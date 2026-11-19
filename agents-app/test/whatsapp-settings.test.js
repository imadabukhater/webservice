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

test('the owner changes the model and who it answers, on the server; Google Cloud only, no key', () => {
  let r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /حد الصرف اليومي:\s+\$0\.5/, 'half a dollar a day by default');
  assert.match(r.stdout, /Google Cloud \(Vertex AI\) — بلا مفتاح/);
  r = run(['limit', '0.25']);
  assert.equal(r.status, 1, 'the daily limit is fixed');
  assert.match(r.stderr, /ثابت/);
  assert.equal(run(['provider', 'groq']).status, 1, 'no other service');
  assert.equal(run(['key']).status, 1, 'no key');
  assert.equal(run(['model', 'gpt-4o']).status, 1, 'Gemini models only');
  r = run(['model', 'gemini-3.5-flash-lite']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gemini-3\.5-flash-lite/);
  r = run(['admins', '0599000111,0599000222']);
  assert.match(r.stdout, /972599000111|970599000111|0599000111/);
  assert.equal(run(['replies', 'maybe']).status, 1);
  r = run(['replies', 'off']);
  assert.match(r.stdout, /الرد على الرسائل:\s+off/);
  // What it saved is what the app reads.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(env.DB_FILE, { readOnly: true });
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  assert.deepEqual([get('wa_ai_daily_usd'), get('wa_ai_model'), get('wa_ai_key'), get('wa_enabled')], [undefined, 'gemini-3.5-flash-lite', undefined, '0']);
  db.close();
});
