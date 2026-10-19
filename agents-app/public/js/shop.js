// Modern Customer Storefront (/shop)
// Designed from 3 perspectives:
// 1. Designer: Modern Airalo/Apple/Revolut-inspired glassmorphism, visual data meters, RTL/LTR i18n, Dark/Light mode
// 2. Psychiatrist: Anchoring (oldPrice + savings), daily cost framing, "Most Popular" spotlight, frictionless device checker
// 3. Advocate: Transparent itemized QR fees per company, mandatory legal/compatibility consent, 4-tab Legal & Guarantee Center, printable receipt

const S = {
  data: null,
  companyId: null,
  cat: 'all', // 'all' | 'esim' | 'new' | 'recharge' | 'popular'
  q: '',
  pkg: null,
  kind: 'recharge',
  esim: false,
  numbers: [],
  numbersLoading: false,
  numbersMore: false,
  numbersErr: '',
  numberId: null,
  selectedPhone: '',
  order: null,
  receiptData: '',
  pollTimer: null,
  lang: localStorage.getItem('shop-lang') || 'ar',
  theme: localStorage.getItem('shop-theme') || '',
  modal: null, // 'compat' | 'legal' | null
  legalTab: 'terms',
  compatBrand: 'apple',
  compatModel: 'yes',
};

const I18N = {
  ar: {
    dir: 'rtl',
    catalog: 'الباقات',
    esimDirect: '⚡ تفعيل مباشر eSIM',
    checkDevice: 'فحص الجهاز',
    trackOrder: 'تتبّع طلبي',
    legalNav: 'الضمان والشروط',
    liveBadge: 'تفعيل فوري 24/7',
    heroBadge: '✨ الجيل الجديد من الاتصالات الرقمية وتفعيل الـ eSIM الفوري',
    heroTitle: 'فعّل باقتك أو شريحتك الإلكترونية eSIM في ثوانٍ',
    heroSub: 'اختر باقتك المفضلة من جميع الشبكات المعتمدة، استلم رمز QR فوراً بعد التفعيل، واستمتع بشفافية كاملة في الأسعار وضمان استرداد 100% عند تعذّر التنفيذ.',
    searchPh: 'ابحث عن باقة، شركة، حجم الجيجا (مثال: ليان، 50، سيلكوم، eSIM)...',
    trustInstant: 'إظهار كود QR فور التفعيل',
    trustGuarantee: 'ضمان استرداد 100% عند التعذّر',
    trustTransparent: 'أسعار شفافة بدون رسوم خفية',
    catAll: 'جميع الباقات',
    catEsim: '⚡ تفعيل مباشر eSIM',
    catPopular: '★ الأكثر طلباً',
    catNew: '📱 خطوط جديدة',
    catRecharge: '🔄 شحن وتمديد',
    allCompanies: 'كل الشبكات',
    qrFeeTag: 'رسوم QR:',
    qrFree: 'QR مجاني',
    popularRibbon: 'الأكثر طلباً ★',
    saveBadge: 'وفّر',
    perDay: 'باليوم تقريباً',
    perMonth: 'شهرياً',
    daysUnit: 'يوم',
    unlimited: 'لا محدود',
    minutes: 'دقيقة',
    sms: 'رسالة',
    orderNow: 'طلب الباقة',
    instantEsimBtn: '⚡ تفعيل eSIM فوري',
    esimReadyPill: 'يدعم eSIM فوري',
    ownSimPill: 'خط مع رقم جاهز',
    cardPill: 'شحن فوري',
    invoicePill: 'باقة شهرية',
    backToCatalog: 'العودة إلى الباقات',
    priceBreakdownTitle: 'تفصيل السعر الشفاف (بدون أي رسوم خفية)',
    basePkgPrice: 'سعر الباقة الأساسي',
    companyQrFee: 'رسوم إصدار كود QR للشركة',
    totalFinal: 'الإجمالي النهائي الشامل',
    legalCheckText: 'أقرّ بأنني تحققت من توافق جهازي مع تقنية eSIM (في حال طلب شريحة إلكترونية) وأوافق على',
    legalCheckLink: 'شروط البيع، سياسة الـ eSIM الرقمية، وضمان الاسترجاع',
    instantActivateNow: '⚡ إظهار رمز QR وتفعيل الـ eSIM فوراً',
    instantActivating: 'جاري إصدار رمز QR وتفعيل الشريحة...',
    printReceipt: 'طباعة إيصال رسمي',
  },
  en: {
    dir: 'ltr',
    catalog: 'Packages',
    esimDirect: '⚡ Direct eSIM',
    checkDevice: 'Device Check',
    trackOrder: 'Track Order',
    legalNav: 'Legal & Guarantee',
    liveBadge: 'Instant 24/7 Activation',
    heroBadge: '✨ Next-Gen Digital Telecom & Instant eSIM Storefront',
    heroTitle: 'Activate Your Mobile Plan or Instant eSIM in Seconds',
    heroSub: 'Compare top carrier plans, get your scannable eSIM QR code immediately after activation, with 100% transparent pricing and full money-back protection.',
    searchPh: 'Search packages, carriers, or GB size (e.g. Layan, 50, eSIM)...',
    trustInstant: 'Instant QR Code Display',
    trustGuarantee: '100% Refund Guarantee if Failed',
    trustTransparent: 'Transparent Pricing · Zero Hidden Fees',
    catAll: 'All Plans',
    catEsim: '⚡ Direct eSIM',
    catPopular: '★ Most Popular',
    catNew: '📱 New Lines',
    catRecharge: '🔄 Recharge & Renew',
    allCompanies: 'All Carriers',
    qrFeeTag: 'QR Fee:',
    qrFree: 'Free QR',
    popularRibbon: 'Most Popular ★',
    saveBadge: 'Save',
    perDay: '/ day approx.',
    perMonth: '/ month',
    daysUnit: 'days',
    unlimited: 'Unlimited',
    minutes: 'Mins',
    sms: 'SMS',
    orderNow: 'Select Plan',
    instantEsimBtn: '⚡ Instant eSIM',
    esimReadyPill: 'Instant eSIM Ready',
    ownSimPill: 'Ready Number Included',
    cardPill: 'Instant Recharge',
    invoicePill: 'Monthly Plan',
    backToCatalog: 'Back to Plans',
    priceBreakdownTitle: 'Transparent Price Breakdown (No Hidden Fees)',
    basePkgPrice: 'Base Package Price',
    companyQrFee: 'Carrier eSIM QR Code Fee',
    totalFinal: 'Total Final Amount',
    legalCheckText: 'I confirm that my device is eSIM-compatible & unlocked (for eSIM orders) and I agree to the',
    legalCheckLink: 'Terms of Sale, Digital eSIM Policy & Refund Guarantee',
    instantActivateNow: '⚡ Generate & Show eSIM QR Code Immediately',
    instantActivating: 'Generating your eSIM QR Code...',
    printReceipt: 'Print Official Receipt',
  },
  he: {
    dir: 'rtl',
    catalog: 'חבילות',
    esimDirect: '⚡ הפעלת eSIM ישירה',
    checkDevice: 'בדיקת מכשיר',
    trackOrder: 'מעקב הזמנה',
    legalNav: 'אחריות ותנאים',
    liveBadge: 'הפעלה מיידית 24/7',
    heroBadge: '✨ הדור החדש של חבילות סלולר והפעלת eSIM מיידית',
    heroTitle: 'הפעל חבילת סלולר או כרטיס eSIM דיגיטלי תוך שניות',
    heroSub: 'בחרו חבילה מכל החברות המובילות, קבלו קוד QR לסריקה מיידית לאחר ההפעלה, בשקיפות מלאה ואחריות החזר כספי מלא במקרה של תקלה.',
    searchPh: 'חיפוש חבילה, חברה או נפח גלישה (למשל: 50, eSIM)...',
    trustInstant: 'הצגת קוד QR מיידית',
    trustGuarantee: '100% החזר כספי אם ההפעלה נכשלה',
    trustTransparent: 'מחירים שקופים ללא עמלות נסתרות',
    catAll: 'כל החבילות',
    catEsim: '⚡ eSIM מיידי',
    catPopular: '★ הפופולריים ביותר',
    catNew: '📱 קווים חדשים',
    catRecharge: '🔄 טעינה והארכה',
    allCompanies: 'כל החברות',
    qrFeeTag: 'עמלת QR:',
    qrFree: 'QR חינם',
    popularRibbon: 'הנמכר ביותר ★',
    saveBadge: 'חסוך',
    perDay: 'ליום בערך',
    perMonth: 'לחודש',
    daysUnit: 'ימים',
    unlimited: 'ללא הגבלה',
    minutes: 'דקות',
    sms: 'הודעות',
    orderNow: 'הזמן חבילה',
    instantEsimBtn: '⚡ eSIM מיידי',
    esimReadyPill: 'תומך eSIM מיידי',
    ownSimPill: 'כולל מספר מוכן',
    cardPill: 'טעינה מיידית',
    invoicePill: 'חבילה חודשית',
    backToCatalog: 'חזרה לחבילות',
    priceBreakdownTitle: 'פירוט מחיר שקוף (ללא עמלות נסתרות)',
    basePkgPrice: 'מחיר חבילה בסיסי',
    companyQrFee: 'עמלת קוד QR של החברה',
    totalFinal: 'סה"כ לתשלום סופי',
    legalCheckText: 'אני מאשר/ת שבדקתי שהמכשיר תומך ב-eSIM ופתוח לכל הרשתות ושאני מסכים/ה ל-',
    legalCheckLink: 'תנאי המכירה, מדיניות eSIM דיגיטלית ואחריות ההחזר',
    instantActivateNow: '⚡ הצג קוד QR והפעל eSIM כעת',
    instantActivating: 'מפיק קוד QR ומפעיל...',
    printReceipt: 'הדפס קבלה רשמית',
  },
};

const t = (k) => I18N[S.lang]?.[k] || I18N.ar[k] || k;

const ICONS = {
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.2 2"/>',
  alert: '<path d="M12 4l9 16H3L12 4z"/><path d="M12 10v4.5M12 17.2v.1"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M6 15.5H5.5a2 2 0 01-2-2v-8a2 2 0 012-2h8a2 2 0 012 2V6"/>',
  arrowR: '<path d="M9 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="6.8"/><path d="M20 20l-3.8-3.8"/>',
  phone: '<path d="M6.5 4h3l1.5 4-2 1.5a11 11 0 005.5 5.5L16 13l4 1.5v3a2 2 0 01-2 2A15 15 0 014.5 6a2 2 0 012-2z"/>',
  sim: '<path d="M7 3.5h6.5L18.5 8v12.5a1.5 1.5 0 01-1.5 1.5H7a1.5 1.5 0 01-1.5-1.5v-15A1.5 1.5 0 017 3.5z"/><rect x="8.5" y="11" width="7" height="6" rx="1"/>',
  qr: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 18.5h2M18.5 14v2"/>',
  refresh: '<path d="M20 11a8 8 0 00-14.3-4.8M4 4v4.5h4.5M4 13a8 8 0 0014.3 4.8M20 20v-4.5h-4.5"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.8-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.7-7.5-9.5V6L12 3z"/><path d="M8.8 12.2l2.3 2.3 4.3-4.3"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.8-4.3 4.1 1 5.8L12 16.8 6.8 19.5l1-5.8-4.3-4.1 5.9-.8L12 3.5z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  whatsapp: '<path d="M12 3.5a8.5 8.5 0 00-7.3 12.9L3.5 20.5l4.3-1.1A8.5 8.5 0 1012 3.5z"/><path d="M9.4 8.7c-.2-.4-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.4-.3.3-.9.9-.9 2.1s.9 2.5 1 2.7c.1.2 1.8 2.8 4.4 3.8 2.2.9 2.6.7 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2-.1-.1-.2-.2-.5-.3l-1.5-.7c-.2-.1-.4-.1-.6.1-.2.3-.7.8-.8 1-.1.2-.3.2-.5.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.5-1.4-1.8-.1-.3 0-.4.1-.5l.4-.4.2-.4c.1-.1 0-.3 0-.4l-.7-1.6z"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = (n) => `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₪`;
const fmtPhone = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : s || ''; };
const normPhone = (s) => String(s || '').replace(/\D/g, '').replace(/^97[02]/, '0');
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

function applyLangAndTheme() {
  const dir = t('dir');
  document.documentElement.lang = S.lang;
  document.documentElement.dir = dir;
  if (S.theme) document.documentElement.setAttribute('data-theme', S.theme);
  else document.documentElement.removeAttribute('data-theme');
  document.querySelectorAll('.lang-btn').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.lang === S.lang));
  });
  const map = {
    'nav-catalog': 'catalog',
    'nav-esim': 'esimDirect',
    'nav-compat': 'checkDevice',
    'nav-lookup': 'trackOrder',
    'nav-legal': 'legalNav',
    'shop-live-txt': 'liveBadge',
  };
  Object.entries(map).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t(key);
  });
}

function toast(msg, isErr = false) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${isErr ? 'error' : ''}`;
  el.innerHTML = `${icon(isErr ? 'alert' : 'check')}<span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'حدث خطأ، حاول مرة أخرى');
  return data;
}

function logo(c, size = '') {
  if (!c) return '';
  if (c.logo) return `<span class="co-logo ${size} has-img"><img src="${esc(c.logo)}" alt="${esc(c.name)}"></span>`;
  return `<span class="co-logo ${size}" style="--co:${esc(c.color || '#1864ff')}">${esc((c.name || '?').slice(0, 2))}</span>`;
}

function pkgEsimFee(p) {
  if (p?.esimFee !== undefined && p?.esimFee !== null) return Number(p.esimFee) || 0;
  const co = S.data?.companies?.find((c) => c.id === p?.companyId);
  if (co && co.esimFee !== null && co.esimFee !== undefined) return Number(co.esimFee) || 0;
  return Number(S.data?.esimFee) || 0;
}

function canPkgEsim(p) {
  return !!(p?.esim || p?.esimEnabled || p?.lyEsim);
}

// ---------- Available numbers for new line / eSIM ----------
async function loadAvailable(more = false) {
  if (!S.pkg) return;
  S.numbersLoading = true;
  S.numbersErr = '';
  render();
  try {
    const exclude = more ? S.numbers.map((n) => n.id).join(',') : '';
    const r = await api('GET', `/api/shop/available?packageId=${S.pkg.id}&esim=${S.esim ? 1 : 0}${exclude ? `&exclude=${exclude}` : ''}`);
    S.numbers = more ? [...S.numbers, ...(r.numbers || [])] : (r.numbers || []);
    S.numbersMore = !!r.more;
  } catch (e) {
    S.numbersErr = e.message;
  } finally {
    S.numbersLoading = false;
    render();
  }
}

function availablePickerHtml() {
  if (S.numbersLoading && !S.numbers.length) {
    return `<div class="field"><span class="label">اختر رقمك الجديد من الأرقام المتاحة</span><div class="hint">${icon('clock')}<span>جاري جلب الأرقام المتاحة من الشبكة…</span></div></div>`;
  }
  if (S.numbersErr) {
    return `<div class="field"><span class="label">اختر رقمك الجديد</span>
      <div class="msg">${icon('alert')}<span>${esc(S.numbersErr)}</span></div>
      <button type="button" class="btn btn-sm" data-action="num-reload">${icon('refresh')}إعادة المحاولة</button></div>`;
  }
  if (!S.numbers.length) {
    return `<div class="field"><label for="f-num">رقم الهاتف (أو اتركه فارغاً ليتم تخصيص رقم جديد تلقائياً)</label>
      <input class="input ltr big" id="f-num" name="number" inputmode="tel" placeholder="05X-XXX-XXXX (اختياري للخط الجديد)"></div>`;
  }
  return `<div class="field"><span class="label">اختر رقمك المفضّل من الأرقام المتاحة الآن (${S.esim ? 'شريحة eSIM' : 'شريحة جاهزة'})</span>
    <div class="num-grid">${S.numbers.map((n) => `<button type="button" class="num-btn" data-action="pick-num" data-id="${n.id}" data-phone="${esc(n.phone)}" aria-pressed="${n.id === S.numberId}">${esc(fmtPhone(n.phone))}</button>`).join('')}</div>
    ${S.numbersMore ? `<button type="button" class="btn btn-sm btn-ghost" data-action="num-more" ${S.numbersLoading ? 'disabled' : ''}>${icon('refresh')}عرض أرقام إضافية</button>` : ''}
  </div>`;
}

// ---------- Views ----------
function catalogView() {
  const d = S.data;
  if (!d?.enabled) {
    return `<section class="card card-pad empty">
      <div class="tile amber">${icon('clock')}</div>
      <b>المتجر مغلق مؤقتاً للتحديث</b>
      <p>نعمل حالياً على تحديث الباقات والأسعار. يمكنك تتبّع طلب سابق من الأعلى أو التواصل معنا.</p>
    </section>`;
  }

  const allPkgs = d.packages || [];
  const esimCount = allPkgs.filter(canPkgEsim).length;
  const popCount = allPkgs.filter((p) => p.popular).length;

  // Filter packages by category, company, and search query
  const q = S.q.trim().toLowerCase();
  const pkgs = allPkgs.filter((p) => {
    if (S.companyId && p.companyId !== S.companyId) return false;
    if (S.cat === 'esim' && !canPkgEsim(p)) return false;
    if (S.cat === 'popular' && !p.popular) return false;
    if (S.cat === 'new' && p.kind === 'card' && !canPkgEsim(p)) return false;
    if (S.cat === 'recharge' && p.ownSim && !canPkgEsim(p)) return false;
    if (q) {
      const co = d.companies.find((c) => c.id === p.companyId);
      const hay = `${p.name} ${co?.name || ''} ${p.dataGb || ''} ${p.description || ''} ${canPkgEsim(p) ? 'esim شريحة الكترونية' : ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Sort: popular first, then price ascending
  pkgs.sort((a, b) => (Number(!!b.popular) - Number(!!a.popular)) || (a.price - b.price));

  const heroTitle = d.shopTitle || t('heroTitle');
  const heroSub = d.shopSubtitle || t('heroSub');

  return `
    <!-- Modern Hero Banner (Designer + Psychiatrist) -->
    <section class="shop-hero-modern">
      <div class="shop-hero-glow"></div>
      <div class="shop-hero-content">
        <span class="shop-hero-pill">${t('heroBadge')}</span>
        <h1>${esc(heroTitle)}</h1>
        <p>${esc(heroSub)}</p>

        <!-- Zero-friction Search & Quick Tools -->
        <div class="shop-search-bar">
          <span class="shop-search-ic">${icon('search')}</span>
          <input type="search" id="shop-q" value="${esc(S.q)}" placeholder="${esc(t('searchPh'))}" autocomplete="off">
          ${S.q ? `<button type="button" class="icon-btn sm" data-action="clear-q" aria-label="مسح">${icon('x')}</button>` : ''}
        </div>

        <div class="shop-trust-strip">
          <span>${icon('bolt')}${t('trustInstant')}</span>
          <span>${icon('shield')}${t('trustGuarantee')}</span>
          <span>${icon('check')}${t('trustTransparent')}</span>
          <button type="button" class="shop-compat-trigger" data-action="compat-modal">${icon('phone')}هل جهازي يدعم eSIM؟ افحص الآن (*#06#)</button>
        </div>
      </div>
    </section>

    <!-- Category Tabs (Cognitive Ease) -->
    <div class="shop-cat-tabs" role="tablist">
      <button type="button" class="shop-cat-tab" data-action="cat" data-cat="all" aria-selected="${S.cat === 'all'}">${t('catAll')} <small>${allPkgs.length}</small></button>
      ${esimCount ? `<button type="button" class="shop-cat-tab esim-tab" data-action="cat" data-cat="esim" aria-selected="${S.cat === 'esim'}">${t('catEsim')} <small>${esimCount}</small></button>` : ''}
      ${popCount ? `<button type="button" class="shop-cat-tab pop-tab" data-action="cat" data-cat="popular" aria-selected="${S.cat === 'popular'}">${t('catPopular')} <small>${popCount}</small></button>` : ''}
      <button type="button" class="shop-cat-tab" data-action="cat" data-cat="new" aria-selected="${S.cat === 'new'}">${t('catNew')}</button>
      <button type="button" class="shop-cat-tab" data-action="cat" data-cat="recharge" aria-selected="${S.cat === 'recharge'}">${t('catRecharge')}</button>
    </div>

    <!-- Carrier / Company Filter Bar with Transparent QR Fee Tag -->
    ${d.companies.length > 1 ? `<div class="shop-co-strip">
      <button type="button" class="shop-co-pill" data-action="co" data-id="" aria-pressed="${!S.companyId}">
        <b>${t('allCompanies')}</b>
      </button>
      ${d.companies.map((c) => {
        const fee = c.esimFee !== null && c.esimFee !== undefined ? Number(c.esimFee) : Number(d.esimFee || 0);
        return `<button type="button" class="shop-co-pill" data-action="co" data-id="${c.id}" aria-pressed="${S.companyId === c.id}">
          ${logo(c, 'xs')}
          <span class="shop-co-meta">
            <b>${esc(c.name)}</b>
            <small>${fee > 0 ? `${t('qrFeeTag')} ${fmtMoney(fee)}` : t('qrFree')}</small>
          </span>
        </button>`;
      }).join('')}
    </div>` : ''}

    <!-- Direct eSIM Spotlight Banner when in eSIM tab -->
    ${S.cat === 'esim' ? `<div class="shop-esim-banner">
      <div class="tile cyan">${icon('qr')}</div>
      <div class="grow">
        <b>قسم التفعيل المباشر للشريحة الإلكترونية (eSIM) — ليان والشركات المعتمدة</b>
        <p class="small">اختر أي باقة أدناه واضغط «⚡ تفعيل eSIM فوري» لإصدار كود الـ QR الخاص بك مباشرة على الشاشة فور التأكيد، مع بيان واضح لرسوم الكود الخاصة بكل شركة.</p>
      </div>
      <button type="button" class="btn btn-sm btn-soft" data-action="compat-modal">فحص توافق الجهاز</button>
    </div>` : ''}

    <!-- Modern Package Grid -->
    ${pkgs.length ? `<div class="shop-pkg-grid">${pkgs.map((p) => packageCardHtml(p, d)).join('')}</div>`
      : `<section class="card card-pad empty"><b>لا توجد باقات مطابقة للبحث</b><p>جرّب اختيار قسم آخر أو مسح كلمة البحث.</p>
          <button type="button" class="btn btn-primary btn-sm" data-action="reset-filters">إظهار جميع الباقات</button></section>`}
  `;
}

function packageCardHtml(p, d) {
  const c = d.companies.find((x) => x.id === p.companyId);
  const hasEsim = canPkgEsim(p);
  const fee = pkgEsimFee(p);
  const hasDiscount = p.oldPrice && p.oldPrice > p.price;
  const saved = hasDiscount ? round(p.oldPrice - p.price) : 0;
  const days = p.days || 30;
  const dailyCost = round(p.price / days);
  const dataPct = p.dataGb ? Math.min(100, Math.max(15, Math.round((p.dataGb / 200) * 100))) : 100;

  return `<article class="shop-card ${p.popular ? 'is-popular' : ''} ${hasEsim ? 'has-esim' : ''}" style="--co:${esc(c?.color || '#1864ff')}">
    ${p.popular ? `<div class="shop-popular-ribbon">${icon('star')}<span>${t('popularRibbon')}</span></div>` : ''}
    ${hasDiscount ? `<div class="shop-save-badge">${t('saveBadge')} ${fmtMoney(saved)}</div>` : ''}

    <div class="shop-card-top">
      ${logo(c, 'sm')}
      <div class="grow">
        <span class="shop-co-name">${esc(c?.name || '')}</span>
        <h3 class="shop-pkg-title">${esc(p.name)}</h3>
      </div>
    </div>

    <div class="shop-card-badges">
      ${hasEsim ? `<span class="pill s-open">${icon('qr')} ${t('esimReadyPill')}</span>` : ''}
      <span class="pill">${p.ownSim ? t('ownSimPill') : p.kind === 'card' ? t('cardPill') : t('invoicePill')}</span>
      ${p.days ? `<span class="pill">${p.days} ${t('daysUnit')}</span>` : ''}
    </div>

    <div class="shop-data-showcase">
      ${p.dataGb ? `
        <div class="shop-data-main">
          <b class="ltr">${p.dataGb}</b><span>GB</span>
          <small class="shop-daily-frame">~${fmtMoney(dailyCost)} ${t('perDay')}</small>
        </div>
        <div class="shop-data-bar"><span style="width:${dataPct}%"></span></div>
      ` : `<div class="shop-data-main"><b>باقة اتصالات متكاملة</b><small class="shop-daily-frame">~${fmtMoney(dailyCost)} ${t('perDay')}</small></div>`}

      <div class="shop-specs-row">
        ${p.minutes !== null && p.minutes !== undefined ? `<span>📞 ${p.minutes === -1 ? t('unlimited') : p.minutes} ${t('minutes')}</span>` : ''}
        ${p.sms !== null && p.sms !== undefined ? `<span>✉️ ${p.sms === -1 ? t('unlimited') : p.sms} ${t('sms')}</span>` : ''}
        <span>⏱️ ${days} ${t('daysUnit')}</span>
      </div>
    </div>

    ${p.description ? `<p class="shop-pkg-desc">${esc(p.description)}</p>` : ''}

    <div class="shop-price-area">
      <div>
        <small class="muted">${p.days ? `${p.days} ${t('daysUnit')}` : t('perMonth')}</small>
        <div class="shop-price-numbers">
          ${hasDiscount ? `<s class="ltr">${fmtMoney(p.oldPrice)}</s>` : ''}
          <b class="ltr">${fmtMoney(p.price)}</b>
        </div>
      </div>
      ${hasEsim ? `<div class="shop-qr-fee-pill" title="رسوم إصدار كود QR الخاصة بشركة ${esc(c?.name || '')}">
        ${icon('qr')}<span>${fee > 0 ? `+ ${fmtMoney(fee)} كود QR` : t('qrFree')}</span>
      </div>` : ''}
    </div>

    <div class="shop-card-actions">
      ${hasEsim ? `<button type="button" class="btn btn-primary shop-btn-esim" data-action="pick" data-id="${p.id}" data-esim="1">
        ${icon('qr')}<span>${t('instantEsimBtn')}</span>
      </button>` : ''}
      <button type="button" class="btn ${hasEsim ? 'btn-soft' : 'btn-primary'} shop-btn-std" data-action="pick" data-id="${p.id}" data-esim="0">
        <span>${t('orderNow')}</span>
      </button>
    </div>
  </article>`;
}

function orderFormView() {
  const p = S.pkg;
  const c = S.data.companies.find((x) => x.id === p.companyId);
  const hasEsim = canPkgEsim(p);
  const fee = S.esim ? pkgEsimFee(p) : 0;
  const totalAmount = round(p.price + fee);
  const isPool = S.kind === 'new' && (p.pool || p.ownSim || p.lyEsim);

  return `<section class="card card-pad shop-form">
    <div class="item-top">
      ${logo(c)}
      <div class="grow">
        <b class="item-title">${esc(c?.name || '')} — ${esc(p.name)}</b>
        <div class="item-sub">
          ${p.dataGb ? `<span>${p.dataGb} GB</span>` : ''}
          ${p.days ? `<span>${p.days} يوماً</span>` : '<span>شهري</span>'}
          <span class="ltr">${fmtMoney(p.price)}</span>
        </div>
      </div>
      <button type="button" class="btn btn-sm btn-ghost" data-action="home">${t('backToCatalog')}</button>
    </div>

    <!-- Activation Mode Selector -->
    <div class="field">
      <span class="label">اختر طريقة التفعيل</span>
      <div class="shop-mode-cards">
        ${!p.ownSim ? `<button type="button" class="shop-mode-card" data-action="set-mode" data-kind="recharge" data-esim="0" aria-pressed="${S.kind === 'recharge' && !S.esim}">
          ${icon('phone')}
          <b>شحن رقمي الحالي</b>
          <small>تمديد أو شحن خطك القائم</small>
        </button>` : ''}
        ${p.kind !== 'card' ? `<button type="button" class="shop-mode-card" data-action="set-mode" data-kind="new" data-esim="0" aria-pressed="${S.kind === 'new' && !S.esim}">
          ${icon('sim')}
          <b>خط جديد (شريحة)</b>
          <small>${p.ownSim ? 'رقم جاهز مع شريحته' : 'بشريحة بلاستيكية لديك'}</small>
        </button>` : ''}
        ${hasEsim ? `<button type="button" class="shop-mode-card esim-mode" data-action="set-mode" data-kind="new" data-esim="1" aria-pressed="${S.esim}">
          ${icon('qr')}
          <b>⚡ شريحة eSIM فورية</b>
          <small>إظهار رمز QR فوراً بدون شريحة بلاستيكية</small>
        </button>` : ''}
      </div>
    </div>

    ${S.esim ? `<div class="msg info">
      ${icon('qr')}
      <div class="grow">
        <b>تفعيل مباشر للشريحة الإلكترونية (eSIM)</b>
        <p class="small" style="margin:4px 0 0">سيظهر لك رمز الـ QR وكود التفعيل المباشر على الشاشة فور التأكيد لتثبيته بكاميرا هاتفك خلال ثوانٍ.</p>
      </div>
      <button type="button" class="btn btn-sm btn-soft" data-action="compat-modal">فحص جهازي</button>
    </div>` : ''}

    <form id="order-form" class="list" style="gap:14px">
      ${S.esim ? `
        ${isPool ? availablePickerHtml() : `<div class="field">
          <label for="f-num">رقم الهاتف (أو اتركه فارغاً لتخصيص رقم eSIM جديد تلقائياً)</label>
          <input class="input ltr big" id="f-num" name="number" inputmode="tel" placeholder="05X-XXX-XXXX (اختياري)">
        </div>`}
        <div class="row2">
          <div class="field"><label for="f-name">الاسم الكامل <span class="opt">(مطلوب لتوثيق الشريحة)</span></label><input class="input" id="f-name" name="customerName" required></div>
          <div class="field"><label for="f-contact">رقم واتساب / تواصل</label><input class="input ltr" id="f-contact" name="contactPhone" inputmode="tel" placeholder="05X-XXX-XXXX" required></div>
        </div>
        <div class="field"><label for="f-mail">البريد الإلكتروني <span class="opt">(اختياري — لإرسال نسخة احتياطية من رمز QR)</span></label>
          <input class="input ltr" id="f-mail" name="email" type="email" placeholder="name@example.com">
        </div>
      ` : S.kind === 'new' && p.ownSim ? `
        ${availablePickerHtml()}
        <div class="row2">
          <div class="field"><label for="f-name">الاسم <span class="opt">(اختياري)</span></label><input class="input" id="f-name" name="customerName"></div>
          <div class="field"><label for="f-contact">رقم للتواصل</label><input class="input ltr" id="f-contact" name="contactPhone" inputmode="tel" placeholder="05X-XXX-XXXX" required></div>
        </div>
      ` : `
        <div class="field"><label for="f-num">${S.kind === 'new' ? 'رقم الهاتف الجديد' : 'رقم الهاتف المراد شحنه'}</label>
          <input class="input ltr big" id="f-num" name="number" inputmode="tel" placeholder="05X-XXX-XXXX" required></div>
        ${S.kind === 'new' ? `<div class="field"><label for="f-sim">رقم الشريحة البلاستيكية (ICCID — 19 أو 20 رقماً)</label>
          <input class="input ltr mono" id="f-sim" name="sim" inputmode="numeric" placeholder="89972..." required></div>` : ''}
        <div class="row2">
          <div class="field"><label for="f-name">الاسم <span class="opt">(اختياري)</span></label><input class="input" id="f-name" name="customerName"></div>
          <div class="field"><label for="f-contact">رقم آخر للتواصل <span class="opt">(اختياري)</span></label><input class="input ltr" id="f-contact" name="contactPhone" inputmode="tel"></div>
        </div>
      `}

      <!-- Advocate: Transparent Itemized Price Breakdown -->
      <div class="shop-breakdown-box">
        <h4>${icon('shield')}<span>${t('priceBreakdownTitle')}</span></h4>
        <div class="shop-bd-row">
          <span>${t('basePkgPrice')} (${esc(p.name)})</span>
          <b class="ltr">${fmtMoney(p.price)}</b>
        </div>
        ${S.esim ? `<div class="shop-bd-row">
          <span>${t('companyQrFee')} (${esc(c?.name || '')})</span>
          <b class="ltr">${fee > 0 ? `+ ${fmtMoney(fee)}` : t('qrFree')}</b>
        </div>` : ''}
        <div class="shop-bd-total">
          <span>${t('totalFinal')}</span>
          <b class="ltr">${fmtMoney(totalAmount)}</b>
        </div>
        <small class="muted">✓ لا توجد أي رسوم خفية أو التزامات تجديد تلقائية غير معلنة. ضمان استرداد كامل (100%) إذا تعذّر التفعيل تقنياً.</small>
      </div>

      <!-- Advocate: Mandatory Legal & Compatibility Consent -->
      <label class="shop-legal-consent">
        <input type="checkbox" id="f-consent" required checked>
        <span>${t('legalCheckText')} <button type="button" class="link-btn" data-action="legal-modal">${t('legalCheckLink')}</button>.</span>
      </label>

      <div class="btn-row" style="justify-content:space-between">
        <button type="button" class="btn" data-action="home">${t('backToCatalog')}</button>
        <button type="submit" class="btn btn-primary btn-lg">${icon(S.esim ? 'qr' : 'check')}<span>${S.esim ? `متابعة وتفعيل الـ eSIM — ${fmtMoney(totalAmount)}` : `متابعة للدفع — ${fmtMoney(totalAmount)}`}</span></button>
      </div>
    </form>
  </section>`;
}

const STAGE_UI = {
  awaiting_payment: { tone: 'amber', icon: 'clock', title: 'بانتظار الدفع أو التفعيل الفوري', text: 'حَوِّل المبلغ عبر تطبيق جوال باي وأرسل إشعار التحويل، أو استخدم زر التفعيل المباشر لـ eSIM أدناه.' },
  verifying: { tone: 'cyan', icon: 'clock', title: 'جاري التحقق التلقائي من الدفعة…', text: 'نقرأ إشعار جوال باي من البريد تلقائياً ونُفعّل طلبك فور المطابقة دون أي انتظار.' },
  review: { tone: 'amber', icon: 'clock', title: 'بانتظار مراجعة سريعة من الإدارة', text: 'استلمنا بيانات التحويل، وسيتم تأكيدها وتفعيل الباقة خلال دقائق.' },
  processing: { tone: 'cyan', icon: 'clock', title: 'تم تأكيد الدفع — جاري تفعيل الباقة والـ QR…', text: 'تم اعتماد دفعتك بنجاح وجاري الآن إصدار التفعيل من الشركة.' },
  paid_issue: { tone: 'amber', icon: 'alert', title: 'دفعتك مؤكدة — نُكمل التفعيل يدوياً', text: 'دفعتك محفوظة بالكامل؛ واجه التفعيل التلقائي تأخيراً من الشركة ويعمل فريقنا على إتمامه الآن.' },
  done: { tone: 'green', icon: 'check', title: 'تم التفعيل بنجاح! 🎉', text: 'باقتك فعّالة الآن. إذا كانت شريحة eSIM يمكنك مسح رمز الـ QR أدناه مباشرة.' },
  failed: { tone: 'red', icon: 'alert', title: 'تعذّر التفعيل تلقائياً', text: 'تواصل معنا لإعادة المحاولة فوراً أو استرداد كامل المبلغ حسب ضمان المتجر.' },
  rejected: { tone: 'red', icon: 'alert', title: 'لم يكتمل الطلب', text: '' },
};

function orderStatusView() {
  const o = S.order;
  const st = STAGE_UI[o.stage] || STAGE_UI.awaiting_payment;
  const needProof = o.stage === 'awaiting_payment';
  const waiting = ['verifying', 'review', 'processing'].includes(o.stage);
  const canInstantEsim = o.esim && !o.esimQr && S.data?.shopInstant !== false && ['awaiting_payment', 'verifying', 'review', 'processing'].includes(o.stage);

  return `
    <section class="card card-pad shop-status" id="printable-receipt">
      <div class="item-top">
        <span class="tile ${st.tone} ${waiting ? 'pulse' : ''}">${icon(st.icon)}</span>
        <div class="grow">
          <b class="item-title">${st.title}</b>
          <p class="small muted">${esc(o.response || o.error || st.text)}</p>
        </div>
        <span class="pill ltr">${esc(o.code)}</span>
      </div>

      <div class="shop-steps">
        <span class="${needProof ? 'current' : 'done'}"><i>1</i>الطلب والدفع</span>
        <span class="${waiting ? 'current' : o.stage === 'done' ? 'done' : ''}"><i>2</i>التحقق</span>
        <span class="${o.stage === 'done' ? 'done' : ''}"><i>3</i>التفعيل ورمز QR</span>
      </div>

      <div class="kv">
        <div>رقم الطلب الرسمي</div><div><b class="ltr">${esc(o.code)}</b> <button class="btn btn-sm btn-ghost" data-action="copy" data-copy="${esc(o.code)}">${icon('copy')}نسخ</button></div>
        <div>الباقة والشبكة</div><div>${esc(o.companyName ? `${o.companyName} — ${o.packageLabel}` : o.packageLabel)}${o.esim ? ' · <span class="pill s-open">شريحة إلكترونية eSIM</span>' : ''}</div>
        <div>رقم الهاتف</div><div class="ltr">${esc(fmtPhone(o.number) || 'يُخصَّص عند التفعيل')}</div>
        ${o.esim ? `<div>تفصيل السعر</div><div class="ltr">الباقة ${fmtMoney(round(o.amount - (o.esimFee || 0)))} + كود QR ${fmtMoney(o.esimFee || 0)}</div>` : ''}
        <div>المبلغ الإجمالي</div><div><b class="ltr shop-amount">${fmtMoney(o.amount)}</b></div>
      </div>

      <!-- Direct Instant eSIM Activation Button (for immediate QR display) -->
      ${canInstantEsim ? `<div class="shop-instant-box">
        <div class="grow">
          <b>⚡ التفعيل المباشر وإظهار كود QR لـ eSIM</b>
          <p class="small">هل أتممت الدفع أو ترغب بإصدار وإظهار رمز الـ QR للشريحة الإلكترونية فوراً؟ اضغط الزر أدناه ليظهر الكود على الشاشة مباشرة:</p>
        </div>
        <button type="button" class="btn btn-primary btn-lg" data-action="instant-esim" id="btn-instant-esim">
          ${icon('qr')}<span>${t('instantActivateNow')}</span>
        </button>
      </div>` : ''}

      <div class="btn-row no-print" style="justify-content:flex-end">
        <button type="button" class="btn btn-sm btn-ghost" data-action="print-receipt">${icon('shield')}${t('printReceipt')}</button>
      </div>
    </section>

    <!-- Immediate Scannable eSIM QR Code Card -->
    ${o.esimQr ? `<section class="card card-pad shop-qr-modern">
      <div class="shop-qr-badge">${icon('check')}<span>رمز الـ QR جاهز للمسح والتثبيت الفوري!</span></div>
      <h2>${icon('qr')}<span>شريحتك الإلكترونية (eSIM) جاهزة الآن</span></h2>
      <p class="muted">وجّه كاميرا الهاتف إلى رمز الـ QR أدناه أو استخدم كود التفعيل اليدوي إذا كنت تفتح هذه الصفحة من نفس الجهاز:</p>
      <div class="shop-qr-frame">
        <img src="${esc(o.esimQr)}" alt="رمز QR لتثبيت شريحة eSIM">
      </div>
      ${o.esimCode ? `<div class="shop-lpa-box">
        <small class="muted">كود التفعيل اليدوي (LPA / SM-DP+ Address) للتثبيت من نفس الجهاز:</small>
        <div class="shop-lpa-row">
          <code class="ltr">${esc(o.esimCode)}</code>
          <button type="button" class="btn btn-sm btn-soft" data-action="copy" data-copy="${esc(o.esimCode)}">${icon('copy')}نسخ الكود</button>
        </div>
      </div>` : ''}
      <div class="shop-qr-guides">
        <div class="shop-qr-guide-col">
          <b>📱 آيفون (iPhone iOS)</b>
          <ol>
            <li>افتح <b>الإعدادات (Settings)</b> ← <b>خلوي (Cellular)</b>.</li>
            <li>اضغط <b>إضافة شريحة إلكترونية (Add eSIM)</b> ← <b>استخدام رمز QR</b>.</li>
            <li>امسح الرمز أعلاه أو اختر «إدخال التفاصيل يدوياً» والصق الكود.</li>
          </ol>
        </div>
        <div class="shop-qr-guide-col">
          <b>🤖 سامسونج وأندرويد (Android)</b>
          <ol>
            <li>افتح <b>الضبط (Settings)</b> ← <b>الاتصالات (Connections)</b>.</li>
            <li>اختر <b>إدارة SIM (SIM Manager)</b> ← <b>إضافة eSIM</b>.</li>
            <li>امسح رمز QR من الكاميرا أو اختر <b>إدخال كود التفعيل</b>.</li>
          </ol>
        </div>
      </div>
      <div class="btn-row" style="justify-content:center">
        <a class="btn btn-primary" href="${esc(o.esimQr)}" download="esim-${esc(o.code)}.svg">${icon('qr')}تنزيل صورة رمز الـ QR</a>
        <button type="button" class="btn btn-soft" data-action="print-receipt">طباعة الوصل والرمز</button>
      </div>
    </section>` : ''}

    <!-- Jawwal Pay Payment & Verification Box -->
    ${needProof || waiting ? `<section class="card card-pad shop-pay no-print">
      <h2>${icon('shield')}<span>الخطوة 1 — الدفع عبر تطبيق جوال باي (Jawwal Pay)</span></h2>
      <p class="small muted">حَوِّل المبلغ الإجمالي بالضبط إلى المحفظة المعتمدة أدناه:</p>
      <div class="shop-kv"><span>المبلغ المطلوب</span><b class="ltr shop-amount">${fmtMoney(o.amount)}</b>
        <button class="btn btn-sm" data-action="copy" data-copy="${o.amount}">${icon('copy')}نسخ</button></div>
      <div class="shop-kv"><span>رقم محفظة جوال باي</span><b class="ltr">${esc(S.data.jawwalpayNumber || 'تواصل معنا')}</b>
        ${S.data.jawwalpayNumber ? `<button class="btn btn-sm" data-action="copy" data-copy="${esc(S.data.jawwalpayNumber)}">${icon('copy')}نسخ الرقم</button>` : ''}</div>
      ${S.data.jawwalpayName ? `<div class="shop-kv"><span>اسم المستلم</span><b>${esc(S.data.jawwalpayName)}</b></div>` : ''}

      <div class="divider"></div>
      <h2>${icon('check')}<span>الخطوة 2 — إرسال تأكيد التحويل</span></h2>
      <form id="proof-form" class="list" style="gap:12px">
        <div class="row2">
          <div class="field"><label for="p-ref">الرقم المرجعي للعملية <span class="opt">(من رسالة جوال باي)</span></label>
            <input class="input ltr" id="p-ref" name="payReference" value="${esc(o.payReference || '')}" placeholder="مثال: 123456789"></div>
          <div class="field"><label for="p-phone">رقم محفظتك المحوِّلة</label>
            <input class="input ltr" id="p-phone" name="payPhone" inputmode="tel" value="${esc(o.payPhone || '')}" placeholder="059-XXX-XXXX"></div>
        </div>
        <div class="field"><label for="p-name">اسم صاحب محفظة جوال باي المحوِّلة</label>
          <input class="input" id="p-name" name="payName" value="${esc(o.payName || '')}" placeholder="الاسم كما يظهر في جوال باي"></div>
        <div class="field"><label for="p-img">صورة شاشة لإشعار التحويل <span class="opt">(اختياري — يسرّع الاعتماد اليدوي)</span></label>
          <input class="input" id="p-img" type="file" accept="image/*"></div>
        <button type="submit" class="btn btn-good btn-lg">${icon('check')}<span>أرسلت التحويل — تحقّق وفعّل الآن</span></button>
      </form>
    </section>` : ''}
  `;
}

function lookupView() {
  return `<section class="card card-pad shop-form">
    <h2>${icon('search')}<span>تتبّع حالة طلبك واسترجاع رمز الـ QR</span></h2>
    <p class="small muted">أدخل رقم الطلب (مثال: <span class="ltr">SH-XXXXXX</span>) لعرض حالة التفعيل أو تنزيل رمز الـ QR لشريحتك الإلكترونية:</p>
    <form id="lookup-form" class="list" style="gap:12px">
      <div class="field"><label for="l-code">رقم الطلب</label>
        <input class="input ltr big" id="l-code" name="code" placeholder="SH-XXXXXX" required></div>
      <div class="btn-row" style="justify-content:space-between">
        <button type="button" class="btn" data-action="home">${t('backToCatalog')}</button>
        <button type="submit" class="btn btn-primary">${icon('search')}<span>عرض الطلب</span></button>
      </div>
    </form>
  </section>`;
}

// ---------- Modals: Psychiatrist Device Compatibility Checker & Advocate Legal Center ----------
function modalHtml() {
  if (!S.modal) return '';
  if (S.modal === 'compat') {
    const models = {
      apple: [
        ['yes', 'iPhone 16 / 16 Plus / 16 Pro / 16 Pro Max (يدعم بالكامل)'],
        ['yes', 'iPhone 15 / 14 / 13 / 12 / 11 (جميع الفئات Pro & Mini)'],
        ['yes', 'iPhone XS / XS Max / XR / SE (الجيل 2 و3)'],
        ['no', 'iPhone X / 8 / 7 أو أقدم (لا يدعم eSIM)'],
      ],
      samsung: [
        ['yes', 'Galaxy S25 / S24 / S23 / S22 / S21 / S20 (جميع فئات Ultra & +)'],
        ['yes', 'Galaxy Z Fold & Z Flip (جميع الأجيال)'],
        ['yes', 'Galaxy Note 20 / Note 20 Ultra / A55 / A54 / A35 (النسخ الداعمة)'],
        ['no', 'سلسلة Galaxy A القديمة (A10–A32) أو Note 10 وما قبله'],
      ],
      other: [
        ['yes', 'Google Pixel 4 / 5 / 6 / 7 / 8 / 9 (جميع الفئات)'],
        ['yes', 'Xiaomi 13 / 14 / 12T Pro · Honor Magic 4/5/6 Pro · Motorola Razr'],
        ['warn', 'جهاز آخر — سأفحص عبر الكود السريع *#06#'],
      ],
    };
    const verdict = S.compatModel === 'yes'
      ? { cls: 'ok', title: 'ممتاز! جهازك يدعم شريحة eSIM الإلكترونية ✅', text: 'يمكنك طلب أي باقة eSIM الآن وتثبيت رمز الـ QR مباشرة من الكاميرا بشرط أن يكون الجهاز مفتوحاً لجميع الشبكات (Unlocked).' }
      : S.compatModel === 'no'
        ? { cls: 'bad', title: 'تنبيه: هذا الطراز لا يدعم تقنية eSIM ❌', text: 'ننصحك باختيار «خط جديد بشريحة بلاستيكية» أو «شحن رقمي الحالي» بدلاً من الشريحة الإلكترونية.' }
        : { cls: 'warn', title: 'تحقّق في 3 ثوانٍ عبر كود *#06# 📞', text: 'افتح تطبيق الاتصال في هاتفك واضغط نجمة سلم صفر ستة سلم (*#06#): إذا ظهر لك سطر باسم EID (مكوّن من 32 رقماً) فجهازك يدعم eSIM بنسبة 100%!' };

    return `<div class="modal-backdrop" data-action="close-modal">
      <div class="modal-sheet" onclick="event.stopPropagation()">
        <div class="sheet-head">
          <div><h3>📱 فحص توافق جهازك مع الشريحة الإلكترونية (eSIM)</h3><p class="small muted">تأكّد مجاناً خلال 5 ثوانٍ قبل الشراء لضمان عمل الشريحة فوراً</p></div>
          <button type="button" class="icon-btn sm" data-action="close-modal">${icon('x')}</button>
        </div>
        <div class="sheet-body list" style="gap:14px">
          <div class="shop-eid-card">
            <span class="tile cyan">${icon('phone')}</span>
            <div class="grow">
              <b>الطريقة الأسرع والأدق 100%: اطلب <kbd class="ltr">*#06#</kbd></b>
              <p class="small">افتح لوحة الاتصال في هاتفك واكتب <b class="ltr">*#06#</b> — إذا ظهر لك رمز باسم <b>EID</b> على الشاشة، فهذا يعني أن جهازك يدعم شريحة <b>eSIM</b> رسمياً!</p>
            </div>
          </div>

          <div class="field">
            <span class="label">أو اختر نوع جهازك للتحقق السريع:</span>
            <div class="segmented">
              <button type="button" data-action="compat-brand" data-brand="apple" aria-pressed="${S.compatBrand === 'apple'}">Apple iPhone</button>
              <button type="button" data-action="compat-brand" data-brand="samsung" aria-pressed="${S.compatBrand === 'samsung'}">Samsung Galaxy</button>
              <button type="button" data-action="compat-brand" data-brand="other" aria-pressed="${S.compatBrand === 'other'}">Pixel / Xiaomi / أخرى</button>
            </div>
          </div>

          <div class="list" style="gap:8px">
            ${(models[S.compatBrand] || []).map(([val, label]) => `
              <label class="switch-row" style="cursor:pointer">
                <span class="grow"><b>${esc(label)}</b></span>
                <input type="radio" name="compat-m" value="${val}" ${S.compatModel === val ? 'checked' : ''} data-action="compat-model" data-val="${val}">
              </label>
            `).join('')}
          </div>

          <div class="msg ${verdict.cls === 'ok' ? 'info' : verdict.cls === 'bad' ? '' : 'warn'}">
            ${icon(verdict.cls === 'ok' ? 'check' : 'alert')}
            <div><b>${verdict.title}</b><p class="small" style="margin:4px 0 0">${verdict.text}</p></div>
          </div>
        </div>
        <div class="sheet-foot">
          <button type="button" class="btn btn-primary" data-action="close-modal">فهمت، العودة للمتجر</button>
        </div>
      </div>
    </div>`;
  }

  if (S.modal === 'legal') {
    const tabs = [
      ['terms', '1. شروط البيع والتفعيل'],
      ['esim', '2. سياسة الـ eSIM الرقمية'],
      ['compat', '3. مسؤولية توافق الجهاز'],
      ['privacy', '4. الضمان والخصوصية'],
    ];
    let content = '';
    if (S.legalTab === 'terms') {
      content = `
        <h4>أولاً: شفافية الأسعار وشروط التفعيل</h4>
        <ul class="shop-legal-list">
          <li><b>الأسعار الشاملة:</b> جميع الأسعار المعروضة بالشيكل (₪) واضحة ومفصّلة. في حال اختيار شريحة إلكترونية (eSIM)، تُعرض رسوم إصدار كود الـ QR الخاصة بكل شركة اتصالات بشكل مستقل وشفاف قبل الدفع.</li>
          <li><b>آلية التفعيل:</b> يتم تفعيل الباقات وإصدار أكواد الـ eSIM إما فورياً عبر قسم التفعيل المباشر أو فور التحقق الآلي/اليدوي من إشعار دفع محفظة جوال باي (Jawwal Pay).</li>
          <li><b>صلاحية الباقة:</b> تبدأ صلاحية الباقة من لحظة تفعيلها الفعلي على الشبكة، وتستمر للمدة المحددة في وصف الباقة (شهرية أو بعدد أيام محدد).</li>
        </ul>`;
    } else if (S.legalTab === 'esim') {
      content = `
        <h4>ثانياً: الطبيعة القانونية لأكواد الـ eSIM الرقمية والاسترجاع</h4>
        <ul class="shop-legal-list">
          <li><b>منتج رقمي فوري الاستهلاك:</b> رمز الـ QR وكود التفعيل اليدوي (LPA) للشريحة الإلكترونية يُعدّ منتجاً رقمياً مخصصاً وفوري الاستخدام يرتبط بالرقم والشبكة فور إصداره.</li>
          <li><b>متى يحق للزبون استرداد كامل المبلغ (100%)؟</b> إذا تعذّر إصدار الكود أو فشل تفعيل الخط من طرف شركة الاتصالات أو النظام لأي سبب تقني، يلتزم المتجر بإعادة 100% من المبلغ المدفوع أو توفير بديل فوري حسب رغبة الزبون.</li>
          <li><b>متى لا يُسترد كود الـ eSIM؟</b> بعد إصدار رمز QR صالح وفعّال على الشبكة وعرضه للزبون، لا يمكن إلغاؤه أو إرجاعه بسبب عدم رغبة الزبون أو عدم دعم هاتفه لتقنية eSIM أو مسح الشريحة بالخطأ من إعدادات الهاتف بعد تثبيتها.</li>
        </ul>`;
    } else if (S.legalTab === 'compat') {
      content = `
        <h4>ثالثاً: إخلاء المسؤولية الفنية عن توافق الجهاز</h4>
        <ul class="shop-legal-list">
          <li><b>فحص الجهاز قبل الشراء:</b> يوفّر المتجر أداة مجانية لفحص التوافق عبر الكود العالمي (<kbd class="ltr">*#06#</kbd> للتحقق من وجود رقم EID). تقع على عاتق المشتري مسؤولية التأكد من أن هاتفه يدعم eSIM وغير مقفل على شبكة أجنبية (Network Unlocked).</li>
          <li><b>استخدام رمز QR لمرة واحدة:</b> معظم شركات الاتصالات تسمح بمسح رمز الـ QR وتثبيته على جهاز واحد فقط. لا تقم بحذف الشريحة الإلكترونية من إعدادات جهازك بعد تثبيتها لأن ذلك قد يتطلب إصدار بدل فاقد برسوم جديدة من الشركة.</li>
        </ul>`;
    } else {
      content = `
        <h4>رابعاً: حماية البيانات وضمان المعاملات المالية</h4>
        <ul class="shop-legal-list">
          <li><b>أمن الدفعات:</b> جميع الحوالات تتم عبر محفظة جوال باي الرسمية المعتمدة، ويتم توثيق كل طلب برقم مرجعي وإيصال إلكتروني رسمي قابل للطباعة.</li>
          <li><b>خصوصية معلومات المشترك:</b> تُستخدم أرقام الهواتف والأسماء حصراً لغرض تنفيذ طلب التفعيل أو الشحن لدى شركة الاتصالات والتواصل مع الزبون بخصوص طلبه، ولا تُشارك مع أي طرف ثالث لأغراض تسويقية.</li>
        </ul>`;
    }

    return `<div class="modal-backdrop" data-action="close-modal">
      <div class="modal-sheet" onclick="event.stopPropagation()">
        <div class="sheet-head">
          <div><h3>⚖️ مركز الضمان والشروط القانونية وحماية المستهلك</h3><p class="small muted">سياسات واضحة تحمي حق الزبون وتضمن شفافية التعامل</p></div>
          <button type="button" class="icon-btn sm" data-action="close-modal">${icon('x')}</button>
        </div>
        <div class="sheet-body list" style="gap:14px">
          <div class="segmented" style="flex-wrap:wrap">
            ${tabs.map(([k, l]) => `<button type="button" data-action="legal-tab" data-tab="${k}" aria-pressed="${S.legalTab === k}">${l}</button>`).join('')}
          </div>
          <div class="shop-legal-box">${content}</div>
        </div>
        <div class="sheet-foot">
          <button type="button" class="btn btn-primary" data-action="close-modal">إغلاق والموافقة</button>
        </div>
      </div>
    </div>`;
  }
  return '';
}

function footerHtml() {
  const wa = S.data?.supportWhatsapp;
  return `<div class="shop-footer-inner">
    <div class="shop-footer-brand">
      <b>${esc(S.data?.appName || 'متجر الباقات والـ eSIM')}</b>
      <p class="small muted">منصة معتمدة لتفعيل باقات الاتصالات والشرائح الإلكترونية eSIM الفورية بشفافية كاملة وضمان استرداد عند التعذّر التقني.</p>
    </div>
    <div class="shop-footer-links">
      <button type="button" class="link-btn" data-action="go-esim">⚡ تفعيل مباشر eSIM</button>
      <button type="button" class="link-btn" data-action="compat-modal">📱 فحص توافق الجهاز (*#06#)</button>
      <button type="button" class="link-btn" data-action="legal-modal">⚖️ شروط البيع وسياسة الـ eSIM</button>
      <button type="button" class="link-btn" data-action="lookup">🔍 تتبّع طلب سابق</button>
    </div>
    ${wa ? `<a class="btn btn-sm wa-btn" href="https://wa.me/${esc(wa.replace(/\D/g, ''))}" target="_blank" rel="noopener">${icon('whatsapp')}<span>تواصل مع الدعم الفني</span></a>` : ''}
  </div>`;
}

function render() {
  applyLangAndTheme();
  const root = document.getElementById('shop-view');
  if (!root) return;
  const activeId = document.activeElement?.id;
  const selStart = document.activeElement?.selectionStart;

  if (S.order) root.innerHTML = orderStatusView();
  else if (S.pkg) root.innerHTML = orderFormView();
  else if (S.lookup) root.innerHTML = lookupView();
  else root.innerHTML = catalogView();

  const foot = document.getElementById('shop-footer');
  if (foot) foot.innerHTML = footerHtml();

  const modalRoot = document.getElementById('shop-modal-root');
  if (modalRoot) modalRoot.innerHTML = modalHtml();

  if (activeId === 'shop-q') {
    const input = document.getElementById('shop-q');
    if (input) {
      input.focus();
      try { input.setSelectionRange(selStart, selStart); } catch { /* ignore */ }
    }
  }
}

async function openOrder(code) {
  clearInterval(S.pollTimer);
  S.order = await api('GET', `/api/shop/orders/${encodeURIComponent(code)}`);
  S.pkg = null;
  S.lookup = false;
  location.hash = `#/order/${S.order.code}`;
  render();
  if (!['done', 'failed', 'rejected', 'cancelled'].includes(S.order.stage)) {
    S.pollTimer = setInterval(async () => {
      try {
        S.order = await api('GET', `/api/shop/orders/${encodeURIComponent(code)}`);
        render();
        if (['done', 'failed', 'rejected', 'cancelled'].includes(S.order.stage)) clearInterval(S.pollTimer);
      } catch { /* retry next tick */ }
    }, 8000);
  }
}

function readReceipt(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('تعذّر قراءة الصورة'));
    r.readAsDataURL(file);
  });
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'shop-q') {
    S.q = e.target.value;
    render();
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const act = btn.dataset.action;

  if (act === 'home') {
    e.preventDefault();
    clearInterval(S.pollTimer);
    S.pkg = null; S.order = null; S.lookup = false;
    location.hash = '';
    render();
  } else if (act === 'go-esim') {
    e.preventDefault();
    clearInterval(S.pollTimer);
    S.pkg = null; S.order = null; S.lookup = false;
    S.cat = 'esim';
    location.hash = '';
    render();
  } else if (act === 'lookup') {
    clearInterval(S.pollTimer);
    S.pkg = null; S.order = null; S.lookup = true;
    render();
  } else if (act === 'lang') {
    S.lang = btn.dataset.lang || 'ar';
    localStorage.setItem('shop-lang', S.lang);
    render();
  } else if (act === 'theme') {
    const cur = document.documentElement.getAttribute('data-theme');
    S.theme = cur === 'dark' ? 'light' : 'dark';
    localStorage.setItem('shop-theme', S.theme);
    render();
  } else if (act === 'cat') {
    S.cat = btn.dataset.cat || 'all';
    render();
  } else if (act === 'co') {
    S.companyId = Number(btn.dataset.id) || null;
    render();
  } else if (act === 'clear-q') {
    S.q = '';
    render();
  } else if (act === 'reset-filters') {
    S.q = ''; S.cat = 'all'; S.companyId = null;
    render();
  } else if (act === 'compat-modal') {
    S.modal = 'compat';
    render();
  } else if (act === 'legal-modal') {
    S.modal = 'legal';
    render();
  } else if (act === 'close-modal') {
    S.modal = null;
    render();
  } else if (act === 'compat-brand') {
    S.compatBrand = btn.dataset.brand || 'apple';
    S.compatModel = 'yes';
    render();
  } else if (act === 'compat-model') {
    S.compatModel = btn.dataset.val || 'yes';
    render();
  } else if (act === 'legal-tab') {
    S.legalTab = btn.dataset.tab || 'terms';
    render();
  } else if (act === 'pick') {
    S.pkg = S.data.packages.find((p) => p.id === Number(btn.dataset.id));
    const wantEsim = btn.dataset.esim === '1' && canPkgEsim(S.pkg);
    S.esim = wantEsim;
    S.kind = wantEsim || S.pkg?.ownSim ? 'new' : 'recharge';
    S.numbers = []; S.numberId = null; S.selectedPhone = ''; S.numbersErr = '';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (S.kind === 'new' && (S.pkg?.pool || S.pkg?.ownSim || S.pkg?.lyEsim)) loadAvailable();
  } else if (act === 'set-mode') {
    S.kind = btn.dataset.kind;
    S.esim = btn.dataset.esim === '1';
    S.numbers = []; S.numberId = null; S.selectedPhone = ''; S.numbersErr = '';
    render();
    if (S.kind === 'new' && (S.pkg?.pool || S.pkg?.ownSim || S.pkg?.lyEsim)) loadAvailable();
  } else if (act === 'pick-num') {
    S.numberId = Number(btn.dataset.id);
    S.selectedPhone = btn.dataset.phone;
    document.querySelectorAll('[data-action="pick-num"]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  } else if (act === 'num-more') {
    loadAvailable(true);
  } else if (act === 'num-reload') {
    loadAvailable(false);
  } else if (act === 'instant-esim') {
    if (!S.order) return;
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = `${icon('clock')}<span>${t('instantActivating')}</span>`;
    try {
      S.order = await api('POST', `/api/shop/orders/${encodeURIComponent(S.order.code)}/instant`, {});
      toast('تم إصدار رمز الـ QR وتفعيل الشريحة الإلكترونية بنجاح!');
      render();
    } catch (ex) {
      toast(ex.message, true);
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  } else if (act === 'print-receipt') {
    window.print();
  } else if (act === 'copy') {
    await navigator.clipboard?.writeText(btn.dataset.copy || '');
    toast('تم النسخ إلى الحافظة');
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'p-img' && e.target.files?.[0]) {
    try { S.receiptData = await readReceipt(e.target.files[0]); } catch (ex) { toast(ex.message, true); }
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('[type=submit]');
  if (btn) btn.disabled = true;
  try {
    if (f.id === 'order-form') {
      const consent = f.querySelector('#f-consent');
      if (consent && !consent.checked) {
        throw new Error('يرجى الموافقة على شروط البيع وتوافق الجهاز للمتابعة');
      }
      const isPool = S.kind === 'new' && (S.pkg.pool || S.pkg.ownSim || S.pkg.lyEsim);
      let numVal = f.number ? normPhone(f.number.value) : '';
      if (isPool && S.numbers.length) {
        if (!S.numberId) throw new Error('اختر رقم الهاتف من القائمة المتاحة أولاً');
        numVal = S.selectedPhone;
      } else if (S.esim && !numVal) {
        // Generate or assign a number when pool isn't required for custom/Layan direct eSIM
        numVal = '059' + String(Math.floor(1000000 + Math.random() * 9000000));
      }
      const r = await api('POST', '/api/shop/orders', {
        packageId: S.pkg.id,
        kind: S.esim ? 'new' : S.kind,
        esim: S.esim,
        qlNumberId: isPool && S.numberId ? S.numberId : undefined,
        number: numVal,
        sim: f.sim?.value || '',
        customerName: f.customerName?.value || '',
        contactPhone: normPhone(f.contactPhone?.value || numVal),
        email: f.email?.value || '',
      });
      localStorage.setItem('lastShopOrder', r.code);
      S.order = r; S.pkg = null;
      location.hash = `#/order/${r.code}`;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      openOrder(r.code);
    } else if (f.id === 'proof-form') {
      S.order = await api('POST', `/api/shop/orders/${encodeURIComponent(S.order.code)}/proof`, {
        payReference: f.payReference.value,
        payPhone: f.payPhone.value,
        payName: f.payName.value,
        receipt: S.receiptData,
      });
      S.receiptData = '';
      toast(S.order.stage === 'done' ? 'تم التحقق وتفعيل باقتك فوراً!' : 'تم استلام التأكيد — جاري التحقق والتفعيل');
      render();
    } else if (f.id === 'lookup-form') {
      await openOrder(f.code.value.trim());
    }
  } catch (ex) {
    toast(ex.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
});

async function boot() {
  S.data = await api('GET', '/api/shop');
  document.title = `${S.data.appName} — المتجر الإلكتروني و eSIM الفوري`;
  document.getElementById('shop-name').textContent = S.data.appName;
  const m = location.hash.match(/^#\/order\/([A-Za-z0-9-]+)/);
  if (m) await openOrder(m[1]);
  else render();
}

boot().catch((e) => toast(e.message, true));
