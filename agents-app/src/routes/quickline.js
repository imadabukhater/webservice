'use strict';
// QuickLine's new lines ('invoice', qln: refs), sold in the shop as eSIMs on its free numbers and activated there
// automatically: their sync (the cost follows QuickLine's price, no approval).
const { q, tx, getSettings, setSetting, qlCredentials } = require('../db');
const { fail, round, now } = require('../util');
const ql = require('../quickline');
const { route, ADMIN } = require('../router');

// Only new lines (sold as eSIMs in the shop): extensions and top-up cards are not sold.
const KINDS = ['invoice'];
const GONE_DAYS = 7; // a package QuickLine no longer lists is removed after this long (when nothing refers to it)
const kindOf = (v) => (v === undefined || v === '' || KINDS.includes(v) ? 'invoice' : fail(400, 'المتجر يبيع شرائح eSIM فقط: لا رزم تمديد أو كروت'));
// Packages of one system that came from QuickLine (extensions: ql: refs, new lines: qln: refs).
const REF = { invoice: "art_card_id LIKE 'qln:%'" };

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
    const known = new Set(q(`SELECT DISTINCT company_id FROM packages WHERE ${REF.invoice}`).all().map((r) => r.company_id));
    // Each package's SIM rule, so a sale can be checked at once.
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
          .run(companyId, c.name, c.agentPrice, c.agentPrice, sort, c.dataGb, c.minutes, c.sms,
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
      const used = q(`SELECT 1 FROM lines WHERE package_id = ?1 UNION ALL SELECT 1 FROM shop_orders WHERE package_id = ?1 AND status IN ('awaiting_payment','verifying','review','paid')
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
    // No approval: the cost is the supplier's current price, and the shop prices follow it.
    q(`UPDATE packages SET cost = art_price, art_ack = NULL WHERE ${REF.invoice} AND art_price IS NOT NULL AND cost != art_price`).run();
    require('../domain').refreshShopPrices();
    return { kind, total: items.length, added, updated, restored, switchedOff: off, removed };
  });
}

// ---------- what the shop needs to sell a new eSIM ----------
function simRules() {
  try { return JSON.parse(q("SELECT value FROM settings WHERE key = 'ql_sim_rules'").get()?.value || '{}'); } catch { return {}; }
}
const simRuleFor = (qlPackageId) => simRules()[qlPackageId] || null;

// Numbers offered, remembered for a while so a sale can be checked to use one of them (in this process only).
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

// Neutral messages: the customer is never told who activates the line.
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
function freeNumbersFor(packageId, esim = false, exclude = []) {
  const art = q('SELECT art_card_id FROM packages WHERE id = ? AND active = 1').get(Number(packageId))?.art_card_id || '';
  // A Layan new line picks one of the dealer's suspended numbers (or Layan's free eSIM numbers when esim).
  const lyRef = require('../layan').parseRef(art);
  if (lyRef?.system === 'lyn') return require('./layan').freeNumbers(lyRef, esim);
  // An Aylol eSIM picks one of the site's ready eSIM numbers; a bill line one of the numbers it offers for the package.
  if (/^ay:esim:/.test(art)) return require('./aylol').freeNumbers(art);
  if (/^ay:bill:/.test(art)) return require('./aylol').billFreeNumbers(art);
  const ref = newLinePackage(packageId);
  return agentWrap(async (creds) => {
    const list = await ql.freeNumbers(creds, { packageId: ref.packageId, exclude, esim });
    remember(ref.packageId, esim, list);
    return list.map((n) => ({ id: n.id, phone: n.phone }));
  });
}
// remember: the customer shop keeps the number a customer picked with the order (payment can take longer than this
// list lasts), and puts it back here before selling it.
module.exports = { syncKind, REF, simRuleFor, servedNumber, remember, companyFor, freeNumbersFor, COMPANIES };
