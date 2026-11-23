'use strict';
// Aylol Telecom, the same shape as telecom and Layan: new lines ('invoice': bill lines ay:bill:…, sold in the shop as
// eSIMs, and eSIMs ay:esim:…). Sales are carried out automatically by autoexec (sendAy) once the customer's payment is
// verified; nothing here buys anything at the site. Its sync sets the cost to the site's price (no approval).
const { q, tx, getSettings, setSetting, aylolCredentials } = require('../db');
const { fail, round, now } = require('../util');
const ay = require('../aylol');
const { route, ADMIN } = require('../router');
const { companyFor } = require('./quickline');

// Only new lines (sold as eSIMs in the shop): extensions and top-up cards are not sold.
const KINDS = ['invoice'];
const GONE_DAYS = 7;
const kindOf = (v) => (v === undefined || v === '' || KINDS.includes(v) ? 'invoice' : fail(400, 'المتجر يبيع شرائح eSIM فقط: لا رزم تمديد أو كروت'));
const REF = {
  invoice: "(art_card_id LIKE 'ay:bill:%' OR art_card_id LIKE 'ay:esim:%')",
};
// The site's eSIM categories whose purchase names the package bought (Hot Mobile and 019). Its other categories
// (Partner, Pelephone, Cellcom, 012) are bought there without naming a package, so selling one could buy an empty
// eSIM: they are not listed until that purchase is known.
const ESIM_CATS = [{ id: 10, name: 'هوت موبايل' }, { id: 28, name: '019' }];

// ---------- the balance: a sale it cannot pay for is refused before anyone pays; the manager is told when low ----------
const LOW_EVERY_MS = 6 * 60 * 60_000;
function tellManager(title, body) {
  try { require('../domain').notify({ role: 'admin', kind: 'task', title, body, link: '#/settings' }); } catch (e) { console.error('aylol notify', e.message); }
  try { Promise.resolve(require('../whatsapp').tellAdmins?.(`⚠️ ${title}\n${body}`)).catch(() => {}); } catch {}
}
function balanceSeen(balance) {
  if (balance === null || balance === undefined) return;
  const low = getSettings().aylolLowBalance;
  if (!(low > 0) || Number(balance) >= low) return;
  const last = Number(q("SELECT value FROM settings WHERE key = 'aylol_low_alert_at'").get()?.value || 0);
  if (now() - last < LOW_EVERY_MS) return;
  setSetting('aylol_low_alert_at', String(now()));
  tellManager('رصيد أيلول منخفض', `رصيدك في أيلول ${round(balance)} ₪، أقل من ${low} ₪. اشحنه حتى لا تتوقف المبيعات.`);
}
// What the site takes for the package (its own cost when known, else its listed price).
const siteCost = (pkg) => round(Number(pkg.supplier_cost ?? pkg.art_price ?? pkg.cost) || 0);
function ensureBalanceFor(pkg) {
  if (!/^ay:/.test(pkg?.art_card_id || '')) return;
  const b = ay.knownBalance();
  if (!b) return; // not known yet: the sale's own check at the site stops it
  const need = siteCost(pkg);
  if (!(need > 0) || b.value >= need) return;
  const last = Number(q("SELECT value FROM settings WHERE key = 'aylol_short_alert_at'").get()?.value || 0);
  if (now() - last > 60 * 60_000) {
    setSetting('aylol_short_alert_at', String(now()));
    tellManager('رصيد أيلول لا يكفي', `طلب ${pkg.name} (${need} ₪) رُفض قبل الدفع: رصيدك في أيلول ${round(b.value)} ₪. اشحنه.`);
  }
  fail(503, 'هذه الباقة غير متوفرة الآن. جرّب بعد قليل أو اختر باقة أخرى.');
}

const wrap = async (fn) => {
  if (!getSettings().aylolConfigured) fail(400, 'أدخل بريد وكلمة مرور أيلول في الإعدادات أولاً');
  try { return await fn(aylolCredentials()); } catch (e) { if (e instanceof ay.AylolError) fail(502, e.message); throw e; }
};

route('POST', '/api/aylol/check', ADMIN, () => wrap(async (creds) => {
  const me = await ay.login(creds, { force: true });
  return { ok: true, user: me.user, balance: me.balance };
}));

route('POST', '/api/aylol/sync', ADMIN, ({ body }) => wrap(async (creds) => {
  if (body.kind === 'all') return { invoice: await syncKind(creds, 'invoice') };
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
// A bill line's numbers: the ones the site offers for its package (only for the companies whose order it knows); for
// an eSIM line, the ones it offers as eSIMs.
async function billFreeNumbers(ref, sim = '', esim = false) {
  if (!getSettings().aylolConfigured) fail(503, 'الأرقام غير متاحة الآن. تواصل مع المدير.');
  const row = q('SELECT supplier_company FROM packages WHERE art_card_id = ?').get(ref);
  if (!(sim || esim ? ay.billShop(ref, row?.supplier_company) : ay.billAuto(ref, row?.supplier_company))) fail(404, 'رقم هذه الرزمة يختاره المدير عند التنفيذ');
  let list;
  try {
    list = await ay.billNumbers(ref.split(':')[3], aylolCredentials(), sim, esim);
  } catch (e) {
    if (e instanceof ay.AylolError) { console.error('aylol bill numbers', e.message); fail(502, 'تعذّر جلب الأرقام الآن. حاول بعد قليل.'); }
    throw e;
  }
  rememberEsim(ref, list.map((n) => n.phone));
  return list.map((n) => ({ id: n.phone, phone: n.phone }));
}

// ---------- a bill line in the customer shop: on the customer's SIM card, or as an eSIM ----------
// The eSIM way is offered to customers only once the owner turns it on (aylol_line_esim = '1', after a real purchase).
const lineEsimOn = () => q("SELECT value FROM settings WHERE key = 'aylol_line_esim'").get()?.value === '1';
// The ways a package's line is sold in the shop now ([] when none: not on sale there).
function shopLineModes(p) {
  return ay.lineModes(p.supplier_sim_type, p.supplier_company).filter((m) => m !== 'esim' || lineEsimOn());
}
// The package's sim_type, asked of the site the first time a customer orders it (the sync may not have said), kept.
async function learnSimType(p) {
  if (p.supplier_sim_type) return p.supplier_sim_type;
  let info;
  try {
    info = await ay.packageInfo(String(p.art_card_id).split(':')[3], aylolCredentials());
  } catch (e) {
    if (e instanceof ay.AylolError) { console.error('aylol package', e.message); fail(502, 'تعذّر الوصول إلى الباقة الآن. حاول بعد قليل.'); }
    throw e;
  }
  const t = ay.simTypeOf(info.sim_type);
  q('UPDATE packages SET supplier_sim_type = ? WHERE id = ?').run(t, p.id);
  p.supplier_sim_type = t;
  return t;
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
// The agent's own price of the site's packages, from its eSIM list (the charge page shows the customer's price only).
// Keyed by eSIM category and package id; only trusted where the customer's price matches the charge page's.
const AGENT_PRICE_CATS = [1, 2, 3, 4, 10, 28];
async function agentPrices(creds) {
  const map = new Map();
  for (const cat of AGENT_PRICE_CATS) {
    for (const purchaseType of ['loaded_esim', 'new_esim']) {
      let r = null;
      try { r = await ay.fetchEsimPackages({ categoryId: cat, purchaseType }, creds); } catch { continue; }
      for (const p of (r && r.success && Array.isArray(r.data)) ? r.data : []) {
        const agent = Number(p.package_agent_price);
        if (agent > 0) map.set(`${cat}:${p.id}`, { customer: Number(p.package_customer_price) || 0, agent: round(agent) });
      }
    }
  }
  return map;
}

async function collectItems(creds, kind) {
  const synced = await ay.syncAll(creds, ['bill']);
  const prices = await agentPrices(creds);
  const agentCost = (ref, cost) => {
    const [, , cid, pid] = String(ref).split(':');
    const a = prices.get(`${ay.mapToEsimCategoryId(cid)}:${pid}`);
    return a && Math.abs(a.customer - cost) < 0.01 ? a.agent : null;
  };
  const items = synced.items.map((x) => ({
    ref: x.ref, name: x.name, company: x.company, cost: Number(x.price) || 0, dataGb: x.dataGb || null, minutes: x.minutes || null,
    sms: x.sms || null, days: x.days || 30, description: String(x.description || '').slice(0, 400), esim: 0, siteCompany: x.siteCompany || null,
    simType: x.simType || null,
  }));
  for (const i of items) i.supplierCost = agentCost(i.ref, i.cost);
  if (kind === 'invoice') {
    for (const cat of ESIM_CATS) {
      for (const purchaseType of ['loaded_esim', 'new_esim']) {
        const r = await ay.fetchEsimPackages({ categoryId: cat.id, purchaseType }, creds);
        for (const p of (r && r.success && Array.isArray(r.data)) ? r.data : []) {
          const ref = `ay:esim:${cat.id}:${p.id}`;
          if (items.some((i) => i.ref === ref)) continue;
          items.push({
            ref, name: `${cat.name} eSIM — ${String(p.display_name || p.name || p.title || '').trim()}`, company: cat.name,
            cost: ay.listedPrice(p) || 0, dataGb: Number(p.data_gb || p.internet || 0) || null, minutes: Number(p.minutes || p.call || 0) || null,
            sms: Number(p.sms || 0) || null, days: Number(p.days || (p.month_number ? p.month_number * 30 : 30)) || 30, description: String(p.description || '').slice(0, 400), esim: 1,
            // The eSIM list's own price is already the agent's (package and eSIM fee).
            supplierCost: ay.listedPrice(p) || null,
          });
        }
      }
    }
  }
  return items.filter((i) => i.cost > 0);
}

// New packages: cost = the site's price (what is sent with the order), supplier_cost = what the site really takes,
// when it says so. Agents' price is the manager's own: a new package comes with none, so agents do not see it until
// the manager sets one. Existing packages keep their price, name and visibility: only the site's current price is
// recorded, and a difference awaits the manager.
async function syncKind(creds, kind) {
  const items = await collectItems(creds, kind);
  if (!items.length) fail(502, 'أيلول: لم أجد رزماً');
  return tx(() => {
    let added = 0;
    let updated = 0;
    let restored = 0;
    const companyIds = new Set();
    const refs = [];
    const known = new Set(q(`SELECT DISTINCT company_id FROM packages WHERE ${REF.invoice}`).all().map((r) => r.company_id));
    const names = new Set();
    for (const p of items) {
      refs.push(p.ref);
      const companyId = companyFor(p.company);
      companyIds.add(companyId);
      const row = q('SELECT id, gone_at FROM packages WHERE art_card_id = ?').get(p.ref);
      if (row) {
        if (row.gone_at) restored++;
        q('UPDATE packages SET art_price = ?, supplier_cost = ?, supplier_company = COALESCE(?, supplier_company), supplier_sim_type = COALESCE(?, supplier_sim_type), active = CASE WHEN gone_at IS NOT NULL THEN 1 ELSE active END, gone_at = NULL WHERE id = ?')
          .run(p.cost, p.supplierCost ?? null, p.siteCompany ?? null, p.simType ?? null, row.id);
        updated++;
        continue;
      }
      let name = p.name || `${p.company}${p.dataGb ? ` ${p.dataGb} جيجا` : ''}`;
      if (names.has(`${companyId}|${name}`) || q('SELECT 1 FROM packages WHERE company_id = ? AND name = ? AND kind = ?').get(companyId, name, kind)) name = `${name} (${p.ref.split(':').pop()})`;
      names.add(`${companyId}|${name}`);
      const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM packages WHERE company_id = ?').get(companyId).s;
      q(`INSERT INTO packages (company_id, name, cost, price, active, sort, data_gb, minutes, sms, description, art_card_id, kind, days, art_price, esim_enabled, supplier_cost, supplier_company, supplier_sim_type)
         VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, name, p.cost, sort, p.dataGb, p.minutes, p.sms, p.description, p.ref, kind, p.days, p.cost, p.esim, p.supplierCost ?? null, p.siteCompany ?? null, p.simType ?? null);
      added++;
    }
    // Gone from the site: hidden as the sync's doing (back by itself when listed again); removed after a week if unused.
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
    // A bill line is a new number on a SIM card, picked from the numbers the site offers for the package.
    if (kind === 'invoice') q("UPDATE packages SET esim_enabled = 0 WHERE art_card_id LIKE 'ay:bill:%' AND esim_enabled != 0").run();
    setSetting(`aylol_synced_${kind}`, now());
    // No approval: the cost is the supplier's current price, and the shop prices follow it.
    q(`UPDATE packages SET cost = art_price, art_ack = NULL WHERE ${REF.invoice} AND art_price IS NOT NULL AND cost != art_price`).run();
    require('../domain').refreshShopPrices();
    return { kind, total: items.length, added, updated, restored, switchedOff: off, removed };
  });
}

module.exports = { syncKind, REF, freeNumbers, billFreeNumbers, lineEsimOn, shopLineModes, learnSimType, rememberEsim, servedEsim, balanceSeen, ensureBalanceFor };
