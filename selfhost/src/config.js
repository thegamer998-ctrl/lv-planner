'use strict';
// All settings come from environment variables (see .env.example).
const path = require('node:path');
const fs = require('node:fs');

// Load a local .env file if present (simple KEY=VALUE lines, no dependency needed).
const envFile = process.env.ENV_FILE || path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const int = (k, d) => { const n = parseInt(env(k, ''), 10); return Number.isFinite(n) ? n : d; };
const first = (...c) => c.find(p => p && fs.existsSync(p)) || c[c.length - 1];

const appUrl = env('APP_URL', 'http://localhost:3000').replace(/\/+$/, '');
const dataDir = path.resolve(env('DATA_DIR', path.join(__dirname, '..', 'data')));
const root = path.join(__dirname, '..');

const config = {
  port: int('PORT', 3000),
  host: env('HOST', '0.0.0.0'),
  appUrl,
  dataDir,
  dbFile: path.join(dataDir, 'expresstech.db'),
  blobDir: path.join(dataDir, 'drawings'),     // the floor drawings (PDF) of Design Center projects, one file per drawing
  backupDir: path.join(dataDir, 'backups'),
  // the planner and the site app (index.html, site.html, icons…): in Docker copied to /app/public/app, when run from the
  // repository they are the files at the top of the repository (the same ones GitHub Pages serves)
  appDir: path.resolve(env('APP_DIR', fs.existsSync(path.join(root, 'public', 'app', 'index.html')) ? path.join(root, 'public', 'app') : path.join(root, '..'))),
  workerFile: path.resolve(env('WORKER_FILE', first(path.join(root, 'worker', 'worker.mjs'), path.join(root, '..', 'server', 'worker.js')))),
  publicDir: path.join(root, 'public'),
  cookieSecure: env('COOKIE_SECURE', appUrl.startsWith('https://') ? 'true' : 'false') === 'true',
  trustProxy: env('TRUST_PROXY', 'true') === 'true',
  sessionDays: int('SESSION_DAYS', 60),
  maxUploadMb: int('MAX_UPLOAD_MB', 60),
  backupHour: int('BACKUP_HOUR', 2),
  backupKeep: int('BACKUP_KEEP', 7),
  company: env('COMPANY_NAME', 'Express Tech'),
  appName: env('APP_NAME', 'Express Tech Design Center'),
  admin: { name: env('ADMIN_NAME', 'Admin'), username: env('ADMIN_USERNAME', ''), email: env('ADMIN_EMAIL', ''), password: env('ADMIN_PASSWORD', '') },
  asanaToken: env('ASANA_TOKEN', ''),
  zoho: {
    dc: env('ZOHO_DC', 'com'), orgId: env('ZOHO_ORG_ID', ''), clientId: env('ZOHO_CLIENT_ID', ''), clientSecret: env('ZOHO_CLIENT_SECRET', ''),
    refreshToken: env('ZOHO_REFRESH_TOKEN', ''), templateId: env('ZOHO_TEMPLATE_ID', ''), salesperson: env('ZOHO_SALESPERSON', ''),
  },
  // how often the Asana mirror runs (the Cloudflare version ran every 2 minutes)
  asanaCronSeconds: int('ASANA_CRON_SECONDS', 120),
};

for (const d of [config.dataDir, config.blobDir, config.backupDir]) fs.mkdirSync(d, { recursive: true });

module.exports = config;
