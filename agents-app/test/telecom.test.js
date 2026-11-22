'use strict';
// telecom.co.il against a fake site that answers like the real one: verifyLogin refreshes to /VVC, /CVC takes the
// e-mailed 5-digit code, a page without a signed-in session redirects to /login; packages by company (regular and
// offers), the subscribers list, a subscriber's page (its package, end date, price) and renewPhoneLineNew.
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const site = {
  code: '', signedIn: new Set(), logins: 0, codesAsked: 0, renewed: [], refuse: '', events: [],
  leads: [
    { id: 465562, number: '0554661392', company: 'rami-levi', status: 'פעיל', campaign: 719, end: '23/10/2026', price: '35.64', special: '0' },
    { id: 466834, number: '0515316032', company: 'we4g', status: 'פעיל', campaign: 853, end: '01/01/2027', price: '27.00', special: '0' },
    { id: 425872, number: '0555623670', company: 'rami-levi', status: 'ניתוק קבוע', campaign: 719, end: '24/04/2026', price: '35.64', special: '0' },
  ],
};
const PACKAGES = {
  'rami-levi': {
    data: [{ campaignId: '719', campaignName: 'Rami Levi  200GB 5G', SPrice: '35.64', CPrice: '60.00', view_gb: '200', view_minutes: '2000', view_sms: '0', campaignSpecialMonths: '0' }],
    offer_data: [{ campaignId: '728', campaignName: 'Rami Levi  200GB 3M', SPrice: '99.00', CPrice: '150.00', view_gb: '200', view_minutes: '2000', campaignSpecialMonths: '3' }],
  },
  we4g: { data: [{ campaignId: '853', campaignName: 'Wecom 500GB', SPrice: '27.00', CPrice: '60.00', view_gb: '500', view_minutes: '3000', campaignSpecialMonths: '0' }], offer_data: [] },
};
const addMonth = (d) => { const [dd, mm, yy] = d.split('/').map(Number); const t = new Date(Date.UTC(yy, mm, dd)); return `${String(t.getUTCDate()).padStart(2, '0')}/${String(t.getUTCMonth() + 1).padStart(2, '0')}/${t.getUTCFullYear()}`; };

let BASE;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const sid = /PHPSESSID=(\w+)/.exec(req.headers.cookie || '')?.[1];
    const form = Object.fromEntries(new URLSearchParams(body));
    const u = new URL(req.url, 'http://x');
    const json = (v) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (u.pathname === '/login') {
      res.writeHead(200, { 'Set-Cookie': `PHPSESSID=s${Date.now()}${Math.random().toString(36).slice(2, 6)}; path=/; HttpOnly` });
      return res.end('<form action="/login/verifyLogin">');
    }
    if (u.pathname === '/login/verifyLogin') {
      site.logins++;
      site.events.push('login');
      if (form.email !== 'dealer@example.com' || form.password !== 'tc-pass') { res.writeHead(200, { Refresh: '0;url=http://x/login' }); return res.end(); }
      site.code = String(10000 + site.logins);
      site.codesAsked++;
      res.writeHead(200, { Refresh: `0;url=${BASE}/VVC` });
      return res.end();
    }
    if (u.pathname === '/VVC') { res.writeHead(200); return res.end('<h2>קוד אימות</h2>'); }
    if (u.pathname === '/CVC') {
      const ok = form.code === site.code;
      if (ok) site.signedIn.add(sid);
      return json({ result: ok, path: ok ? `${BASE}/app/welcome` : '' });
    }
    if (!site.signedIn.has(sid)) { res.writeHead(302, { Location: `${BASE}/login` }); return res.end(); }
    if (u.pathname === '/app/dashboard') { res.writeHead(200); return res.end('<p class="font-lg"><i>₪</i>קרדיט\n\t\t86.48\t</p>'); }
    if (u.pathname === '/app/ajax/getRentPaidPackagesNew') return json(PACKAGES[form.company] ? { result: true, ...PACKAGES[form.company] } : { result: false });
    if (u.pathname === '/app/ajax/getDataForLeadsTable') {
      return json({ draw: 1, recordsTotal: site.leads.length, data: site.leads.map((l) => [
        `<label class="checkbox"><input class="leadCB" type="checkbox" name="selectedLeads[]" value="${l.id}" /><i></i></label>`, ' ', l.number, l.company,
        `<span class="label status">${l.status}</span>`, l.end]) });
    }
    const view = /^\/app\/leads\/viewLead\/(\d+)$/.exec(u.pathname);
    if (view) {
      const l = site.leads.find((x) => x.id === Number(view[1]));
      res.writeHead(200);
      return res.end(`<input type="tel" name="phone" id="leadPhone" value="${l.number}" disabled="disabled">
        <input type="hidden" value="${l.price}" readonly id="supplier_price" /><input type="hidden" value="${l.special}" readonly id="special_date" />
        <input type="hidden" value="0" readonly id="special_date_days" /><input type="hidden" value="0" readonly id="priceSpecial" />
        <input type="hidden" class="datepicker" value="${l.end}" name="serviceEndDate" id="serviceEndDate" />
        <input type="hidden" id="lineProvider" value="${l.company}" /><input type="hidden" id="curr_campaignId" value="${l.campaign} " />`);
    }
    if (u.pathname === '/app/ajax/renewPhoneLineNew') {
      site.renewed.push(form);
      if (site.refuse) return json({ result: false, msg: site.refuse });
      const l = site.leads.find((x) => x.id === Number(form.leadId));
      if (form.renew_type === '1_month') l.end = addMonth(l.end);
      return json({ result: true });
    }
    res.writeHead(404);
    res.end();
  });
});

let base;
let app;
let tc;
const asks = [];
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
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.TC_BASE = BASE;
  process.env.ART_CHECK_MS = '50';
  process.env.DB_FILE = ':memory:';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  tc = require('../src/telecom');
  // The mailbox: marked before the site is asked for a code; the code is what the fake site sent.
  tc._deps.mailMark = async (mail) => { site.events.push('mark'); return { uid: 100 + site.events.length, at: Date.now(), mail }; };
  tc._deps.waitForCode = async (mail, mark, options) => { asks.push({ mail, mark, options }); return site.code; };
  ({ server: app } = require('../server'));
  await new Promise((r) => app.listen(0, r));
  base = `http://127.0.0.1:${app.address().port}`;
});
test.after(() => { app.close(); server.close(); });

const creds = { user: 'dealer@example.com', pass: 'tc-pass', mail: { user: 'box@gmail.com', pass: 'app-pass' } };

test('signs in with the e-mailed code and keeps the session; an ended one signs in again once', async () => {
  const r = await tc.check(creds);
  assert.deepEqual(r, { balance: 86.48, subscribers: 3, active: 2 });
  assert.deepEqual(asks[0].mail, creds.mail);
  assert.deepEqual(site.events.slice(0, 2), ['mark', 'login'], 'the mailbox is marked before the code is asked for');
  assert.equal(asks[0].mark.uid, 101, 'the code is looked for after that mark');
  assert.deepEqual(asks[0].options, { digits: 5 });
  const before = site.logins;
  await tc.leads(creds);
  assert.equal(site.logins, before, 'no new sign-in while the session lasts');
  site.signedIn.clear();
  await tc.leads(creds);
  assert.equal(site.logins, before + 1);
});

test('two requests at once ask for one code, not two', async () => {
  tc._session.key = '';
  site.signedIn.clear();
  const before = site.codesAsked;
  await Promise.all([tc.leads(creds), tc.balance(creds)]);
  assert.equal(site.codesAsked, before + 1);
});

test('a wrong password or a wrong code is refused with a clear message', async () => {
  await assert.rejects(tc.check({ ...creds, pass: 'nope' }), (e) => e.refused && /رفض الدخول/.test(e.message));
  const real = tc._deps.waitForCode;
  tc._deps.waitForCode = async () => '00000';
  await assert.rejects(tc.check(creds), (e) => e.refused && /لم يقبل رمز التحقق/.test(e.message));
  tc._deps.waitForCode = real;
  await assert.rejects(tc.check({ ...creds, user: '' }), /أدخل بريد telecom/);
});

test('through the app: sync its new lines (no extensions)', async () => {
  const admin = await login('admin', 'admin-pass');
  const s = await ok(call(admin, 'PUT', '/api/settings', {
    tcUser: 'dealer@example.com', tcPass: 'tc-pass', tcMailUser: 'box@gmail.com', tcMailPass: 'app-pass',
  }));
  assert.deepEqual([s.tcReady, s.tcMarkupInvoice, s.tcMarkupCard], [true, undefined, undefined]);
  assert.deepEqual(await ok(call(admin, 'POST', '/api/telecom/check')), { ok: true, balance: 86.48, subscribers: 3, active: 2 });

  // ----- sync: new lines, the offers for their months -----
  assert.equal((await call(admin, 'POST', '/api/telecom/sync', { kind: 'card' })).status, 400, 'no extensions');
  const si = await ok(call(admin, 'POST', '/api/telecom/sync', { kind: 'invoice' }));
  assert.equal(si.total, 3);
  // The catalog lists telecom's ALOHA eSIMs only (its other companies are lines on a SIM card).
  const { q } = require('../src/db');
  assert.ok(!(await ok(call(admin, 'GET', '/api/catalog'))).packages.some((p) => p.supplier === 'tc' && p.companyName !== 'ALOHA'));
  const byRef = (ref) => q("SELECT * FROM packages WHERE art_card_id LIKE ?").get(`${ref}%`);
  const newRami = byRef('tcn:719:');
  const offer = byRef('tcn:728:');
  assert.deepEqual([newRami.cost, offer.cost, offer.days, newRami.shop_price], [35.64, 99, 90, null]);
  assert.match(newRami.name, /رامي ليفي 200 جيجا 5G/);
  assert.match(offer.name, /عرض 3 أشهر/);
  // A second sync adds nothing and keeps the prices.
  assert.deepEqual((await ok(call(admin, 'POST', '/api/telecom/sync', { kind: 'invoice' }))).added, 0);
  assert.equal(require('../src/db').q("SELECT COUNT(*) AS n FROM packages WHERE art_card_id LIKE 'tc:%'").get().n, 0);
});
