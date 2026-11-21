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
  const known = new Map(q("SELECT ext_id, end_at, package, details_at FROM supplier_subs WHERE supplier = 'tc'").all().map((r) => [r.ext_id, r]));
  const out = [];
  for (const l of leads) {
    const ext = String(l.leadId);
    const row = { ext, number: localNumber(l.number), sim: '', company: l.company || '', pkg: '', status: l.status || '', active: !!l.active, endAt: null, customer: l.name || '' };
    const was = known.get(ext);
    if (was) Object.assign(row, { endAt: was.end_at, pkg: was.package, detailsAt: was.details_at });
    // The end date and package are on each subscriber's own page: read for the active ones, twice a day at most.
    if (l.active && !(was?.details_at > now() - DETAIL_MS)) {
      try {
        const d = await tc.lead(creds, l.leadId);
        const name = q("SELECT name FROM packages WHERE art_card_id LIKE ? ORDER BY id LIMIT 1").get(`tc%:${d.packageId}:%`)?.name;
        Object.assign(row, { endAt: dateOf(d.endDate), pkg: name || (d.packageId ? `رزمة ${d.packageId}` : ''), detailsAt: now() });
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
    const up = q(`INSERT INTO supplier_subs (supplier, ext_id, number, sim, company, package, status, active, end_at, customer, details_at, first_seen, last_seen)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(supplier, ext_id) DO UPDATE SET number = excluded.number, sim = excluded.sim, company = excluded.company,
                    package = excluded.package, status = excluded.status, active = excluded.active, end_at = excluded.end_at,
                    customer = excluded.customer, details_at = COALESCE(excluded.details_at, supplier_subs.details_at),
                    last_seen = excluded.last_seen, gone_at = NULL`);
    for (const r of rows) {
      if (!r.ext) continue;
      up.run(key, r.ext, localNumber(r.number), r.sim || '', r.company || '', r.pkg || '', r.status || '', r.active ? 1 : 0, r.endAt ?? null,
        r.customer || '', r.detailsAt ?? null, t, t);
    }
    // No longer listed: kept, marked gone.
    return q('UPDATE supplier_subs SET gone_at = ?, active = 0 WHERE supplier = ? AND last_seen < ? AND gone_at IS NULL').run(t, key, t).changes;
  });
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

const AUTO = process.env.NODE_ENV === 'production' || process.env.SUPSUBS === '1';
if (AUTO) {
  setTimeout(() => syncAll().catch((e) => console.error('supsubs', e.message)), 3 * 60_000).unref();
  setInterval(() => syncAll().catch((e) => console.error('supsubs', e.message)), Math.min(EVERY_MS, 15 * 60_000)).unref();
}

module.exports = { NAMES, syncOne, syncAll, view, dateOf, localNumber, _setReaders: (r) => { READERS = { ...READERS, ...r }; } };
