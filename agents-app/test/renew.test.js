'use strict';
// The shop's customer renews a number: any line in the system (an agent's too), at the shop's price of the packages that
// may renew it; paid like any order; renewed by the shop's account, the line staying its agent's.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.WA_AI_DAILY_USD = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { q } = require('../src/db');

let base;
let server;
const call = async (token, method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const ok = async (p) => { const r = await p; assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const DAY = 864e5;

test.before(async () => {
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('a customer renews an agent\'s number from the shop: options at the shop price, paid, renewed by the shop account', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  await ok(call(admin, 'PUT', '/api/settings', { shopEnabled: true, shopHourLimit: 0 }));
  const co = (await ok(call(admin, 'GET', '/api/catalog'))).companies.find((c) => c.name === 'سلكوم');
  await ok(call(admin, 'PUT', `/api/companies/${co.id}`, { activation: 'direct' }));
  const sold = (await ok(call(admin, 'POST', '/api/packages', { companyId: co.id, name: 'سلكوم 400', cost: 50, price: 60, kind: 'invoice', days: 30 }))).id;
  const renew = (await ok(call(admin, 'POST', '/api/packages', { companyId: co.id, name: 'تمديد سلكوم 400', cost: 45, price: 55, kind: 'card', days: 30 }))).id;
  const unpriced = (await ok(call(admin, 'POST', '/api/packages', { companyId: co.id, name: 'بلا سعر متجر', cost: 30, price: 40, kind: 'card', days: 30 }))).id;
  await ok(call(admin, 'PUT', `/api/packages/${renew}`, { shopPrice: 65 }));
  await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل', username: 'agent-r', password: 'secret1', balance: 100 }));
  const agent = (await ok(call(admin, 'GET', '/api/agents'))).find((a) => a.username === 'agent-r');
  // The agent's line, ending in 3 days.
  const t = Date.now();
  const lineId = Number(q(`INSERT INTO lines (number, company_id, package_id, package_label, agent_id, months, price, cost, status, customer_name, activated_at, expires_at, updated_at)
    VALUES ('0521112233', ?, ?, 'سلكوم 400', ?, 1, 60, 50, 'active', 'محمد السري', ?, ?, ?)`).run(co.id, sold, agent.id, t - 27 * DAY, t + 3 * DAY, t).lastInsertRowid);

  // The options: only the shop-priced package of its company; nothing about whose it is.
  const v = await ok(call(null, 'GET', '/api/shop/renew?number=052-111-2233'));
  assert.equal(v.number, '0521112233');
  assert.equal(v.company, 'سلكوم');
  assert.deepEqual(v.options.map((o) => [o.id, o.price]), [[renew, 65]]);
  assert.equal(JSON.stringify(v).includes('محمد'), false, 'the customer\'s name is not shown');
  assert.equal(v.options.some((o) => o.id === unpriced), false);
  assert.equal((await call(null, 'GET', '/api/shop/renew?number=0599999999')).status, 404, 'not ours');

  // The order: kind recharge, the shop price; another package refused.
  assert.equal((await call(null, 'POST', '/api/shop/renewals', { number: '0521112233', packageId: unpriced })).status, 404);
  const o = await ok(call(null, 'POST', '/api/shop/renewals', { number: '0521112233', packageId: renew }));
  assert.equal(o.kind, 'recharge');
  assert.equal(o.amount, 65);
  assert.equal(o.status, 'awaiting_payment');
  assert.match(o.packageLabel, /تمديد/);
  assert.equal(o.packageLabel.split('تمديد').length, 2, 'said once');
  // Paid (the manager confirms it here): the shop account pays the renewal; the line is extended and stays the agent's.
  const id = q('SELECT id FROM shop_orders WHERE code = ?').get(o.code).id;
  await ok(call(admin, 'POST', `/api/shop/admin/orders/${id}/approve`, {}));
  const after = await ok(call(null, 'GET', `/api/shop/orders/${o.code}`));
  assert.equal(after.stage, 'done');
  const line = q('SELECT * FROM lines WHERE id = ?').get(lineId);
  assert.equal(line.agent_id, agent.id, 'still the agent\'s line');
  assert.ok(line.expires_at > t + 30 * DAY, 'extended by 30 days from its end');
  assert.equal(q('SELECT balance FROM users WHERE id = ?').get(agent.id).balance, 100, 'the agent is not charged');
  const shopId = Number(q("SELECT value FROM settings WHERE key = 'shop_agent_id'").get().value);
  const op = q("SELECT * FROM ops WHERE type = 'renew' AND line_id = ? ORDER BY id DESC").get(lineId);
  assert.equal(op.agent_id, shopId, 'renewed by the shop account');
});

test('a renewal waits for its supplier when the company is carried out by hand; one at a time per number', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  const co = (await ok(call(admin, 'GET', '/api/catalog'))).companies.find((c) => c.name === 'بارتنر');
  await ok(call(admin, 'PUT', `/api/companies/${co.id}`, { activation: 'manual' }));
  const renew = (await ok(call(admin, 'POST', '/api/packages', { companyId: co.id, name: 'تمديد بارتنر', cost: 40, price: 50, kind: 'card', days: 30 }))).id;
  await ok(call(admin, 'PUT', `/api/packages/${renew}`, { shopPrice: 55 }));
  const agent = (await ok(call(admin, 'GET', '/api/agents'))).find((a) => a.username === 'agent-r');
  const t = Date.now();
  q(`INSERT INTO lines (number, company_id, package_id, package_label, agent_id, months, price, cost, status, activated_at, expires_at, updated_at)
     VALUES ('0541112233', ?, ?, 'بارتنر', ?, 1, 50, 40, 'active', ?, ?, ?)`).run(co.id, renew, agent.id, t, t + DAY, t);
  const o = await ok(call(null, 'POST', '/api/shop/renewals', { number: '0541112233', packageId: renew }));
  const id = q('SELECT id FROM shop_orders WHERE code = ?').get(o.code).id;
  await ok(call(admin, 'POST', `/api/shop/admin/orders/${id}/approve`, {}));
  assert.equal((await ok(call(null, 'GET', `/api/shop/orders/${o.code}`))).stage, 'processing', 'the manager carries it out');
  assert.equal((await call(null, 'GET', '/api/shop/renew?number=0541112233')).status, 409, 'not renewed twice at once');
  // The manager marks it done: the order is done.
  const task = q("SELECT id FROM tasks WHERE type = 'renew' AND status = 'open' ORDER BY id DESC").get();
  await ok(call(admin, 'POST', `/api/tasks/${task.id}/resolve`, { status: 'done' }));
  assert.equal((await ok(call(null, 'GET', `/api/shop/orders/${o.code}`))).stage, 'done');
});

test('WhatsApp: «بدي أمدد رقمي» — the options, a summary to confirm, then the renewal order paid in the chat', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  const wa = require('../src/whatsapp');
  const S = require('../src/routes/shop');
  const co = (await ok(call(admin, 'GET', '/api/catalog'))).companies.find((c) => c.name === 'سلكوم');
  const opts = S.renewalOptions(q(`${require('../src/domain').LINE_SELECT} WHERE l.number = '0521112233'`).get());
  assert.ok(opts.length >= 1, 'the shop-priced renewal of the first test');
  const second = (await ok(call(admin, 'POST', '/api/packages', { companyId: co.id, name: 'تمديد سلكوم 3 شهور', cost: 120, price: 140, kind: 'card', days: 90 }))).id;
  await ok(call(admin, 'PUT', `/api/packages/${second}`, { shopPrice: 150 }));
  const jid = '972599800001@s.whatsapp.net';
  const ctx = (started = Date.now()) => ({ jid, phone: '0599800001', shop: S.shopCatalogResponse(), startedAt: started, facts: [], after: [], prices: new Set(), phones: new Set() });
  // Two options: the list, nothing ordered.
  const c1 = ctx();
  const r1 = await wa._test.agentTool('renew_number', { number: '0521112233' }, c1);
  assert.deepEqual(r1.need, ['package_id']);
  assert.match(c1.facts[0], /📱 الرقم \*0521112233\* — سلكوم[\s\S]*رزم التمديد:[\s\S]*1️⃣[\s\S]*2️⃣/);
  assert.equal(c1.codeOnly, true);
  // The second picked: the summary to confirm.
  const c2 = ctx();
  const r2 = await wa._test.agentTool('renew_number', { package_id: second }, c2);
  assert.equal(r2.awaiting_confirmation, true);
  assert.match(c2.facts[0], /📝 \*تأكيد التمديد:\*[\s\S]*السعر: \*150 ₪\* \(90 يوم\)/);
  await new Promise((r) => setTimeout(r, 5));
  // «نعم»: the order, with the payment steps (Jawwal Pay is off here: the transfer).
  const c3 = ctx();
  const r3 = await wa._test.agentTool('renew_number', { confirmed: true }, c3);
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.match(c3.facts.at(-1), /✅ انعمل طلب تمديد الرقم \*0521112233\*/);
  const o = S.byCode(r3.order_code);
  assert.equal(o.kind, 'recharge');
  assert.equal(o.amount, 150);
  // A number that is not ours: said plainly.
  q('UPDATE shop_orders SET status = \'cancelled\' WHERE id = ?').run(o.id);
  const c4 = ctx();
  await wa._test.agentTool('renew_number', { number: '0599999999' }, c4);
  assert.match(c4.facts[0], /غير مسجّل عندنا/);
});
