'use strict';
// Imports art-topup's cards into the catalog from the command line (same as «مزامنة الكروت» in the settings).
// ART_USER / ART_PASS, when given, are saved as the art-topup sign-in first. DB_FILE points at the database.
//   sudo -u agents env DB_FILE=/var/lib/agents-app/agents.db node scripts/art-sync.js
const { setSetting, artCredentials } = require('../src/db');
const { syncCards } = require('../src/routes/art');

(async () => {
  if (process.env.ART_USER) setSetting('art_user', process.env.ART_USER);
  if (process.env.ART_PASS) setSetting('art_pass', process.env.ART_PASS);
  const creds = artCredentials();
  if (!creds.user || !creds.pass) throw new Error('art-topup sign-in is not set (ART_USER / ART_PASS)');
  const r = await syncCards(creds);
  console.log(`${r.total} packages (${r.cards} cards, ${r.invoices} invoices): added ${r.added}, updated ${r.updated}, switched off ${r.switchedOff}, hidden for lack of balance ${r.hidden}, markup ${r.markup}%`);
})().catch((e) => { console.error(e.message); process.exit(1); });
