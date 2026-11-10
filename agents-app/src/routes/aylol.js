'use strict';
// Aylol Telecom, the same shape as telecom and Layan: top-up cards ('card', ay:credit:…) and new lines ('invoice':
// bill lines ay:bill:… and eSIMs ay:esim:…). Sales are carried out automatically by autoexec (sendAy) after the
// agent's balance is charged; nothing here buys anything at the site, except a sale being carried out.
// Each system has its own sync, profit percentage and list of price changes awaiting the manager.
const { q, tx, getSettings, setSetting, aylolCredentials } = require('../db');
const { fail, round, now } = require('../util');
const ay = require('../aylol');
const { route, ADMIN, ANY } = require('../router');
const { companyFor } = require('./quickline');

const KINDS = ['card', 'invoice'];
const GONE_DAYS = 7;
const kindOf = (v) => (KINDS.includes(v) ? v : fail(400, 'اختر النظام: الكروت أو الخطوط الجديدة'));
const markupFor = (kind) => (kind === 'card' ? getSettings().aylolMarkupCard : getSettings().aylolMarkupInvoice);
const withMarkup = (cost, kind) => round(cost * (1 + markupFor(kind) / 100));
const REF = {
  card: "art_card_id LIKE 'ay:credit:%'",
  invoice: "(art_card_id LIKE 'ay:bill:%' OR art_card_id LIKE 'ay:esim:%')",
};
const PENDING = 'art_price IS NOT NULL AND ROUND(art_price, 2) != ROUND(cost, 2) AND (art_ack IS NULL OR ROUND(art_ack, 2) != ROUND(art_price, 2))';
const pendingCount = (kind) => q(`SELECT COUNT(*) AS n FROM packages WHERE ${REF[kind]} AND ${PENDING}`).get().n;
// The site's eSIM categories.
const ESIM_CATS = [
  { id: 1, name: 'بارتنر' }, { id: 2, name: 'بيلفون' }, { id: 3, name: 'سلكوم' },
  { id: 4, name: '012' }, { id: 10, name: 'هوت موبايل' }, { id: 28, name: '019' },
];

const wrap = async (fn) => {
  if (!getSettings().aylolConfigured) fail(400, 'أدخل بريد وكلمة مرور أيلول في الإعدادات أولاً');
  try { return await fn(aylolCredentials()); } catch (e) { if (e instanceof ay.AylolError) fail(502, e.message); throw e; }
};

route('POST', '/api/aylol/check', ADMIN, () => wrap(async (creds) => {
  const me = await ay.login(creds);
  return { ok: true, user: me.user, balance: me.balance };
}));

route('POST', '/api/aylol/sync', ADMIN, ({ body }) => wrap(async (creds) => {
  if (body.kind === 'all') {
    const card = await syncKind(creds, 'card');
    const invoice = await syncKind(creds, 'invoice');
    return { card, invoice };
  }
  return syncKind(creds, kindOf(body.kind));
}));

// ---------- free eSIM numbers (an agent picks one, as with Layan and telecom eSIMs) ----------
// Only the numbers are shown: the eSIM's code and QR reach the customer once the sale is carried out. Nothing is
// bought here. A number sold must be one this list showed for that package (checked when the line is created).
const SERVED_MS = 30 * 60_000;
const esimServed = new Map();
function rememberEsim(ref, phones) {
  const t = now();
  for (const [k, v] of esimServed) if (t - v.at > SERVED_MS) esimServed.delete(k);
  for (const phone of phones) esimServed.set(`${ref}:${phone}`, { phone, at: t });
}
function servedEsim(ref, number) {
  const v = esimServed.get(`${ref}:${number}`);
  return v && now() - v.at < SERVED_MS ? v : null;
}
async function freeNumbers(ref) {
  if (!getSettings().aylolConfigured) fail(503, 'الأرقام غير متاحة الآن. تواصل مع المدير.');
  let phones;
  try {
    phones = (await ay.lookupAvailableNumbers({ ref, allocate: false }, aylolCredentials())).numbers.map((n) => n.phoneNumber).filter((p) => /^05\d{8}$/.test(p));
  } catch (e) {
    if (e instanceof ay.AylolError) { console.error('aylol esim numbers', e.message); fail(502, 'تعذّر جلب الأرقام الآن. حاول بعد قليل.'); }
    throw e;
  }
  rememberEsim(ref, phones);
  return phones.map((phone) => ({ id: phone, phone }));
}

// What the site sells, by system. Only what it lists, at its own price: nothing is made up when a sync fails.
async function collectItems(creds, kind) {
  const synced = await ay.syncAll(creds, [kind === 'card' ? 'credit' : 'bill']);
  const items = synced.items.map((x) => ({
    ref: x.ref, name: x.name, company: x.company, cost: Number(x.price) || 0, dataGb: x.dataGb || null, minutes: x.minutes || null,
    sms: x.sms || null, days: x.days || 30, description: String(x.description || '').slice(0, 400), esim: kind === 'card' ? 0 : 1,
  }));
  if (kind === 'invoice') {
    for (const cat of ESIM_CATS) {
      for (const purchaseType of ['loaded_esim', 'new_esim']) {
        const r = await ay.fetchEsimPackages({ categoryId: cat.id, purchaseType }, creds);
        for (const p of (r && r.success && Array.isArray(r.data)) ? r.data : []) {
          const ref = `ay:esim:${cat.id}:${p.id}`;
          if (items.some((i) => i.ref === ref)) continue;
          items.push({
            ref, name: `${cat.name} eSIM — ${String(p.display_name || p.name || p.title || '').trim()}`, company: cat.name,
            cost: Number(p.price ?? p.cost ?? 0) || 0, dataGb: Number(p.data_gb || p.internet || 0) || null, minutes: Number(p.minutes || p.call || 0) || null,
            sms: Number(p.sms || 0) || null, days: Number(p.days || 30) || 30, description: String(p.description || '').slice(0, 400), esim: 1,
          });
        }
      }
    }
  }
  return items.filter((i) => i.cost > 0);
}

// New packages: cost = the site's price, agents' price = cost + this system's percentage. Existing packages keep
// their price, name and visibility: only the site's current price is recorded, and a difference awaits the manager.
async function syncKind(creds, kind) {
  const items = await collectItems(creds, kind);
  if (!items.length) fail(502, 'أيلول: لم أجد رزماً');
  return tx(() => {
    let added = 0;
    let updated = 0;
    let restored = 0;
    const companyIds = new Set();
    const refs = [];
    const known = new Set(q(`SELECT DISTINCT company_id FROM packages WHERE ${REF.card} OR ${REF.invoice}`).all().map((r) => r.company_id));
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
      let name = p.name || `${p.company}${p.dataGb ? ` ${p.dataGb} جيجا` : ''}`;
      if (names.has(`${companyId}|${name}`) || q('SELECT 1 FROM packages WHERE company_id = ? AND name = ? AND kind = ?').get(companyId, name, kind)) name = `${name} (${p.ref.split(':').pop()})`;
      names.add(`${companyId}|${name}`);
      const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM packages WHERE company_id = ?').get(companyId).s;
      q(`INSERT INTO packages (company_id, name, cost, price, active, sort, data_gb, minutes, sms, description, art_card_id, kind, days, art_price, esim_enabled)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, name, p.cost, withMarkup(p.cost, kind), sort, p.dataGb, p.minutes, p.sms, p.description, p.ref, kind, p.days, p.cost, p.esim);
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
    setSetting(`aylol_synced_${kind}`, now());
    return { kind, total: items.length, added, updated, restored, switchedOff: off, removed, pending: pendingCount(kind), markup: markupFor(kind) };
  });
}

route('GET', '/api/aylol/pending', ADMIN, ({ query }) => {
  const kind = kindOf(query.kind);
  return q(`SELECT p.id, p.name, p.cost, p.price, p.art_price, p.edited, p.active, c.name AS company_name
            FROM packages p JOIN companies c ON c.id = p.company_id WHERE ${REF[kind]} AND ${PENDING} ORDER BY c.sort, p.sort, p.id`).all()
    .map((p) => ({ id: p.id, name: p.name, companyName: p.company_name, cost: round(p.cost), artPrice: round(p.art_price), price: round(p.price),
      suggested: withMarkup(p.art_price, kind), edited: !!p.edited, active: !!p.active }));
});

route('POST', '/api/aylol/approve', ADMIN, ({ body }) => tx(() => {
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

route('POST', '/api/aylol/reprice', ADMIN, ({ body }) => tx(() => {
  const kind = kindOf(body.kind);
  const all = body.scope === 'all';
  const rows = q(`SELECT id, cost FROM packages WHERE ${REF[kind]} AND cost > 0 ${all ? '' : 'AND edited = 0'}`).all();
  for (const r of rows) q(`UPDATE packages SET price = ?${all ? ', edited = 0' : ''} WHERE id = ?`).run(withMarkup(r.cost, kind), r.id);
  return { changed: rows.length, markup: markupFor(kind) };
}));

route('GET', '/api/aylol/reprice', ADMIN, ({ query }) => {
  const kind = kindOf(query.kind);
  const r = q(`SELECT COUNT(*) AS total, SUM(edited) AS edited FROM packages WHERE ${REF[kind]} AND cost > 0`).get();
  return { total: r.total, edited: r.edited || 0, pending: pendingCount(kind), markup: markupFor(kind) };
});

module.exports = { syncKind, REF, freeNumbers, rememberEsim, servedEsim };
