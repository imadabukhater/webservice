'use strict';
// WhatsApp: one order going on per chat. The assistant does not open another while one waits for its payment or its
// check, unless the customer cancels it first; and a conversation ends after 15 minutes without a message.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';

const test = require('node:test');
const assert = require('node:assert/strict');
const { q } = require('../src/db');
const wa = require('../src/whatsapp');

const JID = '972500000111@s.whatsapp.net';
let n = 0;
function order(status, jid = JID, ago = 60_000) {
  n++;
  const t = Date.now() - ago;
  q(`INSERT INTO shop_orders (code, package_label, kind, number, customer_name, amount, status, ip, created_at, updated_at)
     VALUES (?, 'Hot 200GB eSIM', 'new', '0530000000', 'عماد', 40, ?, ?, ?, ?)`).run(`WAORD00${n}`, status, `wa:${jid}`.slice(0, 64), t, t);
  return q('SELECT * FROM shop_orders WHERE code = ?').get(`WAORD00${n}`);
}
const ctx = () => ({ jid: JID, phone: '0500000111', shop: { packages: [], jawwalpay: {} }, startedAt: Date.now(), facts: [], after: [], prices: new Set(), phones: new Set() });

test('an order going on in the chat: no new one until the customer cancels it', async () => {
  const o = order('awaiting_payment');
  const c = ctx();
  const r = await wa._test.agentTool('create_order', { package_id: 1, customer_name: 'عماد' }, c);
  assert.equal(r.ok, false);
  assert.equal(r.open_order, o.code);
  assert.match(r.error, /لا تفتح طلب جديد/);
  assert.match(c.facts.join('\n'), new RegExp(o.code), 'its details shown instead');

  // The customer cancels it: then a new one may be made (here: no such package, so the shop says so).
  const c2 = ctx();
  const cancelled = await wa._test.agentTool('cancel_order', {}, c2);
  assert.equal(cancelled.ok, true);
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(o.id).status, 'cancelled');
  assert.match(c2.facts[0], /انلغى الطلب زي ما طلبت/);
  const next = await wa._test.agentTool('create_order', { package_id: 999999, customer_name: 'عماد' }, ctx());
  assert.equal(next.open_order, undefined);
  assert.match(next.error, /ما في باقة/);
});

test('a transfer already sent: the order is not cancelled from the chat, and still blocks a new one', async () => {
  const o = order('verifying');
  const r = await wa._test.agentTool('cancel_order', {}, ctx());
  assert.equal(r.ok, false);
  assert.match(r.error, /لا يمكن إلغاء الطلب بعد إرسال بيانات التحويل/);
  assert.equal((await wa._test.agentTool('create_order', { package_id: 1, customer_name: 'عماد' }, ctx())).open_order, o.code);
  q("UPDATE shop_orders SET status = 'paid' WHERE id = ?").run(o.id);
  // Paid (done or being carried out): a new order may be made.
  assert.equal((await wa._test.agentTool('create_order', { package_id: 1, customer_name: 'عماد' }, ctx())).open_order, undefined);
});

test('another chat\'s order neither blocks nor is cancelled here; an order past its 5 minutes no longer counts', async () => {
  const other = order('awaiting_payment', '972500000222@s.whatsapp.net');
  assert.equal((await wa._test.agentTool('create_order', { package_id: 1, customer_name: 'عماد' }, ctx())).open_order, undefined);
  assert.equal((await wa._test.agentTool('cancel_order', { order_code: other.code }, ctx())).ok, false);
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(other.id).status, 'awaiting_payment');
  const old = order('awaiting_payment', JID, 6 * 60_000);
  assert.equal((await wa._test.agentTool('create_order', { package_id: 1, customer_name: 'عماد' }, ctx())).open_order, undefined);
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(old.id).status, 'cancelled', 'its hold ran out');
});

test('a conversation ends after 15 minutes without a message', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/whatsapp'), 'utf8');
  assert.match(src, /CONVERSATION_IDLE_MS = Number\(process\.env\.WA_CONVERSATION_IDLE_MS\) \|\| 15 \* 60_000/);
  assert.match(src, /SESSION_MS = CONVERSATION_IDLE_MS/);
});
