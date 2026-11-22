'use strict';
// What the manager's screens share: the user, notifications, a package's label and eSIM lines (each sold through the
// customer shop, see sale.js). There are no agents, balances or prices per seller.
const { EventEmitter } = require('node:events');
const { q, getSettings } = require('./db');
const { fail, now, round } = require('./util');

// ---------- users ----------
const getUser = (id) => q('SELECT * FROM users WHERE id = ?').get(Number(id));

const publicUser = (u) => u && ({
  id: u.id, role: u.role, name: u.name, phone: u.phone, username: u.username, active: !!u.active, createdAt: u.created_at,
});

// user_id = one person; role = everyone with that role.
function notify({ userId = null, role = null, kind, title, body = '', link = '' }) {
  q('INSERT INTO notifications (user_id, role, kind, title, body, link, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, role, kind, title, body, link, now());
}

const packageLabel = (pkg) => `${pkg.company_name} ${pkg.name}`;

// true when the company's sales are activated directly (final); false when the manager or a supplier carries them out.
const directCompany = (companyId) => q('SELECT activation FROM companies WHERE id = ?').get(companyId)?.activation === 'direct';

// ---------- the shop's price ----------
// Every package sold in the shop costs the customer its supplier's price + the manager's percentage (settings
// shop_markup, 20 by default); the company's eSIM fee is added on top at order time. Per package, the manager only
// chooses whether it is in the shop (shop_on).
// What the supplier takes: Aylol's real cost when known, else the supplier's current price (refreshed by every sync),
// else the cost.
const supplierPrice = (p) => Number(p?.supplier_cost ?? p?.art_price ?? p?.cost) || 0;
// Rounded to the agora (2 decimals, util.round: Math.round(x * 100) / 100); null when the supplier price is unknown.
const shopPriceOf = (p, markup = getSettings().shopMarkup) => {
  const sp = supplierPrice(p);
  return sp > 0 ? round(sp * (1 + Number(markup) / 100)) : null;
};
// packages.shop_price is kept by the server only: the shop price while the package is in the shop, else NULL
// (the shop sells what has shop_price > 0). id: one package; none: all of them.
function refreshShopPrices(id = null) {
  const rows = q(`SELECT id, shop_on, supplier_cost, art_price, cost, shop_price FROM packages ${id ? 'WHERE id = ?' : ''}`).all(...(id ? [Number(id)] : []));
  const set = q('UPDATE packages SET shop_price = ? WHERE id = ?');
  const markup = getSettings().shopMarkup;
  let changed = 0;
  for (const p of rows) {
    const want = p.shop_on ? shopPriceOf(p, markup) : null;
    if (want !== p.shop_price) { set.run(want, p.id); changed++; }
  }
  return changed;
}

// Fired with a task id once an eSIM activation is opened; listeners act after the current transaction (setImmediate).
const events = new EventEmitter();

// ---------- lines (the eSIMs sold) ----------
const LINE_SELECT = `SELECT l.id, l.number, l.sim, l.company_id, l.package_id, l.package_label, l.esim,
  l.months, l.days, l.price, l.cost, l.status, l.customer_name, l.customer_price, l.note, l.esim_code, (l.esim_qr != '') AS has_qr,
  l.activated_at, l.expires_at, l.updated_at, c.name AS company_name, c.color AS company_color,
  (SELECT art_card_id FROM packages WHERE id = l.package_id) AS package_ref
  FROM lines l LEFT JOIN companies c ON c.id = l.company_id`;

// Display state: active lines past their end date are "expired", close to it "expiring".
function lineState(l, warnDays = 7) {
  if (l.status === 'active' && l.expires_at) {
    const t = now();
    if (l.expires_at < t) return 'expired';
    if (l.expires_at - t <= warnDays * 864e5) return 'expiring';
  }
  return l.status;
}

function lineView(l) {
  return {
    id: l.id, number: l.number, sim: l.sim, companyId: l.company_id, companyName: l.company_name || '', companyColor: l.company_color || '',
    packageId: l.package_id, packageLabel: l.package_label, esim: !!l.esim, months: l.months, days: l.days ?? null,
    price: round(l.price), cost: round(l.cost), status: l.status, state: lineState(l),
    customerName: l.customer_name, customerPrice: l.customer_price === null ? null : round(l.customer_price),
    note: l.note, esimCode: l.esim_code, hasQr: !!l.has_qr,
    activatedAt: l.activated_at, expiresAt: l.expires_at, updatedAt: l.updated_at,
    ...require('./quickline').supplierOfRef(l.package_ref), source: require('./privacy').sourceOf(l.package_ref),
  };
}

function getLine(id) {
  const l = q(`${LINE_SELECT} WHERE l.id = ?`).get(Number(id));
  if (!l) fail(404, 'الرقم غير موجود');
  return l;
}

// Every package's shop price, as it should be, once at startup.
refreshShopPrices();

module.exports = {
  getUser, publicUser, notify, packageLabel, directCompany, events, LINE_SELECT, lineState, lineView, getLine,
  supplierPrice, shopPriceOf, refreshShopPrices,
};
