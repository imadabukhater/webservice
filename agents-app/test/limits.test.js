'use strict';
// The shop's safety limits: orders an hour per customer, the cap above which a matched payment waits for the manager,
// and Aylol's balance (a sale it cannot pay for is refused before anyone pays; the manager is told when it is low).
process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.AYLOL_DATA = require('node:path').join(require('node:os').tmpdir(), `aylol-limits-${process.pid}`);

const test = require('node:test');
const assert = require('node:assert/strict');
const { q, setSetting } = require('../src/db');
const S = require('../src/routes/shop');
const shop = require('../src/shop');
const ay = require('../src/aylol');
const ayRoutes = require('../src/routes/aylol');

const t0 = Date.now();
const co = q("INSERT INTO companies (name, sort) VALUES ('شركة', 1)").run().lastInsertRowid;
// The shop sells eSIMs only, each on a number its supplier has free: QuickLine's (qln:) and Aylol's (ay:esim:) here,
// their free numbers given by stand-ins for the suppliers.
const pkg = (name, shopPrice, ref = 'qln:2564:30', extra = {}) => q(`INSERT INTO packages (company_id, name, cost, price, shop_price, active, sort, kind, art_card_id, art_price, supplier_cost)
  VALUES (?, ?, ?, ?, ?, 1, 1, 'invoice', ?, ?, ?)`).run(co, name, extra.cost ?? shopPrice, shopPrice, shopPrice, ref, extra.artPrice ?? null, extra.supplierCost ?? null).lastInsertRowid;
let free = 0;
const freePhone = () => `0582${String(++free).padStart(6, '0')}`;
require('../src/quickline').freeNumbers = async () => Array.from({ length: 3 }, () => ({ id: free + 1, phone: freePhone(), sim: '', qr: '' }));
ayRoutes.freeNumbers = async () => [{ phone: freePhone() }];
for (const [k, v] of [['shop_enabled', '1'], ['ql_user', 'dealer'], ['ql_pass', 'x'], ['aylol_user', 'dealer'], ['aylol_pass', 'x']]) setSetting(k, v);
const notices = () => q("SELECT title, body FROM notifications WHERE ts >= ? ORDER BY id").all(t0);

test('at most so many orders an hour from one customer; another customer is not held back', async () => {
  const p = pkg('eSIM 20', 20);
  setSetting('shop_hour_limit', '2');
  const order = (contactPhone, clientId) => S.createOrder({ packageId: p, kind: 'esim', customerName: 'زبون', contactPhone }, { ip: 'net-1', clientId });
  await order('0591111111', 'browser-a');
  // Its first order paid or not, the same browser makes a second one for another number…
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  await order('0592222222', 'browser-a');
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  // …but not a third within the hour, whatever the number.
  await assert.rejects(() => order('0593333333', 'browser-a'), /2 طلبات في الساعة/);
  // The same contact phone from other browsers counts too: a second order for it is made, a third is not.
  assert.ok((await order('0591111111', 'browser-b')).code);
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  await assert.rejects(() => order('0591111111', 'browser-e'), /طلبات في الساعة/);
  // Someone else on the same network is not held back.
  assert.ok((await order('0594444444', 'browser-c')).code);
  // 0: no limit.
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  setSetting('shop_hour_limit', '0');
  assert.ok((await order('0593333333', 'browser-a')).code);
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  setSetting('shop_hour_limit', '3');
});

test('a paid order above the cap waits for the manager, with the payment found; below it, it goes on by itself', async () => {
  setSetting('shop_auto_max', '100');
  const big = pkg('باقة كبيرة', 150);
  const o = await S.createOrder({ packageId: big, kind: 'esim', customerName: 'زبون كبير' }, { ip: 'net-2', clientId: 'browser-d' });
  const row = S.byCode(o.code);
  q("UPDATE shop_orders SET status = 'verifying', proof_at = ?, pay_reference = 'REF777' WHERE id = ?").run(Date.now(), row.id);
  q(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
     VALUES (1, 9001, '<cap@jp>', 1, 'notify@jawwal.ps', 'Jawwal Pay', ?, 150, 'REF777', '', '', 'incoming', ?)`).run(Date.now(), Date.now());
  assert.ok(shop.findMail(S.byCode(o.code)), 'the payment is there');
  assert.equal(shop.tryMatch(row.id), false, 'not carried out by itself');
  assert.equal(S.byCode(o.code).status, 'review');
  assert.equal(q("SELECT order_id FROM payment_mails WHERE uid = 9001").get().order_id, null, 'the notice is left for the manager');
  assert.ok(notices().some((n) => n.title.includes('فوق حد التنفيذ التلقائي') && n.title.includes(o.code)));
  // Asked again: still waiting, and the manager is not told twice.
  shop.tryMatch(row.id);
  assert.equal(notices().filter((n) => n.title.includes(o.code)).length, 1);
  // The manager approves it with that notice, as with any order under review.
  assert.equal(shop.claim(row.id, q("SELECT id FROM payment_mails WHERE uid = 9001").get().id, 'يدوي: المدير'), true);
  assert.equal(S.byCode(o.code).status, 'paid');
  setSetting('shop_auto_max', '0');
});

test("an Aylol sale the account cannot pay for is refused before the customer pays; the manager is told when it is low", async () => {
  const ayPkg = pkg('أيلول eSIM 70', 80, 'ay:esim:10:loaded:501', { cost: 70, artPrice: 70, supplierCost: 63.7 });
  const order = () => S.createOrder({ packageId: ayPkg, kind: 'esim', customerName: 'زبون أيلول' }, { ip: 'net-3', clientId: `browser-${Math.random()}` });
  setSetting('shop_hour_limit', '0'); // not what is tested here
  // The balance not known yet: nothing is refused here (the site's own check stops a sale it cannot pay).
  ay._state.balance = null;
  assert.ok((await order()).code);
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  // Known, and enough for what the site takes (its own cost, 63.7): the order is made.
  setSetting('aylol_low_balance', '50');
  Object.assign(ay._state, { balance: 64, balanceAt: Date.now() });
  assert.ok((await order()).code);
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  // Not enough: refused before anything is paid, and the manager is told (once an hour).
  Object.assign(ay._state, { balance: 60, balanceAt: Date.now() });
  await assert.rejects(order, /غير متوفرة الآن/);
  await assert.rejects(order, /غير متوفرة الآن/);
  assert.equal(notices().filter((n) => n.title === 'رصيد أيلول لا يكفي').length, 1);
  // A balance seen long ago is not trusted to refuse.
  Object.assign(ay._state, { balance: 1, balanceAt: Date.now() - 7 * 60 * 60_000 });
  assert.ok((await order()).code);
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  // Under the alert line: told once, not at every look.
  ayRoutes.balanceSeen(40);
  ayRoutes.balanceSeen(30);
  assert.equal(notices().filter((n) => n.title === 'رصيد أيلول منخفض').length, 1);
  assert.match(notices().find((n) => n.title === 'رصيد أيلول منخفض').body, /40 ₪، أقل من 50 ₪/);
  // Packages of other suppliers are never held back by Aylol's balance.
  Object.assign(ay._state, { balance: 0, balanceAt: Date.now() });
  const other = pkg('مورد آخر', 80);
  assert.ok((await S.createOrder({ packageId: other, kind: 'esim', customerName: 'زبون آخر' }, { ip: 'net-4', clientId: 'browser-x' })).code);
});

test("Aylol's balance is read from what the page shows, never from its styles or scripts", () => {
  // As the site's charge page has it: styles full of "balance" next to numbers, long before the balance itself.
  const page = `<html><head><style>.user-account-info .info-box.balance.is-negative .value { color: #e11d48 !important; }
    .aylol-mobile-topbar .balance-card{ flex:1; border-radius:16px; padding:12px 14px; } .balance-card .label{ font-size:11.5px; opacity:.85; margin-bottom:4px; }
    /* 6. Teal (تقارير شحن رصيد) */ .qa-teal { border: 1px solid rgba(2, 132, 199, 0.2); }</style>
    <script>var balance = 6; window.cfg = { balanceTimeout: 30 };</script></head>
    <body><div class="balance-card remaining"><div class="label">الرصيد</div><div class="value">245.30</div></div>
    <div class="balance-card debt"><div class="label">المديونية</div><div class="value">0.00</div></div>
    <span class="d-md-flex">الرصيد: 245.30 شيكل</span> <span>المديونية: 0.00 شيكل</span></body></html>`;
  assert.equal(ay.exBalance(page), 245.3);
  assert.equal(ay.exBalance('<body>رصيدك: 1,412.50 ₪</body>'), 1412.5);
  assert.equal(ay.exBalance('<body>الرصيد: -12.40 شيكل</body>'), -12.4);
  assert.equal(ay.exBalance('<style>.balance{width:6px}</style><body>لا رصيد هنا</body>'), null, 'nothing made up');
});
