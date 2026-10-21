'use strict';
// The Design Center as a Claude connector (Model Context Protocol, Streamable HTTP at /mcp).
// Every call runs as the signed-in person, with exactly their permissions.
const fs = require('node:fs');
const { db } = require('./db');
const config = require('./config');
const { HttpError, readBody, send } = require('./http');
const oauth = require('./oauth');
const dc = require('./dc');
const bridge = require('./worker-bridge');
const notify = require('./notify');
const store = require('./integrations/store');
const P = require('./perms');

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_FILE = 15 * 1024 * 1024;
const writesAllowed = () => store.config('claude').allowWrites === true;
const TYPE_NAMES = { wifi: 'Wi-Fi access point', outdoorwifi: 'Outdoor Wi-Fi access point', cctv: 'CCTV camera (dome)', cctvoutdoor: 'CCTV camera (outdoor)', viewport: 'Viewport',
  network: 'Network / data point', ipphone: 'IP phone point', tv: 'TV point', dtv: 'Data & TV point', uplink: 'Up-link', speaker: 'Speaker', rack: 'Cabinet / IT rack',
  drawbox: 'Draw box', intercom: 'Intercom (door)', intercomscreen: 'Intercom screen', smartlock: 'Smart door lock' };

const T = (name, description, properties, required, write) => ({ name, description, write: !!write,
  inputSchema: { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false } });
const TOOLS = [
  T('whoami', 'Who you are connected as in the Express Tech Design Center, and what you may do there.'),
  T('list_design_projects', 'Design Center (LV Planner) projects: "mine" = I own them, "shared" = shared with me, "all" = every project (admins). Optional text filter on the name.',
    { scope: { type: 'string', enum: ['mine', 'shared', 'all', 'any'] }, query: { type: 'string' } }),
  T('get_design_project', 'Summary of one Design Center project: floors, number of points of each type per floor, cabinets, the linked live project, who it is shared with.', { project_id: { type: 'string' } }, ['project_id']),
  T('get_design_project_file', 'The full LV Planner project file (JSON, without the floor drawings): every point with type, position, cabinet, cable runs, racks, VLANs, cable calculation — the same file the planner saves. Use it to prepare quotes or schedules.', { project_id: { type: 'string' } }, ['project_id']),
  T('get_floor_drawing', 'The floor drawing (PDF) of one floor of a Design Center project. floor = floor name or number (1 = first).', { project_id: { type: 'string' }, floor: { type: 'string' } }, ['project_id', 'floor']),
  T('list_live_projects', 'Live projects (installation on site) I can see: progress, open site reports, Asana stage, paused / completed.'),
  T('get_live_project', 'One live project in detail: progress per kind of point (cabled / installed / aligned / configured), open site reports, cabinet checklists, recent activity.', { live_project_id: { type: 'string' } }, ['live_project_id']),
  T('list_notifications', 'My notifications (newest first).', { unread_only: { type: 'boolean' } }),
  T('mark_notifications_read', 'Mark all my notifications as read.', {}, [], true),
  T('add_point_note', 'Add a note to a point of a live project (as me), e.g. "cable pulled, face plate pending". point = the point\'s label as on site (e.g. GF-HALL-AP01).',
    { live_project_id: { type: 'string' }, point: { type: 'string' }, text: { type: 'string' } }, ['live_project_id', 'point', 'text'], true),
];
const need = (c, m) => { if (!c) throw new HttpError(403, m || 'Your permissions do not allow that.'); };

function typeName(data, t) { return TYPE_NAMES[t] || ((data.customTypes || {})[t] || {}).label || t; }
function summary(user, pid) {
  const { project, data } = dc.get(user, pid);
  const floors = (data.floors || []).map((f, i) => {
    const counts = {};
    for (const m of f.markers || []) { if (m.type === 'uplink') continue; const n = typeName(data, m.type); counts[n] = (counts[n] || 0) + 1; }
    return { number: i + 1, name: f.name, drawing: f.pdfRef ? 'yes' : 'no', points: Object.values(counts).reduce((a, b) => a + b, 0), by_type: counts };
  });
  const totals = {};
  for (const f of floors) for (const [k, v] of Object.entries(f.by_type)) totals[k] = (totals[k] || 0) + v;
  return { id: project.id, name: project.name, owner: project.owner.name, your_access: project.access, last_saved: project.updatedAt, last_saved_by: project.updatedBy.name,
    shared_with: project.sharedWith.map(s => s.name + (s.canEdit ? '' : ' (view)')), live_project_id: project.siteId, total_points: floors.reduce((a, f) => a + f.points, 0),
    totals_by_type: totals, floors, cabinets: (data.racks || []).map(r => ({ name: r.name, main: !!r.main })), revisions: (data.revisions || []).length };
}

async function callTool(user, name, a) {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw new HttpError(404, `Unknown tool ${name}`);
  if (t.write) need(writesAllowed(), 'Your admin has set the Claude connector to read-only.');
  const p = user.perms;
  switch (name) {
    case 'whoami': return { name: user.name, username: user.username, access: P.describe(p), design_center: p.design, live_projects_office: p.office, site_role: P.SITE_ROLE_NAME[p.site], admin: p.admin, claude_can_change_things: writesAllowed() };
    case 'list_design_projects': {
      need(p.design, 'You have no Design Center access.');
      const q = String(a.query || '').toLowerCase();
      const list = dc.list(user, a.scope === 'any' ? '' : a.scope || '').filter(x => !q || x.name.toLowerCase().includes(q));
      return { count: list.length, projects: list.slice(0, 60).map(x => ({ id: x.id, name: x.name, owner: x.owner.name, access: x.access, points: x.points, floors: x.floors, last_saved: x.updatedAt, by: x.updatedBy.name, live_project_id: x.siteId })) };
    }
    case 'get_design_project': need(p.design, 'You have no Design Center access.'); return summary(user, a.project_id);
    case 'get_design_project_file': {
      need(p.design, 'You have no Design Center access.');
      const { project, data } = dc.get(user, a.project_id);
      return { __content: [{ type: 'text', text: `LV Planner project file of “${project.name}” (floor drawings left out; use get_floor_drawing):\n\n` + JSON.stringify(data) }] };
    }
    case 'get_floor_drawing': {
      need(p.design, 'You have no Design Center access.');
      const { project, data } = dc.get(user, a.project_id);
      const fl = data.floors || [], k = String(a.floor || '').trim().toLowerCase();
      const f = fl.find(x => String(x.name || '').toLowerCase() === k) || fl[(parseInt(k, 10) || 0) - 1] || fl.find(x => String(x.name || '').toLowerCase().includes(k));
      if (!f) throw new HttpError(404, 'No such floor. Floors: ' + fl.map(x => x.name).join(', '));
      if (!f.pdfRef || !dc.hasBlob(f.pdfRef)) throw new HttpError(404, 'This floor has no drawing.');
      const buf = fs.readFileSync(dc.blobPath(f.pdfRef));
      if (buf.length > MAX_FILE) return { error: `The drawing is ${Math.round(buf.length / 1048576)} MB — too large to read here (limit 15 MB).` };
      return { __content: [{ type: 'text', text: `Floor drawing: ${project.name} — ${f.name} (PDF, ${Math.round(buf.length / 1024)} KB)` },
        { type: 'resource', resource: { uri: `${config.appUrl}/api/dc/blobs/${f.pdfRef}`, mimeType: 'application/pdf', blob: buf.toString('base64') } }] };
    }
    case 'list_live_projects': {
      const j = p.office ? await bridge.call('/site/list') : await bridge.callAs(user, '/site/me');
      return { count: j.projects.length, projects: j.projects.map(x => ({ id: x.id, name: x.name, state: x.paused ? 'paused' : x.state === 'done' ? 'completed' : 'in progress',
        progress_pct: x.tasks_all ? Math.round(100 * x.tasks_done / x.tasks_all) : 0, points: x.points, points_done: x.installed, open_site_reports: x.open_reports, photos: x.photos,
        asana_next_stage: x.next_stage || null, started: x.started_at ? new Date(x.started_at).toISOString().slice(0, 10) : null })) };
    }
    case 'get_live_project': {
      const d = await bridge.callAs(user, '/site/p/' + encodeURIComponent(String(a.live_project_id || '')));
      const byCat = {};
      for (const pt of d.points) {
        const c = byCat[pt.cat] || (byCat[pt.cat] = { points: 0 });
        c.points++;
        for (const s of pt.steps) c[s] = (c[s] || 0) + (pt[s] ? 1 : 0);
      }
      return { id: d.project.id, name: d.project.name, your_role: d.role, state: d.project.paused ? 'paused' : d.project.status === 'done' ? 'completed' : 'in progress',
        progress_by_kind: byCat, open_site_reports: (d.issues || []).filter(i => i.status === 'open').map(i => ({ kind: i.kind, text: i.text, by: i.by, at: new Date(i.at).toISOString() })),
        cabinets: d.cabinets ? Object.fromEntries(Object.entries(d.cabinets).map(([k, l]) => { const pt = d.points.find(x => x.point_id === k); return [pt ? pt.label : k, { done: l.filter(x => x.done).length, of: l.length, open: l.filter(x => !x.done).map(x => x.name) }]; })) : null,
        recent_activity: (d.activity || []).slice(0, 25).map(x => `${new Date(x.at).toISOString().slice(0, 16)} ${x.by_name}: ${x.action}${x.detail ? ' — ' + x.detail : ''}`) };
    }
    case 'list_notifications': { const l = notify.list(user.id); return { unread: l.unread, items: l.items.filter(x => !a.unread_only || !x.read).map(x => ({ at: x.at, title: x.title, body: x.body, read: x.read })) }; }
    case 'mark_notifications_read': return { unread: notify.markRead(user.id, 'all') };
    case 'add_point_note': {
      const pid = encodeURIComponent(String(a.live_project_id || ''));
      const d = await bridge.callAs(user, '/site/p/' + pid);
      const k = String(a.point || '').trim().toLowerCase();
      const pt = d.points.find(x => String(x.label).toLowerCase() === k) || d.points.find(x => String(x.label).toLowerCase().includes(k));
      if (!pt) throw new HttpError(404, 'No point with that label on this project.');
      await bridge.callAs(user, `/site/p/${pid}/pt/${encodeURIComponent(pt.point_id)}/note`, { method: 'POST', json: { text: String(a.text || '') } });
      setTimeout(() => notify.processSiteLog(), 50);
      return { ok: true, point: pt.label };
    }
  }
}

function rpcResult(idv, result) { return { jsonrpc: '2.0', id: idv, result }; }
function rpcError(idv, code, message) { return { jsonrpc: '2.0', id: idv, error: { code, message } }; }
async function handleOne(user, msg) {
  const { id: idv, method, params } = msg || {};
  if (idv === undefined || idv === null) return null;
  try {
    if (method === 'initialize') {
      const v = VERSIONS.includes(params && params.protocolVersion) ? params.protocolVersion : VERSIONS[0];
      return rpcResult(idv, { protocolVersion: v, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'Express Tech Design Center', title: config.appName, version: require('../package.json').version },
        instructions: `${config.appName}: ${config.company}'s low-voltage design tool (LV Planner) and live installation projects. You are acting as ${user.name} (${P.describe(user.perms)}). ` +
          'To prepare a quote from a design: list_design_projects → get_design_project (counts) or get_design_project_file (full file) → create the estimate with the user\'s Zoho tools/skills. Always confirm with the user before changing anything.' });
    }
    if (method === 'ping') return rpcResult(idv, {});
    if (method === 'tools/list') {
      const list = TOOLS.filter(t => !t.write || writesAllowed()).map(({ name, description, inputSchema, write }) => ({ name, description, inputSchema,
        annotations: { readOnlyHint: !write, destructiveHint: false, openWorldHint: false } }));
      return rpcResult(idv, { tools: list });
    }
    if (method === 'tools/call') {
      try {
        const out = await callTool(user, params && params.name, (params && params.arguments) || {});
        if (out && out.__content) return rpcResult(idv, { content: out.__content });
        return rpcResult(idv, { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out && typeof out === 'object' && !Array.isArray(out) ? out : undefined });
      } catch (e) {
        if (!(e instanceof HttpError)) console.error('[mcp]', e);
        return rpcResult(idv, { isError: true, content: [{ type: 'text', text: e instanceof HttpError ? e.message : 'The Design Center had a problem doing that.' }] });
      }
    }
    if (method === 'resources/list') return rpcResult(idv, { resources: [] });
    if (method === 'prompts/list') return rpcResult(idv, { prompts: [] });
    return rpcError(idv, -32601, `Method not found: ${method}`);
  } catch (e) { return rpcError(idv, -32603, e.message || 'Internal error'); }
}
async function handle(req, res) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id' };
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version' }); return res.end(); }
  const user = oauth.userFromBearer(req);
  if (!user) {
    res.writeHead(401, { ...cors, 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer realm="ExpressTech", resource_metadata="${config.appUrl}/.well-known/oauth-protected-resource"` });
    return res.end(JSON.stringify({ error: 'invalid_token', error_description: 'Connect with your Design Center login.' }));
  }
  if (!oauth.enabled()) return send(res, 403, rpcError(null, -32000, 'Connecting Claude is switched off (Admin → Integrations → Claude).'), cors);
  if (req.method === 'GET') { res.writeHead(405, { ...cors, Allow: 'POST' }); return res.end(); }
  if (req.method === 'DELETE') { res.writeHead(200, cors); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, cors); return res.end(); }
  let body; try { body = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString('utf8')); } catch (e) { return send(res, 400, rpcError(null, -32700, 'Parse error'), cors); }
  const batch = Array.isArray(body);
  const out = (await Promise.all((batch ? body : [body]).map(m => handleOne(user, m)))).filter(Boolean);
  if (!out.length) { res.writeHead(202, cors); return res.end(); }
  send(res, 200, batch ? out : out[0], cors);
}
module.exports = { handle, TOOLS };
