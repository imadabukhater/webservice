'use strict';
// Reads payment notification emails over IMAP (Gmail with an app password) and parses JawwalPay transfers.
// Read-only: messages are fetched with BODY.PEEK so they stay unread in the mailbox.
const net = require('node:net');
const tls = require('node:tls');

class MailError extends Error {}

// ---------- IMAP ----------
class Conn {
  constructor(socket, timeout) {
    this.s = socket;
    this.buf = Buffer.alloc(0);
    this.err = null;
    this.wait = null;
    this.n = 0;
    socket.setTimeout(timeout, () => socket.destroy(new MailError('انتهت مهلة الاتصال بخادم البريد')));
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.wake(); });
    socket.on('error', (e) => { this.err = e; this.wake(); });
    socket.on('close', () => { this.err ||= new MailError('انقطع الاتصال بخادم البريد'); this.wake(); });
  }
  wake() { const w = this.wait; this.wait = null; w?.(); }
  async more() {
    if (this.err) throw this.err;
    await new Promise((r) => { this.wait = r; });
  }
  async line() {
    for (;;) {
      const i = this.buf.indexOf('\r\n');
      if (i >= 0) {
        const l = this.buf.subarray(0, i).toString('utf8');
        this.buf = this.buf.subarray(i + 2);
        return l;
      }
      await this.more();
    }
  }
  async bytes(n) {
    while (this.buf.length < n) await this.more();
    const b = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return b;
  }
  // Untagged responses until the tagged reply; literals ({n}) are collected as Buffers.
  async response(tag) {
    const untagged = [];
    for (;;) {
      let text = await this.line();
      const lits = [];
      let m;
      while ((m = text.match(/\{(\d+)\}$/))) {
        lits.push(await this.bytes(Number(m[1])));
        text = text.slice(0, -m[0].length) + '\0' + await this.line();
      }
      if (text.startsWith(tag + ' ')) {
        if (!/^\S+ OK/i.test(text)) throw new MailError(text.slice(tag.length + 1));
        return untagged;
      }
      untagged.push({ text, lits });
    }
  }
  cmd(c) {
    const tag = `A${++this.n}`;
    this.s.write(`${tag} ${c}\r\n`);
    return this.response(tag);
  }
}

const quote = (s) => `"${String(s).replace(/[\\"]/g, (c) => '\\' + c)}"`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = (ts) => { const d = new Date(ts); return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };

function open({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    s.once(secure ? 'secureConnect' : 'connect', () => { s.removeListener('error', reject); resolve(s); });
    s.once('error', reject);
  });
}

// Messages received since `since` (ms) whose sender contains `from`, skipping UIDs in `known` and UIDs up to `after`.
// Returns { uidValidity, uidNext, messages: [{ uid, raw }] }, newest last, at most `limit`. uidNext is the UID the next
// message to arrive will get at least (0 when the server does not say).
async function fetchMail({ host = 'imap.gmail.com', port = 993, secure = true, user, pass, since, from = '', known = new Set(), after = 0, limit = 40, timeout = 30000 }) {
  let socket;
  try {
    socket = await open({ host, port, secure });
  } catch (e) {
    throw new MailError(`تعذّر الاتصال بخادم البريد: ${e.message}`);
  }
  const c = new Conn(socket, timeout);
  try {
    const greeting = await c.line();
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new MailError('رد غير متوقع من خادم البريد');
    try {
      await c.cmd(`LOGIN ${quote(user)} ${quote(pass)}`);
    } catch (e) {
      const err = new MailError(e instanceof MailError ? 'رفض Gmail الدخول: تأكد من البريد وكلمة مرور التطبيقات (App Password) وتفعيل IMAP' : e.message);
      err.auth = e instanceof MailError; // the server refused these details: trying again will not help
      throw err;
    }
    const sel = await c.cmd('SELECT INBOX');
    const uidValidity = Number(sel.map((r) => r.text.match(/UIDVALIDITY (\d+)/i)?.[1]).find(Boolean) || 0);
    const uidNext = Number(sel.map((r) => r.text.match(/UIDNEXT (\d+)/i)?.[1]).find(Boolean) || 0);
    // Non-ASCII sender filters are applied after parsing (SEARCH would need CHARSET).
    const ascii = from && /^[\x20-\x7e]+$/.test(from);
    const found = await c.cmd(`UID SEARCH SINCE ${imapDate(since)}${ascii ? ` FROM ${quote(from)}` : ''}`);
    const uids = found.flatMap((r) => (/^\* SEARCH/i.test(r.text) ? r.text.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number) : []))
      .filter((u) => u > after && !known.has(u)).sort((a, b) => a - b).slice(-limit);
    const messages = [];
    for (const uid of uids) {
      const res = await c.cmd(`UID FETCH ${uid} BODY.PEEK[]`);
      const hit = res.find((r) => r.lits.length && /FETCH/i.test(r.text));
      if (hit) messages.push({ uid, raw: hit.lits[0] });
    }
    await c.cmd('LOGOUT').catch(() => {});
    return { uidValidity, uidNext, messages };
  } finally {
    socket.destroy();
  }
}

// ---------- MIME ----------
function decodeBytes(buf, charset) {
  try { return new TextDecoder((charset || 'utf-8').trim().toLowerCase()).decode(buf); } catch { return buf.toString('utf8'); }
}

function qpBytes(s, header = false) {
  if (header) s = s.replace(/_/g, ' ');
  s = s.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

// RFC 2047 encoded words: =?UTF-8?B?...?=
function decodeWords(s) {
  return String(s || '').replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs, enc, txt) =>
    decodeBytes(enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : qpBytes(txt, true), cs));
}

function splitPart(str) {
  const m = str.match(/\r?\n\r?\n/);
  const head = m ? str.slice(0, m.index) : str;
  const body = m ? str.slice(m.index + m[0].length) : '';
  const headers = {};
  for (const l of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = l.indexOf(':');
    if (i > 0) { const k = l.slice(0, i).trim().toLowerCase(); if (!(k in headers)) headers[k] = l.slice(i + 1).trim(); }
  }
  return { headers, body };
}

function params(v) {
  const [type, ...rest] = String(v || '').split(';');
  const p = {};
  for (const x of rest) { const i = x.indexOf('='); if (i > 0) p[x.slice(0, i).trim().toLowerCase()] = x.slice(i + 1).trim().replace(/^"|"$/g, ''); }
  return { type: type.trim().toLowerCase(), p };
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rlm: '', lrm: '' };
function htmlToText(h) {
  return h.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n').replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

// Text of a part (latin1 string keeps the raw bytes); collects plain and html bodies.
function walk(str, out, depth = 0) {
  const { headers, body } = splitPart(str);
  const ct = params(headers['content-type'] || 'text/plain');
  if (ct.type.startsWith('multipart/') && ct.p.boundary && depth < 6) {
    const parts = body.split('--' + ct.p.boundary);
    for (const part of parts.slice(1)) { if (part.startsWith('--')) break; walk(part.replace(/^\r?\n/, ''), out, depth + 1); }
    return;
  }
  if (!ct.type.startsWith('text/')) return;
  const enc = String(headers['content-transfer-encoding'] || '').toLowerCase();
  const bytes = enc === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : enc === 'quoted-printable' ? qpBytes(body) : Buffer.from(body, 'latin1');
  const text = decodeBytes(bytes, ct.p.charset);
  if (ct.type === 'text/html') out.html.push(htmlToText(text)); else out.plain.push(text.trim());
}

function parseMessage(raw) {
  const str = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  const { headers } = splitPart(str);
  const out = { plain: [], html: [] };
  walk(str, out);
  // Raw 8-bit headers are UTF-8; encoded words are ASCII, so they survive that step and are decoded after.
  const hdr = (k) => decodeWords(Buffer.from(headers[k] || '', 'latin1').toString('utf8'));
  const date = Date.parse(headers.date || '');
  return {
    from: hdr('from'), subject: hdr('subject'), messageId: headers['message-id'] || '', auth: headers['authentication-results'] || '',
    date: Number.isFinite(date) ? date : null,
    text: (out.plain.filter(Boolean).join('\n') || out.html.join('\n')).slice(0, 20000),
  };
}

// ---------- JawwalPay notification ----------
const toLatinDigits = (s) => String(s || '').replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0)
  .replace(/٫/g, '.').replace(/٬/g, ',');
const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,7}(?:[.,]\d{1,2})?)`;
const money = (s) => Number(/^\d{1,3}(?:,\d{3})+/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.'));
const CUR = '(?:₪|ILS|NIS|شيكل|شيقل|شواقل|ش\\.ج)';

function localPhone(s) {
  let d = s.replace(/\D/g, '');
  if (/^97[02]/.test(d)) d = '0' + d.slice(3);
  return d;
}

// What can be read from a transfer notification. Every field may be null: the format is matched loosely.
function parseJawwalPay({ subject = '', text = '' }, { ownNumber = '' } = {}) {
  const t = toLatinDigits(`${subject}\n${text}`);
  const amountRes = [
    new RegExp(String.raw`${NUM}\s*${CUR}`, 'i'),
    new RegExp(String.raw`${CUR}\s*${NUM}`, 'i'),
    new RegExp(String.raw`(?:المبلغ|مبلغ|بقيمة|قيمة|amount)\s*[:：]?\s*${NUM}`, 'i'),
  ];
  let amount = null;
  for (const re of amountRes) { const m = t.match(re); if (m) { amount = money(m[1]); break; } }

  const ref = t.match(/(?:الرقم المرجعي|رقم مرجعي|رقم المرجع|المرجع|رقم العملية|رقم الحركة|رقم التحويل|reference(?:\s*(?:no\.?|number|#))?|ref\.?(?:\s*no\.?)?|transaction\s*(?:id|no\.?|number))\s*[:：#-]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,40})/i);
  const own = localPhone(ownNumber);
  const phones = [...new Set([...t.matchAll(/(?:\+?97[02][\s-]?|0)5\d(?:[\s-]?\d){7}/g)].map((m) => localPhone(m[0])))].filter((p) => p !== own);
  const name = t.match(/(?:اسم المرسل|المرسل|المحوِّل|المحول|من|sender(?:\s*name)?|from)\s*[:：]\s*([^\n\r\d:|]{2,50})/i)
    || t.match(/(?:من|from)\s+([^\n\r\d:|.,]{2,40}?)\s*(?:[.,]|\s(?:بمبلغ|مبلغ|amount)|$)/im);
  return {
    amount: Number.isFinite(amount) ? amount : null,
    reference: ref ? ref[1].toUpperCase() : null,
    senderPhone: phones[0] || null,
    senderName: name ? name[1].replace(/\s+/g, ' ').trim() : null,
  };
}

// True when the receiving server (Gmail) authenticated the sender for a domain containing `term`:
// DMARC passed for the From domain, or a DKIM signature passed for such a domain. A From header alone can be forged.
function authenticSender({ from, auth }, term) {
  const t = String(term || '').toLowerCase().trim();
  if (!t || !auth) return false;
  const a = auth.toLowerCase();
  const fromDomain = (String(from).toLowerCase().match(/@([a-z0-9.-]+)/) || [])[1] || '';
  if (/\bdmarc=pass\b/.test(a) && fromDomain.includes(t)) return true;
  return [...a.matchAll(/\bdkim=pass\b[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/g)].some((m) => m[1].includes(t));
}

module.exports = {
  authenticSender, fetchMail, parseMessage, parseJawwalPay, htmlToText, toLatinDigits, MailError };
