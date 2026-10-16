'use strict';
// Syncs each supplier's catalog by itself, so new packages, packages listed again and price changes arrive without the
// manager pressing a button: once a day, and sooner (after half an hour) while a sync hid packages within the last day,
// which may be listed again. The manager is told when prices changed and wait for approval, and when a sync fails (once, until it
// works again). Each sync is the same one as the buttons in «الشركات والرزم».
const { q, getSettings, setSetting, qlCredentials, artCredentials, lyCredentials } = require('./db');
const { now } = require('./util');
const D = require('./domain');

const DAY_MS = 24 * 60 * 60_000;
const SOON_MS = 30 * 60_000;
const CHECK_MS = Number(process.env.AUTOSYNC_CHECK_MS) || 60 * 60_000;

const SUPPLIERS = [
  {
    key: 'ql', name: 'QuickLine', configured: (s) => s.qlConfigured, synced: (s) => [s.qlSyncedCard, s.qlSyncedInvoice],
    refs: "art_card_id LIKE 'ql%'", sync: (kind) => require('./routes/quickline').syncKind(qlCredentials(), kind),
  },
  {
    key: 'ly', name: 'ليان', configured: (s) => s.lyConfigured, synced: (s) => [s.lySyncedCard, s.lySyncedInvoice],
    refs: "art_card_id LIKE 'ly%'", sync: (kind) => require('./routes/layan').syncKind(lyCredentials(), kind),
  },
  {
    key: 'art', name: 'art-topup', configured: (s) => s.artConfigured, synced: (s) => [s.artSyncedCard, s.artSyncedInvoice],
    refs: "(art_card_id LIKE 'ic:%' OR art_card_id LIKE 'pb:%' OR art_card_id LIKE 'pc:%' OR art_card_id LIKE 'inv:%')",
    sync: (kind) => require('./routes/art').syncKind(artCredentials(), kind),
  },
];

const tell = (title, body) => D.notify({ role: 'admin', kind: 'task', title, body, link: '#/catalog' });

// Due when either system has never synced or is a day old; or half an hour old while some packages are hidden by a sync.
function due(sup, s) {
  const times = sup.synced(s);
  if (times.some((t) => !t)) return true;
  const oldest = Math.min(...times);
  if (now() - oldest >= DAY_MS) return true;
  // Only packages hidden within the last day: one gone for longer is most likely gone for good.
  const gone = q(`SELECT COUNT(*) AS n FROM packages WHERE gone_at > ? AND ${sup.refs}`).get(now() - DAY_MS).n;
  return gone > 0 && now() - oldest >= SOON_MS;
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const s = getSettings();
    for (const sup of SUPPLIERS) {
      if (!sup.configured(s) || !due(sup, s)) continue;
      try {
        let pending = 0;
        let restored = 0;
        for (const kind of ['card', 'invoice']) {
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
        if (restored) tell(`${sup.name}: عادت ${restored} رزمة للوكلاء`, 'كانت مخفية لأن المورّد لم يعرضها، وعرضها الآن.');
      } catch (e) {
        const errKey = `autosync_error_${sup.key}`;
        if (!q('SELECT value FROM settings WHERE key = ?').get(errKey)?.value) tell(`تعذّرت المزامنة التلقائية مع ${sup.name}`, String(e.message).slice(0, 200));
        setSetting(errKey, String(e.message).slice(0, 300) || 'خطأ');
      }
    }
  } finally {
    busy = false;
  }
}

if (process.env.NODE_ENV === 'production' || process.env.AUTOSYNC === '1') {
  setTimeout(() => tick().catch((e) => console.error('autosync', e)), 2 * 60_000).unref();
  setInterval(() => tick().catch((e) => console.error('autosync', e)), CHECK_MS).unref();
}

module.exports = { tick, due };
