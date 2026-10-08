'use strict';
const { q, tx } = require('../db');
const { fail, now, round, str, num, isBlank, addMonths, imageOrEmpty } = require('../util');
const D = require('../domain');
const { route, ADMIN, ANY } = require('../router');

const TYPE_LABEL = { topup: 'طلب شحن رصيد', port: 'تحويل رقم', esim: 'تفعيل eSIM', general: 'طلب عام' };

const taskView = (t) => ({
  id: t.id, type: t.type, status: t.status, agentId: t.agent_id, agentName: t.agent_name || '',
  lineId: t.line_id, lineNumber: t.line_number || '', linePackage: t.line_package || '',
  amount: t.amount === null ? null : round(t.amount), note: t.note, response: t.response,
  hasAttachment: !!t.has_attachment, createdAt: t.created_at, resolvedAt: t.resolved_at, resolvedBy: t.resolved_by,
});

const TASK_SELECT = `SELECT t.id, t.type, t.status, t.agent_id, t.line_id, t.amount, t.note, t.response, (t.attachment != '') AS has_attachment,
  t.created_at, t.resolved_at, t.resolved_by, u.name AS agent_name, l.number AS line_number, l.package_label AS line_package
  FROM tasks t LEFT JOIN users u ON u.id = t.agent_id LEFT JOIN lines l ON l.id = t.line_id`;

function getTask(id, user) {
  const t = q('SELECT * FROM tasks WHERE id = ?').get(Number(id));
  if (!t || (user.role === 'agent' && t.agent_id !== user.id)) fail(404, 'الطلب غير موجود');
  return t;
}

route('GET', '/api/tasks', ANY, ({ user, query }) => {
  const args = [];
  let where = '1=1';
  if (user.role === 'agent') { where += ' AND t.agent_id = ?'; args.push(user.id); }
  else if (query.agentId) { where += ' AND t.agent_id = ?'; args.push(Number(query.agentId)); }
  if (query.status === 'open') where += " AND t.status = 'open'";
  else if (query.status === 'closed') where += " AND t.status != 'open'";
  if (query.type) { where += ' AND t.type = ?'; args.push(String(query.type)); }
  return q(`${TASK_SELECT} WHERE ${where} ORDER BY t.status = 'open' DESC, t.created_at DESC, t.id DESC LIMIT 500`).all(...args).map(taskView);
});

route('GET', '/api/tasks/:id', ANY, ({ user, params }) => {
  const t = getTask(params.id, user);
  const row = q(`${TASK_SELECT} WHERE t.id = ?`).get(t.id);
  return { ...taskView(row), attachment: t.attachment };
});

// Agents ask the manager for a top-up (with an optional receipt photo) or anything else.
route('POST', '/api/tasks', ANY, ({ user, body }) => {
  if (user.role !== 'agent') fail(400, 'الطلبات يرسلها الوكلاء');
  const type = String(body.type);
  if (!['topup', 'general'].includes(type)) fail(400, 'نوع الطلب غير معروف');
  let amount = null;
  if (type === 'topup') {
    amount = num(body.amount, 'المبلغ');
    if (!(amount > 0)) fail(400, 'أدخل مبلغاً أكبر من صفر');
  }
  const note = str(body.note, 500);
  if (type === 'general' && !note) fail(400, 'اكتب تفاصيل الطلب');
  const attachment = imageOrEmpty(body.attachment, { maxKb: 1500, label: 'المرفق' });
  const id = Number(q('INSERT INTO tasks (type, agent_id, amount, note, attachment, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(type, user.id, amount, note, attachment, now()).lastInsertRowid);
  D.notify({
    role: 'admin', kind: 'task', link: '#/tasks',
    title: type === 'topup' ? `طلب شحن ${amount} ₪ من ${user.name}` : `طلب جديد من ${user.name}`,
    body: note.slice(0, 120),
  });
  return { id };
}, { maxBody: 2200 * 1024 });

route('POST', '/api/tasks/:id/cancel', ANY, ({ user, params }) => {
  const t = getTask(params.id, user);
  if (t.status !== 'open') fail(400, 'تمت معالجة هذا الطلب من قبل');
  if (!['topup', 'general'].includes(t.type)) fail(400, 'طلبات التفعيل يلغيها المدير');
  q("UPDATE tasks SET status = 'rejected', response = 'أُلغي الطلب', resolved_at = ?, resolved_by = ? WHERE id = ?").run(now(), user.name, t.id);
  return { ok: true };
});

// The manager completes or rejects a request. Rejected activations are refunded in full.
route('POST', '/api/tasks/:id/resolve', ADMIN, ({ user, params, body }) => tx(() => {
  const t = getTask(params.id, user);
  if (t.status !== 'open') fail(400, 'تمت معالجة هذا الطلب من قبل');
  const status = body.status === 'rejected' ? 'rejected' : 'done';
  const response = str(body.response, 500);
  const agent = t.agent_id ? D.getUser(t.agent_id) : null;
  const ts = now();
  let amount = t.amount;

  if (t.type === 'topup' && status === 'done') {
    amount = isBlank(body.amount) ? t.amount : num(body.amount, 'المبلغ');
    if (!(amount > 0)) fail(400, 'أدخل مبلغاً أكبر من صفر');
    D.changeBalance(agent, amount, { type: 'topup', actor: user, detail: `طلب شحن رقم ${t.id}${response ? ' · ' + response : ''}` });
  }

  if ((t.type === 'port' || t.type === 'esim') && t.line_id) {
    const l = q('SELECT * FROM lines WHERE id = ?').get(t.line_id);
    if (l && l.status === 'pending') {
      const what = t.type === 'port' ? 'تحويل الرقم' : 'eSIM';
      if (status === 'done') {
        const esimQr = t.type === 'esim' ? imageOrEmpty(body.attachment, { maxKb: 600, label: 'رمز QR' }) : '';
        const esimCode = t.type === 'esim' ? str(body.esimCode, 500) : '';
        q("UPDATE lines SET status = 'active', activated_at = ?, expires_at = ?, esim_code = ?, esim_qr = ?, updated_at = ? WHERE id = ?")
          .run(ts, addMonths(ts, l.months), esimCode, esimQr, ts, l.id);
        D.logLineOp(t.type === 'port' ? 'port_done' : 'esim_done', l, agent, user, response || `تم ${what}`, { package: l.package_label });
      } else {
        D.changeBalance(agent, l.price, {
          type: 'refund', actor: user, lineId: l.id, number: l.number, cost: -l.cost, profit: -(l.price - l.cost), package: l.package_label,
          detail: `رفض ${what}${response ? ' · ' + response : ''}`,
        });
        q("UPDATE sims SET status = 'available', line_id = NULL, used_at = NULL WHERE line_id = ?").run(l.id);
        q('DELETE FROM lines WHERE id = ?').run(l.id);
      }
    }
  }

  q('UPDATE tasks SET status = ?, response = ?, amount = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
    .run(status, response, amount, ts, user.name, t.id);
  if (agent) {
    const label = TYPE_LABEL[t.type];
    D.notify({
      userId: agent.id, kind: 'task', link: t.type === 'esim' || t.type === 'port' ? '#/subscribers' : '#/tasks',
      title: status === 'done'
        ? (t.type === 'topup' ? `تم شحن رصيدك بـ ${round(amount)} ₪` : `تم تنفيذ ${label}`)
        : `رُفض ${label}`,
      body: response,
    });
  }
  return { ok: true };
}), { maxBody: 1100 * 1024 });

module.exports = { TYPE_LABEL };
