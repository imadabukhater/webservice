'use strict';
// QuickLine for its two systems: extending a line a dealer already has ('card', carried out automatically) and
// activating a new line ('invoice', a request for the manager). Each has its own sync, its own profit percentage
// and its own list of price changes awaiting the manager — the same shape as art-topup.
const { q, tx, getSettings, setSetting, qlCredentials } = require('../db');
const { fail, round, now } = require('../util');
const ql = require('../quickline');
const { route, ADMIN, ANY } = require('../router');

const KINDS = ['card', 'invoice'];
const GONE_DAYS = 7; // a package QuickLine no longer lists is removed after this long (when nothing refers to it)
const kindOf = (v) => (KINDS.includes(v) ? v : fail(400, 'اختر النظام: تمديد الخطوط أو خطوط جديدة'));
const markupFor = (kind) => (kind === 'card' ? getSettings().qlMarkupCard : getSettings().qlMarkupInvoice);
const withMarkup = (cost, kind) => round(cost * (1 + markupFor(kind) / 100));
// Packages of one system that came from QuickLine (extensions: ql: refs, new lines: qln: refs).
const REF = { card: "art_card_id LIKE 'ql:%'", invoice: "art_card_id LIKE 'qln:%'" };

// Our company for a QuickLine company name.
const COMPANIES = [
  ['سلكوم', /سي?لكوم|cel+e?com/i], ['جولان', /جولان|golan|gloan/i], ['بيلفون', /بيلفون|pelephone/i], ['هوت موبايل', /هوت|hot/i],
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
  const items = await ql.catalog(creds, kind);
  if (!items.length) fail(502, 'QuickLine: لم أجد رزماً');
  return tx(() => {
    let added = 0;
    let updated = 0;
    let restored = 0;
    const companyIds = new Set();
    const refs = [];
    // Companies that already had QuickLine packages: their automation is the manager's choice from now on.
    const known = new Set(q(`SELECT DISTINCT company_id FROM packages WHERE ${REF.card} OR ${REF.invoice}`).all().map((r) => r.company_id));
    // Each package's SIM rule, so a sale can be checked at once, before the agent pays.
    const rules = simRules();
    for (const c of items) rules[c.packageId] = { company: c.company, postalCode: c.postalCode, simLength: c.simLength, qlCompanyId: c.companyId };
    setSetting('ql_sim_rules', JSON.stringify(rules));
    for (const c of items) {
      // The same QuickLine package is sold two ways: as an extension (ql:) and as a new line (qln:).
      const { ref } = c;
      refs.push(ref);
      const companyId = companyFor(c.company);
      companyIds.add(companyId);
      const p = q('SELECT id, gone_at FROM packages WHERE art_card_id = ?').get(ref);
      if (p) {
        // Listed again after a sync hid it: back for the agents. A package the manager hid stays hidden.
        if (p.gone_at) restored++;
        q('UPDATE packages SET art_price = ?, active = CASE WHEN gone_at IS NOT NULL THEN 1 ELSE active END, gone_at = NULL WHERE id = ?')
          .run(c.agentPrice, p.id);
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
    // Packages QuickLine no longer lists are hidden, marked as the sync's doing (gone_at), so a brief gap in what
    // QuickLine returns heals at the next sync. Only after a week gone, and when nothing here refers to them (a line —
    // which keeps its QuickLine identity through its package —, an offer, an open request), are they removed, so the
    // list does not fill up with old copies and a brief gap never loses the manager's prices.
    let off = 0;
    let removed = 0;
    const gone = q(`SELECT id, active, gone_at FROM packages WHERE ${REF[kind]} AND art_card_id NOT IN (${refs.map(() => '?').join(',')})`).all(...refs);
    for (const g of gone) {
      if (g.active) {
        q('UPDATE packages SET active = 0, gone_at = ? WHERE id = ?').run(now(), g.id);
        off++;
        continue;
      }
      if (!g.gone_at || now() - g.gone_at < GONE_DAYS * 864e5) continue;
      const used = q(`SELECT 1 FROM lines WHERE package_id = ?1 UNION ALL SELECT 1 FROM offers WHERE package_id = ?1
                      UNION ALL SELECT 1 FROM tasks WHERE status = 'open' AND json_valid(payload) AND json_extract(payload, '$.packageId') = ?1
                      LIMIT 1`).get(g.id);
      if (!used) {
        q('DELETE FROM packages WHERE id = ?').run(g.id);
        removed++;
      }
    }
    // Extensions and new lines are carried out automatically for "auto" companies. A company getting QuickLine
    // packages for the first time is switched to auto; after that a manager's "manual" stays, so automation can be
    // stopped for a company.
    for (const id of companyIds) if (!known.has(id)) q("UPDATE companies SET activation = 'auto' WHERE id = ? AND activation = 'manual'").run(id);
    setSetting(`ql_synced_${kind}`, now());
    return { kind, total: items.length, added, updated, restored, switchedOff: off, removed, pending: pendingCount(kind), markup: markupFor(kind) };
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

// ---------- what an agent needs to sell a new line ----------
function simRules() {
  try { return JSON.parse(q("SELECT value FROM settings WHERE key = 'ql_sim_rules'").get()?.value || '{}'); } catch { return {}; }
}
const simRuleFor = (qlPackageId) => simRules()[qlPackageId] || null;

// Numbers shown to agents, remembered for a while so a sale can be checked to use one of them (in this process only:
// after a restart the agent simply loads the numbers again).
const SERVED_MS = 2 * 60 * 60_000;
const served = new Map();
function remember(qlPackageId, esim, list) {
  const t = now();
  for (const [k, v] of served) if (t - v.at > SERVED_MS) served.delete(k);
  for (const n of list) served.set(`${qlPackageId}:${esim ? 'e' : 's'}:${n.id}`, { phone: n.phone, sim: n.sim, qr: n.qr, at: t });
}
function servedNumber(qlPackageId, esim, numberId) {
  const v = served.get(`${qlPackageId}:${esim ? 'e' : 's'}:${numberId}`);
  return v && now() - v.at < SERVED_MS ? v : null;
}

// What agents call: neutral paths and messages, so neither names who activates their lines (see privacy.js).
const agentWrap = async (fn) => {
  if (!getSettings().qlConfigured) fail(503, 'الأرقام غير متاحة الآن. تواصل مع المدير.');
  try {
    return await fn(qlCredentials());
  } catch (e) {
    if (e instanceof ql.QuickLineError) {
      console.error('free numbers', e.message);
      fail(502, 'تعذّر جلب الأرقام الآن. حاول بعد قليل.');
    }
    throw e;
  }
};
function newLinePackage(id) {
  const p = q('SELECT id, art_card_id, active FROM packages WHERE id = ?').get(Number(id));
  const ref = p && ql.parseRef(p.art_card_id);
  if (!p || !p.active || !ref || ref.system !== 'qln') fail(404, 'هذه الرزمة لا تختار رقمها من قائمة');
  return ref;
}

// Free numbers of a new-line package that picks its number from a list (esim=1 for eSIM numbers). exclude: ids shown.
route('GET', '/api/numbers/free', ANY, ({ query }) => {
  // A Layan new line picks one of the dealer's suspended numbers instead.
  const lyRef = require('../layan').parseRef(q('SELECT art_card_id FROM packages WHERE id = ? AND active = 1').get(Number(query.packageId))?.art_card_id);
  if (lyRef?.system === 'lyn') return require('./layan').freeNumbers(lyRef);
  const ref = newLinePackage(query.packageId);
  const esim = query.esim === '1';
  const exclude = String(query.exclude || '').split(',').map(Number).filter(Boolean).slice(0, 500);
  return agentWrap(async (creds) => {
    const list = await ql.freeNumbers(creds, { packageId: ref.packageId, exclude, esim });
    remember(ref.packageId, esim, list);
    return list.map((n) => ({ id: n.id, phone: n.phone }));
  });
});

// Companies a number can be ported from.
route('GET', '/api/numbers/port-companies', ANY, () => agentWrap(async (creds) => (await ql.companies(creds)).map((c) => ({ id: c.id, name: c.name }))));

// The dealer's lines at QuickLine, so the manager can see which numbers an extension can be sold for.
route('GET', '/api/quickline/lines', ADMIN, () => wrap(async (creds) => {
  const subs = await ql.subscriptions(creds);
  return { total: subs.length, extendable: subs.filter((s) => s.canExtend).length, lines: subs.slice(0, 500) };
}));

module.exports = { syncKind, REF, simRuleFor, servedNumber, companyFor };
