'use strict';
// Moving from Cloudflare: a stand-in old server (test/fake-cloudflare.js) gets a project with a drawing, a photo, a staff
// member and a saved planner file; the new server copies everything and the client link keeps working.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'et-imp-'));
const OLD = 38000 + Math.floor(Math.random() * 900), NEW = OLD + 1000, KEY = 'old-office-key-123';
const procs = [];
function start(args, env) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p); let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  return () => out;
}
async function wait(url) { for (let i = 0; i < 60; i++) { try { await fetch(url); return; } catch (e) {} await new Promise(r => setTimeout(r, 200)); } throw new Error('no answer from ' + url); }
let cookie = '';
async function api(method, p, body) {
  const r = await fetch(`http://127.0.0.1:${NEW}${p}`, { method, headers: { 'X-Express': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const old = (p, opts = {}) => fetch(`http://127.0.0.1:${OLD}${p}`, { ...opts, headers: { 'X-Admin-Key': KEY, ...(opts.headers || {}) } });

before(async () => {
  start([path.join(__dirname, 'fake-cloudflare.js'), String(OLD), path.join(DIR, 'old.db'), KEY], {});
  start([path.join(__dirname, '..', 'src', 'server.js')], { DATA_DIR: path.join(DIR, 'new'), PORT: String(NEW), HOST: '127.0.0.1', APP_URL: `http://127.0.0.1:${NEW}`, ADMIN_NAME: 'Husain Kazi', ADMIN_USERNAME: 'husain', ADMIN_PASSWORD: 'FirstPass123', ENV_FILE: '/nonexistent' });
  await wait(`http://127.0.0.1:${OLD}/`); await wait(`http://127.0.0.1:${NEW}/api/health`);
});
after(() => { procs.forEach(p => p.kill()); fs.rmSync(DIR, { recursive: true, force: true }); });

test('everything comes over from the old server', async () => {
  // the old server: a person, a project with a drawing, a tick, a photo and the planner file
  const st = await (await old('/site/staff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Kutbuddin', role: 'tech' }) })).json();
  const pub = await (await old('/site/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Al Bisher', meta: {}, floors: [{ id: 'f1', name: 'GF' }], points: [{ id: 'p1', floorId: 'f1', type: 'wifi', cat: 'ap', label: 'GF-AP01', x: 0.1, y: 0.2 }] }) })).json();
  const img = Buffer.alloc(300000, 7);
  assert.equal((await old(`/site/p/${pub.id}/floor/f1?w=10&h=10`, { method: 'PUT', body: img })).status, 200);
  await old(`/site/p/${pub.id}/pt/p1/status`, { method: 'POST', headers: { 'X-Key': st.person.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'installed', done: true }) });
  await old(`/site/p/${pub.id}/pt/p1/photo?w=4&h=3&caption=box`, { method: 'POST', headers: { 'X-Key': st.person.key }, body: Buffer.from('fake-jpeg-bytes') });
  const pdf = Buffer.from('%PDF-1.4 drawing');
  const file = JSON.stringify({ name: 'Al Bisher', site: { id: pub.id }, floors: [{ id: 'f1', name: 'GF', pdfBase64: pdf.toString('base64'), markers: [{ id: 'p1', type: 'wifi' }] }] });
  assert.equal((await old(`/site/p/${pub.id}/file?part=0&parts=1&at=1700000000000&by=iPad`, { method: 'PUT', body: file })).status, 200);

  // the new server: admin + a login for Kutub, then import
  let r = await api('POST', '/api/auth/login', { username: 'husain', password: 'FirstPass123' });
  await api('POST', '/api/me/password', { current: 'FirstPass123', next: 'HusainPass1' });
  r = await api('POST', '/api/admin/users', { name: 'Kutbuddin Hussain', username: 'kutub', perms: { site: 'tech' } });
  const wrong = await api('POST', '/api/admin/import', { url: `http://127.0.0.1:${OLD}`, key: 'nope' });
  assert.equal(wrong.status, 202);
  for (let i = 0; i < 50; i++) { const s = await api('GET', '/api/admin/import'); if (!s.data.running) { assert.match(s.data.error, /office key is wrong/); break; } await new Promise(x => setTimeout(x, 200)); }
  await api('POST', '/api/admin/import', { url: `http://127.0.0.1:${OLD}`, key: KEY });
  let s;
  for (let i = 0; i < 100; i++) { s = await api('GET', '/api/admin/import'); if (!s.data.running) break; await new Promise(x => setTimeout(x, 200)); }
  assert.equal(s.data.error, null, s.data.log.join('\n'));
  assert.equal(s.data.done.counts.photos, 1);
  assert.equal(s.data.done.files, 1);
  assert.deepEqual(s.data.done.linked, ['Kutbuddin → Kutbuddin Hussain']);

  // the client link works with the same key, the picture is complete, the tick kept its name
  const view = await fetch(`http://127.0.0.1:${NEW}/site/p/${pub.id}?k=${pub.view_key}`).then(x => x.json());
  assert.equal(view.role, 'customer');
  assert.equal(view.points[0].installed_by, 'Kutbuddin');
  const fl = Buffer.from(await (await fetch(`http://127.0.0.1:${NEW}/site/p/${pub.id}/floor/f1?k=${pub.view_key}`)).arrayBuffer());
  assert.equal(fl.length, img.length);
  // the planner file became a Design Center project linked to the live project, with its drawing stored once
  const dcs = await api('GET', '/api/dc/projects');
  assert.equal(dcs.data.projects.length, 1);
  assert.equal(dcs.data.projects[0].siteId, pub.id);
  const full = await api('GET', '/api/dc/projects/' + dcs.data.projects[0].id);
  assert.match(full.data.data.floors[0].pdfRef, /^[0-9a-f]{64}$/);
  assert.equal(full.data.data.floors[0].pdfBase64, null);
  // running it again changes nothing
  await api('POST', '/api/admin/import', { url: `http://127.0.0.1:${OLD}`, key: KEY });
  for (let i = 0; i < 100; i++) { s = await api('GET', '/api/admin/import'); if (!s.data.running) break; await new Promise(x => setTimeout(x, 200)); }
  assert.equal(s.data.done.files, 0);
  assert.equal((await api('GET', '/api/dc/projects')).data.projects.length, 1);
});
