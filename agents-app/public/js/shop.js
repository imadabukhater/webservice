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

function renderBrandWordmark(rawName = '') {
  const clean = String(rawName || '').replace(/^متجر\s+/i, '').trim();
  if (!clean || /^hot\s*e-?sim$/i.test(clean) || /^h-?sim$/i.test(clean)) {
    return `<span class="brand-lockup" dir="ltr"><span class="brand-word-hot">HOT</span><span class="brand-word-esim"><i>e</i>SIM</span></span>`;
  }
  return `<span class="brand-lockup"><span class="brand-word-custom">${esc(clean)}</span><span class="brand-word-esim" dir="ltr"><i>e</i>SIM</span></span>`;
}

function shell(body, { sub = '' } = {}) {
  const rawBrand = S.data?.shopTitle || S.data?.appName || 'Hot Esim';
  const name = S.data?.shopTitle || (S.data?.appName ? `متجر ${S.data.appName}` : 'HOT eSIM');
  const subtitle = sub || S.data?.shopSubtitle || 'شرائح وباقات فورية';
  const wa = waHref(S.data?.supportWhatsapp, `مرحباً، أحتاج مساعدة في ${name}`);
  const dark = document.documentElement.dataset.theme === 'dark';
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  const onHome = !hash;
  const onLegal = hash === 'terms' || hash === 'esim-policy' || hash === 'guarantee';

  root.innerHTML = `
    <header class="shop-top">
      <div class="shop-top-inner">
        <a href="#/" class="shop-brand" data-act="nav-all" aria-label="${esc(name)}">
          <span class="shop-brand-mark">${brandLogoSvg('hsim-logo-svg')}</span>
          <span class="shop-brand-text">
            <span class="shop-brand-title-row">
              ${renderBrandWordmark(rawBrand)}
            </span>
            <small><span class="shop-live-dot"></span>${esc(subtitle)}</small>
          </span>
        </a>

        <nav class="shop-nav" aria-label="التنقّل في المتجر">
          <a href="#/" class="shop-nav-link ${onHome && S.kindFilter !== 'esim' ? 'active' : ''}" data-act="nav-all">
            ${icon('sim')}<span>الباقات</span>
          </a>
          <button type="button" class="shop-nav-link ${onHome && S.kindFilter === 'esim' ? 'active' : ''}" data-act="nav-esim">
            ${icon('qr')}<span>شرائح eSIM</span>
          </button>
          <a href="#/compat" class="shop-nav-link ${hash === 'compat' ? 'active' : ''}">
            ${icon('chip')}<span>فحص التوافق</span>
          </a>
          <a href="#/terms" class="shop-nav-link ${onLegal ? 'active' : ''}">
            ${icon('shield')}<span>الضمان والشروط</span>
          </a>
          <a href="#/track" class="shop-nav-link ${hash === 'track' || hash === 'orders' ? 'active' : ''}">
            ${icon('search')}<span>طلباتي${S.myCodes.length ? ` (${fmtNum(S.myCodes.length)})` : ''}</span>
          </a>
        </nav>

        <div class="shop-utils">
          ${wa ? `<a class="btn btn-sm ghost shop-wa-btn" href="${esc(wa)}" target="_blank" rel="noopener" aria-label="تواصل عبر واتساب">${icon('whatsapp')}<span class="shop-wa-label">واتساب</span></a>` : ''}
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
                ${renderBrandWordmark(rawBrand)}
              </div>
              <small class="muted" style="font-size:.76rem">شرائح eSIM فورية وشحن باقات الخليوي</small>
            </div>
          </div>
        </div>
        <nav class="shop-footer-links" aria-label="روابط المتجر">
          <a href="#/compat" class="shop-footer-link ${hash === 'compat' ? 'active' : ''}">${icon('chip')}<span>فحص توافق الهاتف مع eSIM</span></a>
          <a href="#/terms" class="shop-footer-link ${hash === 'terms' ? 'active' : ''}">${icon('shield')}<span>شروط البيع والتفعيل</span></a>
          <a href="#/esim-policy" class="shop-footer-link ${hash === 'esim-policy' ? 'active' : ''}">${icon('qr')}<span>سياسة كود eSIM QR</span></a>
          <a href="#/guarantee" class="shop-footer-link ${hash === 'guarantee' ? 'active' : ''}">${icon('checkCircle')}<span>ضمان المتجر واسترجاع المبلغ</span></a>
          <a href="#/track" class="shop-footer-link ${hash === 'track' ? 'active' : ''}">${icon('search')}<span>تتبّع حالة طلب</span></a>
        </nav>
      </div>
    </footer>

    <!-- Mobile Thumb-Friendly Bottom Navigation Dock -->
    <nav class="shop-bottom-nav no-print" aria-label="التنقّل السريع للهاتف">
      <a href="#/" class="shop-bnav-item ${onHome && S.kindFilter !== 'esim' ? 'active' : ''}" data-act="nav-all">
        ${icon('sim')}
        <span>الباقات</span>
      </a>
      <button type="button" class="shop-bnav-item ${onHome && S.kindFilter === 'esim' ? 'active' : ''}" data-act="nav-esim">
        ${icon('qr')}
        <span>eSIM</span>
      </button>
      <a href="#/compat" class="shop-bnav-item ${hash === 'compat' ? 'active' : ''}">
        ${icon('chip')}
        <span>التوافق</span>
      </a>
      <a href="#/terms" class="shop-bnav-item ${onLegal ? 'active' : ''}">
        ${icon('shield')}
        <span>الضمان</span>
      </a>
      <a href="#/track" class="shop-bnav-item ${hash === 'track' || hash === 'orders' ? 'active' : ''}">
        <span class="shop-bnav-ic-wrap">
          ${icon('search')}
          ${S.myCodes.length ? `<b class="shop-bnav-badge">${fmtNum(S.myCodes.length)}</b>` : ''}
        </span>
        <span>طلباتي</span>
      </a>
    </nav>
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
    note: 'جميع أجهزة iPhone بدءاً من iPhone XS / XR فما فوق تدعم شريحة eSIM.',
    steps: [
      'الإعدادات ← خلوي ← إضافة شريحة إلكترونية (Add eSIM).',
      'تأكد من عدم قفل الشبكة: الإعدادات ← عام ← حول ← لا توجد قيود على الشريحة.',
    ],
    models: [
      'iPhone 16 / 16 Plus / 16 Pro / 16 Pro Max / 16e',
      'iPhone 15 / 15 Plus / 15 Pro / 15 Pro Max',
      'iPhone 14 / 14 Plus / 14 Pro / 14 Pro Max',
      'iPhone 13 / 13 mini / 13 Pro / 13 Pro Max',
      'iPhone 12 / 12 mini / 12 Pro / 12 Pro Max',
      'iPhone 11 / 11 Pro / 11 Pro Max',
      'iPhone XS / XS Max / iPhone XR',
      'iPhone SE (2020 و 2022)',
      'iPad Pro / iPad Air / iPad mini (نسخ Cellular الحديثة)',
    ],
    exceptions: 'نسخ الصين (شريحتين فعليتين) لا تدعم eSIM.',
  },
  samsung: {
    label: 'Samsung Galaxy',
    badge: 'Android',
    note: 'سلسلة Galaxy S20 فما فوق وسلسلة Z Fold / Z Flip وبعض فئة A الحديثة تدعم eSIM.',
    steps: [
      'الضبط ← الاتصالات ← إدارة SIM ← إضافة eSIM.',
      'أو اطلب *#06# وتأكد من ظهور رقم EID.',
    ],
    models: [
      'Galaxy S25 / S25+ / S25 Ultra',
      'Galaxy S24 / S24+ / S24 Ultra / S24 FE',
      'Galaxy S23 / S23+ / S23 Ultra / S23 FE',
      'Galaxy S22 / S22+ / S22 Ultra',
      'Galaxy S21 / S21+ / S21 Ultra 5G',
      'Galaxy S20 / S20+ / S20 Ultra / Note 20',
      'Galaxy Z Fold6 / Fold5 / Fold4 / Fold3 / Fold2',
      'Galaxy Z Flip6 / Flip5 / Flip4 / Flip3 / Flip',
      'Galaxy A55 5G / A54 5G / A35 5G (النسخ العالمية)',
    ],
    exceptions: 'نسخ S20 FE و S21 FE لا تدعم eSIM.',
  },
  google: {
    label: 'Google Pixel',
    badge: 'Android',
    note: 'جميع هواتف Pixel بدءاً من Pixel 4 فما فوق تدعم شريحة eSIM.',
    steps: [
      'الإعدادات ← الشبكة والإنترنت ← الشرائح (SIMs) ← تنزيل شريحة eSIM.',
    ],
    models: [
      'Pixel 9 / 9 Pro / 9 Pro XL / 9 Pro Fold',
      'Pixel 8 / 8a / 8 Pro',
      'Pixel 7 / 7a / 7 Pro',
      'Pixel 6 / 6a / 6 Pro',
      'Pixel 5 / 5a / Pixel 4 / 4a / 4 XL',
      'Pixel 3 / 3 XL / 3a (النسخ المفتوحة)',
    ],
    exceptions: 'يشترط أن يكون الجهاز مفتوح الشبكة (Unlocked).',
  },
  other: {
    label: 'Xiaomi / Honor / Huawei / أخرى',
    badge: 'Android',
    note: 'الهواتف الرائدة الحديثة من شاومي وهونر وهواوي وموتورولا تدعم eSIM.',
    steps: [
      'اطلب *#06# في لوحة الاتصال: إذا ظهر رمز EID فالهاتف يدعم eSIM.',
    ],
    models: [
      'Xiaomi 14 / 14 Pro / 14 Ultra / 14T / 14T Pro',
      'Xiaomi 13 / 13 Lite / 13 Pro / 13T / 13T Pro / 12T Pro',
      'Redmi Note 13 Pro 5G / Note 13 Pro+ 5G (العالمية)',
      'Honor Magic6 Pro / Magic5 Pro / Magic4 Pro / Magic V2 & V3',
      'Honor 200 / 200 Pro / Honor 90',
      'Huawei Pura 70 Pro / P40 / P40 Pro / Mate 40 Pro',
      'Motorola Razr 50 / Razr 40 / Edge 50 Pro / Edge 40',
      'OnePlus 13 / 12 / 11 · Oppo Find X8 / X5 Pro · Sony Xperia',
    ],
    exceptions: 'Huawei P40 Pro+ و P50 Pro لا يدعمان eSIM. افحص دائماً بـ *#06#.',
  },
};

const KNOWN_UNSUPPORTED = [
  { match: /iphone\s*(6|7|8|\bx\b)/i, msg: 'الدعم يبدأ من iPhone XS / XR فما فوق.' },
  { match: /s10|s9|s8|note\s*10|note\s*9/i, msg: 'الدعم في سامسونج يبدأ من Galaxy S20 و Note 20.' },
  { match: /s20\s*fe|s21\s*fe/i, msg: 'نسخ Galaxy S20 FE و S21 FE لا تدعم eSIM.' },
  { match: /p40\s*pro\+|p50|mate\s*30/i, msg: 'هذا الطراز لا يدعم eSIM.' },
];

function evaluateDeviceQuery(rawQuery) {
  const q = String(rawQuery || '').trim();
  if (!q) return null;
  for (const bad of KNOWN_UNSUPPORTED) {
    if (bad.match.test(q)) {
      return { status: 'bad', title: 'غير متوافق مع eSIM', detail: bad.msg };
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
      title: `متوافق مع eSIM (${fmtNum(hits.length)})`,
      hits: hits.slice(0, 8),
      detail: 'تأكد أن الجهاز مفتوح الشبكة، واطلب *#06# لرؤية رمز EID.',
    };
  }
  return {
    status: 'warn',
    title: `افحص "${q}" بالكود المباشر`,
    detail: 'اطلب *#06# من هاتفك: إذا ظهر رقم EID فجهازك يدعم eSIM.',
  };
}

function renderCompatMarkup({ inSheet = false } = {}) {
  const info = COMPAT_DEVICES[S.compatBrand] || COMPAT_DEVICES.apple;
  const searchRes = evaluateDeviceQuery(S.compatSearch);

  return `
    <div class="esim-eid-check">
      <div class="esim-eid-icon">${icon('phone')}</div>
      <div class="grow">
        <strong>الفحص السريع بـ <kbd dir="ltr">*#06#</kbd></strong>
        <p class="muted" style="margin:3px 0 0;font-size:.86rem">
          اطلب <kbd dir="ltr">*#06#</kbd> في لوحة الاتصال: إذا ظهر لك رقم <b>EID</b> فهاتفك يدعم شريحة <b>eSIM</b>.
        </p>
      </div>
    </div>

    <div class="esim-compat-search-card">
      <label for="compat-q-input" class="esim-sec-title">
        ${icon('search')}
        <span>ابحث بطراز الهاتف (مثال: iPhone 14 أو S24 أو Pixel 8)</span>
      </label>
      <div class="esim-compat-search-row">
        <input id="compat-q-input" class="input" type="search" value="${esc(S.compatSearch)}" placeholder="اكتب اسم الهاتف..." autocomplete="off">
        ${S.compatSearch ? `<button type="button" class="btn ghost btn-sm" id="compat-q-clear">مسح</button>` : ''}
      </div>
      ${searchRes ? `
        <div class="esim-compat-result is-${searchRes.status}">
          <div class="row" style="gap:8px">
            ${icon(searchRes.status === 'ok' ? 'checkCircle' : 'alert')}
            <strong>${esc(searchRes.title)}</strong>
          </div>
          <p style="margin:4px 0 0;font-size:.85rem">${esc(searchRes.detail)}</p>
          ${searchRes.hits ? `
            <ul class="esim-compat-list" style="margin-top:8px">
              ${searchRes.hits.map((h) => `<li>${icon('checkCircle')}<span class="ltr">${esc(h.model)}</span></li>`).join('')}
            </ul>
          ` : ''}
        </div>
      ` : ''}
    </div>

    <div class="esim-brand-tabs" role="tablist" aria-label="الشركات المصنعة">
      ${Object.entries(COMPAT_DEVICES).map(([k, v]) => `
        <button type="button" role="tab" class="esim-brand-tab" aria-selected="${S.compatBrand === k}" data-brand="${k}">
          <b>${esc(v.label)}</b>
          <small>${esc(v.badge)}</small>
        </button>
      `).join('')}
    </div>

    <div class="esim-compat-box">
      <div class="row between" style="flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <h3 style="margin:0">${esc(info.label)}</h3>
        <span class="pill s-done">${esc(info.badge)}</span>
      </div>
      <p class="muted" style="margin:0 0 10px;font-size:.86rem">${esc(info.note)}</p>

      <ul class="esim-compat-list">
        ${info.models.map((m) => `<li>${icon('checkCircle')}<span class="ltr">${esc(m)}</span></li>`).join('')}
      </ul>

      <div class="esim-compat-steps-box" style="margin-top:12px">
        <h4 style="margin:0 0 4px;font-size:.84rem">خطوات التأكد من الإعدادات:</h4>
        <ol class="esim-legal-list">
          ${info.steps.map((s) => `<li>${esc(s)}</li>`).join('')}
        </ol>
      </div>

      ${info.exceptions ? `
        <div class="esim-compat-note" style="margin-top:10px">
          ${icon('info')}
          <span>${esc(info.exceptions)}</span>
        </div>
      ` : ''}
    </div>

    ${!inSheet ? `
      <div class="esim-page-cta">
        <div>
          <h3 style="margin:0 0 2px">هاتفك متوافق؟</h3>
          <p class="muted" style="margin:0;font-size:.85rem">اختر باقتك واستلم كود الـ QR فوراً.</p>
        </div>
        <button type="button" class="btn primary lg" data-act="nav-esim">
          ${icon('qr')}<span>تصفّح باقات eSIM</span>
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
          <span class="esim-hero-kicker">${icon('chip')}<span>فحص التوافق</span></span>
          <h1>فحص توافق الهاتف مع eSIM</h1>
          <p class="muted">تأكد من دعم هاتفك للشريحة الإلكترونية قبل الشراء.</p>
        </div>
        <a href="#/" class="btn ghost btn-sm">← المتجر</a>
      </div>
      <div id="compat-page-body"></div>
    </section>
  `, { sub: 'فحص توافق الجهاز' });

  const mount = document.getElementById('compat-page-body');
  const update = () => {
    mount.innerHTML = renderCompatMarkup({ inSheet: false });
    bindCompatEvents(mount, update);
  };
  update();
}

// Modal Sheet: openCompatSheet()
function openCompatSheet() {
  const { el } = sheet({
    title: 'فحص توافق الهاتف مع eSIM',
    subtitle: 'تأكد من دعم جهازك للشريحة الرقمية',
    wide: true,
    body: `<div id="compat-sheet-body"></div>`,
    footer: `<button type="button" class="btn primary" data-close>متابعة الطلب</button>`,
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
      <div class="esim-legal-panel">
        <h4>١. قواعد كود eSIM QR</h4>
        <ul class="esim-legal-list">
          <li><b>صالح لجهاز واحد:</b> يرتبط كود الـ QR بأول هاتف يمسحه ولا يعمل على جهاز آخر بعد التثبيت.</li>
          <li><b>لا تحذف الشريحة:</b> حذف الشريحة من إعدادات الهاتف يلغيها نهائياً ولا يمكن إعادة مسح نفس الكود.</li>
          <li><b>اتصال Wi-Fi:</b> يلزم اتصال إنترنت مستقر على الهاتف أثناء مسح الكود لتنزيل الشريحة.</li>
          <li><b>سرية الكود:</b> لا تشارك صورة الـ QR أو كود التفعيل اليدوي (LPA) مع أي شخص.</li>
        </ul>
      </div>

      <div class="esim-legal-panel">
        <h4>٢. خطوات التثبيت</h4>
        <div class="shop-qr-guides">
          <div class="shop-qr-guide-col">
            <b>على iPhone (iOS):</b>
            <ol>
              <li>الإعدادات ← خلوي ← إضافة شريحة إلكترونية.</li>
              <li>اختر <b>استخدام رمز QR</b> وامسح الكود أو اختره من الصور.</li>
            </ol>
          </div>
          <div class="shop-qr-guide-col">
            <b>على Android / Samsung:</b>
            <ol>
              <li>الضبط ← الاتصالات ← إدارة SIM ← إضافة eSIM.</li>
              <li>امسح الكود بالكاميرا أو أدخل كود الـ LPA يدوياً.</li>
            </ol>
          </div>
        </div>
      </div>
    `;
  }

  if (tab === 'guarantee') {
    return `
      <div class="esim-legal-panel">
        <h4>حالات الضمان واسترجاع المبلغ</h4>
        <div class="esim-policy-table-wrap">
          <table class="esim-policy-table">
            <thead>
              <tr>
                <th>الحالة</th>
                <th>الإجراء</th>
                <th>الضمان</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>تعذّر التفعيل أو نفاد الباقة بعد الدفع</b></td>
                <td>تبديل لباقة أخرى أو إرجاع المبلغ لمحفظة Jawwal Pay.</td>
                <td><span class="pill s-done">استرجاع 100%</span></td>
              </tr>
              <tr>
                <td><b>خلل تقني في كود الـ QR قبل مسحه</b></td>
                <td>فحص الكود وإصدار بديل أو إرجاع المبلغ.</td>
                <td><span class="pill s-done">استبدال أو استرجاع</span></td>
              </tr>
              <tr>
                <td><b>إلغاء الطلب قبل الدفع أو التنفيذ</b></td>
                <td>إلغاء مباشر من صفحة الطلب.</td>
                <td><span class="pill s-done">إلغاء مجاني</span></td>
              </tr>
              <tr>
                <td><b>حذف الـ eSIM بعد تثبيتها أو إدخال رقم شحن خاطئ</b></td>
                <td>بعد تنفيذ التفعيل لدى شركة الاتصالات لا يمكن إلغاؤه.</td>
                <td><span class="pill s-bad">غير قابل للاسترجاع</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  return `
    <div class="esim-legal-panel">
      <h4>١. الأسعار والدفع</h4>
      <ul class="esim-legal-list">
        <li>جميع الأسعار المعروضة بالشيكل (₪) صريحة ونهائية.</li>
        <li>تُعرض رسوم إصدار شريحة eSIM QR (إن وجدت) بوضوح في ملخص السعر قبل الدفع.</li>
        <li>يتم الدفع عبر <b>Jawwal Pay</b> ثم إدخال رقم الحركة أو اسم المحوِّل لتفعيل الطلب تلقائياً.</li>
      </ul>
    </div>

    <div class="esim-legal-panel">
      <h4>٢. التفعيل وحجز الأرقام</h4>
      <ul class="esim-legal-list">
        <li><b>طلبات الشحن:</b> يرجى التأكد من رقم الهاتف قبل الإرسال؛ لا يمكن استرداد الشحن بعد تنفيذه على رقم خاطئ.</li>
        <li><b>طلبات eSIM:</b> يُحجز الرقم للطلب لمدة 30 دقيقة بانتظار تأكيد الدفع، ويصدر كود الـ QR فور المطابقة.</li>
      </ul>
    </div>
  `;
}

// Full Page: #/terms, #/esim-policy, #/guarantee
function viewLegalPage(tab = 'terms') {
  const titles = {
    terms: { title: 'شروط البيع والتفعيل', sub: 'الأسعار، الدفع، وقواعد التفعيل' },
    esim: { title: 'سياسة كود eSIM QR', sub: 'قواعد استخدام وتثبيت الشريحة الإلكترونية' },
    guarantee: { title: 'ضمان المتجر والاسترجاع', sub: 'ضمان التفعيل 100% أو استرداد المبلغ' },
  };
  const info = titles[tab] || titles.terms;

  shell(`
    <section class="esim-page-wrap">
      <div class="esim-page-head">
        <div>
          <span class="esim-hero-kicker">${icon('shield')}<span>الضمان والشروط</span></span>
          <h1>${esc(info.title)}</h1>
          <p class="muted">${esc(info.sub)}</p>
        </div>
        <a href="#/" class="btn ghost btn-sm">← المتجر</a>
      </div>

      <div class="esim-brand-tabs" role="tablist" aria-label="أقسام الشروط">
        <a href="#/terms" role="tab" class="esim-brand-tab" aria-selected="${tab === 'terms'}">
          <b>شروط البيع والتفعيل</b>
        </a>
        <a href="#/esim-policy" role="tab" class="esim-brand-tab" aria-selected="${tab === 'esim'}">
          <b>سياسة كود eSIM QR</b>
        </a>
        <a href="#/guarantee" role="tab" class="esim-brand-tab" aria-selected="${tab === 'guarantee'}">
          <b>ضمان المتجر والاسترجاع</b>
        </a>
      </div>

      <div class="esim-legal-page-body">
        ${renderLegalSectionMarkup(tab)}
      </div>
    </section>
  `, { sub: info.title });
}

// Modal Sheet: openLegalSheet()
function openLegalSheet(initialTab = 'terms') {
  let tab = initialTab || 'terms';
  const { el } = sheet({
    title: 'الشروط والضمان',
    subtitle: 'شروط التفعيل وسياسة eSIM وضمان المتجر',
    wide: true,
    body: `<div id="legal-sheet-body"></div>`,
    footer: `<button type="button" class="btn primary" data-close>موافق — متابعة</button>`,
  });

  const mount = el.querySelector('#legal-sheet-body');
  function renderLegal() {
    mount.innerHTML = `
      <div class="esim-brand-tabs" role="tablist">
        <button type="button" role="tab" class="esim-brand-tab" aria-selected="${tab === 'terms'}" data-ltab="terms">
          <b>شروط البيع</b>
        </button>
        <button type="button" role="tab" class="esim-brand-tab" aria-selected="${tab === 'esim'}" data-ltab="esim">
          <b>سياسة eSIM QR</b>
        </button>
        <button type="button" role="tab" class="esim-brand-tab" aria-selected="${tab === 'guarantee'}" data-ltab="guarantee">
          <b>الضمان والاسترجاع</b>
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
    title: 'تتبّع طلب',
    subtitle: 'أدخل رمز الطلب لعرض الحالة أو كود الـ QR',
    body: `
      <div class="field">
        <label for="f-sheet-code">رمز الطلب</label>
        <input id="f-sheet-code" name="code" class="input ltr" required placeholder="AB12CD34" autocomplete="off">
      </div>
    `,
    submit: 'عرض الطلب',
    cancel: 'إلغاء',
    onSubmit: (form) => {
      const code = (new FormData(form).get('code') || '').trim().toUpperCase();
      if (!code) throw new Error('أدخل رمز الطلب');
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
          <span class="esim-hero-kicker">${icon('search')}<span>متابعة الطلبات</span></span>
          <h1>تتبّع حالة طلب</h1>
          <p class="muted">أدخل رمز الطلب لتأكيد الدفع أو استلام كود eSIM QR.</p>
        </div>
        <a href="#/" class="btn ghost btn-sm">← المتجر</a>
      </div>

      <div class="card esim-track-card">
        <form id="track-page-form" class="esim-track-form">
          <div class="field grow">
            <label for="track-code-input">رمز الطلب (Order Code)</label>
            <input id="track-code-input" name="code" class="input ltr big" required placeholder="مثال: AB12CD34" autocomplete="off">
          </div>
          <button type="submit" class="btn primary lg">
            ${icon('search')}<span>عرض الطلب</span>
          </button>
        </form>
        <div id="track-inline-error"></div>
      </div>

      <div class="esim-legal-panel">
        <div class="row between" style="flex-wrap:wrap;gap:8px;margin-bottom:10px">
          <h3 style="margin:0">طلباتي على هذا الجهاز (${fmtNum(ordersList.length)})</h3>
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
                          ${o.esim ? `<span class="pill plain" style="margin-inline-start:6px;background:var(--primary-soft);color:var(--primary)">eSIM</span>` : ''}
                          ${hasQr ? `<span class="pill s-done" style="margin-inline-start:4px">QR جاهز</span>` : ''}
                        </div>
                        <div class="item-sub">
                          <span><b class="ltr mono">${esc(o.code)}</b></span>
                          ${o.number ? `<span>· <b class="ltr mono">${esc(fmtPhone(o.number))}</b></span>` : ''}
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
          <div class="empty" style="padding:20px 14px">
            ${icon('list')}
            <b>لا توجد طلبات محفوظة على هذا الجهاز</b>
            <span>أدخل رمز الطلب في الحقل أعلاه لعرضه.</span>
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
        errBox.innerHTML = `<div class="msg" style="margin-top:10px">${icon('alert')}<span>لم يتم العثور على طلب بالرمز <b class="ltr mono">${esc(raw)}</b></span></div>`;
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
    <!-- Signature HOT eSIM & Telecom Hero -->
    <section class="esim-hero">
      <div class="esim-hero-grid">
        <div class="esim-hero-copy">
          <div class="esim-hero-kicker">
            <span class="kicker-monogram ltr">HOT eSIM</span>
            <span>تفعيل فوري</span>
          </div>
          <h1>${esc(S.data.shopTitle || 'شرائح eSIM وباقات خليوي فورية')}</h1>
          <p>
            ${esc(S.data.shopSubtitle || 'اختر باقتك واستلم كود الـ QR فوراً، أو اشحن رقمك الحالي خلال ثوانٍ.')}
          </p>

          <div class="esim-search-box" role="search">
            <span class="esim-search-ic">${icon('search')}</span>
            <input id="shop-q" type="search" value="${esc(S.q)}" placeholder="ابحث عن باقة أو شبكة..." autocomplete="off">
            ${S.q ? `<button type="button" class="icon-btn sm" id="shop-q-clear" aria-label="مسح البحث">${icon('x')}</button>` : ''}
          </div>

          <div class="esim-hero-actions">
            <button type="button" class="esim-hero-btn primary" data-act="nav-esim">
              ${icon('qr')}
              <span>شرائح eSIM</span>
            </button>
            <a href="#/compat" class="esim-hero-btn ghost">
              ${icon('chip')}
              <span>فحص التوافق</span>
            </a>
            <a href="#/track" class="esim-hero-btn ghost">
              ${icon('search')}
              <span>تتبّع طلب</span>
            </a>
          </div>
        </div>

        <!-- Bespoke HOT eSIM Digital Pass Card Showcase -->
        <div class="esim-hero-card-wrap" aria-hidden="true">
          <div class="esim-showcase-card">
            <div class="esim-showcase-top">
              <div>
                <span class="esim-showcase-tag">HOT eSIM</span>
                <strong>شريحة رقمية فورية</strong>
              </div>
              <div class="esim-showcase-emblems">
                ${esimChipSvg('esim-chip-svg lg')}
                ${brandLogoSvg('hsim-logo-svg lg')}
              </div>
            </div>

            <div class="esim-showcase-specs">
              <div><small>الشبكة</small><b class="ltr">4G / 5G</b></div>
              <div><small>التثبيت</small><b>مسح QR</b></div>
              <div><small>الأجهزة</small><b class="ltr">iOS · Android</b></div>
            </div>

            <div class="esim-pass-journey">
              <div class="esim-pass-step">
                <i class="ltr">01</i>
                <span>اختر الباقة</span>
              </div>
              <span class="esim-pass-arrow">←</span>
              <div class="esim-pass-step">
                <i class="ltr">02</i>
                <span>ادفع</span>
              </div>
              <span class="esim-pass-arrow">←</span>
              <div class="esim-pass-step active">
                <i class="ltr">03</i>
                <span>امسح QR</span>
              </div>
            </div>

            <div class="esim-showcase-foot">
              <span class="esim-showcase-status"><i class="shop-live-dot"></i> تفعيل فوري مباشر</span>
              <span class="mono ltr" style="font-size:.75rem;opacity:.85">HOT-eSIM</span>
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
          <span>الكل</span>
          <small>${fmtNum(totalCount)}</small>
        </button>
        <button type="button" role="tab" class="esim-type-tab esim-tab-accent" aria-selected="${S.kindFilter === 'esim'}" data-kind="esim">
          ${icon('qr')}
          <span>شرائح eSIM</span>
          <small>${fmtNum(esimCount)}</small>
        </button>
        ${cardCount ? `
          <button type="button" role="tab" class="esim-type-tab" aria-selected="${S.kindFilter === 'card'}" data-kind="card">
            ${icon('refresh')}
            <span>شحن رصيد</span>
            <small>${fmtNum(cardCount)}</small>
          </button>` : ''}
      </div>

      ${companies.length > 1 ? `
        <div class="esim-carrier-strip" role="tablist" aria-label="شركات الاتصالات">
          <button type="button" class="esim-carrier-pill" aria-pressed="${S.companyId === 'all'}" data-co="all">
            <span class="esim-carrier-all-ic">${icon('grid')}</span>
            <span class="esim-carrier-meta">
              <b>كل الشبكات</b>
              <small>${fmtNum(totalCount)} باقة</small>
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
                  <small>${fmtNum(cPkgs.length)} باقة${hasEsim ? ' · eSIM' : ''}</small>
                </span>
              </button>`;
          }).join('')}
        </div>
      ` : ''}
    </section>

    <!-- Package Cards Grid -->
    ${shown.length ? `
      <section class="esim-grid" aria-label="قائمة الباقات">
        ${shown.map((pk) => renderPlanCard(pk, coMap.get(pk.companyId), maxGb)).join('')}
      </section>
    ` : `
      <div class="card empty">
        ${icon('sim')}
        <p>لا توجد باقات مطابقة</p>
        <button type="button" class="btn ghost btn-sm" id="reset-filters">عرض الكل</button>
      </div>
    `}
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
    ? `${fmtNum(pk.minutes)} دقيقة${pk.sms ? ` · ${fmtNum(pk.sms)} رسالة` : ''}`
    : pk.tag || 'إنترنت ومكالمات';

  const qrFee = Number(pk.esimFee ?? co?.esimFee ?? S.data?.esimFee ?? 0);
  const qrFeeText = hasEsim
    ? (qrFee > 0 ? `+ ${fmtMoney(qrFee)} رسوم QR` : 'شامل كود QR مجاناً')
    : 'شحن مباشر للرقم';
  const hasTwoBtns = pk.kind === 'card' && hasEsim;

  return `
    <article class="esim-card ${featured ? 'is-featured' : ''} ${hasEsim ? 'has-esim' : ''}" style="--co:${esc(coColor)}">
      <div class="esim-card-head">
        <div class="esim-card-carrier">
          ${companyLogo(co || { name: pk.companyName }, 'sm')}
          <div class="esim-card-titles">
            <span class="esim-carrier-label">${esc(co?.name || pk.companyName || '')}</span>
            <h3 class="esim-plan-title">${esc(pk.name)}</h3>
          </div>
        </div>
        <div class="esim-card-emblem" title="${hasEsim ? 'شريحة eSIM' : 'شحن فوري'}">
          ${hasEsim ? `
            ${esimChipSvg('esim-chip-svg')}
            <span class="esim-chip-tag">eSIM QR</span>
          ` : `
            ${simCardSvg('esim-sim-svg')}
            <span class="esim-sim-tag">${pk.kind === 'card' ? 'شحن' : 'خط'}</span>
          `}
        </div>
      </div>

      ${featured || hasDiscount || pk.tag ? `
        <div class="esim-card-flags">
          ${featured ? `<span class="esim-flag featured">${icon('checkCircle')}<span>مميزة</span></span>` : ''}
          ${hasDiscount ? `<span class="esim-flag discount">خصم ${savePct}%</span>` : ''}
          ${pk.tag && !featured ? `<span class="esim-flag featured">${esc(pk.tag)}</span>` : ''}
        </div>
      ` : ''}

      <div class="esim-data-banner">
        <div class="esim-data-main">
          <div class="esim-data-col">
            <small>${icon('data')}<span>الإنترنت</span></small>
            <strong class="ltr">${gbVal > 0 ? `${fmtNum(gbVal)} GB` : 'مفتوح'}</strong>
          </div>
          <div class="esim-data-sep" aria-hidden="true"></div>
          <div class="esim-data-col end">
            <small>${icon('clock')}<span>الصلاحية</span></small>
            <strong>${daysVal > 0 ? `${fmtNum(daysVal)} يوم` : 'شهرية'}</strong>
          </div>
        </div>
        ${gbVal > 0 ? `<div class="esim-gb-meter" aria-hidden="true"><span style="width:${gbPct}%"></span></div>` : ''}
      </div>

      <div class="esim-spec-box">
        <div class="esim-spec-row">
          <span class="esim-spec-k">${icon('call')}<span>المكالمات</span></span>
          <strong class="esim-spec-v">${esc(callsLabel)}</strong>
        </div>

        <div class="esim-spec-row ${hasEsim ? 'esim-qr-row' : ''}">
          <span class="esim-spec-k">${icon(hasEsim ? 'qr' : 'refresh')}<span>${hasEsim ? 'شريحة eSIM' : 'التفعيل'}</span></span>
          <strong class="esim-spec-v">${esc(qrFeeText)}</strong>
        </div>
      </div>

      ${pk.description ? `<p class="esim-plan-desc">${esc(pk.description)}</p>` : ''}

      <div class="esim-card-foot">
        <div class="esim-price-row">
          <div class="esim-price-block">
            <span class="esim-price-label">السعر</span>
            ${perDay ? `<small class="esim-daily-hint">≈ ${perDay} ₪ / يوم</small>` : ''}
          </div>
          <div class="esim-price-val">
            ${hasDiscount ? `<s>${fmtMoney(pk.oldPrice)}</s>` : ''}
            <b>${fmtMoney(pk.price)}</b>
          </div>
        </div>

        <div class="esim-card-btns ${hasTwoBtns ? 'has-two' : 'has-one'}">
          ${hasTwoBtns ? `
            <a href="#/buy/${pk.id}" class="btn ghost">${icon('refresh')}<span>شحن رقمي</span></a>
            <a href="#/buy/${pk.id}?esim=1" class="btn primary">${icon('qr')}<span>شراء eSIM</span></a>
          ` : hasEsim ? `
            <a href="#/buy/${pk.id}?esim=1" class="btn primary">${icon('qr')}<span>شراء eSIM</span></a>
          ` : `
            <a href="#/buy/${pk.id}" class="btn primary">${icon('arrowL')}<span>شراء الباقة</span></a>
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
        <a href="#/" class="btn ghost btn-sm">→ الباقات</a>
        ${canEsim ? `
          <button type="button" class="btn ghost btn-sm" data-act="compat-sheet">
            ${icon('chip')}<span>فحص توافق الجهاز</span>
          </button>` : ''}
      </div>

      <div class="shop-steps no-print" aria-label="مراحل الطلب">
        <span class="current"><i>1</i>البيانات</span>
        <span><i>2</i>الدفع</span>
        <span><i>3</i>التفعيل</span>
      </div>

      <div class="esim-checkout-head">
        <div class="row" style="gap:12px">
          ${companyLogo(co)}
          <div class="grow">
            <span class="esim-carrier-label">${esc(co?.name || '')}</span>
            <h2 style="margin:2px 0 4px">${esc(pk.name)}</h2>
            <div class="chips">${specs(pk)}</div>
          </div>
        </div>
        ${pk.description ? `<p class="muted" style="margin:8px 0 0;font-size:.86rem">${esc(pk.description)}</p>` : ''}
      </div>

      ${canEsim && isCard ? `
        <div class="field">
          <label>نوع الطلب</label>
          <div class="shop-mode-cards" role="radiogroup" aria-label="نوع الطلب">
            <button type="button" class="shop-mode-card" data-esim="0" aria-pressed="true">
              <div class="row between">
                ${icon('refresh')}
                <span class="mono">${fmtMoney(pk.price)}</span>
              </div>
              <b>شحن رقمي الحالي</b>
              <small>تجديد الباقة على شريحتك الحالية</small>
            </button>
            <button type="button" class="shop-mode-card" data-esim="1" aria-pressed="false">
              <div class="row between">
                ${icon('qr')}
                <span class="mono">${fmtMoney(pk.price + qrFee)}</span>
              </div>
              <b>شريحة eSIM جديدة (QR)</b>
              <small>${qrFee > 0 ? `شامل رسوم QR (${fmtMoney(qrFee)})` : 'كود QR مجاني'}</small>
            </button>
          </div>
        </div>
      ` : ''}

      <div class="field">
        <label for="f-name">الاسم</label>
        <input id="f-name" name="customerName" class="input" required autocomplete="name" placeholder="الاسم الكامل">
      </div>

      <div class="field">
        <label for="f-phone">${isCard ? 'رقم الهاتف المراد شحنه' : 'رقم الهاتف'}</label>
        <input id="f-phone" name="number" class="input ltr" inputmode="tel" autocomplete="tel" required placeholder="05XXXXXXXX">
      </div>

      ${!isCard ? `
        <div class="field">
          <label for="f-sim">رقم الشريحة ICCID (19 رقماً)</label>
          <input id="f-sim" name="sim" class="input ltr" inputmode="numeric" required placeholder="89970...">
        </div>
      ` : ''}

      <div class="field">
        <label for="f-contact">رقم واتساب للتواصل <span class="muted">(اختياري)</span></label>
        <input id="f-contact" name="contactPhone" class="input ltr" inputmode="tel" autocomplete="tel" placeholder="059XXXXXXX">
      </div>

      <div class="shop-breakdown-box">
        <div class="shop-bd-row">
          <span>سعر الباقة</span>
          <b class="mono">${fmtMoney(pk.price)}</b>
        </div>
        <div class="shop-bd-total">
          <span>الإجمالي</span>
          <b class="mono">${fmtMoney(total)}</b>
        </div>
      </div>

      <div class="esim-consent-wrap">
        <label class="esim-consent-label">
          <input type="checkbox" name="consent" required>
          <span>تأكدت من الرقم وأوافق على الشروط.</span>
        </label>
        <button type="button" class="btn ghost btn-sm" data-act="legal-sheet" data-tab="terms">${icon('shield')}<span>الشروط والضمان</span></button>
      </div>

      <button class="btn primary lg" type="submit">
        ${icon('checkCircle')}
        <span>متابعة للدفع (${fmtMoney(total)})</span>
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

// eSIM checkout: checks /api/shop/available, shows price + QR fee breakdown, and creates eSIM order
async function esimForm(pk, co, canSwitchToCard = false) {
  const qrFee = Number(pk.esimFee ?? co?.esimFee ?? S.data?.esimFee ?? 0);
  const total = Number(pk.price || 0) + qrFee;

  shell(`<div class="card empty"><p class="muted">جارٍ التحقق من توفّر الشريحة...</p></div>`, { sub: pk.name });
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
        <a href="#/" class="btn ghost btn-sm">→ الباقات</a>
        <button type="button" class="btn ghost btn-sm" data-act="compat-sheet">
          ${icon('chip')}<span>فحص توافق الجهاز</span>
        </button>
      </div>

      <div class="shop-steps no-print" aria-label="مراحل الطلب">
        <span class="current"><i>1</i>البيانات</span>
        <span><i>2</i>الدفع</span>
        <span><i>3</i>استلام QR</span>
      </div>

      <div class="esim-checkout-head">
        <div class="row" style="gap:12px">
          ${companyLogo(co)}
          <div class="grow">
            <span class="esim-carrier-label">${esc(co?.name || '')} · شريحة eSIM</span>
            <h2 style="margin:2px 0 4px">${esc(pk.name)}</h2>
            <div class="chips">${specs(pk)}</div>
          </div>
          ${esimChipSvg('esim-chip-svg')}
        </div>
        ${pk.description ? `<p class="muted" style="margin:8px 0 0;font-size:.86rem">${esc(pk.description)}</p>` : ''}
      </div>

      ${canSwitchToCard ? `
        <div class="field">
          <label>نوع الطلب</label>
          <div class="shop-mode-cards" role="radiogroup" aria-label="نوع الطلب">
            <button type="button" class="shop-mode-card" data-esim="0" aria-pressed="false">
              <div class="row between">
                ${icon('refresh')}
                <span class="mono">${fmtMoney(pk.price)}</span>
              </div>
              <b>شحن رقمي الحالي</b>
              <small>تجديد الباقة على شريحتك الحالية</small>
            </button>
            <button type="button" class="shop-mode-card" data-esim="1" aria-pressed="true">
              <div class="row between">
                ${icon('qr')}
                <span class="mono">${fmtMoney(total)}</span>
              </div>
              <b>شريحة eSIM جديدة (QR)</b>
              <small>${qrFee > 0 ? `شامل رسوم QR (${fmtMoney(qrFee)})` : 'كود QR مجاني'}</small>
            </button>
          </div>
        </div>
      ` : ''}

      ${available ? `
        <div class="esim-ready-notice">
          ${icon('qr')}
          <div class="grow">
            <b>الشريحة متوفرة وجاهزة للإصدار</b>
            <small class="muted" style="display:block">يُحجز الرقم لمدة 30 دقيقة، ويظهر كود الـ QR فور تأكيد الدفع.</small>
          </div>
        </div>
      ` : `
        <div class="card empty">
          ${icon('alert')}
          <p>${esc(S.esimAvailable.error || 'نفدت شرائح eSIM لهذه الباقة حالياً — جرّب باقة أخرى.')}</p>
        </div>
      `}

      <div class="field">
        <label for="f-name">الاسم</label>
        <input id="f-name" name="customerName" class="input" required autocomplete="name" placeholder="الاسم الكامل">
      </div>

      <div class="field">
        <label for="f-email">البريد الإلكتروني <span class="muted">(اختياري — لإرسال نسخة من الـ QR)</span></label>
        <input id="f-email" name="email" type="email" class="input ltr" autocomplete="email" placeholder="you@example.com">
      </div>

      <div class="field">
        <label for="f-contact">رقم واتساب للتواصل <span class="muted">(اختياري)</span></label>
        <input id="f-contact" name="contactPhone" class="input ltr" inputmode="tel" autocomplete="tel" placeholder="059XXXXXXX">
      </div>

      <div class="shop-breakdown-box">
        <div class="shop-bd-row">
          <span>سعر الباقة</span>
          <b class="mono">${fmtMoney(pk.price)}</b>
        </div>
        <div class="shop-bd-row">
          <span>رسوم شريحة eSIM QR</span>
          <b class="mono">${qrFee > 0 ? fmtMoney(qrFee) : 'مجاناً'}</b>
        </div>
        <div class="shop-bd-total">
          <span>الإجمالي</span>
          <b class="mono">${fmtMoney(total)}</b>
        </div>
      </div>

      <div class="esim-consent-wrap">
        <label class="esim-consent-label">
          <input type="checkbox" name="consent" required>
          <span>هاتفي يدعم eSIM وأوافق على الشروط.</span>
        </label>
        <button type="button" class="btn ghost btn-sm" data-act="legal-sheet" data-tab="esim">${icon('shield')}<span>سياسة eSIM والضمان</span></button>
      </div>

      <button class="btn primary lg" type="submit" ${available ? '' : 'disabled'}>
        ${icon('checkCircle')}
        <span>متابعة للدفع (${fmtMoney(total)})</span>
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
  awaiting_payment: { label: 'بانتظار الدفع', cls: 's-open', step: 1, desc: 'حوّل المبلغ عبر Jawwal Pay ثم أدخل رقم الحركة أو اسم المحوِّل أدناه.' },
  verifying: { label: 'جارٍ التحقق من الدفع…', cls: 's-open', step: 2, desc: 'يتحقق النظام من التحويل لتفعيل طلبك تلقائياً.' },
  review: { label: 'قيد المراجعة', cls: 's-open', step: 2, desc: 'يراجع الفريق إشعار التحويل لتفعيل الطلب.' },
  processing: { label: 'تم الدفع — جارٍ التفعيل…', cls: 's-open', step: 2, desc: 'يتم الآن تفعيل الباقة وإصدار كود الـ QR.' },
  paid_issue: { label: 'تم الدفع — قيد المعالجة', cls: 's-open', step: 2, desc: 'يتابع الفريق إتمام التفعيل.' },
  done: { label: 'مفعّل وجاهز', cls: 's-done', step: 3, desc: 'تم تفعيل طلبك بنجاح.' },
  failed: { label: 'تعذّر التنفيذ — تواصل مع الدعم', cls: 's-bad', step: 0, desc: 'تواصل مع الدعم لاسترجاع المبلغ أو إعادة المحاولة.' },
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
          <a href="#/" class="btn primary">المتجر</a>
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
          <button type="button" class="btn ghost btn-sm" id="print-order">${icon('print')}<span>طباعة</span></button>
        </div>
      </div>

      <div class="shop-steps no-print" aria-label="مراحل الطلب">
        <span class="${st.step >= 1 ? 'done' : ''}"><i>1</i>البيانات</span>
        <span class="${st.step >= 3 ? 'done' : payable || st.step === 2 ? 'current' : ''}"><i>2</i>الدفع</span>
        <span class="${st.step >= 3 || hasQr ? 'done' : ''}"><i>3</i>${isEsim ? 'استلام QR' : 'التفعيل'}</span>
      </div>

      <div class="row between" style="flex-wrap:wrap;gap:10px">
        <div class="row" style="gap:10px">
          <span class="shop-brand-mark">${icon(isEsim ? 'qr' : 'sim')}</span>
          <div>
            <span class="esim-carrier-label">طلب #<b class="ltr mono">${esc(o.code)}</b></span>
            <h3 style="margin:2px 0">${esc(o.packageLabel)}${isEsim ? ' · eSIM' : ''}</h3>
            <small class="muted">${esc(o.customerName || '')} · ${o.number ? `<span class="ltr">${esc(fmtPhone(o.number))}</span>` : 'يظهر الرقم بعد الدفع'}</small>
          </div>
        </div>
        <b class="mono shop-amount">${fmtMoney(o.amount)}</b>
      </div>

      ${isEsim ? `
        <div class="shop-breakdown-box">
          <div class="shop-bd-row">
            <span>سعر الباقة</span>
            <b class="mono">${fmtMoney(o.packagePrice ?? o.amount)}</b>
          </div>
          <div class="shop-bd-row">
            <span>رسوم eSIM QR</span>
            <b class="mono">${Number(o.esimFee) > 0 ? fmtMoney(o.esimFee) : 'مجاناً'}</b>
          </div>
        </div>
      ` : ''}

      <div class="row between" style="flex-wrap:wrap;gap:8px">
        <span class="pill ${st.cls}">${esc(st.label)}</span>
        <small class="muted">${fmtDateTime(o.createdAt)}</small>
      </div>
      ${st.desc ? `<p class="muted" style="margin:0;font-size:.86rem">${esc(st.desc)}</p>` : ''}
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
        <h3>١. حوّل عبر Jawwal Pay</h3>
        <p class="muted" style="margin:0;font-size:.85rem">
          حوّل المبلغ للمحفظة التالية.${o.reservedUntil ? ` الرقم محجوز حتى <b>${fmtTime(o.reservedUntil)}</b>.` : ''}
        </p>
        <div class="shop-pay-kvs">
          <div class="shop-kv">
            <span>المبلغ</span>
            <b class="ltr mono">${fmtMoney(o.amount)}</b>
            <button type="button" class="btn ghost btn-sm" data-copy="${esc(String(o.amount))}">${icon('copy')}<span>نسخ</span></button>
          </div>
          ${jp.number ? `
            <div class="shop-kv">
              <span>محفظة جوال باي</span>
              <b class="ltr mono">${esc(fmtPhone(jp.number))}</b>
              <button type="button" class="btn ghost btn-sm" data-copy="${esc(jp.number)}">${icon('copy')}<span>نسخ</span></button>
            </div>
          ` : ''}
          ${jp.name ? `
            <div class="shop-kv">
              <span>المستلم</span>
              <b>${esc(jp.name)}</b>
            </div>
          ` : ''}
        </div>

        <hr style="border:0;border-top:1px solid var(--line);margin:4px 0">

        <h3>٢. ${o.proofSent ? 'تحديث بيانات الدفع' : 'تأكيد الدفع'}</h3>
        <p class="muted" style="margin:0;font-size:.84rem">
          أدخل رقم الحركة أو اسم المحوِّل أو صورة الإشعار:
        </p>

        <form id="proof-f" class="form" style="margin-top:6px">
          <div class="field">
            <label for="f-ref">رقم الحركة (Reference)</label>
            <input id="f-ref" name="payReference" class="input ltr" inputmode="numeric" autocomplete="off" placeholder="مثال: 2922...">
          </div>
          <div class="field">
            <label for="f-pname">اسم المحوِّل</label>
            <input id="f-pname" name="payName" class="input" autocomplete="name" placeholder="الاسم كما في جوال باي">
          </div>
          <div class="field">
            <label for="f-payer">رقم المحفظة المحوَّل منها <span class="muted">(اختياري)</span></label>
            <input id="f-payer" name="payPhone" class="input ltr" inputmode="tel" placeholder="059XXXXXXX">
          </div>
          <div class="field">
            <label>صورة الإشعار <span class="muted">(اختياري)</span></label>
            <label class="upload-box" id="proof-box">
              <input id="f-proof" type="file" accept="image/*" hidden>
              ${icon('image')}
              <span id="proof-label">${o.proofSent ? 'تم إرسال الإشعار — اضغط للتغيير' : 'اختر صورة الإشعار'}</span>
            </label>
          </div>
          <button class="btn primary lg" type="submit">${icon('checkCircle')}<span>${o.proofSent ? 'تحديث بيانات الدفع' : 'تأكيد الدفع وتفعيل الطلب'}</span></button>
        </form>
      </div>
    ` : ''}

    <!-- Step 3: Scannable eSIM QR Code Pass -->
    ${hasQr ? `
      <div class="card shop-qr-modern">
        <div class="shop-qr-badge">
          ${icon('checkCircle')}
          <span>شريحة eSIM جاهزة للمسح</span>
        </div>

        <h3 style="margin:0">امسح كود الـ QR لتثبيت الشريحة</h3>
        <p class="muted" style="margin:0;font-size:.86rem">
          اتصل بالـ Wi-Fi وامسح الكود من إعدادات الهاتف:
        </p>

        <div class="shop-qr-frame">
          <img id="qr-img" src="${esc(o.esimQr)}" alt="كود QR لشريحة eSIM ${esc(o.number || '')}">
        </div>

        <div class="esim-qr-details">
          ${o.number ? `
            <div class="shop-kv">
              <span>رقم الخط</span>
              <b class="ltr mono">${esc(fmtPhone(o.number))}</b>
              <button type="button" class="btn ghost btn-sm no-print" data-copy="${esc(o.number)}">${icon('copy')}<span>نسخ</span></button>
            </div>
          ` : ''}
        </div>

        ${o.esimCode ? `
          <div class="shop-lpa-box no-print">
            <small class="muted">كود التفعيل اليدوي (LPA):</small>
            <div class="shop-lpa-row">
              <code class="ltr">${esc(o.esimCode)}</code>
              <button type="button" class="btn ghost btn-sm" data-copy="${esc(o.esimCode)}">${icon('copy')}<span>نسخ</span></button>
            </div>
          </div>
        ` : ''}

        <div class="row no-print" style="justify-content:center;gap:10px;flex-wrap:wrap">
          <a class="btn primary" href="${esc(o.esimQr)}" download="esim-${esc(o.number || o.code)}.png">
            ${icon('download')}<span>تحميل الـ QR</span>
          </a>
          <button type="button" class="btn ghost" id="print-qr-btn">
            ${icon('print')}<span>طباعة</span>
          </button>
        </div>

        ${o.qrMailed ? `<p class="muted" style="margin:0;font-size:.84rem">${icon('checkCircle')} أُرسلت نسخة إلى <span class="ltr">${esc(o.email)}</span></p>` : ''}

        <div class="shop-qr-guides">
          <div class="shop-qr-guide-col">
            <b>على iPhone:</b>
            <ol>
              <li>الإعدادات ← خلوي ← إضافة شريحة إلكترونية.</li>
              <li>اختر <b>استخدام رمز QR</b> وامسح الكود.</li>
            </ol>
          </div>
          <div class="shop-qr-guide-col">
            <b>على Android:</b>
            <ol>
              <li>الضبط ← الاتصالات ← إدارة SIM ← إضافة eSIM.</li>
              <li>امسح الكود وانتظر اكتمال التنزيل.</li>
            </ol>
          </div>
        </div>
      </div>
    ` : ''}

    ${o.stage === 'done' && !hasQr ? `
      <div class="card empty">
        ${icon('checkCircle')}
        <p>تمّ تفعيل باقتك بنجاح.</p>
        <a href="#/" class="btn ghost">العودة للمتجر</a>
      </div>
    ` : ''}

    ${wa ? `<a class="btn ghost no-print" style="justify-self:center" href="${esc(wa)}" target="_blank" rel="noopener">${icon('whatsapp')}<span>تواصل مع الدعم</span></a>` : ''}
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
