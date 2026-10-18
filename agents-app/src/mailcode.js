'use strict';
// Sign-in codes a supplier sends by e-mail, read from the mailbox over IMAP (mail.js: Gmail with an App password;
// nothing is marked as read). Before asking the supplier for a code the server marks where the mailbox is (mark): the
// code is then looked for only in messages that arrive after that, so a code from an earlier sign-in is never used.
const mail = require('./mail');

const POLL_MS = Number(process.env.MAILCODE_POLL_MS) || 4000;
const WAIT_MS = Number(process.env.MAILCODE_WAIT_MS) || 90_000;
const DAY_MS = 24 * 60 * 60_000;
// Only when the server gives no UIDNEXT: new is then judged by the message's date, a little before the mark.
const SKEW_MS = 15_000;
const RECENT = 8; // at most this many new messages are read in one look
// Only messages from this sender (part of the address), if set: e.g. telecom.co.il.
const FROM = process.env.MAILCODE_FROM || '';

class MailCodeError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One session with the mailbox. Wrong sign-in details throw; a passing fault is reported as { retry }.
async function look(cfg, options) {
  const user = String(cfg.user || '').trim();
  const pass = String(cfg.pass || '').replace(/\s+/g, ''); // Google shows App passwords in groups of four
  if (!user || !pass) throw new MailCodeError('أدخل بريد الجيميل وكلمة مرور التطبيق في الإعدادات');
  try {
    return await mail.fetchMail({ ...(cfg.imap || {}), user, pass, from: FROM, timeout: 20_000, ...options });
  } catch (e) {
    if (e instanceof mail.MailError && e.auth) {
      throw new MailCodeError('الجيميل رفض الدخول — تأكد من البريد وكلمة مرور التطبيق (App password، وليست كلمة مرور الحساب) وأن IMAP مفعّل');
    }
    return { retry: e.message };
  }
}

// Where the mailbox is now: the next message to arrive gets a UID from uidNext on. Nothing is downloaded (the search
// looks at a day that has not come yet).
async function mark(cfg) {
  const at = Date.now();
  const r = await look(cfg, { since: at + 2 * DAY_MS });
  if (r.retry) throw new MailCodeError(`تعذّر الوصول إلى الجيميل (${r.retry})`);
  return { uid: r.uidNext || 0, at };
}

// The code in a message: beside a word that names it (Hebrew, Arabic or English), else a bare number — exactly
// `digits` long when the supplier's codes have a known length, else the first 6-digit number, else 4–8 digits.
function findCode(text, digits) {
  const s = String(text || '');
  const n = digits ? `\\d{${digits}}` : '\\d{4,8}';
  const named = new RegExp(`(?:קוד|סיסמ|אימות|رمز|كود|code|otp|verification|password)[^\\d]{0,40}(${n})(?!\\d)`, 'i').exec(s);
  if (named) return { code: named[1], named: 1 };
  const six = !digits && /(?:^|\D)(\d{6})(?!\d)/.exec(s);
  if (six) return { code: six[1], named: 0 };
  const any = new RegExp(`(?:^|\\D)(${n})(?!\\d)`).exec(s);
  return any ? { code: any[1], named: 0 } : null;
}
const extractCode = (text, digits) => findCode(text, digits)?.code ?? null;

// One look: { code } from the messages that arrived after the mark, or null; { retry } on a passing fault.
// A code beside a word that names it beats a bare number (another e-mail may carry digits too); then the newest.
async function peek(cfg, m, digits) {
  const r = await look(cfg, { since: m.at - DAY_MS, after: m.uid ? m.uid - 1 : 0, limit: RECENT });
  if (r.retry) return r;
  let best = null;
  for (const msg of r.messages) {
    const p = mail.parseMessage(msg.raw);
    if (!m.uid && !(p.date >= m.at - SKEW_MS)) continue;
    const found = findCode(`${p.subject}\n${p.text}`, digits);
    if (found && (!best || found.named > best.named || (found.named === best.named && msg.uid > best.uid))) best = { ...found, uid: msg.uid };
  }
  return best;
}

// Waits for the code e-mailed after the mark (taken just before the supplier was asked to send it).
async function waitForCode(cfg, m, { waitMs = WAIT_MS, pollMs = POLL_MS, digits } = {}) {
  const deadline = Date.now() + waitMs;
  let fault = '';
  for (;;) {
    const r = await peek(cfg, m, digits);
    if (r && r.code) return r.code;
    fault = r && r.retry ? r.retry : '';
    if (Date.now() + pollMs > deadline) break;
    await sleep(pollMs);
  }
  throw new MailCodeError(fault
    ? `تعذّر الوصول إلى الجيميل (${fault})`
    : `لم يصل رمز التحقق إلى الجيميل خلال ${Math.round(waitMs / 1000)} ثانية`);
}

// For the settings' "test" button: the mailbox is reachable and accepts the sign-in.
async function check(cfg) {
  const r = await look(cfg, { since: Date.now() + 2 * DAY_MS });
  if (r.retry) throw new MailCodeError(`تعذّر الوصول إلى الجيميل (${r.retry})`);
  return true;
}

module.exports = { mark, waitForCode, check, extractCode, MailCodeError };
