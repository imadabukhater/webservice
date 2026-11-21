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

// An eSIM number picked by a customer is held for them this long while they transfer (10 minutes), and for as long as their
// transfer is being checked or their paid order waits.
const RESERVE_MS = shop.RESERVE_MS;
const heldNumbers = () => {
  shop.expireUnconfirmed();
  return q(`SELECT number, number_id FROM shop_orders WHERE (esim = 1 OR number_id LIKE 'ayl:%') AND ((status = 'awaiting_payment' AND (created_at > ?
    OR jc_expires_at > ? OR jc_unsure = 1)) OR status IN ('verifying','review') OR (status = 'paid' AND line_id IS NULL))`).all(now() - RESERVE_MS, now());
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
  // Aylol's eSIMs too: one of the site's ready numbers, bought there once the order is paid.
  const aylol = /^ay:esim:/.test(art);
  const hasRef = p && (isEsimRef(art, p.company_name) || aylol);
  const ref = !hasRef ? null : aylol ? { system: 'ay', art } : /^qln:/.test(art) ? ql.parseRef(art) : /^lyn:/.test(art) ? ly.parseRef(art) : tc.parseRef(art);
  // Only an eSIM whose number comes from a supplier: none without one (no "direct" eSIM the manager fills in by hand).
  if (!p || !ref) fail(404, 'الباقة غير متوفرة');
  return { p, ref, aylol, layan: /^lyn:/.test(art), telecom: /^tcn:/.test(art) && p.company_name === TC_ESIM_COMPANY };
}

// The shop sells eSIMs only, each on a number its supplier has free: 'esim' for a supplier's eSIM (QuickLine, Layan,
// telecom's ALOHA, Aylol's eSIMs), 'line' for an Aylol new line sold as an eSIM. Nothing else is sold: no line on a
// SIM card, no recharge of an existing number, no eSIM without a supplier's number.
function shopKind(p) {
  const art = p?.art_card_id || '';
  if (/^ay:bill:/.test(art)) {
    return require('../aylol').billShop(art, p.supplier_company) && require('./aylol').shopLineModes(p).includes('esim') ? 'line' : null;
  }
  return isEsimRef(art, p?.company_name) || /^ay:esim:/.test(art) ? 'esim' : null;
}
// The packages the shop may sell (with a customer price), before their stock is looked at.
const shopRows = () => q(`SELECT p.*, c.name AS company_name, c.esim_fee AS company_esim_fee FROM packages p JOIN companies c ON c.id = p.company_id
    WHERE p.active = 1 AND p.shop_price > 0 ORDER BY c.sort, c.id, p.sort, p.id`).all().filter((p) => shopKind(p));
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

// Direct Jawwal Pay: codes a customer may ask for one order, confirmations per code, the wait before another code,
// and how long a number stays held for a code (never longer than the code itself lasts).
const JC_SENDS_MAX = 3;
const JC_TRIES_MAX = 5;
const JC_RESEND_MS = 45_000;
const JC_HOLD_MS = 10 * 60_000;
const jcPending = (o) => !!(o.jc_invoice_id && o.jc_expires_at && o.jc_expires_at > now());
const maskMobile = (m) => (m && m.length >= 7 ? `${m.slice(0, 3)}${'•'.repeat(m.length - 6)}${m.slice(-3)}` : m || '');

// What the customer sees: one stage that combines payment and activation.
function stage(o, line) {
  if (o.status !== 'paid') return o.status;
  if (!line) return o.error ? 'paid_issue' : 'processing';
  if (o.kind === 'recharge') {
    // A renewal: done once the extension is carried out (its task at the supplier or the manager), refused → failed.
    const t = q("SELECT status FROM tasks WHERE line_id = ? AND type = 'renew' AND created_at >= ? ORDER BY id DESC LIMIT 1")
      .get(line.id, (o.paid_at || o.created_at) - 60_000);
    if (t?.status === 'open') return 'processing';
    if (t?.status === 'rejected') return 'failed';
    return 'done';
  }
  if (line.status === 'pending') return 'processing';
  if (line.status === 'disconnected') return 'failed';
  return 'done';
}

function orderView(o, { admin = false } = {}) {
  const line = o.line_id ? q('SELECT id, status, expires_at, esim_qr, esim_code FROM lines WHERE id = ?').get(o.line_id) : null;
  // Only a real code and QR (from the supplier, or attached by the manager) ever reaches the customer.
  const lineQr = shop.realQr(line?.esim_qr);
  const orderQr = shop.realQr(o.esim_qr);
  const qr = (line?.status === 'active' && lineQr) ? lineQr : (o.status === 'paid' && orderQr ? orderQr : null);
  const esimCode = shop.realCode(line?.esim_code) || shop.realCode(o.esim_code);
  const proofTries = Number(o.proof_tries) || 0;
  const firstProofAt = o.first_proof_at || o.proof_at || null;
  const retryUntil = o.status === 'verifying' && firstProofAt ? firstProofAt + shop.VERIFY_MS : null;
  const canRetryProof = o.status === 'verifying' && proofTries === 1 && retryUntil !== null && now() < retryUntil;
  const waitingReview = (o.status === 'verifying' || o.status === 'review') && (proofTries >= 2 || o.status === 'review');
  const waitUntil = waitingReview && o.proof_at ? o.proof_at + shop.WAIT_REVIEW_MS : null;
  const needsSupport = Boolean(waitingReview && waitUntil !== null && now() >= waitUntil);
  return {
    // An eSIM's number (given at random) shows to the customer once the order is paid.
    code: o.code, packageLabel: o.package_label, kind: o.kind, number: o.number, customerName: o.customer_name,
    amount: round(o.amount), esimFee: round(o.esim_fee || 0), packagePrice: round(o.amount - (o.esim_fee || 0)),
    status: o.status, stage: stage(o, line), response: o.response,
    proofSent: !!o.proof_at, proofTries, firstProofAt, retryUntil, canRetryProof, waitUntil, needsSupport,
    payPhone: o.pay_phone || '', payName: o.pay_name || '', payReference: o.pay_reference || '',
    createdAt: o.created_at, paidAt: o.paid_at, expiresAt: line?.expires_at ?? null,
    // eSIM: the number is held while the customer transfers; the QR code to install it shows once the line is active.
    esim: !!o.esim, email: o.email, qrMailed: !!o.qr_mailed_at,
    reservedUntil: o.status === 'awaiting_payment' ? Math.max(o.created_at + RESERVE_MS, jcPending(o) ? o.jc_expires_at : 0) : null,
    // Direct Jawwal Pay: a code sent to the customer's mobile (shown partly hidden) and until when it can be confirmed.
    jawwal: o.jc_invoice_id || o.jc_sends ? {
      mobile: admin ? o.jc_mobile : maskMobile(o.jc_mobile),
      otpSent: jcPending(o), expiresAt: o.jc_expires_at || null,
      resendAt: o.jc_sent_at ? o.jc_sent_at + JC_RESEND_MS : null,
      sendsLeft: Math.max(0, JC_SENDS_MAX - (o.jc_sends || 0)),
      triesLeft: Math.max(0, JC_TRIES_MAX - (o.jc_tries || 0)),
      checking: !!o.jc_unsure,
      bank: o.jc_bank || '', bankName: BANK_NAME[o.jc_bank] || '',
      ...(admin ? { invoiceId: o.jc_invoice_id, status: o.jc_status || '' } : {}),
    } : null,
    esimQr: o.esim && qr ? qr : null,
    esimCode: o.esim && (admin || o.status === 'paid') ? esimCode : null,
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

// ---------- in stock: only what a supplier has a number free for now ----------
// The shop asks each supplier which eSIM numbers it has free for each package it sells: when it starts, every 10
// minutes, and whenever its catalog is asked for after that. A package is shown (on the site and in WhatsApp) only
// while its supplier's last answer, not older than half an hour, has a number no other customer's order holds. Not
// asked yet, an answer too old, a supplier not set up or not answering: not shown. Ordering asks the supplier again.
const STOCK_MS = Number(process.env.SHOP_STOCK_MS) || 10 * 60_000; // asked again after 10 minutes
const STOCK_STALE_MS = 3 * STOCK_MS; // an answer older than this counts as none
const STOCK_WAIT_MS = Number(process.env.SHOP_STOCK_WAIT_MS) || 15_000; // how long a catalog waits for a first answer
const stock = new Map(); // packageId -> { phones, at }
// A number of the last answer is free now when no customer's order holds it and no line was sold on it since.
function inStock(id, held) {
  const v = stock.get(Number(id));
  if (!v || now() - v.at > STOCK_STALE_MS) return false;
  return v.phones.some((ph) => !held.has(ph) && !q("SELECT 1 FROM lines WHERE number = ? AND status != 'disconnected'").get(ph));
}
// The supplier's free numbers, with the ones this package's orders hold (the supplier leaves those out of its answer):
// an order that ends gives its number back to the shop at once, not at the next look.
const setStock = (id, phones) => {
  const held = q(`SELECT number FROM shop_orders WHERE package_id = ? AND ((status = 'awaiting_payment' AND (created_at > ? OR jc_expires_at > ? OR jc_unsure = 1))
    OR status IN ('verifying','review') OR (status = 'paid' AND line_id IS NULL))`).all(Number(id), now() - RESERVE_MS, now()).map((r) => r.number);
  stock.set(Number(id), { phones: [...new Set([...phones, ...held])].filter(Boolean), at: now() });
};
// How a package's free eSIM numbers are asked: () => [{ phone }].
function stockJob(s, p) {
  const kind = shopKind(p);
  if (kind === 'line') return () => require('./aylol').billFreeNumbers(p.art_card_id, '', true);
  if (kind === 'esim') return () => freeEsimNumbers(s, esimPackage(p.id));
  return null;
}
let refreshing = null;
function refreshStock() {
  if (!refreshing) {
    refreshing = (async () => {
      const s = getSettings();
      if (!s.shopEnabled) return;
      for (const p of shopRows()) {
        const ask = stockJob(s, p);
        if (!ask) continue;
        try {
          setStock(p.id, (await ask()).map((n) => n.phone));
        } catch (e) {
          // The supplier not set up, or not giving its numbers: nothing can be sold there now (an order would fail the
          // same way), so not shown until it answers again.
          setStock(p.id, []);
          if (e.status !== 503) console.error('shop stock', p.id, e.message);
        }
      }
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}
// Before the catalog is shown: a package never asked yet is asked now (waited for, a few seconds at most); answers
// older than 10 minutes are asked again in the background (the catalog does not wait for those).
async function ensureStock() {
  if (!getSettings().shopEnabled) return;
  const ages = shopRows().map((p) => stock.get(Number(p.id))?.at);
  if (ages.some((at) => !at || now() - at > STOCK_STALE_MS)) {
    let timer;
    await Promise.race([refreshStock(), new Promise((r) => { timer = setTimeout(r, STOCK_WAIT_MS); timer.unref?.(); })])
      .catch((e) => console.error('shop stock', e.message));
    clearTimeout(timer);
  } else if (ages.some((at) => now() - at > STOCK_MS)) {
    refreshStock().catch((e) => console.error('shop stock', e.message));
  }
}
if (process.env.NODE_ENV === 'production' || process.env.SHOP_STOCK === '1') {
  setTimeout(() => refreshStock().catch((e) => console.error('shop stock', e.message)), 3_000).unref();
  setInterval(() => refreshStock().catch((e) => console.error('shop stock', e.message)), STOCK_MS).unref();
}

// ---------- public ----------
// The catalog as last known (ensureStock first, for fresh numbers): eSIMs with a number free now.
function shopCatalogResponse() {
  const s = getSettings();
  const held = new Set(heldNumbers().map((h) => h.number));
  const packages = s.shopEnabled ? shopRows().filter((p) => inStock(p.id, held)) : [];
  const ids = new Set(packages.map((p) => p.company_id));
  return {
    // Every order is paid and verified before it is carried out: there is no instant (unpaid) activation.
    enabled: s.shopEnabled, instant: false, appName: s.appName,
    shopName: s.shopTitle || 'Hot eSIM',
    shopTitle: s.shopTitle || '', shopSubtitle: s.shopSubtitle || '',
    supportWhatsapp: s.supportWhatsapp, esimFee: s.esimFee,
    payPhone: s.jawwalpayNumber || s.palpayNumber || '',
    // Paying straight from the customer's Jawwal Pay wallet with a code texted to them (corporate API).
    jawwalDirect: s.jcReady,
    // Banks the customer may pay from instead of the wallet (the code comes from the bank, to its registered mobile).
    jawwalBanks: jcBanks(s).map((code) => ({ code, name: BANK_NAME[code] || code })),
    // A manual transfer, confirmed from the payment e-mails (the manager may stop it: direct payment only).
    manualPay: s.mailPay || !s.jcReady,
    jawwalpay: { number: s.jawwalpayNumber, name: s.jawwalpayName },
    palpay: { number: s.palpayNumber || s.jawwalpayNumber, name: s.palpayName || s.jawwalpayName },
    companies: q('SELECT id, name, color, logo, esim_fee FROM companies ORDER BY sort, id').all().filter((c) => ids.has(c.id)).map((c) => ({
      id: c.id, name: c.name, color: c.color, logo: c.logo,
      esimFee: c.esim_fee === null || c.esim_fee === undefined ? s.esimFee : round(c.esim_fee),
    })),
    packages: packages.map((p) => ({
      id: p.id, companyId: p.company_id, companyName: p.company_name, name: p.name, price: round(p.shop_price),
      oldPrice: p.old_price ? round(p.old_price) : null, popular: !!p.popular, featured: !!p.popular,
      kind: 'esim', esim: true,
      dataGb: p.data_gb, gb: p.data_gb, minutes: p.minutes, sms: p.sms, tag: p.tag, description: p.description, days: p.days || null,
      // An Aylol line is registered in the customer's name, so it is asked (the first name is enough).
      fullName: shopKind(p) === 'line',
      esimFee: p.company_esim_fee === null || p.company_esim_fee === undefined ? s.esimFee : round(p.company_esim_fee),
    })),
  };
}
async function shopCatalog() {
  await ensureStock();
  return shopCatalogResponse();
}
route('GET', '/api/shop', null, shopCatalog);
route('GET', '/api/shop/catalog', null, shopCatalog);

// The free eSIM numbers of a package at its supplier (remembered there, so a sale can use one), without the ones other
// customers hold: [{ id, phone, sim, qr }]. QuickLine's come with their eSIM and QR code; Layan's get theirs when
// activated (its numbers have no id: the number is the id).
async function freeEsimNumbers(s, { ref, layan, telecom, aylol }) {
  const held = heldNumbers();
  let list;
  try {
    if (aylol) {
      if (!s.aylolConfigured) fail(503, 'لا توجد أرقام متاحة الآن');
      list = (await require('./aylol').freeNumbers(ref.art)).map((n) => ({ id: phoneId(n.phone), phone: n.phone, sim: '', qr: '' }));
    } else if (telecom) {
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
  const p = q(`SELECT p.*, c.name AS company_name FROM packages p JOIN companies c ON c.id = p.company_id
               WHERE p.id = ? AND p.active = 1 AND p.shop_price > 0`).get(Number(query.packageId));
  const kind = p && shopKind(p);
  if (!kind) fail(404, 'الباقة غير متوفرة');
  try {
    const held = new Set(heldNumbers().map((h) => h.number));
    const list = kind === 'line'
      ? (await require('./aylol').billFreeNumbers(p.art_card_id, '', true)).filter((n) => !held.has(n.phone))
      : await freeEsimNumbers(s, esimPackage(p.id));
    setStock(p.id, list.map((n) => n.phone));
    return { available: list.length > 0 };
  } catch (e) {
    // The supplier not set up (or its registration details missing): simply none to sell now.
    if (e.status === 503) return { available: false };
    throw e;
  }
});

route('POST', '/api/shop/orders', null, ({ body, ip, req }) => {
  throttle(ip, 'order', 20);
  return createOrder(body, { ip, clientId: str(req?.headers?.['x-client-id'] || body.clientId || '', 64) });
});

// ---------- renewing a number (any line in the system) ----------
// The line behind a number, and the packages that may renew it at the shop's price: its company's, priced for the shop
// (shop_price), and that its supplier extends (quickline.renewalProblem: a QuickLine / Layan / telecom line only on its
// own package's extension). What the customer sees: the company, the package, the expiry — never whose it is.
function renewalLine(numberInput) {
  let number = '';
  try { number = validPhone(normalizePhone(toLatinDigits(String(numberInput || '')))); } catch { fail(400, 'اكتب رقم الخط اللي بدك تمدّده (10 أرقام يبدأ بـ 05)'); }
  const l = q(`${D.LINE_SELECT} WHERE l.number = ? AND l.status != 'disconnected' ORDER BY l.id DESC LIMIT 1`).get(number);
  if (!l) fail(404, 'هذا الرقم غير مسجّل عندنا — للتمديد تواصل مع الدعم.');
  if (l.status === 'pending') fail(409, 'طلب هذا الرقم ما زال قيد التنفيذ — جرّب بعد قليل.');
  if (q("SELECT 1 FROM tasks WHERE line_id = ? AND type = 'renew' AND status = 'open'").get(l.id)) fail(409, 'تمديد هذا الرقم قيد التنفيذ الآن.');
  return l;
}
function renewalOptions(l) {
  const { renewalProblem } = require('../quickline');
  return q(`SELECT p.*, c.name AS company_name FROM packages p JOIN companies c ON c.id = p.company_id
            WHERE p.active = 1 AND p.shop_price > 0 ${l.company_id ? 'AND p.company_id = ?' : ''} ORDER BY p.shop_price, p.id`)
    .all(...(l.company_id ? [l.company_id] : []))
    .filter((p) => !renewalProblem(l.package_ref, p.art_card_id) && !/^(qln|lyn|tcn|ay:bill|ay:esim):/.test(p.art_card_id || ''));
}
function renewalView(l) {
  return {
    number: l.number, company: l.company_name || '', packageLabel: l.package_label || '', expiresAt: l.expires_at || null,
    status: l.status, options: renewalOptions(l).map((p) => ({ id: p.id, name: p.name, label: D.packageLabel(p), price: round(p.shop_price), days: p.days || 30 })),
  };
}
route('GET', '/api/shop/renew', null, ({ query, ip }) => {
  enabled();
  throttle(ip, 'renew_lookup', 30);
  return renewalView(renewalLine(query.number));
});
route('POST', '/api/shop/renewals', null, ({ body, ip, req }) => {
  throttle(ip, 'order', 20);
  return createRenewal(body, { ip, clientId: str(req?.headers?.['x-client-id'] || body.clientId || '', 64) });
});
// A renewal order (kind 'recharge'): paid like any order (directly, or by transfer while that is on); once paid the shop's
// account renews the line (shop.fulfil → lines.renewLine), carried out by its supplier when it is one we automate.
function createRenewal(body, { ip, clientId = '' }) {
  const l = renewalLine(body.number);
  const p = renewalOptions(l).find((x) => x.id === Number(body.packageId));
  if (!p) fail(404, 'هذه الرزمة لا تصلح لتمديد هذا الرقم — اختر من القائمة');
  orderGuards({ number: l.number, contactPhone: body.contactPhone }, { ip, clientId });
  let contact = '';
  try { contact = body.contactPhone ? validPhone(normalizePhone(toLatinDigits(String(body.contactPhone)))) : ''; } catch {}
  const code = newCode();
  const t = now();
  q(`INSERT INTO shop_orders (code, package_id, package_label, kind, number, sim, customer_name, contact_phone, amount, esim_fee, ip, client_id, created_at, updated_at, esim)
     VALUES (?, ?, ?, 'recharge', ?, '', ?, ?, ?, 0, ?, ?, ?, ?, 0)`)
    .run(code, p.id, /تمديد/.test(p.name) ? D.packageLabel(p) : `تمديد ${D.packageLabel(p)}`, l.number, '', contact, round(p.shop_price), ip, clientId, t, t); // not the line's owner's name: whoever has the order sees it
  return orderView(byCode(code));
}

// A new order, with every check the web page's orders get (also made over WhatsApp, where ip and clientId name the chat).
async function createOrder(body, { ip, clientId = '' }) {
  const s = orderGuards(body, { ip, clientId });
  // eSIMs only (whatever the request asks for): a supplier's eSIM, or an Aylol new line as an eSIM.
  return newOrder(body, { ip, clientId, s });
}
// What every customer order is checked against first (an eSIM or a renewal): the hourly limit, one order waiting at a
// time per customer and per number, and per network. Returns the settings.
function orderGuards(body, { ip, clientId = '' }) {
  // At most so many orders an hour from one customer (their browser or chat, or their contact phone).
  const perHour = getSettings().shopHourLimit;
  if (perHour > 0) {
    let contact = '';
    try { contact = validPhone(normalizePhone(body.contactPhone || body.number || '')); } catch {}
    // Orders the customer cancelled (or whose hold ran out) do not count: they can order again (one waiting at a time).
    const n = q(`SELECT COUNT(*) AS c FROM shop_orders WHERE created_at > ? AND status != 'cancelled' AND ((? != '' AND client_id = ?) OR (? != '' AND contact_phone = ?))`)
      .get(now() - 60 * 60_000, clientId, clientId, contact, contact)?.c || 0;
    if (n >= perHour) fail(429, `وصلت إلى الحد الأقصى (${perHour} طلبات في الساعة). حاول لاحقاً أو تواصل معنا.`);
  }
  const s = enabled();
  shop.expireUnconfirmed();

  // Safety rule: A customer can hold at most 1 active reservation (awaiting_payment) at a time.
  if (clientId) {
    const activeClientOrder = q(`SELECT id, code, package_label FROM shop_orders
                                 WHERE client_id = ? AND status = 'awaiting_payment' AND created_at > ? LIMIT 1`)
                              .get(clientId, now() - RESERVE_MS);
    if (activeClientOrder) {
      fail(409, `لديك حجز نشط بالفعل (طلب رقم ${activeClientOrder.code}). يرجى إتمام الدفع أو إلغاء الحجز الحالي لحجز بطاقة جديدة.`, { code: activeClientOrder.code });
    }
  }

  // Prevent holding multiple lines with the same phone number
  const rawNum = body.contactPhone || body.number;
  if (rawNum) {
    const cleanNum = normalizePhone(rawNum);
    if (cleanNum && validPhone(cleanNum)) {
      const activePhoneOrder = q(`SELECT id, code FROM shop_orders
                                  WHERE (number = ? OR contact_phone = ?) AND status = 'awaiting_payment' AND created_at > ? LIMIT 1`)
                               .get(cleanNum, cleanNum, now() - RESERVE_MS);
      if (activePhoneOrder) {
        fail(409, `يوجد حجز نشط بالفعل مسجل بنفس الرقم (طلب رقم ${activePhoneOrder.code}). يرجى إتمام الدفع أو إلغاء الحجز السابق أولاً.`, { code: activePhoneOrder.code });
      }
    }
  }

  // Network anti-hoarding limit: Max concurrent active reservations from the same IP
  const MAX_ACTIVE_PER_IP = Number(process.env.SHOP_MAX_ACTIVE_PER_IP) || 15;
  const activeIpCount = q(`SELECT COUNT(*) AS c FROM shop_orders
                           WHERE ip = ? AND status = 'awaiting_payment' AND created_at > ?`).get(ip, now() - RESERVE_MS)?.c || 0;
  if (activeIpCount >= MAX_ACTIVE_PER_IP) {
    fail(429, 'تم الوصول للحد الأقصى لعدد الحجوزات المعلقة المتزامنة من هذه الشبكة. يرجى إتمام الدفع أو الانتظار حتى انتهاء مهلة الحجز.');
  }
  return s;
}
async function newOrder(body, { ip, clientId, s }) {
  const p = q(`SELECT p.*, c.name AS company_name, c.esim_fee AS company_esim_fee FROM packages p JOIN companies c ON c.id = p.company_id
               WHERE p.id = ? AND p.active = 1 AND p.shop_price > 0`).get(Number(body.packageId));
  const kind = p && shopKind(p);
  if (!kind) fail(404, 'الباقة غير متوفرة — المتجر يبيع شرائح eSIM فقط');
  if (kind === 'line') return aylolLineOrder(body, ip, clientId, p);
  return esimOrder(body, ip, clientId);
}

// A new line at Aylol (as its site sells it), as an eSIM: one of the eSIM numbers Aylol offers for the package, picked
// at random and held for this order (no other customer gets it), with the customer's full name; the eSIM and its QR
// code come with the activation, and the eSIM fee is added. Nothing is bought before the payment is verified; then
// the line is activated at Aylol.
async function aylolLineOrder(body, ip, clientId, p) {
  const AY = require('./aylol');
  AY.ensureBalanceFor(p);
  const customerName = str(body.customerName, 80);
  // The first name is enough: Aylol gets it as first and family name when only one is given (see aylol.splitName).
  if (customerName.length < 2 || /\d/.test(customerName)) fail(400, 'اكتب اسمك — مطلوب لتسجيل الخط');
  const email = str(body.email, 120).toLowerCase();
  if (email && !validAddress(email)) fail(400, 'البريد الإلكتروني غير صحيح');
  // What the package's line can be on, as the site says (asked the first time): sold only when it can be an eSIM.
  await AY.learnSimType(p);
  if (!AY.shopLineModes(p).includes('esim')) fail(404, 'الباقة غير متوفرة — المتجر يبيع شرائح eSIM فقط');
  const contact = body.contactPhone ? validPhone(normalizePhone(body.contactPhone)) : '';
  const list = await AY.billFreeNumbers(p.art_card_id, '', true);
  const held = new Set(heldNumbers().map((h) => h.number));
  const free = list.filter((n) => !held.has(n.phone) && !q("SELECT 1 FROM lines WHERE number = ? AND status != 'disconnected'").get(n.phone));
  setStock(p.id, free.map((n) => n.phone));
  if (!free.length) fail(409, 'نفدت أرقام eSIM لهذه الباقة الآن. جرّب باقة أخرى أو عد لاحقاً.');
  const picked = free[crypto.randomInt(free.length)];
  const s = getSettings();
  const esimFee = round(p.company_esim_fee === null || p.company_esim_fee === undefined ? s.esimFee : p.company_esim_fee);
  const t = now();
  const code = newCode();
  q(`INSERT INTO shop_orders (code, package_id, package_label, kind, number, sim, customer_name, contact_phone, amount, esim_fee, ip, client_id, created_at, updated_at, esim, number_id, email)
     VALUES (?, ?, ?, 'new', ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(code, p.id, D.packageLabel(p), picked.phone, customerName, contact, round(p.shop_price + esimFee), esimFee, ip, clientId, t, t, `ayl:${picked.phone}`, email);
  return orderView(byCode(code));
}

// An eSIM on a free number picked at random. It is held for this order (no other customer gets it) and checked again
// when it is sold; QuickLine's eSIM and QR code are kept with the order. The customer sees the number once paid.
async function esimOrder(body, ip, clientId = '') {
  const s = getSettings();
  const pk = esimPackage(body.packageId);
  require('./aylol').ensureBalanceFor(pk.p);
  const customerName = str(body.customerName, 80);
  if (customerName.length < 2) fail(400, 'اكتب اسمك — مطلوب لتسجيل الخط');
  const email = str(body.email, 120).toLowerCase();
  if (email && !validAddress(email)) fail(400, 'البريد الإلكتروني غير صحيح');
  const contact = body.contactPhone ? validPhone(normalizePhone(body.contactPhone)) : '';
  const list = await freeEsimNumbers(s, pk);
  const held = new Set(heldNumbers().map((h) => h.number));
  const free = list.filter((n) => !held.has(n.phone) && !q("SELECT 1 FROM lines WHERE number = ? AND status != 'disconnected'").get(n.phone));
  setStock(pk.p.id, free.map((n) => n.phone));
  if (!free.length) fail(409, 'نفدت أرقام eSIM لهذه الباقة الآن. جرّب باقة أخرى أو عد لاحقاً.');
  const picked = free[crypto.randomInt(free.length)];
  const t = now();
  const code = newCode();
  const hasCompanyFee = pk.p.company_esim_fee !== null && pk.p.company_esim_fee !== undefined;
  const compFee = hasCompanyFee ? round(pk.p.company_esim_fee) : s.esimFee;
  const esimFee = (hasCompanyFee || body.includeEsimFee) ? round(compFee) : 0;
  const totalAmount = round(pk.p.shop_price + esimFee);
  // The eSIM's code and QR come only from the supplier (QuickLine gives them with the number; Layan and telecom when
  // the line is activated after payment) or from the manager who carries the order out. Nothing is made up here.
  const esimCode = '';
  const qrData = shop.realQr(picked.qr || '');
  const row = q(`INSERT INTO shop_orders (code, package_id, package_label, kind, number, sim, customer_name, contact_phone, amount, esim_fee, esim_code, ip, client_id, created_at, updated_at,
       esim, number_id, esim_qr, email) VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(code, pk.p.id, D.packageLabel(pk.p), picked.phone, String(picked.sim || '').replace(/\D/g, ''), customerName, contact, totalAmount, esimFee, esimCode, ip, clientId, t, t,
      picked.id, qrData, email);
  return orderView(byCode(code));
}

// There is no unpaid ("instant") activation: an order is carried out only once its payment is verified.
route('POST', '/api/shop/orders/:code/instant', null, ({ params, ip }) => {
  enabled();
  throttle(ip, 'proof', 30);
  byCode(params.code, ip);
  fail(403, 'يتم التفعيل وإظهار الكود بعد التحقق من الدفع فقط. أرسل إثبات التحويل من صفحة الطلب.');
});

route('GET', '/api/shop/orders/:code', null, async ({ params, query, ip }) => {
  throttle(ip, 'view', 600);
  shop.expireUnconfirmed();
  shop.escalate();
  let o = byCode(params.code, ip);
  if (o.status === 'verifying' || o.status === 'review') {
    if (query.check === '1') throttle(ip, 'mail_check', 30);
    if (!shop.tryMatch(o.id) && (query.check === '1' || Number(o.proof_tries) >= 2)) {
      // check=1: the customer opened their order (not the page's own refresh): Gemini looks at it too.
      try { await shop.checkMail({ asked: query.check === '1' }); } catch (e) { console.error('shop mail', e.message); }
    }
    o = byCode(params.code);
  }
  // A direct Jawwal Pay confirmation without a clear answer: its invoice is looked up (at most once a minute).
  if (o.jc_unsure && ['awaiting_payment', 'cancelled'].includes(o.status)) {
    try { await shop.reconcileDirect(); } catch (e) { console.error('jawwal reconcile', e.message); }
    o = byCode(params.code);
  }
  return orderView(o);
});

// The customer's transfer details. At least one way to verify: reference, sender phone, sender name or the receipt.
// Attempt 1 checks emails from the last 5 minutes; if unmatched, the customer gets 1 retry within 3 minutes (searching the last 8 minutes).
route('POST', '/api/shop/orders/:code/proof', null, async ({ params, body, ip }) => {
  enabled();
  throttle(ip, 'proof', 30);
  return submitProof(byCode(params.code, ip), body);
}, { maxBody: 2200 * 1024 });

// The customer's payment details (also sent over WhatsApp): matched against the Jawwal Pay / PalPay e-mails received.
async function submitProof(order, body) {
  shop.expireUnconfirmed();
  shop.escalate();
  const o = q('SELECT * FROM shop_orders WHERE id = ?').get(order.id);
  if (o.status === 'cancelled') fail(400, 'انتهت مهلة حجز الرقم (10 دقائق) دون تأكيد الإرسال وتم إلغاء الطلبية تلقائياً');
  if (!['awaiting_payment', 'verifying', 'review'].includes(o.status)) fail(400, 'تم التعامل مع هذا الطلب');
  const prevTries = Number(o.proof_tries) || 0;
  // Manual transfers stopped: a new one is not taken (one already sent may still be corrected).
  const st = getSettings();
  if (!st.mailPay && st.jcReady && o.status === 'awaiting_payment' && !prevTries) {
    fail(400, 'الدفع بالتحويل اليدوي متوقف حالياً — ادفع مباشرة من جوال باي من صفحة طلبك (يصلك رمز تحقق).');
  }
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
    try { await shop.checkMail({ force: true, asked: true }); } catch (e) { console.error('shop mail', e.message); }
  }
  return orderView(byCode(o.code));
}

// ---------- direct Jawwal Pay: a code to the customer's mobile, the payment confirmed with it ----------
// Through the MaalCards corporate API (src/jawwalcorp.js). The money is taken from the customer's wallet only when
// they confirm with the code they received; the order is then paid and carried out as any paid order.
const jc = require('../jawwalcorp');
const { jcCredentials } = require('../db');
const jcBusy = new Set(); // orders with a code being sent or a payment being confirmed now
// E-SADAD not confirmed yet: /settle asked this many times, this far apart, before the customer is answered.
const SETTLE_TRIES = Number(process.env.JC_SETTLE_TRIES) || 2;
const SETTLE_MS = Number(process.env.JC_SETTLE_MS) || 3000;

// The manager hears about a problem with the corporate account once in a while, not on every customer's try.
const jcTold = new Map();
function tellManager(code, body) {
  if (now() - (jcTold.get(code) || 0) < 30 * 60_000) return;
  jcTold.set(code, now());
  D.notify({ role: 'admin', kind: 'task', title: 'الدفع المباشر عبر جوال باي متوقف', body, link: '#/shop' });
}

// The corporate API's refusal as the customer should read it (the manager is told when the account itself is at fault).
// step: 'send' (the code) or 'confirm' (the payment). A refusal the API gives for the request itself (4xx other than the
// account's: 401/403/429) is the number's or the code's, not "unreachable".
function jcFail(e, o = null, step = '') {
  if (!(e instanceof jc.JawwalCorpError)) throw e;
  console.error('jawwal', step, e.status, e.code, e.message, e.data ? JSON.stringify(e.data).slice(0, 300) : '');
  if (o) shop.jcLog(o, `${step || 'call'}_error`, { detail: `${e.status || ''} ${e.code || ''} ${e.message || ''}`.trim() });
  const manual = getSettings().mailPay ? ' يمكنك الدفع بالتحويل اليدوي أدناه.' : '';
  if (e.code === 'corporate_blocked') {
    tellManager(e.code, 'الحساب ممنوع مؤقتاً 15 دقيقة بعد محاولات دخول متكررة (corporate_blocked). تأكد أن الحساب لا يُستخدم من خادم أو برنامج آخر في نفس الوقت.');
  } else if (['invalid_credentials', 'account_disabled', 'corporate_api_disabled', 'not_configured'].includes(e.code)) {
    tellManager(e.code, `رفضت واجهة الشركات الدخول (${e.code}). راجع رقم المشترك واسم المستخدم وكلمة المرور في إعدادات المتجر.`);
  }
  if (e.status === 429 || e.status === 401 || e.status === 403 || e.code === 'not_configured') fail(503, `الدفع المباشر غير متاح الآن — حاول بعد دقيقة.${manual}`);
  if (e.code === '14') fail(422, 'هذا الرقم غير مسجّل لدى بنك فلسطين — استخدم رقم الجوال المسجّل في حسابك البنكي.');
  if (e.code === 'esdad_bank_mobile_unavailable') fail(503, 'بنك فلسطين لا يقبل الدفع برقم الجوال حالياً — ادفع من محفظة جوال باي.');
  if (e.code === 'sadad_banks_not_enabled' || e.code === 'invalid_bank') {
    tellManager(e.code, `الدفع من بنك فلسطين مرفوض من MaalCards (${e.code}). أوقفه من إعدادات المتجر أو راجعهم.`);
    fail(503, 'الدفع من البنك غير متاح حالياً — ادفع من محفظة جوال باي.');
  }
  if (/^esdad_/.test(e.code || '')) {
    tellManager('esdad', `مزوّد الدفع (MaalCards) لم يكمل العملية مع جوال باي: ${e.code} — ${String(e.message).slice(0, 200)}. هذا خلل عندهم: أرسل لهم الرمز والوقت.`);
    fail(503, `الدفع المباشر من جوال باي متوقف مؤقتاً عند مزوّد الدفع — جرّب بعد قليل.${manual}`);
  }
  const requestRefused = e.status >= 400 && e.status < 500;
  if (e.code === 'jawwal_send_otp_failed' || (step === 'send' && requestRefused)) fail(422, 'تعذّر إرسال رمز التحقق لهذا الرقم. تأكد أنه رقم جوال مفعّل عليه جوال باي.');
  if (step === 'confirm' && requestRefused) fail(402, 'رمز التحقق غير صحيح أو رُفض الدفع — تأكد من الرمز وحاول مرة أخرى.');
  if (e.status === 400) fail(400, 'بيانات الدفع غير مكتملة. تأكد من الرقم وحاول مرة أخرى.');
  fail(502, `تعذّر الوصول إلى جوال باي الآن — حاول بعد قليل.${manual}`);
}

function directOrder(code, ip) {
  const s = enabled();
  if (!s.jcReady) fail(403, 'الدفع المباشر عبر جوال باي غير متاح حالياً');
  shop.expireUnconfirmed();
  return byCode(code, ip);
}

// A code for the order's amount to the customer's Jawwal Pay mobile. A new code replaces the earlier one (only the
// last can be confirmed), a few per order, not more often than every 45 seconds.
route('POST', '/api/shop/orders/:code/jawwal/otp', null, async ({ params, body, ip }) => {
  throttle(ip, 'jc_otp', 15);
  return jcSendCode(directOrder(params.code, ip), body.mobile, body.bank);
});
// Shared by the order page and the WhatsApp chat: every check and limit is the same.
// The banks a customer may pay from besides the Jawwal Pay wallet (by mobile number): Bank of Palestine, when allowed.
const jcBanks = (s = getSettings()) => (s.jcReady && s.jcPals ? ['PALS'] : []);
const BANK_NAME = { PALS: 'بنك فلسطين' };
async function jcSendCode(o, mobileInput, bankInput = '') {
  const bank = String(bankInput || '').toUpperCase() === 'JWLP' ? '' : String(bankInput || '').toUpperCase();
  if (bank && !jcBanks().includes(bank)) fail(400, 'طريقة الدفع غير متاحة — اختر محفظة جوال باي');
  if (o.status === 'cancelled') fail(400, 'انتهت مهلة حجز الرقم وتم إلغاء الطلب. اطلب من جديد.');
  if (o.status !== 'awaiting_payment' || o.proof_at) fail(400, 'تم التعامل مع هذا الطلب');
  if (o.jc_unsure) fail(409, 'جارٍ التأكد من دفعتك السابقة لدى جوال باي — انتظر لحظة.');
  const mobile = normalizePhone(toLatinDigits(String(mobileInput || '')));
  if (!/^05\d{8}$/.test(mobile)) fail(400, bank ? 'اكتب رقم جوالك المسجّل في البنك (10 أرقام يبدأ بـ 05)' : 'اكتب رقم جوالك المسجّل في جوال باي (10 أرقام يبدأ بـ 05)');
  if ((o.jc_sends || 0) >= JC_SENDS_MAX) fail(429, 'وصلت إلى الحد الأقصى لرموز التحقق لهذا الطلب. ادفع بالتحويل اليدوي أو تواصل معنا.');
  if (o.jc_sent_at && now() < o.jc_sent_at + JC_RESEND_MS) fail(429, `انتظر ${Math.ceil((o.jc_sent_at + JC_RESEND_MS - now()) / 1000)} ثانية قبل طلب رمز جديد`);
  if (jcBusy.has(o.id)) fail(409, 'جارٍ إرسال الرمز…');
  jcBusy.add(o.id);
  try {
    let r;
    try {
      r = await jc.sendOtp(jcCredentials(), { mobile, amount: o.amount, bank });
    } catch (e) {
      // Counted even when refused: a number that cannot take codes is not tried forever.
      q('UPDATE shop_orders SET jc_sends = jc_sends + 1, jc_sent_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), o.id);
      jcFail(e, o, 'send');
    }
    // The invoice must be for exactly the order's amount, or it is not used.
    if (r.amount !== null && Math.abs(r.amount - Number(o.amount)) > 0.005) {
      console.error('jawwal amount mismatch', o.code, o.amount, r.amount);
      shop.jcLog({ ...o, jc_invoice_id: r.invoiceId }, 'otp_mismatch', { detail: `المبلغ ${r.amount} وليس ${o.amount}` });
      fail(502, 'رد جوال باي بمبلغ مختلف عن الطلب. تواصل مع الدعم.');
    }
    const until = Math.min(r.expiresAt && r.expiresAt > now() ? r.expiresAt : now() + JC_HOLD_MS, now() + JC_HOLD_MS);
    q(`UPDATE shop_orders SET jc_invoice_id = ?, jc_mobile = ?, jc_expires_at = ?, jc_sent_at = ?, jc_sends = jc_sends + 1, jc_tries = 0,
         jc_status = 'pending', jc_bank = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_payment'`).run(r.invoiceId, mobile, until, now(), bank, now(), o.id);
    shop.jcLog({ ...o, jc_invoice_id: r.invoiceId }, 'otp_sent', { status: 'pending', detail: `${r.amount ?? o.amount} ₪ → ${maskMobile(mobile)}${bank ? ` (${BANK_NAME[bank] || bank})` : ''}` });
  } finally {
    jcBusy.delete(o.id);
  }
  return orderView(byCode(o.code));
}

// The code the customer received: the payment is taken and the order carried out. A refused code can be tried again
// (a few times) while it lasts; no clear answer (timeout, 5xx) means the invoice is looked up before anything else,
// so a payment that went through is never lost nor taken twice.
route('POST', '/api/shop/orders/:code/jawwal/confirm', null, async ({ params, body, ip }) => {
  throttle(ip, 'jc_confirm', 40);
  return jcConfirmCode(directOrder(params.code, ip), body.otp);
});
async function jcConfirmCode(order, otpInput) {
  let o = order;
  if (o.status === 'paid') return orderView(o);
  if (o.status !== 'awaiting_payment' || !o.jc_invoice_id) fail(400, o.status === 'cancelled' ? 'انتهت مهلة حجز الرقم وتم إلغاء الطلب.' : 'اطلب رمز التحقق أولاً');
  const otp = toLatinDigits(String(otpInput || '')).replace(/\D/g, '');
  if (!/^\d{4,8}$/.test(otp)) fail(400, 'اكتب رمز التحقق كما وصلك في الرسالة');
  if (!jcPending(o) && !o.jc_unsure) fail(410, 'انتهت صلاحية رمز التحقق — اطلب رمزاً جديداً');
  if ((o.jc_tries || 0) >= JC_TRIES_MAX) fail(429, 'محاولات كثيرة بهذا الرمز — اطلب رمزاً جديداً');
  if (jcBusy.has(o.id)) fail(409, 'جارٍ تأكيد الدفع…');
  jcBusy.add(o.id);
  const creds = jcCredentials();
  let paid = false;
  let confirmed = null; // what confirming (or /settle) answered when it said yes
  try {
    q('UPDATE shop_orders SET jc_tries = jc_tries + 1, updated_at = ? WHERE id = ?').run(now(), o.id);
    try {
      confirmed = await jc.confirmPayment(creds, { invoiceId: o.jc_invoice_id, otp });
      paid = true;
    } catch (e) {
      if (!(e instanceof jc.JawwalCorpError)) throw e;
      if (e.code === 'invoice_confirmed') paid = true; // an earlier confirmation that got no answer went through
      else if (e.code === 'esdad_session_gone') {
        // The provider's payment session ended: this code can no longer be used (a payment it may have taken is still
        // looked up, when one was unclear before).
        q('UPDATE shop_orders SET jc_expires_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), o.id);
        shop.jcLog(o, 'session_gone', { detail: `${e.code} ${e.message}` });
        fail(410, 'انتهت جلسة الدفع عند جوال باي — اطلب رمزاً جديداً.');
      } else if (/^esdad_/.test(e.code || '')) {
        // E-SADAD has not confirmed it yet (esdad_payment_not_confirmed): the payment is pending, not refused. As the
        // guide says, it is asked again with /settle every few seconds (never charged twice); still pending after
        // that, the customer is told so — the payment keeps being followed (reconcileDirect, a day): confirmed later,
        // the order is paid with it (or the manager is told, if the order was paid another way meanwhile). A wrong
        // code ends there too, so a new code may be asked for at once.
        console.error('jawwal confirm provider', o.code, e.code, e.message);
        let st = null;
        for (let i = 0; i < SETTLE_TRIES && !paid; i++) {
          await new Promise((r) => setTimeout(r, SETTLE_MS));
          try { st = await shop.invoiceState(jc, creds, o.jc_invoice_id); } catch (e2) { console.error('jawwal settle', e2.message); }
          if (st?.status === 'confirmed') { paid = true; confirmed = st.raw || null; } else if (st && st.status !== 'pending') break;
        }
        if (!paid) {
          shop.jcLog(o, 'not_confirmed', { status: st?.status || 'pending', detail: `${e.code} ${e.message}` });
          q('UPDATE shop_orders SET jc_expires_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), o.id);
          if (st && st.status !== 'pending') fail(402, 'لم يتم الدفع — رمز التحقق غير صحيح أو انتهت صلاحيته. اطلب رمزاً جديداً وأدخله كما وصلك.');
          fail(402, 'لم يتأكد الدفع بعد — إذا كان الرمز صحيحاً نكمل التحقق تلقائياً ونبلغك فور تأكيده؛ وإذا كان غلطاً اطلب رمزاً جديداً.');
        }
      } else if (e.code === 'invoice_expired' || e.code === 'invoice_not_found') {
        q("UPDATE shop_orders SET jc_expires_at = ?, jc_unsure = 0, jc_status = 'expired', updated_at = ? WHERE id = ?").run(now(), now(), o.id);
        shop.jcLog(o, 'expired', { status: 'expired', detail: e.code });
        fail(410, 'انتهت صلاحية رمز التحقق — اطلب رمزاً جديداً');
      } else if (e.code === 'jawwal_confirm_failed') {
        const canRetry = !!(e.data && (e.data.can_retry === true || e.data.can_retry === 1 || e.data.can_retry === '1'));
        console.error('jawwal confirm refused', o.code, e.data?.failure_code, e.message);
        shop.jcLog(o, 'confirm_refused', { status: canRetry ? 'pending' : 'failed', detail: `${e.data?.failure_code || ''}${canRetry ? ' (يمكن إعادة المحاولة)' : ''}` });
        if (!canRetry) q("UPDATE shop_orders SET jc_expires_at = ?, jc_status = 'failed', updated_at = ? WHERE id = ?").run(now(), now(), o.id);
        fail(402, canRetry
          ? 'رمز التحقق غير صحيح أو رُفض الدفع — تأكد من الرمز وحاول مرة أخرى.'
          : 'رفض جوال باي الدفع (قد يكون الرصيد غير كافٍ). اشحن محفظتك ثم اطلب رمزاً جديداً، أو ادفع بالتحويل اليدوي.');
      } else if (e.unsure) {
        // The payment may have gone through: its invoice says.
        let inv = null;
        try { inv = await shop.invoiceState(jc, creds, o.jc_invoice_id); } catch (e2) { console.error('jawwal invoice', e2.message); }
        shop.jcLog(o, 'confirm_unclear', { status: inv?.status || '', detail: e.message });
        if (inv?.status === 'confirmed') paid = true;
        else if (inv && inv.status === 'pending') fail(502, 'لم يكتمل تأكيد الدفع — أعد إدخال الرمز. لن يُخصم المبلغ مرتين.');
        else if (!inv) {
          q('UPDATE shop_orders SET jc_unsure = 1, updated_at = ? WHERE id = ?').run(now(), o.id);
          fail(502, 'لم يصلنا رد جوال باي بعد. سنتحقق من دفعتك تلقائياً خلال دقائق — لا تدفع مرة أخرى، وتابع صفحة الطلب.');
        } else jcFail(e, o, 'confirm');
      } else jcFail(e, o, 'confirm');
    }
    if (paid) {
      // success: true means confirmed (the guide). The invoice as listed, when the list has it, is still checked for
      // this order's amount and mobile (a mismatch goes to the manager); not listed (yet), confirming's word is enough.
      shop.jcLog(o, 'confirm_ok', { status: 'confirmed', detail: confirmed?.paid_via ? `${confirmed.paid_via}${confirmed.bank ? ` ${confirmed.bank}` : ''}` : '' });
      let listed = null;
      try { listed = await jc.invoice(creds, o.jc_invoice_id); } catch (e2) { console.error('jawwal invoice', e2.message); }
      const c = confirmed && typeof confirmed === 'object' ? confirmed : {};
      shop.settleVerified(o, {
        invoiceId: o.jc_invoice_id, status: 'confirmed',
        amount: listed?.amount ?? (c.amount != null && c.amount !== '' ? Number(c.amount) : null),
        mobile: listed?.mobile || String(c.mobile_number || ''), raw: listed?.raw || c,
      });
    }
  } finally {
    jcBusy.delete(o.id);
  }
  o = byCode(o.code);
  return orderView(o);
}

route('POST', '/api/shop/orders/:code/cancel', null, ({ params, ip }) => {
  throttle(ip, 'cancel', 30);
  return cancelOrder(byCode(params.code, ip));
});
// The customer cancels their order (from the page or the WhatsApp chat) as long as it is not paid: waiting for the
// transfer, for its check, or with the manager. Once paid (being carried out or done) it is not. One cancelled after
// the transfer details were sent goes to the manager: money may have come in, to give back or use for a new order.
const CANCELLABLE = ['awaiting_payment', 'verifying', 'review'];
const CUSTOMER_CANCELLED = 'ألغيت الطلب بنفسك';
function cancelOrder(order) {
  const o = q('SELECT * FROM shop_orders WHERE id = ?').get(order.id);
  if (o.status === 'cancelled') return orderView(o);
  if (!CANCELLABLE.includes(o.status)) fail(400, 'الطلب مدفوع وبيتنفّذ أو انتهى — ما بينلغى. إذا في مشكلة تواصل مع الدعم، وفيك تعمل طلب جديد وقت ما بدك.');
  if (jcBusy.has(o.id) || o.jc_unsure) fail(409, 'جارٍ تأكيد الدفع من جوال باي — انتظر لحظة.');
  const done = q(`UPDATE shop_orders SET status = 'cancelled', response = ?, updated_at = ?
                  WHERE id = ? AND status IN ('awaiting_payment','verifying','review')`).run(CUSTOMER_CANCELLED, now(), o.id).changes;
  // Paid in the meantime (its payment was just confirmed): it goes on.
  if (!done) fail(409, 'تأكد الدفع للتو والطلب بيتنفّذ — ما بينلغى.');
  if (o.status !== 'awaiting_payment') {
    const payer = [o.pay_name, o.pay_phone, o.pay_reference].filter(Boolean).join(' / ') || (o.receipt ? 'صورة إشعار' : '');
    D.notify({ role: 'admin', kind: 'task', title: `الزبون ألغى الطلب ${o.code} بعد إرسال بيانات التحويل`,
      body: `${o.package_label} — ${o.amount} ₪${payer ? ` — المحوِّل: ${payer}` : ''}. إذا وصل تحويله: رجّعه، أو استعمله لطلبه الجديد.`, link: '#/shop' });
  }
  return orderView(byCode(o.code));
}

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
  const jawwalLog = q('SELECT event, status, detail, created_at AS at FROM jc_log WHERE order_id = ? ORDER BY id').all(o.id);
  return { ...orderView(o, { admin: true }), receipt: o.receipt, mail: m && { ...mailView(m), body: m.body }, candidates: candidates.map(mailView), jawwalLog };
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

// The corporate account works: it signs in only if no token is held (reusing the one held otherwise) and lists one invoice.
route('POST', '/api/shop/admin/jawwal/test', ADMIN, async () => {
  if (!getSettings().jcConfigured) fail(400, 'أدخل رقم المشترك واسم المستخدم وكلمة المرور أولاً');
  try {
    const list = await jc.invoices(jcCredentials(), { limit: 1 });
    return { ok: true, invoices: list.length, ...jc.status() };
  } catch (e) {
    if (!(e instanceof jc.JawwalCorpError)) throw e;
    const wait = e.retryAfter ? ` — أعد المحاولة بعد ${Math.ceil(e.retryAfter / 60)} دقيقة` : '';
    fail(502, `${e.code || e.status || 'خطأ'}: ${e.message}${wait}`);
  }
});
route('GET', '/api/shop/admin/jawwal/status', ADMIN, () => jc.status());
route('POST', '/api/shop/admin/orders/:id/jawwal-check', ADMIN, async ({ params }) => {
  const o = adminOrder(params.id);
  if (!o.jc_invoice_id) fail(400, 'هذا الطلب ليس له فاتورة جوال باي مباشرة');
  let inv = null;
  try {
    inv = await shop.invoiceState(jc, jcCredentials(), o.jc_invoice_id);
  } catch (e) {
    if (!(e instanceof jc.JawwalCorpError)) throw e;
    fail(502, `تعذّرت قراءة الفاتورة: ${e.code || e.status || ''} ${e.message}`);
  }
  if (inv && ['awaiting_payment', 'cancelled'].includes(o.status)) shop.settleVerified(o, inv);
  return { ...orderView(adminOrder(o.id), { admin: true }), invoice: inv ? { status: inv.status, amount: inv.amount, mobile: inv.mobile, raw: inv.raw } : null };
});

// Gemini's payment review: the model answers on this server, and how its last look went.
route('POST', '/api/shop/admin/ai/test', ADMIN, async () => {
  const aipay = require('../aipay');
  try {
    return await aipay.test();
  } catch (e) {
    if (!(e instanceof aipay.AiPayError)) throw e;
    fail(502, e.message);
  }
});
route('GET', '/api/shop/admin/ai/status', ADMIN, () => ({ ...shop.aiState, ready: require('../aipay').ready() }));

route('GET', '/api/shop/admin/summary', ADMIN, () => ({
  open: q("SELECT COUNT(*) AS n FROM shop_orders WHERE status IN ('verifying','review') OR (status = 'paid' AND line_id IS NULL)").get().n,
  agentId: shop.shopAgent().id,
}));

// The WhatsApp chat pays an order directly too: the order as the page would find it (direct payment on, holds expired).
const directOrderByCode = (code) => directOrder(code);
module.exports = { shopCatalogResponse, shopCatalog, ensureStock, submitProof, orderView, byCode, createOrder, cancelOrder, refreshStock,
  renewalLine, renewalOptions, renewalView, createRenewal,
  jcSendCode, jcConfirmCode, directOrderByCode, _resetThrottle: () => hits.clear() };
