'use strict';
const { q } = require('../db');
const { fail, now, round, str, num, isBlank, dateOrNull, imageOrEmpty } = require('../util');
const { LIVE_OFFER, priceFor, notify, prefixesOf } = require('../domain');
const { route, ADMIN, ANY } = require('../router');

const companyView = (c, admin) => ({
  id: c.id, name: c.name, sort: c.sort, color: c.color, logo: c.logo, prefixes: prefixesOf(c),
  ...(admin ? { packageCount: c.package_count ?? 0 } : {}),
});

// Unlimited minutes/SMS are stored as -1.
function amount(v, label) {
  if (isBlank(v)) return null;
  if (/^(-1|∞|unlimited|غير محدود|مفتوح)$/i.test(String(v).trim())) return -1;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(400, `قيمة غير صحيحة: ${label}`);
  return Math.round(n);
}

const packageAttrs = (p) => ({
  dataGb: p.data_gb, minutes: p.minutes, sms: p.sms, tag: p.tag, description: p.description,
});

// Agents see their own price (and never the cost); packages without a price are hidden from them.
function catalogFor(user) {
  const companies = q(`SELECT c.*, (SELECT COUNT(*) FROM packages p WHERE p.company_id = c.id) AS package_count
                       FROM companies c ORDER BY c.sort, c.id`).all();
  if (user.role === 'agent') {
    const packages = q(`SELECT p.*, c.name AS company_name, COALESCE(ap.price, p.price) AS agent_price, ap.price IS NOT NULL AS custom
                        FROM packages p JOIN companies c ON c.id = p.company_id
                        LEFT JOIN agent_prices ap ON ap.package_id = p.id AND ap.agent_id = ?
                        WHERE p.active = 1 ORDER BY c.sort, c.id, p.sort, p.id`).all(user.id)
      .filter((p) => p.agent_price > 0)
      .map((p) => ({ id: p.id, name: p.name, companyId: p.company_id, companyName: p.company_name, price: round(p.agent_price), custom: !!p.custom, active: true, ...packageAttrs(p) }));
    return { companies: companies.map((c) => companyView(c, false)), packages };
  }
  const packages = q(`SELECT p.*, c.name AS company_name FROM packages p JOIN companies c ON c.id = p.company_id
                      ORDER BY c.sort, c.id, p.sort, p.id`).all()
    .map((p) => ({ id: p.id, name: p.name, companyId: p.company_id, companyName: p.company_name, cost: round(p.cost), price: round(p.price), active: !!p.active, sort: p.sort, ...packageAttrs(p) }));
  return { companies: companies.map((c) => companyView(c, true)), packages };
}

route('GET', '/api/catalog', ANY, ({ user }) => catalogFor(user));

// ----- companies -----
function companyFields(body, existing = {}) {
  const name = str(body.name ?? existing.name, 60);
  if (!name) fail(400, 'اكتب اسم الشركة');
  const color = str(body.color ?? existing.color ?? '', 9);
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) fail(400, 'لون غير صحيح');
  const logo = body.logo === undefined ? existing.logo ?? '' : imageOrEmpty(body.logo, { maxKb: 300, allowSvg: true, label: 'الشعار' });
  const rawPrefixes = body.prefixes === undefined ? existing.iccid_prefixes ?? '' : [].concat(body.prefixes).join(',');
  const prefixes = String(rawPrefixes).split(/[\s,]+/).map((p) => p.replace(/\D/g, '')).filter((p) => p.length >= 4).slice(0, 20).join(',');
  return { name, color, logo, prefixes };
}

route('POST', '/api/companies', ADMIN, ({ body }) => {
  const f = companyFields(body);
  if (q('SELECT 1 FROM companies WHERE name = ?').get(f.name)) fail(409, 'الشركة موجودة');
  const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM companies').get().s;
  return { id: Number(q('INSERT INTO companies (name, sort, color, logo, iccid_prefixes) VALUES (?, ?, ?, ?, ?)')
    .run(f.name, sort, f.color, f.logo, f.prefixes).lastInsertRowid) };
}, { maxBody: 600 * 1024 });

route('PUT', '/api/companies/:id', ADMIN, ({ params, body }) => {
  const c = q('SELECT * FROM companies WHERE id = ?').get(Number(params.id));
  if (!c) fail(404, 'الشركة غير موجودة');
  const f = companyFields(body, c);
  if (q('SELECT 1 FROM companies WHERE name = ? AND id != ?').get(f.name, c.id)) fail(409, 'الشركة موجودة');
  q('UPDATE companies SET name = ?, color = ?, logo = ?, iccid_prefixes = ? WHERE id = ?').run(f.name, f.color, f.logo, f.prefixes, c.id);
  return { ok: true };
}, { maxBody: 600 * 1024 });

route('DELETE', '/api/companies/:id', ADMIN, ({ params }) => {
  if (q('SELECT 1 FROM packages WHERE company_id = ?').get(Number(params.id))) fail(400, 'احذف باقات الشركة أولاً');
  q('DELETE FROM companies WHERE id = ?').run(Number(params.id));
  return { ok: true };
});

// ----- packages -----
function packageFields(body, existing = {}) {
  const pick = (k, ek) => (body[k] === undefined ? existing[ek ?? k] : body[k]);
  const companyId = Number(pick('companyId', 'company_id'));
  if (!q('SELECT 1 FROM companies WHERE id = ?').get(companyId)) fail(400, 'اختر الشركة');
  const name = str(pick('name'), 80);
  if (!name) fail(400, 'اكتب اسم الباقة');
  const cost = num(pick('cost') ?? 0, 'التكلفة');
  const price = num(pick('price') ?? 0, 'السعر');
  if (cost < 0 || price < 0) fail(400, 'الأسعار لا تكون سالبة');
  const dataRaw = pick('dataGb', 'data_gb');
  const dataGb = isBlank(dataRaw) ? null : num(dataRaw, 'حجم الإنترنت');
  return {
    companyId, name, cost, price, dataGb,
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
  return { id: Number(q(`INSERT INTO packages (company_id, name, cost, price, active, sort, data_gb, minutes, sms, tag, description)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(f.companyId, f.name, f.cost, f.price, f.active, sort, f.dataGb, f.minutes, f.sms, f.tag, f.description).lastInsertRowid) };
});

route('PUT', '/api/packages/:id', ADMIN, ({ params, body }) => {
  const p = q('SELECT * FROM packages WHERE id = ?').get(Number(params.id));
  if (!p) fail(404, 'الباقة غير موجودة');
  const f = packageFields(body, p);
  q(`UPDATE packages SET company_id = ?, name = ?, cost = ?, price = ?, active = ?, data_gb = ?, minutes = ?, sms = ?, tag = ?, description = ?
     WHERE id = ?`).run(f.companyId, f.name, f.cost, f.price, f.active, f.dataGb, f.minutes, f.sms, f.tag, f.description, p.id);
  return { ok: true };
});

// Lines keep their package label, so deleting a package never loses history.
route('DELETE', '/api/packages/:id', ADMIN, ({ params }) => {
  q('DELETE FROM packages WHERE id = ?').run(Number(params.id));
  return { ok: true };
});

// ----- offers -----
route('GET', '/api/offers', ANY, ({ user }) => {
  const t = now();
  const agent = user.role === 'agent';
  const rows = q(`SELECT o.*, p.name AS package_name, p.active AS package_active, p.company_id, p.data_gb, p.minutes, p.sms, p.tag,
                    c.name AS company_name, c.color AS company_color, c.logo AS company_logo
                  FROM offers o LEFT JOIN packages p ON p.id = o.package_id LEFT JOIN companies c ON c.id = p.company_id
                  ${agent ? `WHERE ${LIVE_OFFER}` : ''} ORDER BY o.created_at DESC`).all(...(agent ? [t, t] : []));
  return rows
    .filter((o) => !agent || !o.package_id || o.package_active)
    .map((o) => {
      const regular = o.package_id && agent ? round(priceFor(user.id, o.package_id).agent_price) : undefined;
      return {
        id: o.id, title: o.title, details: o.details, packageId: o.package_id, companyId: o.company_id,
        packageLabel: o.package_id ? `${o.company_name} ${o.package_name}` : '',
        companyName: o.company_name || '', companyColor: o.company_color || '', companyLogo: o.company_logo || '',
        dataGb: o.data_gb, minutes: o.minutes, sms: o.sms, tag: o.tag || '',
        offerPrice: o.offer_price === null ? null : round(o.offer_price), regularPrice: regular,
        startsAt: o.starts_at, endsAt: o.ends_at, active: !!o.active,
        live: !!o.active && (o.starts_at === null || o.starts_at <= t) && (o.ends_at === null || o.ends_at >= t),
      };
    });
});

function offerFields(body, existing = {}) {
  const title = str(body.title ?? existing.title, 100);
  if (!title) fail(400, 'اكتب عنوان العرض');
  const packageId = body.packageId === undefined ? existing.package_id ?? null : body.packageId ? Number(body.packageId) : null;
  if (packageId && !q('SELECT 1 FROM packages WHERE id = ?').get(packageId)) fail(400, 'الباقة غير موجودة');
  const rawPrice = body.offerPrice === undefined ? existing.offer_price : body.offerPrice;
  const offerPrice = isBlank(rawPrice) ? null : num(rawPrice, 'سعر العرض');
  if (offerPrice !== null && offerPrice < 0) fail(400, 'السعر لا يكون سالباً');
  const startsAt = body.startsAt === undefined ? existing.starts_at ?? null : dateOrNull(body.startsAt);
  const endsAt = body.endsAt === undefined ? existing.ends_at ?? null : dateOrNull(body.endsAt);
  if (startsAt && endsAt && endsAt < startsAt) fail(400, 'تاريخ النهاية قبل تاريخ البداية');
  const active = body.active === undefined ? (existing.active ?? 1) : body.active ? 1 : 0;
  return { title, details: str(body.details ?? existing.details, 1000), packageId, offerPrice, startsAt, endsAt, active };
}

route('POST', '/api/offers', ADMIN, ({ body }) => {
  const f = offerFields(body);
  const id = Number(q(`INSERT INTO offers (title, details, package_id, offer_price, starts_at, ends_at, active, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(f.title, f.details, f.packageId, f.offerPrice, f.startsAt, f.endsAt, f.active, now()).lastInsertRowid);
  if (f.active) notify({ role: 'agent', kind: 'offer', title: `عرض جديد: ${f.title}`, body: f.details.slice(0, 120), link: '#/offers' });
  return { id };
});

route('PUT', '/api/offers/:id', ADMIN, ({ params, body }) => {
  const o = q('SELECT * FROM offers WHERE id = ?').get(Number(params.id));
  if (!o) fail(404, 'العرض غير موجود');
  const f = offerFields(body, o);
  q('UPDATE offers SET title = ?, details = ?, package_id = ?, offer_price = ?, starts_at = ?, ends_at = ?, active = ? WHERE id = ?')
    .run(f.title, f.details, f.packageId, f.offerPrice, f.startsAt, f.endsAt, f.active, o.id);
  return { ok: true };
});

route('DELETE', '/api/offers/:id', ADMIN, ({ params }) => {
  q('DELETE FROM offers WHERE id = ?').run(Number(params.id));
  return { ok: true };
});

module.exports = { catalogFor };
