# Express Tech Design Center — self-hosted

The LV Planner, the live projects (site app), the customer view, logins, sharing, notifications and integrations,
running on Express Tech's own server at **https://design.expresskw.com**. Same stack as LeadzIN: Node.js 22 with no
packages, SQLite (`node:sqlite`), Caddy for HTTPS, Docker.

- **Install:** [INSTALL.md](INSTALL.md)
- **Running it / changing it / what is where:** [HANDOVER.md](HANDOVER.md)

## What people get

| Who | What |
|---|---|
| Everyone | One username and password — the same for the site app and (if allowed) the Design Center. Notifications under the bell, on the phone too. Their own Claude connected with their own login. |
| Design Center (e.g. Tahir, Idris) | The LV Planner. Projects save by themselves while you work, open the same on the laptop and the iPad, can be shared ("shared by Husain"), have versions. |
| Live projects office (admins) | Start project / Update site, all live projects, client links, approve site reports, Asana. |
| Site app role | Technician (install, align, cable, photos, MAC), Site engineer (configure), Site manager (sees every live project). |
| Admin (Husain, Aziz) | Everything, plus Admin → Logins & permissions, Integrations, System. |
| Customers | Their link `design.expresskw.com/#<project>-<key>` — progress and photos, view only, never MAC addresses. |

## How it fits together

```
 browser ──HTTPS──▶ Caddy ──▶ Node server (src/server.js)
                                ├── /                    home page, the customer's link        public/index.html, portal.js
                                ├── /login               sign in                                public/login.html
                                ├── /app/                the LV Planner        ┐ the same files GitHub Pages serves (repository root),
                                ├── /app/site.html       the site app          ┘ plus one line: <script src="/hosted.js">
                                ├── /site/…, /zoho       live projects & Zoho  → server/worker.js (the Cloudflare Worker, unchanged)
                                ├── /api/…               logins, Design Center projects, sharing, notifications, admin
                                └── /mcp, /oauth/…       the Claude connector
                              SQLite: data/expresstech.db   ·   floor drawings: data/drawings   ·   backups: data/backups
```

- **The live-project server is the Cloudflare Worker itself** (`../server/worker.js`), run inside Node with a small
  D1-compatible wrapper over SQLite (`src/worker-bridge.js`). Its tables, rules (who can tick what, Asana mirroring,
  per-cabinet checklists, MAC privacy…) are exactly the same. Improving the worker improves both.
- **No keys in browsers.** The planner and the site app send `session` instead of the office key / personal link key;
  the server checks the sign-in and adds the right key for that person (office → office key, everyone else → their own
  record in the site app). Customer and team links (`k=…`) work as before.
- **Design Center projects** (`src/dc.js`): the planner's project file per owner, saved every few seconds while you
  work; each floor drawing (PDF) is stored once by its SHA-256 fingerprint in `data/drawings`. A save based on an older
  version is refused with a choice (open theirs / keep mine / save a copy). Versions kept every ~20 minutes and whenever
  someone else saves. When the project is live, the live site follows (right away on Save, otherwise after a quiet minute).
- **Notifications** (`src/notify.js`): shares, edits by others, new site reports, answers to reports, added to a team,
  project paused/completed, cable destination/label changed on site, integration problems. Live on open pages (Server-Sent
  Events) and as web push (VAPID, `src/push.js`) per kind as each person chooses.
- **Integrations** (`src/integrations/`): Asana token and Zoho Books connection (encrypted with `data/secret.key`) are
  handed to the worker; Claude (MCP + OAuth 2.1 with PKCE, `src/mcp.js`, `src/oauth.js`) — each person connects their own.

## Folders

```
selfhost/
  Dockerfile, docker-compose.yml, docker-compose.with-leadzin.yml, Caddyfile, Caddyfile.leadzin, .env.example
  src/        server.js (routes) · config · db (schema) · http · auth · perms · worker-bridge · dc · notify · push · events
              integrations/ (asana, zoho, claude, store) · mcp · oauth · importcf (move from Cloudflare) · backup · secrets
  public/     index.html + portal.js + portal.css (home, projects, live, notifications, account, Connect Claude, admin)
              login.html/js · hosted.js (planner & site app additions: saving, sharing, bell) · push-sw.js · manifest
  scripts/    user.js (logins from the command line) · import-cloudflare.js · backup.js · restore.js
  test/       api.test.js (logins, permissions, live projects, notifications, projects, sharing, conflicts, Claude)
              import.test.js (move from Cloudflare against a stand-in old server)
../index.html, ../site.html, ../*.png …   the planner and the site app
../server/worker.js                       the live-project server
```

## Run it on a laptop (development)

```bash
cd selfhost
ADMIN_USERNAME=husain ADMIN_PASSWORD=temp12345 npm run dev     # http://localhost:3000
npm test
```

Node 22.13 or newer. No `npm install` — there are no packages.
