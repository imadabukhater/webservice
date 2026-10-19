'use strict';
// telecom.co.il for its two systems, the same shape as Layan: extending a subscriber the dealer already has ('card',
// carried out automatically) and a new line ('invoice', a request the manager carries out there for now). Signing in
// e-mails a code to the account's Gmail; the server reads it from that mailbox over IMAP (src/mailcode.js).
// Each system has its own sync, profit percentage and list of price changes awaiting the manager.
const { q, tx, getSettings, setSetting, tcCredentials } = require('../db');
const { fail, round, now } = require('../util');
const mailcode = require('../mailcode');
const tc = require('../telecom');
const { route, ADMIN } = require('../router');
const { companyFor } = require('./quickline');

const KINDS = ['card', 'invoice'];
const GONE_DAYS = 7;
const kindOf = (v) => (KINDS.includes(v) ? v : fail(400, 'اختر النظام: تمديد الخطوط أو خطوط جديدة'));
const markupFor = (kind) => (kind === 'card' ? getSettings().tcMarkupCard : getSettings().tcMarkupInvoice);
const withMarkup = (cost, kind) => round(cost * (1 + markupFor(kind) / 100));
const REF = { card: "art_card_id LIKE 'tc:%'", invoice: "art_card_id LIKE 'tcn:%'" };
const PENDING = 'art_price IS NOT NULL AND ROUND(art_price, 2) != ROUND(cost, 2) AND (art_ack IS NULL OR ROUND(art_ack, 2) != ROUND(art_price, 2))';
const pendingCount = (kind) => q(`SELECT COUNT(*) AS n FROM packages WHERE ${REF[kind]} AND ${PENDING}`).get().n;

const wrap = async (fn) => {
  if (!getSettings().tcReady) fail(400, 'أدخل بيانات telecom والجيميل أولاً');
  try { return await fn(tcCredentials()); } catch (e) { if (e instanceof tc.TelecomError) fail(502, e.message); throw e; }
};

// The site's names are English ("Cellcom 20GB 3M"); agents get "<company> <data> جيجا" (and 5G, an offer's months).
// A name that says more than that ("… ROUTER", "+ 40 SHEKEL"), or another size than the site's data, keeps the
// site's own name beside it, so two different packages never read the same.
const PLAIN = /\b(cellcom|partner|pelephone|hot|mobile|golan|golant|t|wecom|we4g|rami|levi|aloha|5g|\d+\s*m|\d+\s*gb)\b|[-\s]/gi;
function arabicName(p, companyName) {
  const months = p.months > 1 ? `— عرض ${p.months} ${p.months > 10 ? 'شهراً' : 'أشهر'}` : '';
  const base = [companyName, p.dataGb ? `${p.dataGb} جيجا` : p.name, p.is5G ? '5G' : '', months].filter(Boolean).join(' ');
  const sizes = [...p.name.matchAll(/(\d+)\s*GB/gi)].map((m) => Number(m[1]));
  const more = p.name.replace(PLAIN, '') !== '' || (p.dataGb && sizes.length && !sizes.includes(p.dataGb));
  return more ? `${base} (${p.name})` : base;
}

route('POST', '/api/telecom/mail-check', ADMIN, async () => {
  if (!getSettings().tcMailConfigured) fail(400, 'أدخل بريد الجيميل وكلمة مرور التطبيق أولاً');
  try {
    await mailcode.check(tcCredentials().mail);
  } catch (e) {
    if (e instanceof mailcode.MailCodeError) fail(502, e.message);
    throw e;
  }
  return { ok: true };
});

// Signs in (reading the e-mailed code from Gmail) and reads the credit and the subscribers.
route('POST', '/api/telecom/check', ADMIN, () => wrap(async (creds) => ({ ok: true, ...(await tc.check(creds)) })));

route('POST', '/api/telecom/sync', ADMIN, ({ body }) => { const kind = kindOf(body.kind); return wrap((creds) => syncKind(creds, kind)); });

// New packages: cost = the site's price, agents' price = cost + this system's percentage. Existing packages keep
// their price, name and visibility: only the site's current price is recorded, and a difference awaits the manager.
async function syncKind(creds, kind) {
  const items = (await tc.catalog(creds, kind)).filter((p) => p.cost > 0);
  if (!items.length) fail(502, 'telecom: لم أجد رزماً');
  return tx(() => {
    let added = 0;
    let updated = 0;
    let restored = 0;
    const companyIds = new Set();
    const refs = [];
    const known = new Set(q(`SELECT DISTINCT company_id FROM packages WHERE ${REF.card} OR ${REF.invoice}`).all().map((r) => r.company_id));
    // Two of the site's packages may read the same in Arabic: the second keeps its own name too.
    const names = new Set();
    for (const p of items) {
      refs.push(p.ref);
      const companyId = companyFor(p.company);
      companyIds.add(companyId);
      const row = q('SELECT id, gone_at FROM packages WHERE art_card_id = ?').get(p.ref);
      if (row) {
        if (row.gone_at) restored++;
        q('UPDATE packages SET art_price = ?, active = CASE WHEN gone_at IS NOT NULL THEN 1 ELSE active END, gone_at = NULL WHERE id = ?').run(p.cost, row.id);
        updated++;
        continue;
      }
      const companyName = q('SELECT name FROM companies WHERE id = ?').get(companyId).name;
      let name = arabicName(p, companyName);
      if (names.has(`${companyId}|${name}`) || q('SELECT 1 FROM packages WHERE company_id = ? AND name = ? AND kind = ?').get(companyId, name, kind)) name = `${name} (${p.name})`;
      names.add(`${companyId}|${name}`);
      const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM packages WHERE company_id = ?').get(companyId).s;
      q(`INSERT INTO packages (company_id, name, cost, price, active, sort, data_gb, minutes, sms, description, art_card_id, kind, days, art_price)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, name, p.cost, withMarkup(p.cost, kind), sort, p.dataGb, p.minutes, p.sms || null,
          p.months > 1 ? `عرض لمدة ${p.months} أشهر` : '', p.ref, kind, p.days, p.cost);
      added++;
    }
    // Gone from the site: hidden as the sync's doing (back by itself when listed again); removed after a week if unused.
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
    setSetting(`tc_synced_${kind}`, now());
    return { kind, total: items.length, added, updated, restored, switchedOff: off, removed, pending: pendingCount(kind), markup: markupFor(kind) };
  });
}

route('GET', '/api/telecom/pending', ADMIN, ({ query }) => {
  const kind = kindOf(query.kind);
  return q(`SELECT p.id, p.name, p.cost, p.price, p.art_price, p.edited, p.active, c.name AS company_name
            FROM packages p JOIN companies c ON c.id = p.company_id WHERE ${REF[kind]} AND ${PENDING} ORDER BY c.sort, p.sort, p.id`).all()
    .map((p) => ({ id: p.id, name: p.name, companyName: p.company_name, cost: round(p.cost), artPrice: round(p.art_price), price: round(p.price),
      suggested: withMarkup(p.art_price, kind), edited: !!p.edited, active: !!p.active }));
});

route('POST', '/api/telecom/approve', ADMIN, ({ body }) => tx(() => {
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

route('POST', '/api/telecom/reprice', ADMIN, ({ body }) => tx(() => {
  const kind = kindOf(body.kind);
  const all = body.scope === 'all';
  const rows = q(`SELECT id, cost FROM packages WHERE ${REF[kind]} AND cost > 0 ${all ? '' : 'AND edited = 0'}`).all();
  for (const r of rows) q(`UPDATE packages SET price = ?${all ? ', edited = 0' : ''} WHERE id = ?`).run(withMarkup(r.cost, kind), r.id);
  return { changed: rows.length, markup: markupFor(kind) };
}));

route('GET', '/api/telecom/reprice', ADMIN, ({ query }) => {
  const kind = kindOf(query.kind);
  const r = q(`SELECT COUNT(*) AS total, SUM(edited) AS edited FROM packages WHERE ${REF[kind]} AND cost > 0`).get();
  return { total: r.total, edited: r.edited || 0, pending: pendingCount(kind), markup: markupFor(kind) };
});

// ---------- free ALOHA numbers for a new eSIM (the customer shop) ----------
// Remembered for a while, so a sale can be checked to use one of them; the shop puts its order's number back here
// before selling it (payment may take longer).
const SERVED_MS = 2 * 60 * 60_000;
const esimServed = new Map();
function rememberEsim(packageId, phones) {
  const t = now();
  for (const [k, v] of esimServed) if (t - v.at > SERVED_MS) esimServed.delete(k);
  for (const phone of phones) esimServed.set(`${packageId}:${phone}`, { phone, at: t });
}
function servedEsim(packageId, number) {
  const v = esimServed.get(`${packageId}:${number}`);
  return v && now() - v.at < SERVED_MS ? v : null;
}

module.exports = { syncKind, REF, rememberEsim, servedEsim };
