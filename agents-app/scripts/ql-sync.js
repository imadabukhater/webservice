'use strict';
// Syncs one QuickLine system from the command line (same as the sync buttons in «الشركات والرزم»).
// QL_USER / QL_PASS, when given, are saved as the QuickLine sign-in first. DB_FILE points at the database.
//   sudo -u agents env DB_FILE=/var/lib/agents-app/agents.db node scripts/ql-sync.js card|invoice
const { setSetting, qlCredentials } = require('../src/db');
const { syncKind } = require('../src/routes/quickline');

(async () => {
  const kind = process.argv[2];
  if (!['card', 'invoice'].includes(kind)) throw new Error('usage: node scripts/ql-sync.js card|invoice');
  if (process.env.QL_USER) setSetting('ql_user', process.env.QL_USER);
  if (process.env.QL_PASS) setSetting('ql_pass', process.env.QL_PASS);
  const creds = qlCredentials();
  if (!creds.user || !creds.pass) throw new Error('QuickLine sign-in is not set (QL_USER / QL_PASS)');
  const r = await syncKind(creds, kind);
  console.log(`${kind}: ${r.total} from QuickLine, added ${r.added}, seen ${r.updated}, switched off ${r.switchedOff}, awaiting approval ${r.pending}, markup ${r.markup}%`);
})().catch((e) => { console.error(e.message); process.exit(1); });
