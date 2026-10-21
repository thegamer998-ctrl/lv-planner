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
function securityHeaders(res, kind) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', kind === 'app' ? 'SAMEORIGIN' : 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // the site app scans MAC barcodes with the camera
  res.setHeader('Permissions-Policy', kind === 'app' ? 'camera=(self), microphone=(), geolocation=()' : 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', kind === 'app' ? CSP_APP : CSP_STRICT);
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function send(res, status, body, headers) {
  if (res.headersSent) return;
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  const payload = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(headers || {}) });
  res.end(payload);
}

// Reads the whole body. Accepts Content-Encoding: gzip (the planner compresses its autosaves).
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
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
function clientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf' };

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
  if (opts.transform && ext === '.html') {
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
