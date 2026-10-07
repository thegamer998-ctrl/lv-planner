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
1. **Your team, once.** In the planner click **Start** (or **Site**), then **+ Add people** next to **Team**. The office view opens at the **Team** list (step 4). Add each person with their role, and send them their own link (**Copy link** → WhatsApp). They open it once on their phone and add it to the home screen: it becomes their ExpressTech app, with every project they are on.

   | Role | Can do |
   |---|---|
   | **Technician** (e.g. Kutbuddin) | only his own work: **Installed** on every point and **Aligned** on cameras; photos, notes, site reports, Asana stages and comments. He never sees **Configured**. |
   | **Site engineer** (e.g. Idris) | **Configured** on access points, cameras, IP phones, intercom and the network cabinet, many at once (**Checklist → Configuration → Select all → Mark configured**). He can also correct technician ticks. Has a **To configure** filter on the plan. |
   | **Manager** (e.g. Husain) | sees every project, including office-only stages (payments); approves site reports; manages the team and links |

   Press ✕ next to a person to stop their link.
2. **Start the project** after the customer approves the quotation. In the planner, click **Start** in the toolbar:
   - tick who works on it (everyone is ticked; new people added later also get it while everyone is ticked)
   - paste the Asana project link (optional, can be done later)
   - press **▶ Start project**

   The drawing and points go up, the project appears in each team member's app by itself, and you get the **client link** to send (Copy or WhatsApp). The window also shows each team member's own link, if someone doesn't have it yet.
   - The site app draws each floor's original vector drawing: sharp at every zoom, points exactly where they are in the planner, and it works with no signal once opened.
   - After that the toolbar button reads **Site**: send drawing changes with **Update site**, change the team with **Change**.
3. **Finish.** **Mark project complete** moves it to **Completed** in the team's app. The client link keeps working (read-only). **Reopen project** brings it back.
4. **Office view (all projects).** In the planner, open **Site → Office view** (then **‹** for all projects), or **+ Add people**, or bookmark `https://thegamer998-ctrl.github.io/lv-planner/site.html#office&s=<server address>`.
   - Enter the office key once on each device.
   - It lists every project with progress, open site reports, Asana stages, the next stage and the status.
   - Open a project to see everything, including office-only tasks such as payments.
5. **Labels.** Every point has a label, e.g. **GF-AP01**, **GF-CAM07 Main gate** or **RF-CAM01**: the floor, then the kind and number, then an optional name.
   - Set the name in the planner: click the point, open **More**, and type it under **Label on site & name in UniFi**.
   - The technician writes the label on the device and cable. The site engineer uses the same name in UniFi (the **Copy** button).
   - A label is fixed the first time you publish. Adding, moving or deleting points never renumbers the others, and a deleted number is never reused.
   - **Changing a label on site.** If the client wants a different name (e.g. **GF-HALL-AP01**), the technician, the site engineer or the manager taps the point, then **Edit** next to the label, types the new label and taps **Save label**. Everyone sees it at once, and the customer sees it but can't change it. The app shows who changed it, and **use it again** brings back the drawing's label.
   - The planner picks site changes up when you open **Site**, so your schedule PDF and the next **Update site** use the new label. To replace it from the office, change the point's name in the planner (click the point, open **More**); the point shows the label from site there.
6. **Who ticks what.** Nobody ticks for anyone else.
   - **Technician:** **Installed** on every point, plus **Aligned** on cameras. A camera counts as done only when it is installed **and** aligned. Ticking Aligned also ticks Installed, and unticking Installed clears Aligned, since both are his own.
   - **Site engineer:** **Configured** on access points, cameras, IP phones, intercom and the network cabinet. He does it in bulk: **Checklist → Configuration**, **Select all** on a device type, then **Mark configured**. His ticks never change the technician's, and the technician's never change his.
7. **Link Asana.** Paste the villa's Asana project link and click **Link Asana**.
   - **Points:** an Asana step is completed only when **every** point of that kind has the step ticked (e.g. all cameras aligned). One point unticked reopens it. A comment says who ticked the last one. Steps are found by their names in your villa template:

   | When all… | completes |
   |---|---|
   | ceiling access points are installed | **Peripheral Works › Ceiling Access Points Installation** |
   | wall access points (the WAP type) are installed | **Peripheral Works › Wall Access Points Installation** |
   | data / phone points are installed | **Peripheral Works › Faceplates Punching** |
   | intercom points are installed | **Peripheral Works › Intercom Installation** |
   | cameras are installed / aligned | **Peripheral Works › CCTV Installation / CCTV Alignment** |
   | access points / cameras / IP phones / intercom are configured | **Hardware Configuration › Access Points / CCTV / IP Phones / IP Intercom and Screens** |

   - **Cabling step:** in the planner's **Site** window, tick **ExpressTech pulls the cables** when your team pulls the cables on that job. Every cabled point then gets **Cabling → Installed (→ Aligned for cameras)**, and a point is done only when all are ticked. Asana: a task named like **Cabling for 15 Cameras and 1 Viewport** is completed when every cable run is ticked.
   - **Viewport** (UniFi Protect ViewPort, in the planner under Cameras): Cabling → Installed, then **Configured** by the site engineer. Asana: **Viewport Installation**, **Configuration of Viewport**.
   - Projects with a flat Asana list (Technicians / Engineers sections, no "Cabinet Works" parent) work too: the cabinet takes the tasks about the cabinet, crimping, UNVR, switch, HDD, UPS, labelling and their configuration, in the Asana order. Cameras configured complete **Camera Adoption** and **Camera Naming**.
   - **The cabinet:** tap the cabinet on the plan. It shows the villa's own **Cabinet Works** steps in the Asana order (Cable Tracing → … → UPS; **Cabinet Delivery** stays in Asana only, for the office admin), then **Patch Panel Labelling** and **Cabinet Sticker**, then the engineer's **UDM PRO / Switches / IP PBX** configuration. Each tick completes that exact Asana step. Technicians tick the works and labelling; only the site engineer (or office) ticks the configuration. The cabinet shows as done on the plan when all its works are ticked. Without Asana the same list is used.
   - Unticking reopens the subtask.
   - The Asana stages show in the site app's **Progress** tab and stay mirrored every 2 minutes (see step 3b).
8. **Asana from the app.** In **Progress**, tap a stage to tick it or its steps, read the comments and history, and write a comment. Everything goes to Asana under the technician's name.
   - Technicians see the work stages.
   - Customers see the stages without comments.
   - Payment and invoice tasks are office only.
9. **Site reports.** A technician taps **Report** on the plan and taps the spot, then chooses one of:
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
10. **Changes to the design.** Click **Update site**. Ticks, photos and notes on existing points are kept.
11. **No signal on site** (basements). Ticks, notes and photos wait on the phone and upload by themselves when the signal returns.
12. **Lost a link?** Open **Site** in the planner to copy it again. Links can be reset from the server if one is shared by mistake.
