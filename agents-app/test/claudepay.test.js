'use strict';
// Claude reviews payments (src/claudepay.js): only the unused e-mails of the last 15 minutes go to it, what it names
// is checked again against the money rules, and each e-mail pays one order.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';

const test = require('node:test');
const assert = require('node:assert/strict');
const { q, setSetting } = require('../src/db');
const claudepay = require('../src/claudepay');
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

// Claude, played by the test: it answers what `answer` returns for the request it got.
const requests = [];
let answer = () => ({ matches: [] });
let failWith = null;
const fake = {
  beta: { messages: { create: async (req) => {
    requests.push(req);
    if (failWith) throw failWith;
    return { stop_reason: 'end_turn', model: req.model, content: [{ type: 'text', text: JSON.stringify(answer(JSON.parse(req.messages[0].content.split('\n').slice(1).join('\n')))) }] };
  } } },
  messages: { create: async (req) => ({ model: req.model, content: [{ type: 'text', text: 'ok' }] }) },
};

function reset() {
  q('DELETE FROM shop_orders').run();
  q('DELETE FROM payment_mails').run();
  requests.length = 0;
  answer = () => ({ matches: [] });
  failWith = null;
  claudepay._reset();
  claudepay._setClient(fake);
}

test.before(() => {
  setSetting('claude_key', 'sk-ant-test-0000000000000000000000');
  setSetting('claude_pay', '1');
  setSetting('shop_auto_max', '0');
});

test('Claude matches a name written differently; the e-mail is tied to that order only', async () => {
  reset();
  const o1 = order({ payName: 'عماد ابو خاطر' });
  const o2 = order({ payName: 'سامي طارق' });
  const m1 = mail({ name: 'EMAD ABUKHATER' });
  answer = (d) => {
    assert.deepEqual(d.orders.map((o) => o.order).sort(), [o1.code, o2.code].sort());
    assert.deepEqual(d.emails.map((e) => e.email), [m1]);
    // Claude names the same e-mail for both orders: only the first counts.
    return { matches: [{ order: o1.code, email: m1, reason: 'نفس الاسم بالإنجليزي' }, { order: o2.code, email: m1, reason: 'x' }] };
  };
  assert.equal(await shop.claudeReview(), 1);
  const a = q('SELECT * FROM shop_orders WHERE id = ?').get(o1.id);
  const b = q('SELECT * FROM shop_orders WHERE id = ?').get(o2.id);
  assert.equal(a.status, 'paid');
  assert.equal(a.mail_id, m1);
  assert.match(a.verified_by, /^Claude: نفس الاسم/);
  assert.equal(b.status, 'verifying');
  assert.equal(q('SELECT order_id FROM payment_mails WHERE id = ?').get(m1).order_id, o1.id);
  // Structured JSON answer, the default model, and the request is not repeated when nothing changed.
  assert.equal(requests[0].model, 'claude-opus-5-5');
  assert.equal(requests[0].output_config.format.type, 'json_schema');
  assert.equal(await shop.claudeReview(), 0);
  assert.equal(requests.length, 1, 'b alone with no unused e-mail: nothing to ask');
});

test('only e-mails of the last 15 minutes, after the order, unused, authenticated and with enough money reach Claude', async () => {
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
  assert.equal(await shop.claudeReview(), 1);
  assert.deepEqual(seen, [good]);
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(o.id).status, 'paid');

  // An e-mail from before the order was made cannot pay it, whatever Claude says.
  reset();
  const early = mail({ name: 'Sami', ago: 10 * MIN });
  const late = order({ payName: 'سامي', ago: 3 * MIN });
  answer = () => ({ matches: [{ order: late.code, email: early, reason: 'x' }] });
  assert.equal(await shop.claudeReview(), 0);
  assert.equal(requests.length, 0, 'the early e-mail is not even shown');
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(late.id).status, 'verifying');
});

test('what Claude names outside the rules is dropped', async () => {
  reset();
  const o = order({ amount: 50, payName: 'خالد' });
  const m = mail({ amount: 60, name: 'Khaled' });
  answer = () => ({ matches: [{ order: o.code, email: m + 100, reason: 'made up' }, { order: 'NOPE', email: m, reason: 'x' }] });
  assert.equal(await shop.claudeReview(), 0);
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(o.id).status, 'verifying');
  assert.equal(claudepay.allowed(o, { ...q('SELECT * FROM payment_mails WHERE id = ?').get(m), amount: 49 }), false);
});

test('with Claude on, names wait for it; a reference that matches is still taken at once', async () => {
  reset();
  const byName = order({ payName: 'Sami Tareq' });
  mail({ name: 'Sami Tareq' });
  assert.equal(shop.tryMatch(byName.id), false, 'the name rule is Claude\'s now');
  const byRef = order({ payReference: '2922941234567' });
  mail({ ref: '2922941234567' });
  assert.equal(shop.tryMatch(byRef.id), true);
  assert.match(q('SELECT verified_by FROM shop_orders WHERE id = ?').get(byRef.id).verified_by, /الرقم المرجعي/);
});

test('when Claude cannot be reached, the names are matched by the rules as before', async () => {
  reset();
  const o = order({ payName: 'Sami Tareq' });
  mail({ name: 'Sami Tareq' });
  failWith = Object.assign(new Error('overloaded'), { status: 529 });
  assert.equal(await shop.claudeReview(), 1);
  assert.equal(shop.claudeState.error, 'overloaded');
  assert.match(q('SELECT verified_by FROM shop_orders WHERE id = ?').get(o.id).verified_by, /اسم المحوِّل/);
});

test('above the automatic cap, Claude\'s match waits for the manager', async () => {
  reset();
  setSetting('shop_auto_max', '30');
  try {
    const o = order({ amount: 40, payName: 'عماد' });
    const m = mail({ name: 'Emad' });
    answer = () => ({ matches: [{ order: o.code, email: m, reason: 'x' }] });
    assert.equal(await shop.claudeReview(), 0);
    assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(o.id).status, 'review');
    assert.equal(q('SELECT order_id FROM payment_mails WHERE id = ?').get(m).order_id, null);
  } finally { setSetting('shop_auto_max', '0'); }
});

test('Claude off: nothing is asked and the name rules work as before', async () => {
  reset();
  setSetting('claude_pay', '0');
  try {
    const o = order({ payName: 'Sami Tareq' });
    mail({ name: 'Sami Tareq' });
    assert.equal(await shop.claudeReview(), 0);
    assert.equal(requests.length, 0);
    assert.equal(shop.tryMatch(o.id), true);
  } finally { setSetting('claude_pay', '1'); }
});

test('Aylol: the activation code a new line comes back with (qr_payload) is read', () => {
  const { _test } = require('../src/aylol');
  const fn = _test?.esimCodeAndQr || require('../src/aylol').esimCodeAndQr;
  if (!fn) return;
  const r = fn({ qr_payload: 'LPA:1$hotmobile.example.com$ABC-123', esim_qr: '/qr-codes/branded/x.png' });
  assert.equal(r.esimCode, 'LPA:1$hotmobile.example.com$ABC-123');
  assert.match(r.qr, /^data:image\/png;base64,/);
});
