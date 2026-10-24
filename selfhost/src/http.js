'use strict';
// Tiny HTTP toolkit: router, JSON bodies (optionally gzip-compressed), cookies, static files, security headers.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const config = require('./config');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler });
}
function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
    const m = pathname.match(r.re);
    if (m) { const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); return { handler: r.handler, params }; }
  }
  return null;
}

// The portal pages are strict (no inline script). The planner and the site app are single-file apps with inline script and
// load pdf.js / jsPDF / pdf-lib from cdnjs and the barcode reader from jsDelivr; the planner's AI scan calls api.anthropic.com.
const CSP_STRICT = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "connect-src 'self'; font-src 'self' data:; frame-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const CSP_APP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; " +
  "connect-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://api.anthropic.com; worker-src 'self' blob: https://cdnjs.cloudflare.com; " +
  "frame-src 'self' blob:; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
// Same, when the libraries are served by this server (scripts/vendor-libs.js, done by the Docker build): nothing from outside
// sites except the planner's optional AI scan, which calls api.anthropic.com with the person's own key.
const CSP_APP_LOCAL = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "media-src 'self' blob:; font-src 'self' data:; connect-src 'self' https://api.anthropic.com; worker-src 'self' blob:; " +
  "frame-src 'self' blob:; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
function securityHeaders(res, kind) {
  const app = kind === 'app' || kind === 'app-local';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', app ? 'SAMEORIGIN' : 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // the site app scans MAC barcodes with the camera
  res.setHeader('Permissions-Policy', app ? 'camera=(self), microphone=(), geolocation=()' : 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', kind === 'app' ? CSP_APP : kind === 'app-local' ? CSP_APP_LOCAL : CSP_STRICT);
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function send(res, status, body, headers) {
  if (res.headersSent) return;
  // Answering an upload before its body has arrived (refused, too big, signed out…): read and discard the rest first.
  // Otherwise the connection is cut, and through a proxy the browser only sees "upload failed" or a hang instead of the message.
  const req = res.req;
  if (req && status >= 400 && !req.complete && !req.destroyed && !res._etDraining) {
    res._etDraining = true;
    let n = 0, done = false;
    const go = () => { if (done) return; done = true; send(res, status, body, { Connection: 'close', ...(headers || {}) }); };
    req.on('data', c => { n += c.length; if (n > 200 * 1048576) { go(); req.destroy(); } });
    req.once('end', go); req.once('error', go); req.once('close', go);
    req.resume();
    return;
  }
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  const payload = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(headers || {}) });
  res.end(payload);
}

// Reads the whole body. Accepts Content-Encoding: gzip (the planner compresses its autosaves).
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    let over = false;
    req.on('data', c => { if (over) return; size += c.length; if (size > limit) { over = true; chunks.length = 0; reject(new HttpError(413, 'Request too large')); } else chunks.push(c); });
    req.on('end', () => {
      if (over) return;
      const buf = Buffer.concat(chunks);
      if (/gzip/i.test(String(req.headers['content-encoding'] || ''))) {
        zlib.gunzip(buf, { maxOutputLength: limit * 8 }, (e, out) => e ? reject(new HttpError(400, 'Could not read the compressed request')) : resolve(out));
      } else resolve(buf);
    });
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const buf = await readBody(req, limit || 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { throw new HttpError(400, 'Invalid JSON'); }
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) {} } });
  return out;
}
// The visitor's address. Behind Cloudflare, CF-Connecting-IP is set by Cloudflare itself. Otherwise use the address our own
// proxy (Caddy) appended last to X-Forwarded-For, never the first one, which the visitor controls.
// Our own proxy reaches the app from inside the server (loopback or the Docker network), never from the internet.
const fromProxy = ip => /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === '::1' || /^f[cd]/i.test(ip);
function clientIp(req) {
  if (config.trustProxy && fromProxy(req.socket.remoteAddress || '')) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf && config.trustCloudflare) return cf;
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || '';
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.woff': 'font/woff' };

// Serves a file from dir. transform(buf) may rewrite HTML before it is sent (used to plug the hosted mode into the planner).
function serveFile(req, res, dir, rel, opts = {}) {
  const file = path.normalize(path.join(dir, rel));
  if (!file.startsWith(path.normalize(dir + path.sep)) && file !== path.normalize(dir)) return false;
  let st; try { st = fs.statSync(file); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const base = path.basename(file);
  if (base.startsWith('.')) return false;
  const ext = path.extname(file).toLowerCase();
  if (opts.allow && !opts.allow.includes(ext)) return false;
  const fresh = ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json' || ext === '.webmanifest';
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': fresh ? 'no-cache' : 'public, max-age=86400' };
  if (base === 'sw.js' || base === 'version.json') headers['Cache-Control'] = 'no-store';
  if (opts.immutable) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  if (opts.transform && (ext === '.html' || (opts.transformJs && ext === '.js'))) {
    const out = Buffer.from(opts.transform(fs.readFileSync(file, 'utf8'), rel), 'utf8');
    res.writeHead(200, { ...headers, 'Content-Length': out.length });
    return res.end(req.method === 'HEAD' ? undefined : out), true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

function redirect(res, to, status = 302) { res.writeHead(status, { Location: to, 'Cache-Control': 'no-store' }); res.end(); }

module.exports = { HttpError, route, match, send, readBody, readJson, parseCookies, clientIp, securityHeaders, serveFile, redirect, MIME };
