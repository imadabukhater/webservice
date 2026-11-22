'use strict';
// An eSIM sold through the customer shop, once its order is paid (src/shop.js → fulfil): the buyer's line is recorded
// (pending until the supplier activates it) and an eSIM activation task is opened, which autoexec.js carries out at the
// supplier (or the manager by hand). No balance, no ledger: the customer's payment is the sale.
const { q, getSettings } = require('./db');
const { fail, now, round, str, validPhone, normalizePhone } = require('./util');
const D = require('./domain');

// The manager's account: every line belongs to it (lines.agent_id is required).
function ownerId() {
  const u = q("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get()
    || q("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (!u) fail(500, 'لا يوجد حساب مدير');
  return u.id;
}

// Runs inside the caller's transaction. order: a shop_orders row (paid, esim = 1). Returns { lineId }.
function recordEsimSale(order) {
  if (!order || !order.esim) fail(400, 'المتجر يبيع شرائح eSIM فقط');
  const pkg = q(`SELECT p.*, c.name AS company_name, c.esim_fee AS company_esim_fee FROM packages p JOIN companies c ON c.id = p.company_id
                 WHERE p.id = ?`).get(Number(order.package_id));
  if (!pkg) fail(404, 'الرزمة غير متوفرة');
  const number = validPhone(normalizePhone(order.number));
  if (q("SELECT 1 FROM lines WHERE number = ? AND status != 'disconnected'").get(number)) fail(409, `الرقم ${number} مفعّل مسبقاً`);
  // An Aylol sale the account cannot pay for is refused before anything is recorded.
  require('./routes/aylol').ensureBalanceFor(pkg);
  const ref = String(pkg.art_card_id || '');
  const customerName = str(order.customer_name, 80);
  const needName = () => { if (!customerName) fail(400, 'اكتب اسم الزبون — مطلوب لتفعيل هذا الخط'); };
  const served = () => fail(400, 'اختر رقم الهاتف من قائمة الأرقام المتاحة');
  let sim = String(order.sim || '').replace(/\D/g, '');
  let payload = null;
  let qr = order.esim_qr || '';

  if (/^qln:/.test(ref)) {
    // A QuickLine eSIM number brings its own eSIM, and the QR code to install it.
    const QL = require('./routes/quickline');
    const qlRef = require('./quickline').parseRef(ref);
    needName();
    const picked = QL.servedNumber(qlRef.packageId, true, Number(order.number_id) || 0);
    if (!picked || picked.phone !== number) served();
    sim = String(picked.sim || '').replace(/\D/g, '');
    qr = qr || picked.qr || '';
    const rule = QL.simRuleFor(qlRef.packageId);
    const problem = rule && require('./quickline').simProblem(sim, rule);
    if (problem) fail(400, problem);
    payload = { ql: { type: 'newEsimSubscription', numberId: Number(order.number_id), qr: picked.qr } };
  } else if (/^lyn:/.test(ref)) {
    needName();
    if (!require('./routes/layan').servedEsim(require('./layan').parseRef(ref).packageId, number)) served();
    payload = { ly: { esim: true } };
  } else if (/^tcn:/.test(ref)) {
    needName();
    if (!require('./routes/telecom').servedEsim(require('./telecom').parseRef(ref).packageId, number)) served();
    payload = { tc: { esim: true, email: str(order.email, 120), phone: str(order.contact_phone, 20) } };
  } else if (/^ay:esim:/.test(ref)) {
    if (!require('./routes/aylol').servedEsim(ref, number)) served();
  } else if (/^ay:bill:/.test(ref)) {
    // An Aylol new line, sold by the shop as an eSIM where the site sells it so.
    const AY = require('./aylol');
    if (!AY.lineModes(pkg.supplier_sim_type, pkg.supplier_company).includes('esim')) fail(400, 'هذه الرزمة لا تُباع كـ eSIM');
    if (AY.billAuto(ref, pkg.supplier_company)) {
      if (customerName.length < 2 || /\d/.test(customerName)) fail(400, 'اكتب اسم الزبون — مطلوب لتفعيل الخط');
      if (!require('./routes/aylol').servedEsim(ref, number)) served();
    }
  } else if (!pkg.esim_enabled) {
    fail(404, 'الباقة غير متوفرة — المتجر يبيع شرائح eSIM فقط');
  }

  const companyFee = pkg.company_esim_fee === null || pkg.company_esim_fee === undefined ? null : Number(pkg.company_esim_fee);
  const esimFee = companyFee !== null && Number.isFinite(companyFee) ? companyFee : getSettings().esimFee;
  const amount = round(order.amount);
  const cost = round(Number(pkg.cost || 0) + esimFee);
  const label = D.packageLabel(pkg);
  const t = now();
  const lineId = Number(q(`INSERT INTO lines (number, sim, company_id, package_id, package_label, agent_id, kind, esim, port, direct, months, days, price, cost,
                                              status, customer_name, customer_price, note, activated_at, expires_at, updated_at, esim_qr)
                           VALUES (?, ?, ?, ?, ?, ?, 'new', 1, 0, 0, 1, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, ?, ?)`)
    .run(number, sim, pkg.company_id, pkg.id, label, ownerId(), pkg.days || null, amount, cost,
      customerName, amount, `طلب موقع الزبائن ${order.code}`, t, t, qr).lastInsertRowid);

  const note = [`تفعيل eSIM ${number}`, label, customerName ? `الزبون: ${customerName}` : ''].filter(Boolean).join(' — ');
  const taskId = Number(q('INSERT INTO tasks (type, agent_id, line_id, amount, note, payload, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)')
    .run('esim', lineId, amount, note, payload ? JSON.stringify(payload) : '', t).lastInsertRowid);
  D.notify({ role: 'admin', kind: 'task', title: `تفعيل eSIM ${number}`, body: note, link: '#/tasks' });
  D.events.emit('sale-task', taskId);
  return { lineId, taskId };
}

module.exports = { recordEsimSale, ownerId };
