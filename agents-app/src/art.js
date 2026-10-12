'use strict';
// art-topup.com client. The portal has no public API, so this signs in the way its web page does and calls the
// same endpoints: login (users_db.php?loginTK), the card pages (israel_c.php), a recharge (agents_tk_db.php?makeIR)
// and the operations list (processes.php), where the portal shows each recharge's result.
const BASE = process.env.ART_BASE || 'https://art-topup.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 30_000;

class ArtError extends Error {}

const session = { key: '', jar: new Map() };
const cookieHeader = () => [...session.jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function request(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', Cookie: cookieHeader(),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
    },
    body,
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) session.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  const text = await res.text();
  if (res.status >= 500) throw new ArtError(`art-topup: خطأ في الخادم (${res.status})`);
  return { status: res.status, location: res.headers.get('location') || '', text };
}

const signedOut = (r) => /id="loginFormA"/.test(r.text) || /login\.php/.test(r.location);

async function login({ user, pass }) {
  if (!user || !pass) throw new ArtError('أدخل اسم مستخدم art-topup وكلمة المرور في الإعدادات');
  session.jar.clear();
  session.key = '';
  await request('GET', '/Portal/login.php');
  const r = await request('POST', '/controllers/users_db.php?loginTK', new URLSearchParams({ username: user, password: pass }).toString());
  const answer = r.text.trim();
  if (answer === 'wrong') throw new ArtError('art-topup: اسم المستخدم أو كلمة المرور خاطئة');
  if (answer === 'active') throw new ArtError('art-topup: الحساب غير مفعّل');
  session.key = `${user}\n${pass}`;
}

// GET a portal page, signing in first (or again when the session expired).
async function page(creds, url) {
  if (session.key !== `${creds.user}\n${creds.pass}`) await login(creds);
  let r = await request('GET', url);
  if (signedOut(r)) {
    await login(creds);
    r = await request('GET', url);
    if (signedOut(r)) throw new ArtError('art-topup: تعذّر تسجيل الدخول');
  }
  return r.text;
}

// ---------- HTML helpers ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decode = (s) => String(s).replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e] ?? m;
});
const textOf = (html) => decode(String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')).replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
function inputs(html) {
  return [...String(html).matchAll(/<input\b([^>]*)>/gi)].map(([, attrs]) => {
    const a = {};
    for (const [, k, v1, v2, v3] of attrs.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) a[k.toLowerCase()] = decode(v1 ?? v2 ?? v3 ?? '');
    return a;
  });
}
const money = (s) => { const n = Number(String(s).replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : null; };

// ---------- reading ----------
// Recharge pages linked from the home page: [{ pageId, title }] e.g. { pageId: '16666331', title: 'شحن سيلكوم' }.
function parseCompanies(html) {
  const out = [];
  for (const [, pageId, title] of html.matchAll(/israel_c\.php\?id=(\d+)['"][\s\S]{0,800}?alt="([^"]*)"/g)) {
    if (!out.some((c) => c.pageId === pageId)) out.push({ pageId, title: decode(title).trim() });
  }
  return out;
}

// Cards on a company's recharge page. Each card's dialog holds hidden inputs i_name_<id>, i_price_<id> (agent price).
function parseCards(html) {
  const byId = new Map();
  for (const a of inputs(html)) {
    const m = /^i_(name|price|comp|cust_price)_(\d+)$/.exec(a.id || '');
    if (!m) continue;
    const c = byId.get(m[2]) || { cardId: m[2] };
    c[m[1]] = a.value ?? '';
    byId.set(m[2], c);
  }
  return [...byId.values()].filter((c) => c.name && money(c.price) !== null).map((c) => {
    const start = html.indexOf(`ISModal_${c.cardId}`);
    const next = start < 0 ? -1 : html.indexOf('ISModal_', start + 10);
    const block = textOf(start < 0 ? '' : html.slice(start, next < 0 ? undefined : next));
    const desc = (block.split('وصف الكرت')[1] || '').split('رقم الجوال')[0].replace(/\s+/g, ' ').trim();
    return { cardId: c.cardId, name: c.name.trim(), agentPrice: money(c.price), pageId: c.comp || '', description: desc.slice(0, 300) };
  });
}

function parseBalance(html) {
  const m = /([\d.,]+)\s*₪\s*رصيدك/.exec(textOf(html));
  return m ? money(m[1]) : null;
}

// Rows of the operations table: # | type | details | number | cost | date | status | reply.
function parseOperations(html) {
  const body = (/<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(html) || [])[1] ?? html;
  const rows = [];
  for (const [, tr] of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(([, td]) => textOf(td).replace(/\s+/g, ' ').trim());
    if (cells.length < 7) continue;
    const id = Number(String(cells[0]).replace(/\D/g, ''));
    if (!id) continue;
    rows.push({ id, type: cells[1], details: cells[2], number: String(cells[3]).replace(/\D/g, ''), cost: money(cells[4]),
      date: cells[5], status: cells[6], reply: cells[7] || '' });
  }
  return rows;
}

// What an operation's status means. Failure words win over success words ("تم الرفض"); "تم تقديم" is still waiting.
function outcome(status) {
  const s = String(status);
  if (/رفض|مرفوض|فشل|ملغ|الغاء|إلغاء|خطأ|reject|fail|cancel|error/i.test(s)) return 'failed';
  if (/قيد|انتظار|معالجة|تقديم|جاري|pending|process|wait/i.test(s)) return 'pending';
  if (/تم|نجح|ناجح|مكتمل|منفذ|مقبول|success|done|complete/i.test(s)) return 'done';
  return 'pending';
}

async function companies(creds) { return parseCompanies(await page(creds, '/Portal/index.php')); }
async function cards(creds) {
  const list = await companies(creds);
  if (!list.length) throw new ArtError('art-topup: لم أجد صفحات الشحن. ربما تغيّر تصميم الموقع.');
  const out = [];
  for (const c of list) {
    for (const card of parseCards(await page(creds, `/Portal/israel_c.php?id=${c.pageId}`))) out.push({ ...card, company: c.title });
  }
  return out;
}
async function balance(creds) { return parseBalance(await page(creds, '/Portal/index.php')); }
async function operations(creds) { return parseOperations(await page(creds, '/Portal/processes.php')); }

// Sends one recharge. The portal answers before carrying it out; the result appears in operations().
async function recharge(creds, { cardId, number, price }) {
  if (session.key !== `${creds.user}\n${creds.pass}`) await login(creds);
  const qs = `makeIR&id=${encodeURIComponent(cardId)}&no=${encodeURIComponent(number)}&price=${encodeURIComponent(price)}&cust_price=${encodeURIComponent(price)}`;
  const r = await request('POST', `/controllers/agents_tk_db.php?${qs}`);
  if (signedOut(r)) throw new ArtError('art-topup: انتهت الجلسة قبل الإرسال');
  if (r.status >= 400) throw new ArtError(`art-topup: رُفض الطلب (${r.status})`);
  return textOf(r.text).slice(0, 300);
}

// Phone numbers in the portal's 10-digit local form (05XXXXXXXX).
function localNumber(n) {
  let d = String(n).replace(/\D/g, '');
  if (d.startsWith('972')) d = `0${d.slice(3)}`;
  return /^0\d{9}$/.test(d) ? d : null;
}

module.exports = {
  ArtError, login, cards, balance, operations, recharge, localNumber, outcome,
  parseCompanies, parseCards, parseBalance, parseOperations,
};
