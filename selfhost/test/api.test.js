'use strict';
// End-to-end API tests: starts the real server on a free port with an empty data folder.
//   npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = 39000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'et-test-'));
let proc;

function client() {
  let cookie = '';
  const c = async (method, p, body, headers = {}) => {
    const h = { 'X-Express': '1', ...headers };
    if (cookie) h.Cookie = cookie;
    let b = body;
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
    const r = await fetch(BASE + p, { method, headers: h, body: b, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data, headers: r.headers };
  };
  c.cookie = () => cookie;
  return c;
}
async function signIn(username, password, next) {
  const c = client();
  const r = await c('POST', '/api/auth/login', { username, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  if (r.data.mustChangePassword) { const r2 = await c('POST', '/api/me/password', { current: password, next: next || 'GoodPassw0rd!' }); assert.equal(r2.status, 200, JSON.stringify(r2.data)); }
  return c;
}

const S = {};
before(async () => {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', APP_URL: BASE, ADMIN_NAME: 'Husain Kazi', ADMIN_USERNAME: 'husain', ADMIN_PASSWORD: 'FirstPass123', ENV_FILE: '/nonexistent' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', d => { out += d; }); proc.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 200)); }
  throw new Error('server did not start:\n' + out);
});
after(() => { proc.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('admin signs in and must choose a password', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/login', { username: 'husain', password: 'FirstPass123' });
  assert.equal(r.data.mustChangePassword, true);
  const blocked = await c('GET', '/api/dc/projects');
  assert.equal(blocked.status, 403);
  await c('POST', '/api/me/password', { current: 'FirstPass123', next: 'HusainPass1' });
  S.admin = c;
  const me = await c('GET', '/api/me');
  assert.equal(me.data.user.perms.admin, true);
  const wrong = await client()('POST', '/api/auth/login', { username: 'husain', password: 'nope' });
  assert.equal(wrong.status, 401);
});

test('admin adds logins with permissions', async () => {
  const add = async (name, username, perms) => {
    const r = await S.admin('POST', '/api/admin/users', { name, username, perms });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { id: r.data.user.id, pw: r.data.password, user: r.data.user };
  };
  S.aziz = await add('Aziz', 'aziz', { admin: true });
  S.tahir = await add('Tahir', 'tahir', { design: true });
  S.idris = await add('Idris', 'idris', { design: true, site: 'engineer' });
  S.kutub = await add('Kutub', 'kutub', { site: 'tech' });
  assert.equal(S.kutub.user.staff.role, 'tech');
  assert.equal(S.tahir.user.staff, null);
  assert.equal(S.idris.user.access, 'Design Center + Site engineer');
  const dup = await S.admin('POST', '/api/admin/users', { name: 'Kutub Two', username: 'KUTUB', perms: {} });
  assert.equal(dup.status, 409);
  S.tahirC = await signIn('tahir', S.tahir.pw);
  S.idrisC = await signIn('idris', S.idris.pw);
  S.kutubC = await signIn('kutub', S.kutub.pw);
  const nope = await S.tahirC('GET', '/api/admin/users');
  assert.equal(nope.status, 403);
});

test('planner page needs Design Center access and gets the hosted script', async () => {
  const r = await S.tahirC('GET', '/app/');
  assert.equal(r.status, 200);
  assert.match(r.data, /<script src="\/hosted\.js/);
  const k = await S.kutubC('GET', '/app/');
  assert.equal(k.status, 302);
  assert.match(k.headers.get('location'), /no=design/);
  const anon = await client()('GET', '/app/');
  assert.equal(anon.status, 302);
  const site = await client()('GET', '/app/site.html');
  assert.equal(site.status, 200);
  const hidden = await client()('GET', '/app/wrangler.toml');
  assert.equal(hidden.status, 404);
  const deep = await client()('GET', '/app/server/worker.js');
  assert.equal(deep.status, 404);
});

test('live project: office publishes, technician ticks, customer link sees no MAC', async () => {
  const pub = { name: 'Al Bisher Villa', meta: {}, floors: [{ id: 'f1', name: 'Ground Floor', w: 1000, h: 800 }],
    points: [{ id: 'p1', floorId: 'f1', type: 'wifi', cat: 'ap', label: 'GF-AP01', x: 0.2, y: 0.3 }, { id: 'p2', floorId: 'f1', type: 'rack', cat: 'rack', label: 'RACK', x: 0.5, y: 0.5 }] };
  const denied = await S.tahirC('POST', '/site/publish', pub, { 'X-Admin-Key': 'session' });
  assert.equal(denied.status, 403);
  const forged = await client()('POST', '/site/publish', pub, { 'X-Admin-Key': 'guess' });
  assert.equal(forged.status, 401);
  const r = await S.admin('POST', '/site/publish', pub, { 'X-Admin-Key': 'session' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  S.pid = r.data.id; S.viewKey = r.data.view_key;
  const me = await S.kutubC('GET', '/site/me', undefined, { 'X-Key': 'session' });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.equal(me.data.person.name, 'Kutub');
  assert.ok(me.data.projects.some(p => p.id === S.pid));
  const tick = await S.kutubC('POST', `/site/p/${S.pid}/pt/p1/status`, { step: 'installed', done: true }, { 'X-Key': 'session' });
  assert.equal(tick.status, 200, JSON.stringify(tick.data));
  assert.equal(tick.data.installed_by, 'Kutub');
  const cfg = await S.kutubC('POST', `/site/p/${S.pid}/pt/p1/status`, { step: 'configured', done: true }, { 'X-Key': 'session' });
  assert.equal(cfg.status, 403);
  const eng = await S.idrisC('POST', `/site/p/${S.pid}/pt/p1/status`, { step: 'configured', done: true }, { 'X-Key': 'session' });
  assert.equal(eng.status, 200, JSON.stringify(eng.data));
  const mac = await S.kutubC('POST', `/site/p/${S.pid}/pt/p1/mac`, { mac: 'aa:bb:cc:dd:ee:ff' }, { 'X-Key': 'session' });
  assert.equal(mac.status, 200);
  const cust = await client()('GET', `/site/p/${S.pid}?k=${S.viewKey}`);
  assert.equal(cust.data.role, 'customer');
  assert.equal(cust.data.points[0].mac, undefined);
  const office = await S.admin('GET', `/site/p/${S.pid}`, undefined, { 'X-Admin-Key': 'session' });
  assert.equal(office.data.role, 'office');
  assert.equal(office.data.points.find(p => p.point_id === 'p1').mac, 'AA:BB:CC:DD:EE:FF');
  const tahirSite = await S.tahirC('GET', '/site/me', undefined, { 'X-Key': 'session' });
  assert.equal(tahirSite.status, 403);
  const noStaff = await S.admin('POST', '/site/staff', { name: 'X', role: 'tech' }, { 'X-Admin-Key': 'session' });
  assert.equal(noStaff.status, 400);
});

test('site report notifies the office; the answer notifies the technician', async () => {
  const rep = await S.kutubC('POST', `/site/p/${S.pid}/issue`, { kind: 'missing', floorId: 'f1', x: 0.4, y: 0.4, text: 'Extra AP needed in the majlis' }, { 'X-Key': 'session' });
  assert.equal(rep.status, 200);
  await new Promise(r => setTimeout(r, 600));
  const n = await S.admin('GET', '/api/notifications');
  assert.ok(n.data.items.some(x => x.kind === 'report' && /majlis/.test(x.body)), JSON.stringify(n.data));
  const st = await S.admin('POST', `/site/p/${S.pid}/issue/${rep.data.id}/status`, { status: 'approved', reply: 'OK' }, { 'X-Admin-Key': 'session' });
  assert.equal(st.status, 200);
  await new Promise(r => setTimeout(r, 600));
  const k = await S.kutubC('GET', '/api/notifications');
  assert.ok(k.data.items.some(x => x.kind === 'report_reply'), JSON.stringify(k.data));
});

test('Design Center: save with drawing, share, conflict, versions', async () => {
  const pdf = Buffer.from('%PDF-1.4\n% test drawing\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const h = crypto.createHash('sha256').update(pdf).digest('hex');
  const missing = await S.admin('POST', '/api/dc/projects', { data: { name: 'Villa 387', floors: [{ id: 'a', name: 'GF', pdfRef: h, markers: [] }] } });
  assert.equal(missing.status, 409);
  const up = await S.admin('PUT', '/api/dc/blobs/' + h, new Uint8Array(pdf), { 'Content-Type': 'application/pdf' });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const bad = await S.admin('PUT', '/api/dc/blobs/' + 'a'.repeat(64), new Uint8Array(pdf));
  assert.equal(bad.status, 400);
  const cr = await S.admin('POST', '/api/dc/projects', { data: { name: 'Villa 387', floors: [{ id: 'a', name: 'GF', pdfRef: h, markers: [{ id: 'm1', type: 'wifi' }] }] } });
  assert.equal(cr.status, 201);
  const id = cr.data.project.id; S.dcId = id;
  assert.equal(cr.data.project.points, 1);
  const sv = await S.admin('PUT', '/api/dc/projects/' + id, { baseVersion: 1, data: { name: 'Villa 387', floors: [{ id: 'a', name: 'GF', pdfRef: h, markers: [{ id: 'm1', type: 'wifi' }, { id: 'm2', type: 'cctv' }] }] } });
  assert.equal(sv.data.project.version, 2);
  const tahirNo = await S.tahirC('GET', '/api/dc/projects/' + id);
  assert.equal(tahirNo.status, 404);
  const sh = await S.admin('PUT', `/api/dc/projects/${id}/shares/${S.tahir.id}`, { canEdit: true });
  assert.equal(sh.status, 200);
  const kutubShare = await S.admin('PUT', `/api/dc/projects/${id}/shares/${S.kutub.id}`, { canEdit: true });
  assert.equal(kutubShare.status, 400);
  const shared = await S.tahirC('GET', '/api/dc/projects?scope=shared');
  assert.equal(shared.data.projects[0].owner.name, 'Husain Kazi');
  const tn = await S.tahirC('GET', '/api/notifications');
  assert.ok(tn.data.items.some(x => x.kind === 'share' && /shared “Villa 387”/.test(x.title)));
  const t = await S.tahirC('GET', '/api/dc/projects/' + id);
  t.data.data.floors[0].markers.push({ id: 'm3', type: 'network' });
  const ts = await S.tahirC('PUT', '/api/dc/projects/' + id, { baseVersion: t.data.project.version, data: t.data.data });
  assert.equal(ts.data.project.version, 3);
  assert.equal(ts.data.project.updatedBy.name, 'Tahir');
  const stale = await S.admin('PUT', '/api/dc/projects/' + id, { baseVersion: 2, data: { name: 'Villa 387', floors: [] } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.conflict.updatedBy, 'Tahir');
  const v = await S.admin('GET', `/api/dc/projects/${id}/versions`);
  assert.ok(v.data.versions.length >= 2);
  const blob = await S.tahirC('GET', '/api/dc/blobs/' + h);
  assert.equal(blob.status, 200);
  const del = await S.tahirC('DELETE', '/api/dc/projects/' + id);
  assert.equal(del.status, 403);
  const csrf = await fetch(BASE + '/api/dc/projects/' + id, { method: 'DELETE', headers: { Cookie: S.admin.cookie() } });
  assert.equal(csrf.status, 403);
});

test('a technician is told when added to a project team', async () => {
  const staff = await S.admin('GET', '/site/staff', undefined, { 'X-Admin-Key': 'session' });
  const k = staff.data.staff.find(s => s.name === 'Kutub');
  await S.admin('POST', `/site/p/${S.pid}/team`, { team: [S.idris.user.staff ? S.idris.user.staff.id : 'x'] }, { 'X-Admin-Key': 'session' });
  await S.admin('POST', `/site/p/${S.pid}/team`, { team: [k.id] }, { 'X-Admin-Key': 'session' });
  await new Promise(r => setTimeout(r, 400));
  const n = await S.kutubC('GET', '/api/notifications');
  assert.ok(n.data.items.some(x => x.kind === 'team'), JSON.stringify(n.data.items));
});

test('switching a login off signs them out and stops their site access', async () => {
  const r = await S.admin('PATCH', '/api/admin/users/' + S.kutub.id, { active: false });
  assert.equal(r.status, 200);
  const me = await S.kutubC('GET', '/api/me');
  assert.equal(me.status, 401);
  const last = await S.admin('PATCH', '/api/admin/users/' + S.aziz.id, { active: false });
  assert.equal(last.status, 200);
  const self = await S.admin('PATCH', '/api/admin/users/' + (await S.admin('GET', '/api/me')).data.user.id, { perms: { design: true } });
  assert.equal(self.status, 400);   // the last admin
});

test('Claude connector: OAuth sign-in and tools', async () => {
  await S.admin('PUT', '/api/admin/integrations/claude', { enabled: true });
  const reg = await fetch(BASE + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['http://localhost:7777/cb'] }) }).then(r => r.json());
  const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const page = await S.admin('GET', `/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent('http://localhost:7777/cb')}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`);
  const consent = String(page.data).match(/name="consent" value="([^"]+)"/)[1];
  const dec = await fetch(BASE + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { Cookie: S.admin.cookie(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: `consent=${consent}&decision=allow` });
  const code = new URL(dec.headers.get('location')).searchParams.get('code');
  const tok = await fetch(BASE + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=authorization_code&code=${code}&client_id=${reg.client_id}&code_verifier=${verifier}&redirect_uri=${encodeURIComponent('http://localhost:7777/cb')}` }).then(r => r.json());
  assert.ok(tok.access_token);
  const rpc = async (method, params) => (await fetch(BASE + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  const tools = await rpc('tools/list', {});
  assert.ok(tools.result.tools.some(t => t.name === 'get_design_project_file'));
  assert.ok(!tools.result.tools.some(t => t.name === 'add_point_note'));   // read-only by default
  const list = await rpc('tools/call', { name: 'list_design_projects', arguments: { scope: 'mine' } });
  assert.match(list.result.content[0].text, /Villa 387/);
  const sum = await rpc('tools/call', { name: 'get_design_project', arguments: { project_id: S.dcId } });
  assert.equal(sum.result.structuredContent.total_points, 3);
  const live = await rpc('tools/call', { name: 'get_live_project', arguments: { live_project_id: S.pid } });
  assert.equal(live.result.structuredContent.name, 'Al Bisher Villa');
});
