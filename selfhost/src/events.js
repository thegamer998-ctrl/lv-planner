'use strict';
// Live updates: every open page keeps one Server-Sent Events stream; changes are pushed to the people who may see them.
// Each stream reads its person's session and permissions again (refresh) before every event and every ping, so signing
// out, an expired session, deactivation, a password reset or a permission change takes effect on open screens at once.
const clients = new Set();

function drop(c) { clearInterval(c.ping); clients.delete(c); try { c.res.end(); } catch (e) {} }
function current(c) {
  let u = null; try { u = c.refresh(); } catch (e) {}
  if (!u) { drop(c); return null; }
  c.user = u;
  return u;
}

function subscribe(req, res, user, refresh) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 4000\n\n');
  const c = { res, user, refresh: refresh || (() => user) };
  clients.add(c);
  c.ping = setInterval(() => { if (current(c)) { try { res.write(': ping\n\n'); } catch (e) {} } }, 25000);
  req.on('close', () => { clearInterval(c.ping); clients.delete(c); });
}

// event: {type, ...}; to(user) decides who gets it (default: everyone signed in)
function publish(event, to) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of [...clients]) {
    const u = current(c);
    if (!u) continue;
    if (to && !to(u)) continue;
    try { c.res.write(data); } catch (e) {}
  }
}
const toUsers = ids => { const s = new Set(ids); return u => s.has(u.id); };

// Sign a user out everywhere (e.g. deactivated): close their streams.
function kick(userId) { for (const c of [...clients]) if (c.user.id === userId) drop(c); }
// Someone's permissions changed: check their open streams again now.
function recheck(userId) { for (const c of [...clients]) if (!userId || c.user.id === userId) current(c); }
const count = () => clients.size;
const online = () => new Set([...clients].map(c => c.user.id));

module.exports = { subscribe, publish, toUsers, kick, recheck, count, online };
