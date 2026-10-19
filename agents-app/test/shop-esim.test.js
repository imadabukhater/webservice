'use strict';
// The customer shop selling eSIMs, end to end: a customer picks a package and one of its free eSIM numbers, pays by
// JawwalPay, the payment is confirmed from JawwalPay's real e-mail wording (by the transaction number, else by the
// sender's name), the eSIM is activated automatically and its QR code is shown and e-mailed. Fakes: a QuickLine API
// with eSIM numbers, a Gmail inbox (IMAP), and Gmail's SMTP.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.IMAP_HOST = '127.0.0.1';
process.env.IMAP_SECURE = '0';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_SECURE = '0';
process.env.ART_CHECK_MS = '50';

const http = require('node:http');
const net = require('node:net');
const test = require('node:test');
const assert = require('node:assert/strict');

// ---------- QuickLine, with three free eSIM numbers ----------
const JWT = 'header.payload.signature';
const QR = 'iVBORw0KGgo=';
const ql = {
  created: [], added: [],
  esim: [9101, 9102, 9103].map((id, i) => ({ id, phone: `058111222${i}`, sim: `89972020123456789${i}`, barcodeImage: QR })),
};
const qlApi = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    const text = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(v); };
    const url = req.url.replace(/^\/api\//, '');
    const f = body ? JSON.parse(body) : {};
    if (url === 'Account/Login') {
      if (f.email !== 'dealer@example.com' || f.password !== 'ql-pass-123') return text('خطأ', 401);
      return json({ statusCode: 200, data: { jwt: JWT, userId: 'u1', type: 'Dealer', name: 'أحمد', email: f.email } });
    }
    if (req.headers.authorization !== `Bearer ${JWT}`) return text('unauthorized', 401);
    if (url === 'Companies/GetDealerCompanies') return json([{ id: 3, name: 'Cellcom', logo: 'c.jpg', color: '#72206A', postalCode: '89972020', simLength: 18 }]);
    if (url === 'Packages/GetPackagesByCompany/3') {
      return json([{
        company: { id: 3, name: 'Cellcom', logo: 'c.jpg', color: '#72206A' },
        package: { name: 'سلكوم 400 جيجا', id: 2564, gb: 400, sms: 5000, minutes: 5000, isOffer: false, offer: null, hasFakePrice: false },
        prices: { pricePerCustomer: 100, pricePerCustomerOffer: 100, fakePrice: null, cost: 62, costOffer: 62, secondaryPrice: 62, mainPrice: 62 },
        dealerId: 4606,
      }]);
    }
    if (url === 'Numbers/GetFreeNumbers') {
      const skip = new Set((f.Numbers || []).map(Number));
      return json(f.isEsim ? ql.esim.filter((n) => !skip.has(n.id)) : []);
    }
    if (url === 'Subscriptions/DealersGetAllDT') {
      return json({ draw: f.draw, recordsTotal: ql.added.length, recordsFiltered: ql.added.length, data: ql.added.slice(f.start, f.start + f.length).map((s, i) => ({
        company: { name: 'Cellcom', id: 3, simPrefix: '89972020', simLength: 18 }, package: { name: 'سلكوم 400 جيجا', id: 2564, gb: 400 },
        customer: { name: 'زبون', id: 1 }, daysLeft: { value: 30, color: 'success' }, status: { name: 'جديد', value: 'info', valueInt: 1 },
        automaticRenew: { name: 'غير فعال', text: 'danger', value: false },
        subscription: { id: s.id, phoneNumber: s.number, simNumber: s.sim, customerPrice: null, isEsim: { name: 'نعم', value: 'success', valueInt: 1 } },
        constantRenew: { name: 'غير فعال', text: 'danger', value: false },
        actions: { canExtend: false, canDisconnect: true, canPause: true, canChangeSim: true, canChangeAutomaticRenew: true, canRefresh: true },
        cutDate: '20/11/2026', connectionDate: '21/10/2026', updateDate: '21/10/2026', dealer: { id: 4606, name: 'أحمد', phone: '0534559260' }, belongsToUser: true, number: i + 1,
      })) });
    }
    if (url === 'Subscriptions/NewSubscription') {
      ql.created.push(f);
      const n = ql.esim.find((x) => x.id === Number(f.numberId));
      ql.added.push({ id: 500000 + ql.added.length, number: n.phone, sim: n.sim });
      return text('تمت إضافة الاشتراك بنجاح');
    }
    return text('not found', 404);
  });
});

// ---------- Gmail: the inbox (IMAP) ----------
const inbox = [];
const imap = net.createServer((sock) => {
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
      if (/^LOGIN/i.test(cmd)) sock.write(cmd.includes('"abcdefghijklmnop"') ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
      else if (/^SELECT/i.test(cmd)) sock.write(`* ${inbox.length} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n${tag} OK [READ-WRITE] done\r\n`);
      else if (/^UID SEARCH/i.test(cmd)) sock.write(`* SEARCH${inbox.map((_, n) => ` ${n + 1}`).join('')}\r\n${tag} OK done\r\n`);
      else if (/^UID FETCH/i.test(cmd)) {
        const uid = Number(cmd.split(' ')[2]);
        const raw = Buffer.from(inbox[uid - 1], 'utf8');
        sock.write(Buffer.concat([Buffer.from(`* ${uid} FETCH (UID ${uid} BODY[] {${raw.length}}\r\n`), raw, Buffer.from(`)\r\n${tag} OK done\r\n`)]));
      } else if (/^LOGOUT/i.test(cmd)) { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end(); }
      else sock.write(`${tag} BAD unknown\r\n`);
    }
  });
  sock.on('error', () => {});
});
// As JawwalPay's e-mails reach Gmail: from noreply@jawwalpay.ps, DMARC passed.
const jawwalPay = (body) => inbox.push([
  'Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=jawwalpay.ps; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=jawwalpay.ps',
  'From: Jawwal Pay <noreply@jawwalpay.ps>', 'Subject: Jawwal Pay', `Message-ID: <m${inbox.length + 1}@jawwalpay.ps>`,
  `Date: ${new Date(Date.now() + 1000).toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
  Buffer.from(body).toString('base64'), '',
].join('\r\n'));

// ---------- Gmail: sending (SMTP) ----------
const outbox = [];
const smtpServer = net.createServer((sock) => {
  let buf = '';
  let data = null;
  const m = { auth: '', from: '', to: '', body: '' };
  sock.write('220 fake smtp ready\r\n');
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (data !== null) {
        if (line === '.') { m.body = data; data = null; outbox.push({ ...m }); sock.write('250 OK queued\r\n'); } else data += `${line}\r\n`;
        continue;
      }
      if (/^EHLO/i.test(line)) sock.write('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 SMTPUTF8\r\n');
      else if (/^AUTH PLAIN /i.test(line)) {
        m.auth = Buffer.from(line.slice(11), 'base64').toString();
        sock.write(m.auth === '\0shop@gmail.com\0abcdefghijklmnop' ? '235 Accepted\r\n' : '535 Bad credentials\r\n');
      } else if (/^MAIL FROM:/i.test(line)) { m.from = line.slice(10); sock.write('250 OK\r\n'); }
      else if (/^RCPT TO:/i.test(line)) { m.to = line.slice(8); sock.write('250 OK\r\n'); }
      else if (/^DATA/i.test(line)) { data = ''; sock.write('354 Go ahead\r\n'); }
      else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('500 unknown\r\n');
    }
  });
  sock.on('error', () => {});
});

// ---------- Layan, with free eSIM numbers on its WE package ----------
const LY_SECRET = 'JBSWY3DPEHPK3PXP';
const LY_PKG = '22222222-2222-2222-2222-222222222222';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const lyFake = { newLines: [], emptySims: [], free: ['0515102941', '0515102942'] };
const lyApi = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    const text = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(v); };
    if (req.url === '/qr/esim-1.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    const url = req.url.replace(/^\/api\//, '');
    const f = body ? JSON.parse(body) : {};
    if (url === 'Auth/Login') return f.username === 'ly.dealer' && f.password === 'ly-pass' ? json({ statusCode: 202, data: { requestId: 'r1', verificationMethod: 2 } }) : text('خطأ', 400);
    if (url === 'Auth/VerifyCode') return f.code === require('../src/layan').totp(LY_SECRET) ? json({ jwt: 'ly.jwt' }) : text('קוד שגוי', 400);
    if (req.headers.authorization !== 'Bearer ly.jwt') return text('unauthorized', 401);
    if (url === 'Packages/GetPackageDuration') return json([{ name: 'חודש', value: 30 }]);
    if (url === 'Packages/GetPackagesSortedByCompanies/false') {
      return json([{ company: { id: 'c9', name: 'We' }, packages: [{ id: LY_PKG, name: 'חבילת 500 גיגה 2026', internet: '500', cost: 32, isActive: true, saleId: null, duration: null }] }]);
    }
    if (url === `Numbers/GetAvailableNumbersForPackage/${LY_PKG}/true`) return json(lyFake.free.map((phoneNumber) => ({ phoneNumber })));
    const empty = /^Packages\/GetEmptySim\/([^/]+)\/(\d+)$/.exec(url);
    if (empty) { lyFake.emptySims.push(empty[2]); return json({ sim: '8997209000000000071', url: '/qr/esim-1.png', price: '7' }); }
    if (url === 'Deals/NewLine') { lyFake.newLines.push(f); return text('בוצע בהצלחה'); }
    return text('not found', 404);
  });
});

let base;
let server;
const call = async (token, method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const ok = async (p) => { const r = await p; assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 60)); }
};

test.before(async () => {
  await new Promise((r) => qlApi.listen(0, '127.0.0.1', r));
  await new Promise((r) => imap.listen(0, '127.0.0.1', r));
  await new Promise((r) => smtpServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => lyApi.listen(0, '127.0.0.1', r));
  process.env.LY_BASE = `http://127.0.0.1:${lyApi.address().port}`;
  process.env.QL_BASE = `http://127.0.0.1:${qlApi.address().port}`;
  process.env.IMAP_PORT = String(imap.address().port);
  process.env.SMTP_PORT = String(smtpServer.address().port);
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
test.after(() => { server.close(); qlApi.close(); lyApi.close(); imap.close(); smtpServer.close(); });

test('eSIM shop: pick a number, pay by JawwalPay, confirmed from the e-mail, activated, QR shown and e-mailed', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  await ok(call(admin, 'PUT', '/api/settings', {
    qlUser: 'dealer@example.com', qlPass: 'ql-pass-123',
    shopEnabled: true, jawwalpayNumber: '0567725080', jawwalpayName: 'المتجر', gmailUser: 'shop@gmail.com', gmailPass: 'abcd efgh ijkl mnop',
  }));
  assert.equal((await ok(call(admin, 'GET', '/api/settings'))).mailFrom, 'jawwalpay.ps', 'JawwalPay e-mails are trusted from their own domain only');
  await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'invoice' }));
  const pkg = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.supplier === 'ql' && p.kind === 'invoice');
  await ok(call(admin, 'PUT', `/api/packages/${pkg.id}`, { shopPrice: 90 }));

  // ----- the catalog and the free numbers: no supplier, no eSIM data before payment -----
  const pub = await ok(call(null, 'GET', '/api/shop'));
  const sp = pub.packages.find((p) => p.id === pkg.id);
  assert.deepEqual([sp.esim, sp.price], [true, 90]);
  assert.deepEqual(pub.jawwalpay, { number: '0567725080', name: 'المتجر' });
  const nums = await ok(call(null, 'GET', `/api/shop/numbers?packageId=${pkg.id}`));
  assert.deepEqual(nums, [{ id: 9101, phone: '0581112220' }, { id: 9102, phone: '0581112221' }, { id: 9103, phone: '0581112222' }]);
  assert.ok(!/QuickLine|8997|iVBOR/.test(JSON.stringify([pub, nums])), 'no supplier, SIM or QR code before payment');

  // ----- an order holds its number -----
  const order = (body) => call(null, 'POST', '/api/shop/orders', { kind: 'esim', packageId: pkg.id, ...body });
  assert.equal((await order({ numberId: 9101 })).status, 400, 'a name is needed to register the line');
  assert.equal((await order({ numberId: 9999, customerName: 'زبون' })).status, 400, 'a number from the list only');
  assert.equal((await order({ numberId: 9101, customerName: 'زبون', email: 'not-an-email' })).status, 400);
  const a = await ok(order({ numberId: 9101, customerName: 'المعتز بالله ابو خاطر', email: 'Buyer@Example.com' }));
  assert.deepEqual([a.status, a.esim, a.number, a.amount, a.email, a.esimQr], ['awaiting_payment', true, '0581112220', 90, 'buyer@example.com', null]);
  assert.ok(a.reservedUntil > Date.now() + 29 * 60_000, 'held for 30 minutes');
  assert.equal(a.sim, undefined, 'the eSIM itself is not shown');
  assert.equal((await order({ numberId: 9101, customerName: 'زبون آخر' })).status, 409, 'nobody else can buy it meanwhile');
  assert.deepEqual((await ok(call(null, 'GET', `/api/shop/numbers?packageId=${pkg.id}`))).map((n) => n.id), [9102, 9103]);

  // ----- a transfer sent from the wallet is never a payment, even with its transaction number -----
  jawwalPay('تمت حركة تحويل الأموال لمبلغ: ILS 90.00 للمشترك: 00970592578034 بنجاح! رصيدك الحالي: ILS 415.00. رقم الحركة: 2922925325476.');
  const b = await ok(order({ numberId: 9102, customerName: 'زبون ثانٍ' }));
  const vb = await ok(call(null, 'POST', `/api/shop/orders/${b.code}/proof`, { payReference: '2922925325476' }));
  assert.equal(vb.status, 'verifying', 'not paid by an outgoing transfer');

  // ----- paid: JawwalPay's e-mail with the transaction number in brackets -----
  jawwalPay('لقد استلمت حركه تحويل اموال بقيمة: ILS 90.00 من المعتز بالله عاطف ابو خاطر . الرصيد الحالي: ILS 505.00 .المرجع :(2922922722823)');
  const va = await ok(call(null, 'POST', `/api/shop/orders/${a.code}/proof`, { payReference: '2922922722823' }));
  assert.equal(va.status, 'paid');
  const done = await until(async () => { const o = await ok(call(null, 'GET', `/api/shop/orders/${a.code}`)); return o.stage === 'done' && o; });
  assert.equal(done.esimQr, `data:image/png;base64,${QR}`, 'the QR code shows once the line is active');
  assert.deepEqual([ql.created[0].newSubscriptionType, ql.created[0].numberId], ['newEsimSubscription', '9101']);
  const adminOrder = (await ok(call(admin, 'GET', '/api/shop/admin/orders'))).find((o) => o.code === a.code);
  assert.match(adminOrder.verifiedBy, /الرقم المرجعي/);

  // ----- the QR code by e-mail, once -----
  const r = await ok(call(admin, 'POST', '/api/shop/admin/check-mail'));
  assert.equal(r.mailed, 1);
  assert.equal(outbox.length, 1);
  const sent = outbox[0];
  assert.equal(sent.to, '<buyer@example.com>');
  assert.match(sent.body, /Content-Type: image\/png; name="esim-0581112220.png"/);
  assert.match(sent.body, /Content-ID: <esim-qr>/);
  assert.ok(sent.body.includes(QR));
  assert.match(sent.body, /^Subject: =\?UTF-8\?B\?/m);
  assert.equal((await ok(call(null, 'GET', `/api/shop/orders/${a.code}`))).qrMailed, true);
  assert.equal((await ok(call(admin, 'POST', '/api/shop/admin/check-mail'))).mailed, 0, 'not sent twice');

  // ----- no transaction number: the full name as JawwalPay shows it, with the exact amount -----
  const c = await ok(order({ numberId: 9103, customerName: 'محمد خليل' }));
  jawwalPay('لقد استلمت حركه تحويل اموال بقيمة: ILS 90.00 من مُحمّد أحمد خليل . الرصيد الحالي: ILS 595.00 .المرجع :(2922931111111)');
  const vc = await ok(call(null, 'POST', `/api/shop/orders/${c.code}/proof`, { payName: 'محمد احمد خليل' }));
  assert.equal(vc.status, 'paid');
  await until(async () => (await ok(call(null, 'GET', `/api/shop/orders/${c.code}`))).stage === 'done');

  // The shop account keeps the profit: paid 90 twice, each charged the agent's price and the eSIM fee.
  const shopAgent = (await ok(call(admin, 'GET', '/api/agents'))).find((x) => x.name === 'متجر الزبائن');
  assert.ok(shopAgent.balance > 0 && shopAgent.balance < 180, String(shopAgent.balance));
  // The order B is still waiting (its "payment" was our own transfer), and holds its number.
  assert.equal((await ok(call(null, 'GET', `/api/shop/orders/${b.code}`))).status, 'verifying');
});

test('eSIM shop with Layan: its free eSIM numbers, activated after payment with the QR code Layan gives', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  await ok(call(admin, 'PUT', '/api/settings', { lyUser: 'ly.dealer', lyPass: 'ly-pass', lySecret: LY_SECRET }));
  await ok(call(admin, 'POST', '/api/layan/sync', { kind: 'invoice' }));
  const pkg = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.supplier === 'ly' && p.kind === 'invoice');
  await ok(call(admin, 'PUT', `/api/packages/${pkg.id}`, { shopPrice: 60 }));
  assert.equal((await ok(call(null, 'GET', '/api/shop'))).packages.find((p) => p.id === pkg.id).esim, true);

  const nums = await ok(call(null, 'GET', `/api/shop/numbers?packageId=${pkg.id}`));
  assert.deepEqual(nums.map((n) => n.phone), ['0515102941', '0515102942']);
  assert.equal(lyFake.emptySims.length, 0, 'no eSIM is taken from Layan before payment');
  const o = await ok(call(null, 'POST', '/api/shop/orders', { kind: 'esim', packageId: pkg.id, numberId: nums[0].id, customerName: 'زبون ليان', email: 'ly@example.com' }));
  assert.deepEqual([o.number, o.esim, o.amount], ['0515102941', true, 60]);
  assert.deepEqual((await ok(call(null, 'GET', `/api/shop/numbers?packageId=${pkg.id}`))).map((n) => n.phone), ['0515102942'], 'held for this customer');

  jawwalPay('لقد استلمت حركه تحويل اموال بقيمة: ILS 60.00 من زبون ليان . الرصيد الحالي: ILS 700.00 .المرجع :(2922950000001)');
  assert.equal((await ok(call(null, 'POST', `/api/shop/orders/${o.code}/proof`, { payReference: '2922950000001' }))).status, 'paid');
  const done = await until(async () => { const v = await ok(call(null, 'GET', `/api/shop/orders/${o.code}`)); return v.stage === 'done' && v; });
  assert.equal(done.esimQr, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.deepEqual(lyFake.emptySims, ['0515102941']);
  const sent = lyFake.newLines[0];
  assert.deepEqual([sent.Number, sent.packageId, sent.SimNumber, sent.isEsim, sent.Customer.Fullname, sent.Duration, sent.Price, sent.isPaid],
    ['0515102941', LY_PKG, '8997209000000000071', true, 'زبون ليان', 30, 60, true]);
  const task = (await ok(call(admin, 'GET', '/api/tasks'))).find((t) => t.lineNumber === '0515102941');
  assert.deepEqual([task.type, task.status, task.source], ['esim', 'done', 'ليان']);
  assert.equal((await ok(call(admin, 'POST', '/api/shop/admin/check-mail'))).mailed, 1, 'its QR code e-mailed too');
  assert.match(outbox.at(-1).to, /ly@example.com/);
});
