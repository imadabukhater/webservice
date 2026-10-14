'use strict';
// art-topup for the two separate systems: recharge cards ('card') and invoices ('invoice').
// Each has its own sync, its own profit percentage, and its own list of price changes awaiting the manager.
const { q, tx, getSettings, setSetting, artCredentials } = require('../db');
const { fail, round, now } = require('../util');
const art = require('../art');
const { route, ADMIN } = require('../router');

const KINDS = ['card', 'invoice'];
const kindOf = (v) => (KINDS.includes(v) ? v : fail(400, 'اختر النظام: كروت الشحن أو الفواتير'));
const markupFor = (kind) => (kind === 'card' ? getSettings().artMarkupCard : getSettings().artMarkupInvoice);
const withMarkup = (cost, kind) => round(cost * (1 + markupFor(kind) / 100));
// Packages of one system that came from art-topup (cards: ic/pb/pc refs, invoices: inv refs).
const REF = { card: "(art_card_id LIKE 'ic:%' OR art_card_id LIKE 'pb:%' OR art_card_id LIKE 'pc:%')", invoice: "art_card_id LIKE 'inv:%'" };
// Packages of either art-topup system. Other suppliers (QuickLine's ql:/qln:) share these columns and the same
// 'card'/'invoice' kinds, so every query below filters on the refs rather than on kind alone.
const ART_REF = `(${REF.card} OR ${REF.invoice})`;

// Our company for an art-topup page title, invoice company or (in "شركات مشتركة") package name.
const COMPANIES = [
  ['سلكوم', /سي?لكوم|cel+e?com/i], ['جولان', /جولان|golan/i], ['بيلفون', /بيلفون|pelephone/i], ['هوت موبايل', /هوت|hot/i],
  ['019', /019/], ['رامي ليفي', /رامي|rami/i], ['بارتنر', /بارتنر|partner/i],
  ['جوال', /جوال|jawwal/i], ['أوريدو', /[أا]وريدو|ooredoo|oredoo/i],
  ['WE', /we\s*4\s*g|^\s*وي\s|\bwe\b/i], ['كلام', /كلام|kalam/i], ['X phone', /x\s*-?\s*phone|اكس فون/i],
];
function companyFor(title) {
  const [name, re] = COMPANIES.find(([, r]) => r.test(title)) || [title.replace(/^\s*شحن\s*/, '').trim(), null];
  const all = q('SELECT id, name FROM companies').all();
  const found = all.find((c) => c.name === name) || (re && all.find((c) => re.test(c.name)));
  if (found) return found.id;
  const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM companies').get().s;
  return Number(q("INSERT INTO companies (name, sort, activation) VALUES (?, ?, 'auto')").run(name, sort).lastInsertRowid);
}
const gbOf = (s) => { const m = /(\d+(?:\.\d+)?)\s*(?:جيجا|GB|G\b)/i.exec(s); return m ? Number(m[1]) : null; };

// A package awaits the manager when art-topup's price differs from its approved cost and was not ignored.
const PENDING = 'art_price IS NOT NULL AND ROUND(art_price, 2) != ROUND(cost, 2) AND (art_ack IS NULL OR ROUND(art_ack, 2) != ROUND(art_price, 2))';
const pendingCount = (kind) => q(`SELECT COUNT(*) AS n FROM packages WHERE ${REF[kind]} AND ${PENDING}`).get().n;

const wrap = async (fn) => {
  if (!getSettings().artConfigured) fail(400, 'أدخل اسم مستخدم art-topup وكلمة المرور أولاً');
  try { return await fn(artCredentials()); } catch (e) { if (e instanceof art.ArtError) fail(502, e.message); throw e; }
};

route('POST', '/api/art/check', ADMIN, () => wrap(async (creds) => ({ ok: true, balance: await art.balance(creds) })));

// One system at a time. New packages: cost = art-topup's price, agents' price = cost + this system's percentage,
// visible to agents. Existing packages are never changed (price, cost, name, visibility): only art-topup's current
// price is recorded, and a difference goes to the approval list. Packages gone from art-topup are switched off.
route('POST', '/api/art/sync', ADMIN, ({ body }) => { const kind = kindOf(body.kind); return wrap((creds) => syncKind(creds, kind)); });

async function syncKind(creds, kind) {
  const items = kind === 'card' ? await art.cards(creds) : await art.invoices(creds);
  if (!items.length) fail(502, kind === 'card' ? 'art-topup: لم أجد كروتاً' : 'art-topup: لم أجد فواتير');
  return tx(() => {
    let added = 0;
    let updated = 0;
    const companyIds = new Set();
    // Companies that already had art-topup cards: their automation is the manager's choice from now on.
    const known = new Set(q(`SELECT DISTINCT company_id FROM packages WHERE ${REF.card}`).all().map((r) => r.company_id));
    for (const c of items) {
      const companyId = companyFor(c.company);
      companyIds.add(companyId);
      const p = q('SELECT id FROM packages WHERE art_card_id = ?').get(c.ref);
      if (p) {
        q('UPDATE packages SET art_price = ? WHERE id = ?').run(c.agentPrice, p.id);
        updated++;
      } else {
        const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM packages WHERE company_id = ?').get(companyId).s;
        q(`INSERT INTO packages (company_id, name, cost, price, active, sort, data_gb, description, art_card_id, kind, days, art_price)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
          .run(companyId, c.name, c.agentPrice, withMarkup(c.agentPrice, kind), sort, gbOf(c.name), c.description, c.ref, kind, c.days ?? null, c.agentPrice);
        added++;
      }
    }
    // Bundles hidden for lack of balance are not "gone": only switch off when every page was fully read.
    const refs = items.map((c) => c.ref);
    const off = items.hidden ? 0
      : q(`UPDATE packages SET active = 0 WHERE ${REF[kind]} AND active = 1 AND art_card_id NOT IN (${refs.map(() => '?').join(',')})`).run(...refs).changes;
    // Card recharges can be carried out automatically; invoices stay requests for the manager.
    // Only a company's first cards switch it to auto; a manager's "manual" afterwards stays.
    if (kind === 'card') for (const id of companyIds) if (!known.has(id)) q("UPDATE companies SET activation = 'auto' WHERE id = ? AND activation = 'manual'").run(id);
    setSetting(`art_synced_${kind}`, now());
    return { kind, total: items.length, hidden: items.hidden || 0, added, updated, switchedOff: off, pending: pendingCount(kind), markup: markupFor(kind) };
  });
}

// Price changes from art-topup awaiting the manager, with the price the percentage would give.
route('GET', '/api/art/pending', ADMIN, ({ query }) => {
  const kind = kindOf(query.kind);
  return q(`SELECT p.id, p.name, p.cost, p.price, p.art_price, p.edited, p.active, c.name AS company_name
            FROM packages p JOIN companies c ON c.id = p.company_id WHERE ${REF[kind]} AND ${PENDING} ORDER BY c.sort, p.sort, p.id`).all()
    .map((p) => ({ id: p.id, name: p.name, companyName: p.company_name, cost: round(p.cost), artPrice: round(p.art_price), price: round(p.price),
      suggested: withMarkup(p.art_price, kind), edited: !!p.edited, active: !!p.active }));
});

// mode all: cost = art-topup's price and agents' price = it + the percentage; cost: only the cost; ignore: keep both
// (asked again only if art-topup's price changes again).
route('POST', '/api/art/approve', ADMIN, ({ body }) => tx(() => {
  const mode = ['all', 'cost', 'ignore'].includes(body.mode) ? body.mode : fail(400, 'اختر طريقة الاعتماد');
  const ids = [].concat(body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) fail(400, 'اختر الرزم');
  let done = 0;
  for (const id of ids) {
    const p = q(`SELECT * FROM packages WHERE id = ? AND ${ART_REF} AND ${PENDING}`).get(id);
    if (!p) continue;
    if (mode === 'ignore') q('UPDATE packages SET art_ack = art_price WHERE id = ?').run(id);
    else if (mode === 'cost') q('UPDATE packages SET cost = art_price, art_ack = NULL WHERE id = ?').run(id);
    else q('UPDATE packages SET cost = art_price, price = ?, art_ack = NULL WHERE id = ?').run(withMarkup(p.art_price, p.kind), id);
    done++;
  }
  return { done };
}));

// Applies this system's percentage to the current prices: agents' price = cost + percentage.
// scope unedited skips packages whose price the manager set by hand; all includes them (they follow the percentage again).
route('POST', '/api/art/reprice', ADMIN, ({ body }) => tx(() => {
  const kind = kindOf(body.kind);
  const all = body.scope === 'all';
  // A package without a cost cannot take a percentage (its price would become 0 and hide it from agents).
  const rows = q(`SELECT id, cost FROM packages WHERE ${REF[kind]} AND cost > 0 ${all ? '' : 'AND edited = 0'}`).all();
  for (const r of rows) q(`UPDATE packages SET price = ?${all ? ', edited = 0' : ''} WHERE id = ?`).run(withMarkup(r.cost, kind), r.id);
  return { changed: rows.length, markup: markupFor(kind) };
}));

// How many packages a percentage change would touch, for the manager's choice.
route('GET', '/api/art/reprice', ADMIN, ({ query }) => {
  const kind = kindOf(query.kind);
  const r = q(`SELECT COUNT(*) AS total, SUM(edited) AS edited FROM packages WHERE ${REF[kind]} AND cost > 0`).get();
  return { total: r.total, edited: r.edited || 0, pending: pendingCount(kind), markup: markupFor(kind) };
});

module.exports = { syncKind };
