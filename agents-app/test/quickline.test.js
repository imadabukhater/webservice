'use strict';
// QuickLine integration against a fake API that mimics the real one (JWT login, the dealer's companies and
// packages, the subscriptions list and Subscriptions/Renew, which moves a line's cut date).
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const JWT = 'header.payload.signature';
// The dealer's lines at QuickLine: number → subscription. 0524386903 can be extended, 0511111111 cannot.
const subs = () => [
  { id: 305648, number: '0524386903', company: 'Cellcom', companyId: 3, packageId: 2564, status: 'فعال', statusInt: 2, canExtend: true, daysLeft: fake.daysLeft, cutDate: fake.cutDate },
  { id: 400877, number: '0511111111', company: 'Cellcom', companyId: 3, packageId: 2564, status: 'فصل نهائي', statusInt: 4, canExtend: false, daysLeft: 0, cutDate: '01/01/2026' },
];
const fake = { renews: [], logins: 0, cutDate: '14/10/2026', daysLeft: 3, cost: 62, renewAnswer: null, expire: false };

const PACKAGES = {
  3: [{ id: 2564, name: 'سلكوم 400 جيجا', gb: 400, sms: 5000, minutes: 5000, offer: 'سعر الشهر الأول' }],
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
        package: { name: p.name, id: p.id, gb: p.gb, sms: p.sms, minutes: p.minutes, isOffer: !!p.offer, offer: p.offer ? { id: 1, months: 1, title: p.offer } : null, hasFakePrice: false },
        prices: { pricePerCustomer: 100, pricePerCustomerOffer: 100, fakePrice: null, cost: fake.cost, costOffer: fake.cost, secondaryPrice: fake.cost, mainPrice: fake.cost },
        dealerId: 4606,
      })));
    }
    if (url === 'Subscriptions/DealersGetAllDT') {
      return json({
        draw: 1,
        recordsTotal: 2,
        recordsFiltered: 2,
        data: subs().map((s, i) => ({
          company: { name: s.company, id: s.companyId, simPrefix: '89972020', simLength: 18 },
          package: { name: 'سلكوم 400 جيجا', id: s.packageId, gb: 400 },
          customer: { name: 'زبون', id: 1 },
          daysLeft: { value: s.daysLeft, color: 'warning' },
          status: { name: s.status, value: 'success', valueInt: s.statusInt },
          automaticRenew: { name: 'غير فعال', text: 'danger', value: false },
          subscription: { id: s.id, phoneNumber: s.number, simNumber: `8997202035011905${i}`, customerPrice: null, isEsim: { name: 'لا', value: 'danger', valueInt: 0 } },
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
      fake.daysLeft += f.days;
      fake.cutDate = '13/11/2026';
      return text('تم تمديد الاشتراك بنجاح');
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

test('QuickLine: sync with the markup, extend a line automatically, hand the rest to the manager', async () => {
  const admin = await login('admin', 'admin-pass');
  assert.equal((await call(admin, 'POST', '/api/quickline/check')).status, 400, 'not configured yet');
  const s = await ok(call(admin, 'PUT', '/api/settings', { qlUser: 'dealer@example.com', qlPass: 'ql-pass-123', qlMarkupCard: 20, qlMarkupInvoice: 10 }));
  assert.equal(s.qlConfigured, true);
  assert.deepEqual([s.qlMarkupCard, s.qlMarkupInvoice], [20, 10], 'a separate profit percentage per system');
  assert.equal((await call(admin, 'PUT', '/api/settings', { qlMarkupCard: 250 })).status, 400);
  assert.ok(!JSON.stringify(await ok(call(admin, 'GET', '/api/settings'))).includes('ql-pass-123'), 'the password is never sent back');
  const chk = await ok(call(admin, 'POST', '/api/quickline/check'));
  assert.deepEqual([chk.ok, chk.name, chk.credit, chk.active], [true, 'أحمد', -116.67, 20]);

  // ----- each system syncs on its own -----
  assert.equal((await call(admin, 'POST', '/api/quickline/sync', {})).status, 400, 'a system must be chosen');
  const sc = await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'card' }));
  assert.deepEqual([sc.total, sc.added, sc.updated, sc.switchedOff, sc.pending, sc.markup], [2, 2, 0, 0, 0, 20]);
  const si = await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'invoice' }));
  assert.deepEqual([si.total, si.added, si.markup], [2, 2, 10]);
  assert.ok((await ok(call(admin, 'GET', '/api/settings'))).qlSyncedCard > 0);

  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const ext = cat.packages.find((p) => p.supplier === 'ql' && p.kind === 'card' && p.artCode === '2564');
  assert.equal(ext.cost, 62);
  assert.equal(ext.price, 74.4, 'agents pay QuickLine\'s price + 20%');
  assert.deepEqual([ext.dataGb, ext.minutes, ext.sms, ext.days], [400, 5000, 5000, 30]);
  const newLine = cat.packages.find((p) => p.supplier === 'ql' && p.kind === 'invoice' && p.artCode === '2564');
  assert.equal(newLine.price, 68.2, 'new lines use their own percentage (10%)');
  assert.equal(cat.companies.find((c) => c.id === ext.companyId).name, 'سلكوم', 'matched to the existing company');
  assert.equal(cat.companies.find((c) => c.id === ext.companyId).activation, 'auto');
  assert.ok(cat.companies.some((c) => c.name === 'جولان'), 'a missing company is created');
  const again = await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'card' }));
  assert.deepEqual([again.added, again.updated], [0, 2]);

  // ----- art-topup's controls never touch QuickLine's packages -----
  assert.equal((await ok(call(admin, 'GET', '/api/art/reprice?kind=card'))).total, 0);
  assert.equal((await ok(call(admin, 'POST', '/api/art/reprice', { kind: 'card', scope: 'all' }))).changed, 0);
  assert.equal((await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.id === ext.id).price, 74.4, 'untouched');

  // ----- extending a line is carried out automatically -----
  await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل', username: 'agent1', password: 'secret1', balance: 500 }));
  const t = await login('agent1', 'secret1');
  const r = await ok(call(t, 'POST', '/api/lines', { kind: 'external', packageId: ext.id, number: '052-438-6903' }));
  assert.equal(r.line.status, 'pending');
  const line = await until(async () => { const l = (await ok(call(t, 'GET', `/api/lines/${r.line.id}`))).line; return l.status === 'active' && l; });
  assert.ok(line.expiresAt > Date.now() + 27 * 864e5);
  assert.deepEqual(fake.renews, [{ subscriptionId: 305648, days: 30 }], 'the number was turned into its subscription, and sent once');
  const done = (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === r.line.id);
  assert.equal(done.status, 'done');
  assert.equal(done.autoStatus, 'done');
  assert.equal(done.resolvedBy, 'QuickLine (تلقائي)');
  assert.match(done.autoNote, /تم التمديد حتى 13\/11\/2026/);

  // ----- a number QuickLine does not have, and one it will not extend: the manager decides, nothing is sent -----
  const before = fake.renews.length;
  const r2 = await ok(call(t, 'POST', '/api/lines', { kind: 'external', packageId: ext.id, number: '0599999999' }));
  const missing = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === r2.line.id && x.autoStatus === 'failed'));
  assert.equal(missing.status, 'open', 'left for the manager');
  assert.match(missing.autoNote, /غير موجود في QuickLine/);
  const r3 = await ok(call(t, 'POST', '/api/lines', { kind: 'external', packageId: ext.id, number: '0511111111' }));
  const closed = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === r3.line.id && x.autoStatus === 'failed'));
  assert.match(closed.autoNote, /لا يسمح بتمديد/);
  assert.equal(fake.renews.length, before, 'neither was sent to QuickLine');
  // Rejecting gives the agent the money back.
  const paid = (await ok(call(t, 'GET', '/api/me'))).user.balance;
  await ok(call(admin, 'POST', `/api/tasks/${missing.id}/resolve`, { status: 'rejected', response: 'الرقم غير موجود' }));
  assert.equal((await ok(call(t, 'GET', '/api/me'))).user.balance, Math.round((paid + 74.4) * 100) / 100);

  // ----- QuickLine refusing the extension is a clean failure: the task stays open and is never resent -----
  fake.renewAnswer = 'الرصيد غير كافٍ';
  // Selling a recharge on a number the agent already has renews that same line, so the new task is found by
  // ignoring every task that existed before this sale.
  const had = new Set((await ok(call(admin, 'GET', '/api/tasks'))).map((x) => x.id));
  await ok(call(t, 'POST', '/api/lines', { kind: 'external', packageId: ext.id, number: '0524386903' }));
  const refused = await until(async () => (await ok(call(admin, 'GET', '/api/tasks')))
    .find((x) => !had.has(x.id) && !['', 'sending'].includes(x.autoStatus)));
  assert.equal(refused.status, 'open');
  assert.equal(refused.autoStatus, 'failed', 'an answered refusal charges nothing, so the manager can simply refund');
  assert.match(refused.autoNote, /الرصيد غير كافٍ/);
  assert.equal(fake.renews.length, before + 1, 'tried once only');
  fake.renewAnswer = null;
});

test('QuickLine: an expired token signs in again, and a new price waits for the manager', async () => {
  const admin = await login('admin', 'admin-pass');
  // ----- an expired token is renewed without the manager noticing -----
  const logins = fake.logins;
  fake.expire = true;
  assert.equal((await ok(call(admin, 'POST', '/api/quickline/check'))).ok, true);
  assert.ok(fake.logins > logins, 'signed in again');

  // ----- QuickLine's price changed: costs and prices wait for the manager -----
  const ext = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.supplier === 'ql' && p.kind === 'card' && p.artCode === '2564');
  fake.cost = 70;
  const sync = await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'card' }));
  assert.equal(sync.pending, 2, 'both packages changed price');
  const mid = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.id === ext.id);
  assert.deepEqual([mid.cost, mid.price, mid.artPrice, mid.artPending], [62, 74.4, 70, true], 'nothing changed on its own');
  const pending = await ok(call(admin, 'GET', '/api/quickline/pending?kind=card'));
  const row = pending.find((p) => p.id === ext.id);
  assert.deepEqual([row.cost, row.artPrice, row.suggested], [62, 70, 84]);

  // Approving takes the new cost and the percentage on top of it.
  await ok(call(admin, 'POST', '/api/quickline/approve', { ids: [ext.id], mode: 'all' }));
  const after = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.id === ext.id);
  assert.deepEqual([after.cost, after.price, after.artPending], [70, 84, false]);

  // Ignoring keeps both, and the same price is not asked about again.
  const other = pending.find((p) => p.id !== ext.id);
  await ok(call(admin, 'POST', '/api/quickline/approve', { ids: [other.id], mode: 'ignore' }));
  assert.equal((await ok(call(admin, 'GET', '/api/quickline/pending?kind=card'))).length, 0);
  await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'card' }));
  assert.equal((await ok(call(admin, 'GET', '/api/quickline/pending?kind=card'))).length, 0, 'still ignored');

  // ----- the dealer's lines are readable for the manager -----
  const lines = await ok(call(admin, 'GET', '/api/quickline/lines'));
  assert.deepEqual([lines.total, lines.extendable], [2, 1]);
  assert.equal(lines.lines[0].number, '0524386903');
});
