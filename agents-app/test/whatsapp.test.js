'use strict';
// The WhatsApp agent, with WhatsApp itself replaced by a recorder and Aylol by a fake site (as in aylol.test.js):
// an agent sells over WhatsApp exactly as in the portal (nothing charged before «نعم», the supplier carries it out,
// the result and the eSIM's real QR come back in the chat), a refusal is reported with its refund, the manager sees
// open requests, and anyone else only gets the shop's packages and its link to pay — nothing is bought for them.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeQrDataUrl } = require('./qr-decode');

const SEED = 'abcdef0123456789abcdef0123456789';
const STOCKS = [{ id: 900, phone: '0531112222', sim_number: '8997210000000000900' }, { id: 901, phone: '0532223333', sim_number: '8997210000000000901' }];
const site = { signedIn: new Set(), purchases: [], subscribes: [], gemini: [] };
const lpaOf = (stock) => `LPA:1$smdp.hot.example$ACT-${stock.id}`;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const sid = /aylol_session=(\w+)/.exec(req.headers.cookie || '')?.[1];
    const html = (s, headers = {}) => { res.writeHead(200, { 'Content-Type': 'text/html', ...headers }); res.end(s); };
    const json = (v) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (u.pathname === '/login' && req.method === 'GET') {
      return html('<html><head><meta name="csrf-token" content="CSRF-LOGIN"></head></html>', { 'Set-Cookie': `aylol_session=s${Date.now()}; Path=/` });
    }
    if (u.pathname === '/login' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      if (f.get('email') === 'dealer@example.com' && f.get('password') === 'right-pass' && f.get('_token') === 'CSRF-LOGIN') site.signedIn.add(sid);
      res.writeHead(302, { Location: '/dashboard/charge-system' });
      return res.end();
    }
    if (!site.signedIn.has(sid)) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    if (u.pathname === '/dashboard/charge-system') {
      return html(`<html><head><meta name="csrf-token" content="CSRF-APP"></head><body>رصيدك: 412.50 ₪<script>window.cfg = { seed: "${SEED}" };</script></body></html>`);
    }
    if (u.pathname === '/dashboard/esim') return html('<html><head><meta name="csrf-token" content="CSRF-ESIM"></head></html>');
    const m = /^\/dashboard\/charge-system\/categories\/(\d+)\/packages$/.exec(u.pathname);
    if (m) {
      const want = crypto.createHash('sha256').update(`${req.url}|${req.headers['x-sec-time']}|${req.headers['x-sec-nonce']}|${SEED}`).digest('hex');
      if (req.headers['x-sec-sign'] !== want) return json({ success: false, message: 'bad signature' });
      const type = u.searchParams.get('type');
      if (type === 'credit' && m[1] === '10') return json({ success: true, last_page: 1, data: [{ id: 41, name: 'Hot 50 شيكل', price: 47.5 }] });
      return json({ success: true, last_page: 1, data: [] });
    }
    if (u.pathname === '/dashboard/esim/packages') {
      if (u.searchParams.get('category_id') === '10' && u.searchParams.get('purchase_type') === 'loaded_esim') return json({ success: true, data: [{ id: 501, name: 'Hot eSIM 50GB', price: 40, data_gb: 50 }] });
      return json({ success: true, data: [] });
    }
    if (u.pathname === '/dashboard/esim/ready-stocks') {
      return json(u.searchParams.get('category_id') === '10' ? { success: true, data: STOCKS.slice(site.purchases.length) } : { success: true, data: [] });
    }
    if (u.pathname === '/dashboard/esim/purchase-category-10-loaded' && req.method === 'POST') {
      const stock = STOCKS[site.purchases.length];
      site.purchases.push(JSON.parse(body));
      return json({ success: true, data: { phone: stock.phone, sim_number: stock.sim_number, lpa: lpaOf(stock) } });
    }
    if (u.pathname === '/dashboard/charge-system/subscribe' && req.method === 'POST') {
      const f = Object.fromEntries(new URLSearchParams(body));
      site.subscribes.push(f);
      return json(f.phone === '0520000000' ? { success: false, message: 'الرقم غير صالح للشحن' } : { success: true, message: 'تم الشحن' });
    }
    res.writeHead(404);
    res.end();
  });
});

// A fake Gemini: answers from what the prompt gave it, and records the prompt.
const gemini = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    site.gemini.push({ key: req.headers['x-goog-api-key'], body: JSON.parse(body) });
    if (req.headers['x-goog-api-key'] !== 'good-key') { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'API key not valid' } })); }
    const prompt = JSON.parse(body).contents[0].parts[0].text;
    const id = /#(\d+) هوت موبايل/.exec(prompt)?.[1] || '0';
    const reply = { action: 'answer', reply: `نعم، باقة هوت eSIM رقم ${id} بسعر 55 ₪. اطلبها من https://evil.example.com/pay` };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }));
  });
});

let base;
let app;
let dataDir;
const call = async (token, method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const ok = async (p) => { const r = await p; assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 60)); }
};

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await new Promise((r) => gemini.listen(0, '127.0.0.1', r));
  process.env.GEMINI_BASE = `http://127.0.0.1:${gemini.address().port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-'));
  process.env.AYLOL_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.AYLOL_DATA = path.join(dataDir, 'aylol');
  process.env.WA_DATA = path.join(dataDir, 'wa');
  process.env.DB_FILE = ':memory:';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  ({ server: app } = require('../server'));
  await new Promise((r) => app.listen(0, () => { base = `http://127.0.0.1:${app.address().port}`; r(); }));
});
test.after(() => { app.close(); server.close(); gemini.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('WhatsApp: agents sell as in the portal, results and real QR come back, customers only get the shop link', async () => {
  const wa = require('../src/whatsapp');
  const { q } = require('../src/db');
  const sent = [];
  wa._test.setTransport(async (jid, content) => { sent.push({ jid, ...content }); });
  const AG = '970599111222@s.whatsapp.net';
  const say = async (jid, phone, text) => { const from = sent.length; await wa.handle({ jid, phone, text }); return sent.slice(from); };
  const textOf = (msgs) => msgs.map((m) => m.text || m.caption || '').join('\n');

  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  await ok(call(admin, 'PUT', '/api/settings', { aylolUser: 'dealer@example.com', aylolPass: 'right-pass' }));
  // The instant sync (what saving the account starts on the server).
  await require('../src/autosync').syncNow('ay');
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const esimPkg = cat.packages.find((p) => p.esimEnabled && p.cost === 40);
  const cardPkg = cat.packages.find((p) => p.kind === 'card' && p.cost === 47.5);
  assert.ok(esimPkg && cardPkg, 'synced at once');

  // The settings screen: nothing secret comes back, and the WhatsApp agent's options are saved.
  const st = await ok(call(admin, 'GET', '/api/whatsapp'));
  assert.equal(st.status, 'off');
  const saved = await ok(call(admin, 'PUT', '/api/whatsapp', { admins: '0599000111', shopUrl: 'https://shop.example.com/shop', aiKey: 'secret-ai-key' }));
  assert.deepEqual([saved.config.admins, saved.config.shopUrl, saved.config.hasAiKey], ['0599000111', 'https://shop.example.com/shop', true]);
  assert.equal(JSON.stringify(saved).includes('secret-ai-key'), false);
  assert.equal(JSON.stringify(await ok(call(admin, 'GET', '/api/settings'))).includes('secret-ai-key'), false);
  await ok(call(admin, 'PUT', '/api/whatsapp', { aiKeyClear: true }));
  const agentTok = await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل واتساب', username: 'wa-agent', password: 'secret1', phone: '0599111222', balance: 500 }));
  assert.ok(agentTok);
  const login = (await ok(call(null, 'POST', '/api/login', { username: 'wa-agent', password: 'secret1' }))).token;
  assert.equal((await call(login, 'GET', '/api/whatsapp')).status, 403, 'manager only');

  // The agent, known by the phone on their account: their packages at their prices, never the supplier's name.
  const list = textOf(await say(AG, '0599111222', 'الباقات'));
  assert.match(list, new RegExp(`#${esimPkg.id}`));
  assert.match(list, new RegExp(`#${cardPkg.id}`));
  assert.equal(/أيلول|aylol/i.test(list), false);
  assert.match(textOf(await say(AG, '0599111222', 'رصيدي')), /500 ₪/);

  // eSIM: the free numbers, then the customer's name, then «نعم». Nothing is bought or charged before it.
  const nums = textOf(await say(AG, '0599111222', `esim ${esimPkg.id}`));
  assert.match(nums, /1\) 0531112222/);
  assert.match(textOf(await say(AG, '0599111222', '١')), /اسم الزبون/);
  assert.match(textOf(await say(AG, '0599111222', 'زبون واتساب')), /نعم/);
  assert.equal(site.purchases.length, 0);
  assert.equal((await ok(call(login, 'GET', '/api/me'))).user.balance, 500, 'not charged before «نعم»');
  assert.match(textOf(await say(AG, '0599111222', 'نعم')), /يُنفَّذ الآن/);
  const done = await until(() => sent.find((m) => m.image && m.jid === AG));
  assert.equal(site.purchases.length, 1);
  assert.deepEqual(site.purchases[0], { category_id: 10, purchase_type: 'loaded_esim', package_id: '501' });
  assert.match(done.caption, /0531112222/);
  assert.equal(decodeQrDataUrl(`data:image/png;base64,${done.image.toString('base64')}`), lpaOf(STOCKS[0]), 'the real code, scannable');
  await until(() => sent.find((m) => m.text && m.text.includes(lpaOf(STOCKS[0]))));
  assert.ok((await ok(call(login, 'GET', '/api/me'))).user.balance < 500, 'paid from the balance');

  // A top-up card, confirmed: carried out at the supplier with that number, and the agent is told.
  assert.match(textOf(await say(AG, '0599111222', `شحن 0529998877 ${cardPkg.id}`)), /نعم/);
  assert.equal(site.subscribes.length, 0);
  await say(AG, '0599111222', 'نعم');
  await until(() => sent.find((m) => m.text && m.text.startsWith('✅ تم الشحن') && m.text.includes('0529998877')));
  assert.equal(site.subscribes.at(-1).phone, '0529998877');

  // Refused by the supplier: it waits for the manager; the manager's rejection reaches the chat with the refund.
  const before = (await ok(call(login, 'GET', '/api/me'))).user.balance;
  await say(AG, '0599111222', `شحن 0520000000 ${cardPkg.id}`);
  await say(AG, '0599111222', 'نعم');
  const task = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((t) => t.status === 'open' && /0520000000/.test(t.note) && t.autoStatus === 'failed'));
  await ok(call(admin, 'POST', `/api/tasks/${task.id}/resolve`, { status: 'rejected', response: 'رقم غير صالح' }));
  await until(() => sent.find((m) => m.text && m.text.startsWith('❌') && m.text.includes('0520000000')));
  assert.equal((await ok(call(login, 'GET', '/api/me'))).user.balance, before, 'refunded');

  // «لا» cancels; a sale cannot be confirmed later out of nowhere.
  await say(AG, '0599111222', `شحن 0529998877 ${cardPkg.id}`);
  assert.match(textOf(await say(AG, '0599111222', 'لا')), /الإلغاء/);
  const subs = site.subscribes.length;
  await say(AG, '0599111222', 'نعم');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(site.subscribes.length, subs);

  // The manager: open requests; selling stays in the portal.
  assert.match(textOf(await say('970599000111@s.whatsapp.net', '0599000111', 'الطلبات')), /لا طلبات مفتوحة|طلبات مفتوحة/);

  // A customer: the shop's packages at the shop's price, and its link to pay. Nothing is bought, nobody is charged.
  const C = '972541234567@s.whatsapp.net';
  q('UPDATE packages SET shop_price = 55 WHERE id = ?').run(esimPkg.id);
  await ok(call(admin, 'PUT', '/api/settings', { shopEnabled: true }));
  const shopList = textOf(await say(C, '0541234567', 'الباقات'));
  assert.match(shopList, /55 ₪/);
  assert.equal(shopList.includes(`#${cardPkg.id}`), false, 'only what the shop sells');
  const link = textOf(await say(C, '0541234567', `esim ${esimPkg.id}`));
  assert.match(link, new RegExp(`https://shop\\.example\\.com/shop#/buy/${esimPkg.id}\\?esim=1`));
  assert.equal(site.purchases.length, 1, 'a customer never buys over WhatsApp');
  assert.match(textOf(await say(C, '0541234567', 'رصيدي')), /الباقات/, 'no balance for strangers');

  // The customer orders in the shop (an Aylol eSIM on one of its ready numbers), pays by Jawwal Pay, and checks the
  // transfer over WhatsApp with the order number and the payer's name: the transfer's e-mail is found, the eSIM is
  // bought and activated, and its QR code reaches the chat by itself.
  await ok(call(admin, 'PUT', '/api/settings', { jawwalpayNumber: '0599000000', jawwalpayName: 'المتجر' }));
  const order = await ok(call(null, 'POST', '/api/shop/orders', { packageId: esimPkg.id, kind: 'new', esim: true, customerName: 'محمد احمد', contactPhone: '0541234567' }));
  assert.equal(order.status, 'awaiting_payment');
  const asked = textOf(await say(C, '0541234567', `طلبي ${order.code}`));
  assert.match(asked, /اسم المحوِّل/);
  // Not paid yet: nothing matches, the order waits (and is checked again).
  assert.match(textOf(await say(C, '0541234567', 'محمد احمد علي')), /لم يصل إشعاره/);
  q(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
     VALUES (1, 7001, '<wa@jp>', 1, 'noreply@jawwalpay.ps', 'Jawwal Pay', ?, ?, '2922940777001', '', 'محمد احمد علي', 'incoming', ?)`).run(Date.now(), order.amount, Date.now());
  // An outgoing transfer, or another amount, never pays it: only this received transfer does.
  assert.match(textOf(await say(C, '0541234567', `${order.code} 2922940777001`)), /تم التحقق من الدفع/);
  await until(() => site.purchases.length === 2);
  await until(async () => (await ok(call(null, 'GET', `/api/shop/orders/${order.code}`))).stage === 'done');
  await wa._test.watchShop();
  const qrMsg = await until(() => sent.find((m) => m.image && m.jid === C));
  assert.match(qrMsg.caption, new RegExp(order.code));
  assert.equal(decodeQrDataUrl(`data:image/png;base64,${qrMsg.image.toString('base64')}`), lpaOf(STOCKS[1]));
  assert.ok(sent.find((m) => m.jid === C && m.text && m.text.includes(lpaOf(STOCKS[1]))));
  const after = sent.length;
  await wa._test.watchShop();
  assert.equal(sent.length, after, 'sent once');

  // Gemini: free text is answered from the shop's own packages and prices, within the conversation, without links.
  await ok(call(admin, 'PUT', '/api/whatsapp', { aiKey: 'good-key' }));
  const answer = textOf(await say(C, '0541234567', 'عندكم شي لهوت؟'));
  assert.match(answer, new RegExp(`رقم ${esimPkg.id} بسعر 55`));
  assert.equal(/evil\.example|https?:\/\/evil/.test(answer), false, 'no link from the AI');
  const prompt = site.gemini.at(-1).body.contents[0].parts[0].text;
  assert.match(prompt, new RegExp(`#${esimPkg.id} هوت موبايل .* 55 ₪`));
  assert.match(prompt, /المحادثة حتى الآن/);
  assert.equal(prompt.includes(`#${cardPkg.id}`), false, 'only what the customer can buy');
  // A wrong key: the menu still answers, and the error shows in the settings.
  await ok(call(admin, 'PUT', '/api/whatsapp', { aiKey: 'bad-key' }));
  assert.match(textOf(await say(C, '0541234567', 'سؤال آخر عن الشبكة')), /الباقات/);
  assert.match((await ok(call(admin, 'GET', '/api/whatsapp'))).aiError, /403.*API key not valid/);

  // What WhatsApp delivers: private chats only, a LID chat with its phone, and old messages are not answered.
  const n = sent.length;
  await wa._test.onRaw({ key: { remoteJid: '123@g.us', fromMe: false }, message: { conversation: 'الباقات' } });
  await wa._test.onRaw({ key: { remoteJid: AG, fromMe: true }, message: { conversation: 'الباقات' } });
  await wa._test.onRaw({ key: { remoteJid: AG, fromMe: false }, message: { conversation: 'الباقات' }, messageTimestamp: Math.floor(Date.now() / 1000) - 3600 });
  // …also when WhatsApp gives the time as a 64-bit object.
  const old = Math.floor(Date.now() / 1000) - 3600;
  await wa._test.onRaw({ key: { remoteJid: AG, fromMe: false }, message: { conversation: 'الباقات' }, messageTimestamp: { low: old, high: 0, toNumber: () => old } });
  assert.equal(sent.length, n);
  await wa._test.onRaw({ key: { remoteJid: '1555@lid', remoteJidAlt: '970599111222@s.whatsapp.net', fromMe: false }, message: { conversation: 'رصيدي' }, messageTimestamp: Math.floor(Date.now() / 1000) });
  assert.equal(sent.at(-1).jid, '1555@lid');
  assert.match(sent.at(-1).text, /رصيدك/);
  assert.deepEqual([wa._test.jidOf('0599111222'), wa._test.jidOf('0521234567')], ['970599111222@s.whatsapp.net', '972521234567@s.whatsapp.net']);
});
