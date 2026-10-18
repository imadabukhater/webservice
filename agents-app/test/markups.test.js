'use strict';
// The manager's profit percentage per agent and per pricing system.
const test = require('node:test');
const assert = require('node:assert/strict');

let base;
let server;
const call = async (token, method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const ok = async (p) => { const r = await p; assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const login = async (u, p) => (await ok(call(null, 'POST', '/api/login', { username: u, password: p }))).token;

test.before(async () => {
  process.env.DB_FILE = ':memory:';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('each agent can have its own profit percentage per system; a price set by hand still wins', async () => {
  const admin = await login('admin', 'admin-pass');
  const co = (await ok(call(admin, 'GET', '/api/catalog'))).companies.find((c) => c.name === 'سلكوم');
  await ok(call(admin, 'PUT', `/api/companies/${co.id}`, { activation: 'direct' }));
  const inv = (await ok(call(admin, 'POST', '/api/packages', { companyId: co.id, name: 'فاتورة 100', cost: 50, price: 60, kind: 'invoice', days: 30 }))).id;
  const card = (await ok(call(admin, 'POST', '/api/packages', { companyId: co.id, name: 'كرت 40', cost: 40, price: 44, kind: 'card', days: 30 }))).id;
  const free = (await ok(call(admin, 'POST', '/api/packages', { companyId: co.id, name: 'بدون تكلفة', cost: 0, price: 25, kind: 'invoice', days: 30 }))).id;
  await ok(call(admin, 'POST', '/api/agents', { name: 'أ', username: 'agent1', password: 'secret1', balance: 1000 }));
  await ok(call(admin, 'POST', '/api/agents', { name: 'ب', username: 'agent2', password: 'secret2', balance: 1000 }));
  const agents = await ok(call(admin, 'GET', '/api/agents'));
  const a1 = agents.find((a) => a.username === 'agent1').id;
  const t1 = await login('agent1', 'secret1');
  const t2 = await login('agent2', 'secret2');
  const priceOf = async (t, id) => (await ok(call(t, 'GET', '/api/catalog'))).packages.find((p) => p.id === id)?.price;

  // ----- no percentage: the packages' own prices -----
  assert.deepEqual(await ok(call(admin, 'GET', `/api/agents/${a1}/markups`)), { invoice: null, card: null, qlinvoice: null, qlcard: null, lyinvoice: null, lycard: null });
  assert.equal(await priceOf(t1, inv), 60);

  // ----- agent a1: 10% on invoices, 5% on cards; agent a2 untouched -----
  assert.equal((await call(admin, 'PUT', `/api/agents/${a1}/markups`, { invoice: 250 })).status, 400);
  assert.deepEqual(await ok(call(admin, 'PUT', `/api/agents/${a1}/markups`, { invoice: 10, card: 5 })), { invoice: 10, card: 5, qlinvoice: null, qlcard: null, lyinvoice: null, lycard: null });
  assert.equal(await priceOf(t1, inv), 55, 'cost 50 + 10%');
  assert.equal(await priceOf(t1, card), 42, 'cost 40 + 5%');
  assert.equal(await priceOf(t1, free), 25, 'no cost: the package price stays');
  assert.equal(await priceOf(t2, inv), 60, 'another agent keeps the normal price');

  // ----- the manager's view of a1's prices -----
  const rows = await ok(call(admin, 'GET', `/api/agents/${a1}/prices`));
  const row = rows.find((r) => r.packageId === inv);
  assert.deepEqual([row.system, row.defaultPrice, row.markupPrice, row.customPrice, row.agentPrice], ['invoice', 60, 55, null, 55]);

  // ----- a sale charges the percentage price; a price set by hand wins over the percentage -----
  const sale = await ok(call(t1, 'POST', '/api/lines', { packageId: inv, number: '0521110001', sim: '8997202000000000901' }));
  assert.equal(sale.balance, 945);
  await ok(call(admin, 'PUT', `/api/agents/${a1}/prices`, { prices: [{ packageId: inv, price: 52 }] }));
  assert.equal(await priceOf(t1, inv), 52);

  // ----- the percentage follows the cost -----
  await ok(call(admin, 'PUT', `/api/packages/${card}`, { cost: 60 }));
  assert.equal(await priceOf(t1, card), 63);

  // ----- cleared: back to the normal price; agents cannot see or change percentages -----
  await ok(call(admin, 'PUT', `/api/agents/${a1}/markups`, { card: null }));
  assert.equal(await priceOf(t1, card), 44);
  assert.equal((await call(t1, 'GET', `/api/agents/${a1}/markups`)).status, 403);
  assert.equal((await call(t1, 'PUT', `/api/agents/${a1}/markups`, { invoice: 0 })).status, 403);

  // ----- a package hidden from one agent only: gone from their list, not on sale to them; the others still see it -----
  await ok(call(admin, 'PUT', `/api/agents/${a1}/prices`, { prices: [{ packageId: card, price: null, hidden: true }] }));
  assert.equal(await priceOf(t1, card), undefined, 'not in the list of agent1');
  assert.equal(await priceOf(t2, card), 44, 'agent2 still sees it');
  const sell = await call(t1, 'POST', '/api/lines', { kind: 'external', packageId: card, number: '0521110002' });
  assert.equal(sell.status, 404);
  assert.match(sell.body.error, /غير متاحة لك/);
  assert.equal((await ok(call(admin, 'GET', `/api/agents/${a1}/prices`))).find((r) => r.packageId === card).hidden, true);
  await ok(call(admin, 'PUT', `/api/agents/${a1}/prices`, { prices: [{ packageId: card, price: null, hidden: false }] }));
  assert.equal(await priceOf(t1, card), 44, 'shown again');

  // ----- the developer's 2% of every sale: on the manager's dashboard only -----
  const dash = await ok(call(admin, 'GET', '/api/dashboard'));
  assert.equal(dash.devFeePercent, 2);
  assert.deepEqual([dash.month.revenue, dash.month.profit, dash.month.devFee, dash.month.net], [55, 5, 1.1, 3.9]);
  const agentDash = await ok(call(t1, 'GET', '/api/dashboard'));
  assert.ok(!/devFee|net|profit/.test(JSON.stringify(agentDash)), 'agents see none of it');
});
