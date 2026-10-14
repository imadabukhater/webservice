'use strict';
// The forgotten-password way back for the manager: a script run on the server.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const NODE = ['--disable-warning=ExperimentalWarning'];
const run = (file, env, args = []) => spawnSync(process.execPath, [...NODE, path.join(ROOT, file), ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('a forgotten manager password is reset from the server, and the account signed out everywhere', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-admin-'));
  const DB_FILE = path.join(dir, 'agents.db');
  try {
    // A database whose manager signed in on a device, then was switched off by mistake.
    execFileSync(process.execPath, [...NODE, '-e', `
      const { q } = require(${JSON.stringify(path.join(ROOT, 'src/db'))});
      q("INSERT INTO sessions (token_hash, user_id, expires_at) SELECT 'old', id, ? FROM users WHERE role = 'admin'").run(Date.now() + 1e9);
      q("UPDATE users SET active = 0 WHERE role = 'admin'").run();
    `], { env: { ...process.env, DB_FILE, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'forgotten-1' } });

    const unknown = run('scripts/reset-admin.js', { DB_FILE }, ['nobody']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Managers: admin/);
    assert.equal(run('scripts/reset-admin.js', { DB_FILE, NEW_PASSWORD: 'short' }).status, 1, 'too short');

    const r = run('scripts/reset-admin.js', { DB_FILE });
    assert.equal(r.status, 0, r.stderr);
    const password = /New password: (\S+)/.exec(r.stdout)[1];
    assert.ok(password.length >= 12);

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_FILE);
    const admin = db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
    const { verifyPassword } = require('../src/passwords');
    assert.equal(verifyPassword(password, admin.password_hash), true);
    assert.equal(verifyPassword('forgotten-1', admin.password_hash), false);
    assert.equal(admin.active, 1, 'switched back on');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(admin.id).n, 0, 'signed out everywhere');
    db.close();

    // A chosen password, by name.
    const chosen = run('scripts/reset-admin.js', { DB_FILE, NEW_PASSWORD: 'my-new-pass-2026' }, ['ADMIN']);
    assert.equal(chosen.status, 0, chosen.stderr);
    assert.ok(!chosen.stdout.includes('my-new-pass-2026'), 'a chosen password is not printed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
