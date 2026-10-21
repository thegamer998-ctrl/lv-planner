'use strict';
// Stands in for the old Cloudflare server in the import test: the same server/worker.js on its own SQLite file,
// with a known office key.   node test/fake-cloudflare.js <port> <db file> <office key>
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const [port, file, key] = process.argv.slice(2);
const db = new DatabaseSync(file);
const conv = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v instanceof ArrayBuffer ? new Uint8Array(v) : v;
class St { constructor(sql, a) { this.sql = sql; this.a = a || []; } bind(...a) { return new St(this.sql, a.map(conv)); }
  async first(c) { const r = db.prepare(this.sql).get(...this.a); return r ? (c ? r[c] : { ...r }) : null; }
  async all() { return { results: db.prepare(this.sql).all(...this.a).map(r => ({ ...r })) }; }
  async run() { db.prepare(this.sql).run(...this.a); return { success: true }; } }
const env = { DB: { prepare: s => new St(s) }, ADMIN_KEY: key };
(async () => {
  const w = (await import(pathToFileURL(path.join(__dirname, '..', '..', 'server', 'worker.js')).href)).default;
  http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const h = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'content-length') h.set(k, v);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const r = await w.fetch(new Request('http://x' + req.url, { method: req.method, headers: h, body }), env, { waitUntil() {} });
    const out = Buffer.from(await r.arrayBuffer()); const hh = {}; r.headers.forEach((v, k) => { hh[k] = v; });
    res.writeHead(r.status, hh); res.end(out);
  }).listen(+port, '127.0.0.1', () => console.log('ready'));
})();
