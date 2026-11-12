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
const site = { signedIn: new Set(), badSignatures: 0, purchases: [], subscribes: [], logins: 0, cardPrice: 47.5, cardListed: true };

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
      if (type === 'bill' && cat === 25) return json({ success: true, last_page: 1, data: [{ id: 77, display_name: 'WE 100GB', price: 35, data_gb: 100, days: 30 }] });
      return json({ success: true, last_page: 1, data: [] });
    }
    if (u.pathname === '/dashboard/esim/packages') {
      if (u.searchParams.get('category_id') === '10' && u.searchParams.get('purchase_type') === 'loaded_esim') return json({ success: true, data: [{ id: 501, name: 'Hot eSIM 50GB', price: 40, data_gb: 50 }] });
      return json({ success: true, data: [] });
    }
    if (u.pathname === '/dashboard/esim/ready-stocks') {
      return json(u.searchParams.get('category_id') === '10' ? { success: true, data: [STOCK] } : { success: true, data: [] });
    }
    if (u.pathname === '/dashboard/esim/purchase-category-10-loaded' && req.method === 'POST') {
      site.purchases.push(JSON.parse(body));
      return json({ success: true, data: { phone: STOCK.phone, sim_number: STOCK.sim_number, lpa: 'LPA:1$smdp.hot.example$ACT-900' } });
    }
    if (u.pathname === '/dashboard/charge-system/subscribe' && req.method === 'POST') {
      site.subscribes.push(Object.fromEntries(new URLSearchParams(body)));
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
  assert.deepEqual([card.total, invoice.total], [1, 2]);
  assert.equal(site.badSignatures, 0);
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const ayPkgs = cat.packages.filter((p) => p.supplier === 'ay');
  assert.deepEqual(ayPkgs.map((p) => p.cost).sort((a, b) => a - b), [35, 40, 47.5]);
  assert.equal(ayPkgs.some((p) => /empty|استرداد/i.test(p.name)), false, 'no made-up packages');
  const esimPkg = ayPkgs.find((p) => p.esimEnabled && p.cost === 40);
  assert.ok(esimPkg);

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
  assert.deepEqual(free, [{ id: STOCK.phone, phone: STOCK.phone }]);
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

  // A bill line is not an eSIM: it is refused before the agent pays, so nothing is paid for at the site without an eSIM to give.
  const billPkg = ayPkgs.find((p) => p.kind === 'invoice' && p.cost === 35);
  assert.equal(billPkg.esimEnabled, false);
  const refused = await call(agent, 'POST', '/api/lines', { kind: 'new', esim: true, packageId: billPkg.id, number: '0531234567', customerName: 'زبون' });
  assert.equal(refused.status, 400);

  // The password, the tokens and the customers' details never appear on curl's command line.
  const argv = fs.readFileSync(path.join(dataDir, 'argv.log'), 'utf8');
  assert.ok(argv.includes('/login'), 'the wrapper saw the requests');
  for (const secret of ['right-pass', 'wrong-pass', 'CSRF-LOGIN', '0529998877', 'زبون']) assert.equal(argv.includes(secret), false, `${secret} on the command line`);
});
