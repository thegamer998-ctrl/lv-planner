# ExpressTech server: setup guide

One free Cloudflare Worker runs two things for the LV Planner:

- **Site app.** Technicians tick points, take photos and add notes on their phones. Customers follow progress. Asana stays in sync.
- **Direct Zoho quotes.** The planner's **Quote → Create in Zoho now** button.

Everything lives in your Cloudflare account. The free plan is enough and needs no card.
- Photos and data are stored in a Cloudflare **D1** database (5 GB free).
- Photos are shrunk on the phone to about 300 KB each, so that's roughly 15,000 photos.

Setup takes about 20 minutes, once.

---

## 1. Create the Worker
1. Go to **https://dash.cloudflare.com** and sign up or sign in.
2. Open **Workers & Pages**, click **Create**, then **Create Worker**. Name it `expresstech` and click **Deploy**.
3. Click **Edit code**, delete what's there, and paste all of `worker.js` from this folder. Click **Deploy**.
4. Copy the Worker address, for example `https://expresstech.yourname.workers.dev`.

## 2. Create the database and connect it
1. In the Cloudflare menu, go to **Storage & Databases → D1** and click **Create database**. Name it `expresstech`.
2. Open your Worker and go to **Settings → Bindings**. Click **Add → D1 database**.
   - **Variable name:** `DB` (exactly).
   - **Database:** `expresstech`.
3. Click **Save**. The tables are created automatically on first use.

## 3. Add the settings
In the Worker, go to **Settings → Variables and Secrets** and add:

| Name | Type | Value | Needed for |
|---|---|---|---|
| `ADMIN_KEY` | Secret | a long password you make up (the **office key**) | everything |
| `ALLOWED_ORIGIN` | Text | `https://thegamer998-ctrl.github.io` | everything |
| `ASANA_TOKEN` | Secret | your Asana personal access token (step 4) | Asana sync |
| `ZOHO_CLIENT_ID` | Secret | from the Zoho API console (step 5) | Zoho quotes |
| `ZOHO_CLIENT_SECRET` | Secret | from the Zoho API console | Zoho quotes |
| `ZOHO_REFRESH_TOKEN` | Secret | from step 5 | Zoho quotes |
| `ZOHO_DC` | Text | `com` (or `sa` / `eu` / `in`, the ending of your Zoho Books address) | Zoho quotes |
| `ORG_ID` | Text | `716314143` | Zoho quotes |
| `TEMPLATE_ID` | Text | `2276818000000071050` | Zoho quotes |
| `SALESPERSON` | Text | `Hussain Kazi` | Zoho quotes |

Click **Deploy** after adding them. You can start with only `ADMIN_KEY` and `ALLOWED_ORIGIN`, so the site app works, and add Asana and Zoho later.

## 3b. Keep Asana mirrored every 2 minutes
1. In the Worker, go to **Settings → Triggers → Cron Triggers** and click **Add**.
2. Enter `*/2 * * * *` and save.

The server then reads every linked Asana project every 2 minutes on its own:
- stages, steps, who is assigned, due dates, completions and comments
- the project status update

Projects marked complete in Asana are checked every 6 hours. Opening a project in the app also refreshes it, and there's a **Refresh** button in the Progress tab.

## 4. Asana token (for the sync)
1. In Asana, click your photo, then **Settings → Apps → Developer apps → Personal access tokens**. On some accounts the page is at https://app.asana.com/0/my-apps.
2. Click **Create new token**, name it `ExpressTech Site`, and copy it into `ASANA_TOKEN`.

Ticks from the site app will show in Asana as coming from this account.

## 5. Zoho (for "Create in Zoho now")
1. Go to **https://api-console.zoho.com**. Click **Add Client**, choose **Self Client**, then **Create**. Copy the Client ID and Client Secret.
2. Open the **Generate Code** tab and fill it in:
   - **Scope:** `ZohoBooks.estimates.CREATE,ZohoBooks.contacts.READ,ZohoBooks.contacts.CREATE,ZohoBooks.settings.READ`
   - **Time duration:** 10 minutes
3. Click **Create**, pick Express Tech, and copy the code.
4. Within 10 minutes, open **Terminal** on the Mac and run this one line, with your values filled in:
   ```
   curl -s -X POST "https://accounts.zoho.com/oauth/v2/token?grant_type=authorization_code&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&code=CODE"
   ```
5. Copy the `refresh_token` from the reply into `ZOHO_REFRESH_TOKEN`.

## 6. Connect the planner
1. In the planner, click **Site** and open **ExpressTech server**.
2. Paste the Worker address and the office key (`ADMIN_KEY`), then click **Save**.

Do this once on each office device. The **Quote** dialog uses the same server.

---

## Using it
1. **Publish.** Open the project in the planner, click **Site**, then **Publish to site**. The points go up with each floor's original vector drawing.
   - The site app draws the drawing itself, so it stays sharp at every zoom, and the points sit exactly where they are in the planner.
   - Each phone keeps a copy of the drawing, so it opens instantly and works with no signal.
   - Projects published before this version show a picture of the drawing until you press **Update site** once.
2. **Your team: one personal link each.** In the office view (step 4), scroll to **Team**, type the name, pick the role and press **Add**. Their link is copied: send it on WhatsApp.

   | Role | Can do |
   |---|---|
   | **Technician** (e.g. Kutbuddin) | tick **Installed** on every point, and **Aligned** on cameras; photos, notes, site reports, Asana stages and comments |
   | **Site engineer** (e.g. Idris) | everything a technician can, plus **Configured** on cameras; a **To configure** filter on the plan |
   | **Manager** (e.g. Husain) | everything, plus office-only stages (payments), approving site reports, the customer and team links, and managing the team |

   A personal link opens all the projects. Every tick, photo and note shows the person's name and role. Press ✕ to stop someone's link.
3. **Other links** (in the planner's **Site** window):
   - **Team link:** a shared link for a helper without a personal link. The phone asks for a name once.
   - **Customer link:** view only, with progress, photos and stages. It never shows the team link or payment tasks.
4. **Office view (all projects).** In the planner, open **Site → Open office view**, or bookmark `https://thegamer998-ctrl.github.io/lv-planner/site.html#office&s=<server address>`.
   - Enter the office key once on each device.
   - It lists every project with progress, open site reports, Asana stages, the next stage and the status.
   - Open a project to see everything, including office-only tasks such as payments.
5. **Cameras: three ticks.** In the app each camera has three steps:
   1. **Installed**: the technician fixed it
   2. **Aligned**: the technician aimed and locked it
   3. **Configured**: the site engineer adopted, named and set recording

   A camera counts as done for the installation only when it is installed **and** aligned. Ticking Aligned also ticks Installed. Unticking Installed clears the later steps.
6. **Link Asana.** Paste the villa's Asana project link and click **Link Asana**.
   - When every point of a kind has a step ticked, the matching Asana subtask is completed with a comment. The subtask is found by its name:

   | When all… | completes the Asana task or subtask named like |
   |---|---|
   | access points are installed | **Ceiling Access Point Installation** |
   | cameras are installed | **Cameras Installation** (any name with "camera" and "install") |
   | cameras are aligned | **Cameras Alignment** (any name with "camera" and "align") |
   | cameras are configured | **CCTV - Camera Naming…** or **Camera Adoption** |
   | data points are installed | a name with "data point" or "network point" |

   - Add **Cameras Installation** and **Cameras Alignment** as subtasks in the villa template, so every new project has them.
   - Unticking reopens the subtask.
   - The Asana stages show in the site app's **Progress** tab and stay mirrored every 2 minutes (see step 3b).
7. **Asana from the app.** In **Progress**, tap a stage to tick it or its steps, read the comments and history, and write a comment. Everything goes to Asana under the technician's name.
   - Technicians see the work stages.
   - Customers see the stages without comments.
   - Payment and invoice tasks are office only.
8. **Site reports.** A technician taps **Report** on the plan and taps the spot, then chooses one of:
   - **Extra point found here**, with the kind of point (AP, camera…)
   - **Point not on site**
   - **Other issue**

   They add a comment and an optional photo. You see it:
   - in the office view, under **Reports**
   - on your drawing in the planner, as an orange pin

   Click the pin and choose:
   - **Add camera here**: the point is placed exactly there
   - **Remove this point**
   - **Not needed / Keep the point**, with a reply

   Press **Update site**. The technician sees the new or removed point and your answer.
9. **Changes to the design.** Click **Update site**. Ticks, photos and notes on existing points are kept.
10. **No signal on site** (basements). Ticks, notes and photos wait on the phone and upload by themselves when the signal returns.
11. **Lost a link?** Open **Site** in the planner to copy it again. Links can be reset from the server if one is shared by mistake.
