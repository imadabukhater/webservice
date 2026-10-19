'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { q, db, getSettings, setSetting } = require('../db');
const { fail, now, str, num, int } = require('../util');
const { hashPassword, verifyPassword, sha } = require('../passwords');
const { publicUser } = require('../domain');
const { route, ADMIN, ANY } = require('../router');

const SESSION_DAYS = 30;

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q('DELETE FROM sessions WHERE expires_at < ?').run(now());
  q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, now() + SESSION_DAYS * 864e5);
  return token;
}

// Login attempts: in-memory throttle per username + address.
const attempts = new Map();

route('GET', '/api/public', null, () => {
  const { appName, supportWhatsapp } = getSettings();
  return { appName, supportWhatsapp };
});

route('POST', '/api/login', null, ({ body, ip }) => {
  const username = str(body.username, 64);
  const key = username.toLowerCase() + '|' + ip;
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > now()) fail(429, 'محاولات كثيرة. حاول بعد دقيقة.');
  const u = q('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) {
    a.n += 1;
    if (a.n >= 5) { a.until = now() + 60_000; a.n = 0; }
    attempts.set(key, a);
    fail(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
  }
  attempts.delete(key);
  if (!u.active) fail(403, 'هذا الحساب موقوف. تواصل مع المدير.');
  return { token: createSession(u.id), user: publicUser(u), settings: settingsFor(u) };
});

route('POST', '/api/logout', ANY, ({ token }) => {
  q('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  return { ok: true };
});

route('GET', '/api/me', ANY, ({ user }) => ({ user: publicUser(user), settings: settingsFor(user) }));

// Agents see only what their screens need — never the suppliers' accounts, the manager's profit percentages or the
// backups. A list of what to show, so a setting added later stays the manager's unless it is added here.
const AGENT_SETTINGS = ['appName', 'warnDays', 'lowBalance', 'esimFee', 'supportWhatsapp'];
function settingsFor(user) {
  const s = getSettings();
  if (user.role === 'admin') return s;
  return Object.fromEntries(AGENT_SETTINGS.map((k) => [k, s[k]]));
}

route('POST', '/api/me/password', ANY, ({ user, body, token }) => {
  if (!verifyPassword(String(body.current || ''), user.password_hash)) fail(400, 'كلمة المرور الحالية غير صحيحة');
  const pw = String(body.password || '');
  if (pw.length < 6) fail(400, 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل');
  q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), user.id);
  // Sign out every other device.
  q('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, sha(token));
  return { ok: true };
});

route('GET', '/api/settings', ADMIN, () => getSettings());

route('PUT', '/api/settings', ADMIN, ({ body }) => {
  if (body.appName !== undefined) {
    const name = str(body.appName, 60);
    if (!name) fail(400, 'اكتب اسم التطبيق');
    setSetting('app_name', name);
  }
  if (body.warnDays !== undefined) setSetting('warn_days', int(Number(body.warnDays), 'أيام التنبيه', 1, 60));
  if (body.lowBalance !== undefined) setSetting('low_balance', Math.max(0, num(body.lowBalance, 'حد الرصيد المنخفض')));
  if (body.esimFee !== undefined) {
    const fee = num(body.esimFee, 'رسوم eSIM');
    if (fee < 0) fail(400, 'رسوم eSIM لا تكون سالبة');
    setSetting('esim_fee', fee);
  }
  if (body.artUser !== undefined) setSetting('art_user', str(body.artUser, 80));
  // Write-only: an empty password keeps the saved one.
  if (body.artPass) setSetting('art_pass', String(body.artPass).slice(0, 200));
  if (body.qlUser !== undefined) setSetting('ql_user', str(body.qlUser, 120));
  if (body.qlPass) setSetting('ql_pass', String(body.qlPass).slice(0, 200));
  if (body.lyUser !== undefined) setSetting('ly_user', str(body.lyUser, 120));
  if (body.lyPass) setSetting('ly_pass', String(body.lyPass).slice(0, 200));
  // The authenticator secret, as a key or the app's export link: stored as a base32 key, never sent back.
  if (body.lySecret) {
    try { setSetting('ly_secret', require('../layan').normalizeSecret(body.lySecret)); } catch (e) { fail(400, e.message); }
  }
  if (body.tcUser !== undefined) setSetting('tc_user', str(body.tcUser, 120));
  if (body.tcPass) setSetting('tc_pass', String(body.tcPass).slice(0, 200));
  if (body.tcMailUser !== undefined) {
    const mail = str(body.tcMailUser, 120);
    if (mail && !/^[^\s@"]+@[^\s@"]+\.[^\s@"]+$/.test(mail)) fail(400, 'اكتب بريد الجيميل كاملاً، مثل name@gmail.com');
    setSetting('tc_mail_user', mail);
  }
  // Google shows an App password in groups of four: kept without the spaces.
  for (const [field, key] of [['tcRegAddress', 'tc_reg_address'], ['tcRegCity', 'tc_reg_city'], ['tcRegZip', 'tc_reg_zip']]) {
    if (body[field] !== undefined) setSetting(key, str(body[field], 80));
  }
  if (body.tcMailPass) setSetting('tc_mail_pass', String(body.tcMailPass).replace(/\s+/g, '').slice(0, 200));
  for (const [field, key] of [['artMarkupCard', 'art_markup_card'], ['artMarkupInvoice', 'art_markup_invoice'],
    ['qlMarkupCard', 'ql_markup_card'], ['qlMarkupInvoice', 'ql_markup_invoice'],
    ['lyMarkupCard', 'ly_markup_card'], ['lyMarkupInvoice', 'ly_markup_invoice'],
    ['tcMarkupCard', 'tc_markup_card'], ['tcMarkupInvoice', 'tc_markup_invoice']]) {
    if (body[field] === undefined) continue;
    const m = num(body[field], 'نسبة الربح');
    if (m < 0 || m > 200) fail(400, 'نسبة الربح بين 0 و200%');
    setSetting(key, m);
  }
  if (body.shopEnabled !== undefined) setSetting('shop_enabled', body.shopEnabled ? '1' : '0');
  if (body.jawwalpayNumber !== undefined) {
    const n = String(body.jawwalpayNumber).replace(/[^\d+]/g, '');
    if (n && !/^\+?\d{9,13}$/.test(n)) fail(400, 'رقم محفظة جوال باي غير صحيح');
    setSetting('jawwalpay_number', n);
  }
  if (body.jawwalpayName !== undefined) setSetting('jawwalpay_name', str(body.jawwalpayName, 80));
  if (body.gmailUser !== undefined) setSetting('gmail_user', str(body.gmailUser, 120));
  if (body.gmailPass) setSetting('gmail_pass', String(body.gmailPass).replace(/\s+/g, '').slice(0, 64));
  if (body.mailFrom !== undefined) setSetting('mail_from', str(body.mailFrom, 80));
  if (body.supportWhatsapp !== undefined) {
    // International format without + or leading zeros, as wa.me expects: 972567725080.
    const wa = String(body.supportWhatsapp).replace(/\D/g, '').replace(/^00/, '');
    if (wa && !/^[1-9]\d{7,14}$/.test(wa)) fail(400, 'اكتب رقم واتساب بالصيغة الدولية، مثل 972567725080');
    setSetting('support_whatsapp', wa);
  }
  return getSettings();
});

// A consistent copy of the whole database, made with VACUUM INTO.
// A copy in Google Cloud Storage now (the same one the server makes every day).
route('POST', '/api/backup/cloud', ADMIN, async () => {
  try {
    return await require('../cloudbackup').backupNow();
  } catch (e) {
    setSetting('backup_error', String(e.message).slice(0, 300));
    return fail(502, e.message);
  }
});

route('GET', '/api/backup', ADMIN, ({ res }) => {
  const file = path.join(os.tmpdir(), `agents-backup-${process.pid}-${now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="agents-backup-${stamp}.db"`,
    'Cache-Control': 'no-store',
  });
  const stream = fs.createReadStream(file);
  stream.pipe(res);
  stream.on('close', () => fs.rm(file, { force: true }, () => {}));
  return { raw: true };
});
