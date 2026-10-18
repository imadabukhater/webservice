'use strict';
// API for connected sites (other shops reselling this catalog). Each key belongs to an agent account: its orders are
// charged to that agent's balance at the agent's prices, exactly like a sale in the portal.
// Server to server only: send the key in the X-Api-Key header and never expose it in a browser.
const crypto = require('node:crypto');
const { q, tx, getSettings } = require('../db');
const { fail, now, round, str } = require('../util');
const { sha } = require('../passwords');
const D = require('../domain');
const { createLine } = require('./lines');
const { route, ADMIN } = require('../router');

const hits = new Map();

function keyAgent(req) {
  const key = String(req.headers['x-api-key'] || '').trim();
  if (!key) fail(401, 'مفتاح الربط مفقود (X-Api-Key)');
  const k = q('SELECT * FROM api_keys WHERE key_hash = ? AND active = 1').get(sha(key));
  if (!k) fail(401, 'مفتاح الربط غير صالح');
  const t = now();
  const list = (hits.get(k.id) || []).filter((x) => x > t - 60_000);
  if (list.length >= 120) fail(429, 'طلبات كثيرة. حاول بعد دقيقة.');
  list.push(t);
  hits.set(k.id, list);
  const agent = D.getUser(k.agent_id);
  if (!agent || agent.role !== 'agent' || !agent.active) fail(403, 'حساب الوكيل المرتبط موقوف');
  q('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(t, k.id);
  return agent;
}

const lineOut = (l) => ({
  id: l.id, number: l.number, package: l.packageLabel, status: l.status, state: l.state, months: l.months, price: l.price,
  customerName: l.customerName, activatedAt: l.activatedAt, expiresAt: l.expiresAt,
});

route('GET', '/api/v1/catalog', null, ({ req }) => {
  const agent = keyAgent(req);
  const rows = q(`SELECT p.*, c.name AS company_name, c.color AS company_color, COALESCE(ap.price, p.price) AS agent_price
                  FROM packages p JOIN companies c ON c.id = p.company_id
                  LEFT JOIN agent_prices ap ON ap.package_id = p.id AND ap.agent_id = ?
                  WHERE p.active = 1 ORDER BY c.sort, c.id, p.sort, p.id`).all(agent.id).filter((p) => p.agent_price > 0);
  return {
    updatedAt: now(),
    packages: rows.map((p) => ({
      id: p.id, companyId: p.company_id, company: p.company_name, companyColor: p.company_color, name: p.name,
      price: round(p.agent_price), suggestedPrice: p.shop_price ? round(p.shop_price) : null,
      dataGb: p.data_gb, minutes: p.minutes, sms: p.sms, description: p.description,
    })),
  };
});

route('GET', '/api/v1/balance', null, ({ req }) => {
  const a = keyAgent(req);
  return { balance: round(a.balance), creditLimit: round(a.credit_limit), available: round(a.balance + a.credit_limit) };
});

// body: { packageId, number, kind: 'recharge'|'new', sim?, esim?, months?, customerName?, customerPrice?, reference? }
route('POST', '/api/v1/orders', null, ({ req, body }) => {
  const agent = keyAgent(req);
  const ref = str(body.reference, 60);
  const r = tx(() => createLine(agent, {
    kind: body.kind === 'new' ? 'new' : 'external', number: body.number, sim: body.sim, esim: !!body.esim, months: body.months ?? 1,
    packageId: body.packageId, customerName: body.customerName, customerPrice: body.customerPrice,
    note: ref ? `موقع مرتبط: ${ref}` : 'موقع مرتبط',
  }));
  return { order: lineOut(r.line), renewed: !!r.renewed, balance: r.balance, available: r.available };
});

route('GET', '/api/v1/orders/:id', null, ({ req, params }) => {
  const agent = keyAgent(req);
  return { order: lineOut(D.lineView(D.getLine(params.id, agent), 'agent', getSettings().warnDays)) };
});

// ---------- manager: keys ----------
route('GET', '/api/sync-keys', ADMIN, () => q(`SELECT k.id, k.agent_id, k.name, k.prefix, k.active, k.created_at, k.last_used_at, u.name AS agent_name
  FROM api_keys k JOIN users u ON u.id = k.agent_id ORDER BY k.id DESC`).all().map((k) => ({
  id: k.id, agentId: k.agent_id, agentName: k.agent_name, name: k.name, prefix: k.prefix, active: !!k.active, createdAt: k.created_at, lastUsedAt: k.last_used_at,
})));

// The key is shown once, here; only its hash is stored.
route('POST', '/api/sync-keys', ADMIN, ({ body }) => {
  const agent = D.getAgent(body.agentId);
  const name = str(body.name, 80);
  if (!name) fail(400, 'اكتب اسم الموقع');
  const key = `ak_${crypto.randomBytes(24).toString('base64url')}`;
  const id = Number(q('INSERT INTO api_keys (agent_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(agent.id, name, sha(key), key.slice(0, 7), now()).lastInsertRowid);
  return { id, key };
});

route('DELETE', '/api/sync-keys/:id', ADMIN, ({ params }) => {
  q('DELETE FROM api_keys WHERE id = ?').run(Number(params.id));
  return { ok: true };
});
