// Customer shop: pick a package, transfer with JawwalPay, report the transfer, follow the order.
import {
  esc, icon, fmtMoney, fmtNum, fmtDateTime, fmtDate, specs, companyLogo, fileToDataUrl, copyText, toast, supportHref, fmtPhone,
} from './core.js';

const root = document.getElementById('shop');
const S = { shop: null, company: 0, poll: null };

// ---------- API ----------
async function call(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error('لا يوجد اتصال بالإنترنت. حاول مرة أخرى.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'تعذّر الاتصال بالخادم');
  return data;
}

// Orders made on this device, newest first.
const MINE = 'shop-orders';
function myOrders() { try { return JSON.parse(localStorage.getItem(MINE) || '[]'); } catch { return []; } }
function remember(code) {
  try { localStorage.setItem(MINE, JSON.stringify([code, ...myOrders().filter((c) => c !== code)].slice(0, 20))); } catch { /* storage blocked */ }
}

// ---------- layout ----------
function shell(content) {
  const s = S.shop;
  const wa = supportHref(s?.supportWhatsapp);
  return `
    <header class="shop-top"><a class="shop-brand" href="#/"><span class="brand-mark">${icon('logo')}</span><b>${esc(s?.appName || 'المتجر')}</b></a>
      <nav class="shop-nav">${myOrders().length ? `<a class="btn btn-ghost btn-sm" href="#/orders">${icon('list')}طلباتي</a>` : ''}
        ${wa ? `<a class="btn btn-ghost btn-sm" href="${esc(wa)}" target="_blank" rel="noopener">${icon('whatsapp')}الدعم</a>` : ''}</nav></header>
    <main class="shop-main">${content}</main>`;
}

const paint = (content) => { root.innerHTML = shell(content); window.scrollTo(0, 0); };

function errorBox(message, retry = true) {
  return `<div class="empty"><span class="tile red">${icon('alert')}</span><b>تعذّر التحميل</b><span>${esc(message)}</span>
    ${retry ? `<button class="btn btn-soft" data-act="reload">${icon('refresh')}حاول مرة أخرى</button>` : ''}</div>`;
}

// ---------- catalog ----------
function pkgCard(p) {
  return `<button class="pkg-card" data-act="pick" data-id="${p.id}">
    <div class="pkg-head"><span class="pkg-name">${esc(p.companyName)} · ${esc(p.name)}</span></div>
    ${p.dataGb ? `<div class="pkg-data"><b>${fmtNum(p.dataGb)}</b><span>GB</span></div>` : ''}
    ${specs(p) ? `<div class="pkg-specs">${specs(p)}</div>` : ''}
    ${p.description ? `<p class="small muted">${esc(p.description)}</p>` : ''}
    <div class="pkg-price"><small>للشهر</small><b>${fmtMoney(p.price)}</b></div></button>`;
}

function catalogPage() {
  const s = S.shop;
  if (!s.enabled) return paint(`<div class="empty"><span class="tile amber">${icon('clock')}</span><b>المتجر مغلق حالياً</b><span>عد لاحقاً أو تواصل مع الدعم.</span></div>`);
  const list = S.company ? s.packages.filter((p) => p.companyId === S.company) : s.packages;
  paint(`
    <section class="shop-hero"><h1>اشحن رقمك بسهولة</h1><p>اختر الباقة، حوّل المبلغ عبر <b>جوال باي</b>، وأرسل بيانات التحويل. نتحقق من الدفع ونفعّل الباقة.</p></section>
    ${s.companies.length > 1 ? `<div class="chips">${[{ id: 0, name: 'الكل' }, ...s.companies].map((c) => `<button class="chip" data-act="company" data-id="${c.id}" aria-pressed="${S.company === c.id}">${esc(c.name)}</button>`).join('')}</div>` : ''}
    ${list.length ? `<div class="pkg-grid">${list.map(pkgCard).join('')}</div>`
      : `<div class="empty"><span class="tile">${icon('box')}</span><b>لا توجد باقات حالياً</b></div>`}`);
}

// ---------- order form ----------
function orderForm(p) {
  const co = S.shop.companies.find((c) => c.id === p.companyId);
  paint(`
    <a class="btn btn-ghost btn-sm" href="#/">${icon('arrowR')}كل الباقات</a>
    <form class="card card-pad shop-form" id="order-form" novalidate>
      <div class="item-top">${companyLogo(co, 'sm')}<div class="grow"><b class="item-title">${esc(p.companyName)} · ${esc(p.name)}</b>
        <div class="item-sub"><span>شهر واحد</span></div></div><b class="ltr shop-amount">${fmtMoney(p.price)}</b></div>
      <div class="segmented" id="kind"><button type="button" data-kind="recharge" aria-pressed="true">شحن رقم موجود</button>
        <button type="button" data-kind="new" aria-pressed="false">خط جديد بشريحة</button></div>
      <div class="field"><label for="f-number">رقم الهاتف المراد شحنه</label>
        <input class="input ltr big" id="f-number" name="number" type="tel" inputmode="tel" autocomplete="tel" placeholder="05X XXX XXXX" required></div>
      <div class="field" id="sim-field" hidden><label for="f-sim">رقم الشريحة (ICCID)</label>
        <input class="input ltr" id="f-sim" name="sim" inputmode="numeric" placeholder="8997…"><span class="hint">مطبوع على الشريحة، من 18 إلى 22 رقماً.</span></div>
      <div class="field"><label for="f-name">الاسم <span class="opt">(اختياري)</span></label><input class="input" id="f-name" name="customerName" autocomplete="name"></div>
      <div class="field"><label for="f-contact">رقم للتواصل <span class="opt">(إن كان غير الرقم أعلاه)</span></label>
        <input class="input ltr" id="f-contact" name="contactPhone" type="tel" inputmode="tel"></div>
      <div class="msg" id="form-err" hidden></div>
      <button class="btn btn-primary btn-lg btn-block" type="submit">${icon('arrowL')}متابعة للدفع</button>
    </form>`);
  const form = document.getElementById('order-form');
  let kind = 'recharge';
  form.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.kind;
    form.querySelectorAll('[data-kind]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    document.getElementById('sim-field').hidden = kind !== 'new';
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('form-err');
    const btn = form.querySelector('[type=submit]');
    const v = (n) => form.elements[n].value.trim();
    err.hidden = true;
    btn.disabled = true;
    try {
      const o = await call('POST', '/api/shop/orders', { packageId: p.id, kind, number: v('number'), sim: v('sim'), customerName: v('customerName'), contactPhone: v('contactPhone') });
      remember(o.code);
      location.hash = `#/order/${o.code}`;
    } catch (ex) {
      err.innerHTML = `${icon('alert')}<span>${esc(ex.message)}</span>`;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

// ---------- order status ----------
const STAGES = {
  awaiting_payment: ['wallet', 'amber', 'بانتظار التحويل', 'حوّل المبلغ ثم أرسل بيانات التحويل أدناه.'],
  verifying: ['clock', '', 'نتحقق من التحويل', 'نبحث عن إشعار جوال باي المطابق. عادةً خلال دقائق — اترك الصفحة مفتوحة أو عد إليها لاحقاً.'],
  review: ['shield', 'violet', 'قيد المراجعة', 'لم نجد الإشعار تلقائياً، فيراجع فريقنا التحويل يدوياً. يمكنك إضافة صورة الإشعار لتسريع المراجعة.'],
  processing: ['clock', 'cyan', 'تم استلام الدفع — قيد التفعيل', 'وصلنا المبلغ ونفّذ الطلب الآن.'],
  paid_issue: ['clock', 'cyan', 'تم استلام الدفع — قيد المعالجة', 'وصلنا المبلغ. يراجع فريقنا الطلب ويتواصل معك إن لزم.'],
  done: ['checkCircle', 'green', 'تم التفعيل', 'الباقة مفعّلة على رقمك.'],
  failed: ['alert', 'red', 'تعذّر التنفيذ', 'تواصل مع الدعم لاسترجاع المبلغ أو إعادة المحاولة.'],
  rejected: ['x', 'red', 'مرفوض', ''],
  cancelled: ['x', '', 'أُلغي الطلب', ''],
};
const PAYABLE = ['awaiting_payment', 'verifying', 'review'];

function stepper(stage) {
  const at = { awaiting_payment: 0, verifying: 1, review: 1, processing: 2, paid_issue: 2, done: 3 }[stage] ?? -1;
  const steps = ['الطلب', 'التحقق من الدفع', 'التفعيل', 'تم'];
  return `<div class="shop-steps">${steps.map((s, i) => `<span class="${i < at ? 'done' : i === at ? 'current' : ''}"><i>${i < at || at === 3 ? icon('check') : i + 1}</i>${s}</span>`).join('')}</div>`;
}

function payBox(o) {
  const jp = S.shop.jawwalpay;
  return `<section class="card card-pad shop-pay">
    <h2>${icon('wallet')}حوّل عبر جوال باي</h2>
    <div class="shop-kv"><span>المبلغ</span><b class="ltr">${fmtMoney(o.amount)}</b><button class="btn btn-sm" data-act="copy" data-v="${o.amount}">${icon('copy')}نسخ</button></div>
    ${jp.number ? `<div class="shop-kv"><span>إلى المحفظة</span><b class="ltr">${esc(fmtPhone(jp.number))}</b><button class="btn btn-sm" data-act="copy" data-v="${esc(jp.number)}">${icon('copy')}نسخ</button></div>` : ''}
    ${jp.name ? `<div class="shop-kv"><span>باسم</span><b>${esc(jp.name)}</b></div>` : ''}
    <div class="shop-kv"><span>رقم الطلب</span><b class="ltr">${esc(o.code)}</b><button class="btn btn-sm" data-act="copy" data-v="${esc(o.code)}">${icon('copy')}نسخ</button></div>
    <p class="small muted">حوّل المبلغ نفسه بالضبط حتى نتعرّف على تحويلك تلقائياً.</p>
  </section>
  <form class="card card-pad shop-form" id="proof-form" novalidate>
    <h2>${icon('send')}${o.proofSent ? 'تحديث بيانات التحويل' : 'بعد التحويل: أرسل بيانات التحويل'}</h2>
    <p class="small muted">يكفي واحد منها، وكلما زادت كان التحقق أسرع.</p>
    <div class="field"><label for="p-ref">الرقم المرجعي للتحويل</label><input class="input ltr" id="p-ref" name="payReference" autocomplete="off"></div>
    <div class="row2"><div class="field"><label for="p-phone">رقم المحوِّل</label><input class="input ltr" id="p-phone" name="payPhone" type="tel" inputmode="tel"></div>
      <div class="field"><label for="p-name">اسم المحوِّل</label><input class="input" id="p-name" name="payName"></div></div>
    <div class="field"><label for="p-file">صورة إشعار التحويل <span class="opt">(اختياري)</span></label>
      <input class="input" id="p-file" name="receipt" type="file" accept="image/*"></div>
    <div class="msg" id="proof-err" hidden></div>
    <button class="btn btn-primary btn-lg btn-block" type="submit">${icon('check')}تحقق من التحويل</button>
  </form>`;
}

function orderPage(o) {
  const [ic, color, title, text] = STAGES[o.stage] || STAGES.verifying;
  const payable = PAYABLE.includes(o.status);
  paint(`
    ${stepper(o.stage)}
    <section class="card card-pad shop-status">
      <div class="item-top"><span class="tile ${color} ${o.stage === 'verifying' ? 'pulse' : ''}">${icon(ic)}</span>
        <div class="grow"><b class="item-title">${title}</b><div class="item-sub"><span>طلب <span class="ltr">${esc(o.code)}</span></span><span>${fmtDateTime(o.createdAt)}</span></div></div></div>
      ${text ? `<p class="small" style="color:var(--ink-2)">${text}</p>` : ''}
      ${o.response ? `<div class="msg">${icon('info')}<span>${esc(o.response)}</span></div>` : ''}
      <div class="shop-kv"><span>الباقة</span><b>${esc(o.packageLabel)}</b></div>
      <div class="shop-kv"><span>الرقم</span><b class="ltr">${esc(fmtPhone(o.number))}</b></div>
      <div class="shop-kv"><span>المبلغ</span><b class="ltr">${fmtMoney(o.amount)}</b></div>
      ${o.expiresAt ? `<div class="shop-kv"><span>سارية حتى</span><b>${fmtDate(o.expiresAt)}</b></div>` : ''}
      ${o.status === 'awaiting_payment' ? `<button class="btn btn-ghost btn-sm" data-act="cancel" data-code="${esc(o.code)}">إلغاء الطلب</button>` : ''}
    </section>
    ${payable ? payBox(o) : ''}
    ${['done', 'cancelled', 'rejected', 'failed'].includes(o.stage) ? `<a class="btn btn-soft btn-block" href="#/">${icon('plus')}طلب جديد</a>` : ''}`);
  if (payable) bindProof(o);
  // Follow the order until it is finished.
  clearTimeout(S.poll);
  if (!['done', 'cancelled', 'rejected', 'failed'].includes(o.stage) && (o.proofSent || o.status !== 'awaiting_payment')) {
    S.poll = setTimeout(() => refreshOrder(o.code), 8000);
  }
}

async function refreshOrder(code) {
  if (location.hash !== `#/order/${code}` || document.querySelector('#proof-form :focus')) {
    S.poll = setTimeout(() => refreshOrder(code), 8000);
    return;
  }
  try { orderPage(await call('GET', `/api/shop/orders/${code}`)); } catch { S.poll = setTimeout(() => refreshOrder(code), 15000); }
}

function bindProof(o) {
  const form = document.getElementById('proof-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('proof-err');
    const btn = form.querySelector('[type=submit]');
    const v = (n) => form.elements[n].value.trim();
    err.hidden = true;
    btn.disabled = true;
    btn.innerHTML = `${icon('clock')}جارٍ التحقق…`;
    try {
      const file = form.elements.receipt.files[0];
      const receipt = file ? await fileToDataUrl(file, { max: 1400 }) : '';
      const r = await call('POST', `/api/shop/orders/${o.code}/proof`, { payReference: v('payReference'), payPhone: v('payPhone'), payName: v('payName'), receipt });
      toast(r.status === 'paid' ? 'تم التحقق من الدفع' : 'تم استلام بيانات التحويل');
      orderPage(r);
    } catch (ex) {
      err.innerHTML = `${icon('alert')}<span>${esc(ex.message)}</span>`;
      err.hidden = false;
      btn.disabled = false;
      btn.innerHTML = `${icon('check')}تحقق من التحويل`;
    }
  });
}

async function ordersPage() {
  const codes = myOrders();
  paint(`<h2 class="dot-title">طلباتي</h2><div class="list" id="my-list">${codes.map(() => '<div class="skel" style="height:76px"></div>').join('')}</div>`);
  const rows = await Promise.all(codes.map((c) => call('GET', `/api/shop/orders/${c}`).catch(() => null)));
  const box = document.getElementById('my-list');
  if (!box) return;
  const list = rows.filter(Boolean);
  box.innerHTML = list.length ? list.map((o) => {
    const [ic, color, title] = STAGES[o.stage] || STAGES.verifying;
    return `<a class="item" href="#/order/${esc(o.code)}"><div class="item-top"><span class="tile sm ${color}">${icon(ic)}</span>
      <div class="grow"><b class="item-title">${esc(o.packageLabel)}</b><div class="item-sub"><span class="ltr">${esc(fmtPhone(o.number))}</span><span>${fmtDate(o.createdAt)}</span></div></div>
      <span class="pill">${title}</span></div></a>`;
  }).join('') : `<div class="empty"><span class="tile">${icon('list')}</span><b>لا توجد طلبات</b></div>`;
}

// ---------- routing ----------
async function route() {
  clearTimeout(S.poll);
  const [, page, arg] = location.hash.replace(/^#/, '').split('/');
  try {
    if (!S.shop) S.shop = await call('GET', '/api/shop');
    document.title = S.shop.appName ? `متجر ${S.shop.appName}` : 'متجر الباقات';
    if (page === 'order' && arg) return orderPage(await call('GET', `/api/shop/orders/${encodeURIComponent(arg)}`));
    if (page === 'orders') return ordersPage();
    if (page === 'buy' && arg) {
      const p = S.shop.packages.find((x) => x.id === Number(arg));
      if (p) return orderForm(p);
    }
    return catalogPage();
  } catch (e) {
    paint(errorBox(e.message));
  }
}

root.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'pick') location.hash = `#/buy/${a.dataset.id}`;
  else if (act === 'company') { S.company = Number(a.dataset.id); catalogPage(); }
  else if (act === 'copy') copyText(a.dataset.v);
  else if (act === 'reload') { S.shop = null; route(); }
  else if (act === 'cancel') {
    if (!confirm('إلغاء هذا الطلب؟')) return;
    try { orderPage(await call('POST', `/api/shop/orders/${a.dataset.code}/cancel`)); } catch (ex) { toast(ex.message, { error: true }); }
  }
});
window.addEventListener('hashchange', route);
route();
