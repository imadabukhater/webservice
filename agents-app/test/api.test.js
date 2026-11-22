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
  assert.equal(cat0.packages.length, 0, 'no packages until suppliers sync');
  assert.equal(cat0.markup, 20);
  const cellcom = cat0.companies.find((c) => c.name === 'سلكوم');

  // A package of an earlier version, added by hand as an eSIM (no supplier: not in the catalog, but its sale works).
  const pkgId = Number(q("INSERT INTO packages (company_id, name, cost, price, esim_enabled) VALUES (?, 'eSIM 100 جيجا', 30, 40, 1)").run(cellcom.id).lastInsertRowid);
  assert.ok(!(await ok(call(admin, 'GET', '/api/catalog'))).packages.some((p) => p.id === pkgId));

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

test('the packages page: every eSIM package, one toggle, the shop price = supplier price + the manager’s percentage', async () => {
  const admin = await login('admin', 'admin-pass');
  for (const [method, url] of [['POST', '/api/packages'], ['DELETE', '/api/packages/1'], ['POST', '/api/packages/bulk'], ['GET', '/api/catalog/similar'],
    ['POST', '/api/companies'], ['PUT', '/api/companies/1'], ['DELETE', '/api/companies/1'], ['GET', '/api/quickline/pending'], ['POST', '/api/layan/approve'],
    ['POST', '/api/telecom/reprice'], ['GET', '/api/aylol/reprice']]) {
    assert.equal((await call(admin, method, url, method === 'GET' ? undefined : {})).status, 404, `${method} ${url}`);
  }
  const co = q("SELECT id FROM companies WHERE name = 'سلكوم'").get().id;
  const aloha = Number(q("INSERT INTO companies (name, sort) VALUES ('ALOHA', 9)").run().lastInsertRowid);
  const add = (ref, f = {}) => Number(q(`INSERT INTO packages (company_id, name, cost, art_price, supplier_cost, active, gone_at, art_card_id, kind, esim_enabled, shop_price, data_gb, days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.co ?? co, `رزمة ${ref}`, f.cost ?? 50, f.art ?? null, f.real ?? null, f.active ?? 1, f.gone ?? null, ref,
    f.kind ?? 'invoice', f.esim ?? 0, f.shop ?? null, f.gb ?? null, f.days ?? null).lastInsertRowid);
  const ql = add('qln:1:30', { art: 50 });
  const qlHidden = add('qln:2:30', { active: 0 }); // hidden by the manager before: still listed, available
  const ly = add('lyn:11111111-2222-3333-4444-555555555555:30', { esim: 1 });
  const tcAloha = add('tcn:5:30', { co: aloha });
  const tcOther = add('tcn:6:30'); // telecom's other companies are lines on a SIM card
  const ayEsim = add('ay:esim:10:501', { real: 38, art: 40, gb: 400, days: 30 });
  const gone = add('ay:esim:10:502', { gone: Date.now() });
  const card = add('ql:1:30', { kind: 'card' });
  const manual = add('', { esim: 1 });

  let cat = await ok(call(admin, 'GET', '/api/catalog'));
  const ids = cat.packages.map((p) => p.id);
  for (const id of [ql, qlHidden, ly, tcAloha, ayEsim, gone]) assert.ok(ids.includes(id), `listed ${id}`);
  for (const id of [tcOther, card, manual]) assert.ok(!ids.includes(id), `not listed ${id}`);
  const view = (id) => cat.packages.find((p) => p.id === id);
  assert.deepEqual(view(ql), { id: ql, name: 'رزمة qln:1:30', companyId: co, companyName: 'سلكوم', supplier: 'ql', supplierPrice: 50, shopPrice: null, inShop: false, available: true, dataGb: null, days: null });
  assert.deepEqual([view(qlHidden).available, view(gone).available, view(ayEsim).supplier, view(ayEsim).supplierPrice, view(ayEsim).dataGb, view(ayEsim).days], [true, false, 'ay', 38, 400, 30], 'Aylol: what it really takes');

  // On: shop price = supplier price × 1.2 rounded to the nearest whole shekel; off: no shop price, still shown.
  const on = await ok(call(admin, 'PUT', `/api/packages/${qlHidden}`, { inShop: true }));
  assert.deepEqual([on.inShop, on.shopPrice], [true, 60]);
  assert.equal(q('SELECT active FROM packages WHERE id = ?').get(qlHidden).active, 1);
  assert.equal((await ok(call(admin, 'PUT', `/api/packages/${ayEsim}`, { inShop: true }))).shopPrice, 46);
  assert.equal((await call(admin, 'PUT', `/api/packages/${gone}`, { inShop: true })).status, 409);
  assert.equal((await call(admin, 'PUT', `/api/packages/${card}`, { inShop: true })).status, 404);
  assert.equal((await call(admin, 'PUT', `/api/packages/${ql}`, { shopPrice: 99 })).status, 400, 'the toggle is the only change');
  const off = await ok(call(admin, 'PUT', `/api/packages/${qlHidden}`, { inShop: false }));
  assert.deepEqual([off.inShop, off.shopPrice], [false, null]);
  assert.equal(q('SELECT shop_price, active FROM packages WHERE id = ?').get(qlHidden).shop_price, null);
  assert.equal(q('SELECT active FROM packages WHERE id = ?').get(qlHidden).active, 1, 'off leaves it shown');

  // The manager's percentage: every shop price follows at once.
  for (const bad of [-1, 501, 'abc', '', true]) assert.equal((await call(admin, 'PUT', '/api/settings', { shopMarkup: bad })).status, 400, String(bad));
  assert.equal((await ok(call(admin, 'PUT', '/api/settings', { shopMarkup: 30 }))).shopMarkup, 30);
  cat = await ok(call(admin, 'GET', '/api/catalog'));
  assert.equal(cat.markup, 30);
  assert.equal(view(ayEsim).shopPrice, 49, 'Math.round(38 × 1.3)');
  assert.equal(q('SELECT shop_price FROM packages WHERE id = ?').get(ayEsim).shop_price, 49);
  await ok(call(admin, 'PUT', '/api/settings', { shopMarkup: 20 }));
  assert.equal(q('SELECT shop_price FROM packages WHERE id = ?').get(ayEsim).shop_price, 46);
  await ok(call(admin, 'PUT', `/api/packages/${ayEsim}`, { inShop: false }));
});
