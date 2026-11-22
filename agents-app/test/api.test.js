'use strict';
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');
const { q, tx } = require('../src/db');
const { hashPassword } = require('../src/passwords');
const { recordEsimSale } = require('../src/sale');
const D = require('../src/domain');

let base;
const call = async (token, method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const ok = async (p) => {
  const r = await p;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const login = async (username, password) => (await ok(call(null, 'POST', '/api/login', { username, password }))).token;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());

let seq = 0;
// A paid eSIM shop order for a package, as the shop leaves it before fulfilling it.
function paidOrder(packageId, { number, amount = 50, name = 'زبون تجربة', email = 'c@example.com' } = {}) {
  seq++;
  const t = Date.now();
  const id = Number(q(`INSERT INTO shop_orders (code, package_id, package_label, kind, number, customer_name, contact_phone, amount, status, paid_at,
                         created_at, updated_at, esim, email) VALUES (?, ?, 'سلكوم eSIM', 'new', ?, ?, '0599000000', ?, 'paid', ?, ?, ?, 1, ?)`)
    .run(`T${seq}`, packageId, number, name, amount, t, t, t, email).lastInsertRowid);
  return q('SELECT * FROM shop_orders WHERE id = ?').get(id);
}
// What shop.fulfil does with the sale: the line it made is the order's.
function fulfil(o) {
  return tx(() => {
    const r = recordEsimSale(o);
    q('UPDATE shop_orders SET line_id = ? WHERE id = ?').run(r.lineId, o.id);
    return r;
  });
}

test('only the manager signs in; removed portal features are gone', async () => {
  assert.equal((await call(null, 'POST', '/api/login', { username: 'admin', password: 'nope' })).status, 401);
  const admin = await login('admin', 'admin-pass');
  assert.equal((await ok(call(null, 'GET', '/api/public'))).appName, 'متجر eSIM');
  const me = await ok(call(admin, 'GET', '/api/me'));
  assert.equal(me.user.role, 'admin');
  assert.equal(me.user.balance, undefined, 'no balances');
  for (const k of ['warnDays', 'lowBalance', 'artUser', 'artConfigured', 'qlMarkupCard', 'qlSyncedCard']) assert.equal(me.settings[k], undefined, k);

  // An agent account left in an older database cannot sign in, nor use a session it had.
  const agentId = Number(q("INSERT INTO users (role, name, username, password_hash, created_at) VALUES ('agent', 'وكيل قديم', 'old', ?, ?)")
    .run(hashPassword('secret1'), Date.now()).lastInsertRowid);
  assert.equal((await call(null, 'POST', '/api/login', { username: 'old', password: 'secret1' })).status, 401);
  q("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(require('../src/passwords').sha('agent-token'), agentId, Date.now() + 864e5);
  assert.equal((await call('agent-token', 'GET', '/api/me')).status, 401);

  for (const [method, url] of [['GET', '/api/agents'], ['GET', '/api/lines'], ['GET', '/api/sims'], ['GET', '/api/messages'], ['GET', '/api/invoices'],
    ['GET', '/api/offers'], ['GET', '/api/v1/catalog'], ['GET', '/api/supplier-subs'], ['POST', '/api/art/sync'], ['GET', '/api/search'], ['GET', '/api/ops'],
    ['POST', '/api/tasks'], ['GET', '/api/numbers/free']]) {
    assert.equal((await call(admin, method, url)).status, 404, `${method} ${url}`);
  }
  // The supplier syncs take new lines only: no extensions or cards.
  assert.equal((await call(admin, 'POST', '/api/quickline/sync', { kind: 'card' })).status, 400);
});

test('an eSIM sold in the shop: recorded, activated or rejected by the manager, kept as a buyer', async () => {
  const admin = await login('admin', 'admin-pass');
  const cat0 = await ok(call(admin, 'GET', '/api/catalog'));
  assert.ok(cat0.companies.some((c) => c.name === 'سلكوم'));
  assert.ok(!cat0.companies.some((c) => c.name === 'الكروت'), 'no cards company');
  assert.equal(cat0.packages.length, 0, 'no packages until suppliers sync or the manager adds one');
  const cellcom = cat0.companies.find((c) => c.name === 'سلكوم');

  // A package added by hand is an eSIM; one marked otherwise is not listed.
  const { id: pkgId } = await ok(call(admin, 'POST', '/api/packages', { companyId: cellcom.id, name: 'eSIM 100 جيجا', cost: 30, price: 40, shopPrice: 50, dataGb: 100 }));
  const { id: hiddenId } = await ok(call(admin, 'POST', '/api/packages', { companyId: cellcom.id, name: 'شريحة', cost: 30, esimEnabled: false }));
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  assert.ok(cat.packages.some((p) => p.id === pkgId && p.esimEnabled));
  assert.ok(!cat.packages.some((p) => p.id === hiddenId));
  assert.equal(cat.packages[0].agentPrice, undefined);

  // Paid order → line pending + an eSIM task, no balance anywhere.
  const o1 = paidOrder(pkgId, { number: '0521000001', amount: 57 });
  const { lineId } = fulfil(o1);
  const line = D.getLine(lineId);
  assert.equal(line.status, 'pending');
  assert.equal(line.price, 57);
  assert.equal(line.cost, 37, 'cost + the eSIM fee (7)');
  assert.equal(q('SELECT agent_id FROM lines WHERE id = ?').get(lineId).agent_id, q("SELECT id FROM users WHERE username = 'admin'").get().id);
  assert.throws(() => fulfil(paidOrder(pkgId, { number: '0521000001' })), /مفعّل مسبقاً/);

  const tasks = await ok(call(admin, 'GET', '/api/tasks?status=open'));
  const task = tasks.find((t) => t.lineId === lineId);
  assert.equal(task.type, 'esim');
  assert.equal(task.lineNumber, '0521000001');

  let dash = await ok(call(admin, 'GET', '/api/dashboard'));
  assert.deepEqual(Object.keys(dash).sort(), ['buyers', 'month', 'pendingActivations', 'shopOpen', 'today']);
  assert.ok(dash.today.sales >= 1 && dash.today.revenue >= 57);
  assert.ok(dash.pendingActivations >= 1);

  await ok(call(admin, 'POST', `/api/tasks/${task.id}/resolve`, { status: 'done', attachment: PNG, esimCode: 'LPA:1$x$y' }));
  const done = D.getLine(lineId);
  assert.equal(done.status, 'active');
  assert.ok(done.expires_at > Date.now());
  assert.equal((await call(admin, 'POST', `/api/tasks/${task.id}/resolve`, { status: 'done' })).status, 400, 'once only');

  // Rejected: the line goes, the order keeps the reason (and stays a paid order for the manager).
  const o2 = paidOrder(pkgId, { number: '0521000002', name: 'سامي' });
  const r2 = fulfil(o2);
  const t2 = (await ok(call(admin, 'GET', '/api/tasks?status=open'))).find((t) => t.lineId === r2.lineId);
  await ok(call(admin, 'POST', `/api/tasks/${t2.id}/resolve`, { status: 'rejected', response: 'الرقم غير متاح' }));
  assert.equal(q('SELECT 1 FROM lines WHERE id = ?').get(r2.lineId), undefined);
  const after = q('SELECT * FROM shop_orders WHERE id = ?').get(o2.id);
  assert.equal(after.line_id, null);
  assert.match(after.error, /رُفض التفعيل: الرقم غير متاح/);

  // The buyers' record, read only.
  const buyers = await ok(call(admin, 'GET', '/api/buyers'));
  const b1 = buyers.find((b) => b.id === o1.id);
  assert.equal(b1.number, '0521000001');
  assert.equal(b1.lineStatus, 'active');
  assert.equal(b1.hasQr, true);
  assert.equal(b1.companyName, 'سلكوم');
  assert.equal(buyers.find((b) => b.id === o2.id).lineStatus, null);
  assert.deepEqual((await ok(call(admin, 'GET', '/api/buyers?q=سامي'))).map((b) => b.id), [o2.id]);
  assert.ok((await ok(call(admin, 'GET', '/api/buyers?q=1000001'))).map((b) => b.id).includes(o1.id));
  assert.ok(!(await ok(call(admin, 'GET', '/api/buyers?q=1000001'))).some((b) => b.id === o2.id));
  const detail = await ok(call(admin, 'GET', `/api/buyers/${o1.id}`));
  assert.equal(detail.esimQr, PNG);
  assert.equal(detail.esimCode, 'LPA:1$x$y');
  assert.equal((await call(admin, 'PUT', `/api/buyers/${o1.id}`, {})).status, 404, 'read only');

  // Reports: eSIM sales only.
  const list = await ok(call(admin, 'GET', '/api/reports'));
  assert.deepEqual(list.map((r) => r.key), ['sales', 'by_package', 'pending']);
  const sales = await ok(call(admin, 'GET', '/api/reports/sales'));
  assert.ok(sales.rows.some((r) => r.number === '0521000001' && r.amount === 57 && r.profit === 20 && r.state === 'مفعّل'));
  const byPkg = await ok(call(admin, 'GET', '/api/reports/by_package'));
  assert.ok(byPkg.rows.find((r) => r.package === 'سلكوم eSIM').sales >= 2);

  const activity = await ok(call(admin, 'GET', '/api/activity?days=7'));
  assert.equal(activity.days.length, 7);
  assert.ok(activity.totals.activate >= 2);
  dash = await ok(call(admin, 'GET', '/api/dashboard'));
  assert.ok(dash.buyers >= 2);

  const notes = await ok(call(admin, 'GET', '/api/notifications'));
  assert.ok(notes.items.some((n) => n.link === '#/tasks'));
});
