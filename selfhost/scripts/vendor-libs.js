'use strict';
// Fetches the browser libraries the planner and the site app use (vendor/libs.json) into public/app-vendor, so this server
// serves them itself at /app/vendor/… and browsers load nothing from outside sites (no cdnjs / jsDelivr at run time).
// Run by the Dockerfile at build time; also by hand:  node scripts/vendor-libs.js [outDir]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const list = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'libs.json'), 'utf8')).libs;
const out = path.resolve(process.argv[2] || path.join(root, 'public', 'app-vendor'));
const ALLOWED = { 'cdnjs.cloudflare.com': 'cdnjs', 'cdn.jsdelivr.net': 'jsdelivr' };

// https://cdnjs.cloudflare.com/ajax/libs/x/1.0/a.js → <out>/cdnjs/ajax/libs/x/1.0/a.js
function localPath(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED[u.hostname] || u.search || u.hash || u.pathname.includes('..')) throw new Error('Not an allowed library address: ' + url);
  return path.join(out, ALLOWED[u.hostname], ...u.pathname.split('/').filter(Boolean));
}

(async () => {
  const sums = [];
  for (const lib of list) {
    const file = localPath(lib.url);
    const r = await fetch(lib.url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${lib.url} answered ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString('utf8');
    if (buf.length < 10000 || /^\s*</.test(text) || (lib.expect && !text.includes(lib.expect))) throw new Error(`${lib.url} did not return the expected library`);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (lib.sha256 && lib.sha256 !== sha) throw new Error(`${lib.url} changed: sha256 ${sha}, expected ${lib.sha256}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    sums.push(`${sha}  ${path.relative(out, file)}`);
    console.log(`[vendor] ${lib.url} → ${path.relative(root, file)} (${Math.round(buf.length / 1024)} KB, sha256 ${sha})`);
  }
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
})().catch(e => { console.error('[vendor] ' + e.message); process.exit(1); });
