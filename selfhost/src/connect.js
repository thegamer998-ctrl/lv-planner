'use strict';
// LeadzIN → Design Center. LeadzIN calls these with its key (Admin → Integrations → LeadzIN):
//   GET  /api/connect/leadzin/ping                      is the key right?
//   POST /api/connect/leadzin/projects                  start the project of a won lead from its quotation
//        { lead:{ id, name, company, phone, email, area }, estimate:{ id, number, date, status, lines:[{ name, sku, description, quantity }] },
//          startNow, by }
//   GET  /api/connect/leadzin/projects/<lead id>        the project's progress (shown on the lead)
// One project per lead. The quotation's hardware becomes the device list of a project without a drawing (src/quote-map.js);
// the office checks it in the site app (Edit devices) and presses Start installation — unless LeadzIN starts it right away.
const config = require('./config');
const { db, now } = require('./db');
const { HttpError, send, readJson } = require('./http');
const bridge = require('./worker-bridge');
const notify = require('./notify');
const qm = require('./quote-map');
const { leadzin } = require('./integrations');

const link = id => `${config.appUrl}/app/site.html#p=${id}`;
async function status(pid) {
  const j = await bridge.call('/site/list');
  const p = j.projects.find(x => x.id === pid);
  if (!p) return null;
  return { id: p.id, name: p.name, state: p.state, paused: !!p.paused, pct: p.tasks_all ? Math.round(100 * p.tasks_done / p.tasks_all) : 0,
    points: p.points, done: p.installed, openReports: p.open_reports || 0, startedAt: p.started_at, completedAt: p.completed_at,
    url: link(p.id), clientUrl: `${config.appUrl}/#${p.id}-${p.view_key}` };
}
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

async function start(b) {
  const lead = b.lead || {}, est = b.estimate || {};
  const leadId = str(lead.id, 60);
  if (!leadId) throw new HttpError(400, 'The lead is missing.');
  const had = db.prepare('SELECT * FROM leadzin_projects WHERE lead_id=?').get(leadId);
  if (had) {
    const s = await status(had.project_id);
    if (s) return { project: s, existing: true };
    db.prepare('DELETE FROM leadzin_projects WHERE lead_id=?').run(leadId);   // deleted in the meantime: start again
  }
  if (!Array.isArray(est.lines) || !est.lines.length) throw new HttpError(400, 'The quotation has no lines.');
  const areas = [{ id: 'a1', name: 'Villa' }];
  const m = qm.fromLines(est.lines, 'a1');
  if (!m.rows.length) throw new HttpError(400, `No devices found in quotation ${str(est.number, 40)} — only cables, labour or services. Start the project in the Design Center instead (site app → New project without drawing).`);
  const name = str(lead.company, 80) || str(lead.name, 80) || 'Project from LeadzIN';
  const go = b.startNow === true || leadzin.startNow();
  const by = (str(b.by, 40) || 'LeadzIN').slice(0, 30) + ' (LeadzIN)';
  const body = qm.publishBody({ name, rows: m.rows, kit: m.kit, areas, cabling: false, by, status: go ? undefined : 'survey',
    from: { id: str(est.id, 40), number: str(est.number, 40), date: str(est.date, 20), status: str(est.status, 20), source: 'LeadzIN', leadId },
    customer: { name: str(lead.name, 80), company: str(lead.company, 80), phone: str(lead.phone, 40), email: str(lead.email, 120), area: str(lead.area, 80) } });
  const r = await bridge.call('/site/publish', { method: 'POST', json: body });
  db.prepare('INSERT OR REPLACE INTO leadzin_projects(lead_id,project_id,estimate_id,estimate_number,lead_name,by_name,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(leadId, r.id, str(est.id, 40), str(est.number, 40), name, by, now());
  const n = body.points.length;
  for (const uid of notify.officeIds())
    notify.send(uid, { kind: 'project', title: `New project from LeadzIN: ${name}`, body: `${n} device${n === 1 ? '' : 's'} from quotation ${str(est.number, 40)}` +
      (go ? ' — the installation has started.' : ' — check the devices (Edit devices), then press Start installation.') + (m.unknown.length ? ` Not recognised: ${m.unknown.join(', ')}.` : ''), url: link(r.id), ref: r.id, byName: by });
  setTimeout(() => notify.processSiteLog(), 50);
  return { project: await status(r.id), devices: n, skipped: m.skipped, unknown: m.unknown, started: go };
}

async function handle(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '');
  if (!p.startsWith('/api/connect/leadzin')) throw new HttpError(404, 'Not found');
  if (!leadzin.authorized(req)) return send(res, 401, { error: 'The Design Center did not accept the key. Make a new key in Design Center → Admin → Integrations → LeadzIN and paste it into LeadzIN.' });
  if (p === '/api/connect/leadzin/ping' && req.method === 'GET') return send(res, 200, { ok: true, name: config.appName, address: config.appUrl });
  if (p === '/api/connect/leadzin/projects' && req.method === 'POST') return send(res, 200, await start(await readJson(req, 4 * 1024 * 1024)));
  const m = p.match(/^\/api\/connect\/leadzin\/projects\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const row = db.prepare('SELECT * FROM leadzin_projects WHERE lead_id=?').get(decodeURIComponent(m[1]));
    return send(res, 200, { project: row ? await status(row.project_id) : null });
  }
  throw new HttpError(404, 'Not found');
}

module.exports = { handle, start };
