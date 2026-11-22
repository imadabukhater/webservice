'use strict';
// The manager's home: eSIM sales (paid shop orders), what waits for the manager, the activity chart and notifications.
const { q } = require('../db');
const { now, round, dayStart, monthStart, tzFrom, arCount } = require('../util');
const { route, ADMIN } = require('../router');

// Paid eSIM orders since a moment: how many and how much the customers paid.
function sales(from) {
  const r = q("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS revenue FROM shop_orders WHERE status = 'paid' AND paid_at >= ?").get(from);
  return { sales: r.n || 0, revenue: round(r.revenue) };
}
const pendingActivations = () => q("SELECT COUNT(*) AS n FROM tasks WHERE type = 'esim' AND status = 'open' AND auto_status NOT IN ('sending','sent')").get().n;
const shopOpen = () => q("SELECT COUNT(*) AS n FROM shop_orders WHERE status IN ('verifying','review') OR (status = 'paid' AND line_id IS NULL)").get().n;

route('GET', '/api/dashboard', ADMIN, ({ query }) => {
  const tz = tzFrom(query);
  const t = now();
  return {
    today: sales(dayStart(t, tz)),
    month: sales(monthStart(t, tz)),
    buyers: q("SELECT COUNT(*) AS n FROM shop_orders WHERE status = 'paid'").get().n,
    pendingActivations: pendingActivations(),
    shopOpen: shopOpen(),
  };
});

// Daily eSIM sales for the activity chart, bucketed in the viewer's time zone (renew and swap_sim stay 0).
route('GET', '/api/activity', ADMIN, ({ query }) => {
  const tz = tzFrom(query);
  const days = Math.min(90, Math.max(7, Number(query.days) || 30));
  const end = dayStart(now(), tz) + 864e5;
  const start = end - days * 864e5;
  const rows = q("SELECT paid_at AS ts FROM shop_orders WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?").all(start, end);
  const series = Array.from({ length: days }, (_, i) => ({ ts: start + i * 864e5, activate: 0, renew: 0, swap_sim: 0, other: 0, total: 0 }));
  const totals = { activate: 0, renew: 0, swap_sim: 0, other: 0, total: 0 };
  for (const r of rows) {
    const d = series[Math.floor((r.ts - start) / 864e5)];
    if (!d) continue;
    d.activate++; d.total++;
    totals.activate++; totals.total++;
  }
  return { days: series, totals };
});

// ----- notifications -----
route('GET', '/api/notifications', ADMIN, ({ user }) => {
  const items = q('SELECT * FROM notifications WHERE user_id = ? OR (user_id IS NULL AND role = ?) ORDER BY ts DESC, id DESC LIMIT 40')
    .all(user.id, 'admin')
    .map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, ts: n.ts, unread: n.ts > user.notif_seen_at }));
  const alerts = [];
  // What waits for the manager: eSIM activations no supplier is carrying out right now, and shop orders to check.
  const tasks = pendingActivations();
  if (tasks) alerts.push({ kind: 'tasks', title: `${arCount(tasks, { one: 'تفعيل واحد', two: 'تفعيلان', few: 'تفعيلات', many: 'تفعيلاً' })} بانتظارك`, body: 'تفعيل eSIM لطلبات مدفوعة', link: '#/tasks' });
  const shop = shopOpen();
  if (shop) alerts.push({ kind: 'shop', title: `${arCount(shop, { one: 'طلب واحد', two: 'طلبان', few: 'طلبات', many: 'طلباً' })} في المتجر بانتظارك`, body: 'تحقق من دفع أو تنفيذ', link: '#/shop' });
  const unread = items.filter((i) => i.unread).length;
  return { unread, alerts, items, badges: { bell: unread + alerts.length, tasks, shop } };
});

route('POST', '/api/notifications/seen', ADMIN, ({ user }) => {
  q('UPDATE users SET notif_seen_at = ? WHERE id = ?').run(now(), user.id);
  return { ok: true };
});

module.exports = {};
