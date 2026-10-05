// ExpressTech LV Planner → Zoho Books relay (Cloudflare Worker)
// Receives a quote from the planner and creates a DRAFT estimate in Zoho Books.
// Secrets live in the Worker's settings (never in the planner):
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, RELAY_KEY
// Plain variables: ZOHO_DC (com | eu | in | sa | com.au), ORG_ID (716314143),
//   ALLOWED_ORIGIN (https://thegamer998-ctrl.github.io), TEMPLATE_ID, SALESPERSON

let cachedToken = null, tokenExpiry = 0;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : (allowed[0] || "*"),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Relay-Key",
      "Vary": "Origin"
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return reply({ error: "POST only" }, 405);
    if (!env.RELAY_KEY || req.headers.get("X-Relay-Key") !== env.RELAY_KEY) return reply({ error: "Wrong relay key" }, 401);

    let q;
    try { q = await req.json(); } catch (e) { return reply({ error: "Bad JSON" }, 400); }
    if (!q.customer_name || !Array.isArray(q.line_items) || !q.line_items.length) return reply({ error: "Customer and lines are required" }, 400);

    try {
      const dc = env.ZOHO_DC || "com", org = env.ORG_ID;
      const api = `https://www.zohoapis.${dc}/books/v3`;
      const token = await getToken(env, dc);
      const z = async (path, opts = {}) => {
        const sep = path.includes("?") ? "&" : "?";
        const r = await fetch(`${api}${path}${sep}organization_id=${org}`, {
          ...opts, headers: { "Authorization": `Zoho-oauthtoken ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) }
        });
        const j = await r.json();
        if (j.code !== 0) throw new Error(j.message || `Zoho error ${j.code}`);
        return j;
      };

      // 1. customer: exact name match, else create
      let customerCreated = false;
      const found = await z(`/contacts?contact_type=customer&contact_name=${encodeURIComponent(q.customer_name)}`);
      let contact = (found.contacts || []).find(c => c.contact_name.trim().toLowerCase() === q.customer_name.trim().toLowerCase());
      if (!contact) {
        const made = await z(`/contacts`, { method: "POST", body: JSON.stringify({ contact_name: q.customer_name, contact_type: "customer", customer_sub_type: "individual" }) });
        contact = made.contact; customerCreated = true;
      }

      // 2. line descriptions: the given one, else the item's description without the leading "Model: …" line
      const descCache = {};
      const lines = [];
      for (const l of q.line_items) {
        let description = l.description;
        if (!description) {
          if (!(l.item_id in descCache)) {
            try {
              const it = (await z(`/items/${l.item_id}`)).item;
              descCache[l.item_id] = (it.description || "").replace(/^Model:[^\n]*\n?/, "");
            } catch (e) { descCache[l.item_id] = ""; }
          }
          description = descCache[l.item_id];
        }
        const li = { item_id: l.item_id, quantity: l.quantity, header_name: l.header_name, description };
        if (l.rate != null) li.rate = l.rate;
        lines.push(li);
      }

      // 3. the Draft estimate (never sent)
      const body = {
        customer_id: contact.contact_id,
        reference_number: q.reference_number || "Villa LV Design",
        notes: q.notes || "Looking forward for your business.",
        terms: q.terms || "",
        line_items: lines
      };
      if (env.TEMPLATE_ID) body.template_id = env.TEMPLATE_ID;
      if (env.SALESPERSON) body.salesperson_name = env.SALESPERSON;
      const est = (await z(`/estimates?send=false`, { method: "POST", body: JSON.stringify(body) })).estimate;
      return reply({ estimate_id: est.estimate_id, estimate_number: est.estimate_number, total: est.total, status: est.status, customer_created: customerCreated });
    } catch (e) {
      return reply({ error: String(e.message || e) }, 502);
    }
  }
};

async function getToken(env, dc) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const accounts = dc === "com" ? "accounts.zoho.com" : `accounts.zoho.${dc}`;
  const u = `https://${accounts}/oauth/v2/token?refresh_token=${encodeURIComponent(env.ZOHO_REFRESH_TOKEN)}&client_id=${encodeURIComponent(env.ZOHO_CLIENT_ID)}&client_secret=${encodeURIComponent(env.ZOHO_CLIENT_SECRET)}&grant_type=refresh_token`;
  const r = await fetch(u, { method: "POST" });
  const j = await r.json();
  if (!j.access_token) throw new Error("Zoho login failed: " + (j.error || "no token"));
  cachedToken = j.access_token; tokenExpiry = Date.now() + ((j.expires_in || 3600) - 120) * 1000;
  return cachedToken;
}
