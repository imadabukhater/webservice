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
  assert.deepEqual([sc.total, sc.added, sc.updated, sc.switchedOff, sc.pending, sc.markup], [3, 3, 0, 0, 0, 20]);
  const si = await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'invoice' }));
  assert.deepEqual([si.total, si.added, si.markup], [3, 3, 10]);
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
  assert.deepEqual([again.added, again.updated], [0, 3]);
  // An offer package: extended at its regular monthly price, opened as a new line for its offer period at the offer price.
  const offerExt = cat.packages.find((p) => p.supplier === 'ql' && p.kind === 'card' && p.artCode === '2587');
  const offerNew = cat.packages.find((p) => p.supplier === 'ql' && p.kind === 'invoice' && p.artCode === '2587');
  assert.deepEqual([offerExt.cost, offerExt.days], [45, 30]);
  assert.deepEqual([offerNew.cost, offerNew.price, offerNew.days], [80, 88, 90]);

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
  assert.match(refused.autoNote, /رصيد حسابك في QuickLine لا يكفي/, 'in plain words');
  assert.ok(!/\(400\)/.test(refused.autoNote), 'no HTTP codes');
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

test('QuickLine: a new line, an eSIM and a ported number are activated automatically', async () => {
  const admin = await login('admin', 'admin-pass');
  await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'invoice' }));
  const pk = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.supplier === 'ql' && p.kind === 'invoice' && p.artCode === '2564');
  await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل خطوط', username: 'agent2', password: 'secret2', balance: 1000 }));
  const t = await login('agent2', 'secret2');
  const agentPkg = (await ok(call(t, 'GET', '/api/catalog'))).packages.find((p) => p.id === pk.id);
  assert.equal(agentPkg.ql, true, 'the agent knows its number comes from QuickLine');

  // ----- the agent picks one of QuickLine's free numbers -----
  const nums = await ok(call(t, 'GET', `/api/quickline/numbers?packageId=${pk.id}`));
  assert.deepEqual(nums.map((n) => n.phone), ['0528170777', '0584922255']);
  assert.deepEqual((await ok(call(t, 'GET', `/api/quickline/numbers?packageId=${pk.id}&exclude=9001`))).map((n) => n.id), [9002]);
  const sale = { kind: 'new', packageId: pk.id, number: '0528170777', qlNumberId: 9001, sim: '899720201111111111', customerName: 'علاء عدنان' };

  // ----- everything QuickLine checks is checked before the agent pays -----
  const before = (await ok(call(t, 'GET', '/api/me'))).user.balance;
  const bad = async (body, re) => { const r = await call(t, 'POST', '/api/lines', body); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, re); };
  await bad({ ...sale, customerName: '' }, /اسم الزبون/);
  await bad({ ...sale, number: '0521234567' }, /قائمة أرقام QuickLine/);
  await bad({ ...sale, qlNumberId: 9002 }, /قائمة أرقام QuickLine/);
  await bad({ ...sale, sim: '8997202011111111111' }, /18 رقماً وتبدأ بـ 89972020/);
  assert.equal((await ok(call(t, 'GET', '/api/me'))).user.balance, before, 'nothing was charged');
  assert.equal(fake.created.length, 0);

  // ----- a new line on a physical SIM -----
  const r = await ok(call(t, 'POST', '/api/lines', sale));
  assert.equal(r.line.status, 'pending');
  const line = await until(async () => { const l = (await ok(call(t, 'GET', `/api/lines/${r.line.id}`))).line; return l.status === 'active' && l; });
  assert.ok(line.expiresAt > Date.now() + 29 * 864e5);
  assert.equal(fake.created.length, 1, 'sent once');
  const sent = fake.created[0];
  assert.deepEqual(
    [sent.newSubscriptionType, sent.packageId, sent.numberId, sent.simNumber, sent.daysValues, sent.firstName, sent.lastName, sent.phone, sent.oldCompany],
    ['newSubscription', '2564', '9001', '1111111111', 30, 'علاء', 'عدنان', null, null],
    'the SIM goes without the company prefix, as the portal sends it',
  );
  assert.match(sent.startDate, /^\d{2}\/\d{2}\/\d{4}$/);
  const done = (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === r.line.id);
  assert.deepEqual([done.status, done.autoStatus, done.resolvedBy], ['done', 'done', 'QuickLine (تلقائي)']);

  // ----- an eSIM: its number brings its own eSIM, and the QR code reaches the line -----
  const enums = await ok(call(t, 'GET', `/api/quickline/numbers?packageId=${pk.id}&esim=1`));
  assert.deepEqual(enums.map((n) => n.id), [9101]);
  const re = await ok(call(t, 'POST', '/api/lines', { kind: 'new', esim: true, packageId: pk.id, number: '0581112222', qlNumberId: 9101, customerName: 'زبون eSIM' }));
  const esimLine = await until(async () => { const l = (await ok(call(t, 'GET', `/api/lines/${re.line.id}`))).line; return l.status === 'active' && l; });
  assert.equal(esimLine.esimQr, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(esimLine.sim, '899720201234567890');
  assert.deepEqual([fake.created[1].newSubscriptionType, fake.created[1].numberId, fake.created[1].simNumber], ['newEsimSubscription', '9101', '1234567890']);

  // ----- a ported number names the company it leaves -----
  const cos = await ok(call(t, 'GET', '/api/quickline/port-companies'));
  assert.ok(cos.some((c) => c.id === 2 && c.name === 'Golan'));
  const port = { kind: 'new', port: true, packageId: pk.id, number: '0547777777', sim: '899720202222222222', customerName: 'محمد' };
  await bad(port, /الشركة التي يُحوَّل منها/);
  const rp = await ok(call(t, 'POST', '/api/lines', { ...port, qlOldCompany: 2 }));
  await until(async () => (await ok(call(t, 'GET', `/api/lines/${rp.line.id}`))).line.status === 'active');
  assert.deepEqual([fake.created[2].newSubscriptionType, fake.created[2].phone, fake.created[2].oldCompany, fake.created[2].numberId, fake.created[2].lastName],
    ['neyod', '0547777777', 2, null, '']);

  // ----- QuickLine refusing: nothing was activated, the manager refunds, and it is never resent -----
  fake.newAnswer = 'الشريحة مستعملة';
  await ok(call(t, 'GET', `/api/quickline/numbers?packageId=${pk.id}`));
  const rf = await ok(call(t, 'POST', '/api/lines', { ...sale, number: '0584922255', qlNumberId: 9002, sim: '899720203333333333' }));
  const refused = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === rf.line.id && !['', 'sending'].includes(x.autoStatus)));
  assert.deepEqual([refused.status, refused.autoStatus], ['open', 'failed']);
  assert.match(refused.autoNote, /الشريحة مستعملة/);
  assert.match(refused.autoNote, /مستعملان من قبل في QuickLine — جرّب شريحة أو رقماً آخر/);
  // The agent sees a simple state, never the technical note.
  const mine = (await ok(call(t, 'GET', '/api/tasks'))).find((x) => x.id === refused.id);
  assert.equal(mine.autoState, 'review');
  assert.ok(!('autoNote' in mine) && !('autoStatus' in mine));
  const paid = (await ok(call(t, 'GET', '/api/me'))).user.balance;
  await ok(call(admin, 'POST', `/api/tasks/${refused.id}/resolve`, { status: 'rejected', response: 'رفضه QuickLine' }));
  assert.equal((await ok(call(t, 'GET', '/api/me'))).user.balance, Math.round((paid + rf.line.price) * 100) / 100);
  assert.equal(fake.created.length, 4, 'tried once only');
  fake.newAnswer = null;

  // ----- the agent freezes and unfreezes, the manager disconnects: each changes the QuickLine line too -----
  const qlSub = fake.added.find((x) => x.number === '0528170777');
  Object.assign(qlSub, { status: 'فعال', statusInt: 2 });
  const act = (action, who = t) => ok(call(who, 'POST', `/api/lines/${r.line.id}/action`, { action }));
  await act('freeze');
  await until(async () => qlSub.statusInt === 6);
  await act('unfreeze');
  await until(async () => qlSub.statusInt === 2);
  const refusedCut = await call(t, 'POST', `/api/lines/${r.line.id}/action`, { action: 'disconnect' });
  assert.equal(refusedCut.status, 403, 'a final disconnect is for the manager only');
  assert.equal(qlSub.statusInt, 2);
  await act('disconnect', admin);
  await until(async () => qlSub.statusInt === 4);
  assert.deepEqual(fake.stateCalls, [['PauseNumber', qlSub.id, true], ['ActivateNumber', qlSub.id, undefined], ['CloseNumber', qlSub.id, true]]);
  const log = await until(async () => {
    const h = (await ok(call(admin, 'GET', `/api/lines/${r.line.id}`))).history.filter((x) => x.type === 'supplier_sync');
    return h.length === 3 && h;
  });
  assert.match(log[0].detail, /فُصل الرقم نهائياً في QuickLine/);

  // ----- a QuickLine line that QuickLine does not have: the manager is told, nothing is sent -----
  const calls = fake.stateCalls.length;
  fake.added.splice(fake.added.findIndex((x) => x.number === '0547777777'), 1);
  await ok(call(admin, 'POST', `/api/lines/${rp.line.id}/action`, { action: 'disconnect' }));
  const missing = await until(async () => (await ok(call(admin, 'GET', `/api/lines/${rp.line.id}`))).history.find((x) => x.type === 'supplier_sync'));
  assert.match(missing.detail, /غير موجود في QuickLine/);
  assert.equal(fake.stateCalls.length, calls);
});

test('QuickLine: sales by the manager go through QuickLine, renewals fit the line, and nothing is refunded mid-way', async () => {
  const admin = await login('admin', 'admin-pass');
  const t = await login('agent2', 'secret2');
  const cat = (await ok(call(admin, 'GET', '/api/catalog'))).packages;
  const pk = cat.find((p) => p.supplier === 'ql' && p.kind === 'invoice' && p.artCode === '2564');
  const ext = cat.find((p) => p.supplier === 'ql' && p.kind === 'card' && p.artCode === '2564');
  const otherExt = cat.find((p) => p.supplier === 'ql' && p.kind === 'card' && p.artCode === '2587');
  const manualPkg = cat.find((p) => !p.supplier && p.companyId === pk.companyId);
  const agentId = (await ok(call(admin, 'GET', '/api/agents'))).find((a) => a.username === 'agent2').id;

  // ----- the manager sells a QuickLine line: it waits for QuickLine like an agent's -----
  await ok(call(admin, 'GET', `/api/quickline/numbers?packageId=${pk.id}`));
  fake.holdNew = true;
  const sale = await ok(call(admin, 'POST', '/api/lines', { agentId, kind: 'new', packageId: pk.id, number: '0584922255', qlNumberId: 9002, sim: '899720204444444444', customerName: 'زبون المدير' }));
  assert.equal(sale.line.status, 'pending', 'not active before QuickLine has it');
  const task = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === sale.line.id && x.autoStatus === 'sent'));

  // ----- no refund while QuickLine is still carrying it out -----
  const early = await call(admin, 'POST', `/api/tasks/${task.id}/resolve`, { status: 'rejected' });
  assert.equal(early.status, 409);
  fake.added.push({ id: 600001, number: '0584922255', company: 'Cellcom', companyId: 3, packageId: 2564, status: 'فعال', statusInt: 2, canExtend: true, daysLeft: 30, cutDate: '12/11/2026' });
  fake.holdNew = false;
  await until(async () => (await ok(call(admin, 'GET', `/api/lines/${sale.line.id}`))).line.status === 'active');

  // ----- a QuickLine line is extended only by its own package's extension -----
  const line = (await ok(call(t, 'GET', `/api/lines/${sale.line.id}`))).line;
  assert.deepEqual([line.supplier, line.qlPackage], ['ql', 2564]);
  const renew = (packageId) => call(t, 'POST', `/api/lines/${sale.line.id}/renew`, { packageId });
  if (manualPkg) assert.match((await renew(manualPkg.id)).body.error, /خط QuickLine/);
  assert.match((await renew(otherExt.id)).body.error, /خط QuickLine/);
  assert.match((await renew(pk.id)).body.error, /تفعيل خط جديد/);
  const ok1 = await ok(renew(ext.id));
  assert.equal(ok1.pending, true, 'waits for QuickLine');
  await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === sale.line.id && x.type === 'renew' && x.status === 'done'));

  // ----- QuickLine's two systems cannot stand in for each other -----
  assert.match((await call(t, 'POST', '/api/lines', { kind: 'external', packageId: pk.id, number: '0501112233' })).body.error, /تفعيل خط جديد/);
  assert.match((await call(t, 'POST', '/api/lines', { kind: 'new', packageId: ext.id, number: '0501112233', sim: '899720205555555555', customerName: 'س' })).body.error, /رزمة تمديد/);

  // ----- QuickLine unreachable before sending: tried again, sent once -----
  const t1 = await login('agent1', 'secret1');
  const had = new Set((await ok(call(admin, 'GET', '/api/tasks'))).map((x) => x.id));
  const renews = fake.renews.length;
  fake.subsFail = 1;
  await ok(call(t1, 'POST', '/api/lines', { kind: 'external', packageId: ext.id, number: '0524386903' }));
  const retry = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => !had.has(x.id) && x.autoStatus === '' && /يُعاد المحاولة/.test(x.autoNote)));
  assert.equal(fake.renews.length, renews, 'nothing sent yet');
  await require('../src/autoexec').sweep();
  await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.id === retry.id && x.status === 'done'));
  assert.equal(fake.renews.length, renews + 1, 'sent once');

  // ----- a send cut off midway is handed to the manager, never resent -----
  // (a request whose send began 11 minutes ago and never finished, as when the server dies mid-send)
  const { q } = require('../src/db');
  const open = { id: Number(q(`INSERT INTO tasks (type, agent_id, line_id, amount, note, created_at, auto_status, auto_at)
    VALUES ('renew', ?, ?, 10, 'تمديد', ?, 'sending', ?)`).run(agentId, sale.line.id, Date.now() - 11 * 60_000, Date.now() - 11 * 60_000).lastInsertRowid) };
  const sentBefore = fake.renews.length;
  await require('../src/autoexec').sweep();
  const stuck = (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.id === open.id);
  assert.deepEqual([stuck.status, stuck.autoStatus], ['open', 'unknown']);
  assert.equal(fake.renews.length, sentBefore, 'not resent');

  // ----- disconnected while QuickLine still shows the line as «جديد»: nothing is sent until QuickLine activates it -----
  const qlLine = fake.added.find((x) => x.id === 600001);
  Object.assign(qlLine, { status: 'جديد', statusInt: 1 });
  const calls = fake.stateCalls.length;
  await ok(call(admin, 'POST', `/api/lines/${sale.line.id}/action`, { action: 'disconnect' }));
  const waiting = await until(async () => (await ok(call(admin, 'GET', `/api/lines/${sale.line.id}`))).history.find((x) => x.type === 'supplier_sync'));
  assert.match(waiting.detail, /بانتظار أن يفعّل QuickLine الخط/);
  await require('../src/autoexec').sweep();
  assert.equal(fake.stateCalls.length, calls, 'nothing sent while «جديد»');
  Object.assign(qlLine, { status: 'فعال', statusInt: 2 });
  await require('../src/autoexec').sweep();
  assert.deepEqual(fake.stateCalls.slice(calls), [['CloseNumber', 600001, true]]);
  assert.equal(qlLine.statusInt, 4);
  await require('../src/autoexec').sweep();
  assert.equal(fake.stateCalls.length, calls + 1, 'sent once');
});

test('QuickLine: a SIM swap reaches QuickLine, the manager can stop automation, and nothing is resolved or deleted mid-way', async () => {
  const admin = await login('admin', 'admin-pass');
  const t = await login('agent2', 'secret2');
  const pk = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.supplier === 'ql' && p.kind === 'invoice' && p.artCode === '2564');
  const company = () => ok(call(admin, 'GET', '/api/catalog')).then((c) => c.companies.find((x) => x.id === pk.companyId));

  // ----- a company the manager set to "manual" stays manual through a sync -----
  await ok(call(admin, 'PUT', `/api/companies/${pk.companyId}`, { activation: 'manual' }));
  await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'card' }));
  await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'invoice' }));
  assert.equal((await company()).activation, 'manual');
  await ok(call(admin, 'PUT', `/api/companies/${pk.companyId}`, { activation: 'auto' }));

  // ----- a line whose activation QuickLine is still carrying out cannot be deleted -----
  await ok(call(t, 'GET', `/api/quickline/numbers?packageId=${pk.id}`));
  fake.holdNew = true;
  const r = await ok(call(t, 'POST', '/api/lines', { kind: 'new', packageId: pk.id, number: '0528170777', qlNumberId: 9001, sim: '899720207777777777', customerName: 'زبون جديد' }));
  const task = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === r.line.id && x.autoStatus === 'sent'));
  assert.equal((await call(admin, 'DELETE', `/api/lines/${r.line.id}?refund=1`)).status, 409);
  const added = fake.created.at(-1);
  fake.added.unshift({ id: 700001, number: '0528170777', sim: `89972020${added.simNumber}`, company: 'Cellcom', companyId: 3, packageId: 2564, status: 'فعال', statusInt: 2, canExtend: true, daysLeft: 30, cutDate: '12/11/2026' });
  fake.holdNew = false;
  await until(async () => (await ok(call(t, 'GET', `/api/lines/${r.line.id}`))).line.status === 'active');
  assert.equal((await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.id === task.id).status, 'done');

  // ----- a request being sent cannot be carried out by hand at the same moment -----
  const { q } = require('../src/db');
  const agentId = (await ok(call(admin, 'GET', '/api/agents'))).find((a) => a.username === 'agent2').id;
  const sending = Number(q(`INSERT INTO tasks (type, agent_id, line_id, amount, note, created_at, auto_status, auto_at)
    VALUES ('renew', ?, ?, 10, 'تمديد', ?, 'sending', ?)`).run(agentId, r.line.id, Date.now(), Date.now()).lastInsertRowid);
  assert.equal((await call(admin, 'POST', `/api/tasks/${sending}/resolve`, { status: 'done' })).status, 409);
  q("UPDATE tasks SET status = 'rejected', auto_status = 'failed' WHERE id = ?").run(sending);

  // ----- a new SIM goes on the line at QuickLine too, checked against its rule first -----
  const swap = (sim) => call(t, 'POST', `/api/lines/${r.line.id}/action`, { action: 'swap_sim', sim });
  const wrong = await swap('8997202066666666666');
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /18 رقماً/);
  await ok(swap('899720206666666666'));
  await until(async () => fake.added[0].sim === '899720206666666666');
  assert.deepEqual(fake.simCalls, [[700001, '6666666666']], 'without the company prefix, once');
  const logged = await until(async () => (await ok(call(admin, 'GET', `/api/lines/${r.line.id}`))).history.find((x) => x.type === 'supplier_sync' && /الشريحة/.test(x.detail)));
  assert.match(logged.detail, /وُضعت الشريحة 899720206666666666/);

  // ----- packages gone from QuickLine: removed when unused, hidden when a line still uses them -----
  const saved = { 2: PACKAGES[2], 3: PACKAGES[3] };
  PACKAGES[2] = [];
  PACKAGES[3] = PACKAGES[3].filter((x) => x.id !== 2564);
  const sync = await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'invoice' }));
  assert.equal(sync.removed, 1, 'Golan 2505 was not used: removed');
  const after = (await ok(call(admin, 'GET', '/api/catalog'))).packages.filter((x) => x.supplier === 'ql' && x.kind === 'invoice');
  assert.ok(!after.some((x) => x.artCode === '2505'));
  const kept = after.find((x) => x.artCode === '2564');
  assert.equal(kept.active, false, 'lines use 2564: kept, hidden from agents');
  PACKAGES[2] = saved[2];
  PACKAGES[3] = saved[3];

  // ----- the manager's system health -----
  const h = await ok(call(admin, 'GET', '/api/health'));
  assert.equal(h.quickline.balance, -116.67);
  assert.ok(h.quickline.synced > 0);
  assert.equal(h.art, null, 'art-topup not set up here');
  assert.equal(typeof h.tasks.attention, 'number');
  assert.equal(h.qlPending, 0);
  assert.equal((await call(t, 'GET', '/api/health')).status, 403);
});
