'use strict';
process.env.DB_FILE = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin-pass';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

let base;
const call = async (token, method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const ok = async (p) => {
  const r = await p;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const login = async (username, password) => (await ok(call(null, 'POST', '/api/login', { username, password }))).token;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const DAY = 864e5;

test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());

test('portal flow: catalog, prices, credit, SIM stock, activations, tasks, renewals, reports', async () => {
  assert.equal((await call(null, 'POST', '/api/login', { username: 'admin', password: 'nope' })).status, 401);
  const admin = await login('admin', 'admin-pass');
  assert.equal((await ok(call(null, 'GET', '/api/public'))).appName, 'بوابة الوكلاء');

  // ----- catalog -----
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const cellcom = cat.companies.find((c) => c.name === 'سلكوم');
  const partner = cat.companies.find((c) => c.name === 'بارتنر');
  assert.deepEqual(cellcom.prefixes, ['8997202']);
  assert.equal(cellcom.activation, 'manual', 'sales are requests to the manager by default');
  // These flows test instant activation: switch the companies to direct.
  for (const c of cat.companies) await ok(call(admin, 'PUT', `/api/companies/${c.id}`, { activation: 'direct' }));
  const p500 = cat.packages.find((p) => p.name === '500 جيجا');
  const p300 = cat.packages.find((p) => p.name === '300 جيجا');
  const pPartner = cat.packages.find((p) => p.companyId === partner.id);
  await ok(call(admin, 'PUT', `/api/packages/${p500.id}`, { cost: 60, price: 80, minutes: 'غير محدود', sms: 5000, tag: 'RENTERS' }));
  await ok(call(admin, 'PUT', `/api/packages/${pPartner.id}`, { cost: 20, price: 30 }));
  const p500v = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.id === p500.id);
  assert.equal(p500v.minutes, -1);
  assert.equal(p500v.dataGb, 500);
  assert.equal(p500v.tag, 'RENTERS');

  // ----- agents -----
  const a1 = await ok(call(admin, 'POST', '/api/agents', { name: 'أبو أحمد', username: 'abu', password: 'secret1', balance: 100, creditLimit: 50 }));
  const a2 = await ok(call(admin, 'POST', '/api/agents', { name: 'محل النور', username: 'noor', password: 'secret2' }));
  assert.equal(a1.available, 150);
  await ok(call(admin, 'PUT', `/api/agents/${a1.id}/prices`, { prices: [{ packageId: p500.id, price: 70 }] }));
  const t1 = await login('abu', 'secret1');
  const t2 = await login('noor', 'secret2');
  const c1 = await ok(call(t1, 'GET', '/api/catalog'));
  assert.equal(c1.packages.find((p) => p.id === p500.id).price, 70);
  assert.equal(c1.packages.find((p) => p.id === p500.id).cost, undefined, 'agents never see the cost');
  assert.ok(!c1.packages.some((p) => p.id === p300.id), 'unpriced packages are hidden');
  assert.equal((await call(t1, 'GET', '/api/agents')).status, 403);
  assert.equal((await call(t1, 'GET', '/api/backup')).status, 403);

  // ----- SIM stock -----
  const sims = await ok(call(t1, 'POST', '/api/sims', {
    iccids: ['8997202000000000011', '8997202000000000029', '8997202000000000037', '12', '8997202000000000011'],
  }));
  assert.equal(sims.added.length, 3);
  assert.deepEqual(sims.invalid, ['12']);
  assert.ok(sims.added.every((s) => s.companyId === cellcom.id), 'company detected from the ICCID prefix');
  const stock = await ok(call(t1, 'GET', '/api/sims?status=available'));
  assert.equal(stock.length, 3);
  assert.equal((await ok(call(t2, 'GET', '/api/sims'))).length, 0);

  // ----- activation within the credit limit -----
  const act = await ok(call(t1, 'POST', '/api/lines', {
    packageId: p500.id, months: 2, number: '+972 52-123-4567', simId: stock.find((s) => s.iccid.endsWith('11')).id,
    customerName: 'محمد', customerPrice: 180,
  }));
  assert.equal(act.line.number, '0521234567');
  assert.equal(act.line.price, 140);
  assert.equal(act.balance, -40);
  assert.equal(act.available, 10);
  assert.equal(act.line.state, 'active');
  assert.ok(Math.abs(act.line.expiresAt - Date.now() - 60 * DAY) < 3 * DAY);
  const lineId = act.line.id;
  assert.equal((await ok(call(t1, 'GET', '/api/sims?status=available'))).length, 2, 'stock SIM is used');
  const short = await call(t1, 'POST', '/api/lines', { packageId: p500.id, number: '0520000002', sim: '8997202000000000029' });
  assert.equal(short.status, 400, 'available balance is 10');
  assert.match(short.body.error, /الرصيد المتاح لا يكفي/);

  await ok(call(admin, 'POST', `/api/agents/${a1.id}/balance`, { kind: 'topup', amount: 400, note: 'نقداً' }));
  assert.equal((await call(t1, 'POST', '/api/lines', { packageId: p500.id, number: '0521234567', sim: '8997202000000000029' })).status, 409);
  const mismatch = await call(t1, 'POST', '/api/lines', { packageId: pPartner.id, number: '0541111111', sim: '8997202000000000029' });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.body.error, /سلكوم/);

  // A SIM with an unknown prefix teaches the company its prefix.
  await ok(call(t1, 'POST', '/api/lines', { packageId: pPartner.id, number: '0541111111', sim: '8997201000000000001' }));
  assert.ok((await ok(call(admin, 'GET', '/api/catalog'))).companies.find((c) => c.id === partner.id).prefixes.includes('8997201'));

  // External prepaid number: no SIM.
  const ext = await ok(call(t1, 'POST', '/api/lines', { kind: 'external', packageId: p500.id, number: '0502222222' }));
  assert.equal(ext.line.kind, 'external');
  assert.equal(ext.line.sim, '');

  // ----- eSIM and number porting go through the manager -----
  const es = await ok(call(t1, 'POST', '/api/lines', { packageId: p500.id, number: '0503333333', esim: true }));
  assert.equal(es.line.status, 'pending');
  assert.equal(es.line.expiresAt, null);
  const port = await ok(call(t1, 'POST', '/api/lines', { packageId: p500.id, number: '0504444444', port: true, sim: '8997202000000000037' }));
  assert.equal(port.line.status, 'pending');
  const balanceBeforeReject = (await ok(call(t1, 'GET', '/api/me'))).user.balance;
  const open = await ok(call(admin, 'GET', '/api/tasks?status=open'));
  assert.equal(open.length, 2);
  const adminNotes = await ok(call(admin, 'GET', '/api/notifications'));
  assert.ok(adminNotes.alerts.some((a) => a.kind === 'tasks'));
  assert.equal(adminNotes.badges.tasks, 2);
  const esTask = open.find((t) => t.type === 'esim');
  const portTask = open.find((t) => t.type === 'port');
  await ok(call(admin, 'POST', `/api/tasks/${esTask.id}/resolve`, { status: 'done', esimCode: 'LPA:1$sm.example$ABC', attachment: PNG }));
  const esLine = await ok(call(t1, 'GET', `/api/lines/${es.line.id}`));
  assert.equal(esLine.line.status, 'active');
  assert.equal(esLine.line.esimCode, 'LPA:1$sm.example$ABC');
  assert.equal(esLine.line.esimQr, PNG);
  assert.ok(esLine.line.expiresAt > Date.now());
  await ok(call(admin, 'POST', `/api/tasks/${portTask.id}/resolve`, { status: 'rejected', response: 'الرقم غير قابل للتحويل' }));
  assert.equal((await ok(call(t1, 'GET', '/api/me'))).user.balance, balanceBeforeReject + 70, 'rejected porting is refunded');
  assert.equal((await call(t1, 'GET', `/api/lines/${port.line.id}`)).status, 404);
  assert.ok((await ok(call(t1, 'GET', '/api/sims?status=available'))).some((s) => s.iccid === '8997202000000000037'), 'SIM back in stock');

  // ----- renewal extends from the current end date -----
  const before = (await ok(call(t1, 'GET', `/api/lines/${lineId}`))).line;
  const renewed = await ok(call(t1, 'POST', `/api/lines/${lineId}/renew`, { months: 1, customerPrice: 90 }));
  const gain = renewed.line.expiresAt - before.expiresAt;
  assert.ok(gain >= 28 * DAY && gain <= 31 * DAY + 3600e3, `renewal adds one month (${gain / DAY} days)`);
  assert.equal(renewed.line.price, 70);
  const otherCompany = await call(t1, 'POST', `/api/lines/${lineId}/renew`, { months: 1, packageId: pPartner.id });
  assert.equal(otherCompany.status, 400);

  // ----- line actions -----
  assert.equal((await ok(call(t1, 'POST', `/api/lines/${lineId}/action`, { action: 'freeze' }))).line.status, 'frozen');
  assert.equal((await call(t1, 'POST', `/api/lines/${lineId}/action`, { action: 'freeze' })).status, 400);
  assert.equal((await ok(call(t1, 'POST', `/api/lines/${lineId}/action`, { action: 'unfreeze' }))).line.status, 'active');
  const swap = await ok(call(t1, 'POST', `/api/lines/${lineId}/action`, { action: 'swap_sim', sim: '8997202000000000029' }));
  assert.equal(swap.line.sim, '8997202000000000029');
  assert.equal((await call(t2, 'POST', `/api/lines/${lineId}/action`, { action: 'freeze' })).status, 404);
  assert.equal((await ok(call(t2, 'GET', '/api/lines'))).length, 0);
  const check = await ok(call(t2, 'GET', '/api/lines/check?number=052-1234567'));
  assert.deepEqual([check.exists, check.mine, check.lineId], [true, false, null]);

  // Expiry warnings: the manager corrects an end date to two days from now.
  await ok(call(admin, 'PUT', `/api/lines/${ext.line.id}`, { expiresAt: Date.now() + 2 * DAY }));
  const n1 = await ok(call(t1, 'GET', '/api/notifications'));
  assert.ok(n1.alerts.some((a) => a.kind === 'expiring'));
  assert.ok(n1.unread >= 2, 'top-up and eSIM notifications');
  assert.ok(n1.items.some((i) => i.title.includes('تم شحن رصيدك')));
  await ok(call(t1, 'POST', '/api/notifications/seen'));
  assert.equal((await ok(call(t1, 'GET', '/api/notifications'))).unread, 0);

  // ----- top-up request with a receipt -----
  const req = await ok(call(t1, 'POST', '/api/tasks', { type: 'topup', amount: 100, note: 'حوالة', attachment: PNG }));
  assert.equal((await call(admin, 'POST', '/api/tasks', { type: 'topup', amount: 5 })).status, 400);
  assert.equal((await call(t1, 'POST', `/api/tasks/${req.id}/resolve`, { status: 'done' })).status, 403);
  assert.equal((await ok(call(admin, 'GET', `/api/tasks/${req.id}`))).attachment, PNG);
  const beforeTopup = (await ok(call(t1, 'GET', '/api/me'))).user.balance;
  await ok(call(admin, 'POST', `/api/tasks/${req.id}/resolve`, { status: 'done', amount: 90 }));
  assert.equal((await ok(call(t1, 'GET', '/api/me'))).user.balance, beforeTopup + 90);
  assert.equal((await call(admin, 'POST', `/api/tasks/${req.id}/resolve`, { status: 'done' })).status, 400, 'resolved once');

  // ----- dashboard, activity, search -----
  const dash = await ok(call(t1, 'GET', '/api/dashboard?tz=-180'));
  assert.equal(dash.today.activations, 5);
  assert.equal(dash.today.renewals, 1);
  assert.equal(dash.lines.expiring, 1);
  assert.equal(dash.month.margin, 180 - 140 + 90 - 70);
  const adminDash = await ok(call(admin, 'GET', '/api/dashboard?tz=-180'));
  assert.equal(adminDash.agents, 2);
  assert.ok(adminDash.month.profit > 0);
  const activity = await ok(call(t1, 'GET', '/api/activity?days=30&tz=-180'));
  assert.equal(activity.days.length, 30);
  assert.equal(activity.days.at(-1).activate, 5);
  assert.equal(activity.totals.swap_sim, 1);
  const found = await ok(call(t1, 'GET', '/api/search?q=1234'));
  assert.equal(found.lines[0].number, '0521234567');
  assert.equal((await ok(call(t2, 'GET', '/api/search?q=1234'))).lines.length, 0);

  // ----- reports -----
  const list = await ok(call(t1, 'GET', '/api/reports'));
  assert.ok(list.some((r) => r.key === 'my_margin'));
  assert.ok(!list.some((r) => r.key === 'by_agent'));
  assert.equal((await call(t1, 'GET', '/api/reports/by_agent')).status, 404);
  const active = await ok(call(t1, 'GET', '/api/reports/active'));
  assert.ok(active.rows.some((r) => r.number === '0521234567'));
  const expiring = await ok(call(t1, 'GET', '/api/reports/expiring'));
  assert.deepEqual(expiring.rows.map((r) => r.number), ['0502222222']);
  const margin = await ok(call(t1, 'GET', '/api/reports/my_margin'));
  assert.equal(margin.rows.reduce((s, r) => s + r.margin, 0), 60);
  const byAgent = await ok(call(admin, 'GET', '/api/reports/by_agent'));
  assert.ok(byAgent.columns.some((c) => c.key === 'profit'));
  const statement = await ok(call(admin, 'GET', `/api/reports/statement?agentId=${a1.id}`));
  assert.ok(statement.rows.every((r) => r.agent === 'أبو أحمد'));

  // ----- manager: move a line with its value, backup -----
  await ok(call(admin, 'POST', `/api/agents/${a2.id}/balance`, { kind: 'topup', amount: 500 }));
  const moved = await ok(call(admin, 'POST', `/api/lines/${ext.line.id}/move`, { toAgentId: a2.id, withMoney: true }));
  assert.equal(moved.line.agentId, a2.id);
  assert.equal((await ok(call(t2, 'GET', '/api/lines'))).length, 1);
  const backup = await call(admin, 'GET', '/api/backup');
  assert.equal(backup.status, 200);
  assert.equal(backup.body.subarray(0, 15).toString(), 'SQLite format 3');

  // ----- disabled agents are signed out -----
  await ok(call(admin, 'PUT', `/api/agents/${a1.id}`, { active: false }));
  assert.equal((await call(t1, 'GET', '/api/me')).status, 401);
  assert.equal((await call(null, 'POST', '/api/login', { username: 'abu', password: 'secret1' })).status, 403);
});

test('offers: running offers only, priced per month', async () => {
  const admin = await login('admin', 'admin-pass');
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const p500 = cat.packages.find((p) => p.name === '500 جيجا');
  const agent = await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل العروض', username: 'offers', password: 'secret9', balance: 500 }));
  const t = await login('offers', 'secret9');
  const live = await ok(call(admin, 'POST', '/api/offers', { title: 'حملة الشتاء', packageId: p500.id, offerPrice: 55, startsAt: Date.now() - DAY, endsAt: Date.now() + DAY }));
  await ok(call(admin, 'POST', '/api/offers', { title: 'منتهي', packageId: p500.id, offerPrice: 1, endsAt: Date.now() - DAY }));
  const seen = await ok(call(t, 'GET', '/api/offers'));
  assert.deepEqual(seen.map((o) => o.title), ['حملة الشتاء']);
  assert.equal(seen[0].regularPrice, 80);
  assert.ok((await ok(call(t, 'GET', '/api/notifications'))).items.some((i) => i.kind === 'offer'));
  const r = await ok(call(t, 'POST', '/api/lines', { offerId: live.id, months: 3, number: '0525555555', sim: '8997202000000000045' }));
  assert.equal(r.line.price, 165);
  assert.equal(r.balance, 335);
  assert.equal(agent.balance, 500);
});

test('card recharge extends a known number; eSIM fee is charged and refunded', async () => {
  const admin = await login('admin', 'admin-pass');
  const p500 = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.name === '500 جيجا');
  await ok(call(admin, 'POST', '/api/agents', { name: 'محل الكروت', username: 'cards', password: 'secret7', balance: 500 }));
  await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل آخر', username: 'other', password: 'secret8', balance: 500 }));
  const t = await login('cards', 'secret7');
  const other = await login('other', 'secret8');

  // ----- card recharge -----
  const first = await ok(call(t, 'POST', '/api/lines', { kind: 'external', packageId: p500.id, number: '0587000001' }));
  assert.equal(first.line.kind, 'external');
  assert.equal(first.balance, 420);
  assert.equal(first.renewed, undefined);
  const again = await ok(call(t, 'POST', '/api/lines', { kind: 'external', packageId: p500.id, number: '058-700-0001' }));
  assert.equal(again.renewed, true, 'a second card on the same number extends the line');
  assert.equal(again.line.id, first.line.id);
  assert.ok(again.line.expiresAt > first.line.expiresAt + 27 * DAY);
  assert.equal(again.balance, 340);
  const taken = await call(other, 'POST', '/api/lines', { kind: 'external', packageId: p500.id, number: '0587000001' });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /وكيل آخر/);
  assert.equal((await call(t, 'POST', '/api/lines', { packageId: p500.id, number: '0587000001', sim: '8997202000000000052' })).status, 409,
    'a new activation still refuses a number in use');

  // ----- eSIM fee (default 7 ₪), refunded in full when rejected -----
  assert.equal((await ok(call(admin, 'GET', '/api/settings'))).esimFee, 7);
  const es = await ok(call(t, 'POST', '/api/lines', { packageId: p500.id, number: '0587000002', esim: true }));
  assert.equal(es.line.price, 87);
  assert.equal(es.balance, 253);
  const task = (await ok(call(admin, 'GET', '/api/tasks?status=open'))).find((x) => x.lineId === es.line.id);
  await ok(call(admin, 'POST', `/api/tasks/${task.id}/resolve`, { status: 'rejected', response: 'خطأ' }));
  assert.equal((await ok(call(t, 'GET', '/api/me'))).user.balance, 340);
  const op = (await ok(call(admin, 'GET', `/api/ops?limit=20`))).find((o) => o.type === 'activate' && o.number === '0587000002');
  assert.equal(op.profit, 87 - 67, 'the fee is passed through at cost');
  await ok(call(admin, 'PUT', '/api/settings', { esimFee: 0 }));
  assert.equal((await ok(call(t, 'POST', '/api/lines', { packageId: p500.id, number: '0587000003', esim: true }))).line.price, 80);
  assert.equal((await call(admin, 'PUT', '/api/settings', { esimFee: -1 })).status, 400);
  await ok(call(admin, 'PUT', '/api/settings', { esimFee: 7 }));
});

test('messages between the manager and an agent, and the support WhatsApp number', async () => {
  const admin = await login('admin', 'admin-pass');
  const agent = await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل الرسائل', username: 'chat', password: 'secret6' }));
  const t = await login('chat', 'secret6');

  assert.equal((await call(t, 'POST', '/api/messages', { body: '   ' })).status, 400);
  assert.equal((await call(t, 'GET', '/api/messages/threads')).status, 403);
  const m1 = await ok(call(t, 'POST', '/api/messages', { body: 'أحتاج 10 شرائح\nمن سلكوم' }));
  assert.equal(m1.fromAdmin, false);

  let n = await ok(call(admin, 'GET', '/api/notifications'));
  assert.equal(n.badges.messages, 1);
  assert.ok(n.alerts.some((a) => a.kind === 'message' && a.link === '#/messages'));
  const thread = (await ok(call(admin, 'GET', '/api/messages/threads'))).find((x) => x.agentId === agent.id);
  assert.equal(thread.unread, 1);
  assert.equal(thread.last.body, 'أحتاج 10 شرائح\nمن سلكوم');

  const seen = await ok(call(admin, 'GET', `/api/messages?agentId=${agent.id}`));
  assert.deepEqual(seen.map((m) => m.id), [m1.id]);
  assert.equal((await ok(call(admin, 'GET', '/api/notifications'))).badges.messages, 0, 'opening the conversation reads it');

  const reply = await ok(call(admin, 'POST', '/api/messages', { agentId: agent.id, body: 'تمام، تصلك غداً' }));
  assert.equal(reply.fromAdmin, true);
  n = await ok(call(t, 'GET', '/api/notifications'));
  assert.equal(n.badges.messages, 1);
  const newer = await ok(call(t, 'GET', `/api/messages?after=${m1.id}`));
  assert.deepEqual(newer.map((m) => m.body), ['تمام، تصلك غداً']);
  const mine = await ok(call(t, 'GET', '/api/messages'));
  assert.equal(mine.find((m) => m.id === m1.id).read, true, 'the agent sees the manager read the message');
  assert.equal((await call(admin, 'POST', '/api/messages', { agentId: 99999, body: 'x' })).status, 404);

  // ----- support WhatsApp -----
  assert.equal((await ok(call(null, 'GET', '/api/public'))).supportWhatsapp, '972567725080');
  assert.equal((await ok(call(admin, 'PUT', '/api/settings', { supportWhatsapp: '+972 56-772-5081' }))).supportWhatsapp, '972567725081');
  assert.equal((await call(admin, 'PUT', '/api/settings', { supportWhatsapp: '0567725080' })).status, 400);
  assert.equal((await ok(call(admin, 'PUT', '/api/settings', { supportWhatsapp: '' }))).supportWhatsapp, '');
  await ok(call(admin, 'PUT', '/api/settings', { supportWhatsapp: '972567725080' }));
});

test('the manager corrects number, package and price of an activated line', async () => {
  const admin = await login('admin', 'admin-pass');
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const p500 = cat.packages.find((p) => p.name === '500 جيجا');
  const p300 = cat.packages.find((p) => p.name === '300 جيجا');
  await ok(call(admin, 'PUT', `/api/packages/${p300.id}`, { cost: 30, price: 45 }));
  await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل التعديل', username: 'fix', password: 'secret5', balance: 200 }));
  const t = await login('fix', 'secret5');
  const act = await ok(call(t, 'POST', '/api/lines', { packageId: p500.id, number: '0588000001', sim: '8997202000000000060' }));
  assert.equal(act.balance, 120);
  assert.equal((await call(t, 'POST', `/api/lines/${act.line.id}/correct`, { price: 1 })).status, 403, 'agents cannot correct');
  assert.equal((await call(admin, 'POST', `/api/lines/${act.line.id}/correct`, {})).status, 400);

  const r = await ok(call(admin, 'POST', `/api/lines/${act.line.id}/correct`, { number: '0588000002', packageId: p300.id, price: 45, reason: 'خطأ وكيل' }));
  assert.equal(r.line.number, '0588000002');
  assert.equal(r.line.packageId, p300.id);
  assert.equal(r.line.price, 45);
  assert.equal(r.balance, 155, 'the 35 ₪ difference goes back to the agent');
  const op = (await ok(call(admin, 'GET', '/api/ops?limit=5'))).find((o) => o.type === 'line_edit');
  assert.equal(op.amount, 35);
  assert.equal(op.profit, -35 + 30, 'profit follows the new price and cost');
  assert.match(op.detail, /0588000001 ← 0588000002/);
  assert.ok((await ok(call(t, 'GET', '/api/notifications'))).items.some((i) => i.title.includes('عدّل المدير')));

  await ok(call(t, 'POST', '/api/lines', { packageId: p500.id, number: '0588000003', sim: '8997202000000000078' }));
  assert.equal((await call(admin, 'POST', `/api/lines/${act.line.id}/correct`, { number: '0588000003' })).status, 409);
});

test('manual companies: sales become requests the manager carries out; direct lines are final', async () => {
  const admin = await login('admin', 'admin-pass');
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const cellcom = cat.companies.find((c) => c.name === 'سلكوم');
  const p500 = cat.packages.find((p) => p.name === '500 جيجا');
  await ok(call(admin, 'PUT', `/api/companies/${cellcom.id}`, { activation: 'manual' }));
  assert.equal((await ok(call(admin, 'GET', '/api/catalog'))).companies.find((c) => c.id === cellcom.id).activation, 'manual');
  const agent = await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل الطلبات', username: 'manual', password: 'secret4', balance: 500 }));
  const t = await login('manual', 'secret4');
  const openTask = async (lineId, type) => (await ok(call(admin, 'GET', '/api/tasks?status=open'))).find((x) => x.lineId === lineId && x.type === type);

  // ----- activation request -----
  const act = await ok(call(t, 'POST', '/api/lines', { packageId: p500.id, number: '0589000001', sim: '8997202000000000086', customerName: 'سامي' }));
  assert.equal(act.line.status, 'pending');
  assert.equal(act.line.expiresAt, null);
  assert.equal(act.balance, 420, 'charged when the request is made');
  const task = await openTask(act.line.id, 'activate');
  assert.match(task.note, /0589000001/);
  assert.match(task.note, /8997202000000000086/);
  assert.match(task.note, /سامي/);
  assert.equal(task.amount, 80);
  assert.equal((await call(t, 'POST', `/api/tasks/${task.id}/cancel`)).status, 400, 'agents cannot cancel a sale request');
  await ok(call(admin, 'POST', `/api/tasks/${task.id}/resolve`, { status: 'done' }));
  const done = (await ok(call(t, 'GET', `/api/lines/${act.line.id}`))).line;
  assert.equal(done.status, 'active');
  assert.ok(done.expiresAt > Date.now() + 27 * 864e5);
  assert.equal(done.direct, false);

  // ----- renewal request: charged now, extended when carried out, refunded when rejected -----
  const ren = await ok(call(t, 'POST', `/api/lines/${act.line.id}/renew`, { months: 1 }));
  assert.equal(ren.pending, true);
  assert.equal(ren.line.expiresAt, done.expiresAt, 'not extended yet');
  assert.equal(ren.balance, 340);
  const renTask = await openTask(act.line.id, 'renew');
  await ok(call(admin, 'POST', `/api/tasks/${renTask.id}/resolve`, { status: 'done' }));
  const extended = (await ok(call(t, 'GET', `/api/lines/${act.line.id}`))).line.expiresAt;
  assert.ok(extended > done.expiresAt + 27 * 864e5);
  await ok(call(t, 'POST', `/api/lines/${act.line.id}/renew`, { months: 1 }));
  const rej = await openTask(act.line.id, 'renew');
  await ok(call(admin, 'POST', `/api/tasks/${rej.id}/resolve`, { status: 'rejected', response: 'الرقم غير صحيح' }));
  assert.equal((await ok(call(t, 'GET', '/api/me'))).user.balance, 340);
  assert.equal((await ok(call(t, 'GET', `/api/lines/${act.line.id}`))).line.expiresAt, extended);

  // ----- card recharge request, rejected: refunded and removed -----
  const card = await ok(call(t, 'POST', '/api/lines', { kind: 'external', packageId: p500.id, number: '0589000002' }));
  assert.equal(card.line.status, 'pending');
  const cardTask = await openTask(card.line.id, 'recharge');
  await ok(call(admin, 'POST', `/api/tasks/${cardTask.id}/resolve`, { status: 'rejected' }));
  assert.equal((await ok(call(t, 'GET', '/api/me'))).user.balance, 340);
  assert.equal((await call(t, 'GET', `/api/lines/${card.line.id}`)).status, 404);

  // ----- the manager's own sales are not requests -----
  const mine = await ok(call(admin, 'POST', '/api/lines', { agentId: agent.id, packageId: p500.id, number: '0589000003', sim: '8997202000000000094' }));
  assert.equal(mine.line.status, 'active');

  // ----- direct: active at once; a final disconnect is the manager's -----
  await ok(call(admin, 'PUT', `/api/companies/${cellcom.id}`, { activation: 'direct' }));
  const direct = await ok(call(t, 'POST', '/api/lines', { packageId: p500.id, number: '0589000004', sim: '8997202000000000102' }));
  assert.equal(direct.line.status, 'active');
  assert.equal(direct.line.direct, true);
  const cut = await call(t, 'POST', `/api/lines/${direct.line.id}/action`, { action: 'disconnect' });
  assert.equal(cut.status, 403);
  assert.match(cut.body.error, /الفصل النهائي عند المدير/);
  // Freezing (a temporary disconnect) stays the agent's.
  assert.equal((await ok(call(t, 'POST', `/api/lines/${direct.line.id}/action`, { action: 'freeze' }))).line.status, 'frozen');
  await ok(call(t, 'POST', `/api/lines/${direct.line.id}/action`, { action: 'unfreeze' }));
  assert.equal((await ok(call(t, 'POST', `/api/lines/${direct.line.id}/renew`, { months: 1 }))).pending, false);
});
