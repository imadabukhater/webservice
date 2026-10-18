'use strict';
// Invoices the manager issues to agents: pending until marked paid or rejected.
const { q } = require('../db');
const { fail, now, round, str, num, dateOrNull } = require('../util');
const D = require('../domain');
const { route, ADMIN, ANY } = require('../router');

const SELECT = 'SELECT i.*, u.name AS agent_name FROM invoices i LEFT JOIN users u ON u.id = i.agent_id';

const invoiceView = (i) => ({
  id: i.id, invoiceNumber: i.invoice_number, agentId: i.agent_id, agentName: i.agent_name || '',
  amount: round(i.amount), description: i.description, status: i.status,
  issueDate: i.issue_date, dueDate: i.due_date, paidDate: i.paid_date, notes: i.notes,
});

function getInvoice(id, user) {
  const i = q(`${SELECT} WHERE i.id = ?`).get(Number(id));
  if (!i || (user.role === 'agent' && i.agent_id !== user.id)) fail(404, 'الفاتورة غير موجودة');
  return i;
}

function pending(id) {
  const i = q('SELECT * FROM invoices WHERE id = ?').get(Number(id));
  if (!i) fail(404, 'الفاتورة غير موجودة');
  if (i.status !== 'pending') fail(400, 'تمت معالجة هذه الفاتورة من قبل');
  return i;
}

function nextNumber() {
  const max = q("SELECT MAX(CAST(SUBSTR(invoice_number, 5) AS INTEGER)) AS n FROM invoices WHERE invoice_number LIKE 'INV-%'").get().n;
  return `INV-${Math.max(1000, max || 0) + 1}`;
}

function amountOf(v) {
  const a = num(v, 'المبلغ');
  if (!(a > 0)) fail(400, 'المبلغ يجب أن يكون أكبر من صفر');
  return a;
}

route('GET', '/api/invoices', ANY, ({ user }) => (user.role === 'admin'
  ? q(`${SELECT} ORDER BY i.id DESC LIMIT 2000`).all()
  : q(`${SELECT} WHERE i.agent_id = ? ORDER BY i.id DESC LIMIT 2000`).all(user.id)).map(invoiceView));

route('GET', '/api/invoices/:id', ANY, ({ user, params }) => invoiceView(getInvoice(params.id, user)));

route('POST', '/api/invoices', ADMIN, ({ body }) => {
  const agent = D.getAgent(body.agentId);
  const amount = amountOf(body.amount);
  const number = nextNumber();
  const id = Number(q('INSERT INTO invoices (invoice_number, agent_id, amount, description, issue_date, due_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(number, agent.id, amount, str(body.description, 300), now(), dateOrNull(body.dueDate), str(body.notes, 500)).lastInsertRowid);
  D.notify({ userId: agent.id, kind: 'balance', title: `فاتورة جديدة ${number}`, body: `${amount} ₪`, link: '#/invoices' });
  return invoiceView(q(`${SELECT} WHERE i.id = ?`).get(id));
});

route('PUT', '/api/invoices/:id', ADMIN, ({ params, body }) => {
  const i = pending(params.id);
  q('UPDATE invoices SET amount = ?, description = ?, due_date = ?, notes = ? WHERE id = ?').run(
    body.amount === undefined ? i.amount : amountOf(body.amount),
    body.description === undefined ? i.description : str(body.description, 300),
    body.dueDate === undefined ? i.due_date : dateOrNull(body.dueDate),
    body.notes === undefined ? i.notes : str(body.notes, 500), i.id);
  return invoiceView(q(`${SELECT} WHERE i.id = ?`).get(i.id));
});

route('POST', '/api/invoices/:id/pay', ADMIN, ({ params }) => {
  const i = pending(params.id);
  q("UPDATE invoices SET status = 'paid', paid_date = ? WHERE id = ?").run(now(), i.id);
  return { ok: true };
});

route('POST', '/api/invoices/:id/reject', ADMIN, ({ params }) => {
  const i = pending(params.id);
  q("UPDATE invoices SET status = 'rejected' WHERE id = ?").run(i.id);
  return { ok: true };
});

route('DELETE', '/api/invoices/:id', ADMIN, ({ params }) => {
  const i = pending(params.id);
  q('DELETE FROM invoices WHERE id = ?').run(i.id);
  return { ok: true };
});
