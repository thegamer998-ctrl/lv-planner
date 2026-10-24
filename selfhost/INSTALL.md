# Installing the Express Tech Design Center on our server

This puts everything on Express Tech's own Linux server, at **https://design.expresskw.com**:

- the **LV Planner** (Design Center) — projects saved under each person's login, shared, opened on any device
- the **site app** — live projects for technicians, site engineers and managers
- the **customer's project link** — `https://design.expresskw.com/#<project>-<key>` (the links already sent keep working)
- logins and permissions, notifications, Asana, Zoho Books and the Claude connector

About 30–45 minutes. You need: the server (Linux with Docker), access to the expresskw.com DNS, and the office key of the old Cloudflare server (to bring the live projects over).

---

## 1. What the server needs

- Linux (Ubuntu 22.04/24.04 or similar), 2 GB RAM, 20 GB free disk to start (photos and drawings grow it)
- Docker with the compose plugin: `docker --version` and `docker compose version` both answer
  (if not: `curl -fsSL https://get.docker.com | sh`)
- Ports 80 and 443 open to the internet (HTTPS certificate and the app)

**Is LeadzIN already running on this server?** Then its Caddy already uses ports 80/443. Follow the steps below but use
**option B** in step 4 (the Design Center shares LeadzIN's Caddy).

## 2. Point design.expresskw.com at the server

In the DNS of expresskw.com, change the record of `design`:

| Type | Name | Value |
|---|---|---|
| A | design | the server's public IP address |

(Today `design` points to GitHub Pages — a CNAME to `thegamer998-ctrl.github.io`. Delete that CNAME and add the A record.)
Do this **after** step 6 if you want the old site to keep answering until the new one is ready; the certificate is
fetched as soon as the name points here.

## 3. Get the files onto the server

```bash
cd /opt
sudo git clone https://github.com/thegamer998-ctrl/lv-planner.git expresstech
cd expresstech/selfhost
cp .env.example .env
nano .env
```

In `.env` set at least:

- `APP_URL=https://design.expresskw.com` and `DOMAIN=design.expresskw.com`
- `ADMIN_NAME`, `ADMIN_USERNAME` (e.g. `husain`) and a temporary `ADMIN_PASSWORD` — the first admin login; you choose a new password at the first sign-in

Everything else can stay as it is. (No git on the server? Copy the whole repository folder there instead — the
`selfhost` folder needs the planner files next to it.)

The app runs as user 1000 inside Docker, so it must own its data folder:

```bash
sudo mkdir -p data
sudo chown -R 1000:1000 data
```

## 4. Start it

**Option A — this server has nothing else on ports 80/443:**

```bash
docker compose up -d --build
docker compose logs -f designcenter        # Ctrl+C to stop watching
```

The build fetches the planner's libraries (pdf.js, jsPDF, pdf-lib, the barcode reader) once from cdnjs and jsDelivr, so
the server needs internet access while building; after that browsers load nothing from outside sites.

```bash
```

**Option B — LeadzIN already runs here:**

```bash
docker network ls                          # find LeadzIN's network, usually leadzin_default
nano .env                                  # set PROXY_NETWORK=leadzin_default
docker compose -f docker-compose.with-leadzin.yml up -d --build
```

Then add the block from `Caddyfile.leadzin` to the end of LeadzIN's `Caddyfile` and reload LeadzIN's Caddy
(in the LeadzIN folder): `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.

You should see `listening on http://0.0.0.0:3000 (public address https://design.expresskw.com)` in the log.

## 5. First sign-in

Open https://design.expresskw.com, sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` and choose your own password.
Then set up **two-step sign-in** (required for admins): scan the QR code with an authenticator app on your phone
(Google Authenticator, Microsoft Authenticator, 1Password, Apple Passwords…) and type the code it shows. From then on
you sign in with your password and the current code from that app. Aziz does the same at his first sign-in.

Then **Admin → Logins & permissions → Add login** for each person. Quick choices:

| Person | Quick choice |
|---|---|
| Aziz | Admin |
| Tahir | Design Center only (sales) |
| Idris | Design Center + site engineer |
| Kutub | Technician |

Each new login shows a temporary password once (Copy message / WhatsApp). They choose their own at the first sign-in.
Lost or new phone: **the person → Reset two-step**; they set it up again at their next sign-in.
If someone already used a personal site-app link, pick their name under **Site app person** so their projects and
history carry on (the import in step 6 also links people by name).

## 6. Bring the live projects over from Cloudflare

**Admin → System → Move from Cloudflare**: the old address is filled in; paste the **office key** of the old server and
press **Copy everything**. It copies every live project — drawings, points, ticks, MAC addresses, photos, notes, site
reports, activity, cabinet checklists, people and the client links — and the planner files that were saved on the
old server (they become your Design Center projects; share them from **Projects**).

The old server must have the latest `server/worker.js` (with the export) — it is deployed to Cloudflare automatically
when `main` is pushed.

It is safe to run again: do it once now to try everything, and once more at the moment you switch (step 7) to bring
the last changes over.

## 7. Switch

1. Run the copy (step 6) one last time.
2. Make sure the DNS of `design.expresskw.com` points to this server (step 2).
3. Tell the team: open **https://design.expresskw.com**, sign in with your username, add it to the home screen
   (site app: `https://design.expresskw.com/app/site.html`). The old personal links stop being needed.
4. Customers' links keep working (same address, same key), and so does the site app people already added to their
   Home Screen (it opens the same `design.expresskw.com/site.html` with their personal link) — nobody installs anything
   again. They can also sign in with their own username from then on.

The old Cloudflare server and the GitHub Pages planner keep running until you switch them off (see HANDOVER.md).

## 8. Integrations (Admin → Integrations)

- **Asana** — paste a Personal access token (Asana → My settings → Apps → Developer apps), Save, Switch on, Test.
- **Zoho Books** — follow the steps in the dialog (Zoho API Console; you can add our Redirect URI to the LeadzIN client),
  then **Connect with Zoho**. Pick the estimate template and the salesperson if you want.
- **LeadzIN** — Make a new key, paste it into LeadzIN → Admin → Integrations → Express Tech Design Center. A won lead's
  **Start project** then starts its installation here from the approved Zoho quotation (no drawing needed).
- **Claude** — Switch on. Each person then opens **their name → Connect Claude** and adds the address shown there in
  their own Claude app (Settings → Connectors → Add custom connector).

## Backups

- Every night at `BACKUP_HOUR` the database is copied to `selfhost/data/backups` (the last `BACKUP_KEEP` are kept).
- **Copy the whole `selfhost/data` folder off the server regularly** (it holds the database, the floor drawings in
  `data/drawings`, the backups and `secret.key`, which unlocks the saved integration keys). For example nightly:
  `rsync -a /opt/expresstech/selfhost/data/ backup-host:/backups/designcenter/`
- A backup now: `docker compose exec designcenter npm run backup`
- Put one back: see `scripts/restore.js` (stop, restore, start).

## Updating

When the planner, the site app or the server change (a push to the repository):

```bash
cd /opt/expresstech && sudo git pull
cd selfhost && docker compose up -d --build          # option B: add  -f docker-compose.with-leadzin.yml
```

The data folder is not touched. Open pages pick up the new planner / site app by themselves.

## Useful commands

```bash
docker compose ps                                     # is it running?
docker compose logs --tail 100 designcenter           # what did it say?
docker compose restart designcenter
docker compose exec designcenter npm run user -- list
docker compose exec designcenter npm run user -- reset husain     # forgot the admin password
docker compose exec designcenter npm run user -- reset-2fa husain # lost the phone with the authenticator app
docker compose exec designcenter npm run user -- add "Aziz" aziz --admin
```

## If something is wrong

- **The browser says the connection is not secure / no certificate** — the DNS does not point here yet, or ports 80/443
  are closed. `docker compose logs caddy` says why.
- **"Wrong username or password"** — `npm run user -- reset <username>` gives a new temporary password.
- **The import says the office key is wrong** — it is the key the planner used for the old server (Settings → Express Tech
  server on a device that still has it).
- **The import says the old server has no export yet** — push `main` so Cloudflare gets the latest `server/worker.js`.
- **Zoho: "did not return a refresh token"** — the Redirect URI in the Zoho API Console must be exactly the one shown.
- **Notifications don't reach an iPhone** — add the site app to the Home Screen, open it from there, then my account →
  Turn on for this device.
