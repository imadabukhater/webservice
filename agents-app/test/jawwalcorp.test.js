'use strict';
// Direct Jawwal Pay through the MaalCards corporate API, against a fake API that keeps its sign-in rules:
// one seat, a token reused until it ends, 429 token_still_valid while the seat is held, 401 token_revoked.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.SHOP_RESERVE_MS = '3000';
process.env.JC_SKEW_MS = '0';
process.env.JC_SETTLE_MS = '20'; // /settle asked again a moment later (3 seconds live)
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
  listAmountDelta: 0, // the invoice list shows a different amount than was charged
  failNoRetry: false, // confirm_payment refuses for good (e.g. not enough balance)
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
      if (api.sendAs) return send(res, api.sendAs.status, { success: false, error: api.sendAs.error, message: api.sendAs.message || '' });
      if (body.bank && !['PALS', 'JWLP'].includes(body.bank)) return send(res, 400, { success: false, code: 'invalid_bank' });
      if (body.bank === 'PALS' && body.mobile_number === api.notAtBank) return send(res, 422, { success: false, code: '14', message: 'not registered' });
      if (body.mobile_number === api.notJawwalPay) return send(res, 422, { success: false, error: 'jawwal_send_otp_failed', message: 'mobile is not a jawwal pay wallet' });
      const id = `COR-${Date.now()}-${++api.n}`;
      api.invoices.set(id, { id, amount: body.amount, mobile: body.mobile_number, bank: body.bank || '', otp: '123456', status: 'pending', exp: Date.now() + 5 * 60_000 });
      return send(res, 200, { success: true, message: 'otp sent', data: { cor_invoice_id: id, expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), amount: body.amount, mobile_number: body.mobile_number } });
    }
    if (url.pathname === '/api/jawwal/corporate/confirm_payment') {
      const inv = api.invoices.get(body.cor_invoice_id);
      if (!inv) return send(res, 404, { success: false, error: 'invoice_not_found' });
      if (inv.status === 'confirmed') return send(res, 409, { success: false, error: 'invoice_confirmed' });
      if (inv.status === 'expired' || inv.exp < Date.now()) { inv.status = 'expired'; return send(res, 409, { success: false, error: 'invoice_expired' }); }
      if (api.failNoRetry) { inv.status = 'failed'; return send(res, 402, { success: false, error: 'jawwal_confirm_failed', data: { failure_code: 'insufficient_balance', can_retry: false } }); }
      if (api.confirmLater && body.otp === inv.otp) { inv.status = 'confirmed'; return send(res, 409, { success: false, code: 'esdad_payment_not_confirmed', message: 'x' }); }
      if (api.confirmAs) return send(res, api.confirmAs.status, { success: false, error: api.confirmAs.error, message: api.confirmAs.message || '' });
      if (body.otp !== inv.otp && api.wrongOtpAs) return send(res, api.wrongOtpAs.status, { success: false, error: api.wrongOtpAs.error, message: 'otp is invalid' });
      if (body.otp !== inv.otp) return send(res, 402, { success: false, error: 'jawwal_confirm_failed', data: { failure_code: 'wrong_otp', can_retry: true } });
      inv.status = 'confirmed';
      if (api.lostAnswer) return send(res, 502, { success: false, message: 'bad gateway' });
      return send(res, 200, { success: true, data: { cor_invoice_id: inv.id, status: 'confirmed' } });
    }
    if (url.pathname === '/api/jawwal/corporate/settle') {
      if (api.invoicesDown) return send(res, 502, {});
      const inv = api.invoices.get(body.cor_invoice_id);
      if (!inv) return send(res, 404, { success: false, error: 'invoice_not_found' });
      if (inv.status === 'confirmed') return send(res, 200, { success: true, data: { cor_invoice_id: inv.id, status: 'confirmed', amount: inv.amount, mobile_number: inv.mobile, paid_via: 'sadad_gate' } });
      if (inv.status === 'expired') return send(res, 409, { success: false, error: 'invoice_expired' });
      return send(res, 409, { success: false, code: 'esdad_payment_not_confirmed', message: 'لم يصل تأكيد الدفع من بوابة سداد بعد' });
    }
    if (url.pathname === '/api/jawwal/corporate/invoices') {
      if (api.invoicesDown) return send(res, 502, {});
      if (api.listShape === 'paged') {
        // Another shape: a page object, the id as invoice_id, «paid», and the id filter not applied.
        const all = [...api.invoices.values()].reverse().map((i) => ({ invoice_id: i.id, state: i.status === 'confirmed' ? 'paid' : i.status, amount: String(i.amount), mobile: i.mobile }));
        return send(res, 200, { success: true, data: { invoices: { data: all, total: all.length, current_page: 1 } } });
      }
      const id = url.searchParams.get('cor_invoice_id');
      const list = [...api.invoices.values()].filter((i) => !id || i.id === id)
        .map((i) => ({ cor_invoice_id: i.id, status: i.status, amount: i.amount + api.listAmountDelta, mobile_number: i.mobile }));
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

  // Never a refresh, and only the documented paths.
  assert.ok(api.log.every((l) => /^(POST \/api\/auth\/corporate_sign_in|POST \/api\/jawwal\/corporate\/(send_otp|confirm_payment|settle)|GET \/api\/jawwal\/corporate\/invoices)$/.test(l)), api.log.join('\n'));
});

test('paid only once the invoice, read on its own, is confirmed for the order: success, mismatch, expired, failed, duplicate, logged without the OTP', async () => {
  const { q } = require('../src/db');
  const S = require('../src/shop');
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  require('../src/db').setSetting('jc_wait_until', 0);
  require('../src/routes/shop')._resetThrottle(); // one machine plays every customer here
  const esim = await QL.esimPackage(call, ok, admin, 70);
  let n = 0;
  const order = async () => ok(call(null, 'POST', '/api/shop/orders', { kind: 'esim', packageId: esim.id, customerName: `دفع ${++n}` }));
  const otp = (o, mobile) => ok(call(null, 'POST', `/api/shop/orders/${o.code}/jawwal/otp`, { mobile }));
  const confirm = (o, code = '123456') => call(null, 'POST', `/api/shop/orders/${o.code}/jawwal/confirm`, { otp: code });
  const row = (o) => q('SELECT * FROM shop_orders WHERE code = ?').get(o.code);
  const logOf = (o) => q('SELECT event, status, detail FROM jc_log WHERE order_id = ? ORDER BY id').all(row(o).id);

  // Success: confirm says yes, the invoice list is read and agrees (confirmed, 70 ₪, the same mobile): paid once.
  const a = await order();
  await otp(a, '0599200001');
  assert.equal(row(a).jc_status, 'pending');
  const before = api.log.filter((l) => l.startsWith('GET')).length;
  assert.equal((await confirm(a)).body.status, 'paid');
  assert.ok(api.log.filter((l) => l.startsWith('GET')).length > before, 'the invoice list was asked after confirming');
  assert.equal(row(a).jc_status, 'confirmed');
  assert.deepEqual(logOf(a).map((l) => l.event), ['otp_sent', 'confirm_ok', 'verified', 'paid']);
  assert.equal(JSON.stringify(logOf(a)).includes('123456'), false, 'the OTP is never logged');
  // Duplicate: confirming again neither pays nor carries it out twice.
  assert.equal((await confirm(a)).body.status, 'paid');
  assert.equal(logOf(a).filter((l) => l.event === 'paid').length, 1);
  const detail = await ok(call(admin, 'GET', `/api/shop/admin/orders/${row(a).id}`));
  assert.equal(detail.jawwal.status, 'confirmed');
  assert.equal(detail.jawwalLog.length, 4, 'the manager sees the log');

  // The invoice says another amount than the order: confirmed by the API, but nothing is carried out; the manager is told.
  const b = await order();
  await otp(b, '0599200002');
  api.listAmountDelta = -10;
  const rb = await confirm(b);
  api.listAmountDelta = 0;
  assert.equal(rb.body.status, 'awaiting_payment');
  assert.match(row(b).error, /لا تطابق الطلب/);
  assert.equal(logOf(b).at(-1).event, 'mismatch');
  assert.ok(q('SELECT 1 FROM notifications WHERE title = ?').get(`فاتورة جوال باي لا تطابق الطلب ${b.code}`));

  // Expired invoice: 410, its state kept, not paid.
  const c = await order();
  await otp(c, '0599200003');
  [...api.invoices.values()].at(-1).exp = Date.now() - 1;
  assert.equal((await confirm(c)).status, 410);
  assert.equal(row(c).jc_status, 'expired');
  assert.equal(row(c).status, 'awaiting_payment');

  // Refused for good (not enough balance): 402, failed, a new code needed.
  const d = await order();
  await otp(d, '0599200004');
  api.failNoRetry = true;
  const rd = await confirm(d);
  api.failNoRetry = false;
  assert.equal(rd.status, 402);
  assert.equal(row(d).jc_status, 'failed');
  assert.match(logOf(d).at(-1).detail, /insufficient_balance/);
  assert.equal((await confirm(d)).status, 410, 'that code cannot be used again');

  // Confirm says yes but the invoice list cannot be read: success means confirmed (the guide) — paid at once, once.
  const e = await order();
  await otp(e, '0599200005');
  api.invoicesDown = true;
  const re = await confirm(e);
  api.invoicesDown = false;
  assert.equal(re.body.status, 'paid');
  assert.equal(await S.reconcileDirect({ force: true }), 0, 'nothing left to look up');
  assert.equal(logOf(e).filter((l) => l.event === 'paid').length, 1);
});

test('the manager stops or allows paying by transfer (e-mail): never both ways off', async () => {
  require('../src/routes/shop')._resetThrottle();
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  const esim = await QL.esimPackage(call, ok, admin, 60);
  assert.equal((await ok(call(null, 'GET', '/api/shop'))).manualPay, true, 'on by default');
  // Off (direct payment is on): the shop offers no transfer, and a transfer's details are not taken for a new order.
  let s = await ok(call(admin, 'PUT', '/api/settings', { mailPay: false }));
  assert.equal(s.mailPay, false);
  assert.equal((await ok(call(null, 'GET', '/api/shop'))).manualPay, false);
  const o = await ok(call(null, 'POST', '/api/shop/orders', { kind: 'esim', packageId: esim.id, customerName: 'بلا تحويل' }));
  const r = await call(null, 'POST', `/api/shop/orders/${o.code}/proof`, { payName: 'محمد احمد' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /التحويل اليدوي متوقف/);
  // Direct payment cannot be turned off now: the customers would have no way to pay.
  const both = await call(admin, 'PUT', '/api/settings', { jcEnabled: false });
  assert.equal(both.status, 400);
  assert.match(both.body.error, /معاً/);
  assert.equal((await ok(call(null, 'GET', '/api/shop'))).jawwalDirect, true);
  // On again: the transfer is taken as before.
  s = await ok(call(admin, 'PUT', '/api/settings', { mailPay: true }));
  assert.equal(s.mailPay, true);
  assert.equal((await ok(call(null, 'POST', `/api/shop/orders/${o.code}/proof`, { payName: 'محمد احمد' }))).status, 'verifying');
  // Without direct payment, the e-mail way cannot be stopped.
  await ok(call(admin, 'PUT', '/api/settings', { jcEnabled: false }));
  const lone = await call(admin, 'PUT', '/api/settings', { mailPay: false });
  assert.equal(lone.status, 400);
  assert.equal((await ok(call(admin, 'GET', '/api/settings'))).mailPay, true);
  await ok(call(admin, 'PUT', '/api/settings', { jcEnabled: true }));
});

test('WhatsApp: the whole payment in the chat — the number, the code texted, the code sent back, paid; the code never kept', async () => {
  require('../src/routes/shop')._resetThrottle();
  require('../src/db').setSetting('jc_wait_until', 0);
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  const esim = await QL.esimPackage(call, ok, admin, 125);
  const wa = require('../src/whatsapp');
  const sent = [];
  wa._test.setTransport(async (jid, content) => { sent.push({ jid, ...content }); });
  const jid = '972599300001@s.whatsapp.net';
  const said = () => sent.filter((m) => m.jid === jid).map((m) => m.text || m.caption || '').join('\n---\n');
  const S = require('../src/routes/shop');
  const v = await S.createOrder({ packageId: esim.id, kind: 'esim', esim: true, includeEsimFee: true, customerName: 'عماد' }, { ip: `wa:${jid}`, clientId: `wa:${jid}` });
  const o = S.byCode(v.code);
  // After the order: what to send, to pay here (never the site).
  const facts = wa._test.orderFacts ? wa._test.orderFacts(o, S.shopCatalogResponse()) : '';
  assert.match(facts, /1️⃣ ابعتلي \*رقم جوالك\*[\s\S]*2️⃣[\s\S]*3️⃣/, 'the payment explained first');
  assert.match(facts, /بندعم الدفع من \*جوال باي\* و\*بنك فلسطين\* بس/);
  assert.doesNotMatch(facts, /#\/order\/|نفس الرقم/);
  const invoicesBefore = api.invoices.size;
  // A number not on Jawwal Pay: asked to confirm, then the API cannot text it — said so, with what is supported.
  assert.equal(await wa._test.payHere(jid, '0599300999', '0599300001'), true);
  assert.match(said(), /رح نبعت رمز التحقق على الرقم: \*0599300999\*\nمن وين بدك تدفع؟\n1️⃣ محفظة \*جوال باي\*\n2️⃣ \*بنك فلسطين\*/);
  assert.equal(api.invoices.size, invoicesBefore, 'nothing sent before the yes');
  api.notJawwalPay = '0599300999';
  assert.equal(await wa._test.payHere(jid, 'نعم', '0599300001'), true);
  assert.match(said(), /ما قدرنا نبعت رمز على الرقم \*0599300999\* — غالباً مش مسجّل بجوال باي[\s\S]*محفظة \*جوال باي\* أو \*بنك فلسطين\*/);
  require('../src/db').q('UPDATE shop_orders SET jc_sent_at = NULL WHERE id = ?').run(o.id); // past the 45 seconds between codes
  // The right number, confirmed: the code is texted to it.
  await wa._test.payHere(jid, 'رقمي 0599300001', '0599300001');
  assert.equal(await wa._test.payHere(jid, 'نعم', '0599300001'), true);
  assert.match(said(), /✅ بعتنالك رمز تحقق برسالة على \*059••••001\* لدفع \*\d+ ₪\*[\s\S]*عشان أتمم عملية الدفع/);
  const inv = [...api.invoices.values()].at(-1);
  assert.equal(inv.mobile, '0599300001');
  // A wrong code: «wrong», how long it still lasts and the tries left; the right one: paid, said here.
  wa._test.recent.clear();
  await wa.handle({ jid, phone: '0599300001', text: '000000' });
  assert.match(said(), /❌ الرمز غلط\. ابعتلي الرمز الصحيح خلال \d+ (دقايق|ثانية) \(بقيلك 4 محاولات\)/);
  // Refused with another code than documented (here 422 invalid_otp): still «wrong code», never «unreachable».
  api.wrongOtpAs = { status: 422, error: 'invalid_otp' };
  wa._test.recent.clear();
  await wa.handle({ jid, phone: '0599300001', text: '111111' });
  api.wrongOtpAs = null;
  assert.match(said().split('---').at(-1), /❌ الرمز غلط.*بقيلك 3 محاولات/);
  assert.doesNotMatch(said(), /تعذّر الوصول/);
  wa._test.recent.clear();
  await wa.handle({ jid, phone: '0599300001', text: 'الرمز ١٢٣٤٥٦' });
  assert.match(said(), /✅ تم الدفع لطلبك \*[A-Z0-9]+\*/);
  assert.equal(S.byCode(o.code).status, 'paid');
  assert.equal(inv.status, 'confirmed');
  // The code was never kept in the conversation (so never given to Gemini).
  const hist = JSON.stringify(wa._test.history.get(jid) || []);
  assert.equal(hist.includes('123456') || hist.includes('١٢٣٤٥٦') || hist.includes('000000'), false, hist);
  assert.match(hist, /\[رمز التحقق\]/);
  // Paid: a number or a code now is the assistant's to answer (nothing taken twice).
  assert.equal(wa._test.payState(jid), null);
});

test('MaalCards\' own link to Jawwal Pay failing (esdad_…): the provider\'s fault, never the customer\'s; a payment it cannot confirm is looked up', async () => {
  require('../src/routes/shop')._resetThrottle();
  require('../src/db').setSetting('jc_wait_until', 0);
  const { q } = require('../src/db');
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  const esim = await QL.esimPackage(call, ok, admin, 45);
  const order = async () => ok(call(null, 'POST', '/api/shop/orders', { kind: 'esim', packageId: esim.id, customerName: 'سداد' }));
  // Sending: 422 esdad_not_wired — not «your number is not on Jawwal Pay»; the manager is told.
  const a = await order();
  api.sendAs = { status: 422, error: 'esdad_not_wired', message: "DirectPay replay step 'submit_identifier/otp-form' is not wired yet" };
  const r1 = await call(null, 'POST', `/api/shop/orders/${a.code}/jawwal/otp`, { mobile: '0599400001' });
  api.sendAs = null;
  assert.equal(r1.status, 503);
  assert.match(r1.body.error, /متوقف مؤقتاً عند مزوّد الدفع/);
  assert.doesNotMatch(r1.body.error, /مفعّل عليه جوال باي/);
  assert.ok(q("SELECT 1 FROM notifications WHERE body LIKE '%esdad_not_wired%'").get(), 'the manager is told, with the provider\'s code');
  // Confirming: 409 esdad_payment_not_confirmed — what a wrong code gets. Not paid; the customer asks for a new code at
  // once (not held back); that invoice is still looked up quietly: confirmed later → paid with it, once.
  const b = await order();
  await ok(call(null, 'POST', `/api/shop/orders/${b.code}/jawwal/otp`, { mobile: '0599400002' }));
  const inv = [...api.invoices.values()].at(-1);
  api.confirmAs = { status: 409, error: 'esdad_payment_not_confirmed', message: 'لم يصل تأكيد الدفع من بوابة سداد بعد' };
  const r2 = await call(null, 'POST', `/api/shop/orders/${b.code}/jawwal/confirm`, { otp: '000000' });
  api.confirmAs = null;
  assert.equal(r2.status, 402);
  assert.match(r2.body.error, /لم يتأكد الدفع بعد/, 'pending, not refused (the guide)');
  const vb = await ok(call(null, 'GET', `/api/shop/orders/${b.code}`));
  assert.equal(vb.status, 'awaiting_payment');
  assert.equal(vb.jawwal.checking, false, 'not held back');
  assert.equal(vb.jawwal.otpSent, false, 'that code is over: a new one');
  inv.status = 'confirmed'; // the provider took it after all
  assert.equal(await require('../src/shop').reconcileDirect({ force: true }), 1);
  assert.equal((await ok(call(null, 'GET', `/api/shop/orders/${b.code}`))).status, 'paid');
  assert.equal(await require('../src/shop').reconcileDirect({ force: true }), 0, 'once');
  // The same, but the customer paid again with a new code meanwhile: the late one goes to the manager, nothing twice.
  const b2 = await order();
  await ok(call(null, 'POST', `/api/shop/orders/${b2.code}/jawwal/otp`, { mobile: '0599400004' }));
  const old = [...api.invoices.values()].at(-1);
  api.confirmAs = { status: 409, error: 'esdad_payment_not_confirmed', message: 'x' };
  assert.equal((await call(null, 'POST', `/api/shop/orders/${b2.code}/jawwal/confirm`, { otp: '000000' })).status, 402);
  api.confirmAs = null;
  q('UPDATE shop_orders SET jc_sent_at = NULL WHERE code = ?').run(b2.code);
  await ok(call(null, 'POST', `/api/shop/orders/${b2.code}/jawwal/otp`, { mobile: '0599400004' }));
  assert.equal((await ok(call(null, 'POST', `/api/shop/orders/${b2.code}/jawwal/confirm`, { otp: '123456' }))).status, 'paid');
  old.status = 'confirmed';
  await require('../src/shop').reconcileDirect({ force: true });
  assert.ok(q('SELECT 1 FROM notifications WHERE title = ?').get(`دفعة جوال باي متأخرة للطلب ${b2.code}`), 'the manager is told');
  assert.equal(q("SELECT COUNT(*) AS n FROM jc_log WHERE event = 'paid' AND order_id = (SELECT id FROM shop_orders WHERE code = ?)").get(b2.code).n, 1);
  // Confirming: 409 esdad_session_gone — a new code is needed (410).
  const c = await order();
  await ok(call(null, 'POST', `/api/shop/orders/${c.code}/jawwal/otp`, { mobile: '0599400003' }));
  api.confirmAs = { status: 409, error: 'esdad_session_gone', message: 'انتهت جلسة الدفع، ابدأ من جديد' };
  const r3 = await call(null, 'POST', `/api/shop/orders/${c.code}/jawwal/confirm`, { otp: '123456' });
  api.confirmAs = null;
  assert.equal(r3.status, 410);
  assert.match(r3.body.error, /انتهت جلسة الدفع/);
  assert.equal((await ok(call(null, 'GET', `/api/shop/orders/${c.code}`))).jawwal.otpSent, false);
});

test('the invoice found whatever shape the list comes in (SADCOR-…, invoice_id, «paid», no filter); the manager checks it now', async () => {
  require('../src/routes/shop')._resetThrottle();
  require('../src/db').setSetting('jc_wait_until', 0);
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  const esim = await QL.esimPackage(call, ok, admin, 45);
  const order = async () => ok(call(null, 'POST', '/api/shop/orders', { kind: 'esim', packageId: esim.id, customerName: 'محمد' }));
  api.listShape = 'paged';
  try {
    // Confirmed, and found in the other shape at once: paid.
    const a = await order();
    await ok(call(null, 'POST', `/api/shop/orders/${a.code}/jawwal/otp`, { mobile: '0599500001' }));
    assert.equal((await ok(call(null, 'POST', `/api/shop/orders/${a.code}/jawwal/confirm`, { otp: '123456' }))).status, 'paid');
    // Confirmed, the invoice list not readable (as on the server for 5A09GK02): success means confirmed — paid at once.
    const c0 = await order();
    await ok(call(null, 'POST', `/api/shop/orders/${c0.code}/jawwal/otp`, { mobile: '0599500003' }));
    api.invoicesDown = true;
    assert.equal((await ok(call(null, 'POST', `/api/shop/orders/${c0.code}/jawwal/confirm`, { otp: '123456' }))).status, 'paid');
    api.invoicesDown = false;
    // No answer to confirming and nothing readable: the manager's «check now» (later) pays it, with what the API said.
    const b = await order();
    await ok(call(null, 'POST', `/api/shop/orders/${b.code}/jawwal/otp`, { mobile: '0599500002' }));
    api.invoicesDown = true;
    api.lostAnswer = true;
    const rb = await call(null, 'POST', `/api/shop/orders/${b.code}/jawwal/confirm`, { otp: '123456' });
    api.invoicesDown = false;
    api.lostAnswer = false;
    assert.equal(rb.status, 502);
    const id = require('../src/db').q('SELECT id FROM shop_orders WHERE code = ?').get(b.code).id;
    const checked = await ok(call(admin, 'POST', `/api/shop/admin/orders/${id}/jawwal-check`));
    assert.equal(checked.status, 'paid');
    assert.equal(checked.invoice.status, 'confirmed');
    assert.equal(checked.invoice.raw.paid_via, 'sadad_gate', 'the API\'s own answer (/settle), for the manager');
  } finally { api.listShape = null; }
});

test('E-SADAD: «not confirmed yet» is pending — asked again with /settle; confirmed a moment later → paid, once', async () => {
  require('../src/routes/shop')._resetThrottle();
  require('../src/db').setSetting('jc_wait_until', 0);
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  const esim = await QL.esimPackage(call, ok, admin, 45);
  const o = await ok(call(null, 'POST', '/api/shop/orders', { kind: 'esim', packageId: esim.id, customerName: 'سداد' }));
  await ok(call(null, 'POST', `/api/shop/orders/${o.code}/jawwal/otp`, { mobile: '0599600001' }));
  const before = api.log.filter((l) => l.endsWith('/settle')).length;
  api.confirmLater = true;
  const v = await ok(call(null, 'POST', `/api/shop/orders/${o.code}/jawwal/confirm`, { otp: '123456' }));
  api.confirmLater = false;
  assert.equal(v.status, 'paid');
  assert.ok(api.log.filter((l) => l.endsWith('/settle')).length > before, 'asked with /settle');
  assert.equal([...api.invoices.values()].filter((i) => i.mobile === '0599600001' && i.status === 'confirmed').length, 1, 'one payment');
});

test('Bank of Palestine: the code from the bank to its registered mobile — on the site and in the chat; off in the settings', async () => {
  require('../src/routes/shop')._resetThrottle();
  require('../src/db').setSetting('jc_wait_until', 0);
  const { q } = require('../src/db');
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  const esim = await QL.esimPackage(call, ok, admin, 40);
  assert.deepEqual((await ok(call(null, 'GET', '/api/shop'))).jawwalBanks, [{ code: 'PALS', name: 'بنك فلسطين' }]);
  const order = async () => ok(call(null, 'POST', '/api/shop/orders', { kind: 'esim', packageId: esim.id, customerName: 'بنك' }));
  // The site: chosen, sent with bank PALS, said on the order; then paid as usual.
  const a = await order();
  const v = await ok(call(null, 'POST', `/api/shop/orders/${a.code}/jawwal/otp`, { mobile: '0599700001', bank: 'PALS' }));
  assert.equal([...api.invoices.values()].at(-1).bank, 'PALS');
  assert.equal(v.jawwal.bank, 'PALS');
  assert.equal(v.jawwal.bankName, 'بنك فلسطين');
  assert.equal((await ok(call(null, 'POST', `/api/shop/orders/${a.code}/jawwal/confirm`, { otp: '123456' }))).status, 'paid');
  // Not the bank's registered number (code 14): said so; an unknown bank: refused before anything is sent.
  const b = await order();
  api.notAtBank = '0599700002';
  const r14 = await call(null, 'POST', `/api/shop/orders/${b.code}/jawwal/otp`, { mobile: '0599700002', bank: 'PALS' });
  assert.equal(r14.status, 422);
  assert.match(r14.body.error, /غير مسجّل لدى بنك فلسطين/);
  q('UPDATE shop_orders SET jc_sent_at = NULL WHERE code = ?').run(b.code);
  assert.equal((await call(null, 'POST', `/api/shop/orders/${b.code}/jawwal/otp`, { mobile: '0599700003', bank: 'QUDS' })).status, 400);
  // The chat: the number, «2» (the bank) → the bank texts the code.
  const wa = require('../src/whatsapp');
  const sent = [];
  wa._test.setTransport(async (jid, content) => { sent.push({ jid, ...content }); });
  const jid = '972599700004@s.whatsapp.net';
  const S = require('../src/routes/shop');
  const c = S.byCode((await S.createOrder({ packageId: esim.id, kind: 'esim', esim: true, includeEsimFee: true, customerName: 'بنك' }, { ip: `wa:${jid}`, clientId: `wa:${jid}` })).code);
  assert.match(wa._test.orderFacts(c, S.shopCatalogResponse()), /محفظة \*جوال باي\* أو \*بنك فلسطين\*/);
  await wa._test.payHere(jid, '0599700004', '0599700004');
  assert.equal(await wa._test.payHere(jid, '2', '0599700004'), true);
  assert.match(sent.at(-1).text, /\*بنك فلسطين\* بعتلك رمز تحقق برسالة على/);
  assert.equal([...api.invoices.values()].at(-1).bank, 'PALS');
  // Off in the settings: not offered, and refused if asked.
  await ok(call(admin, 'PUT', '/api/settings', { jcPals: false }));
  assert.deepEqual((await ok(call(null, 'GET', '/api/shop'))).jawwalBanks, []);
  const d = await order();
  assert.equal((await call(null, 'POST', `/api/shop/orders/${d.code}/jawwal/otp`, { mobile: '0599700005', bank: 'PALS' })).status, 400);
  await ok(call(admin, 'PUT', '/api/settings', { jcPals: true }));
});
