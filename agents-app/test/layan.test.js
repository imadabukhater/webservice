'use strict';
// Layan against a fake API that mimics the real one: sign-in with an authenticator code, packages by company (regular
// prices and offers), the dealer's numbers (active and suspended), a price quote, ActivateLine and Extend.
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const SECRET = 'JBSWY3DPEHPK3PXP';
const JWT = 'ly.jwt.token';
const PKG = { cel300: '11111111-1111-1111-1111-111111111111', partner500: '22222222-2222-2222-2222-222222222222' };
const SALE = '33333333-3333-3333-3333-333333333333';
const fake = {
  logins: 0, activated: [], extended: [], quotePlus: 0,
  numbers: [
    { number: '0542791534', sim: '89972010915031422471', company: 'Partner', pkg: 'פרטנר 500 גיגה 2025', status: 'מושהה', end: '20/08/2026 22:21' },
    { number: '0542791535', sim: '89972010915031422472', company: 'Partner', pkg: 'פרטנר 500 גיגה 2025', status: 'מושהה', end: '21/08/2026 22:21' },
    { number: '0544098533', sim: '89972010625030880872', company: 'Cellcom', pkg: 'חבילת 300 גיגה 2026', status: 'מושהה', end: '25/09/2026 14:31' },
  ],
};
const PACKAGES = [
  { company: { id: 'c1', name: 'Cellcom' }, packages: [
    { id: PKG.cel300, name: 'חבילת 300 גיגה 2026', internet: '300', cost: 39, isActive: true, minutes: 3000, messages: 3000, saleId: null, duration: null },
    { id: PKG.cel300, name: 'חבילת 300 גיגה 2026', internet: '300', cost: 99, isActive: true, saleId: SALE, saleName: 'מבצע', duration: 'שלושה חודשים' }] },
  { company: { id: 'c2', name: 'Partner' }, packages: [
    { id: PKG.partner500, name: 'פרטנר 500 גיגה 2025', internet: '500G', cost: 39, isActive: true, saleId: null, duration: null }] },
];
const cost = (number, saleId) => {
  const n = fake.numbers.find((x) => x.number === number);
  const p = PACKAGES.flatMap((g) => g.packages).find((x) => x.name === n.pkg && (x.saleId || null) === (saleId || null));
  return p.cost + fake.quotePlus;
};

const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    const text = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(v); };
    const url = req.url.replace(/^\/api\//, '');
    const f = body ? JSON.parse(body) : {};
    if (url === 'Auth/Login') {
      fake.logins++;
      if (f.username !== 'ahmad.2025' || f.password !== 'pw-1') return text('שם המשתמש או הסיסמה שגויים.', 400);
      return json({ statusCode: 202, data: { requestId: 'r1', verificationMethod: 2 } });
    }
    if (url === 'Auth/VerifyCode') {
      const { totp } = require('../src/layan');
      return f.code === totp(SECRET) && f.requestId === 'r1' ? json({ jwt: JWT, fullName: 'احمد' }) : text('קוד שגוי', 400);
    }
    if (req.headers.authorization !== `Bearer ${JWT}`) return text('unauthorized', 401);
    if (url === 'Index/GetHomePageData') return json(['0', '45', '0', '0', '-58 ₪', '1']);
    if (url === 'Packages/GetPackageDuration') return json([{ name: 'חודש', value: 30 }, { name: 'שלושה חודשים', value: 90 }]);
    if (url === 'Packages/GetPackagesSortedByCompanies/false') return json(PACKAGES);
    if (url === 'Subscribtions/GetSubscribersDT') {
      return json({ data: fake.numbers.map((n, i) => ({ id: `s${i}`, number: n.number, simNumber: n.sim, companyName: n.company,
        status: { name: n.status }, endDate: n.end, package: { name: n.pkg } })) });
    }
    if (url === 'Deals/GetCostBeforeActivate') return json(cost(f.Number, f.SaleId));
    if (url === 'Deals/ActivateLine' || url === 'Deals/Extend') {
      const n = fake.numbers.find((x) => x.number === f.Number);
      (url === 'Deals/ActivateLine' ? fake.activated : fake.extended).push(f);
      Object.assign(n, { status: 'פעיל', end: url === 'Deals/ActivateLine' ? '16/11/2026 10:00' : '16/12/2026 10:00' });
      return text('בוצע בהצלחה');
    }
    return text('not found', 404);
  });
});

let base;
let server;
const call = async (token, method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const ok = async (p) => { const r = await p; assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const login = async (u, p) => (await ok(call(null, 'POST', '/api/login', { username: u, password: p }))).token;
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 60)); }
};

test.before(async () => {
  await new Promise((r) => api.listen(0, r));
  process.env.LY_BASE = `http://127.0.0.1:${api.address().port}`;
  process.env.ART_CHECK_MS = '50';
  process.env.DB_FILE = ':memory:';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); api.close(); });

test('Layan: signs in with its own authenticator code and syncs its new lines (no extensions)', async () => {
  const admin = await login('admin', 'admin-pass');
  // ----- the secret as the authenticator app exports it, stored as a key and never sent back -----
  assert.equal((await call(admin, 'PUT', '/api/settings', { lySecret: 'not a key!' })).status, 400);
  const s = await ok(call(admin, 'PUT', '/api/settings', { lyUser: 'ahmad.2025', lyPass: 'pw-1', lySecret: `otpauth://totp/Layan:ahmad?secret=${SECRET}&issuer=Layan`, lyMarkupInvoice: 10 }));
  assert.deepEqual([s.lyConfigured, s.lyHasSecret], [true, true]);
  assert.ok(!JSON.stringify(s).includes(SECRET) && !JSON.stringify(s).includes('pw-1'), 'secret and password never sent back');
  const chk = await ok(call(admin, 'POST', '/api/layan/check'));
  assert.deepEqual([chk.balance, chk.numbers, chk.suspended], [-58, 3, 3]);

  // ----- sync: Arabic names, regular 30 days and the offer's own period, the percentage on top -----
  assert.equal((await call(admin, 'POST', '/api/layan/sync', { kind: 'card' })).status, 400, 'no extensions');
  const si = await ok(call(admin, 'POST', '/api/layan/sync', { kind: 'invoice' }));
  assert.equal(si.total, 3);
  const cat = (await ok(call(admin, 'GET', '/api/catalog'))).packages.filter((p) => p.supplier === 'ly');
  assert.equal(cat.length, 3);
  const newCel = cat.find((p) => p.days === 30 && /سلكوم 300 جيجا/.test(p.name));
  const offer = cat.find((p) => p.days === 90);
  assert.deepEqual([newCel.cost, newCel.price, offer.cost, offer.price], [39, 42.9, 99, 108.9]);
  assert.match(offer.name, /عرض 90 يوماً/);
  assert.equal(require('../src/db').q("SELECT COUNT(*) AS n FROM packages WHERE art_card_id LIKE 'ly:%'").get().n, 0);
});

test('Layan: a wrong authenticator secret is reported clearly', async () => {
  const admin = await login('admin', 'admin-pass');
  await ok(call(admin, 'PUT', '/api/settings', { lySecret: 'AAAAAAAAAAAAAAAA' }));
  const r = await call(admin, 'POST', '/api/layan/check');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /لم يُقبل رمز المصادقة/);
});
