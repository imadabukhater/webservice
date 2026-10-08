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

route('GET', '/api/public', null, () => ({ appName: getSettings().appName }));

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
  return { token: createSession(u.id), user: publicUser(u), settings: getSettings() };
});

route('POST', '/api/logout', ANY, ({ token }) => {
  q('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  return { ok: true };
});

route('GET', '/api/me', ANY, ({ user }) => ({ user: publicUser(user), settings: getSettings() }));

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
  return getSettings();
});

// A consistent copy of the whole database, made with VACUUM INTO.
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
