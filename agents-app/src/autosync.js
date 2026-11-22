'use strict';
// Syncs each supplier's catalog by itself, so new packages, packages listed again and price changes arrive without the
// manager pressing a button: every six hours or once a day (see OFTEN_MS), when its account is saved, and sooner (after half an hour) while a sync hid packages within the last day,
// which may be listed again. The manager is told when prices changed and wait for approval, and when a sync fails (once, until it
// works again). Each sync is the same one as the buttons in «الشركات والرزم».
const { q, getSettings, setSetting, qlCredentials, aylolCredentials, lyCredentials, tcCredentials } = require('./db');
const { now } = require('./util');
const D = require('./domain');

const DAY_MS = 24 * 60 * 60_000;
// QuickLine and Layan sign in by themselves, so their catalogs are refreshed four times a day, and Aylol's every two
// hours. telecom's sign-in waits for a code by e-mail: once a day.
// (Free numbers and the price are read from the supplier at every order, whatever the catalog's age.)
const OFTEN_MS = 6 * 60 * 60_000;
const SOON_MS = 30 * 60_000;
const CHECK_MS = Number(process.env.AUTOSYNC_CHECK_MS) || 60 * 60_000;

const SUPPLIERS = [
  {
    key: 'ay', name: 'أيلول', every: 2 * 60 * 60_000, configured: (s) => s.aylolConfigured, synced: (s) => [s.aylolSyncedInvoice],
    refs: "(art_card_id LIKE 'ay:bill:%' OR art_card_id LIKE 'ay:esim:%')", sync: (kind) => require('./routes/aylol').syncKind(aylolCredentials(), kind),
  },
  {
    key: 'ql', name: 'QuickLine', every: OFTEN_MS, configured: (s) => s.qlConfigured, synced: (s) => [s.qlSyncedInvoice],
    refs: "art_card_id LIKE 'qln:%'", sync: (kind) => require('./routes/quickline').syncKind(qlCredentials(), kind),
  },
  {
    key: 'ly', name: 'ليان', every: OFTEN_MS, configured: (s) => s.lyConfigured, synced: (s) => [s.lySyncedInvoice],
    refs: "art_card_id LIKE 'lyn:%'", sync: (kind) => require('./routes/layan').syncKind(lyCredentials(), kind),
  },
  {
    key: 'tc', name: 'telecom', configured: (s) => s.tcReady, synced: (s) => [s.tcSyncedInvoice],
    refs: "art_card_id LIKE 'tcn:%'", sync: (kind) => require('./routes/telecom').syncKind(tcCredentials(), kind),
  },
];

const tell = (title, body) => D.notify({ role: 'admin', kind: 'task', title, body, link: '#/catalog' });

// Due when its new lines have never synced or is older than the supplier's period; or half an hour old while some packages are hidden by a sync.
function due(sup, s) {
  const times = sup.synced(s);
  if (times.some((t) => !t)) return true;
  const oldest = Math.min(...times);
  if (now() - oldest >= (sup.every || DAY_MS)) return true;
  // Only packages hidden within the last day: one gone for longer is most likely gone for good.
  const gone = q(`SELECT COUNT(*) AS n FROM packages WHERE gone_at > ? AND ${sup.refs}`).get(now() - DAY_MS).n;
  return gone > 0 && now() - oldest >= SOON_MS;
}

// One supplier's new lines, with what the manager is told. Never two syncs of one supplier at once.
const running = new Set();
async function syncOne(sup) {
  if (running.has(sup.key)) return;
  running.add(sup.key);
  try {
    let pending = 0;
    let restored = 0;
    for (const kind of ['invoice']) {
      const r = await sup.sync(kind);
      pending += r.pending || 0;
      restored += r.restored || 0;
    }
    const errKey = `autosync_error_${sup.key}`;
    if (q('SELECT value FROM settings WHERE key = ?').get(errKey)?.value) setSetting(errKey, '');
    // Told about price changes when their number changes, not every day they are still waiting.
    const lastKey = `autosync_pending_${sup.key}`;
    if (pending && String(pending) !== q('SELECT value FROM settings WHERE key = ?').get(lastKey)?.value) {
      tell(`${sup.name}: ${pending} رزمة تغيّر سعرها`, 'بانتظار موافقتك في «الشركات والرزم». لن تتغيّر أسعارك قبلها.');
    }
    setSetting(lastKey, pending);
    if (restored) tell(`${sup.name}: عادت ${restored} رزمة`, 'كانت مخفية لأن المورّد لم يعرضها، وعرضها الآن.');
  } catch (e) {
    const errKey = `autosync_error_${sup.key}`;
    if (!q('SELECT value FROM settings WHERE key = ?').get(errKey)?.value) tell(`تعذّرت المزامنة التلقائية مع ${sup.name}`, String(e.message).slice(0, 200));
    setSetting(errKey, String(e.message).slice(0, 300) || 'خطأ');
  } finally {
    running.delete(sup.key);
  }
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const s = getSettings();
    for (const sup of SUPPLIERS) if (sup.configured(s) && due(sup, s)) await syncOne(sup);
  } finally {
    busy = false;
  }
}

// Right away (in the background), e.g. once its account is saved. Returns the sync, for tests.
function syncNow(key) {
  const sup = SUPPLIERS.find((x) => x.key === key);
  if (!sup || !sup.configured(getSettings())) return Promise.resolve();
  return syncOne(sup);
}
// From the settings screen: only where the daily sync runs (the server, not the tests).
const AUTO = process.env.NODE_ENV === 'production' || process.env.AUTOSYNC === '1';
function syncSoon(key) {
  if (AUTO) setImmediate(() => syncNow(key).catch((e) => console.error('autosync', e)));
}

if (AUTO) {
  setTimeout(() => tick().catch((e) => console.error('autosync', e)), 2 * 60_000).unref();
  setInterval(() => tick().catch((e) => console.error('autosync', e)), CHECK_MS).unref();
}

module.exports = { tick, due, syncNow, syncSoon };
