// Customer Storefront (/shop): Authentic eSIM & Telecom Plan Storefront.
// Uses ES module imports from ./core.js — zero emojis, crisp vector SVGs, full pages & sheets.
import {
  esc, icon, fmtMoney, fmtNum, fmtDateTime, fmtDate, fmtTime, specs, companyLogo,
  fileToDataUrl, copyText, toast, fmtPhone, sheet, closeSheet,
} from './core.js';

const MY_ORDERS_KEY = 'agents.shop.orders';
function savedOrderCodes() {
  try { return JSON.parse(localStorage.getItem(MY_ORDERS_KEY) || '[]').filter((x) => typeof x === 'string'); }
  catch { return []; }
}
function rememberOrderCode(code) {
  if (!code) return;
  const list = [code, ...savedOrderCodes().filter((c) => c !== code)].slice(0, 30);
  try { localStorage.setItem(MY_ORDERS_KEY, JSON.stringify(list)); } catch {}
}

function waHref(wa, text = '') {
  if (!wa) return '';
  const clean = String(wa).replace(/[^\d]/g, '');
  if (!clean) return '';
  return `https://wa.me/${clean}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

function notify(msg, isErr = false) {
  toast(msg, { error: Boolean(isErr) });
}

const S = {
  data: null,
  companyId: 'all',
  kindFilter: 'all', // 'all' | 'esim' | 'card' | 'line'
  q: '',
  compatBrand: 'apple',
  compatSearch: '',
  order: null,
  pollTimer: null,
  myCodes: savedOrderCodes(),
  myOrders: null,
  wantEsim: false,
  esimAvailable: null,
  instantBusy: false,
};

const root = document.getElementById('shop');

function getTheme() {
  return localStorage.getItem('agents.theme') || localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('agents.theme', t);
  localStorage.setItem('theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'dark' ? '#09111f' : '#0f172a';
}
applyTheme(getTheme());

async function jfetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { ...opts, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `خطأ (${res.status})`);
  return data;
}

// Signature H-SIM Brand Logo: Outer chamfered SIM card silhouette + Bold H-shaped metallic chip contact pad
let svgUid = 0;
function brandLogoSvg(cls = 'hsim-logo-svg') {
  const id = ++svgUid;
  return `<svg class="${cls}" viewBox="0 0 44 44" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="hSimFrame${id}" x1="4" y1="2" x2="40" y2="42" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#38bdf8"/>
        <stop offset="55%" stop-color="#0ea5e9"/>
        <stop offset="100%" stop-color="#2563eb"/>
      </linearGradient>
      <linearGradient id="hSimGold${id}" x1="10" y1="10" x2="34" y2="34" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#fef08a"/>
        <stop offset="48%" stop-color="#fbbf24"/>
        <stop offset="100%" stop-color="#d97706"/>
      </linearGradient>
    </defs>
    <!-- Outer SIM Card Body with 45-degree Chamfered Top-Right Corner -->
    <path d="M11 3.5H26.5L36.5 13.5V35.5A5 5 0 0 1 31.5 40.5H11A5 5 0 0 1 6 35.5V8.5A5 5 0 0 1 11 3.5Z"
          fill="#071124" fill-opacity=".85" stroke="url(#hSimFrame${id})" stroke-width="2.2" stroke-linejoin="round"/>
    <!-- Chamfered SIM Corner Trace -->
    <path d="M25.8 4V11.8A2.2 2.2 0 0 0 28 14H35.8" stroke="#7dd3fc" stroke-width="1.3" stroke-opacity=".55" stroke-linecap="round"/>
    <!-- Bold Letter 'H' Formed as the Metallic SIM Chip Contact Pad -->
    <g fill="url(#hSimGold${id})">
      <rect x="11.5" y="12.5" width="5.6" height="19.5" rx="1.8"/>
      <path d="M25.4 12.5H28.3L30.5 14.7V30.2A1.8 1.8 0 0 1 28.7 32H25.4A1.8 1.8 0 0 1 23.6 30.2V14.3A1.8 1.8 0 0 1 25.4 12.5Z"/>
      <rect x="16" y="19.5" width="9" height="5.5" rx="1.2"/>
    </g>
    <!-- SIM Chip Contact Grooves on the H Pillars -->
    <g stroke="#78350f" stroke-width="1.15" stroke-opacity=".6" stroke-linecap="round">
      <path d="M12 17.6h4.6M12 26.8h4.6M24.1 17.6h5.9M24.1 26.8h5.9"/>
    </g>
    <!-- Glowing eSIM Core Node in the Center of the H -->
    <circle cx="21" cy="22.25" r="1.7" fill="#071124"/>
    <circle cx="21" cy="22.25" r=".95" fill="#38bdf8"/>
  </svg>`;
}

// Vector eSIM metallic chip SVG emblem with signature H-shaped contact pad geometry
function esimChipSvg(cls = 'esim-chip-svg') {
  const id = ++svgUid;
  return `<svg class="${cls}" viewBox="0 0 44 34" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="chipGrad${id}" x1="0" y1="0" x2="44" y2="34" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#fef08a"/>
        <stop offset="50%" stop-color="#f59e0b"/>
        <stop offset="100%" stop-color="#b45309"/>
      </linearGradient>
    </defs>
    <!-- Outer Chamfered SIM-Chip Plate -->
    <path d="M6 1.5h26.5L42.5 11v17a4.5 4.5 0 0 1-4.5 4.5H6A4.5 4.5 0 0 1 1.5 28V6A4.5 4.5 0 0 1 6 1.5z"
          fill="url(#chipGrad${id})" stroke="#78350f" stroke-width="1.2" stroke-opacity=".45"/>
    <!-- Bold H-Chip Architecture & Contact Pad Grooves -->
    <path d="M11 7.5v19M17.5 7.5v19M26.5 7.5v19M33 7.5v19M17.5 14h9M17.5 20h9" stroke="#78350f" stroke-width="1.6" stroke-opacity=".65" stroke-linecap="round"/>
    <path d="M2 12.5h9M33 12.5h9M2 21.5h9M33 21.5h9" stroke="#78350f" stroke-width="1.15" stroke-opacity=".45"/>
    <rect x="11" y="7.5" width="6.5" height="19" rx="1.5" fill="#fef9c3" fill-opacity=".28"/>
    <rect x="26.5" y="7.5" width="6.5" height="19" rx="1.5" fill="#fef9c3" fill-opacity=".28"/>
    <rect x="17.5" y="14" width="9" height="6" rx="1" fill="#fef9c3" fill-opacity=".34"/>
  </svg>`;
}

function simCardSvg(cls = 'esim-sim-svg') {
  return `<svg class="${cls}" viewBox="0 0 28 34" fill="none" aria-hidden="true">
    <path d="M5 1.5h12.2L26.5 10v19A3.5 3.5 0 0 1 23 32.5H5A3.5 3.5 0 0 1 1.5 29V5A3.5 3.5 0 0 1 5 1.5z" stroke="currentColor" stroke-width="1.8"/>
    <!-- H-shaped SIM chip inside card -->
    <path d="M9.5 12.5v11M18.5 12.5v11M9.5 18h9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    <rect x="6.5" y="10" width="15" height="16" rx="2.5" stroke="currentColor" stroke-width="1.3" opacity=".55"/>
  </svg>`;
}

function isEsimPkg(pk) {
  return Boolean(pk && (pk.esim || pk.kind === 'esim'));
}

function pkgGb(pk) {
  return Number(pk?.dataGb ?? pk?.gb ?? 0) || 0;
}

function isFeaturedPkg(pk) {
  return Boolean(pk?.popular || pk?.featured);
}

function shell(body, { sub = '' } = {}) {
  const name = S.data?.shopTitle || (S.data?.appName ? `متجر ${S.data.appName}` : 'منصّة الشرائح والباقات الرقمية');
  const subtitle = sub || S.data?.shopSubtitle || 'شرائح eSIM الفورية وتجديد باقات الخليوي بسعر صريح';
  const wa = waHref(S.data?.supportWhatsapp, `مرحباً، أحتاج مساعدة في ${name}`);
  const dark = document.documentElement.dataset.theme === 'dark';
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  const onHome = !hash;
  const onLegal = hash === 'terms' || hash === 'esim-policy' || hash === 'guarantee';

  root.innerHTML = `
    <header class="shop-top">
      <div class="shop-top-inner">
        <a href="#/" class="shop-brand" data-act="nav-all">
          <span class="shop-brand-mark">${brandLogoSvg('hsim-logo-svg')}</span>
          <span class="shop-brand-text">
            <span class="shop-brand-title-row">
              <strong>${esc(name)}</strong>
              <span class="shop-brand-monogram ltr">H-SIM</span>
            </span>
            <small><span class="shop-live-dot"></span>${esc(subtitle)}</small>
          </span>
        </a>

        <nav class="shop-nav" aria-label="التنقّل في المتجر">
          <a href="#/" class="shop-nav-link ${onHome && S.kindFilter !== 'esim' ? 'active' : ''}" data-act="nav-all">
            ${icon('sim')}<span>الباقات والشرائح</span>
          </a>
          <button type="button" class="shop-nav-link ${onHome && S.kindFilter === 'esim' ? 'active' : ''}" data-act="nav-esim">
            ${icon('qr')}<span>شرائح eSIM الفورية</span>
          </button>
          <a href="#/compat" class="shop-nav-link ${hash === 'compat' ? 'active' : ''}">
            ${icon('chip')}<span>فحص توافق هاتفي</span>
          </a>
          <a href="#/terms" class="shop-nav-link ${onLegal ? 'active' : ''}">
            ${icon('shield')}<span>ميثاق الضمان والشروط</span>
          </a>
          <a href="#/track" class="shop-nav-link ${hash === 'track' || hash === 'orders' ? 'active' : ''}">
            ${icon('search')}<span>متابعة طلبي${S.myCodes.length ? ` (${fmtNum(S.myCodes.length)})` : ''}</span>
          </a>
        </nav>

        <div class="shop-utils">
          ${wa ? `<a class="btn btn-sm ghost shop-wa-btn" href="${esc(wa)}" target="_blank" rel="noopener">${icon('whatsapp')}<span>الدعم المباشر</span></a>` : ''}
          <button type="button" class="icon-btn sm" data-act="theme" aria-label="${dark ? 'الوضع الفاتح' : 'الوضع الداكن'}" title="${dark ? 'الوضع الفاتح' : 'الوضع الداكن'}">
            ${icon(dark ? 'sun' : 'moon')}
          </button>
        </div>
      </div>
    </header>

    <main class="shop-main">${body}</main>

    <footer class="shop-footer no-print">
      <div class="shop-footer-inner">
        <div class="shop-footer-brand">
          <div class="row" style="gap:10px">
            <span class="shop-brand-mark sm">${brandLogoSvg('hsim-logo-svg sm')}</span>
            <div>
              <div class="row" style="gap:8px">
                <b>${esc(name)}</b>
                <span class="shop-brand-monogram ltr">H-SIM</span>
              </div>
              <small class="muted" style="font-size:.75rem">الجيل الرقمي لشرائح الاتصال والباقات الفورية</small>
            </div>
          </div>
          <p class="muted" style="margin:8px 0 0;font-size:.84rem;line-height:1.65">
            صمّمنا هذه المنصّة لتختصر عليك الوقت: شرائح eSIM تصدر بكود QR فوري جاهز للمسح، وشحن مباشر لباقات الخليوي والإنترنت بتسعير صريح وميثاق ضمان يحمي حقّك بالكامل.
          </p>
        </div>
        <nav class="shop-footer-links" aria-label="روابط صفحات المتجر والسياسات">
          <a href="#/compat" class="shop-footer-link ${hash === 'compat' ? 'active' : ''}">${icon('chip')}<span>فحص توافق الهاتف مع eSIM</span></a>
          <a href="#/terms" class="shop-footer-link ${hash === 'terms' ? 'active' : ''}">${icon('shield')}<span>شروط البيع والتفعيل</span></a>
          <a href="#/esim-policy" class="shop-footer-link ${hash === 'esim-policy' ? 'active' : ''}">${icon('qr')}<span>سياسة كود eSIM QR</span></a>
          <a href="#/guarantee" class="shop-footer-link ${hash === 'guarantee' ? 'active' : ''}">${icon('checkCircle')}<span>ضمان المتجر واسترجاع المبلغ</span></a>
          <a href="#/track" class="shop-footer-link ${hash === 'track' ? 'active' : ''}">${icon('search')}<span>تتبّع حالة طلب</span></a>
        </nav>
      </div>
    </footer>
  `;

  bindGlobalTriggers(root);
}

function bindGlobalTriggers(scope) {
  scope.querySelectorAll('[data-act="theme"]').forEach((b) => {
    b.onclick = () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
      route();
    };
  });
  scope.querySelectorAll('[data-act="track-sheet"]').forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); openTrackSheet(); };
  });
  scope.querySelectorAll('[data-act="compat-sheet"]').forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openCompatSheet(); };
  });
  scope.querySelectorAll('[data-act="legal-sheet"]').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLegalSheet(b.dataset.tab || 'terms');
    };
  });
  scope.querySelectorAll('[data-act="nav-all"]').forEach((b) => {
    b.onclick = () => {
      S.kindFilter = 'all';
      if (!location.hash || location.hash === '#/') viewCatalog();
    };
  });
  scope.querySelectorAll('[data-act="nav-esim"]').forEach((b) => {
    b.onclick = () => {
      S.kindFilter = 'esim';
      if (location.hash && location.hash !== '#/') {
        location.hash = '#/';
      } else {
        viewCatalog();
        document.getElementById('esim-plans-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
  });
}

// ============================================================================
// Device Compatibility Data & Helpers
// ============================================================================
const COMPAT_DEVICES = {
  apple: {
    label: 'Apple iPhone & iPad',
    badge: 'iOS 12.1+',
    note: 'جميع هواتف iPhone الصادرة منذ خريف 2018 (بدءاً من iPhone XS و XR فما فوق) تدعم شريحة eSIM الرقمية بشكل كامل.',
    steps: [
      'افتح الإعدادات (Settings) ← خلوي (Cellular) أو البيانات الخلوية (Mobile Data).',
      'إذا ظهر لك خيار "إضافة شريحة إلكترونية (Add eSIM)" فجهازك يدعم الخدمة.',
      'للتأكد من عدم قفل الشبكة: الإعدادات ← عام (General) ← حول (About) ← قيود الشبكة: "لا توجد قيود على الشريحة (No SIM Restrictions)".',
    ],
    models: [
      'iPhone 16 / 16 Plus / 16 Pro / 16 Pro Max / 16e',
      'iPhone 15 / 15 Plus / 15 Pro / 15 Pro Max',
      'iPhone 14 / 14 Plus / 14 Pro / 14 Pro Max',
      'iPhone 13 / 13 mini / 13 Pro / 13 Pro Max',
      'iPhone 12 / 12 mini / 12 Pro / 12 Pro Max',
      'iPhone 11 / 11 Pro / 11 Pro Max',
      'iPhone XS / XS Max / iPhone XR',
      'iPhone SE (الجيل الثاني 2020 والجيل الثالث 2022)',
      'iPad Pro (11-inch & 12.9-inch من الجيل الثالث فما فوق - نسخ Cellular)',
      'iPad Air (الجيل الثالث فما فوق - نسخ Cellular)',
      'iPad mini (الجيل الخامس فما فوق - نسخ Cellular)',
    ],
    exceptions: 'ملاحظة: نسخ iPhone المخصصة للصين البر الرئيسي (Mainland China) التي تحتوي على مدخلين لشريحتين فعليتين لا تدعم eSIM. أما iPhone 13 mini و 12 mini و SE فتدعم eSIM في جميع المناطق.',
  },
  samsung: {
    label: 'Samsung Galaxy',
    badge: 'One UI / Android',
    note: 'جميع هواتف الفئة العليا Galaxy S (بدءاً من S20) وسلسلة الهواتف القابلة للطي Z Fold / Z Flip وبعض هواتف الفئة المتوسطة الحديثة تدعم eSIM.',
    steps: [
      'افتح الضبط (Settings) ← الاتصالات (Connections) ← إدارة بطاقة SIM (SIM Manager).',
      'إذا وجدت قسم "الشرائح الإلكترونية (eSIMs)" وخيار "إضافة eSIM (Add eSIM)" فجهازك جاهز تماماً.',
      'يمكنك أيضاً طلب *#06# والتأكد من ظهور رقم EID المكوّن من 32 رقماً.',
    ],
    models: [
      'Galaxy S25 / S25+ / S25 Ultra',
      'Galaxy S24 / S24+ / S24 Ultra / S24 FE',
      'Galaxy S23 / S23+ / S23 Ultra / S23 FE',
      'Galaxy S22 / S22+ / S22 Ultra',
      'Galaxy S21 / S21+ / S21 Ultra 5G',
      'Galaxy S20 / S20+ / S20 Ultra 5G',
      'Galaxy Note 20 / Note 20 Ultra 5G',
      'Galaxy Z Fold6 / Z Fold5 / Z Fold4 / Z Fold3 / Z Fold2',
      'Galaxy Z Flip6 / Z Flip5 / Z Flip4 / Z Flip3 / Z Flip',
      'Galaxy A55 5G / Galaxy A54 5G / Galaxy A35 5G (النسخ العالمية والأوروبية)',
      'Galaxy XCover7',
    ],
    exceptions: 'ملاحظة: سلسلة Galaxy S20 FE و S21 FE لا تدعم eSIM. في هواتف A54 و A35 يرجى التحقق عبر *#06# لأن بعض النسخ الإقليمية تختلف حسب البلد.',
  },
  google: {
    label: 'Google Pixel',
    badge: 'Android خالص',
    note: 'هواتف Google Pixel هي من أوائل الهواتف الذكية الداعمة لتقنية eSIM وتتميّز بسهولة التثبيت المباشر.',
    steps: [
      'افتح الإعدادات (Settings) ← الشبكة والإنترنت (Network & Internet) ← الشرائح (SIMs).',
      'اضغط على علامة (+) بجانب الشرائح ثم اختر "تنزيل شريحة eSIM بدلاً من ذلك".',
    ],
    models: [
      'Pixel 9 / 9 Pro / 9 Pro XL / 9 Pro Fold',
      'Pixel 8 / 8a / 8 Pro',
      'Pixel 7 / 7a / 7 Pro',
      'Pixel 6 / 6a / 6 Pro',
      'Pixel 5 / 5a 5G',
      'Pixel 4 / 4a / 4 XL',
      'Pixel 3 / 3 XL / 3a / 3a XL (النسخ غير المقفلة)',
      'Pixel Fold',
    ],
    exceptions: 'ملاحظة: جميع أجهزة Pixel من الجيل الرابع فما فوق تدعم eSIM بشكل قياسي طالما أن الجهاز غير مقفل على شبكة محددة.',
  },
  other: {
    label: 'Xiaomi / Honor / Huawei / Motorola',
    badge: 'أندرويد متعدد',
    note: 'أغلب الهواتف الرائدة والمتوسطة الحديثة من شاومي، هونر، هواوي، وموتورولا أصبحت مزوّدة برقاقة eSIM مدمجة.',
    steps: [
      'اطلب الكود *#06# في لوحة الاتصال: إذا ظهر لك رمز EID فالهاتف يدعم شريحة eSIM.',
      'أو افتح الإعدادات ← الشبكات والاتصالات ← بطاقات SIM وتحقق من وجود خيار تفعيل/إضافة eSIM.',
    ],
    models: [
      'Xiaomi 14 / 14 Pro / 14 Ultra / 14T / 14T Pro',
      'Xiaomi 13 / 13 Lite / 13 Pro / 13T / 13T Pro',
      'Xiaomi 12T Pro',
      'Redmi Note 13 Pro 5G / Note 13 Pro+ 5G (النسخ العالمية الداعمة لـ eSIM)',
      'Honor Magic6 Pro / Magic5 Pro / Magic4 Pro / Magic V2 & V3',
      'Honor 200 / 200 Pro / Honor 90',
      'Huawei Pura 70 Pro / P40 / P40 Pro / Mate 40 Pro',
      'Motorola Razr 50 / Razr 40 Ultra / Edge 50 Pro / Edge 40 / Moto G54 5G',
      'OnePlus 13 / OnePlus 12 / OnePlus 11 / OnePlus Open',
      'Oppo Find X8 / Find X5 Pro / Find N2 Flip / Find N3',
      'Sony Xperia 1 VI / 1 V / 5 V / 10 VI',
    ],
    exceptions: 'ملاحظة: Huawei P40 Pro+ و P50 Pro لا يدعمان eSIM. افحص دائماً بـ *#06# للتأكد من وجود EID في نسختك.',
  },
};

const KNOWN_UNSUPPORTED = [
  { match: /iphone\s*(6|7|8|\bx\b)/i, msg: 'هواتف iPhone X و iPhone 8 وما قبلها لا تدعم تقنية eSIM (الدعم يبدأ من iPhone XS / XR فما فوق).' },
  { match: /s10|s9|s8|note\s*10|note\s*9/i, msg: 'سلسلة Galaxy S10 و Note 10 وما قبلها لا تدعم شريحة eSIM (الدعم في سامسونج يبدأ من Galaxy S20 و Note 20).' },
  { match: /s20\s*fe|s21\s*fe/i, msg: 'نسخ Galaxy S20 FE و Galaxy S21 FE لا تحتوي على شريحة eSIM مدمجة.' },
  { match: /p40\s*pro\+|p50|mate\s*30/i, msg: 'هذا الطراز من Huawei لا يدعم eSIM (الدعم متوفر في P40 و P40 Pro و Mate 40 Pro و Pura 70 Pro).' },
];

function evaluateDeviceQuery(rawQuery) {
  const q = String(rawQuery || '').trim();
  if (!q) return null;
  for (const bad of KNOWN_UNSUPPORTED) {
    if (bad.match.test(q)) {
      return { status: 'bad', title: 'هذا الطراز لا يدعم شريحة eSIM', detail: bad.msg };
    }
  }
  const qLower = q.toLowerCase();
  const hits = [];
  for (const [brandKey, group] of Object.entries(COMPAT_DEVICES)) {
    for (const m of group.models) {
      if (m.toLowerCase().includes(qLower) || group.label.toLowerCase().includes(qLower)) {
        hits.push({ brand: group.label, model: m, brandKey });
      }
    }
  }
  if (hits.length) {
    return {
      status: 'ok',
      title: `نعم! وجدنا ${fmtNum(hits.length)} طراز متوافق مع "${q}"`,
      hits: hits.slice(0, 8),
      detail: 'تأكد فقط من أن جهازك مفتوح الشبكة (Unlocked) واطلب *#06# لرؤية رقم EID للتأكيد النهائي.',
    };
  }
  return {
    status: 'warn',
    title: `لم نعثر على "${q}" في القائمة المختصرة — افحصه بالكود الفوري`,
    detail: 'افتح لوحة الاتصال في هاتفك الآن واطلب الكود *#06#. إذا ظهر لك رقم EID (32 رقماً)، فجهازك يدعم شريحة eSIM بنسبة 100%.',
  };
}

function renderCompatMarkup({ inSheet = false } = {}) {
  const info = COMPAT_DEVICES[S.compatBrand] || COMPAT_DEVICES.apple;
  const searchRes = evaluateDeviceQuery(S.compatSearch);

  return `
    <!-- Instant *#06# Verification Hero Card -->
    <div class="esim-eid-check">
      <div class="esim-eid-icon">${icon('phone')}</div>
      <div class="grow">
        <strong>الفحص الأدقّ والأسرع خلال 5 ثوانٍ من هاتفك:</strong>
        <p class="muted" style="margin:4px 0 0;font-size:.88rem;line-height:1.6">
          افتح تطبيق الاتصال في هاتفك واطلب الرمز <kbd dir="ltr">*#06#</kbd> — ستظهر لك نافذة معلومات الجهاز فوراً. إذا رأيت رقماً تحت عنوان <b>EID</b> (مكوّناً من 32 رقماً)، فهاتفك يحتوي على رقاقة <b>eSIM</b> ويدعم التفعيل الفوري بكود الـ QR بنسبة 100%.
        </p>
      </div>
    </div>

    <!-- 3 Verification Steps Grid -->
    <div class="esim-info-grid">
      <div class="esim-info-card">
        <div class="esim-step-num">1</div>
        <h4>وجود رمز EID</h4>
        <p class="muted">اطلب <kbd dir="ltr">*#06#</kbd> وتأكد من ظهور حقل <b>EID</b>. وجود هذا الرقم يعني أن شريحة الـ eSIM الإلكترونية مدمجة في لوحة الهاتف.</p>
      </div>
      <div class="esim-info-card">
        <div class="esim-step-num">2</div>
        <h4>الجهاز مفتوح الشبكة</h4>
        <p class="muted">يجب أن يكون الهاتف غير مقفل على شركة اتصالات خارجية (<b>Network Unlocked / لا توجد قيود على الشريحة</b>).</p>
      </div>
      <div class="esim-info-card">
        <div class="esim-step-num">3</div>
        <h4>اتصال Wi-Fi عند المسح</h4>
        <p class="muted">لتنزيل ملف الشريحة عبر كود الـ QR بعد الشراء، يجب أن يكون الهاتف متصلاً بشبكة Wi-Fi أو بيانات خلوية مستقرة.</p>
      </div>
    </div>

    <!-- Interactive Model Search Box -->
    <div class="esim-compat-search-card">
      <label for="compat-q-input" class="esim-sec-title">
        ${icon('search')}
        <span>ابحث باسم هاتفك للتحقق السريع (مثال: iPhone 14 أو S24 أو Pixel 8 أو A54)</span>
      </label>
      <div class="esim-compat-search-row">
        <input id="compat-q-input" class="input" type="search" value="${esc(S.compatSearch)}" placeholder="اكتب طراز هاتفك هنا..." autocomplete="off">
        ${S.compatSearch ? `<button type="button" class="btn ghost btn-sm" id="compat-q-clear">مسح</button>` : ''}
      </div>
      ${searchRes ? `
        <div class="esim-compat-result is-${searchRes.status}">
          <div class="row" style="gap:8px">
            ${icon(searchRes.status === 'ok' ? 'checkCircle' : 'alert')}
            <strong>${esc(searchRes.title)}</strong>
          </div>
          <p style="margin:4px 0 0;font-size:.86rem">${esc(searchRes.detail)}</p>
          ${searchRes.hits ? `
            <ul class="esim-compat-list" style="margin-top:10px">
              ${searchRes.hits.map((h) => `<li>${icon('checkCircle')}<span class="ltr">${esc(h.model)}</span></li>`).join('')}
            </ul>
          ` : ''}
        </div>
      ` : ''}
    </div>

    <!-- Brand Selector Tabs -->
    <div class="esim-brand-tabs" role="tablist" aria-label="الشركات المصنعة للهواتف">
      ${Object.entries(COMPAT_DEVICES).map(([k, v]) => `
        <button type="button" role="tab" class="esim-brand-tab" aria-selected="${S.compatBrand === k}" data-brand="${k}">
          <b>${esc(v.label)}</b>
          <small>${esc(v.badge)}</small>
        </button>
      `).join('')}
    </div>

    <!-- Selected Brand Details & Models -->
    <div class="esim-compat-box">
      <div class="row between" style="flex-wrap:wrap;gap:8px;margin-bottom:10px">
        <h3 style="margin:0">${esc(info.label)}</h3>
        <span class="pill s-done">${esc(info.badge)}</span>
      </div>
      <p class="muted" style="margin:0 0 12px;font-size:.88rem">${esc(info.note)}</p>

      <h4 style="margin:0 0 8px;font-size:.88rem">الأجهزة المتوافقة:</h4>
      <ul class="esim-compat-list">
        ${info.models.map((m) => `<li>${icon('checkCircle')}<span class="ltr">${esc(m)}</span></li>`).join('')}
      </ul>

      <div class="esim-compat-steps-box" style="margin-top:14px">
        <h4 style="margin:0 0 6px;font-size:.86rem">كيف تتأكد من داخل إعدادات ${esc(info.label)}؟</h4>
        <ol class="esim-legal-list">
          ${info.steps.map((s) => `<li>${esc(s)}</li>`).join('')}
        </ol>
      </div>

      ${info.exceptions ? `
        <div class="esim-compat-note" style="margin-top:12px">
          ${icon('info')}
          <span>${esc(info.exceptions)}</span>
        </div>
      ` : ''}
    </div>

    ${!inSheet ? `
      <div class="esim-page-cta">
        <div>
          <h3 style="margin:0 0 4px">تأكدت من توافق هاتفك؟</h3>
          <p class="muted" style="margin:0;font-size:.88rem">اختر باقة الـ eSIM المناسبة لك الآن واستلم كود الـ QR الجاهز للمسح فوراً.</p>
        </div>
        <button type="button" class="btn primary lg" data-act="nav-esim">
          ${icon('qr')}<span>استعرض باقات eSIM الفورية</span>
        </button>
      </div>
    ` : ''}
  `;
}

function bindCompatEvents(container, rerender) {
  container.querySelectorAll('[data-brand]').forEach((btn) => {
    btn.onclick = () => {
      S.compatBrand = btn.dataset.brand;
      rerender();
    };
  });
  const qInput = container.querySelector('#compat-q-input');
  if (qInput) {
    qInput.oninput = (e) => {
      S.compatSearch = e.currentTarget.value;
      const pos = e.currentTarget.selectionStart;
      rerender();
      const next = container.querySelector('#compat-q-input');
      if (next) { next.focus(); try { next.setSelectionRange(pos, pos); } catch {} }
    };
  }
  const qClear = container.querySelector('#compat-q-clear');
  if (qClear) {
    qClear.onclick = () => {
      S.compatSearch = '';
      rerender();
    };
  }
  bindGlobalTriggers(container);
}

// Full Page: #/compat
function viewCompatPage() {
  shell(`
    <section class="esim-page-wrap">
      <div class="esim-page-head">
        <div>
          <span class="esim-hero-kicker">${icon('chip')}<span>دليل وفاحص التوافق الرقمي</span></span>
          <h1>فحص توافق الهاتف مع شريحة eSIM</h1>
          <p class="muted">تحقق من دعم هاتفك لتقنية الشريحة الإلكترونية المدمجة (eSIM) قبل شراء الباقة وإصدار كود الـ QR.</p>
        </div>
        <a href="#/" class="btn ghost btn-sm">← العودة للمتجر</a>
      </div>
      <div id="compat-page-body"></div>
    </section>
  `, { sub: 'فحص توافق الجهاز مع eSIM' });

  const mount = document.getElementById('compat-page-body');
  const update = () => {
    mount.innerHTML = renderCompatMarkup({ inSheet: false });
    bindCompatEvents(mount, update);
  };
  update();
}

// Modal Sheet: openCompatSheet() (used inside checkout so user doesn't lose form inputs)
function openCompatSheet() {
  const { el } = sheet({
    title: 'فحص توافق هاتفك مع شريحة eSIM',
    subtitle: 'تأكد خلال ثوانٍ من أن هاتفك يدعم الشريحة الرقمية قبل الشراء',
    wide: true,
    body: `<div id="compat-sheet-body"></div>`,
    footer: `<button type="button" class="btn primary" data-close>تم الفحص — متابعة الطلب</button>`,
  });
  const mount = el.querySelector('#compat-sheet-body');
  const update = () => {
    mount.innerHTML = renderCompatMarkup({ inSheet: true });
    bindCompatEvents(mount, update);
  };
  update();
}

// ============================================================================
// Legal, eSIM QR Policy, and Store Guarantee Pages & Sheets
// ============================================================================
function renderLegalSectionMarkup(tab = 'terms') {
  if (tab === 'esim') {
    return `
      <div class="esim-legal-hero">
        <div class="esim-eid-icon">${icon('qr')}</div>
        <div>
          <h3>سياسة إصدار واستخدام كود eSIM QR الرقمي</h3>
          <p class="muted">كل ما تحتاج معرفته حول آلية عمل كود الـ QR، طريقة التثبيت الصحيحة، وقواعد الحفاظ على شريحتك الإلكترونية.</p>
        </div>
      </div>

      <div class="esim-info-grid">
        <div class="esim-info-card">
          <div class="esim-step-num">${icon('lock')}</div>
          <h4>صالح لجهاز واحد فقط</h4>
          <p class="muted">يرتبط كود الـ QR بجهازك فور مسحه لأول مرة عبر معرّف الرقاقة (EID)، ولا يمكن مسحه على هاتف آخر بعد التثبيت.</p>
        </div>
        <div class="esim-info-card">
          <div class="esim-step-num">${icon('alert')}</div>
          <h4>لا تحذف الشريحة أبداً</h4>
          <p class="muted">اختيار "حذف eSIM / Delete eSIM" من إعدادات الهاتف يلغي الشريحة نهائياً ويتطلب إصدار بدل شريحة لدى الشركة المشغّلة.</p>
        </div>
        <div class="esim-info-card">
          <div class="esim-step-num">${icon('data')}</div>
          <h4>يتطلب اتصال إنترنت عند المسح</h4>
          <p class="muted">عملية مسح الكود تقوم بتنزيل ملف الشريحة المشفّر من خادم شركة الاتصالات، لذلك يلزم اتصال Wi-Fi مستقر أثناء المسح.</p>
        </div>
      </div>

      <div class="esim-legal-panel">
        <h4>١. القواعد الأساسية لكود eSIM QR</h4>
        <ul class="esim-legal-list">
          <li><b>التحقق من توافق الهاتف قبل الشراء:</b> تقع على عاتق المشتري مسؤولية التأكد من أن هاتفه يدعم تقنية eSIM (عبر طلب <kbd dir="ltr">*#06#</kbd> وظهور رقم <b>EID</b>) وأن الهاتف غير مقفل على شبكة أخرى (Network Unlocked).</li>
          <li><b>سرية كود الـ QR وكود التفعيل اليدوي (LPA):</b> كود الـ QR الذي يظهر لك بعد التفعيل هو ملكية خاصة لخطك. لا تقم بمشاركة صورة الكود مع أي طرف آخر لأن أول جهاز يقوم بمسحه وتنزيل الملف سيستحوذ على الشريحة.</li>
          <li><b>رسوم إصدار كود eSIM QR:</b> تختلف رسوم شريحة الـ eSIM من شركة اتصالات لأخرى (وقد تكون مجانية في بعض الباقات)، ويتم عرضها بشكل منفصل وشفاف في ملخص السعر قبل الدفع.</li>
          <li><b>عدم إمكانية إعادة المسح بعد الحذف:</b> لأسباب أمنية تقنية لدى شركات الاتصالات، كود الـ QR يُستخدم لمرة واحدة فقط (One-Time Provisioning). في حال قمت بحذف الشريحة من هاتفك أو عمل ضبط مصنع مع مسح الـ eSIM، لن يعمل الكود القديم مرة أخرى.</li>
        </ul>
      </div>

      <div class="esim-legal-panel">
        <h4>٢. طرق تثبيت شريحة eSIM على هاتفك</h4>
        <div class="shop-qr-guides">
          <div class="shop-qr-guide-col">
            <b>الطريقة الأولى: مسح رمز QR بالكاميرا</b>
            <ol>
              <li>اتصل بشبكة Wi-Fi مستقرة على هاتفك.</li>
              <li>على <b>iPhone</b>: الإعدادات ← خلوي ← إضافة شريحة إلكترونية ← استخدام رمز QR.</li>
              <li>على <b>Android / Samsung</b>: الضبط ← الاتصالات ← إدارة SIM ← إضافة eSIM ← مسح رمز QR.</li>
              <li>وجّه الكاميرا نحو الكود وانتظر بضع ثوانٍ حتى يكتمل التفعيل.</li>
            </ol>
          </div>
          <div class="shop-qr-guide-col">
            <b>الطريقة الثانية: التثبيت من نفس الهاتف (بدون هاتف ثانٍ)</b>
            <ol>
              <li>على <b>iOS 17.4+</b>: احفظ صورة الـ QR في الصور، أو اضغط مطولاً عليها واختر "إضافة eSIM"، أو اختر فتح الصورة من الاستوديو داخل إعدادات إضافة eSIM.</li>
              <li>أو انسخ <b>كود التفعيل اليدوي (LPA)</b> الموجود أسفل صورة الـ QR في صفحة طلبك.</li>
              <li>في إعدادات إضافة eSIM بالهاتف، اختر <b>إدخال التفاصيل يدوياً (Enter Details Manually)</b> والصق الكود.</li>
            </ol>
          </div>
        </div>
      </div>
    `;
  }

  if (tab === 'guarantee') {
    return `
      <div class="esim-legal-hero">
        <div class="esim-eid-icon">${icon('shield')}</div>
        <div>
          <h3>ضمان المتجر وسياسة استرجاع المبلغ</h3>
          <p class="muted">نضمن لك تفعيل باقتك وشريحتك بشكل رسمي وموثوق، أو استرداد كامل المبلغ المدفوع في حال تعذّر التنفيذ من المصدر.</p>
        </div>
      </div>

      <div class="esim-info-grid">
        <div class="esim-info-card">
          <div class="esim-step-num">${icon('checkCircle')}</div>
          <h4>ضمان التفعيل 100%</h4>
          <p class="muted">كل طلب محمي بضمان التنفيذ الكامل؛ إذا تعذّر إصدار الشريحة أو تفعيل الباقة من المصدر لأي سبب تقني، يعود لك كامل المبلغ دون خصم.</p>
        </div>
        <div class="esim-info-card">
          <div class="esim-step-num">${icon('qr')}</div>
          <h4>حفظ دائم لكود الـ QR</h4>
          <p class="muted">تظل صورة كود الـ QR ورقم الخط وتفاصيل الباقة محفوظة في صفحة طلبك بحيث يمكنك الرجوع إليها أو طباعتها في أي وقت.</p>
        </div>
        <div class="esim-info-card">
          <div class="esim-step-num">${icon('whatsapp')}</div>
          <h4>دعم فني بشري مباشر</h4>
          <p class="muted">فريق الدعم متواجد لمساعدتك خطوة بخطوة في التثبيت أو المراجعة الفورية لأي طلب عبر واتساب.</p>
        </div>
      </div>

      <div class="esim-legal-panel">
        <h4>جدول حالات الضمان، الاستبدال، واسترجاع المبلغ</h4>
        <div class="esim-policy-table-wrap">
          <table class="esim-policy-table">
            <thead>
              <tr>
                <th>الحالة</th>
                <th>الإجراء والضمان المطبّق</th>
                <th>الاسترجاع / البديل</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>تعذّر التفعيل أو نفاد أرقام الباقة بعد الدفع</b></td>
                <td>يتم إشعارك فوراً وتخييرك بين التحويل لباقة أخرى أو استرداد المبلغ.</td>
                <td><span class="pill s-done">استرجاع كامل 100%</span></td>
              </tr>
              <tr>
                <td><b>خلل تقني في كود الـ QR من المصدر قبل مسحه</b></td>
                <td>يفحص فريق الدعم حالة الشريحة لدى الشركة ويصدر لك كوداً بديلاً أو يعيد المبلغ.</td>
                <td><span class="pill s-done">استبدال مجاني أو استرجاع 100%</span></td>
              </tr>
              <tr>
                <td><b>إلغاء الطلب قبل الدفع أو قبل بدء التنفيذ</b></td>
                <td>يمكنك إلغاء الطلب بضغطة زر من صفحة الطلب مباشرة.</td>
                <td><span class="pill s-done">إلغاء فوري مجاني</span></td>
              </tr>
              <tr>
                <td><b>شراء شريحة eSIM لهاتف لا يدعم التقنية (بعد إصدار الكود)</b></td>
                <td>بمجرد تخصيص الرقم وإصدار كود الـ QR من شركة الاتصالات، تُحتسب الشريحة مفعّلة، لكن يمكنك مسح الكود على أي هاتف آخر متوافق طالما لم يُمسح بعد.</td>
                <td><span class="pill s-open">قابل للاستخدام على جهاز متوافق</span></td>
              </tr>
              <tr>
                <td><b>حذف شريحة eSIM من الجهاز بعد تثبيتها أو إدخال رقم شحن خاطئ</b></td>
                <td>بعد تثبيت الشريحة على الهاتف أو تنفيذ شحن الرصيد على الرقم المدخل لدى الشركة، لا يمكن استرجاع قيمتها.</td>
                <td><span class="pill s-bad">غير قابل للاسترجاع بعد التنفيذ</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="esim-legal-panel">
        <h4>كيف تطلب استرجاع المبلغ أو تفعيل الضمان؟</h4>
        <ol class="esim-legal-list">
          <li>احتفظ <b>برمز الطلب (Order Code)</b> الموجود في صفحة الطلب أو في قسم "تتبّع طلب".</li>
          <li>تواصل مع الدعم الفني عبر زر <b>واتساب الدعم</b> الموجود أعلى الصفحة أو داخل صفحة الطلب.</li>
          <li>يتم التحقق من حالة الطلب وإرجاع المبلغ مباشرة إلى محفظة <b>Jawwal Pay</b> الخاصة بك أو استبدال الباقة فوراً.</li>
        </ol>
      </div>
    `;
  }

  // Default: 'terms' (شروط البيع والتفعيل)
  return `
    <div class="esim-legal-hero">
      <div class="esim-eid-icon">${icon('file')}</div>
      <div>
        <h3>شروط البيع والتفعيل المعتمدة في المتجر</h3>
        <p class="muted">توضيح كامل وشفاف لآلية شراء الباقات، تفعيل شرائح eSIM الفورية، الدفع، ومسؤوليات المشترك.</p>
      </div>
    </div>

    <div class="esim-legal-panel">
      <h4>١. نطاق الخدمة والباقات المتوفرة</h4>
      <ul class="esim-legal-list">
        <li><b>خدمات المتجر:</b> يتيح المتجر للعملاء شراء وتفعيل شرائح الاتصال الإلكترونية (<b>eSIM</b>) بكود QR مباشر، بالإضافة إلى شحن الرصيد وتجديد الحزم والباقات على الأرقام الحالية لمختلف شبكات الاتصالات (سلكوم، بارتنر، هوت موبايل، رامي ليفي، WE، ALOHA وغيرها).</li>
        <li><b>مواصفات الباقات:</b> تُعرض تفاصيل كل باقة (حجم الإنترنت بالجيجابايت GB، مدة الصلاحية بالأيام، دقائق المكالمات والرسائل، ونوع التفعيل) بوضوح على بطاقة الباقة قبل الشراء.</li>
      </ul>
    </div>

    <div class="esim-legal-panel">
      <h4>٢. الأسعار، رسوم كود الـ QR، وآلية الدفع</h4>
      <ul class="esim-legal-list">
        <li><b>شفافية الأسعار:</b> جميع الأسعار المعروضة بالشيكل الإسرائيلي الجديد (₪) نهائية ولا توجد أي عمولات مخفية.</li>
        <li><b>رسوم شريحة eSIM QR:</b> في حال طلب تفعيل الباقة كشريحة eSIM إلكترونية جديدة، تُضاف رسوم إصدار كود الـ QR المحددة لكل شركة اتصالات (أو تكون مجانية 0 ₪ حسب الشركة والعرض)، وتظهر لك القيمة التفصيلية والإجمالية في "ملخص السعر الشامل" قبل تأكيد الطلب.</li>
        <li><b>الدفع عبر جوال باي (Jawwal Pay):</b> يتم تحويل المبلغ الإجمالي المحدّد في الطلب إلى محفظة المتجر المعتمدة، ثم إدخال رقم الحركة أو اسم المحوِّل أو إرفاق صورة الإشعار ليقوم النظام بالتحقق التلقائي وتنفيذ التفعيل.</li>
        <li><b>التفعيل المباشر الفوري:</b> في حال تفعيل ميزة الإصدار الفوري في المتجر لباقات eSIM، يتم تخصيص الرقم وتوليد كود الـ QR مباشرة على الشاشة فور الضغط على زر التفعيل الفوري.</li>
      </ul>
    </div>

    <div class="esim-legal-panel">
      <h4>٣. دقة البيانات وحجز الأرقام</h4>
      <ul class="esim-legal-list">
        <li><b>مسؤولية رقم الهاتف في طلبات الشحن:</b> في طلبات شحن وتجديد رقم حالي، يجب على المشترك التأكد من كتابة رقم الهاتف بشكل صحيح. لا يتحمل المتجر مسؤولية الشحن الذي يتم تنفيذه بنجاح على رقم أدخله العميل بالخطأ.</li>
        <li><b>مهلة حجز رقم eSIM:</b> عند إنشاء طلب eSIM، يُحجز لك رقم من مخزون الباقة لفترة زمنية محددة لإتمام الدفع. إذا لم يُستكمل الدفع خلال المهلة، يُلغى الحجز تلقائياً لإتاحة الرقم لمشتركين آخرين.</li>
        <li><b>سياسة الاستخدام العادل:</b> تخضع جميع الخطوط والباقات بعد تفعيلها لشروط التغطية والاستخدام العادل المعتمدة لدى شركة الاتصالات المشغّلة للشبكة.</li>
      </ul>
    </div>
  `;
}

// Full Page: #/terms, #/esim-policy, #/guarantee
function viewLegalPage(tab = 'terms') {
  const titles = {
    terms: { title: 'شروط البيع والتفعيل', sub: 'القواعد المنظّمة لشراء الباقات وتفعيل الشرائح والدفع بشفافية كاملة' },
    esim: { title: 'سياسة كود eSIM QR الرقمي', sub: 'تعليمات استخدام ومسح كود الـ QR وطريقة التثبيت الصحيحة على هاتفك' },
    guarantee: { title: 'ضمان المتجر واسترجاع المبلغ', sub: 'حماية كاملة لحقوق المشتري وضمان التفعيل 100% أو استرداد المبلغ' },
  };
  const info = titles[tab] || titles.terms;

  shell(`
    <section class="esim-page-wrap">
      <div class="esim-page-head">
        <div>
          <span class="esim-hero-kicker">${icon('shield')}<span>السياسات والضمان الرسمي</span></span>
          <h1>${esc(info.title)}</h1>
          <p class="muted">${esc(info.sub)}</p>
        </div>
        <a href="#/" class="btn ghost btn-sm">← العودة للمتجر</a>
      </div>

      <!-- Navigation Tabs between the 3 Policy Pages -->
      <div class="esim-brand-tabs" role="tablist" aria-label="أقسام الشروط والسياسات">
        <a href="#/terms" role="tab" class="esim-brand-tab" aria-selected="${tab === 'terms'}">
          <b>شروط البيع والتفعيل</b>
          <small>الأسعار والدفع والتنفيذ</small>
        </a>
        <a href="#/esim-policy" role="tab" class="esim-brand-tab" aria-selected="${tab === 'esim'}">
          <b>سياسة كود eSIM QR</b>
          <small>قواعد المسح والتثبيت</small>
        </a>
        <a href="#/guarantee" role="tab" class="esim-brand-tab" aria-selected="${tab === 'guarantee'}">
          <b>ضمان المتجر والاسترجاع</b>
          <small>حماية المشتري 100%</small>
        </a>
      </div>

      <div class="esim-legal-page-body">
        ${renderLegalSectionMarkup(tab)}
      </div>

      <div class="esim-page-cta">
        <div>
          <h3 style="margin:0 0 4px">هل لديك استفسار إضافي؟</h3>
          <p class="muted" style="margin:0;font-size:.88rem">يمكنك فحص توافق جهازك الآن أو العودة لتصفّح الباقات المتوفرة.</p>
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <a href="#/compat" class="btn ghost">${icon('chip')}<span>فحص توافق الجهاز</span></a>
          <a href="#/" class="btn primary">${icon('sim')}<span>تصفّح الباقات</span></a>
        </div>
      </div>
    </section>
  `, { sub: info.title });
}

// Modal Sheet: openLegalSheet() (used inside checkout so customer stays on form)
function openLegalSheet(initialTab = 'terms') {
  let tab = initialTab || 'terms';
  const { el } = sheet({
    title: 'شروط البيع، سياسة eSIM، وضمان المتجر',
    subtitle: 'شفافية كاملة لحماية حقوق المشترك وتوضيح آلية التفعيل الفوري',
    wide: true,
    body: `<div id="legal-sheet-body"></div>`,
    footer: `<button type="button" class="btn primary" data-close>فهمت وموافق — متابعة الطلب</button>`,
  });

  const mount = el.querySelector('#legal-sheet-body');
  function renderLegal() {
    mount.innerHTML = `
      <div class="esim-brand-tabs" role="tablist">
        <button type="button" role="tab" class="esim-brand-tab" aria-selected="${tab === 'terms'}" data-ltab="terms">
          <b>شروط البيع والتفعيل</b>
        </button>
        <button type="button" role="tab" class="esim-brand-tab" aria-selected="${tab === 'esim'}" data-ltab="esim">
          <b>سياسة كود eSIM QR</b>
        </button>
        <button type="button" role="tab" class="esim-brand-tab" aria-selected="${tab === 'guarantee'}" data-ltab="guarantee">
          <b>ضمان المتجر والاسترجاع</b>
        </button>
      </div>
      <div style="margin-top:12px;display:grid;gap:12px">
        ${renderLegalSectionMarkup(tab)}
      </div>
    `;
    mount.querySelectorAll('[data-ltab]').forEach((btn) => {
      btn.onclick = () => {
        tab = btn.dataset.ltab;
        renderLegal();
      };
    });
  }
  renderLegal();
}

// ============================================================================
// Track Order Page (#/track & #/orders) + Quick Sheet
// ============================================================================
function openTrackSheet() {
  sheet({
    title: 'تتبّع حالة طلبك',
    subtitle: 'أدخل رمز الطلب للاطلاع على حالة التفعيل أو عرض كود eSIM QR الخاص بك',
    body: `
      <div class="field">
        <label for="f-sheet-code">رمز الطلب (Order Code)</label>
        <input id="f-sheet-code" name="code" class="input ltr" required placeholder="مثال: AB12CD34" autocomplete="off">
      </div>
    `,
    submit: 'عرض تفاصيل الطلب',
    cancel: 'إلغاء',
    onSubmit: (form) => {
      const code = (new FormData(form).get('code') || '').trim().toUpperCase();
      if (!code) throw new Error('أدخل رمز الطلب أولاً');
      location.hash = `#/order/${encodeURIComponent(code)}`;
    },
  });
}

async function viewTrackPage() {
  clearInterval(S.pollTimer);
  const codes = S.myCodes;
  if (codes.length && !S.myOrders) {
    const results = await Promise.all(codes.map((c) => jfetch(`/api/shop/orders/${encodeURIComponent(c)}`).catch(() => null)));
    S.myOrders = results.filter(Boolean);
  }
  const ordersList = S.myOrders || [];

  shell(`
    <section class="esim-page-wrap">
      <div class="esim-page-head">
        <div>
          <span class="esim-hero-kicker">${icon('search')}<span>مركز متابعة الطلبات وشرائح eSIM</span></span>
          <h1>تتبّع حالة طلب واستلام كود الـ QR</h1>
          <p class="muted">أدخل رمز الطلب الخاص بك لعرض حالة التفعيل، تأكيد الدفع، أو تحميل كود eSIM QR وتفاصيل الخط في أي وقت.</p>
        </div>
        <a href="#/" class="btn ghost btn-sm">← العودة للمتجر</a>
      </div>

      <!-- Interactive Order Code Lookup Card -->
      <div class="card esim-track-card">
        <form id="track-page-form" class="esim-track-form">
          <div class="field grow">
            <label for="track-code-input">رمز الطلب (Order Code)</label>
            <input id="track-code-input" name="code" class="input ltr big" required placeholder="أدخل رمز الطلب هنا — مثال: AB12CD34" autocomplete="off">
          </div>
          <button type="submit" class="btn primary lg">
            ${icon('search')}<span>بحث وعرض الطلب</span>
          </button>
        </form>
        <div id="track-inline-error"></div>
      </div>

      <!-- Order Stages Explanation -->
      <div class="esim-info-grid">
        <div class="esim-info-card">
          <div class="esim-step-num">1</div>
          <h4>بانتظار الدفع أو التفعيل الفوري</h4>
          <p class="muted">تم إنشاء الطلب وحجز الرقم. يمكنك إتمام التحويل عبر Jawwal Pay أو الضغط على زر التفعيل الفوري المباشر.</p>
        </div>
        <div class="esim-info-card">
          <div class="esim-step-num">2</div>
          <h4>التحقق التلقائي وإصدار الشريحة</h4>
          <p class="muted">يطابق النظام إشعار الدفع تلقائياً وينفّذ تفعيل الباقة أو توليد شريحة الـ eSIM لدى شركة الاتصالات.</p>
        </div>
        <div class="esim-info-card">
          <div class="esim-step-num">3</div>
          <h4>مفعّل وجاهز مع كود QR</h4>
          <p class="muted">يظهر لك رقم الهاتف المخصّص وصورة كود eSIM QR وكود الـ LPA اليدوي جاهزة للمسح أو التحميل والطباعة.</p>
        </div>
      </div>

      <!-- Saved Orders on This Device -->
      <div class="esim-legal-panel">
        <div class="row between" style="flex-wrap:wrap;gap:8px;margin-bottom:12px">
          <div>
            <h3 style="margin:0">طلباتي المحفوظة على هذا الجهاز (${fmtNum(ordersList.length)})</h3>
            <small class="muted">يتم حفظ رموز طلباتك تلقائياً على متصفحك لسهولة الرجوع إلى كود الـ QR في أي وقت</small>
          </div>
        </div>

        ${ordersList.length ? `
          <div class="list">
            ${ordersList.map((o) => {
              const st = STAGES_AR[o.stage] || STAGES_AR[o.status] || STAGES_AR.awaiting_payment;
              const hasQr = Boolean(o.esimQr && /^data:image\//.test(o.esimQr));
              return `
                <a href="#/order/${esc(o.code)}" class="item clickable" style="text-decoration:none;color:inherit">
                  <div class="item-top" style="justify-content:space-between;flex-wrap:wrap;gap:10px">
                    <div class="row" style="gap:12px">
                      <span class="shop-brand-mark sm">${icon(o.esim ? 'qr' : 'sim')}</span>
                      <div>
                        <div class="item-title">
                          ${esc(o.packageLabel)}
                          ${o.esim ? `<span class="pill plain" style="margin-inline-start:6px;background:var(--primary-soft);color:var(--primary)">eSIM QR</span>` : ''}
                          ${hasQr ? `<span class="pill s-done" style="margin-inline-start:4px">كود QR جاهز</span>` : ''}
                        </div>
                        <div class="item-sub">
                          <span>رمز الطلب: <b class="ltr mono">${esc(o.code)}</b></span>
                          ${o.number ? `<span>· الرقم: <b class="ltr mono">${esc(fmtPhone(o.number))}</b></span>` : ''}
                          <span>· ${fmtDateTime(o.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                    <div style="text-align:end;display:grid;gap:4px;justify-items:end">
                      <b class="mono">${fmtMoney(o.amount)}</b>
                      <span class="pill ${st.cls}">${esc(st.label)}</span>
                    </div>
                  </div>
                </a>`;
            }).join('')}
          </div>
        ` : `
          <div class="empty" style="padding:24px 16px">
            ${icon('list')}
            <b>لا توجد طلبات محفوظة على هذا المتصفح بعد</b>
            <span>إذا كان لديك رمز طلب سابق، أدخله في مربع البحث أعلاه لعرض حالته وكود الـ QR الخاص به.</span>
          </div>
        `}
      </div>
    </section>
  `, { sub: 'تتبّع حالة طلب' });

  const form = document.getElementById('track-page-form');
  const errBox = document.getElementById('track-inline-error');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const raw = (new FormData(form).get('code') || '').trim().toUpperCase();
      if (!raw) return;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      errBox.innerHTML = '';
      try {
        const order = await jfetch(`/api/shop/orders/${encodeURIComponent(raw)}`);
        rememberOrderCode(order.code);
        S.myCodes = savedOrderCodes();
        S.myOrders = null;
        S.order = order;
        location.hash = `#/order/${encodeURIComponent(order.code)}`;
      } catch (err) {
        errBox.innerHTML = `<div class="msg" style="margin-top:10px">${icon('alert')}<span>لم يتم العثور على طلب بالرمز <b class="ltr mono">${esc(raw)}</b> — تأكد من كتابة الرمز بشكل صحيح.</span></div>`;
        btn.disabled = false;
      }
    };
  }
}

// ============================================================================
// Store Catalog & Checkout
// ============================================================================
async function ensureCatalog() {
  if (!S.data) S.data = await jfetch('/api/shop');
  if (S.data?.appName) document.title = `متجر ${S.data.appName}`;
}

function viewCatalog() {
  if (!S.data.enabled) {
    shell(`
      <div class="card empty">
        ${icon('clock')}
        <p>المتجر مغلق مؤقتاً للصيانة والتحديث — يرجى المحاولة لاحقاً.</p>
      </div>
    `);
    return;
  }

  const companies = S.data.companies || [];
  const packages = S.data.packages || [];
  const coMap = new Map(companies.map((c) => [c.id, c]));

  // Counts per service type
  const totalCount = packages.length;
  const esimCount = packages.filter((p) => isEsimPkg(p)).length;
  const cardCount = packages.filter((p) => p.kind === 'card').length;

  // Filtered packages
  const q = S.q.trim().toLowerCase();
  const shown = packages.filter((p) => {
    if (S.companyId !== 'all' && String(p.companyId) !== String(S.companyId)) return false;
    if (S.kindFilter === 'esim' && !isEsimPkg(p)) return false;
    if (S.kindFilter === 'card' && p.kind !== 'card') return false;
    if (q) {
      const coName = coMap.get(p.companyId)?.name || p.companyName || '';
      const hay = `${p.name} ${p.description || ''} ${p.tag || ''} ${coName} ${pkgGb(p) || ''} ${p.days || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Sort: featured/popular first, then price ascending
  shown.sort((a, b) => {
    if (isFeaturedPkg(b) !== isFeaturedPkg(a)) return (isFeaturedPkg(b) ? 1 : 0) - (isFeaturedPkg(a) ? 1 : 0);
    return Number(a.price || 0) - Number(b.price || 0);
  });

  const maxGb = Math.max(100, ...packages.map((p) => pkgGb(p)));

  shell(`
    <!-- Signature H-SIM & Telecom Hero -->
    <section class="esim-hero">
      <div class="esim-hero-grid">
        <div class="esim-hero-copy">
          <div class="esim-hero-kicker">
            <span class="kicker-monogram ltr">H-SIM</span>
            <span>الجيل الرقمي لشرائح الاتصال والباقات الفورية</span>
          </div>
          <h1>${esc(S.data.shopTitle || 'اتصالك يبدأ من شاشتك — شرائح eSIM بكود QR فوري وباقات خليوي بسعر صريح')}</h1>
          <p>
            ${esc(S.data.shopSubtitle || 'ودّع انتظار الشرائح التقليدية؛ انتقِ شبكتك وباقتك، استلم شريحة eSIM الرقمية الجاهزة للمسح فوراً على شاشتك، أو جدّد باقة رقمك الحالي في ثوانٍ بميثاق ضمان كامل.')}
          </p>

          <div class="esim-search-box" role="search">
            <span class="esim-search-ic">${icon('search')}</span>
            <input id="shop-q" type="search" value="${esc(S.q)}" placeholder="ابحث باسم الباقة، سعة الإنترنت (مثال: 100 GB)، أو اسم الشبكة..." autocomplete="off">
            ${S.q ? `<button type="button" class="icon-btn sm" id="shop-q-clear" aria-label="مسح البحث">${icon('x')}</button>` : ''}
          </div>

          <div class="esim-hero-actions">
            <button type="button" class="esim-hero-btn primary" data-act="nav-esim">
              ${icon('qr')}
              <span>إصدار شريحة eSIM فورية</span>
            </button>
            <a href="#/compat" class="esim-hero-btn ghost">
              ${icon('chip')}
              <span>افحص توافق هاتفك</span>
            </a>
            <a href="#/track" class="esim-hero-btn ghost">
              ${icon('search')}
              <span>متابعة طلب أو استلام QR</span>
            </a>
          </div>

          <div class="esim-trust-row">
            <span>${icon('qr')} كود eSIM QR جاهز للمسح فوراً</span>
            <span>${icon('shield')} تسعير نهائي صريح بدون عمولات مخفية</span>
            <span>${icon('checkCircle')} ميثاق ضمان التفعيل 100%</span>
          </div>
        </div>

        <!-- Bespoke H-SIM Digital Pass Card Showcase -->
        <div class="esim-hero-card-wrap" aria-hidden="true">
          <div class="esim-showcase-card">
            <div class="esim-showcase-top">
              <div>
                <span class="esim-showcase-tag">H-SIM DIGITAL PASS</span>
                <strong>شريحة اتصال رقمية ذكية</strong>
              </div>
              <div class="esim-showcase-emblems">
                ${esimChipSvg('esim-chip-svg lg')}
                ${brandLogoSvg('hsim-logo-svg lg')}
              </div>
            </div>

            <div class="esim-showcase-specs">
              <div><small>الجيل الشبكي</small><b class="ltr">4G LTE / 5G</b></div>
              <div><small>آلية التثبيت</small><b>مسح QR مباشر</b></div>
              <div><small>التوافق القياسي</small><b class="ltr">iOS · Android</b></div>
            </div>

            <div class="esim-pass-journey">
              <div class="esim-pass-step">
                <i class="ltr">01</i>
                <span>انتقِ الباقة</span>
              </div>
              <span class="esim-pass-arrow">←</span>
              <div class="esim-pass-step">
                <i class="ltr">02</i>
                <span>أكّد الدفع</span>
              </div>
              <span class="esim-pass-arrow">←</span>
              <div class="esim-pass-step active">
                <i class="ltr">03</i>
                <span>امسح الـ QR واتصل</span>
              </div>
            </div>

            <div class="esim-showcase-foot">
              <span class="esim-showcase-status"><i class="shop-live-dot"></i> بوابة التفعيل المباشر متاحة الآن</span>
              <span class="mono ltr" style="font-size:.75rem;opacity:.85">H-SIM // QR-READY</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Service Type Filter & Carrier Strip -->
    <section id="esim-plans-anchor" class="esim-controls">
      <div class="esim-type-tabs" role="tablist" aria-label="نوع الخدمة">
        <button type="button" role="tab" class="esim-type-tab" aria-selected="${S.kindFilter === 'all'}" data-kind="all">
          ${icon('sim')}
          <span>جميع الباقات والشرائح</span>
          <small>${fmtNum(totalCount)}</small>
        </button>
        <button type="button" role="tab" class="esim-type-tab esim-tab-accent" aria-selected="${S.kindFilter === 'esim'}" data-kind="esim">
          ${icon('qr')}
          <span>شرائح eSIM فورية</span>
          <small>${fmtNum(esimCount)}</small>
        </button>
        ${cardCount ? `
          <button type="button" role="tab" class="esim-type-tab" aria-selected="${S.kindFilter === 'card'}" data-kind="card">
            ${icon('refresh')}
            <span>شحن وتجديد رقمي الحالي</span>
            <small>${fmtNum(cardCount)}</small>
          </button>` : ''}
      </div>

      ${companies.length > 1 ? `
        <div class="esim-carrier-strip" role="tablist" aria-label="شركات الاتصالات">
          <button type="button" class="esim-carrier-pill" aria-pressed="${S.companyId === 'all'}" data-co="all">
            <span class="esim-carrier-all-ic">${icon('grid')}</span>
            <span class="esim-carrier-meta">
              <b>كل الشبكات المعتمدة</b>
              <small>${fmtNum(totalCount)} باقة متاحة</small>
            </span>
          </button>
          ${companies.map((c) => {
            const cPkgs = packages.filter((p) => p.companyId === c.id);
            const hasEsim = cPkgs.some((p) => isEsimPkg(p));
            return `
              <button type="button" class="esim-carrier-pill" aria-pressed="${String(S.companyId) === String(c.id)}" data-co="${c.id}" style="--co:${esc(c.color || '#2563eb')}">
                ${companyLogo(c, 'sm')}
                <span class="esim-carrier-meta">
                  <b>${esc(c.name)}</b>
                  <small>${fmtNum(cPkgs.length)} باقة${hasEsim ? ' · تدعم H-eSIM' : ''}</small>
                </span>
              </button>`;
          }).join('')}
        </div>
      ` : ''}
    </section>

    <!-- Bespoke SIM-Pass Package Cards Grid -->
    ${shown.length ? `
      <section class="esim-grid" aria-label="قائمة الباقات">
        ${shown.map((pk) => renderPlanCard(pk, coMap.get(pk.companyId), maxGb)).join('')}
      </section>
    ` : `
      <div class="card empty">
        ${icon('sim')}
        <p>لا توجد باقات مطابقة لخيارات البحث الحالية</p>
        <button type="button" class="btn ghost btn-sm" id="reset-filters">إظهار كافة الباقات</button>
      </div>
    `}

    <!-- Signature Brand Identity & Pillars Strip -->
    <section class="esim-brand-pillars" aria-label="مميزات وميثاق المنصة">
      <div class="esim-pillar-card">
        <div class="esim-pillar-ic">${brandLogoSvg('hsim-logo-svg sm')}</div>
        <div>
          <h3>تقنية H-SIM الرقمية الفورية</h3>
          <p class="muted">إصدار مباشر لشريحتك الإلكترونية بكود QR جاهز للمسح وكود تفعيل LPA يدوي مع رقمك المخصّص دون انتظار توصيل.</p>
        </div>
      </div>
      <div class="esim-pillar-card">
        <div class="esim-pillar-ic">${icon('shield')}</div>
        <div>
          <h3>تسعير صريح من أول نظرة</h3>
          <p class="muted">السعر المعلَن على كل باقة هو السعر الحقيقي بالشيكل، مع توضيح رسوم إصدار كود الـ QR لكل شبكة بشفافية تامة قبل الدفع.</p>
        </div>
      </div>
      <div class="esim-pillar-card">
        <div class="esim-pillar-ic">${icon('checkCircle')}</div>
        <div>
          <h3>ميثاق ضمان التشغيل 100%</h3>
          <p class="muted">حقّك محفوظ بالكامل؛ نضمن لك تفعيل الباقة وعمل شريحة الـ eSIM بكفاءة على هاتفك المتوافق أو استرجاع المبلغ فوراً.</p>
        </div>
      </div>
    </section>
  `);

  // Bind search & filter events
  const qInput = document.getElementById('shop-q');
  if (qInput) {
    qInput.oninput = (e) => {
      S.q = e.currentTarget.value;
      const pos = e.currentTarget.selectionStart;
      viewCatalog();
      const next = document.getElementById('shop-q');
      if (next) { next.focus(); try { next.setSelectionRange(pos, pos); } catch {} }
    };
  }
  const qClear = document.getElementById('shop-q-clear');
  if (qClear) {
    qClear.onclick = () => { S.q = ''; viewCatalog(); };
  }
  const resetBtn = document.getElementById('reset-filters');
  if (resetBtn) {
    resetBtn.onclick = () => { S.companyId = 'all'; S.kindFilter = 'all'; S.q = ''; viewCatalog(); };
  }
  root.querySelectorAll('[data-kind]').forEach((b) => {
    b.onclick = () => { S.kindFilter = b.dataset.kind; viewCatalog(); };
  });
  root.querySelectorAll('[data-co]').forEach((b) => {
    b.onclick = () => { S.companyId = b.dataset.co; viewCatalog(); };
  });
}

function renderPlanCard(pk, co, maxGb) {
  const coColor = co?.color || '#2563eb';
  const hasEsim = isEsimPkg(pk);
  const featured = isFeaturedPkg(pk);
  const hasDiscount = Number(pk.oldPrice) > Number(pk.price);
  const savePct = hasDiscount ? Math.round(((pk.oldPrice - pk.price) / pk.oldPrice) * 100) : 0;
  const gbVal = pkgGb(pk);
  const gbPct = gbVal > 0 ? Math.min(100, Math.max(14, Math.round((gbVal / maxGb) * 100))) : 100;
  const daysVal = Number(pk.days) || 0;
  const perDay = daysVal >= 7 && pk.price > 0 ? (pk.price / daysVal).toFixed(1) : null;

  const callsLabel = pk.minutes
    ? `${fmtNum(pk.minutes)} دقيقة مكالمات${pk.sms ? ` · ${fmtNum(pk.sms)} رسالة` : ''}`
    : pk.tag || 'إنترنت ومكالمات حسب الباقة';

  const qrFee = Number(pk.esimFee ?? co?.esimFee ?? S.data?.esimFee ?? 0);
  const qrFeeText = hasEsim
    ? (qrFee > 0 ? `+ ${fmtMoney(qrFee)} لإصدار كود QR` : 'كود eSIM QR مشمول مجاناً')
    : 'شحن مباشر على شريحتك الحالية';
  const hasTwoBtns = pk.kind === 'card' && hasEsim;

  return `
    <article class="esim-card ${featured ? 'is-featured' : ''} ${hasEsim ? 'has-esim' : ''}" style="--co:${esc(coColor)}">
      <!-- Top Carrier & H-SIM Chip Header -->
      <div class="esim-card-head">
        <div class="esim-card-carrier">
          ${companyLogo(co || { name: pk.companyName }, 'sm')}
          <div class="esim-card-titles">
            <span class="esim-carrier-label">${esc(co?.name || pk.companyName || '')}</span>
            <h3 class="esim-plan-title">${esc(pk.name)}</h3>
          </div>
        </div>
        <div class="esim-card-emblem" title="${hasEsim ? 'تدعم شريحة H-eSIM الرقمية وكود QR' : 'شحن وتفعيل فوري'}">
          ${hasEsim ? `
            ${esimChipSvg('esim-chip-svg')}
            <span class="esim-chip-tag">H-eSIM QR</span>
          ` : `
            ${simCardSvg('esim-sim-svg')}
            <span class="esim-sim-tag">${pk.kind === 'card' ? 'شحن رقم' : 'باقة خط'}</span>
          `}
        </div>
      </div>

      ${featured || hasDiscount || pk.tag ? `
        <div class="esim-card-flags">
          ${featured ? `<span class="esim-flag featured">${icon('checkCircle')}<span>باقة مختارة</span></span>` : ''}
          ${hasDiscount ? `<span class="esim-flag discount">وفّر ${savePct}%</span>` : ''}
          ${pk.tag && !featured ? `<span class="esim-flag featured">${esc(pk.tag)}</span>` : ''}
        </div>
      ` : ''}

      <!-- Signature H-SIM Telecom Data & Validity Readout Banner -->
      <div class="esim-data-banner">
        <div class="esim-data-main">
          <div class="esim-data-col">
            <small>${icon('data')}<span>سعة الإنترنت</span></small>
            <strong class="ltr">${gbVal > 0 ? `${fmtNum(gbVal)} GB` : 'حسب الباقة'}</strong>
          </div>
          <div class="esim-data-sep" aria-hidden="true"></div>
          <div class="esim-data-col end">
            <small>${icon('clock')}<span>فترة التفعيل</span></small>
            <strong>${daysVal > 0 ? `${fmtNum(daysVal)} يوم` : 'شهرية'}</strong>
          </div>
        </div>
        ${gbVal > 0 ? `<div class="esim-gb-meter" aria-hidden="true"><span style="width:${gbPct}%"></span></div>` : ''}
      </div>

      <!-- Structured Specification Rows -->
      <div class="esim-spec-box">
        <div class="esim-spec-row">
          <span class="esim-spec-k">${icon('call')}<span>المكالمات والرسائل</span></span>
          <strong class="esim-spec-v">${esc(callsLabel)}</strong>
        </div>

        <div class="esim-spec-row ${hasEsim ? 'esim-qr-row' : ''}">
          <span class="esim-spec-k">${icon(hasEsim ? 'qr' : 'refresh')}<span>${hasEsim ? 'إصدار شريحة eSIM' : 'طريقة التفعيل'}</span></span>
          <strong class="esim-spec-v">${esc(qrFeeText)}</strong>
        </div>
      </div>

      ${pk.description ? `<p class="esim-plan-desc">${esc(pk.description)}</p>` : ''}

      <!-- Perforated SIM-Pass Price & Action Footer -->
      <div class="esim-card-foot">
        <div class="esim-price-row">
          <div class="esim-price-block">
            <span class="esim-price-label">السعر الصافي</span>
            ${perDay ? `<small class="esim-daily-hint">≈ ${perDay} ₪ / يوم</small>` : ''}
          </div>
          <div class="esim-price-val">
            ${hasDiscount ? `<s>${fmtMoney(pk.oldPrice)}</s>` : ''}
            <b>${fmtMoney(pk.price)}</b>
          </div>
        </div>

        <div class="esim-card-btns ${hasTwoBtns ? 'has-two' : 'has-one'}">
          ${hasTwoBtns ? `
            <a href="#/buy/${pk.id}" class="btn ghost">${icon('refresh')}<span>اشحن رقمي</span></a>
            <a href="#/buy/${pk.id}?esim=1" class="btn primary">${icon('qr')}<span>فعّل شريحة eSIM</span></a>
          ` : hasEsim ? `
            <a href="#/buy/${pk.id}?esim=1" class="btn primary">${icon('qr')}<span>إصدار شريحة eSIM الآن</span></a>
          ` : `
            <a href="#/buy/${pk.id}" class="btn primary">${icon('arrowL')}<span>تفعيل الباقة الآن</span></a>
          `}
        </div>
      </div>
    </article>
  `;
}

function viewBuy(id) {
  const pk = (S.data?.packages || []).find((p) => String(p.id) === String(id));
  if (!pk) { location.hash = '#/'; return; }
  const co = (S.data?.companies || []).find((c) => c.id === pk.companyId) || { name: pk.companyName };
  const isCard = pk.kind === 'card';
  const canEsim = Boolean(pk.esim);
  const wantEsim = canEsim && (S.wantEsim || !isCard);
  const qrFee = Number(pk.esimFee ?? co?.esimFee ?? S.data?.esimFee ?? 0);
  const total = Number(pk.price || 0) + (wantEsim ? qrFee : 0);

  if (wantEsim) {
    return esimForm(pk, co, isCard);
  }

  shell(`
    <form id="buy-f" class="card shop-form" style="--co:${esc(co?.color || '#2563eb')}">
      <div class="shop-card-topbar">
        <a href="#/" class="btn ghost btn-sm">→ العودة للباقات</a>
        ${canEsim ? `
          <button type="button" class="btn ghost btn-sm" data-act="compat-sheet">
            ${icon('chip')}<span>فحص توافق الجهاز مع eSIM</span>
          </button>` : ''}
      </div>

      <div class="shop-steps no-print" aria-label="مراحل الطلب">
        <span class="current"><i>1</i>بيانات المشترك</span>
        <span><i>2</i>تأكيد الدفع (Jawwal Pay)</span>
        <span><i>3</i>التفعيل واستلام الطلب</span>
      </div>

      <!-- Selected Package Header -->
      <div class="esim-checkout-head">
        <div class="row" style="gap:12px">
          ${companyLogo(co)}
          <div class="grow">
            <span class="esim-carrier-label">${esc(co?.name || '')}</span>
            <h2 style="margin:2px 0 4px">${esc(pk.name)}</h2>
            <div class="chips">${specs(pk)}</div>
          </div>
        </div>
        ${pk.description ? `<p class="muted" style="margin:8px 0 0;font-size:.88rem">${esc(pk.description)}</p>` : ''}
      </div>

      ${canEsim && isCard ? `
        <div class="field">
          <label>اختر طريقة التفعيل المطلوبة</label>
          <div class="shop-mode-cards" role="radiogroup" aria-label="طريقة التفعيل">
            <button type="button" class="shop-mode-card" data-esim="0" aria-pressed="true">
              <div class="row between">
                ${icon('refresh')}
                <span class="mono">${fmtMoney(pk.price)}</span>
              </div>
              <b>شحن وتجديد رقمي الحالي</b>
              <small>شحن الباقة مباشرة على شريحتك الحالية دون تغييرها</small>
            </button>
            <button type="button" class="shop-mode-card" data-esim="1" aria-pressed="false">
              <div class="row between">
                ${icon('qr')}
                <span class="mono">${fmtMoney(pk.price + qrFee)}</span>
              </div>
              <b>شريحة eSIM إلكترونية (كود QR)</b>
              <small>${qrFee > 0 ? `شامل رسوم كود QR (${fmtMoney(qrFee)})` : 'كود QR مجاني مع الباقة'}</small>
            </button>
          </div>
        </div>
      ` : ''}

      <div class="field">
        <label for="f-name">الاسم الكامل</label>
        <input id="f-name" name="customerName" class="input" required autocomplete="name" placeholder="الاسم كما سيظهر في الطلب">
      </div>

      <div class="field">
        <label for="f-phone">${isCard ? 'رقم الهاتف المراد شحنه بالباقة' : 'رقم الهاتف'}</label>
        <input id="f-phone" name="number" class="input ltr" inputmode="tel" autocomplete="tel" required placeholder="059XXXXXXX">
      </div>

      ${!isCard ? `
        <div class="field">
          <label for="f-sim">رقم الشريحة ICCID (19 رقماً)</label>
          <input id="f-sim" name="sim" class="input ltr" inputmode="numeric" required placeholder="89970...">
        </div>
      ` : ''}

      <div class="field">
        <label for="f-contact">رقم للتواصل عبر واتساب <span class="muted">(اختياري)</span></label>
        <input id="f-contact" name="contactPhone" class="input ltr" inputmode="tel" autocomplete="tel" placeholder="059XXXXXXX">
      </div>

      <!-- Transparent Price Breakdown -->
      <div class="shop-breakdown-box">
        <h4>${icon('shield')}<span>ملخص السعر الشامل</span></h4>
        <div class="shop-bd-row">
          <span>سعر الباقة (${esc(pk.name)})</span>
          <b class="mono">${fmtMoney(pk.price)}</b>
        </div>
        <div class="shop-bd-total">
          <span>المبلغ الإجمالي النهائي</span>
          <b class="mono">${fmtMoney(total)}</b>
        </div>
      </div>

      <!-- Legal Consent -->
      <div class="esim-consent-wrap">
        <label class="esim-consent-label">
          <input type="checkbox" name="consent" required>
          <span>أقرّ بصحة الرقم المدخل وبموافقتي على شروط التفعيل.</span>
        </label>
        <button type="button" class="btn ghost btn-sm" data-act="legal-sheet" data-tab="terms">${icon('shield')}<span>عرض الشروط والضمان</span></button>
      </div>

      <button class="btn primary lg" type="submit">
        ${icon('checkCircle')}
        <span>المتابعة إلى خطوة تأكيد الدفع (${fmtMoney(total)})</span>
      </button>
    </form>
  `, { sub: pk.name });

  root.querySelectorAll('[data-esim]').forEach((b) => {
    b.onclick = () => {
      S.wantEsim = b.dataset.esim === '1';
      viewBuy(id);
    };
  });

  document.getElementById('buy-f').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    const fd = new FormData(f);
    try {
      const order = await jfetch('/api/shop/orders', {
        method: 'POST',
        body: {
          packageId: pk.id,
          kind: isCard ? 'recharge' : 'new',
          customerName: fd.get('customerName'),
          number: fd.get('number'),
          sim: fd.get('sim') || '',
          contactPhone: fd.get('contactPhone') || '',
        },
      });
      rememberOrderCode(order.code);
      S.myCodes = savedOrderCodes();
      S.myOrders = null;
      S.order = order;
      location.hash = `#/order/${order.code}`;
    } catch (err) {
      notify(err.message, true);
      btn.disabled = false;
    }
  };
}

// eSIM checkout: checks /api/shop/available, shows full price + QR fee breakdown, and creates eSIM order
async function esimForm(pk, co, canSwitchToCard = false) {
  const qrFee = Number(pk.esimFee ?? co?.esimFee ?? S.data?.esimFee ?? 0);
  const total = Number(pk.price || 0) + qrFee;

  shell(`<div class="card empty"><p class="muted">جارٍ التحقق من توفّر شرائح eSIM للباقة...</p></div>`, { sub: pk.name });
  if (S.esimAvailable === null || S.esimAvailable.pkgId !== pk.id) {
    try {
      const r = await jfetch(`/api/shop/available?packageId=${encodeURIComponent(pk.id)}`);
      S.esimAvailable = { pkgId: pk.id, available: Boolean(r.available) };
    } catch (err) {
      S.esimAvailable = { pkgId: pk.id, available: false, error: err.message };
    }
  }
  const available = S.esimAvailable.available;

  shell(`
    <form id="buy-f" class="card shop-form" style="--co:${esc(co?.color || '#2563eb')}">
      <div class="shop-card-topbar">
        <a href="#/" class="btn ghost btn-sm">→ العودة للباقات</a>
        <button type="button" class="btn ghost btn-sm" data-act="compat-sheet">
          ${icon('chip')}<span>فحص توافق الجهاز مع eSIM</span>
        </button>
      </div>

      <div class="shop-steps no-print" aria-label="مراحل الطلب">
        <span class="current"><i>1</i>بيانات المشترك</span>
        <span><i>2</i>تأكيد الدفع (Jawwal Pay)</span>
        <span><i>3</i>استلام كود eSIM QR</span>
      </div>

      <div class="esim-checkout-head">
        <div class="row" style="gap:12px">
          ${companyLogo(co)}
          <div class="grow">
            <span class="esim-carrier-label">${esc(co?.name || '')} · شريحة eSIM رقمية فورية</span>
            <h2 style="margin:2px 0 4px">${esc(pk.name)}</h2>
            <div class="chips">${specs(pk)}</div>
          </div>
          ${esimChipSvg('esim-chip-svg')}
        </div>
        ${pk.description ? `<p class="muted" style="margin:8px 0 0;font-size:.88rem">${esc(pk.description)}</p>` : ''}
      </div>

      ${canSwitchToCard ? `
        <div class="field">
          <label>اختر طريقة التفعيل المطلوبة</label>
          <div class="shop-mode-cards" role="radiogroup" aria-label="طريقة التفعيل">
            <button type="button" class="shop-mode-card" data-esim="0" aria-pressed="false">
              <div class="row between">
                ${icon('refresh')}
                <span class="mono">${fmtMoney(pk.price)}</span>
              </div>
              <b>شحن وتجديد رقمي الحالي</b>
              <small>شحن الباقة مباشرة على شريحتك الحالية دون تغييرها</small>
            </button>
            <button type="button" class="shop-mode-card" data-esim="1" aria-pressed="true">
              <div class="row between">
                ${icon('qr')}
                <span class="mono">${fmtMoney(total)}</span>
              </div>
              <b>شريحة eSIM إلكترونية (كود QR)</b>
              <small>${qrFee > 0 ? `شامل رسوم كود QR (${fmtMoney(qrFee)})` : 'كود QR مجاني مع الباقة'}</small>
            </button>
          </div>
        </div>
      ` : ''}

      ${available ? `
        <div class="esim-ready-notice">
          ${icon('qr')}
          <div class="grow">
            <b>حجز فوري للرقم وتوليد كود QR بعد تأكيد الدفع</b>
            <small class="muted" style="display:block">يُحجز لك رقم جديد لمدة 30 دقيقة، وفور تأكيد تحويل المبلغ بالخطوة التالية يظهر كود الـ QR الخاص بشريحتك مباشرة على الشاشة.</small>
          </div>
        </div>
      ` : `
        <div class="card empty">
          ${icon('alert')}
          <p>${esc(S.esimAvailable.error || 'نفدت أرقام eSIM لهذه الباقة الآن — جرّب باقة أخرى أو تواصل مع الدعم.')}</p>
        </div>
      `}

      <div class="field">
        <label for="f-name">الاسم الكامل</label>
        <input id="f-name" name="customerName" class="input" required autocomplete="name" placeholder="الاسم الثلاثي لتسجيل الخط">
      </div>

      <div class="field">
        <label for="f-email">البريد الإلكتروني <span class="muted">(مستحسن — نرسل لك عليه نسخة من كود الـ QR أيضاً)</span></label>
        <input id="f-email" name="email" type="email" class="input ltr" autocomplete="email" placeholder="you@example.com">
      </div>

      <div class="field">
        <label for="f-contact">رقم للتواصل عبر واتساب <span class="muted">(اختياري)</span></label>
        <input id="f-contact" name="contactPhone" class="input ltr" inputmode="tel" autocomplete="tel" placeholder="059XXXXXXX">
      </div>

      <div class="shop-breakdown-box">
        <h4>${icon('shield')}<span>ملخص السعر الشامل</span></h4>
        <div class="shop-bd-row">
          <span>سعر الباقة (${esc(pk.name)})</span>
          <b class="mono">${fmtMoney(pk.price)}</b>
        </div>
        <div class="shop-bd-row">
          <span>رسوم إصدار كود eSIM QR (${esc(co?.name || '')})</span>
          <b class="mono">${qrFee > 0 ? fmtMoney(qrFee) : 'مشمول بالسعر'}</b>
        </div>
        <div class="shop-bd-total">
          <span>المبلغ الإجمالي النهائي</span>
          <b class="mono">${fmtMoney(total)}</b>
        </div>
      </div>

      <div class="esim-consent-wrap">
        <label class="esim-consent-label">
          <input type="checkbox" name="consent" required>
          <span>أؤكد أن هاتفي يدعم شريحة eSIM ومفتوح الشبكة وأوافق على شروط التفعيل.</span>
        </label>
        <button type="button" class="btn ghost btn-sm" data-act="legal-sheet" data-tab="esim">${icon('shield')}<span>سياسة eSIM والضمان</span></button>
      </div>

      <button class="btn primary lg" type="submit" ${available ? '' : 'disabled'}>
        ${icon('checkCircle')}
        <span>المتابعة إلى خطوة تأكيد الدفع (${fmtMoney(total)})</span>
      </button>
    </form>
  `, { sub: pk.name });

  root.querySelectorAll('[data-esim]').forEach((b) => {
    b.onclick = () => {
      S.wantEsim = b.dataset.esim === '1';
      viewBuy(pk.id);
    };
  });

  document.getElementById('buy-f').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    const fd = new FormData(f);
    try {
      const order = await jfetch('/api/shop/orders', {
        method: 'POST',
        body: {
          kind: 'esim',
          esim: true,
          includeEsimFee: qrFee > 0,
          packageId: pk.id,
          customerName: fd.get('customerName'),
          email: fd.get('email') || '',
          contactPhone: fd.get('contactPhone') || '',
        },
      });
      S.esimAvailable = null;
      rememberOrderCode(order.code);
      S.myCodes = savedOrderCodes();
      S.myOrders = null;
      S.order = order;
      location.hash = `#/order/${order.code}`;
    } catch (err) {
      notify(err.message, true);
      S.esimAvailable = null;
      btn.disabled = false;
    }
  };
}

const STAGES_AR = {
  awaiting_payment: { label: 'الخطوة ٢: بانتظار تحويل المبلغ وتأكيد الدفع', cls: 's-open', step: 1, desc: 'حوّل المبلغ عبر تطبيق جوال باي (Jawwal Pay) ثم أدخل رقم الحركة أو بيانات التحويل في نموذج تأكيد الدفع أدناه.' },
  verifying: { label: 'جارٍ التحقق التلقائي من التحويل…', cls: 's-open', step: 2, desc: 'يبحث النظام عن إشعار جوال باي المطابق لتفعيل خطك وإصدار كود QR تلقائياً.' },
  review: { label: 'قيد المراجعة والتفعيل من فريق المتجر', cls: 's-open', step: 2, desc: 'يراجع فريق المتجر إشعار التحويل لتفعيل طلبك في أسرع وقت.' },
  processing: { label: 'تم استلام الدفع — جارٍ التفعيل وإصدار الشريحة…', cls: 's-open', step: 2, desc: 'وصلنا المبلغ ونفعّل خطك الآن لدى شركة الاتصالات. سيظهر رمز QR هنا فور جهوزه.' },
  paid_issue: { label: 'تم استلام الدفع — قيد المعالجة الفنية', cls: 's-open', step: 2, desc: 'وصلنا المبلغ ويتابع فريقنا إتمام التفعيل.' },
  done: { label: 'مفعّل وجاهز للاستخدام', cls: 's-done', step: 3, desc: 'تم تأكيد الدفع وتفعيل طلبك بنجاح.' },
  failed: { label: 'تعذّر التنفيذ — تواصل مع الدعم', cls: 's-bad', step: 0, desc: 'تواصل مع الدعم الفني لاسترجاع المبلغ أو إعادة المحاولة.' },
  rejected: { label: 'مرفوض — تواصل مع الدعم', cls: 's-bad', step: 0, desc: '' },
  cancelled: { label: 'ملغى', cls: 's-bad', step: 0, desc: '' },
};
const PAYABLE_STATUSES = ['awaiting_payment', 'verifying', 'review'];
const FINAL_STAGES = ['done', 'cancelled', 'rejected', 'failed'];

async function viewOrder(code) {
  clearInterval(S.pollTimer);
  try {
    S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(code)}`);
    rememberOrderCode(S.order.code);
    S.myCodes = savedOrderCodes();
  } catch (err) {
    shell(`
      <div class="card empty">
        ${icon('alert')}
        <p>${esc(err.message)}</p>
        <div class="row" style="gap:8px;justify-content:center;flex-wrap:wrap">
          <a href="#/track" class="btn ghost">تتبّع طلب آخر</a>
          <a href="#/" class="btn primary">العودة للمتجر</a>
        </div>
      </div>`);
    return;
  }
  renderOrder();
  if (!FINAL_STAGES.includes(S.order.stage)) {
    S.pollTimer = setInterval(async () => {
      if (document.querySelector('#proof-f :focus')) return;
      try {
        const next = await jfetch(`/api/shop/orders/${encodeURIComponent(code)}`);
        if (next.status !== S.order.status || next.stage !== S.order.stage || next.proofSent !== S.order.proofSent || next.esimQr !== S.order.esimQr) {
          S.order = next;
          renderOrder();
          if (FINAL_STAGES.includes(next.stage)) clearInterval(S.pollTimer);
        }
      } catch {}
    }, 6000);
  }
}

function renderOrder() {
  const o = S.order;
  const st = STAGES_AR[o.stage] || STAGES_AR[o.status] || STAGES_AR.awaiting_payment;
  const jp = S.data?.jawwalpay || {};
  const isEsim = Boolean(o.esim);
  const hasQr = Boolean(o.esimQr && /^data:image\//.test(o.esimQr));
  const payable = PAYABLE_STATUSES.includes(o.status);
  const wa = waHref(S.data?.supportWhatsapp, `مرحباً، بخصوص الطلب ${o.code}`);

  shell(`
    <!-- Order Summary Card -->
    <div class="card shop-status">
      <div class="shop-card-topbar no-print">
        <a href="#/" class="btn ghost btn-sm">← المتجر</a>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <button type="button" class="btn ghost btn-sm" id="copy-code">${icon('copy')}<span class="ltr">${esc(o.code)}</span></button>
          <button type="button" class="btn ghost btn-sm" id="print-order">${icon('print')}<span>طباعة الإيصال</span></button>
        </div>
      </div>

      <div class="shop-steps no-print" aria-label="مراحل الطلب">
        <span class="${st.step >= 1 ? 'done' : ''}"><i>1</i>بيانات المشترك</span>
        <span class="${st.step >= 3 ? 'done' : payable || st.step === 2 ? 'current' : ''}"><i>2</i>تأكيد الدفع (Jawwal Pay)</span>
        <span class="${st.step >= 3 || hasQr ? 'done' : ''}"><i>3</i>${isEsim ? 'استلام كود eSIM QR' : 'اكتمال التفعيل'}</span>
      </div>

      <div class="row between" style="flex-wrap:wrap;gap:10px">
        <div class="row" style="gap:10px">
          <span class="shop-brand-mark">${icon(isEsim ? 'qr' : 'sim')}</span>
          <div>
            <span class="esim-carrier-label">رمز الطلب: <b class="ltr mono">${esc(o.code)}</b></span>
            <h3 style="margin:2px 0">${esc(o.packageLabel)}${isEsim ? ' · eSIM' : ''}</h3>
            <small class="muted">${esc(o.customerName || '')} · ${o.number ? `<span class="ltr">${esc(fmtPhone(o.number))}</span>` : 'يظهر الرقم فور تأكيد الدفع والتفعيل'}</small>
          </div>
        </div>
        <b class="mono shop-amount">${fmtMoney(o.amount)}</b>
      </div>

      ${isEsim ? `
        <div class="shop-breakdown-box">
          <div class="shop-bd-row">
            <span>سعر الباقة الأساسي</span>
            <b class="mono">${fmtMoney(o.packagePrice ?? o.amount)}</b>
          </div>
          <div class="shop-bd-row">
            <span>رسوم كود eSIM QR</span>
            <b class="mono">${Number(o.esimFee) > 0 ? fmtMoney(o.esimFee) : 'مشمول بالسعر'}</b>
          </div>
        </div>
      ` : ''}

      <div class="row between" style="flex-wrap:wrap;gap:8px">
        <span class="pill ${st.cls}">${esc(st.label)}</span>
        <small class="muted">${fmtDateTime(o.createdAt)}</small>
      </div>
      ${st.desc ? `<p class="muted" style="margin:0;font-size:.88rem">${esc(st.desc)}</p>` : ''}
      ${o.response ? `<div class="esim-ready-notice">${icon('info')}<span>${esc(o.response)}</span></div>` : ''}
      ${o.expiresAt ? `<div class="shop-kv"><span>صلاحية الباقة حتى</span><b>${fmtDate(o.expiresAt)}</b></div>` : ''}
      ${o.status === 'awaiting_payment' ? `
        <div class="row no-print" style="justify-content:flex-end">
          <button type="button" class="btn ghost btn-sm" id="cancel-order-btn">إلغاء الطلب</button>
        </div>` : ''}
    </div>

    <!-- Step 2: Jawwal Pay Payment & Confirmation Box -->
    ${payable ? `
      <div class="card shop-pay no-print">
        <h3>١. حوّل المبلغ عبر تطبيق جوال باي (Jawwal Pay)</h3>
        <p class="muted" style="margin:0">
          حوّل المبلغ المحدّد بالضبط بتحويل واحد إلى المحفظة التالية.${o.reservedUntil ? ` رقمك محجوز لك حتى <b>${fmtTime(o.reservedUntil)}</b>.` : ''}
        </p>
        <div class="shop-pay-kvs">
          <div class="shop-kv">
            <span>المبلغ المطلوب تحويله</span>
            <b class="ltr mono">${fmtMoney(o.amount)}</b>
            <button type="button" class="btn ghost btn-sm" data-copy="${esc(String(o.amount))}">${icon('copy')}<span>نسخ</span></button>
          </div>
          ${jp.number ? `
            <div class="shop-kv">
              <span>إلى رقم محفظة جوال باي</span>
              <b class="ltr mono">${esc(fmtPhone(jp.number))}</b>
              <button type="button" class="btn ghost btn-sm" data-copy="${esc(jp.number)}">${icon('copy')}<span>نسخ</span></button>
            </div>
          ` : ''}
          ${jp.name ? `
            <div class="shop-kv">
              <span>باسم المستلم</span>
              <b>${esc(jp.name)}</b>
            </div>
          ` : ''}
        </div>

        <hr style="border:0;border-top:1px solid var(--line);margin:4px 0">

        <h3>٢. ${o.proofSent ? 'تحديث بيانات تأكيد الدفع' : 'تأكيد الدفع لتفعيل الطلب تلقائياً'}</h3>
        <p class="muted" style="margin:0;font-size:.85rem">
          أدخل <b>رقم الحركة</b> من رسالة جوال باي (أسرع طريقة للمطابقة الفورية وإظهار كود الـ QR)، أو اسم المحوِّل، أو ارفع صورة الإشعار:
        </p>

        <form id="proof-f" class="form" style="margin-top:6px">
          <div class="field">
            <label for="f-ref">رقم الحركة في جوال باي (Reference No.)</label>
            <input id="f-ref" name="payReference" class="input ltr" inputmode="numeric" autocomplete="off" placeholder="مثال: 2922...">
          </div>
          <div class="field">
            <label for="f-pname">أو: اسم المحوِّل كما يظهر في جوال باي</label>
            <input id="f-pname" name="payName" class="input" autocomplete="name" placeholder="الاسم الكامل">
          </div>
          <div class="field">
            <label for="f-payer">رقم محفظة جوال باي المحوَّل منها <span class="muted">(اختياري)</span></label>
            <input id="f-payer" name="payPhone" class="input ltr" inputmode="tel" placeholder="059XXXXXXX">
          </div>
          <div class="field">
            <label>صورة إشعار التحويل <span class="muted">(اختياري — تساعد في تسريع المراجعة)</span></label>
            <label class="upload-box" id="proof-box">
              <input id="f-proof" type="file" accept="image/*" hidden>
              ${icon('image')}
              <span id="proof-label">${o.proofSent ? 'تم إرسال الإشعار — اضغط لاستبداله' : 'اضغط لاختيار لقطة شاشة لإشعار Jawwal Pay'}</span>
            </label>
          </div>
          <button class="btn primary lg" type="submit">${icon('checkCircle')}<span>${o.proofSent ? 'تحديث بيانات تأكيد الدفع' : 'أرسلت المبلغ — تأكيد الدفع وتفعيل الطلب'}</span></button>
        </form>
      </div>
    ` : ''}

    <!-- Step 3: Scannable eSIM QR Code Pass (shown once payment is confirmed and esimQr is ready) -->
    ${hasQr ? `
      <div class="card shop-qr-modern">
        <div class="shop-qr-badge">
          ${icon('checkCircle')}
          <span>تم تأكيد الدفع — شريحة eSIM مفعّلة وجاهزة للمسح</span>
        </div>

        <h3 style="margin:0">امسح كود الـ QR لتثبيت شريحة eSIM على هاتفك</h3>
        <p class="muted" style="margin:0">
          تأكد من اتصال هاتفك بالـ Wi-Fi، ثم افتح الكاميرا أو إعدادات الخليوي وامسح الكود التالي:
        </p>

        <div class="shop-qr-frame">
          <img id="qr-img" src="${esc(o.esimQr)}" alt="كود QR لتفعيل شريحة eSIM للرقم ${esc(o.number || '')}">
        </div>

        <div class="esim-qr-details">
          ${o.number ? `
            <div class="shop-kv">
              <span>رقم الخط المخصّص</span>
              <b class="ltr mono">${esc(fmtPhone(o.number))}</b>
              <button type="button" class="btn ghost btn-sm no-print" data-copy="${esc(o.number)}">${icon('copy')}<span>نسخ</span></button>
            </div>
          ` : ''}
        </div>

        ${o.esimCode ? `
          <div class="shop-lpa-box no-print">
            <small class="muted">كود التفعيل اليدوي (LPA / Activation Code) في حال التثبيت من نفس الجهاز:</small>
            <div class="shop-lpa-row">
              <code class="ltr">${esc(o.esimCode)}</code>
              <button type="button" class="btn ghost btn-sm" data-copy="${esc(o.esimCode)}">${icon('copy')}<span>نسخ الكود</span></button>
            </div>
          </div>
        ` : ''}

        <div class="row no-print" style="justify-content:center;gap:10px;flex-wrap:wrap">
          <a class="btn primary" href="${esc(o.esimQr)}" download="esim-${esc(o.number || o.code)}.png">
            ${icon('download')}<span>تحميل صورة كود QR</span>
          </a>
          <button type="button" class="btn ghost" id="print-qr-btn">
            ${icon('print')}<span>طباعة بطاقة الشريحة</span>
          </button>
        </div>

        ${o.qrMailed ? `<p class="muted" style="margin:0;font-size:.84rem">${icon('checkCircle')} تم إرسال نسخة من رمز QR إلى <span class="ltr">${esc(o.email)}</span></p>` : ''}

        <!-- Step-by-step Installation Guide -->
        <div class="shop-qr-guides">
          <div class="shop-qr-guide-col">
            <b>خطوات التثبيت على iPhone (iOS):</b>
            <ol>
              <li>افتح <b>الإعدادات (Settings)</b> ثم <b>خلوي (Cellular)</b>.</li>
              <li>اضغط على <b>إضافة شريحة إلكترونية (Add eSIM)</b> ثم <b>استخدام رمز QR</b>.</li>
              <li>وجّه الكاميرا نحو الكود أعلاه وأكمل التثبيت (لا تحذف الشريحة بعد إضافتها).</li>
            </ol>
          </div>
          <div class="shop-qr-guide-col">
            <b>خطوات التثبيت على Android (Samsung / Pixel):</b>
            <ol>
              <li>افتح <b>الضبط (Settings)</b> ثم <b>الاتصالات (Connections)</b> ثم <b>إدارة SIM</b>.</li>
              <li>اختر <b>إضافة eSIM (Add eSIM)</b> ثم <b>مسح رمز QR من مزود الخدمة</b>.</li>
              <li>امسح الكود أعلاه وانتظر بضع ثوانٍ حتى يكتمل تنزيل الشريحة.</li>
            </ol>
          </div>
        </div>
      </div>
    ` : ''}

    ${o.stage === 'done' && !hasQr ? `
      <div class="card empty">
        ${icon('checkCircle')}
        <p>تمّ تأكيد الدفع وتفعيل باقتك بنجاح — شكراً لثقتك بنا.</p>
        <a href="#/" class="btn ghost">العودة للمتجر</a>
      </div>
    ` : ''}

    ${wa ? `<a class="btn ghost no-print" style="justify-self:center" href="${esc(wa)}" target="_blank" rel="noopener">${icon('whatsapp')}<span>تواصل مع الدعم بخصوص هذا الطلب</span></a>` : ''}
  `, { sub: `طلب ${o.code}` });

  const copyCode = document.getElementById('copy-code');
  if (copyCode) copyCode.onclick = () => copyText(o.code);
  const printBtn = document.getElementById('print-order');
  if (printBtn) printBtn.onclick = () => window.print();
  const printQrBtn = document.getElementById('print-qr-btn');
  if (printQrBtn) printQrBtn.onclick = () => window.print();

  root.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => copyText(b.dataset.copy);
  });

  const cancelBtn = document.getElementById('cancel-order-btn');
  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      try {
        S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}/cancel`, { method: 'POST' });
        notify('تم إلغاء الطلب');
        renderOrder();
      } catch (err) {
        notify(err.message, true);
      }
    };
  }

  const fileInput = document.getElementById('f-proof');
  let proofData = '';
  if (fileInput) {
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        proofData = await fileToDataUrl(file, { max: 1400 });
        document.getElementById('proof-label').textContent = `تم إرفاق: ${file.name}`;
      } catch (err) { notify(err.message, true); }
    };
  }
  const pf = document.getElementById('proof-f');
  if (pf) {
    pf.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(pf);
      const payReference = (fd.get('payReference') || '').trim();
      const payName = (fd.get('payName') || '').trim();
      const payPhone = (fd.get('payPhone') || '').trim();
      if (!payReference && !payName && !payPhone && !proofData) {
        notify('أدخل رقم الحركة أو اسم/رقم المحوِّل أو ارفع صورة الإشعار', true);
        return;
      }
      const btn = pf.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}/proof`, {
          method: 'POST',
          body: { payReference, payName, payPhone, receipt: proofData },
        });
        notify(S.order.status === 'paid' ? 'تم التحقق من الدفع وتفعيل الطلب' : 'تم استلام بيانات التحويل — جارٍ التحقّق');
        renderOrder();
      } catch (err) {
        notify(err.message, true);
        btn.disabled = false;
      }
    };
  }
}

async function route() {
  clearInterval(S.pollTimer);
  try {
    await ensureCatalog();
  } catch (err) {
    root.innerHTML = `<main class="shop-main"><div class="card empty">${icon('alert')}<p>${esc(err.message)}</p></div></main>`;
    return;
  }
  const rawHash = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = rawHash.split('?');
  const params = new URLSearchParams(queryPart || '');
  const [head, arg] = pathPart.split('/');

  window.scrollTo({ top: 0, behavior: 'instant' });

  if (head === 'compat') return viewCompatPage();
  if (head === 'terms') return viewLegalPage('terms');
  if (head === 'esim-policy') return viewLegalPage('esim');
  if (head === 'guarantee') return viewLegalPage('guarantee');
  if (head === 'track' || head === 'orders') {
    S.myOrders = null;
    return viewTrackPage();
  }
  if (head === 'buy' && arg) {
    if (params.get('esim') === '1') S.wantEsim = true;
    else if (!queryPart) S.wantEsim = false;
    return viewBuy(arg);
  }
  if (head === 'order' && arg) return viewOrder(decodeURIComponent(arg));
  viewCatalog();
}

window.addEventListener('hashchange', route);
route();
