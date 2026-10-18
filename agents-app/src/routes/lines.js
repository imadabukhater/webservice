'use strict';
const { q, tx, getSettings } = require('../db');
const {
  fail, now, round, str, num, optNum, int, isBlank, dateOrNull, normalizePhone, validPhone, addMonths,
} = require('../util');
const D = require('../domain');
const { route, ADMIN, ANY } = require('../router');

const monthsText = (m) => (m === 1 ? 'شهر' : m === 2 ? 'شهران' : m <= 10 ? `${m} أشهر` : `${m} شهراً`);

const view = (lineId, user) => D.lineView(D.getLine(lineId, user), user.role);

function listLines(user, query) {
  const args = [];
  let where = '1=1';
  if (user.role === 'agent') { where += ' AND l.agent_id = ?'; args.push(user.id); }
  else if (query.agentId) { where += ' AND l.agent_id = ?'; args.push(Number(query.agentId)); }
  if (query.status) { where += ' AND l.status = ?'; args.push(String(query.status)); }
  const warn = getSettings().warnDays;
  return q(`${D.LINE_SELECT} WHERE ${where} ORDER BY l.activated_at DESC, l.id DESC LIMIT 5000`).all(...args)
    .map((l) => D.lineView(l, user.role, warn));
}

route('GET', '/api/lines', ANY, ({ user, query }) => listLines(user, query));

// Live check while typing a number in the wizard.
route('GET', '/api/lines/check', ANY, ({ user, query }) => {
  const number = normalizePhone(query.number);
  if (!/^\d{9,13}$/.test(number)) return { valid: false, number };
  const l = q("SELECT id, agent_id, status FROM lines WHERE number = ? AND status != 'disconnected'").get(number);
  const mine = !!l && (user.role === 'admin' || l.agent_id === user.id);
  return { valid: true, number, exists: !!l, mine, lineId: mine ? l.id : null, pending: mine && l.status === 'pending' };
});

route('GET', '/api/lines/:id', ANY, ({ user, params }) => {
  const l = D.getLine(params.id, user);
  const { esim_qr: esimQr } = q('SELECT esim_qr FROM lines WHERE id = ?').get(l.id);
  const history = q('SELECT * FROM ops WHERE line_id = ? ORDER BY ts DESC, id DESC LIMIT 100').all(l.id).map(D.opView(user.role));
  return { line: { ...D.lineView(l, user.role), esimQr }, history };
});

// ----- activation -----
route('POST', '/api/lines', ANY, ({ user, body }) => tx(() => createLine(user, body)));

// A new line or card recharge sold by `user` (an agent, or the manager for body.agentId). Runs inside the caller's transaction.
function createLine(user, body) {
  const isAdmin = user.role === 'admin';
  const agent = isAdmin ? D.getAgent(body.agentId) : D.getUser(user.id);
  if (!agent.active) fail(403, 'حساب الوكيل موقوف');
  // kind 'external' = card recharge for a prepaid number activated outside the portal.
  const kind = body.kind === 'external' ? 'external' : 'new';
  const months = int(Number(body.months ?? 1), 'المدة', 1, 24);
  const port = kind === 'new' && !!body.port;
  const esim = kind === 'new' && !!body.esim;
  const number = validPhone(normalizePhone(body.number));
  const existing = q("SELECT id, agent_id FROM lines WHERE number = ? AND status != 'disconnected'").get(number);
  if (existing) {
    // Recharging a card on one of the agent's own numbers extends that line.
    if (kind === 'external' && existing.agent_id === agent.id) return { ...renewLine(user, D.getLine(existing.id, user), body), renewed: true };
    fail(409, kind === 'external' ? `الرقم ${number} مسجّل عند وكيل آخر. تواصل مع المدير.` : `الرقم ${number} مفعّل مسبقاً`);
  }

  const { pkg, offer, unit: quoted } = D.quote(agent.id, { packageId: body.packageId, offerId: body.offerId });
  let unit = quoted;
  if (isAdmin && !isBlank(body.unitPrice)) unit = num(body.unitPrice, 'السعر');
  if (unit < 0) fail(400, 'السعر لا يكون سالباً');
  if (!isAdmin && !(unit > 0)) fail(400, 'لم يحدد المدير سعر هذه الباقة بعد');
  // The eSIM activation fee is passed through at cost, so it adds to the price but not to the profit.
  const esimFee = esim ? getSettings().esimFee : 0;
  const total = round(unit * months + esimFee);
  const cost = round(pkg.cost * months + esimFee);

  let sim = { iccid: '', stockId: null };
  if (kind === 'new' && !esim) {
    if (isBlank(body.sim) && !body.simId) fail(400, 'أدخل رقم الشريحة أو اخترها من المخزون');
    sim = D.takeSim({ iccid: body.sim, simId: body.simId }, { agentId: agent.id, isAdmin, companyId: pkg.company_id, companyName: pkg.company_name });
  }
  const customerPrice = optNum(body.customerPrice, 'سعر الزبون');
  if (customerPrice !== null && customerPrice < 0) fail(400, 'سعر الزبون لا يكون سالباً');

  // Direct companies: active at once and final. Manual companies: a request the manager carries out
  // (the manager's own sales count as already done). eSIM and number porting always go through the manager.
  const direct = D.directCompany(pkg.company_id) && !port && !esim;
  const manual = !direct && !port && !esim && !isAdmin;
  const pending = port || esim || manual;
  const t = now();
  const label = D.packageLabel(pkg);
  const customerName = str(body.customerName, 80);
  const lineId = Number(q(`INSERT INTO lines (number, sim, company_id, package_id, package_label, agent_id, kind, esim, port, direct, months, price, cost,
                                              offer_id, status, customer_name, customer_price, note, activated_at, expires_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(number, sim.iccid, pkg.company_id, pkg.id, label, agent.id, kind, esim ? 1 : 0, port ? 1 : 0, direct ? 1 : 0, months, total, cost,
      offer?.id ?? null, pending ? 'pending' : 'active', customerName, customerPrice, str(body.note, 300),
      t, pending ? null : addMonths(t, months), t).lastInsertRowid);
  D.markSimUsed(sim.stockId, lineId);
  if (sim.iccid) D.learnPrefix(pkg.company_id, sim.iccid);

  const detail = [monthsText(months), offer ? `عرض: ${offer.title}` : '', kind === 'external' ? 'شحن كرت' : '',
    esim ? (esimFee ? `eSIM (رسوم ${esimFee} ₪)` : 'eSIM') : '', port ? 'تحويل رقم' : ''].filter(Boolean).join(' · ');
  D.changeBalance(agent, -total, {
    type: 'activate', actor: user, lineId, number, cost, profit: total - cost, detail, package: label, customerPrice,
  }, { charge: true });

  if (pending) {
    const type = port ? 'port' : esim ? 'esim' : kind === 'external' ? 'recharge' : 'activate';
    const what = { port: 'تحويل رقم', esim: 'تفعيل eSIM', recharge: 'شحن كرت', activate: 'تفعيل خط' }[type];
    // Everything the manager needs to carry it out on the company's site.
    const note = [`${what} ${number}`, label, monthsText(months), sim.iccid ? `شريحة ${sim.iccid}` : '', customerName ? `الزبون: ${customerName}` : '']
      .filter(Boolean).join(' — ');
    D.openSaleTask({ type, agent, lineId, amount: total, note });
  }
  return { line: view(lineId, user), balance: round(agent.balance), available: round(agent.balance + agent.credit_limit) };
}

// ----- renewal (existing customer, or a card recharge on a known number) -----
route('POST', '/api/lines/:id/renew', ANY, ({ user, params, body }) => tx(() => renewLine(user, D.getLine(params.id, user), body)));

// Runs inside the caller's transaction.
function renewLine(user, l, body) {
  const isAdmin = user.role === 'admin';
  if (l.status === 'pending') fail(400, 'طلب هذا الرقم ما زال قيد التنفيذ');
  if (l.status === 'disconnected') fail(400, 'الرقم مفصول. فعّله من جديد كمشترك جديد.');
  const agent = D.getUser(l.agent_id);
  if (!agent.active) fail(403, 'حساب الوكيل موقوف');
  const months = int(Number(body.months ?? 1), 'المدة', 1, 24);
  const packageId = body.offerId ? null : body.packageId ?? l.package_id;
  if (!body.offerId && !packageId) fail(400, 'اختر الباقة');
  const { pkg, offer, unit: quoted } = D.quote(agent.id, { packageId, offerId: body.offerId });
  if (l.company_id && pkg.company_id !== l.company_id) fail(400, `اختر باقة من ${l.company_name}`);
  let unit = quoted;
  if (isAdmin && !isBlank(body.unitPrice)) unit = num(body.unitPrice, 'السعر');
  if (unit < 0) fail(400, 'السعر لا يكون سالباً');
  if (!isAdmin && !(unit > 0)) fail(400, 'لم يحدد المدير سعر هذه الباقة بعد');
  const total = round(unit * months);
  const cost = round(pkg.cost * months);
  const customerPrice = optNum(body.customerPrice, 'سعر الزبون');

  const label = D.packageLabel(pkg);
  const card = body.kind === 'external';
  const renewal = { packageId: pkg.id, label, companyId: pkg.company_id, months, total, cost, offerId: offer?.id ?? null, customerPrice };
  // Manual companies: the agent pays now; the line is extended when the manager marks the request done.
  const manual = !isAdmin && !D.directCompany(pkg.company_id);
  if (!manual) applyRenewal(l.id, renewal);
  D.changeBalance(agent, -total, {
    type: 'renew', actor: user, lineId: l.id, number: l.number, cost, profit: total - cost, package: label, customerPrice,
    detail: [`تمديد ${monthsText(months)}`, offer ? `عرض: ${offer.title}` : '', card ? 'شحن كرت' : '', manual ? 'بانتظار التنفيذ' : ''].filter(Boolean).join(' · '),
  }, { charge: true });
  if (manual) {
    const note = [`${card ? 'شحن كرت' : 'تمديد رزمة'} ${l.number}`, label, monthsText(months), l.customer_name ? `الزبون: ${l.customer_name}` : '']
      .filter(Boolean).join(' — ');
    D.openSaleTask({ type: 'renew', agent, lineId: l.id, amount: total, note, payload: renewal });
  }
  return { line: view(l.id, user), pending: manual, balance: round(agent.balance), available: round(agent.balance + agent.credit_limit) };
}

// Extends a line by a renewal (now, or when the manager carries out a renewal request).
function applyRenewal(lineId, r) {
  const t = now();
  const l = q('SELECT expires_at FROM lines WHERE id = ?').get(lineId);
  q(`UPDATE lines SET package_id = ?, package_label = ?, company_id = ?, months = ?, price = ?, cost = ?, offer_id = ?, expires_at = ?,
       customer_price = COALESCE(?, customer_price), updated_at = ? WHERE id = ?`)
    .run(r.packageId, r.label, r.companyId, r.months, r.total, r.cost, r.offerId, addMonths(Math.max(t, l.expires_at || t), r.months),
      r.customerPrice, t, lineId);
}

// ----- freeze, unfreeze, disconnect, SIM swap -----
const ACTIONS = {
  freeze: { from: ['active'], to: 'frozen', label: 'تجميد الرقم' },
  unfreeze: { from: ['frozen'], to: 'active', label: 'إلغاء التجميد' },
  disconnect: { from: ['active', 'frozen'], to: 'disconnected', label: 'فصل الرقم' },
};

route('POST', '/api/lines/:id/action', ANY, ({ user, params, body }) => tx(() => {
  const l = D.getLine(params.id, user);
  const agent = D.getUser(l.agent_id);
  const action = String(body.action);
  const reason = str(body.reason, 200);
  if (action === 'swap_sim') {
    if (!['active', 'frozen'].includes(l.status)) fail(400, 'لا يمكن تبديل شريحة هذا الرقم الآن');
    if (isBlank(body.sim) && !body.simId) fail(400, 'أدخل رقم الشريحة الجديدة');
    const sim = D.takeSim({ iccid: body.sim, simId: body.simId },
      { agentId: agent.id, isAdmin: user.role === 'admin', companyId: l.company_id, companyName: l.company_name });
    q('UPDATE lines SET sim = ?, esim = 0, updated_at = ? WHERE id = ?').run(sim.iccid, now(), l.id);
    D.markSimUsed(sim.stockId, l.id);
    if (l.company_id) D.learnPrefix(l.company_id, sim.iccid);
    D.logLineOp('swap_sim', l, agent, user, `${l.sim || 'بدون شريحة'} ← ${sim.iccid}${reason ? ' · ' + reason : ''}`, { package: l.package_label });
  } else {
    const a = ACTIONS[action];
    if (!a) fail(400, 'إجراء غير معروف');
    if (action === 'disconnect' && l.direct && user.role !== 'admin') fail(400, 'هذا الخط مفعّل تفعيلاً مباشراً ولا يمكن فصله');
    if (!a.from.includes(l.status)) fail(400, 'لا يمكن تنفيذ هذا الإجراء على حالة الرقم الحالية');
    q('UPDATE lines SET status = ?, updated_at = ? WHERE id = ?').run(a.to, now(), l.id);
    D.logLineOp(action, l, agent, user, a.label + (reason ? ' · ' + reason : ''), { package: l.package_label });
  }
  return { line: view(l.id, user) };
}));

// Customer details and notes; the manager may also correct the end date.
route('PUT', '/api/lines/:id', ANY, ({ user, params, body }) => {
  const l = D.getLine(params.id, user);
  const full = q('SELECT customer_price, expires_at FROM lines WHERE id = ?').get(l.id);
  const name = body.customerName === undefined ? l.customer_name : str(body.customerName, 80);
  const price = body.customerPrice === undefined ? full.customer_price : optNum(body.customerPrice, 'سعر الزبون');
  const note = body.note === undefined ? l.note : str(body.note, 300);
  const expires = user.role === 'admin' && body.expiresAt !== undefined ? dateOrNull(body.expiresAt) : full.expires_at;
  q('UPDATE lines SET customer_name = ?, customer_price = ?, note = ?, expires_at = ?, updated_at = ? WHERE id = ?')
    .run(name, price, note, expires, now(), l.id);
  return { line: view(l.id, user) };
});

// The manager corrects what an agent activated: number, package and/or the price charged.
// A price change charges or refunds the difference to the agent (it may go past the credit limit).
route('POST', '/api/lines/:id/correct', ADMIN, ({ user, params, body }) => tx(() => {
  const l = D.getLine(params.id, user);
  const agent = D.getUser(l.agent_id);
  const full = q('SELECT cost FROM lines WHERE id = ?').get(l.id);
  const changes = [];

  let number = l.number;
  if (!isBlank(body.number) && normalizePhone(body.number) !== l.number) {
    number = validPhone(normalizePhone(body.number));
    if (q("SELECT 1 FROM lines WHERE number = ? AND status != 'disconnected' AND id != ?").get(number, l.id)) fail(409, `الرقم ${number} مفعّل على خط آخر`);
    changes.push(`الرقم ${l.number} ← ${number}`);
  }

  let pkg = null;
  let cost = full.cost;
  if (body.packageId && Number(body.packageId) !== l.package_id) {
    pkg = D.priceFor(agent.id, body.packageId);
    const old = l.package_id ? q('SELECT cost FROM packages WHERE id = ?').get(l.package_id) : null;
    // Keep any eSIM fee inside the cost: swap only the package part.
    cost = round(old ? full.cost - old.cost * l.months + pkg.cost * l.months : pkg.cost * l.months);
    changes.push(`الرزمة ${l.package_label} ← ${D.packageLabel(pkg)}`);
  }

  let price = l.price;
  if (!isBlank(body.price)) {
    price = num(body.price, 'السعر');
    if (price < 0) fail(400, 'السعر لا يكون سالباً');
    if (round(price) !== round(l.price)) changes.push(`السعر ${round(l.price)} ← ${round(price)} ₪`);
  }
  if (!changes.length) fail(400, 'لم يتغير شيء');

  const label = pkg ? D.packageLabel(pkg) : l.package_label;
  q('UPDATE lines SET number = ?, package_id = ?, package_label = ?, company_id = ?, price = ?, cost = ?, updated_at = ? WHERE id = ?')
    .run(number, pkg ? pkg.id : l.package_id, label, pkg ? pkg.company_id : l.company_id, price, cost, now(), l.id);
  const detail = `تعديل المدير: ${changes.join(' · ')}${body.reason ? ' · ' + str(body.reason, 200) : ''}`;
  const priceDelta = round(price - l.price);
  const costDelta = round(cost - full.cost);
  if (priceDelta || costDelta) {
    D.changeBalance(agent, -priceDelta, {
      type: 'line_edit', actor: user, lineId: l.id, number, cost: costDelta, profit: priceDelta - costDelta, package: label, detail,
    });
  } else {
    D.logLineOp('line_edit', { ...l, number }, agent, user, detail, { package: label });
  }
  D.notify({ userId: agent.id, kind: 'line', title: `عدّل المدير الخط ${number}`, body: changes.join(' · '), link: '#/subscribers' });
  return { line: view(l.id, user), balance: round(agent.balance) };
}));

route('POST', '/api/lines/:id/move', ADMIN, ({ user, params, body }) => tx(() => {
  const l = D.getLine(params.id, user);
  const from = D.getUser(l.agent_id);
  const to = D.getAgent(body.toAgentId);
  if (to.id === from.id) fail(400, 'اختر وكيلاً آخر');
  const detail = `نقل من ${from.name} إلى ${to.name}`;
  if (body.withMoney) {
    D.changeBalance(to, -l.price, { type: 'line_move', actor: user, lineId: l.id, number: l.number, detail }, { charge: true });
    D.changeBalance(from, l.price, { type: 'line_move', actor: user, lineId: l.id, number: l.number, detail });
  } else {
    D.logLineOp('line_move', l, to, user, detail);
  }
  q('UPDATE lines SET agent_id = ?, updated_at = ? WHERE id = ?').run(to.id, now(), l.id);
  D.notify({ userId: to.id, kind: 'line', title: `أُضيف الرقم ${l.number} إلى حسابك`, body: l.package_label, link: '#/subscribers' });
  D.notify({ userId: from.id, kind: 'line', title: `نُقل الرقم ${l.number} من حسابك`, body: `إلى ${to.name}`, link: '#/subscribers' });
  return { line: view(l.id, user) };
}));

// Removes a line entered by mistake. A SIM taken from stock goes back to stock.
route('DELETE', '/api/lines/:id', ADMIN, ({ user, params, query }) => tx(() => {
  const l = D.getLine(params.id, user);
  const agent = D.getUser(l.agent_id);
  if (query.refund === '1') {
    D.changeBalance(agent, l.price, { type: 'line_delete', actor: user, number: l.number, cost: -l.cost, profit: -(l.price - l.cost),
      package: l.package_label, detail: 'حذف الخط مع إرجاع المبلغ' });
  } else {
    D.logLineOp('line_delete', l, agent, user, 'حذف الخط');
  }
  q("UPDATE sims SET status = 'available', line_id = NULL, used_at = NULL WHERE line_id = ?").run(l.id);
  q("DELETE FROM tasks WHERE line_id = ? AND status = 'open'").run(l.id);
  q('DELETE FROM lines WHERE id = ?').run(l.id);
  return { ok: true };
}));

module.exports = { monthsText, applyRenewal, createLine };
