'use strict';
const { q, getSettings } = require('../db');
const { fail, now, round } = require('../util');
const D = require('../domain');
const { route, ANY } = require('../router');

// Column types tell the client how to format, filter and export: text, phone, iccid, date, datetime, money, num.
const col = (key, label, type = 'text') => ({ key, label, type });

const OP_LABEL = {
  activate: 'تفعيل', renew: 'تمديد', topup: 'شحن رصيد', deduct: 'خصم رصيد', transfer_in: 'رصيد وارد', transfer_out: 'رصيد صادر',
  refund: 'استرجاع', line_move: 'نقل رقم', line_delete: 'حذف خط', freeze: 'تجميد', unfreeze: 'إلغاء تجميد',
  disconnect: 'فصل', swap_sim: 'تبديل شريحة', port_done: 'تحويل رقم', esim_done: 'تفعيل eSIM',
};

function lineRows(user, p, where, args, order = 'l.activated_at DESC') {
  const agentId = user.role === 'agent' ? user.id : p.agentId;
  return q(`${D.LINE_SELECT} WHERE ${where} ${agentId ? 'AND l.agent_id = ?' : ''} ORDER BY ${order} LIMIT 5000`)
    .all(...args, ...(agentId ? [agentId] : []));
}

function opsRows(user, types, p, extra = '') {
  const mine = user.role === 'agent';
  const agentId = mine ? user.id : p.agentId;
  return q(`SELECT * FROM ops WHERE type IN (${types.map(() => '?').join(',')}) AND ts >= ? AND ts < ? ${extra}
            ${agentId ? 'AND agent_id = ?' : ''} ORDER BY ts DESC LIMIT 5000`)
    .all(...types, p.from, p.to, ...(agentId ? [agentId] : []));
}

const agentCol = (user) => (user.role === 'admin' ? [col('agent', 'الوكيل')] : []);
const daysLeft = (ts) => (ts ? Math.ceil((ts - now()) / 864e5) : null);

// Each report: title, group, who may run it, whether it takes a date range, and a builder.
const REPORTS = [
  {
    key: 'active', group: 'الأرقام', title: 'الأرقام الفعّالة',
    build(user, p) {
      const rows = lineRows(user, p, "l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at >= ?)", [now()]);
      return {
        columns: [col('number', 'رقم الهاتف', 'phone'), col('customer', 'اسم الزبون'), col('company', 'شركة الاتصالات'), col('package', 'اسم الرزمة'),
          col('sim', 'رقم الشريحة', 'iccid'), col('activated', 'تاريخ التفعيل', 'date'), col('expires', 'تاريخ نهاية الرزمة', 'date'),
          col('days', 'الأيام المتبقية', 'num'), ...agentCol(user)],
        rows: rows.map((l) => ({ number: l.number, customer: l.customer_name, company: l.company_name, package: l.package_label, sim: l.sim,
          activated: l.activated_at, expires: l.expires_at, days: daysLeft(l.expires_at), agent: l.agent_name })),
      };
    },
  },
  {
    key: 'expiring', group: 'الأرقام', title: 'شرائح بانتظار الفصل',
    build(user, p) {
      const t = now();
      const warn = getSettings().warnDays;
      const rows = lineRows(user, p, "l.status = 'active' AND l.expires_at BETWEEN ? AND ?", [t, t + warn * 864e5], 'l.expires_at ASC');
      return {
        subtitle: `تنتهي خلال ${warn} أيام`,
        columns: [col('expires', 'تاريخ نهاية الرزمة', 'date'), col('package', 'اسم الرزمة'), col('company', 'شركة الاتصالات'),
          col('number', 'رقم الهاتف', 'phone'), col('sim', 'رقم الشريحة', 'iccid'), col('customer', 'اسم الزبون'), col('days', 'الأيام المتبقية', 'num'),
          ...agentCol(user)],
        rows: rows.map((l) => ({ expires: l.expires_at, package: l.package_label, company: l.company_name, number: l.number, sim: l.sim,
          customer: l.customer_name, days: daysLeft(l.expires_at), agent: l.agent_name })),
      };
    },
  },
  {
    key: 'expired', group: 'الأرقام', title: 'أرقام انتهت ولم تُمدَّد',
    build(user, p) {
      const rows = lineRows(user, p, "l.status = 'active' AND l.expires_at < ?", [now()], 'l.expires_at DESC');
      return {
        columns: [col('expires', 'انتهت في', 'date'), col('number', 'رقم الهاتف', 'phone'), col('package', 'اسم الرزمة'), col('customer', 'اسم الزبون'),
          col('days', 'منذ (أيام)', 'num'), ...agentCol(user)],
        rows: rows.map((l) => ({ expires: l.expires_at, number: l.number, package: l.package_label, customer: l.customer_name,
          days: -daysLeft(l.expires_at), agent: l.agent_name })),
      };
    },
  },
  {
    key: 'frozen', group: 'الأرقام', title: 'الأرقام المجمّدة',
    build(user, p) {
      const rows = lineRows(user, p, "l.status = 'frozen'", [], 'l.updated_at DESC');
      return {
        columns: [col('number', 'رقم الهاتف', 'phone'), col('package', 'اسم الرزمة'), col('customer', 'اسم الزبون'), col('since', 'مجمّد منذ', 'date'),
          col('expires', 'تاريخ نهاية الرزمة', 'date'), ...agentCol(user)],
        rows: rows.map((l) => ({ number: l.number, package: l.package_label, customer: l.customer_name, since: l.updated_at, expires: l.expires_at, agent: l.agent_name })),
      };
    },
  },
  {
    key: 'pending', group: 'الأرقام', title: 'طلبات تحويل وeSIM قيد التنفيذ',
    build(user, p) {
      const rows = lineRows(user, p, "l.status = 'pending'", [], 'l.activated_at ASC');
      return {
        columns: [col('created', 'تاريخ الطلب', 'datetime'), col('number', 'رقم الهاتف', 'phone'), col('type', 'النوع'), col('package', 'اسم الرزمة'),
          col('customer', 'اسم الزبون'), ...agentCol(user)],
        rows: rows.map((l) => ({ created: l.activated_at, number: l.number, type: l.port ? 'تحويل رقم' : 'eSIM', package: l.package_label,
          customer: l.customer_name, agent: l.agent_name })),
      };
    },
  },
  {
    key: 'disconnected', group: 'الأرقام', title: 'الأرقام المفصولة',
    build(user, p) {
      const rows = lineRows(user, p, "l.status = 'disconnected'", [], 'l.updated_at DESC');
      return {
        columns: [col('number', 'رقم الهاتف', 'phone'), col('package', 'اسم الرزمة'), col('customer', 'اسم الزبون'), col('at', 'تاريخ الفصل', 'date'), ...agentCol(user)],
        rows: rows.map((l) => ({ number: l.number, package: l.package_label, customer: l.customer_name, at: l.updated_at, agent: l.agent_name })),
      };
    },
  },
  {
    key: 'activations', group: 'العمليات', title: 'التفعيلات', dated: true,
    build: (user, p) => saleReport(user, p, ['activate']),
  },
  {
    key: 'renewals', group: 'العمليات', title: 'التمديدات', dated: true,
    build: (user, p) => saleReport(user, p, ['renew']),
  },
  {
    key: 'swaps', group: 'العمليات', title: 'تبديل الشرائح', dated: true,
    build(user, p) {
      const rows = opsRows(user, ['swap_sim'], p);
      return {
        columns: [col('ts', 'التاريخ', 'datetime'), col('number', 'رقم الهاتف', 'phone'), col('detail', 'الشريحة القديمة ← الجديدة'),
          col('actor', 'نفّذها'), ...agentCol(user)],
        rows: rows.map((o) => ({ ts: o.ts, number: o.number, detail: o.detail, actor: o.actor_name, agent: o.agent_name })),
      };
    },
  },
  {
    key: 'line_actions', group: 'العمليات', title: 'التجميد والفصل', dated: true,
    build(user, p) {
      const rows = opsRows(user, ['freeze', 'unfreeze', 'disconnect'], p);
      return {
        columns: [col('ts', 'التاريخ', 'datetime'), col('type', 'العملية'), col('number', 'رقم الهاتف', 'phone'), col('detail', 'التفاصيل'),
          col('actor', 'نفّذها'), ...agentCol(user)],
        rows: rows.map((o) => ({ ts: o.ts, type: OP_LABEL[o.type], number: o.number, detail: o.detail, actor: o.actor_name, agent: o.agent_name })),
      };
    },
  },
  {
    key: 'statement', group: 'المالية', title: 'كشف حساب الرصيد', dated: true,
    build(user, p) {
      const types = ['activate', 'renew', 'topup', 'deduct', 'transfer_in', 'transfer_out', 'refund', 'line_move', 'line_delete'];
      const rows = opsRows(user, types, p, 'AND amount != 0');
      return {
        columns: [col('ts', 'التاريخ', 'datetime'), col('type', 'العملية'), col('detail', 'التفاصيل'), col('amount', 'المبلغ', 'money'),
          col('before', 'الرصيد قبل', 'money'), col('after', 'الرصيد بعد', 'money'), ...agentCol(user)],
        rows: rows.map((o) => ({ ts: o.ts, type: OP_LABEL[o.type] || o.type, detail: [o.number, o.package, o.detail].filter(Boolean).join(' · '),
          amount: round(o.amount), before: o.balance_before, after: o.balance_after, agent: o.agent_name })),
      };
    },
  },
  {
    key: 'by_package', group: 'المالية', title: 'المبيعات حسب الرزمة', dated: true,
    build(user, p) {
      const admin = user.role === 'admin';
      const agentId = admin ? p.agentId : user.id;
      const rows = q(`SELECT package, SUM(type = 'activate') AS activations, SUM(type = 'renew') AS renewals,
                        SUM(-amount) AS revenue, SUM(cost) AS cost, SUM(profit) AS profit
                      FROM ops WHERE type IN ('activate','renew','refund','line_delete') AND package != '' AND ts >= ? AND ts < ?
                      ${agentId ? 'AND agent_id = ?' : ''} GROUP BY package ORDER BY revenue DESC`).all(p.from, p.to, ...(agentId ? [agentId] : []));
      return {
        columns: [col('package', 'اسم الرزمة'), col('activations', 'تفعيلات', 'num'), col('renewals', 'تمديدات', 'num'),
          col('revenue', admin ? 'المبيعات' : 'المدفوع', 'money'), ...(admin ? [col('cost', 'التكلفة', 'money'), col('profit', 'الربح', 'money')] : [])],
        rows: rows.map((r) => ({ package: r.package, activations: r.activations || 0, renewals: r.renewals || 0, revenue: round(r.revenue),
          cost: round(r.cost), profit: round(r.profit) })),
      };
    },
  },
  {
    key: 'by_agent', group: 'المالية', title: 'أرباح الوكلاء', dated: true, admin: true,
    build(user, p) {
      const rows = q(`SELECT u.id, u.name, u.balance, u.credit_limit,
                        COALESCE(SUM(o.type = 'activate'), 0) AS activations, COALESCE(SUM(o.type = 'renew'), 0) AS renewals,
                        COALESCE(SUM(-o.amount), 0) AS revenue, COALESCE(SUM(o.cost), 0) AS cost, COALESCE(SUM(o.profit), 0) AS profit
                      FROM users u LEFT JOIN ops o ON o.agent_id = u.id AND o.type IN ('activate','renew','refund','line_delete') AND o.ts >= ? AND o.ts < ?
                      WHERE u.role = 'agent' GROUP BY u.id ORDER BY profit DESC`).all(p.from, p.to);
      return {
        columns: [col('agent', 'الوكيل'), col('activations', 'تفعيلات', 'num'), col('renewals', 'تمديدات', 'num'), col('revenue', 'المبيعات', 'money'),
          col('cost', 'التكلفة', 'money'), col('profit', 'الربح', 'money'), col('balance', 'الرصيد الحالي', 'money')],
        rows: rows.map((r) => ({ agent: r.name, activations: r.activations, renewals: r.renewals, revenue: round(r.revenue), cost: round(r.cost),
          profit: round(r.profit), balance: round(r.balance) })),
      };
    },
  },
  {
    key: 'my_margin', group: 'المالية', title: 'أرباحي من الزبائن', dated: true, agent: true,
    build(user, p) {
      const rows = opsRows(user, ['activate', 'renew'], p, 'AND customer_price IS NOT NULL');
      return {
        columns: [col('ts', 'التاريخ', 'datetime'), col('type', 'العملية'), col('number', 'رقم الهاتف', 'phone'), col('package', 'اسم الرزمة'),
          col('customer', 'سعر الزبون', 'money'), col('paid', 'دفعتُ', 'money'), col('margin', 'ربحي', 'money')],
        rows: rows.map((o) => ({ ts: o.ts, type: OP_LABEL[o.type], number: o.number, package: o.package, customer: round(o.customer_price),
          paid: round(-o.amount), margin: round(o.customer_price + o.amount) })),
      };
    },
  },
  {
    key: 'sims', group: 'المخزون', title: 'مخزون الشرائح',
    build(user, p) {
      const mine = user.role === 'agent';
      const rows = q(`SELECT s.*, c.name AS company_name, u.name AS agent_name, l.number AS line_number FROM sims s
                      LEFT JOIN companies c ON c.id = s.company_id LEFT JOIN users u ON u.id = s.agent_id LEFT JOIN lines l ON l.id = s.line_id
                      ${mine ? 'WHERE s.agent_id = ?' : ''} ORDER BY s.status, s.created_at DESC LIMIT 5000`).all(...(mine ? [user.id] : []));
      return {
        columns: [col('iccid', 'رقم الشريحة', 'iccid'), col('company', 'شركة الاتصالات'), col('status', 'الحالة'), col('number', 'الرقم المرتبط', 'phone'),
          col('added', 'تاريخ الإضافة', 'date'), ...(mine ? [] : [col('agent', 'الوكيل')])],
        rows: rows.map((s) => ({ iccid: s.iccid, company: s.company_name || 'غير محددة', status: s.status === 'available' ? 'متاحة' : 'مستعملة',
          number: s.line_number || '', added: s.created_at, agent: s.agent_name || 'مخزن المدير' })),
      };
    },
  },
];

function saleReport(user, p, types) {
  const admin = user.role === 'admin';
  const rows = opsRows(user, types, p);
  return {
    columns: [col('ts', 'التاريخ', 'datetime'), col('number', 'رقم الهاتف', 'phone'), col('package', 'اسم الرزمة'), col('detail', 'التفاصيل'),
      col('price', 'السعر', 'money'), ...(admin ? [col('cost', 'التكلفة', 'money'), col('profit', 'الربح', 'money')] : [col('customer', 'سعر الزبون', 'money')]),
      ...agentCol(user)],
    rows: rows.map((o) => ({ ts: o.ts, number: o.number, package: o.package, detail: o.detail, price: round(-o.amount), cost: round(o.cost),
      profit: round(o.profit), customer: o.customer_price === null ? null : round(o.customer_price), agent: o.agent_name })),
  };
}

const allowed = (r, user) => !(r.admin && user.role !== 'admin') && !(r.agent && user.role !== 'agent');

route('GET', '/api/reports', ANY, ({ user }) => REPORTS.filter((r) => allowed(r, user))
  .map((r) => ({ key: r.key, title: r.title, group: r.group, dated: !!r.dated })));

route('GET', '/api/reports/:key', ANY, ({ user, params, query }) => {
  const r = REPORTS.find((x) => x.key === params.key);
  if (!r || !allowed(r, user)) fail(404, 'التقرير غير موجود');
  const to = Number(query.to) || now() + 864e5;
  const from = Number(query.from) || to - 31 * 864e5;
  const out = r.build(user, { from, to, agentId: user.role === 'admin' ? Number(query.agentId) || null : null });
  return { key: r.key, title: r.title, dated: !!r.dated, ...out };
});
