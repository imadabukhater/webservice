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
  const l = q("SELECT id, agent_id FROM lines WHERE number = ? AND status != 'disconnected'").get(number);
  const mine = !!l && (user.role === 'admin' || l.agent_id === user.id);
  return { valid: true, number, exists: !!l, mine, lineId: mine ? l.id : null };
});

route('GET', '/api/lines/:id', ANY, ({ user, params }) => {
  const l = D.getLine(params.id, user);
  const { esim_qr: esimQr } = q('SELECT esim_qr FROM lines WHERE id = ?').get(l.id);
  const history = q('SELECT * FROM ops WHERE line_id = ? ORDER BY ts DESC, id DESC LIMIT 100').all(l.id).map(D.opView(user.role));
  return { line: { ...D.lineView(l, user.role), esimQr }, history };
});

// ----- activation -----
route('POST', '/api/lines', ANY, ({ user, body }) => tx(() => {
  const isAdmin = user.role === 'admin';
  const agent = isAdmin ? D.getAgent(body.agentId) : D.getUser(user.id);
  if (!agent.active) fail(403, 'حساب الوكيل موقوف');
  const kind = body.kind === 'external' ? 'external' : 'new';
  const months = int(Number(body.months ?? 1), 'المدة', 1, 24);
  const port = kind === 'new' && !!body.port;
  const esim = kind === 'new' && !!body.esim;
  const number = validPhone(normalizePhone(body.number));
  if (q("SELECT 1 FROM lines WHERE number = ? AND status != 'disconnected'").get(number)) fail(409, `الرقم ${number} مفعّل مسبقاً`);

  const { pkg, offer, unit: quoted } = D.quote(agent.id, { packageId: body.packageId, offerId: body.offerId });
  let unit = quoted;
  if (isAdmin && !isBlank(body.unitPrice)) unit = num(body.unitPrice, 'السعر');
  if (unit < 0) fail(400, 'السعر لا يكون سالباً');
  if (!isAdmin && !(unit > 0)) fail(400, 'لم يحدد المدير سعر هذه الباقة بعد');
  const total = round(unit * months);
  const cost = round(pkg.cost * months);

  let sim = { iccid: '', stockId: null };
  if (kind === 'new' && !esim) {
    if (isBlank(body.sim) && !body.simId) fail(400, 'أدخل رقم الشريحة أو اخترها من المخزون');
    sim = D.takeSim({ iccid: body.sim, simId: body.simId }, { agentId: agent.id, isAdmin, companyId: pkg.company_id, companyName: pkg.company_name });
  }
  const customerPrice = optNum(body.customerPrice, 'سعر الزبون');
  if (customerPrice !== null && customerPrice < 0) fail(400, 'سعر الزبون لا يكون سالباً');

  const pending = port || esim;
  const t = now();
  const label = D.packageLabel(pkg);
  const lineId = Number(q(`INSERT INTO lines (number, sim, company_id, package_id, package_label, agent_id, kind, esim, port, months, price, cost,
                                              offer_id, status, customer_name, customer_price, note, activated_at, expires_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(number, sim.iccid, pkg.company_id, pkg.id, label, agent.id, kind, esim ? 1 : 0, port ? 1 : 0, months, total, cost,
      offer?.id ?? null, pending ? 'pending' : 'active', str(body.customerName, 80), customerPrice, str(body.note, 300),
      t, pending ? null : addMonths(t, months), t).lastInsertRowid);
  D.markSimUsed(sim.stockId, lineId);
  if (sim.iccid) D.learnPrefix(pkg.company_id, sim.iccid);

  const detail = [monthsText(months), offer ? `عرض: ${offer.title}` : '', kind === 'external' ? 'رقم خارجي' : '',
    esim ? 'eSIM' : '', port ? 'تحويل رقم' : ''].filter(Boolean).join(' · ');
  D.changeBalance(agent, -total, {
    type: 'activate', actor: user, lineId, number, cost, profit: total - cost, detail, package: label, customerPrice,
  }, { charge: true });

  if (pending) {
    const type = port ? 'port' : 'esim';
    const what = port ? 'تحويل رقم' : 'تفعيل eSIM';
    q('INSERT INTO tasks (type, agent_id, line_id, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(type, agent.id, lineId, total, `${what} ${number} — ${label}`, t);
    D.notify({ role: 'admin', kind: 'task', title: `${what} من ${agent.name}`, body: `${number} — ${label}`, link: '#/tasks' });
  }
  return { line: view(lineId, user), balance: round(agent.balance), available: round(agent.balance + agent.credit_limit) };
}));

// ----- renewal (existing customer) -----
route('POST', '/api/lines/:id/renew', ANY, ({ user, params, body }) => tx(() => {
  const isAdmin = user.role === 'admin';
  const l = D.getLine(params.id, user);
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

  const t = now();
  const expires = addMonths(Math.max(t, l.expires_at || t), months);
  const label = D.packageLabel(pkg);
  q(`UPDATE lines SET package_id = ?, package_label = ?, company_id = ?, months = ?, price = ?, cost = ?, offer_id = ?, expires_at = ?,
       customer_price = COALESCE(?, customer_price), updated_at = ? WHERE id = ?`)
    .run(pkg.id, label, pkg.company_id, months, total, cost, offer?.id ?? null, expires, customerPrice, t, l.id);
  D.changeBalance(agent, -total, {
    type: 'renew', actor: user, lineId: l.id, number: l.number, cost, profit: total - cost, package: label, customerPrice,
    detail: [`تمديد ${monthsText(months)}`, offer ? `عرض: ${offer.title}` : ''].filter(Boolean).join(' · '),
  }, { charge: true });
  return { line: view(l.id, user), balance: round(agent.balance), available: round(agent.balance + agent.credit_limit) };
}));

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

module.exports = { monthsText };
