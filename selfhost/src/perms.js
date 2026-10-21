'use strict';
// What each login may do. Set per person in Admin → Logins & permissions.
//   admin      everything: logins & permissions, integrations, system; sees every Design Center project
//   design     Design Center: the LV Planner — own projects, projects shared with them, Zoho quotes
//   allDesigns sees (and can open) every Design Center project, not only their own and shared ones
//   office     live projects office: Start project / Update site, all live projects, client links, approve site reports, Asana link
//   site       their role in the site app: '' (none), 'tech' (technician), 'engineer' (site engineer), 'manager' (sees all live projects)
const SITE_ROLES = ['', 'tech', 'engineer', 'manager'];
const SITE_ROLE_NAME = { '': 'No site app', tech: 'Technician', engineer: 'Site engineer', manager: 'Site manager' };
const FLAGS = [
  ['design', 'Design Center', 'Open the LV Planner: their own projects and the ones shared with them, PDF reports, Zoho quotes.'],
  ['allDesigns', 'See every Design Center project', 'Not only their own and the ones shared with them.'],
  ['office', 'Live projects office', 'Start projects and Update site, see every live project, client links, approve site reports, link Asana.'],
  ['admin', 'Admin', 'Everything, plus logins & permissions, integrations and the system page.'],
];
const PRESETS = [
  { id: 'admin', label: 'Admin', perms: { admin: true, design: true, allDesigns: true, office: true, site: 'manager' } },
  { id: 'design', label: 'Design Center only (sales)', perms: { design: true, site: '' } },
  { id: 'design_engineer', label: 'Design Center + site engineer', perms: { design: true, site: 'engineer' } },
  { id: 'tech', label: 'Technician', perms: { site: 'tech' } },
  { id: 'engineer', label: 'Site engineer', perms: { site: 'engineer' } },
  { id: 'manager', label: 'Site manager', perms: { site: 'manager' } },
];

function clean(p) {
  p = p && typeof p === 'object' ? p : {};
  const out = { admin: !!p.admin, design: !!p.design, allDesigns: !!p.allDesigns, office: !!p.office, site: SITE_ROLES.includes(p.site) ? p.site : '' };
  if (out.admin) { out.design = true; out.allDesigns = true; out.office = true; }
  return out;
}
function permsOf(row) {
  if (!row) return clean({});
  let p = row.perms;
  if (typeof p === 'string') { try { p = JSON.parse(p || '{}'); } catch (e) { p = {}; } }
  return clean(p);
}
// someone who uses the live-project side at all (the site app): office people and anyone with a site role
const liveAccess = p => !!(p.office || p.site);
// the role their personal record in the site app has (the "staff" table of the live projects)
const staffRole = p => p.site || (p.office ? 'manager' : '');
function describe(p) {
  const bits = [];
  if (p.admin) return 'Admin';
  if (p.design) bits.push('Design Center');
  if (p.office) bits.push('Live projects office');
  if (p.site) bits.push(SITE_ROLE_NAME[p.site]);
  return bits.join(' + ') || 'No access';
}

module.exports = { SITE_ROLES, SITE_ROLE_NAME, FLAGS, PRESETS, clean, permsOf, liveAccess, staffRole, describe };
