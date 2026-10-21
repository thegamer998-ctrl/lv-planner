'use strict';
// Moving from Cloudflare: copies every live project (drawings, points, ticks, photos, notes, site reports, activity,
// cabinet checklists, people, client links, the planner files saved on the server) from the old ExpressTech server
// (the Cloudflare Worker) into this server. Uses the old server's office key, typed by the admin.
// Safe to run again: rows are matched by their ids and replaced, so a second run just brings the latest changes over.
const { db, now, meta, tx } = require('./db');
const bridge = require('./worker-bridge');

const ORDER = ['staff', 'projects', 'floors', 'floor_pdf', 'points', 'photos', 'notes', 'issues', 'checks', 'log', 'pfile'];
const state = { running: false, log: [], done: null, error: null, startedAt: null, counts: {} };

function say(line) { state.log.push(new Date().toISOString().slice(11, 19) + '  ' + line); if (state.log.length > 300) state.log.shift(); console.log('[import]', line); }

async function getJson(base, key, path) {
  const r = await fetch(base + path, { headers: { 'X-Admin-Key': key }, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('The old server says the office key is wrong.');
  if (r.status === 404 && /Not found/.test(j.error || '')) throw new Error('The old server does not have the export yet — the latest server/worker.js must be deployed on Cloudflare first (push to main).');
  if (!r.ok) throw new Error(j.error || 'Old server error ' + r.status);
  return j;
}
async function getBlob(base, key, table, rid, col) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${base}/site/export/${table}/blob?rid=${rid}&col=${col}`, { headers: { 'X-Admin-Key': key }, signal: AbortSignal.timeout(120000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('status ' + r.status);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) { if (i === 2) throw new Error(`Could not copy a picture (${table} ${rid}): ${e.message}`); await new Promise(res => setTimeout(res, 1500)); }
  }
}

async function run({ url, key, fresh, owner }) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('Give the old server address, e.g. https://expresstech.hussaink-060.workers.dev');
  if (!key) throw new Error('Type the office key of the old server.');
  await bridge.ready();
  const hello = await fetch(base + '/', { signal: AbortSignal.timeout(20000) }).then(r => r.json()).catch(() => null);
  if (!hello || !hello.ok) throw new Error('That address does not answer like the ExpressTech server.');
  if (fresh) {
    say('Clearing the live projects on this server first');
    tx(() => { for (const t of ORDER) db.prepare(`DELETE FROM ${t}`).run(); });
  }
  const imported = { staff: new Set() };
  for (const t of ORDER) {
    const local = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
    let after = 0, n = 0, pics = 0;
    for (;;) {
      const page = await getJson(base, key, `/site/export/${t}?after=${after}&limit=${['floors', 'floor_pdf', 'photos', 'pfile'].includes(t) ? 40 : 300}`);
      for (const row of page.rows) {
        after = row._rid;
        const cols = page.columns.filter(c => local.has(c)), vals = [];
        for (const c of cols) {
          if (page.blobs.includes(c)) { const v = row[c] ? await getBlob(base, key, t, row._rid, c) : null; if (v) pics++; vals.push(v); }
          else vals.push(row[c] === undefined ? null : row[c]);
        }
        db.prepare(`INSERT OR REPLACE INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
        if (t === 'staff') imported.staff.add(row.id);
        n++;
      }
      if (!page.more) break;
    }
    state.counts[t] = n;
    say(`${t}: ${n} row${n === 1 ? '' : 's'}${pics ? ` (${pics} picture${pics === 1 ? '' : 's'} / drawing parts)` : ''}`);
  }
  // nothing that already happened becomes a notification
  const m = db.prepare('SELECT MAX(id) n FROM log').get();
  meta.set('notified_log_id', (m && m.n) || 0);

  // people: link each person of the old site app to the login with the same (first) name. A login made before the import
  // got a new, empty site app record; it is swapped for the old one (with the projects and history) as long as no
  // project's team uses the new one yet.
  const linked = [], unmatched = [];
  const inTeams = new Set();
  for (const p of db.prepare('SELECT team FROM projects').all()) { try { for (const x of JSON.parse(p.team || '[]') || []) inTeams.add(x); } catch (e) {} }
  const free = u => !u.staff_id || (!imported.staff.has(u.staff_id) && !inTeams.has(u.staff_id));
  for (const s of db.prepare('SELECT * FROM staff ORDER BY name').all()) {
    if (!imported.staff.has(s.id) || db.prepare('SELECT 1 FROM users WHERE staff_id=?').get(s.id)) continue;
    const first = String(s.name).toLowerCase().split(/\s+/)[0];
    const u = db.prepare('SELECT * FROM users WHERE active=1').all().filter(free)
      .find(x => x.name.toLowerCase() === s.name.toLowerCase() || x.name.toLowerCase().split(/\s+/)[0] === first || x.username.toLowerCase() === first);
    if (u) {
      if (u.staff_id) db.prepare('DELETE FROM staff WHERE id=?').run(u.staff_id);
      db.prepare('UPDATE users SET staff_id=? WHERE id=?').run(s.id, u.id); bridge.syncStaff(u.id); linked.push(`${s.name} → ${u.name}`);
    }
    else if (s.active) unmatched.push(s.name + ' (' + ({ tech: 'technician', engineer: 'site engineer', manager: 'manager' }[s.role] || s.role) + ')');
  }
  if (linked.length) say('Linked to logins: ' + linked.join(', '));
  if (unmatched.length) say('Not linked yet (add a login for them and pick them under “Site app person”): ' + unmatched.join(', '));

  // planner files that were saved on the server → Design Center projects (owned by the admin running the import)
  const dc = require('./dc');
  const ownerRow = db.prepare('SELECT * FROM users WHERE id=?').get(owner);
  const ownerUser = require('./auth').toUser(ownerRow);
  let files = 0, skipped = 0;
  for (const p of db.prepare('SELECT id, name, pfile_parts, pfile_at FROM projects WHERE pfile_parts > 0').all()) {
    const parts = db.prepare('SELECT data FROM pfile WHERE project_id=? ORDER BY part').all(p.id);
    if (parts.length !== p.pfile_parts) { say(`Planner file of ${p.name}: incomplete on the old server, skipped`); continue; }
    let data; try { data = JSON.parse(Buffer.concat(parts.map(x => Buffer.from(x.data))).toString('utf8')); } catch (e) { say(`Planner file of ${p.name}: could not be read, skipped`); continue; }
    const have = db.prepare('SELECT id, updated_at, version FROM dc_projects WHERE site_id=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1').get(p.id);
    const at = new Date(p.pfile_at || Date.now()).toISOString();
    if (have && have.updated_at >= at) { skipped++; continue; }
    if (have) dc.save(ownerUser, have.id, { data, baseVersion: have.version, force: true });
    else dc.create(ownerUser, data, { at });
    files++;
  }
  say(`Planner files: ${files} brought over as Design Center projects${skipped ? `, ${skipped} already up to date` : ''} (owner: ${ownerRow.name} — share them from My projects)`);
  meta.set('imported_from', base); meta.set('imported_at', now());
  return { counts: state.counts, linked, unmatched, files };
}

function start(opts) {
  if (state.running) throw new Error('An import is already running.');
  Object.assign(state, { running: true, log: [], done: null, error: null, startedAt: now(), counts: {} });
  say('Copying from ' + opts.url);
  run(opts).then(r => { state.done = r; say('Finished.'); }).catch(e => { state.error = e.message; say('Stopped: ' + e.message); }).finally(() => { state.running = false; });
}
const status = () => ({ running: state.running, log: state.log, done: state.done, error: state.error, startedAt: state.startedAt, last: { from: meta.get('imported_from') || null, at: meta.get('imported_at') || null } });

module.exports = { start, run, status };
