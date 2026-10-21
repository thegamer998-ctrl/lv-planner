'use strict';
// Copy everything from the old ExpressTech server on Cloudflare (the same as Admin → System → Move from Cloudflare):
//   docker compose exec -it designcenter npm run import-cloudflare -- https://expresstech.hussaink-060.workers.dev husain
// The office key of the old server is asked for (it is not shown and not saved). The planner files saved on the old
// server become Design Center projects owned by the given username (an admin). Safe to run again.
const readline = require('node:readline');
const { db } = require('../src/db');
const [url = 'https://expresstech.hussaink-060.workers.dev', owner] = process.argv.slice(2);
function ask(q) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.startsWith(q)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); res(a.trim()); });
  });
}
(async () => {
  const admins = db.prepare('SELECT * FROM users WHERE active=1').all().filter(u => require('../src/perms').permsOf(u).admin);
  const o = owner ? db.prepare('SELECT * FROM users WHERE username=?').get(owner) : admins[0];
  if (!o) { console.error('No admin login yet — start the server once (it makes the first admin), or give an admin username.'); process.exit(1); }
  const key = process.env.OLD_OFFICE_KEY || await ask('Office key of the old server: ');
  const r = await require('../src/importcf').run({ url, key, owner: o.id });
  console.log(JSON.stringify(r, null, 1));
  console.log('Done. If the server is running, restart it so its notifications start from here:  docker compose restart designcenter');
  process.exit(0);
})().catch(e => { console.error('Stopped:', e.message); process.exit(1); });
