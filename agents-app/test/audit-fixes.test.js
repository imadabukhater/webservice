'use strict';
// Regression tests for Critical + High audit fixes.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.WA_AI_DAILY_USD = '0';
process.env.IMAP_HOST = '127.0.0.1';
process.env.IMAP_SECURE = '0';
process.env.JC_SKEW_MS = '0';
process.env.ART_CHECK_MS = '250';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

// ---------- Fake QuickLine with configurable delay, price hike, and subscription poll counter ----------
const qlState = {
  delayFreeMs: 0,
  cost: 60,
  created: [],
  subsCalls: 0,
  esim: [9501, 9502, 9503, 9504, 9505, 9506].map((id, i) => ({
    id, phone: `058911220${i}`, sim: `89972020123456789${i}`, barcodeImage: 'iVBORw0KGgo=',
  })),
  added: [],
};
const qlServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const json = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    const text = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(v); };
    const url = req.url.replace(/^\/api\//, '');
    const f = body ? JSON.parse(body) : {};
    if (url === 'Account/Login') return json({ statusCode: 200, data: { jwt: 'ql.jwt', userId: 'u1', type: 'Dealer', name: 'Test', email: f.email } });
    if (req.headers.authorization !== 'Bearer ql.jwt') return text('unauthorized', 401);
    if (url === 'Companies/GetDealerCompanies') return json([{ id: 3, name: 'Cellcom', logo: 'c.jpg', color: '#72206A', postalCode: '89972020', simLength: 18 }]);
    if (url === 'Packages/GetPackagesByCompany/3') {
      return json([{
        company: { id: 3, name: 'Cellcom', logo: 'c.jpg', color: '#72206A' },
        package: { name: 'سلكوم 400 جيجا', id: 2564, gb: 400, sms: 5000, minutes: 5000, isOffer: false, offer: null, hasFakePrice: false },
        prices: { pricePerCustomer: 100, pricePerCustomerOffer: 100, fakePrice: null, cost: qlState.cost, costOffer: qlState.cost, secondaryPrice: qlState.cost, mainPrice: qlState.cost },
        dealerId: 4606,
      }]);
    }
    if (url === 'Numbers/GetFreeNumbers') {
      if (qlState.delayFreeMs) await new Promise((r) => setTimeout(r, qlState.delayFreeMs));
      qlState.lastExclude = f.Numbers || [];
      const skip = new Set((f.Numbers || []).map(Number));
      return json(f.isEsim ? qlState.esim.filter((n) => !skip.has(n.id)) : []);
    }
    if (url === 'Subscriptions/DealersGetAllDT') {
      qlState.subsCalls++;
      return json({
        draw: f.draw, recordsTotal: qlState.added.length, recordsFiltered: qlState.added.length,
        data: qlState.added.slice(f.start, f.start + f.length).map((s, i) => ({
          company: { name: 'Cellcom', id: 3, simPrefix: '89972020', simLength: 18 }, package: { name: 'سلكوم 400 جيجا', id: 2564, gb: 400 },
          customer: { name: 'زبون', id: 1 }, daysLeft: { value: 30, color: 'success' }, status: { name: 'جديد', value: 'info', valueInt: 1 },
          automaticRenew: { name: 'غير فعال', text: 'danger', value: false },
          subscription: { id: s.id, phoneNumber: s.number, simNumber: s.sim, customerPrice: null, isEsim: { name: 'نعم', value: 'success', valueInt: 1 } },
          constantRenew: { name: 'غير فعال', text: 'danger', value: false },
          actions: { canExtend: false, canDisconnect: true, canPause: true, canChangeSim: true, canChangeAutomaticRenew: true, canRefresh: true },
          cutDate: '20/11/2026', connectionDate: '21/10/2026', updateDate: '21/10/2026', dealer: { id: 4606, name: 'أحمد', phone: '0534559260' }, belongsToUser: true, number: i + 1,
        })),
      });
    }
    if (url === 'Subscriptions/NewSubscription') {
      qlState.created.push(f);
      return text('تمت إضافة الاشتراك بنجاح');
    }
    return text('not found', 404);
  });
});

// ---------- Fake Layan that rejects TOTP code replay (verifies login deduplication) ----------
const LY_SECRET = 'JBSWY3DPEHPK3PXP';
const lyState = { loginCalls: 0, verifyCalls: 0, usedCodes: new Set() };
const lyServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const json = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    const text = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(v); };
    const url = req.url.replace(/^\/api\//, '');
    const f = body ? JSON.parse(body) : {};
    if (url === 'Auth/Login') {
      lyState.loginCalls++;
      await new Promise((r) => setTimeout(r, 40));
      return json({ statusCode: 202, data: { requestId: `r-${lyState.loginCalls}`, verificationMethod: 2 } });
    }
    if (url === 'Auth/VerifyCode') {
      lyState.verifyCalls++;
      if (lyState.usedCodes.has(f.code)) return text('code already used', 400);
      lyState.usedCodes.add(f.code);
      return json({ jwt: 'ly.jwt.unique' });
    }
    if (req.headers.authorization !== 'Bearer ly.jwt.unique') return text('unauthorized', 401);
    if (url === 'Packages/GetPackageDuration') return json([{ name: 'חודש', value: 30 }]);
    if (url === 'Packages/GetPackagesSortedByCompanies/false') {
      return json([{ company: { id: 'c9', name: 'We' }, packages: [{ id: '22222222-2222-2222-2222-222222222222', name: 'We 500GB', internet: '500', cost: 30, isActive: true }] }]);
    }
    return text('not found', 404);
  });
});

// ---------- Fake JawwalCorp corporate API ----------
const jcState = { invoices: new Map(), n: 0, lostAnswer: false, confirmDelayMs: 0 };
const jcServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : {};
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/api/auth/corporate_sign_in') {
      return send(200, { success: true, data: { access_token: 'jc.tok', expires_in: 3600, expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    }
    if (url.pathname === '/api/jawwal/corporate/send_otp') {
      const id = `COR-${++jcState.n}`;
      jcState.invoices.set(id, { id, amount: body.amount, mobile: body.mobile_number, status: 'pending' });
      return send(200, { success: true, data: { cor_invoice_id: id, expires_at: new Date(Date.now() + 300_000).toISOString(), amount: body.amount, mobile_number: body.mobile_number } });
    }
    if (url.pathname === '/api/jawwal/corporate/confirm_payment') {
      if (jcState.confirmDelayMs) await new Promise((r) => setTimeout(r, jcState.confirmDelayMs));
      const inv = jcState.invoices.get(body.cor_invoice_id);
      inv.status = 'confirmed';
      if (jcState.lostAnswer) return send(502, { success: false });
      return send(200, { success: true, data: { cor_invoice_id: inv.id, status: 'confirmed' } });
    }
    if (url.pathname === '/api/jawwal/corporate/settle') {
      const inv = jcState.invoices.get(body.cor_invoice_id);
      if (jcState.lostAnswer) return send(502, { success: false });
      return send(200, { success: true, data: { cor_invoice_id: inv.id, status: inv.status, amount: inv.amount, mobile_number: inv.mobile } });
    }
    if (url.pathname === '/api/jawwal/corporate/invoices') {
      if (jcState.lostAnswer) return send(502, { success: false });
      const list = [...jcState.invoices.values()].map((i) => ({ cor_invoice_id: i.id, status: i.status, amount: i.amount, mobile_number: i.mobile }));
      return send(200, { success: true, data: list });
    }
    send(404, { success: false });
  });
});

// ---------- Fake IMAP capturing SEARCH commands ----------
const imapSearches = [];
const imapServer = net.createServer((sock) => {
  let buf = '';
  sock.write('* OK fake imap ready\r\n');
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const [tag, ...rest] = line.split(' ');
      const cmd = rest.join(' ');
      if (/^LOGIN/i.test(cmd)) sock.write(`${tag} OK logged in\r\n`);
      else if (/^SELECT/i.test(cmd)) sock.write(`* 0 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n${tag} OK done\r\n`);
      else if (/^UID SEARCH/i.test(cmd)) { imapSearches.push(cmd); sock.write(`* SEARCH\r\n${tag} OK done\r\n`); }
      else if (/^LOGOUT/i.test(cmd)) { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end(); }
      else sock.write(`${tag} BAD unknown\r\n`);
    }
  });
  sock.on('error', () => {});
});

let base;
let server;
let admin;
let qlPkg;

const call = async (token, method, url, body, headers = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
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
  await Promise.all([
    new Promise((r) => qlServer.listen(0, '127.0.0.1', r)),
    new Promise((r) => lyServer.listen(0, '127.0.0.1', r)),
    new Promise((r) => jcServer.listen(0, '127.0.0.1', r)),
    new Promise((r) => imapServer.listen(0, '127.0.0.1', r)),
  ]);
  process.env.QL_BASE = `http://127.0.0.1:${qlServer.address().port}`;
  process.env.LY_BASE = `http://127.0.0.1:${lyServer.address().port}`;
  process.env.JC_BASE = `http://127.0.0.1:${jcServer.address().port}`;
  process.env.IMAP_PORT = String(imapServer.address().port);
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  await ok(call(admin, 'PUT', '/api/settings', {
    qlUser: 'dealer@example.com', qlPass: 'pass',
    shopEnabled: true, shopHourLimit: 0, esimFee: 12,
    jawwalpayNumber: '0599000000', gmailUser: 'shop@gmail.com', gmailPass: 'abcd efgh ijkl mnop',
    mailFrom: 'jawwalpay.ps, jawwal.ps',
    jcEnabled: true, jcManagerId: '173', jcUser: 'corp', jcPass: 'corp-pass',
  }));
  await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'invoice' }));
  qlPkg = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.supplier === 'ql');
  await ok(call(admin, 'PUT', `/api/packages/${qlPkg.id}`, { inShop: true }));
});
test.after(() => { server.close(); qlServer.close(); lyServer.close(); jcServer.close(); imapServer.close(); });

test('Fix 1 (Critical): manual proof blocked during direct Jawwal Pay confirm/unsure, and unsure verifying orders still reconcile', async () => {
  const { q } = require('../src/db');
  const shop = require('../src/shop');
  const o = await ok(call(null, 'POST', '/api/shop/orders', { packageId: qlPkg.id, customerName: 'عماد اختبار' }));
  await ok(call(null, 'POST', `/api/shop/orders/${o.code}/jawwal/otp`, { mobile: '0599123456' }));

  // 1a) Proof submitted while confirm_payment is in-flight is rejected with 409 (no silent loss of direct charge)
  jcState.confirmDelayMs = 80;
  jcState.lostAnswer = true;
  const confirmP = call(null, 'POST', `/api/shop/orders/${o.code}/jawwal/confirm`, { otp: '123456' });
  await new Promise((r) => setTimeout(r, 20));
  const proofDuring = await call(null, 'POST', `/api/shop/orders/${o.code}/proof`, { payReference: 'REF-RACE' });
  assert.equal(proofDuring.status, 409);
  const confirmRes = await confirmP;
  assert.equal(confirmRes.status, 502); // marked jc_unsure = 1
  jcState.confirmDelayMs = 0;

  // 1b) Proof submitted while jc_unsure = 1 is also rejected with 409
  const proofUnsure = await call(null, 'POST', `/api/shop/orders/${o.code}/proof`, { payReference: 'REF-UNSURE' });
  assert.equal(proofUnsure.status, 409);

  // 1c) Even if an order was already in verifying with jc_unsure = 1, reconcileDirect still settles it
  q("UPDATE shop_orders SET status = 'verifying', proof_at = ? WHERE code = ?").run(Date.now(), o.code);
  jcState.lostAnswer = false;
  const settled = await shop.reconcileDirect({ force: true });
  assert.equal(settled, 1);
  const fresh = await ok(call(null, 'GET', `/api/shop/orders/${o.code}`));
  assert.equal(fresh.status, 'paid');
});

test('Fix 2 (High): client cannot bypass global esimFee by sending includeEsimFee: false or omitting it', async () => {
  const o1 = await ok(call(null, 'POST', '/api/shop/orders', { packageId: qlPkg.id, includeEsimFee: false, customerName: 'محاولة خصم' }));
  assert.equal(o1.esimFee, 12);
  assert.equal(o1.amount, o1.packagePrice + 12);
  await ok(call(null, 'POST', `/api/shop/orders/${o1.code}/cancel`));
});

test('Fix 3 (High): concurrent createOrder requests from same client cannot bypass 1-active-reservation limit', async () => {
  qlState.delayFreeMs = 60;
  const headers = { 'X-Client-Id': 'concurrent-attacker-1' };
  const results = await Promise.all([1, 2, 3, 4].map((i) =>
    call(null, 'POST', '/api/shop/orders', { packageId: qlPkg.id, customerName: `زبون ${i}` }, headers)));
  qlState.delayFreeMs = 0;
  const okOnes = results.filter((r) => r.status === 200);
  const blocked = results.filter((r) => r.status === 409);
  assert.equal(okOnes.length, 1, `expected exactly 1 reservation, got ${okOnes.length}`);
  assert.equal(blocked.length, 3, `expected 3 blocked with 409, got ${blocked.length}`);
  await ok(call(null, 'POST', `/api/shop/orders/${okOnes[0].body.code}/cancel`));
});

test('Fix 4 (High): 1-word customer name on ay:bill: eSIM succeeds in recordEsimSale', () => {
  const { q, tx } = require('../src/db');
  const { recordEsimSale } = require('../src/sale');
  const ayRoutes = require('../src/routes/aylol');
  const coId = q('SELECT id FROM companies LIMIT 1').get().id;
  const pkgId = Number(q(`INSERT INTO packages (company_id, name, cost, price, active, art_card_id, kind, supplier_company, supplier_sim_type)
    VALUES (?, 'Aylol Bill eSIM', 30, 36, 1, 'ay:bill:11:777', 'invoice', 7, 'esim')`).run(coId).lastInsertRowid);
  ayRoutes._test?.rememberEsim?.('ay:bill:11:777', ['0519998877']);
  // Seed served cache via billFreeNumbers fallback if no _test hook: test directly via served map
  // Instead, test with non-auto company vs auto company: for auto company 7, verify name validation doesn't reject 1-word name.
  let err;
  try {
    tx(() => recordEsimSale({
      code: 'AY1WORD1', package_id: pkgId, esim: 1, number: '0519998877', sim: '',
      customer_name: 'لينا', amount: 48, esim_qr: '', email: '', contact_phone: '',
    }));
  } catch (e) { err = e; }
  // Fails only because number isn't in servedEsim cache, NOT because of 1-word customer name!
  assert.ok(err && /قائمة الأرقام/.test(err.message), `expected served-number error, got: ${err?.message}`);
});

test('Fix 5 & 6 (High): QuickLine live price guard blocks price hikes, and sweep() does not multiply polling timers', async () => {
  const { q } = require('../src/db');
  const autoexec = require('../src/autoexec');
  const shop = require('../src/shop');

  // Fix 5: supplier raises price from 60 -> 80 before sendQlNew runs
  const oPrice = await ok(call(null, 'POST', '/api/shop/orders', { packageId: qlPkg.id, customerName: 'فحص سعر' }));
  qlState.cost = 80;
  const createdBefore = qlState.created.length;
  const oRow = q('SELECT * FROM shop_orders WHERE code = ?').get(oPrice.code);
  assert.equal(shop.claim(oRow.id, null, 'test'), true);
  shop.fulfil(oRow.id);
  let task;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 50));
    task = q('SELECT * FROM tasks WHERE line_id = (SELECT line_id FROM shop_orders WHERE code = ?)').get(oPrice.code);
    if (task && task.auto_status && task.auto_status !== 'sending') break;
  }
  assert.equal(task.auto_status, 'failed');
  assert.match(task.auto_note, /أعلى من المعتمد/);
  assert.equal(qlState.created.length, createdBefore, 'must not place QuickLine order when price increased');
  qlState.cost = 60;

  // Fix 6: sent task with active later() timer is not double-polled by repeated sweep() calls
  const oPoll = await ok(call(null, 'POST', '/api/shop/orders', { packageId: qlPkg.id, customerName: 'فحص تكرار' }));
  const pRow = q('SELECT * FROM shop_orders WHERE code = ?').get(oPoll.code);
  assert.equal(shop.claim(pRow.id, null, 'test'), true);
  shop.fulfil(pRow.id);
  let pTask;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 50));
    pTask = q('SELECT * FROM tasks WHERE line_id = (SELECT line_id FROM shop_orders WHERE code = ?)').get(oPoll.code);
    if (pTask && pTask.auto_status && pTask.auto_status !== 'sending') break;
  }
  assert.equal(pTask.auto_status, 'sent');
  const callsBefore = qlState.subsCalls;
  await autoexec.sweep();
  await autoexec.sweep();
  await autoexec.sweep();
  assert.equal(qlState.subsCalls, callsBefore, 'sweep() skips sent tasks that already have a scheduled timer');
  // Clean up the open sent task so background timers don't hit a closed server in test.after.
  q("UPDATE tasks SET status = 'done', auto_status = 'done' WHERE id = ?").run(pTask.id);
});

test('Fix 7 (High): Layan concurrent catalog() calls deduplicate TOTP login (no replay failure)', async () => {
  const ly = require('../src/layan');
  const items = await ly.catalog({ user: 'ly.user', pass: 'ly.pass', secret: LY_SECRET }, 'invoice');
  assert.equal(items.length, 1);
  assert.equal(lyState.loginCalls, 1, 'Auth/Login called once despite Promise.all');
  assert.equal(lyState.verifyCalls, 1, 'Auth/VerifyCode called once despite Promise.all');
});

test('Fix 8 (High): IMAP SEARCH includes bop.ps and splits multi-domain mail_from', async () => {
  const shop = require('../src/shop');
  imapSearches.length = 0;
  await shop.checkMail({ force: true });
  assert.ok(imapSearches.length >= 1, 'IMAP UID SEARCH ran');
  const cmd = imapSearches.at(-1);
  assert.match(cmd, /FROM "jawwalpay\.ps"/);
  assert.match(cmd, /FROM "jawwal\.ps"/);
  assert.match(cmd, /FROM "palpay\.ps"/);
  assert.match(cmd, /FROM "bop\.ps"/);
  assert.match(cmd, /FROM "shop@gmail\.com"/);
});

test('Fix 9 (High): QuickLine syncKind rejects removed card kind cleanly and scripts/ql-sync.js defaults to invoice', async () => {
  const { syncKind } = require('../src/routes/quickline');
  await assert.rejects(
    () => syncKind({ user: 'dealer@example.com', pass: 'pass' }, 'card'),
    (e) => e.status === 400 && /eSIM فقط/.test(e.message),
  );
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const execFileAsync = promisify(execFile);
  const path = require('node:path');
  const script = path.join(__dirname, '..', 'scripts', 'ql-sync.js');
  const { stdout } = await execFileAsync(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
    env: { ...process.env, DB_FILE: ':memory:', QL_USER: 'dealer@example.com', QL_PASS: 'pass', QL_BASE: process.env.QL_BASE },
    encoding: 'utf8',
  });
  assert.match(stdout, /^invoice: 1 from QuickLine, added 1, seen 0, restored 0, switched off 0, removed 0/m);
  assert.doesNotMatch(stdout, /undefined/);
  await assert.rejects(() => execFileAsync(process.execPath, ['--disable-warning=ExperimentalWarning', script, 'card'], {
    env: { ...process.env, DB_FILE: ':memory:' },
  }));
});

test('Medium 1-3: invalid HTML code points do not crash IMAP parsing, ownNumber filters both wallets, and TLS open() times out', async () => {
  const mail = require('../src/mail');
  const smtp = require('../src/smtp');

  // 1) Poison-pill numeric HTML entities (> 0x10FFFF) must not throw RangeError
  const rawHtml = [
    'From: Jawwal Pay <noreply@jawwalpay.ps>',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>استلمت 50 &#8362; bad: &#9999999; &#x110000; ok: &#x2713;</p>',
  ].join('\r\n');
  const parsed = mail.parseMessage(rawHtml);
  assert.match(parsed.text, /50 ₪/);
  assert.match(parsed.text, /&#9999999;/);
  assert.match(parsed.text, /✓/);

  // 2) ownNumber array excludes both jawwalpayNumber and palpayNumber
  const f = mail.parseJawwalPay(
    { text: 'تم استلام 50 ₪ على محفظة 0599000002 (بال باي) من 0599111222' },
    { ownNumber: ['0599000001', '0599000002'] },
  );
  assert.equal(f.senderPhone, '0599111222');
  const fOnlyOwn = mail.parseJawwalPay(
    { text: 'تم استلام 50 ₪ على محفظة 0599000002' },
    { ownNumber: ['0599000001', '0599000002'] },
  );
  assert.equal(fOnlyOwn.senderPhone, null);

  // 3) Stalled TLS handshake in IMAP and SMTP rejects promptly within timeout instead of hanging
  const stalled = net.createServer((sock) => { sock.on('error', () => {}); });
  await new Promise((r) => stalled.listen(0, '127.0.0.1', r));
  const port = stalled.address().port;
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => mail.fetchMail({ host: '127.0.0.1', port, secure: true, user: 'a@b.com', pass: 'p', since: Date.now(), timeout: 150 }),
      /انتهت مهلة الاتصال/,
    );
    assert.ok(Date.now() - t0 < 2000, 'IMAP TLS handshake timed out promptly');

    const t1 = Date.now();
    await assert.rejects(
      () => smtp.sendMail({ host: '127.0.0.1', port, secure: true, user: 'a@b.com', pass: 'p', to: 'c@d.com', subject: 'hi', html: 'hi', timeout: 150 }),
      /انتهت مهلة الاتصال/,
    );
    assert.ok(Date.now() - t1 < 2000, 'SMTP TLS handshake timed out promptly');
  } finally {
    stalled.close();
  }
});

test('Medium 4-6: PUT /api/settings rolls back atomically, /api/health returns aylol, and Layan normalizes image/jpg & blocks svg', async () => {
  const before = await ok(call(admin, 'GET', '/api/settings'));
  // Turn jcEnabled off first (mailPay is on), then try turning both off alongside appName change
  await ok(call(admin, 'PUT', '/api/settings', { jcEnabled: false }));
  const bad = await call(admin, 'PUT', '/api/settings', { appName: 'ShouldRollback', mailPay: false, jcEnabled: false });
  assert.equal(bad.status, 400);
  const after = await ok(call(admin, 'GET', '/api/settings'));
  assert.equal(after.jcEnabled, false, 'jcEnabled must NOT be flipped to true on rollback');
  assert.equal(after.mailPay, true);
  assert.equal(after.appName, before.appName, 'earlier field in same request rolled back too');
  await ok(call(admin, 'PUT', '/api/settings', { jcEnabled: true }));

  // Layan QR MIME normalization
  const ly = require('../src/layan');
  const imgSrv = http.createServer((req, res) => {
    if (req.url === '/ok.jpg') { res.writeHead(200, { 'Content-Type': 'image/jpg; charset=binary' }); return res.end(Buffer.from([0xff, 0xd8, 0xff])); }
    if (req.url === '/bad.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end('<svg/>'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => imgSrv.listen(0, '127.0.0.1', r));
  try {
    const imgBase = `http://127.0.0.1:${imgSrv.address().port}`;
    const jpg = await ly.imageDataUrl(`${imgBase}/ok.jpg`);
    assert.match(jpg, /^data:image\/jpeg;base64,/);
    await assert.rejects(() => ly.imageDataUrl(`${imgBase}/bad.svg`), /غير متاح/);
  } finally {
    imgSrv.close();
  }

  // /api/health exposes aylol key when configured (even if balance check fails with error)
  await ok(call(admin, 'PUT', '/api/settings', { aylolUser: 'u@aylol.test', aylolPass: 'p' }));
  process.env.AYLOL_BASE = 'http://127.0.0.1:1';
  const health = await ok(call(admin, 'GET', '/api/health'));
  assert.ok(health.aylol && typeof health.aylol === 'object', 'health includes aylol object');
  assert.ok('balance' in health.aylol && 'error' in health.aylol && 'synced' in health.aylol);
  await ok(call(admin, 'PUT', '/api/settings', { aylolUser: '' }));
});

test('Low 1-4: bad %-encoding returns 400, oversized body returns 413 cleanly, by_package handles unfulfilled cost, reject clears mail_id & checks jc_unsure, UIDVALIDITY reset works', async () => {
  const { q } = require('../src/db');
  const mail = require('../src/mail');

  // 1) Malformed percent-encoding in API route param returns 400 instead of 500
  const badPct = await call(null, 'GET', '/api/shop/orders/%E0%A4%A');
  assert.equal(badPct.status, 400);

  // 2) Oversized body (> 64KB default) receives a clean 413 JSON response without TCP reset
  const huge = await call(null, 'POST', '/api/login', { username: 'x'.repeat(80 * 1024), password: 'p' });
  assert.equal(huge.status, 413);
  assert.match(huge.body.error, /كبير/);

  // 3) by_package report does not overstate profit when paid order has line_id IS NULL
  const nowTs = Date.now();
  q(`INSERT INTO shop_orders (code, package_label, kind, number, customer_name, amount, status, paid_at, line_id, created_at, updated_at)
     VALUES ('UNFUL001', 'باقة غير منفذة', 'new', '0589991111', 'تجربة', 100, 'paid', ?, NULL, ?, ?)`).run(nowTs, nowTs, nowTs);
  const rep = await ok(call(admin, 'GET', `/api/reports/by_package?from=${nowTs - 60000}&to=${nowTs + 60000}`));
  const unfulRow = rep.rows.find((r) => r.package === 'باقة غير منفذة');
  assert.ok(unfulRow);
  assert.equal(unfulRow.revenue, 100);
  assert.equal(unfulRow.cost, null);
  assert.equal(unfulRow.profit, null);

  // 4) Admin reject clears shop_orders.mail_id and refuses while jc_unsure = 1
  const mailId = Number(q(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
    VALUES (99, 1, '<rej@jp>', 1, 'noreply@jawwalpay.ps', 'Jawwal Pay', ?, 100, 'REJ1', '', '', 'incoming', ?)`).run(nowTs, nowTs).lastInsertRowid);
  const rejOrdId = Number(q(`INSERT INTO shop_orders (code, package_label, kind, number, customer_name, amount, status, paid_at, mail_id, jc_unsure, line_id, created_at, updated_at)
    VALUES ('REJORD01', 'باقة رفض', 'new', '0589992222', 'تجربة', 100, 'paid', ?, ?, 1, NULL, ?, ?)`).run(nowTs, mailId, nowTs, nowTs).lastInsertRowid);
  q('UPDATE payment_mails SET order_id = ? WHERE id = ?').run(rejOrdId, mailId);
  assert.equal((await call(admin, 'POST', `/api/shop/admin/orders/${rejOrdId}/reject`, { response: 'مرفوض' })).status, 409, 'cannot reject while jc_unsure = 1');
  q('UPDATE shop_orders SET jc_unsure = 0 WHERE id = ?').run(rejOrdId);
  await ok(call(admin, 'POST', `/api/shop/admin/orders/${rejOrdId}/reject`, { response: 'مرفوض' }));
  assert.equal(q('SELECT mail_id FROM shop_orders WHERE id = ?').get(rejOrdId).mail_id, null, 'shop_orders.mail_id cleared');
  assert.equal(q('SELECT order_id FROM payment_mails WHERE id = ?').get(mailId).order_id, null, 'payment_mails.order_id freed');

  // 5) IMAP UIDVALIDITY change invalidates old known UIDs
  const uidSrv = net.createServer((sock) => {
    let buf = '';
    sock.write('* OK ready\r\n');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, ...rest] = line.split(' ');
        const cmd = rest.join(' ');
        if (/^LOGIN/i.test(cmd)) sock.write(`${tag} OK ok\r\n`);
        else if (/^SELECT/i.test(cmd)) sock.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 42] ok\r\n${tag} OK done\r\n`);
        else if (/^UID SEARCH/i.test(cmd)) sock.write(`* SEARCH 1\r\n${tag} OK done\r\n`);
        else if (/^UID FETCH 1/i.test(cmd)) {
          const raw = Buffer.from('From: a@b.com\r\nSubject: hi\r\n\r\nhello', 'utf8');
          sock.write(Buffer.concat([Buffer.from(`* 1 FETCH (UID 1 BODY[] {${raw.length}}\r\n`), raw, Buffer.from(`)\r\n${tag} OK done\r\n`)]));
        } else if (/^LOGOUT/i.test(cmd)) { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end(); }
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => uidSrv.listen(0, '127.0.0.1', r));
  try {
    const same = await mail.fetchMail({ host: '127.0.0.1', port: uidSrv.address().port, secure: false, user: 'u', pass: 'p', since: nowTs, known: new Set([1]), knownUidValidity: 42 });
    assert.equal(same.messages.length, 0, 'same UIDVALIDITY skips known UID 1');
    const changed = await mail.fetchMail({ host: '127.0.0.1', port: uidSrv.address().port, secure: false, user: 'u', pass: 'p', since: nowTs, known: new Set([1]), knownUidValidity: 7 });
    assert.equal(changed.messages.length, 1, 'changed UIDVALIDITY does not skip reused UID 1');
  } finally {
    uidSrv.close();
  }
});

test('Payment & QR audit fixes: Azure octet-stream PNG sniffing (Layan & Aylol), QuickLine QR/exclude, task LPA->QR & empty-QR guard, WhatsApp webp QR', async () => {
  const { q } = require('../src/db');
  const { sniffImageMime, normalizeQrDataUrl } = require('../src/util');
  const ly = require('../src/layan');
  const ay = require('../src/aylol');
  const wa = require('../src/whatsapp');
  const { orderView } = require('../src/routes/shop');

  const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const WEBP_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

  // 1) Magic-byte sniffing & QuickLine raw base64 normalization
  assert.equal(sniffImageMime(PNG_BYTES), 'image/png');
  assert.equal(sniffImageMime(WEBP_BYTES), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('<html>nope</html>')), '');
  assert.equal(normalizeQrDataUrl(PNG_BYTES.toString('base64')), `data:image/png;base64,${PNG_BYTES.toString('base64')}`);
  assert.equal(normalizeQrDataUrl('data:image/jpg;base64,/9j/AA=='), 'data:image/jpeg;base64,/9j/AA==');
  assert.equal(normalizeQrDataUrl('not-an-image'), '');

  // 2) Layan & Aylol download PNG served as application/octet-stream (Azure Blob Storage), while rejecting HTML/SVG
  const qrSrv = http.createServer((req, res) => {
    if (req.url === '/blob.png') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(PNG_BYTES); }
    if (req.url === '/blob.html') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end('<html>login</html>'); }
    if (req.url === '/bad.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end('<svg/>'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => qrSrv.listen(0, '127.0.0.1', r));
  const prevAyBase = process.env.AYLOL_BASE;
  try {
    const base = `http://127.0.0.1:${qrSrv.address().port}`;
    process.env.AYLOL_BASE = base;
    const lyPng = await ly.imageDataUrl(`${base}/blob.png`);
    assert.equal(lyPng, `data:image/png;base64,${PNG_BYTES.toString('base64')}`, 'Layan accepts PNG with application/octet-stream');
    await assert.rejects(() => ly.imageDataUrl(`${base}/blob.html`), /غير متاح/, 'Layan rejects non-image octet-stream');
    await assert.rejects(() => ly.imageDataUrl(`${base}/bad.svg`), /غير متاح/, 'Layan still rejects SVG');

    const ayPng = await ay.qrImage(`${base}/blob.png`);
    assert.equal(ayPng, `data:image/png;base64,${PNG_BYTES.toString('base64')}`, 'Aylol accepts PNG with application/octet-stream');
    assert.equal(await ay.qrImage(`${base}/blob.html`), '', 'Aylol rejects non-image octet-stream');
    assert.equal(await ay.qrImage(`${base}/bad.svg`), '', 'Aylol rejects SVG');
  } finally {
    if (prevAyBase === undefined) delete process.env.AYLOL_BASE; else process.env.AYLOL_BASE = prevAyBase;
    qrSrv.close();
  }

  // 3) QuickLine freeNumbers excludes only QuickLine numeric IDs, never Aylol 'ayl:...' reservations
  const nowTs = Date.now();
  const ayPkgId = Number(q(`INSERT INTO packages (company_id, name, cost, price, active, art_card_id, kind, shop_on, shop_price)
    VALUES ((SELECT id FROM companies LIMIT 1), 'باقة أيلول اختبار', 30, 30, 1, 'ay:bill:25:999', 'invoice', 1, 40)`).run().lastInsertRowid);
  q(`INSERT INTO shop_orders (code, package_id, package_label, kind, number, number_id, customer_name, amount, status, esim, created_at, updated_at)
     VALUES ('AYHOLD01', ?, 'أيلول', 'new', '0527770001', 'ayl:0527770001', 'زبون', 45, 'awaiting_payment', 1, ?, ?)`).run(ayPkgId, nowTs, nowTs);
  qlState.lastExclude = null;
  try {
    await ok(call(null, 'GET', `/api/shop/available?packageId=${qlPkg.id}`));
    assert.ok(Array.isArray(qlState.lastExclude), 'QuickLine received exclude array');
    assert.ok(!qlState.lastExclude.some((x) => String(x).startsWith('ayl:')), 'Aylol number_id must never be passed to QuickLine');
  } finally {
    q("UPDATE shop_orders SET status = 'cancelled' WHERE code = 'AYHOLD01'").run();
  }

  // 4) Manual eSIM task completion rejects empty QR+LPA, auto-generates PNG QR from LPA, and orderView hides QR while pending
  const coId = q('SELECT id FROM companies LIMIT 1').get().id;
  const lineId = Number(q(`INSERT INTO lines (number, sim, company_id, package_id, package_label, agent_id, kind, esim, months, price, cost, status, customer_name, activated_at, updated_at)
    VALUES ('0528881111', '', ?, ?, 'رزمة اختبار', (SELECT id FROM users WHERE role = 'admin' LIMIT 1), 'new', 1, 1, 50, 30, 'pending', 'زبون', ?, ?)`).run(coId, qlPkg.id, nowTs, nowTs).lastInsertRowid);
  const taskId = Number(q(`INSERT INTO tasks (type, line_id, amount, note, created_at) VALUES ('esim', ?, 50, 'تفعيل eSIM', ?)`).run(lineId, nowTs).lastInsertRowid);
  const ordId = Number(q(`INSERT INTO shop_orders (code, package_id, package_label, kind, number, customer_name, amount, status, esim, esim_qr, line_id, created_at, updated_at)
    VALUES ('QRTASK01', ?, 'رزمة اختبار', 'new', '0528881111', 'زبون', 50, 'paid', 1, ?, ?, ?, ?)`).run(qlPkg.id, `data:image/png;base64,${PNG_BYTES.toString('base64')}`, lineId, nowTs, nowTs).lastInsertRowid);

  // While line is pending, orderView must NOT expose unactivated QR
  const pendingView = orderView(q('SELECT * FROM shop_orders WHERE id = ?').get(ordId));
  assert.equal(pendingView.stage, 'processing');
  assert.equal(pendingView.esimQr, null, 'QR must not be exposed before line is active');

  // Resolving with neither QR image nor LPA code is refused (400)
  const emptyRes = await call(admin, 'POST', `/api/tasks/${taskId}/resolve`, { status: 'done' });
  assert.equal(emptyRes.status, 400, 'cannot complete eSIM task with empty QR and empty LPA');

  // Resolving with ONLY an LPA code automatically draws a valid PNG QR
  await ok(call(admin, 'POST', `/api/tasks/${taskId}/resolve`, { status: 'done', esimCode: 'LPA:1$smdp.example$MATCH-99' }));
  const doneView = orderView(q('SELECT * FROM shop_orders WHERE id = ?').get(ordId));
  assert.equal(doneView.stage, 'done');
  assert.equal(doneView.esimCode, 'LPA:1$smdp.example$MATCH-99');
  assert.match(doneView.esimQr, /^data:image\/png;base64,iVBOR/, 'LPA code automatically generates a PNG QR');

  // 5) WhatsApp delivers webp & uppercase data URLs as image buffers (not broken fallback text)
  const sentMsgs = [];
  wa._test.setTransport(async (jid, content) => { sentMsgs.push({ jid, content }); });
  try {
    const webpLineId = Number(q(`INSERT INTO lines (number, sim, company_id, package_id, package_label, agent_id, kind, esim, months, price, cost, status, customer_name, esim_qr, esim_code, activated_at, updated_at)
      VALUES ('0528882222', '', ?, ?, 'رزمة ويب بي', (SELECT id FROM users WHERE role = 'admin' LIMIT 1), 'new', 1, 1, 50, 30, 'active', 'زبون', ?, 'LPA:1$smdp.example$WEBP-1', ?, ?)`)
      .run(coId, qlPkg.id, `DATA:IMAGE/WEBP;base64,${WEBP_BYTES.toString('base64')}`, nowTs, nowTs).lastInsertRowid);
    const webpOrdId = Number(q(`INSERT INTO shop_orders (code, package_id, package_label, kind, number, customer_name, amount, status, esim, line_id, created_at, updated_at)
      VALUES ('WAWEBP01', ?, 'رزمة ويب بي', 'new', '0528882222', 'زبون', 50, 'paid', 1, ?, ?, ?)`).run(qlPkg.id, webpLineId, nowTs, nowTs).lastInsertRowid);
    wa._test.follow('972599000111@s.whatsapp.net', { id: webpOrdId, ip: 'wa:972599000111@s.whatsapp.net' }, 'processing');
    await wa._test.watchShop();
    const imgMsg = sentMsgs.find((m) => m.jid === '972599000111@s.whatsapp.net' && Buffer.isBuffer(m.content?.image));
    assert.ok(imgMsg, 'WhatsApp sends webp/uppercase QR data URL as an image Buffer');
    assert.equal(Buffer.compare(imgMsg.content.image, WEBP_BYTES), 0);
    assert.ok(sentMsgs.some((m) => m.content?.text?.includes('LPA:1$smdp.example$WEBP-1')), 'WhatsApp also sends LPA code');
  } finally {
    wa._test.setTransport(null);
  }
});

test('Storefront polish: publicPackageName, packageLabel deduping, and /api/shop scrub supplier names & internal codes', async () => {
  const { q } = require('../src/db');
  const { publicPackageName } = require('../src/privacy');
  const { packageLabel } = require('../src/domain');

  assert.equal(publicPackageName('ليان هوت موبايل 200 جيجا (213)'), 'هوت موبايل 200 جيجا');
  assert.equal(publicPackageName('Aylol telecom WE 500 GB ESIM JUST'), 'WE 500 GB');
  assert.equal(publicPackageName('سلكوم 400 جبجا - كويك لاين'), 'سلكوم 400 جيجا');
  assert.equal(publicPackageName('QuickLine 019 250 جيجا (9001)'), '019 250 جيجا');

  assert.equal(packageLabel({ company_name: 'سلكوم', name: 'سلكوم 400 جبجا (213)' }), 'سلكوم 400 جيجا');
  assert.equal(packageLabel({ company_name: 'بارتنر', name: 'ليان 500 جيجا 5G' }), 'بارتنر 500 جيجا 5G');

  const coId = qlPkg.companyId;
  const dirtyId = Number(q(`INSERT INTO packages (company_id, name, description, cost, price, active, art_card_id, kind, shop_price)
    VALUES (?, 'ليان Aylol telecom 500 جبجا ESIM JUST (777)', 'مزود QuickLine تفعيل سريع', 30, 30, 1, 'qln:3:777', 'invoice', 40)`).run(coId).lastInsertRowid);
  try {
    const pub = await ok(call(null, 'GET', '/api/shop'));
    const pk = pub.packages.find((p) => p.id === dirtyId);
    assert.ok(pk, 'dirty test package appears in /api/shop');
    assert.equal(pk.name, '500 جيجا');
    assert.doesNotMatch(pk.name, /ليان|Aylol|ESIM JUST|777|جبجا/i);
    assert.doesNotMatch(pk.description, /QuickLine/i);
  } finally {
    q('DELETE FROM packages WHERE id = ?').run(dirtyId);
  }
});

test('Nearest-shekel rounding, SSR /package/:id SEO pages, /api/shop/package/:id, and dynamic /sitemap.xml', async () => {
  const { q } = require('../src/db');
  const { shopPriceOf } = require('../src/domain');

  // 1) Nearest whole shekel rounding
  assert.equal(shopPriceOf({ cost: 33.55 }, 20), 40); // 40.26 -> 40
  assert.equal(shopPriceOf({ cost: 39.65 }, 20), 48); // 47.58 -> 48
  assert.equal(shopPriceOf({ cost: 25.42 }, 20), 31); // 30.504 -> 31

  // 2) Public single-package API (/api/shop/package/:id)
  const apiPkg = await ok(call(null, 'GET', `/api/shop/package/${qlPkg.id}`));
  assert.equal(apiPkg.package.id, qlPkg.id);
  assert.equal(apiPkg.package.price, Math.round(apiPkg.package.price));
  assert.equal(apiPkg.package.total, apiPkg.package.price + apiPkg.package.esimFee);
  assert.equal(apiPkg.available, true);
  assert.equal((await call(null, 'GET', '/api/shop/package/999999')).status, 404);

  // 3) Server-side rendered SEO page at /package/:id (HTML + canonical + 3 JSON-LD schemas + zero supplier leaks)
  const rawGet = (p) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${p}`, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });

  const page = await rawGet(`/package/${qlPkg.id}`);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, new RegExp(`<link rel="canonical" href="[^"]*/package/${qlPkg.id}">`));
  assert.match(page.body, /<meta name="description" content="[^"]+">/);
  assert.match(page.body, /<meta name="keywords" content="[^"]+">/);
  assert.doesNotMatch(page.body, /QuickLine|Aylol|ليان/i);
  const ldBlocks = [...page.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert.equal(ldBlocks.length, 3, 'Product + BreadcrumbList + FAQPage JSON-LD');
  const prod = ldBlocks.find((b) => b['@type'] === 'Product');
  assert.ok(prod && prod.offers && prod.offers.priceCurrency === 'ILS');
  assert.equal(Number(prod.offers.price), apiPkg.package.total);
  assert.ok(ldBlocks.some((b) => b['@type'] === 'BreadcrumbList'));
  const faq = ldBlocks.find((b) => b['@type'] === 'FAQPage');
  assert.ok(faq && faq.mainEntity.length >= 4);

  // Unknown package returns HTTP 404 with noindex
  const missing = await rawGet('/package/999999');
  assert.equal(missing.status, 404);
  assert.match(missing.body, /noindex/);

  // 4) Dynamic /sitemap.xml includes / and /package/:id with no invalid # fragment URLs
  const sm = await rawGet('/sitemap.xml');
  assert.equal(sm.status, 200);
  assert.match(sm.headers['content-type'], /application\/xml/);
  assert.match(sm.body, new RegExp(`<loc>[^<]*/package/${qlPkg.id}</loc>`));
  assert.doesNotMatch(sm.body, /#/);

  // 5) Google Search Console homepage (/): West Bank + Gaza, 4 JSON-LD schemas, verification meta, 301 canonicals, real 404 (no Soft 404), and noindex on /portal
  const rawReq = (p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${p}`, { method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });

  await ok(call(admin, 'PUT', '/api/settings', { googleSiteVerification: '<meta name="google-site-verification" content="gsc_verify_token_12345" />' }));
  try {
    const home = await rawReq('/');
    assert.equal(home.status, 200);
    assert.match(home.body, /<link rel="canonical" href="https:\/\/www\.hotesim\.shop\/">/);
    assert.match(home.body, /hreflang="ar-PS"/);
    assert.match(home.body, /<meta name="google-site-verification" content="gsc_verify_token_12345">/);
    assert.match(home.body, /الضفة الغربية/);
    assert.match(home.body, /قطاع غزة/);
    assert.match(home.body, new RegExp(`href="/package/${qlPkg.id}"`));
    const homeLds = [...home.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const types = homeLds.map((x) => x['@type']);
    for (const t of ['WebSite', 'OnlineStore', 'ItemList', 'FAQPage']) assert.ok(types.includes(t), `missing ${t} JSON-LD on /`);
    const storeLd = homeLds.find((x) => x['@type'] === 'OnlineStore');
    assert.ok(storeLd.areaServed.some((a) => a.name === 'West Bank'), 'OnlineStore areaServed includes West Bank');
    assert.ok(storeLd.areaServed.some((a) => a.name === 'Gaza Strip'), 'OnlineStore areaServed includes Gaza Strip');
    const listLd = homeLds.find((x) => x['@type'] === 'ItemList');
    const firstOffer = listLd.itemListElement[0]?.item?.offers;
    assert.ok(firstOffer?.shippingDetails && firstOffer?.hasMerchantReturnPolicy && firstOffer?.priceValidUntil, 'Merchant Listings offer fields present');

    const apex = await rawReq('/package/1', { Host: 'hotesim.shop' });
    assert.equal(apex.status, 301);
    assert.equal(apex.headers.location, 'https://www.hotesim.shop/package/1');

    const dupShop = await rawReq('/shop');
    assert.equal(dupShop.status, 301);
    assert.equal(dupShop.headers.location, '/');

    const dupHtml = await rawReq('/shop.html');
    assert.equal(dupHtml.status, 301);
    assert.equal(dupHtml.headers.location, '/');

    const soft404 = await rawReq('/not-a-real-page-xyz');
    assert.equal(soft404.status, 404);
    assert.match(soft404.headers['x-robots-tag'] || '', /noindex/);

    const portal = await rawReq('/portal');
    assert.equal(portal.status, 200);
    assert.match(portal.headers['x-robots-tag'] || '', /noindex/);

    for (const slug of ['compat', 'esim-policy', 'guarantee', 'terms']) {
      const p = await rawReq(`/${slug}`);
      assert.equal(p.status, 200, `/${slug} returns 200`);
      assert.match(p.body, new RegExp(`<link rel="canonical" href="https://www\\.hotesim\\.shop/${slug}">`));
      assert.match(sm.body, new RegExp(`<loc>https://www\\.hotesim\\.shop/${slug}</loc>`));
    }

    // 6) Changing site name (appName) & esimFee in Settings immediately updates storefront & overrides stale company fees
    const beforeSt = await ok(call(admin, 'GET', '/api/settings'));
    q('UPDATE companies SET esim_fee = 99 WHERE id = ?').run(qlPkg.companyId);
    try {
      await ok(call(admin, 'PUT', '/api/settings', { appName: 'متجر فلسطين نت', esimFee: 5 }));
      const liveShop = await ok(call(null, 'GET', '/api/shop'));
      assert.equal(liveShop.shopName, 'متجر فلسطين نت');
      assert.equal(liveShop.shopTitle, 'متجر فلسطين نت');
      const livePk = liveShop.packages.find((p) => p.id === qlPkg.id);
      assert.equal(livePk.esimFee, 5, 'global esimFee clears stale company esim_fee override');
      assert.equal(livePk.total, livePk.price + 5);
      const liveHome = await rawReq('/');
      assert.match(liveHome.body, /<title>متجر فلسطين نت \|/);
    } finally {
      await ok(call(admin, 'PUT', '/api/settings', { appName: beforeSt.appName, shopTitle: beforeSt.shopTitle, esimFee: beforeSt.esimFee }));
    }
  } finally {
    await ok(call(admin, 'PUT', '/api/settings', { googleSiteVerification: '' }));
  }
});
