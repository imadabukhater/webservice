'use strict';
// Syncs one art-topup system from the command line (same as the sync buttons in «الشركات والرزم»).
// ART_USER / ART_PASS, when given, are saved as the art-topup sign-in first. DB_FILE points at the database.
//   sudo -u agents env DB_FILE=/var/lib/agents-app/agents.db node scripts/art-sync.js card|invoice
const { setSetting, artCredentials } = require('../src/db');
const { syncKind } = require('../src/routes/art');

(async () => {
  const kind = process.argv[2];
  if (!['card', 'invoice'].includes(kind)) throw new Error('usage: node scripts/art-sync.js card|invoice');
  if (process.env.ART_USER) setSetting('art_user', process.env.ART_USER);
  if (process.env.ART_PASS) setSetting('art_pass', process.env.ART_PASS);
  const creds = artCredentials();
  if (!creds.user || !creds.pass) throw new Error('art-topup sign-in is not set (ART_USER / ART_PASS)');
  const r = await syncKind(creds, kind);
  console.log(`${kind}: ${r.total} from art-topup, added ${r.added}, seen ${r.updated}, switched off ${r.switchedOff}, hidden ${r.hidden}, awaiting approval ${r.pending}, markup ${r.markup}%`);
})().catch((e) => { console.error(e.message); process.exit(1); });
