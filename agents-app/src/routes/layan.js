'use strict';
// Layan for its two systems, the same shape as QuickLine: extending a dealer's active number ('card') and activating
// one of its suspended numbers as a new line ('invoice'), both carried out automatically. Each has its own sync,
// profit percentage and list of price changes awaiting the manager.
const { q, tx, getSettings, setSetting, lyCredentials } = require('../db');
const { fail, round, now } = require('../util');
const ly = require('../layan');
const { route, ADMIN } = require('../router');
const { companyFor } = require('./quickline');

const KINDS = ['card', 'invoice'];
const GONE_DAYS = 7;
const kindOf = (v) => (KINDS.includes(v) ? v : fail(400, 'اختر النظام: تمديد الخطوط أو خطوط جديدة'));
const markupFor = (kind) => (kind === 'card' ? getSettings().lyMarkupCard : getSettings().lyMarkupInvoice);
const withMarkup = (cost, kind) => round(cost * (1 + markupFor(kind) / 100));
const REF = { card: "art_card_id LIKE 'ly:%'", invoice: "art_card_id LIKE 'lyn:%'" };
const PENDING = 'art_price IS NOT NULL AND ROUND(art_price, 2) != ROUND(cost, 2) AND (art_ack IS NULL OR ROUND(art_ack, 2) != ROUND(art_price, 2))';
const pendingCount = (kind) => q(`SELECT COUNT(*) AS n FROM packages WHERE ${REF[kind]} AND ${PENDING}`).get().n;

const wrap = async (fn) => {
  if (!getSettings().lyConfigured) fail(400, 'أدخل اسم مستخدم ليان وكلمة المرور أولاً');
  try { return await fn(lyCredentials()); } catch (e) { if (e instanceof ly.LayanError) fail(502, e.message); throw e; }
};

// Layan names its packages in Hebrew; agents get "<company> <data> جيجا" (and 5G, eSIM, an offer's period).
function arabicName(c, companyName) {
  return [companyName, c.dataGb ? `${c.dataGb} جيجا` : c.packageName, c.is5G ? '5G' : '', c.esim ? 'eSIM' : '', c.saleId ? `— عرض ${c.days} يوماً` : '']
    .filter(Boolean).join(' ');
}

route('POST', '/api/layan/check', ADMIN, () => wrap(async (creds) => {
  const [bal, nums] = await Promise.all([ly.balance(creds), ly.numbers(creds)]);
  return { ok: true, balance: bal, numbers: nums.length, active: nums.filter((n) => n.active).length, suspended: nums.filter((n) => n.suspended).length };
}));

route('POST', '/api/layan/sync', ADMIN, ({ body }) => { const kind = kindOf(body.kind); return wrap((creds) => syncKind(creds, kind)); });

async function syncKind(creds, kind) {
  const items = await ly.catalog(creds, kind);
  if (!items.length) fail(502, 'ليان: لم أجد رزماً');
  return tx(() => {
    let added = 0;
    let updated = 0;
    let restored = 0;
    const companyIds = new Set();
    const refs = [];
    const known = new Set(q(`SELECT DISTINCT company_id FROM packages WHERE ${REF.card} OR ${REF.invoice}`).all().map((r) => r.company_id));
    // Which Layan package a number belongs to is known by its name and company: kept for picking numbers to sell.
    const names = JSON.parse(q("SELECT value FROM settings WHERE key = 'ly_packages'").get()?.value || '{}');
    for (const c of items) {
      names[c.packageId] = { name: c.packageName, company: c.company };
      refs.push(c.ref);
      const companyId = companyFor(c.company);
      companyIds.add(companyId);
      const p = q('SELECT id, gone_at FROM packages WHERE art_card_id = ?').get(c.ref);
      if (p) {
        if (p.gone_at) restored++;
        q('UPDATE packages SET art_price = ?, active = CASE WHEN gone_at IS NOT NULL THEN 1 ELSE active END, gone_at = NULL WHERE id = ?').run(c.agentPrice, p.id);
        updated++;
      } else {
        const companyName = q('SELECT name FROM companies WHERE id = ?').get(companyId).name;
        const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM packages WHERE company_id = ?').get(companyId).s;
        q(`INSERT INTO packages (company_id, name, cost, price, active, sort, data_gb, minutes, sms, description, art_card_id, kind, days, art_price)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(companyId, arabicName(c, companyName), c.agentPrice, withMarkup(c.agentPrice, kind), sort, c.dataGb, c.minutes, c.sms,
            c.saleId ? `عرض لمدة ${c.days} يوماً` : '', c.ref, kind, c.days, c.agentPrice);
        added++;
      }
    }
    setSetting('ly_packages', JSON.stringify(names));
    // Gone from Layan: hidden as the sync's doing (back by itself when listed again); removed after a week if unused.
    let off = 0;
    let removed = 0;
    const gone = q(`SELECT id, active, gone_at FROM packages WHERE ${REF[kind]} AND art_card_id NOT IN (${refs.map(() => '?').join(',')})`).all(...refs);
    for (const g of gone) {
      if (g.active) { q('UPDATE packages SET active = 0, gone_at = ? WHERE id = ?').run(now(), g.id); off++; continue; }
      if (!g.gone_at || now() - g.gone_at < GONE_DAYS * 864e5) continue;
      const used = q(`SELECT 1 FROM lines WHERE package_id = ?1 UNION ALL SELECT 1 FROM offers WHERE package_id = ?1
                      UNION ALL SELECT 1 FROM tasks WHERE status = 'open' AND json_valid(payload) AND json_extract(payload, '$.packageId') = ?1 LIMIT 1`).get(g.id);
      if (!used) { q('DELETE FROM packages WHERE id = ?').run(g.id); removed++; }
    }
    for (const id of companyIds) if (!known.has(id)) q("UPDATE companies SET activation = 'auto' WHERE id = ? AND activation = 'manual'").run(id);
    setSetting(`ly_synced_${kind}`, now());
    return { kind, total: items.length, added, updated, restored, switchedOff: off, removed, pending: pendingCount(kind), markup: markupFor(kind) };
  });
}

route('GET', '/api/layan/pending', ADMIN, ({ query }) => {
  const kind = kindOf(query.kind);
  return q(`SELECT p.id, p.name, p.cost, p.price, p.art_price, p.edited, p.active, c.name AS company_name
            FROM packages p JOIN companies c ON c.id = p.company_id WHERE ${REF[kind]} AND ${PENDING} ORDER BY c.sort, p.sort, p.id`).all()
    .map((p) => ({ id: p.id, name: p.name, companyName: p.company_name, cost: round(p.cost), artPrice: round(p.art_price), price: round(p.price),
      suggested: withMarkup(p.art_price, kind), edited: !!p.edited, active: !!p.active }));
});

route('POST', '/api/layan/approve', ADMIN, ({ body }) => tx(() => {
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

route('POST', '/api/layan/reprice', ADMIN, ({ body }) => tx(() => {
  const kind = kindOf(body.kind);
  const all = body.scope === 'all';
  const rows = q(`SELECT id, cost FROM packages WHERE ${REF[kind]} AND cost > 0 ${all ? '' : 'AND edited = 0'}`).all();
  for (const r of rows) q(`UPDATE packages SET price = ?${all ? ', edited = 0' : ''} WHERE id = ?`).run(withMarkup(r.cost, kind), r.id);
  return { changed: rows.length, markup: markupFor(kind) };
}));

route('GET', '/api/layan/reprice', ADMIN, ({ query }) => {
  const kind = kindOf(query.kind);
  const r = q(`SELECT COUNT(*) AS total, SUM(edited) AS edited FROM packages WHERE ${REF[kind]} AND cost > 0`).get();
  return { total: r.total, edited: r.edited || 0, pending: pendingCount(kind), markup: markupFor(kind) };
});

// ---------- numbers to sell as new lines ----------
// The dealer's suspended numbers on a package; shown to agents, remembered so a sale can be checked to use one.
const SERVED_MS = 2 * 60 * 60_000;
const served = new Map();
const packageInfo = (packageId) => JSON.parse(q("SELECT value FROM settings WHERE key = 'ly_packages'").get()?.value || '{}')[packageId] || null;

async function freeNumbers(ref) {
  if (!getSettings().lyConfigured) fail(503, 'الأرقام غير متاحة الآن. تواصل مع المدير.');
  const info = packageInfo(ref.packageId);
  if (!info) fail(503, 'الأرقام غير متاحة الآن. تواصل مع المدير.');
  let list;
  try {
    list = (await ly.numbers(lyCredentials())).filter((n) => n.suspended && n.packageName === info.name && n.company === info.company);
  } catch (e) {
    if (e instanceof ly.LayanError) { console.error('layan numbers', e.message); fail(502, 'تعذّر جلب الأرقام الآن. حاول بعد قليل.'); }
    throw e;
  }
  const t = now();
  for (const [k, v] of served) if (t - v.at > SERVED_MS) served.delete(k);
  for (const n of list) served.set(`${ref.packageId}:${n.number}`, { phone: n.number, sim: n.sim, at: t });
  // The number is its own id here.
  return list.map((n) => ({ id: n.number, phone: n.number }));
}
function servedNumber(packageId, number) {
  const v = served.get(`${packageId}:${number}`);
  return v && now() - v.at < SERVED_MS ? v : null;
}

module.exports = { syncKind, REF, freeNumbers, servedNumber, packageInfo };
