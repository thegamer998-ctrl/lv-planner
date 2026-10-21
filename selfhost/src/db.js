'use strict';
// SQLite database using Node's built-in node:sqlite (no native add-ons to compile).
// Two kinds of tables live in the same file:
//   - the app's own tables below (logins, Design Center projects, sharing, notifications, integrations, Claude connector)
//   - the live-project tables of the site app (projects, floors, points, photos, notes, issues, log, checks, staff…),
//     created by server/worker.js exactly as on Cloudflare D1 (see worker-bridge.js)
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const config = require('./config');

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

const MIGRATIONS = [
  // 1 — initial schema
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE users (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
     password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
     perms TEXT NOT NULL DEFAULT '{}', staff_id TEXT, notify TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL, created_by TEXT, last_login_at TEXT);
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '');
   CREATE INDEX sessions_user ON sessions(user_id);

   CREATE TABLE dc_projects (
     id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}',
     version INTEGER NOT NULL DEFAULT 1, bytes INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0, floors INTEGER NOT NULL DEFAULT 0,
     site_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT, deleted_at TEXT, deleted_by TEXT);
   CREATE INDEX dc_projects_owner ON dc_projects(owner_id);
   CREATE INDEX dc_projects_site ON dc_projects(site_id);
   CREATE TABLE dc_shares (
     project_id TEXT NOT NULL REFERENCES dc_projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     can_edit INTEGER NOT NULL DEFAULT 1, shared_by TEXT, created_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id));
   CREATE INDEX dc_shares_user ON dc_shares(user_id);
   CREATE TABLE dc_versions (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES dc_projects(id) ON DELETE CASCADE, version INTEGER NOT NULL,
     name TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0,
     saved_at TEXT NOT NULL, saved_by TEXT, reason TEXT NOT NULL DEFAULT '');
   CREATE INDEX dc_versions_p ON dc_versions(project_id, id);
   CREATE TABLE dc_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, created_at TEXT NOT NULL, created_by TEXT);

   CREATE TABLE notifications (
     id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
     title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL DEFAULT '', by_name TEXT NOT NULL DEFAULT '',
     at TEXT NOT NULL, read_at TEXT);
   CREATE INDEX notifications_user ON notifications(user_id, id);
   CREATE TABLE push_subscriptions (
     endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
     user_agent TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_ok_at TEXT, fails INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX push_user ON push_subscriptions(user_id);

   CREATE TABLE integrations (
     id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
     last_error TEXT NOT NULL DEFAULT '', last_ok_at TEXT, updated_at TEXT, updated_by TEXT);
   CREATE TABLE integration_log (id INTEGER PRIMARY KEY AUTOINCREMENT, integration TEXT NOT NULL, at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
   CREATE INDEX integration_log_i ON integration_log(integration, id);

   CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', redirect_uris TEXT NOT NULL, secret_hash TEXT, created_at TEXT NOT NULL);
   CREATE TABLE oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL);
   CREATE TABLE oauth_tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, grant_id TEXT NOT NULL, client_id TEXT NOT NULL,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
   CREATE INDEX oauth_tokens_user ON oauth_tokens(user_id);
   CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);

   CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, by_name TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');`,
  // 2 — projects started from LeadzIN (one per lead)
  `CREATE TABLE leadzin_projects (lead_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, estimate_id TEXT, estimate_number TEXT, lead_name TEXT, by_name TEXT, created_at TEXT NOT NULL);`,
];

(function migrate() {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  let v = has ? Number((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() || {}).value || 0) : 0;
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      v++;
      db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(v));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
})();

const now = () => new Date().toISOString();
const id = (n = 12) => { const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from(crypto.randomBytes(n), b => a[b % a.length]).join(''); };

// Run fn inside a transaction (node:sqlite has no helper for this).
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

const meta = {
  get: k => (db.prepare('SELECT value FROM meta WHERE key=?').get(k) || {}).value,
  set: (k, v) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v)),
};
const tableExists = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

function audit(user, action, detail) {
  db.prepare('INSERT INTO audit(at,user_id,by_name,action,detail) VALUES(?,?,?,?,?)').run(now(), user ? user.id : null, user ? user.name : 'system', action, String(detail || '').slice(0, 500));
}

module.exports = { db, now, id, tx, meta, tableExists, audit };
