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
