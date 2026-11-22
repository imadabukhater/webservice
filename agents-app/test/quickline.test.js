'use strict';
// QuickLine integration against a fake API that mimics the real one (JWT login, the dealer's companies and
// packages, the subscriptions list, Subscriptions/Renew, which moves a line's cut date, Numbers/GetFreeNumbers and
// Subscriptions/NewSubscription, which adds a line).
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const JWT = 'header.payload.signature';
// The dealer's lines at QuickLine: number → subscription. 0524386903 can be extended, 0511111111 cannot.
const subs = () => [
  ...fake.added,
  { id: 305648, number: '0524386903', company: 'Cellcom', companyId: 3, packageId: 2564, status: 'فعال', statusInt: 2, canExtend: true, daysLeft: fake.daysLeft, cutDate: fake.cutDate },
  { id: 400877, number: '0511111111', company: 'Cellcom', companyId: 3, packageId: 2564, status: 'فصل نهائي', statusInt: 4, canExtend: false, daysLeft: 0, cutDate: '01/01/2026' },
];
const fake = { renews: [], logins: 0, cutDate: '14/10/2026', daysLeft: 3, cost: 62, renewAnswer: null, expire: false, created: [], added: [], newAnswer: null, stateCalls: [], holdNew: false, subsFail: 0, simCalls: [] };
// Free numbers per kind: physical SIM, and eSIM (with its own eSIM and QR code).
const FREE = {
  s: [{ id: 9001, phone: '0528170777', sim: '', barcodeImage: null }, { id: 9002, phone: '0584922255', sim: '', barcodeImage: null }],
  e: [{ id: 9101, phone: '0581112222', sim: '899720201234567890', barcodeImage: 'iVBORw0KGgo=' }],
};

const PACKAGES = {
  3: [{ id: 2564, name: 'سلكوم 400 جيجا', gb: 400, sms: 5000, minutes: 5000, offer: 'سعر الشهر الأول' },
    // An offer for the first three months: 80 for the 90 days, 45 a month after that.
    { id: 2587, name: 'سلكوم 400 جيجا عرض 3 أشهر', gb: 400, sms: 5000, minutes: 5000, offer: 'السعر للأشهر الثلاثة الأولى', months: 3, cost: 45, costOffer: 80 }],
  2: [{ id: 2505, name: 'جولان 300 جيجا', gb: 300, sms: 4000, minutes: 4000, offer: null }],
};
const COMPANIES = [
  { id: 3, name: 'Cellcom', logo: 'c.jpg', color: '#72206A', postalCode: '89972020', simLength: 18 },
  { id: 2, name: 'Golan', logo: 'g.jpg', color: '#ed1c24', postalCode: '89972020', simLength: 18 },
];

const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    const text = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(v); };
    const url = req.url.replace(/^\/api\//, '');
    if (url === 'Account/Login') {
      const f = JSON.parse(body || '{}');
      fake.logins++;
      if (f.email !== 'dealer@example.com' || f.password !== 'ql-pass-123') return text('البريد أو كلمة المرور خاطئة', 401);
      return json({ statusCode: 200, data: { jwt: JWT, userId: 'u1', type: 'Dealer', name: 'أحمد ', email: f.email, roleId: '2', isDriver: false } });
    }
    // Everything else needs the token. fake.expire makes the first call after a sign-in fail once, as an expired one would.
    if (req.headers.authorization !== `Bearer ${JWT}`) return text('unauthorized', 401);
    if (fake.expire) { fake.expire = false; return text('token expired', 401); }
    if (url === 'Home/GetHomePageData') {
      return json({ activeSubscriptions: 20, inActiveSubscriptions: 154, pendingServices: 0, openPayments: 1205, credit: -116.67, ads: [] });
    }
    if (url === 'Companies/GetDealerCompanies') return json(COMPANIES);
    const pk = /^Packages\/GetPackagesByCompany\/(\d+)$/.exec(url);
    if (pk) {
      const co = COMPANIES.find((c) => c.id === Number(pk[1]));
      return json((PACKAGES[pk[1]] || []).map((p) => ({
        company: { id: co.id, name: co.name, logo: co.logo, color: co.color },
        package: { name: p.name, id: p.id, gb: p.gb, sms: p.sms, minutes: p.minutes, isOffer: !!p.offer, offer: p.offer ? { id: 1, months: p.months || 1, title: p.offer } : null, hasFakePrice: false },
        prices: { pricePerCustomer: 100, pricePerCustomerOffer: 100, fakePrice: null, cost: p.cost ?? fake.cost, costOffer: p.costOffer ?? fake.cost, secondaryPrice: p.cost ?? fake.cost, mainPrice: p.costOffer ?? fake.cost },
        dealerId: 4606,
      })));
    }
    if (url === 'Subscriptions/DealersGetAllDT') {
      if (fake.subsFail > 0) { fake.subsFail--; return text('down', 503); }
      const f = JSON.parse(body || '{}');
      const all = subs();
      return json({
        draw: f.draw,
        recordsTotal: all.length,
        recordsFiltered: all.length,
        data: all.slice(f.start, f.start + f.length).map((s, i) => ({
          company: { name: s.company, id: s.companyId, simPrefix: '89972020', simLength: 18 },
          package: { name: 'سلكوم 400 جيجا', id: s.packageId, gb: 400 },
          customer: { name: 'زبون', id: 1 },
          daysLeft: { value: s.daysLeft, color: 'warning' },
          status: { name: s.status, value: 'success', valueInt: s.statusInt },
          automaticRenew: { name: 'غير فعال', text: 'danger', value: false },
          subscription: { id: s.id, phoneNumber: s.number, simNumber: s.sim || `8997202035011905${i}`, customerPrice: null, isEsim: { name: 'لا', value: 'danger', valueInt: 0 } },
          constantRenew: { name: 'غير فعال', text: 'danger', value: false },
          actions: { canExtend: s.canExtend, canDisconnect: true, canPause: true, canChangeSim: true, canChangeAutomaticRenew: true, canRefresh: true },
          cutDate: s.cutDate,
          connectionDate: '14/09/2026',
          updateDate: '14/09/2026',
          dealer: { id: 4606, name: 'أحمد ', phone: '0534559260' },
          belongsToUser: true,
          number: i + 1,
        })),
      });
    }
    if (url === 'Subscriptions/Renew') {
      const f = JSON.parse(body || '{}');
      fake.renews.push(f);
      if (fake.renewAnswer) return text(fake.renewAnswer, 400);
      // The extension takes effect at once: the cut date moves and the remaining days grow.
      const own = fake.added.find((x) => x.id === Number(f.subscriptionId));
      if (own) { own.daysLeft += f.days; own.cutDate = '13/12/2026'; return text('تم تمديد الاشتراك بنجاح'); }
      fake.daysLeft += f.days;
      fake.cutDate = '13/11/2026';
      return text('تم تمديد الاشتراك بنجاح');
    }
    if (url === 'Numbers/GetFreeNumbers') {
      const f = JSON.parse(body || '{}');
      const skip = new Set((f.Numbers || []).map(Number));
      return json(FREE[f.isEsim ? 'e' : 's'].filter((n) => !skip.has(n.id)));
    }
    if (url === 'Subscriptions/NewSubscription') {
      const f = JSON.parse(body || '{}');
      fake.created.push(f);
      if (fake.newAnswer) return text(fake.newAnswer, 400);
      // holdNew: QuickLine accepted it but has not activated the line yet.
      if (fake.holdNew) return text('تم استلام الطلب');
      const free = [...FREE.s, ...FREE.e].find((n) => n.id === Number(f.numberId));
      const number = f.newSubscriptionType === 'neyod' ? f.phone : free.phone;
      fake.added.push({ id: 500000 + fake.added.length, number, company: 'Cellcom', companyId: 3, packageId: Number(f.packageId), status: 'جديد', statusInt: 1, canExtend: false, daysLeft: f.daysValues, cutDate: '12/11/2026' });
      return text('تمت إضافة الاشتراك بنجاح');
    }
    if (url === 'Subscriptions/ChangeSim') {
      const f = JSON.parse(body || '{}');
      fake.simCalls.push([f.subscriptionId, f.simNumber]);
      const sub = fake.added.find((x) => x.id === Number(f.subscriptionId));
      if (!sub) return text('الاشتراك غير موجود', 400);
      sub.sim = `89972020${f.simNumber}`;
      return text('تم تغيير الشريحة');
    }
    // A line's state: CloseNumber (final, 4), PauseNumber (temporary, 6), ActivateNumber/<id> (back to 2).
    const stateCall = /^Subscriptions\/(CloseNumber|PauseNumber|ActivateNumber)(?:\/(\d+))?$/.exec(url);
    if (stateCall) {
      const f = JSON.parse(body || '{}');
      const id = Number(stateCall[2] || f.subscriptionId);
      fake.stateCalls.push([stateCall[1], id, f.cutNoReceive]);
      const sub = fake.added.find((x) => x.id === id);
      if (!sub) return text('الاشتراك غير موجود', 400);
      Object.assign(sub, { CloseNumber: { status: 'فصل نهائي', statusInt: 4 }, PauseNumber: { status: 'فصل مؤقت', statusInt: 6 }, ActivateNumber: { status: 'فعال', statusInt: 2 } }[stateCall[1]]);
      return text('تم');
    }
    return text('not found', 404);
  });
});

let base;
let server;
const call = async (token, method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const ok = async (p) => { const r = await p; assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const login = async (u, p) => (await ok(call(null, 'POST', '/api/login', { username: u, password: p }))).token;
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 60));
  }
};

test.before(async () => {
  await new Promise((r) => api.listen(0, r));
  process.env.QL_BASE = `http://127.0.0.1:${api.address().port}`;
  process.env.ART_CHECK_MS = '50';
  process.env.DB_FILE = ':memory:';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); api.close(); });

// A paid shop order for a QuickLine eSIM number the shop offered (and so remembered), then sold (shop.fulfil's part).
let seq = 0;
function sellEsim(pkg, n, { name = 'زبون eSIM', phone = n.phone } = {}) {
  const { q, tx } = require('../src/db');
  const { recordEsimSale } = require('../src/sale');
  const ref = require('../src/quickline').parseRef(q('SELECT art_card_id FROM packages WHERE id = ?').get(pkg.id).art_card_id);
  require('../src/routes/quickline').remember(ref.packageId, true, [{ id: n.id, phone: n.phone, sim: n.sim, qr: n.barcodeImage }]);
  const t = Date.now();
  const id = Number(q(`INSERT INTO shop_orders (code, package_id, package_label, kind, number, sim, customer_name, amount, status, paid_at, created_at, updated_at, esim, number_id)
                       VALUES (?, ?, 'eSIM', 'new', ?, ?, ?, 70, 'paid', ?, ?, ?, 1, ?)`).run(`QL${++seq}`, pkg.id, phone, n.sim, name, t, t, t, n.id).lastInsertRowid);
  return tx(() => {
    const r = recordEsimSale(q('SELECT * FROM shop_orders WHERE id = ?').get(id));
    q('UPDATE shop_orders SET line_id = ? WHERE id = ?').run(r.lineId, id);
    return r;
  });
}

test('QuickLine: new lines sync at the supplier’s price; the shop price follows it, and the toggle puts it in the shop or not', async () => {
  const admin = await login('admin', 'admin-pass');
  const { q } = require('../src/db');
  assert.equal((await call(admin, 'POST', '/api/quickline/check')).status, 400, 'not configured yet');
  const s = await ok(call(admin, 'PUT', '/api/settings', { qlUser: 'dealer@example.com', qlPass: 'ql-pass-123' }));
  assert.equal(s.qlConfigured, true);
  assert.equal(s.qlMarkupInvoice, undefined, 'no percentage per supplier');
  assert.equal(s.shopMarkup, 20);
  assert.ok(!JSON.stringify(await ok(call(admin, 'GET', '/api/settings'))).includes('ql-pass-123'), 'the password is never sent back');
  const chk = await ok(call(admin, 'POST', '/api/quickline/check'));
  assert.deepEqual([chk.ok, chk.name, chk.credit, chk.active], [true, 'أحمد', -116.67, 20]);

  assert.equal((await call(admin, 'POST', '/api/quickline/sync', { kind: 'card' })).status, 400, 'no extensions');
  const si = await ok(call(admin, 'POST', '/api/quickline/sync', {}));
  assert.deepEqual([si.kind, si.total, si.added, si.pending, si.markup], ['invoice', 3, 3, undefined, undefined]);
  assert.ok((await ok(call(admin, 'GET', '/api/settings'))).qlSyncedInvoice > 0);

  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const newLine = cat.packages.find((p) => p.supplier === 'ql' && p.name === 'سلكوم 400 جيجا');
  assert.deepEqual([newLine.supplierPrice, newLine.shopPrice, newLine.inShop, newLine.available], [62, null, false, true], 'off until the manager turns it on');
  const row = (id) => q('SELECT * FROM packages WHERE id = ?').get(id);
  assert.equal(q('SELECT name FROM companies WHERE id = ?').get(row(newLine.id).company_id).name, 'سلكوم', 'matched to the existing company');
  assert.ok(cat.packages.some((p) => p.companyName === 'جولان'), 'a missing company is created');
  assert.equal(q("SELECT COUNT(*) AS n FROM packages WHERE art_card_id LIKE 'ql:%'").get().n, 0);
  const again = await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'invoice' }));
  assert.deepEqual([again.added, again.updated], [0, 3]);

  // ----- an expired token is renewed without the manager noticing -----
  const logins = fake.logins;
  fake.expire = true;
  assert.equal((await ok(call(admin, 'POST', '/api/quickline/check'))).ok, true);
  assert.ok(fake.logins > logins, 'signed in again');

  // ----- in the shop: supplier price × 1.2 -----
  await ok(call(admin, 'PUT', '/api/settings', { shopEnabled: true, jawwalpayNumber: '0599000000' }));
  const shopIds = async () => (await ok(call(null, 'GET', '/api/shop'))).packages.map((p) => p.id);
  assert.ok(!(await shopIds()).includes(newLine.id));
  assert.equal((await ok(call(admin, 'PUT', `/api/packages/${newLine.id}`, { inShop: true }))).shopPrice, 74);
  await require('../src/routes/shop').refreshStock();
  assert.ok((await shopIds()).includes(newLine.id), 'on sale');

  // ----- QuickLine's price changed: no approval, the cost and the shop price follow at the next sync -----
  fake.cost = 70;
  await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'invoice' }));
  assert.deepEqual([row(newLine.id).cost, row(newLine.id).art_price, row(newLine.id).shop_price], [70, 70, 84]);
  assert.equal((await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.id === newLine.id).shopPrice, 84);
  const other = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.supplier === 'ql' && p.id !== newLine.id);
  assert.equal(row(other.id).shop_price, null, 'a package off the shop has no shop price');

  // ----- off: out of the shop; on: back -----
  await ok(call(admin, 'PUT', `/api/packages/${newLine.id}`, { inShop: false }));
  assert.equal(row(newLine.id).shop_price, null);
  assert.ok(!(await shopIds()).includes(newLine.id), 'off the shop');
  await ok(call(admin, 'PUT', `/api/packages/${newLine.id}`, { inShop: true }));
  assert.equal(row(newLine.id).shop_price, 84);
  await require('../src/routes/shop').refreshStock();
  assert.ok((await shopIds()).includes(newLine.id), 'back on sale');
  fake.cost = 62;
  await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'invoice' }));
  assert.equal(row(newLine.id).shop_price, 74);

  // Removed paths.
  for (const url of ['/api/numbers/free', '/api/numbers/port-companies', '/api/quickline/lines', '/api/quickline/pending', '/api/quickline/reprice']) {
    assert.equal((await call(admin, 'GET', url)).status, 404, url);
  }
});

test('QuickLine: an eSIM sold in the shop is activated there automatically, with its QR code', async () => {
  const admin = await login('admin', 'admin-pass');
  const pk = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.supplier === 'ql' && p.name === 'سلكوم 400 جيجا');
  const n = FREE.e[0];
  const { q } = require('../src/db');

  // Only a number QuickLine offered (and the shop remembered) can be sold.
  assert.throws(() => sellEsim(pk, n, { phone: '0581112299' }), /قائمة الأرقام المتاحة/);
  assert.equal(fake.created.length, 0);

  const { lineId } = sellEsim(pk, n);
  const line = await until(() => { const l = q('SELECT * FROM lines WHERE id = ?').get(lineId); return l.status === 'active' && l; });
  assert.equal(line.esim_qr, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(line.sim, '899720201234567890');
  assert.ok(line.expires_at > Date.now() + 29 * 864e5);
  assert.equal(fake.created.length, 1, 'sent once');
  assert.deepEqual([fake.created[0].newSubscriptionType, fake.created[0].numberId, fake.created[0].simNumber], ['newEsimSubscription', '9101', '1234567890']);
  const done = (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === lineId);
  assert.deepEqual([done.type, done.status, done.autoStatus, done.resolvedBy, done.source], ['esim', 'done', 'done', 'QuickLine (تلقائي)', 'QuickLine']);

  // ----- QuickLine refusing: nothing was activated, it is never resent, and the manager rejects it -----
  q("UPDATE lines SET status = 'disconnected' WHERE id = ?").run(lineId);
  fake.added.length = 0;
  fake.newAnswer = 'الرقم محجوز';
  const rf = sellEsim(pk, n, { name: 'زبون ثان' });
  const refused = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === rf.lineId && !['', 'sending'].includes(x.autoStatus)));
  assert.deepEqual([refused.status, refused.autoStatus], ['open', 'failed']);
  assert.match(refused.autoNote, /الرقم محجوز/);
  const tries = fake.created.length;
  await ok(call(admin, 'POST', `/api/tasks/${refused.id}/resolve`, { status: 'rejected', response: 'رفضه QuickLine' }));
  assert.equal(q('SELECT 1 FROM lines WHERE id = ?').get(rf.lineId), undefined);
  assert.match(q('SELECT error FROM shop_orders WHERE code = ?').get(`QL${seq}`).error, /رفضه QuickLine/);
  await require('../src/autoexec').sweep();
  assert.equal(fake.created.length, tries, 'tried once only');
  fake.newAnswer = null;

  // ----- the manager can stop automation for a company: the eSIM waits for them -----
  q("UPDATE companies SET activation = 'manual' WHERE id = ?").run(pk.companyId);
  const rm = sellEsim(pk, n, { name: 'زبون ثالث' });
  await new Promise((r) => setTimeout(r, 200));
  const waiting = (await ok(call(admin, 'GET', '/api/tasks?status=open'))).find((x) => x.lineId === rm.lineId);
  assert.equal(waiting.autoStatus, '');
  assert.equal(fake.created.length, tries);
  await ok(call(admin, 'POST', `/api/tasks/${waiting.id}/resolve`, { status: 'done', attachment: 'data:image/png;base64,iVBORw0KGgo=' }));
  assert.equal(q('SELECT status FROM lines WHERE id = ?').get(rm.lineId).status, 'active');
});
