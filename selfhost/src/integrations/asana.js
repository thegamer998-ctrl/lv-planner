'use strict';
// Asana: each live project can be linked to its Asana project (planner → Site, or the site app's Progress tab). The site app
// then shows the stages, ticks them from the points and the cabinet checklist, and a mirror is refreshed every 2 minutes.
// All of that is done by server/worker.js as before; this file holds the token.
const config = require('../config');
const store = require('./store');
const ID = 'asana';

const token = () => (store.enabled(ID) && store.config(ID).token) || '';
const def = {
  id: ID, name: 'Asana', vendor: 'Asana', category: 'Project stages', color: '#f06a6a', initials: 'AS',
  description: 'Live projects linked to their Asana project: the site app shows the stages and ticks them when every point / cabinet step is done (no comments are written on anyone’s behalf).',
  docsUrl: 'https://developers.asana.com/docs/personal-access-token',
  setup: [
    'In Asana open My settings → Apps → Developer apps (app.asana.com/0/my-apps) and create a Personal access token, signed in as the Express Tech account that sees the villa projects.',
    'Paste it below, Save, switch it on and press Test.',
  ],
  fields: [
    { key: 'token', label: 'Personal access token', type: 'secret', required: true },
  ],
  info: () => {
    let linked = 0;
    try { linked = require('../db').db.prepare('SELECT COUNT(*) n FROM projects WHERE asana_gid IS NOT NULL').get().n; } catch (e) {}
    return { linkedProjects: linked, everySeconds: config.asanaCronSeconds };
  },
  configured: () => !!store.config(ID).token,
  async test() {
    const r = await fetch('https://app.asana.com/api/1.0/users/me?opt_fields=name,email,workspaces.name', { headers: { Authorization: 'Bearer ' + store.config(ID).token }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || 'Asana answered ' + r.status);
    return `Connected as ${j.data.name}${j.data.workspaces && j.data.workspaces.length ? ' — ' + j.data.workspaces.map(w => w.name).join(', ') : ''}.`;
  },
  actions: {},
};
function seedFromEnv() {
  if (store.row(ID) || !config.asanaToken) return;
  store.saveConfig(ID, { token: config.asanaToken }, null); store.setEnabled(ID, true, null); store.log(ID, 'info', 'Token imported from the .env file');
}
const workerEnv = () => (token() ? { ASANA_TOKEN: token() } : {});
module.exports = { def, seedFromEnv, workerEnv };
