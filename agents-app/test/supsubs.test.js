'use strict';
// Every supplier's subscribers in one table for the manager (src/supsubs.js): read, matched with our lines, kept when
// they disappear, never wiped by an empty answer; the manager only.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.WA_AI_DAILY_USD = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { q, setSetting } = require('../src/db');
const subs = require('../src/supsubs');

let base;
let server;
const call = async (token, method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const ok = async (p) => { const r = await p; assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

// QuickLine's list, as the test says it.
let qlRows = [];
let qlFail = null;
subs._setReaders({
  ql: { configured: () => true, read: async () => { if (qlFail) throw qlFail; return qlRows; } },
  ly: { configured: () => false, read: async () => [] },
  tc: { configured: () => false, read: async () => [] },
  ay: { configured: () => false, read: async () => [] },
});
const row = (ext, number, extra = {}) => ({ ext, number, sim: '', company: 'Cellcom', pkg: 'سلكوم 400', status: 'فعال', active: true, endAt: Date.now() + 5 * 864e5, customer: 'زبون', ...extra });

test.before(async () => {
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('the suppliers\' subscribers: read, matched with our lines, gone ones kept, an empty answer not taken; the manager only', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  // Our lines: one QuickLine line listed there, one not listed (ours only).
  const co = q("SELECT id FROM companies WHERE name = 'سلكوم'").get().id;
  const pkg = Number(q("INSERT INTO packages (company_id, name, sort, cost, price, days, art_card_id) VALUES (?, 'سلكوم 400', 1, 50, 60, 30, 'qln:2400:30')").run(co).lastInsertRowid);
  const adminId = q("SELECT id FROM users WHERE role = 'admin'").get().id;
  const t = Date.now();
  const add = (number) => q(`INSERT INTO lines (number, company_id, package_id, package_label, agent_id, months, price, cost, status, activated_at, expires_at, updated_at)
    VALUES (?, ?, ?, 'سلكوم 400', ?, 1, 60, 50, 'active', ?, ?, ?)`).run(number, co, pkg, adminId, t, t + 5 * 864e5, t);
  add('0521000001');
  add('0521000099');

  qlRows = [row('11', '0521000001'), row('12', '972521000002'), row('13', '0521000003', { active: false, status: 'فصل نهائي' })];
  let v = await ok(call(admin, 'POST', '/api/supplier-subs/sync', {}));
  assert.deepEqual(v.result, [{ key: 'ql', count: 3, gone: 0 }]);
  assert.equal(v.rows.length, 3);
  const first = v.rows.find((r) => r.number === '0521000001');
  assert.equal(first.line.agentName, 'المدير', 'matched with our line');
  assert.equal(v.rows.find((r) => r.number === '0521000002').line, null, 'a +972 number in local form; not ours');
  assert.deepEqual(v.oursOnly.map((l) => l.number), ['0521000099'], 'our active line no supplier lists');
  assert.equal(v.suppliers.find((s) => s.key === 'ql').count, 3);

  // Read again without one: kept, marked gone.
  qlRows = [row('11', '0521000001'), row('13', '0521000003', { active: false, status: 'فصل نهائي' }), row('14', '0521000004'), row('15', '0521000005'), row('16', '0521000006'), row('17', '0521000007')];
  v = await ok(call(admin, 'POST', '/api/supplier-subs/sync', { supplier: 'ql' }));
  const gone = v.rows.find((r) => r.number === '0521000002');
  assert.equal(gone.gone, true);
  assert.equal(gone.active, false);
  assert.equal(v.rows.length, 7);

  // An empty answer where there were many: a failure, nothing wiped; the manager told once.
  qlRows = [];
  v = await ok(call(admin, 'POST', '/api/supplier-subs/sync', {}));
  assert.match(v.result[0].error, /فاضية/);
  assert.equal(v.rows.filter((r) => !r.gone).length, 6, 'nothing marked gone');
  qlFail = new Error('QuickLine: تعذّر الاتصال');
  await ok(call(admin, 'POST', '/api/supplier-subs/sync', {}));
  assert.equal(q("SELECT COUNT(*) AS n FROM notifications WHERE title = 'تعذّر تحديث مشتركي QuickLine'").get().n, 1, 'told once until it works again');
  qlFail = null;
  qlRows = [row('11', '0521000001')];
  v = await ok(call(admin, 'POST', '/api/supplier-subs/sync', {}));
  assert.equal(v.suppliers.find((s) => s.key === 'ql').error, '');

  // The manager only.
  await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل', username: 'agent-s', password: 'secret1' }));
  const agent = (await ok(call(null, 'POST', '/api/login', { username: 'agent-s', password: 'secret1' }))).token;
  assert.equal((await call(agent, 'GET', '/api/supplier-subs')).status, 403);
});

test('dates as each supplier writes them', () => {
  assert.equal(new Date(subs.dateOf('22/11/2026')).getDate(), 22);
  assert.equal(new Date(subs.dateOf('30/11/2026 19:52')).getMonth(), 10);
  assert.equal(new Date(subs.dateOf('2026-12-20')).getDate(), 20);
  assert.equal(subs.dateOf(''), null);
  assert.equal(subs.localNumber('+972 52-100-0002'), '0521000002');
});
