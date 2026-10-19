'use strict';
// Sends one e-mail through Gmail's SMTP with the App password used for reading the mailbox (smtp.gmail.com:465, TLS).
// Used for what a customer should keep, such as an eSIM's QR code. Images are sent inline (cid:) so mail apps show
// them without loading anything from the internet.
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');

class SmtpError extends Error {}

const b64 = (v) => Buffer.from(v).toString('base64');
const wrap = (s) => s.replace(/.{1,76}/g, '$&\r\n');
const word = (s) => `=?UTF-8?B?${b64(String(s))}?=`;
// Nothing a customer typed may end up as a header of its own.
const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const validAddress = (s) => /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/.test(String(s || ''));

function open({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    s.once(secure ? 'secureConnect' : 'connect', () => { s.removeListener('error', reject); resolve(s); });
    s.once('error', reject);
  });
}

// SMTP replies: "250-…" lines go on, "250 …" ends one.
function replies(socket, timeout) {
  let buf = '';
  let wait = null;
  let err = null;
  socket.setTimeout(timeout, () => socket.destroy(new SmtpError('انتهت مهلة الاتصال بخادم البريد')));
  const wake = () => { const w = wait; wait = null; w?.(); };
  socket.on('data', (d) => { buf += d.toString('utf8'); wake(); });
  socket.on('error', (e) => { err = e; wake(); });
  socket.on('close', () => { err ||= new SmtpError('انقطع الاتصال بخادم البريد'); wake(); });
  return async () => {
    for (;;) {
      const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(buf);
      if (m) {
        const text = buf.slice(0, m.index + m[0].length);
        buf = buf.slice(m.index + m[0].length);
        return { code: Number(m[1]), text: text.trim() };
      }
      if (err) throw err;
      await new Promise((r) => { wait = r; });
    }
  };
}

function message({ from, fromName, to, subject, html, images }) {
  const boundary = `b${crypto.randomBytes(12).toString('hex')}`;
  const parts = [
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(html)),
    ...images.flatMap((img) => [
      `--${boundary}`, `Content-Type: ${img.type}; name="${img.name}"`, 'Content-Transfer-Encoding: base64', `Content-ID: <${img.cid}>`,
      `Content-Disposition: inline; filename="${img.name}"`, '', wrap(img.content.toString('base64')),
    ]),
    `--${boundary}--`, '',
  ];
  return [
    `From: ${fromName ? `${word(oneLine(fromName))} ` : ''}<${from}>`, `To: <${to}>`, `Subject: ${word(oneLine(subject))}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0', `Content-Type: multipart/related; boundary="${boundary}"`, '', ...parts,
  ].join('\r\n');
}

// images: [{ cid, name, type, content: Buffer }], referenced in the HTML as src="cid:<cid>".
async function sendMail({ host = 'smtp.gmail.com', port = 465, secure = true, user, pass, fromName = '', to, subject, html, images = [], timeout = 30_000 }) {
  if (!validAddress(user) || !pass) throw new SmtpError('بيانات Gmail غير مكتملة');
  if (!validAddress(to)) throw new SmtpError('عنوان البريد غير صحيح');
  let socket;
  try {
    socket = await open({ host, port, secure });
  } catch (e) {
    throw new SmtpError(`تعذّر الاتصال بخادم البريد: ${e.message}`);
  }
  const next = replies(socket, timeout);
  const expect = async (codes, failure) => {
    const r = await next();
    if (!codes.includes(r.code)) throw new SmtpError(failure ? failure(r) : `رفض خادم البريد: ${r.text.slice(0, 160)}`);
    return r;
  };
  const say = (line) => socket.write(`${line}\r\n`);
  try {
    await expect([220]);
    say('EHLO agents-app');
    await expect([250]);
    say(`AUTH PLAIN ${b64(`\0${user}\0${String(pass).replace(/\s+/g, '')}`)}`);
    await expect([235], () => 'رفض Gmail الدخول: تأكد من كلمة مرور التطبيقات (App Password)');
    say(`MAIL FROM:<${user}>`);
    await expect([250]);
    say(`RCPT TO:<${to}>`);
    await expect([250, 251]);
    say('DATA');
    await expect([354]);
    // A line starting with a dot gets another one (RFC 5321); the base64 parts never do, but headers might.
    socket.write(`${message({ from: user, fromName, to, subject, html, images }).replace(/(^|\r\n)\./g, '$1..')}\r\n.\r\n`);
    await expect([250]);
    say('QUIT');
  } finally {
    socket.end();
    socket.destroy();
  }
}

module.exports = { sendMail, validAddress, SmtpError };
