'use strict';
// Zoho Books: the planner's "Quote" button makes a Draft estimate in Zoho Books (the customer is found or created, the
// lines come from the design). The estimate itself is made by server/worker.js as before; this file holds the connection.
const crypto = require('node:crypto');
const config = require('../config');
const { HttpError } = require('../http');
const store = require('./store');

const ID = 'zoho_books';
const SCOPES = 'ZohoBooks.contacts.READ,ZohoBooks.contacts.CREATE,ZohoBooks.estimates.READ,ZohoBooks.estimates.CREATE,ZohoBooks.settings.READ';
const DCS = [['com', 'zoho.com — global / US (books.zoho.com)'], ['eu', 'zoho.eu — Europe'], ['in', 'zoho.in — India'], ['com.au', 'zoho.com.au — Australia'], ['jp', 'zoho.jp — Japan'], ['ca', 'zohocloud.ca — Canada'], ['sa', 'zoho.sa — Saudi Arabia']];
const redirectUri = () => `${config.appUrl}/api/integrations/${ID}/callback`;

function settings() {
  const c = store.config(ID), dc = c.dc || 'com';
  const Z = { dc, orgId: c.orgId || '', clientId: c.clientId || '', clientSecret: c.clientSecret || '', refreshToken: c.refreshToken || '',
    templateId: c.templateId || '', salesperson: c.salesperson || '' };
  Z.configured = !!(Z.clientId && Z.clientSecret && Z.refreshToken && Z.orgId);
  Z.enabled = Z.configured && store.enabled(ID);
  Z.accounts = process.env.ZOHO_ACCOUNTS_URL || (dc === 'ca' ? 'https://accounts.zohocloud.ca' : `https://accounts.zoho.${dc}`);
  Z.api = process.env.ZOHO_API_URL || `https://www.zohoapis.${dc}/books/v3`;
  return Z;
}
async function accessToken() {
  const Z = settings();
  const qs = new URLSearchParams({ refresh_token: Z.refreshToken, client_id: Z.clientId, client_secret: Z.clientSecret, grant_type: 'refresh_token' });
  const r = await fetch(`${Z.accounts}/oauth/v2/token?${qs}`, { method: 'POST', signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Zoho sign-in failed (${j.error || r.status}). Press “Connect with Zoho” again.`);
  return j.access_token;
}
async function api(p, opts = {}) {
  const Z = settings(), t = await accessToken();
  const qs = new URLSearchParams(opts.noOrg ? {} : { organization_id: Z.orgId });
  const r = await fetch(`${Z.api}${p}${p.includes('?') ? '&' : '?'}${qs}`, { headers: { Authorization: `Zoho-oauthtoken ${t}` }, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) throw new Error(j.message || `Zoho error ${j.code || r.status}`);
  return j;
}

const def = {
  id: ID, name: 'Zoho Books', vendor: 'Zoho', category: 'Quotations', color: '#e42527', initials: 'ZB',
  description: 'The planner’s Quote button makes a Draft estimate in Zoho Books straight from the design: the customer is found (or created), hardware, cabling and termination lines with the Express Tech terms.',
  docsUrl: 'https://www.zoho.com/books/api/v3/introduction/',
  oauth: true,
  setup: [
    'Open the Zoho API Console (api-console.zoho.com) signed in as a Zoho Books admin. You can reuse the LeadzIN client: open it and add the Redirect URI below, or make a new “Server-based Application”.',
    'Homepage URL: this address. Authorized Redirect URI: copy it from below.',
    'Paste the Client ID and Client Secret here, choose the data centre, Save, then press “Connect with Zoho” and approve.',
  ],
  fields: [
    { key: 'dc', label: 'Zoho data centre', type: 'select', options: DCS, default: 'com' },
    { key: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: '1000.XXXXXXXXXXXX' },
    { key: 'clientSecret', label: 'Client Secret', type: 'secret', required: true },
    { key: 'orgId', label: 'Zoho Books organization', type: 'select', optionsAction: 'organizations', help: 'Filled in automatically after “Connect with Zoho”.' },
    { key: 'templateId', label: 'Estimate template', type: 'select', optionsAction: 'templates', help: 'Optional — the PDF layout of the estimate.' },
    { key: 'salesperson', label: 'Salesperson on the estimate', type: 'text', placeholder: 'e.g. Husain Kazi', help: 'Optional.' },
    { key: 'refreshToken', label: 'Refresh token (advanced)', type: 'secret', advanced: true, help: 'Set automatically by “Connect with Zoho”. Only paste one here if you generated it yourself with a Self Client.' },
  ],
  info: () => ({ redirectUri: redirectUri(), connectedTo: settings().orgId || null }),
  configured: () => settings().configured,
  async test() {
    const o = await api('/organizations', { noOrg: true });
    const org = (o.organizations || []).find(x => String(x.organization_id) === settings().orgId);
    if (!org) throw new Error('Signed in to Zoho, but the organization ' + settings().orgId + ' is not in this account.');
    return `Connected to Zoho Books — ${org.name} (organization ${org.organization_id}).`;
  },
  actions: {
    async organizations() {
      const o = await api('/organizations', { noOrg: true });
      return (o.organizations || []).map(x => ({ value: String(x.organization_id), label: `${x.name} (${x.organization_id})${x.is_default_org ? ' — default' : ''}` }));
    },
    async templates() {
      const o = await api('/estimates/templates');
      return [{ value: '', label: 'Zoho’s default' }].concat((o.templates || []).map(x => ({ value: String(x.template_id), label: x.template_name })));
    },
  },
};

// "Connect with Zoho": the admin approves in Zoho; Zoho sends them back with a code that is swapped for a refresh token.
const pending = new Map();
function authorizeUrl(user) {
  const c = store.config(ID);
  if (!c.clientId || !c.clientSecret) throw new HttpError(400, 'Save the Client ID and Client Secret first.');
  const st = crypto.randomBytes(16).toString('hex');
  pending.set(st, { user: user.id, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60e3) pending.delete(k);
  const qs = new URLSearchParams({ scope: SCOPES, client_id: c.clientId, response_type: 'code', access_type: 'offline', prompt: 'consent', redirect_uri: redirectUri(), state: st });
  return `${settings().accounts}/oauth/v2/auth?${qs}`;
}
async function callback(user, q) {
  const st = q.get('state'), code = q.get('code');
  const p = pending.get(st || '');
  if (!p || p.user !== user.id) throw new HttpError(400, 'This Zoho sign-in link has expired. Press “Connect with Zoho” again.');
  pending.delete(st);
  if (q.get('error')) throw new HttpError(400, 'Zoho said: ' + q.get('error'));
  if (!code) throw new HttpError(400, 'Zoho did not send an authorization code.');
  const c = store.config(ID);
  let accounts = settings().accounts;
  const m = String(q.get('accounts-server') || '').match(/^https:\/\/accounts\.zoho(?:cloud)?\.([a-z.]+)$/);
  if (m && !process.env.ZOHO_ACCOUNTS_URL) { accounts = q.get('accounts-server'); c.dc = m[1]; }
  const qs = new URLSearchParams({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
  const r = await fetch(`${accounts}/oauth/v2/token?${qs}`, { method: 'POST', signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!j.refresh_token) throw new HttpError(400, `Zoho did not return a refresh token (${j.error || r.status}). Check the Client ID, Secret and Redirect URI, then try again.`);
  c.refreshToken = j.refresh_token;
  store.saveConfig(ID, c, user);
  try {
    const o = await fetch(`${settings().api}/organizations`, { headers: { Authorization: `Zoho-oauthtoken ${j.access_token}` }, signal: AbortSignal.timeout(15000) }).then(x => x.json());
    const orgs = o.organizations || [];
    if (!c.orgId || !orgs.some(x => String(x.organization_id) === c.orgId)) {
      const pick = orgs.find(x => x.is_default_org) || orgs[0];
      if (pick) { c.orgId = String(pick.organization_id); store.saveConfig(ID, c, user); }
    }
  } catch (e) {}
  store.setEnabled(ID, true, user);
  store.setStatus(ID, true);
  store.log(ID, 'info', `Connected by ${user.name}${c.orgId ? ' — organization ' + c.orgId : ''}`);
}

function seedFromEnv() {
  const e = config.zoho;
  if (store.row(ID) || !(e.clientId || e.refreshToken)) return;
  store.saveConfig(ID, { dc: e.dc, orgId: e.orgId, clientId: e.clientId, clientSecret: e.clientSecret, refreshToken: e.refreshToken, templateId: e.templateId, salesperson: e.salesperson }, null);
  store.setEnabled(ID, !!(e.clientId && e.clientSecret && e.refreshToken && e.orgId), null);
  store.log(ID, 'info', 'Settings imported from the .env file');
}

// What server/worker.js reads from its environment for the estimate.
function workerEnv() {
  const Z = settings();
  if (!Z.enabled) return {};
  return { ZOHO_DC: Z.dc, ORG_ID: Z.orgId, ZOHO_CLIENT_ID: Z.clientId, ZOHO_CLIENT_SECRET: Z.clientSecret, ZOHO_REFRESH_TOKEN: Z.refreshToken,
    TEMPLATE_ID: Z.templateId || undefined, SALESPERSON: Z.salesperson || undefined };
}

module.exports = { def, authorizeUrl, callback, seedFromEnv, workerEnv, settings };
