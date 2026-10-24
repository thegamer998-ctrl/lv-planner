'use strict';
// OAuth 2.1 for the Claude connector (MCP authorization spec): each person signs in with their own Design Center login
// and approves "Claude" once. Supports Dynamic Client Registration and PKCE (S256), short-lived access tokens and rotating refresh tokens.
const crypto = require('node:crypto');
const { db, now, id } = require('./db');
const config = require('./config');
const { HttpError, readBody, send, clientIp } = require('./http');
const P = require('./perms');
const auth = require('./auth');
const store = require('./integrations/store');

const ACCESS_TTL = 3600, REFRESH_DAYS = 60;
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const rnd = (n = 32) => crypto.randomBytes(n).toString('base64url');
const enabled = () => store.enabled('claude');

// Where Claude may send people back to after they approve. Claude.ai / Claude Desktop use claude.ai (or claude.com);
// Claude Code and other local MCP clients use localhost. Add more with MCP_REDIRECT_ALLOW (comma-separated prefixes).
const EXTRA = String(process.env.MCP_REDIRECT_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean);
function redirectAllowed(u) {
  let x; try { x = new URL(u); } catch (e) { return false; }
  if (x.hash) return false;
  if (x.protocol === 'https:' && ['claude.ai', 'claude.com', 'www.claude.ai', 'www.claude.com'].includes(x.hostname) && x.pathname.startsWith('/api/mcp/auth_callback')) return true;
  if (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)) return true;
  return EXTRA.some(p => { let e; try { e = new URL(p); } catch (err) { return false; } return x.origin === e.origin && x.pathname.startsWith(e.pathname); });
}
// Claude's own apps send people back to claude.ai / claude.com; anything else is shown on the approval page by its address.
const isClaude = u => { try { const x = new URL(u); return x.protocol === 'https:' && ['claude.ai', 'claude.com', 'www.claude.ai', 'www.claude.com'].includes(x.hostname); } catch (e) { return false; } };

const issuer = () => config.appUrl;
const resource = () => `${config.appUrl}/mcp`;
function metadataAS() {
  return {
    issuer: issuer(), authorization_endpoint: `${issuer()}/oauth/authorize`, token_endpoint: `${issuer()}/oauth/token`,
    registration_endpoint: `${issuer()}/oauth/register`, revocation_endpoint: `${issuer()}/oauth/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['design'], service_documentation: `${issuer()}/`,
  };
}
const metadataPR = () => ({ resource: resource(), authorization_servers: [issuer()], scopes_supported: ['design'], bearer_methods_supported: ['header'], resource_name: config.appName });

async function form(req) {
  const t = (await readBody(req, 64 * 1024)).toString('utf8');
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('application/json')) { try { return JSON.parse(t || '{}'); } catch (e) { return {}; } }
  return Object.fromEntries(new URLSearchParams(t));
}
const oerr = (res, status, error, description) => send(res, status, { error, error_description: description }, { 'Access-Control-Allow-Origin': '*' });

/* ---------- Dynamic Client Registration ---------- */
// At most 10 registrations per address per hour and 200 in total; registrations never used within a day are removed.
const regs = new Map();
async function register(req, res) {
  const ip = clientIp(req), t = Date.now();
  const recent = (regs.get(ip) || []).filter(x => t - x < 3600e3);
  if (recent.length >= 10) return oerr(res, 429, 'too_many_requests', 'Too many registrations from this address. Try again in an hour.');
  regs.set(ip, [...recent, t]);
  if (db.prepare('SELECT COUNT(*) n FROM oauth_clients').get().n >= 200) return oerr(res, 503, 'temporarily_unavailable', 'Too many registered apps. Ask an admin.');
  const b = await form(req);
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!uris.length || uris.some(u => !redirectAllowed(u))) return oerr(res, 400, 'invalid_redirect_uri', 'This redirect address is not allowed by the Design Center.');
  const cid = 'et_' + rnd(18);
  const confidential = b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none';
  const secret = confidential ? rnd(32) : null;
  db.prepare('INSERT INTO oauth_clients(client_id,name,redirect_uris,secret_hash,created_at) VALUES(?,?,?,?,?)')
    .run(cid, String(b.client_name || 'MCP client').slice(0, 100), JSON.stringify(uris), secret ? sha(secret) : null, now());
  send(res, 201, { client_id: cid, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: b.client_name || 'MCP client', redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    token_endpoint_auth_method: secret ? (b.token_endpoint_auth_method || 'client_secret_post') : 'none' }, { 'Access-Control-Allow-Origin': '*' });
}
const client = cid => db.prepare('SELECT * FROM oauth_clients WHERE client_id=?').get(String(cid || ''));

/* ---------- Authorization (consent screen) ---------- */
const pending = new Map(); // consent id -> request
setInterval(() => { const t = Date.now(); for (const [k, v] of pending) if (t - v.at > 15 * 60e3) pending.delete(k); }, 5 * 60e3).unref();

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ${config.appName}</title>
<link rel="stylesheet" href="/portal.css"></head><body class="auth-page"><main class="auth"><div class="auth-card">
<div class="auth-brand"><img src="/brand-logo.png" alt="${config.company}"><small>Design Center · Connect an app</small></div>${body}</div></main><div class="brand-stripe"></div></body></html>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function authorize(req, res, url) {
  if (req.method === 'POST') return decide(req, res);
  const q = url.searchParams;
  const c = client(q.get('client_id'));
  const ru = q.get('redirect_uri') || '';
  const fail = msg => { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page('Can’t connect', `<p>${esc(msg)}</p>`)); };
  if (!c) return fail('This app is not registered with the Design Center. Remove the connector in Claude and add it again.');
  if (!JSON.parse(c.redirect_uris).includes(ru)) return fail('The return address does not match. Remove the connector in Claude and add it again.');
  const back = (err, desc) => { const u = new URL(ru); u.searchParams.set('error', err); if (desc) u.searchParams.set('error_description', desc); if (q.get('state')) u.searchParams.set('state', q.get('state')); res.writeHead(302, { Location: u.href }); res.end(); };
  if (q.get('response_type') !== 'code') return back('unsupported_response_type');
  if (!q.get('code_challenge') || (q.get('code_challenge_method') || 'plain') !== 'S256') return back('invalid_request', 'PKCE with S256 is required');
  if (!enabled()) return fail('Connecting Claude is switched off. An admin can switch it on in Admin → Integrations → Claude.');
  const user = auth.getUser(req, res);
  if (!user) { res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(url.pathname + url.search) }); return res.end(); }
  if (user.mustChangePassword || user.mustSetup2fa) return fail('Open the Design Center in your browser and finish setting up your sign-in (password and two-step sign-in) first, then try connecting again.');
  const cid = rnd(18);
  pending.set(cid, { at: Date.now(), user: user.id, client: c.client_id, redirect: ru, challenge: q.get('code_challenge'), state: q.get('state') || '', scope: q.get('scope') || 'design' });
  const writes = store.config('claude').allowWrites === true;
  const origin = new URL(ru).origin;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    // allow the approval form to continue on to Claude
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self' ${origin}; frame-ancestors 'none'; base-uri 'none'` });
  res.end(page('Allow access', `
    <h2>Allow <b>${isClaude(ru) ? 'Claude' : 'an app at ' + esc(new URL(ru).host)}</b> to use the Design Center as ${esc(user.name)}?</h2>
    <p class="muted">It will send you back to <b>${esc(new URL(ru).host)}</b>${c.name ? ` · it calls itself “${esc(String(c.name).slice(0, 60))}”` : ''}. If that is not the app you are connecting, press Cancel.</p>
    <p>It will be able to ${writes ? 'see, and make small changes to,' : 'see'} what <b>you</b> can, with <b>your</b> permissions — your Design Center projects (points, floors, cabinets, drawings), live project progress, site reports and your notifications. Everything it does is recorded under your name.</p>
    <p class="muted">You can disconnect it at any time: Design Center → your name → Connect Claude.</p>
    <form method="post" action="/oauth/authorize" class="auth-actions">
      <input type="hidden" name="consent" value="${cid}">
      <button class="btn" name="decision" value="deny" type="submit">Cancel</button>
      <button class="btn pri" name="decision" value="allow" type="submit">Allow</button>
    </form>`));
}
async function decide(req, res) {
  const b = await form(req);
  const p = pending.get(String(b.consent || ''));
  const user = auth.getUser(req, res);
  if (!p || !user || user.id !== p.user || user.mustChangePassword || user.mustSetup2fa) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page('Expired', '<p>This approval page has expired. Start connecting again from Claude.</p>')); }
  pending.delete(String(b.consent));
  const u = new URL(p.redirect);
  if (p.state) u.searchParams.set('state', p.state);
  if (b.decision !== 'allow') { u.searchParams.set('error', 'access_denied'); res.writeHead(302, { Location: u.href }); return res.end(); }
  const code = rnd(32);
  db.prepare('INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,challenge,scope,expires_at) VALUES(?,?,?,?,?,?,?)')
    .run(sha(code), p.client, user.id, p.redirect, p.challenge, p.scope, new Date(Date.now() + 5 * 60e3).toISOString());
  store.log('claude', 'info', `${user.name} connected ${(client(p.client) || {}).name || 'Claude'}`);
  u.searchParams.set('code', code);
  u.searchParams.set('iss', issuer());
  res.writeHead(302, { Location: u.href }); res.end();
}

/* ---------- Token endpoint ---------- */
// Active, own password chosen, and two-step sign-in set up where it is required.
function signInOk(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  return !!u && !!u.active && !u.must_change_password && !(P.twoFactorRequired(u) && !u.totp_enabled);
}
function clientAuth(req, b) {
  let cid = b.client_id, secret = b.client_secret;
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Basic ')) { const [a, s] = Buffer.from(h.slice(6), 'base64').toString().split(':'); cid = decodeURIComponent(a || ''); secret = decodeURIComponent(s || ''); }
  const c = client(cid);
  if (!c) return null;
  if (c.secret_hash && (!secret || sha(secret) !== c.secret_hash)) return null;
  return c;
}
function issue(clientId, userId, grantId) {
  const access = rnd(32), refresh = rnd(32), t = now();
  db.prepare('INSERT INTO oauth_tokens(token_hash,kind,grant_id,client_id,user_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(sha(access), 'access', grantId, clientId, userId, new Date(Date.now() + ACCESS_TTL * 1000).toISOString(), t);
  db.prepare('INSERT INTO oauth_tokens(token_hash,kind,grant_id,client_id,user_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(sha(refresh), 'refresh', grantId, clientId, userId, new Date(Date.now() + REFRESH_DAYS * 864e5).toISOString(), t);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'design' };
}
async function token(req, res) {
  const b = await form(req);
  const c = clientAuth(req, b);
  if (!c) return oerr(res, 401, 'invalid_client', 'Unknown client');
  if (!enabled()) return oerr(res, 400, 'invalid_grant', 'Connecting Claude is switched off in the Design Center.');
  if (b.grant_type === 'authorization_code') {
    const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash=?').get(sha(b.code || ''));
    if (row) db.prepare('DELETE FROM oauth_codes WHERE code_hash=?').run(row.code_hash); // single use
    if (!row || row.client_id !== c.client_id || row.expires_at < now()) return oerr(res, 400, 'invalid_grant', 'The code is invalid or expired.');
    if (b.redirect_uri !== row.redirect_uri) return oerr(res, 400, 'invalid_grant', 'redirect_uri missing or does not match');
    const chal = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
    if (chal !== row.challenge) return oerr(res, 400, 'invalid_grant', 'PKCE verification failed.');
    if (!signInOk(row.user_id)) return oerr(res, 400, 'invalid_grant', 'User is not active or must finish setting up the sign-in.');
    return send(res, 200, issue(c.client_id, row.user_id, id()), { 'Access-Control-Allow-Origin': '*' });
  }
  if (b.grant_type === 'refresh_token') {
    const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash=? AND kind IN ('refresh','used')").get(sha(b.refresh_token || ''));
    if (row && row.kind === 'used') { // an old refresh token came back: it was copied. End that whole connection.
      db.prepare('DELETE FROM oauth_tokens WHERE grant_id=?').run(row.grant_id);
      store.log('claude', 'error', 'A used Claude refresh token was presented again; that connection was disconnected.');
      return oerr(res, 400, 'invalid_grant', 'The refresh token was already used. Connect again.');
    }
    if (!row || row.client_id !== c.client_id || row.expires_at < now()) return oerr(res, 400, 'invalid_grant', 'The refresh token is invalid or expired.');
    if (!signInOk(row.user_id)) return oerr(res, 400, 'invalid_grant', 'User is not active or must finish setting up the sign-in.');
    db.prepare("UPDATE oauth_tokens SET kind='used' WHERE token_hash=?").run(row.token_hash); // rotate; kept until it expires to spot reuse
    db.prepare("DELETE FROM oauth_tokens WHERE grant_id=? AND kind='access' AND expires_at < ?").run(row.grant_id, now());
    return send(res, 200, issue(c.client_id, row.user_id, row.grant_id), { 'Access-Control-Allow-Origin': '*' });
  }
  oerr(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
}
async function revoke(req, res) {
  const b = await form(req);
  const row = db.prepare('SELECT grant_id FROM oauth_tokens WHERE token_hash=?').get(sha(b.token || ''));
  if (row) db.prepare('DELETE FROM oauth_tokens WHERE grant_id=?').run(row.grant_id);
  send(res, 200, {});
}

// Bearer token → the Design Center user (with permissions), or null
function userFromBearer(req) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ')) return null;
  const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash=? AND kind='access'").get(sha(h.slice(7).trim()));
  if (!row || row.expires_at < now()) return null;
  const u = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(row.user_id);
  if (!u || u.must_change_password || (P.twoFactorRequired(u) && !u.totp_enabled)) return null;
  db.prepare('UPDATE oauth_tokens SET last_used_at=? WHERE token_hash=?').run(now(), row.token_hash);
  return { ...auth.toUser(u), viaClaude: (client(row.client_id) || {}).name || 'Claude' };
}

// "Connect Claude" screen: this person's connections
function connections(userId) {
  return db.prepare(`SELECT t.grant_id, c.name, MIN(t.created_at) since, MAX(COALESCE(t.last_used_at, t.created_at)) last
    FROM oauth_tokens t LEFT JOIN oauth_clients c ON c.client_id=t.client_id WHERE t.user_id=? AND t.kind != 'used' AND t.expires_at > ? GROUP BY t.grant_id ORDER BY last DESC`).all(userId, now())
    .map(r => ({ id: r.grant_id, name: r.name || 'Claude', since: r.since, lastUsed: r.last }));
}
function disconnect(userId, grantId) { db.prepare('DELETE FROM oauth_tokens WHERE user_id=? AND grant_id=?').run(userId, grantId); }
function disconnectAll() { db.prepare('DELETE FROM oauth_tokens').run(); }
// Password changed or reset, two-step sign-in reset, or person switched off: every Claude connection of theirs stops at once.
function disconnectUser(userId) { db.prepare('DELETE FROM oauth_tokens WHERE user_id=?').run(userId); db.prepare('DELETE FROM oauth_codes WHERE user_id=?').run(userId); }
setInterval(() => {
  db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(now()); db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now());
  db.prepare(`DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oauth_tokens) AND client_id NOT IN (SELECT client_id FROM oauth_codes)`)
    .run(new Date(Date.now() - 864e5).toISOString());
  const t = Date.now(); for (const [k, l] of regs) if (!l.some(x => t - x < 3600e3)) regs.delete(k);
}, 3600e3).unref();

module.exports = { metadataAS, metadataPR, register, authorize, token, revoke, userFromBearer, connections, disconnect, disconnectAll, disconnectUser, resource, enabled };
