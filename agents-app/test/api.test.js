'use strict';
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

let base;
const call = async (token, method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const login = async (username, password) => (await call(null, 'POST', '/api/login', { username, password })).body.token;

test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());

test('full flow: admin, agents, prices, activation, line actions, offers', async () => {
  // Login
  assert.equal((await call(null, 'POST', '/api/login', { username: 'admin', password: 'wrong' })).status, 401);
  const admin = await login('admin', 'admin-pass');
  assert.ok(admin);
  assert.equal((await call(null, 'GET', '/api/agents')).status, 401);

  // Seeded catalog, set prices
  const cat = (await call(admin, 'GET', '/api/catalog')).body;
  assert.deepEqual(cat.companies.map((c) => c.name), ['سلكوم', 'بارتنر', 'بيلفون', 'هوت موبايل']);
  const p500 = cat.packages.find((p) => p.name === '500 جيجا');
  assert.equal((await call(admin, 'PUT', `/api/packages/${p500.id}`, { cost: 60, price: 80 })).status, 200);

  // Agents
  const a1 = (await call(admin, 'POST', '/api/agents', { name: 'أبو أحمد', username: 'abu', password: 'secret1', balance: 200 })).body;
  const a2 = (await call(admin, 'POST', '/api/agents', { name: 'محل النور', username: 'noor', password: 'secret2', balance: 50 })).body;
  assert.equal(a1.balance, 200);
  assert.equal((await call(admin, 'POST', '/api/agents', { name: 'x', username: 'ABU', password: 'secret3' })).status, 409);

  // Per-agent price for a1 only
  await call(admin, 'PUT', `/api/agents/${a1.id}/prices`, { prices: [{ packageId: p500.id, price: 70 }] });
  const t1 = await login('abu', 'secret1');
  const t2 = await login('noor', 'secret2');
  const c1 = (await call(t1, 'GET', '/api/catalog')).body.packages.find((p) => p.id === p500.id);
  const c2 = (await call(t2, 'GET', '/api/catalog')).body.packages.find((p) => p.id === p500.id);
  assert.equal(c1.price, 70);
  assert.equal(c2.price, 80);
  assert.equal(c1.cost, undefined, 'agents never see cost');
  const unpriced = cat.packages.find((p) => p.name === '300 جيجا');
  assert.ok(!(await call(t1, 'GET', '/api/catalog')).body.packages.some((p) => p.id === unpriced.id), 'unpriced packages hidden');
  assert.equal((await call(t1, 'POST', '/api/lines', { packageId: unpriced.id, number: '0520000001' })).status, 400);

  // Agents cannot use admin routes
  assert.equal((await call(t1, 'GET', '/api/agents')).status, 403);
  assert.equal((await call(t1, 'POST', `/api/agents/${a1.id}/balance`, { kind: 'topup', amount: 1000 })).status, 403);

  // Activation charges the agent's own price; agent cannot override it
  const act = await call(t1, 'POST', '/api/lines', { packageId: p500.id, number: '052-123-4567', sim: '8997201', price: 1 });
  assert.equal(act.status, 200);
  assert.equal(act.body.balance, 130);
  assert.equal(act.body.line.number, '0521234567');
  assert.equal((await call(t2, 'POST', '/api/lines', { packageId: p500.id, number: '0521234567' })).status, 409);
  assert.equal((await call(t2, 'POST', '/api/lines', { packageId: p500.id, number: '0529999999' })).status, 400, 'insufficient balance');

  const lineId = act.body.line.id;
  // Other agent cannot see or touch the line
  assert.equal((await call(t2, 'GET', '/api/lines')).body.length, 0);
  assert.equal((await call(t2, 'POST', `/api/lines/${lineId}/action`, { action: 'freeze' })).status, 404);

  // Freeze, unfreeze, swap SIM, disconnect
  assert.equal((await call(t1, 'POST', `/api/lines/${lineId}/action`, { action: 'freeze' })).body.line.status, 'frozen');
  assert.equal((await call(t1, 'POST', `/api/lines/${lineId}/action`, { action: 'freeze' })).status, 400);
  assert.equal((await call(t1, 'POST', `/api/lines/${lineId}/action`, { action: 'unfreeze' })).body.line.status, 'active');
  assert.equal((await call(t1, 'POST', `/api/lines/${lineId}/action`, { action: 'swap_sim', sim: '8997202222' })).body.line.sim, '8997202222');

  // Admin moves the number with its value
  await call(admin, 'POST', `/api/agents/${a2.id}/balance`, { kind: 'topup', amount: 100 });
  assert.equal((await call(t1, 'POST', `/api/lines/${lineId}/move`, { toAgentId: a2.id })).status, 403);
  assert.equal((await call(admin, 'POST', `/api/lines/${lineId}/move`, { toAgentId: a2.id, withMoney: true })).status, 200);
  const agents = (await call(admin, 'GET', '/api/agents')).body;
  assert.equal(agents.find((a) => a.id === a1.id).balance, 200);
  assert.equal(agents.find((a) => a.id === a2.id).balance, 80);
  assert.equal((await call(t2, 'POST', `/api/lines/${lineId}/action`, { action: 'disconnect' })).body.line.status, 'disconnected');
  assert.equal((await call(t2, 'POST', `/api/lines/${lineId}/action`, { action: 'swap_sim', sim: '12345678' })).status, 400);

  // Offers: live offer with special price, expired offer hidden from agents
  const day = 864e5;
  const offer = (await call(admin, 'POST', '/api/offers', { title: 'عرض الأسبوع', packageId: p500.id, offerPrice: 55, startsAt: Date.now() - day, endsAt: Date.now() + day })).body;
  await call(admin, 'POST', '/api/offers', { title: 'منتهي', endsAt: Date.now() - day });
  const seen = (await call(t1, 'GET', '/api/offers')).body;
  assert.deepEqual(seen.map((o) => o.title), ['عرض الأسبوع']);
  assert.equal(seen[0].regularPrice, 70);
  assert.equal((await call(admin, 'GET', '/api/offers')).body.length, 2);
  const viaOffer = await call(t1, 'POST', '/api/lines', { offerId: offer.id, number: '0541111111' });
  assert.equal(viaOffer.body.balance, 145);

  // Log shows before/after; agents never get cost/profit
  const ops = (await call(t1, 'GET', '/api/ops')).body;
  const last = ops[0];
  assert.equal(last.type, 'activate');
  assert.equal(last.before, 200);
  assert.equal(last.after, 145);
  assert.equal(last.profit, undefined);
  const adminOps = (await call(admin, 'GET', `/api/ops?agentId=${a1.id}&type=activate`)).body;
  assert.equal(adminOps[0].profit, -5);

  // Disabled agent is logged out and cannot log in
  await call(admin, 'PUT', `/api/agents/${a1.id}`, { active: false });
  assert.equal((await call(t1, 'GET', '/api/me')).status, 401);
  assert.equal((await call(null, 'POST', '/api/login', { username: 'abu', password: 'secret1' })).status, 403);

  // Company with packages cannot be deleted
  assert.equal((await call(admin, 'DELETE', `/api/companies/${p500.companyId}`)).status, 400);
});
