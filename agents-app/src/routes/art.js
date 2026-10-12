'use strict';
// art-topup settings actions: check the sign-in and balance, and import its cards as packages.
const { q, tx, getSettings, artCredentials } = require('../db');
const { fail, round } = require('../util');
const art = require('../art');
const { route, ADMIN } = require('../router');

// Our company for an art-topup recharge page title ("شحن سيلكوم" → سلكوم).
const COMPANIES = [
  ['سلكوم', /سي?لكوم|cel+e?com/i], ['جولان', /جولان|golan/i], ['بيلفون', /بيلفون|pelephone/i], ['هوت موبايل', /هوت|hot/i],
  ['019', /019/], ['رامي ليفي', /رامي|rami/i], ['بارتنر', /بارتنر|partner/i],
  ['جوال', /جوال|jawwal/i], ['أوريدو', /[أا]وريدو|ooredoo|oredoo/i],
];
function companyFor(title) {
  const [name, re] = COMPANIES.find(([, r]) => r.test(title)) || [title.replace(/^\s*شحن\s*/, '').trim(), null];
  const all = q('SELECT id, name FROM companies').all();
  const found = all.find((c) => c.name === name) || (re && all.find((c) => re.test(c.name)));
  if (found) return found.id;
  const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM companies').get().s;
  return Number(q("INSERT INTO companies (name, sort, activation) VALUES (?, ?, 'auto')").run(name, sort).lastInsertRowid);
}
const gbOf = (s) => { const m = /(\d+(?:\.\d+)?)\s*(?:جيجا|GB|G\b)/i.exec(s); return m ? Number(m[1]) : null; };

const wrap = async (fn) => {
  if (!getSettings().artConfigured) fail(400, 'أدخل اسم مستخدم art-topup وكلمة المرور أولاً');
  try { return await fn(artCredentials()); } catch (e) { if (e instanceof art.ArtError) fail(502, e.message); throw e; }
};

route('POST', '/api/art/check', ADMIN, () => wrap(async (creds) => ({ ok: true, balance: await art.balance(creds) })));

// Cards become packages: cost = art-topup's agent price, agents' price = cost + the markup. Cards gone from
// art-topup are switched off. Companies with cards are set to "auto" unless they are "direct".
route('POST', '/api/art/sync', ADMIN, () => wrap(syncCards));

async function syncCards(creds) {
  const cards = await art.cards(creds);
  if (!cards.length) fail(502, 'art-topup: لم أجد كروتاً');
  const markup = getSettings().artMarkup;
  return tx(() => {
    let added = 0;
    let updated = 0;
    const companyIds = new Set();
    for (const c of cards) {
      const companyId = companyFor(c.company);
      companyIds.add(companyId);
      const price = round(c.agentPrice * (1 + markup / 100));
      const p = q('SELECT id FROM packages WHERE art_card_id = ?').get(c.ref);
      if (p) {
        q('UPDATE packages SET company_id = ?, name = ?, cost = ?, price = ?, description = ?, active = 1, data_gb = COALESCE(?, data_gb) WHERE id = ?')
          .run(companyId, c.name, c.agentPrice, price, c.description, gbOf(c.name), p.id);
        updated++;
      } else {
        const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM packages WHERE company_id = ?').get(companyId).s;
        q('INSERT INTO packages (company_id, name, cost, price, active, sort, data_gb, description, art_card_id) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)')
          .run(companyId, c.name, c.agentPrice, price, sort, gbOf(c.name), c.description, c.ref);
        added++;
      }
    }
    // Bundles hidden for lack of balance are not "gone": only switch off what disappeared from a page that was read.
    const ids = cards.map((c) => c.ref);
    const off = cards.hidden ? 0
      : q(`UPDATE packages SET active = 0 WHERE art_card_id != '' AND active = 1 AND art_card_id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids).changes;
    for (const id of companyIds) q("UPDATE companies SET activation = 'auto' WHERE id = ? AND activation = 'manual'").run(id);
    return { cards: cards.length, hidden: cards.hidden, added, updated, switchedOff: off, markup };
  });
}

module.exports = { syncCards };
