'use strict';
// Web Push (phone / desktop notifications even when the app is closed) — implemented with Node's crypto only:
// VAPID (RFC 8292) to identify this server, and aes128gcm payload encryption (RFC 8291).
// Works on Android/Chrome/Edge/Firefox, Mac Safari & Chrome, and iPhone/iPad (iOS 16.4+) once the app is added to the Home Screen.
const crypto = require('node:crypto');
const { db, now, meta } = require('./db');
const config = require('./config');
const secrets = require('./secrets');

const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => Buffer.from(String(s), 'base64url');

// VAPID key pair: from .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) or generated once and kept (encrypted) in the database.
function loadVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return keysFromRaw(process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const stored = meta.get('vapid');
  if (stored) { const k = secrets.decrypt(stored); return keysFromRaw(k.publicKey, k.privateKey); }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
  meta.set('vapid', secrets.encrypt({ publicKey: pub, privateKey: jwk.d }));
  return keysFromRaw(pub, jwk.d);
}
function keysFromRaw(pub, d) {
  const raw = fromB64u(pub);
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)), d }, format: 'jwk' });
  return { publicKey: pub, key };
}
const vapid = loadVapid();
const publicKey = () => vapid.publicKey;

function subject() {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  if (config.appUrl.startsWith('https://')) return config.appUrl;
  const admin = db.prepare("SELECT email FROM users WHERE perms LIKE '%\"admin\":true%' AND email <> '' ORDER BY created_at LIMIT 1").get();
  return 'mailto:' + (admin ? admin.email : 'it@expresskw.com');
}

const jwtCache = new Map();
function vapidJwt(audience) {
  const c = jwtCache.get(audience);
  if (c && c.exp - 3600 > Date.now() / 1000) return c.jwt;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const unsigned = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' + b64u(JSON.stringify({ aud: audience, exp, sub: subject() }));
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  const jwt = unsigned + '.' + b64u(sig);
  jwtCache.set(audience, { jwt, exp });
  return jwt;
}

// RFC 8291 message encryption (aes128gcm, single record)
function encrypt(payload, p256dh, authSecret, opts = {}) {
  const uaPublic = fromB64u(p256dh), auth = fromB64u(authSecret);
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.privateKey) ecdh.setPrivateKey(opts.privateKey); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, keyInfo, 32));
  const salt = opts.salt || crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

async function sendOne(sub, data, opts = {}) {
  if (!pushHostAllowed(sub.endpoint)) { db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(sub.endpoint); return 'gone'; }
  const endpoint = new URL(sub.endpoint);
  const body = encrypt(JSON.stringify(data), sub.p256dh, sub.auth);
  const r = await fetch(sub.endpoint, {
    method: 'POST', body, signal: AbortSignal.timeout(15000), redirect: 'error',
    headers: {
      'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: String(opts.ttl || 24 * 3600), Urgency: opts.urgency || 'high',
      ...(opts.topic ? { Topic: opts.topic } : {}),
      Authorization: `vapid t=${vapidJwt(endpoint.origin)}, k=${vapid.publicKey}`,
    },
  });
  if (r.status === 404 || r.status === 410) { db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(sub.endpoint); return 'gone'; }
  if (!r.ok) {
    db.prepare('UPDATE push_subscriptions SET fails = fails + 1 WHERE endpoint=?').run(sub.endpoint);
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND fails >= 10').run(sub.endpoint);
    throw new Error(`push service answered ${r.status}`);
  }
  db.prepare('UPDATE push_subscriptions SET fails = 0, last_ok_at = ? WHERE endpoint=?').run(now(), sub.endpoint);
  return 'ok';
}

// Send to every device of one person. data: {title, body, url, tag}
async function sendToUser(userId, data, opts) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(userId);
  const results = await Promise.allSettled(subs.map(s => sendOne(s, data, opts)));
  results.forEach(r => { if (r.status === 'rejected') console.error('[push]', r.reason.message); });
  return { devices: subs.length, delivered: results.filter(r => r.status === 'fulfilled' && r.value === 'ok').length, errors: results.filter(r => r.status === 'rejected').map(r => r.reason.message) };
}

// Browsers only ever hand out endpoints on these push services. Anything else is refused, so the server can't be pointed at
// an arbitrary (or internal) address.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
function pushHostAllowed(endpoint) {
  let u; try { u = new URL(endpoint); } catch (e) { return false; }
  return u.protocol === 'https:' && !u.port && !u.username && !u.password && PUSH_HOSTS.some(re => re.test(u.hostname));
}

function subscribe(userId, sub, ua) {
  const ok = sub && typeof sub.endpoint === 'string' && sub.endpoint.length < 1000 && pushHostAllowed(sub.endpoint) && sub.keys && sub.keys.p256dh && sub.keys.auth;
  if (!ok) return false;
  if (fromB64u(sub.keys.p256dh).length !== 65 || fromB64u(sub.keys.auth).length < 16) return false;
  db.prepare(`INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth,user_agent,created_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent, fails=0`)
    .run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, String(ua || '').slice(0, 200), now());
  return true;
}
function unsubscribe(userId, endpoint) { db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(String(endpoint || ''), userId); }
const devices = userId => db.prepare('SELECT endpoint, user_agent, created_at, last_ok_at FROM push_subscriptions WHERE user_id=? ORDER BY created_at').all(userId);

module.exports = { pushHostAllowed, publicKey, sendToUser, subscribe, unsubscribe, devices, encrypt };
