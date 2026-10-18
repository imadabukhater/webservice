'use strict';
const { EventEmitter } = require('node:events');
const { q, getSettings } = require('./db');
const { fail, now, round, normalizeIccid, validIccid } = require('./util');

// ---------- users ----------
const getUser = (id) => q('SELECT * FROM users WHERE id = ?').get(Number(id));

function getAgent(id) {
  const u = q("SELECT * FROM users WHERE id = ? AND role = 'agent'").get(Number(id));
  if (!u) fail(404, 'الوكيل غير موجود');
  return u;
}

const publicUser = (u) => u && ({
  id: u.id, role: u.role, name: u.name, phone: u.phone, username: u.username,
  balance: round(u.balance), creditLimit: round(u.credit_limit), available: round(u.balance + u.credit_limit),
  notes: u.notes, active: !!u.active, createdAt: u.created_at,
});

// ---------- ledger ----------
function logOp(op) {
  return Number(q(`INSERT INTO ops (ts, type, agent_id, agent_name, actor_id, actor_name, line_id, number, amount, balance_before, balance_after,
                                    cost, profit, detail, package, customer_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    now(), op.type, op.agentId ?? null, op.agentName || '', op.actor?.id ?? null, op.actor?.name || '',
    op.lineId ?? null, op.number || '', round(op.amount), op.before ?? null, op.after ?? null,
    round(op.cost), round(op.profit), op.detail || '', op.package || '', op.customerPrice ?? null).lastInsertRowid);
}

// An agent's history never names the supplier: neither who carried it out nor in the details (see privacy.js).
const opView = (role) => (o) => ({
  id: o.id, ts: o.ts, type: o.type, agentId: o.agent_id, agentName: o.agent_name,
  actorName: role === 'admin' ? o.actor_name : require('./privacy').forAgent(o.actor_name),
  lineId: o.line_id, number: o.number, amount: round(o.amount), before: o.balance_before, after: o.balance_after,
  detail: role === 'admin' ? o.detail : require('./privacy').forAgent(o.detail), package: o.package, customerPrice: o.customer_price,
  ...(role === 'admin' ? { cost: round(o.cost), profit: round(o.profit) } : {}),
});

// Charges must stay within balance + credit limit; credits always apply.
function changeBalance(agent, delta, op, { charge = false } = {}) {
  const before = round(agent.balance);
  const after = round(before + delta);
  if (charge && after < -round(agent.credit_limit) - 1e-9) {
    fail(400, `الرصيد المتاح لا يكفي. المتاح ${round(agent.balance + agent.credit_limit)} ₪ والمطلوب ${round(-delta)} ₪`);
  }
  q('UPDATE users SET balance = ? WHERE id = ?').run(after, agent.id);
  agent.balance = after;
  logOp({ ...op, agentId: agent.id, agentName: agent.name, amount: delta, before, after });
}

function logLineOp(type, line, agent, actor, detail, extra = {}) {
  logOp({ type, agentId: agent.id, agentName: agent.name, actor, lineId: line.id, number: line.number,
    before: agent.balance, after: agent.balance, detail, ...extra });
}

// user_id = one person; role = everyone with that role.
function notify({ userId = null, role = null, kind, title, body = '', link = '' }) {
  q('INSERT INTO notifications (user_id, role, kind, title, body, link, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, role, kind, title, body, link, now());
}

// ---------- pricing ----------
const LIVE_OFFER = '(o.active = 1 AND (o.starts_at IS NULL OR o.starts_at <= ?) AND (o.ends_at IS NULL OR o.ends_at >= ?))';

// The manager's pricing systems; each can have its own profit percentage for each agent.
const SYSTEMS = ['invoice', 'card', 'qlinvoice', 'qlcard', 'lyinvoice', 'lycard'];
const SYSTEM_SQL = `CASE WHEN p.art_card_id LIKE 'qln:%' THEN 'qlinvoice' WHEN p.art_card_id LIKE 'ql:%' THEN 'qlcard'
  WHEN p.art_card_id LIKE 'lyn:%' THEN 'lyinvoice' WHEN p.art_card_id LIKE 'ly:%' THEN 'lycard'
  WHEN p.kind = 'card' THEN 'card' ELSE 'invoice' END`;
// An agent's price for a package: a price set for that package > the agent's percentage for its system, on the cost
// (only when there is a cost) > the package's own price. The joins take the agent id twice.
const AGENT_PRICE_JOINS = `LEFT JOIN agent_prices ap ON ap.package_id = p.id AND ap.agent_id = ?
  LEFT JOIN agent_markups am ON am.agent_id = ? AND am.system = ${SYSTEM_SQL}`;
const MARKUP_PRICE_SQL = 'CASE WHEN am.markup IS NOT NULL AND p.cost > 0 THEN ROUND(p.cost * (1 + am.markup / 100.0), 2) END';
const AGENT_PRICE_SQL = `COALESCE(ap.price, ${MARKUP_PRICE_SQL}, p.price)`;

function priceFor(agentId, packageId) {
  const p = q(`SELECT p.*, c.name AS company_name, ${AGENT_PRICE_SQL} AS agent_price
               FROM packages p JOIN companies c ON c.id = p.company_id
               ${AGENT_PRICE_JOINS}
               WHERE p.id = ?`).get(agentId, agentId, Number(packageId));
  if (!p || !p.active) fail(404, 'الرزمة غير متوفرة');
  // Hidden from this agent by the manager: not on sale to them, whatever screen it comes from.
  if (q('SELECT 1 FROM agent_hidden WHERE agent_id = ? AND package_id = ?').get(agentId, p.id)) fail(404, 'هذه الرزمة غير متاحة لك');
  return p;
}

function liveOffer(id) {
  const t = now();
  return q(`SELECT o.* FROM offers o WHERE o.id = ? AND ${LIVE_OFFER}`).get(Number(id), t, t);
}

// What an agent pays per month for a package, or for the package behind a running offer.
function quote(agentId, { packageId, offerId }) {
  if (offerId) {
    const offer = liveOffer(offerId);
    if (!offer || !offer.package_id) fail(400, 'هذا العرض غير متاح');
    const pkg = priceFor(agentId, offer.package_id);
    return { pkg, offer, unit: round(offer.offer_price ?? pkg.agent_price) };
  }
  if (!packageId) fail(400, 'اختر الرزمة');
  const pkg = priceFor(agentId, packageId);
  return { pkg, offer: null, unit: round(pkg.agent_price) };
}

const packageLabel = (pkg) => `${pkg.company_name} ${pkg.name}`;

// true when the company's sales are activated directly (final); false when the manager carries them out.
const directCompany = (companyId) => q('SELECT activation FROM companies WHERE id = ?').get(companyId)?.activation === 'direct';

// Fired with a task id once a sale request is opened; listeners act after the current transaction (setImmediate).
const events = new EventEmitter();

// A sale the manager carries out by hand (or the art-topup executor): opens a task and tells the manager.
function openSaleTask({ type, agent, lineId = null, amount, note, payload = null }) {
  const id = Number(q('INSERT INTO tasks (type, agent_id, line_id, amount, note, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(type, agent.id, lineId, amount, note, payload ? JSON.stringify(payload) : '', now()).lastInsertRowid);
  notify({ role: 'admin', kind: 'task', title: `${note.split(' — ')[0]} من ${agent.name}`, body: note, link: '#/tasks' });
  events.emit('sale-task', id);
  return id;
}

// ---------- SIM cards ----------
const prefixesOf = (c) => String(c.iccid_prefixes || '').split(/[\s,]+/).filter(Boolean);

function companyForIccid(iccid) {
  let best = null;
  let len = 0;
  for (const c of q('SELECT id, name, iccid_prefixes FROM companies').all()) {
    for (const p of prefixesOf(c)) {
      if (iccid.startsWith(p) && p.length > len) { best = c; len = p.length; }
    }
  }
  return best;
}

// The first SIM activated for a company teaches the app that company's ICCID prefix.
function learnPrefix(companyId, iccid) {
  if (companyForIccid(iccid)) return;
  const c = q('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!c) return;
  q('UPDATE companies SET iccid_prefixes = ? WHERE id = ?').run([...prefixesOf(c), iccid.slice(0, 7)].join(','), companyId);
}

// Validates a SIM for activation or swap: from the agent's stock (simId) or typed in.
function takeSim({ iccid, simId }, { agentId, isAdmin, companyId, companyName }) {
  let row;
  if (simId) {
    row = q('SELECT * FROM sims WHERE id = ?').get(Number(simId));
    if (!row) fail(404, 'الشريحة غير موجودة في المخزون');
    iccid = row.iccid;
  } else {
    iccid = validIccid(normalizeIccid(iccid));
    row = q('SELECT * FROM sims WHERE iccid = ?').get(iccid);
  }
  if (row) {
    if (row.status !== 'available') fail(409, 'هذه الشريحة مستعملة');
    if (!(row.agent_id === agentId || (isAdmin && row.agent_id === null))) fail(403, 'هذه الشريحة ليست في مخزونك');
  }
  if (q("SELECT 1 FROM lines WHERE sim = ? AND status != 'disconnected'").get(iccid)) fail(409, 'هذه الشريحة مرتبطة برقم آخر');
  const detected = companyForIccid(iccid);
  if (detected && companyId && detected.id !== companyId) fail(400, `هذه الشريحة تابعة لـ${detected.name} وليست ${companyName}`);
  return { iccid, stockId: row?.id ?? null };
}

function markSimUsed(stockId, lineId) {
  if (stockId) q("UPDATE sims SET status = 'used', line_id = ?, used_at = ? WHERE id = ?").run(lineId, now(), stockId);
}

// ---------- lines ----------
const LINE_SELECT = `SELECT l.id, l.number, l.sim, l.company_id, l.package_id, l.package_label, l.agent_id, l.kind, l.esim, l.port, l.direct,
  l.months, l.price, l.cost, l.offer_id, l.status, l.customer_name, l.customer_price, l.note, l.esim_code, (l.esim_qr != '') AS has_qr,
  l.activated_at, l.expires_at, l.updated_at, u.name AS agent_name, c.name AS company_name, c.color AS company_color,
  (SELECT art_card_id FROM packages WHERE id = l.package_id) AS package_ref
  FROM lines l JOIN users u ON u.id = l.agent_id LEFT JOIN companies c ON c.id = l.company_id`;

// Display state: active lines past their end date are "expired", close to it "expiring".
function lineState(l, warnDays = getSettings().warnDays) {
  if (l.status === 'active' && l.expires_at) {
    const t = now();
    if (l.expires_at < t) return 'expired';
    if (l.expires_at - t <= warnDays * 864e5) return 'expiring';
  }
  return l.status;
}

function lineView(l, role, warnDays) {
  const admin = role === 'admin';
  return {
    id: l.id, number: l.number, sim: l.sim, companyId: l.company_id, companyName: l.company_name || '', companyColor: l.company_color || '',
    packageId: l.package_id, packageLabel: l.package_label, agentId: l.agent_id, agentName: l.agent_name,
    kind: l.kind, esim: !!l.esim, port: !!l.port, direct: !!l.direct, months: l.months, price: round(l.price), offerId: l.offer_id,
    ...(admin ? { cost: round(l.cost) } : {}),
    status: l.status, state: lineState(l, warnDays),
    customerName: l.customer_name, customerPrice: l.customer_price === null ? null : round(l.customer_price),
    note: admin ? l.note : require('./privacy').forAgent(l.note), esimCode: l.esim_code, hasQr: !!l.has_qr,
    activatedAt: l.activated_at, expiresAt: l.expires_at,
    daysLeft: l.expires_at ? Math.ceil((l.expires_at - now()) / 864e5) : null, updatedAt: l.updated_at,
    // Who activates the line (the supplier) is the manager's only.
    ...(admin ? { ...require('./quickline').supplierOfRef(l.package_ref), source: require('./privacy').sourceOf(l.package_ref) } : {}),
  };
}

function getLine(id, user) {
  const l = q(`${LINE_SELECT} WHERE l.id = ?`).get(Number(id));
  if (!l || (user.role === 'agent' && l.agent_id !== user.id)) fail(404, 'الرقم غير موجود');
  return l;
}

module.exports = {
  getUser, getAgent, publicUser, logOp, opView, logLineOp, changeBalance, notify,
  LIVE_OFFER, priceFor, liveOffer, quote, packageLabel, directCompany, openSaleTask, events,
  prefixesOf, companyForIccid, learnPrefix, takeSim, markSimUsed,
  LINE_SELECT, lineState, lineView, getLine, SYSTEMS, SYSTEM_SQL, AGENT_PRICE_JOINS, AGENT_PRICE_SQL, MARKUP_PRICE_SQL,
};
