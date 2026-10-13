'use strict';
// art-topup settings actions: check the sign-in and balance, and import its recharge cards and invoice packages.
const { q, tx, getSettings, artCredentials } = require('../db');
const { fail, round } = require('../util');
const art = require('../art');
const { route, ADMIN } = require('../router');

// Our company for an art-topup page title, invoice company or (in "شركات مشتركة") package name.
const COMPANIES = [
  ['سلكوم', /سي?لكوم|cel+e?com/i], ['جولان', /جولان|golan/i], ['بيلفون', /بيلفون|pelephone/i], ['هوت موبايل', /هوت|hot/i],
  ['019', /019/], ['رامي ليفي', /رامي|rami/i], ['بارتنر', /بارتنر|partner/i],
  ['جوال', /جوال|jawwal/i], ['أوريدو', /[أا]وريدو|ooredoo|oredoo/i],
  ['WE', /we\s*4\s*g|^\s*وي\s|\bwe\b/i], ['كلام', /كلام|kalam/i], ['X phone', /x\s*-?\s*phone|اكس فون/i],
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

// Cards (kind 'card') and invoice packages (kind 'invoice') become packages: cost = art-topup's agent price,
// agents' price = cost + the markup. New ones are visible to agents. On later syncs:
// - a package the manager edited keeps his name, price, size and duration; only its cost follows art-topup;
// - whether agents see it is never changed, except that packages gone from art-topup are switched off.
// Companies with art-topup packages are set to "auto" unless they are "direct".
route('POST', '/api/art/sync', ADMIN, () => wrap(syncCards));

async function syncCards(creds) {
  const items = await art.catalog(creds);
  if (!items.length) fail(502, 'art-topup: لم أجد كروتاً ولا فواتير');
  const markup = getSettings().artMarkup;
  return tx(() => {
    const count = { added: 0, updated: 0, cards: 0, invoices: 0 };
    const companyIds = new Set();
    for (const c of items) {
      count[c.kind === 'invoice' ? 'invoices' : 'cards']++;
      const companyId = companyFor(c.company);
      companyIds.add(companyId);
      const price = round(c.agentPrice * (1 + markup / 100));
      const p = q('SELECT id, edited FROM packages WHERE art_card_id = ?').get(c.ref);
      if (p?.edited) {
        q('UPDATE packages SET cost = ? WHERE id = ?').run(c.agentPrice, p.id);
        count.updated++;
      } else if (p) {
        q(`UPDATE packages SET company_id = ?, name = ?, cost = ?, price = ?, description = ?, kind = ?, days = ?, data_gb = COALESCE(?, data_gb)
           WHERE id = ?`).run(companyId, c.name, c.agentPrice, price, c.description, c.kind, c.days ?? null, gbOf(c.name), p.id);
        count.updated++;
      } else {
        const sort = q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM packages WHERE company_id = ?').get(companyId).s;
        q(`INSERT INTO packages (company_id, name, cost, price, active, sort, data_gb, description, art_card_id, kind, days)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
          .run(companyId, c.name, c.agentPrice, price, sort, gbOf(c.name), c.description, c.ref, c.kind, c.days ?? null);
        count.added++;
      }
    }
    // Bundles hidden for lack of balance are not "gone": only switch off when every page was fully read.
    const ids = items.map((c) => c.ref);
    const off = items.hidden ? 0
      : q(`UPDATE packages SET active = 0 WHERE art_card_id != '' AND active = 1 AND art_card_id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids).changes;
    for (const id of companyIds) q("UPDATE companies SET activation = 'auto' WHERE id = ? AND activation = 'manual'").run(id);
    return { ...count, total: items.length, hidden: items.hidden, switchedOff: off, markup };
  });
}

module.exports = { syncCards };
