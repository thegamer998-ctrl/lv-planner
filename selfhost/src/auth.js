'use strict';
// Passwords (scrypt), sessions (random token in an HttpOnly cookie, only its hash is stored) and login throttling.
const crypto = require('node:crypto');
const { db, now, id } = require('./db');
const config = require('./config');
const { HttpError, parseCookies, clientIp } = require('./http');
const P = require('./perms');
const totp = require('./totp');
const secrets = require('./secrets');
const totpSecret = enc => { try { return enc ? secrets.decrypt(enc).s : ''; } catch (e) { return ''; } };

const COOKIE = 'et_sid';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const expected = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, got);
}
function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (pw.length > 200) throw new HttpError(400, 'Password is too long.');
}
function tempPassword() {
  // readable, 10 chars, no look-alike characters
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(10), b => a[b % a.length]).join('');
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

function setCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`);
}
function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = new Date(Date.now() + config.sessionDays * 864e5).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,user_agent,ip) VALUES(?,?,?,?,?,?)')
    .run(sha(token), userId, now(), exp, String(req.headers['user-agent'] || '').slice(0, 200), clientIp(req));
  setCookie(res, token, config.sessionDays * 86400);
}
function destroySession(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(t));
  setCookie(res, '', 0);
}

// What the rest of the app knows about the signed-in person.
function toUser(row) {
  const perms = P.permsOf(row);
  return { id: row.id, name: row.name, username: row.username, email: row.email, phone: row.phone, perms, staffId: row.staff_id || null,
    mustChangePassword: !!row.must_change_password, twoFactor: !!row.totp_enabled, mustSetup2fa: P.twoFactorRequired(row) && !row.totp_enabled,
    firstName: String(row.name || '').split(/\s+/)[0] };
}

// Returns the signed-in user or null. Sessions slide: renewed when less than half their life remains.
function getUser(req, res) {
  if (req._user !== undefined) return req._user;
  const t = parseCookies(req)[COOKIE];
  if (!t) return (req._user = null);
  const row = db.prepare('SELECT s.token_hash, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha(t));
  if (!row) return (req._user = null);
  if (row.expires_at < now() || !row.active) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash); return (req._user = null); }
  const left = new Date(row.expires_at) - Date.now();
  if (res && !res.headersSent && left < config.sessionDays * 864e5 / 2) {
    db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(new Date(Date.now() + config.sessionDays * 864e5).toISOString(), row.token_hash);
    setCookie(res, t, config.sessionDays * 86400);
  }
  return (req._user = toUser(row));
}

// The same person, read again from the database (open live-update streams call this before every event, so signing out,
// deactivation, a password reset or a permission change takes effect on open screens straight away).
function recheck(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const row = db.prepare('SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha(t));
  if (!row || row.expires_at < now() || !row.active) return null;
  const u = toUser(row);
  return u.mustChangePassword || u.mustSetup2fa ? null : u;
}

// Brute-force protection, per 15 minutes: 10 failed attempts per IP+login, 50 per IP, and 20 per login from anywhere
// (so changing address doesn't help).
const fails = new Map();
function throttle(key, limit) {
  const t = Date.now(), win = 15 * 60e3;
  const list = (fails.get(key) || []).filter(x => t - x < win);
  fails.set(key, list);
  if (list.length >= limit) throw new HttpError(429, 'Too many failed sign-in attempts. Wait 15 minutes and try again.');
}
function recordFail(key) { const l = fails.get(key) || []; l.push(Date.now()); fails.set(key, l); }
setInterval(() => { const t = Date.now(); for (const [k, l] of fails) if (!l.some(x => t - x < 15 * 60e3)) fails.delete(k); }, 10 * 60e3).unref();

const findLogin = login => {
  const l = String(login || '').trim();
  if (!l) return null;
  return db.prepare('SELECT * FROM users WHERE username = ?').get(l) || (l.includes('@') ? db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(l) : null);
};
// Checked against unknown logins too, so a wrong username takes as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
function login(req, res, username, password, code) {
  const ln = String(username || '').trim().toLowerCase();
  const ip = clientIp(req), k1 = 'ip:' + ip, k2 = 'u:' + ip + ':' + ln, k3 = 'l:' + ln;
  throttle(k1, 50); throttle(k2, 10); throttle(k3, 20);
  const u = findLogin(username);
  const ok = verifyPassword(password || '', u ? u.password_hash : DUMMY_HASH);
  if (!u || !u.active || !ok) {
    recordFail(k1); recordFail(k2); recordFail(k3);
    throw new HttpError(401, 'Wrong username or password.');
  }
  if (u.totp_enabled) { // second step: the code from their authenticator app
    if (!String(code || '').trim()) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app.', { needCode: true });
    const step = totp.verify(totpSecret(u.totp_secret), code, u.totp_last_step);
    if (!step) { recordFail(k1); recordFail(k2); recordFail(k3); throw new HttpError(401, 'That code is not right. Use the current code from your authenticator app.', { needCode: true }); }
    db.prepare('UPDATE users SET totp_last_step=? WHERE id=?').run(step, u.id);
  }
  fails.delete(k2); fails.delete(k3);
  db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(now(), u.id);
  createSession(res, req, u.id);
  return u;
}

const USERNAME_RX = /^[a-z0-9][a-z0-9._-]{1,31}$/i;
function checkUsername(username, exceptId) {
  const u = String(username || '').trim();
  if (!USERNAME_RX.test(u)) throw new HttpError(400, 'Username: 2–32 letters or digits (dots, dashes and underscores allowed), e.g. husain or aziz.k');
  if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(u, exceptId || '')) throw new HttpError(409, `The username “${u}” is already taken.`);
  return u;
}
function createUser({ name, username, email = '', phone = '', perms = {}, password, mustChange = true, by = null }) {
  name = String(name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Name is required.');
  username = checkUsername(username || name.split(/\s+/)[0].toLowerCase());
  email = String(email || '').trim().toLowerCase().slice(0, 120);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'That email address does not look right.');
  checkPasswordStrength(password);
  const uid = id(12);
  db.prepare('INSERT INTO users(id,name,username,email,phone,password_hash,must_change_password,active,perms,created_at,created_by) VALUES(?,?,?,?,?,?,?,1,?,?,?)')
    .run(uid, name, username, email, String(phone || '').slice(0, 40), hashPassword(password), mustChange ? 1 : 0, JSON.stringify(P.clean(perms)), now(), by);
  return uid;
}

// First start: create the admin from ADMIN_USERNAME / ADMIN_PASSWORD when there are no users yet.
function ensureAdmin() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return;
  const a = config.admin;
  if (!(a.username || a.email) || !a.password) {
    console.warn('[expresstech] No logins yet. Set ADMIN_USERNAME and ADMIN_PASSWORD in .env and restart, or run: npm run user -- add "Your Name" yourname --admin');
    return;
  }
  createUser({ name: a.name, username: a.username || a.email.split('@')[0], email: a.email, perms: { admin: true, site: 'manager' }, password: a.password, mustChange: true });
  console.log(`[expresstech] Created the admin login “${a.username || a.email}”. A new password is asked at the first sign-in.`);
}

module.exports = { recheck, totpSecret, COOKIE, hashPassword, verifyPassword, checkPasswordStrength, tempPassword, getUser, login, destroySession, createSession, createUser, ensureAdmin, checkUsername, toUser, sha };
