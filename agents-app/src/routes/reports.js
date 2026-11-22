'use strict';
// The manager's reports on eSIM sales: each paid shop order is a sale (its customer's payment), its line the eSIM.
const { q } = require('../db');
const { fail, now, round } = require('../util');
const D = require('../domain');
const { route, ADMIN } = require('../router');

// Column types tell the client how to format, filter and export: text, phone, iccid, date, datetime, money, num.
const col = (key, label, type = 'text') => ({ key, label, type });

const PAID = `FROM shop_orders o LEFT JOIN lines l ON l.id = o.line_id LEFT JOIN packages p ON p.id = o.package_id
  LEFT JOIN companies c ON c.id = p.company_id WHERE o.status = 'paid' AND o.paid_at >= ? AND o.paid_at < ?`;

// Each report: title, group, whether it takes a date range, and a builder.
const REPORTS = [
  {
    key: 'sales', group: 'المبيعات', title: 'مبيعات eSIM', dated: true,
    build(p) {
      const rows = q(`SELECT o.*, l.status AS line_status, l.cost AS line_cost, c.name AS company_name ${PAID} ORDER BY o.paid_at DESC LIMIT 5000`).all(p.from, p.to);
      return {
        columns: [col('ts', 'تاريخ الدفع', 'datetime'), col('code', 'رقم الطلب'), col('number', 'رقم الهاتف', 'phone'), col('customer', 'اسم الزبون'),
          col('email', 'البريد'), col('company', 'شركة الاتصالات'), col('package', 'اسم الرزمة'), col('amount', 'المبلغ', 'money'),
          col('cost', 'التكلفة', 'money'), col('profit', 'الربح', 'money'), col('state', 'الحالة')],
        rows: rows.map((o) => ({
          ts: o.paid_at, code: o.code, number: o.number, customer: o.customer_name, email: o.email, company: o.company_name || '', package: o.package_label,
          amount: round(o.amount), cost: o.line_cost === null ? null : round(o.line_cost),
          profit: o.line_cost === null ? null : round(o.amount - o.line_cost),
          state: o.line_status === 'active' ? 'مفعّل' : o.line_status === 'pending' ? 'قيد التفعيل' : 'لم يُنفَّذ',
        })),
      };
    },
  },
  {
    key: 'by_package', group: 'المبيعات', title: 'المبيعات حسب الرزمة', dated: true,
    build(p) {
      const rows = q(`SELECT o.package_label AS package, COUNT(*) AS sales, SUM(o.amount) AS revenue, SUM(l.cost) AS cost ${PAID}
                      GROUP BY o.package_label ORDER BY revenue DESC`).all(p.from, p.to);
      return {
        columns: [col('package', 'اسم الرزمة'), col('sales', 'المبيعات', 'num'), col('revenue', 'المبلغ', 'money'), col('cost', 'التكلفة', 'money'),
          col('profit', 'الربح', 'money')],
        rows: rows.map((r) => ({ package: r.package, sales: r.sales || 0, revenue: round(r.revenue), cost: round(r.cost), profit: round(r.revenue - r.cost) })),
      };
    },
  },
  {
    key: 'pending', group: 'التفعيل', title: 'eSIM قيد التفعيل',
    build() {
      const rows = q(`${D.LINE_SELECT} WHERE l.status = 'pending' ORDER BY l.activated_at DESC LIMIT 5000`).all();
      return {
        columns: [col('activated', 'تاريخ البيع', 'datetime'), col('number', 'رقم الهاتف', 'phone'), col('customer', 'اسم الزبون'),
          col('company', 'شركة الاتصالات'), col('package', 'اسم الرزمة'), col('price', 'المبلغ', 'money')],
        rows: rows.map((l) => ({ activated: l.activated_at, number: l.number, customer: l.customer_name, company: l.company_name || '',
          package: l.package_label, price: round(l.price) })),
      };
    },
  },
];

route('GET', '/api/reports', ADMIN, () => REPORTS.map((r) => ({ key: r.key, title: r.title, group: r.group, dated: !!r.dated })));

route('GET', '/api/reports/:key', ADMIN, ({ params, query }) => {
  const r = REPORTS.find((x) => x.key === params.key);
  if (!r) fail(404, 'التقرير غير موجود');
  const to = Number(query.to) || now() + 864e5;
  const from = Number(query.from) || to - 31 * 864e5;
  return { key: r.key, title: r.title, dated: !!r.dated, ...r.build({ from, to }) };
});
