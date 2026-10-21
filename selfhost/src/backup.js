'use strict';
// Nightly database snapshot (consistent copy via VACUUM INTO), keeping the last BACKUP_KEEP. The floor drawings of
// Design Center projects are files in data/drawings (never changed once written) — copy the whole data folder off the server.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { db } = require('./db');

function backupNow() {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(config.backupDir, `expresstech-${stamp}.db`);
  fs.rmSync(file, { force: true });
  db.prepare('VACUUM INTO ?').run(file);
  const all = fs.readdirSync(config.backupDir).filter(f => /^expresstech-.*\.db$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - config.backupKeep))) fs.rmSync(path.join(config.backupDir, old), { force: true });
  return file;
}
function list() {
  return fs.readdirSync(config.backupDir).filter(f => /^expresstech-.*\.db$/.test(f)).sort().reverse()
    .map(f => ({ name: f, size: fs.statSync(path.join(config.backupDir, f)).size }));
}
function schedule(after) {
  let lastDay = null;
  setInterval(() => {
    const d = new Date(), day = d.toDateString();
    if (d.getHours() === config.backupHour && lastDay !== day) {
      lastDay = day;
      try { console.log('[backup] saved', backupNow()); } catch (e) { console.error('[backup] failed:', e.message); require('./notify').system('backup', 'The nightly backup failed', e.message); }
      try { if (after) after(); } catch (e) { console.error('[cleanup]', e.message); }
    }
  }, 5 * 60e3).unref();
}
module.exports = { backupNow, list, schedule };
