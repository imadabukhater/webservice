'use strict';
// Aylol Telecom (aylol-telecom.com) client: top-up cards ("credit"), new bill lines ("bill") and eSIMs.
// The site is a Laravel app behind a bot check that only lets a real HTTP/2 client through, so requests go through
// the system's curl (asynchronously: the server never waits on it) with a cookie jar kept beside the database.
// Signed AJAX calls carry X-Sec-Time / X-Sec-Nonce / X-Sec-Sign = sha256(path|time|nonce|seed), the seed being read
// from the charge page after signing in.
// The e-mail and password are the manager's, saved in the settings (aylolCredentials): none is written here.
// An eSIM's QR code is drawn here from its real activation code (LPA:1$…); nothing is made up and the code is never
// sent to an outside image service.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const qr = require('./qr');
const { totp } = require('./layan');

const BASE = () => process.env.AYLOL_BASE || 'https://www.aylol-telecom.com';
const CURL = () => process.env.AYLOL_CURL || 'curl';
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36';
const TIMEOUT_S = 35;
const SESSION_MS = 12 * 60_000;

class AylolError extends Error {
  constructor(message, { refused = false } = {}) {
    super(message);
    this.refused = refused; // the site answered and declined: nothing was done there.
  }
}

// ---------- files: beside the database (the app folder is read-only on the server) ----------
let dir = '';
function dataDir() {
  if (dir) return dir;
  let base = process.env.AYLOL_DATA;
  if (!base) {
    const dbFile = require('./db').DB_FILE;
    base = dbFile === ':memory:' ? path.join(os.tmpdir(), `agents-aylol-${process.pid}`) : path.join(path.dirname(dbFile), 'aylol');
  }
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  dir = base;
  return dir;
}
const cookieJar = () => path.join(dataDir(), 'cookies.txt');

// ---------- requests: one at a time (they share the cookie jar) ----------
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// body: sent as the request's body through curl's stdin, so the password, tokens and customers' details never show
// in the server's process list. -g: the site's values are never read as curl's URL patterns.
function curl(args, body = null) {
  return serial(() => new Promise((resolve, reject) => {
    const out = path.join(dataDir(), `res-${crypto.randomBytes(6).toString('hex')}.tmp`);
    const child = execFile(CURL(), ['--http2', '-g', '-sS', '--max-time', String(TIMEOUT_S), '-A', UA, '-b', cookieJar(), '-c', cookieJar(), ...args,
      ...(body === null ? [] : ['--data-binary', '@-']), '-o', out],
      { timeout: (TIMEOUT_S + 5) * 1000 }, (err) => {
        let text = '';
        try { text = fs.readFileSync(out, 'utf8'); } catch {}
        try { fs.unlinkSync(out); } catch {}
        if (err) {
          if (err.code === 'ENOENT') return reject(new AylolError('أيلول: برنامج curl غير مثبت على الخادم'));
          return reject(new AylolError(`أيلول: تعذّر الاتصال (${String(err.message).split('\n')[0].slice(0, 120)})`));
        }
        resolve(text);
      });
    child.stdin.on('error', () => {});
    child.stdin.end(body === null ? '' : body);
  }));
}
const formBody = (fields) => new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v ?? '')])).toString();

function page(url, ref, extra = [], body = null) {
  return curl([
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: ar,en;q=0.9',
    ...(ref ? ['-H', `Referer: ${ref}`] : []),
    '-H', 'Sec-Fetch-Dest: document', '-H', 'Sec-Fetch-Mode: navigate', '-H', `Sec-Fetch-Site: ${ref ? 'same-origin' : 'none'}`,
    ...extra, url,
  ], body);
}

const state = { seed: '', csrf: '', user: '', loggedAt: 0, chargeHtml: '', balance: null };

function signedHeaders(p) {
  const ts = String(Date.now());
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const rb = crypto.randomBytes(20);
  let nonce = '';
  for (let i = 0; i < 20; i++) nonce += chars[rb[i] % chars.length];
  const sign = crypto.createHash('sha256').update(`${p}|${ts}|${nonce}|${state.seed}`).digest('hex');
  return { ts, nonce, sign };
}

function ajax(p, { ref = '/dashboard/charge-system', signed = true, csrf = state.csrf, extra = [], body = null } = {}) {
  const h = signed ? signedHeaders(p) : null;
  return curl([
    '-H', 'Accept: application/json, text/javascript, */*; q=0.01',
    '-H', 'Accept-Language: ar,en;q=0.9',
    '-H', 'X-Requested-With: XMLHttpRequest',
    '-H', `X-CSRF-TOKEN: ${csrf || state.csrf}`,
    ...(h ? ['-H', `X-Sec-Time: ${h.ts}`, '-H', `X-Sec-Nonce: ${h.nonce}`, '-H', `X-Sec-Sign: ${h.sign}`] : []),
    '-H', `Referer: ${BASE()}${ref}`, '-H', `Origin: ${BASE()}`,
    '-H', 'Sec-Fetch-Dest: empty', '-H', 'Sec-Fetch-Mode: cors', '-H', 'Sec-Fetch-Site: same-origin',
    ...extra, BASE() + p,
  ], body);
}
const parseJson = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

function exCsrf(h) {
  if (!h) return '';
  return h.match(/csrf-token["']\s+content=["']([^"']+)["']/i)?.[1]
    || h.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)?.[1]
    || h.match(/<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i)?.[1] || '';
}
function exSeed(h) {
  return (h && (h.match(/seed:\s*["']([^"']+)["']/i)?.[1] || h.match(/["']?seed["']?\s*[:=]\s*["']([a-f0-9]{16,128})["']/i)?.[1])) || '';
}
function exBalance(h) {
  const m = h && (h.match(/(?:الرصيد|رصيدك|balance)[^0-9-]*([0-9]+(?:\.[0-9]+)?)/i) || h.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:₪|شيكل|ILS)/i));
  return m ? Number(m[1]) : null;
}

function requireCreds(creds) {
  const user = String(creds?.user || '').trim();
  const pass = String(creds?.pass || '');
  if (!user || !pass) throw new AylolError('أدخل بريد وكلمة مرور أيلول في الإعدادات أولاً', { refused: true });
  return { user, pass, secret: String(creds?.secret || '') };
}

// ---------- two-step sign-in (Google Authenticator) ----------
// After the password the site sends to /two-factor, a form asking the authenticator's 6-digit code: one field, or one
// box per digit. Its own fields are read from the page (hidden token, field names, where it posts), never guessed.
const attrOf = (tag, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const unescapeHtml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const CODE_NAME = /code|otp|one_?time|totp|2fa|verification|pin|authenticator/i;
function twoFactorForm(html, pageUrl) {
  for (const [, attrs, inner] of String(html || '').matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const inputs = [...inner.matchAll(/<input\b[^>]*>/gi)].map(([tag]) => ({
      name: attrOf(tag, 'name'), type: (attrOf(tag, 'type') || 'text').toLowerCase(), value: unescapeHtml(attrOf(tag, 'value') || ''), max: attrOf(tag, 'maxlength'),
    })).filter((i) => i.name);
    const typed = inputs.filter((i) => ['text', 'number', 'tel', ''].includes(i.type));
    const digits = typed.filter((i) => i.max === '1');
    const single = typed.find((i) => CODE_NAME.test(i.name)) || (typed.length === 1 ? typed[0] : null);
    if (inputs.some((i) => i.type === 'password') || (!single && digits.length < 4)) continue;
    let action;
    try { action = new URL(unescapeHtml(attrOf(attrs, 'action') || pageUrl), pageUrl); } catch { continue; }
    return {
      action: action.href,
      hidden: inputs.filter((i) => i.type === 'hidden'),
      codeHidden: inputs.find((i) => i.type === 'hidden' && i.name !== '_token' && CODE_NAME.test(i.name)) || null,
      single: digits.length >= 4 ? null : single,
      digits: digits.length >= 4 ? digits : [],
      remember: inputs.filter((i) => i.type === 'checkbox' && /remember|trust/i.test(i.name)),
    };
  }
  return null;
}
function twoFactorFields(form, code) {
  const pairs = form.hidden.map((i) => [i.name, form.codeHidden && i.name === form.codeHidden.name ? code : i.value]);
  if (form.single) pairs.push([form.single.name, code]);
  form.digits.forEach((d, n) => pairs.push([d.name, code[n] || '']));
  for (const r of form.remember) pairs.push([r.name, r.value || 'on']); // remember this device: fewer codes later
  return new URLSearchParams(pairs).toString();
}
const charged = async () => {
  const h = await page(`${BASE()}/dashboard/charge-system`, `${BASE()}/admin/home`);
  return { h, seed: exSeed(h) };
};
async function passTwoFactor(c) {
  const pageUrl = `${BASE()}/two-factor`;
  const html = await page(pageUrl, `${BASE()}/login`);
  const form = twoFactorForm(html, pageUrl);
  if (!form) return null;
  if (!c.secret) throw new AylolError('أيلول يطلب رمز Google Authenticator: أدخل المفتاح السري في الإعدادات ← أيلول', { refused: true });
  // The code goes to the site itself only.
  if (new URL(form.action).origin !== new URL(BASE()).origin) throw new AylolError('أيلول: صفحة رمز المصادقة ترسل إلى موقع آخر — لم أرسل الرمز');
  for (let attempt = 0; attempt < 2; attempt++) {
    // A code is used once: a second try waits for the next one (every 30 seconds).
    if (attempt) await new Promise((r) => setTimeout(r, 30_500 - (Date.now() % 30_000)));
    await page(form.action, pageUrl, ['-H', `Origin: ${BASE()}`, '-H', 'Content-Type: application/x-www-form-urlencoded'], twoFactorFields(form, totp(c.secret)));
    const after = await charged();
    if (after.seed) return after.h;
  }
  throw new AylolError('أيلول رفض رمز المصادقة — تأكد من المفتاح السري (نفس حساب Google Authenticator) ومن ضبط ساعة الخادم', { refused: true });
}

// ---------- session ----------
async function login(creds) {
  const c = requireCreds(creds);
  // A saved session may still be good: the charge page then carries the seed.
  if (state.user === c.user && fs.existsSync(cookieJar())) {
    const h = await page(`${BASE()}/dashboard/charge-system`, `${BASE()}/admin/home`);
    const seed = exSeed(h);
    const csrf = exCsrf(h);
    if (seed && csrf) {
      Object.assign(state, { seed, csrf, user: c.user, loggedAt: Date.now(), chargeHtml: h, balance: exBalance(h) });
      return { ok: true, user: c.user, balance: state.balance };
    }
  }
  try { fs.unlinkSync(cookieJar()); } catch {}
  const loginHtml = await page(`${BASE()}/login`, '');
  const csrf1 = exCsrf(loginHtml);
  if (!csrf1) throw new AylolError('أيلول: تعذّر قراءة صفحة الدخول');
  await page(`${BASE()}/login`, `${BASE()}/login`, ['-H', `Origin: ${BASE()}`, '-H', 'Content-Type: application/x-www-form-urlencoded'],
    formBody({ email: c.user, password: c.pass, _token: csrf1 }));
  let ch = (await charged()).h;
  // Two-step sign-in: the charge page only opens once the authenticator's code is accepted.
  if (!exSeed(ch)) ch = (await passTwoFactor(c)) || ch;
  const seed = exSeed(ch);
  if (!seed) throw new AylolError('أيلول رفض الدخول — راجع البريد وكلمة المرور', { refused: true });
  Object.assign(state, { seed, csrf: exCsrf(ch) || csrf1, user: c.user, loggedAt: Date.now(), chargeHtml: ch, balance: exBalance(ch) });
  return { ok: true, user: c.user, balance: state.balance };
}
async function ensureSession(creds) {
  const c = requireCreds(creds);
  if (state.user !== c.user || !state.seed || Date.now() - state.loggedAt > SESSION_MS) await login(c);
}

// ---------- catalog ----------
function normalizeCompanyName(raw, group = '', id = 0) {
  const t = `${String(raw || '')} ${String(group || '')}`.trim();
  const cid = Number(id);
  if (/سلكوم|سيليكوم|cellcom/i.test(t) || [3, 11, 91].includes(cid)) return 'سلكوم';
  if (/بلفون|بيلفون|بيليفون|pelephone/i.test(t) || [2, 15].includes(cid)) return 'بيلفون';
  if (/هوت|hot/i.test(t) || [10, 12, 23].includes(cid)) return 'هوت موبايل';
  if (/بارتنر|partner/i.test(t) || [1, 24].includes(cid)) return 'بارتنر';
  if (/012/i.test(t) || cid === 4) return '012';
  if (/019/i.test(t) || [28, 102].includes(cid)) return '019';
  if (/^وي$|\bwe\b|we_/i.test(t) || [6, 25].includes(cid)) return 'WE';
  if (/جولان|golan/i.test(t) || cid === 5) return 'جولان';
  if (/رامي|rami/i.test(t) || cid === 7) return 'رامي ليفي';
  return String(raw || '').trim() || 'Aylol';
}
// The site's categories, used when its charge page does not list them as cards.
const KNOWN_CATS = {
  credit: [
    { id: 3, ids: [3], group: 'cellcom_credit', type: 'credit', name: 'سلكوم' },
    { id: 1, ids: [1], group: 'partner_credit', type: 'credit', name: 'بارتنر' },
    { id: 2, ids: [2], group: 'pelephone_credit', type: 'credit', name: 'بيلفون' },
    { id: 10, ids: [10], group: 'hot_credit', type: 'credit', name: 'هوت موبايل' },
    { id: 5, ids: [5], group: 'golan_credit', type: 'credit', name: 'جولان' },
    { id: 4, ids: [4], group: '012_credit', type: 'credit', name: '012' },
    { id: 6, ids: [6], group: 'we_credit', type: 'credit', name: 'WE' },
    { id: 7, ids: [7], group: 'ramilevi_credit', type: 'credit', name: 'رامي ليفي' },
    { id: 28, ids: [28], group: '019_credit', type: 'credit', name: '019' },
  ],
  bill: [
    { id: 11, ids: [11, 91], group: 'cellcom_bill', type: 'bill', name: 'سلكوم' },
    { id: 12, ids: [12, 23], group: 'hot_bill', type: 'bill', name: 'هوت موبايل' },
    { id: 25, ids: [25], group: 'we_bill', type: 'bill', name: 'WE' },
    { id: 15, ids: [15], group: 'pelephone_bill', type: 'bill', name: 'بيلفون' },
    { id: 24, ids: [24], group: 'partner_bill', type: 'bill', name: 'بارتنر' },
    { id: 102, ids: [102], group: '019_bill', type: 'bill', name: '019' },
  ],
};
function parseCategoriesFromHtml(html) {
  const list = [];
  const seen = new Set();
  const re = /<div[^>]*class=["'][^"']*category-card[^"']*["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const tag = m[0];
    if (tag.includes('esim-category-card')) continue;
    const id = tag.match(/data-category-id=["'](\d+)["']/i)?.[1] || '';
    const idsRaw = tag.match(/data-category-ids=["']([^"']+)["']/i)?.[1] || id;
    const group = tag.match(/data-category-group=["']([^"']*)["']/i)?.[1] || '';
    const type = tag.match(/data-category-type=["']([^"']+)["']/i)?.[1] || '';
    const title = tag.match(/title=["']([^"']+)["']/i)?.[1] || '';
    if (!id || (type !== 'credit' && type !== 'bill')) continue;
    const k = `${type}:${id}:${group}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const ids = idsRaw.split(',').map((x) => Number(x.trim())).filter(Boolean);
    list.push({ id: Number(id), ids: ids.length ? ids : [Number(id)], group, type, name: normalizeCompanyName(title, group, id) });
  }
  for (const t of ['credit', 'bill']) {
    for (const kc of KNOWN_CATS[t]) {
      const k = `${kc.type}:${kc.id}:${kc.group}`;
      if (!seen.has(k)) { seen.add(k); list.push(kc); }
    }
  }
  return list;
}
async function fetchPackages({ companyId, type, groupName = '', pageNo = 1 }, creds) {
  await ensureSession(creds);
  return parseJson(await ajax(`/dashboard/charge-system/categories/${companyId}/packages?type=${type}&page=${pageNo}${groupName ? `&group_name=${groupName}` : ''}`));
}
function extractGb(p, name) {
  if (Number(p.data_gb) > 0) return Number(p.data_gb);
  if (Number(p.internet) > 0) { const v = Number(p.internet); return (v >= 1024 && v % 1024 === 0) ? Math.round(v / 1024) : v; }
  const m = String(name || '').match(/(\d+)\s*(?:جيجا|GB|G\b)/i);
  return m ? Number(m[1]) : 0;
}
// Every package the site lists, by type: [{ ref: 'ay:<type>:<categoryId>:<packageId>', name, company, price, … }].
async function syncAll(creds, types = ['credit', 'bill']) {
  await login(creds);
  const items = [];
  const seen = new Set();
  for (const type of types) {
    for (const c of parseCategoriesFromHtml(state.chargeHtml).filter((x) => x.type === type)) {
      for (const cid of [...new Set([c.id, ...(c.ids || [])])]) {
        let got = 0;
        for (const g of c.group ? [c.group, ''] : ['']) {
          for (let pageNo = 1, last = 1; pageNo <= last && pageNo <= 15; pageNo++) {
            const r = await fetchPackages({ companyId: cid, type, groupName: g, pageNo }, creds);
            const rows = (r && r.success && Array.isArray(r.data)) ? r.data : (r && Array.isArray(r.packages) ? r.packages : []);
            if (!rows.length) break;
            for (const p of rows) {
              const key = `${type}:${p.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              got++;
              const name = String(p.display_name || p.name || p.title || '').trim();
              items.push({
                id: p.id, ref: `ay:${type}:${cid}:${p.id}`, name, company: c.name, companyId: cid, type,
                kind: type === 'bill' ? 'invoice' : 'card', price: Number(p.price ?? p.cost ?? p.distributor_price ?? p.customer_price ?? 0),
                dataGb: extractGb(p, name), minutes: Number(p.minutes ?? p.call ?? 0) || 0, sms: Number(p.sms ?? 0) || 0,
                days: Number(p.days || (p.month_number ? Number(p.month_number) * 30 : 30)) || 30, description: String(p.description || '').trim(),
              });
            }
            last = Number(r.last_page) || 1;
          }
          if (got > 0) break;
        }
      }
    }
  }
  return { syncedAt: Date.now(), items };
}

// ---------- eSIMs ----------
function mapToEsimCategoryId(companyId) {
  const n = Number(companyId);
  if ([11, 91, 3].includes(n)) return 3;
  if ([12, 23, 10].includes(n)) return 10;
  if ([15, 2].includes(n)) return 2;
  if ([24, 1].includes(n)) return 1;
  if ([102, 28].includes(n)) return 28;
  return n === 4 ? 4 : n;
}
async function fetchEsimPage(creds) {
  await ensureSession(creds);
  return page(`${BASE()}/dashboard/esim`, `${BASE()}/dashboard/charge-system`);
}
async function fetchEsimPackages({ categoryId, purchaseType = 'loaded_esim' }, creds) {
  await ensureSession(creds);
  return parseJson(await ajax(`/dashboard/esim/packages?category_id=${encodeURIComponent(categoryId)}&purchase_type=${encodeURIComponent(purchaseType)}`, { ref: '/dashboard/esim', signed: false }));
}
async function fetchEsimReadyStocks({ categoryId }, creds) {
  await ensureSession(creds);
  return parseJson(await ajax(`/dashboard/esim/ready-stocks?category_id=${encodeURIComponent(categoryId)}`, { ref: '/dashboard/esim', signed: false }));
}

// The eSIM's real activation code (LPA:1$…) and its QR image: the site's own image when it sends one as data, else
// drawn here from the code. No code: no QR.
const LPA = /^LPA:1\$/i;
function esimCodeAndQr(d = {}, rawObj = {}) {
  const fields = [d.lpa, d.activation_code, d.esim_code, d.matching_id, d.qr_code, d.qr, d.esim_qr, d.payload, rawObj.lpa, rawObj.qr_code, rawObj.qr];
  const code = fields.map((v) => (typeof v === 'string' ? v.trim() : '')).find((v) => LPA.test(v)) || '';
  const image = [d.qr_image, d.qr_code, d.qr, d.esim_barcode, d.esim_qr, d.barcode, rawObj.qr_code]
    .find((v) => typeof v === 'string' && /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(v)) || '';
  return { esimCode: code, qr: image || (code ? qr.dataUrl(code) : '') };
}
function phoneFrom(d = {}, rawObj = {}, fallback = '') {
  for (const c of [d.phone, d.phone_number, d.MobileNumber, d.mobile, d.new_phone, d.allocated_phone, d.number, d.msisdn, d.sim_phone, rawObj.phone, rawObj.phone_number, rawObj.new_phone, rawObj.number]) {
    const cl = String(c || '').replace(/\D/g, '');
    if (cl.length >= 9) return cl;
  }
  return fallback;
}

// Buys an eSIM at the site (it is charged there): called only when an order is carried out.
async function purchaseEsim({ categoryId, purchaseType = 'empty_esim', phone = '', simLastDigits = '', esimStockId = '', packageId = '', transferPhone = '' }, creds) {
  await ensureSession(creds);
  const esimHtml = await fetchEsimPage(creds);
  const esimCsrf = exCsrf(esimHtml) || state.csrf;
  const catNum = mapToEsimCategoryId(categoryId);
  let chosenStock = null;
  if (!esimStockId && (!phone || purchaseType === 'ready_esim')) {
    const sr = await fetchEsimReadyStocks({ categoryId: catNum }, creds);
    const stocks = (sr && sr.success && Array.isArray(sr.data)) ? sr.data : [];
    if (stocks.length) {
      chosenStock = stocks[0];
      esimStockId = String(chosenStock.id);
      if (purchaseType === 'empty_esim') purchaseType = 'ready_esim';
    }
  }
  let endpoint = '/dashboard/esim/purchase-empty';
  let body = { category_id: catNum, purchase_type: purchaseType, phone: String(phone || '').replace(/\D/g, ''), sim_last_digits: String(simLastDigits || '') };
  if (purchaseType === 'ready_esim' && esimStockId) body.esim_stock_id = esimStockId;
  else if (String(catNum) === '10' && purchaseType === 'loaded_esim') {
    endpoint = '/dashboard/esim/purchase-category-10-loaded';
    body = { category_id: 10, purchase_type: 'loaded_esim', package_id: String(packageId) };
  } else if (String(catNum) === '28' && ['new_esim', 'transfer_to_esim', 'loaded_esim'].includes(purchaseType)) {
    endpoint = '/dashboard/esim/purchase-category-28';
    body = { category_id: 28, purchase_type: purchaseType, phone: String(phone || '').replace(/\D/g, ''), transfer_phone: String(transferPhone || '').replace(/\D/g, ''), package_id: String(packageId || '') };
  }
  const raw = await ajax(endpoint, { ref: '/dashboard/esim', signed: false, csrf: esimCsrf, extra: ['-H', 'Content-Type: application/json'], body: JSON.stringify(body) });
  const res = parseJson(raw);
  if (!res) throw new AylolError(`أيلول: رد غير مفهوم على شراء eSIM (${raw.slice(0, 120)})`);
  if (!res.success) throw new AylolError(res.message || res.error || 'أيلول رفض إصدار شريحة eSIM', { refused: true });
  const d = res.data || {};
  const stPhone = chosenStock ? (chosenStock.phone || chosenStock.phone_number || chosenStock.number || '') : '';
  const stSim = chosenStock ? (chosenStock.sim_number || chosenStock.iccid || '') : '';
  return { ok: true, phoneNumber: phoneFrom(d, res, String(stPhone || body.phone || '').replace(/\D/g, '')), simNumber: String(d.sim_number || d.sim || d.iccid || stSim || ''), ...esimCodeAndQr(d, res), esimId: d.id || d.esim_id || esimStockId || '' };
}

// Ready numbers for a package (no purchase unless `allocate`, which buys an eSIM: only when an order is carried out).
async function lookupAvailableNumbers({ ref = '', companyId = '', packageId = '', simNumber = '', allocate = false }, creds) {
  await ensureSession(creds);
  let cid = String(companyId || '');
  let pid = String(packageId || '');
  if (ref.startsWith('ay:')) { const parts = ref.split(':'); cid = cid || String(parts[2] || ''); pid = pid || String(parts[3] || ''); }
  const esimCatId = mapToEsimCategoryId(cid || 3);
  const cleanSim = String(simNumber || '').replace(/\D/g, '');
  const numbers = [];
  const seen = new Set();
  const push = (obj) => {
    const phone = phoneFrom(obj, obj, '');
    if (!phone || seen.has(phone)) return;
    seen.add(phone);
    numbers.push({ phoneNumber: phone, simNumber: String(obj.sim_number || obj.sim || obj.iccid || cleanSim || ''), esimStockId: obj.id || obj.esim_id || obj.stock_id || '', ...esimCodeAndQr(obj, obj) });
  };
  const sr = await fetchEsimReadyStocks({ categoryId: esimCatId }, creds);
  const rows = (sr && sr.success && Array.isArray(sr.data)) ? sr.data : (sr && Array.isArray(sr.stocks) ? sr.stocks : []);
  for (const row of rows) {
    if (cleanSim) {
      const rs = String(row.sim_number || row.iccid || row.sim || '').replace(/\D/g, '');
      if (rs && !rs.endsWith(cleanSim) && !cleanSim.endsWith(rs) && !rs.includes(cleanSim)) continue;
    }
    push(row);
  }
  if (!numbers.length && allocate) {
    const pType = (esimCatId === 28 && !cleanSim) ? 'new_esim' : (esimCatId === 10 && pid && pid !== 'empty' ? 'loaded_esim' : 'empty_esim');
    const ar = await purchaseEsim({ categoryId: esimCatId, purchaseType: pType, simLastDigits: cleanSim ? cleanSim.slice(-6) : '', packageId: (pid === 'empty' || pid === 'ready') ? '' : pid }, creds);
    if (ar.phoneNumber) numbers.push({ phoneNumber: ar.phoneNumber, simNumber: ar.simNumber || cleanSim, esimStockId: ar.esimId, esimCode: ar.esimCode, qr: ar.qr });
  }
  return { ok: true, categoryId: esimCatId, simNumber: cleanSim, numbers };
}

// Carries an order out at the site (it is charged there). ref: ay:<credit|bill|esim>:<categoryId>:<packageId>.
async function executeOrder({ ref, phoneNumber = '', price = 0, simNumber = '', useEsim = false, retrieveNewNumber = false, note = '' }, creds) {
  await ensureSession(creds);
  const parts = String(ref || '').split(':');
  if (parts[0] !== 'ay' || parts.length < 4) throw new AylolError('رزمة أيلول غير صالحة', { refused: true });
  const [, type, companyId, packageId] = parts;
  const cleanPhone = String(phoneNumber || '').replace(/\D/g, '');
  const needNewNum = !cleanPhone || /^050{7,8}$/.test(cleanPhone) || retrieveNewNumber;

  if (type === 'esim') {
    const catNum = mapToEsimCategoryId(companyId);
    const pType = packageId === 'empty' ? 'empty_esim' : (packageId === 'ready' ? 'ready_esim' : (catNum === 28 && needNewNum ? 'new_esim' : 'loaded_esim'));
    const res = await purchaseEsim({ categoryId: catNum, purchaseType: pType, phone: needNewNum ? '' : cleanPhone, packageId: (packageId === 'empty' || packageId === 'ready') ? '' : packageId }, creds);
    return { ok: true, message: res.phoneNumber ? `تم التفعيل — الرقم: ${res.phoneNumber}` : 'تم إصدار شريحة eSIM', phoneNumber: res.phoneNumber || cleanPhone, simNumber: res.simNumber || simNumber, qr: res.qr, esimCode: res.esimCode, isEsim: true };
  }

  let phone = needNewNum ? '' : cleanPhone;
  let sim = String(simNumber || '').trim();
  let allocQr = '';
  let allocCode = '';
  if ((useEsim || needNewNum) && !phone) {
    const look = await lookupAvailableNumbers({ ref, companyId, packageId, simNumber: sim, allocate: true }, creds);
    const n0 = look.numbers[0];
    if (n0) { phone = n0.phoneNumber || phone; sim = n0.simNumber || sim; allocQr = n0.qr || ''; allocCode = n0.esimCode || ''; }
  }
  if (!/^05\d{8}$/.test(phone)) throw new AylolError('لم يتوفر رقم متاح من أيلول لهذه العملية', { refused: true });
  const endpoint = (type === 'bill' && (companyId === '6' || companyId === '25')) ? '/dashboard/charge-system/provider-subscribe' : '/dashboard/charge-system/subscribe';
  const payload = (type === 'credit' && !useEsim && !sim)
    ? { _token: state.csrf, package_id: packageId, company_id: companyId, phone, price: String(Number(price) || 0), note, action: 'recharge' }
    : { _token: state.csrf, package_id: packageId, company_id: companyId, category_id: companyId, phone, MobileNumber: phone, price: String(Number(price) || 0), customer_price: String(Number(price) || 0), duration: '1', note, ...(sim ? { sim_number: sim } : {}) };
  const raw = await ajax(endpoint, { signed: true, extra: ['-H', 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8'], body: formBody(payload) });
  const data = parseJson(raw);
  if (!data) throw new AylolError(`أيلول: رد غير مفهوم (${raw.slice(0, 120)})`);
  if (data.success === true || data.status === 'success' || data.ok === true) {
    const d = data.data || {};
    const got = esimCodeAndQr(d, data);
    return {
      ok: true, message: data.message || 'تم التنفيذ', phoneNumber: phoneFrom(d, data, phone), subscriptionId: d.subscription_id || d.id || '',
      cardCode: d.order_code || d.card_code || d.pin || '', simNumber: String(d.sim_number || sim || ''),
      esimCode: got.esimCode || allocCode, qr: got.qr || allocQr,
    };
  }
  throw new AylolError(data.message || data.error || 'أيلول رفض الطلب', { refused: true });
}

// The site's price for a package right now (read from its own listing), or null when it no longer lists it.
// Asked before every sale, so nothing is bought above the price the manager approved.
const listedPrice = (p) => Number(p.price ?? p.cost ?? p.distributor_price ?? p.customer_price ?? 0) || null;
async function currentPrice(ref, creds) {
  await ensureSession(creds);
  const [head, type, cid, pid] = String(ref || '').split(':');
  if (head !== 'ay' || !cid || !pid) return null;
  if (type === 'esim') {
    for (const purchaseType of ['loaded_esim', 'new_esim']) {
      const r = await fetchEsimPackages({ categoryId: cid, purchaseType }, creds);
      const p = ((r && r.success && Array.isArray(r.data)) ? r.data : []).find((x) => String(x.id) === pid);
      if (p) return listedPrice(p);
    }
    return null;
  }
  if (type !== 'credit' && type !== 'bill') return null;
  const cats = parseCategoriesFromHtml(state.chargeHtml).filter((c) => c.type === type && [c.id, ...(c.ids || [])].map(String).includes(cid));
  for (const g of [...new Set([...cats.map((c) => c.group).filter(Boolean), ''])]) {
    for (let pageNo = 1, last = 1; pageNo <= last && pageNo <= 15; pageNo++) {
      const r = await fetchPackages({ companyId: cid, type, groupName: g, pageNo }, creds);
      const rows = (r && r.success && Array.isArray(r.data)) ? r.data : (r && Array.isArray(r.packages) ? r.packages : []);
      if (!rows.length) break;
      const p = rows.find((x) => String(x.id) === pid);
      if (p) return listedPrice(p);
      last = Number(r.last_page) || 1;
    }
  }
  return null;
}

async function balance(creds) {
  await ensureSession(creds);
  return state.balance;
}

module.exports = {
  AylolError, login, balance, parseCategoriesFromHtml, fetchPackages, syncAll, fetchEsimPage, fetchEsimPackages, fetchEsimReadyStocks,
  purchaseEsim, lookupAvailableNumbers, executeOrder, currentPrice, mapToEsimCategoryId, esimCodeAndQr, twoFactorForm, twoFactorFields, _state: state,
};
