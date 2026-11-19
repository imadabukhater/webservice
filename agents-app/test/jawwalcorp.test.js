'use strict';
// Direct Jawwal Pay through the MaalCards corporate API, against a fake API that keeps its sign-in rules:
// one seat, a token reused until it ends, 429 token_still_valid while the seat is held, 401 token_revoked.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.SHOP_RESERVE_MS = '3000';
process.env.JC_SKEW_MS = '0';
process.env.ART_CHECK_MS = '50';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fakeQuickLine } = require('./fake-quickline');

const QL = fakeQuickLine(); // the supplier of the eSIMs sold
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 60)); }
};

// ---------- the fake corporate API ----------
const api = {
  signIns: 0, refused: 0, seat: null, invoices: new Map(), n: 0,
  revokeAlways: false, // every request answers token_revoked, even with a new token
  lostAnswer: false, // confirm_payment is carried out but answers 502
  invoicesDown: false, // the invoice list answers 502
  log: [],
};
const CREDS = { manager_id: 173, username: 'corp-test', password: 'p@ss word#1' };
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const fakeApi = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : {};
    api.log.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/api/auth/corporate_sign_in') {
      api.signIns++;
      if (body.manager_id !== CREDS.manager_id || body.username !== CREDS.username || body.password !== CREDS.password) {
        return send(res, 401, { success: false, error: 'invalid_credentials', message: 'wrong' });
      }
      if (api.seat && api.seat.exp > Date.now()) {
        api.refused++;
        return send(res, 429, { success: false, error: 'token_still_valid', retry_after: 120, attempts_left: 2 - api.refused });
      }
      api.seat = { token: `tok-${api.signIns}`, exp: Date.now() + 3600_000 };
      return send(res, 200, { success: true, data: { access_token: api.seat.token, expires_in: 3600, expires_at: new Date(api.seat.exp).toISOString() } });
    }
    const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (api.revokeAlways || !api.seat || auth !== api.seat.token) return send(res, 401, { success: false, error: 'token_revoked' });
    if (url.pathname === '/api/jawwal/corporate/send_otp') {
      const id = `COR-${Date.now()}-${++api.n}`;
      api.invoices.set(id, { id, amount: body.amount, mobile: body.mobile_number, otp: '123456', status: 'pending', exp: Date.now() + 5 * 60_000 });
      return send(res, 200, { success: true, message: 'otp sent', data: { cor_invoice_id: id, expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), amount: body.amount, mobile_number: body.mobile_number } });
    }
    if (url.pathname === '/api/jawwal/corporate/confirm_payment') {
      const inv = api.invoices.get(body.cor_invoice_id);
      if (!inv) return send(res, 404, { success: false, error: 'invoice_not_found' });
      if (inv.status === 'confirmed') return send(res, 409, { success: false, error: 'invoice_confirmed' });
      if (body.otp !== inv.otp) return send(res, 402, { success: false, error: 'jawwal_confirm_failed', data: { failure_code: 'wrong_otp', can_retry: true } });
      inv.status = 'confirmed';
      if (api.lostAnswer) return send(res, 502, { success: false, message: 'bad gateway' });
      return send(res, 200, { success: true, data: { cor_invoice_id: inv.id, status: 'confirmed' } });
    }
    if (url.pathname === '/api/jawwal/corporate/invoices') {
      if (api.invoicesDown) return send(res, 502, {});
      const id = url.searchParams.get('cor_invoice_id');
      const list = [...api.invoices.values()].filter((i) => !id || i.id === id)
        .map((i) => ({ cor_invoice_id: i.id, status: i.status, amount: i.amount, mobile_number: i.mobile }));
      return send(res, 200, { success: true, data: list });
    }
    send(res, 404, { success: false });
  });
});

let base;
let server;
const call = async (token, method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const ok = async (p) => {
  const r = await p;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

test.before(async () => {
  await new Promise((r) => fakeApi.listen(0, '127.0.0.1', r));
  process.env.JC_BASE = `http://127.0.0.1:${fakeApi.address().port}`;
  process.env.QL_BASE = await QL.listen();
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
test.after(() => { server.close(); fakeApi.close(); QL.close(); });

test('direct Jawwal Pay: code, confirmation, token reused, one sign-in on revoke, none before retry_after, unclear answers', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  await ok(call(admin, 'PUT', '/api/settings', { shopEnabled: true, shopHourLimit: 0, jawwalpayNumber: '0599000000' }));
  const esim = await QL.esimPackage(call, ok, admin, 95);

  // Off until the account is saved and turned on.
  assert.equal((await ok(call(null, 'GET', '/api/shop'))).jawwalDirect, false);
  let n = 0;
  const order = async () => ok(call(null, 'POST', '/api/shop/orders', { kind: 'esim', packageId: esim.id, customerName: `زبون ${++n}` }));
  const o0 = await order();
  assert.equal((await call(null, 'POST', `/api/shop/orders/${o0.code}/jawwal/otp`, { mobile: '0599123456' })).status, 403);

  const s = await ok(call(admin, 'PUT', '/api/settings', { jcEnabled: true, jcManagerId: '173', jcUser: CREDS.username, jcPass: CREDS.password }));
  assert.equal(s.jcReady, true);
  assert.equal(s.jcPass, undefined, 'the password never leaves the server');
  assert.equal((await ok(call(null, 'GET', '/api/shop'))).jawwalDirect, true);
  assert.equal((await call(admin, 'PUT', '/api/settings', { jcManagerId: 'abc' })).status, 400);

  // ----- a code, a wrong code, the right code: paid and carried out -----
  const o1 = await order();
  assert.equal((await call(null, 'POST', `/api/shop/orders/${o1.code}/jawwal/otp`, { mobile: '12345' })).status, 400);
  assert.equal((await call(null, 'POST', `/api/shop/orders/${o1.code}/jawwal/confirm`, { otp: '123456' })).status, 400, 'no code asked yet');
  let v = await ok(call(null, 'POST', `/api/shop/orders/${o1.code}/jawwal/otp`, { mobile: '+970 599-123-456' }));
  assert.equal(api.signIns, 1);
  assert.equal(v.status, 'awaiting_payment');
  assert.equal(v.jawwal.otpSent, true);
  assert.equal(v.jawwal.mobile, '059••••456', 'the mobile is partly hidden');
  assert.equal(v.jawwal.invoiceId, undefined, 'the invoice id stays on the server');
  const inv1 = [...api.invoices.values()].at(-1);
  assert.equal(inv1.amount, 95, 'the order amount is charged');
  assert.equal(inv1.mobile, '0599123456');
  assert.equal((await call(null, 'POST', `/api/shop/orders/${o1.code}/jawwal/otp`, { mobile: '0599123456' })).status, 429, 'a new code waits 45 seconds');

  let r = await call(null, 'POST', `/api/shop/orders/${o1.code}/jawwal/confirm`, { otp: '000000' });
  assert.equal(r.status, 402);
  assert.equal((await ok(call(null, 'GET', `/api/shop/orders/${o1.code}`))).status, 'awaiting_payment', 'a refused code leaves the order waiting');
  v = await ok(call(null, 'POST', `/api/shop/orders/${o1.code}/jawwal/confirm`, { otp: '١٢٣٤٥٦' }));
  assert.equal(v.status, 'paid');
  await until(async () => (await ok(call(null, 'GET', `/api/shop/orders/${o1.code}`))).stage === 'done');
  assert.equal(api.signIns, 1, 'one token for everything');
  const ad = (await ok(call(admin, 'GET', '/api/shop/admin/orders'))).find((o) => o.code === o1.code);
  assert.match(ad.verifiedBy, /^جوال باي مباشر: COR-/);
  assert.equal(ad.jawwal.mobile, '0599123456');
  // Confirming again changes nothing.
  assert.equal((await ok(call(null, 'POST', `/api/shop/orders/${o1.code}/jawwal/confirm`, { otp: '123456' }))).status, 'paid');

  // ----- the token survives: the next order signs in no more -----
  const o2 = await order();
  await ok(call(null, 'POST', `/api/shop/orders/${o2.code}/jawwal/otp`, { mobile: '0599123457' }));
  assert.equal(api.signIns, 1);

  // ----- revoked (another seat took it): one sign-in, the request once more -----
  api.seat = null;
  const o3 = await order();
  await ok(call(null, 'POST', `/api/shop/orders/${o3.code}/jawwal/otp`, { mobile: '0599123458' }));
  assert.equal(api.signIns, 2);

  // ----- still revoked after signing in again: no loop, one sign-in only -----
  api.revokeAlways = true;
  api.seat = null;
  const o4 = await order();
  r = await call(null, 'POST', `/api/shop/orders/${o4.code}/jawwal/otp`, { mobile: '0599123459' });
  assert.equal(r.status, 503);
  assert.equal(api.signIns, 3, 'exactly one more sign-in');
  api.revokeAlways = false;

  // ----- the token lost here while the seat is still held: refused once, then nothing until retry_after -----
  require('../src/jawwalcorp')._forget();
  const o5 = await order();
  r = await call(null, 'POST', `/api/shop/orders/${o5.code}/jawwal/otp`, { mobile: '0599123460' });
  assert.equal(r.status, 503);
  assert.equal(api.signIns, 4);
  assert.equal(api.refused, 1);
  const o6 = await order();
  r = await call(null, 'POST', `/api/shop/orders/${o6.code}/jawwal/otp`, { mobile: '0599123461' });
  assert.equal(r.status, 503);
  assert.equal(api.signIns, 4, 'no sign-in before retry_after (a second refusal would block the account)');
  const st = await ok(call(admin, 'GET', '/api/shop/admin/jawwal/status'));
  assert.equal(st.waitCode, 'token_still_valid');
  assert.ok(st.waitUntil > Date.now() + 100_000);
  // The seat freed (as retry_after said): signing in works again.
  const { setSetting } = require('../src/db');
  setSetting('jc_wait_until', 0);
  api.seat = null;
  const t = await ok(call(admin, 'POST', '/api/shop/admin/jawwal/test'));
  assert.equal(t.ok, true);
  assert.equal(api.signIns, 5);

  // ----- no clear answer to a confirmation: the invoice says it went through -----
  const o7 = await order();
  await ok(call(null, 'POST', `/api/shop/orders/${o7.code}/jawwal/otp`, { mobile: '0599123462' }));
  api.lostAnswer = true;
  v = await ok(call(null, 'POST', `/api/shop/orders/${o7.code}/jawwal/confirm`, { otp: '123456' }));
  assert.equal(v.status, 'paid', 'paid once, found from the invoice');

  // ----- no answer and the invoice list down too: checked again later, never offered to pay twice -----
  const o8 = await order();
  await ok(call(null, 'POST', `/api/shop/orders/${o8.code}/jawwal/otp`, { mobile: '0599123463' }));
  api.invoicesDown = true;
  r = await call(null, 'POST', `/api/shop/orders/${o8.code}/jawwal/confirm`, { otp: '123456' });
  assert.equal(r.status, 502);
  v = await ok(call(null, 'GET', `/api/shop/orders/${o8.code}`));
  assert.equal(v.status, 'awaiting_payment');
  assert.equal(v.jawwal.checking, true);
  assert.equal((await call(null, 'POST', `/api/shop/orders/${o8.code}/cancel`)).status, 409, 'not cancelled while the payment is checked');
  assert.equal((await call(null, 'POST', `/api/shop/orders/${o8.code}/jawwal/otp`, { mobile: '0599123463' })).status, 409, 'no new code either');
  api.invoicesDown = false;
  api.lostAnswer = false;
  assert.equal(await require('../src/shop').reconcileDirect({ force: true }), 1);
  v = await ok(call(null, 'GET', `/api/shop/orders/${o8.code}`));
  assert.equal(v.status, 'paid');
  assert.equal(v.jawwal.checking, false);
  assert.equal([...api.invoices.values()].filter((i) => i.status === 'confirmed').length, 3, 'three payments taken, each once');

  // ----- a code still valid keeps the order past its 5-minute hold; one without a code is cancelled -----
  const o9 = await order();
  const o10 = await order();
  await ok(call(null, 'POST', `/api/shop/orders/${o9.code}/jawwal/otp`, { mobile: '0599123464' }));
  await new Promise((res) => setTimeout(res, 3200));
  assert.equal((await ok(call(null, 'GET', `/api/shop/orders/${o9.code}`))).status, 'awaiting_payment');
  assert.equal((await ok(call(null, 'GET', `/api/shop/orders/${o10.code}`))).status, 'cancelled');
  assert.equal((await ok(call(null, 'POST', `/api/shop/orders/${o9.code}/jawwal/confirm`, { otp: '123456' }))).status, 'paid');

  // Never a refresh, and only the four paths.
  assert.ok(api.log.every((l) => /^(POST \/api\/auth\/corporate_sign_in|POST \/api\/jawwal\/corporate\/(send_otp|confirm_payment)|GET \/api\/jawwal\/corporate\/invoices)$/.test(l)), api.log.join('\n'));
});
