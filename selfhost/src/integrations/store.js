'use strict';
// Where integration settings live: one row per integration, settings encrypted, plus a short activity log.
const { db, now } = require('../db');
const secrets = require('../secrets');

const versions = {}; // bumps when settings change, so providers can drop cached tokens
const row = id => db.prepare('SELECT * FROM integrations WHERE id=?').get(id);
function ensure(id) { if (!row(id)) db.prepare('INSERT INTO integrations(id, updated_at) VALUES(?,?)').run(id, now()); return row(id); }
function config(id) {
  const r = row(id); if (!r || !r.config) return {};
  try { return secrets.decrypt(r.config); } catch (e) { console.error(`[integrations] cannot read settings for ${id} (was SECRET_KEY changed?)`); return {}; }
}
function saveConfig(id, cfg, user) {
  ensure(id);
  db.prepare('UPDATE integrations SET config=?, updated_at=?, updated_by=? WHERE id=?').run(secrets.encrypt(cfg), now(), user ? user.id : null, id);
  versions[id] = (versions[id] || 0) + 1;
}
function setEnabled(id, on, user) {
  ensure(id);
  db.prepare('UPDATE integrations SET enabled=?, updated_at=?, updated_by=? WHERE id=?').run(on ? 1 : 0, now(), user ? user.id : null, id);
  versions[id] = (versions[id] || 0) + 1;
}
const enabled = id => !!(row(id) || {}).enabled;
function setStatus(id, ok, error) {
  ensure(id);
  if (ok) db.prepare("UPDATE integrations SET status='ok', last_error='', last_ok_at=? WHERE id=?").run(now(), id);
  else db.prepare("UPDATE integrations SET status='error', last_error=? WHERE id=?").run(String(error || 'Unknown error').slice(0, 500), id);
}
function log(id, level, message) {
  db.prepare('INSERT INTO integration_log(integration, at, level, message) VALUES(?,?,?,?)').run(id, now(), level, String(message).slice(0, 500));
  db.prepare('DELETE FROM integration_log WHERE integration=? AND id <= (SELECT id FROM integration_log WHERE integration=? ORDER BY id DESC LIMIT 1 OFFSET 300)').run(id, id);
}
const recent = (id, n = 25) => db.prepare('SELECT at, level, message FROM integration_log WHERE integration=? ORDER BY id DESC LIMIT ?').all(id, n);
function reset(id, user) {
  ensure(id);
  db.prepare("UPDATE integrations SET enabled=0, config='', status='', last_error='', last_ok_at=NULL, updated_at=?, updated_by=? WHERE id=?").run(now(), user ? user.id : null, id);
  versions[id] = (versions[id] || 0) + 1;
}
const version = id => versions[id] || 0;
module.exports = { row, ensure, config, saveConfig, setEnabled, enabled, setStatus, log, recent, reset, version };
