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
const pkg = (name, shopPrice, ref = '', extra = {}) => q(`INSERT INTO packages (company_id, name, cost, price, shop_price, active, sort, kind, art_card_id, art_price, supplier_cost)
  VALUES (?, ?, ?, ?, ?, 1, 1, 'card', ?, ?, ?)`).run(co, name, extra.cost ?? shopPrice, shopPrice, shopPrice, ref, extra.artPrice ?? null, extra.supplierCost ?? null).lastInsertRowid;
setSetting('shop_enabled', '1');
const notices = () => q("SELECT title, body FROM notifications WHERE ts >= ? ORDER BY id").all(t0);

test('at most so many orders an hour from one customer; another customer is not held back', () => {
  const p = pkg('كرت 20', 20);
  setSetting('shop_hour_limit', '2');
  const order = (number, clientId) => S.createOrder({ packageId: p, kind: 'recharge', number }, { ip: 'net-1', clientId });
  order('0591111111', 'browser-a');
  // Its first order paid or not, the same browser makes a second one for another number…
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  order('0592222222', 'browser-a');
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  // …but not a third within the hour, whatever the number.
  assert.throws(() => order('0593333333', 'browser-a'), /2 طلبات في الساعة/);
  // The same contact phone from other browsers counts too: a second order for it is made, a third is not.
  assert.ok(order('0591111111', 'browser-b').code);
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  assert.throws(() => order('0591111111', 'browser-e'), /طلبات في الساعة/);
  // Someone else on the same network is not held back.
  assert.ok(order('0594444444', 'browser-c').code);
  // 0: no limit.
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  setSetting('shop_hour_limit', '0');
  assert.ok(order('0593333333', 'browser-a').code);
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  setSetting('shop_hour_limit', '3');
});

test('a paid order above the cap waits for the manager, with the payment found; below it, it goes on by itself', () => {
  setSetting('shop_auto_max', '100');
  const big = pkg('باقة كبيرة', 150);
  const o = S.createOrder({ packageId: big, kind: 'recharge', number: '0595555555' }, { ip: 'net-2', clientId: 'browser-d' });
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

test("an Aylol sale the account cannot pay for is refused before the customer pays; the manager is told when it is low", () => {
  const ayPkg = pkg('أيلول 70', 80, 'ay:credit:1:22', { cost: 70, artPrice: 70, supplierCost: 63.7 });
  const order = () => S.createOrder({ packageId: ayPkg, kind: 'recharge', number: '0596666666' }, { ip: 'net-3', clientId: `browser-${Math.random()}` });
  setSetting('shop_hour_limit', '0'); // not what is tested here
  // The balance not known yet: nothing is refused here (the site's own check stops a sale it cannot pay).
  ay._state.balance = null;
  assert.ok(order().code);
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  // Known, and enough for what the site takes (its own cost, 63.7): the order is made.
  setSetting('aylol_low_balance', '50');
  Object.assign(ay._state, { balance: 64, balanceAt: Date.now() });
  assert.ok(order().code);
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  // Not enough: refused before anything is paid, and the manager is told (once an hour).
  Object.assign(ay._state, { balance: 60, balanceAt: Date.now() });
  assert.throws(order, /غير متوفرة الآن/);
  assert.throws(order, /غير متوفرة الآن/);
  assert.equal(notices().filter((n) => n.title === 'رصيد أيلول لا يكفي').length, 1);
  // A balance seen long ago is not trusted to refuse.
  Object.assign(ay._state, { balance: 1, balanceAt: Date.now() - 7 * 60 * 60_000 });
  assert.ok(order().code);
  q("UPDATE shop_orders SET status = 'cancelled'").run();
  // Under the alert line: told once, not at every look.
  ayRoutes.balanceSeen(40);
  ayRoutes.balanceSeen(30);
  assert.equal(notices().filter((n) => n.title === 'رصيد أيلول منخفض').length, 1);
  assert.match(notices().find((n) => n.title === 'رصيد أيلول منخفض').body, /40 ₪، أقل من 50 ₪/);
  // Packages of other suppliers are never held back by Aylol's balance.
  Object.assign(ay._state, { balance: 0, balanceAt: Date.now() });
  const other = pkg('مورد آخر', 80, 'ic:5:7');
  assert.ok(S.createOrder({ packageId: other, kind: 'recharge', number: '0597777777' }, { ip: 'net-4', clientId: 'browser-x' }).code);
});
