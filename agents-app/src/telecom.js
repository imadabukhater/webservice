'use strict';
// telecom.co.il ("ALOHA") client, for its rentals system (מערכת השכרות). The site is server-rendered PHP with a
// PHPSESSID cookie; its pages call a few JSON endpoints, and this calls the same ones, without a browser:
//   POST /login/verifyLogin { email, password, remember } → a refresh to /VVC (a code was e-mailed) or into /app
//   POST /CVC { code }  (5 digits, valid ~3 minutes) → { result: true, path: '/app/welcome' }
//   POST /app/ajax/getRentPaidPackagesNew { company, type: 'new' } → { data: [package], offer_data: [offer] }
//   GET  /app/ajax/getDataForLeadsTable → the dealer's subscribers ("leads": one per number)
//   GET  /app/leads/viewLead/<id> → one subscriber: its package, end date, and the price an extension starts from
//   POST /app/ajax/renewPhoneLineNew { leadId, renew_type } → { result: true } or { result: false, msg }
// The code is read from the account's Gmail over IMAP (mailcode.js). A session lasts ~75 minutes; a page that
// sends us back to /login signs in again once.
//   extension (ref tc:<package>:<days>)   — extends a subscriber on its own package, carried out automatically
//   new line  (ref tcn:<package>:<days>)  — a request for the manager for now (number, SIM and customer differ by company)
const mailcode = require('./mailcode');

const BASE = process.env.TC_BASE || 'https://www.telecom.co.il';
const TIMEOUT_MS = 30_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// The site's companies, by its own codes, and ours for each.
const COMPANIES = {
  cellcom: 'سلكوم', partner: 'بارتنر', pelephone: 'بيلفون', hot: 'هوت موبايل', golan: 'جولان', we4g: 'WE', 'rami-levi': 'رامي ليفي', x2one: 'ALOHA',
};
// Extensions offered, in days (the site's renew types). 14 days is left out: its price on the site is not one formula.
const RENEW_TYPES = { 7: '1_week', 30: '1_month', 90: '3_month', 180: '6_month' };
const DURATIONS = (process.env.TC_DURATIONS || '30').split(',').map(Number).filter((n) => RENEW_TYPES[n]);

class TelecomError extends Error {
  constructor(message, { refused = false } = {}) {
    super(message);
    this.refused = refused; // the site answered and declined: nothing was done, nothing charged.
  }
}

// For tests: where the e-mailed code comes from.
const deps = { mailMark: mailcode.mark, waitForCode: mailcode.waitForCode };
const CODE_DIGITS = 5; // the site's code page has five boxes

// ---------- requests ----------
const session = { key: '', cookies: new Map(), signingIn: null };

// Where a response sends the browser: a Location header, or the site's "Refresh: 0;url=…".
function target(res) {
  const to = res.headers.get('location') || /url=(.+)$/i.exec(res.headers.get('refresh') || '')?.[1] || '';
  return to ? new URL(to.trim(), BASE).pathname : '';
}

async function request(method, path, { form, ajax = false } = {}) {
  let res;
  try {
    res = await fetch(new URL(path, BASE), {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': UA,
        Referer: `${BASE}/`,
        ...(session.cookies.size ? { Cookie: [...session.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
        ...(ajax ? { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
  } catch (e) {
    throw new TelecomError(`telecom: تعذّر الاتصال (${e.name === 'TimeoutError' ? 'انتهى الوقت' : e.message})`);
  }
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const at = pair.indexOf('=');
    if (at > 0) session.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  const text = await res.text();
  if (res.status >= 500) throw new TelecomError(`telecom: خطأ في الخادم (${res.status})`);
  return { status: res.status, to: target(res), text };
}

const outside = (r) => /^\/login/i.test(r.to);
const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

async function signIn({ user, pass, mail }) {
  if (!user || !pass) throw new TelecomError('أدخل بريد telecom وكلمة المرور في الإعدادات');
  session.key = '';
  session.cookies.clear();
  await request('GET', '/login');
  // Where the mailbox is before the site sends the code (and that the mailbox can be read at all, before asking).
  let mark;
  try {
    mark = await deps.mailMark(mail || {});
  } catch (e) {
    throw new TelecomError(`telecom: ${e.message}`);
  }
  const r = await request('POST', '/login/verifyLogin', { form: { email: user, password: pass, remember: 'on' } });
  if (/^\/app\b/i.test(r.to)) { session.key = `${user}\n${pass}`; return; } // a remembered device: no code asked
  if (!/^\/VVC\b/i.test(r.to)) throw new TelecomError('telecom رفض الدخول — تأكد من البريد وكلمة المرور', { refused: true });
  await request('GET', '/VVC');
  let code;
  try {
    code = await deps.waitForCode(mail || {}, mark, { digits: CODE_DIGITS });
  } catch (e) {
    throw new TelecomError(`telecom: ${e.message}`);
  }
  const data = json(await request('POST', '/CVC', { form: { code }, ajax: true }));
  if (!data || data.result !== true) throw new TelecomError(`telecom لم يقبل رمز التحقق (${code})`, { refused: true });
  session.key = `${user}\n${pass}`;
}

// One sign-in at a time: two jobs at once would each ask for a code and the second would void the first.
function login(creds) {
  session.signingIn ||= signIn(creds).finally(() => { session.signingIn = null; });
  return session.signingIn;
}

// A page of the signed-in site; signs in first, and again once if the session ended.
async function page(creds, method, path, form, { ajax = false } = {}) {
  if (session.signingIn) await session.signingIn;
  if (session.key !== `${creds.user}\n${creds.pass}`) await login(creds);
  let r = await request(method, path, { form, ajax });
  if (outside(r)) {
    session.key = '';
    await login(creds);
    r = await request(method, path, { form, ajax });
    if (outside(r)) throw new TelecomError('telecom: انتهت الجلسة ولم ينجح الدخول من جديد');
  }
  return r;
}

// ---------- reading ----------
const money = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
const round2 = (n) => Math.round(n * 100) / 100;
const text = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const inputValue = (html, id) => new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`, 'i').exec(html)?.[0].match(/\bvalue="([^"]*)"/i)?.[1].trim() ?? null;
// dd/mm/yyyy → yyyy-mm-dd, so dates compare as text.
const isoDate = (d) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(d || '').trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
const localNumber = (n) => {
  let d = String(n || '').replace(/\D/g, '');
  if (d.startsWith('972')) d = `0${d.slice(3)}`;
  return /^0\d{9}$/.test(d) ? d : null;
};

// The rentals credit, as the dashboard shows it ("₪ קרדיט 86.48").
async function balance(creds) {
  const r = await page(creds, 'GET', '/app/dashboard');
  const m = /קרדיט\s+(-?[\d,]+(?:\.\d+)?)/.exec(text(r.text));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// The packages the site sells as new lines, company by company: regular ones (a month) and offers (their months).
// Each is { packageId, company (ours), code (the site's), name, cost, customerPrice, dataGb, minutes, sms, months, offer }.
async function packages(creds) {
  const out = [];
  for (const [code, company] of Object.entries(COMPANIES)) {
    const data = json(await page(creds, 'POST', '/app/ajax/getRentPaidPackagesNew', { company: code, type: 'new' }, { ajax: true }));
    if (!data || data.result === false) continue;
    for (const [list, offer] of [[data.data, false], [data.offer_data, true]]) {
      for (const v of list || []) {
        const cost = money(v.SPrice);
        if (!v.campaignId || !(cost > 0)) continue;
        out.push({
          packageId: Number(v.campaignId), company, code, name: String(v.campaignName || '').replace(/\s+/g, ' ').trim(),
          cost, customerPrice: money(v.CPrice), dataGb: money(v.view_gb ?? v.gb), minutes: money(v.view_minutes), sms: money(v.view_sms),
          months: Math.max(1, Number(v.campaignSpecialMonths) || 0), offer, is5G: /(^|[^\d])5G\b/i.test(v.campaignName || ''), // not the 5G in "15GB"
        });
      }
    }
  }
  return out;
}

// What an extension costs on the site, from the price the subscriber's page starts from (as its renew buttons work it
// out): a month at that price, three and six in proportion, a week at the daily rate plus 2 ₪.
function extensionPrice(supplierPrice, days) {
  const p = Number(supplierPrice);
  if (!(p > 0)) return null;
  if (days === 7) return round2((p / 30) * 7 + 2);
  if (days === 30) return round2(p);
  if (days === 90 || days === 180) return round2((p / 30) * days);
  return null;
}

// The two systems in the app's terms: extensions ('card': regular packages, each duration offered) and new lines
// ('invoice': regular packages and offers). ref is what the app keeps on its package.
async function catalog(creds, kind) {
  const all = await packages(creds);
  if (kind === 'card') {
    return all.filter((p) => !p.offer).flatMap((p) => DURATIONS.map((days) => ({
      ...p, days, cost: extensionPrice(p.cost, days), ref: `tc:${p.packageId}:${days}`,
    })));
  }
  return all.map((p) => ({ ...p, days: p.months * 30, ref: `tcn:${p.packageId}:${p.months * 30}` }));
}

// The dealer's subscribers: { leadId, number, name, company (the site's code), status, active, updated }.
async function leads(creds) {
  const r = await page(creds, 'GET', '/app/ajax/getDataForLeadsTable?draw=1&start=0&length=5000', null, { ajax: true });
  const data = json(r);
  if (!data || !Array.isArray(data.data)) throw new TelecomError('telecom: لم أفهم قائمة المشتركين');
  return data.data.map((row) => {
    const status = text(row[4]);
    return {
      leadId: Number(/value="(\d+)"/.exec(row[0] || '')?.[1]) || null, name: text(row[1]), number: localNumber(row[2]),
      company: text(row[3]), status, active: status === 'פעיל', updated: isoDate(text(row[5])),
    };
  }).filter((l) => l.leadId && l.number);
}

// One subscriber's page: its package, its end date, and the price an extension starts from. special: the subscriber
// is on special terms (its own dates or prices), which the site prices differently — not extended automatically.
async function lead(creds, leadId) {
  const r = await page(creds, 'GET', `/app/leads/viewLead/${Number(leadId)}`);
  const h = r.text;
  const endDate = isoDate(inputValue(h, 'serviceEndDate'));
  const packageId = Number(inputValue(h, 'curr_campaignId')) || null;
  if (!endDate || !packageId) throw new TelecomError(`telecom: لم أفهم صفحة المشترك ${leadId}`);
  const zero = (v) => !v || v === '0' || Number(v) === 0;
  return {
    leadId: Number(leadId), number: localNumber(inputValue(h, 'leadPhone')), packageId, endDate,
    supplierPrice: money(inputValue(h, 'supplier_price')), provider: inputValue(h, 'lineProvider') || '',
    special: !(zero(inputValue(h, 'special_date')) && zero(inputValue(h, 'special_date_days')) && zero(inputValue(h, 'priceSpecial'))),
  };
}

// The subscriber of a number: the active one if there is one, else the latest.
async function findLead(creds, number) {
  const n = localNumber(number);
  const list = (await leads(creds)).filter((l) => l.number === n);
  return list.find((l) => l.active) || list.sort((a, b) => b.leadId - a.leadId)[0] || null;
}

// ---------- doing ----------
// Extends a subscriber; the site charges the dealer's credit. A refusal ({ result: false }) means nothing was done.
async function extend(creds, { leadId, days }) {
  const type = RENEW_TYPES[days];
  if (!type) throw new TelecomError(`telecom: لا يوجد تمديد لمدة ${days} يوماً`, { refused: true });
  const r = await page(creds, 'POST', '/app/ajax/renewPhoneLineNew', { leadId: String(leadId), renew_type: type, date_choice: '' }, { ajax: true });
  const data = json(r);
  if (data && data.result === true) return data;
  if (data && (data.result === false || data.result === 'false')) {
    throw new TelecomError(`telecom رفض التمديد${data.msg ? `: ${String(data.msg).slice(0, 160)}` : ''}`, { refused: true });
  }
  // Anything else: it may or may not have gone through.
  throw new TelecomError(`telecom: رد غير مفهوم على التمديد (${r.status})`);
}

// ---------- a new ALOHA eSIM line (as the site's "new subscriber" form does it) ----------
// 1. /app/ajax2/getx2onePhones { company: 'x2one', type: 'new', campaign } — the free numbers;
// 2. /app/ajax/getESim { data[company] } — a free eSIM ({ data: { id } }), then /app/ajax/chooseESim { id, company } —
//    takes it for this line ({ result, id, sim, QR }: QR is the eSIM's activation code, which the QR image encodes);
// 3. /app/leads/leadActionNew — the form: the number, the eSIM (sim_h, and its id as sim_data), the end date and
//    the customer's details → { result: true, leadId }.
const ESIM_COMPANY = 'x2one';
const SIM_PREFIX = { x2one: '899721233' };
async function esimNumbers(creds, packageId) {
  const data = json(await page(creds, 'POST', '/app/ajax2/getx2onePhones', { company: ESIM_COMPANY, type: 'new', campaign: String(packageId) }, { ajax: true }));
  return (Array.isArray(data) ? data : []).map((n) => localNumber(n.phone)).filter(Boolean);
}
async function takeEsim(creds) {
  const got = json(await page(creds, 'POST', '/app/ajax/getESim', { 'data[company]': ESIM_COMPANY }, { ajax: true }));
  if (!got || got.result !== true || !got.data?.id) throw new TelecomError('telecom: لا يوجد eSIM متاح الآن', { refused: true });
  const chosen = json(await page(creds, 'POST', '/app/ajax/chooseESim', { id: String(got.data.id), company: ESIM_COMPANY }, { ajax: true }));
  if (!chosen || chosen.result !== true) throw new TelecomError('telecom: تعذّر حجز eSIM', { refused: true });
  return { id: String(chosen.id || got.data.id), sim: String(chosen.sim || '').replace(/\D/g, ''), code: String(chosen.QR || got.data.qrData || '') };
}
// dd/mm/yyyy, as the site's form sends dates.
const siteDate = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
async function newEsimLine(creds, { packageId, number, esim, months = 1, customer }) {
  const end = new Date();
  end.setMonth(end.getMonth() + Math.max(1, months));
  const [first, ...rest] = String(customer.name || '').trim().split(/\s+/);
  const r = await page(creds, 'POST', '/app/leads/leadActionNew', {
    niyud_phone: '', sim_niyud: '', oldProvider: '0', phone: number, sim: SIM_PREFIX[ESIM_COMPANY], sim_h: esim.sim, sim_new: '',
    serviceEndDate: siteDate(end), firstname: first || '-', lastname: rest.join(' ') || first || '-', email: customer.email, temp_phone: customer.phone,
    address: customer.address, city: customer.city, zipCode: customer.zip, comment: customer.comment || '', campaignId: String(packageId), sim_data: esim.id,
  }, { ajax: true });
  const data = json(r);
  if (data && data.result === true) return { leadId: Number(data.leadId) || null };
  if (data && (data.result === false || data.result === 'false' || data.result === 'false1')) {
    throw new TelecomError(`telecom رفض الخط الجديد${data.result === 'false1' ? ' (رقم الشريحة)' : ''}`, { refused: true });
  }
  throw new TelecomError(`telecom: رد غير مفهوم على الخط الجديد (${r.status})`);
}
// The eSIM's QR code as an image (the site draws it with this same service from the activation code).
const QR_BASE = process.env.TC_QR_BASE || 'https://api.qrserver.com';
async function qrImage(code) {
  if (!code) return '';
  const res = await fetch(`${QR_BASE}/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!res.ok || !/^image\//.test(type)) throw new TelecomError(`telecom: تعذّر رسم رمز QR (${res.status})`);
  return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
}

const parseRef = (ref) => {
  const m = /^(tcn?):(\d+):(\d+)$/.exec(String(ref || ''));
  return m ? { system: m[1], packageId: Number(m[2]), days: Number(m[3]) } : null;
};

// For the settings' "test" button: signs in (with the e-mailed code) and reads the credit and the subscribers.
async function check(creds) {
  session.key = '';
  const [credit, list] = [await balance(creds), await leads(creds)];
  return { balance: credit, subscribers: list.length, active: list.filter((l) => l.active).length };
}

module.exports = {
  TelecomError, COMPANIES, DURATIONS, check, page, balance, packages, catalog, leads, lead, findLead, extend,
  extensionPrice, parseRef, localNumber, esimNumbers, takeEsim, newEsimLine, qrImage, _deps: deps, _session: session,
};
