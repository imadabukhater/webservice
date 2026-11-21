'use strict';
// Every supplier's subscribers (src/supsubs.js): read, kept when they disappear, never wiped by an empty answer, and one
// list with ours — each is a line in our system, added and kept in step every hour; the manager only.
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

  const end = Date.now() + 9 * 864e5;
  qlRows = [row('11', '0521000001', { endAt: end }), row('12', '972521000002', { pkgId: '2400', sim: '8997201' }), row('13', '0521000003', { active: false, status: 'فصل نهائي' })];
  let s = await ok(call(admin, 'POST', '/api/supplier-subs/sync', {}));
  assert.deepEqual(s.result, [{ key: 'ql', count: 3, gone: 0 }]);
  assert.equal(s.suppliers.find((x) => x.key === 'ql').count, 3);
  assert.equal(s.rows, undefined, 'the sync answers with the state of the reading only');
  let v = await ok(call(admin, 'GET', '/api/supplier-subs'));
  assert.equal(v.rows.length, 3);
  const first = v.rows.find((r) => r.number === '0521000001');
  assert.equal(first.line.agentName, 'المدير', 'already ours: stays the agent\'s line');
  assert.equal(q("SELECT expires_at FROM lines WHERE number = '0521000001'").get().expires_at, end, 'its end date from the supplier');
  // One list: the supplier's subscriber is ours now, on the shop's account, with its package; a finally cut one is not added.
  const added = q("SELECT * FROM lines WHERE number = '0521000002'").get();
  assert.ok(added, 'a +972 number added in local form');
  assert.equal(added.agent_id, Number(q("SELECT value FROM settings WHERE key = 'shop_agent_id'").get().value), 'on the shop\'s account');
  assert.equal(added.package_id, pkg, 'its package by QuickLine\'s package id');
  assert.equal(added.company_id, co);
  assert.equal(added.status, 'active');
  assert.equal(added.sim, '8997201');
  assert.equal(added.price, 0, 'no sale recorded');
  assert.equal(v.rows.find((r) => r.number === '0521000002').line.agentName, 'متجر الزبائن');
  assert.equal(q("SELECT COUNT(*) AS n FROM lines WHERE number = '0521000003'").get().n, 0, 'cut before we met it');
  assert.equal(q("SELECT COUNT(*) AS n FROM ops WHERE type = 'supplier_sync' AND number = '0521000002'").get().n, 1);
  assert.deepEqual(v.oursOnly.map((l) => l.number), ['0521000099'], 'our active line no supplier lists');
  // Read again: nothing added twice.
  await ok(call(admin, 'POST', '/api/supplier-subs/sync', {}));
  assert.equal(q("SELECT COUNT(*) AS n FROM lines WHERE number = '0521000002'").get().n, 1);

  // Read again without one: kept, marked gone.
  qlRows = [row('11', '0521000001', { active: false, status: 'موقوف' }), row('13', '0521000003', { active: false, status: 'فصل نهائي' }), row('14', '0521000004'), row('15', '0521000005'), row('16', '0521000006'), row('17', '0521000007')];
  await ok(call(admin, 'POST', '/api/supplier-subs/sync', { supplier: 'ql' }));
  v = await ok(call(admin, 'GET', '/api/supplier-subs'));
  const gone = v.rows.find((r) => r.number === '0521000002');
  assert.equal(gone.gone, true);
  assert.equal(gone.active, false);
  assert.equal(v.rows.length, 7);
  assert.equal(q("SELECT status FROM lines WHERE number = '0521000002'").get().status, 'disconnected', 'gone at its supplier: cut here');
  assert.equal(q("SELECT status FROM lines WHERE number = '0521000001'").get().status, 'frozen', 'suspended there: frozen here');
  assert.equal(q("SELECT COUNT(*) AS n FROM lines WHERE number LIKE '052100000_' AND status = 'active'").get().n, 4, 'the new ones added (0004-0007)');
  // A line we are carrying out (pending) is left alone.
  q("UPDATE lines SET status = 'pending' WHERE number = '0521000004'").run();
  qlRows = qlRows.filter((r) => r.ext !== '14');
  await ok(call(admin, 'POST', '/api/supplier-subs/sync', {}));
  assert.equal(q("SELECT status FROM lines WHERE number = '0521000004'").get().status, 'pending');
  // Listed again (a new subscription at the supplier): active again, not cut by the old one.
  qlRows = [...qlRows, row('18', '0521000002')];
  await ok(call(admin, 'POST', '/api/supplier-subs/sync', {}));
  assert.equal(q("SELECT status FROM lines WHERE number = '0521000002' ORDER BY id DESC").get().status, 'active');
  assert.equal(q("SELECT COUNT(*) AS n FROM lines WHERE number = '0521000002'").get().n, 1);

  // An empty answer where there were many: a failure, nothing wiped; the manager told once.
  qlRows = [];
  s = await ok(call(admin, 'POST', '/api/supplier-subs/sync', {}));
  assert.match(s.result[0].error, /فاضية/);
  v = await ok(call(admin, 'GET', '/api/supplier-subs'));
  assert.equal(v.rows.filter((r) => !r.gone).length, 6, 'nothing marked gone');
  qlFail = new Error('QuickLine: تعذّر الاتصال');
  await ok(call(admin, 'POST', '/api/supplier-subs/sync', {}));
  assert.equal(q("SELECT COUNT(*) AS n FROM notifications WHERE title = 'تعذّر تحديث مشتركي QuickLine'").get().n, 1, 'told once until it works again');
  qlFail = null;
  qlRows = [row('11', '0521000001')];
  s = await ok(call(admin, 'POST', '/api/supplier-subs/sync', {}));
  assert.equal(s.suppliers.find((x) => x.key === 'ql').error, '');
  assert.equal((await ok(call(admin, 'GET', '/api/supplier-subs?summary=1'))).suppliers.length, 1, 'the bar: suppliers with an account only');

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
