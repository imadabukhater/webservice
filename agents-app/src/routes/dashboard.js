'use strict';
const { q, getSettings } = require('../db');
const { now, round, str, dayStart, monthStart, tzFrom, arCount } = require('../util');
const D = require('../domain');
const { route, ANY } = require('../router');

const SALE_TYPES = "('activate','renew','refund','line_delete')";

// Counts lines by display state for one agent (or everyone).
function lineCounts(agentId) {
  const t = now();
  const warn = getSettings().warnDays * 864e5;
  const rows = q(`SELECT status, expires_at FROM lines ${agentId ? 'WHERE agent_id = ?' : ''}`).all(...(agentId ? [agentId] : []));
  const c = { active: 0, expiring: 0, expired: 0, frozen: 0, pending: 0, disconnected: 0, total: 0 };
  for (const r of rows) {
    if (r.status === 'active' && r.expires_at && r.expires_at < t) c.expired++;
    else if (r.status === 'active') {
      c.active++;
      if (r.expires_at && r.expires_at - t <= warn) c.expiring++;
    } else c[r.status]++;
    if (r.status !== 'disconnected') c.total++;
  }
  return c;
}

// Sales since a moment: counts, money spent by agents, manager profit, and the agent's own margin over customer prices.
function sales(from, agentId) {
  const r = q(`SELECT
      SUM(type = 'activate') AS activations, SUM(type = 'renew') AS renewals,
      COALESCE(SUM(-amount), 0) AS revenue, COALESCE(SUM(profit), 0) AS profit,
      COALESCE(SUM(CASE WHEN customer_price IS NOT NULL THEN customer_price + amount ELSE 0 END), 0) AS margin
    FROM ops WHERE ts >= ? AND type IN ${SALE_TYPES} ${agentId ? 'AND agent_id = ?' : ''}`).get(from, ...(agentId ? [agentId] : []));
  return {
    activations: r.activations || 0, renewals: r.renewals || 0,
    revenue: round(r.revenue), profit: round(r.profit), margin: round(r.margin),
  };
}

route('GET', '/api/dashboard', ANY, ({ user, query }) => {
  const tz = tzFrom(query);
  const t = now();
  const today = dayStart(t, tz);
  const month = monthStart(t, tz);
  if (user.role === 'agent') {
    const me = D.getUser(user.id);
    const { profit: _p, ...todaySales } = sales(today, me.id);
    const { profit: _m, ...monthSales } = sales(month, me.id);
    return {
      balance: round(me.balance), creditLimit: round(me.credit_limit), available: round(me.balance + me.credit_limit),
      lines: lineCounts(me.id), today: todaySales, month: monthSales,
      openTasks: q("SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status = 'open'").get(me.id).n,
      sims: q("SELECT COUNT(*) AS n FROM sims WHERE agent_id = ? AND status = 'available'").get(me.id).n,
    };
  }
  const agents = q("SELECT COUNT(*) AS n, COALESCE(SUM(balance), 0) AS b, COALESCE(SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END), 0) AS debt FROM users WHERE role = 'agent'").get();
  return {
    agents: agents.n, balances: round(agents.b), debt: round(agents.debt),
    lines: lineCounts(null), today: sales(today, null), month: sales(month, null),
    openTasks: q("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").get().n,
    sims: q("SELECT COUNT(*) AS n FROM sims WHERE status = 'available'").get().n,
  };
});

// Daily operation counts for the activity chart, bucketed in the viewer's time zone.
route('GET', '/api/activity', ANY, ({ user, query }) => {
  const tz = tzFrom(query);
  const days = Math.min(90, Math.max(7, Number(query.days) || 30));
  const end = dayStart(now(), tz) + 864e5;
  const start = end - days * 864e5;
  const agentId = user.role === 'agent' ? user.id : Number(query.agentId) || null;
  const rows = q(`SELECT ts, type FROM ops WHERE ts >= ? AND ts < ?
                  AND type IN ('activate','renew','swap_sim','freeze','unfreeze','disconnect','port_done','esim_done')
                  ${agentId ? 'AND agent_id = ?' : ''}`).all(start, end, ...(agentId ? [agentId] : []));
  const series = Array.from({ length: days }, (_, i) => ({ ts: start + i * 864e5, activate: 0, renew: 0, swap_sim: 0, other: 0, total: 0 }));
  const totals = { activate: 0, renew: 0, swap_sim: 0, other: 0, total: 0 };
  for (const r of rows) {
    const d = series[Math.floor((r.ts - start) / 864e5)];
    if (!d) continue;
    const k = ['activate', 'renew', 'swap_sim'].includes(r.type) ? r.type : 'other';
    d[k]++; d.total++;
    totals[k]++; totals.total++;
  }
  return { days: series, totals };
});

route('GET', '/api/search', ANY, ({ user, query }) => {
  const term = str(query.q, 40);
  if (term.length < 2) return { lines: [], agents: [], sims: [] };
  const digits = term.replace(/\D/g, '');
  const like = `%${term}%`;
  const likeDigits = digits.length >= 3 ? `%${digits.replace(/^(972|970)/, '')}%` : like;
  const mine = user.role === 'agent';
  const lines = q(`${D.LINE_SELECT} WHERE (l.number LIKE ? OR l.sim LIKE ? OR l.customer_name LIKE ?) ${mine ? 'AND l.agent_id = ?' : ''}
                   ORDER BY l.status = 'disconnected', l.activated_at DESC LIMIT 8`)
    .all(likeDigits, likeDigits, like, ...(mine ? [user.id] : []))
    .map((l) => D.lineView(l, user.role));
  const agents = mine ? [] : q("SELECT * FROM users WHERE role = 'agent' AND (name LIKE ? OR username LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 5")
    .all(like, like, likeDigits).map(D.publicUser);
  const sims = digits.length >= 4
    ? q(`SELECT s.id, s.iccid, s.status, c.name AS company_name, u.name AS agent_name FROM sims s
         LEFT JOIN companies c ON c.id = s.company_id LEFT JOIN users u ON u.id = s.agent_id
         WHERE s.iccid LIKE ? ${mine ? 'AND s.agent_id = ?' : ''} LIMIT 5`).all(`%${digits}%`, ...(mine ? [user.id] : []))
      .map((s) => ({ id: s.id, iccid: s.iccid, status: s.status, companyName: s.company_name || '', agentName: s.agent_name || '' }))
    : [];
  return { lines, agents, sims };
});

route('GET', '/api/ops', ANY, ({ user, query }) => {
  const args = [];
  let where = '1=1';
  const agentId = user.role === 'agent' ? user.id : Number(query.agentId) || null;
  if (agentId) { where += ' AND agent_id = ?'; args.push(agentId); }
  if (query.type) { where += ' AND type = ?'; args.push(String(query.type)); }
  if (query.types) {
    const types = String(query.types).split(',').filter((x) => /^[a-z_]+$/.test(x)).slice(0, 20);
    if (types.length) { where += ` AND type IN (${types.map(() => '?').join(',')})`; args.push(...types); }
  }
  if (query.money === '1') where += ' AND amount != 0';
  if (query.lineId) { where += ' AND line_id = ?'; args.push(Number(query.lineId)); }
  if (query.from) { where += ' AND ts >= ?'; args.push(Number(query.from)); }
  if (query.to) { where += ' AND ts < ?'; args.push(Number(query.to)); }
  const limit = Math.min(Number(query.limit) || 200, 2000);
  return q(`SELECT * FROM ops WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ${limit}`).all(...args).map(D.opView(user.role));
});

// ----- notifications -----
route('GET', '/api/notifications', ANY, ({ user }) => {
  const s = getSettings();
  const t = now();
  const warn = s.warnDays * 864e5;
  const items = q(`SELECT * FROM notifications WHERE user_id = ? OR (user_id IS NULL AND role = ?) ORDER BY ts DESC, id DESC LIMIT 40`)
    .all(user.id, user.role)
    .map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, ts: n.ts, unread: n.ts > user.notif_seen_at }));
  const alerts = [];
  const numbers = { one: 'رقم واحد', two: 'رقمان', few: 'أرقام', many: 'رقماً' };
  const agentWhere = user.role === 'agent' ? 'AND agent_id = ?' : '';
  const a = user.role === 'agent' ? [user.id] : [];
  const expiring = q(`SELECT COUNT(*) AS n FROM lines WHERE status = 'active' AND expires_at BETWEEN ? AND ? ${agentWhere}`).get(t, t + warn, ...a).n;
  const expired = q(`SELECT COUNT(*) AS n FROM lines WHERE status = 'active' AND expires_at < ? AND expires_at > ? ${agentWhere}`).get(t, t - 30 * 864e5, ...a).n;
  let tasks;
  if (user.role === 'agent') {
    const me = D.getUser(user.id);
    const available = me.balance + me.credit_limit;
    if (s.lowBalance > 0 && available < s.lowBalance) {
      alerts.push({ kind: 'balance', title: 'رصيدك منخفض', body: `المتاح ${round(available)} ₪. اطلب شحن الرصيد قبل نفاده.`, link: '#/payments' });
    }
    tasks = expiring + q("SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status = 'open'").get(user.id).n;
  } else {
    const open = q("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").get().n;
    if (open) alerts.push({ kind: 'tasks', title: `${arCount(open, { one: 'طلب واحد', two: 'طلبان', few: 'طلبات', many: 'طلباً' })} بانتظارك`, body: 'شحن رصيد، تحويل أرقام وeSIM', link: '#/tasks' });
    if (s.lowBalance > 0) {
      const low = q("SELECT COUNT(*) AS n FROM users WHERE role = 'agent' AND active = 1 AND balance + credit_limit < ?").get(s.lowBalance).n;
      if (low) alerts.push({ kind: 'balance', title: `${arCount(low, { one: 'وكيل واحد', two: 'وكيلان', few: 'وكلاء', many: 'وكيلاً' })} برصيد منخفض`, body: `أقل من ${s.lowBalance} ₪`, link: '#/agents' });
    }
    tasks = open;
  }
  if (expiring) alerts.push({ kind: 'expiring', title: `${arCount(expiring, numbers)} ${expiring === 1 ? 'ينتهي' : 'تنتهي'} خلال ${s.warnDays} أيام`, body: 'مدّدها قبل أن تُفصل', link: '#/subscribers?state=expiring' });
  if (expired) alerts.push({ kind: 'expired', title: `${arCount(expired, numbers)} ${expired === 1 ? 'انتهى' : 'انتهت'} ولم ${expired === 1 ? 'يُمدَّد' : 'تُمدَّد'}`, body: 'آخر 30 يوماً', link: '#/subscribers?state=expired' });
  const unread = items.filter((i) => i.unread).length;
  return { unread, alerts, items, badges: { bell: unread + alerts.length, tasks } };
});

route('POST', '/api/notifications/seen', ANY, ({ user }) => {
  q('UPDATE users SET notif_seen_at = ? WHERE id = ?').run(now(), user.id);
  return { ok: true };
});

module.exports = { lineCounts };
