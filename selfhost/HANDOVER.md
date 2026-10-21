# Handover — Express Tech Design Center (self-hosted)

For whoever looks after the server or changes the app. Installation is in [INSTALL.md](INSTALL.md); the big picture in
[README.md](README.md).

## Where things are

| What | Where |
|---|---|
| The code | GitHub `thegamer998-ctrl/lv-planner` — planner & site app at the top, live-project server in `server/worker.js`, this server in `selfhost/` |
| On the server | `/opt/expresstech` (the repository) · settings in `selfhost/.env` · all data in `selfhost/data` |
| Database | `selfhost/data/expresstech.db` (SQLite, WAL) — logins, Design Center projects, notifications, integrations, and the live projects (the worker's tables: projects, floors, floor_pdf, points, photos, notes, issues, log, checks, staff, pfile) |
| Floor drawings of Design Center projects | `selfhost/data/drawings/<2 letters>/<sha256>.pdf` (never changed once written; unused ones are removed after 14 days) |
| Backups | `selfhost/data/backups` (nightly) — copy `data/` off the server too |
| Secrets | `.env` (first admin, optional integration keys) · `data/secret.key` (encrypts the integration keys saved in Admin → Integrations — keep it with the database) |
| Logs | `docker compose logs designcenter` |

## Logins and permissions

Admin → Logins & permissions. Per person: **Design Center**, **See every Design Center project**, **Live projects office**,
**Admin**, and a **site app role** (technician / site engineer / site manager). Admins have everything. At least one active
admin is always kept. Switching a login off signs that person out everywhere at once and stops their site-app access.

Each login with a site role (or office access) has a record in the site app (the worker's `staff` table) — that is what
puts their name on ticks, photos and notes and what a project's team lists. It follows the login automatically
(name, role, switched off). The old personal links (`site.html#u=<key>`) still work for people whose login is linked to
their old record; switching the login off stops them.

From the command line (e.g. nobody can sign in as admin): `docker compose exec designcenter npm run user -- list|add|reset|perms|activate|deactivate`.

## What runs where today, and switching the old pieces off

| Piece | Before | Now |
|---|---|---|
| Planner | GitHub Pages `thegamer998-ctrl.github.io/lv-planner/` | `design.expresskw.com/app/` (the same file) |
| Site app | GitHub Pages `…/site.html` + personal links | `design.expresskw.com/app/site.html`, sign-in |
| Live-project server | Cloudflare Worker `expresstech.hussaink-060.workers.dev` + D1 | inside this server |
| Customer links | `design.expresskw.com/#…` (GitHub Pages) | the same address, now this server |
| Planner files | local files / iPad Files + copy on the Worker | Design Center projects under each login |

After the switch (INSTALL step 7) and a week of everyone working on the new server:

1. Run Admin → System → Move from Cloudflare one last time if anything was still done on the old one.
2. Cloudflare: Workers → expresstech → Settings → Triggers: remove the cron (stops the Asana mirroring there).
   Later delete the Worker and the D1 database `expresstech` (export first if you want an archive).
3. GitHub Pages can stay (the planner there still works with files and the old server) or be switched off in the
   repository settings. The `design-center` repository (the old customer front door) is no longer used once the DNS
   points here.
4. In GitHub → Settings → Secrets you can remove `CLOUDFLARE_API_TOKEN` and the deploy workflow when the Worker is gone.

The planner and the site app files are shared by both worlds: with `/hosted.js` (this server) they sign in and save
online; without it (GitHub Pages) they work exactly as before.

## Changing things

- **The planner / site app** (`index.html`, `site.html`): edit at the top of the repository as before; bump the version
  (`.ver` in index.html, `SITE_VER` in site.html, `version.json`, and the cache name in `sw.js`). Everything for the
  hosted version is behind `HOSTED` (planner) / `HOSTED` (site app) and in `selfhost/public/hosted.js`.
- **Live-project rules** (ticks, steps, Asana, cabinets, reports): `server/worker.js`. It runs here unchanged; new
  tables / columns go into its `SCHEMA` / `COLUMNS` lists and are created on the next start.
- **Logins, projects, sharing, notifications, admin**: `selfhost/src`. Schema changes: add a new entry to `MIGRATIONS`
  in `src/db.js` (never edit an old one).
- **Notifications**: kinds and who gets what in `src/notify.js` (`KINDS`, `dispatch`).
- **Claude tools**: `src/mcp.js` (`TOOLS`, `callTool`).
- Run `npm test` in `selfhost/` before deploying; then on the server `git pull && docker compose up -d --build`.

## Security notes

- Passwords: scrypt; sessions: random token in an HttpOnly, Secure, SameSite=Lax cookie (only its hash is stored);
  10 failed sign-ins per address and username in 15 minutes are blocked.
- Every state-changing API call needs the `X-Express: 1` header (cross-site requests can't send it).
- The office key of the live-project server is random, made at each start and never leaves the server process. A key
  sent by a browser in `X-Admin-Key` is dropped.
- MAC addresses are never sent to customers (the worker removes them for the customer role).
- Integration keys are stored encrypted (AES-256-GCM) with `data/secret.key` (or `SECRET_KEY` from `.env`).
- The Claude connector uses OAuth 2.1 with PKCE; each person approves their own Claude; access tokens last 1 hour,
  refresh tokens 60 days and rotate. Admin → Integrations → Claude can make it read-only (default) or switch it off.

## Health

- `https://design.expresskw.com/api/health` → `{"ok":true,…}` (Docker's health check uses it).
- Admin → System: version, database size, drawings, counts, backups, last import.
