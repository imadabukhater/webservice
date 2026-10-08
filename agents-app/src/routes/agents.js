'use strict';
const { q, tx } = require('../db');
const { fail, now, round, str, num } = require('../util');
const { hashPassword } = require('../passwords');
const D = require('../domain');
const { route, ADMIN } = require('../router');

function validUsername(u) {
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(u)) fail(400, 'اسم المستخدم: 3 أحرف إنجليزية أو أرقام على الأقل، بدون مسافات');
  return u;
}
function validPassword(pw) {
  if (String(pw).length < 6) fail(400, 'كلمة المرور 6 أحرف على الأقل');
  return String(pw);
}
function creditLimit(v) {
  const n = num(v ?? 0, 'سقف الدين');
  if (n < 0) fail(400, 'سقف الدين لا يكون سالباً');
  return n;
}

route('GET', '/api/agents', ADMIN, () => q(`
  SELECT u.*,
    (SELECT COUNT(*) FROM lines l WHERE l.agent_id = u.id AND l.status != 'disconnected') AS line_count,
    (SELECT COUNT(*) FROM sims s WHERE s.agent_id = u.id AND s.status = 'available') AS sim_count,
    (SELECT MAX(ts) FROM ops o WHERE o.agent_id = u.id AND o.type IN ('activate','renew')) AS last_sale_at
  FROM users u WHERE role = 'agent' ORDER BY u.active DESC, u.name`).all()
  .map((u) => ({ ...D.publicUser(u), lineCount: u.line_count, simCount: u.sim_count, lastSaleAt: u.last_sale_at })));

route('POST', '/api/agents', ADMIN, ({ user, body }) => tx(() => {
  const name = str(body.name, 80);
  if (!name) fail(400, 'اكتب اسم الوكيل');
  const username = validUsername(str(body.username, 32));
  if (q('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'اسم المستخدم مستخدم من قبل');
  const id = q(`INSERT INTO users (role, name, phone, username, password_hash, credit_limit, notes, created_at)
                VALUES ('agent', ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, str(body.phone, 30), username, hashPassword(validPassword(body.password)), creditLimit(body.creditLimit), str(body.notes, 500), now())
    .lastInsertRowid;
  const opening = round(body.balance);
  if (opening) D.changeBalance(D.getUser(id), opening, { type: opening > 0 ? 'topup' : 'deduct', actor: user, detail: 'رصيد افتتاحي' });
  return D.publicUser(D.getUser(id));
}));

route('PUT', '/api/agents/:id', ADMIN, ({ params, body }) => {
  const a = D.getAgent(params.id);
  const name = str(body.name ?? a.name, 80);
  if (!name) fail(400, 'اكتب اسم الوكيل');
  const username = validUsername(str(body.username ?? a.username, 32));
  if (q('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, a.id)) fail(409, 'اسم المستخدم مستخدم من قبل');
  const active = body.active === undefined ? a.active : body.active ? 1 : 0;
  const limit = body.creditLimit === undefined ? a.credit_limit : creditLimit(body.creditLimit);
  q('UPDATE users SET name = ?, phone = ?, username = ?, notes = ?, active = ?, credit_limit = ? WHERE id = ?')
    .run(name, str(body.phone ?? a.phone, 30), username, str(body.notes ?? a.notes, 500), active, limit, a.id);
  if (body.password) {
    q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(validPassword(body.password)), a.id);
    q('DELETE FROM sessions WHERE user_id = ?').run(a.id);
  }
  if (!active) q('DELETE FROM sessions WHERE user_id = ?').run(a.id);
  if (round(limit) !== round(a.credit_limit)) {
    D.notify({ userId: a.id, kind: 'balance', title: `سقف الدين أصبح ${round(limit)} ₪`, link: '#/payments' });
  }
  return D.publicUser(D.getUser(a.id));
});

route('DELETE', '/api/agents/:id', ADMIN, ({ params }) => {
  const a = D.getAgent(params.id);
  if (q('SELECT 1 FROM lines WHERE agent_id = ?').get(a.id)) fail(400, 'لدى الوكيل أرقام. انقلها أولاً، أو أوقف الحساب بدلاً من حذفه.');
  q("UPDATE sims SET agent_id = NULL WHERE agent_id = ? AND status = 'available'").run(a.id);
  q('DELETE FROM users WHERE id = ?').run(a.id);
  return { ok: true };
});

route('POST', '/api/agents/:id/balance', ADMIN, ({ user, params, body }) => tx(() => {
  const a = D.getAgent(params.id);
  const amount = num(body.amount, 'المبلغ');
  const kind = String(body.kind);
  let delta;
  if (kind === 'topup') delta = amount;
  else if (kind === 'deduct') delta = -amount;
  else if (kind === 'set') delta = round(amount - a.balance);
  else fail(400, 'نوع العملية غير معروف');
  if (kind !== 'set' && !(amount > 0)) fail(400, 'أدخل مبلغاً أكبر من صفر');
  if (!delta) fail(400, 'الرصيد لم يتغير');
  const note = str(body.note, 200);
  D.changeBalance(a, delta, { type: delta > 0 ? 'topup' : 'deduct', actor: user, detail: note || (kind === 'set' ? 'تعيين رصيد' : '') });
  D.notify({
    userId: a.id, kind: 'balance', link: '#/payments',
    title: delta > 0 ? `تم شحن رصيدك بـ ${round(delta)} ₪` : `تم خصم ${round(-delta)} ₪ من رصيدك`,
    body: note,
  });
  return D.publicUser(D.getUser(a.id));
}));

route('POST', '/api/transfer', ADMIN, ({ user, body }) => tx(() => {
  const from = D.getAgent(body.fromId);
  const to = D.getAgent(body.toId);
  if (from.id === to.id) fail(400, 'اختر وكيلين مختلفين');
  const amount = num(body.amount, 'المبلغ');
  if (!(amount > 0)) fail(400, 'أدخل مبلغاً أكبر من صفر');
  if (from.balance < amount) fail(400, `رصيد ${from.name} لا يكفي`);
  D.changeBalance(from, -amount, { type: 'transfer_out', actor: user, detail: `إلى ${to.name}` });
  D.changeBalance(to, amount, { type: 'transfer_in', actor: user, detail: `من ${from.name}` });
  D.notify({ userId: from.id, kind: 'balance', title: `نُقل ${amount} ₪ من رصيدك إلى ${to.name}`, link: '#/payments' });
  D.notify({ userId: to.id, kind: 'balance', title: `وصلك ${amount} ₪ من ${from.name}`, link: '#/payments' });
  return { ok: true };
}));

// Per-agent prices: every package with the agent's price (custom or default).
route('GET', '/api/agents/:id/prices', ADMIN, ({ params }) => {
  const a = D.getAgent(params.id);
  return q(`SELECT p.id AS packageId, p.company_id AS companyId, c.name AS companyName, p.name, p.cost, p.price AS defaultPrice,
              ap.price AS customPrice, p.active
            FROM packages p JOIN companies c ON c.id = p.company_id
            LEFT JOIN agent_prices ap ON ap.package_id = p.id AND ap.agent_id = ?
            ORDER BY c.sort, c.id, p.sort, p.id`).all(a.id).map((r) => ({ ...r, active: !!r.active }));
});

route('PUT', '/api/agents/:id/prices', ADMIN, ({ params, body }) => tx(() => {
  const a = D.getAgent(params.id);
  for (const item of Array.isArray(body.prices) ? body.prices : []) {
    const pid = Number(item.packageId);
    if (item.price === null || item.price === '' || item.price === undefined) {
      q('DELETE FROM agent_prices WHERE agent_id = ? AND package_id = ?').run(a.id, pid);
    } else {
      const price = num(item.price, 'السعر');
      if (price < 0) fail(400, 'السعر لا يكون سالباً');
      if (!q('SELECT 1 FROM packages WHERE id = ?').get(pid)) continue;
      q(`INSERT INTO agent_prices (agent_id, package_id, price) VALUES (?, ?, ?)
         ON CONFLICT(agent_id, package_id) DO UPDATE SET price = excluded.price`).run(a.id, pid, price);
    }
  }
  return { ok: true };
}));
