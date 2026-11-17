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
const site = { signedIn: new Set(), badSignatures: 0, purchases: [], subscribes: [], logins: 0, cardPrice: 47.5, cardListed: true, hotEsim: false, emptySims: [], skyQr: [] };
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
        return json({ success: true, data: [
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

// The manager prices Aylol's packages: a synced package has no agents' price until then (here, cost + the system's %).
const priceAylol = () => {
  const { q, getSettings } = require('../src/db');
  const s = getSettings();
  q("UPDATE packages SET price = ROUND(cost * (1 + ? / 100.0), 2) WHERE art_card_id LIKE 'ay:%' AND kind = 'card' AND price = 0").run(s.aylolMarkupCard);
  q("UPDATE packages SET price = ROUND(cost * (1 + ? / 100.0), 2) WHERE art_card_id LIKE 'ay:%' AND kind != 'card' AND price = 0").run(s.aylolMarkupInvoice);
};

test('Aylol: credentials only from the settings, real supplier catalog, eSIM numbers picked without buying, sale carried out with a real QR', async () => {
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;

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

  // Sync: only what the site lists, at its price (the signature is checked by the fake site).
  const card = await ok(call(admin, 'POST', '/api/aylol/sync', { kind: 'card' }));
  const invoice = await ok(call(admin, 'POST', '/api/aylol/sync', { kind: 'invoice' }));
  assert.deepEqual([card.total, invoice.total], [1, 3]);
  assert.equal(site.badSignatures, 0);
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const ayPkgs = cat.packages.filter((p) => p.supplier === 'ay');
  assert.deepEqual(ayPkgs.map((p) => p.cost).sort((a, b) => a - b), [30, 35, 40, 47.5]);
  assert.equal(ayPkgs.some((p) => /empty|استرداد/i.test(p.name)), false, 'no made-up packages');
  const esimPkg = ayPkgs.find((p) => p.esimEnabled && p.cost === 40);
  assert.ok(esimPkg);
  // No agents' price of its own yet: the manager sets it, and agents do not see the package until then.
  assert.deepEqual(ayPkgs.map((p) => p.price), [0, 0, 0, 0]);
  priceAylol();

  // The cookie jar lives beside the data, never in the app folder.
  assert.ok(fs.existsSync(path.join(dataDir, 'cookies.txt')));
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'aylol-data')), false);

  // An agent sees the eSIM numbers: no purchase, no eSIM code, and never the supplier's name.
  await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل', username: 'agent-ay', password: 'secret1', balance: 500 }));
  const agent = (await ok(call(null, 'POST', '/api/login', { username: 'agent-ay', password: 'secret1' }))).token;
  const agentCat = await ok(call(agent, 'GET', '/api/catalog'));
  const seen = agentCat.packages.find((p) => p.id === esimPkg.id);
  assert.equal(seen.pool, true);
  assert.equal(JSON.stringify(agentCat).includes('أيلول') || JSON.stringify(agentCat).includes('ay:'), false);
  const free = await ok(call(agent, 'GET', `/api/numbers/free?packageId=${esimPkg.id}&esim=1`));
  assert.deepEqual(free, [{ id: STOCK.phone, phone: STOCK.phone }, { id: STOCK2.phone, phone: STOCK2.phone }]);
  assert.equal(site.purchases.length, 0, 'looking at numbers buys nothing');
  assert.equal((await call(agent, 'GET', '/api/aylol/available-numbers?packageId=1')).status, 404, 'the old lookup that could buy is gone');

  // A number the list did not show is refused.
  assert.equal((await call(agent, 'POST', '/api/lines', { kind: 'new', esim: true, packageId: esimPkg.id, number: '0539999999', customerName: 'زبون' })).status, 400);

  // The sale: the agent pays, the site sells the eSIM, the customer gets the real code as a scannable QR.
  const sold = await ok(call(agent, 'POST', '/api/lines', { kind: 'new', esim: true, packageId: esimPkg.id, number: STOCK.phone, customerName: 'زبون هوت' }));
  const task = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((t) => t.lineId === sold.line.id && t.status === 'done'));
  assert.equal(site.purchases.length, 1);
  assert.deepEqual(site.purchases[0], { category_id: 10, purchase_type: 'loaded_esim', package_id: '501' });
  assert.ok(task);
  const { line } = await ok(call(agent, 'GET', `/api/lines/${sold.line.id}`));
  assert.equal(line.status, 'active');
  assert.equal(line.esimCode, 'LPA:1$smdp.hot.example$ACT-900');
  assert.equal(decodeQrDataUrl(line.esimQr), 'LPA:1$smdp.hot.example$ACT-900');
  assert.ok((await ok(call(agent, 'GET', '/api/me'))).user.balance < 500, 'the agent paid for the sale');

  // A top-up card on a customer's number goes to the site's charge form with that number.
  const cardPkg = ayPkgs.find((p) => p.kind === 'card');
  const topup = await ok(call(agent, 'POST', '/api/lines', { kind: 'external', packageId: cardPkg.id, number: '0529998877' }));
  await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((t) => t.lineId === topup.line.id && t.status === 'done'));
  const sent = site.subscribes.at(-1);
  assert.deepEqual([sent.phone, sent.package_id, sent.company_id, sent.action], ['0529998877', '41', '10', 'recharge']);

  // The site's price is read before every purchase: when it rose above the approved price, nothing is bought there
  // and the request waits for the manager, who is told why.
  site.cardPrice = 60;
  const before = site.subscribes.length;
  const dear = await ok(call(agent, 'POST', '/api/lines', { kind: 'external', packageId: cardPkg.id, number: '0527776655' }));
  const held = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((t) => t.lineId === dear.line.id && t.autoStatus === 'failed'));
  assert.match(held.autoNote, /60/);
  assert.equal(held.status, 'open');
  assert.equal(site.subscribes.length, before, 'nothing bought above the approved price');
  // The same when the site no longer lists the package.
  site.cardPrice = 47.5;
  site.cardListed = false;
  const gone = await ok(call(agent, 'POST', '/api/lines', { kind: 'external', packageId: cardPkg.id, number: '0527776644' }));
  await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((t) => t.lineId === gone.line.id && t.autoStatus === 'failed'));
  assert.equal(site.subscribes.length, before);
  site.cardListed = true;

  // A bill line: a new number on the customer's SIM card, as the site sells it (its company 7): one of the numbers the
  // site offers for the package, the SIM's number and the customer's first and family names. Never an eSIM.
  const billPkg = ayPkgs.find((p) => p.kind === 'invoice' && p.cost === 35);
  const billSeen = (await ok(call(agent, 'GET', '/api/catalog'))).packages.find((p) => p.id === billPkg.id);
  assert.deepEqual([billSeen.pool, billSeen.simOnly, billSeen.esimOnly, billSeen.esimEnabled], [true, true, false, false]);
  const SIM = '8997210000000000777';
  const freeBill = await ok(call(agent, 'GET', `/api/numbers/free?packageId=${billPkg.id}&esim=0`));
  assert.deepEqual(freeBill.map((n) => n.phone), ['0512000001', '0512000002', '0512000003']);
  const purchases = site.purchases.length;
  assert.equal((await call(agent, 'POST', '/api/lines', { kind: 'new', esim: true, packageId: billPkg.id, number: '0512000001', customerName: 'Moataz Abukhater' })).status, 400, 'never an eSIM');
  assert.equal((await call(agent, 'POST', '/api/lines', { kind: 'new', packageId: billPkg.id, number: '0531234567', sim: SIM, customerName: 'Moataz Abukhater' })).status, 400, 'a typed number is refused');
  assert.equal((await call(agent, 'POST', '/api/lines', { kind: 'new', packageId: billPkg.id, number: '0512000002', sim: SIM, customerName: 'Moataz' })).status, 400, 'first and family names');
  const subs = site.subscribes.length;
  const bill = await ok(call(agent, 'POST', '/api/lines', { kind: 'new', packageId: billPkg.id, number: '0512000002', sim: SIM, customerName: 'Moataz Abukhater' }));
  await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((t) => t.lineId === bill.line.id && t.status === 'done'));
  assert.equal(site.subscribes.length, subs + 1);
  const order = site.subscribes.at(-1);
  assert.deepEqual(
    [order.action, order.package_id, order.company_id, order.category_id, order.phone, order.company7_available_number_id, order.sim_number,
      order.first_name, order.last_name, order.duration, order.customer_price, order.price, order.company7_number_option, order.customer_paid, order.esim],
    ['subscription', '77', '7', '12', '0512000002', 'k-2', SIM, 'Moataz', 'Abukhater', '1', '35', '35', 'new', 'true', undefined]);
  assert.equal(site.purchases.length, purchases, 'no eSIM is bought for a bill line');
  const billLine = (await ok(call(agent, 'GET', `/api/lines/${bill.line.id}`))).line;
  assert.deepEqual([billLine.status, billLine.number, billLine.sim, billLine.esim], ['active', '0512000002', SIM, false]);
  // The manager's own sale goes to Aylol too, never active before it is carried out there.
  const own = await ok(call(admin, 'POST', '/api/lines', { kind: 'new', agentId: (await ok(call(admin, 'GET', '/api/agents'))).find((a) => a.username === 'agent-ay').id,
    packageId: billPkg.id, number: '0512000001', sim: '8997210000000000778', customerName: 'Moataz Abukhater' }));
  assert.notEqual(own.line.status, 'active');

  // A customer buys a new line on their own SIM in the shop: the SIM's number and their full name; a number Aylol offers,
  // held for the order; nothing at Aylol before the payment is verified; then the line is activated there, as above.
  const { q: dbq } = require('../src/db');
  await ok(call(admin, 'PUT', '/api/settings', { shopEnabled: true, jawwalpayNumber: '0599000000', jawwalpayName: 'المتجر' }));
  dbq('UPDATE packages SET shop_price = 39 WHERE id = ?').run(billPkg.id);
  const shopPkg = (await ok(call(null, 'GET', '/api/shop'))).packages.find((p) => p.id === billPkg.id);
  assert.equal(shopPkg?.simLine, true, 'on sale in the shop, as a new line on the customer SIM');
  const SIM2 = '8997210000000000779';
  assert.equal((await call(null, 'POST', '/api/shop/orders', { packageId: billPkg.id, kind: 'new', sim: SIM2, customerName: 'Sami' })).status, 400, 'the full name');
  assert.equal((await call(null, 'POST', '/api/shop/orders', { packageId: billPkg.id, kind: 'new', sim: '123', customerName: 'Sami Khaled' })).status, 400, 'a real SIM number');
  const shopOrder = await ok(call(null, 'POST', '/api/shop/orders', { packageId: billPkg.id, kind: 'new', sim: SIM2, customerName: 'Sami Khaled' }));
  const heldOrder = dbq('SELECT * FROM shop_orders WHERE code = ?').get(shopOrder.code);
  assert.deepEqual([heldOrder.number, heldOrder.sim, heldOrder.esim, heldOrder.amount], ['0512000003', SIM2, 0, 39], 'the one number not sold yet, held for the order');
  assert.equal(site.subscribes.some((x) => x.phone === '0512000003'), false, 'nothing at Aylol before the payment');
  dbq(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
       VALUES (1, 8001, '<ayline@jp>', 1, 'noreply@jawwalpay.ps', 'Jawwal Pay', ?, 39, 'REF3939', '', '', 'incoming', ?)`).run(Date.now(), Date.now());
  await ok(call(null, 'POST', `/api/shop/orders/${shopOrder.code}/proof`, { payReference: 'REF3939' }));
  const lineOrder = await until(() => site.subscribes.find((x) => x.phone === '0512000003'));
  assert.deepEqual([lineOrder.action, lineOrder.phone, lineOrder.company7_available_number_id, lineOrder.sim_number, lineOrder.first_name, lineOrder.last_name],
    ['subscription', '0512000003', 'k-3', SIM2, 'Sami', 'Khaled']);
  await until(async () => (await ok(call(null, 'GET', `/api/shop/orders/${shopOrder.code}`))).stage === 'done');

  // A Pelephone line (Aylol's company 5, Sky5G): its numbers depend on the customer's SIM, so it is sold in the shop
  // (where the SIM's number comes with the order) and sent as its page sends it, with the package's one-month period.
  const pelePkg = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.supplier === 'ay' && p.cost === 30);
  dbq('UPDATE packages SET shop_price = 45 WHERE id = ?').run(pelePkg.id);
  assert.equal((await ok(call(null, 'GET', '/api/shop'))).packages.find((p) => p.id === pelePkg.id)?.simLine, true);
  const SIM3 = '8997250000000000001';
  const peleOrder = await ok(call(null, 'POST', '/api/shop/orders', { packageId: pelePkg.id, kind: 'new', sim: SIM3, customerName: 'Rami Saleh' }));
  assert.equal(dbq('SELECT number FROM shop_orders WHERE code = ?').get(peleOrder.code).number, '0555037832', 'a number Aylol offers for this SIM');
  dbq(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
       VALUES (1, 8002, '<pele@jp>', 1, 'noreply@jawwalpay.ps', 'Jawwal Pay', ?, 45, 'REF4545', '', '', 'incoming', ?)`).run(Date.now(), Date.now());
  await ok(call(null, 'POST', `/api/shop/orders/${peleOrder.code}/proof`, { payReference: 'REF4545' }));
  const sky = await until(() => site.subscribes.find((x) => x.phone === '0555037832'));
  assert.equal(sky.json, true, 'sent as JSON, as the page does');
  assert.deepEqual([sky.action, sky.package_id, sky.company_id, sky.subscriber_id, sky.sim_number, sky.first_name, sky.last_name, sky.period_id, sky.duration, sky.esim],
    ['subscription', '88', '5', '760026', SIM3, 'Rami', 'Saleh', '9', '1', 0]);
  // An agent's Pelephone sale (no SIM known before the number) stays a request for the manager.
  const peleSeen = (await ok(call(agent, 'GET', '/api/catalog'))).packages.find((p) => p.id === pelePkg.id);
  assert.equal(peleSeen ? peleSeen.pool : false, false);

  // The password, the tokens and the customers' details never appear on curl's command line.
  const argv = fs.readFileSync(path.join(dataDir, 'argv.log'), 'utf8');
  assert.ok(argv.includes('/login'), 'the wrapper saw the requests');
  for (const secret of ['right-pass', 'wrong-pass', 'CSRF-LOGIN', '0529998877', 'زبون', 'Abukhater', 'Khaled', 'Saleh', SIM, SIM2, SIM3]) assert.equal(argv.includes(secret), false, `${secret} on the command line`);
});

// A new line in the shop on Aylol's company 7, as its page sells it: on the customer's SIM card, or (once the owner turns
// it on, after a real purchase) as an eSIM: one of the eSIM numbers the site offers, picked at random; the eSIM for it
// (an empty one, asked as the page asks it) goes with the order, and its QR code comes back to the customer as an image.
// A package the site sells as eSIM only (Hot's) is never sold on a SIM card, and not at all while eSIM lines are off.
test('Aylol lines in the shop: on the customer SIM or as an eSIM with its QR, eSIM-only packages never on a SIM', async () => {
  const { q: dbq } = require('../src/db');
  const admin = (await ok(call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' }))).token;
  site.hotEsim = true;
  await ok(call(admin, 'POST', '/api/aylol/sync', { kind: 'invoice' }));
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const billPkg = cat.packages.find((p) => p.supplier === 'ay' && p.kind === 'invoice' && p.cost === 35);
  const hotPkg = cat.packages.find((p) => p.supplier === 'ay' && p.cost === 25);
  assert.ok(billPkg && hotPkg);
  assert.equal(dbq('SELECT supplier_sim_type FROM packages WHERE id = ?').get(hotPkg.id).supplier_sim_type, 'esim', 'kept as the site says');
  dbq('UPDATE packages SET shop_price = 40 WHERE id = ?').run(hotPkg.id);

  // eSIM lines off (until a real purchase): on the customer's SIM card only; the eSIM-only package is not on sale.
  let shopCat = await ok(call(null, 'GET', '/api/shop'));
  assert.deepEqual(shopCat.packages.find((p) => p.id === billPkg.id).lineModes, ['sim']);
  assert.equal(shopCat.packages.some((p) => p.id === hotPkg.id), false);
  assert.equal((await call(null, 'POST', '/api/shop/orders', { packageId: billPkg.id, kind: 'new', lineEsim: true, customerName: 'Lina Haddad' })).status, 400);

  dbq("INSERT INTO settings (key, value) VALUES ('aylol_line_esim', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  shopCat = await ok(call(null, 'GET', '/api/shop'));
  const shopBill = shopCat.packages.find((p) => p.id === billPkg.id);
  assert.deepEqual(shopBill.lineModes, ['sim', 'esim']);
  assert.deepEqual(shopCat.packages.find((p) => p.id === hotPkg.id)?.lineModes, ['esim']);
  assert.equal((await call(null, 'POST', '/api/shop/orders', { packageId: hotPkg.id, kind: 'new', sim: '8997210000000000790', customerName: 'Lina Haddad' })).status, 400, 'never on a SIM card');
  // An agent still sells these lines on a SIM card only.
  const agent = (await ok(call(null, 'POST', '/api/login', { username: 'agent-ay', password: 'secret1' }))).token;
  assert.equal((await call(agent, 'POST', '/api/lines', { kind: 'new', esim: true, packageId: billPkg.id, number: '0513000001', customerName: 'Lina Haddad' })).status, 400);

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

  // Over WhatsApp, the assistant's order takes the way of the line, and asks it when the package has both.
  const wa = require('../src/whatsapp');
  const jid = '970599777666@s.whatsapp.net';
  const ctx = () => ({ jid, phone: '0599777666', shop: require('../src/routes/shop').shopCatalogResponse(), startedAt: Date.now(), facts: [], after: [], prices: new Set(), phones: new Set() });
  const asked = await wa._test.agentTool('create_order', { package_id: billPkg.id, customer_name: 'Omar Nasser' }, ctx());
  assert.deepEqual(asked.need, ['line_type']);
  const c1 = ctx();
  const shown = await wa._test.agentTool('create_order', { line_type: 'esim' }, c1);
  assert.equal(shown.awaiting_confirmation, true);
  assert.match(c1.facts.join('\n'), new RegExp(`${39 + fee} ₪[\\s\\S]*eSIM`));
  assert.doesNotMatch(c1.facts.join('\n'), /رقم الشريحة/);
  await new Promise((r) => setTimeout(r, 5));
  const made = await wa._test.agentTool('create_order', { confirmed: true }, ctx());
  assert.equal(made.ok, true, JSON.stringify(made));
  const waRow = dbq('SELECT * FROM shop_orders WHERE code = ?').get(made.order_code);
  assert.deepEqual([waRow.esim, waRow.sim, waRow.amount, waRow.customer_name], [1, '', 39 + fee, 'Omar Nasser']);
  // An eSIM-only package over WhatsApp: no way to ask, and never a SIM card.
  const wrong = await wa._test.agentTool('create_order', { package_id: hotPkg.id, customer_name: 'Omar Nasser', line_type: 'sim' }, ctx());
  assert.equal(wrong.ok, false);
  assert.deepEqual(wrong.line_types, ['esim']);

  // Pelephone (company 5, Sky5G) as an eSIM: one of the site's eSIMs, sent as its page sends it (JSON, esim 1, the
  // eSIM's own SIM number, key and period); the QR asked as the page asks it, and kept as an image.
  const pelePkg = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.supplier === 'ay' && p.cost === 30);
  const peleShop = (await ok(call(null, 'GET', '/api/shop'))).packages.find((p) => p.id === pelePkg.id);
  assert.deepEqual(peleShop.lineModes, ['sim', 'esim']);
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

  // The customer's new number never on curl's command line (the eSIM is asked with it in the request's body).
  const argv = fs.readFileSync(path.join(dataDir, 'argv.log'), 'utf8');
  for (const secret of ['0513000001', '0513000002', '0555000780', 'Haddad', 'Nasser', 'Rana']) assert.equal(argv.includes(secret), false, `${secret} on the command line`);
});
