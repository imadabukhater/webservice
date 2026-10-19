// Customer shop (eSIM): pick a package and one of its free numbers, transfer with JawwalPay, confirm with the
// transaction number (or the sender's name), and get the QR code to install the eSIM — here and by e-mail.
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
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
const period = (p) => (p.days && p.days !== 30 ? `${fmtNum(p.days)} يوماً` : 'للشهر');

function errorBox(message, retry = true) {
  return `<div class="empty"><span class="tile red">${icon('alert')}</span><b>تعذّر التحميل</b><span>${esc(message)}</span>
    ${retry ? `<button class="btn btn-soft" data-act="reload">${icon('refresh')}حاول مرة أخرى</button>` : ''}</div>`;
}

// ---------- catalog: eSIM packages only, for now ----------
const esimPackages = () => S.shop.packages.filter((p) => p.esim);

function pkgCard(p) {
  return `<button class="pkg-card" data-act="pick" data-id="${p.id}">
    <div class="pkg-head"><span class="pkg-name">${esc(p.companyName)} · ${esc(p.name)}</span><span class="pill">eSIM</span></div>
    ${p.dataGb ? `<div class="pkg-data"><b>${fmtNum(p.dataGb)}</b><span>GB</span></div>` : ''}
    ${specs(p) ? `<div class="pkg-specs">${specs(p)}</div>` : ''}
    ${p.description ? `<p class="small muted">${esc(p.description)}</p>` : ''}
    <div class="pkg-price"><small>${period(p)}</small><b>${fmtMoney(p.price)}</b></div></button>`;
}

function catalogPage() {
  const s = S.shop;
  if (!s.enabled) return paint(`<div class="empty"><span class="tile amber">${icon('clock')}</span><b>المتجر مغلق حالياً</b><span>عد لاحقاً أو تواصل مع الدعم.</span></div>`);
  const all = esimPackages();
  const companies = s.companies.filter((c) => all.some((p) => p.companyId === c.id));
  const list = S.company ? all.filter((p) => p.companyId === S.company) : all;
  paint(`
    <section class="shop-hero"><h1>خط eSIM فوري، بدون شريحة</h1>
      <p>اختر الباقة ورقمك الجديد، حوّل المبلغ عبر <b>جوال باي</b>، ويصلك رمز QR لتثبيت الخط على هاتفك خلال دقائق.</p></section>
    ${companies.length > 1 ? `<div class="chips">${[{ id: 0, name: 'الكل' }, ...companies].map((c) => `<button class="chip" data-act="company" data-id="${c.id}" aria-pressed="${S.company === c.id}">${esc(c.name)}</button>`).join('')}</div>` : ''}
    ${list.length ? `<div class="pkg-grid">${list.map(pkgCard).join('')}</div>`
      : `<div class="empty"><span class="tile">${icon('box')}</span><b>لا توجد باقات eSIM حالياً</b><span>عد لاحقاً أو تواصل مع الدعم.</span></div>`}
    <p class="small muted" style="text-align:center">تأكد أن هاتفك يدعم eSIM قبل الشراء (أغلب أجهزة آيفون من XS فما فوق، وأجهزة أندرويد الحديثة).</p>`);
}

// ---------- the package, its free numbers, and the customer's details ----------
async function esimForm(p) {
  const co = S.shop.companies.find((c) => c.id === p.companyId);
  const st = { numbers: [], shown: [], picked: 0, loading: true, error: '' };
  const head = `<a class="btn btn-ghost btn-sm" href="#/">${icon('arrowR')}كل الباقات</a>`;
  const numbersHtml = () => {
    if (st.loading) return '<div class="num-grid">' + '<div class="skel" style="height:48px"></div>'.repeat(4) + '</div>';
    if (st.error) return `<div class="msg">${icon('alert')}<span>${esc(st.error)}</span></div><button type="button" class="btn btn-soft btn-sm" data-act="more">${icon('refresh')}حاول مرة أخرى</button>`;
    if (!st.numbers.length) return `<div class="empty"><span class="tile">${icon('phone')}</span><b>لا توجد أرقام eSIM متاحة لهذه الباقة الآن</b><span>جرّب باقة أخرى أو عد لاحقاً.</span></div>`;
    return `<div class="num-grid">${st.numbers.map((n) => `<button type="button" class="num-btn" data-num="${n.id}" aria-pressed="${st.picked === n.id}">${esc(fmtPhone(n.phone))}</button>`).join('')}</div>
      <button type="button" class="btn btn-ghost btn-sm" data-act="more">${icon('refresh')}أرقام أخرى</button>`;
  };
  paint(`${head}
    <form class="card card-pad shop-form" id="order-form" novalidate>
      <div class="item-top">${companyLogo(co, 'sm')}<div class="grow"><b class="item-title">${esc(p.companyName)} · ${esc(p.name)}</b>
        <div class="item-sub"><span>eSIM</span><span>${period(p)}</span></div></div><b class="ltr shop-amount">${fmtMoney(p.price)}</b></div>
      <div class="field"><span class="label">اختر رقمك الجديد</span><div id="numbers">${numbersHtml()}</div></div>
      <div class="field"><label for="f-name">الاسم الكامل</label><input class="input" id="f-name" name="customerName" autocomplete="name" required>
        <span class="hint">مطلوب لتسجيل الخط باسمك.</span></div>
      <div class="field"><label for="f-email">البريد الإلكتروني <span class="opt">(مستحسن)</span></label>
        <input class="input ltr" id="f-email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com">
        <span class="hint">نرسل لك عليه رمز QR لتثبيت الـ eSIM، لتحتفظ به.</span></div>
      <div class="field"><label for="f-contact">رقم للتواصل <span class="opt">(اختياري)</span></label>
        <input class="input ltr" id="f-contact" name="contactPhone" type="tel" inputmode="tel" placeholder="05X XXX XXXX"></div>
      <div class="msg" id="form-err" hidden></div>
      <button class="btn btn-primary btn-lg btn-block" type="submit" disabled>${icon('arrowL')}متابعة للدفع</button>
    </form>`);
  const form = document.getElementById('order-form');
  const submit = form.querySelector('[type=submit]');
  const redraw = () => { document.getElementById('numbers').innerHTML = numbersHtml(); submit.disabled = !st.picked; };
  const load = async (more) => {
    st.loading = true;
    st.error = '';
    redraw();
    try {
      const exclude = more ? st.shown.join(',') : '';
      const list = await call('GET', `/api/shop/numbers?packageId=${p.id}${exclude ? `&exclude=${exclude}` : ''}`);
      // "More numbers" brings a new batch; when there is none, the ones shown stay.
      if (!more || list.length) st.numbers = list;
      st.shown.push(...list.map((n) => n.id));
      if (!st.numbers.some((n) => n.id === st.picked)) st.picked = 0;
      if (more && !list.length) toast('لا توجد أرقام أخرى الآن');
    } catch (ex) {
      st.error = ex.message;
    }
    st.loading = false;
    redraw();
  };
  form.addEventListener('click', (e) => {
    const n = e.target.closest('[data-num]');
    if (n) { st.picked = Number(n.dataset.num); redraw(); return; }
    if (e.target.closest('[data-act="more"]')) { e.stopPropagation(); load(st.numbers.length > 0 && !st.error); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('form-err');
    const v = (n) => form.elements[n].value.trim();
    err.hidden = true;
    if (!st.picked) return;
    submit.disabled = true;
    try {
      const o = await call('POST', '/api/shop/orders', {
        kind: 'esim', packageId: p.id, numberId: st.picked, customerName: v('customerName'), email: v('email'), contactPhone: v('contactPhone'),
      });
      remember(o.code);
      location.hash = `#/order/${o.code}`;
    } catch (ex) {
      err.innerHTML = `${icon('alert')}<span>${esc(ex.message)}</span>`;
      err.hidden = false;
      submit.disabled = false;
      // Taken meanwhile: show fresh numbers.
      if (/محجوز|لم يعد متاحاً|من القائمة/.test(ex.message)) load(false);
    }
  });
  load(false);
}

// ---------- order status ----------
const STAGES = {
  awaiting_payment: ['wallet', 'amber', 'بانتظار التحويل', 'حوّل المبلغ عبر جوال باي ثم أكّد الشراء أدناه.'],
  verifying: ['clock', '', 'نتحقق من التحويل', 'نبحث عن إشعار جوال باي المطابق. عادةً خلال دقيقة أو اثنتين — اترك الصفحة مفتوحة أو عد إليها لاحقاً.'],
  review: ['shield', 'violet', 'قيد المراجعة', 'لم نجد الإشعار تلقائياً، فيراجع فريقنا التحويل يدوياً. يمكنك إضافة صورة الإشعار لتسريع المراجعة.'],
  processing: ['clock', 'cyan', 'تم استلام الدفع — قيد التفعيل', 'وصلنا المبلغ ونفعّل خطك الآن، عادةً خلال دقائق. سيظهر رمز QR هنا.'],
  paid_issue: ['clock', 'cyan', 'تم استلام الدفع — قيد المعالجة', 'وصلنا المبلغ. يراجع فريقنا الطلب ويتواصل معك إن لزم.'],
  done: ['checkCircle', 'green', 'تم التفعيل', 'خطك فعّال. امسح رمز QR أدناه لتثبيت الـ eSIM على هاتفك.'],
  failed: ['alert', 'red', 'تعذّر التنفيذ', 'تواصل مع الدعم لاسترجاع المبلغ أو إعادة المحاولة.'],
  rejected: ['x', 'red', 'مرفوض', ''],
  cancelled: ['x', '', 'أُلغي الطلب', ''],
};
const PAYABLE = ['awaiting_payment', 'verifying', 'review'];
const FINAL = ['done', 'cancelled', 'rejected', 'failed'];

function stepper(stage) {
  const at = { awaiting_payment: 0, verifying: 1, review: 1, processing: 2, paid_issue: 2, done: 3 }[stage] ?? -1;
  const steps = ['الطلب', 'التحقق من الدفع', 'التفعيل', 'رمز QR'];
  return `<div class="shop-steps">${steps.map((s, i) => `<span class="${i < at ? 'done' : i === at ? 'current' : ''}"><i>${i < at || at === 3 ? icon('check') : i + 1}</i>${s}</span>`).join('')}</div>`;
}

// How to pay, and how the payment is checked: shown before the customer confirms the purchase.
function payBox(o) {
  const jp = S.shop.jawwalpay;
  return `<section class="card card-pad shop-pay">
    <h2>${icon('wallet')}١. حوّل المبلغ عبر جوال باي</h2>
    <div class="shop-kv"><span>المبلغ</span><b class="ltr">${fmtMoney(o.amount)}</b><button class="btn btn-sm" data-act="copy" data-v="${o.amount}">${icon('copy')}نسخ</button></div>
    ${jp.number ? `<div class="shop-kv"><span>إلى المحفظة</span><b class="ltr">${esc(fmtPhone(jp.number))}</b><button class="btn btn-sm" data-act="copy" data-v="${esc(jp.number)}">${icon('copy')}نسخ</button></div>` : ''}
    ${jp.name ? `<div class="shop-kv"><span>باسم</span><b>${esc(jp.name)}</b></div>` : ''}
    <p class="small muted">حوّل المبلغ نفسه بالضبط، بتحويل واحد.${o.reservedUntil ? ` الرقم <b class="ltr">${esc(fmtPhone(o.number))}</b> محجوز لك حتى <b>${fmtTime(o.reservedUntil)}</b>.` : ''}</p>
  </section>
  <form class="card card-pad shop-form" id="proof-form" novalidate>
    <h2>${icon('shield')}٢. ${o.proofSent ? 'تحديث بيانات التحويل' : 'أكّد الشراء'}</h2>
    <div class="shop-verify">
      <b>كيف نتحقق من دفعتك؟</b>
      <ol>
        <li>بعد التحويل تصلك رسالة من جوال باي فيها <b>«رقم الحركة»</b>. انسخه في الخانة الأولى — هذه أسرع طريقة.</li>
        <li>إن لم يكن معك رقم الحركة: اكتب <b>اسمك الكامل كما يظهر في جوال باي</b>.</li>
      </ol>
      <span class="small muted">نطابق بياناتك مع إشعار جوال باي ومع المبلغ نفسه بالضبط، ثم نفعّل الخط تلقائياً.</span>
    </div>
    <div class="field"><label for="p-ref">رقم الحركة</label><input class="input ltr" id="p-ref" name="payReference" inputmode="numeric" autocomplete="off" placeholder="2922…"></div>
    <div class="field"><label for="p-name">أو: اسم المحوِّل كما في جوال باي</label><input class="input" id="p-name" name="payName" autocomplete="name"></div>
    <div class="field"><label for="p-file">صورة إشعار التحويل <span class="opt">(اختياري، تساعد المراجعة)</span></label>
      <input class="input" id="p-file" name="receipt" type="file" accept="image/*"></div>
    <div class="msg" id="proof-err" hidden></div>
    <button class="btn btn-primary btn-lg btn-block" type="submit">${icon('check')}${o.proofSent ? 'تحديث' : 'تأكيد الشراء'}</button>
  </form>`;
}

// The QR code to install the eSIM, once the line is active.
function qrBox(o) {
  if (!o.esimQr || !/^data:image\//.test(o.esimQr)) return '';
  return `<section class="card card-pad shop-qr">
    <h2>${icon('qr')}رمز تثبيت الـ eSIM</h2>
    <img src="${esc(o.esimQr)}" alt="رمز QR لتثبيت eSIM للرقم ${esc(o.number)}">
    <a class="btn btn-primary btn-block" href="${esc(o.esimQr)}" download="esim-${esc(o.number)}.png">${icon('download')}تنزيل الرمز</a>
    <ol>
      <li>آيفون: الإعدادات ← الخلوي ← إضافة eSIM ← استخدام رمز QR.</li>
      <li>أندرويد: الإعدادات ← الاتصالات ← مدير SIM ← إضافة eSIM ← مسح رمز QR.</li>
      <li>تحتاج اتصالاً بالإنترنت (واي فاي) أثناء التثبيت. امسح الرمز على جهاز واحد فقط.</li>
    </ol>
    ${o.qrMailed ? `<p class="small muted">${icon('checkCircle')} أرسلنا الرمز أيضاً إلى <span class="ltr">${esc(o.email)}</span>.</p>`
      : o.email ? `<p class="small muted">سنرسل الرمز أيضاً إلى <span class="ltr">${esc(o.email)}</span> خلال دقائق.</p>` : ''}
  </section>`;
}

function orderPage(o) {
  const [ic, color, title, text] = STAGES[o.stage] || STAGES.verifying;
  const payable = PAYABLE.includes(o.status);
  paint(`
    ${stepper(o.stage)}
    <section class="card card-pad shop-status">
      <div class="item-top"><span class="tile ${color} ${['verifying', 'processing'].includes(o.stage) ? 'pulse' : ''}">${icon(ic)}</span>
        <div class="grow"><b class="item-title">${title}</b><div class="item-sub"><span>طلب <span class="ltr">${esc(o.code)}</span></span><span>${fmtDateTime(o.createdAt)}</span></div></div></div>
      ${text ? `<p class="small" style="color:var(--ink-2)">${text}</p>` : ''}
      ${o.response ? `<div class="msg">${icon('info')}<span>${esc(o.response)}</span></div>` : ''}
      <div class="shop-kv"><span>الباقة</span><b>${esc(o.packageLabel)}${o.esim ? ' · eSIM' : ''}</b></div>
      <div class="shop-kv"><span>${o.esim ? 'رقمك الجديد' : 'الرقم'}</span><b class="ltr">${esc(fmtPhone(o.number))}</b></div>
      <div class="shop-kv"><span>المبلغ</span><b class="ltr">${fmtMoney(o.amount)}</b></div>
      ${o.expiresAt ? `<div class="shop-kv"><span>سارية حتى</span><b>${fmtDate(o.expiresAt)}</b></div>` : ''}
      ${o.status === 'awaiting_payment' ? `<button class="btn btn-ghost btn-sm" data-act="cancel" data-code="${esc(o.code)}">إلغاء الطلب</button>` : ''}
    </section>
    ${qrBox(o)}
    ${payable ? payBox(o) : ''}
    ${FINAL.includes(o.stage) ? `<a class="btn btn-soft btn-block" href="#/">${icon('plus')}طلب جديد</a>` : ''}
    <p class="small muted" style="text-align:center">احفظ رابط هذه الصفحة لتعود إلى طلبك.</p>`);
  if (payable) bindProof(o);
  // Follow the order until it is finished (and its QR code e-mailed).
  clearTimeout(S.poll);
  const waiting = !FINAL.includes(o.stage) || (o.stage === 'done' && o.esim && o.email && !o.qrMailed);
  if (waiting && (o.proofSent || o.status !== 'awaiting_payment')) S.poll = setTimeout(() => refreshOrder(o.code), 8000);
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
    const file = form.elements.receipt.files[0];
    if (!v('payReference') && !v('payName') && !file) {
      err.innerHTML = `${icon('alert')}<span>أدخل رقم الحركة من رسالة جوال باي، أو اسمك الكامل كما يظهر في جوال باي.</span>`;
      err.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.innerHTML = `${icon('clock')}جارٍ التحقق…`;
    try {
      const receipt = file ? await fileToDataUrl(file, { max: 1400 }) : '';
      const r = await call('POST', `/api/shop/orders/${o.code}/proof`, { payReference: v('payReference'), payName: v('payName'), receipt });
      toast(r.status === 'paid' ? 'تم التحقق من الدفع' : 'تم استلام بيانات التحويل');
      orderPage(r);
    } catch (ex) {
      err.innerHTML = `${icon('alert')}<span>${esc(ex.message)}</span>`;
      err.hidden = false;
      btn.disabled = false;
      btn.innerHTML = `${icon('check')}تأكيد الشراء`;
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
      <div class="grow"><b class="item-title">${esc(o.packageLabel)}${o.esim ? ' · eSIM' : ''}</b><div class="item-sub"><span class="ltr">${esc(fmtPhone(o.number))}</span><span>${fmtDate(o.createdAt)}</span></div></div>
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
      const p = esimPackages().find((x) => x.id === Number(arg));
      if (p) return esimForm(p);
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
