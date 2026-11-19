'use strict';
// Several WhatsApp numbers linked to the shop: each its own session; a customer is answered from the number they wrote
// to, an order's updates go from its chat's number (even after a restart), and another number takes over when that one
// is down.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';

const test = require('node:test');
const assert = require('node:assert/strict');
const { q } = require('../src/db');
const wa = require('../src/whatsapp');
const T = wa._test;

// A socket standing in for a linked number: what it sends is recorded with the number's id.
const sent = [];
function fakeUp(id, phone) {
  const L = T.link(id);
  Object.assign(L, { status: 'connected', phone, sock: { sendMessage: async (jid, content) => { sent.push({ via: id, jid, text: content.text }); }, sendPresenceUpdate: async () => {}, end() {} } });
  return L;
}
const msg = (jid, id, text) => ({ key: { remoteJid: jid, id, fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text } });

test('numbers are added (up to five) and removed; the first is only unlinked', async () => {
  let s = wa.status();
  assert.deepEqual(s.links.map((l) => l.id), ['main']);
  assert.equal(s.maxLinks, 5);
  assert.equal(s.status, s.links[0].status, 'the first number\'s state at the top, as before');
  const ids = [wa.addLink(), wa.addLink(), wa.addLink(), wa.addLink()];
  assert.deepEqual(ids, ['n2', 'n3', 'n4', 'n5']);
  assert.throws(() => wa.addLink(), /الحد الأقصى 5/);
  await assert.rejects(() => wa.removeLink('main'), /لا يُحذف/);
  s = await wa.removeLink('n4');
  assert.deepEqual(s.links.map((l) => l.id), ['main', 'n2', 'n3', 'n5']);
  assert.equal(wa.addLink(), 'n6', 'a removed id is not used again');
  await wa.removeLink('n5');
  await wa.removeLink('n6');
});

test('a customer is answered from the number they wrote to; another takes over when it is down', async () => {
  T.setTransport(null); // the numbers' own sockets
  fakeUp('main', '972599000001');
  const second = fakeUp('n3', '972599000003');
  const jid = '972500000777@s.whatsapp.net';
  await T.onRaw(msg(jid, 'L-1', 'مرحبا'), 'n3'); // the shop is closed here: it answers that, from n3
  assert.equal(sent.at(-1).via, 'n3');
  assert.equal(sent.at(-1).jid, jid);
  const other = '972500000888@s.whatsapp.net';
  T.recent.clear();
  await T.onRaw(msg(other, 'L-2', 'مرحبا'), 'main');
  assert.equal(sent.at(-1).via, 'main', 'each chat on its own number');
  // An order made in the n3 chat keeps its number, even when the chat's memory is gone (a restart).
  const t = Date.now();
  q(`INSERT INTO shop_orders (code, package_label, kind, number, amount, status, created_at, updated_at) VALUES ('LINKORD1', 'eSIM', 'new', '0530000000', 30, 'awaiting_payment', ?, ?)`).run(t, t);
  T.follow(jid, q("SELECT * FROM shop_orders WHERE code = 'LINKORD1'").get(), 'awaiting');
  assert.equal(q("SELECT link FROM wa_shop WHERE jid = ?").get(jid).link, 'n3');
  T.chatLink.clear();
  assert.equal(T.linkFor(jid).id, 'n3');
  // n3 down: the main number answers instead (better than no answer).
  Object.assign(second, { status: 'off', sock: null });
  assert.equal(T.linkFor(jid).id, 'main');
  // None up: nothing to send from.
  Object.assign(T.link('main'), { status: 'off', sock: null });
  assert.equal(T.linkFor(jid), null);
  T.setTransport(async () => {});
});
