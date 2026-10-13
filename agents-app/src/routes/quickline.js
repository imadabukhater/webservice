'use strict';
// QuickLine for its two systems: extending a line a dealer already has ('card', carried out automatically) and
// activating a new line ('invoice', a request for the manager). Each has its own sync, its own profit percentage
// and its own list of price changes awaiting the manager — the same shape as art-topup.
const { q, tx, getSettings, setSetting, qlCredentials } = require('../db');
const { fail, round, now } = require('../util');
const ql = require('../quickline');
const { route, ADMIN } = require('../router');

const KINDS = ['card', 'invoice'];
const kindOf = (v) => (KINDS.includes(v) ? v : fail(400, 'اختر النظام: تمديد الخطوط أو خطوط جديدة'));
const markupFor = (kind) => (kind === 'card' ? getSettings().qlMarkupCard : getSettings().qlMarkupInvoice);
const withMarkup = (cost, kind) => round(cost * (1 + markupFor(kind) / 100));
// Packages of one system that came from QuickLine (extensions: ql: refs, new lines: qln: refs).
const REF = { card: "art_card_id LIKE 'ql:%'", invoice: "art_card_id LIKE 'qln:%'" };

// Our company for a QuickLine company name.
const COMPANIES = [
  ['سلكوم', /سي?لكوم|cel+e?com/i], ['جولان', /جولان|golan/i], ['بيلفون', /بيلفون|pelephone/i], ['هوت موبايل', /هوت|hot/i],
  ['019', /019/], ['رامي ليفي', /رامي|rami/i], ['بارتنر', /بارتنر|partner/i],
  ['جوال', /جوال|jawwal/i], ['أوريدو', /[أا]وريدو|ooredoo|oredoo/i],
  ['WE', /we\s*4\s*g|^\s*وي\s|\bwe\b/i], ['كلام', /كلام|kalam/i], ['X phone', /x\s*-?\s*phone|اكس فون/i],
  ['نتفليكس', /netflix|نتفليكس/i],
];
function companyFor(title) {
  const [name, re] = COMPANIES.find(([, r]) => r.test(title)) || [String(title).trim(), null];
  const all = q('SELECT id, name FROM companies').all();
  const found = all.find((c) => c.name === name) || (re && all.find((c) => re.test(c.name)));
  if (found) return found.id;
  const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM companies').get().s;
  return Number(q("INSERT INTO companies (name, sort, activation) VALUES (?, ?, 'auto')").run(name, sort).lastInsertRowid);
}

// A package awaits the manager when QuickLine's price differs from its approved cost and was not ignored.
const PENDING = 'art_price IS NOT NULL AND ROUND(art_price, 2) != ROUND(cost, 2) AND (art_ack IS NULL OR ROUND(art_ack, 2) != ROUND(art_price, 2))';
const pendingCount = (kind) => q(`SELECT COUNT(*) AS n FROM packages WHERE ${REF[kind]} AND ${PENDING}`).get().n;

const wrap = async (fn) => {
  if (!getSettings().qlConfigured) fail(400, 'أدخل بريد QuickLine وكلمة المرور أولاً');
  try { return await fn(qlCredentials()); } catch (e) { if (e instanceof ql.QuickLineError) fail(502, e.message); throw e; }
};

route('POST', '/api/quickline/check', ADMIN, () => wrap(async (creds) => {
  const me = await ql.login(creds);
  return { ok: true, name: String(me.name || '').trim(), type: me.type, ...(await ql.homeData(creds)) };
}));

// One system at a time. New packages: cost = QuickLine's price, agents' price = cost + this system's percentage,
// visible to agents. Existing packages are never changed (price, cost, name, visibility): only QuickLine's current
// price is recorded, and a difference goes to the approval list. Packages gone from QuickLine are switched off.
route('POST', '/api/quickline/sync', ADMIN, ({ body }) => { const kind = kindOf(body.kind); return wrap((creds) => syncKind(creds, kind)); });

async function syncKind(creds, kind) {
  const items = await ql.catalog(creds);
  if (!items.length) fail(502, 'QuickLine: لم أجد باقات');
  return tx(() => {
    let added = 0;
    let updated = 0;
    const companyIds = new Set();
    const refs = [];
    for (const c of items) {
      // The same QuickLine package is sold two ways: as an extension (ql:) and as a new line (qln:).
      const ref = kind === 'card' ? c.ref : c.newRef;
      refs.push(ref);
      const companyId = companyFor(c.company);
      companyIds.add(companyId);
      const p = q('SELECT id FROM packages WHERE art_card_id = ?').get(ref);
      if (p) {
        q('UPDATE packages SET art_price = ? WHERE id = ?').run(c.agentPrice, p.id);
        updated++;
      } else {
        const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM packages WHERE company_id = ?').get(companyId).s;
        q(`INSERT INTO packages (company_id, name, cost, price, active, sort, data_gb, minutes, sms, description, art_card_id, kind, days, art_price)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(companyId, c.name, c.agentPrice, withMarkup(c.agentPrice, kind), sort, c.dataGb, c.minutes, c.sms,
            c.description, ref, kind, c.days, c.agentPrice);
        added++;
      }
    }
    const off = q(`UPDATE packages SET active = 0 WHERE ${REF[kind]} AND active = 1 AND art_card_id NOT IN (${refs.map(() => '?').join(',')})`)
      .run(...refs).changes;
    // Extensions are carried out automatically; new lines stay requests for the manager.
    if (kind === 'card') for (const id of companyIds) q("UPDATE companies SET activation = 'auto' WHERE id = ? AND activation = 'manual'").run(id);
    setSetting(`ql_synced_${kind}`, now());
    return { kind, total: items.length, added, updated, switchedOff: off, pending: pendingCount(kind), markup: markupFor(kind) };
  });
}

// Price changes from QuickLine awaiting the manager, with the price the percentage would give.
route('GET', '/api/quickline/pending', ADMIN, ({ query }) => {
  const kind = kindOf(query.kind);
  return q(`SELECT p.id, p.name, p.cost, p.price, p.art_price, p.edited, p.active, c.name AS company_name
            FROM packages p JOIN companies c ON c.id = p.company_id WHERE ${REF[kind]} AND ${PENDING} ORDER BY c.sort, p.sort, p.id`).all()
    .map((p) => ({ id: p.id, name: p.name, companyName: p.company_name, cost: round(p.cost), artPrice: round(p.art_price), price: round(p.price),
      suggested: withMarkup(p.art_price, kind), edited: !!p.edited, active: !!p.active }));
});

// mode all: cost = QuickLine's price and agents' price = it + the percentage; cost: only the cost; ignore: keep both
// (asked again only if QuickLine's price changes again).
route('POST', '/api/quickline/approve', ADMIN, ({ body }) => tx(() => {
  const mode = ['all', 'cost', 'ignore'].includes(body.mode) ? body.mode : fail(400, 'اختر طريقة الاعتماد');
  const ids = [].concat(body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) fail(400, 'اختر الرزم');
  let done = 0;
  for (const id of ids) {
    const p = q(`SELECT * FROM packages WHERE id = ? AND (${REF.card} OR ${REF.invoice}) AND ${PENDING}`).get(id);
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
route('POST', '/api/quickline/reprice', ADMIN, ({ body }) => tx(() => {
  const kind = kindOf(body.kind);
  const all = body.scope === 'all';
  // A package without a cost cannot take a percentage (its price would become 0 and hide it from agents).
  const rows = q(`SELECT id, cost FROM packages WHERE ${REF[kind]} AND cost > 0 ${all ? '' : 'AND edited = 0'}`).all();
  for (const r of rows) q(`UPDATE packages SET price = ?${all ? ', edited = 0' : ''} WHERE id = ?`).run(withMarkup(r.cost, kind), r.id);
  return { changed: rows.length, markup: markupFor(kind) };
}));

// How many packages a percentage change would touch, for the manager's choice.
route('GET', '/api/quickline/reprice', ADMIN, ({ query }) => {
  const kind = kindOf(query.kind);
  const r = q(`SELECT COUNT(*) AS total, SUM(edited) AS edited FROM packages WHERE ${REF[kind]} AND cost > 0`).get();
  return { total: r.total, edited: r.edited || 0, pending: pendingCount(kind), markup: markupFor(kind) };
});

// The dealer's lines at QuickLine, so the manager can see which numbers an extension can be sold for.
route('GET', '/api/quickline/lines', ADMIN, () => wrap(async (creds) => {
  const subs = await ql.subscriptions(creds);
  return { total: subs.length, extendable: subs.filter((s) => s.canExtend).length, lines: subs.slice(0, 500) };
}));

module.exports = { syncKind, REF };
