'use strict';
// Layan's new lines ('invoice'), sold in the shop as eSIMs on its free numbers: their sync (the cost follows the
// supplier's price, no approval).
const { q, tx, getSettings, setSetting, lyCredentials } = require('../db');
const { fail, round, now } = require('../util');
const ly = require('../layan');
const { route, ADMIN } = require('../router');
const { companyFor } = require('./quickline');

// Only new lines (sold as eSIMs in the shop): extensions and top-up cards are not sold.
const KINDS = ['invoice'];
const GONE_DAYS = 7;
const kindOf = (v) => (v === undefined || v === '' || KINDS.includes(v) ? 'invoice' : fail(400, 'المتجر يبيع شرائح eSIM فقط: لا رزم تمديد أو كروت'));
const REF = { invoice: "art_card_id LIKE 'lyn:%'" };

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
    const known = new Set(q(`SELECT DISTINCT company_id FROM packages WHERE ${REF.invoice}`).all().map((r) => r.company_id));
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
          .run(companyId, arabicName(c, companyName), c.agentPrice, c.agentPrice, sort, c.dataGb, c.minutes, c.sms,
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
      const used = q(`SELECT 1 FROM lines WHERE package_id = ?1 UNION ALL SELECT 1 FROM shop_orders WHERE package_id = ?1 AND status IN ('awaiting_payment','verifying','review','paid')
                      UNION ALL SELECT 1 FROM tasks WHERE status = 'open' AND json_valid(payload) AND json_extract(payload, '$.packageId') = ?1 LIMIT 1`).get(g.id);
      if (!used) { q('DELETE FROM packages WHERE id = ?').run(g.id); removed++; }
    }
    for (const id of companyIds) if (!known.has(id)) q("UPDATE companies SET activation = 'auto' WHERE id = ? AND activation = 'manual'").run(id);
    setSetting(`ly_synced_${kind}`, now());
    // No approval: the cost is the supplier's current price, and the shop prices follow it.
    q(`UPDATE packages SET cost = art_price, art_ack = NULL WHERE ${REF.invoice} AND art_price IS NOT NULL AND cost != art_price`).run();
    require('../domain').refreshShopPrices();
    return { kind, total: items.length, added, updated, restored, switchedOff: off, removed };
  });
}

// ---------- numbers to sell as new lines ----------
// The dealer's suspended numbers on a package; shown to agents, remembered so a sale can be checked to use one.
const SERVED_MS = 2 * 60 * 60_000;
const served = new Map();
const packageInfo = (packageId) => JSON.parse(q("SELECT value FROM settings WHERE key = 'ly_packages'").get()?.value || '{}')[packageId] || null;

async function freeNumbers(ref, esim = false) {
  if (!getSettings().lyConfigured) fail(503, 'الأرقام غير متاحة الآن. تواصل مع المدير.');
  if (esim) {
    let phones;
    try {
      phones = await ly.esimNumbers(lyCredentials(), ref.packageId);
    } catch (e) {
      if (e instanceof ly.LayanError) { console.error('layan esim numbers', e.message); fail(502, 'تعذّر جلب الأرقام الآن. حاول بعد قليل.'); }
      throw e;
    }
    rememberEsim(ref.packageId, phones);
    return phones.map((phone) => ({ id: phone, phone }));
  }
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

// ---------- free numbers that come as a new eSIM (the customer shop) ----------
// Remembered like the suspended numbers above, so a sale can be checked to use one of them; the shop also keeps the
// picked number with its order and puts it back here before selling it.
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

module.exports = { syncKind, REF, freeNumbers, servedNumber, packageInfo, rememberEsim, servedEsim };
