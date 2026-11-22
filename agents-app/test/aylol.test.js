'use strict';
// Aylol Telecom against a fake site that answers like the real one (through the system's curl, as in production):
// a CSRF-protected login, the charge page carrying the signing seed, signed package listings (X-Sec-Sign checked),
// eSIM packages and ready stocks, and the eSIM purchase. Credentials come from the settings only; agents pick an
// eSIM number from the list without anything being bought or any eSIM code shown; the sale is carried out
// automatically after the agent pays, and the customer's QR is drawn from the real activation code.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeQrDataUrl } = require('./qr-decode');

const SEED = 'abcdef0123456789abcdef0123456789';
const STOCK = { id: 900, phone: '0531112222', sim_number: '8997210000000000900', qr_code: 'LPA:1$smdp.hot.example$STOCK-SECRET' };
const STOCK2 = { id: 901, phone: '0532223333', sim_number: '8997210000000000901', qr_code: 'LPA:1$smdp.hot.example$STOCK-901' };
const site = { signedIn: new Set(), badSignatures: 0, purchases: [], subscribes: [], logins: 0, cardPrice: 47.5, cardListed: true, hotEsim: false, emptySims: [], skyQr: [], noEsim: false };
// The QR code image of an eSIM, as the site's storage serves it (a real PNG: one pixel).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const sid = /aylol_session=(\w+)/.exec(req.headers.cookie || '')?.[1];
    const html = (s, headers = {}) => { res.writeHead(200, { 'Content-Type': 'text/html', ...headers }); res.end(s); };
    const json = (v) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (u.pathname === '/login' && req.method === 'GET') {
      return html('<html><head><meta name="csrf-token" content="CSRF-LOGIN"></head><body>login</body></html>', { 'Set-Cookie': `aylol_session=s${Date.now()}; Path=/` });
    }
    if (u.pathname === '/login' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      if (f.get('email') === 'dealer@example.com' && f.get('password') === 'right-pass' && f.get('_token') === 'CSRF-LOGIN') { site.signedIn.add(sid); site.logins++; }
      res.writeHead(302, { Location: '/dashboard/charge-system' });
      return res.end();
    }
    if (u.pathname.startsWith('/qr/') || u.pathname.startsWith('/qr-codes/branded/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    if (!site.signedIn.has(sid)) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    if (u.pathname === '/dashboard/charge-system') {
      return html(`<html><head><meta name="csrf-token" content="CSRF-APP"></head><body>رصيدك: 412.50 ₪<script>window.cfg = { seed: "${SEED}" };</script></body></html>`);
    }
    if (u.pathname === '/dashboard/esim') return html('<html><head><meta name="csrf-token" content="CSRF-ESIM"></head></html>');
    const m = /^\/dashboard\/charge-system\/categories\/(\d+)\/packages$/.exec(u.pathname);
    if (m) {
      const p = req.url.split('?')[0] === req.url ? req.url : req.url; // the client signs the full path with its query
      const want = crypto.createHash('sha256').update(`${p}|${req.headers['x-sec-time']}|${req.headers['x-sec-nonce']}|${SEED}`).digest('hex');
      if (req.headers['x-sec-sign'] !== want) { site.badSignatures++; return json({ success: false, message: 'bad signature' }); }
      const cat = Number(m[1]);
      const type = u.searchParams.get('type');
      if (type === 'credit' && cat === 10) return json({ success: true, last_page: 1, data: site.cardListed ? [{ id: 41, name: 'Hot 50 شيكل', price: site.cardPrice }] : [] });
      if (type === 'bill' && cat === 15) return json({ success: true, last_page: 1, data: [{ id: 88, display_name: 'Pelephone 100GB', price: 30, data_gb: 100, days: 30, company_id: 5, category_id: 15 }] });
      if (type === 'bill' && cat === 12) return json({ success: true, last_page: 1, data: [{ id: 77, display_name: 'Hot 100GB', price: 35, data_gb: 100, days: 30, company_id: 7, category_id: 12 },
        ...(site.hotEsim ? [{ id: 79, display_name: 'Hot eSIM 200GB', price: 25, data_gb: 200, days: 30, company_id: 7, category_id: 12, sim_type: 'esim' }] : [])] });
      return json({ success: true, last_page: 1, data: [] });
    }
    if (u.pathname === '/dashboard/esim/packages') {
      if (u.searchParams.get('category_id') === '10' && u.searchParams.get('purchase_type') === 'loaded_esim') return json({ success: true, data: [{ id: 501, name: 'Hot eSIM 50GB', price: 40, data_gb: 50 }] });
      return json({ success: true, data: [] });
    }
    if (u.pathname === '/dashboard/esim/ready-stocks') {
      return json(u.searchParams.get('category_id') === '10' ? { success: true, data: [STOCK, STOCK2] } : { success: true, data: [] });
    }
    if (u.pathname === '/dashboard/esim/purchase-category-10-loaded' && req.method === 'POST') {
      site.purchases.push(JSON.parse(body));
      return json({ success: true, data: { phone: STOCK.phone, sim_number: STOCK.sim_number, lpa: 'LPA:1$smdp.hot.example$ACT-900' } });
    }
    if (u.pathname === '/dashboard/charge-system/package/88') {
      return json({ success: true, data: { id: 88, price: 30, company_id: 5, category_id: 15, month_number: null, period_id: null, is_task_based: false,
        duration_options: [{ id: '9', value: '1', label: '1 شهر' }, { id: '10', value: '2', label: '2 شهر' }] } });
    }
    if (u.pathname === '/dashboard/charge-system/package/79') {
      return json({ success: true, data: { id: 79, price: 25, company_id: 7, category_id: 12, month_number: null, period_id: null, sim_type: 'esim' } });
    }
    // Company 7's eSIM for a number picked (asked by its page once a number is chosen): an empty eSIM and its QR code.
    const es = /^\/dashboard\/charge-system\/empty-sim\/(\d+)$/.exec(u.pathname);
    if (es && req.method === 'GET') {
      const want = crypto.createHash('sha256').update(`${req.url}|${req.headers['x-sec-time']}|${req.headers['x-sec-nonce']}|${SEED}`).digest('hex');
      const phone = u.searchParams.get('phone') || '';
      site.emptySims.push({ pkg: es[1], phone, signed: req.headers['x-sec-sign'] === want });
      return json({ success: true, data: { sim_number: `8997200000000${phone.slice(-6)}`, qr_url: `http://${req.headers.host}/qr/${phone}.png` } });
    }
    if (u.pathname === '/dashboard/charge-system/package/77') {
      return json({ success: true, data: { id: 77, price: 35, company_id: 7, category_id: 12, month_number: null, period_id: null, sim_type: null } });
    }
    if (u.pathname === '/dashboard/charge-system/available-numbers' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      site.numberLookups = (site.numberLookups || 0) + 1;
      // Company 5: the numbers offered for the SIM given; as eSIMs, the site's eSIMs (each with its SIM number and key).
      if (f.get('package_id') === '88' && f.get('is_esim') === '1' && f.get('sim_type') === 'esim') {
        return json({ success: true, data: [{ id: 7852297, number: '0555000780', phone: '0555000780', phone_number: '0555000780', sim_number: '8997250000000000121', selection_key: '7852297',
          subscription_key: '7852297', is_esim: 'true', status: 'available', package_id: '88', duration_key: '10' }] });
      }
      if (f.get('package_id') === '88') {
        if (f.get('type') !== 'sim_number' || !/^\d{18,22}$/.test(f.get('sim_number') || '')) return json({ success: true, data: [{ id: 1, number: '0500000001', selection_key: '1', sim_number: '8997250408008240211' }] });
        return json({ success: true, data: [{ id: 760026, number: '0555037832', phone: '0555037832', selection_key: '760026', sim_number: f.get('sim_number'), status: 'available', package_id: 88 }] });
      }
      if (['77', '79'].includes(f.get('package_id')) && f.get('is_esim') === '1' && f.get('sim_type') === 'esim') {
        return json({ success: true, data: site.noEsim ? [] : [
          { id: 'e-1', number: '0513000001', phone: '0513000001', selection_key: 'e-1', sim_number: '', barcode_text: '', is_esim: '1', status: 'available' },
          { id: 'e-2', number: '0513000002', phone: '0513000002', selection_key: 'e-2', sim_number: '', barcode_text: '', is_esim: '1', status: 'available' }] });
      }
      if (f.get('package_id') !== '77' || f.get('sim_type') !== 'sim' || f.get('is_esim') !== '0') return json({ success: true, data: [] });
      return json({ success: true, meta: { count: 2 }, data: [
        { id: 'k-1', number: '0512000001', phone: '0512000001', selection_key: 'k-1', status: 'available', package_id: 77 },
        { id: 'k-2', number: '0512000002', phone: '0512000002', selection_key: 'k-2', status: 'available', package_id: 77 },
        { id: 'k-3', number: '0512000003', phone: '0512000003', selection_key: 'k-3', status: 'available', package_id: 77 }] });
    }
    if (u.pathname === '/dashboard/subscriptions/company5/qr-code' && req.method === 'POST') {
      const b = JSON.parse(body);
      site.skyQr.push(b);
      return json({ success: true, data: [{ qr_file: `qr-codes/branded/${b.iccid}.png` }] });
    }
    if (u.pathname === '/dashboard/charge-system/subscribe' && req.method === 'POST') {
      const f = String(req.headers['content-type'] || '').includes('application/json') ? { ...JSON.parse(body), json: true } : Object.fromEntries(new URLSearchParams(body));
      site.subscribes.push(f);
      if (f.action === 'subscription') {
        const isEsim = f.esim === 'on' || f.esim === 1;
        return json({ success: true, message: 'تم إنشاء الخط الجديد بنجاح', data: { subscription_id: 33832, status: 'active', mobile_number: f.phone, phone: f.phone, sim_number: f.sim_number,
          esim_qr: isEsim && f.company7_esim_image_url ? f.company7_esim_image_url : null, is_esim: isEsim, company_id: Number(f.company_id) } });
      }
      return json({ success: true, message: 'تم الشحن' });
    }
    res.writeHead(404);
    res.end();
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
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 80)); }
};

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aylol-test-'));
  process.env.AYLOL_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.AYLOL_DATA = dataDir;
  // curl through a wrapper that records its command line: what any user of the server could read in the process list.
  // A shell script where the system runs one; a Node script on Windows, which cannot.
  const argvLog = path.join(dataDir, 'argv.log');
  const wrapper = path.join(dataDir, process.platform === 'win32' ? 'curl-logged.js' : 'curl-logged.sh');
  if (process.platform === 'win32') {
    fs.writeFileSync(wrapper, [
      'const args = process.argv.slice(2);',
      `require('node:fs').appendFileSync(${JSON.stringify(argvLog)}, args.join(' ') + '\\n');`,
      "process.exit(require('node:child_process').spawnSync('curl', args, { stdio: 'inherit' }).status ?? 1);",
    ].join('\n'));
  } else {
    fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec curl "$@"\n`, { mode: 0o755 });
  }
  process.env.AYLOL_CURL = wrapper;
  process.env.DB_FILE = ':memory:';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  ({ server: app } = require('../server'));
  await new Promise((r) => app.listen(0, () => { base = `http://127.0.0.1:${app.address().port}`; r(); }));
});
test.after(() => { app.close(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

// A paid shop order for an Aylol eSIM number the shop offered (and so remembered), then sold (shop.fulfil's part).
let seq = 0;
function sellEsim(pkgId, phone, name) {
  const { q, tx } = require('../src/db');
  const { recordEsimSale } = require('../src/sale');
  const art = q('SELECT art_card_id FROM packages WHERE id = ?').get(pkgId).art_card_id;
  require('../src/routes/aylol').rememberEsim(art, [phone]);
  const t = Date.now();
  const id = Number(q(`INSERT INTO shop_orders (code, package_id, package_label, kind, number, customer_name, amount, status, paid_at, created_at, updated_at, esim)
                       VALUES (?, ?, 'eSIM', 'new', ?, ?, 50, 'paid', ?, ?, ?, 1)`).run(`AY${++seq}`, pkgId, phone, name, t, t, t).lastInsertRowid);
  return tx(() => {
    const r = recordEsimSale(q('SELECT * FROM shop_orders WHERE id = ?').get(id));
    q('UPDATE shop_orders SET line_id = ? WHERE id = ?').run(r.lineId, id);
    return r;
  });
}

test('Aylol: credentials only from the settings, real supplier catalog (new lines only), an eSIM sold in the shop carried out with a real QR', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  const { q: dbq, tx } = require('../src/db');

  // Nothing is set up: nothing is tried, no account is made up.
  assert.equal((await call(admin, 'POST', '/api/aylol/check')).status, 400);
  assert.equal(site.logins, 0);

  const wrong = await ok(call(admin, 'PUT', '/api/settings', { aylolUser: 'dealer@example.com', aylolPass: 'wrong-pass' }));
  assert.equal(wrong.aylolConfigured, true);
  assert.equal(JSON.stringify(wrong).includes('wrong-pass'), false, 'the password never leaves the server');
  assert.equal((await call(admin, 'POST', '/api/aylol/check')).status, 502);

  await ok(call(admin, 'PUT', '/api/settings', { aylolPass: 'right-pass' }));
  const check = await ok(call(admin, 'POST', '/api/aylol/check'));
  assert.deepEqual([check.user, check.balance], ['dealer@example.com', 412.5]);

  // Sync: only what the site lists, at its price (the signature is checked by the fake site). No top-up cards.
  assert.equal((await call(admin, 'POST', '/api/aylol/sync', { kind: 'card' })).status, 400);
  const invoice = await ok(call(admin, 'POST', '/api/aylol/sync', { kind: 'invoice' }));
  assert.equal(invoice.total, 3);
  assert.equal(site.badSignatures, 0);
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const ayPkgs = cat.packages.filter((p) => p.supplier === 'ay');
  assert.deepEqual(ayPkgs.map((p) => p.cost).sort((a, b) => a - b), [30, 35, 40]);
  assert.equal(ayPkgs.some((p) => /empty|استرداد/i.test(p.name)), false, 'no made-up packages');
  const esimPkg = ayPkgs.find((p) => p.esimEnabled && p.cost === 40);
  assert.ok(esimPkg);
  assert.equal(esimPkg.pool, true);
  assert.equal(dbq("SELECT COUNT(*) AS n FROM packages WHERE art_card_id LIKE 'ay:credit:%'").get().n, 0);

  // The cookie jar lives beside the data, never in the app folder.
  assert.ok(fs.existsSync(path.join(dataDir, 'cookies.txt')));
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'aylol-data')), false);
  assert.equal((await call(admin, 'GET', `/api/numbers/free?packageId=${esimPkg.id}&esim=1`)).status, 404, 'no agent number lookup');

  // The eSIM numbers the shop offers: looking buys nothing.
  const art = dbq('SELECT art_card_id FROM packages WHERE id = ?').get(esimPkg.id).art_card_id;
  const free = await require('../src/routes/aylol').freeNumbers(art);
  assert.deepEqual(free.map((n) => n.phone), [STOCK.phone, STOCK2.phone]);
  assert.equal(site.purchases.length, 0, 'looking at numbers buys nothing');

  // A number the list did not show is refused.
  assert.throws(() => tx(() => require('../src/sale').recordEsimSale({ esim: 1, package_id: esimPkg.id, number: '0539999999', customer_name: 'زبون', amount: 50, code: 'X' })),
    /قائمة الأرقام المتاحة/);

  // The sale: paid in the shop, the site sells the eSIM, the customer gets the real code as a scannable QR.
  const sold = sellEsim(esimPkg.id, STOCK.phone, 'زبون هوت');
  const task = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((t) => t.lineId === sold.lineId && t.status === 'done'));
  assert.equal(task.source, 'أيلول');
  assert.equal(site.purchases.length, 1);
  assert.deepEqual(site.purchases[0], { category_id: 10, purchase_type: 'loaded_esim', package_id: '501' });
  const line = dbq('SELECT * FROM lines WHERE id = ?').get(sold.lineId);
  assert.equal(line.status, 'active');
  assert.equal(line.esim_code, 'LPA:1$smdp.hot.example$ACT-900');
  assert.equal(decodeQrDataUrl(line.esim_qr), 'LPA:1$smdp.hot.example$ACT-900');

  // The shop sells eSIMs only: a new line on the customer's own SIM card is never on sale there, nor ordered — Aylol's
  // lines reach the shop only as eSIMs (below), while eSIM lines are off here.
  const billPkg = ayPkgs.find((p) => p.cost === 35);
  await ok(call(admin, 'PUT', '/api/settings', { shopEnabled: true, jawwalpayNumber: '0599000000', jawwalpayName: 'المتجر' }));
  dbq('UPDATE packages SET shop_price = 39 WHERE id = ?').run(billPkg.id);
  const pelePkg = ayPkgs.find((p) => p.cost === 30);
  dbq('UPDATE packages SET shop_price = 45 WHERE id = ?').run(pelePkg.id);
  const onSale = (await ok(call(null, 'GET', '/api/shop'))).packages;
  assert.equal(onSale.some((p) => p.id === billPkg.id || p.id === pelePkg.id), false, 'not on sale on a SIM card');
  const subsBefore = site.subscribes.length;
  for (const id of [billPkg.id, pelePkg.id]) {
    assert.equal((await call(null, 'POST', '/api/shop/orders', { packageId: id, kind: 'new', sim: '8997210000000000779', customerName: 'Sami Khaled' })).status, 404);
  }
  assert.equal(site.subscribes.length, subsBefore, 'nothing at Aylol');

  // The password, the tokens and the customers' details never appear on curl's command line.
  const argv = fs.readFileSync(path.join(dataDir, 'argv.log'), 'utf8');
  assert.ok(argv.includes('/login'), 'the wrapper saw the requests');
  for (const secret of ['right-pass', 'wrong-pass', 'CSRF-LOGIN', 'زبون']) assert.equal(argv.includes(secret), false, `${secret} on the command line`);
});

// A new line in the shop on Aylol's company 7, as its page sells it — as an eSIM only (the shop sells eSIMs only), once
// the owner turns eSIM lines on after a real purchase: one of the eSIM numbers the site offers, picked at random; the
// eSIM for it (an empty one, asked as the page asks it) goes with the order, and its QR code comes back to the customer
// as an image. While eSIM lines are off, none of these lines is on sale.
test('Aylol lines in the shop: as an eSIM only, with its QR; not on sale while eSIM lines are off', async () => {
  const { q: dbq } = require('../src/db');
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  site.hotEsim = true;
  await ok(call(admin, 'POST', '/api/aylol/sync', { kind: 'invoice' }));
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const billPkg = cat.packages.find((p) => p.supplier === 'ay' && p.cost === 35);
  const hotPkg = cat.packages.find((p) => p.supplier === 'ay' && p.cost === 25);
  assert.ok(billPkg && hotPkg);
  assert.equal(dbq('SELECT supplier_sim_type FROM packages WHERE id = ?').get(hotPkg.id).supplier_sim_type, 'esim', 'kept as the site says');
  dbq('UPDATE packages SET shop_price = 40 WHERE id = ?').run(hotPkg.id);

  // eSIM lines off (until a real purchase): none of these lines is on sale (never on a SIM card).
  let shopCat = await ok(call(null, 'GET', '/api/shop'));
  assert.equal(shopCat.packages.some((p) => p.id === billPkg.id || p.id === hotPkg.id), false);
  assert.equal((await call(null, 'POST', '/api/shop/orders', { packageId: billPkg.id, kind: 'new', lineEsim: true, customerName: 'Lina Haddad' })).status, 404);

  dbq("INSERT INTO settings (key, value) VALUES ('aylol_line_esim', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  shopCat = await ok(call(null, 'GET', '/api/shop'));
  const shopBill = shopCat.packages.find((p) => p.id === billPkg.id);
  assert.deepEqual([shopBill.esim, shopBill.fullName, shopBill.lineModes], [true, true, undefined], 'an eSIM, registered with the full name');
  assert.equal(shopCat.packages.find((p) => p.id === hotPkg.id)?.esim, true);
  assert.equal((await call(null, 'POST', '/api/shop/orders', { packageId: billPkg.id, kind: 'esim', customerName: 'Lina 2' })).status, 400, 'a name, not digits');
  // The first name is enough: Aylol gets it as first and family name.
  assert.deepEqual(require('../src/aylol').splitName('Lina'), { first: 'Lina', last: 'Lina' });
  assert.deepEqual(require('../src/aylol').splitName('Lina Haddad'), { first: 'Lina', last: 'Haddad' });

  // The eSIM order: no SIM asked, a random eSIM number held, the eSIM fee added; nothing at the site before payment.
  const fee = Number(shopBill.esimFee) || 0;
  const subs = site.subscribes.length;
  const o = await ok(call(null, 'POST', '/api/shop/orders', { packageId: billPkg.id, kind: 'new', lineEsim: true, customerName: 'Lina Haddad' }));
  const row = dbq('SELECT * FROM shop_orders WHERE code = ?').get(o.code);
  assert.deepEqual([row.esim, row.sim, row.amount, row.esim_fee], [1, '', 39 + fee, fee]);
  assert.ok(['0513000001', '0513000002'].includes(row.number), 'one of the eSIM numbers the site offers');
  assert.equal(site.subscribes.length, subs);
  assert.equal(site.emptySims.length, 0, 'no eSIM asked for before payment');

  dbq(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
       VALUES (1, 8003, '<esline@jp>', 1, 'noreply@jawwalpay.ps', 'Jawwal Pay', ?, ?, 'REF7001', '', '', 'incoming', ?)`).run(Date.now(), 39 + fee, Date.now());
  await ok(call(null, 'POST', `/api/shop/orders/${o.code}/proof`, { payReference: 'REF7001' }));
  const sub = await until(() => site.subscribes.find((x) => x.esim === 'on'));
  const port = server.address().port;
  assert.deepEqual(
    [sub.action, sub.package_id, sub.company_id, sub.phone, sub.company7_available_number_id, sub.sim_number, sub.company7_esim_image_url, sub.first_name, sub.last_name, sub.company7_number_option],
    ['subscription', '77', '7', row.number, row.number === '0513000001' ? 'e-1' : 'e-2', `8997200000000${row.number.slice(-6)}`, `http://127.0.0.1:${port}/qr/${row.number}.png`, 'Lina', 'Haddad', 'new']);
  assert.deepEqual(site.emptySims.map((e) => [e.pkg, e.phone, e.signed]), [['77', row.number, true]], 'the eSIM asked as the page asks it, signed');
  const done = await until(async () => { const v = await ok(call(null, 'GET', `/api/shop/orders/${o.code}`)); return v.stage === 'done' && v; });
  assert.equal(done.esimQr, `data:image/png;base64,${PNG.toString('base64')}`, 'the QR code the site gave, as an image');
  const line = dbq('SELECT l.* FROM lines l JOIN shop_orders o ON o.line_id = l.id WHERE o.code = ?').get(o.code);
  assert.deepEqual([line.status, line.esim, line.number, line.sim], ['active', 1, row.number, `8997200000000${row.number.slice(-6)}`]);

  // Over WhatsApp, the assistant's order is an eSIM too: the full name asked, never a SIM card.
  const wa = require('../src/whatsapp');
  const jid = '970599777666@s.whatsapp.net';
  const shopNow = await require('../src/routes/shop').shopCatalog();
  const ctx = () => ({ jid, phone: '0599777666', shop: shopNow, startedAt: Date.now(), facts: [], after: [], prices: new Set(), phones: new Set() });
  const asked = await wa._test.agentTool('create_order', { package_id: billPkg.id }, ctx());
  assert.deepEqual(asked.need, ['customer_name']);
  const c1 = ctx();
  const shown = await wa._test.agentTool('create_order', { customer_name: 'Omar Nasser' }, c1);
  assert.equal(shown.awaiting_confirmation, true);
  assert.match(c1.facts.join('\n'), new RegExp(`${39 + fee} ₪[\\s\\S]*eSIM`));
  assert.doesNotMatch(c1.facts.join('\n'), /رقم الشريحة/);
  await new Promise((r) => setTimeout(r, 5));
  const made = await wa._test.agentTool('create_order', { confirmed: true }, ctx());
  assert.equal(made.ok, true, JSON.stringify(made));
  const waRow = dbq('SELECT * FROM shop_orders WHERE code = ?').get(made.order_code);
  assert.deepEqual([waRow.esim, waRow.sim, waRow.amount, waRow.customer_name], [1, '', 39 + fee, 'Omar Nasser']);

  // Pelephone (company 5, Sky5G) as an eSIM: one of the site's eSIMs, sent as its page sends it (JSON, esim 1, the
  // eSIM's own SIM number, key and period); the QR asked as the page asks it, and kept as an image.
  const pelePkg = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.supplier === 'ay' && p.cost === 30);
  const peleShop = (await ok(call(null, 'GET', '/api/shop'))).packages.find((p) => p.id === pelePkg.id);
  assert.equal(peleShop.esim, true);
  const po = await ok(call(null, 'POST', '/api/shop/orders', { packageId: pelePkg.id, kind: 'new', lineEsim: true, customerName: 'Rana Saleh' }));
  const prow = dbq('SELECT * FROM shop_orders WHERE code = ?').get(po.code);
  assert.deepEqual([prow.esim, prow.sim, prow.number, prow.amount], [1, '', '0555000780', 45 + fee]);
  dbq(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
       VALUES (1, 8004, '<pelesim@jp>', 1, 'noreply@jawwalpay.ps', 'Jawwal Pay', ?, ?, 'REF7002', '', '', 'incoming', ?)`).run(Date.now(), 45 + fee, Date.now());
  await ok(call(null, 'POST', `/api/shop/orders/${po.code}/proof`, { payReference: 'REF7002' }));
  const skySub = await until(() => site.subscribes.find((x) => x.json && x.esim === 1));
  assert.deepEqual([skySub.package_id, skySub.company_id, skySub.phone, skySub.subscriber_id, skySub.sim_number, skySub.sub_sim_select, skySub.period_id, skySub.is_esim, skySub.first_name, skySub.last_name],
    ['88', '5', '0555000780', '7852297', '8997250000000000121', '8997250000000000121', '10', 1, 'Rana', 'Saleh']);
  const pdone = await until(async () => { const v = await ok(call(null, 'GET', `/api/shop/orders/${po.code}`)); return v.stage === 'done' && v; });
  assert.deepEqual(site.skyQr, [{ company_id: 5, package: '88', iccid: '8997250000000000121', subscription_key: '7852297' }]);
  assert.equal(pdone.esimQr, `data:image/png;base64,${PNG.toString('base64')}`);

  // Only what has a number free is shown (on the site and in WhatsApp): the site out of eSIM numbers for these packages,
  // they go; back once it has them again.
  const S = require('../src/routes/shop');
  site.noEsim = true;
  await S.refreshStock();
  let inShop = (await ok(call(null, 'GET', '/api/shop'))).packages;
  assert.equal(inShop.some((p) => p.id === billPkg.id || p.id === hotPkg.id), false);
  assert.doesNotMatch(wa._test.agentSystem(S.shopCatalogResponse(), require('../src/waconfig').config()), new RegExp(`#${hotPkg.id} `));
  site.noEsim = false;
  await S.refreshStock();
  // The site offers its two eSIM numbers again, but one was sold here (a line) and the other is held by the WhatsApp
  // order: still none free. That order ends, and its number is on sale again at once.
  assert.equal((await ok(call(null, 'GET', '/api/shop'))).packages.some((p) => p.id === hotPkg.id), false, 'a sold or held number is not free');
  await ok(call(null, 'POST', `/api/shop/orders/${made.order_code}/cancel`));
  inShop = (await ok(call(null, 'GET', '/api/shop'))).packages;
  assert.ok(inShop.find((p) => p.id === billPkg.id));
  assert.ok(inShop.find((p) => p.id === hotPkg.id));

  // The customer's new number never on curl's command line (the eSIM is asked with it in the request's body).
  const argv = fs.readFileSync(path.join(dataDir, 'argv.log'), 'utf8');
  for (const secret of ['0513000001', '0513000002', '0555000780', 'Haddad', 'Nasser', 'Rana']) assert.equal(argv.includes(secret), false, `${secret} on the command line`);
});
