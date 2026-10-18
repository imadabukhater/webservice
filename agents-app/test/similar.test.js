'use strict';
// The same new line from two suppliers: the manager is told which is cheaper.
const test = require('node:test');
const assert = require('node:assert/strict');

let base;
let server;
const call = async (token, method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const ok = async (p) => { const r = await p; assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

test.before(async () => {
  process.env.DB_FILE = ':memory:';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('the same new line from art-topup and QuickLine: the cheaper one is pointed out, and kept for agents on request', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  const { q } = require('../src/db');
  const co = q("SELECT id FROM companies WHERE name = 'سلكوم'").get().id;
  const add = (ref, cost, gb, days, kind = 'invoice', active = 1) => Number(q(`INSERT INTO packages (company_id, name, cost, price, active, data_gb, days, art_card_id, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(co, `رزمة ${ref}`, cost, cost + 10, active, gb, days, ref, kind).lastInsertRowid);
  const art = add('inv:x:1', 42, 400, 30);
  const ql = add('qln:2539:30', 50, 400, 30);
  add('qln:2600:30', 40, 300, 30); // other data: no match
  add('ic:1', 30, 400, 30, 'card'); add('ql:2539:30', 20, 400, 30, 'card'); // cards are not compared

  const groups = await ok(call(admin, 'GET', '/api/catalog/similar'));
  assert.equal(groups.length, 1);
  assert.deepEqual([groups[0].cheapestId, groups[0].saving, groups[0].packages.map((p) => p.source)], [art, 8, ['art-topup', 'QuickLine']]);

  // Keeping the cheaper one for agents: the group needs no more decision.
  await ok(call(admin, 'PUT', `/api/packages/${ql}`, { active: false }));
  assert.equal((await ok(call(admin, 'GET', '/api/catalog/similar'))).length, 0);
  // The cheaper one hidden while the other is on sale: pointed out again.
  await ok(call(admin, 'PUT', `/api/packages/${ql}`, { active: true }));
  await ok(call(admin, 'PUT', `/api/packages/${art}`, { active: false }));
  assert.equal((await ok(call(admin, 'GET', '/api/catalog/similar'))).length, 1);

  await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل', username: 'agent1', password: 'secret1' }));
  const t = (await ok(call(null, 'POST', '/api/login', { username: 'agent1', password: 'secret1' }))).token;
  assert.equal((await call(t, 'GET', '/api/catalog/similar')).status, 403, 'the manager\u2019s only');
});
