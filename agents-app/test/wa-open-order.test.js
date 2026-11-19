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

test('a transfer already sent, or the order with the manager: the customer still cancels it, and the manager is told', async () => {
  for (const status of ['verifying', 'review']) {
    const o = order(status);
    q("UPDATE shop_orders SET pay_name = 'عماد ابو خاطر' WHERE id = ?").run(o.id);
    assert.equal((await wa._test.agentTool('create_order', { package_id: 1, customer_name: 'عماد' }, ctx())).open_order, o.code, 'it blocks a new one');
    const c = ctx();
    const r = await wa._test.agentTool('cancel_order', {}, c);
    assert.equal(r.ok, true, JSON.stringify(r));
    const row = q('SELECT * FROM shop_orders WHERE id = ?').get(o.id);
    assert.equal(row.status, 'cancelled');
    assert.equal(row.response, 'ألغيت الطلب بنفسك');
    assert.match(c.facts[0], /إذا كنت حوّلت المبلغ، المتجر بيتواصل معك/);
    const note = q('SELECT * FROM notifications WHERE title LIKE ? ORDER BY id DESC').get(`%${o.code}%`);
    assert.ok(note, 'the manager is told');
    assert.match(note.body, /عماد ابو خاطر/);
    assert.equal((await wa._test.agentTool('create_order', { package_id: 1, customer_name: 'عماد' }, ctx())).open_order, undefined, 'then a new one may be made');
  }
});

test('a paid order is not cancelled, and a new one may be made beside it', async () => {
  const o = order('paid');
  const r = await wa._test.agentTool('cancel_order', { order_code: o.code }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.error, /مدفوع/);
  assert.match(r.error, /فيك تعمل طلب جديد/, 'the customer is told a new order can be made');
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(o.id).status, 'paid');
  assert.equal((await wa._test.agentTool('create_order', { package_id: 1, customer_name: 'عماد' }, ctx())).open_order, undefined);
});

test('another chat\'s order neither blocks nor is cancelled here; an order past its 10 minutes no longer counts', async () => {
  const other = order('awaiting_payment', '972500000222@s.whatsapp.net');
  assert.equal((await wa._test.agentTool('create_order', { package_id: 1, customer_name: 'عماد' }, ctx())).open_order, undefined);
  assert.equal((await wa._test.agentTool('cancel_order', { order_code: other.code }, ctx())).ok, false);
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(other.id).status, 'awaiting_payment');
  const old = order('awaiting_payment', JID, 11 * 60_000);
  const recent = order('awaiting_payment', JID, 9 * 60_000);
  assert.equal((await wa._test.agentTool('create_order', { package_id: 1, customer_name: 'عماد' }, ctx())).open_order, recent.code, 'still held at 9 minutes');
  q("UPDATE shop_orders SET status = 'cancelled' WHERE id = ?").run(recent.id);
  assert.equal((await wa._test.agentTool('create_order', { package_id: 1, customer_name: 'عماد' }, ctx())).open_order, undefined);
  assert.equal(q('SELECT status FROM shop_orders WHERE id = ?').get(old.id).status, 'cancelled', 'its hold ran out');
});

test('a conversation ends after 15 minutes without a message', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/whatsapp'), 'utf8');
  assert.match(src, /CONVERSATION_IDLE_MS = Number\(process\.env\.WA_CONVERSATION_IDLE_MS\) \|\| 15 \* 60_000/);
  assert.match(src, /SESSION_MS = CONVERSATION_IDLE_MS/);
});

test('the same WhatsApp message delivered twice is answered once', async () => {
  const sent = [];
  wa._test.setTransport(async (jid, content) => { sent.push({ jid, ...content }); });
  wa._test.recent.clear();
  const msg = (id) => ({ key: { remoteJid: '972500000333@s.whatsapp.net', id, fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'مرحبا' } });
  await wa._test.onRaw(msg('MSG-1'));
  await wa._test.onRaw(msg('MSG-1')); // delivered again
  assert.equal(sent.length, 1);
  await wa._test.onRaw(msg('MSG-2')); // another message: answered
  assert.equal(sent.length, 2);
});

test('one chat\'s messages are answered in turn, not at once', async () => {
  const order2 = [];
  wa._test.setTransport(async (jid, content) => { await new Promise((r) => setTimeout(r, 30)); order2.push(content.text); });
  wa._test.recent.clear();
  const at = Math.floor(Date.now() / 1000);
  const m = (id, text) => ({ key: { remoteJid: '972500000444@s.whatsapp.net', id, fromMe: false }, messageTimestamp: at, message: { conversation: text } });
  const t0 = Date.now();
  await Promise.all([wa._test.onRaw(m('Q-1', 'أول')), wa._test.onRaw(m('Q-2', 'تاني'))]);
  assert.equal(order2.length, 2);
  assert.ok(Date.now() - t0 >= 55, 'the second answer waited for the first');
});

test('a reply already sent in the conversation is caught as a repeat (short words may come again)', () => {
  const jid = '972500000555@s.whatsapp.net';
  wa._test.history.set(jid, [{ role: 'model', text: 'أهلين فيك 👋 عنا eSIM هوت وبيلفون، شو بتحب؟', at: Date.now() }]);
  assert.equal(wa._test.saidBefore(jid, 'أهلين فيك! عنا eSIM هوت وبيلفون، شو بتحب'), true);
  assert.equal(wa._test.saidBefore(jid, 'تمام 👍'), false);
  assert.equal(wa._test.saidBefore(jid, 'هوت 200 جيجا بـ 40 شيكل، بتحب أعملك الطلب؟'), false);
});
