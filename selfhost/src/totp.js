'use strict';
// Two-step sign-in: time-based one-time codes (RFC 6238, 30 s, 6 digits, SHA-1), the same codes Google Authenticator,
// Microsoft Authenticator, 1Password etc. show. Secrets are stored encrypted (secrets.js). The set-up QR code is drawn here
// as an SVG with the vendored qrcode encoder, so nothing is sent to an outside service.
const crypto = require('node:crypto');
const config = require('./config');
const QR = require('./vendor/qrcode/qrcode');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function newSecret() { // 160 bits, base32
  const bytes = crypto.randomBytes(20); let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function fromB32(s) {
  let bits = '';
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function codeAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', fromB32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 30000);

// Returns the matched time step (accepting one step either side for clock drift), or 0. A step at or before lastStep
// was already used, so the same code can't be replayed.
function verify(secret, code, lastStep = 0) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6 || !secret) return 0;
  const now = stepNow();
  for (const s of [now, now - 1, now + 1]) {
    if (s <= lastStep) continue;
    const want = codeAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c))) return s;
  }
  return 0;
}

function uri(secret, account) {
  const issuer = config.appName || 'Express Tech Design Center';
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
// QR code as an SVG data URI (black on white with a quiet zone, scales cleanly).
function qrSvg(text) {
  const m = QR.create(text, { errorCorrectionLevel: 'M' }).modules, n = m.size, q = 4;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m.get(y, x)) d += `M${x + q} ${y + q}h1v1h-1z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
const group = s => s.replace(/(.{4})/g, '$1 ').trim();

module.exports = { newSecret, verify, uri, qrSvg, group, codeAt, stepNow };
