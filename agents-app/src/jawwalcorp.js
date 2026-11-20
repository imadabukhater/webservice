'use strict';
// Direct Jawwal Pay through the MaalCards corporate API (api.maalcards.com, «واجهة الشركات»). It charges a customer's
// Jawwal Pay wallet on their mobile number, with no cards and no store: send_otp texts the customer a code for an
// amount and returns an invoice (cor_invoice_id); confirm_payment with that invoice and the code takes the money.
//
// Its sign-in rules are strict, and breaking them blocks every payment for 15 minutes:
//   - a token lasts one hour and must be reused; each account has a few seats, one token per seat;
//   - signing in while every seat holds a valid token is refused (429 token_still_valid, with retry_after);
//     two more tries revoke every seat's token and block the account (429 corporate_blocked);
//   - a revoked or replaced token answers 401 token_revoked; there is no refresh (403 refresh_not_allowed).
// So this server keeps one token in the database (it outlives a restart, which would otherwise sign in again while
// the old token still holds the seat), signs in only when it has none or it ended, one sign-in at a time, never
// again before retry_after, and on token_revoked signs in once and retries the request once — never in a loop.
const { q, setSetting } = require('./db');

const BASE = (process.env.JC_BASE || 'https://api.maalcards.com').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.JC_TIMEOUT_MS) || 30_000;
// A token is used until it ends (by our clock, from expires_in), and the next sign-in waits this much longer, so a
// clock a little ahead of theirs never signs in while they still count the old token.
const SKEW_MS = Number.isFinite(Number(process.env.JC_SKEW_MS)) ? Number(process.env.JC_SKEW_MS) : 3_000;
const FALLBACK_TTL_MS = 60 * 60_000;
const BLOCK_MS = 15 * 60_000;
// After a refused sign-in for wrong details, a disabled account or the API turned off: not asked again for a minute,
// so customers' payments do not hammer the sign-in.
const REFUSED_WAIT_MS = 60_000;

class JawwalCorpError extends Error {
  // status: HTTP status (0: no answer); code: the API's error code; data: its data (failure_code, can_retry…).
  // unsure: no clear answer (timeout, connection lost, 5xx): the request may or may not have been carried out.
  constructor(message, { status = 0, code = '', data = null, retryAfter = 0, unsure = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
    this.retryAfter = retryAfter;
    this.unsure = unsure;
  }
}

// ---------- the stored token ----------
const KEYS = { token: 'jc_token', exp: 'jc_token_exp', owner: 'jc_token_owner', wait: 'jc_wait_until', waitCode: 'jc_wait_code' };
const read = (k) => q('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
const owner = (creds) => `${creds.managerId}:${creds.user}`;

function stored(creds) {
  const token = read(KEYS.token);
  // A token signed in for another account (the manager changed it) is not used.
  if (!token || read(KEYS.owner) !== owner(creds)) return null;
  return { token, exp: Number(read(KEYS.exp)) || 0 };
}
function store(creds, token, exp) {
  setSetting(KEYS.token, token);
  setSetting(KEYS.exp, exp);
  setSetting(KEYS.owner, owner(creds));
}
// Forgets the token, only if it is still the one given (another request may have signed in since).
function forget(token) {
  if (!token || read(KEYS.token) === token) {
    setSetting(KEYS.token, '');
    setSetting(KEYS.exp, 0);
  }
}
function waitUntil(ms, code) {
  const until = Date.now() + ms;
  if (until > (Number(read(KEYS.wait)) || 0)) {
    setSetting(KEYS.wait, until);
    setSetting(KEYS.waitCode, code || '');
  }
}

// What the server knows now, for the manager (never the token itself).
function status() {
  const exp = Number(read(KEYS.exp)) || 0;
  const wait = Number(read(KEYS.wait)) || 0;
  return {
    hasToken: !!read(KEYS.token) && exp > Date.now(),
    tokenExpiresAt: exp || null,
    waitUntil: wait > Date.now() ? wait : null,
    waitCode: wait > Date.now() ? read(KEYS.waitCode) : '',
  };
}

// ---------- HTTP ----------
const pick = (b, k) => (b && b[k] !== undefined ? b[k] : b?.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data[k] : undefined);
// The API's error code: in "error", "code" or "error_code", or a snake_case "message".
function errorCode(b) {
  for (const k of ['error_code', 'code', 'error']) {
    const v = pick(b, k);
    if (typeof v === 'string' && /^[a-z][a-z0-9_]+$/.test(v)) return v;
    if ((typeof v === 'number' || (typeof v === 'string' && /^\d{1,4}$/.test(v)))) return String(v); // e.g. 14 (the number is not registered at the bank)
  }
  const m = b?.message;
  return typeof m === 'string' && /^[a-z][a-z0-9_]+$/.test(m) ? m : '';
}

async function request(method, path, { token, body } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new JawwalCorpError(`تعذّر الوصول إلى جوال باي: ${e.name === 'TimeoutError' ? 'انتهت المهلة' : e.message}`, { unsure: true });
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
  if (res.ok && json && json.success !== false) return json;
  const code = errorCode(json);
  const retryAfter = Number(pick(json, 'retry_after')) || 0;
  const message = (json && typeof json.message === 'string' && json.message !== code && json.message) || code || `HTTP ${res.status}`;
  throw new JawwalCorpError(message, {
    status: res.status, code, retryAfter,
    data: json && typeof json.data === 'object' ? json.data : json,
    unsure: res.status >= 500 || (!json && res.ok),
  });
}

// ---------- sign-in ----------
// expires_at as an ISO date or epoch seconds/milliseconds.
function parseTime(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

let signingIn = null;

async function signIn(creds) {
  if (!creds?.managerId || !creds.user || !creds.pass) throw new JawwalCorpError('أدخل بيانات واجهة الشركات (رقم المشترك واسم المستخدم وكلمة المرور)', { code: 'not_configured' });
  const wait = Number(read(KEYS.wait)) || 0;
  if (wait > Date.now()) {
    throw new JawwalCorpError('الدفع المباشر متوقف مؤقتاً', { status: 429, code: read(KEYS.waitCode) || 'wait', retryAfter: Math.ceil((wait - Date.now()) / 1000) });
  }
  let r;
  try {
    r = await request('POST', '/api/auth/corporate_sign_in', { body: { manager_id: creds.managerId, username: creds.user, password: creds.pass } });
  } catch (e) {
    if (e.status === 429) {
      // Every seat busy (wait until one is free) or blocked (15 minutes): no sign-in at all before then.
      const ms = e.retryAfter > 0 ? e.retryAfter * 1000 : e.code === 'corporate_blocked' ? BLOCK_MS : REFUSED_WAIT_MS;
      waitUntil(ms + SKEW_MS, e.code);
      if (e.code === 'corporate_blocked') forget();
    } else if ([401, 403].includes(e.status)) {
      waitUntil(REFUSED_WAIT_MS, e.code);
    }
    throw e;
  }
  const token = pick(r, 'access_token');
  if (!token || typeof token !== 'string') throw new JawwalCorpError('رد تسجيل الدخول بلا رمز', { unsure: false });
  // By our own clock (expires_in), never later than their expires_at.
  const byIn = Number(pick(r, 'expires_in')) > 0 ? Date.now() + Number(pick(r, 'expires_in')) * 1000 : 0;
  const byAt = parseTime(pick(r, 'expires_at'));
  const exp = Math.min(...[byIn, byAt].filter((t) => t > Date.now())) || Date.now() + FALLBACK_TTL_MS;
  store(creds, token, Number.isFinite(exp) ? exp : Date.now() + FALLBACK_TTL_MS);
  return token;
}

// The token to use: the stored one while it lasts; otherwise one sign-in, shared by every request waiting for it.
// failed: the token a request was just refused with (401): another sign-in is made only if no other request already
// replaced it.
async function token(creds, { failed = null } = {}) {
  const s = stored(creds);
  if (s && s.token !== failed && s.exp > Date.now()) return s.token;
  if (signingIn) return signingIn;
  signingIn = (async () => {
    // It just ended: wait out the clock difference first (a few seconds at most).
    if (s && s.token !== failed && s.exp + SKEW_MS > Date.now()) await new Promise((r) => setTimeout(r, s.exp + SKEW_MS - Date.now()));
    return signIn(creds);
  })().finally(() => { signingIn = null; });
  return signingIn;
}

// A request with the token; on 401 one sign-in and one retry.
async function call(creds, method, path, body) {
  let tok = await token(creds);
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(method, path, { token: tok, body });
    } catch (e) {
      if (e.status === 429 && e.code === 'corporate_blocked') {
        forget();
        waitUntil(e.retryAfter > 0 ? e.retryAfter * 1000 : BLOCK_MS, e.code);
      }
      if (e.status !== 401 || attempt > 0 || e.code === 'invalid_credentials') throw e;
      forget(tok);
      tok = await token(creds, { failed: tok });
    }
  }
}

// ---------- the API ----------
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Texts the customer a code for this amount. Returns the invoice to confirm: { invoiceId, expiresAt, amount, mobile }.
// bank: '' (Jawwal Pay wallet) or 'PALS' (Bank of Palestine, which texts the code to the mobile registered with it).
async function sendOtp(creds, { mobile, amount, bank = '' }) {
  const r = await call(creds, 'POST', '/api/jawwal/corporate/send_otp', { mobile_number: String(mobile), amount: money(amount), ...(bank ? { bank } : {}) });
  const d = r.data && typeof r.data === 'object' ? r.data : r;
  if (!d.cor_invoice_id) throw new JawwalCorpError('رد جوال باي بلا رقم فاتورة', { unsure: true });
  return {
    invoiceId: String(d.cor_invoice_id),
    expiresAt: parseTime(d.expires_at) || null,
    amount: d.amount === undefined ? null : money(d.amount),
    mobile: d.mobile_number ? String(d.mobile_number) : String(mobile),
  };
}

// Confirms the invoice with the customer's code. Refusals throw: 402 jawwal_confirm_failed (data.failure_code,
// data.can_retry), 409 invoice_confirmed / invoice_expired, 404 invoice_not_found.
async function confirmPayment(creds, { invoiceId, otp }) {
  const r = await call(creds, 'POST', '/api/jawwal/corporate/confirm_payment', { cor_invoice_id: String(invoiceId), otp: String(otp) });
  return r.data && typeof r.data === 'object' ? r.data : r;
}

// The list of invoices wherever the response holds it (data, data.invoices, data.data, data.items…, a page object):
// the first array of objects found, a few levels deep.
function listIn(r, depth = 0) {
  if (Array.isArray(r)) return r.filter((x) => x && typeof x === 'object');
  if (!r || typeof r !== 'object' || depth > 3) return [];
  for (const k of ['data', 'invoices', 'items', 'results', 'rows', 'list', 'records']) {
    const l = listIn(r[k], depth + 1);
    if (l.length) return l;
  }
  return [];
}
// The invoice's id under whichever name it has (cor_invoice_id as documented; SADCOR-… / COR-… as sent back).
const ID_KEYS = ['cor_invoice_id', 'invoice_id', 'invoiceId', 'corInvoiceId', 'reference', 'ref', 'id'];
const idsOf = (i) => ID_KEYS.map((k) => i?.[k]).filter((v) => v !== undefined && v !== null && v !== '').map(String);
// The documented states, and the names a payment provider may use for them.
const STATES = { confirmed: 'confirmed', paid: 'confirmed', success: 'confirmed', succeeded: 'confirmed', completed: 'confirmed', done: 'confirmed',
  pending: 'pending', waiting: 'pending', expired: 'expired', failed: 'failed', cancelled: 'failed', canceled: 'failed', rejected: 'failed' };
const stateOf = (v) => STATES[String(v || '').toLowerCase().trim()] || String(v || '').toLowerCase().trim();

// A payment in progress asked again (E-SADAD: success means confirmed; 409 esdad_payment_not_confirmed: still pending).
// Never charges twice.
async function settle(creds, invoiceId) {
  const r = await call(creds, 'POST', '/api/jawwal/corporate/settle', { cor_invoice_id: String(invoiceId) });
  return r.data && typeof r.data === 'object' ? r.data : r;
}

// The account's invoices: { status: pending|confirmed|expired|failed, mobile, cor_invoice_id, limit, page }.
async function invoices(creds, filters = {}, { withRaw = false } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const r = await call(creds, 'GET', `/api/jawwal/corporate/invoices${qs.size ? `?${qs}` : ''}`);
  const list = listIn(r).map((i) => ({
    invoiceId: idsOf(i).find((v) => /COR-/i.test(v)) || idsOf(i)[0] || '',
    ids: idsOf(i),
    status: stateOf(i.status ?? i.state ?? i.payment_status),
    amount: i.amount === undefined || i.amount === null ? null : money(i.amount),
    mobile: String(i.mobile_number ?? i.mobile ?? i.msisdn ?? ''),
    raw: i,
  }));
  return withRaw ? { list, raw: r } : list;
}

// One invoice by its id, or null: asked by its id; not found that way, among the latest invoices (by any id field, or
// the id anywhere in it). What the API answered is logged when it is not found, to see how it names things.
async function invoice(creds, invoiceId) {
  const id = String(invoiceId);
  const has = (i) => i.ids.includes(id) || JSON.stringify(i.raw).includes(`"${id}"`);
  const first = await invoices(creds, { cor_invoice_id: id, limit: 5 }, { withRaw: true });
  let hit = first.list.find(has);
  if (hit) return { ...hit, invoiceId: id };
  const latest = await invoices(creds, { limit: 100 }, { withRaw: true });
  hit = latest.list.find(has);
  if (hit) return { ...hit, invoiceId: id };
  console.error('jawwal invoice not found', id, JSON.stringify(first.raw).slice(0, 600), '| latest:', JSON.stringify(latest.raw).slice(0, 600));
  return null;
}

module.exports = { BASE, JawwalCorpError, sendOtp, confirmPayment, settle, invoices, invoice, listIn, stateOf, status, token, parseTime, _forget: forget };
