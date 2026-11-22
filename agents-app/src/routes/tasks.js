'use strict';
// eSIM activations the manager carries out (or a supplier, see autoexec.js): one task per eSIM sold in the shop
// (sale.js). Done: the line is active with its QR code. Rejected: the line is removed and the shop order says why.
const { q, tx } = require('../db');
const { sourceOf } = require('../privacy');
const { fail, now, round, str, periodEnd, imageOrEmpty } = require('../util');
const { route, ADMIN } = require('../router');

const TYPE_LABEL = { esim: 'تفعيل eSIM' };

const taskView = (t) => ({
  id: t.id, type: t.type, status: t.status,
  lineId: t.line_id, lineNumber: t.line_number || '', linePackage: t.line_package || '',
  amount: t.amount === null ? null : round(t.amount), note: t.note, response: t.response,
  hasAttachment: !!t.has_attachment, createdAt: t.created_at, resolvedAt: t.resolved_at, resolvedBy: t.resolved_by,
  autoStatus: t.auto_status || '', autoNote: t.auto_note || '', source: t.package_ref === null ? '' : sourceOf(t.package_ref),
});

const TASK_SELECT = `SELECT t.id, t.type, t.status, t.line_id, t.amount, t.note, t.response, (t.attachment != '') AS has_attachment,
  t.created_at, t.resolved_at, t.resolved_by, t.auto_status, t.auto_note, l.number AS line_number, l.package_label AS line_package,
  (SELECT art_card_id FROM packages WHERE id = l.package_id) AS package_ref
  FROM tasks t LEFT JOIN lines l ON l.id = t.line_id`;

function getTask(id) {
  const t = q("SELECT * FROM tasks WHERE id = ? AND type = 'esim'").get(Number(id));
  if (!t) fail(404, 'الطلب غير موجود');
  return t;
}

route('GET', '/api/tasks', ADMIN, ({ query }) => {
  let where = "t.type = 'esim'";
  if (query.status === 'open') where += " AND t.status = 'open'";
  else if (query.status === 'closed') where += " AND t.status != 'open'";
  else if (['done', 'rejected'].includes(query.status)) where += ` AND t.status = '${query.status}'`;
  return q(`${TASK_SELECT} WHERE ${where} ORDER BY t.status = 'open' DESC, t.created_at DESC, t.id DESC LIMIT 500`).all().map(taskView);
});

route('GET', '/api/tasks/:id', ADMIN, ({ params }) => {
  const t = getTask(params.id);
  const row = q(`${TASK_SELECT} WHERE t.id = ?`).get(t.id);
  return { ...taskView(row), attachment: t.attachment };
});

// The manager completes or rejects an activation.
route('POST', '/api/tasks/:id/resolve', ADMIN, ({ user, params, body }) => tx(() => {
  const t = getTask(params.id);
  // While it is being sent, carrying it out by hand would do it twice; once sent, the supplier may still deliver it.
  if (t.auto_status === 'sending') fail(409, 'يُرسَل الآن إلى المورّد — انتظر ثوانيَ ثم أعد المحاولة');
  if (body.status === 'rejected' && t.auto_status === 'sent') {
    fail(409, 'التنفيذ التلقائي جارٍ الآن عند المورّد — انتظر نتيجته قبل الرفض');
  }
  return resolveTask(t, user, body);
}),
  { maxBody: 1100 * 1024 });

// Runs inside the caller's transaction. user: { name } of whoever carried it out (the manager, or a supplier's actor).
function resolveTask(t, user, body) {
  if (t.status !== 'open') fail(400, 'تمت معالجة هذا الطلب من قبل');
  const status = body.status === 'rejected' ? 'rejected' : 'done';
  const response = str(body.response, 500);
  const ts = now();
  const l = t.line_id ? q('SELECT * FROM lines WHERE id = ?').get(t.line_id) : null;
  if (l && l.status === 'pending') {
    if (status === 'done') {
      const esimQr = imageOrEmpty(body.attachment, { maxKb: 600, label: 'رمز QR' });
      const esimCode = str(body.esimCode, 500);
      q("UPDATE lines SET status = 'active', activated_at = ?, expires_at = ?, esim_code = COALESCE(NULLIF(?, ''), esim_code), esim_qr = COALESCE(NULLIF(?, ''), esim_qr), updated_at = ? WHERE id = ?")
        .run(ts, periodEnd(ts, l.months, l.days), esimCode, esimQr, ts, l.id);
    } else {
      q("UPDATE shop_orders SET line_id = NULL, error = 'رُفض التفعيل: ' || ?, updated_at = ? WHERE line_id = ?").run(response, ts, l.id);
      q('DELETE FROM lines WHERE id = ?').run(l.id);
    }
  }
  q('UPDATE tasks SET status = ?, response = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
    .run(status, response, ts, user?.name || '', t.id);
  return { ok: true };
}

module.exports = { TYPE_LABEL, resolveTask };
