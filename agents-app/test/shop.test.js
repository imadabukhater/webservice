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
  assert.deepEqual(mail.parseJawwalPay(p), { amount: 70, reference: 'AB-7781', senderPhone: null, senderName: null });
  assert.equal(mail.authenticSender(p, 'jawwal'), true);
  assert.equal(mail.authenticSender({ ...p, auth: 'mx.google.com; dkim=none; dmarc=fail header.from=jawwal.ps' }, 'jawwal'), false);
  assert.equal(mail.authenticSender({ ...p, auth: '' }, 'jawwal'), false);
  const f = mail.parseJawwalPay({ text: 'You received 1,250.50 ILS from Ahmad Ali. Mobile: +970 59 912 3456. Transaction ID: 99887766' }, { ownNumber: '0599000000' });
  assert.deepEqual(f, { amount: 1250.5, reference: '99887766', senderPhone: '0599123456', senderName: 'Ahmad Ali' });
  const { namesMatch } = require('../src/shop');
  assert.ok(namesMatch('محمد احمد', 'مُحمّد أحمد خليل'));
  assert.ok(!namesMatch('محمد', 'محمد أحمد'), 'one word is not enough unless it is the whole name');
  assert.ok(!namesMatch('سامي خليل', 'محمد أحمد'));
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
  addMail('حوالة بمبلغ 95 ₪ من الرقم 0597777777', { from: 'JawwalPay <notify@jawwal.ps>', auth: '' });
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
  addMail('حوالة 95 شيكل Reference: RR-5');
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
  addMail('حوالة 40.00 ₪ Ref: PP-9');
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
