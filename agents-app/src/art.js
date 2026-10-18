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
// Recharge pages linked from the home page: [{ kind, page, title }], kind israel (card pages), bundles or cash.
function parseCompanies(html) {
  const out = [];
  const add = (kind, page, title) => { if (!out.some((c) => c.page === page)) out.push({ kind, page, title: decode(title).trim() }); };
  for (const [, page, title] of html.matchAll(/(israel_c\.php\?id=\d+)['"][\s\S]{0,800}?alt="([^"]*)"/g)) add('israel', page, title);
  for (const [, page, title] of html.matchAll(/(pal_chargen\.php\?type=\w+)['"][\s\S]{0,800}?alt="([^"]*)"/g)) add('bundles', page, title);
  for (const [, page, title] of html.matchAll(/(pal_charge\.php\?id=\d+)['"][\s\S]{0,800}?alt="([^"]*)"/g)) add('cash', page, title);
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

// Palestinian bundle pages (pal_chargen.php?type=jawwal_minutes …): openModal('<id>', '<title>', <price>, '<category>').
// Bundles above the account's balance are shown without an id, so they cannot be read until the balance allows them.
function parseBundles(html, type) {
  const items = [];
  for (const [, id, title, price, category] of html.matchAll(/openModal\(\s*'(\d+)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*,\s*([\d.]+)\s*,\s*'([^']*)'\s*\)/g)) {
    items.push({ ref: `pb:${type}:${id}:${category}`, name: decode(title).replace(/\s+/g, ' ').trim(), agentPrice: Number(price), description: '' });
  }
  const hidden = (html.match(/class="pkg-card\s+disabled"/g) || []).length;
  return { items, hidden };
}

// Cash recharge pages (pal_charge.php?id=…): one product id and the amounts on offer.
function parseCash(html) {
  const product = inputs(html).find((a) => a.id === 'product_id')?.value || '';
  const amounts = [...new Set([...html.matchAll(/data-amount="([\d.]+)"/g)].map((m) => Number(m[1])))];
  return product ? amounts.map((a) => ({ ref: `pc:${product}:${a}`, amount: a })) : [];
}

// Invoice (line activation) packages of one company, from packages_tk_db.php?getIPackages2&id=<company>.
// Each has hidden inputs i_name2_<id>, i_cust_price2_<id> (agent price) and a details table (offer, days).
function parseInvoicePackages(html) {
  const byId = new Map();
  for (const a of inputs(html)) {
    const m = /^i_(name2|cust_price2|comp2)_(\d+)$/.exec(a.id || '');
    if (!m) continue;
    const p = byId.get(m[2]) || { id: m[2] };
    p[m[1]] = a.value ?? '';
    byId.set(m[2], p);
  }
  return [...byId.values()].filter((p) => p.name2 && money(p.cust_price2) !== null).map((p) => {
    const start = html.indexOf(`ISModal2_${p.id}`);
    const next = start < 0 ? -1 : html.indexOf('showISModal2(', start);
    const block = textOf(start < 0 ? '' : html.slice(start, next < 0 ? undefined : next));
    const after = (label, stop) => (block.split(label)[1] || '').split(stop)[0].replace(/\s+/g, ' ').trim();
    const days = Number((/(\d+)\s*يوم/.exec(after('عدد الأيام', 'رقم الشريحة')) || [])[1]) || null;
    // Names come HTML-escaped twice (&amp;quot;).
    return { id: p.id, name: decode(p.name2).replace(/\s+/g, ' ').trim(), agentPrice: money(p.cust_price2), companyPage: p.comp2 || '',
      description: decode(after('وصف العرض', 'عدد الأيام')).slice(0, 300), days };
  });
}

// Invoice companies on invoices.php: showIPackages2(<id>, '<api company or empty>', '<name>').
function parseInvoiceCompanies(html) {
  return [...html.matchAll(/showIPackages2\(\s*(\d+)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g)]
    .map(([, id, api, name]) => ({ id, api, name: decode(name).trim() }))
    .filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i);
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

// Invoice packages (activating a new line): invoices.php lists the companies, and each company's packages load by POST.
// ref inv:<api company or empty>:<package id>. In "شركات مشتركة" the package name says which company it is.
async function invoices(creds) {
  const companies = parseInvoiceCompanies(await page(creds, '/Portal/invoices.php'));
  const out = [];
  for (const c of companies) {
    const r = await request('POST', `/controllers/packages_tk_db.php?getIPackages2&id=${encodeURIComponent(c.id)}`);
    if (signedOut(r)) throw new ArtError('art-topup: انتهت الجلسة أثناء قراءة الفواتير');
    for (const p of parseInvoicePackages(r.text)) {
      out.push({ ref: `inv:${c.api}:${p.id}`, kind: 'invoice', company: c.api === 'mixed_shared' ? p.name : c.name, name: p.name,
        agentPrice: p.agentPrice, description: p.description, days: p.days, api: !!c.api });
    }
  }
  return out;
}

// Everything that can be sold: recharge cards (kind 'card') and invoice packages (kind 'invoice'), plus how many
// bundles the portal hid. Card refs say how to buy: ic:<card> (Israeli card), pb:<type>:<id>:<category>
// (Palestinian bundle), pc:<product>:<amount> (cash).
async function catalog(creds) {
  const list = await cards(creds);
  return Object.assign([...list, ...await invoices(creds)], { hidden: list.hidden });
}

async function cards(creds) {
  const list = await companies(creds);
  if (!list.length) throw new ArtError('art-topup: لم أجد صفحات الشحن. ربما تغيّر تصميم الموقع.');
  const out = [];
  let hidden = 0;
  for (const c of list) {
    const html = await page(creds, `/Portal/${c.page}`);
    if (c.kind === 'israel') {
      for (const card of parseCards(html)) out.push({ ...card, ref: `ic:${card.cardId}`, kind: 'card', company: c.title });
    } else if (c.kind === 'bundles') {
      const type = c.page.split('=')[1];
      const r = parseBundles(html, type);
      hidden += r.hidden;
      // The same bundle can be listed on both the minutes and the internet page.
      const key = (ref) => { const [, t, id] = ref.split(':'); return `${t.split('_')[0]}:${id}`; };
      for (const b of r.items) if (!out.some((o) => o.ref.startsWith('pb:') && key(o.ref) === key(b.ref))) out.push({ ...b, kind: 'card', company: c.title });
    } else {
      for (const x of parseCash(html)) {
        out.push({ ref: x.ref, kind: 'card', company: c.title, name: `${c.title} ${x.amount} ₪`, agentPrice: x.amount, description: 'شحن رصيد نقدي' });
      }
    }
  }
  return Object.assign(out, { hidden });
}
async function balance(creds) { return parseBalance(await page(creds, '/Portal/index.php')); }
async function operations(creds) { return parseOperations(await page(creds, '/Portal/processes.php')); }

// Sends one sale. Israeli cards: the portal answers before carrying it out and the result appears in operations()
// ({ async: true }). Palestinian bundles and cash: the answer is final, "success" or "error: …" ({ ok, error }).
async function recharge(creds, { ref, number, price }) {
  if (session.key !== `${creds.user}\n${creds.pass}`) await login(creds);
  const [kind, a, b, c] = String(ref).split(':');
  const enc = encodeURIComponent;
  let r;
  if (kind === 'ic') {
    r = await request('POST', `/controllers/agents_tk_db.php?makeIR&id=${enc(a)}&no=${enc(number)}&price=${enc(price)}&cust_price=${enc(price)}`);
  } else if (kind === 'pb') {
    const company = a.includes('jawwal') ? 'jawwal' : 'ooredoo';
    r = await request('GET', `/controllers/makePC1.php?${new URLSearchParams({ phone: number, product_id: b, company, price: String(price), category: c || '', pkg_type: a })}`);
  } else if (kind === 'pc') {
    r = await request('GET', `/controllers/makePC2.php?no2=${enc(number)}&id2=${enc(a)}&price2=${enc(b)}`);
  } else {
    throw new ArtError('art-topup: نوع غير معروف');
  }
  if (signedOut(r)) throw new ArtError('art-topup: انتهت الجلسة قبل الإرسال');
  if (r.status >= 400) throw new ArtError(`art-topup: رُفض الطلب (${r.status})`);
  const text = textOf(r.text).slice(0, 300);
  if (kind === 'ic') return { async: true, text };
  return { async: false, ok: text.trim() === 'success', error: /error\s*:/i.test(text) ? text.replace(/^.*?error\s*:/i, '').trim() || text : '', text };
}

// Phone numbers in the portal's 10-digit local form (05XXXXXXXX).
function localNumber(n) {
  let d = String(n).replace(/\D/g, '');
  if (d.startsWith('972')) d = `0${d.slice(3)}`;
  return /^0\d{9}$/.test(d) ? d : null;
}

module.exports = {
  ArtError, login, cards, invoices, catalog, balance, operations, recharge, localNumber, outcome,
  parseCompanies, parseCards, parseBundles, parseCash, parseBalance, parseOperations, parseInvoicePackages, parseInvoiceCompanies,
};
