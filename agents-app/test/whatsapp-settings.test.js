'use strict';
// The owner's command on the server: the only way to change the WhatsApp agent's settings and the daily limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-settings-'));
const env = { ...process.env, DB_FILE: path.join(dir, 'agents.db'), ADMIN_PASSWORD: 'admin-pass' };
const run = (args, input) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'whatsapp-settings.js'), ...args],
  { env, input, encoding: 'utf8' });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the owner changes the limit, the service and the key on the server; the key never shows', () => {
  let r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /حد الصرف اليومي:\s+\$0\.5/, 'half a dollar a day by default');
  assert.match(r.stdout, /المفتاح:\s+لا يوجد/);
  r = run(['limit', '0.25']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\$0\.25/);
  assert.equal(run(['limit', '-3']).status, 1, 'a negative limit is refused');
  assert.equal(run(['provider', 'openai']).status, 1, 'only the known services');
  assert.equal(run(['provider', 'groq']).status, 0);
  // The key from the keyboard (here: piped), never on the command line; shown only by its last four characters.
  r = run(['key'], 'gsk_secretkey1234567890WXYZ\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes('gsk_secretkey'), false);
  assert.match(r.stdout, /…WXYZ/);
  r = run(['admins', '0599000111,0599000222']);
  assert.match(r.stdout, /972599000111|970599000111|0599000111/);
  assert.equal(run(['replies', 'maybe']).status, 1);
  r = run(['replies', 'off']);
  assert.match(r.stdout, /الرد على الرسائل:\s+off/);
  // What it saved is what the app reads.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(env.DB_FILE, { readOnly: true });
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  assert.deepEqual([get('wa_ai_daily_usd'), get('wa_ai_provider'), get('wa_ai_key'), get('wa_enabled')], ['0.25', 'groq', 'gsk_secretkey1234567890WXYZ', '0']);
  db.close();
});
