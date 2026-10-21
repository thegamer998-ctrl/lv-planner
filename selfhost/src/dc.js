'use strict';
// Design Center projects: the planner's project file, kept on the server under its owner's login.
//   - saved automatically while you work (every few seconds), every device opens the same latest version
//   - floor drawings (PDFs) are stored once each, by their fingerprint (SHA-256), not inside every save
//   - shared with other logins ("shared by Husain"), who can edit it too; a save based on an older version is refused
//     with a clear choice instead of silently overwriting someone's work
//   - earlier versions are kept (every ~20 minutes of work and whenever someone else saves) and can be restored
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { db, now, id, tx } = require('./db');
const { HttpError } = require('./http');
const events = require('./events');

const SNAP_MIN = 20, KEEP_VERSIONS = 60;
const HASH_RX = /^[0-9a-f]{64}$/;
const uname = uid => (uid && (db.prepare('SELECT name FROM users WHERE id=?').get(uid) || {}).name) || '';

/* ---------- drawings (PDF files by fingerprint) ---------- */
const blobPath = h => path.join(config.blobDir, h.slice(0, 2), h + '.pdf');
const hasBlob = h => HASH_RX.test(h) && fs.existsSync(blobPath(h));
function putBlob(user, h, buf) {
  if (!HASH_RX.test(h)) throw new HttpError(400, 'Bad drawing id.');
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== h) throw new HttpError(400, 'The drawing did not arrive complete — try again.');
  const f = blobPath(h);
  if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f); }
  db.prepare('INSERT OR IGNORE INTO dc_blobs(hash,bytes,created_at,created_by) VALUES(?,?,?,?)').run(h, buf.length, now(), user ? user.id : null);
  return { hash: h, bytes: buf.length };
}
function storePdfBase64(user, b64) {
  const buf = Buffer.from(b64, 'base64');
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  putBlob(user, h, buf);
  return h;
}

/* ---------- access ---------- */
// 'owner' | 'edit' | 'view' | null
function access(user, row) {
  if (!row || !user) return null;
  if (row.owner_id === user.id) return 'owner';
  if (user.perms.admin || user.perms.allDesigns) return 'edit';
  const s = db.prepare('SELECT can_edit FROM dc_shares WHERE project_id=? AND user_id=?').get(row.id, user.id);
  return s ? (s.can_edit ? 'edit' : 'view') : null;
}
function mustSee(user, pid, opts = {}) {
  const row = db.prepare('SELECT * FROM dc_projects WHERE id=?').get(String(pid || ''));
  const a = access(user, row);
  if (!row || !a || (row.deleted_at && !opts.deleted)) throw new HttpError(404, 'Project not found — it may have been deleted, or it is not shared with you.');
  return { row, access: a };
}
// everyone who may open the project (for live updates and notifications)
function audience(row) {
  const ids = new Set([row.owner_id]);
  for (const s of db.prepare('SELECT user_id FROM dc_shares WHERE project_id=?').all(row.id)) ids.add(s.user_id);
  return ids;
}
const canSeeAll = u => u.perms.admin || u.perms.allDesigns;

/* ---------- reading / listing ---------- */
function brief(row, user) {
  const shares = db.prepare('SELECT s.user_id, s.can_edit, u.name FROM dc_shares s JOIN users u ON u.id = s.user_id WHERE s.project_id=? ORDER BY u.name').all(row.id);
  return {
    id: row.id, name: row.name, owner: { id: row.owner_id, name: uname(row.owner_id) }, access: access(user, row),
    version: row.version, points: row.points, floors: row.floors, bytes: row.bytes, siteId: row.site_id || null,
    createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: { id: row.updated_by, name: uname(row.updated_by) },
    sharedWith: shares.map(s => ({ id: s.user_id, name: s.name, canEdit: !!s.can_edit })), deletedAt: row.deleted_at || null,
  };
}
const COLS = 'id, owner_id, name, version, bytes, points, floors, site_id, created_at, updated_at, updated_by, deleted_at';
function list(user, scope) {
  let rows;
  if (scope === 'trash') rows = db.prepare(`SELECT ${COLS} FROM dc_projects WHERE deleted_at IS NOT NULL AND (owner_id=? OR ?) ORDER BY deleted_at DESC`).all(user.id, user.perms.admin ? 1 : 0);
  else if (scope === 'all' && canSeeAll(user)) rows = db.prepare(`SELECT ${COLS} FROM dc_projects WHERE deleted_at IS NULL ORDER BY updated_at DESC`).all();
  else if (scope === 'shared') rows = db.prepare(`SELECT ${COLS.split(', ').map(c => 'p.' + c).join(', ')} FROM dc_projects p JOIN dc_shares s ON s.project_id = p.id WHERE s.user_id=? AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`).all(user.id);
  else if (scope === 'mine') rows = db.prepare(`SELECT ${COLS} FROM dc_projects WHERE owner_id=? AND deleted_at IS NULL ORDER BY updated_at DESC`).all(user.id);
  else rows = db.prepare(`SELECT ${COLS.split(', ').map(c => 'p.' + c).join(', ')} FROM dc_projects p WHERE p.deleted_at IS NULL AND (p.owner_id=? OR EXISTS (SELECT 1 FROM dc_shares s WHERE s.project_id=p.id AND s.user_id=?)) ORDER BY p.updated_at DESC`).all(user.id, user.id);
  return rows.map(r => brief(r, user));
}
function get(user, pid) {
  const { row } = mustSee(user, pid);
  let data; try { data = JSON.parse(row.data); } catch (e) { data = {}; }
  return { project: brief(row, user), data };
}

/* ---------- saving ---------- */
// The planner sends its project object with every floor's drawing as pdfRef (fingerprint, uploaded once) instead of the PDF.
// A floor that still carries the PDF itself (an older planner, an import) is stored here and replaced by its fingerprint.
function prepare(user, data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.floors)) throw new HttpError(400, 'That is not a planner project.');
  let points = 0;
  for (const f of data.floors) {
    if (f && f.pdfBase64) { f.pdfRef = storePdfBase64(user, f.pdfBase64); f.pdfBase64 = null; }
    if (f && f.pdfRef && !hasBlob(f.pdfRef)) throw new HttpError(409, `The drawing of “${f.name || 'a floor'}” has not arrived on the server yet — save again.`, { missingDrawing: f.pdfRef });
    points += Array.isArray(f && f.markers) ? f.markers.length : 0;
  }
  const text = JSON.stringify(data);
  return { text, points, floors: data.floors.length, name: String(data.name || 'Untitled Project').trim().slice(0, 120) || 'Untitled Project', siteId: data.site && data.site.id ? String(data.site.id).slice(0, 40) : null };
}
function create(user, data, opts = {}) {
  const d = prepare(user, data), pid = id(14), t = now();
  db.prepare('INSERT INTO dc_projects(id,owner_id,name,data,version,bytes,points,floors,site_id,created_at,updated_at,updated_by) VALUES(?,?,?,?,1,?,?,?,?,?,?,?)')
    .run(pid, opts.ownerId || user.id, d.name, d.text, d.text.length, d.points, d.floors, d.siteId, opts.at || t, opts.at || t, user.id);
  const row = db.prepare('SELECT * FROM dc_projects WHERE id=?').get(pid);
  notifyAudience(row, user, false);
  return brief(row, user);
}
function snapshot(row, reason) {
  db.prepare('INSERT INTO dc_versions(project_id,version,name,data,bytes,points,saved_at,saved_by,reason) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(row.id, row.version, row.name, row.data, row.bytes, row.points, row.updated_at, row.updated_by, reason || '');
  db.prepare('DELETE FROM dc_versions WHERE project_id=? AND id NOT IN (SELECT id FROM dc_versions WHERE project_id=? ORDER BY id DESC LIMIT ?)').run(row.id, row.id, KEEP_VERSIONS);
}
function save(user, pid, body) {
  return tx(() => {
    const { row, access: a } = mustSee(user, pid);
    if (a === 'view') throw new HttpError(403, `${uname(row.owner_id)} shared this project with you to view only.`);
    if (!body.force && Number(body.baseVersion) !== row.version) {
      throw new HttpError(409, `${uname(row.updated_by) || 'Someone'} saved a newer version of this project.`, {
        conflict: { version: row.version, updatedBy: uname(row.updated_by), updatedById: row.updated_by, updatedAt: row.updated_at } });
    }
    const d = prepare(user, body.data);
    if (d.text === row.data) return { project: brief(row, user), unchanged: true };
    const last = db.prepare('SELECT saved_at FROM dc_versions WHERE project_id=? ORDER BY id DESC LIMIT 1').get(row.id);
    const otherPerson = row.updated_by && row.updated_by !== user.id;
    if (otherPerson || !last || Date.now() - new Date(last.saved_at) > SNAP_MIN * 60e3 || body.force) snapshot(row, otherPerson ? 'before ' + user.name + '’s changes' : body.force ? 'replaced' : '');
    const t = now(), v = row.version + 1;
    db.prepare('UPDATE dc_projects SET name=?, data=?, version=?, bytes=?, points=?, floors=?, site_id=?, updated_at=?, updated_by=? WHERE id=?')
      .run(d.name, d.text, v, d.text.length, d.points, d.floors, d.siteId, t, user.id, row.id);
    const nrow = db.prepare('SELECT * FROM dc_projects WHERE id=?').get(row.id);
    events.publish({ type: 'dc', id: row.id, version: v, by: user.id, byName: user.name, name: d.name, client: body.client || '' }, u => audience(nrow).has(u.id) || canSeeAll(u));
    notifyAudience(nrow, user, true);
    return { project: brief(nrow, user) };
  });
}
function rename(user, pid, name) {
  const { row, access: a } = mustSee(user, pid);
  if (a === 'view') throw new HttpError(403, 'View only.');
  name = String(name || '').trim().slice(0, 120);
  if (!name) throw new HttpError(400, 'Type a name.');
  let data; try { data = JSON.parse(row.data); } catch (e) { data = {}; }
  data.name = name;
  return save(user, pid, { data, baseVersion: row.version });
}
function copy(user, pid, name) {
  const { row } = mustSee(user, pid);
  const data = JSON.parse(row.data);
  data.name = String(name || (row.name + ' (copy)')).slice(0, 120);
  data.site = null;   // a copy is not the live project
  return create(user, data);
}
function remove(user, pid) {
  const { row, access: a } = mustSee(user, pid);
  if (a !== 'owner' && !user.perms.admin) throw new HttpError(403, `Only ${uname(row.owner_id)} (the owner) or an admin can delete this project.`);
  db.prepare('UPDATE dc_projects SET deleted_at=?, deleted_by=? WHERE id=?').run(now(), user.id, row.id);
  events.publish({ type: 'dc-list' }, u => audience(row).has(u.id) || canSeeAll(u));
}
function restoreDeleted(user, pid) {
  const { row, access: a } = mustSee(user, pid, { deleted: true });
  if (a !== 'owner' && !user.perms.admin) throw new HttpError(403, 'Only the owner or an admin can restore it.');
  db.prepare('UPDATE dc_projects SET deleted_at=NULL, deleted_by=NULL WHERE id=?').run(row.id);
  events.publish({ type: 'dc-list' }, u => audience(row).has(u.id) || canSeeAll(u));
}
function transfer(user, pid, toUserId) {
  const { row, access: a } = mustSee(user, pid);
  if (a !== 'owner' && !user.perms.admin) throw new HttpError(403, 'Only the owner or an admin can hand the project over.');
  const to = db.prepare('SELECT id, name FROM users WHERE id=? AND active=1').get(String(toUserId || ''));
  if (!to) throw new HttpError(400, 'Pick a person.');
  tx(() => {
    db.prepare('UPDATE dc_projects SET owner_id=? WHERE id=?').run(to.id, row.id);
    db.prepare('DELETE FROM dc_shares WHERE project_id=? AND user_id=?').run(row.id, to.id);
    if (row.owner_id !== to.id) db.prepare('INSERT OR IGNORE INTO dc_shares(project_id,user_id,can_edit,shared_by,created_at) VALUES(?,?,1,?,?)').run(row.id, row.owner_id, user.id, now());
  });
  require('./notify').send(to.id, { kind: 'share', title: `${user.name} gave you the project “${row.name}”`, body: 'You are now its owner.', url: '/app/?project=' + row.id, ref: row.id, byName: user.name });
  return brief(db.prepare('SELECT * FROM dc_projects WHERE id=?').get(row.id), user);
}

/* ---------- versions ---------- */
function versions(user, pid) {
  const { row } = mustSee(user, pid);
  const cur = { id: 0, version: row.version, savedAt: row.updated_at, savedBy: uname(row.updated_by), points: row.points, bytes: row.bytes, current: true };
  return [cur].concat(db.prepare('SELECT id, version, saved_at, saved_by, points, bytes, reason FROM dc_versions WHERE project_id=? ORDER BY id DESC').all(row.id)
    .map(v => ({ id: v.id, version: v.version, savedAt: v.saved_at, savedBy: uname(v.saved_by), points: v.points, bytes: v.bytes, reason: v.reason })));
}
function restoreVersion(user, pid, vid) {
  const { row, access: a } = mustSee(user, pid);
  if (a === 'view') throw new HttpError(403, 'View only.');
  const v = db.prepare('SELECT * FROM dc_versions WHERE id=? AND project_id=?').get(Number(vid), row.id);
  if (!v) throw new HttpError(404, 'That version is not there any more.');
  const data = JSON.parse(v.data);
  return save(user, pid, { data, baseVersion: row.version, force: true });
}
function versionData(user, pid, vid) {
  const { row } = mustSee(user, pid);
  const v = db.prepare('SELECT data FROM dc_versions WHERE id=? AND project_id=?').get(Number(vid), row.id);
  if (!v) throw new HttpError(404, 'That version is not there any more.');
  return JSON.parse(v.data);
}

/* ---------- sharing ---------- */
function shares(user, pid) {
  const { row } = mustSee(user, pid);
  return brief(row, user).sharedWith;
}
function share(user, pid, toId, canEdit) {
  const { row, access: a } = mustSee(user, pid);
  if (a === 'view') throw new HttpError(403, 'You can only view this project.');
  const to = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(String(toId || ''));
  if (!to) throw new HttpError(400, 'Pick a person.');
  if (to.id === row.owner_id) throw new HttpError(400, `${to.name} owns this project.`);
  const P = require('./perms');
  if (!P.permsOf(to).design) throw new HttpError(400, `${to.name} has no Design Center access. An admin can give it in Admin → Logins & permissions.`);
  const had = db.prepare('SELECT 1 FROM dc_shares WHERE project_id=? AND user_id=?').get(row.id, to.id);
  db.prepare(`INSERT INTO dc_shares(project_id,user_id,can_edit,shared_by,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(project_id,user_id) DO UPDATE SET can_edit=excluded.can_edit`).run(row.id, to.id, canEdit === false ? 0 : 1, user.id, now());
  if (!had) require('./notify').send(to.id, { kind: 'share', title: `${user.name} shared “${row.name}” with you`, body: canEdit === false ? 'You can view it.' : 'You can open and edit it — changes are saved for everyone.', url: '/app/?project=' + row.id, ref: row.id, byName: user.name });
  events.publish({ type: 'dc-list' }, u => u.id === to.id);
  return shares(user, pid);
}
function unshare(user, pid, uid) {
  const { row, access: a } = mustSee(user, pid);
  if (a === 'view' && uid !== user.id) throw new HttpError(403, 'You can only view this project.');
  db.prepare('DELETE FROM dc_shares WHERE project_id=? AND user_id=?').run(row.id, String(uid));
  events.publish({ type: 'dc-list' }, u => u.id === uid);
  return shares(user, pid);
}

/* ---------- live projects ---------- */
// the Design Center project(s) behind a live project (planner → Live projects → Open in planner)
function bySite(user, siteId) {
  return db.prepare(`SELECT ${COLS} FROM dc_projects WHERE site_id=? AND deleted_at IS NULL ORDER BY updated_at DESC`).all(String(siteId))
    .filter(r => access(user, r)).map(r => brief(r, user));
}

/* ---------- who else has it open ---------- */
const presence = new Map();   // project id -> Map(user id -> {name, at, editing})
function heartbeat(user, pid, editing) {
  mustSee(user, pid);
  let m = presence.get(pid); if (!m) presence.set(pid, (m = new Map()));
  m.set(user.id, { name: user.name, at: Date.now(), editing: !!editing });
  const out = [];
  for (const [uid, p] of m) { if (Date.now() - p.at > 75e3) m.delete(uid); else if (uid !== user.id) out.push({ id: uid, name: p.name, editing: p.editing }); }
  return out;
}
function leave(user, pid) { const m = presence.get(pid); if (m) m.delete(user.id); }

/* ---------- notifications for the others ---------- */
// "Aziz changed Al Bisher Villa": once per person per project every 30 minutes, not on every autosave
function notifyAudience(row, user, edited) {
  if (!edited) return;
  const notify = require('./notify');
  const since = new Date(Date.now() - 30 * 60e3).toISOString();
  for (const uid of audience(row)) {
    if (uid === user.id) continue;
    if (db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND kind='edit' AND ref=? AND at > ?").get(uid, row.id, since)) continue;
    notify.send(uid, { kind: 'edit', title: `${user.name} is changing “${row.name}”`, body: 'Your copy updates by itself when you open it.', url: '/app/?project=' + row.id, ref: row.id, byName: user.name });
  }
}

/* ---------- clean-up: drawings no project or version uses any more (after 14 days) ---------- */
function gcBlobs() {
  const used = new Set(), rx = /"pdfRef":"([0-9a-f]{64})"/g;
  for (const t of ['dc_projects', 'dc_versions']) for (const r of db.prepare(`SELECT data FROM ${t}`).iterate()) { let m; while ((m = rx.exec(r.data))) used.add(m[1]); }
  const old = new Date(Date.now() - 14 * 864e5).toISOString();
  let n = 0;
  for (const b of db.prepare('SELECT hash FROM dc_blobs WHERE created_at < ?').all(old)) {
    if (used.has(b.hash)) continue;
    try { fs.rmSync(blobPath(b.hash), { force: true }); } catch (e) {}
    db.prepare('DELETE FROM dc_blobs WHERE hash=?').run(b.hash); n++;
  }
  // projects in the trash for more than 30 days
  const gone = db.prepare('SELECT id FROM dc_projects WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(new Date(Date.now() - 30 * 864e5).toISOString());
  for (const g of gone) db.prepare('DELETE FROM dc_projects WHERE id=?').run(g.id);
  return { drawings: n, projects: gone.length };
}

module.exports = { list, get, create, save, rename, copy, remove, restoreDeleted, transfer, versions, restoreVersion, versionData, shares, share, unshare,
  bySite, heartbeat, leave, putBlob, hasBlob, blobPath, storePdfBase64, access, mustSee, gcBlobs, brief };
