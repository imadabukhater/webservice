'use strict';
// Customer shop: public catalog and orders (/api/shop/...), and the manager's side (/api/shop/admin/...).
const crypto = require('node:crypto');
const { q, getSettings } = require('../db');
const { fail, now, round, str, normalizePhone, validPhone, normalizeIccid, validIccid, imageOrEmpty } = require('../util');
const D = require('../domain');
const shop = require('../shop');
const { MailError } = require('../mail');
const { route, ADMIN } = require('../router');

// ---------- per-address throttle ----------
const hits = new Map();
function throttle(ip, kind, max) {
  const key = `${kind}|${ip}`;
  const t = now();
  const list = (hits.get(key) || []).filter((x) => x > t - 3600_000);
  if (list.length >= max) fail(429, 'طلبات كثيرة من هذا الجهاز. حاول لاحقاً.');
  list.push(t);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
}

const enabled = () => {
  const s = getSettings();
  if (!s.shopEnabled) fail(403, 'المتجر مغلق حالياً');
  return s;
};

const newCode = () => {
  for (;;) {
    const code = crypto.randomBytes(6).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (code.length === 8 && !q('SELECT 1 FROM shop_orders WHERE code = ?').get(code)) return code;
  }
};

// What the customer sees: one stage that combines payment and activation.
function stage(o, line) {
  if (o.status !== 'paid') return o.status;
  if (!line) return o.error ? 'paid_issue' : 'processing';
  if (line.status === 'pending') return 'processing';
  if (line.status === 'disconnected') return 'failed';
  return 'done';
}

function orderView(o, { admin = false } = {}) {
  const line = o.line_id ? q('SELECT id, status, expires_at FROM lines WHERE id = ?').get(o.line_id) : null;
  return {
    code: o.code, packageLabel: o.package_label, kind: o.kind, number: o.number, customerName: o.customer_name,
    amount: round(o.amount), status: o.status, stage: stage(o, line), response: o.response,
    proofSent: !!o.proof_at, createdAt: o.created_at, paidAt: o.paid_at, expiresAt: line?.expires_at ?? null,
    ...(admin ? {
      id: o.id, sim: o.sim, contactPhone: o.contact_phone, payPhone: o.pay_phone, payName: o.pay_name, payReference: o.pay_reference,
      hasReceipt: !!o.receipt, proofAt: o.proof_at, mailId: o.mail_id, verifiedBy: o.verified_by, lineId: o.line_id, error: o.error,
      ip: o.ip, updatedAt: o.updated_at,
    } : {}),
  };
}

const mailView = (m) => ({
  id: m.id, from: m.from_addr, subject: m.subject, receivedAt: m.received_at, amount: m.amount, reference: m.reference,
  senderPhone: m.sender_phone, senderName: m.sender_name, trusted: !!m.trusted, orderId: m.order_id || null, orderCode: m.order_code || null,
});

function byCode(code) {
  const o = q('SELECT * FROM shop_orders WHERE code = ?').get(String(code).toUpperCase());
  if (!o) fail(404, 'الطلب غير موجود');
  return o;
}

// ---------- public ----------
route('GET', '/api/shop', null, () => {
  const s = getSettings();
  const packages = s.shopEnabled ? q(`SELECT p.*, c.name AS company_name FROM packages p JOIN companies c ON c.id = p.company_id
      WHERE p.active = 1 AND p.shop_price > 0 ORDER BY c.sort, c.id, p.sort, p.id`).all() : [];
  const ids = new Set(packages.map((p) => p.company_id));
  return {
    enabled: s.shopEnabled, appName: s.appName, supportWhatsapp: s.supportWhatsapp,
    jawwalpay: { number: s.jawwalpayNumber, name: s.jawwalpayName },
    companies: q('SELECT id, name, color, logo FROM companies ORDER BY sort, id').all().filter((c) => ids.has(c.id)),
    packages: packages.map((p) => ({
      id: p.id, companyId: p.company_id, companyName: p.company_name, name: p.name, price: round(p.shop_price),
      dataGb: p.data_gb, minutes: p.minutes, sms: p.sms, tag: p.tag, description: p.description,
    })),
  };
});

route('POST', '/api/shop/orders', null, ({ body, ip }) => {
  enabled();
  throttle(ip, 'order', 20);
  const p = q(`SELECT p.*, c.name AS company_name FROM packages p JOIN companies c ON c.id = p.company_id
               WHERE p.id = ? AND p.active = 1 AND p.shop_price > 0`).get(Number(body.packageId));
  if (!p) fail(404, 'الباقة غير متوفرة');
  const kind = body.kind === 'new' ? 'new' : 'recharge';
  const number = validPhone(normalizePhone(body.number));
  const sim = kind === 'new' ? validIccid(normalizeIccid(body.sim)) : '';
  const contact = body.contactPhone ? validPhone(normalizePhone(body.contactPhone)) : number;
  const t = now();
  const code = newCode();
  q(`INSERT INTO shop_orders (code, package_id, package_label, kind, number, sim, customer_name, contact_phone, amount, ip, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(code, p.id, D.packageLabel(p), kind, number, sim, str(body.customerName, 80), contact, round(p.shop_price), ip, t, t);
  return orderView(byCode(code));
});

route('GET', '/api/shop/orders/:code', null, ({ params, ip }) => {
  throttle(ip, 'view', 600);
  return orderView(byCode(params.code));
});

// The customer's transfer details. At least one way to verify: reference, sender phone, sender name or the receipt.
route('POST', '/api/shop/orders/:code/proof', null, async ({ params, body, ip }) => {
  enabled();
  throttle(ip, 'proof', 30);
  const o = byCode(params.code);
  if (!['awaiting_payment', 'verifying', 'review'].includes(o.status)) fail(400, 'تم التعامل مع هذا الطلب');
  const payPhone = body.payPhone ? validPhone(normalizePhone(body.payPhone)) : '';
  const payName = str(body.payName, 80);
  const payReference = str(body.payReference, 60);
  const receipt = imageOrEmpty(body.receipt, { maxKb: 1500, label: 'صورة الإشعار' });
  if (!payPhone && !payName && !payReference && !receipt && !o.receipt) fail(400, 'أدخل الرقم المرجعي أو رقم/اسم المحوِّل أو صورة الإشعار');
  q(`UPDATE shop_orders SET pay_phone = ?, pay_name = ?, pay_reference = ?, receipt = CASE WHEN ? != '' THEN ? ELSE receipt END,
     status = CASE WHEN status = 'review' THEN 'review' ELSE 'verifying' END, proof_at = ?, updated_at = ? WHERE id = ?`)
    .run(payPhone, payName, payReference, receipt, receipt, now(), now(), o.id);
  if (!shop.tryMatch(o.id)) {
    // Read the mailbox now: the email often arrives a few seconds after the transfer.
    try { await shop.checkMail(); } catch (e) { console.error('shop mail', e.message); }
  }
  return orderView(byCode(o.code));
}, { maxBody: 2200 * 1024 });

route('POST', '/api/shop/orders/:code/cancel', null, ({ params }) => {
  const o = byCode(params.code);
  if (o.status !== 'awaiting_payment') fail(400, 'لا يمكن إلغاء الطلب بعد إرسال بيانات التحويل. تواصل مع الدعم.');
  q("UPDATE shop_orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), o.id);
  return orderView(byCode(o.code));
});

// ---------- manager ----------
const adminOrder = (id) => {
  const o = q('SELECT * FROM shop_orders WHERE id = ?').get(Number(id));
  if (!o) fail(404, 'الطلب غير موجود');
  return o;
};

route('GET', '/api/shop/admin/orders', ADMIN, ({ query }) => {
  const where = { open: "status IN ('verifying','review') OR (status = 'paid' AND line_id IS NULL)", waiting: "status = 'awaiting_payment'" }[query.filter] || '1=1';
  return q(`SELECT * FROM shop_orders WHERE ${where} ORDER BY id DESC LIMIT 500`).all().map((o) => orderView(o, { admin: true }));
});

route('GET', '/api/shop/admin/orders/:id', ADMIN, ({ params }) => {
  const o = adminOrder(params.id);
  const m = o.mail_id ? q('SELECT * FROM payment_mails WHERE id = ?').get(o.mail_id) : null;
  // Unused emails with the same amount, to confirm by hand.
  const candidates = q(`SELECT * FROM payment_mails WHERE order_id IS NULL AND amount IS NOT NULL AND ABS(amount - ?) < 0.005
                        ORDER BY received_at DESC LIMIT 20`).all(o.amount);
  return { ...orderView(o, { admin: true }), receipt: o.receipt, mail: m && { ...mailView(m), body: m.body }, candidates: candidates.map(mailView) };
});

// Payment confirmed by the manager, optionally with the email that shows it.
route('POST', '/api/shop/admin/orders/:id/approve', ADMIN, ({ user, params, body }) => {
  const o = adminOrder(params.id);
  const mailId = body.mailId ? Number(body.mailId) : null;
  if (mailId && !q('SELECT 1 FROM payment_mails WHERE id = ? AND order_id IS NULL AND amount IS NOT NULL').get(mailId)) fail(409, 'هذا الإشعار مستخدم لطلب آخر');
  if (!shop.claim(o.id, mailId, `يدوي: ${user.name}`)) fail(400, 'تم التعامل مع هذا الطلب');
  shop.fulfil(o.id);
  return orderView(adminOrder(o.id), { admin: true });
});

// Paid but not carried out (e.g. the number was refused): try again after fixing the cause.
route('POST', '/api/shop/admin/orders/:id/retry', ADMIN, ({ params, body }) => {
  const o = adminOrder(params.id);
  if (o.status !== 'paid' || o.line_id) fail(400, 'هذا الطلب لا يحتاج إعادة');
  if (body.number) q('UPDATE shop_orders SET number = ? WHERE id = ?').run(validPhone(normalizePhone(body.number)), o.id);
  if (body.sim && o.kind === 'new') q('UPDATE shop_orders SET sim = ? WHERE id = ?').run(validIccid(normalizeIccid(body.sim)), o.id);
  shop.fulfil(o.id);
  const fresh = adminOrder(o.id);
  if (!fresh.line_id) fail(400, fresh.error || 'تعذّر التنفيذ');
  return orderView(fresh, { admin: true });
});

route('POST', '/api/shop/admin/orders/:id/reject', ADMIN, ({ user, params, body }) => {
  const o = adminOrder(params.id);
  if (!['awaiting_payment', 'verifying', 'review'].includes(o.status) && !(o.status === 'paid' && !o.line_id)) fail(400, 'لا يمكن رفض هذا الطلب');
  q("UPDATE shop_orders SET status = 'rejected', response = ?, verified_by = ?, updated_at = ? WHERE id = ?")
    .run(str(body.response, 300), user.name, now(), o.id);
  // A rejected paid order frees its email for another order.
  if (o.mail_id) q('UPDATE payment_mails SET order_id = NULL WHERE id = ?').run(o.mail_id);
  return orderView(adminOrder(o.id), { admin: true });
});

route('GET', '/api/shop/admin/mails', ADMIN, () => q(`SELECT m.*, o.code AS order_code FROM payment_mails m LEFT JOIN shop_orders o ON o.id = m.order_id
  WHERE m.order_id IS NULL OR m.order_id != 0 ORDER BY m.received_at DESC LIMIT 200`).all().map(mailView));

route('GET', '/api/shop/admin/mails/:id', ADMIN, ({ params }) => {
  const m = q('SELECT * FROM payment_mails WHERE id = ?').get(Number(params.id));
  if (!m) fail(404, 'الإشعار غير موجود');
  return { ...mailView(m), body: m.body };
});

route('POST', '/api/shop/admin/check-mail', ADMIN, async () => {
  if (!getSettings().gmailConfigured) fail(400, 'أدخل بريد Gmail وكلمة مرور التطبيقات أولاً');
  try {
    return await shop.checkMail({ force: true });
  } catch (e) {
    if (e instanceof MailError || e.code) fail(502, e.message);
    throw e;
  }
});

route('GET', '/api/shop/admin/summary', ADMIN, () => ({
  open: q("SELECT COUNT(*) AS n FROM shop_orders WHERE status IN ('verifying','review') OR (status = 'paid' AND line_id IS NULL)").get().n,
  agentId: shop.shopAgent().id,
}));
