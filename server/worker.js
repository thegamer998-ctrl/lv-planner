// ExpressTech server (Cloudflare Worker + D1 database bound as DB)
//   /zoho          → Draft estimate in Zoho Books from the planner's quote
//   /site/...      → installation site app: floor plans, points, ticks, photos, notes, site reports, Asana mirror
//   cron (every 2 min) → keeps every linked Asana project mirrored
//
// Secrets: ADMIN_KEY (office key), ASANA_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
// Variables: ALLOWED_ORIGIN, ZOHO_DC, ORG_ID, TEMPLATE_ID, SALESPERSON

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
  `CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, project_id TEXT, floor_id TEXT, x REAL, y REAL, kind TEXT, point_id TEXT,
     suggest_type TEXT, text TEXT, by_name TEXT, at INTEGER, status TEXT DEFAULT 'open', status_by TEXT, status_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, at INTEGER, by_name TEXT,
     action TEXT, point_id TEXT, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS photos_pt ON photos (project_id, point_id)`,
  `CREATE INDEX IF NOT EXISTS notes_pt ON notes (project_id, point_id)`,
  `CREATE INDEX IF NOT EXISTS issues_p ON issues (project_id, status)`,
  `CREATE INDEX IF NOT EXISTS log_p ON log (project_id, at)`
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const s of SCHEMA) await db.prepare(s).run();
  schemaReady = true;
}

// Point categories (the planner's VLAN groups) and the Asana subtask each completes when every point of it is installed
const CATS = {
  ap:    { name: "Access points", asana: /access point.*install|install.*access point|ceiling access point/i },
  cam:   { name: "Cameras",       asana: /camera.*install|install.*camera|cctv.*install/i },
  data:  { name: "Data points",   asana: /data point|network point/i },
  phone: { name: "IP phones",     asana: /phone.*install|install.*phone/i },
  icom:  { name: "Intercom",      asana: /intercom|door entry/i },
  rack:  { name: "Cabinet",       asana: null },
  other: { name: "Other",         asana: null }
};
// money / admin tasks: shown in the office view only
const PRIVATE_STAGE = /payment|invoice|it flow|customer details|quotation|advance/i;
const MAX_IMG = 1900 * 1024;   // D1 rows are limited to 2 MB
const FRESH_MS = 90 * 1000;    // a mirror older than this is refreshed when someone opens the project

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
      if (path === "/" && req.method === "GET") return json({ ok: true, service: "ExpressTech server", asana: !!env.ASANA_TOKEN, db: !!env.DB });
      if ((path === "/zoho" || path === "/") && req.method === "POST") {
        if (!adminOk()) return json({ error: "Wrong office key" }, 401);
        return json(await zohoEstimate(await req.json(), env));
      }
      if (!path.startsWith("/site")) return json({ error: "Not found" }, 404);
      if (!env.DB) return json({ error: "Database not connected — bind a D1 database as DB" }, 500);
      await ensureSchema(env.DB);
      const db = env.DB;

      // ---- office endpoints
      if (path === "/site/publish" && req.method === "POST") {
        if (!adminOk()) return json({ error: "Wrong office key" }, 401);
        return json(await publish(db, await req.json()));
      }
      if (path === "/site/list" && req.method === "GET") {
        if (!adminOk()) return json({ error: "Wrong office key" }, 401);
        return json({ projects: await projectList(db) });
      }

      const m = path.match(/^\/site\/p\/([A-Za-z0-9]+)(?:\/(.*))?$/);
      if (!m) return json({ error: "Not found" }, 404);
      const pid = m[1], rest = m[2] || "";
      let proj = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(pid).first();
      if (!proj) return json({ error: "Project not found" }, 404);
      const key = req.headers.get("X-Key") || url.searchParams.get("k") || "";
      const role = adminOk() ? "office" : key && key === proj.team_key ? "team" : key && key === proj.view_key ? "customer" : null;
      if (!role) return json({ error: "This link is not valid any more — ask ExpressTech for a new one" }, 403);
      const canEdit = role === "office" || role === "team";
      const by = (req.headers.get("X-By") || url.searchParams.get("by") || (role === "office" ? "ExpressTech office" : "Technician")).slice(0, 40);
      const asanaOn = !!(proj.asana_gid && env.ASANA_TOKEN);
      let mm;

      // floor drawings
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
      // photos (of points or of site reports)
      if ((mm = rest.match(/^photo\/([A-Za-z0-9]+)$/))) {
        if (req.method === "DELETE") {
          if (!canEdit) return json({ error: "View only" }, 403);
          const ph = await db.prepare("SELECT point_id FROM photos WHERE id = ? AND project_id = ?").bind(mm[1], pid).first();
          await db.prepare("DELETE FROM photos WHERE id = ? AND project_id = ?").bind(mm[1], pid).run();
          if (ph) await addLog(db, pid, by, "photo-removed", ph.point_id, "");
          return json({ ok: true });
        }
        const ph = await db.prepare("SELECT img, point_id FROM photos WHERE id = ? AND project_id = ?").bind(mm[1], pid).first();
        if (!ph || (role === "customer" && String(ph.point_id).startsWith("issue:"))) return json({ error: "No photo" }, 404);
        return new Response(toBytes(ph.img), { headers: { ...cors, "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" } });
      }
      // point actions: installed tick, photo, note
      if ((mm = rest.match(/^pt\/([^/]+)\/(status|photo|note)$/)) && req.method === "POST") {
        if (!canEdit) return json({ error: "View only — use the team link to make changes" }, 403);
        const ptid = decodeURIComponent(mm[1]);
        const pt = await db.prepare("SELECT * FROM points WHERE project_id = ? AND point_id = ?").bind(pid, ptid).first();
        if (!pt) return json({ error: "Point not found" }, 404);
        if (mm[2] === "status") {
          const b = await req.json(), inst = b.installed ? 1 : 0, t = now();
          await db.prepare("UPDATE points SET installed = ?, installed_by = ?, installed_at = ? WHERE project_id = ? AND point_id = ?")
            .bind(inst, inst ? by : null, inst ? t : null, pid, ptid).run();
          await addLog(db, pid, by, inst ? "installed" : "uninstalled", ptid, pt.label);
          await touch(db, pid);
          if (asanaOn) ctx.waitUntil(asanaPush(db, env, proj, pt.cat, by).catch(e => console.log("asana push", e)));
          return json({ ok: true, installed: inst, installed_by: inst ? by : null, installed_at: inst ? t : null });
        }
        if (mm[2] === "photo") return json(await savePhoto(db, req, url, pid, ptid, by, pt.label));
        if (mm[2] === "note") return json(await saveNote(db, req, pid, ptid, by, pt.label));
      }
      // site reports (technician pins: extra point found, point not on site, other)
      if (rest === "issue" && req.method === "POST") {
        if (!canEdit) return json({ error: "View only" }, 403);
        const b = await req.json();
        const kind = ["missing", "extra", "other"].includes(b.kind) ? b.kind : "other";
        const text = String(b.text || "").trim().slice(0, 1000);
        if (!b.floorId) return json({ error: "Floor is required" }, 400);
        const id = rid(14), t = now();
        await db.prepare("INSERT INTO issues (id, project_id, floor_id, x, y, kind, point_id, suggest_type, text, by_name, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')")
          .bind(id, pid, String(b.floorId), clamp01(b.x), clamp01(b.y), kind, b.pointId ? String(b.pointId) : null, b.suggestType ? String(b.suggestType).slice(0, 30) : null, text, by, t).run();
        await addLog(db, pid, by, "report", "issue:" + id, (kind === "missing" ? "Extra point found" : kind === "extra" ? "Point not on site" : "Site report") + (text ? ": " + text.slice(0, 60) : ""));
        await touch(db, pid);
        return json({ ok: true, id });
      }
      if ((mm = rest.match(/^issue\/([A-Za-z0-9]+)\/(photo|note|status)$/)) && req.method === "POST") {
        const iid = mm[1];
        const is = await db.prepare("SELECT * FROM issues WHERE id = ? AND project_id = ?").bind(iid, pid).first();
        if (!is) return json({ error: "Report not found" }, 404);
        if (!canEdit) return json({ error: "View only" }, 403);
        if (mm[2] === "photo") return json(await savePhoto(db, req, url, pid, "issue:" + iid, by, "site report"));
        if (mm[2] === "note") return json(await saveNote(db, req, pid, "issue:" + iid, by, "site report"));
        if (mm[2] === "status") {
          if (role !== "office") return json({ error: "Only the office can approve or close a report" }, 403);
          const b = await req.json();
          const status = ["open", "approved", "rejected", "done"].includes(b.status) ? b.status : "open";
          await db.prepare("UPDATE issues SET status = ?, status_by = ?, status_at = ? WHERE id = ?").bind(status, by, now(), iid).run();
          const reply = String(b.reply || "").trim();
          const label = status === "rejected" && is.kind === "extra" ? "Point stays in the drawing"
            : { open: "Reopened", approved: "Approved", rejected: "Not needed", done: "Done — point updated in the drawing" }[status];
          await db.prepare("INSERT INTO notes (id, project_id, point_id, text, by_name, at) VALUES (?, ?, ?, ?, ?, ?)").bind(rid(16), pid, "issue:" + iid, label + (reply ? " — " + reply : ""), by, now()).run();
          await addLog(db, pid, by, "report-" + status, "issue:" + iid, reply.slice(0, 60));
          await touch(db, pid);
          return json({ ok: true, status });
        }
      }
      if ((mm = rest.match(/^note\/([A-Za-z0-9]+)$/)) && req.method === "DELETE") {
        if (!canEdit) return json({ error: "View only" }, 403);
        await db.prepare("DELETE FROM notes WHERE id = ? AND project_id = ?").bind(mm[1], pid).run();
        return json({ ok: true });
      }
      // Asana: link, refresh, tick a stage, comment on a stage
      if (rest === "asana" && req.method === "POST") {
        if (role !== "office") return json({ error: "Office only" }, 403);
        const b = await req.json();
        const gid = String(b.gid || "").replace(/\D/g, "") || null;
        await db.prepare("UPDATE projects SET asana_gid = ?, asana_cache = NULL, asana_at = 0 WHERE id = ?").bind(gid, pid).run();
        let stages = null;
        if (gid && env.ASANA_TOKEN) stages = await asanaRefresh(db, env, { ...proj, asana_gid: gid, asana_cache: null });
        return json({ ok: true, gid, stages: stages ? stagesFor(stages, "office") : null });
      }
      if (rest === "asana/refresh" && req.method === "POST") {
        if (!asanaOn) return json({ error: "Asana is not linked" }, 400);
        const stages = await asanaRefresh(db, env, proj);
        return json({ ok: true, stages: stagesFor(stages, role) });
      }
      if ((mm = rest.match(/^stage\/(\d+)(\/comment)?$/)) && req.method === "POST") {
        if (!canEdit) return json({ error: "View only" }, 403);
        if (!asanaOn) return json({ error: "Asana is not linked" }, 400);
        const cache = safeJson(proj.asana_cache), gid = mm[1];
        const found = findTask(cache, gid);
        if (!found || (role !== "office" && found.private)) return json({ error: "Stage not found" }, 404);
        const b = await req.json();
        if (mm[2]) {
          const text = String(b.text || "").trim().slice(0, 2000);
          if (!text) return json({ error: "Empty comment" }, 400);
          await asanaApi(env, `/tasks/${gid}/stories`, { method: "POST", body: JSON.stringify({ data: { text: `${by} (ExpressTech Site): ${text}` } }) });
          await addLog(db, pid, by, "stage-comment", "stage:" + gid, found.task.name + ": " + text.slice(0, 60));
        } else {
          const done = !!b.completed;
          await asanaApi(env, `/tasks/${gid}`, { method: "PUT", body: JSON.stringify({ data: { completed: done } }) });
          await asanaApi(env, `/tasks/${gid}/stories`, { method: "POST", body: JSON.stringify({ data: { text: `${done ? "Completed" : "Reopened"} by ${by} in the ExpressTech site app.` } }) });
          await addLog(db, pid, by, done ? "stage-done" : "stage-reopened", "stage:" + gid, found.task.name);
        }
        const stages = await asanaRefresh(db, env, proj);
        return json({ ok: true, stages: stagesFor(stages, role) });
      }
      if (rest === "keys" && req.method === "POST") {
        if (role !== "office") return json({ error: "Office only" }, 403);
        const b = await req.json().catch(() => ({}));
        const team = b.which === "customer" ? proj.team_key : rid(), view = b.which === "team" ? proj.view_key : rid();
        await db.prepare("UPDATE projects SET team_key = ?, view_key = ? WHERE id = ?").bind(team, view, pid).run();
        return json({ ok: true, team_key: team, view_key: view });
      }
      if (rest === "" && req.method === "GET") {
        // keep the Asana mirror fresh: refresh now if it is old, in the background if it is a little stale
        if (asanaOn) {
          const age = now() - (proj.asana_at || 0);
          if (age > 6 * FRESH_MS) { try { await asanaRefresh(db, env, proj); proj = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(pid).first(); } catch (e) { console.log("asana", e); } }
          else if (age > FRESH_MS) ctx.waitUntil(asanaRefresh(db, env, proj).catch(e => console.log("asana", e)));
        }
        return json(await projectView(db, proj, role));
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  // Cron trigger (set "*/2 * * * *" in the Worker's Triggers): mirror every active linked Asana project
  async scheduled(event, env, ctx) {
    if (!env.DB || !env.ASANA_TOKEN) return;
    await ensureSchema(env.DB);
    const r = await env.DB.prepare("SELECT * FROM projects WHERE asana_gid IS NOT NULL AND asana_at < ? ORDER BY asana_at LIMIT 15").bind(now() - 100 * 1000).all();
    for (const p of r.results) {
      const c = safeJson(p.asana_cache);
      if (c.project && c.project.completed && now() - (p.asana_at || 0) < 6 * 3600 * 1000) continue;   // finished projects: every 6 h
      try { await asanaRefresh(env.DB, env, p); } catch (e) { console.log("cron asana", p.id, e); }
    }
  }
};

function clamp01(v) { v = +v; return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5; }
function toBytes(v) { if (Array.isArray(v)) return new Uint8Array(v); return v; }
function safeJson(s) { try { return JSON.parse(s || "{}") || {}; } catch (e) { return {}; } }
async function touch(db, pid) { await db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now(), pid).run(); }
async function addLog(db, pid, by, action, ptid, detail) {
  await db.prepare("INSERT INTO log (project_id, at, by_name, action, point_id, detail) VALUES (?, ?, ?, ?, ?, ?)").bind(pid, now(), by, action, ptid, detail || "").run();
}
async function savePhoto(db, req, url, pid, ptid, by, label) {
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) throw new Error("Empty photo");
  if (buf.byteLength > MAX_IMG) throw new Error("Photo too large");
  const id = rid(16), q = url.searchParams, t = now();
  await db.prepare("INSERT INTO photos (id, project_id, point_id, img, w, h, by_name, at, caption) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, pid, ptid, new Uint8Array(buf), +q.get("w") || 0, +q.get("h") || 0, by, t, (q.get("caption") || "").slice(0, 200)).run();
  await addLog(db, pid, by, "photo", ptid, label);
  await touch(db, pid);
  return { ok: true, photo: { id, by, at: t, w: +q.get("w") || 0, h: +q.get("h") || 0 } };
}
async function saveNote(db, req, pid, ptid, by, label) {
  const b = await req.json(), text = String(b.text || "").trim().slice(0, 1000);
  if (!text) throw new Error("Empty note");
  const id = rid(16), t = now();
  await db.prepare("INSERT INTO notes (id, project_id, point_id, text, by_name, at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, pid, ptid, text, by, t).run();
  await addLog(db, pid, by, "note", ptid, text.slice(0, 80));
  await touch(db, pid);
  return { ok: true, note: { id, text, by, at: t } };
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
  for (const [i, f] of (b.floors || []).entries()) {
    await db.prepare(`INSERT INTO floors (project_id, floor_id, ord, name, w, h, v) VALUES (?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT (project_id, floor_id) DO UPDATE SET ord = excluded.ord, name = excluded.name`)
      .bind(proj.id, String(f.id), i, f.name || "Floor", +f.w || 0, +f.h || 0).run();
  }
  const oldF = await db.prepare("SELECT floor_id FROM floors WHERE project_id = ?").bind(proj.id).all();
  for (const r of oldF.results) if (!floorIds.includes(r.floor_id)) await db.prepare("DELETE FROM floors WHERE project_id = ? AND floor_id = ?").bind(proj.id, r.floor_id).run();
  await db.prepare("UPDATE points SET active = 0 WHERE project_id = ?").bind(proj.id).run();
  for (const [i, p] of b.points.entries()) {
    await db.prepare(`INSERT INTO points (project_id, point_id, floor_id, type, cat, label, model, color, x, y, ord, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT (project_id, point_id) DO UPDATE SET floor_id = excluded.floor_id, type = excluded.type, cat = excluded.cat, label = excluded.label,
          model = excluded.model, color = excluded.color, x = excluded.x, y = excluded.y, ord = excluded.ord, active = 1`)
      .bind(proj.id, String(p.id), String(p.floorId), p.type || "", p.cat || "data", p.label || "", p.model || "", p.color || "#3b82f6", +p.x || 0, +p.y || 0, i).run();
  }
  // reports the office resolved in the planner (point added / removed)
  for (const r of (b.resolved || [])) {
    const is = await db.prepare("SELECT status FROM issues WHERE id = ? AND project_id = ?").bind(String(r.id), proj.id).first();
    if (!is || is.status === "done") continue;
    await db.prepare("UPDATE issues SET status = 'done', status_by = 'ExpressTech office', status_at = ? WHERE id = ?").bind(t, String(r.id)).run();
    await db.prepare("INSERT INTO notes (id, project_id, point_id, text, by_name, at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(rid(16), proj.id, "issue:" + r.id, r.text || "Done — point updated in the drawing", "ExpressTech office", t).run();
    await addLog(db, proj.id, "ExpressTech office", "report-done", "issue:" + r.id, r.text || "");
  }
  if ((b.resolved || []).length) await addLog(db, proj.id, "ExpressTech office", "published", "", "Drawing updated");
  const have = await db.prepare("SELECT floor_id, v FROM floors WHERE project_id = ?").bind(proj.id).all();
  return { id: proj.id, team_key: proj.team_key, view_key: proj.view_key, needFloors: have.results.filter(r => !r.v).map(r => r.floor_id) };
}

async function projectView(db, proj, role) {
  const pid = proj.id;
  const [floors, points, photos, notes, issues, log] = await Promise.all([
    db.prepare("SELECT floor_id, ord, name, w, h, v FROM floors WHERE project_id = ? ORDER BY ord").bind(pid).all(),
    db.prepare("SELECT point_id, floor_id, type, cat, label, model, color, x, y, installed, installed_by, installed_at FROM points WHERE project_id = ? AND active = 1 ORDER BY ord").bind(pid).all(),
    db.prepare("SELECT id, point_id, w, h, by_name, at, caption FROM photos WHERE project_id = ? ORDER BY at").bind(pid).all(),
    db.prepare("SELECT id, point_id, text, by_name, at FROM notes WHERE project_id = ? ORDER BY at").bind(pid).all(),
    db.prepare("SELECT * FROM issues WHERE project_id = ? ORDER BY at DESC").bind(pid).all(),
    db.prepare("SELECT at, by_name, action, point_id, detail FROM log WHERE project_id = ? ORDER BY at DESC LIMIT 60").bind(pid).all()
  ]);
  const byPt = {}, byIssue = {};
  for (const p of points.results) byPt[p.point_id] = { ...p, photos: [], notes: [] };
  const out = {
    role, project: { id: pid, name: proj.name, updated_at: proj.updated_at, meta: safeJson(proj.meta), asana: !!proj.asana_gid },
    floors: floors.results.map(f => ({ id: f.floor_id, name: f.name, w: f.w, h: f.h, v: f.v })),
    points: [], issues: [], stages: proj.asana_cache ? stagesFor(safeJson(proj.asana_cache), role) : null, activity: []
  };
  if (role !== "customer") for (const is of issues.results) byIssue[is.id] = {
    id: is.id, floor_id: is.floor_id, x: is.x, y: is.y, kind: is.kind, point_id: is.point_id, suggest_type: is.suggest_type,
    text: is.text, by: is.by_name, at: is.at, status: is.status, status_by: is.status_by, status_at: is.status_at, photos: [], notes: [] };
  const target = id => String(id).startsWith("issue:") ? byIssue[String(id).slice(6)] : byPt[id];
  for (const ph of photos.results) { const t = target(ph.point_id); if (t) t.photos.push({ id: ph.id, w: ph.w, h: ph.h, by: ph.by_name, at: ph.at, caption: ph.caption }); }
  for (const n of notes.results) { const t = target(n.point_id); if (t) t.notes.push({ id: n.id, text: n.text, by: n.by_name, at: n.at }); }
  out.points = Object.values(byPt);
  out.issues = Object.values(byIssue);
  out.activity = log.results.filter(a => role !== "customer" || !/^(report|stage-comment)/.test(a.action));
  if (role === "office") { out.links = { team_key: proj.team_key, view_key: proj.view_key }; out.project.asana_gid = proj.asana_gid; }
  return out;
}

async function projectList(db) {
  const ps = await db.prepare("SELECT id, name, team_key, view_key, asana_gid, asana_cache, asana_at, updated_at FROM projects ORDER BY updated_at DESC").all();
  const cnt = await db.prepare("SELECT project_id, COUNT(*) AS n, SUM(installed) AS done FROM points WHERE active = 1 GROUP BY project_id").all();
  const iss = await db.prepare("SELECT project_id, COUNT(*) AS n FROM issues WHERE status = 'open' GROUP BY project_id").all();
  const ph = await db.prepare("SELECT project_id, COUNT(*) AS n FROM photos GROUP BY project_id").all();
  const by = (rows) => Object.fromEntries(rows.results.map(r => [r.project_id, r]));
  const C = by(cnt), I = by(iss), H = by(ph);
  return ps.results.map(p => {
    const c = safeJson(p.asana_cache);
    let tDone = 0, tAll = 0, next = null;
    for (const s of (c.sections || [])) for (const t of s.tasks) { tAll++; if (t.completed) tDone++; else if (!next && !PRIVATE_STAGE.test(t.name)) next = t.name; }
    return { id: p.id, name: p.name, team_key: p.team_key, view_key: p.view_key, updated_at: p.updated_at, points: (C[p.id] || {}).n || 0, installed: (C[p.id] || {}).done || 0,
      open_reports: (I[p.id] || {}).n || 0, photos: (H[p.id] || {}).n || 0, asana: !!p.asana_gid, asana_at: p.asana_at, stages_done: tDone, stages_all: tAll, next_stage: next,
      status: c.project && c.project.status ? c.project.status : null };
  });
}

// ------------------------------------------------------------------ Asana mirror
async function asanaApi(env, path, opts = {}) {
  const r = await fetch("https://app.asana.com/api/1.0" + path, {
    ...opts, headers: { "Authorization": "Bearer " + env.ASANA_TOKEN, "Content-Type": "application/json", "Accept": "application/json", ...(opts.headers || {}) }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || ("Asana " + r.status));
  return j.data;
}
const T_FIELDS = "name,completed,completed_at,assignee.name,due_on,notes,modified_at,num_subtasks";
function story(s) {
  return { at: Date.parse(s.created_at) || 0, by: s.created_by ? s.created_by.name : "Asana", text: s.text || "", kind: s.resource_subtype || s.type };
}
async function storiesOf(env, gid) {
  const ss = await asanaApi(env, `/tasks/${gid}/stories?opt_fields=created_at,created_by.name,text,resource_subtype,type&limit=100`);
  return ss.filter(s => s.resource_subtype === "comment_added" || s.resource_subtype === "marked_complete" || s.resource_subtype === "marked_incomplete" || s.resource_subtype === "assigned")
    .slice(-40).map(story);
}
function taskOut(t, old, stories) {
  return { gid: t.gid, name: t.name, completed: !!t.completed, completed_at: t.completed_at ? Date.parse(t.completed_at) : null,
    assignee: t.assignee ? t.assignee.name : null, due_on: t.due_on || null, notes: (t.notes || "").slice(0, 2000), modified_at: t.modified_at || null,
    stories: stories || (old && old.stories) || [] };
}
// Full mirror of the project: sections → tasks → subtasks, assignees, due dates, comments. Comments are re-read only for tasks that changed.
async function asanaRefresh(db, env, proj) {
  const old = safeJson(proj.asana_cache), oldBy = {};
  for (const s of (old.sections || [])) for (const t of s.tasks) { oldBy[t.gid] = t; for (const st of (t.subtasks || [])) oldBy[st.gid] = st; }
  const changed = (t) => !oldBy[t.gid] || oldBy[t.gid].modified_at !== t.modified_at;
  const [pinfo, tasks] = await Promise.all([
    asanaApi(env, `/projects/${proj.asana_gid}?opt_fields=name,completed,due_on,current_status_update.title,current_status_update.text,current_status_update.created_at,current_status_update.created_by.name,current_status_update.status_type`),
    asanaApi(env, `/projects/${proj.asana_gid}/tasks?opt_fields=${T_FIELDS},memberships.section.name,memberships.project.gid&limit=100`)
  ]);
  const sections = [];
  for (const t of tasks) {
    const mem = (t.memberships || []).find(x => x.project && x.project.gid === proj.asana_gid) || (t.memberships || [])[0];
    const sname = (mem && mem.section ? mem.section.name : "") || "Tasks";
    if (/untitled/i.test(sname) && t === tasks[0] && !t.num_subtasks && /^(mr|mrs|ms|dr|sheikh)\b/i.test(t.name)) continue;   // the customer-name card at the top
    let sec = sections.find(s => s.name === sname);
    if (!sec) { sec = { name: /untitled/i.test(sname) ? "General" : sname, tasks: [] }; sections.push(sec); }
    const task = taskOut(t, oldBy[t.gid], changed(t) ? await storiesOf(env, t.gid) : null);
    task.private = PRIVATE_STAGE.test(t.name);
    task.subtasks = [];
    if (t.num_subtasks) {
      const subs = await asanaApi(env, `/tasks/${t.gid}/subtasks?opt_fields=${T_FIELDS}&limit=100`);
      for (const s of subs) task.subtasks.push(taskOut(s, oldBy[s.gid], changed(s) ? await storiesOf(env, s.gid) : null));
    }
    sec.tasks.push(task);
  }
  const cs = pinfo.current_status_update;
  const mirror = { at: now(), project: { name: pinfo.name, completed: !!pinfo.completed, due_on: pinfo.due_on || null,
      status: cs ? { title: cs.title, text: (cs.text || "").slice(0, 1500), at: Date.parse(cs.created_at) || 0, by: cs.created_by ? cs.created_by.name : "", type: cs.status_type } : null },
    sections };
  await db.prepare("UPDATE projects SET asana_cache = ?, asana_at = ? WHERE id = ?").bind(JSON.stringify(mirror), now(), proj.id).run();
  proj.asana_cache = JSON.stringify(mirror); proj.asana_at = now();
  return mirror;
}
// What each role sees: office everything; team no money tasks; customer no money tasks, no comments, no notes
function stagesFor(m, role) {
  if (!m || !m.sections) return null;
  const strip = (t) => role === "customer" ? { ...t, stories: [], notes: "" } : t;
  return { at: m.at, project: role === "customer" ? { ...m.project, status: m.project && m.project.status ? { title: m.project.status.title, at: m.project.status.at, type: m.project.status.type } : null } : m.project,
    sections: m.sections.map(s => ({ name: s.name, tasks: s.tasks.filter(t => role === "office" || !t.private).map(t => ({ ...strip(t), subtasks: (t.subtasks || []).map(strip) })) }))
      .filter(s => s.tasks.length) };
}
function findTask(m, gid) {
  for (const s of (m.sections || [])) for (const t of s.tasks) {
    if (t.gid === gid) return { task: t, private: !!t.private };
    for (const st of (t.subtasks || [])) if (st.gid === gid) return { task: st, private: !!t.private };
  }
  return null;
}
// After a point tick: when every point of that kind is installed, complete the matching subtask (reopen it if one is unticked)
async function asanaPush(db, env, proj, cat, by) {
  const c = CATS[cat]; if (!c || !c.asana) return;
  const r = await db.prepare("SELECT COUNT(*) AS n, SUM(installed) AS done FROM points WHERE project_id = ? AND active = 1 AND cat = ?").bind(proj.id, cat).first();
  const n = r.n || 0, done = r.done || 0; if (!n) return;
  let m = safeJson(proj.asana_cache);
  if (!m.sections) m = await asanaRefresh(db, env, proj);
  let target = null;
  for (const s of m.sections) for (const t of s.tasks) {
    for (const st of (t.subtasks || [])) if (!target && c.asana.test(st.name)) target = st;
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
