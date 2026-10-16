'use strict';
// layan-t.net client. Like QuickLine, the site is a single page over a JSON API (api.layan-t.net) with a JWT; unlike
// it, signing in asks for an authenticator code, which this server makes itself from the account's TOTP secret.
//
// Layan sells by phone number: the dealer's numbers (each with its SIM, each on one package) are listed by
// Subscribtions/GetSubscribersDT. A line that ended is «מושהה» (suspended) and is sold again as a new line with
// Deals/ActivateLine; an active one is extended with Deals/Extend. Both take { Number, Duration (days) | SaleId }.
// Deals/GetCostBeforeActivate quotes the price first, so nothing is sent at a price other than the one approved.
//   extension (ref ly:<package>:<days>[:<sale>])  — extends a dealer's active number
//   new line  (ref lyn:<package>:<days>[:<sale>]) — activates one of the dealer's suspended numbers on that package
const crypto = require('node:crypto');

const BASE = process.env.LY_BASE || 'https://api.layan-t.net';
const TIMEOUT_MS = 30_000;
const ACTIVE = 'פעיל';
const SUSPENDED = 'מושהה';

class LayanError extends Error {
  constructor(message, { refused = false } = {}) {
    super(message);
    this.refused = refused; // Layan answered and declined: nothing was done, nothing charged.
  }
}

// ---------- the authenticator ----------
// The secret is accepted as the manager has it: a base32 key, an otpauth:// link, or Google Authenticator's
// otpauth-migration:// export. It is kept as base32.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const toBase32 = (buf) => {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
};
const fromBase32 = (s) => {
  let bits = '';
  for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
};
// The first account in a Google Authenticator export (protobuf: payload.1 = { 1: secret }).
function migrationSecret(uri) {
  const data = Buffer.from(decodeURIComponent(new URL(uri).searchParams.get('data') || ''), 'base64');
  const fields = (b) => {
    const out = [];
    let i = 0;
    const varint = () => { let x = 0; let s = 0; let c; do { c = b[i++]; x += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80); return x; };
    while (i < b.length) {
      const k = varint();
      if ((k & 7) === 2) { const n = varint(); out.push([k >> 3, b.subarray(i, i + n)]); i += n; } else if ((k & 7) === 0) out.push([k >> 3, varint()]);
      else throw new Error('wire');
    }
    return out;
  };
  const account = fields(data).find(([f]) => f === 1)?.[1];
  const secret = account && fields(account).find(([f]) => f === 1)?.[1];
  if (!secret) throw new Error('no secret');
  return toBase32(secret);
}
function normalizeSecret(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  try {
    if (s.startsWith('otpauth-migration://')) return migrationSecret(s);
    if (s.startsWith('otpauth://')) return new URL(s).searchParams.get('secret').toUpperCase().replace(/[^A-Z2-7]/g, '');
  } catch {
    throw new LayanError('رابط المصادقة غير صالح — انسخ المفتاح أو الرابط كاملاً');
  }
  const b32 = s.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z2-7]{16,}=*$/.test(b32)) throw new LayanError('المفتاح السري يجب أن يكون حروفاً إنجليزية وأرقاماً من 2 إلى 7 (16 خانة على الأقل)');
  return b32.replace(/=+$/, '');
}
// The 6-digit code the authenticator shows now (RFC 6238: HMAC-SHA1, 30 seconds).
function totp(secretB32, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = crypto.createHmac('sha1', fromBase32(secretB32)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// ---------- requests ----------
const session = { key: '', jwt: '' };

async function request(method, route, { body, jwt } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api/${route}`, {
      method,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Language: 'ar', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new LayanError(`ليان: تعذّر الاتصال (${e.name === 'TimeoutError' ? 'انتهى الوقت' : e.message})`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (res.status >= 500) throw new LayanError(`ليان: خطأ في الخادم (${res.status})`);
  return { status: res.status, data, text: text.slice(0, 300) };
}

async function login({ user, pass, secret }) {
  if (!user || !pass) throw new LayanError('أدخل اسم مستخدم ليان وكلمة المرور في الإعدادات');
  session.jwt = '';
  session.key = '';
  const r = await request('POST', 'Auth/Login', { body: { username: user, password: pass } });
  if (r.status >= 400) throw new LayanError(`ليان: ${r.text.replace(/^"|"$/g, '') || 'تعذّر تسجيل الدخول'}`);
  let jwt = r.data?.data?.jwt;
  if (r.data?.statusCode === 202) {
    // An authenticator code (method 2) is made here; a code sent by SMS or e-mail (1, 3) cannot be answered.
    if (r.data.data?.verificationMethod !== 2) throw new LayanError('ليان: الحساب يطلب رمزاً يصل برسالة. فعّل تطبيق المصادقة للحساب ليعمل الربط.');
    if (!secret) throw new LayanError('ليان: الحساب يطلب رمز المصادقة — أدخل المفتاح السري في الإعدادات');
    const v = await request('POST', 'Auth/VerifyCode', { body: { code: totp(secret), requestId: r.data.data.requestId, jwt: null } });
    if (v.status >= 400) throw new LayanError(`ليان: لم يُقبل رمز المصادقة — تأكد من المفتاح السري وساعة السيرفر (${v.text})`);
    jwt = v.data?.jwt || v.data?.data?.jwt;
  }
  if (!jwt) throw new LayanError('ليان: لم يرجع الخادم رمز دخول');
  session.jwt = jwt;
  session.key = `${user}\n${pass}\n${secret || ''}`;
}

async function api(creds, method, route, body) {
  if (session.key !== `${creds.user}\n${creds.pass}\n${creds.secret || ''}`) await login(creds);
  let r = await request(method, route, { body, jwt: session.jwt });
  if (r.status === 401 || r.status === 403) {
    await login(creds);
    r = await request(method, route, { body, jwt: session.jwt });
  }
  if (r.status >= 400) throw new LayanError(`ليان رفض الطلب${r.text ? ` (ليان: ${r.text.replace(/^"|"$/g, '').slice(0, 160)})` : ''}`, { refused: true });
  return r;
}

// ---------- reading ----------
const money = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null; };
const gbOf = (s) => { const m = /(\d+(?:\.\d+)?)/.exec(String(s || '')); return m ? Number(m[1]) : null; };

// The account's balance, from the home page figures (the fifth one is the balance, e.g. "-58 ₪").
async function balance(creds) {
  const { data } = await api(creds, 'GET', 'Index/GetHomePageData');
  return Array.isArray(data) ? money(data[4]) : null;
}

// Package durations by name (Hebrew), for the offers' fixed periods.
async function durations(creds) {
  const { data } = await api(creds, 'GET', 'Packages/GetPackageDuration');
  return new Map((Array.isArray(data) ? data : []).map((d) => [d.name, Number(d.value)]));
}

// Everything on offer: one entry per package price — the regular one (30 days) and each offer (its own period).
// kind 'card' takes regular prices only (an extension); 'invoice' takes both (a new line).
async function catalog(creds, kind = 'card') {
  const [{ data }, days] = await Promise.all([api(creds, 'POST', 'Packages/GetPackagesSortedByCompanies/false'), durations(creds)]);
  const out = [];
  for (const g of Array.isArray(data) ? data : []) {
    for (const p of g.packages || []) {
      if (!p.isActive || !p.id || money(p.cost) === null) continue;
      const sale = p.saleId || null;
      if (sale && kind === 'card') continue;
      const period = sale ? days.get(p.duration) || null : 30;
      if (!period) continue;
      const tag = kind === 'card' ? 'ly' : 'lyn';
      out.push({
        ref: `${tag}:${p.id}:${period}${sale ? `:${sale}` : ''}`,
        kind, packageId: p.id, saleId: sale, days: period,
        company: g.company?.name || '', packageName: p.name,
        dataGb: gbOf(p.internet), minutes: p.minutes ?? null, sms: p.messages ?? null,
        is5G: !!p.is5G || /דור 5|5G/i.test(p.name), esim: /esim/i.test(p.name),
        agentPrice: Math.round(money(p.cost) * 100) / 100,
        saleName: p.saleName || '',
      });
    }
  }
  return out;
}

// The dealer's numbers at Layan: [{ number, sim, company, packageName, status, active, suspended, endDate }].
async function numbers(creds) {
  const { data } = await api(creds, 'POST', 'Subscribtions/GetSubscribersDT', {
    draw: 1, start: 0, length: 5000, search: { value: '', regex: false }, order: [], columns: [], customSearch: {},
  });
  return (data?.data || []).map((x) => ({
    id: x.id, number: String(x.number || '').replace(/\D/g, ''), sim: String(x.simNumber || ''), company: x.companyName || '',
    packageName: x.package?.name || '', status: x.status?.name || '', active: x.status?.name === ACTIVE,
    suspended: x.status?.name === SUSPENDED, endDate: x.endDate || '',
  })).filter((x) => x.number);
}

// What Layan would charge now for activating or extending a number this way.
async function quote(creds, { number, days, saleId }) {
  const { data, text } = await api(creds, 'POST', 'Deals/GetCostBeforeActivate', { Number: number, Duration: saleId ? null : days, SaleId: saleId || null });
  const n = money(data ?? text);
  if (n === null) throw new LayanError(`ليان: سعر غير مفهوم (${text})`);
  return n;
}

// ---------- selling ----------
async function activate(creds, { number, days, saleId }) {
  await api(creds, 'POST', 'Deals/ActivateLine', { Number: number, Duration: saleId ? null : days, SaleId: saleId || null, UserPaid: false, endDate: null });
}
async function extend(creds, { number, days, saleId }) {
  await api(creds, 'POST', 'Deals/Extend', { Number: number, Duration: saleId ? null : days, SaleId: saleId || null, UserPaid: false });
}

const parseRef = (ref) => {
  const m = /^(lyn?):([0-9a-f-]{36}):(\d+)(?::([0-9a-f-]{36}))?$/i.exec(String(ref));
  return m ? { system: m[1], packageId: m[2], days: Number(m[3]), saleId: m[4] || null } : null;
};

function localNumber(n) {
  let d = String(n).replace(/\D/g, '');
  if (d.startsWith('972')) d = `0${d.slice(3)}`;
  return /^0\d{9}$/.test(d) ? d : null;
}

module.exports = {
  LayanError, normalizeSecret, totp, login, api, balance, durations, catalog, numbers, quote, activate, extend, parseRef, localNumber,
};
