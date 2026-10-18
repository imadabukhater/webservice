'use strict';
// The e-mailed sign-in code: finding the code in typical messages, and mark + waitForCode against a fake IMAP server
// that answers like Gmail to what mail.fetchMail sends (LOGIN, SELECT with UIDNEXT, UID SEARCH, UID FETCH BODY.PEEK[]).
const net = require('node:net');
const test = require('node:test');
const assert = require('node:assert/strict');
const { mark, waitForCode, check, extractCode } = require('../src/mailcode');

const USER = 'box@gmail.com';
const PASS = 'abcdefghijklmnop';
const mailbox = { messages: [], commands: [], uidNext: true }; // messages: { uid, at, raw }
const add = (raw, at = Date.now()) => {
  mailbox.messages.push({ uid: Math.max(0, ...mailbox.messages.map((m) => m.uid)) + 1, at, raw });
};

const server = net.createServer((sock) => {
  sock.write('* OK Gimap ready\r\n');
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    let eol;
    while ((eol = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, eol);
      buf = buf.slice(eol + 2);
      const [tag, ...words] = line.split(' ');
      const cmd = words.join(' ');
      mailbox.commands.push(cmd);
      if (/^LOGIN /i.test(cmd)) {
        sock.write(cmd === `LOGIN "${USER}" "${PASS}"` ? `${tag} OK authenticated\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
      } else if (/^SELECT /i.test(cmd)) {
        const next = Math.max(0, ...mailbox.messages.map((m) => m.uid)) + 1;
        sock.write(`* ${mailbox.messages.length} EXISTS\r\n* OK [UIDVALIDITY 3] UIDs valid\r\n${mailbox.uidNext ? `* OK [UIDNEXT ${next}] Predicted next UID\r\n` : ''}${tag} OK [READ-WRITE] INBOX selected\r\n`);
      } else if (/^UID SEARCH /i.test(cmd)) {
        // SINCE is by day, as on Gmail: a day that has not come yet finds nothing.
        const d = /SINCE (\d+)-(\w+)-(\d+)/.exec(cmd);
        const since = Date.parse(`${d[1]} ${d[2]} ${d[3]} 00:00:00 +0000`);
        const hits = mailbox.messages.filter((m) => m.at >= since).map((m) => ` ${m.uid}`).join('');
        sock.write(`* SEARCH${hits}\r\n${tag} OK SEARCH completed\r\n`);
      } else if (/^UID FETCH \d+ BODY\.PEEK\[\]$/i.test(cmd)) {
        const uid = Number(/\d+/.exec(cmd)[0]);
        const m = mailbox.messages.find((x) => x.uid === uid);
        if (m) {
          const raw = Buffer.from(m.raw, 'utf8');
          sock.write(Buffer.concat([Buffer.from(`* ${uid} FETCH (UID ${uid} BODY[] {${raw.length}}\r\n`), raw, Buffer.from(')\r\n')]));
        }
        sock.write(`${tag} OK Success\r\n`);
      } else if (/^LOGOUT/i.test(cmd)) {
        sock.end(`* BYE\r\n${tag} OK\r\n`);
      } else {
        sock.write(`${tag} BAD unknown\r\n`);
      }
    }
  });
  sock.on('error', () => {});
});
let imap;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { imap = { host: '127.0.0.1', port: server.address().port, secure: false }; r(); })));
test.after(() => server.close());

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
// A code message as telecom.co.il might send it: Hebrew subject, base64 HTML.
const codeMessage = (code, at = Date.now()) => [
  'From: ALOHA <no-reply@telecom.co.il>',
  `Date: ${new Date(at).toUTCString()}`,
  `Subject: =?UTF-8?B?${Buffer.from('קוד כניסה למערכת').toString('base64')}?=`,
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/html; charset="UTF-8"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(`<html><head><style>.x{color:#123456}</style></head><body><p>שלום,</p><p>קוד האימות שלך הוא: <b>${code}</b></p></body></html>`),
  '--b1--',
  '',
].join('\r\n');
const plainMessage = (text, at = Date.now()) => `From: someone@example.com\r\nDate: ${new Date(at).toUTCString()}\r\nSubject: hello\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;

test('extractCode finds the code in typical messages, and only codes of a known length when given', () => {
  assert.equal(extractCode('קוד האימות שלך הוא: 482913'), '482913');
  assert.equal(extractCode('Your verification code is 7731\nValid until 2026'), '7731');
  assert.equal(extractCode('Telecom 2026\nלכניסה למערכת: 553201'), '553201');
  assert.equal(extractCode('رمز الدخول 9182'), '9182');
  assert.equal(extractCode('שלום, תודה שפנית'), null);
  assert.equal(extractCode('קוד אימות: 97445', 5), '97445');
  assert.equal(extractCode('Order 2026-10-18, code 97445', 5), '97445');
  assert.equal(extractCode('שלום 97445', 5), '97445');
  assert.equal(extractCode('Order 123456 confirmed', 5), null, 'not five digits out of six');
});

test('only a code that arrives after the mark is used, and old mail is not even downloaded or marked read', async () => {
  mailbox.messages = [];
  mailbox.commands = [];
  add(codeMessage('11111')); // a code from an earlier sign-in, today
  add(plainMessage('nothing to see'));
  const m = await mark({ user: USER, pass: PASS, imap });
  assert.equal(m.uid, 3);
  assert.ok(!mailbox.commands.some((c) => /^UID FETCH/.test(c)), 'marking downloads nothing');
  setTimeout(() => {
    add(codeMessage('48291'));
    add(plainMessage('Payment of 50 NIS, reference 77777')); // newer, with five digits, but not a code
  }, 120);
  const code = await waitForCode({ user: USER, pass: 'abcd efgh ijkl mnop', imap }, m, { waitMs: 3000, pollMs: 50, digits: 5 });
  assert.equal(code, '48291');
  const fetches = mailbox.commands.filter((c) => /^UID FETCH/.test(c));
  assert.ok(fetches.length && fetches.every((c) => Number(/\d+/.exec(c)[0]) >= 3), 'messages from before the mark are not downloaded');
  assert.ok(fetches.every((c) => /BODY\.PEEK\[\]$/.test(c)) && !mailbox.commands.some((c) => /STORE/i.test(c)), 'mail stays unread');
});

test('a server that gives no UIDNEXT: new is judged by the message date', async () => {
  mailbox.messages = [];
  mailbox.uidNext = false;
  add(codeMessage('22222', Date.now() - 10 * 60_000));
  const m = await mark({ user: USER, pass: PASS, imap });
  assert.equal(m.uid, 0);
  setTimeout(() => add(codeMessage('33333')), 80);
  assert.equal(await waitForCode({ user: USER, pass: PASS, imap }, m, { waitMs: 3000, pollMs: 50, digits: 5 }), '33333');
  mailbox.uidNext = true;
});

test('waitForCode gives up with a clear message when no code arrives', async () => {
  mailbox.messages = [];
  const m = await mark({ user: USER, pass: PASS, imap });
  await assert.rejects(waitForCode({ user: USER, pass: PASS, imap }, m, { waitMs: 200, pollMs: 50 }), /لم يصل رمز التحقق/);
});

test('a wrong App password, missing settings, or an unreachable server are reported', async () => {
  await assert.rejects(mark({ user: USER, pass: 'wrong', imap }), /رفض الدخول/);
  const started = Date.now();
  await assert.rejects(waitForCode({ user: USER, pass: 'wrong', imap }, { uid: 1, at: Date.now() }, { waitMs: 5000, pollMs: 50 }), /رفض الدخول/);
  assert.ok(Date.now() - started < 2000, 'a refused sign-in stops the wait at once');
  await assert.rejects(check({ user: '', pass: PASS, imap }), /أدخل بريد الجيميل/);
  await assert.rejects(check({ user: USER, pass: PASS, imap: { host: '127.0.0.1', port: 1, secure: false } }), /تعذّر الوصول/);
  assert.equal(await check({ user: USER, pass: PASS, imap }), true);
});
