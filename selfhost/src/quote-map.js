'use strict';
// A quotation (Zoho Books lines) → the device list of a project without a drawing. The same matching as the site app's
// "Fill from the Zoho quotation" (site.html, zohoKind): each line becomes a device type, the cabinet's hardware, or is left
// out (cables, labour, services). Used when LeadzIN starts a project.
const LT = [   // [type, name, category, colour, label]
  ['wifi', 'Access point', 'ap', '#3b82f6', 'AP'], ['outdoorwifi', 'Outdoor access point', 'ap', '#0ea5e9', 'AP'],
  ['cctv', 'Camera — indoor', 'cam', '#ef4444', 'CAM'], ['cctvoutdoor', 'Camera — outdoor', 'cam', '#f97316', 'CAM'],
  ['network', 'Data point', 'data', '#22c55e', 'D'], ['ipphone', 'IP phone', 'phone', '#a855f7', 'PH'],
  ['intercom', 'Intercom — door', 'icom', '#f59e0b', 'IC'], ['intercomscreen', 'Intercom screen', 'icom', '#eab308', 'IS'],
  ['viewport', 'Viewport', 'vp', '#14b8a6', 'VP'], ['tv', 'TV point', 'other', '#a16207', 'TV'], ['speaker', 'Speaker', 'other', '#ec4899', 'SP'],
  ['rack', 'Network cabinet', 'rack', '#475569', 'RACK'], ['other', 'Other device', 'other', '#64748b', 'X'],
];
const KIT = { gw: 'Gateway / UDM', sw: 'Switch', nvr: 'NVR', hdd: 'Hard disk', ups: 'UPS', pp: 'Patch panel', pbx: 'IP PBX', dac: 'DAC cable' };
const LTof = t => LT.find(x => x[0] === t) || LT[LT.length - 1];

function kindOf(l) {
  // The item's name decides first: a description can say "support", "Wi-Fi", "NVR" or "cable" about a device.
  var n = ((l.name || "") + " " + (l.sku || "")).toLowerCase(), s = (n + " " + (l.description || "")).toLowerCase();
  var SERVICE = /labou?r|installation (charge|fee|work)|professional services?|service charge|support|warranty|delivery|configuration|programming|termination|testing/;
  var ACCESSORY = /cable|cat ?[5-8]|fib(er|re)|connector|rj ?45|patch cord|bracket|mount|\bbox\b|trunking|conduit|clip|screw|faceplate|keystone|adapter|injector/;
  function kit(t){
    if (/\budm\b|dream machine|dream router|gateway|firewall|\bucg\b|router/.test(t)) return "kit:gw";
    if (/\bu?nvr\b|recorder/.test(t)) return "kit:nvr";
    if (/\bhdd\b|hard ?dis[kc]|surveillance (disk|drive)/.test(t)) return "kit:hdd";
    if (/switch|\busw\b/.test(t)) return "kit:sw";
    if (/\bups\b/.test(t)) return "kit:ups";
    if (/patch ?panel/.test(t)) return "kit:pp";
    if (/\bpbx\b|yeastar p\d/.test(t)) return "kit:pbx";
    if (/\bdac\b|sfp/.test(t)) return "kit:dac";
    if (/cabinet|\brack\b|\b\d{1,2} ?u\b/.test(t)) return "rack";
    return null;
  }
  function dev(t){
    if (/data point|network point|lan point|data outlet/.test(t)) return "network";
    if (/tv point|satellite|\bcoax/.test(t)) return "tv";
    if (/doorbell|door ?station|intercom|door ?phone/.test(t)) return /screen|monitor|viewer|indoor station|display/.test(s) ? "intercomscreen" : "intercom";
    if (/viewport/.test(t)) return "viewport";
    if (/camera|cctv|\bg[3-6]\b|\bg[3-6][ -]|dome|bullet|turret|\bptz\b|\bai (pro|360|bullet|theta|dome)/.test(t)) return /bullet|turret|ptz|outdoor/.test(s) ? "cctvoutdoor" : "cctv";
    if (/\bu[67]\b|\bu[67][+-]|\bu[67] |access point|\bap\b|\buap\b|wi-?fi|nanohd|\be7\b|in-?wall/.test(t)) return /outdoor|mesh|\bpro max outdoor|ultra/.test(s) ? "outdoorwifi" : "wifi";
    if (/ip ?phone|yealink|fanvil|\bt[3-5]\d[a-z]?\b|desk ?phone|dect|\bgxp/.test(t)) return "ipphone";
    if (/speaker/.test(t)) return "speaker";
    return null;
  }
  if (SERVICE.test(n)) return "";
  var k = (/point|outlet/.test(n) && dev(n)) || kit(n);
  if (k) return k;
  if (ACCESSORY.test(n)) return "";   // a bracket, cable or box for a device is not the device
  return dev(n) || dev(s) || kit(s) || (SERVICE.test(s) || ACCESSORY.test(s) ? "" : "?");
}

const rid = () => 'r' + Math.random().toString(36).slice(2, 8);
// lines → { rows (device lines), kit (cabinet hardware), skipped (not devices), unknown (not recognised — left out) }
function fromLines(lines, area) {
  const rows = [], kit = {}, skipped = [], unknown = [];
  for (const l of lines || []) {
    const q = Math.max(0, Math.round(Number(l.quantity) || 0)), name = String(l.name || '').trim();
    if (!q || !name) continue;
    const k = kindOf(l);
    if (k === '') { skipped.push(name); continue; }
    if (k === '?') { unknown.push(`${q} × ${name}`); continue; }
    if (k.startsWith('kit:')) { kit[k.slice(4)] = (kit[k.slice(4)] || 0) + q; continue; }
    const d = String(l.description || '').split('\n')[0].trim();   // "Network Point" → its description says which one
    rows.push({ id: rid(), type: k, model: (/^(network|data|lan|tv) point$/i.test(name.trim()) && d ? d : name).slice(0, 60), qty: Math.min(200, q), area });
  }
  if (Object.keys(kit).length && !rows.some(r => r.type === 'rack')) rows.push({ id: rid(), type: 'rack', model: '', qty: 1, area });
  return { rows, kit, skipped, unknown };
}

// the body for /site/publish — the same points the site app makes (AP-01, CAM-01…, Cabinet)
function publishBody({ id, name, rows, kit, areas, cabling, from, customer, by, status }) {
  const pts = [], n = {}, racks = [], types = {}, areaName = a => (areas.find(x => x.id === a) || {}).name || '';
  const nrack = rows.filter(r => r.type === 'rack').reduce((a, r) => a + (r.qty || 0), 0);
  LT.forEach(t => { types[t[0]] = t[1]; });
  for (const r of rows) {
    const t = LTof(r.type);
    for (let i = 1; i <= r.qty; i++) {
      n[t[4]] = (n[t[4]] || 0) + 1;
      const pid = `${r.id}-${i}`, label = t[0] === 'rack' ? (nrack > 1 ? `Cabinet ${n[t[4]]}` : 'Cabinet') : `${t[4]}-${String(n[t[4]]).padStart(2, '0')}`;
      pts.push({ id: pid, floorId: r.area, type: r.type, cat: t[2], label, model: r.model || '', color: t[3], x: 0.5, y: 0.5 });
      if (t[0] === 'rack') racks.push({ id: pid, point: pid, name: label, main: !racks.length, floor: areaName(r.area) });
    }
  }
  if (racks.length) racks[0].kit = kit;
  return { id, name, by, status, cabling: !!cabling, points: pts, floors: areas.map(a => ({ id: a.id, name: a.name })),
    meta: { list: { rows, kit, from: from || null }, types, racks, customer: customer || undefined, planner: 'LeadzIN (no drawing)' } };
}

module.exports = { LT, KIT, kindOf, fromLines, publishBody };
