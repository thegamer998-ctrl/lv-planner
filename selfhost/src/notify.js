'use strict';
// Notification center: every notice is kept (the bell in the planner, the site app and the Design Center home), arrives live
// on open pages, and — if that person switched it on for the kind — as a phone / computer notification (web push).
const { db, now, meta } = require('./db');
const events = require('./events');
const P = require('./perms');

const KINDS = [
  ['share', 'A project is shared with me', true],
  ['edit', 'Someone changes a project shared with me', false],
  ['report', 'New site report (extra point, point not on site, issue)', true],
  ['report_reply', 'The office answers my site report', true],
  ['team', 'I am added to a live project', true],
  ['project', 'A live project is paused, resumed or completed', true],
  ['site_change', 'Changes made on site (cable destination, label)', false],
  ['system', 'Problems with an integration (admins)', true],
];
const KIND_KEYS = KINDS.map(k => k[0]);

function prefs(row) {
  let n = {}; try { n = JSON.parse(row.notify || '{}') || {}; } catch (e) {}
  const push = {}; for (const [k, , d] of KINDS) push[k] = typeof (n.push || {})[k] === 'boolean' ? n.push[k] : d;
  return { push };
}
function savePrefs(userId, body) {
  const row = db.prepare('SELECT notify FROM users WHERE id=?').get(userId);
  const cur = prefs(row);
  for (const k of KIND_KEYS) if (body && body.push && typeof body.push[k] === 'boolean') cur.push[k] = body.push[k];
  db.prepare('UPDATE users SET notify=? WHERE id=?').run(JSON.stringify(cur), userId);
  return cur;
}

const out = r => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, url: r.url, ref: r.ref, by: r.by_name, at: r.at, read: !!r.read_at });
const unread = uid => db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL').get(uid).n;

// send(userId, {kind, title, body, url, ref, byName, group}) — group: a key; a second notice with the same key within
// 10 minutes updates the first one ("3 changes") instead of adding another line
function send(userId, n) {
  const u = db.prepare('SELECT id, active, notify FROM users WHERE id=?').get(userId);
  if (!u || !u.active) return null;
  let row = null;
  if (n.group) {
    const g = db.prepare("SELECT * FROM notifications WHERE user_id=? AND kind=? AND ref=? AND read_at IS NULL AND at > ? ORDER BY id DESC LIMIT 1")
      .get(userId, n.kind, n.group, new Date(Date.now() - 10 * 60e3).toISOString());
    if (g) {
      const m = g.title.match(/ \((\d+)\)$/), cnt = (m ? +m[1] : 1) + 1;
      const title = (m ? g.title.slice(0, -m[0].length) : g.title) + ` (${cnt})`;
      db.prepare('UPDATE notifications SET title=?, body=?, at=?, by_name=? WHERE id=?').run(title, String(n.body || '').slice(0, 500), now(), n.byName || '', g.id);
      row = db.prepare('SELECT * FROM notifications WHERE id=?').get(g.id);
    }
  }
  if (!row) {
    const r = db.prepare('INSERT INTO notifications(user_id,kind,title,body,url,ref,by_name,at) VALUES(?,?,?,?,?,?,?,?)')
      .run(userId, n.kind, String(n.title).slice(0, 200), String(n.body || '').slice(0, 500), String(n.url || ''), String(n.group || n.ref || ''), n.byName || '', now());
    row = db.prepare('SELECT * FROM notifications WHERE id=?').get(Number(r.lastInsertRowid));
    db.prepare('DELETE FROM notifications WHERE user_id=? AND id < (SELECT id FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 1 OFFSET 400)').run(userId, userId);
  }
  events.publish({ type: 'notify', item: out(row), unread: unread(userId) }, x => x.id === userId);
  if (prefs(u).push[n.kind]) {
    require('./push').sendToUser(userId, { title: row.title, body: row.body, url: row.url || '/', tag: n.kind + ':' + (n.group || n.ref || row.id) })
      .catch(e => console.error('[push]', e.message));
  }
  return out(row);
}
function list(userId, before) {
  const rows = before ? db.prepare('SELECT * FROM notifications WHERE user_id=? AND id < ? ORDER BY id DESC LIMIT 40').all(userId, Number(before))
    : db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 40').all(userId);
  return { items: rows.map(out), unread: unread(userId) };
}
function markRead(userId, ids) {
  if (ids === 'all') db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(), userId);
  else for (const i of (Array.isArray(ids) ? ids : []).slice(0, 200)) db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND id=? AND read_at IS NULL').run(now(), userId, Number(i));
  const n = unread(userId);
  events.publish({ type: 'notify-read', unread: n }, x => x.id === userId);
  return n;
}

/* ---------- who to tell about live projects ---------- */
const activeUsers = () => db.prepare('SELECT * FROM users WHERE active=1').all();
const officeIds = () => activeUsers().filter(u => P.permsOf(u).office).map(u => u.id);
function teamIds(pid) {
  const p = db.prepare('SELECT team FROM projects WHERE id=?').get(pid);
  let team = []; try { team = JSON.parse((p && p.team) || '[]') || []; } catch (e) {}
  const out = [];
  for (const u of activeUsers()) {
    const pp = P.permsOf(u); if (!u.staff_id || !P.liveAccess(pp)) continue;
    const role = P.staffRole(pp);
    if (role === 'manager' || !team.length || team.includes(u.staff_id)) out.push(u.id);
  }
  return out;
}
const managerIds = () => activeUsers().filter(u => P.staffRole(P.permsOf(u)) === 'manager').map(u => u.id);
function designIds(pid) {
  const ids = new Set();
  for (const r of db.prepare('SELECT id, owner_id FROM dc_projects WHERE site_id=? AND deleted_at IS NULL').all(pid)) {
    ids.add(r.owner_id);
    for (const s of db.prepare('SELECT user_id FROM dc_shares WHERE project_id=?').all(r.id)) ids.add(s.user_id);
  }
  return [...ids];
}
const byName = name => db.prepare('SELECT u.id FROM users u LEFT JOIN staff s ON s.id = u.staff_id WHERE u.active=1 AND (u.name = ? OR s.name = ?)').all(name, name).map(r => r.id);
const uniq = (list, except) => [...new Set(list)].filter(x => !except.includes(x));

// After every change made through the site app / planner: read the new lines of the live projects' activity log
// and tell the right people.
const STATE = { 'project-paused': 'paused', 'project-resumed': 'resumed', 'project-done': 'marked complete', 'project-reopened': 'reopened' };
function processSiteLog() {
  const saved = meta.get('notified_log_id');
  if (saved === undefined) { const m = db.prepare('SELECT MAX(id) n FROM log').get(); meta.set('notified_log_id', (m && m.n) || 0); return; }   // first run: nothing old
  let last = Number(saved) || 0;
  const rows = db.prepare('SELECT * FROM log WHERE id > ? ORDER BY id LIMIT 500').all(last);
  for (const l of rows) {
    last = l.id;
    try { dispatch(l); } catch (e) { console.error('[notify]', e.message); }
  }
  meta.set('notified_log_id', last);
}
function dispatch(l) {
  const proj = db.prepare('SELECT id, name FROM projects WHERE id=?').get(l.project_id);
  if (!proj) return;
  const actor = byName(l.by_name), url = '/app/site.html#p=' + proj.id;
  const who = l.by_name ? l.by_name + (l.by_role ? ' (' + l.by_role.toLowerCase() + ')' : '') : '';
  if (l.action === 'report') {
    for (const uid of uniq([...officeIds(), ...managerIds(), ...designIds(proj.id)], actor))
      send(uid, { kind: 'report', title: `Site report · ${proj.name}`, body: `${l.detail}${who ? ' — ' + who : ''}`, url, ref: proj.id, byName: l.by_name });
  } else if (/^report-(approved|rejected|done)$/.test(l.action)) {
    const iid = String(l.point_id || '').replace(/^issue:/, '');
    const is = db.prepare('SELECT by_name, kind FROM issues WHERE id=?').get(iid);
    if (!is) return;
    const word = { approved: 'approved', rejected: 'not needed', done: 'done — drawing updated' }[l.action.slice(7)];
    for (const uid of uniq(byName(is.by_name), actor))
      send(uid, { kind: 'report_reply', title: `Your site report on ${proj.name}: ${word}`, body: (l.detail ? l.detail + ' — ' : '') + l.by_name, url, ref: proj.id, byName: l.by_name });
  } else if (l.action === 'project-started') {
    for (const uid of uniq(teamIds(proj.id), actor))
      send(uid, { kind: 'team', title: `New project: ${proj.name}`, body: 'You are on the team — it is in your site app.', url, ref: proj.id, byName: l.by_name });
  } else if (STATE[l.action]) {
    for (const uid of uniq([...teamIds(proj.id), ...officeIds()], actor))
      send(uid, { kind: 'project', title: `${proj.name} was ${STATE[l.action]}`, body: who ? 'By ' + who : '', url, ref: proj.id, byName: l.by_name });
  } else if (l.action === 'cable-dest' || l.action === 'label') {
    const pt = db.prepare('SELECT COALESCE(site_label, label) AS l FROM points WHERE project_id=? AND point_id=?').get(proj.id, l.point_id || '');
    const what = l.action === 'cable-dest' ? 'Cable destination changed' : 'Label changed';
    for (const uid of uniq([...officeIds(), ...designIds(proj.id)], actor))
      send(uid, { kind: 'site_change', title: `${what} on site · ${proj.name}`, body: `${pt ? pt.l + ': ' : ''}${l.detail}${who ? ' — ' + who : ''}`, url, group: 'site:' + proj.id + ':' + l.action, ref: proj.id, byName: l.by_name });
  }
}
// someone was added to a live project's team (planner → Site → team, or Update site)
function teamAdded(pid, staffIds, by) {
  const proj = db.prepare('SELECT id, name FROM projects WHERE id=?').get(pid);
  if (!proj || !staffIds.length) return;
  for (const u of db.prepare('SELECT id, staff_id FROM users WHERE active=1').all())
    if (u.staff_id && staffIds.includes(u.staff_id) && (!by || u.id !== by.id))
      send(u.id, { kind: 'team', title: `You are on the team of ${proj.name}`, body: by ? 'Added by ' + by.name : '', url: '/app/site.html#p=' + proj.id, ref: proj.id, byName: by ? by.name : '' });
}
// integration problems → admins, at most once an hour per integration
const lastSys = {};
function system(key, title, body) {
  if (lastSys[key] && Date.now() - lastSys[key] < 3600e3) return;
  lastSys[key] = Date.now();
  for (const u of activeUsers()) if (P.permsOf(u).admin) send(u.id, { kind: 'system', title, body, url: '/#admin/integrations', ref: key });
}

module.exports = { KINDS, prefs, savePrefs, send, list, markRead, unread, processSiteLog, teamAdded, system, teamIds, officeIds };
