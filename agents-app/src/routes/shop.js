'use strict';
// Customer shop: public catalog and orders (/api/shop/...), and the manager's side (/api/shop/admin/...).
const crypto = require('node:crypto');
const { q, getSettings, qlCredentials } = require('../db');
const { fail, now, round, str, normalizePhone, validPhone, normalizeIccid, validIccid, imageOrEmpty } = require('../util');
const D = require('../domain');
const shop = require('../shop');
const ql = require('../quickline');
const { MailError, toLatinDigits } = require('../mail');
const { validAddress } = require('../smtp');
const { route, ADMIN } = require('../router');

// An eSIM number picked by a customer is held for them this long while they transfer (5 minutes), and for as long as their
// transfer is being checked or their paid order waits.
const RESERVE_MS = shop.RESERVE_MS;
const heldNumbers = () => {
  shop.expireUnconfirmed();
  return q(`SELECT number, number_id FROM shop_orders WHERE esim = 1 AND ((status = 'awaiting_payment' AND created_at > ?)
    OR status IN ('verifying','review') OR (status = 'paid' AND line_id IS NULL))`).all(now() - RESERVE_MS);
};
// A package sold as an eSIM: a new line whose number (with its eSIM and QR code) comes from the supplier's free
// eSIM numbers, activated automatically.
// QuickLine (its eSIM numbers come with their QR code), Layan (it gives the eSIM's QR code when activating), and
// telecom's ALOHA (its eSIM's activation code, drawn as a QR code).
const TC_ESIM_COMPANY = 'ALOHA';
const isEsimRef = (ref, companyName) => /^(qln|lyn):/.test(String(ref || '')) || (/^tcn:/.test(String(ref || '')) && companyName === TC_ESIM_COMPANY);
const tc = require('../telecom');
const ly = require('../layan');
function esimPackage(id) {
  const p = q(`SELECT p.*, c.name AS company_name, c.esim_fee AS company_esim_fee FROM packages p JOIN companies c ON c.id = p.company_id
               WHERE p.id = ? AND p.active = 1 AND p.shop_price > 0`).get(Number(id));
  const art = p?.art_card_id || '';
  const hasRef = p && isEsimRef(art, p.company_name);
  const ref = !hasRef ? null : /^qln:/.test(art) ? ql.parseRef(art) : /^lyn:/.test(art) ? ly.parseRef(art) : tc.parseRef(art);
  if (!p || (!ref && !p.esim_enabled)) fail(404, 'الباقة غير متوفرة');
  return { p, ref, layan: /^lyn:/.test(art), telecom: /^tcn:/.test(art) && p.company_name === TC_ESIM_COMPANY, direct: !!p.esim_enabled };
}
// Layan's numbers have no id of their own: the number is the id.
const phoneId = (phone) => Number(String(phone).replace(/\D/g, ''));

// ---------- per-address throttle ----------
const hits = new Map();
function throttle(ip, kind, max) {
  const key = `${kind}|${ip}`;
  const t = now();
  const list = (hits.get(key) || []).filter((x) => x > t - 3600_000);
  if (list.length >= max) fail(429, 'طلبات كثيرة من هذا الجهاز. حاول لاحقاً.');
  list.push(t);
  hits.delete(key);
  hits.set(key, list);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
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
  const line = o.line_id ? q('SELECT id, status, expires_at, esim_qr FROM lines WHERE id = ?').get(o.line_id) : null;
  const qr = (line?.status === 'active' && line.esim_qr) ? line.esim_qr : (o.status === 'paid' && o.esim_qr ? o.esim_qr : null);
  const proofTries = Number(o.proof_tries) || 0;
  const firstProofAt = o.first_proof_at || o.proof_at || null;
  const retryUntil = o.status === 'verifying' && firstProofAt ? firstProofAt + shop.VERIFY_MS : null;
  const canRetryProof = o.status === 'verifying' && proofTries === 1 && retryUntil !== null && now() < retryUntil;
  const waitingReview = (o.status === 'verifying' || o.status === 'review') && (proofTries >= 2 || o.status === 'review');
  const waitUntil = waitingReview && o.proof_at ? o.proof_at + shop.WAIT_REVIEW_MS : null;
  const needsSupport = Boolean(waitingReview && waitUntil !== null && now() >= waitUntil);
  return {
    // An eSIM's number (given at random) shows to the customer once the order is paid.
    code: o.code, packageLabel: o.package_label, kind: o.kind, number: admin || !o.esim || o.status === 'paid' ? o.number : null, customerName: o.customer_name,
    amount: round(o.amount), esimFee: round(o.esim_fee || 0), packagePrice: round(o.amount - (o.esim_fee || 0)),
    status: o.status, stage: stage(o, line), response: o.response,
    proofSent: !!o.proof_at, proofTries, firstProofAt, retryUntil, canRetryProof, waitUntil, needsSupport,
    payPhone: o.pay_phone || '', payName: o.pay_name || '', payReference: o.pay_reference || '',
    createdAt: o.created_at, paidAt: o.paid_at, expiresAt: line?.expires_at ?? null,
    // eSIM: the number is held while the customer transfers; the QR code to install it shows once the line is active.
    esim: !!o.esim, email: o.email, qrMailed: !!o.qr_mailed_at,
    reservedUntil: o.status === 'awaiting_payment' ? o.created_at + RESERVE_MS : null,
    esimQr: o.esim && qr ? qr : null,
    esimCode: o.esim && (admin || o.status === 'paid') ? (o.esim_code || '') : null,
    ...(admin ? {
      id: o.id, sim: o.sim, contactPhone: o.contact_phone,
      hasReceipt: !!o.receipt, proofAt: o.proof_at, mailId: o.mail_id, verifiedBy: o.verified_by, lineId: o.line_id, error: o.error,
      ip: o.ip, updatedAt: o.updated_at, qrMailedAt: o.qr_mailed_at,
    } : {}),
  };
}

const mailView = (m) => ({
  id: m.id, from: m.from_addr, subject: m.subject, receivedAt: m.received_at, amount: m.amount, reference: m.reference,
  senderPhone: m.sender_phone, senderName: m.sender_name, trusted: !!m.trusted, orderId: m.order_id || null, orderCode: m.order_code || null,
});

function byCode(code, ip) {
  const clean = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(clean)) {
    if (ip) throttle(ip, 'order_miss', 40);
    fail(404, 'الطلب غير موجود');
  }
  const o = q('SELECT * FROM shop_orders WHERE code = ?').get(clean);
  if (!o) {
    if (ip) throttle(ip, 'order_miss', 40);
    fail(404, 'الطلب غير موجود');
  }
  return o;
}

// ---------- public ----------
function shopCatalogResponse() {
  const s = getSettings();
  const packages = s.shopEnabled ? q(`SELECT p.*, c.name AS company_name, c.esim_fee AS company_esim_fee FROM packages p JOIN companies c ON c.id = p.company_id
      WHERE p.active = 1 AND p.shop_price > 0 ORDER BY c.sort, c.id, p.sort, p.id`).all() : [];
  const ids = new Set(packages.map((p) => p.company_id));
  return {
    enabled: s.shopEnabled, instant: s.shopInstant, appName: s.appName,
    shopName: s.shopTitle || (s.appName ? `متجر ${s.appName}` : 'متجر الباقات'),
    shopTitle: s.shopTitle || '', shopSubtitle: s.shopSubtitle || '',
    supportWhatsapp: s.supportWhatsapp, esimFee: s.esimFee,
    payPhone: s.jawwalpayNumber || s.palpayNumber || '',
    jawwalpay: { number: s.jawwalpayNumber, name: s.jawwalpayName },
    palpay: { number: s.palpayNumber || s.jawwalpayNumber, name: s.palpayName || s.jawwalpayName },
    companies: q('SELECT id, name, color, logo, esim_fee FROM companies ORDER BY sort, id').all().filter((c) => ids.has(c.id)).map((c) => ({
      id: c.id, name: c.name, color: c.color, logo: c.logo,
      esimFee: c.esim_fee === null || c.esim_fee === undefined ? s.esimFee : round(c.esim_fee),
    })),
    packages: packages.map((p) => ({
      id: p.id, companyId: p.company_id, companyName: p.company_name, name: p.name, price: round(p.shop_price),
      oldPrice: p.old_price ? round(p.old_price) : null, popular: !!p.popular, featured: !!p.popular,
      kind: p.kind === 'card' ? 'card' : 'invoice',
      dataGb: p.data_gb, gb: p.data_gb, minutes: p.minutes, sms: p.sms, tag: p.tag, description: p.description, days: p.days || null,
      esim: isEsimRef(p.art_card_id, p.company_name) || !!p.esim_enabled,
      esimFee: p.company_esim_fee === null || p.company_esim_fee === undefined ? s.esimFee : round(p.company_esim_fee),
    })),
  };
}
route('GET', '/api/shop', null, shopCatalogResponse);
route('GET', '/api/shop/catalog', null, shopCatalogResponse);

// The free eSIM numbers of a package at its supplier (remembered there, so a sale can use one), without the ones other
// customers hold: [{ id, phone, sim, qr }]. QuickLine's come with their eSIM and QR code; Layan's get theirs when
// activated (its numbers have no id: the number is the id).
async function freeEsimNumbers(s, { ref, layan, telecom }) {
  const held = heldNumbers();
  let list;
  try {
    if (telecom) {
      // Registered with the shop's address: none set, nothing to sell.
      if (!s.tcReady || !s.tcRegReady) fail(503, 'لا توجد أرقام متاحة الآن');
      const phones = await tc.esimNumbers(require('../db').tcCredentials(), ref.packageId);
      require('./telecom').rememberEsim(ref.packageId, phones);
      list = phones.map((phone) => ({ id: phoneId(phone), phone, sim: '', qr: '' }));
    } else if (layan) {
      if (!s.lyConfigured) fail(503, 'لا توجد أرقام متاحة الآن');
      const phones = await ly.esimNumbers(require('../db').lyCredentials(), ref.packageId);
      require('./layan').rememberEsim(ref.packageId, phones);
      list = phones.map((phone) => ({ id: phoneId(phone), phone, sim: '', qr: '' }));
    } else {
      if (!s.qlConfigured) fail(503, 'لا توجد أرقام متاحة الآن');
      list = await ql.freeNumbers(qlCredentials(), { packageId: ref.packageId, exclude: held.map((h) => h.number_id).filter(Boolean), esim: true });
      require('./quickline').remember(ref.packageId, true, list);
    }
  } catch (e) {
    if (!(e instanceof ql.QuickLineError) && !(e instanceof ly.LayanError) && !(e instanceof tc.TelecomError)) throw e;
    console.error('shop numbers', e.message);
    fail(502, 'تعذّر الوصول إلى الأرقام الآن. حاول بعد قليل.');
  }
  const taken = new Set(held.map((h) => h.number));
  return list.filter((n) => n.phone && !taken.has(n.phone));
}

// Whether a package has an eSIM number free now. The customer does not choose it: one is given at random with the
// order, and shown once the order is paid.
route('GET', '/api/shop/available', null, async ({ query, ip }) => {
  const s = enabled();
  throttle(ip, 'numbers', 120);
  const pk = esimPackage(query.packageId);
  if (!pk.ref && pk.direct) return { available: true };
  try {
    const list = await freeEsimNumbers(s, pk);
    return { available: list.length > 0 || pk.direct };
  } catch (e) {
    // The supplier not set up (or its registration details missing): simply none to sell now (unless direct eSIM enabled).
    if (e.status === 503) return { available: !!pk.direct };
    throw e;
  }
});

function genDirectNumber() {
  for (;;) {
    const num = `059${String(crypto.randomInt(1000000, 9999999))}`;
    if (!q("SELECT 1 FROM lines WHERE number = ? AND status != 'disconnected'").get(num) &&
        !q("SELECT 1 FROM shop_orders WHERE number = ? AND status IN ('awaiting_payment','verifying','review','paid')").get(num)) {
      return num;
    }
  }
}

route('POST', '/api/shop/orders', null, ({ body, ip }) => {
  const s = enabled();
  throttle(ip, 'order', 20);
  if (body.kind === 'esim' || body.esim) return esimOrder(body, ip);
  const p = q(`SELECT p.*, c.name AS company_name, c.esim_fee AS company_esim_fee FROM packages p JOIN companies c ON c.id = p.company_id
               WHERE p.id = ? AND p.active = 1 AND p.shop_price > 0`).get(Number(body.packageId));
  if (!p) fail(404, 'الباقة غير متوفرة');
  const kind = body.kind === 'new' ? 'new' : 'recharge';
  const number = validPhone(normalizePhone(body.number));
  const sim = kind === 'new' ? validIccid(normalizeIccid(body.sim)) : '';
  const contact = body.contactPhone ? validPhone(normalizePhone(body.contactPhone)) : number;
  const t = now();
  const code = newCode();
  const row = q(`INSERT INTO shop_orders (code, package_id, package_label, kind, number, sim, customer_name, contact_phone, amount, ip, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(code, p.id, D.packageLabel(p), kind, number, sim, str(body.customerName, 80), contact, round(p.shop_price), ip, t, t);
  if (body.instant && s.shopInstant) {
    const orderId = Number(row.lastInsertRowid);
    if (shop.claim(orderId, null, 'تفعيل فوري مباشر')) shop.fulfil(orderId);
  }
  return orderView(byCode(code));
});

// An eSIM on a free number picked at random. It is held for this order (no other customer gets it) and checked again
// when it is sold; QuickLine's eSIM and QR code are kept with the order. The customer sees the number once paid.
async function esimOrder(body, ip) {
  const s = getSettings();
  const pk = esimPackage(body.packageId);
  const customerName = str(body.customerName, 80);
  if (customerName.length < 2) fail(400, 'اكتب اسمك — مطلوب لتسجيل الخط');
  const email = str(body.email, 120).toLowerCase();
  if (email && !validAddress(email)) fail(400, 'البريد الإلكتروني غير صحيح');
  const contact = body.contactPhone ? validPhone(normalizePhone(body.contactPhone)) : '';
  let picked = null;
  if (pk.ref) {
    try {
      const list = await freeEsimNumbers(s, pk);
      const held = new Set(heldNumbers().map((h) => h.number));
      const free = list.filter((n) => !held.has(n.phone) && !q("SELECT 1 FROM lines WHERE number = ? AND status != 'disconnected'").get(n.phone));
      if (free.length) picked = free[crypto.randomInt(free.length)];
    } catch (e) {
      if (!pk.direct) throw e;
    }
  }
  if (!picked) {
    if (!pk.direct) fail(409, 'نفدت أرقام eSIM لهذه الباقة الآن. جرّب باقة أخرى أو عد لاحقاً.');
    const customPhone = body.number ? validPhone(normalizePhone(body.number)) : genDirectNumber();
    picked = { id: phoneId(customPhone), phone: customPhone, sim: '', qr: '' };
  }
  const t = now();
  const code = newCode();
  const hasCompanyFee = pk.p.company_esim_fee !== null && pk.p.company_esim_fee !== undefined;
  const compFee = hasCompanyFee ? round(pk.p.company_esim_fee) : s.esimFee;
  const esimFee = (hasCompanyFee || body.includeEsimFee) ? round(compFee) : 0;
  const totalAmount = round(pk.p.shop_price + esimFee);
  const esimCode = `LPA:1$rsp.${String(pk.p.company_name || 'esim').toLowerCase().replace(/[^a-z0-9]/g, '') || 'telecom'}.portal$ESIM-${code}-${picked.phone}`;
  const qrData = picked.qr || (pk.direct || (body.instant && s.shopInstant) ? shop.makeEsimQr(esimCode, picked.phone) : '');
  const row = q(`INSERT INTO shop_orders (code, package_id, package_label, kind, number, sim, customer_name, contact_phone, amount, esim_fee, esim_code, ip, created_at, updated_at,
       esim, number_id, esim_qr, email) VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(code, pk.p.id, D.packageLabel(pk.p), picked.phone, String(picked.sim || '').replace(/\D/g, ''), customerName, contact, totalAmount, esimFee, esimCode, ip, t, t,
      picked.id, qrData, email);
  if (body.instant && s.shopInstant) {
    const orderId = Number(row.lastInsertRowid);
    if (shop.claim(orderId, null, 'تفعيل فوري مباشر')) {
      shop.fulfil(orderId);
      const ord = byCode(code);
      if (ord.line_id && qrData) {
        q("UPDATE lines SET esim_qr = COALESCE(NULLIF(esim_qr, ''), ?), status = 'active', activated_at = COALESCE(activated_at, ?), updated_at = ? WHERE id = ?")
          .run(qrData, now(), now(), ord.line_id);
      }
    }
  }
  return orderView(byCode(code));
}

route('POST', '/api/shop/orders/:code/instant', null, ({ params, ip }) => {
  const s = enabled();
  throttle(ip, 'proof', 30);
  if (!s.shopInstant) fail(403, 'التفعيل الفوري غير مفعّل حالياً');
  const o = byCode(params.code, ip);
  if (o.status === 'paid') return orderView(o);
  if (!['awaiting_payment', 'verifying', 'review'].includes(o.status)) fail(400, 'تم التعامل مع هذا الطلب');
  const esimCode = o.esim_code || `LPA:1$rsp.esim.portal$ESIM-${o.code}-${o.number}`;
  const qrData = o.esim ? (o.esim_qr || shop.makeEsimQr(esimCode, o.number)) : '';
  if (o.esim && !o.esim_qr) {
    q('UPDATE shop_orders SET esim_qr = ?, esim_code = ? WHERE id = ?').run(qrData, esimCode, o.id);
  }
  if (shop.claim(o.id, null, 'تفعيل فوري مباشر')) {
    shop.fulfil(o.id);
    const fresh = byCode(o.code);
    if (fresh.line_id && qrData) {
      q("UPDATE lines SET esim_qr = COALESCE(NULLIF(esim_qr, ''), ?), status = 'active', activated_at = COALESCE(activated_at, ?), updated_at = ? WHERE id = ?")
        .run(qrData, now(), now(), fresh.line_id);
    }
  }
  return orderView(byCode(o.code));
});

route('GET', '/api/shop/orders/:code', null, async ({ params, query, ip }) => {
  throttle(ip, 'view', 600);
  shop.expireUnconfirmed();
  shop.escalate();
  let o = byCode(params.code, ip);
  if (o.status === 'verifying' || o.status === 'review') {
    if (!shop.tryMatch(o.id) && (query.check === '1' || Number(o.proof_tries) >= 2)) {
      try { await shop.checkMail(); } catch (e) { console.error('shop mail', e.message); }
    }
    o = byCode(params.code);
  }
  return orderView(o);
});

// The customer's transfer details. At least one way to verify: reference, sender phone, sender name or the receipt.
// Attempt 1 checks emails from the last 5 minutes; if unmatched, the customer gets 1 retry within 3 minutes (searching the last 8 minutes).
route('POST', '/api/shop/orders/:code/proof', null, async ({ params, body, ip }) => {
  enabled();
  throttle(ip, 'proof', 30);
  shop.expireUnconfirmed();
  shop.escalate();
  const o = byCode(params.code, ip);
  if (o.status === 'cancelled') fail(400, 'انتهت مهلة حجز الرقم (5 دقائق) دون تأكيد الإرسال وتم إلغاء الطلبية تلقائياً');
  if (!['awaiting_payment', 'verifying', 'review'].includes(o.status)) fail(400, 'تم التعامل مع هذا الطلب');
  const prevTries = Number(o.proof_tries) || 0;
  if (prevTries >= 2) fail(400, 'لقد استنفدت فرصة تصحيح البيانات — الطلب الآن قيد المراجعة');
  if (prevTries === 1 && o.status === 'review') fail(400, 'انتهت مهلة تصحيح البيانات (3 دقائق) — الطلب الآن قيد المراجعة');
  let payPhone = body.payPhone ? validPhone(normalizePhone(toLatinDigits(body.payPhone))) : '';
  let payName = str(body.payName, 80);
  let payReference = str(toLatinDigits(body.payReference), 60);
  const phoneLike = (v) => /^(?:\+?97[02][\s-]?|0)5\d(?:[\s-]?\d){7}$/.test(String(v || '').trim());
  if (!payPhone && phoneLike(payReference)) {
    payPhone = validPhone(normalizePhone(payReference));
    payReference = '';
  }
  if (!payPhone && phoneLike(payName)) {
    payPhone = validPhone(normalizePhone(payName));
    payName = '';
  }
  if (!payReference && /^\d{8,20}$/.test(toLatinDigits(payName).replace(/\s+/g, ''))) {
    payReference = toLatinDigits(payName).replace(/\s+/g, '').slice(0, 60);
    payName = '';
  }
  const receipt = imageOrEmpty(body.receipt, { maxKb: 1500, label: 'صورة الإشعار' });
  if (!payPhone && !payName && !payReference && !receipt && !o.receipt) fail(400, 'أدخل الرقم المرجعي أو رقم/اسم المحوِّل أو صورة الإشعار');
  const t = now();
  const nextTry = prevTries + 1;
  q(`UPDATE shop_orders
        SET pay_phone = ?, pay_name = ?, pay_reference = ?,
            receipt = CASE WHEN ? != '' THEN ? ELSE receipt END,
            status = CASE WHEN status = 'review' THEN 'review' ELSE 'verifying' END,
            proof_tries = ?,
            first_proof_at = COALESCE(first_proof_at, ?),
            proof_at = ?, updated_at = ?
      WHERE id = ?`)
    .run(payPhone, payName, payReference, receipt, receipt, nextTry, t, t, t, o.id);
  if (!shop.tryMatch(o.id)) {
    // Read the mailbox now: the email often arrives a few seconds after the transfer.
    try { await shop.checkMail(); } catch (e) { console.error('shop mail', e.message); }
  }
  return orderView(byCode(o.code));
}, { maxBody: 2200 * 1024 });

route('POST', '/api/shop/orders/:code/cancel', null, ({ params, ip }) => {
  throttle(ip, 'cancel', 30);
  const o = byCode(params.code, ip);
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
  // Unused emails with at least the order's amount, to confirm by hand.
  const candidates = q(`SELECT * FROM payment_mails WHERE order_id IS NULL AND amount IS NOT NULL AND amount + 0.005 >= ?
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
