'use strict';
// Manage logins from the server's command line (when nobody can sign in as admin, or for scripting).
//   docker compose exec designcenter npm run user -- list
//   docker compose exec designcenter npm run user -- add "Tahir Ahmed" tahir --design
//   docker compose exec designcenter npm run user -- add "Kutbuddin" kutub --tech
//   docker compose exec designcenter npm run user -- add "Aziz" aziz --admin
//   docker compose exec designcenter npm run user -- reset husain
//   docker compose exec designcenter npm run user -- reset-2fa husain      (lost phone: set two-step sign-in up again)
//   docker compose exec designcenter npm run user -- perms idris --design --engineer
//   docker compose exec designcenter npm run user -- deactivate kutub      |   activate kutub
// Access flags: --admin  --design  --all-designs  --office  --tech | --engineer | --manager
// Prints a temporary password; the person chooses their own at the first sign-in.
const { db } = require('../src/db');
const auth = require('../src/auth');
const P = require('../src/perms');

const [cmd, ...args] = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--')), words = args.filter(a => !a.startsWith('--'));
const fail = m => { console.error(m); process.exit(1); };
const byName = u => db.prepare('SELECT * FROM users WHERE username = ?').get(String(u || '').trim());
function permsFrom(f) {
  const p = { admin: f.includes('--admin'), design: f.includes('--design'), allDesigns: f.includes('--all-designs'), office: f.includes('--office'),
    site: f.includes('--manager') ? 'manager' : f.includes('--engineer') ? 'engineer' : f.includes('--tech') ? 'tech' : '' };
  if (p.admin && !p.site) p.site = 'manager';
  return P.clean(p);
}
// the person's record in the site app follows the login (needs the live-project tables, made when the server first starts)
// signed out everywhere, Claude disconnected
function cutOff(uid) { db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid); db.prepare('DELETE FROM oauth_tokens WHERE user_id=?').run(uid); db.prepare('DELETE FROM oauth_codes WHERE user_id=?').run(uid); }
function sync(uid) { try { require('../src/worker-bridge').syncStaff(uid); } catch (e) { /* the server does it at its next start */ } }

try {
  if (cmd === 'list' || !cmd) {
    const rows = db.prepare('SELECT * FROM users ORDER BY name').all();
    if (!rows.length) console.log('No logins yet. Add the first admin:  npm run user -- add "Your Name" yourname --admin');
    rows.forEach(u => console.log(`${u.active ? ' ' : 'x'} ${u.name.padEnd(22)} ${u.username.padEnd(16)} ${P.describe(P.permsOf(u)).padEnd(40)} ${u.totp_enabled ? 'two-step on ' : '            '} last sign-in: ${u.last_login_at || 'never'}`));
  } else if (cmd === 'add') {
    const [name, username] = words;
    if (!name || !username) fail('Usage: npm run user -- add "Full Name" username [--admin|--design|--office|--tech|--engineer|--manager]');
    const pw = auth.tempPassword();
    const uid = auth.createUser({ name, username, perms: permsFrom(flags), password: pw, mustChange: true });
    sync(uid);
    console.log(`Added ${name} (${username}) — ${P.describe(permsFrom(flags))}.\nTemporary password: ${pw}\n(They choose their own password at the first sign-in.)`);
  } else if (cmd === 'reset') {
    const u = byName(words[0]); if (!u) fail('No login with that username.');
    const pw = auth.tempPassword();
    db.prepare('UPDATE users SET password_hash=?, must_change_password=1, active=1 WHERE id=?').run(auth.hashPassword(pw), u.id);
    cutOff(u.id);
    console.log(`New temporary password for ${u.username}: ${pw}${u.totp_enabled ? '\n(Two-step sign-in stays on. Lost phone too? Also run: npm run user -- reset-2fa ' + u.username + ')' : ''}`);
  } else if (cmd === 'reset-2fa') {
    const u = byName(words[0]); if (!u) fail('No login with that username.');
    db.prepare('UPDATE users SET totp_secret=NULL, totp_pending=NULL, totp_enabled=0, totp_last_step=0 WHERE id=?').run(u.id);
    cutOff(u.id);
    console.log(`Two-step sign-in reset for ${u.username}.${P.permsOf(u).admin ? ' They set it up again at their next sign-in.' : ''}`);
  } else if (cmd === 'perms') {
    const u = byName(words[0]); if (!u) fail('No login with that username.');
    db.prepare('UPDATE users SET perms=? WHERE id=?').run(JSON.stringify(permsFrom(flags)), u.id); sync(u.id);
    console.log(`${u.username}: ${P.describe(permsFrom(flags))}`);
  } else if (cmd === 'deactivate' || cmd === 'activate') {
    const u = byName(words[0]); if (!u) fail('No login with that username.');
    db.prepare('UPDATE users SET active=? WHERE id=?').run(cmd === 'activate' ? 1 : 0, u.id);
    if (cmd === 'deactivate') cutOff(u.id);
    sync(u.id);
    console.log(`${u.username} ${cmd}d.`);
  } else fail('Unknown command. Use: list | add | reset | reset-2fa | perms | activate | deactivate');
} catch (e) { fail(e.message); }
