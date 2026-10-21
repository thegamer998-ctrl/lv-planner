'use strict';
// Put a backup back. Stop the app first, then (in the selfhost folder on the server):
//   docker compose stop designcenter
//   docker compose run --rm designcenter npm run restore -- /data/backups/expresstech-2026-10-21-02-00.db
//   docker compose start designcenter
// The current database is kept next to it as expresstech.db.before-restore-<time>.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('Usage: npm run restore -- <backup file>   (see data/backups)'); process.exit(1); }
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
if (fs.existsSync(config.dbFile)) fs.renameSync(config.dbFile, `${config.dbFile}.before-restore-${stamp}`);
for (const x of ['-wal', '-shm']) fs.rmSync(config.dbFile + x, { force: true });
fs.copyFileSync(path.resolve(src), config.dbFile);
console.log(`Restored ${src}. Start the app again.`);
