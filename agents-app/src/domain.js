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

const { publicPackageName, forAgent } = require('./privacy');
const packageLabel = (pkg) => {
  const co = String(pkg.company_name || '').trim();
  const nm = publicPackageName(pkg.name || '');
  if (!co) return nm;
  if (!nm) return co;
  return nm.toLowerCase().startsWith(co.toLowerCase()) ? nm : `${co} ${nm}`;
};

// Shared GB / duration / tier helpers for storefront price comparison & sorting (mirrors catalog-compare.js).
const ARABIC_DIGITS_MAP = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};
const toLatinDigits = (s) => String(s || '').replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS_MAP[d] || d);
const escRe = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function extractGb(p) {
  const raw = Number(p?.data_gb ?? p?.dataGb);
  if (raw > 0) return round(raw);
  const text = toLatinDigits(p?.name);
  const tb = text.match(/(\d+(?:\.\d+)?)\s*(?:تيرا(?:\s*بايت)?|tb(?![a-z]))/i);
  if (tb && Number(tb[1]) > 0) return round(Number(tb[1]) * 1000);
  const gb = text.match(/(\d+(?:\.\d+)?)\s*(?:جيجا(?:\s*بايت)?|جبجا|غيغا(?:\s*بايت)?|قيقا|جيكا|ج\.ب|gb(?![a-z]))/i);
  if (gb && Number(gb[1]) > 0) return round(Number(gb[1]));
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*g(?![a-z0-9])/gi)) {
    const val = Number(m[1]);
    if (val >= 10) return round(val);
  }
  return null;
}

function extractDays(p) {
  const raw = Number(p?.days);
  if (raw > 0) return Math.round(raw);
  const text = toLatinDigits(p?.name);
  const d = text.match(/(\d+)\s*(?:يوم|يوماً|يوما|ايام|أيام|days?|d(?![a-z]))/i);
  if (d && Number(d[1]) > 0) return Number(d[1]);
  const m = text.match(/(\d+)\s*(?:شهر|شهور|أشهر|اشهر|شهراً|شهرا|months?|m(?![a-z]))/i);
  if (m && Number(m[1]) > 0) return Number(m[1]) * 30;
  const w = text.match(/(\d+)\s*(?:أسبوع|اسبوع|أسابيع|اسابيع|weeks?)/i);
  if (w && Number(w[1]) > 0) return Number(w[1]) * 7;
  if (/(?:شهرين|شهران)/.test(text)) return 60;
  if (/ثلاثة?\s*(?:أشهر|اشهر)/.test(text)) return 90;
  if (/ستة?\s*(?:أشهر|اشهر)/.test(text)) return 180;
  if (/(?:سنة|سنوي)/.test(text)) return 360;
  if (/(?:أسبوع|اسبوع)/.test(text)) return 7;
  return 30;
}

function cleanTierName(name, companyName) {
  let s = forAgent(toLatinDigits(name || ''));
  if (companyName) s = s.replace(new RegExp(escRe(companyName), 'gi'), ' ');
  s = s
    .replace(/\b(?:e-?sim|sim|just|5g|4g)\b/gi, ' ')
    .replace(/(?:إي\s*سيم|اي\s*سيم|شريحة|حزمة|باقة)/g, ' ')
    .replace(/\d+\s*(?:يوم|يوماً|يوما|ايام|أيام|شهر|شهور|أشهر|اشهر|شهراً|شهرا|days?|months?)/gi, ' ')
    .replace(/(?:شهرين|شهران|شهري|سنوي)/g, ' ')
    .replace(/[-–—·|/()_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (s || String(name || 'pkg')).toLowerCase();
}

function packageTierKey(p) {
  const coKey = p.company_id ?? p.companyId ?? String(p.company_name || p.companyName || '').trim();
  const gb = extractGb(p);
  const days = extractDays(p);
  if (gb !== null) return `${coKey}|gb:${gb}:${days}`;
  if (/(?:نت|انترنت|إنترنت|internet)\s*(?:مفتوح|لامحدود|لا\s*محدود|غير\s*محدود|unlimited)|unlimited\s*data/i.test(String(p?.name || ''))) {
    return `${coKey}|unlimited:${days}`;
  }
  return `${coKey}|other:${cleanTierName(p?.name, p?.company_name || p?.companyName)}:${days}`;
}

const customerTotalOf = (p, s = getSettings()) => {
  const esimFee = p.company_esim_fee === null || p.company_esim_fee === undefined ? s.esimFee : round(p.company_esim_fee);
  return round(round(p.shop_price) + round(esimFee || 0));
};

// From already-available offers, keep the single cheapest offer per (company, tier), then sort by data GB DESC & price ASC.
function selectBestTierPackages(rows, s = getSettings()) {
  const bestByTier = new Map();
  for (const p of rows || []) {
    const key = packageTierKey(p);
    const total = customerTotalOf(p, s);
    const supCost = supplierPrice(p);
    const cur = bestByTier.get(key);
    if (!cur) {
      bestByTier.set(key, { p, total, supCost });
      continue;
    }
    const better = total < cur.total
      || (total === cur.total && supCost > 0 && (cur.supCost <= 0 || supCost < cur.supCost))
      || (total === cur.total && supCost === cur.supCost && !!p.popular && !cur.p.popular);
    if (better) bestByTier.set(key, { p, total, supCost });
  }
  return [...bestByTier.values()]
    .sort((a, b) => {
      const ga = extractGb(a.p) || 0;
      const gb = extractGb(b.p) || 0;
      if (gb !== ga) return gb - ga;
      if (a.total !== b.total) return a.total - b.total;
      const da = extractDays(a.p);
      const db = extractDays(b.p);
      if (da !== db) return da - db;
      if (!!b.p.popular !== !!a.p.popular) return (b.p.popular ? 1 : 0) - (a.p.popular ? 1 : 0);
      return (a.p.sort - b.p.sort) || (a.p.id - b.p.id);
    })
    .map((x) => x.p);
}

// true when the company's sales are activated directly (final); false when the manager or a supplier carries them out.
const directCompany = (companyId) => q('SELECT activation FROM companies WHERE id = ?').get(companyId)?.activation === 'direct';

// ---------- the shop's price ----------
// Every package sold in the shop costs the customer its supplier's price + the manager's percentage (settings
// shop_markup, 20 by default); the company's eSIM fee is added on top at order time. Per package, the manager only
// chooses whether it is in the shop (shop_on).
// What the supplier takes: Aylol's real cost when known, else the supplier's current price (refreshed by every sync),
// else the cost.
const supplierPrice = (p) => Number(p?.supplier_cost ?? p?.art_price ?? p?.cost) || 0;
// Rounded to the nearest whole shekel (Math.round); null when the supplier price is unknown.
const shopPriceOf = (p, markup = getSettings().shopMarkup) => {
  const sp = supplierPrice(p);
  return sp > 0 ? Math.round(sp * (1 + Number(markup) / 100)) : null;
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
  supplierPrice, shopPriceOf, refreshShopPrices, extractGb, extractDays, packageTierKey, customerTotalOf, selectBestTierPackages,
};
