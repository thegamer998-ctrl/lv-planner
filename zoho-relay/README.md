# LV Planner → Zoho Books relay

With this relay set up, the planner's **Quote → Create in Zoho now** button makes the Draft estimate in Zoho Books directly, with no Claude step. Without it, **Open in Claude** does the same job through Claude.

The relay is a small free Cloudflare Worker (`worker.js`). Your Zoho keys are stored in the Worker's settings. They are never in the planner or on GitHub. The relay only creates **Draft** estimates and customers. It never sends anything.

Setup takes about 15 minutes, once.

## 1. Find your Zoho data center
Open Zoho Books in the browser and look at the address:
- `books.zoho.com` → **com**
- `books.zoho.sa` → **sa**
- `books.zoho.eu` → **eu**
- `books.zoho.in` → **in**

Use that ending everywhere below. The examples show `.com`.

## 2. Make a Zoho API client
1. Go to **https://api-console.zoho.com**. Sign in with the Zoho account that owns Express Tech Books.
2. Click **Add Client**, choose **Self Client**, then **Create**.
3. Copy the **Client ID** and **Client Secret**.
4. Open the **Generate Code** tab and fill it in:
   - **Scope:** `ZohoBooks.estimates.CREATE,ZohoBooks.contacts.READ,ZohoBooks.contacts.CREATE,ZohoBooks.settings.READ`
   - **Time duration:** 10 minutes
   - **Description:** LV Planner
5. Click **Create**, pick the Express Tech organization, and copy the **code**.

## 3. Turn the code into a refresh token (within 10 minutes)
On the Mac, open **Terminal** and paste this one line. Put in your three values first:

```
curl -s -X POST "https://accounts.zoho.com/oauth/v2/token?grant_type=authorization_code&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&code=CODE"
```

Copy the `refresh_token` value from the reply. It doesn't expire. Keep it private.

## 4. Create the Worker (free)
1. Go to **https://dash.cloudflare.com** and sign up or sign in.
2. Open **Workers & Pages**, click **Create**, then **Create Worker**. Name it `lv-zoho-relay` and click **Deploy**.
3. Click **Edit code**, delete what's there, and paste all of `worker.js`. Click **Deploy**.
4. Go to **Settings → Variables and Secrets** and add:

| Name | Type | Value |
|---|---|---|
| `ZOHO_CLIENT_ID` | Secret | Client ID from step 2 |
| `ZOHO_CLIENT_SECRET` | Secret | Client Secret from step 2 |
| `ZOHO_REFRESH_TOKEN` | Secret | refresh_token from step 3 |
| `RELAY_KEY` | Secret | any long password you make up |
| `ZOHO_DC` | Text | `com` (or `sa` / `eu` / `in`) |
| `ORG_ID` | Text | `716314143` |
| `ALLOWED_ORIGIN` | Text | `https://thegamer998-ctrl.github.io` |
| `TEMPLATE_ID` | Text | `2276818000000071050` |
| `SALESPERSON` | Text | `Hussain Kazi` |

5. Click **Deploy** again. Copy the Worker address, for example `https://lv-zoho-relay.yourname.workers.dev`.

## 5. Connect the planner
In the planner, click **Quote**, open **Direct Zoho link**, and enter:
- the Worker address
- the `RELAY_KEY`

Click **Save**. The **Create in Zoho now** button appears. Do this once on each device (Mac, iPad). The details are saved only on that device.

## What it does
1. Finds the customer by exact name, or creates them as an individual customer.
2. Creates a **Draft** estimate:
   - reference "Villa LV Design"
   - Compact template
   - salesperson
   - Express Tech terms and notes
3. Uses the lines from the planner under the Network Infrastructure and CCTV headings. Each line uses its item's description without the "Model:" line, or the planner's own description for patch panels, Point Termination and Professional Services.
4. Replies with the estimate number and total, which the planner shows.
