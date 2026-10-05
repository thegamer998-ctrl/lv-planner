// ExpressTech server (Cloudflare Worker + D1 database "DB")
//   /zoho              → create a Draft estimate in Zoho Books from the planner's quote
//   /site/...          → shared installation site: floor plans, points, ticks, photos, notes, Asana stages
//
// Secrets (Worker settings → Variables and Secrets):
//   ADMIN_KEY            office key used by the planner (publish projects, create quotes)
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN   (only for /zoho)
//   ASANA_TOKEN          Asana personal access token        (only for Asana sync)
// Plain variables: ZOHO_DC (com|eu|in|sa|com.au), ORG_ID, TEMPLATE_ID, SALESPERSON, ALLOWED_ORIGIN
// Binding: D1 database bound as DB.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, team_key TEXT, view_key TEXT, meta TEXT,
     asana_gid TEXT, asana_cache TEXT, asana_at INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS floors (project_id TEXT, floor_id TEXT, ord INTEGER, name TEXT, w INTEGER, h INTEGER,
     img BLOB, v INTEGER DEFAULT 0, PRIMARY KEY (project_id, floor_id))`,
  `CREATE TABLE IF NOT EXISTS points (project_id TEXT, point_id TEXT, floor_id TEXT, type TEXT, cat TEXT, label TEXT,
     model TEXT, color TEXT, x REAL, y REAL, ord INTEGER, installed INTEGER DEFAULT 0, installed_by TEXT, installed_at INTEGER,
     active INTEGER DEFAULT 1, PRIMARY KEY (project_id, point_id))`,
  `CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, project_id TEXT, point_id TEXT, img BLOB, w INTEGER, h INTEGER,
     by_name TEXT, at INTEGER, caption TEXT)`,
  `CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, project_id TEXT, point_id TEXT, text TEXT, by_name TEXT, at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, at INTEGER, by_name TEXT,
     action TEXT, point_id TEXT, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS photos_pt ON photos (project_id, point_id)`,
  `CREATE INDEX IF NOT EXISTS notes_pt ON notes (project_id, point_id)`,
  `CREATE INDEX IF NOT EXISTS log_p ON log (project_id, at)`
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const s of SCHEMA) await db.prepare(s).run();
  schemaReady = true;
}

// Categories (match the planner's VLAN groups) and the Asana subtask each one completes when every point is installed
const CATS = {
  ap:    { name: "Access points", asana: /access point.*install|install.*access point|ceiling access point/i },
  cam:   { name: "Cameras",       asana: /camera.*install|install.*camera|cctv.*install/i },
  data:  { name: "Data points",   asana: /data point|network point/i },
  phone: { name: "IP phones",     asana: /phone.*install|install.*phone/i },
  icom:  { name: "Intercom",      asana: /intercom|door entry/i },
  rack:  { name: "Cabinet",       asana: null }
};
const HIDE_STAGE = /payment|invoice|it flow|customer details|quotation|advance/i;

const MAX_IMG = 1900 * 1024;   // D1 rows are limited to 2 MB

function rid(n = 20) {
  const a = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, x => a[x % a.length]).join("");
}
const now = () => Date.now();

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": !allowed.length || allowed.includes(origin) ? (origin || "*") : allowed[0],
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, X-Relay-Key, X-Key, X-By",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const adminOk = () => !!env.ADMIN_KEY && (req.headers.get("X-Admin-Key") === env.ADMIN_KEY || req.headers.get("X-Relay-Key") === env.ADMIN_KEY);
    try {
      if (path === "/" && req.method === "GET") return json({ ok: true, service: "ExpressTech server" });
      if ((path === "/zoho" || path === "/") && req.method === "POST") {
        if (!adminOk()) return json({ error: "Wrong office key" }, 401);
        return json(await zohoEstimate(await req.json(), env));
      }
      if (!path.startsWith("/site")) return json({ error: "Not found" }, 404);
      if (!env.DB) return json({ error: "Database not connected — bind a D1 database as DB" }, 500);
      await ensureSchema(env.DB);
      const db = env.DB;

      // ---- office (planner) endpoints
      if (path === "/site/publish" && req.method === "POST") {
        if (!adminOk()) return json({ error: "Wrong office key" }, 401);
        return json(await publish(db, await req.json()));
      }
      if (path === "/site/list" && req.method === "GET") {
        if (!adminOk()) return json({ error: "Wrong office key" }, 401);
        const r = await db.prepare("SELECT id, name, team_key, view_key, asana_gid, updated_at FROM projects ORDER BY updated_at DESC").all();
        return json({ projects: r.results });
      }

      const m = path.match(/^\/site\/p\/([A-Za-z0-9]+)(?:\/(.*))?$/);
      if (!m) return json({ error: "Not found" }, 404);
      const pid = m[1], rest = m[2] || "";
      const proj = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(pid).first();
      if (!proj) return json({ error: "Project not found" }, 404);
      const key = req.headers.get("X-Key") || url.searchParams.get("k") || "";
      const role = adminOk() ? "office" : key && key === proj.team_key ? "team" : key && key === proj.view_key ? "customer" : null;
      if (!role) return json({ error: "This link is not valid any more — ask ExpressTech for a new one" }, 403);
      const canEdit = role === "office" || role === "team";
      const by = (req.headers.get("X-By") || url.searchParams.get("by") || (role === "office" ? "ExpressTech office" : "Technician")).slice(0, 40);

      // floor image
      let mm;
      if ((mm = rest.match(/^floor\/([^/]+)$/))) {
        const fid = decodeURIComponent(mm[1]);
        if (req.method === "PUT") {
          if (role !== "office") return json({ error: "Office only" }, 403);
          const buf = await req.arrayBuffer();
          if (buf.byteLength > MAX_IMG) return json({ error: "Floor image too large" }, 413);
          const q = url.searchParams;
          await db.prepare(`INSERT INTO floors (project_id, floor_id, ord, name, w, h, img, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (project_id, floor_id) DO UPDATE SET ord = excluded.ord, name = excluded.name, w = excluded.w, h = excluded.h, img = excluded.img, v = excluded.v`)
            .bind(pid, fid, +q.get("ord") || 0, q.get("name") || fid, +q.get("w") || 0, +q.get("h") || 0, new Uint8Array(buf), now()).run();
          await touch(db, pid);
          return json({ ok: true });
        }
        const f = await db.prepare("SELECT img FROM floors WHERE project_id = ? AND floor_id = ?").bind(pid, fid).first();
        if (!f || !f.img) return json({ error: "No image" }, 404);
        return new Response(toBytes(f.img), { headers: { ...cors, "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" } });
      }
      // photo
      if ((mm = rest.match(/^photo\/([A-Za-z0-9]+)$/))) {
        if (req.method === "DELETE") {
          if (!canEdit) return json({ error: "View only" }, 403);
          const ph = await db.prepare("SELECT point_id FROM photos WHERE id = ? AND project_id = ?").bind(mm[1], pid).first();
          await db.prepare("DELETE FROM photos WHERE id = ? AND project_id = ?").bind(mm[1], pid).run();
          if (ph) await addLog(db, pid, by, "photo-removed", ph.point_id, "");
          return json({ ok: true });
        }
        const ph = await db.prepare("SELECT img FROM photos WHERE id = ? AND project_id = ?").bind(mm[1], pid).first();
        if (!ph) return json({ error: "No photo" }, 404);
        return new Response(toBytes(ph.img), { headers: { ...cors, "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" } });
      }
      // point actions
      if ((mm = rest.match(/^pt\/([^/]+)\/(status|photo|note)$/)) && req.method === "POST") {
        if (!canEdit) return json({ error: "View only — use the team link to make changes" }, 403);
        const ptid = decodeURIComponent(mm[1]);
        const pt = await db.prepare("SELECT * FROM points WHERE project_id = ? AND point_id = ?").bind(pid, ptid).first();
        if (!pt) return json({ error: "Point not found" }, 404);
        if (mm[2] === "status") {
          const b = await req.json();
          const inst = b.installed ? 1 : 0;
          await db.prepare("UPDATE points SET installed = ?, installed_by = ?, installed_at = ? WHERE project_id = ? AND point_id = ?")
            .bind(inst, inst ? by : null, inst ? now() : null, pid, ptid).run();
          await addLog(db, pid, by, inst ? "installed" : "uninstalled", ptid, pt.label);
          await touch(db, pid);
          if (proj.asana_gid && env.ASANA_TOKEN) ctx.waitUntil(asanaPush(db, env, proj, pt.cat, by).catch(e => console.log("asana", e)));
          return json({ ok: true, installed: inst, installed_by: inst ? by : null, installed_at: inst ? now() : null });
        }
        if (mm[2] === "photo") {
          const buf = await req.arrayBuffer();
          if (!buf.byteLength) return json({ error: "Empty photo" }, 400);
          if (buf.byteLength > MAX_IMG) return json({ error: "Photo too large" }, 413);
          const id = rid(16), q = url.searchParams;
          await db.prepare("INSERT INTO photos (id, project_id, point_id, img, w, h, by_name, at, caption) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(id, pid, ptid, new Uint8Array(buf), +q.get("w") || 0, +q.get("h") || 0, by, now(), (q.get("caption") || "").slice(0, 200)).run();
          await addLog(db, pid, by, "photo", ptid, pt.label);
          await touch(db, pid);
          return json({ ok: true, photo: { id, by, at: now(), caption: q.get("caption") || "", w: +q.get("w") || 0, h: +q.get("h") || 0 } });
        }
        if (mm[2] === "note") {
          const b = await req.json(), text = String(b.text || "").trim().slice(0, 1000);
          if (!text) return json({ error: "Empty note" }, 400);
          const id = rid(16);
          await db.prepare("INSERT INTO notes (id, project_id, point_id, text, by_name, at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, pid, ptid, text, by, now()).run();
          await addLog(db, pid, by, "note", ptid, text.slice(0, 80));
          await touch(db, pid);
          return json({ ok: true, note: { id, text, by, at: now() } });
        }
      }
      if ((mm = rest.match(/^note\/([A-Za-z0-9]+)$/)) && req.method === "DELETE") {
        if (!canEdit) return json({ error: "View only" }, 403);
        await db.prepare("DELETE FROM notes WHERE id = ? AND project_id = ?").bind(mm[1], pid).run();
        return json({ ok: true });
      }
      if (rest === "asana" && req.method === "POST") {
        if (role !== "office") return json({ error: "Office only" }, 403);
        const b = await req.json();
        const gid = String(b.gid || "").replace(/\D/g, "") || null;
        await db.prepare("UPDATE projects SET asana_gid = ?, asana_cache = NULL, asana_at = 0 WHERE id = ?").bind(gid, pid).run();
        let stages = null;
        if (gid && env.ASANA_TOKEN) { stages = await asanaRefresh(db, env, { ...proj, asana_gid: gid }); }
        return json({ ok: true, gid, stages });
      }
      if (rest === "keys" && req.method === "POST") {
        if (role !== "office") return json({ error: "Office only" }, 403);
        const b = await req.json().catch(() => ({}));
        const team = b.which === "customer" ? proj.team_key : rid(), view = b.which === "team" ? proj.view_key : rid();
        await db.prepare("UPDATE projects SET team_key = ?, view_key = ? WHERE id = ?").bind(team, view, pid).run();
        return json({ ok: true, team_key: team, view_key: view });
      }
      if (rest === "" && req.method === "GET") {
        // refresh Asana stages in the background when older than 5 minutes
        if (proj.asana_gid && env.ASANA_TOKEN && now() - (proj.asana_at || 0) > 5 * 60 * 1000) {
          ctx.waitUntil(asanaRefresh(db, env, proj).catch(e => console.log("asana", e)));
        }
        return json(await projectView(db, proj, role));
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
};

function toBytes(v) {
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return v;
  if (Array.isArray(v)) return new Uint8Array(v);
  return v;
}
async function touch(db, pid) { await db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now(), pid).run(); }
async function addLog(db, pid, by, action, ptid, detail) {
  await db.prepare("INSERT INTO log (project_id, at, by_name, action, point_id, detail) VALUES (?, ?, ?, ?, ?, ?)").bind(pid, now(), by, action, ptid, detail || "").run();
}

// Create or update a project from the planner. Ticks, photos and notes on points that still exist are kept.
async function publish(db, b) {
  if (!b || !b.name || !Array.isArray(b.points)) throw new Error("name and points are required");
  let proj = b.id ? await db.prepare("SELECT * FROM projects WHERE id = ?").bind(String(b.id)).first() : null;
  const t = now();
  if (!proj) {
    proj = { id: rid(12), team_key: rid(), view_key: rid() };
    await db.prepare("INSERT INTO projects (id, name, team_key, view_key, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(proj.id, b.name, proj.team_key, proj.view_key, JSON.stringify(b.meta || {}), t, t).run();
  } else {
    await db.prepare("UPDATE projects SET name = ?, meta = ?, updated_at = ? WHERE id = ?").bind(b.name, JSON.stringify(b.meta || {}), t, proj.id).run();
  }
  const floorIds = (b.floors || []).map(f => String(f.id));
  // floors: keep images, update names/order; drop floors that no longer exist
  for (const [i, f] of (b.floors || []).entries()) {
    await db.prepare(`INSERT INTO floors (project_id, floor_id, ord, name, w, h, v) VALUES (?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT (project_id, floor_id) DO UPDATE SET ord = excluded.ord, name = excluded.name, w = excluded.w, h = excluded.h`)
      .bind(proj.id, String(f.id), i, f.name || "Floor", +f.w || 0, +f.h || 0).run();
  }
  const oldF = await db.prepare("SELECT floor_id FROM floors WHERE project_id = ?").bind(proj.id).all();
  for (const r of oldF.results) if (!floorIds.includes(r.floor_id)) await db.prepare("DELETE FROM floors WHERE project_id = ? AND floor_id = ?").bind(proj.id, r.floor_id).run();
  // points
  await db.prepare("UPDATE points SET active = 0 WHERE project_id = ?").bind(proj.id).run();
  for (const [i, p] of b.points.entries()) {
    await db.prepare(`INSERT INTO points (project_id, point_id, floor_id, type, cat, label, model, color, x, y, ord, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT (project_id, point_id) DO UPDATE SET floor_id = excluded.floor_id, type = excluded.type, cat = excluded.cat, label = excluded.label,
          model = excluded.model, color = excluded.color, x = excluded.x, y = excluded.y, ord = excluded.ord, active = 1`)
      .bind(proj.id, String(p.id), String(p.floorId), p.type || "", p.cat || "data", p.label || "", p.model || "", p.color || "#3b82f6", +p.x || 0, +p.y || 0, i).run();
  }
  const have = await db.prepare("SELECT floor_id, v FROM floors WHERE project_id = ?").bind(proj.id).all();
  const needFloors = have.results.filter(r => !r.v).map(r => r.floor_id);
  return { id: proj.id, team_key: proj.team_key, view_key: proj.view_key, needFloors };
}

async function projectView(db, proj, role) {
  const pid = proj.id;
  const [floors, points, photos, notes, log] = await Promise.all([
    db.prepare("SELECT floor_id, ord, name, w, h, v FROM floors WHERE project_id = ? ORDER BY ord").bind(pid).all(),
    db.prepare("SELECT point_id, floor_id, type, cat, label, model, color, x, y, installed, installed_by, installed_at FROM points WHERE project_id = ? AND active = 1 ORDER BY ord").bind(pid).all(),
    db.prepare("SELECT id, point_id, w, h, by_name, at, caption FROM photos WHERE project_id = ? ORDER BY at").bind(pid).all(),
    db.prepare("SELECT id, point_id, text, by_name, at FROM notes WHERE project_id = ? ORDER BY at").bind(pid).all(),
    db.prepare("SELECT at, by_name, action, point_id, detail FROM log WHERE project_id = ? ORDER BY at DESC LIMIT 40").bind(pid).all()
  ]);
  const byPt = {};
  for (const p of points.results) byPt[p.point_id] = { ...p, photos: [], notes: [] };
  for (const ph of photos.results) if (byPt[ph.point_id]) byPt[ph.point_id].photos.push({ id: ph.id, w: ph.w, h: ph.h, by: ph.by_name, at: ph.at, caption: ph.caption });
  for (const n of notes.results) if (byPt[n.point_id]) byPt[n.point_id].notes.push({ id: n.id, text: n.text, by: n.by_name, at: n.at });
  let stages = null;
  try { stages = proj.asana_cache ? JSON.parse(proj.asana_cache) : null; } catch (e) {}
  const out = {
    role, project: { id: pid, name: proj.name, updated_at: proj.updated_at, meta: safeJson(proj.meta), asana: !!proj.asana_gid },
    floors: floors.results.map(f => ({ id: f.floor_id, name: f.name, w: f.w, h: f.h, v: f.v })),
    points: Object.values(byPt), stages, activity: log.results
  };
  if (role === "office") { out.links = { team_key: proj.team_key, view_key: proj.view_key }; out.project.asana_gid = proj.asana_gid; }
  return out;
}
function safeJson(s) { try { return JSON.parse(s || "{}"); } catch (e) { return {}; } }

// ------------------------------------------------------------------ Asana
async function asanaApi(env, path, opts = {}) {
  const r = await fetch("https://app.asana.com/api/1.0" + path, {
    ...opts, headers: { "Authorization": "Bearer " + env.ASANA_TOKEN, "Content-Type": "application/json", "Accept": "application/json", ...(opts.headers || {}) }
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || ("Asana " + r.status));
  return j.data;
}
// Read the project's stages (sections → tasks → subtasks), hiding payment / admin tasks
async function asanaRefresh(db, env, proj) {
  const tasks = await asanaApi(env, `/projects/${proj.asana_gid}/tasks?opt_fields=name,completed,completed_at,memberships.section.name,memberships.project.gid,num_subtasks&limit=100`);
  const sections = [];
  for (const t of tasks) {
    const mem = (t.memberships || []).find(x => x.project && x.project.gid === proj.asana_gid) || (t.memberships || [])[0];
    const sname = mem && mem.section ? mem.section.name : "";
    if (!sname || /untitled/i.test(sname) || HIDE_STAGE.test(t.name)) continue;
    let sec = sections.find(s => s.name === sname);
    if (!sec) { sec = { name: sname, tasks: [] }; sections.push(sec); }
    const task = { gid: t.gid, name: t.name, completed: !!t.completed, completed_at: t.completed_at || null, subtasks: [] };
    if (t.num_subtasks) {
      const subs = await asanaApi(env, `/tasks/${t.gid}/subtasks?opt_fields=name,completed,completed_at`);
      task.subtasks = subs.map(s => ({ gid: s.gid, name: s.name, completed: !!s.completed, completed_at: s.completed_at || null }));
    }
    sec.tasks.push(task);
  }
  const stages = { at: now(), sections };
  await db.prepare("UPDATE projects SET asana_cache = ?, asana_at = ? WHERE id = ?").bind(JSON.stringify(stages), now(), proj.id).run();
  return stages;
}
// After a tick: when every point of that category is installed, complete the matching Asana subtask (and reopen it if one is unticked)
async function asanaPush(db, env, proj, cat, by) {
  const c = CATS[cat]; if (!c || !c.asana) return;
  const r = await db.prepare("SELECT COUNT(*) AS n, SUM(installed) AS done FROM points WHERE project_id = ? AND active = 1 AND cat = ?").bind(proj.id, cat).first();
  const n = r.n || 0, done = r.done || 0; if (!n) return;
  let stages = null;
  try { stages = proj.asana_cache ? JSON.parse(proj.asana_cache) : null; } catch (e) {}
  if (!stages) stages = await asanaRefresh(db, env, proj);
  let target = null;
  for (const s of stages.sections) for (const t of s.tasks) {
    for (const st of t.subtasks) if (!target && c.asana.test(st.name)) target = st;
    if (!target && c.asana.test(t.name)) target = t;
  }
  if (!target) return;
  const complete = done >= n;
  if (complete !== target.completed) {
    await asanaApi(env, `/tasks/${target.gid}`, { method: "PUT", body: JSON.stringify({ data: { completed: complete } }) });
    const text = complete
      ? `All ${n} ${c.name.toLowerCase()} installed and ticked in the ExpressTech site app (last by ${by}).`
      : `Reopened: ${done} of ${n} ${c.name.toLowerCase()} installed (unticked by ${by} in the ExpressTech site app).`;
    await asanaApi(env, `/tasks/${target.gid}/stories`, { method: "POST", body: JSON.stringify({ data: { text } }) });
    await asanaRefresh(db, env, proj);
  }
}

// ------------------------------------------------------------------ Zoho Books (Draft estimates from the planner's quote)
let zohoToken = null, zohoExpiry = 0;
async function zohoEstimate(q, env) {
  if (!q.customer_name || !Array.isArray(q.line_items) || !q.line_items.length) throw new Error("Customer and lines are required");
  const dc = env.ZOHO_DC || "com", org = env.ORG_ID;
  const api = `https://www.zohoapis.${dc}/books/v3`;
  if (!zohoToken || now() > zohoExpiry) {
    const accounts = dc === "com" ? "accounts.zoho.com" : `accounts.zoho.${dc}`;
    const r = await fetch(`https://${accounts}/oauth/v2/token?refresh_token=${encodeURIComponent(env.ZOHO_REFRESH_TOKEN)}&client_id=${encodeURIComponent(env.ZOHO_CLIENT_ID)}&client_secret=${encodeURIComponent(env.ZOHO_CLIENT_SECRET)}&grant_type=refresh_token`, { method: "POST" });
    const j = await r.json();
    if (!j.access_token) throw new Error("Zoho login failed: " + (j.error || "no token"));
    zohoToken = j.access_token; zohoExpiry = now() + ((j.expires_in || 3600) - 120) * 1000;
  }
  const z = async (path, opts = {}) => {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`${api}${path}${sep}organization_id=${org}`, { ...opts, headers: { "Authorization": `Zoho-oauthtoken ${zohoToken}`, "Content-Type": "application/json" } });
    const j = await r.json();
    if (j.code !== 0) throw new Error(j.message || `Zoho error ${j.code}`);
    return j;
  };
  let customerCreated = false;
  const found = await z(`/contacts?contact_type=customer&contact_name=${encodeURIComponent(q.customer_name)}`);
  let contact = (found.contacts || []).find(c => c.contact_name.trim().toLowerCase() === q.customer_name.trim().toLowerCase());
  if (!contact) {
    contact = (await z(`/contacts`, { method: "POST", body: JSON.stringify({ contact_name: q.customer_name, contact_type: "customer", customer_sub_type: "individual" }) })).contact;
    customerCreated = true;
  }
  const descCache = {}, lines = [];
  for (const l of q.line_items) {
    let description = l.description;
    if (!description) {
      if (!(l.item_id in descCache)) {
        try { descCache[l.item_id] = ((await z(`/items/${l.item_id}`)).item.description || "").replace(/^Model:[^\n]*\n?/, ""); }
        catch (e) { descCache[l.item_id] = ""; }
      }
      description = descCache[l.item_id];
    }
    const li = { item_id: l.item_id, quantity: l.quantity, header_name: l.header_name, description };
    if (l.rate != null) li.rate = l.rate;
    lines.push(li);
  }
  const body = { customer_id: contact.contact_id, reference_number: q.reference_number || "Villa LV Design", notes: q.notes || "Looking forward for your business.", terms: q.terms || "", line_items: lines };
  if (env.TEMPLATE_ID) body.template_id = env.TEMPLATE_ID;
  if (env.SALESPERSON) body.salesperson_name = env.SALESPERSON;
  const est = (await z(`/estimates?send=false`, { method: "POST", body: JSON.stringify(body) })).estimate;
  return { estimate_id: est.estimate_id, estimate_number: est.estimate_number, total: est.total, status: est.status, customer_created: customerCreated };
}
