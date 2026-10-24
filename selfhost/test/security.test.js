'use strict';
// Security checks — the same strategy as LeadzIN's 20 Oct 2026 review: sign-in throttling, two-step sign-in for admins,
// Claude connector hardening, push hosts, live updates that stop at sign-out, libraries served from this server.
//   npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const totp = require('../src/totp');

const PORT = 41000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'et-sec-'));
const VENDOR = path.join(DATA, 'vendor');
let proc;

function client() {
  let cookie = '';
  const c = async (method, p, body, headers = {}) => {
    const h = { 'X-Express': '1', ...headers };
    if (cookie) h.Cookie = cookie;
    let b;
    if (body !== undefined) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
    const r = await fetch(BASE + p, { method, headers: h, body: b, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text(), headers: r.headers };
  };
  c.cookie = () => cookie;
  return c;
}
const nextCode = (secret, after) => { for (let s = totp.stepNow(); ; s++) if (!after || s > after) return { code: totp.codeAt(secret, s), step: s }; };
async function enable2fa(c) {
  const s = await c('POST', '/api/me/2fa/setup');
  const secret = s.data.secret.replace(/ /g, '');
  const n = nextCode(secret);
  assert.equal((await c('POST', '/api/me/2fa/enable', { code: n.code })).status, 200);
  return { secret, used: n.step };
}
async function newLogin(admin, name, username, perms) {
  const r = await admin('POST', '/api/admin/users', { name, username, perms });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const c = client();
  await c('POST', '/api/auth/login', { username, password: r.data.password });
  const pw = await c('POST', '/api/me/password', { current: r.data.password, next: 'Chosen12345!' });
  assert.equal(pw.status, 200);
  c.id = r.data.user.id; c.mustSetup2fa = pw.data.mustSetup2fa;
  return c;
}

const S = {};
before(async () => {
  // stand-in libraries, as if the Docker build had fetched them
  fs.mkdirSync(path.join(VENDOR, 'cdnjs/ajax/libs/pdf.js/3.11.174'), { recursive: true });
  fs.writeFileSync(path.join(VENDOR, 'cdnjs/ajax/libs/pdf.js/3.11.174/pdf.min.js'), '/* pdf.js 3.11.174 */');
  fs.writeFileSync(path.join(VENDOR, 'SHA256SUMS'), 'x  cdnjs/ajax/libs/pdf.js/3.11.174/pdf.min.js\n');
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DATA_DIR: DATA, VENDOR_DIR: VENDOR, PORT: String(PORT), HOST: '127.0.0.1', APP_URL: BASE, ADMIN_NAME: 'Husain Kazi', ADMIN_USERNAME: 'husain', ADMIN_PASSWORD: 'FirstPass123', ENV_FILE: '/nonexistent' },
    stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 200)); }
  S.admin = client();
  await S.admin('POST', '/api/auth/login', { username: 'husain', password: 'FirstPass123' });
  await S.admin('POST', '/api/me/password', { current: 'FirstPass123', next: 'HusainPass1' });
  S.admin2fa = await enable2fa(S.admin);
});
after(() => { proc.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('sign-in limit holds when the visitor changes X-Forwarded-For; unknown usernames get the same answer', async () => {
  await newLogin(S.admin, 'Victim', 'victim', { design: true });
  let last;
  for (let i = 0; i < 22; i++) last = await client()('POST', '/api/auth/login', { username: 'victim', password: 'guess' + i }, { 'X-Forwarded-For': `10.0.${i}.1` });
  assert.equal(last.status, 429);
  const right = await client()('POST', '/api/auth/login', { username: 'victim', password: 'Chosen12345!' }, { 'X-Forwarded-For': '10.9.9.9' });
  assert.equal(right.status, 429);   // locked for 15 minutes from anywhere
  const nobody = await client()('POST', '/api/auth/login', { username: 'nobody', password: 'x' }, { 'X-Forwarded-For': '10.8.8.8' });
  const wrong = await client()('POST', '/api/auth/login', { username: 'husain', password: 'wrong' }, { 'X-Forwarded-For': '10.8.8.9' });
  assert.equal(nobody.status, 401); assert.equal(nobody.data.error, wrong.data.error);
});

test('two-step sign-in: admins must set it up; then sign-in needs a fresh code; no replay', async () => {
  const a2 = await newLogin(S.admin, 'Aziz', 'aziz', { admin: true });
  assert.equal(a2.mustSetup2fa, true);
  assert.equal((await a2('GET', '/api/dc/projects')).status, 403);
  assert.equal((await a2('GET', '/site/list', undefined, { 'X-Admin-Key': 'session' })).status, 403);
  const page = await a2('GET', '/app/');
  assert.equal(page.status, 302); assert.match(page.headers.get('location'), /^\/login/);
  const wrongSetup = await a2('POST', '/api/me/2fa/setup');
  const sec = wrongSetup.data.secret.replace(/ /g, '');
  const bad = totp.codeAt(sec, totp.stepNow()) === '000000' ? '111111' : '000000';
  assert.equal((await a2('POST', '/api/me/2fa/enable', { code: bad })).status, 400);
  const first = nextCode(sec);
  assert.equal((await a2('POST', '/api/me/2fa/enable', { code: first.code })).status, 200);
  assert.equal((await a2('GET', '/api/dc/projects')).status, 200);
  // a new sign-in: password alone is not enough
  const b = client();
  const step1 = await b('POST', '/api/auth/login', { username: 'aziz', password: 'Chosen12345!' });
  assert.equal(step1.status, 401); assert.equal(step1.data.needCode, true);
  assert.equal((await b('POST', '/api/auth/login', { username: 'aziz', password: 'Chosen12345!', code: '12345' })).status, 401);
  const n = nextCode(sec, first.step);   // the enable step used one code; the next one is accepted
  assert.equal((await b('POST', '/api/auth/login', { username: 'aziz', password: 'Chosen12345!', code: n.code })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'aziz', password: 'Chosen12345!', code: n.code })).status, 401);   // no replay
  // admins can't switch it off; another admin resets it (lost phone) and that signs them out everywhere
  assert.equal((await b('POST', '/api/me/2fa/disable', { password: 'Chosen12345!', code: '000000' })).status, 403);
  assert.equal((await S.admin('POST', `/api/admin/users/${a2.id}/reset-2fa`)).status, 200);
  assert.equal((await b('GET', '/api/me')).status, 401);
  const again = client();
  const r = await again('POST', '/api/auth/login', { username: 'aziz', password: 'Chosen12345!' });
  assert.equal(r.status, 200); assert.equal(r.data.mustSetup2fa, true);
});

test('two-step sign-in is optional for others: on with a code, off with password and code', async () => {
  const t = await newLogin(S.admin, 'Tahir', 'tahir', { design: true });
  assert.equal(t.mustSetup2fa, false);
  assert.equal((await t('GET', '/api/dc/projects')).status, 200);
  const on = await enable2fa(t);
  assert.equal((await t('GET', '/api/me')).data.user.twoFactor, true);
  assert.equal((await t('POST', '/api/me/2fa/disable', { password: 'wrong', code: nextCode(on.secret, on.used).code })).status, 400);
  assert.equal((await t('POST', '/api/me/2fa/disable', { password: 'Chosen12345!', code: nextCode(on.secret, on.used).code })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'tahir', password: 'Chosen12345!' })).status, 200);
});

test('notifications only go to real push services', async () => {
  const keys = { p256dh: crypto.createECDH('prime256v1').generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  for (const endpoint of ['https://evil.example/push', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://127.0.0.1/x', 'https://user@fcm.googleapis.com/x'])
    assert.equal((await S.admin('POST', '/api/push/subscribe', { subscription: { endpoint, keys } })).status, 400, endpoint);
  assert.equal((await S.admin('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys } })).status, 200);
  assert.equal((await S.admin('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/abc', keys } })).status, 200);
});

test('Claude connector: approval page names the app, redirect_uri required, used refresh token ends the connection, password change disconnects', async () => {
  await S.admin('PUT', '/api/admin/integrations/claude', { enabled: true });
  const k = await newLogin(S.admin, 'Kutub', 'kutub', { site: 'tech' });
  const RU = 'http://localhost:7777/cb';
  const reg = await fetch(BASE + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [RU] }) }).then(r => r.json());
  assert.equal((await fetch(BASE + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) })).status, 400);
  const connect = async () => {
    const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const page = await k('GET', `/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(RU)}&code_challenge=${challenge}&code_challenge_method=S256`);
    assert.match(String(page.data), /<b>an app at localhost:7777<\/b>/);
    const consent = String(page.data).match(/name="consent" value="([^"]+)"/)[1];
    const dec = await fetch(BASE + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { Cookie: k.cookie(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: `consent=${consent}&decision=allow` });
    return { code: new URL(dec.headers.get('location')).searchParams.get('code'), verifier };
  };
  const tokenCall = body => fetch(BASE + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: reg.client_id, ...body }).toString() }).then(async r => ({ status: r.status, data: await r.json() }));
  let c = await connect();
  assert.equal((await tokenCall({ grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier })).status, 400);   // no redirect_uri
  c = await connect();
  const t1 = await tokenCall({ grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier, redirect_uri: RU });
  assert.equal(t1.status, 200);
  const t2 = await tokenCall({ grant_type: 'refresh_token', refresh_token: t1.data.refresh_token });
  assert.equal(t2.status, 200);
  const replay = await tokenCall({ grant_type: 'refresh_token', refresh_token: t1.data.refresh_token });   // the old one again: copied
  assert.equal(replay.status, 400);
  assert.equal((await tokenCall({ grant_type: 'refresh_token', refresh_token: t2.data.refresh_token })).status, 400);   // whole connection ended
  // a fresh connection stops when the password changes
  c = await connect();
  const t3 = await tokenCall({ grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier, redirect_uri: RU });
  const mcp = () => fetch(BASE + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + t3.data.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal((await mcp()).status, 200);
  assert.equal((await k('POST', '/api/me/password', { current: 'Chosen12345!', next: 'Another12345!' })).status, 200);
  assert.equal((await mcp()).status, 401);
});

test('live updates stop when the person signs out', async () => {
  const t = client();
  await t('POST', '/api/auth/login', { username: 'tahir', password: 'Chosen12345!' });
  const ac = new AbortController();
  const r = await fetch(BASE + '/api/events', { headers: { Cookie: t.cookie() }, signal: ac.signal });
  assert.equal(r.status, 200);
  const reader = r.body.getReader();
  await reader.read();   // retry line
  await t('POST', '/api/auth/logout');
  await S.admin('PATCH', '/api/admin/users/' + (await S.admin('GET', '/api/admin/users')).data.users.find(u => u.username === 'victim').id, { phone: '1' });   // any change → an event
  const end = await Promise.race([reader.read(), new Promise(res => setTimeout(() => res('timeout'), 3000))]);
  assert.equal(end.done, true);
  ac.abort();
});

test('sign-in page only returns to pages of this site', async () => {
  const js = await (await fetch(BASE + '/login.js')).text();
  const pick = new Function('location', 'URLSearchParams', 'URL', js.match(/var next = (\(function\(\)\{[\s\S]*?\}\)\(\));/)[1].replace(/^/, 'var q = new URLSearchParams(location.search); return '));
  const at = n => pick({ search: '?next=' + encodeURIComponent(n), origin: 'https://design.expresskw.com' }, URLSearchParams, URL);
  assert.equal(at('/app/site.html#p=1'), '/app/site.html#p=1');
  for (const n of ['//evil.example/', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)']) assert.equal(at(n), '/', n);
});

test('the planner loads its libraries from this server, not from outside sites', async () => {
  const page = await S.admin('GET', '/app/');
  assert.equal(page.status, 200);
  assert.ok(!/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/.test(page.data));
  assert.match(page.data, /\/app\/vendor\/cdnjs\/ajax\/libs\/pdf\.js\/3\.11\.174\/pdf\.min\.js/);
  const csp = page.headers.get('content-security-policy');
  assert.ok(!/cdnjs|jsdelivr/.test(csp), csp);
  const sw = await S.admin('GET', '/app/sw.js');
  assert.ok(!/cdnjs\.cloudflare\.com/.test(sw.data.replace('url.hostname !== "cdnjs.cloudflare.com"', '')));
  const lib = await fetch(BASE + '/app/vendor/cdnjs/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  assert.equal(lib.status, 200); assert.match(lib.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(BASE + '/app/vendor/cdnjs/../../secret.key')).status, 404);
  const site = await S.admin('GET', '/app/site.html');
  assert.ok(!/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(site.data));
});
