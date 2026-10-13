'use strict';
const { q, tx, getSettings } = require('../db');
const { fail, round } = require('../util');
const { route, ADMIN, ANY } = require('../router');

// Get next invoice number
function getNextInvoiceNumber() {
  const last = q('SELECT invoice_number FROM invoices ORDER BY id DESC LIMIT 1').get();
  if (!last) return 'INV-1001';
  const num = parseInt(last.invoice_number.replace('INV-', '')) + 1;
  return `INV-${num}`;
}

// List invoices (filtered for agents, all for admin)
route('GET', '/api/invoices', ANY, ({ user }) => {
  const invoices = user.role === 'admin'
    ? q('SELECT i.*, u.name as agent_name FROM invoices i LEFT JOIN users u ON i.agent_id = u.id ORDER BY i.id DESC').all()
    : q('SELECT i.*, u.name as agent_name FROM invoices i LEFT JOIN users u ON i.agent_id = u.id WHERE i.agent_id = ? ORDER BY i.id DESC').all(user.id);

  return invoices.map((inv) => ({
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    agentId: inv.agent_id,
    agentName: inv.agent_name,
    amount: inv.amount,
    description: inv.description,
    status: inv.status,
    issueDate: inv.issue_date,
    dueDate: inv.due_date,
    paidDate: inv.paid_date,
    notes: inv.notes,
  }));
});

// Get single invoice
route('GET', '/api/invoices/:id', ANY, ({ user, params: { id } }) => {
  const inv = q('SELECT i.*, u.name as agent_name FROM invoices i LEFT JOIN users u ON i.agent_id = u.id WHERE i.id = ?').get(id);
  if (!inv) fail(404, 'الفاتورة غير موجودة');
  if (user.role !== 'admin' && inv.agent_id !== user.id) fail(403, 'غير مصرح لك');

  return {
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    agentId: inv.agent_id,
    agentName: inv.agent_name,
    amount: inv.amount,
    description: inv.description,
    status: inv.status,
    issueDate: inv.issue_date,
    dueDate: inv.due_date,
    paidDate: inv.paid_date,
    notes: inv.notes,
  };
});

// Create invoice (admin only)
route('POST', '/api/invoices', ADMIN, ({ body }) => {
  const { agentId, amount, description, dueDate, notes } = body;

  if (!agentId || amount === undefined) fail(400, 'معرّف الوكيل والمبلغ مطلوب');
  if (amount <= 0) fail(400, 'المبلغ يجب أن يكون أكبر من صفر');

  const agent = q('SELECT id FROM users WHERE id = ?').get(agentId);
  if (!agent) fail(404, 'الوكيل غير موجود');

  const invoiceNumber = getNextInvoiceNumber();
  const now = Date.now();

  const id = tx(() => {
    q('INSERT INTO invoices (invoice_number, agent_id, amount, description, status, issue_date, due_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(invoiceNumber, agentId, amount, description || '', 'pending', now, dueDate || null, notes || '');
    return q('SELECT last_insert_rowid() as id').get().id;
  });

  return { id, invoiceNumber };
});

// Update invoice (admin only)
route('PUT', '/api/invoices/:id', ADMIN, ({ body, params: { id } }) => {
  const { amount, description, dueDate, notes } = body;

  const inv = q('SELECT status FROM invoices WHERE id = ?').get(id);
  if (!inv) fail(404, 'الفاتورة غير موجودة');
  if (inv.status !== 'pending') fail(400, 'لا يمكن تعديل فاتورة غير معلقة');

  if (amount !== undefined && amount <= 0) fail(400, 'المبلغ يجب أن يكون أكبر من صفر');

  tx(() => {
    q('UPDATE invoices SET amount = COALESCE(?, amount), description = COALESCE(?, description), due_date = COALESCE(?, due_date), notes = COALESCE(?, notes) WHERE id = ?')
      .run(amount, description, dueDate, notes, id);
  });

  return { ok: true };
});

// Mark invoice as paid (admin only)
route('POST', '/api/invoices/:id/pay', ADMIN, ({ body, params: { id } }) => {
  const inv = q('SELECT agent_id, amount, status FROM invoices WHERE id = ?').get(id);
  if (!inv) fail(404, 'الفاتورة غير موجودة');
  if (inv.status === 'paid') fail(400, 'الفاتورة مدفوعة بالفعل');
  if (inv.status === 'rejected') fail(400, 'لا يمكن دفع فاتورة مرفوضة');

  tx(() => {
    q('UPDATE invoices SET status = ?, paid_date = ? WHERE id = ?')
      .run('paid', Date.now(), id);
  });

  return { ok: true };
});

// Reject invoice (admin only)
route('POST', '/api/invoices/:id/reject', ADMIN, ({ body, params: { id } }) => {
  const inv = q('SELECT status FROM invoices WHERE id = ?').get(id);
  if (!inv) fail(404, 'الفاتورة غير موجودة');
  if (inv.status !== 'pending') fail(400, 'لا يمكن رفض فاتورة غير معلقة');

  tx(() => {
    q('UPDATE invoices SET status = ? WHERE id = ?')
      .run('rejected', id);
  });

  return { ok: true };
});

// Delete invoice (admin only, pending only)
route('DELETE', '/api/invoices/:id', ADMIN, ({ body, params: { id } }) => {
  const inv = q('SELECT status FROM invoices WHERE id = ?').get(id);
  if (!inv) fail(404, 'الفاتورة غير موجودة');
  if (inv.status !== 'pending') fail(400, 'يمكن حذف الفواتير المعلقة فقط');

  tx(() => {
    q('DELETE FROM invoices WHERE id = ?').run(id);
  });

  return { ok: true };
});

module.exports = {};
