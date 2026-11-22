'use strict';
// The record of everyone who bought an eSIM in the shop (paid orders), for the manager. Read only.
const { q } = require('../db');
const { fail, round, str } = require('../util');
const { route, ADMIN } = require('../router');

const SELECT = `SELECT o.*, l.status AS line_status, l.esim_qr AS line_qr, l.esim_code AS line_code, c.name AS company_name
  FROM shop_orders o LEFT JOIN lines l ON l.id = o.line_id LEFT JOIN packages p ON p.id = o.package_id
  LEFT JOIN companies c ON c.id = p.company_id`;

const view = (o) => ({
  id: o.id, code: o.code, customerName: o.customer_name, email: o.email, contactPhone: o.contact_phone, number: o.number,
  packageLabel: o.package_label, companyName: o.company_name || '', amount: round(o.amount), paidAt: o.paid_at,
  lineStatus: ['pending', 'active'].includes(o.line_status) ? o.line_status : null,
  hasQr: !!(o.line_qr || o.esim_qr),
});

route('GET', '/api/buyers', ADMIN, ({ query }) => {
  let where = "o.status = 'paid'";
  const args = [];
  const text = str(query.q, 80);
  if (text) {
    const like = `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const digits = text.replace(/\D/g, '');
    where += " AND (o.customer_name LIKE ? ESCAPE '\\' OR o.code LIKE ? ESCAPE '\\' OR o.email LIKE ? ESCAPE '\\' OR o.number LIKE ? ESCAPE '\\'"
      + (digits.length >= 3 ? ' OR o.number LIKE ? OR o.contact_phone LIKE ?' : '') + ')';
    args.push(like, like, like, like, ...(digits.length >= 3 ? [`%${digits}%`, `%${digits}%`] : []));
  }
  if (Number(query.from)) { where += ' AND o.paid_at >= ?'; args.push(Number(query.from)); }
  if (Number(query.to)) { where += ' AND o.paid_at < ?'; args.push(Number(query.to)); }
  return q(`${SELECT} WHERE ${where} ORDER BY o.paid_at DESC, o.id DESC LIMIT 5000`).all(...args).map(view);
});

route('GET', '/api/buyers/:id', ADMIN, ({ params }) => {
  const o = q(`${SELECT} WHERE o.id = ? AND o.status = 'paid'`).get(Number(params.id));
  if (!o) fail(404, 'غير موجود');
  return { ...view(o), esimQr: o.line_qr || o.esim_qr || null, esimCode: o.line_code || o.esim_code || null };
});
