'use strict';
// Gives a manager account a new password when it is forgotten, from the server's command line — so only someone who
// can sign in to the server (the Google Cloud account) can do it; the web app offers no such reset.
// The account is also switched back on, and every device signed in to it is signed out.
// NEW_PASSWORD sets the password; without it a strong one is made up and printed. DB_FILE points at the database.
//   sudo -u agents env DB_FILE=/var/lib/agents-app/agents.db node scripts/reset-admin.js [username]
const crypto = require('node:crypto');
const { q, tx } = require('../src/db');
const { hashPassword } = require('../src/passwords');

const admins = q("SELECT id, username, name, active FROM users WHERE role = 'admin' ORDER BY id").all();
const wanted = process.argv[2];
const admin = wanted ? admins.find((a) => a.username.toLowerCase() === wanted.toLowerCase()) : admins.length === 1 ? admins[0] : null;
if (!admin) {
  console.error(wanted ? `No manager named "${wanted}".` : 'More than one manager: name the one to reset.');
  console.error(`Managers: ${admins.map((a) => a.username).join(', ') || '(none)'}`);
  console.error('usage: node scripts/reset-admin.js [username]');
  process.exit(1);
}
const password = process.env.NEW_PASSWORD || crypto.randomBytes(9).toString('base64url');
if (password.length < 8) {
  console.error('NEW_PASSWORD must be at least 8 characters.');
  process.exit(1);
}
tx(() => {
  q('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?').run(hashPassword(password), admin.id);
  q('DELETE FROM sessions WHERE user_id = ?').run(admin.id);
});
console.log(`Manager "${admin.username}" (${admin.name}): new password set${admin.active ? '' : ', account switched back on'}; signed out everywhere.`);
if (!process.env.NEW_PASSWORD) console.log(`New password: ${password}`);
console.log('Sign in with it, then change it under «الحساب» (tap your name).');
