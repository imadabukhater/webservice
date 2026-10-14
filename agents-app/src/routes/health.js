'use strict';
// How the automatic parts are doing, at a glance, for the manager's home page: the suppliers (balance, last sync),
// the cloud backup, and what waits for the manager or for a supplier. Supplier balances are read at most every
// 10 minutes, so the home page stays fast.
const { q, getSettings, artCredentials, qlCredentials } = require('../db');
const { now, round } = require('../util');
const { route, ADMIN } = require('../router');
const ql = require('../quickline');
const art = require('../art');

const TTL_MS = 10 * 60_000;
const cache = new Map();
async function cached(key, fn) {
  const c = cache.get(key);
  if (c && now() - c.at < TTL_MS) return c;
  let entry;
  try {
    entry = { at: now(), value: await fn(), error: '' };
  } catch (e) {
    entry = { at: now(), value: null, error: String(e.message || e).slice(0, 200) };
  }
  cache.set(key, entry);
  return entry;
}

// The older of a supplier's two syncs (cards and invoices): null while either has never run.
const lastSync = (a, b) => (a && b ? Math.min(a, b) : null);

route('GET', '/api/health', ADMIN, async () => {
  const s = getSettings();
  const [qlBal, artBal] = await Promise.all([
    s.qlConfigured ? cached('ql', () => ql.balance(qlCredentials())) : null,
    s.artConfigured ? cached('art', () => art.balance(artCredentials())) : null,
  ]);
  const count = (sql) => q(sql).get().n;
  return {
    quickline: s.qlConfigured ? {
      balance: qlBal.value === null ? null : round(qlBal.value), error: qlBal.error,
      synced: lastSync(s.qlSyncedCard, s.qlSyncedInvoice),
    } : null,
    art: s.artConfigured ? {
      balance: artBal.value === null ? null : round(artBal.value), error: artBal.error,
      synced: lastSync(s.artSyncedCard, s.artSyncedInvoice),
    } : null,
    backup: { bucket: s.backupBucket, lastAt: s.backupLastAt, error: s.backupError },
    tasks: {
      // Open requests the manager has to act on (manual ones, and what did not go through automatically).
      attention: count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open' AND auto_status NOT IN ('sending','sent')"),
      running: count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open' AND auto_status IN ('sending','sent')"),
    },
    // Line changes still to be made at QuickLine (a disconnect, a pause, a SIM).
    qlPending: count("SELECT COUNT(*) AS n FROM lines WHERE ql_pending != '' OR ql_sim != ''"),
  };
});
