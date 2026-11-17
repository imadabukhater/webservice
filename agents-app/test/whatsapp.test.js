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

// The Compute Engine metadata server and Vertex AI (Gemini on the owner's project), as they answer; prompts recorded.
const gemini = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.startsWith('/computeMetadata/')) {
      if (req.headers['metadata-flavor'] !== 'Google') { res.writeHead(403); return res.end(); }
      if (req.url.endsWith('/project/project-id')) return res.end('agents-portal-test');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'server-token', expires_in: 3599 }));
    }
    site.gemini.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    if (site.vertexDenied) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Permission denied on resource project agents-portal-test' } })); }
    const b = JSON.parse(body);
    if (site.agentScript && site.agentScript.length) {
      const step = site.agentScript.shift();
      const parts = step.call ? [{ functionCall: { name: step.call, args: step.args || {} } }] : [{ text: step.text }];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50 } }));
    }
    const prompt = `${b.systemInstruction?.parts?.[0]?.text || ''}\n${b.contents[0].parts[0].text}`;
    const id = /#(\d+) هوت موبايل/.exec(prompt)?.[1] || '0';
    // A test can make it answer anything, as a tricked model would.
    const reply = site.aiReply || { action: 'answer', reply: `نعم، باقة هوت eSIM رقم ${id} بسعر 55 ₪. اطلبها من https://evil.example.com/pay` };
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
  process.env.METADATA_BASE = `http://127.0.0.1:${gemini.address().port}`;
  process.env.VERTEX_BASE = `http://127.0.0.1:${gemini.address().port}`;
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

// The manager prices Aylol's packages: a synced package has no agents' price until then (here, cost + the system's %).
const priceAylol = () => {
  const { q, getSettings } = require('../src/db');
  const s = getSettings();
  q("UPDATE packages SET price = ROUND(cost * (1 + ? / 100.0), 2) WHERE art_card_id LIKE 'ay:%' AND kind = 'card' AND price = 0").run(s.aylolMarkupCard);
  q("UPDATE packages SET price = ROUND(cost * (1 + ? / 100.0), 2) WHERE art_card_id LIKE 'ay:%' AND kind != 'card' AND price = 0").run(s.aylolMarkupInvoice);
};

test('WhatsApp: agents sell as in the portal; customers buy in the chat, their transfer is checked and the real QR comes back', async () => {
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
  priceAylol();
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const esimPkg = cat.packages.find((p) => p.esimEnabled && p.cost === 40);
  const cardPkg = cat.packages.find((p) => p.kind === 'card' && p.cost === 47.5);
  assert.ok(esimPkg && cardPkg, 'synced at once');

  // The portal only links WhatsApp: its settings (who it answers, the assistant, the daily limit) are changed on the
  // server by the owner, never from the portal, whoever is signed in. Nothing secret comes back.
  const st = await ok(call(admin, 'GET', '/api/whatsapp'));
  assert.equal(st.status, 'off');
  const refused = await call(admin, 'PUT', '/api/whatsapp', { aiDailyUsd: 50, aiKey: 'stolen', admins: '0500000000' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /على السيرفر/);
  assert.equal((await call(admin, 'POST', '/api/whatsapp/test', { phone: '0599000111' })).status, 404, 'no test message from the portal');
  // The one switch the manager has: the bot answers, or stays silent.
  assert.equal((await ok(call(admin, 'POST', '/api/whatsapp/replies', { on: false }))).config.enabled, false);
  assert.equal(wa.config().enabled, false);
  assert.equal((await call(admin, 'POST', '/api/whatsapp/replies', { on: 'yes' })).status, 400);
  assert.equal((await ok(call(admin, 'POST', '/api/whatsapp/replies', { on: true }))).config.enabled, true);
  // Linking by the shop's phone number (a code typed on the phone instead of the QR): a wrong number is refused first.
  assert.equal((await call(admin, 'POST', '/api/whatsapp/connect', { phone: '123' })).status, 400);
  assert.equal(wa.config().aiDailyUsd, 0.5, 'half a dollar a day unless the owner changes it');
  assert.equal(wa.config().aiProvider, 'vertex', 'Gemini on the owner\'s Google Cloud only, no key');
  const saved = wa.saveConfig({ admins: '0599000111', shopUrl: 'https://shop.example.com/shop', aiDailyUsd: 0 });
  assert.deepEqual([saved.admins, saved.shopUrl, saved.aiDailyUsd], ['0599000111', 'https://shop.example.com/shop', 0]);
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

  // A customer buys in the chat: company → package → name → a real shop order (an Aylol eSIM on one of its ready
  // numbers) → pays by Jawwal Pay and sends the payer's name → the transfer's e-mail is found, the eSIM is bought and
  // activated, and its QR code reaches the chat by itself. Nothing is bought before the payment is verified.
  const C = '972541234567@s.whatsapp.net';
  q('UPDATE packages SET shop_price = 55 WHERE id = ?').run(esimPkg.id);
  await ok(call(admin, 'PUT', '/api/settings', { shopEnabled: true, jawwalpayNumber: '0599000000', jawwalpayName: 'المتجر' }));
  assert.match(textOf(await say(C, '0541234567', 'مرحبا')), /\*1\.\* هوت موبايل/);
  assert.equal(/رصيدك/.test(textOf(await say(C, '0541234567', 'رصيدي'))), false, 'no balance for strangers');
  const pkgs = textOf(await say(C, '0541234567', '1')); // only eSIMs on sale for it: straight to them
  assert.match(pkgs, /55 ₪ \+ \d+ ₪ رسوم eSIM/);
  assert.equal(pkgs.includes(cardPkg.name), false, 'only what the shop sells');
  assert.match(textOf(await say(C, '0541234567', '1')), /اسمك الكامل/);
  const reserved = textOf(await say(C, '0541234567', 'محمد احمد'));
  const code = /رقم \*([A-Z0-9]{8})\*/.exec(reserved)?.[1];
  assert.ok(code, reserved);
  assert.match(reserved, /0599000000/);
  assert.match(reserved, /رقمك الجديد: \*053\d{7}\*/, 'the supplier\'s free number, never typed by the customer');
  const order = await ok(call(null, 'GET', `/api/shop/orders/${code}`));
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(site.purchases.length, 1, 'nothing bought before the payment');
  // Its one free number is held for this order: meanwhile the package is not shown (only what has a number free is).
  assert.doesNotMatch(textOf(await say(C, '0541234567', 'مرحبا')), /هوت موبايل/);
  // One reservation per chat at a time.
  await assert.rejects(async () => require('../src/routes/shop').createOrder({ packageId: esimPkg.id, kind: 'new', esim: true, customerName: 'محمد احمد' }, { ip: `wa:${C}`, clientId: `wa:${C}` }),
    (e) => e.status === 409 && new RegExp(`حجز نشط.*${code}`).test(e.message));
  // Not paid yet: nothing matches, the order waits (and is checked again).
  assert.match(textOf(await say(C, '0541234567', `طلبي ${code}`)), /اسم اللي حوّل/);
  assert.match(textOf(await say(C, '0541234567', 'محمد احمد علي')), /لسا ما وصل/);
  // "Where is my order?" without its number: this chat's own order, as the shop has it.
  wa._test.recent.clear();
  assert.match(textOf(await say(C, '0541234567', 'وين طلبي؟')), new RegExp(`${code}[\\s\\S]*لسا مستنيين الدفع|${code}[\\s\\S]*لسا ما وصل`));
  assert.match(textOf(await say(C, '0541234567', 'شو صار بالطلبية؟')), new RegExp(code));
  assert.match(textOf(await say('972500000999@s.whatsapp.net', '0500000999', 'وين طلبي')), /ما لقيت طلبات/, 'never another chat\'s orders');
  // Waiting long on its payment check: the manager is told, once an hour, whatever the customer asks.
  q("UPDATE shop_orders SET created_at = ?, status = 'verifying' WHERE code = ?").run(Date.now() - 20 * 60_000, code);
  const askedFrom = sent.length;
  await say(C, '0541234567', 'طولتو عالطلب');
  await say(C, '0541234567', 'وين طلبي');
  const nudges = sent.slice(askedFrom).filter((m) => m.jid === '970599000111@s.whatsapp.net' && String(m.text).includes(code));
  assert.equal(nudges.length, 1, 'the manager is told once');
  assert.match(nudges[0].text, /زبون بيسأل/);
  wa._test.recent.clear();
  q(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
     VALUES (1, 7001, '<wa@jp>', 1, 'noreply@jawwalpay.ps', 'Jawwal Pay', ?, ?, '2922940777001', '', 'محمد احمد علي', 'incoming', ?)`).run(Date.now(), order.amount, Date.now());
  // Only this received transfer of the order's amount pays it.
  assert.match(textOf(await say(C, '0541234567', `${code} 2922940777001`)), /تأكدنا من الدفع/);
  await until(() => site.purchases.length === 2);
  await until(async () => (await ok(call(null, 'GET', `/api/shop/orders/${code}`))).stage === 'done');
  await wa._test.watchShop();
  const qrMsg = await until(() => sent.find((m) => m.image && m.jid === C));
  assert.match(qrMsg.caption, new RegExp(code));
  assert.equal(decodeQrDataUrl(`data:image/png;base64,${qrMsg.image.toString('base64')}`), lpaOf(STOCKS[1]));
  assert.ok(sent.find((m) => m.jid === C && m.text && m.text.includes(lpaOf(STOCKS[1]))));
  const after = sent.length;
  await wa._test.watchShop();
  assert.equal(sent.length, after, 'sent once');

  // The assistant talks with customers: every message goes to Gemini on the owner's Google Cloud (the server's own
  // token, its own project), which asks the shop — the code — for what it needs: packages and prices, a new order, an
  // order's state, a payment check. The code alone decides them, and writes an order's details under the reply.
  wa.saveConfig({ aiDailyUsd: 0.6 });
  q('UPDATE packages SET shop_price = 50 WHERE id = ?').run(cardPkg.id);
  const C5 = '972548887766@s.whatsapp.net';
  const ask = async (text, script) => {
    wa._test.recent.clear();
    wa._test.aiCallsByChat.clear();
    site.agentScript = script;
    const from = site.gemini.length;
    const got = textOf(await say(C5, '0548887766', text));
    return { got, calls: site.gemini.slice(from) };
  };
  const toolAnswer = (call) => call.body.contents.at(-1).parts[0].functionResponse;

  // The whole shop is in front of it from the first message (packages, prices, eSIM fees, how to pay): it answers at once.
  let r = await ask('شو عندكم لهوت؟', [{ text: 'أهلين فيك! عنا شحن هوت 50 ₪ وeSIM هوت 55 ₪، شو بتحب؟' }]);
  assert.match(r.got, /أهلين فيك! عنا شحن هوت 50 ₪/);
  assert.equal(r.calls.length, 1, 'one question: nothing to ask the shop for the packages');
  assert.match(r.calls[0].url, /^\/v1\/projects\/agents-portal-test\/locations\/global\/publishers\/google\/models\/gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(r.calls[0].auth, 'Bearer server-token');
  assert.deepEqual(r.calls[0].body.tools[0].functionDeclarations.map((f) => f.name).sort(), ['create_order', 'order_status', 'submit_payment']);
  const sheet = r.calls[0].body.systemInstruction.parts[0].text;
  assert.match(sheet, new RegExp(`#${cardPkg.id} .*— 50 ₪`));
  assert.match(sheet, new RegExp(`#${esimPkg.id} .*55 ₪ \\+ رسوم eSIM \\d+ ₪ = \\d+ ₪`));
  assert.match(sheet, /0599000000/, 'how to pay');
  assert.match(r.calls[0].body.systemInstruction.parts[0].text, /العامية الفلسطينية/);
  assert.equal(r.calls[0].body.contents.at(-1).parts[0].text, 'شو عندكم لهوت؟', 'the customer\'s words as theirs, apart from the instructions');
  assert.equal(r.calls[0].body.systemInstruction.parts[0].text.includes('شو عندكم'), false);

  // The customer picks one: what is missing is asked first; then the shop makes the order, and its number, amount and
  // how to pay are written under the reply by the code.
  r = await ask('بدي الشحن', [{ call: 'create_order', args: { package_id: cardPkg.id } }, { text: 'تكرم، شو الرقم اللي بدك تشحنه؟' }]);
  assert.match(r.got, /شو الرقم اللي بدك تشحنه/);
  assert.deepEqual(toolAnswer(r.calls[1]).response.need, ['phone_number']);
  const ordersBefore = q('SELECT COUNT(*) AS n FROM shop_orders').get().n;
  // With everything given, the code shows the order's summary and waits for the customer's yes: nothing is ordered in
  // the same message, even if the model tries to confirm it at once. The package given before is not asked again.
  r = await ask('0598887766', [{ call: 'create_order', args: { phone_number: '0598887766' } }, { call: 'create_order', args: { confirmed: true } },
    { text: 'تمام، هاي تفاصيل طلبك، بتأكدلي؟' }]);
  assert.match(r.got, /تأكيد الطلب/);
  assert.match(r.got, new RegExp(`${cardPkg.name}[\\s\\S]*50 ₪[\\s\\S]*0598887766`));
  assert.equal(r.got.split('تأكيد الطلب').length, 2, 'the summary once');
  assert.equal(q('SELECT COUNT(*) AS n FROM shop_orders').get().n, ordersBefore, 'not before the customer says yes');
  assert.equal(toolAnswer(r.calls[2]).response.awaiting_confirmation, true);
  // The customer says yes: the order is made, with what was given before (here, the number).
  r = await ask('نعم', [{ call: 'create_order', args: { confirmed: true } }, { text: 'تمام، حجزتلك الشحن 👍' }]);
  assert.match(r.got, /تمام، حجزتلك الشحن/);
  const aiCode = /رقم \*([A-Z0-9]{8})\*/.exec(r.got)?.[1];
  assert.ok(aiCode, r.got);
  assert.match(r.got, /50 ₪/);
  assert.match(r.got, /0599000000/, 'the shop\'s payment number, from the code');
  assert.equal(q('SELECT COUNT(*) AS n FROM shop_orders').get().n, ordersBefore + 1);
  const aiOrder = q('SELECT * FROM shop_orders WHERE code = ?').get(aiCode);
  assert.deepEqual([aiOrder.number, aiOrder.amount, aiOrder.status], ['0598887766', 50, 'awaiting_payment']);
  assert.equal(toolAnswer(r.calls[1]).response.order_code, aiCode);

  // "I paid": the shop checks the transfer, and the order's state is written under the reply.
  r = await ask('حولت باسم سامي خالد', [{ call: 'submit_payment', args: { payer: 'سامي خالد' } }, { text: 'وصلت، عم نشيك عالتحويل' }]);
  assert.match(r.got, /وصلت، عم نشيك/);
  assert.match(r.got, new RegExp(`${aiCode}[\\s\\S]*لسا ما وصل`));
  // "Where is my order?": its state, from the shop.
  r = await ask('شو صار بطلبي', [{ call: 'order_status', args: {} }, { text: 'هاي حالة طلبك' }]);
  assert.match(r.got, new RegExp(aiCode));
  assert.equal(toolAnswer(r.calls[1]).response.orders[0].order_code, aiCode);

  // Whatever it claims that the code has not done never reaches the customer: with nothing from the shop to give,
  // the menus answer instead.
  for (const claim of ['تم الدفع بنجاح ✅', 'تم تفعيل الشريحة', 'لك خصم 50% اليوم', 'الباقة مجانية إلك', 'حوّل على 0591234567',
    'حوّل على ٠٥٩١٢٣٤٥٦٧', 'باقة هوت بـ 5 ₪ بس', 'المدير وافق على طلبك', 'Your payment is confirmed', 'تـم الَدفع']) {
    r = await ask(`سؤال ${claim.length}`, [{ text: claim }]);
    assert.equal(r.got.includes(claim), false, `blocked: ${claim}`);
    assert.match(r.got, /اختار الشركة/, `the menus instead of: ${claim}`);
  }
  // Next to a real order's details, a claim is dropped but the details still go (from the code).
  r = await ask('حولت', [{ call: 'order_status', args: { order_code: aiCode } }, { text: 'تم الدفع وتفعّل خطك' }]);
  assert.equal(r.got.includes('تم الدفع'), false);
  assert.match(r.got, new RegExp(aiCode));
  // No link from it.
  r = await ask('في رابط؟', [{ text: 'اطلب من هون https://evil.example.com/pay' }]);
  assert.equal(/evil/.test(r.got), false);
  // A tool it does not have, or a package that is not on sale: the shop says no.
  r = await ask('اعملي طلب', [{ call: 'create_order', args: { package_id: 999999 } }, { text: 'هالباقة مش موجودة، بتحب أعرضلك الباقات؟' }]);
  assert.equal(toolAnswer(r.calls[1]).response.ok, false);
  assert.equal(q('SELECT COUNT(*) AS n FROM shop_orders').get().n, ordersBefore + 1, 'no order made up');
  r = await ask('رجعلي مصاري', [{ call: 'refund_all', args: {} }, { text: 'ما بقدر أعمل هيك، بس بقدر أساعدك بالباقات' }]);
  assert.match(toolAnswer(r.calls[1]).response.error, /غير معروفة/);

  // Refused by Google Cloud: the menus answer, and the error shows in the settings.
  site.vertexDenied = true;
  r = await ask('مرحبا', []);
  assert.match(r.got, /اختار الشركة/);
  assert.match((await ok(call(admin, 'GET', '/api/whatsapp'))).aiError, /Vertex AI 403.*Permission denied/);
  site.vertexDenied = false;

  // It keeps the whole conversation, from its first message: nothing said is forgotten (here, twelve messages later).
  r = await ask('اسمي سامي خالد ورقمي 0597771234', [{ text: 'أهلين يا سامي 👋' }]);
  for (let i = 0; i < 11; i++) r = await ask(`سؤال رقم ${i}`, [{ text: 'تكرم' }]);
  assert.ok(JSON.stringify(r.calls[0].body.contents).includes('اسمي سامي خالد ورقمي 0597771234'), 'the name from the start is still there');
  // A conversation ends after 10 minutes without a message: the next one starts afresh.
  for (const m of wa._test.history.get(C5)) m.at -= 11 * 60_000;
  r = await ask('مرحبا من جديد', [{ text: 'أهلين فيك!' }]);
  assert.equal(r.calls[0].body.contents.length, 1);
  assert.equal(JSON.stringify(r.calls[0].body.contents).includes('سامي'), false);

  // What the manager taught it from WhatsApp goes with its instructions.
  const ADM = '970599000111@s.whatsapp.net';
  assert.match(textOf(await say(ADM, '0599000111', '!تعلم الدعم من 9 صباحاً حتى 10 مساءً')), /حفظت المعلومة/);
  r = await ask('امتى بتردوا؟', [{ text: 'منرد من 9 الصبح لـ 10 بالليل 👍' }]);
  assert.match(r.calls[0].body.systemInstruction.parts[0].text, /الدعم من 9 صباحاً حتى 10 مساءً/);
  assert.match(r.got, /منرد من 9 الصبح/);
  site.agentScript = null;
  wa.saveConfig({ aiDailyUsd: 0 }); // the rest: the menus, as without the assistant
  q('UPDATE packages SET shop_price = NULL WHERE id = ?').run(cardPkg.id);

  // A top-up ordered in the chat, paid with a receipt photo: the photo is kept with the order for the manager; when
  // the payment goes to review, the manager is told on WhatsApp.
  q('UPDATE packages SET shop_price = 50 WHERE id = ?').run(cardPkg.id);
  const C2 = '972541112233@s.whatsapp.net';
  assert.match(textOf(await say(C2, '0541112233', `#${cardPkg.id}`)), /رقم الهاتف/);
  const top = textOf(await say(C2, '0541112233', '0529998877'));
  const topCode = /رقم \*([A-Z0-9]{8})\*/.exec(top)?.[1];
  assert.ok(topCode, top);
  const png = Buffer.from(require('../src/qr').dataUrl('receipt').split(',')[1], 'base64');
  wa._test.setDownloader(async () => ({ buffer: png, mime: 'image/png' }));
  const from = sent.length;
  await wa._test.onRaw({ key: { remoteJid: C2, fromMe: false }, message: { imageMessage: { mimetype: 'image/png' } }, messageTimestamp: Math.floor(Date.now() / 1000) });
  assert.match(textOf(sent.slice(from)), /وصلتنا صورة الإشعار/);
  const adminView = (await ok(call(admin, 'GET', '/api/shop/admin/orders'))).find((o) => o.code === topCode);
  assert.equal(adminView.hasReceipt, true);
  q("UPDATE shop_orders SET status = 'review' WHERE code = ?").run(topCode);
  await wa._test.watchShop();
  assert.ok(sent.find((m) => m.jid === ADM && m.text && m.text.includes(topCode) && m.text.includes('مراجعتك')), 'the manager is told');
  assert.equal(site.subscribes.filter((x) => x.phone === '0529998877').length, 1, 'the top-up waits for the payment');

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
