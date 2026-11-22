'use strict';
// The manager's companies and eSIM packages (the shop sells them at their customer price, shop_price).
const { q } = require('../db');
const { fail, round, str, num, int, isBlank, imageOrEmpty } = require('../util');
const { route, ADMIN } = require('../router');

const prefixesOf = (c) => String(c.iccid_prefixes || '').split(/[\s,]+/).filter(Boolean);
const companyView = (c) => ({
  id: c.id, name: c.name, sort: c.sort, color: c.color, logo: c.logo, prefixes: prefixesOf(c), activation: c.activation || 'manual',
  esimFee: c.esim_fee === null || c.esim_fee === undefined ? null : round(c.esim_fee),
  packageCount: c.package_count ?? 0,
});

// The packages that can be sold as an eSIM: a supplier's eSIM (QuickLine, Layan, telecom, Aylol), an Aylol new line
// sold as an eSIM, or a package the manager added by hand with eSIM on. Recharge cards and extensions are not sold.
const ESIM_SQL = `(p.art_card_id LIKE 'qln:%' OR p.art_card_id LIKE 'lyn:%' OR p.art_card_id LIKE 'tcn:%'
  OR p.art_card_id LIKE 'ay:esim:%' OR p.art_card_id LIKE 'ay:bill:%' OR (p.art_card_id = '' AND p.esim_enabled = 1))`;

// Unlimited minutes/SMS are stored as -1.
function amount(v, label) {
  if (isBlank(v)) return null;
  if (/^(-1|∞|unlimited|غير محدود|مفتوح)$/i.test(String(v).trim())) return -1;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(400, `قيمة غير صحيحة: ${label}`);
  return Math.round(n);
}

// Aylol bill lines sold automatically: only for the site's companies whose order form is known (see aylol.js).
const ayBillAuto = (p) => require('../aylol').billAuto(p.art_card_id, p.supplier_company);
const packageAttrs = (p) => {
  const ref = p.art_card_id || '';
  return {
    dataGb: p.data_gb, minutes: p.minutes, sms: p.sms, tag: p.tag, description: p.description,
    kind: 'invoice', days: p.days ?? null,
    popular: !!p.popular,
    oldPrice: p.old_price ? round(p.old_price) : null,
    esimEnabled: !!p.esim_enabled,
    // auto: a supplier carries it out (for "auto" companies); pool: its number is picked from the supplier's free
    // numbers; waits: never active before the supplier activated it.
    auto: !!ref, pool: /^(qln|lyn):|^ay:esim:/.test(ref) || ayBillAuto(p), waits: /^(qln|lyn|tcn|ay):/.test(ref),
    esimOnly: /^ay:esim:/.test(ref),
    art: !!ref, ql: /^qln:/.test(ref), ...require('../quickline').supplierOfRef(ref),
  };
};
// The supplier's code for a package, shown to the manager. QuickLine's and telecom's refs carry the package id and
// the duration (qln:2564:30), and the id is what identifies it there; the others end in it.
const artCode = (ref) => {
  const parts = String(ref || '').split(':').filter(Boolean);
  if (!parts.length) return '';
  return /^(qln|tcn)$/.test(parts[0]) ? parts[1] || '' : parts.slice(-1)[0] || '';
};

function catalog() {
  const companies = q(`SELECT c.*, (SELECT COUNT(*) FROM packages p WHERE p.company_id = c.id AND ${ESIM_SQL}) AS package_count
                       FROM companies c ORDER BY c.sort, c.id`).all();
  const packages = q(`SELECT p.*, c.name AS company_name FROM packages p JOIN companies c ON c.id = p.company_id
                      WHERE ${ESIM_SQL} ORDER BY c.sort, c.id, p.sort, p.id`).all()
    .map((p) => ({ id: p.id, name: p.name, companyId: p.company_id, companyName: p.company_name, cost: round(p.cost), price: round(p.price), shopPrice: p.shop_price === null ? null : round(p.shop_price), active: !!p.active, sort: p.sort,
      artCode: artCode(p.art_card_id), edited: !!p.edited, gone: !!p.gone_at, artPrice: p.art_price === null ? null : round(p.art_price),
      supplierCost: p.supplier_cost === null || p.supplier_cost === undefined ? null : round(p.supplier_cost),
      // The supplier's price changed and the manager has not decided yet.
      artPending: p.art_price !== null && round(p.art_price) !== round(p.cost) && (p.art_ack === null || round(p.art_ack) !== round(p.art_price)),
      ...packageAttrs(p) }));
  return { companies: companies.map(companyView), packages };
}

route('GET', '/api/catalog', ADMIN, () => catalog());

// The same eSIM on offer from two suppliers (same company, same data, same duration): the manager is told which
// is cheaper to activate, and can keep that one on sale.
// A group is listed while acting on it saves something: a pricier one is on sale, or the cheapest is hidden.
route('GET', '/api/catalog/similar', ADMIN, () => {
  const rows = q(`SELECT p.id, p.name, p.cost, p.price, p.active, p.days, p.data_gb, p.art_card_id, p.company_id, c.name AS company_name
                  FROM packages p JOIN companies c ON c.id = p.company_id
                  WHERE p.kind = 'invoice' AND p.cost > 0 AND p.data_gb > 0
                    AND (p.art_card_id LIKE 'qln:%' OR p.art_card_id LIKE 'lyn:%' OR p.art_card_id LIKE 'tcn:%')`).all();
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.company_id}|${r.data_gb}|${r.days || 30}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const source = (ref) => (/^qln:/.test(ref) ? 'QuickLine' : /^lyn:/.test(ref) ? 'ليان' : 'telecom');
  const out = [];
  for (const [key, list] of groups) {
    if (new Set(list.map((r) => source(r.art_card_id))).size < 2) continue;
    list.sort((a, b) => a.cost - b.cost);
    const cheapest = list[0];
    const pricierOnSale = list.filter((r) => r.active && r.cost > cheapest.cost);
    if (!pricierOnSale.length && cheapest.active) continue;
    out.push({
      key, companyId: cheapest.company_id, companyName: cheapest.company_name, dataGb: cheapest.data_gb, days: cheapest.days || 30,
      cheapestId: cheapest.id,
      saving: round(Math.max(0, ...pricierOnSale.map((r) => r.cost)) - cheapest.cost),
      packages: list.map((r) => ({ id: r.id, name: r.name, source: source(r.art_card_id), cost: round(r.cost), price: round(r.price), active: !!r.active })),
    });
  }
  return out.sort((a, b) => b.saving - a.saving);
});

// ----- companies -----
function companyFields(body, existing = {}) {
  const name = str(body.name ?? existing.name, 60);
  if (!name) fail(400, 'اكتب اسم الشركة');
  const color = str(body.color ?? existing.color ?? '', 9);
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) fail(400, 'لون غير صحيح');
  const logo = body.logo === undefined ? existing.logo ?? '' : imageOrEmpty(body.logo, { maxKb: 300, allowSvg: true, label: 'الشعار' });
  const rawPrefixes = body.prefixes === undefined ? existing.iccid_prefixes ?? '' : [].concat(body.prefixes).join(',');
  const prefixes = String(rawPrefixes).split(/[\s,]+/).map((p) => p.replace(/\D/g, '')).filter((p) => p.length >= 4).slice(0, 20).join(',');
  const wanted = body.activation ?? existing.activation;
  const activation = ['direct', 'auto'].includes(wanted) ? wanted : 'manual';
  const feeRaw = body.esimFee === undefined ? existing.esim_fee : body.esimFee;
  const esimFee = isBlank(feeRaw) ? null : num(feeRaw, 'رسوم رمز QR للـ eSIM');
  if (esimFee !== null && esimFee < 0) fail(400, 'رسوم eSIM لا تكون سالبة');
  return { name, color, logo, prefixes, activation, esimFee };
}

route('POST', '/api/companies', ADMIN, ({ body }) => {
  const f = companyFields(body);
  if (q('SELECT 1 FROM companies WHERE name = ?').get(f.name)) fail(409, 'الشركة موجودة');
  const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM companies').get().s;
  return { id: Number(q('INSERT INTO companies (name, sort, color, logo, iccid_prefixes, activation, esim_fee) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(f.name, sort, f.color, f.logo, f.prefixes, f.activation, f.esimFee).lastInsertRowid) };
}, { maxBody: 600 * 1024 });

route('PUT', '/api/companies/:id', ADMIN, ({ params, body }) => {
  const c = q('SELECT * FROM companies WHERE id = ?').get(Number(params.id));
  if (!c) fail(404, 'الشركة غير موجودة');
  const f = companyFields(body, c);
  if (q('SELECT 1 FROM companies WHERE name = ? AND id != ?').get(f.name, c.id)) fail(409, 'الشركة موجودة');
  q('UPDATE companies SET name = ?, color = ?, logo = ?, iccid_prefixes = ?, activation = ?, esim_fee = ? WHERE id = ?')
    .run(f.name, f.color, f.logo, f.prefixes, f.activation, f.esimFee, c.id);
  return { ok: true };
}, { maxBody: 600 * 1024 });

route('DELETE', '/api/companies/:id', ADMIN, ({ params }) => {
  if (q('SELECT 1 FROM packages WHERE company_id = ?').get(Number(params.id))) fail(400, 'احذف رزم الشركة أولاً');
  q('DELETE FROM companies WHERE id = ?').run(Number(params.id));
  return { ok: true };
});

// ----- packages -----
function packageFields(body, existing = {}) {
  const pick = (k, ek) => (body[k] === undefined ? existing[ek ?? k] : body[k]);
  const companyId = Number(pick('companyId', 'company_id'));
  if (!q('SELECT 1 FROM companies WHERE id = ?').get(companyId)) fail(400, 'اختر الشركة');
  const name = str(pick('name'), 80);
  if (!name) fail(400, 'اكتب اسم الرزمة');
  const cost = num(pick('cost') ?? 0, 'التكلفة');
  const price = num(pick('price') ?? 0, 'السعر');
  if (cost < 0 || price < 0) fail(400, 'الأسعار لا تكون سالبة');
  const dataRaw = pick('dataGb', 'data_gb');
  const dataGb = isBlank(dataRaw) ? null : num(dataRaw, 'حجم الإنترنت');
  const kind = 'invoice';
  const daysRaw = pick('days');
  const days = isBlank(daysRaw) ? null : int(Number(daysRaw), 'عدد الأيام', 1, 730);
  const shopRaw = pick('shopPrice', 'shop_price');
  const shopPrice = isBlank(shopRaw) ? null : num(shopRaw, 'سعر الزبون');
  if (shopPrice !== null && shopPrice < 0) fail(400, 'الأسعار لا تكون سالبة');
  const oldRaw = pick('oldPrice', 'old_price');
  const oldPrice = isBlank(oldRaw) ? null : num(oldRaw, 'السعر قبل الخصم');
  if (oldPrice !== null && oldPrice < 0) fail(400, 'الأسعار لا تكون سالبة');
  return {
    companyId, name, cost, price, dataGb, kind, days, shopPrice: shopPrice || null,
    oldPrice: oldPrice || null,
    popular: body.popular === undefined ? (existing.popular ?? 0) : body.popular ? 1 : 0,
    // A package added by hand is an eSIM unless the manager says otherwise.
    esimEnabled: body.esimEnabled === undefined ? (existing.esim_enabled ?? 1) : body.esimEnabled ? 1 : 0,
    minutes: body.minutes === undefined ? existing.minutes ?? null : amount(body.minutes, 'الدقائق'),
    sms: body.sms === undefined ? existing.sms ?? null : amount(body.sms, 'الرسائل'),
    tag: str(pick('tag') ?? '', 30),
    description: str(pick('description') ?? '', 300),
    active: body.active === undefined ? (existing.active ?? 1) : body.active ? 1 : 0,
  };
}

route('POST', '/api/packages', ADMIN, ({ body }) => {
  const f = packageFields(body);
  const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM packages WHERE company_id = ?').get(f.companyId).s;
  return { id: Number(q(`INSERT INTO packages (company_id, name, cost, price, active, sort, data_gb, minutes, sms, tag, description, kind, days, edited, shop_price, old_price, popular, esim_enabled)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
    .run(f.companyId, f.name, f.cost, f.price, f.active, sort, f.dataGb, f.minutes, f.sms, f.tag, f.description, f.kind, f.days, f.shopPrice, f.oldPrice, f.popular, f.esimEnabled).lastInsertRowid) };
});

// Changing what customers see marks the package as edited, so a supplier sync keeps the manager's version.
// Showing or hiding it alone does not.
route('PUT', '/api/packages/:id', ADMIN, ({ params, body }) => {
  const p = q('SELECT * FROM packages WHERE id = ?').get(Number(params.id));
  if (!p) fail(404, 'الرزمة غير موجودة');
  const f = packageFields(body, p);
  const edited = p.edited || ['name', 'price', 'dataGb', 'description', 'days', 'minutes', 'sms', 'kind'].some((k) => body[k] !== undefined);
  q(`UPDATE packages SET company_id = ?, name = ?, cost = ?, price = ?, active = ?, data_gb = ?, minutes = ?, sms = ?, tag = ?, description = ?,
       kind = ?, days = ?, edited = ?, shop_price = ?, old_price = ?, popular = ?, esim_enabled = ? WHERE id = ?`)
    .run(f.companyId, f.name, f.cost, f.price, f.active, f.dataGb, f.minutes, f.sms, f.tag, f.description, f.kind, f.days, edited ? 1 : 0, f.shopPrice, f.oldPrice, f.popular, f.esimEnabled, p.id);
  // Shown or hidden by the manager: from now on the manager's decision, not something a sync undoes.
  if (body.active !== undefined) q('UPDATE packages SET gone_at = NULL WHERE id = ?').run(p.id);
  return { ok: true };
});

// Lines keep their package label, so deleting a package never loses history.
route('DELETE', '/api/packages/:id', ADMIN, ({ params }) => {
  q('DELETE FROM packages WHERE id = ?').run(Number(params.id));
  return { ok: true };
});

// Bulk package actions: delete all or selected packages, hide, show, publish/unpublish in customer shop, or enable eSIM.
route('POST', '/api/packages/bulk', ADMIN, ({ body }) => {
  const action = String(body.action || '');
  const all = !!body.all;
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!all && !ids.length) fail(400, 'حدد رزمة واحدة على الأقل');

  let where = all ? ESIM_SQL.replace(/p\./g, '') : `id IN (${ids.map(() => '?').join(',')})`;
  const args = all ? [] : [...ids];
  if (all && body.companyId) { where += ' AND company_id = ?'; args.push(Number(body.companyId)); }

  let changed = 0;
  if (action === 'delete') {
    changed = q(`DELETE FROM packages WHERE ${where}`).run(...args).changes;
  } else if (action === 'hide') {
    changed = q(`UPDATE packages SET active = 0, gone_at = NULL WHERE ${where}`).run(...args).changes;
  } else if (action === 'show') {
    changed = q(`UPDATE packages SET active = 1, gone_at = NULL WHERE ${where}`).run(...args).changes;
  } else if (action === 'shop-show') {
    changed = q(`UPDATE packages SET active = 1, gone_at = NULL,
                   shop_price = CASE WHEN shop_price IS NOT NULL AND shop_price > 0 THEN shop_price
                                     WHEN price > 0 THEN price
                                     WHEN cost > 0 THEN ROUND(cost * 1.15, 2)
                                     ELSE 50 END
                 WHERE ${where}`).run(...args).changes;
  } else if (action === 'shop-hide') {
    changed = q(`UPDATE packages SET shop_price = NULL WHERE ${where}`).run(...args).changes;
  } else if (action === 'esim-enable') {
    changed = q(`UPDATE packages SET esim_enabled = 1 WHERE ${where}`).run(...args).changes;
  } else if (action === 'esim-disable') {
    changed = q(`UPDATE packages SET esim_enabled = 0 WHERE ${where}`).run(...args).changes;
  } else {
    fail(400, 'عملية غير معروفة');
  }
  return { ok: true, changed, affected: changed };
});

module.exports = { catalog };
