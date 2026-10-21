'use strict';
// LeadzIN (Express Tech's lead tracker): when a lead is won, LeadzIN starts the installation project here from the
// approved Zoho quotation — the hardware becomes the device list, the cabinet hardware the cabinet checklist.
// LeadzIN signs its calls with a key made here (Make a new key) and pasted into LeadzIN → Admin → Integrations.
const crypto = require('node:crypto');
const config = require('../config');
const store = require('./store');
const ID = 'leadzin';

const def = {
  id: ID, name: 'LeadzIN', vendor: 'Express Tech', category: 'Leads → projects', color: '#D21E1C', initials: 'LZ',
  description: 'Start the installation project straight from a won lead in LeadzIN: the approved quotation’s hardware becomes the device list (no drawing needed). The office checks it and presses Start installation; LeadzIN shows the progress on the lead.',
  setup: [
    'Press “Make a new key” below and copy the key (it is shown once).',
    'In LeadzIN open Admin → Integrations → Express Tech Design Center, paste the key, keep the address ' + config.appUrl + ', Save, switch it on and press Test.',
    'On a won lead with a Zoho Books quotation, LeadzIN now shows “Start project”.',
  ],
  fields: [
    { key: 'startNow', label: 'Start the installation right away (otherwise it waits for the office to check the devices — recommended)', type: 'checkbox', default: false },
    { key: 'key', label: 'Key LeadzIN signs with', type: 'secret', required: true, help: 'Made with “Make a new key”.' },
  ],
  buttons: [{ action: 'newKey', label: 'Make a new key' }],
  info: () => {
    let n = 0; try { n = require('../db').db.prepare('SELECT COUNT(*) n FROM leadzin_projects').get().n; } catch (e) {}
    return { address: config.appUrl, projectsFromLeadzin: n };
  },
  configured: () => !!store.config(ID).key,
  async test() { return `Ready. LeadzIN can start projects at ${config.appUrl} (${this.info().projectsFromLeadzin} so far).`; },
  actions: {
    async newKey(user) {
      const key = 'lz_' + crypto.randomBytes(24).toString('base64url');
      const c = store.config(ID); c.key = key; store.saveConfig(ID, c, user); store.setEnabled(ID, true, user);
      store.log(ID, 'info', `New key made${user ? ' by ' + user.name : ''} — the old one stops working`);
      return { secret: key, message: 'Copy this key into LeadzIN → Admin → Integrations → Express Tech Design Center. It is shown only now; the old key stopped working.' };
    },
  },
};
// LeadzIN's call: the right key and switched on
function authorized(req) {
  const c = store.config(ID), h = String(req.headers.authorization || '');
  if (!store.enabled(ID) || !c.key || !h.startsWith('Bearer ')) return false;
  const a = Buffer.from(h.slice(7).trim()), b = Buffer.from(c.key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const startNow = () => store.config(ID).startNow === true;
module.exports = { def, authorized, startNow };
