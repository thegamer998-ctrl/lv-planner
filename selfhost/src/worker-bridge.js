'use strict';
// Runs the live-project server (server/worker.js — the same file that ran on Cloudflare) inside this Node server, unchanged:
//   - its D1 database becomes this SQLite database (a small D1-compatible wrapper below)
//   - its Asana / Zoho secrets come from Admin → Integrations
//   - its cron (every 2 minutes) becomes a timer
// The planner and the site app talk to it exactly as before (/site/…, /zoho). Instead of the office key and personal links,
// a signed-in person's requests are marked "session": this file then adds the right key for that person on the server side
// (office people get the office key, everyone with a site role their own personal key), so the keys never reach a browser.
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const config = require('./config');
const { db, now } = require('./db');
const { HttpError, readBody } = require('./http');
const P = require('./perms');

/* ---------- D1-compatible wrapper over node:sqlite ---------- */
const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); if (cache.size > 400) cache.clear(); cache.set(sql, s); }
  return s;
}
const conv = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v instanceof ArrayBuffer ? new Uint8Array(v) : v;
class D1Statement {
  constructor(sql, args) { this.sql = sql; this.args = args || []; }
  bind(...a) { return new D1Statement(this.sql, a.map(conv)); }
  async first(col) { const r = stmt(this.sql).get(...this.args); if (!r) return null; return col ? r[col] : { ...r }; }
  async all() { return { results: stmt(this.sql).all(...this.args).map(r => ({ ...r })), success: true, meta: {} }; }
  async run() { const r = stmt(this.sql).run(...this.args); return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }
  async raw() { return stmt(this.sql).all(...this.args).map(r => Object.values(r)); }
}
const D1 = {
  prepare: sql => new D1Statement(sql),
  batch: async list => { const out = []; db.exec('BEGIN'); try { for (const s of list) out.push(await s.run()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return out; },
  exec: async sql => { db.exec(sql); return { count: 1 }; },
};

/* ---------- the worker ---------- */
const OFFICE_KEY = crypto.randomBytes(32).toString('base64url');   // never leaves this process
let worker = null;
async function load() {
  if (!worker) worker = (await import(pathToFileURL(config.workerFile).href)).default;
  return worker;
}
function env() {
  const integ = require('./integrations');
  return { DB: D1, ADMIN_KEY: OFFICE_KEY, ALLOWED_ORIGIN: config.appUrl, ...integ.workerEnv() };
}
const ctx = () => ({ waitUntil: p => Promise.resolve(p).catch(e => console.error('[site] background', e && e.message || e)), passThroughOnException() {} });

// Call the worker from inside the server (as the office). Returns parsed JSON or throws.
async function call(path, opts = {}) {
  const w = await load();
  const headers = new Headers(opts.headers || {});
  headers.set('X-Admin-Key', OFFICE_KEY);
  if (opts.json !== undefined) { headers.set('Content-Type', 'application/json'); opts.body = JSON.stringify(opts.json); }
  const r = await w.fetch(new Request('http://worker' + path, { method: opts.method || 'GET', headers, body: opts.body }), env(), ctx());
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) { if (!r.ok) throw new HttpError(r.status, 'Live projects: error ' + r.status); return Buffer.from(await r.arrayBuffer()); }
  const j = await r.json();
  if (!r.ok) throw new HttpError(r.status, j.error || ('Live projects: error ' + r.status));
  return j;
}
// Call it as one person (their personal record), e.g. for the Claude connector: only what they may see.
async function callAs(user, path, opts = {}) {
  const w = await load();
  const headers = new Headers(opts.headers || {});
  const p = user.perms;
  if (p.office) headers.set('X-Admin-Key', OFFICE_KEY);
  const st = ensureStaff(user.id);
  if (st) headers.set('X-Key', st.key);
  if (p.office) headers.set('X-By', user.name);
  if (!p.office && !st) throw new HttpError(403, 'This login has no access to live projects.');
  if (opts.json !== undefined) { headers.set('Content-Type', 'application/json'); opts.body = JSON.stringify(opts.json); }
  const r = await w.fetch(new Request('http://worker' + path, { method: opts.method || 'GET', headers, body: opts.body }), env(), ctx());
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status, j.error || ('Live projects: error ' + r.status));
  return j;
}

// Create the live-project tables (the worker does this on its first request).
async function ready() { await call('/site/list'); }

/* ---------- people: each login with access to live projects has its personal record (the worker's "staff" table) ---------- */
function rid(n) { const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from(crypto.randomBytes(n), b => a[b % a.length]).join(''); }
// Keep the personal record in step with the login: name, role (technician / site engineer / manager), active.
function syncStaff(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!u) return null;
  const p = P.permsOf(u), role = P.staffRole(p), on = !!(u.active && role);
  let st = u.staff_id ? db.prepare('SELECT * FROM staff WHERE id=?').get(u.staff_id) : null;
  if (!st) {
    if (!on) return null;
    const sid = rid(10);
    db.prepare('INSERT INTO staff (id, name, role, key, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(sid, u.name.slice(0, 40), role, rid(24), Date.now());
    db.prepare('UPDATE users SET staff_id=? WHERE id=?').run(sid, u.id);
    st = db.prepare('SELECT * FROM staff WHERE id=?').get(sid);
  } else {
    db.prepare('UPDATE staff SET name=?, role=?, active=? WHERE id=?').run(u.name.slice(0, 40), role || st.role, on ? 1 : 0, st.id);
    st = db.prepare('SELECT * FROM staff WHERE id=?').get(st.id);
  }
  return st.active ? st : null;
}
function ensureStaff(userId) {
  const u = db.prepare('SELECT staff_id FROM users WHERE id=?').get(userId);
  const st = u && u.staff_id ? db.prepare('SELECT * FROM staff WHERE id=? AND active=1').get(u.staff_id) : null;
  return st || syncStaff(userId);
}
// People in the site app who have no login yet (made with the old personal links): offered when adding a login,
// so the new login keeps that person's projects, ticks and history.
function unlinkedStaff() {
  return db.prepare('SELECT s.id, s.name, s.role, s.active FROM staff s WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.staff_id = s.id) ORDER BY s.active DESC, s.name').all();
}

/* ---------- requests from the planner / site app ---------- */
const SESSION = 'session';
// The planner sends X-Admin-Key: session, the site app X-Key: session (and ?k=session on photos and drawings).
function marked(req, url) {
  const h = req.headers;
  return h['x-admin-key'] === SESSION || h['x-relay-key'] === SESSION || h['x-key'] === SESSION || url.searchParams.get('k') === SESSION;
}

async function handle(req, res, url, getUser, hooks) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !/^(host|connection|content-length|transfer-encoding|x-admin-key|x-relay-key)$/i.test(k)) headers.set(k, v);
  const mark = marked(req, url);
  let user = null, staff = null;
  if (/^\/site\/export(\/|$)/.test(path)) throw new HttpError(404, 'Not found');
  if (mark) {
    user = getUser();
    if (!user) throw new HttpError(401, 'Please sign in.', { signIn: true });
    if (user.mustChangePassword) throw new HttpError(403, 'Please set your own password first.', { mustChangePassword: true });
    const p = user.perms;
    const officeOnly = path === '/site/publish' || path === '/site/list' || path === '/site/staff';
    if (/^\/site\/staff\/./.test(path) || (path === '/site/staff' && req.method === 'POST'))
      throw new HttpError(400, 'People are added in Admin → Logins & permissions now (each person has their own username and password).');
    if (path === '/zoho' && !(p.design || p.office)) throw new HttpError(403, 'Your login has no Design Center access.');
    if (officeOnly && !p.office) throw new HttpError(403, 'Only the live projects office can do this. Ask an admin for “Live projects office” access.');
    if (path.startsWith('/site/') && !officeOnly && !P.liveAccess(p)) throw new HttpError(403, 'Your login has no access to live projects. Ask an admin to give you a site app role.');
    if (p.office || path === '/zoho') { headers.set('X-Admin-Key', OFFICE_KEY); headers.set('X-By', user.name); }
    if (path.startsWith('/site/') && P.liveAccess(p)) {
      staff = ensureStaff(user.id);
      if (staff) headers.set('X-Key', staff.key); else headers.delete('X-Key');
    } else headers.delete('X-Key');
    if (url.searchParams.get('k') === SESSION) {
      if (staff) url.searchParams.set('k', staff.key); else url.searchParams.delete('k');
    }
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req, 40 * 1024 * 1024);
  if (body && body.length) headers.set('content-length', String(body.length));
  const before = hooks && hooks.before ? hooks.before(path, req.method, body) : null;
  const w = await load();
  const r = await w.fetch(new Request('http://worker' + path + url.search, { method: req.method, headers, body }), env(), ctx());
  const out = Buffer.from(await r.arrayBuffer());
  const h = {};
  r.headers.forEach((v, k) => { h[k] = v; });
  h['content-length'] = String(out.length);
  res.writeHead(r.status, h);
  res.end(req.method === 'HEAD' ? undefined : out);
  if (hooks && hooks.after && r.status < 400 && req.method !== 'GET') {
    let json = null; try { json = JSON.parse(out.toString('utf8')); } catch (e) {}
    try { hooks.after(path, req.method, user, before, json, body); } catch (e) { console.error('[site] after hook', e); }
  }
}

/* ---------- cron: keep the Asana mirrors fresh ---------- */
function startCron() {
  const tick = async () => {
    const e = env();
    if (!e.ASANA_TOKEN) return;
    try { await (await load()).scheduled({ cron: '*/2 * * * *', scheduledTime: Date.now() }, e, ctx()); }
    catch (err) { console.error('[asana] cron', err.message); }
  };
  setTimeout(tick, 15e3).unref();
  setInterval(tick, config.asanaCronSeconds * 1000).unref();
}

module.exports = { D1, load, call, callAs, ready, handle, syncStaff, ensureStaff, unlinkedStaff, startCron };
