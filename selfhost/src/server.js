'use strict';
// Express Tech Design Center — plain Node.js (22.13+), no external packages.
//   /                the Design Center home (and the customer's project link: /#<project>-<key>)
//   /login           sign in
//   /app/            the LV Planner (Design Center)          /app/site.html   the site app (live projects, client view)
//   /site/…, /zoho   the live-project server (server/worker.js, unchanged)
//   /api/…           logins, Design Center projects, sharing, notifications, admin, integrations
//   /mcp, /oauth/…   the Claude connector
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const config = require('./config');
const { db, now, audit } = require('./db');
const H = require('./http');
const { HttpError, route, send, readJson, readBody, redirect } = H;
const auth = require('./auth');
const P = require('./perms');
const events = require('./events');
const bridge = require('./worker-bridge');
const dc = require('./dc');
const notify = require('./notify');
const push = require('./push');
const integrations = require('./integrations');
const oauth = require('./oauth');
const mcp = require('./mcp');
const backup = require('./backup');
const importcf = require('./importcf');
const connect = require('./connect');

const VERSION = require('../package.json').version;
const need = (cond, msg) => { if (!cond) throw new HttpError(403, msg || 'You do not have permission to do that.'); };
const isAdmin = u => u.perms.admin;
const staffOf = sid => sid ? db.prepare('SELECT id, name, role, active FROM staff WHERE id=?').get(sid) || null : null;
const adminUser = u => ({ id: u.id, name: u.name, username: u.username, email: u.email, phone: u.phone, active: !!u.active, perms: P.permsOf(u), access: P.describe(P.permsOf(u)),
  staff: staffOf(u.staff_id), mustChangePassword: !!u.must_change_password, createdAt: u.created_at, lastLoginAt: u.last_login_at });

/* ---------- sign in ---------- */
route('POST', '/api/auth/login', async (req, res) => {
  const b = await readJson(req);
  const u = auth.login(req, res, b.username || b.email, b.password);
  send(res, 200, { ok: true, mustChangePassword: !!u.must_change_password });
});
route('POST', '/api/auth/logout', async (req, res) => { auth.destroySession(req, res); send(res, 200, { ok: true }); });
route('GET', '/api/me', async (req, res, c) => send(res, 200, {
  user: c.user, unread: notify.unread(c.user.id),
  config: { appName: config.appName, company: config.company, version: VERSION, integrations: integrations.status(), pushKey: push.publicKey(), siteRoles: P.SITE_ROLE_NAME },
}));
route('POST', '/api/me/password', async (req, res, c) => {
  const b = await readJson(req);
  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(c.user.id);
  if (!auth.verifyPassword(b.current || '', row.password_hash)) throw new HttpError(400, 'Your current password is not correct.');
  auth.checkPasswordStrength(b.next);
  if (b.next === b.current) throw new HttpError(400, 'Choose a new password that is different from the current one.');
  db.prepare('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?').run(auth.hashPassword(b.next), c.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(c.user.id);   // sign out other devices
  auth.createSession(res, req, c.user.id);
  send(res, 200, { ok: true });
});
route('PATCH', '/api/me', async (req, res, c) => {
  const b = await readJson(req), upd = {};
  if (b.email !== undefined) { const e = String(b.email).trim().toLowerCase(); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new HttpError(400, 'That email address does not look right.'); upd.email = e; }
  if (b.phone !== undefined) upd.phone = String(b.phone).slice(0, 40);
  const k = Object.keys(upd);
  if (k.length) db.prepare(`UPDATE users SET ${k.map(x => x + '=?').join(',')} WHERE id=?`).run(...k.map(x => upd[x]), c.user.id);
  send(res, 200, { ok: true });
});
// people to share with (everyone signed in sees the names of the active logins)
route('GET', '/api/users', async (req, res) => send(res, 200, { users: db.prepare('SELECT * FROM users WHERE active=1 ORDER BY name').all()
  .map(u => { const p = P.permsOf(u); return { id: u.id, name: u.name, username: u.username, design: p.design, access: P.describe(p) }; }) }));

/* ---------- Admin → Logins & permissions ---------- */
route('GET', '/api/admin/users', async (req, res, c) => {
  need(isAdmin(c.user), 'Only an admin can manage logins.');
  send(res, 200, { users: db.prepare('SELECT * FROM users ORDER BY active DESC, name').all().map(adminUser), unlinkedStaff: bridge.unlinkedStaff(),
    flags: P.FLAGS.map(([key, label, help]) => ({ key, label, help })), siteRoles: P.SITE_ROLES.map(r => ({ id: r, label: P.SITE_ROLE_NAME[r] })), presets: P.PRESETS });
});
function linkStaff(uid, staffId) {
  if (staffId === undefined) return;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  if (!staffId) return;
  const st = db.prepare('SELECT * FROM staff WHERE id=?').get(String(staffId));
  if (!st) throw new HttpError(400, 'That site app person is not there any more.');
  const other = db.prepare('SELECT name FROM users WHERE staff_id=? AND id<>?').get(st.id, uid);
  if (other) throw new HttpError(409, `${st.name} in the site app is already linked to the login of ${other.name}.`);
  if (u.staff_id && u.staff_id !== st.id) db.prepare('UPDATE staff SET active=0 WHERE id=?').run(u.staff_id);
  db.prepare('UPDATE users SET staff_id=? WHERE id=?').run(st.id, uid);
}
route('POST', '/api/admin/users', async (req, res, c) => {
  need(isAdmin(c.user), 'Only an admin can add logins.');
  const b = await readJson(req);
  const password = auth.tempPassword();
  const uid = auth.createUser({ name: b.name, username: b.username, email: b.email, phone: b.phone, perms: b.perms, password, mustChange: true, by: c.user.id });
  linkStaff(uid, b.staffId);
  bridge.syncStaff(uid);
  audit(c.user, 'login-added', `${b.name} (${P.describe(P.clean(b.perms))})`);
  events.publish({ type: 'users' });
  send(res, 201, { user: adminUser(db.prepare('SELECT * FROM users WHERE id=?').get(uid)), password });
});
route('PATCH', '/api/admin/users/:id', async (req, res, c) => {
  need(isAdmin(c.user), 'Only an admin can change logins.');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(c.params.id);
  if (!u) throw new HttpError(404, 'Login not found.');
  const b = await readJson(req), upd = {};
  if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 80); if (!n) throw new HttpError(400, 'Name is required.'); upd.name = n; }
  if (b.username !== undefined) upd.username = auth.checkUsername(b.username, u.id);
  if (b.email !== undefined) { const e = String(b.email).trim().toLowerCase(); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new HttpError(400, 'That email address does not look right.'); upd.email = e; }
  if (b.phone !== undefined) upd.phone = String(b.phone).slice(0, 40);
  if (b.perms !== undefined) upd.perms = JSON.stringify(P.clean(b.perms));
  if (b.active !== undefined) upd.active = b.active ? 1 : 0;
  const wasAdmin = P.permsOf(u).admin && u.active, staysAdmin = P.permsOf({ perms: upd.perms || u.perms }).admin && (upd.active === undefined ? u.active : upd.active);
  if (wasAdmin && !staysAdmin && db.prepare("SELECT COUNT(*) n FROM users WHERE active=1 AND perms LIKE '%\"admin\":true%'").get().n <= 1)
    throw new HttpError(400, 'You need at least one active admin.');
  const keys = Object.keys(upd);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => upd[k]), u.id);
  linkStaff(u.id, b.staffId);
  bridge.syncStaff(u.id);
  if (upd.active === 0) { db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); events.kick(u.id); }
  const nu = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  audit(c.user, 'login-changed', `${nu.name}: ${P.describe(P.permsOf(nu))}${nu.active ? '' : ' (switched off)'}`);
  events.publish({ type: 'users' });
  events.publish({ type: 'me' }, x => x.id === u.id);
  send(res, 200, { user: adminUser(nu) });
});
route('POST', '/api/admin/users/:id/reset-password', async (req, res, c) => {
  need(isAdmin(c.user), 'Only an admin can reset passwords.');
  const u = db.prepare('SELECT id, name FROM users WHERE id=?').get(c.params.id);
  if (!u) throw new HttpError(404, 'Login not found.');
  const password = auth.tempPassword();
  db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?').run(auth.hashPassword(password), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); events.kick(u.id);
  audit(c.user, 'password-reset', u.name);
  send(res, 200, { password });
});
route('GET', '/api/admin/audit', async (req, res, c) => { need(isAdmin(c.user)); send(res, 200, { items: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all() }); });

/* ---------- Design Center projects ---------- */
const needDesign = u => need(u.perms.design, 'Your login has no Design Center access. Ask an admin.');
const BIG = 64 * 1024 * 1024;
route('GET', '/api/dc/projects', async (req, res, c) => { needDesign(c.user); send(res, 200, { projects: dc.list(c.user, c.query.get('scope') || '') }); });
route('POST', '/api/dc/projects', async (req, res, c) => { needDesign(c.user); const b = await readJson(req, BIG); send(res, 201, { project: dc.create(c.user, b.data) }); });
route('GET', '/api/dc/projects/:id', async (req, res, c) => { needDesign(c.user); send(res, 200, dc.get(c.user, c.params.id)); });
route('PUT', '/api/dc/projects/:id', async (req, res, c) => { needDesign(c.user); const b = await readJson(req, BIG); b.client = String(req.headers['x-client'] || '').slice(0, 40); send(res, 200, dc.save(c.user, c.params.id, b)); });
route('PATCH', '/api/dc/projects/:id', async (req, res, c) => { needDesign(c.user); const b = await readJson(req); send(res, 200, dc.rename(c.user, c.params.id, b.name)); });
route('DELETE', '/api/dc/projects/:id', async (req, res, c) => { needDesign(c.user); dc.remove(c.user, c.params.id); send(res, 200, { ok: true }); });
route('POST', '/api/dc/projects/:id/restore', async (req, res, c) => { needDesign(c.user); dc.restoreDeleted(c.user, c.params.id); send(res, 200, { ok: true }); });
route('POST', '/api/dc/projects/:id/copy', async (req, res, c) => { needDesign(c.user); const b = await readJson(req); send(res, 201, { project: dc.copy(c.user, c.params.id, b.name) }); });
route('POST', '/api/dc/projects/:id/transfer', async (req, res, c) => { needDesign(c.user); const b = await readJson(req); send(res, 200, { project: dc.transfer(c.user, c.params.id, b.userId) }); });
route('GET', '/api/dc/projects/:id/versions', async (req, res, c) => { needDesign(c.user); send(res, 200, { versions: dc.versions(c.user, c.params.id) }); });
route('GET', '/api/dc/projects/:id/versions/:vid', async (req, res, c) => { needDesign(c.user); send(res, 200, { data: dc.versionData(c.user, c.params.id, c.params.vid) }); });
route('POST', '/api/dc/projects/:id/versions/:vid/restore', async (req, res, c) => { needDesign(c.user); send(res, 200, dc.restoreVersion(c.user, c.params.id, c.params.vid)); });
route('GET', '/api/dc/projects/:id/shares', async (req, res, c) => { needDesign(c.user); send(res, 200, { shares: dc.shares(c.user, c.params.id) }); });
route('PUT', '/api/dc/projects/:id/shares/:uid', async (req, res, c) => { needDesign(c.user); const b = await readJson(req); send(res, 200, { shares: dc.share(c.user, c.params.id, c.params.uid, b.canEdit !== false) }); });
route('DELETE', '/api/dc/projects/:id/shares/:uid', async (req, res, c) => { needDesign(c.user); send(res, 200, { shares: dc.unshare(c.user, c.params.id, c.params.uid) }); });
route('POST', '/api/dc/projects/:id/presence', async (req, res, c) => { needDesign(c.user); const b = await readJson(req); send(res, 200, { others: dc.heartbeat(c.user, c.params.id, b.editing) }); });
route('DELETE', '/api/dc/projects/:id/presence', async (req, res, c) => { dc.leave(c.user, c.params.id); send(res, 200, { ok: true }); });
route('GET', '/api/dc/by-site/:sid', async (req, res, c) => { needDesign(c.user); send(res, 200, { projects: dc.bySite(c.user, c.params.sid) }); });
route('GET', '/api/dc/blobs/:hash', async (req, res, c) => {
  needDesign(c.user);
  const h = c.params.hash;
  if (!dc.hasBlob(h)) throw new HttpError(404, 'Drawing not found');
  const f = dc.blobPath(h), st = fs.statSync(f);
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=31536000, immutable' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f).pipe(res);
});
route('PUT', '/api/dc/blobs/:hash', async (req, res, c) => {
  needDesign(c.user);
  if (dc.hasBlob(c.params.hash)) { req.resume(); return send(res, 200, { ok: true, had: true }); }
  const buf = await readBody(req, config.maxUploadMb * 1024 * 1024);
  send(res, 201, dc.putBlob(c.user, c.params.hash, buf));
});

/* ---------- live projects (for the home page; the site app itself talks to /site/…) ---------- */
route('GET', '/api/live', async (req, res, c) => {
  const p = c.user.perms;
  if (!P.liveAccess(p)) return send(res, 200, { projects: [] });
  const j = p.office ? await bridge.call('/site/list') : await bridge.callAs(c.user, '/site/me');
  send(res, 200, { projects: j.projects.map(x => ({ id: x.id, name: x.name, state: x.state, paused: !!x.paused, pct: x.tasks_all ? Math.round(100 * x.tasks_done / x.tasks_all) : 0,
    points: x.points, openReports: x.open_reports || 0, nextStage: x.next_stage || null, updatedAt: x.updated_at, startedAt: x.started_at, viewKey: p.office ? x.view_key : undefined, list: !!x.list })) });
});

/* ---------- notifications ---------- */
route('GET', '/api/notifications', async (req, res, c) => send(res, 200, notify.list(c.user.id, c.query.get('before'))));
route('POST', '/api/notifications/read', async (req, res, c) => { const b = await readJson(req); send(res, 200, { unread: notify.markRead(c.user.id, b.all ? 'all' : b.ids) }); });
route('GET', '/api/me/notifications', async (req, res, c) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(c.user.id);
  send(res, 200, { kinds: notify.KINDS.map(([k, label]) => ({ key: k, label })), prefs: notify.prefs(u), publicKey: push.publicKey(),
    devices: push.devices(c.user.id).map(d => ({ endpoint: d.endpoint, device: d.user_agent, since: d.created_at, lastOk: d.last_ok_at })) });
});
route('PUT', '/api/me/notifications', async (req, res, c) => send(res, 200, { prefs: notify.savePrefs(c.user.id, await readJson(req)) }));
route('POST', '/api/push/subscribe', async (req, res, c) => {
  const b = await readJson(req);
  if (!push.subscribe(c.user.id, b.subscription, req.headers['user-agent'])) throw new HttpError(400, 'This browser sent an invalid notification subscription.');
  send(res, 200, { ok: true });
});
route('POST', '/api/push/unsubscribe', async (req, res, c) => { const b = await readJson(req); push.unsubscribe(c.user.id, b.endpoint); send(res, 200, { ok: true }); });
route('POST', '/api/push/test', async (req, res, c) => send(res, 200, await push.sendToUser(c.user.id, { title: 'Express Tech notifications are on ✓', body: `Hi ${c.user.firstName}, this device will now get Design Center alerts.`, url: '/', tag: 'test' })));

/* ---------- Connect Claude (each person) ---------- */
route('GET', '/api/me/claude', async (req, res, c) => send(res, 200, { enabled: oauth.enabled(), mcpUrl: oauth.resource(), https: config.appUrl.startsWith('https://'), connections: oauth.connections(c.user.id) }));
route('DELETE', '/api/me/claude/:id', async (req, res, c) => { oauth.disconnect(c.user.id, c.params.id); send(res, 200, { ok: true }); });

/* ---------- Admin → Integrations ---------- */
route('GET', '/api/admin/integrations', async (req, res, c) => { need(isAdmin(c.user)); send(res, 200, { integrations: integrations.list() }); });
route('PUT', '/api/admin/integrations/:id', async (req, res, c) => { need(isAdmin(c.user)); const r = integrations.save(c.params.id, await readJson(req), c.user); audit(c.user, 'integration', c.params.id); send(res, 200, { integration: r }); });
route('POST', '/api/admin/integrations/:id/test', async (req, res, c) => { need(isAdmin(c.user)); send(res, 200, { message: await integrations.test(c.params.id) }); });
route('POST', '/api/admin/integrations/:id/actions/:action', async (req, res, c) => { need(isAdmin(c.user)); send(res, 200, { result: await integrations.action(c.params.id, c.params.action, c.user) }); });
route('DELETE', '/api/admin/integrations/:id', async (req, res, c) => { need(isAdmin(c.user)); integrations.disconnect(c.params.id, c.user); audit(c.user, 'integration-off', c.params.id); send(res, 200, { ok: true }); });
route('POST', '/api/admin/integrations/zoho_books/authorize', async (req, res, c) => { need(isAdmin(c.user)); send(res, 200, { url: integrations.zoho.authorizeUrl(c.user) }); });
route('GET', '/api/integrations/zoho_books/callback', async (req, res, c) => {
  let to = '/#admin/integrations';
  try { need(isAdmin(c.user)); await integrations.zoho.callback(c.user, c.query); events.publish({ type: 'config' }); to += '?connected=zoho_books'; }
  catch (e) { to += '?error=' + encodeURIComponent(e.message); }
  redirect(res, to);
});

/* ---------- Admin → System ---------- */
const startedAt = now();
route('GET', '/api/admin/system', async (req, res, c) => {
  need(isAdmin(c.user));
  const size = f => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
  const n = q => { try { return db.prepare(q).get().n; } catch (e) { return 0; } };
  send(res, 200, {
    version: VERSION, startedAt, node: process.version, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, serverTime: new Date().toString(), appUrl: config.appUrl,
    liveConnections: events.count(), dbSize: size(config.dbFile) + size(config.dbFile + '-wal'),
    drawings: { count: n('SELECT COUNT(*) n FROM dc_blobs'), bytes: n('SELECT COALESCE(SUM(bytes),0) n FROM dc_blobs') },
    counts: { logins: n('SELECT COUNT(*) n FROM users WHERE active=1'), designProjects: n('SELECT COUNT(*) n FROM dc_projects WHERE deleted_at IS NULL'),
      liveProjects: n('SELECT COUNT(*) n FROM projects'), points: n('SELECT COUNT(*) n FROM points WHERE active=1'), photos: n('SELECT COUNT(*) n FROM photos'), pushDevices: n('SELECT COUNT(*) n FROM push_subscriptions') },
    planner: (() => { try { return JSON.parse(fs.readFileSync(path.join(config.appDir, 'version.json'), 'utf8')); } catch (e) { return null; } })(),
    backups: backup.list().slice(0, 7), import: importcf.status(),
  });
});
route('POST', '/api/admin/backup', async (req, res, c) => { need(isAdmin(c.user)); send(res, 200, { file: path.basename(backup.backupNow()) }); });
route('POST', '/api/admin/import', async (req, res, c) => {
  need(isAdmin(c.user));
  const b = await readJson(req);
  importcf.start({ url: b.url, key: b.key, fresh: !!b.fresh, owner: c.user.id });
  audit(c.user, 'import-cloudflare', b.url);
  send(res, 202, importcf.status());
});
route('GET', '/api/admin/import', async (req, res, c) => { need(isAdmin(c.user)); send(res, 200, importcf.status()); });

route('GET', '/api/events', async (req, res, c) => { events.subscribe(req, res, c.user); });
route('GET', '/api/health', async (req, res) => send(res, 200, { ok: true, time: now(), clients: events.count() }));

/* ---------- the live-project server: after-change hooks (who was added to a team → notification) ---------- */
function teamSet(pid) {
  const p = db.prepare('SELECT team FROM projects WHERE id=?').get(pid);
  if (!p) return null;
  let t = []; try { t = JSON.parse(p.team || '[]') || []; } catch (e) {}
  return new Set(t.length ? t : db.prepare("SELECT id FROM staff WHERE active=1 AND role <> 'manager'").all().map(r => r.id));
}
let logTimer = null;
const siteHooks = {
  before(p, method, body) {
    let m = p.match(/^\/site\/p\/([A-Za-z0-9]+)\/team$/);
    if (m) return { pid: m[1], team: teamSet(m[1]) };
    if (p === '/site/publish' && body) { try { const b = JSON.parse(body.toString('utf8')); if (b.id) return { pid: String(b.id), team: teamSet(String(b.id)) }; } catch (e) {} }
    return null;
  },
  after(p, method, user, before) {
    clearTimeout(logTimer); logTimer = setTimeout(() => notify.processSiteLog(), 300);
    if (before && before.pid && before.team) {
      const nowSet = teamSet(before.pid) || new Set();
      const added = [...nowSet].filter(x => !before.team.has(x));
      if (added.length) notify.teamAdded(before.pid, added, user);
    }
  },
};

/* ---------- pages ---------- */
// The planner and the site app get one extra line: /hosted.js, which switches on what this server adds
// (sign-in instead of keys, projects saved under your login, sharing, notifications). Nothing else in them changes.
const HOSTED_TAG = '<script src="/hosted.js?v=' + VERSION + '"></script>';
const plugHosted = html => html.replace(/<head([^>]*)>/i, m => m + '\n' + HOSTED_TAG);
const APP_EXT = ['.html', '.png', '.js', '.json', '.webmanifest', '.ico', '.svg', '.jpg'];
function serveApp(req, res, url, getUser) {
  let rel = url.pathname.slice('/app/'.length) || 'index.html';
  if (rel.includes('/') || rel.startsWith('.') || /^(package|package-lock|wrangler)\./.test(rel)) return false;
  if (rel === 'index.html') {
    const u = getUser();
    if (!u) { redirect(res, '/login?next=' + encodeURIComponent(url.pathname + url.search)); return true; }
    if (u.mustChangePassword) { redirect(res, '/login?next=' + encodeURIComponent(url.pathname + url.search)); return true; }
    if (!u.perms.design) { redirect(res, '/?no=design'); return true; }
  }
  H.securityHeaders(res, 'app');
  return H.serveFile(req, res, config.appDir, rel, { allow: APP_EXT, transform: plugHosted });
}

const OPEN_ROUTES = new Set(['/api/auth/login', '/api/health']);
const PASSWORD_ROUTES = new Set(['/api/me', '/api/me/password', '/api/auth/logout', '/api/events']);

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { error: 'Bad URL' }); }
  const pathname = url.pathname;
  const getUser = () => auth.getUser(req, res);
  try {
    // live projects (planner, site app, client links) — the worker sets its own CORS headers
    if (pathname === '/zoho' || pathname === '/site' || pathname.startsWith('/site/')) {
      if (pathname === '/zoho' && req.method === 'POST' && !integrations.status().zoho) throw new HttpError(503, 'Zoho Books is not connected yet — an admin can connect it in Admin → Integrations.');
      return await bridge.handle(req, res, url, getUser, siteHooks);
    }
    // Claude connector (MCP) and its sign-in (OAuth)
    if (pathname === '/mcp') return await mcp.handle(req, res);
    // LeadzIN starts projects here (server to server, its own key)
    if (pathname.startsWith('/api/connect/')) { H.securityHeaders(res, 'strict'); return await connect.handle(req, res, url); }
    if (pathname.startsWith('/.well-known/oauth-protected-resource')) return send(res, 200, oauth.metadataPR(), { 'Access-Control-Allow-Origin': '*' });
    if (pathname.startsWith('/.well-known/oauth-authorization-server') || pathname.startsWith('/.well-known/openid-configuration')) return send(res, 200, oauth.metadataAS(), { 'Access-Control-Allow-Origin': '*' });
    if (pathname.startsWith('/oauth/')) {
      H.securityHeaders(res, 'strict');
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' }); return res.end(); }
      if (pathname === '/oauth/register' && req.method === 'POST') return await oauth.register(req, res);
      if (pathname === '/oauth/authorize') return await oauth.authorize(req, res, url);
      if (pathname === '/oauth/token' && req.method === 'POST') return await oauth.token(req, res);
      if (pathname === '/oauth/revoke' && req.method === 'POST') return await oauth.revoke(req, res);
    }
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      if (pathname === '/app' || pathname === '/planner' || pathname === '/planner/') return redirect(res, '/app/' + url.search);
      if (pathname === '/site' || pathname === '/site-app') return redirect(res, '/app/site.html');
      if (pathname.startsWith('/app/')) { if (serveApp(req, res, url, getUser)) return; return send(res, 404, 'Not found'); }
      H.securityHeaders(res, 'strict');
      if (pathname === '/login' || pathname === '/') return H.serveFile(req, res, config.publicDir, pathname === '/' ? 'index.html' : 'login.html') || send(res, 404, 'Not found');
      if (pathname === '/brand-logo.png' || pathname === '/brand-mark.png' || pathname === '/favicon.ico') {
        H.serveFile(req, res, config.appDir, pathname === '/favicon.ico' ? 'icon-192.png' : pathname.slice(1)) || send(res, 404, 'Not found'); return;
      }
      if (H.serveFile(req, res, config.publicDir, pathname.slice(1))) return;
      return send(res, 404, 'Not found');
    }
    H.securityHeaders(res, 'strict');
    const m = H.match(req.method, pathname);
    if (!m) throw new HttpError(404, 'Not found');
    // CSRF protection: every state-changing API call must carry this header (browsers can't add it cross-site).
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-express'] !== '1' && !pathname.startsWith('/api/integrations/')) throw new HttpError(403, 'Missing request header.');
    const ctx = { params: m.params, query: url.searchParams, user: null };
    if (!OPEN_ROUTES.has(pathname)) {
      ctx.user = getUser();
      if (!ctx.user) throw new HttpError(401, 'Please sign in.', { signIn: true });
      if (ctx.user.mustChangePassword && !PASSWORD_ROUTES.has(pathname)) throw new HttpError(403, 'Please set your own password first.', { mustChangePassword: true });
    }
    await m.handler(req, res, ctx);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error('[error]', req.method, pathname, e);
    send(res, 500, { error: 'Something went wrong on the server.' });
  }
});
server.requestTimeout = 0;   // long uploads and the live-update stream
server.headersTimeout = 60e3;

async function start() {
  auth.ensureAdmin();
  integrations.init();
  await bridge.ready();
  for (const u of db.prepare('SELECT id FROM users').all()) bridge.syncStaff(u.id);
  notify.processSiteLog();
  bridge.startCron();
  backup.schedule(() => console.log('[cleanup]', dc.gcBlobs()));
  setInterval(() => { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()); }, 6 * 3600e3).unref();
  setInterval(() => notify.processSiteLog(), 60e3).unref();   // e.g. ticks from the Asana mirror, older app links
  await new Promise(r => server.listen(config.port, config.host, r));
  console.log(`[expresstech] ${config.appName} ${VERSION} listening on http://${config.host}:${config.port} (public address ${config.appUrl})`);
  console.log(`[expresstech] planner & site app from ${config.appDir}, live-project server ${config.workerFile}`);
}
if (require.main === module) start().catch(e => { console.error(e); process.exit(1); });

const shutdown = () => { server.close(); try { db.close(); } catch (e) {} process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

module.exports = { server, start };
