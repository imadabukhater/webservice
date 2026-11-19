'use strict';
// Gemini reviews payments (src/aipay.js): only the unused e-mails of the last 15 minutes go to it, what it names
// is checked again against the money rules, and each e-mail pays one order.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';

const test = require('node:test');
const assert = require('node:assert/strict');
const { q, setSetting } = require('../src/db');
const aipay = require('../src/aipay');
const shop = require('../src/shop');

const MIN = 60_000;
let n = 0;
function order({ amount = 40, payName = '', payPhone = '', payReference = '', ago = 2 * MIN, status = 'verifying' } = {}) {
  n++;
  const t = Date.now() - ago;
  const id = Number(q(`INSERT INTO shop_orders (code, package_label, kind, number, customer_name, amount, status, pay_name, pay_phone, pay_reference, proof_at, created_at, updated_at)
                       VALUES (?, 'Hot 200GB eSIM', 'new', ?, 'عماد', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`T${n}`, `05300000${String(n).padStart(2, '0')}`, amount, status, payName, payPhone, payReference, t, t, t).lastInsertRowid);
  return q('SELECT * FROM shop_orders WHERE id = ?').get(id);
}
function mail({ amount = 40, name = '', phone = '', ref = '', ago = MIN, trusted = 1, body = 'تم استلام حوالة' } = {}) {
  n++;
  const t = Date.now() - ago;
  return Number(q(`INSERT INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference, sender_phone, sender_name, body, created_at)
                   VALUES (1, ?, ?, ?, 'noreply@jawwalpay.ps', 'Jawwal Pay', ?, ?, ?, ?, ?, ?, ?)`)
    .run(n, `<c${n}@jp>`, trusted, t, amount, ref, phone, name, body, t).lastInsertRowid);
}

// Gemini, played by the test: it answers what `answer` returns for the data it got (null: no answer came).
const requests = [];
let answer = () => ({ matches: [] });
async function fakeAsk(system, user, options) {
  requests.push({ system, user, options });
  const data = JSON.parse(user.slice(user.indexOf('\n') + 1));
  return answer(data);
}

function reset() {
  q('DELETE FROM shop_orders').run();
  q('DELETE FROM payment_mails').run();
  requests.length = 0;
  answer = () => ({ matches: [] });
  aipay._reset();
  aipay._setAsk(fakeAsk);
}

test.before(() => {
  setSetting('shop_auto_max', '0');
});

test('Gemini matches a name written differently; the e-mail is tied to that order only', async () => {
  reset();
  const o1 = order({ payName: 'عماد ابو خاطر' });
  const o2 = order({ payName: 'سامي طارق' });
  const m1 = mail({ name: 'EMAD ABUKHATER' });
  answer = (d) => {
    assert.deepEqual(d.orders.map((o) => o.order).sort(), [o1.code, o2.code].sort());
    assert.deepEqual(d.emails.map((e) => e.email), [m1]);
    // Gemini names the same e-mail for both orders: only the first counts.
    return { matches: [{ order: o1.code, email: m1, reason: 'نفس الاسم بالإنجليزي' }, { order: o2.code, email: m1, reason: 'x' }] };
  };
  assert.equal(await shop.aiReview(), 1);
  const a = q('SELECT * FROM shop_orders WHERE id = ?').get(o1.id);
  const b = q('SELECT * FROM shop_orders WHERE id = ?').get(o2.id);
  assert.equal(a.status, 'paid');
  assert.equal(a.mail_id, m1);
  assert.match(a.verified_by, /^Gemini: نفس الاسم/);
  assert.equal(b.status, 'verifying');
  assert.equal(q('SELECT order_id FROM payment_mails WHERE id = ?').get(m1).order_id, o1.id);
  // The money rules are in the instructions, the data apart from them; nothing is asked again when nothing changed.
  assert.match(requests[0].system, /Each e-mail pays one order only/);
  assert.equal(requests[0].options.temperature, 0);
  assert.equal(await shop.aiReview(), 0);
  assert.equal(requests.length, 1, 'b alone with no unused e-mail: nothing to ask');
});

test('only e-mails of the last 15 minutes, after the order, unused, authenticated and with enough money reach Gemini', async () => {
  reset();
  const o = order({ amount: 40, payName: 'محمد', ago: 30 * MIN });
  mail({ name: 'Mohammed', ago: 16 * MIN }); // older than the quarter hour
  mail({ name: 'Mohammed', amount: 39 }); // less than the order
  mail({ name: 'Mohammed', trusted: 0 }); // not authenticated
  const used = mail({ name: 'Mohammed' });
  q('UPDATE payment_mails SET order_id = 999 WHERE id = ?').run(used);
  const good = mail({ name: 'Mohammad', amount: 45, ago: 5 * MIN });
  let seen = [];
  answer = (d) => { seen = d.emails.map((e) => e.email); return { matches: [{ order: o.code, email: good, reason: 'محمد = Mohammad' }] }; };
  assert.equal(await shop.aiReview(), 1);
  assert.deepEqual(seen, [good]);
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(o.id).status, 'paid');

  // An e-mail from before the order was made cannot pay it, whatever Gemini says.
  reset();
  const early = mail({ name: 'Sami', ago: 10 * MIN });
  const late = order({ payName: 'سامي', ago: 3 * MIN });
  answer = () => ({ matches: [{ order: late.code, email: early, reason: 'x' }] });
  assert.equal(await shop.aiReview(), 0);
  assert.equal(requests.length, 0, 'the early e-mail is not even shown');
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(late.id).status, 'verifying');
});

test('what Gemini names outside the rules is dropped', async () => {
  reset();
  const o = order({ amount: 50, payName: 'خالد' });
  const m = mail({ amount: 60, name: 'Khaled' });
  answer = () => ({ matches: [{ order: o.code, email: m + 100, reason: 'made up' }, { order: 'NOPE', email: m, reason: 'x' }] });
  assert.equal(await shop.aiReview(), 0);
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(o.id).status, 'verifying');
  assert.equal(aipay.allowed(o, { ...q('SELECT * FROM payment_mails WHERE id = ?').get(m), amount: 49 }), false);
});

test('with Gemini on, names wait for it; a reference that matches is still taken at once', async () => {
  reset();
  const byName = order({ payName: 'Sami Tareq' });
  mail({ name: 'Sami Tareq' });
  assert.equal(shop.tryMatch(byName.id), false, 'the name rule is Gemini\'s now');
  const byRef = order({ payReference: '2922941234567' });
  mail({ ref: '2922941234567' });
  assert.equal(shop.tryMatch(byRef.id), true);
  assert.match(q('SELECT verified_by FROM shop_orders WHERE id = ?').get(byRef.id).verified_by, /الرقم المرجعي/);
});

test('when Gemini cannot be reached, the names are matched by the rules as before', async () => {
  reset();
  const o = order({ payName: 'Sami Tareq' });
  mail({ name: 'Sami Tareq' });
  answer = () => null; // askModel gives null when Vertex AI fails or the day's limit is reached
  assert.equal(await shop.aiReview(), 1);
  assert.match(shop.aiState.error, /لم يصل رد من Gemini/);
  // The same question is asked again on the next look (the answer never came).
  const o2 = order({ payName: 'Lina Omar' });
  mail({ name: 'Lina Omar' });
  answer = () => ({ matches: [] });
  assert.equal(await shop.aiReview(), 0);
  assert.equal(shop.aiState.error, '');
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(o2.id).status, 'verifying');
  assert.match(q('SELECT verified_by FROM shop_orders WHERE id = ?').get(o.id).verified_by, /اسم المحوِّل/);
});

test('above the automatic cap, Gemini\'s match waits for the manager', async () => {
  reset();
  setSetting('shop_auto_max', '30');
  try {
    const o = order({ amount: 40, payName: 'عماد' });
    const m = mail({ name: 'Emad' });
    answer = () => ({ matches: [{ order: o.code, email: m, reason: 'x' }] });
    assert.equal(await shop.aiReview(), 0);
    assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(o.id).status, 'review');
    assert.equal(q('SELECT order_id FROM payment_mails WHERE id = ?').get(m).order_id, null);
  } finally { setSetting('shop_auto_max', '0'); }
});

test('Gemini stopped: nothing is asked and the name rules work as before', async () => {
  reset();
  process.env.WA_AI_DAILY_USD = '0'; // the assistant stopped on the server
  try {
    const o = order({ payName: 'Sami Tareq' });
    mail({ name: 'Sami Tareq' });
    assert.equal(await shop.aiReview(), 0);
    assert.equal(requests.length, 0);
    assert.equal(shop.tryMatch(o.id), true);
  } finally { delete process.env.WA_AI_DAILY_USD; }
});

test('Aylol: the activation code a new line comes back with (qr_payload) is read', () => {
  const { _test } = require('../src/aylol');
  const fn = _test?.esimCodeAndQr || require('../src/aylol').esimCodeAndQr;
  if (!fn) return;
  const r = fn({ qr_payload: 'LPA:1$hotmobile.example.com$ABC-123', esim_qr: '/qr-codes/branded/x.png' });
  assert.equal(r.esimCode, 'LPA:1$hotmobile.example.com$ABC-123');
  assert.match(r.qr, /^data:image\/png;base64,/);
});
