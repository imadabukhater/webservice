'use strict';
// One-time fixes that run when an existing database is opened by a newer version.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'src/db');
const node = (code, env) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('QuickLine packages a sync hid before gone_at existed are marked once, so the next sync brings them back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-'));
  const DB_FILE = path.join(dir, 'agents.db');
  try {
    // A database from before the fix: QuickLine packages switched off by a sync, others untouched.
    node(`
      const { q } = require(${JSON.stringify(DB)});
      const co = q("SELECT id FROM companies LIMIT 1").get().id;
      const add = (ref, active) => q("INSERT INTO packages (company_id, name, cost, price, active, art_card_id, kind) VALUES (?, ?, 10, 12, ?, ?, 'card')").run(co, ref, active, ref);
      add('ql:1:30', 0); add('qln:2:30', 0); add('ql:3:30', 1); add('ic:9', 0);
      q("UPDATE packages SET gone_at = NULL").run();
      q("DELETE FROM settings WHERE key = 'migr_ql_gone'").run();
    `, { DB_FILE, ADMIN_PASSWORD: 'x12345678' });

    const read = () => JSON.parse(node(`
      const { q } = require(${JSON.stringify(DB)});
      console.log(JSON.stringify(q("SELECT art_card_id AS ref, active, gone_at IS NOT NULL AS gone FROM packages WHERE art_card_id != '' ORDER BY id").all()));
    `, { DB_FILE }));

    const first = read();
    assert.deepEqual(first.map((r) => [r.ref, r.active, r.gone]), [['ql:1:30', 0, 1], ['qln:2:30', 0, 1], ['ql:3:30', 1, 0], ['ic:9', 0, 0]],
      'only hidden QuickLine packages are marked; visible ones and art-topup are untouched');

    // Once only: a package hidden afterwards (by the manager) is not marked by a later start.
    node(`const { q } = require(${JSON.stringify(DB)}); q("UPDATE packages SET active = 0 WHERE art_card_id = 'ql:3:30'").run();`, { DB_FILE });
    assert.equal(read().find((r) => r.ref === 'ql:3:30').gone, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
