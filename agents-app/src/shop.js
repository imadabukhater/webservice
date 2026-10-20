'use strict';
// Customer shop orders paid by JawwalPay (for now eSIMs: a QuickLine number picked by the customer, its QR code shown and
// e-mailed once active). A transfer is confirmed automatically when an authenticated JawwalPay email
// in Gmail has the order's exact amount and matches what the customer reported (reference, sender phone or name).
// Anything else goes to the manager. Paid orders are sold through the "shop" agent account, so they follow the same
// rules as any agent sale (manual companies become tasks, art-topup recharges run automatically).
const crypto = require('node:crypto');
const { q, tx, getSettings, setSetting, gmailCredentials } = require('./db');
const { ApiError, now } = require('./util');
const { hashPassword } = require('./passwords');
const D = require('./domain');
const mail = require('./mail');
const smtp = require('./smtp');
const ql = require('./quickline');
const { createLine } = require('./routes/lines');

const VERIFY_MS = Number(process.env.SHOP_VERIFY_MS) || 15 * 60_000; // unmatched this long after the proof: to the manager
const LOOP_MS = Number(process.env.MAIL_LOOP_MS) || 60_000;
const IMAP = {
  host: process.env.IMAP_HOST || 'imap.gmail.com',
  port: Number(process.env.IMAP_PORT) || 993,
  secure: process.env.IMAP_SECURE !== '0',
};
// The eSIM's QR code goes to the customer from the same Gmail.
const SMTP = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE !== '0',
};
const MAIL_TRIES = 5;

// ---------- the shop's agent account ----------
function shopAgent() {
  const id = Number(q("SELECT value FROM settings WHERE key = 'shop_agent_id'").get()?.value);
  const u = id && q("SELECT * FROM users WHERE id = ? AND role = 'agent'").get(id);
  if (u) return u;
  let username = 'shop';
  for (let i = 2; q('SELECT 1 FROM users WHERE username = ?').get(username); i++) username = `shop${i}`;
  const newId = Number(q("INSERT INTO users (role, name, username, password_hash, notes, created_at) VALUES ('agent', 'متجر الزبائن', ?, ?, ?, ?)")
    .run(username, hashPassword(crypto.randomBytes(18).toString('base64url')), 'حساب طلبات موقع الزبائن', now()).lastInsertRowid);
  setSetting('shop_agent_id', newId);
  return D.getUser(newId);
}

// ---------- matching ----------
const normRef = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const nameTokens = (s) => String(s || '').toLowerCase()
  .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((t) => t.length > 1);

// Every word of the shorter name appears in the longer one; a single word must be the whole name.
function namesMatch(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (!A.length || !B.length) return false;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  if (short.length < 2 && A.join(' ') !== B.join(' ')) return false;
  return short.every((t) => long.includes(t));
}

function matchReason(o, m) {
  if (m.trusted !== undefined && !m.trusted) return null;
  if (o.pay_reference && m.reference) {
    const refA = normRef(o.pay_reference);
    const refB = normRef(m.reference);
    return refA.length >= 3 && refA === refB ? 'الرقم المرجعي' : null;
  }
  if (o.pay_phone && m.sender_phone) {
    return o.pay_phone === m.sender_phone ? 'رقم المحوِّل' : null;
  }
  if (o.pay_name && m.sender_name && namesMatch(o.pay_name, m.sender_name)) return 'اسم المحوِّل';
  return null;
}

// The oldest unused authenticated email with the order's amount that matches the customer's details.
function findMail(o) {
  const mails = q(`SELECT * FROM payment_mails WHERE order_id IS NULL AND trusted = 1 AND amount IS NOT NULL
                   AND ABS(amount - ?) < 0.005 AND received_at >= ? ORDER BY received_at, id`).all(o.amount, o.created_at - 10 * 60_000);
  const rank = { 'الرقم المرجعي': 0, 'رقم المحوِّل': 1, 'اسم المحوِّل': 2 };
  let best = null;
  for (const m of mails) {
    const by = matchReason(o, m);
    if (by && (!best || rank[by] < rank[best.by])) best = { mail: m, by };
  }
  return best;
}

// Marks the order paid with this email (each email pays one order only). Returns true when it did.
function claim(orderId, mailId, verifiedBy) {
  return tx(() => {
    const o = q("SELECT * FROM shop_orders WHERE id = ? AND status IN ('awaiting_payment','verifying','review')").get(orderId);
    if (!o) return false;
    if (mailId && !q('UPDATE payment_mails SET order_id = ? WHERE id = ? AND order_id IS NULL').run(orderId, mailId).changes) return false;
    q("UPDATE shop_orders SET status = 'paid', mail_id = ?, paid_at = ?, verified_by = ?, updated_at = ? WHERE id = ?")
      .run(mailId || null, now(), verifiedBy, now(), orderId);
    return true;
  });
}

function tryMatch(orderId) {
  const o = q("SELECT * FROM shop_orders WHERE id = ? AND status IN ('verifying','review')").get(orderId);
  if (!o) return false;
  const hit = findMail(o);
  if (!hit || !claim(o.id, hit.mail.id, `تلقائي: ${hit.by}`)) return false;
  fulfil(o.id);
  return true;
}

// ---------- fulfilment ----------
const ACTOR_NAME = 'موقع الزبائن';

function makeEsimQr(code, label = '') {
  const s = String(code || 'LPA:1$rsp.esim.local$ACTIVATE');
  const hash = crypto.createHash('sha256').update(s).digest();
  const N = 29;
  const grid = Array.from({ length: N }, () => Array(N).fill(0));
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
      const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                 (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                 (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      grid[rr][cc] = on ? 1 : 2;
    }
  };
  finder(0, 0); finder(0, N - 7); finder(N - 7, 0);
  for (let i = 8; i < N - 8; i++) {
    grid[6][i] = i % 2 === 0 ? 1 : 2;
    grid[i][6] = i % 2 === 0 ? 1 : 2;
  }
  for (let r = 20; r <= 24; r++) for (let c = 20; c <= 24; c++) {
    const on = r === 20 || r === 24 || c === 20 || c === 24 || (r === 22 && c === 22);
    grid[r][c] = on ? 1 : 2;
  }
  let bitIdx = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (grid[r][c] !== 0) continue;
    const byte = hash[Math.floor(bitIdx / 8) % hash.length];
    const bit = (byte >> (bitIdx % 8)) & 1;
    grid[r][c] = ((bit ^ ((r * 3 + c * 5) & 1)) & 1) ? 1 : 2;
    bitIdx++;
  }
  const cell = 7, pad = 21, size = N * cell + pad * 2;
  let rects = '';
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (grid[r][c] === 1) rects += `<rect x="${pad + c * cell}" y="${pad + r * cell}" width="${cell}" height="${cell}" rx="1.2"/>`;
  }
  const safeLabel = String(label || '').replace(/[<>&"]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size + (safeLabel ? 22 : 0)}" width="280" height="280">` +
    `<rect width="100%" height="100%" rx="16" fill="#ffffff"/>` +
    `<g fill="#0f172a">${rects}</g>` +
    (safeLabel ? `<text x="${size / 2}" y="${size + 14}" text-anchor="middle" font-family="monospace" font-size="11" font-weight="bold" fill="#334155">${safeLabel}</text>` : '') +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// Credits the shop account with the customer's payment and sells the package from it, in one transaction.
// A refusal (e.g. the number belongs to another agent) leaves the order paid with the reason, for the manager.
function fulfil(orderId) {
  const o = q("SELECT * FROM shop_orders WHERE id = ? AND status = 'paid' AND line_id IS NULL").get(orderId);
  if (!o) return null;
  // An eSIM is sold on the number the customer picked, which the order kept: it goes back on the list of numbers
  // shown, which a sale is checked against (payment may have taken longer than that list lasts).
  const art = o.esim ? q('SELECT art_card_id FROM packages WHERE id = ?').get(o.package_id)?.art_card_id || '' : '';
  const qlRef = /^qln:/.test(art) ? ql.parseRef(art) : null;
  const lyRef = /^lyn:/.test(art) ? require('./layan').parseRef(art) : null;
  if (qlRef) require('./routes/quickline').remember(qlRef.packageId, true, [{ id: o.number_id, phone: o.number, sim: o.sim, qr: o.esim_qr }]);
  if (lyRef) require('./routes/layan').rememberEsim(lyRef.packageId, [o.number]);
  const tcRef = /^tcn:/.test(art) ? require('./telecom').parseRef(art) : null;
  if (tcRef) require('./routes/telecom').rememberEsim(tcRef.packageId, [o.number]);
  try {
    const r = tx(() => {
      const agent = shopAgent();
      D.changeBalance(agent, o.amount, { type: 'topup', actor: { id: null, name: ACTOR_NAME }, detail: `دفعة جوال باي — طلب ${o.code}` });
      const note = `طلب موقع الزبائن ${o.code}`;
      const sale = createLine(agent, o.esim
        ? { kind: 'new', esim: true, number: o.number, qlNumberId: o.number_id, packageId: o.package_id, months: 1, customerName: o.customer_name, customerPrice: o.amount, note,
          customerEmail: o.email, customerPhone: o.contact_phone }
        : { kind: o.kind === 'recharge' ? 'external' : 'new', number: o.number, sim: o.sim, packageId: o.package_id, months: 1, customerName: o.customer_name, customerPrice: o.amount, note });
      if (o.esim && o.esim_qr) {
        q("UPDATE lines SET esim_qr = COALESCE(NULLIF(esim_qr, ''), ?) WHERE id = ?").run(o.esim_qr, sale.line.id);
        if (!qlRef && !lyRef && !tcRef) {
          q("UPDATE lines SET status = 'active', activated_at = COALESCE(activated_at, ?), updated_at = ? WHERE id = ?").run(now(), now(), sale.line.id);
          q("UPDATE tasks SET status = 'done', resolved_at = ?, response = 'تفعيل فوري تلقائي لرمز QR' WHERE line_id = ? AND status = 'open'").run(now(), sale.line.id);
        }
      }
      q("UPDATE shop_orders SET line_id = ?, error = '', updated_at = ? WHERE id = ?").run(sale.line.id, now(), o.id);
      return sale;
    });
    D.notify({ role: 'admin', kind: 'line', title: `طلب زبون مدفوع ${o.code}`, body: `${o.package_label} — ${o.number} — ${o.amount} ₪`, link: '#/shop' });
    return r;
  } catch (e) {
    if (!(e instanceof ApiError)) console.error('shop fulfil', e);
    q('UPDATE shop_orders SET error = ?, updated_at = ? WHERE id = ?').run(String(e.message).slice(0, 300), now(), o.id);
    D.notify({ role: 'admin', kind: 'task', title: `طلب زبون مدفوع يحتاج تدخلك ${o.code}`, body: e.message, link: '#/shop' });
    return null;
  }
}

// ---------- the eSIM's QR code by e-mail ----------
const html = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function qrMail(o, s) {
  return `<!doctype html><html dir="rtl" lang="ar"><body style="margin:0;padding:24px;background:#f4f5f8;font-family:Tahoma,Arial,sans-serif;color:#111">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:24px">
    <h2 style="margin:0 0 10px">شريحتك الإلكترونية (eSIM) جاهزة</h2>
    <p style="margin:0 0 6px">${o.customer_name ? `مرحباً ${html(o.customer_name)}، ` : ''}تم تفعيل خطك:</p>
    <p style="margin:0 0 16px;font-size:20px;direction:ltr;text-align:right"><b>${html(o.number)}</b></p>
    <p style="margin:0 0 16px">${html(o.package_label)}</p>
    <p style="text-align:center;margin:0 0 16px"><img src="cid:esim-qr" alt="رمز QR لتثبيت eSIM" width="240" height="240" style="border:1px solid #ddd;border-radius:8px"></p>
    <p style="margin:0 0 6px"><b>طريقة التثبيت</b></p>
    <ul style="margin:0 0 16px;padding-inline-start:20px">
      <li>آيفون: الإعدادات ← الخلوي ← إضافة eSIM ← استخدام رمز QR.</li>
      <li>أندرويد: الإعدادات ← الاتصالات ← مدير SIM ← إضافة eSIM ← مسح رمز QR.</li>
    </ul>
    <p style="margin:0 0 6px;color:#555">امسح الرمز على جهاز واحد فقط واحتفظ بهذه الرسالة. يحتاج الجهاز إلى اتصال بالإنترنت أثناء التثبيت.</p>
    <p style="margin:0;color:#555">رقم الطلب: <span dir="ltr">${html(o.code)}</span>${s.supportWhatsapp ? ` · للمساعدة واتساب <span dir="ltr">${html(s.supportWhatsapp)}</span>` : ''}</p>
  </div></body></html>`;
}

// Sends each active eSIM's QR code once to the e-mail its customer gave. A failure is tried again on the next round,
// a few times, and then left to the manager (the QR code stays on the order page either way).
const mailTries = new Map();
async function deliverQr() {
  const s = getSettings();
  if (!s.gmailConfigured) return 0;
  const rows = q(`SELECT o.*, l.esim_qr AS line_qr FROM shop_orders o JOIN lines l ON l.id = o.line_id
                  WHERE o.esim = 1 AND o.email != '' AND o.qr_mailed_at IS NULL AND l.status = 'active' AND l.esim_qr != ''`).all();
  let sent = 0;
  for (const o of rows) {
    const tries = mailTries.get(o.id) || 0;
    if (tries >= MAIL_TRIES) continue;
    const img = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(o.line_qr);
    if (!img) continue;
    const creds = gmailCredentials();
    try {
      await smtp.sendMail({
        ...SMTP, user: creds.user, pass: creds.pass, fromName: s.appName, to: o.email, subject: `رمز تفعيل eSIM — ${o.number}`,
        html: qrMail(o, s), images: [{ cid: 'esim-qr', name: `esim-${o.number}.${img[1].split('/')[1].replace('jpeg', 'jpg')}`, type: img[1], content: Buffer.from(img[2], 'base64') }],
      });
      q('UPDATE shop_orders SET qr_mailed_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), o.id);
      mailTries.delete(o.id);
      sent++;
    } catch (e) {
      mailTries.set(o.id, tries + 1);
      console.error('shop qr mail', o.code, e.message);
      if (tries + 1 >= MAIL_TRIES) {
        D.notify({ role: 'admin', kind: 'task', title: `تعذّر إرسال رمز eSIM بالبريد ${o.code}`, body: `${o.email}: ${e.message}`, link: '#/shop' });
      }
    }
  }
  return sent;
}

// ---------- mailbox ----------
function saveMail(uidValidity, uid, raw, settings) {
  const p = mail.parseMessage(raw);
  if (p.messageId && q('SELECT 1 FROM payment_mails WHERE message_id = ?').get(p.messageId)) return null;
  const term = String(settings.mailFrom || '').toLowerCase();
  if (term && !p.from.toLowerCase().includes(term)) return null;
  const f = mail.parseJawwalPay(p, { ownNumber: settings.jawwalpayNumber });
  // Only money that came in can pay an order: a transfer sent from the wallet (or a one-time code) is kept without an
  // amount, so it never matches, even when its reference or the number it went to is known.
  if (!f.incoming) f.amount = null;
  const trusted = mail.authenticSender(p, term) ? 1 : 0;
  return Number(q(`INSERT OR IGNORE INTO payment_mails (uid_validity, uid, message_id, trusted, from_addr, subject, received_at, amount, reference,
                     sender_phone, sender_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uidValidity, uid, p.messageId, trusted, p.from.slice(0, 200), p.subject.slice(0, 300), p.date || now(), f.amount, f.reference || '',
      f.senderPhone || '', (f.senderName || '').slice(0, 80), p.text.slice(0, 8000), now()).lastInsertRowid) || null;
}

// Proofs nobody could match in time go to the manager.
function escalate() {
  const late = q("SELECT * FROM shop_orders WHERE status = 'verifying' AND proof_at < ?").all(now() - VERIFY_MS);
  for (const o of late) {
    q("UPDATE shop_orders SET status = 'review', updated_at = ? WHERE id = ? AND status = 'verifying'").run(now(), o.id);
    D.notify({ role: 'admin', kind: 'task', title: `تحقق يدوي من تحويل ${o.code}`, body: `${o.amount} ₪ — لم يُعثر على إشعار مطابق`, link: '#/shop' });
  }
  return late.length;
}

let running = null;
// Reads new payment emails, then matches waiting orders. force: read even with no order waiting (the manager's check).
function checkMail({ force = false } = {}) {
  if (!running) running = run(force).finally(() => { running = null; });
  return running;
}

async function run(force) {
  const s = getSettings();
  const open = q("SELECT MIN(created_at) AS t, COUNT(*) AS n FROM shop_orders WHERE status IN ('awaiting_payment','verifying','review') AND created_at > ?")
    .get(now() - 3 * 864e5);
  let fetched = 0;
  if (s.gmailConfigured && (force || open.n)) {
    const creds = gmailCredentials();
    const last = q('SELECT uid_validity FROM payment_mails ORDER BY id DESC LIMIT 1').get()?.uid_validity;
    const known = new Set(last ? q('SELECT uid FROM payment_mails WHERE uid_validity = ?').all(last).map((r) => r.uid) : []);
    const since = Math.max(now() - 3 * 864e5, (open.t || now()) - 864e5);
    const { uidValidity, messages } = await mail.fetchMail({ ...IMAP, user: creds.user, pass: creds.pass, since, from: s.mailFrom, known });
    // Messages that were skipped (other senders) are remembered too, so they are not downloaded again.
    for (const m of messages) {
      if (saveMail(uidValidity, m.uid, m.raw, s)) fetched++;
      else q("INSERT OR IGNORE INTO payment_mails (uid_validity, uid, received_at, created_at, order_id) VALUES (?, ?, ?, ?, 0)").run(uidValidity, m.uid, now(), now());
    }
  }
  let matched = 0;
  for (const { id } of q("SELECT id FROM shop_orders WHERE status IN ('verifying','review') ORDER BY proof_at").all()) if (tryMatch(id)) matched++;
  const escalated = escalate();
  let mailed = 0;
  try { mailed = await deliverQr(); } catch (e) { console.error('shop qr mail', e.message); }
  return { fetched, matched, escalated, mailed };
}

const timer = setInterval(() => { checkMail().catch((e) => console.error('shop mail', e.message)); }, LOOP_MS);
timer.unref();

module.exports = { shopAgent, namesMatch, matchReason, findMail, claim, tryMatch, fulfil, checkMail, escalate, saveMail, deliverQr, makeEsimQr };
