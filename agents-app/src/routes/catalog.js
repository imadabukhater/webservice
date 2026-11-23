'use strict';
// The manager's eSIM packages. Prices are not set per package: the shop sells a package at its supplier's price + the
// manager's percentage (settings shopMarkup, domain.shopPriceOf). The one choice per package is whether it is in the
// shop (shop_on). Companies and packages come from the suppliers' syncs and are read only here.
const { q, getSettings } = require('../db');
const { fail, round } = require('../util');
const D = require('../domain');
const { route, ADMIN } = require('../router');

// The packages the shop can sell as an eSIM, by the shop's own rules (routes/shop.js shopKind): a QuickLine or Layan
// new line (an eSIM on a number from the supplier), telecom's ALOHA eSIM, every Aylol eSIM, and an Aylol new line the
// site sells as an eSIM. Recharge cards, extensions and packages without a supplier are not sold.
// esim_enabled does not decide it (the syncs leave it off for most eSIM packages).
const TC_ESIM_COMPANY = 'ALOHA';
const CANDIDATES = `(p.art_card_id LIKE 'qln:%' OR p.art_card_id LIKE 'lyn:%' OR p.art_card_id LIKE 'tcn:%'
  OR p.art_card_id LIKE 'ay:esim:%' OR p.art_card_id LIKE 'ay:bill:%')`;
function esimCapable(p) {
  const ref = String(p.art_card_id || '');
  if (/^(qln|lyn):/.test(ref) || /^ay:esim:/.test(ref)) return true;
  if (/^tcn:/.test(ref)) return p.company_name === TC_ESIM_COMPANY;
  if (/^ay:bill:/.test(ref)) {
    // As the site sells it: an eSIM where its company and sim_type allow one (an unknown sim_type, asked of the site at
    // the first order, counts as possible). The shop also needs Aylol eSIM lines on (routes/aylol.lineEsimOn).
    const AY = require('../aylol');
    return AY.billShop(ref, p.supplier_company) && AY.lineModes(p.supplier_sim_type, p.supplier_company).includes('esim');
  }
  return false;
}
const SELECT = `SELECT p.*, c.name AS company_name FROM packages p JOIN companies c ON c.id = p.company_id WHERE ${CANDIDATES}`;

const packageView = (p) => {
  const sp = D.supplierPrice(p);
  return {
    id: p.id, name: p.name, companyId: p.company_id, companyName: p.company_name,
    supplier: require('../quickline').supplierOfRef(p.art_card_id).supplier || '',
    supplierPrice: sp > 0 ? round(sp) : null,
    shopPrice: p.shop_price > 0 ? round(p.shop_price) : null,
    inShop: !!p.shop_on,
    // Still listed by its supplier (a package the manager hid before is available, just not in the shop).
    available: !p.gone_at,
    dataGb: Number(p.data_gb) > 0 ? Number(p.data_gb) : null,
    days: Number(p.days) > 0 ? Number(p.days) : null,
  };
};

function catalog() {
  const companies = q('SELECT id, name, sort, color, logo FROM companies ORDER BY sort, id').all()
    .map((c) => ({ id: c.id, name: c.name, sort: c.sort, color: c.color, logo: c.logo }));
  const packages = q(`${SELECT} ORDER BY c.sort, c.id, p.sort, p.id`).all().filter(esimCapable).map(packageView);
  return { markup: getSettings().shopMarkup, companies, packages };
}

route('GET', '/api/catalog', ADMIN, () => catalog());

// The only change the manager makes: a package in the shop or not. Its shop price follows at once. On: the package is
// shown again (the shop sells shown packages only), as long as its supplier still lists it. Off: only out of the shop.
route('PUT', '/api/packages/:id', ADMIN, ({ params, body }) => {
  const p = q(`${SELECT} AND p.id = ?`).get(Number(params.id));
  if (!p || !esimCapable(p)) fail(404, 'الرزمة غير موجودة');
  if (typeof body.inShop !== 'boolean') fail(400, 'اختر: في المتجر أو لا');
  if (body.inShop) {
    if (p.gone_at) fail(409, 'غير متوفر عند المورّد');
    q('UPDATE packages SET shop_on = 1, active = 1 WHERE id = ?').run(p.id);
  } else {
    q('UPDATE packages SET shop_on = 0 WHERE id = ?').run(p.id);
  }
  D.refreshShopPrices(p.id);
  require('./shop').invalidateStock(p.id);
  return packageView(q(`${SELECT} AND p.id = ?`).get(p.id));
});

module.exports = { catalog, esimCapable };
