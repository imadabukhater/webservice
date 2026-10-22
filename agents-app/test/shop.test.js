'use strict';
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.IMAP_HOST = '127.0.0.1';
process.env.IMAP_SECURE = '0';
process.env.SHOP_VERIFY_MS = '1500';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

// ---------- a small IMAP server holding test emails ----------
const inbox = [];
const imapLog = [];
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
      imapLog.push(cmd);
      if (/^LOGIN/i.test(cmd)) sock.write(cmd.includes('"abcdefghijklmnop"') ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
      else if (/^SELECT/i.test(cmd)) sock.write(`* ${inbox.length} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n${tag} OK [READ-WRITE] done\r\n`);
      else if (/^UID SEARCH/i.test(cmd)) sock.write(`* SEARCH${inbox.map((_, n) => ` ${n + 1}`).join('')}\r\n${tag} OK done\r\n`);
      else if (/^UID FETCH/i.test(cmd)) {
        const uid = Number(cmd.split(' ')[2]);
        const raw = Buffer.from(inbox[uid - 1], 'utf8');
        sock.write(`* ${uid} FETCH (UID ${uid} BODY[] {${raw.length}}\r\n`);
        sock.write(raw);
        sock.write(`)\r\n${tag} OK done\r\n`);
      } else if (/^LOGOUT/i.test(cmd)) { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end(); }
      else sock.write(`${tag} BAD unknown\r\n`);
    }
  });
});

const GOOD_AUTH = 'mx.google.com; dkim=pass header.i=@jawwal.ps header.s=k1; spf=pass smtp.mailfrom=jawwal.ps; dmarc=pass (p=REJECT) header.from=jawwal.ps';
let mailN = 0;
function addMail(body, { from = 'JawwalPay <notify@jawwal.ps>', auth = GOOD_AUTH } = {}) {
  mailN++;
  inbox.push([
    ...(auth ? [`Authentication-Results: ${auth}`] : []),
    `From: ${from}`, `Subject: =?UTF-8?B?${Buffer.from('إشعار تحويل').toString('base64')}?=`, `Message-ID: <m${mailN}@jawwal.ps>`,
    `Date: ${new Date(Date.now() + 1000).toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(body).toString('base64'), '',
  ].join('\r\n'));
}

let base;
let server;
const call = async (token, method, url, body, headers = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
};
const ok = async (p) => {
  const r = await p;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test.before(async () => {
  await new Promise((r) => imap.listen(0, '127.0.0.1', r));
  process.env.IMAP_PORT = String(imap.address().port);
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
test.after(() => { server.close(); imap.close(); });

test('email parsing: MIME, encoded headers, Arabic digits and sender authentication', () => {
  const mail = require('../src/mail');
  const raw = ['Authentication-Results: mx.google.com; dkim=pass header.i=@jawwal.ps; dmarc=pass header.from=jawwal.ps',
    'From: =?UTF-8?B?' + Buffer.from('جوال باي').toString('base64') + '?= <noreply@jawwal.ps>',
    'Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    '<p>=D8=A7=D9=84=D9=85=D8=A8=D9=84=D8=BA: =D9=A7=D9=A0 &#8362;</p><p>Ref: AB-7781</p>', '--b1--', ''].join('\r\n');
  const p = mail.parseMessage(Buffer.from(raw, 'latin1'));
  assert.equal(p.from, 'جوال باي <noreply@jawwal.ps>');
  assert.match(p.text, /المبلغ: ٧٠ ₪/);
  assert.deepEqual(mail.parseJawwalPay(p), { amount: 70, reference: 'AB-7781', senderPhone: null, senderName: null, incoming: false });
  assert.equal(mail.authenticSender(p, 'jawwal'), true);
  assert.equal(mail.authenticSender({ ...p, auth: 'mx.google.com; dkim=none; dmarc=fail header.from=jawwal.ps' }, 'jawwal'), false);
  assert.equal(mail.authenticSender({ ...p, auth: '' }, 'jawwal'), false);
  const f = mail.parseJawwalPay({ text: 'You received 1,250.50 ILS from Ahmad Ali. Mobile: +970 59 912 3456. Transaction ID: 99887766' }, { ownNumber: '0599000000' });
  assert.deepEqual(f, { amount: 1250.5, reference: '99887766', senderPhone: '0599123456', senderName: 'Ahmad Ali', incoming: true });
  // JawwalPay's own wording: money received (the reference in brackets), and a transfer sent from the wallet,
  // which is not a payment (the number in it is where the money went, not who paid).
  assert.deepEqual(mail.parseJawwalPay({ text: 'لقد استلمت حركه تحويل اموال بقيمة: ILS 1.00 من المعتز بالله عاطف ابو خاطر . الرصيد الحالي: ILS 425.00 .المرجع :(2922922722823)' }),
    { amount: 1, reference: '2922922722823', senderPhone: null, senderName: 'المعتز بالله عاطف ابو خاطر', incoming: true });
  assert.equal(mail.parseJawwalPay({ text: 'تمت حركة تحويل الأموال لمبلغ: ILS 10.00 للمشترك: 00970592578034 بنجاح! رصيدك الحالي: ILS 415.00. رقم الحركة: 2922925325476.' }).incoming, false);
  assert.deepEqual(mail.parseJawwalPay({ text: 'Mona Mohammed Omar Hasaballah قام بتحويل مبلغ ILS 50.00 لحسابك بتاريخ 19-10-2026 11:17:00 AM. الرصيد المتوفر ILS 852.00.' }),
    { amount: 50, reference: null, senderPhone: null, senderName: 'Mona Mohammed Omar Hasaballah', incoming: true });
  assert.equal(mail.parseJawwalPay({ text: 'حركة طلب رقم سري لمرة واحدة والمخصص لعملية تعديل الايميل تمت بنجاح. الرقم هو 59806.' }).incoming, false);
  // A domain is that domain (or one under it), never a look-alike.
  const jp = { from: 'Jawwal Pay <noreply@jawwalpay.ps>', auth: 'mx.google.com; spf=pass smtp.mailfrom=jawwalpay.ps; dmarc=pass (p=NONE) header.from=jawwalpay.ps' };
  assert.equal(mail.authenticSender(jp, 'jawwalpay.ps'), true);
  assert.equal(mail.authenticSender({ ...jp, from: 'x <a@myjawwalpay.ps>' }, 'jawwalpay.ps'), false);
  assert.equal(mail.authenticSender({ ...jp, from: 'x <a@jawwalpay.ps.example.com>' }, 'jawwalpay.ps'), false);
  assert.equal(mail.authenticSender({ ...jp, from: 'x <a@mail.jawwalpay.ps>' }, 'jawwalpay.ps'), true);
  const { namesMatch, matchReason } = require('../src/shop');
  assert.ok(namesMatch('محمد احمد', 'مُحمّد أحمد خليل'));
  assert.ok(namesMatch('محمد حسين علي saek', 'mohammed Hussein ali skaek'), 'Arabic + English mixed name with 1-char typo matches');
  assert.ok(namesMatch('منى محمد عمر حسب الاه', 'Mona Mohammed Omar Hasaballah'), 'Arabic compound name matches English JawwalPay name');
  assert.ok(namesMatch('المعتز بالله عاطف ابو خاطر', 'المعتزبالله عاطف ابوخاطر'), 'compound Arabic names match regardless of spacing');
  assert.ok(!namesMatch('محمد', 'محمد أحمد'), 'one word is not enough unless it is the whole name');
  assert.ok(!namesMatch('سامي خليل', 'محمد أحمد'));
  assert.ok(!namesMatch('محمد خليل', 'محمود خليل'), 'distinct Arabic names never collide');
  assert.ok(!namesMatch('حسن علي', 'حسين علي'), 'distinct Arabic names never collide');
  // Payment matching security: conflicting reference or phone must never fall back to name, and untrusted emails never match.
  assert.equal(matchReason({ pay_reference: 'REF-111', pay_name: 'محمد أحمد' }, { reference: 'REF-999', sender_name: 'محمد أحمد', trusted: 1 }), null);
  assert.equal(matchReason({ pay_phone: '0599111111', pay_name: 'محمد أحمد' }, { sender_phone: '0599222222', sender_name: 'محمد أحمد', trusted: 1 }), null);
  assert.equal(matchReason({ pay_reference: 'REF-111' }, { reference: 'REF-111', trusted: 0 }), null);
  assert.equal(matchReason({ pay_reference: '12' }, { reference: '12', trusted: 1 }), null, 'too short reference');
  assert.equal(matchReason({ pay_reference: '85749' }, { reference: '2922947585749', trusted: 1 }), 'الرقم المرجعي', 'last 5+ digits of long reference match');
});

test('customer shop: order, JawwalPay proof, automatic match from Gmail, fulfilment and manual review', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;

  // Closed until the manager opens it.
  assert.equal((await ok(call(null, 'GET', '/api/shop'))).enabled, false);
  assert.equal((await call(null, 'POST', '/api/shop/orders', { packageId: 1, number: '0521234567' })).status, 403);

  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const cellcom = cat.companies.find((c) => c.name === 'سلكوم');
  const partner = cat.companies.find((c) => c.name === 'بارتنر');
  await ok(call(admin, 'PUT', `/api/companies/${cellcom.id}`, { activation: 'direct' }));
  const p500 = cat.packages.find((p) => p.name === '500 جيجا');
  const pPartner = cat.packages.find((p) => p.companyId === partner.id);
  await ok(call(admin, 'PUT', `/api/packages/${p500.id}`, { cost: 60, price: 80, shopPrice: 95 }));
  await ok(call(admin, 'PUT', `/api/packages/${pPartner.id}`, { cost: 20, price: 30, shopPrice: 40 }));
  assert.equal((await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.id === p500.id).shopPrice, 95);

  await ok(call(admin, 'PUT', '/api/settings', {
    shopEnabled: true, jawwalpayNumber: '0599000000', jawwalpayName: 'متجر الاتصالات', gmailUser: 'shop@gmail.com', gmailPass: 'abcd efgh ijkl mnop', mailFrom: 'jawwal',
  }));
  const settings = await ok(call(admin, 'GET', '/api/settings'));
  assert.equal(settings.gmailConfigured, true);
  assert.equal(settings.gmailPass, undefined, 'the app password never leaves the server');

  const pub = await ok(call(null, 'GET', '/api/shop'));
  assert.equal(pub.enabled, true);
  assert.deepEqual(pub.jawwalpay, { number: '0599000000', name: 'متجر الاتصالات' });
  assert.deepEqual(pub.packages.map((p) => [p.id, p.price]), [[p500.id, 95], [pPartner.id, 40]]);
  assert.equal(pub.packages[0].cost, undefined, 'customers never see costs');

  // ----- 1: reference number matches an authenticated email -----
  const o1 = await ok(call(null, 'POST', '/api/shop/orders', { packageId: p500.id, number: '+972 52-123-4567', customerName: 'زبون أول' }));
  assert.equal(o1.status, 'awaiting_payment');
  assert.equal(o1.amount, 95);
  assert.equal(o1.number, '0521234567');
  assert.match(o1.code, /^[A-Z0-9]{8}$/);
  assert.equal((await call(null, 'POST', `/api/shop/orders/${o1.code}/proof`, {})).status, 400, 'something to verify is required');
  let v = await ok(call(null, 'POST', `/api/shop/orders/${o1.code}/proof`, { payReference: 'tx-1001' }));
  assert.equal(v.status, 'verifying', 'no email yet');
  addMail('تم استلام حوالة بمبلغ 95.00 شيكل\nالرقم المرجعي: TX-1001\nمن: أحمد');
  const check = await ok(call(admin, 'POST', '/api/shop/admin/check-mail'));
  assert.equal(check.fetched, 1);
  assert.equal(check.matched, 1);
  v = await ok(call(null, 'GET', `/api/shop/orders/${o1.code.toLowerCase()}`));
  assert.equal(v.status, 'paid');
  assert.equal(v.stage, 'done', 'direct company: active at once');
  assert.ok(v.expiresAt > Date.now());
  assert.ok(imapLog.some((c) => /^UID FETCH \d+ BODY\.PEEK\[\]$/.test(c)), 'emails stay unread');

  const summary = await ok(call(admin, 'GET', '/api/shop/admin/summary'));
  const shopAgent = (await ok(call(admin, 'GET', '/api/agents'))).find((a) => a.id === summary.agentId);
  assert.equal(shopAgent.name, 'متجر الزبائن');
  assert.equal(shopAgent.balance, 15, 'paid 95, charged the agent price 80');
  const lines = await ok(call(admin, 'GET', `/api/lines?agentId=${shopAgent.id}`));
  assert.equal(lines[0].number, '0521234567');
  assert.equal(lines[0].customerPrice, 95);

  // ----- 2: a forged email (no Gmail authentication) is never trusted -----
  addMail('استلمت حوالة بمبلغ 95 ₪ من الرقم 0597777777', { from: 'JawwalPay <notify@jawwal.ps>', auth: '' });
  const o2 = await ok(call(null, 'POST', '/api/shop/orders', { packageId: p500.id, number: '0527654321' }));
  v = await ok(call(null, 'POST', `/api/shop/orders/${o2.code}/proof`, { payPhone: '0597777777', receipt: PNG }));
  assert.equal(v.status, 'verifying');
  await new Promise((r) => setTimeout(r, 1600));
  await ok(call(admin, 'POST', '/api/shop/admin/check-mail'));
  v = await ok(call(null, 'GET', `/api/shop/orders/${o2.code}`));
  assert.equal(v.status, 'review', 'unmatched proofs go to the manager');
  const open = await ok(call(admin, 'GET', '/api/shop/admin/orders?filter=open'));
  const a2 = open.find((o) => o.code === o2.code);
  assert.ok(a2.hasReceipt);
  const d2 = await ok(call(admin, 'GET', `/api/shop/admin/orders/${a2.id}`));
  assert.equal(d2.receipt, PNG);
  const forged = d2.candidates.find((m) => m.senderPhone === '0597777777');
  assert.equal(forged.trusted, false);
  // The manager checked JawwalPay and confirms by hand, linking the email.
  const ap = await ok(call(admin, 'POST', `/api/shop/admin/orders/${a2.id}/approve`, { mailId: forged.id }));
  assert.equal(ap.stage, 'done');
  assert.match(ap.verifiedBy, /يدوي/);

  // ----- 3: the email arrives before the proof; sender name matches -----
  addMail('استلمت 95 ILS\nالمرسل: مُحمّد أحمد خليل\nرقم العملية 55667788');
  const o3 = await ok(call(null, 'POST', '/api/shop/orders', { packageId: p500.id, number: '0531112222' }));
  v = await ok(call(null, 'POST', `/api/shop/orders/${o3.code}/proof`, { payName: 'محمد احمد' }));
  assert.equal(v.stage, 'done', 'proof triggers an immediate mailbox check');

  // The same email cannot pay a second order.
  const o4 = await ok(call(null, 'POST', '/api/shop/orders', { packageId: p500.id, number: '0531113333' }));
  v = await ok(call(null, 'POST', `/api/shop/orders/${o4.code}/proof`, { payName: 'محمد احمد', payReference: '55667788' }));
  assert.notEqual(v.status, 'paid');
  const a4 = (await ok(call(admin, 'GET', '/api/shop/admin/orders'))).find((o) => o.code === o4.code);
  v = await ok(call(admin, 'POST', `/api/shop/admin/orders/${a4.id}/reject`, { response: 'لم يصل التحويل' }));
  assert.equal(v.status, 'rejected');
  assert.equal((await ok(call(null, 'GET', `/api/shop/orders/${o4.code}`))).response, 'لم يصل التحويل');

  // ----- 4: paid, but the number belongs to another agent: the manager fixes the number and retries -----
  const ag = await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل', username: 'ag1', password: 'secret1', balance: 500 }));
  const agTok = (await ok(call(null, 'POST', '/api/login', { username: 'ag1', password: 'secret1' }))).token;
  await ok(call(agTok, 'POST', '/api/lines', { kind: 'external', number: '0539999999', packageId: p500.id }));
  addMail('استلمت حوالة 95 شيكل Reference: RR-5');
  const o5 = await ok(call(null, 'POST', '/api/shop/orders', { packageId: p500.id, number: '0539999999' }));
  v = await ok(call(null, 'POST', `/api/shop/orders/${o5.code}/proof`, { payReference: 'RR-5' }));
  assert.equal(v.status, 'paid');
  assert.equal(v.stage, 'paid_issue');
  const a5 = (await ok(call(admin, 'GET', '/api/shop/admin/orders?filter=open'))).find((o) => o.code === o5.code);
  assert.match(a5.error, /وكيل آخر/);
  assert.equal((await ok(call(admin, 'GET', '/api/agents'))).find((a) => a.id === shopAgent.id).balance, 45, 'a refused sale leaves no money moved');
  v = await ok(call(admin, 'POST', `/api/shop/admin/orders/${a5.id}/retry`, { number: '0539990000' }));
  assert.equal(v.stage, 'done');

  // ----- 5: manual company: paid orders become the manager's tasks -----
  addMail('استلمت حوالة 40.00 ₪ Ref: PP-9');
  const o6 = await ok(call(null, 'POST', '/api/shop/orders', { packageId: pPartner.id, number: '0541234567', customerName: 'زبون بارتنر' }));
  v = await ok(call(null, 'POST', `/api/shop/orders/${o6.code}/proof`, { payReference: 'pp-9' }));
  assert.equal(v.stage, 'processing');
  const tasks = await ok(call(admin, 'GET', '/api/tasks?status=open'));
  const task = tasks.find((t) => t.lineNumber === '0541234567');
  assert.equal(task.type, 'recharge');
  await ok(call(admin, 'POST', `/api/tasks/${task.id}/resolve`, { status: 'done' }));
  assert.equal((await ok(call(null, 'GET', `/api/shop/orders/${o6.code}`))).stage, 'done');

  // Cancelling is only possible before paying; unknown codes are 404.
  const o7 = await ok(call(null, 'POST', '/api/shop/orders', { packageId: p500.id, kind: 'new', number: '0551234567', sim: '8997202123456789012' }));
  assert.equal((await ok(call(null, 'POST', `/api/shop/orders/${o7.code}/cancel`))).status, 'cancelled');
  assert.equal((await call(null, 'GET', '/api/shop/orders/NOPE1234')).status, 404);
  assert.equal((await call(null, 'POST', '/api/shop/orders', { packageId: p500.id, kind: 'new', number: '0551234567', sim: '12' })).status, 400);

  // The mailbox list for the manager.
  const mails = await ok(call(admin, 'GET', '/api/shop/admin/mails'));
  assert.equal(mails.length, 5);
  assert.ok(mails.every((m) => m.amount !== null));

  // Wrong app password: a clear error.
  await ok(call(admin, 'PUT', '/api/settings', { gmailPass: 'wrong' }));
  const bad = await call(admin, 'POST', '/api/shop/admin/check-mail');
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /App Password/);

  // The shop page.
  const page = await call(null, 'GET', '/shop');
  assert.match(page.body, /js\/shop\.js/);

  // Root '/' serves the customer shop as the main landing page.
  const rootPage = await call(null, 'GET', '/');
  assert.match(rootPage.body, /js\/shop\.js/);

  // Portal '/portal' and '/admin' serve the agents & manager portal (index.html).
  const portalPage = await call(null, 'GET', '/portal');
  assert.match(portalPage.body, /js\/main\.js/);
  const adminPage = await call(null, 'GET', '/admin');
  assert.match(adminPage.body, /js\/main\.js/);
});

test('connected sites: catalog, orders and balance with an API key; invoices', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  const site = await ok(call(admin, 'POST', '/api/agents', { name: 'موقع شريك', username: 'site1', password: 'secret1', balance: 200 }));
  const k = await ok(call(admin, 'POST', '/api/sync-keys', { agentId: site.id, name: 'example.com' }));
  assert.match(k.key, /^ak_/);
  const keys = await ok(call(admin, 'GET', '/api/sync-keys'));
  assert.equal(keys[0].prefix, k.key.slice(0, 7));
  assert.equal(keys[0].key, undefined);

  const H = { 'X-Api-Key': k.key };
  assert.equal((await call(null, 'GET', '/api/v1/catalog')).status, 401);
  assert.equal((await call(null, 'GET', '/api/v1/catalog', undefined, { 'X-Api-Key': 'ak_wrong' })).status, 401);
  const cat = await ok(call(null, 'GET', '/api/v1/catalog', undefined, H));
  const p500 = cat.packages.find((p) => p.name === '500 جيجا');
  assert.equal(p500.price, 80);
  assert.equal(p500.suggestedPrice, 95);
  assert.equal(p500.cost, undefined);

  const r = await ok(call(null, 'POST', '/api/v1/orders', { packageId: p500.id, number: '0561234567', customerName: 'عبر الموقع', reference: 'W-1' }, H));
  assert.equal(r.order.status, 'active');
  assert.equal(r.balance, 120);
  assert.equal((await ok(call(null, 'GET', `/api/v1/orders/${r.order.id}`, undefined, H))).order.number, '0561234567');
  assert.equal((await ok(call(null, 'GET', '/api/v1/balance', undefined, H))).available, 120);
  assert.equal((await call(null, 'POST', '/api/v1/orders', { packageId: p500.id, number: '0561234567' }, H)).status, 200, 'recharging its own number extends it');
  assert.equal((await call(null, 'POST', '/api/v1/orders', { packageId: p500.id, number: '0570000000' }, H)).status, 400, 'no balance left');

  await ok(call(admin, 'DELETE', `/api/sync-keys/${k.id}`));
  assert.equal((await call(null, 'GET', '/api/v1/catalog', undefined, H)).status, 401);

  // ----- invoices -----
  const inv = await ok(call(admin, 'POST', '/api/invoices', { agentId: site.id, amount: 150, description: 'اشتراك الشهر' }));
  assert.equal(inv.invoiceNumber, 'INV-1001');
  assert.equal((await ok(call(admin, 'POST', '/api/invoices', { agentId: site.id, amount: 20 }))).invoiceNumber, 'INV-1002');
  const siteTok = (await ok(call(null, 'POST', '/api/login', { username: 'site1', password: 'secret1' }))).token;
  assert.equal((await ok(call(siteTok, 'GET', '/api/invoices'))).length, 2);
  assert.equal((await call(siteTok, 'POST', `/api/invoices/${inv.id}/pay`)).status, 403);
  assert.equal((await call(null, 'GET', '/api/invoices')).status, 401);
  await ok(call(admin, 'PUT', `/api/invoices/${inv.id}`, { amount: 160 }));
  await ok(call(admin, 'POST', `/api/invoices/${inv.id}/pay`));
  assert.equal((await call(admin, 'DELETE', `/api/invoices/${inv.id}`)).status, 400, 'paid invoices stay');
  const paid = (await ok(call(admin, 'GET', '/api/invoices'))).find((i) => i.id === inv.id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.amount, 160);
});

test('custom company eSIM QR fee, direct eSIM instant QR activation, and bulk package operations', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  await ok(call(admin, 'PUT', '/api/settings', { shopEnabled: true, shopInstant: true, esimFee: 10 }));

  const co = await ok(call(admin, 'POST', '/api/companies', { name: 'ليان eSIM', color: '#0ea5e9', esimFee: 25 }));
  const p1 = await ok(call(admin, 'POST', '/api/packages', {
    companyId: co.id, name: 'باقة ليان 100GB', dataGb: 100, price: 45, shopPrice: 60, oldPrice: 75, popular: true, esimEnabled: true,
  }));
  const p2 = await ok(call(admin, 'POST', '/api/packages', {
    companyId: co.id, name: 'باقة ليان 200GB', dataGb: 200, price: 65, shopPrice: 80,
  }));

  const shop = await ok(call(null, 'GET', '/api/shop'));
  assert.equal(shop.companies.find((c) => c.id === co.id).esimFee, 25);
  const sp1 = shop.packages.find((p) => p.id === p1.id);
  assert.equal(sp1.esimFee, 25);
  assert.equal(sp1.oldPrice, 75);
  assert.equal(sp1.popular, true);
  assert.equal(sp1.esim, true);

  // When shopInstant is off (default), client-supplied instant:true cannot bypass payment
  await ok(call(admin, 'PUT', '/api/settings', { shopInstant: false }));
  const unpaidAttempt = await ok(call(null, 'POST', '/api/shop/orders', {
    packageId: p1.id, kind: 'new', esim: true, instant: true, number: '0591112222', customerName: 'محاولة', contactPhone: '0591112222',
  }));
  assert.equal(unpaidAttempt.status, 'awaiting_payment');
  assert.equal(unpaidAttempt.esimQr, null);
  assert.equal((await call(null, 'POST', `/api/shop/orders/${unpaidAttempt.code}/instant`, {})).status, 403);

  // Re-enable shopInstant explicitly and verify instant endpoint works when admin opts in
  await ok(call(admin, 'PUT', '/api/settings', { shopInstant: true }));
  const ord = await ok(call(null, 'POST', '/api/shop/orders', {
    packageId: p1.id, kind: 'new', esim: true, number: '0591234567', customerName: 'أحمد', contactPhone: '0591234567',
  }));
  assert.equal(ord.amount, 85);
  assert.equal(ord.esimFee, 25);

  const inst = await ok(call(null, 'POST', `/api/shop/orders/${ord.code}/instant`, {}));
  assert.match(inst.esimQr, /^data:image\/svg\+xml;base64,/);
  assert.match(inst.esimCode, /^LPA:1\$/);

  // Bulk hide, show, esim-enable, and delete
  await ok(call(admin, 'POST', '/api/packages/bulk', { action: 'hide', ids: [p1.id, p2.id] }));
  let cat = await ok(call(admin, 'GET', '/api/catalog'));
  assert.equal(cat.packages.find((p) => p.id === p1.id).active, false);

  await ok(call(admin, 'POST', '/api/packages/bulk', { action: 'show', ids: [p1.id, p2.id] }));
  await ok(call(admin, 'POST', '/api/packages/bulk', { action: 'esim-enable', ids: [p2.id] }));
  cat = await ok(call(admin, 'GET', '/api/catalog'));
  assert.equal(cat.packages.find((p) => p.id === p2.id).esimEnabled, true);

  const delRes = await ok(call(admin, 'POST', '/api/packages/bulk', { action: 'delete', ids: [p1.id, p2.id] }));
  assert.equal(delRes.affected, 2);
});

test('5-minute reservation auto-cancel, 5-minute 1st check, and 3-minute retry (8-minute 2nd check)', async () => {
  const { q } = require('../src/db');
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  await ok(call(admin, 'PUT', '/api/settings', { shopEnabled: true, shopInstant: false }));
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const co = cat.companies[0];
  await ok(call(admin, 'PUT', `/api/companies/${co.id}`, { activation: 'direct' }));
  const pkg = await ok(call(admin, 'POST', '/api/packages', {
    companyId: co.id, name: 'باقة التحقق', kind: 'card', cost: 20, price: 25, shopPrice: 33, days: 30,
  }));

  // 1) Unconfirmed order older than 5 minutes is cancelled automatically
  const expiredOrd = await ok(call(null, 'POST', '/api/shop/orders', { packageId: pkg.id, number: '0591112233' }));
  q('UPDATE shop_orders SET created_at = ? WHERE code = ?').run(Date.now() - 5 * 60_000 - 1000, expiredOrd.code);
  const afterExpire = await ok(call(null, 'GET', `/api/shop/orders/${expiredOrd.code}`));
  assert.equal(afterExpire.status, 'cancelled', 'unconfirmed order auto-cancelled after 5 minutes');
  assert.equal((await call(null, 'POST', `/api/shop/orders/${expiredOrd.code}/proof`, { payName: 'محمد احمد' })).status, 400);

  // 2) Email received 6 minutes ago is outside the 5-minute 1st check, then matched by the 8-minute 2nd check (retry)
  const retryOrd = await ok(call(null, 'POST', '/api/shop/orders', { packageId: pkg.id, number: '0592223344' }));
  const sixMinAgo = Date.now() - 6 * 60_000;
  q(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
     VALUES (1, 9991, '<retry@jp>', 1, 'noreply@jawwalpay.ps', 'Jawwal Pay', ?, 33, '2922949999999', '', 'mohammed Hussein ali skaek', 'incoming', ?)`).run(sixMinAgo, sixMinAgo);

  // Attempt 1: wrong/typo name or 6-min old email -> searches only last 5 minutes -> stays verifying with canRetryProof = true
  const try1 = await ok(call(null, 'POST', `/api/shop/orders/${retryOrd.code}/proof`, { payName: 'محمد حسين' }));
  assert.equal(try1.status, 'verifying');
  assert.equal(try1.proofTries, 1);
  assert.equal(try1.canRetryProof, true);

  // Attempt 2 (correction within retry window): searches last 8 minutes and matches Arabic/English name!
  const try2 = await ok(call(null, 'POST', `/api/shop/orders/${retryOrd.code}/proof`, { payName: 'محمد حسين علي سكيك' }));
  assert.equal(try2.status, 'paid', '2nd attempt searches last 8 minutes and matches');
  assert.equal(try2.stage, 'done');

  // 3) After 2nd attempt fails, waitUntil is 15 minutes; visiting Orders page (GET /api/shop/orders/:code?check=1) re-verifies automatically; after 15m needsSupport is true
  const waitOrd = await ok(call(null, 'POST', '/api/shop/orders', { packageId: pkg.id, number: '0593334455' }));
  await ok(call(null, 'POST', `/api/shop/orders/${waitOrd.code}/proof`, { payName: 'خالد وليد سعيد' }));
  const wTry2 = await ok(call(null, 'POST', `/api/shop/orders/${waitOrd.code}/proof`, { payName: 'خالد وليد سعيد' }));
  assert.equal(wTry2.proofTries, 2);
  assert.equal(wTry2.canRetryProof, false);
  assert.ok(wTry2.waitUntil > Date.now());
  assert.equal(wTry2.needsSupport, false);

  // Simulate 15 minutes passing without a match -> needsSupport becomes true
  q('UPDATE shop_orders SET proof_at = ? WHERE code = ?').run(Date.now() - 15 * 60_000 - 1000, waitOrd.code);
  const after15m = await ok(call(null, 'GET', `/api/shop/orders/${waitOrd.code}`));
  assert.equal(after15m.needsSupport, true, 'prompts customer to contact support after 15 minutes');

  // If the delayed email arrives and customer visits Orders page, GET /api/shop/orders/:code?check=1 matches it automatically
  const nowTs = Date.now();
  q(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
     VALUES (1, 9992, '<delayed@jp>', 1, 'noreply@jawwalpay.ps', 'Jawwal Pay', ?, 33, '2922948888888', '', 'Khaled Waleed Saeed', 'incoming', ?)`).run(nowTs, nowTs);
  const autoVerified = await ok(call(null, 'GET', `/api/shop/orders/${waitOrd.code}?check=1`));
  assert.equal(autoVerified.status, 'paid', 'visiting Orders page automatically re-verifies and activates the order');
  assert.equal(autoVerified.stage, 'done');

  // 4) Amount check: sending less than the order amount is rejected; sending more is accepted
  const amtOrd = await ok(call(null, 'POST', '/api/shop/orders', { packageId: pkg.id, number: '0594445566' }));
  const tNow = Date.now();
  q(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
     VALUES (1, 9993, '<less@jp>', 1, 'noreply@jawwalpay.ps', 'Jawwal Pay', ?, 30, '2922947777777', '', 'Sami Tareq', 'incoming', ?)`).run(tNow, tNow);
  const lessTry = await ok(call(null, 'POST', `/api/shop/orders/${amtOrd.code}/proof`, { payName: 'سامي طارق' }));
  assert.equal(lessTry.status, 'verifying', 'less than required amount (30 < 33) is not accepted');

  q(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
     VALUES (1, 9994, '<more@jp>', 1, 'noreply@jawwalpay.ps', 'Jawwal Pay', ?, 35, '2922946666666', '', 'Sami Tareq', 'incoming', ?)`).run(tNow, tNow);
  const moreTry = await ok(call(null, 'POST', `/api/shop/orders/${amtOrd.code}/proof`, { payName: 'سامي طارق' }));
  assert.equal(moreTry.status, 'paid', 'more than required amount (35 >= 33) is accepted');
  assert.equal(moreTry.stage, 'done');

  // 5) PalPay ("الدفع لصديق") notification via SMSForwarder from the shop's own Gmail
  const mail = require('../src/mail');
  const { namesMatch, saveMail } = require('../src/shop');
  const { getSettings } = require('../src/db');
  const palpayParsed = mail.parseJawwalPay({
    subject: '[SMSForwarder] New message from الدفع لصديق - ١٠/٢٢، ١١:٢٠ ص',
    text: 'الدفع لصديق\nتحويل دفع لصديق: Almotazbellah Atef Mohammed Abukhater, بمبلغ 5.00 ILS',
  });
  assert.deepEqual(palpayParsed, {
    amount: 5,
    reference: null,
    senderPhone: null,
    senderName: 'Almotazbellah Atef Mohammed Abukhater',
    incoming: true,
  });
  assert.ok(namesMatch('المعتز بالله عاطف محمد ابو خاطر', palpayParsed.senderName));
  assert.ok(namesMatch('معتز عاطف ابو خاطر', palpayParsed.senderName));

  await ok(call(admin, 'PUT', '/api/settings', { gmailUser: 'moatazbll@gmail.com', mailFrom: 'jawwalpay.ps' }));
  const curSettings = getSettings();

  // Spoofed display name from another Gmail address must be rejected
  const spoofedRaw = [
    'Authentication-Results: mx.google.com; dkim=pass header.i=@gmail.com; dmarc=pass header.from=gmail.com',
    'From: "moatazbll@gmail.com" <attacker@gmail.com>',
    'Subject: [SMSForwarder] New message from الدفع لصديق',
    'Message-ID: <spoof-palpay@gmail.com>',
    `Date: ${new Date().toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'الدفع لصديق\nتحويل دفع لصديق: Almotazbellah Atef Mohammed Abukhater, بمبلغ 33.00 ILS',
  ].join('\r\n');
  assert.equal(saveMail(1, 9995, spoofedRaw, curSettings), null, 'spoofed display name from external gmail is rejected');

  // Authentic SMSForwarder email from the shop's own Gmail is saved as trusted and matches order automatically
  const validPalpayRaw = [
    'Authentication-Results: mx.google.com; dkim=pass header.i=@gmail.com; dmarc=pass header.from=gmail.com',
    'From: moatazbll@gmail.com',
    `Subject: =?UTF-8?B?${Buffer.from('[SMSForwarder] New message from الدفع لصديق - ١٠/٢٢، ١١:٢٠ ص').toString('base64')}?=`,
    'Message-ID: <valid-palpay@gmail.com>',
    `Date: ${new Date().toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('الدفع لصديق\nتحويل دفع لصديق: Almotazbellah Atef Mohammed Abukhater, بمبلغ 33.00 ILS').toString('base64'),
  ].join('\r\n');
  const savedId = saveMail(1, 9996, validPalpayRaw, curSettings);
  assert.ok(savedId > 0, 'SMSForwarder PalPay email from own Gmail is saved');
  const palpayOrd = await ok(call(null, 'POST', '/api/shop/orders', { packageId: pkg.id, number: '0595556677' }));
  const palpayProof = await ok(call(null, 'POST', `/api/shop/orders/${palpayOrd.code}/proof`, { payName: 'المعتز بالله عاطف ابو خاطر' }));
  assert.equal(palpayProof.status, 'paid', 'PalPay order is verified automatically by sender name');
  assert.equal(palpayProof.stage, 'done');
});


