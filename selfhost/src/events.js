'use strict';
// Live updates: every open page keeps one Server-Sent Events stream; changes are pushed to the people who may see them.
const clients = new Set();

function subscribe(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 4000\n\n');
  const c = { res, user };
  clients.add(c);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(c); });
}

// event: {type, ...}; to(userId) decides who gets it (default: everyone signed in)
function publish(event, to) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) {
    if (to && !to(c.user)) continue;
    try { c.res.write(data); } catch (e) {}
  }
}
const toUsers = ids => { const s = new Set(ids); return u => s.has(u.id); };

// Sign a user out everywhere (e.g. deactivated): close their streams.
function kick(userId) { for (const c of clients) if (c.user.id === userId) { try { c.res.end(); } catch (e) {} clients.delete(c); } }
const count = () => clients.size;
const online = () => new Set([...clients].map(c => c.user.id));

module.exports = { subscribe, publish, toUsers, kick, count, online };
