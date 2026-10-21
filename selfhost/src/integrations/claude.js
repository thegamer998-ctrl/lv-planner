'use strict';
// Claude (AI assistant): each person connects their own Claude (desktop app, claude.ai, phone) to the Design Center with
// their own login and permissions. Nothing is configured centrally except on/off and read-only.
const config = require('../config');
const { db, now } = require('../db');

const def = {
  id: 'claude', name: 'Claude (AI assistant)', vendor: 'Anthropic', category: 'AI assistant', color: '#c96442', initials: 'AI',
  description: 'Each person connects their own Claude with their own login: it can read their Design Center projects (points, floors, cabinets, drawings — e.g. to prepare a Zoho quote with their skills), live project progress, site reports and notifications.',
  docsUrl: 'https://support.claude.com/en/articles/11503834',
  setup: [
    'Switch this on (it needs the Design Center on its public https address).',
    'Each person then opens the Design Center → their name → “Connect Claude” and follows the steps (Claude → Settings → Connectors → Add custom connector → paste the address).',
    'They sign in with their own username and password and press Allow. Their Claude can only see and do what that person can.',
  ],
  fields: [
    { key: 'allowWrites', label: 'Claude may also make small changes (add a note to a point, mark notifications read) — not only read', type: 'checkbox', default: false },
  ],
  info: () => ({ mcpUrl: `${config.appUrl}/mcp`, connectedPeople: db.prepare("SELECT COUNT(DISTINCT user_id) n FROM oauth_tokens WHERE kind='refresh' AND expires_at > ?").get(now()).n }),
  configured: () => true,
  async test() {
    if (!config.appUrl.startsWith('https://')) throw new Error(`APP_URL is ${config.appUrl} — Claude can only connect to a public https address.`);
    const n = this.info().connectedPeople;
    return `Ready. Connector address: ${config.appUrl}/mcp · ${n} ${n === 1 ? 'person has' : 'people have'} connected Claude.`;
  },
  actions: {},
};
module.exports = { def };
