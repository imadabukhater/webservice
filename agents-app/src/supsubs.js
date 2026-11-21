'use strict';
// The subscribers each supplier holds for our accounts — QuickLine, Layan, telecom (ALOHA) and Aylol — read every hour
// into one table for the manager: one row per supplier subscription, its number, company, package, state, end and
// customer. A subscription no longer listed is kept, marked gone (gone_at). Read only: nothing is changed at a supplier.
const { q, tx, getSettings, setSetting, qlCredentials, lyCredentials, tcCredentials, aylolCredentials } = require('./db');
const { now } = require('./util');
const D = require('./domain');

const EVERY_MS = Number(process.env.SUPSUBS_EVERY_MS) || 60 * 60_000;
const DETAIL_MS = 12 * 60 * 60_000; // telecom's end dates: one page per active subscriber, at most twice a day
const NAMES = { ql: 'QuickLine', ly: 'ليان', tc: 'telecom', ay: 'أيلول' };
const KEYS = Object.keys(NAMES);

// ---------- what each supplier says ----------
const localNumber = (n) => {
  let d = String(n || '').replace(/\D/g, '');
  if (/^97[02]5\d{8}$/.test(d)) d = `0${d.slice(3)}`;
  return d;
};
// "dd/mm/yyyy" or "dd/mm/yyyy HH:mm" (QuickLine, Layan) and "yyyy-mm-dd" (telecom, Aylol): the end of that day, local.
function dateOf(s) {
  const v = String(s || '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 23, 59).getTime();
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59).getTime();
  return null;
}
const AY_STATUS = { active: 'فعّال', paused: 'موقوف مؤقتاً', suspended: 'موقوف مؤقتاً', stopped: 'موقوف نهائياً', disconnected: 'موقوف نهائياً', expired: 'منتهي', cancelled: 'ملغى' };

async function readTelecom() {
  const tc = require('./telecom');
  const creds = tcCredentials();
  const leads = await tc.leads(creds);
  const known = new Map(q("SELECT ext_id, end_at, package, pkg_id, details_at FROM supplier_subs WHERE supplier = 'tc'").all().map((r) => [r.ext_id, r]));
  const out = [];
  for (const l of leads) {
    const ext = String(l.leadId);
    const row = { ext, number: localNumber(l.number), sim: '', company: l.company || '', pkg: '', status: l.status || '', active: !!l.active, endAt: null, customer: l.name || '' };
    const was = known.get(ext);
    if (was) Object.assign(row, { endAt: was.end_at, pkg: was.package, pkgId: was.pkg_id || '', detailsAt: was.details_at });
    // The end date and package are on each subscriber's own page: read for the active ones, twice a day at most.
    if (l.active && !(was?.details_at > now() - DETAIL_MS && was.pkg_id)) {
      try {
        const d = await tc.lead(creds, l.leadId);
        const name = q("SELECT name FROM packages WHERE art_card_id LIKE ? ORDER BY id LIMIT 1").get(`tc%:${d.packageId}:%`)?.name;
        Object.assign(row, { endAt: dateOf(d.endDate), pkg: name || (d.packageId ? `رزمة ${d.packageId}` : ''), pkgId: d.packageId ? String(d.packageId) : '', detailsAt: now() });
      } catch (e) { console.error('supsubs telecom lead', l.leadId, e.message); }
    }
    out.push(row);
  }
  return out;
}

// key → { configured(settings), read() → [{ ext, number, sim, company, pkg, status, active, endAt, customer, detailsAt? }] }
let READERS = {
  ql: {
    configured: (s) => s.qlConfigured,
    read: async () => (await require('./quickline').subscriptions(qlCredentials())).map((r) => ({
      ext: String(r.id), number: localNumber(r.number), sim: r.sim || '', company: r.company || '', pkg: r.packageName || '',
      status: r.status || '', active: r.statusValue === 2 || r.status === 'فعال', endAt: dateOf(r.cutDate), customer: r.customer || '',
      pkgId: r.packageId != null ? String(r.packageId) : '',
    })),
  },
  ly: {
    configured: (s) => s.lyConfigured,
    read: async () => (await require('./layan').numbers(lyCredentials())).map((x) => ({
      ext: String(x.id), number: localNumber(x.number), sim: x.sim || '', company: x.company || '', pkg: x.packageName || '',
      status: x.active ? 'فعّال' : x.suspended ? 'موقوف' : (x.status || ''), active: !!x.active, endAt: dateOf(x.endDate), customer: x.customer || '',
    })),
  },
  tc: { configured: (s) => s.tcReady, read: readTelecom },
  ay: {
    configured: (s) => s.aylolConfigured,
    read: async () => (await require('./aylol').subscriptions(aylolCredentials())).map((x) => ({
      ext: String(x.id), number: localNumber(x.phone), sim: '', company: x.company || '', pkg: x.packageName || '',
      status: AY_STATUS[x.status] || x.status || '', active: x.status === 'active', endAt: dateOf(x.endDate), customer: x.customer || '',
    })),
  },
};

// ---------- the table ----------
const sKey = (key, what) => `subs_${key}_${what}`;
const setting = (k) => q('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';

function save(key, rows, t) {
  return tx(() => {
    const up = q(`INSERT INTO supplier_subs (supplier, ext_id, number, sim, company, package, pkg_id, status, active, end_at, customer, details_at, first_seen, last_seen)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(supplier, ext_id) DO UPDATE SET number = excluded.number, sim = excluded.sim, company = excluded.company,
                    package = excluded.package, pkg_id = excluded.pkg_id, status = excluded.status, active = excluded.active, end_at = excluded.end_at,
                    customer = excluded.customer, details_at = COALESCE(excluded.details_at, supplier_subs.details_at),
                    last_seen = excluded.last_seen, gone_at = NULL`);
    for (const r of rows) {
      if (!r.ext) continue;
      up.run(key, r.ext, localNumber(r.number), r.sim || '', r.company || '', r.pkg || '', r.pkgId || '', r.status || '', r.active ? 1 : 0, r.endAt ?? null,
        r.customer || '', r.detailsAt ?? null, t, t);
    }
    // No longer listed: kept, marked gone.
    const gone = q('UPDATE supplier_subs SET gone_at = ?, active = 0 WHERE supplier = ? AND last_seen < ? AND gone_at IS NULL').run(t, key, t).changes;
    mirror(key, t);
    return gone;
  });
}

// ---------- one list: the suppliers' subscribers are our subscribers ----------
// Everyone a supplier lists bought through us, so each is a line in our system: added when first seen (on the shop's
// account, «متجر الزبائن», unless the number is already a line), and kept in step with the supplier every hour — its
// state (active / frozen when suspended / disconnected when finally cut or gone) and its end date. A line being carried
// out by us (pending) is left alone. Prices are not touched (no sale is recorded: a supplier_sync entry, the manager's).
const FINAL = /نهائي|קבוע|ملغى|cancel|disconnect/i;
const lineStatus = (r) => (r.gone_at || FINAL.test(r.status) ? 'disconnected' : r.active ? 'active' : 'frozen');
function companyFind(name) {
  const v = String(name || '').trim();
  if (!v) return null;
  const exact = q('SELECT id FROM companies WHERE lower(name) = lower(?)').get(v);
  // Else by the known names (Cellcom, HOT, …), or a company the catalog has not met yet, as the catalog sync does.
  return exact ? exact.id : require('./routes/quickline').companyFor(v);
}
// Our package of a subscription: by the supplier's package id (QuickLine qln:/ql:, telecom tcn:/tc:), else by name
// (Layan lyn:/ly:, Aylol ay:bill:). Its new-line package first: the line's own, which a renewal is checked against.
function packageOf(r) {
  const one = (sql, ...a) => q(`SELECT p.*, c.name AS company_name FROM packages p JOIN companies c ON c.id = p.company_id WHERE ${sql} ORDER BY p.id LIMIT 1`).get(...a);
  const id = String(r.pkg_id || '');
  if (r.supplier === 'ql' && id) return one("p.art_card_id LIKE ?", `qln:${id}:%`) || one("p.art_card_id LIKE ?", `ql:${id}:%`);
  if (r.supplier === 'tc' && id) return one("p.art_card_id LIKE ?", `tcn:${id}:%`) || one("p.art_card_id LIKE ?", `tc:${id}:%`);
  if (r.supplier === 'ly' && r.package) return one("p.art_card_id LIKE 'lyn:%' AND p.name = ?", r.package) || one("p.art_card_id LIKE 'ly:%' AND p.name = ?", r.package);
  if (r.supplier === 'ay' && r.package) return one("p.art_card_id LIKE 'ay:bill:%' AND p.name = ?", r.package);
  return null;
}
function mirror(key, t) {
  // Each number once, by its best row at any supplier (listed and active first): an old subscription gone at one
  // supplier does not cut a number listed again (at it or another one).
  const numbers = q('SELECT DISTINCT number FROM supplier_subs WHERE supplier = ? AND (last_seen = ? OR gone_at = ?)').all(key, t, t).map((x) => x.number);
  const best = q('SELECT * FROM supplier_subs WHERE number = ? ORDER BY gone_at IS NOT NULL, active DESC, last_seen DESC, id DESC LIMIT 1');
  let shop = null;
  for (const number of numbers) {
    if (!number) continue;
    const r = best.get(number);
    const status = lineStatus(r);
    const line = q("SELECT * FROM lines WHERE number = ? ORDER BY (status != 'disconnected') DESC, id DESC LIMIT 1").get(r.number);
    if (line) {
      if (line.status === 'pending') continue;
      if (!line.package_id) {
        const p = packageOf(r);
        if (p) q('UPDATE lines SET package_id = ?, company_id = COALESCE(company_id, ?), updated_at = ? WHERE id = ?').run(p.id, p.company_id, t, line.id);
      }
      q(`UPDATE lines SET status = ?, expires_at = COALESCE(?, expires_at), sim = CASE WHEN sim = '' THEN ? ELSE sim END,
           customer_name = CASE WHEN customer_name = '' THEN ? ELSE customer_name END, updated_at = ? WHERE id = ?
           AND (status != ? OR COALESCE(expires_at, 0) != COALESCE(?, expires_at, 0) OR (sim = '' AND ? != '') OR (customer_name = '' AND ? != ''))`)
        .run(status, r.end_at, r.sim || '', r.customer || '', t, line.id, status, r.end_at, r.sim || '', r.customer || '');
      continue;
    }
    if (status === 'disconnected') continue; // cut before we met it: not added
    shop ||= require('./shop').shopAgent();
    const p = packageOf(r);
    const companyId = p?.company_id ?? companyFind(r.company);
    const id = Number(q(`INSERT INTO lines (number, sim, company_id, package_id, package_label, agent_id, kind, months, price, cost, status, customer_name, note, activated_at, expires_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, 'new', 1, 0, 0, ?, ?, ?, ?, ?, ?)`)
      .run(r.number, r.sim || '', companyId, p?.id ?? null, r.package || p?.name || '', shop.id, status, r.customer || '', `من ${NAMES[r.supplier]}`, r.first_seen, r.end_at, t).lastInsertRowid);
    D.logLineOp('supplier_sync', { id, number: r.number }, shop, { id: null, name: NAMES[r.supplier] }, `أُضيف من ${NAMES[r.supplier]}: ${r.package || ''}`.trim());
  }
}

// The supplier's subscription behind a number a customer may renew: listed (not gone), and not finally cut.
function renewable(number) {
  const r = q('SELECT * FROM supplier_subs WHERE number = ? AND gone_at IS NULL ORDER BY active DESC, last_seen DESC LIMIT 1').get(localNumber(number));
  return r && !FINAL.test(r.status) ? r : null;
}

// One supplier read and saved. A failure is kept (shown to the manager, told once until it works again); the rows read
// before stay as they were. An empty list where there were many is taken as a failure (the page changed), not as
// everyone gone.
const running = new Map();
function syncOne(key) {
  if (running.has(key)) return running.get(key);
  const p = (async () => {
    const t = now();
    setSetting(sKey(key, 'tried'), t);
    try {
      const rows = await READERS[key].read();
      const before = q('SELECT COUNT(*) AS n FROM supplier_subs WHERE supplier = ? AND gone_at IS NULL').get(key).n;
      if (!rows.length && before > 5) throw new Error(`رجعت القائمة فاضية (كان فيها ${before})`);
      const gone = save(key, rows, t);
      setSetting(sKey(key, 'at'), t);
      setSetting(sKey(key, 'count'), rows.length);
      setSetting(sKey(key, 'error'), '');
      return { key, count: rows.length, gone };
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      if (!setting(sKey(key, 'error'))) {
        D.notify({ role: 'admin', kind: 'task', title: `تعذّر تحديث مشتركي ${NAMES[key]}`, body: msg, link: '#/subscribers?view=suppliers' });
      }
      setSetting(sKey(key, 'error'), msg);
      console.error('supsubs', key, msg);
      return { key, error: msg };
    }
  })().finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

// Every supplier with an account saved, one after another (force: now, else those not read within the hour).
async function syncAll({ force = false } = {}) {
  const s = getSettings();
  const out = [];
  for (const key of KEYS) {
    if (!READERS[key].configured(s)) continue;
    if (!force && Number(setting(sKey(key, 'tried'))) > now() - EVERY_MS + 60_000) continue;
    out.push(await syncOne(key));
  }
  return out;
}

// What the manager sees: each supplier's state, every subscription (with the line in our system on the same number,
// when there is one), and our active lines of these suppliers that no supplier lists.
function view() {
  const s = getSettings();
  const suppliers = KEYS.map((key) => ({
    key, name: NAMES[key], configured: !!READERS[key].configured(s), at: Number(setting(sKey(key, 'at'))) || null,
    count: Number(setting(sKey(key, 'count'))) || 0, error: setting(sKey(key, 'error')), running: running.has(key),
  }));
  const lines = new Map();
  for (const l of q(`${D.LINE_SELECT} WHERE l.status != 'disconnected' ORDER BY l.id`).all()) lines.set(l.number, l);
  const rows = q('SELECT * FROM supplier_subs ORDER BY gone_at IS NOT NULL, active DESC, end_at IS NULL, end_at, id').all().map((r) => {
    const l = lines.get(r.number);
    return {
      id: r.id, supplier: r.supplier, supplierName: NAMES[r.supplier] || r.supplier, number: r.number, sim: r.sim, company: r.company,
      package: r.package, status: r.status, active: !!r.active, endsAt: r.end_at, customer: r.customer, firstSeen: r.first_seen,
      lastSeen: r.last_seen, gone: !!r.gone_at, goneAt: r.gone_at,
      line: l ? { id: l.id, agentName: l.agent_name, status: l.status, expiresAt: l.expires_at, packageLabel: l.package_label } : null,
    };
  });
  // Our lines of a supplier we read that it does not list (active there).
  const { supplierOfRef } = require('./quickline');
  const listed = new Set(q('SELECT supplier || \':\' || number AS k FROM supplier_subs WHERE gone_at IS NULL').all().map((r) => r.k));
  const readOk = new Set(suppliers.filter((x) => x.at).map((x) => x.key));
  const oursOnly = [...lines.values()].filter((l) => {
    const sup = supplierOfRef(l.package_ref).supplier;
    return readOk.has(sup) && ['active', 'frozen'].includes(l.status) && !listed.has(`${sup}:${l.number}`);
  }).map((l) => ({ id: l.id, number: l.number, supplier: supplierOfRef(l.package_ref).supplier, agentName: l.agent_name, packageLabel: l.package_label, expiresAt: l.expires_at }));
  return { suppliers, rows, oursOnly, everyMs: EVERY_MS };
}
// Just the reading's state per supplier, for the bar above the one subscribers list.
function summary() {
  const s = getSettings();
  return {
    everyMs: EVERY_MS,
    suppliers: KEYS.map((key) => ({
      key, name: NAMES[key], configured: !!READERS[key].configured(s), at: Number(setting(sKey(key, 'at'))) || null,
      count: Number(setting(sKey(key, 'count'))) || 0, error: setting(sKey(key, 'error')), running: running.has(key),
    })).filter((x) => x.configured),
  };
}

const AUTO = process.env.NODE_ENV === 'production' || process.env.SUPSUBS === '1';
if (AUTO) {
  setTimeout(() => syncAll().catch((e) => console.error('supsubs', e.message)), 3 * 60_000).unref();
  setInterval(() => syncAll().catch((e) => console.error('supsubs', e.message)), Math.min(EVERY_MS, 15 * 60_000)).unref();
}

module.exports = { NAMES, syncOne, syncAll, view, summary, dateOf, localNumber, renewable, packageOf, _setReaders: (r) => { READERS = { ...READERS, ...r }; } };
