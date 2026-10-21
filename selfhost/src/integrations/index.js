'use strict';
// Integration hub: the list in Admin → Integrations, saving settings, testing, and the secrets the live-project server needs.
const { HttpError } = require('../http');
const events = require('../events');
const store = require('./store');
const zoho = require('./zoho');
const asana = require('./asana');
const claude = require('./claude');

const PROVIDERS = [asana.def, zoho.def, claude.def];
const byId = id => { const p = PROVIDERS.find(x => x.id === id); if (!p) throw new HttpError(404, 'Unknown integration.'); return p; };

function describe(p) {
  const r = store.row(p.id) || {};
  const cfg = store.config(p.id);
  const values = {}, secretsSet = {};
  for (const f of p.fields) {
    if (f.type === 'secret') secretsSet[f.key] = !!cfg[f.key];
    else values[f.key] = cfg[f.key] !== undefined ? cfg[f.key] : f.default;
  }
  const configured = p.configured();
  return {
    id: p.id, name: p.name, vendor: p.vendor, category: p.category, color: p.color, initials: p.initials, description: p.description, docsUrl: p.docsUrl || '',
    setup: p.setup || [], fields: p.fields, oauth: !!p.oauth, actions: Object.keys(p.actions || {}),
    enabled: !!r.enabled, configured, status: !r.enabled ? (configured ? 'off' : 'not_set_up') : r.status === 'error' ? 'error' : 'connected',
    lastError: r.last_error || '', lastOkAt: r.last_ok_at || null, updatedAt: r.updated_at || null,
    info: p.info ? p.info() : null, values, secretsSet, log: store.recent(p.id, 15),
  };
}
const list = () => PROVIDERS.map(describe);

// Secret fields: empty = keep the saved value, null = clear it.
function save(id, body, user) {
  const p = byId(id);
  const cfg = store.config(id);
  if (body.config) {
    for (const f of p.fields) {
      if (!(f.key in body.config)) continue;
      let v = body.config[f.key];
      if (f.type === 'secret') { if (v === null) delete cfg[f.key]; else if (typeof v === 'string' && v.trim()) cfg[f.key] = v.trim(); continue; }
      if (f.type === 'checkbox') v = !!v;
      else v = String(v ?? '').trim().slice(0, 500);
      if (f.type === 'select' && f.options && v && !f.options.some(o => o[0] === v)) continue;
      cfg[f.key] = v;
    }
    store.saveConfig(id, cfg, user);
    store.log(id, 'info', `Settings saved by ${user.name}`);
  }
  if (body.enabled !== undefined) {
    if (body.enabled && !p.configured()) throw new HttpError(400, 'Fill in the required settings first' + (p.oauth ? ' and press “Connect”.' : '.'));
    store.setEnabled(id, !!body.enabled, user);
    store.log(id, 'info', `${body.enabled ? 'Switched on' : 'Switched off'} by ${user.name}`);
    if (!body.enabled) store.setStatus(id, true);
  }
  events.publish({ type: 'config' });
  return describe(p);
}
async function test(id) {
  const p = byId(id);
  if (!p.configured()) throw new HttpError(400, 'Fill in the required settings first.');
  try { const msg = await p.test(); store.setStatus(id, true); store.log(id, 'info', 'Test: ' + msg); return msg; }
  catch (e) { store.setStatus(id, false, e.message); store.log(id, 'error', 'Test failed: ' + e.message); throw new HttpError(400, e.message); }
}
async function action(id, name) {
  const p = byId(id), fn = p.actions && p.actions[name];
  if (!fn) throw new HttpError(404, 'Unknown action.');
  try { return await fn(); } catch (e) { throw new HttpError(400, e.message); }
}
function disconnect(id, user) { byId(id); store.reset(id, user); if (id === 'claude') require('../oauth').disconnectAll(); store.log(id, 'info', `Disconnected by ${user.name}`); events.publish({ type: 'config' }); }

function init() { zoho.seedFromEnv(); asana.seedFromEnv(); }
const workerEnv = () => ({ ...asana.workerEnv(), ...zoho.workerEnv() });
const status = () => ({ asana: !!asana.workerEnv().ASANA_TOKEN, zoho: zoho.settings().enabled, claude: store.enabled('claude') });

module.exports = { list, save, test, action, disconnect, init, workerEnv, status, zoho, store };
