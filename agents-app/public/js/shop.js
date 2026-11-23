// Customer Storefront (/shop): Authentic eSIM & Telecom Plan Storefront.
// Uses ES module imports from ./core.js — zero emojis, crisp vector SVGs, full pages & sheets.
import {
  esc, icon, fmtNum, fmtDateTime, fmtDate, fmtTime, specs, companyLogo,
  fileToDataUrl, copyText, toast, fmtPhone, sheet, closeSheet, go,
} from './core.js';
import { extractGb, extractDays } from './catalog-compare.js';

const MY_ORDERS_KEY = 'agents.shop.orders';
const CODE_RE = /^[A-Z0-9]{6,12}$/;
function savedOrderCodes() {
  try {
    return JSON.parse(localStorage.getItem(MY_ORDERS_KEY) || '[]')
      .filter((x) => typeof x === 'string')
      .map((x) => x.trim().toUpperCase())
      .filter((x) => CODE_RE.test(x));
  } catch { return []; }
}
function rememberOrderCode(code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!CODE_RE.test(clean)) return;
  const list = [clean, ...savedOrderCodes().filter((c) => c !== clean)].slice(0, 30);
  try { localStorage.setItem(MY_ORDERS_KEY, JSON.stringify(list)); } catch {}
}

const BUYER_KEY = 'agents.shop.buyer';
function loadBuyer() {
  try {
    const o = JSON.parse(localStorage.getItem(BUYER_KEY) || '{}');
    return { customerName: String(o.customerName || '').slice(0, 80), email: String(o.email || '').slice(0, 120) };
  } catch { return { customerName: '', email: '' }; }
}
function saveBuyer({ customerName = '', email = '' }) {
  try {
    const prev = loadBuyer();
    const next = {
      customerName: customerName && customerName !== 'زبون المتجر' ? customerName : prev.customerName,
      email: email || prev.email,
    };
    localStorage.setItem(BUYER_KEY, JSON.stringify(next));
  } catch {}
}

function validQrDataUrl(src) {
  return typeof src === 'string' && /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(src.trim());
}

function copyWithFeedback(btn, val) {
  copyText(val);
  if (!btn) return;
  const span = btn.querySelector('span');
  const prev = span ? span.textContent : '';
  btn.classList.add('is-copied');
  if (span) span.textContent = '✓ تم النسخ';
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    btn.classList.remove('is-copied');
    if (span && prev) span.textContent = prev;
  }, 1800);
}

function renderPaymentSecurityShield() {
  return `
    <div class="shop-sec-shield">
      <div class="shop-sec-shield-head">
        <span class="shop-sec-shield-ic">${icon('bolt')}</span>
        <div>
          <b>التحقق والتفعيل يتم تلقائياً وخلال ثوانٍ</b>
        </div>
      </div>
    </div>
  `;
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

function fmtShekel(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return `${fmtNum(v)} ₪`;
}

const CARRIER_SEO = [
  { re: /سلكوم|cellcom/i, en: 'Cellcom', about: 'تتميّز شبكة سلكوم (Cellcom) بتغطية قوية وسرعات إنترنت عالية تدعم الجيل الخامس 5G في الضفة الغربية وقطاع غزة والقدس وفلسطين مع استقرار ممتاز للمكالمات والإنترنت.' },
  { re: /هوت|hot/i, en: 'Hot Mobile', about: 'تُعدّ شبكة هوت موبايل (Hot Mobile) من أكثر الشبكات طلباً لشرائح eSIM في الضفة الغربية وقطاع غزة وفلسطين بفضل عروضها المرنة لمدة 30 يوماً و90 يوماً وأسعارها الاقتصادية.' },
  { re: /بيلفون|pelephone/i, en: 'Pelephone', about: 'توفّر شبكة بيلفون (Pelephone) أداءً قوياً على شبكات 4G و5G مع جودة اتصال عالية وتغطية واسعة في الضفة الغربية وقطاع غزة والقدس ومناسبة للاستخدام اليومي المكثّف.' },
  { re: /بارتنر|partner/i, en: 'Partner', about: 'تقدّم شبكة بارتنر (Partner) باقات إنترنت كبيرة بسرعات 5G فائقة ومناسبة للتصفح، البث، والعمل عن بُعد في الضفة الغربية وقطاع غزة وفلسطين.' },
  { re: /\bwe\b|وي|wecom/i, en: 'WE (Wecom)', about: 'تتميّز باقات وي (WE / Wecom) بأكبر سعات الإنترنت مقابل السعر في الضفة الغربية وغزة مع خيارات توفير شهرية وعروض 90 يوماً.' },
  { re: /019/i, en: '019 Mobile', about: 'توفّر 019 موبايل (019 Mobile) باقات eSIM سريعة وموثوقة في الضفة الغربية وغزة مع تفعيل فوري وأسعار منافسة.' },
  { re: /aloha|الوها|ألوها/i, en: 'ALOHA', about: 'تتيح شرائح ALOHA تفعيل eSIM فوري وسهل في الضفة الغربية وقطاع غزة مع باقات إنترنت ومكالمات مناسبة للاستخدام اليومي.' },
  { re: /جولان|golan/i, en: 'Golan Telecom', about: 'توفّر جولان تليكوم (Golan Telecom) باقات eSIM مرنة بتغطية جيدة وسرعات إنترنت عالية في الضفة الغربية وقطاع غزة.' },
  { re: /رامي|rami/i, en: 'Rami Levy', about: 'تقدّم رامي ليفي (Rami Levy) باقات اتصال وإنترنت اقتصادية بتفعيل eSIM فوري في الضفة الغربية وقطاع غزة وفلسطين.' },
];
function carrierSeoInfo(name = '') {
  return CARRIER_SEO.find((c) => c.re.test(name)) || {
    en: name || 'Hot eSIM',
    about: `توفّر شبكة ${name || 'Hot eSIM'} اتصال إنترنت سريعاً ومكالمات مستقرة عبر شريحة eSIM إلكترونية فورية في الضفة الغربية وقطاع غزة والقدس وفلسطين.`,
  };
}

function setPageMeta({ title, description, canonicalPath = '/' }) {
  if (title) document.title = title;
  if (description) {
    let md = document.querySelector('meta[name="description"]');
    if (!md) { md = document.createElement('meta'); md.setAttribute('name', 'description'); document.head.appendChild(md); }
    md.setAttribute('content', description);
  }
  const canon = document.querySelector('link[rel="canonical"]');
  if (canon) canon.setAttribute('href', `${location.origin}${canonicalPath}`);
}

function openPackagePage(id) {
  const target = `/package/${encodeURIComponent(String(id))}`;
  if (location.pathname !== target || location.hash) {
    history.pushState(null, '', target);
  }
  route();
}

const S = {
  data: null,
  companyId: 'all',
  duration: 'all', // 'all' | '30' | '90'
  sort: 'gb_desc', // 'gb_desc' | 'price_asc' (default: data quantity DESC, then price ASC)
  kindFilter: 'esim', // 'esim' | 'card'
  q: '',
  compatBrand: 'apple',
  compatSearch: '',
  infoTab: 'purchase', // 'purchase' | 'number' | 'credit' | ''
  openCompatBrand: '', // 'apple' | 'samsung' | 'xiaomi' | 'google' | ''
  openFaqIdx: -1,
  order: null,
  pollTimer: null,
  countdownTimer: null,
  myCodes: savedOrderCodes(),
  myOrders: null,
  wantEsim: false,
  esimAvailable: null,
  instantBusy: false,
  seq: 0,
};

const root = document.getElementById('shop');

function getTheme() {
  try {
    const saved = localStorage.getItem('agents.theme') || localStorage.getItem('theme');
    if (saved) return saved;
  } catch {}
  return matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('agents.theme', t);
    localStorage.setItem('theme', t);
  } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'dark' ? '#120D18' : '#17111F';
}
applyTheme(getTheme());

const CLIENT_ID_KEY = 'agents.shop.client_id';
function getClientId() {
  let id = '';
  try { id = localStorage.getItem(CLIENT_ID_KEY) || ''; } catch {}
  if (!id || id.length < 10) {
    id = 'c_' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));
    try { localStorage.setItem(CLIENT_ID_KEY, id); } catch {}
  }
  return id;
}

async function jfetch(path, opts = {}) {
  const headers = {
    'X-Client-Id': getClientId(),
    ...(opts.headers || {}),
  };
  let body = opts.body;
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { ...opts, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `خطأ (${res.status})`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

// Signature Hot eSIM Brand Logo (#h-mark): Chamfered H-shaped SIM body + Warm cream chip crossbar + Rising flame
let svgUid = 0;
function brandLogoSvg(cls = 'hsim-logo-svg') {
  const id = ++svgUid;
  return `<svg class="${cls}" viewBox="18 16 204 204" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="hHeat${id}" gradientUnits="userSpaceOnUse" x1="0" y1="216" x2="0" y2="20">
        <stop offset="0" stop-color="#E0123E"/>
        <stop offset="0.55" stop-color="#FF4A1F"/>
        <stop offset="1" stop-color="#FFB21E"/>
      </linearGradient>
    </defs>
    <path d="M62 52 L80 52 Q88 52 88 60 L88 96 Q88 104 96 104 L144 104 Q152 104 152 96 L152 60 Q152 52 160 52 L168 52 L194 78 L194 200 Q194 216 178 216 L160 216 Q152 216 152 208 L152 184 Q152 176 144 176 L96 176 Q88 176 88 184 L88 208 Q88 216 80 216 L62 216 Q46 216 46 200 L46 68 Q46 52 62 52 Z" fill="url(#hHeat${id})"/>
    <rect x="88" y="116" width="64" height="48" rx="10" fill="#FFF1DC"/>
    <g stroke="#F0302F" stroke-width="4">
      <line x1="109.3" y1="116" x2="109.3" y2="164"/>
      <line x1="130.7" y1="116" x2="130.7" y2="164"/>
      <line x1="88" y1="140" x2="152" y2="140"/>
    </g>
    <path d="M120 98 C106.7 98 97.2 87.6 97.2 73.3 C97.2 58.1 108.6 48.6 114.3 39.1 C118.1 33.4 121 27.7 121.9 20.1 C133.3 31.5 142.8 48.6 142.8 69.5 C142.8 86.6 133.3 98 120 98 Z" fill="url(#hHeat${id})"/>
    <path d="M0 -8 C-8 -8 -12 -14 -12 -23 C-12 -33 -5 -39 1 -50 C7 -41 12 -33 12 -23 C12 -14 8 -8 0 -8 Z" transform="translate(120 98) scale(0.95)" fill="#FFE58A"/>
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
  return Boolean(pk && pk.kind !== 'card' && (pk.esim || pk.kind === 'esim'));
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
    return `<span class="brand-lockup" dir="ltr"><span class="brand-word-hot">Hot</span><span class="brand-word-esim">eSIM</span></span>`;
  }
  return `<span class="brand-lockup"><span class="brand-word-custom">${esc(clean)}</span></span>`;
}

function shell(body, { sub = '' } = {}) {
  const rawBrand = S.data?.shopTitle || S.data?.appName || 'Hot eSIM';
  const name = rawBrand;
  const subtitle = sub || S.data?.shopSubtitle || 'شرائح وباقات فورية';
  const wa = waHref(S.data?.supportWhatsapp, `مرحباً، أحتاج مساعدة في ${name}`);
  const dark = document.documentElement.dataset.theme === 'dark';
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  const pathSlug = !hash ? location.pathname.replace(/^\/|\/$/g, '').toLowerCase() : '';
  const activeRoute = hash || pathSlug;
  const onPackagePath = /^\/package\/\d+/.test(location.pathname);
  const onHome = !activeRoute && !onPackagePath;
  const onLegal = activeRoute === 'terms' || activeRoute === 'esim-policy' || activeRoute === 'guarantee';

  root.innerHTML = `
    <header class="shop-top">
      <div class="shop-top-inner">
        <a href="/" class="shop-brand" data-act="nav-esim" aria-label="${esc(name)}">
          <span class="shop-brand-mark">${brandLogoSvg('hsim-logo-svg')}</span>
          <span class="shop-brand-text">
            <span class="shop-brand-title-row">
              ${renderBrandWordmark(rawBrand)}
            </span>
            <small><span class="shop-live-dot"></span>${esc(subtitle)}</small>
          </span>
        </a>

        <nav class="shop-nav" aria-label="التنقّل في المتجر">
          <button type="button" class="shop-nav-link ${onHome ? 'active' : ''}" data-act="nav-esim">
            ${icon('qr')}<span>شرائح eSIM</span>
          </button>
          <a href="/compat" data-spa-link class="shop-nav-link ${activeRoute === 'compat' ? 'active' : ''}">
            ${icon('chip')}<span>فحص التوافق</span>
          </a>
          <a href="/terms" data-spa-link class="shop-nav-link ${onLegal ? 'active' : ''}">
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

    <footer class="pele-footer no-print">
      <div class="pele-footer-wrap">
        <div class="pele-right-foot">
          <div class="row" style="gap:10px">
            <span class="shop-brand-mark">${brandLogoSvg('hsim-logo-svg')}</span>
            <div>
              ${renderBrandWordmark(rawBrand)}
              <small class="muted" style="display:block;font-size:.78rem;margin-top:3px">شرائح eSIM فورية برقم جديد</small>
            </div>
          </div>
          <div class="pele-foot-net">
            ${wa ? `<a href="${esc(wa)}" target="_blank" rel="noopener" class="pele-net-ic" title="واتساب">${icon('whatsapp')}</a>` : ''}
            <a href="#/track" class="pele-net-ic" title="تتبّع طلب">${icon('search')}</a>
            <a href="/compat" data-spa-link class="pele-net-ic" title="فحص التوافق">${icon('chip')}</a>
            <button type="button" class="pele-net-ic" data-act="theme" title="تغيير المظهر">${icon(dark ? 'sun' : 'moon')}</button>
          </div>
        </div>

        <div class="pele-left-foot">
          <div class="pele-lnks">
            <div>
              <h3 class="ttl">عام والخدمات</h3>
              <a href="/" data-act="nav-esim">باقات شرائح eSIM</a>
              <a href="/compat" data-spa-link class="${activeRoute === 'compat' ? 'active' : ''}">فحص توافق الهاتف مع eSIM</a>
              <a href="#/track" class="${hash === 'track' ? 'active' : ''}">تتبّع حالة طلب</a>
            </div>
            <div>
              <h3 class="ttl">الشروط والدعم</h3>
              <a href="/terms" data-spa-link class="${activeRoute === 'terms' ? 'active' : ''}">شروط البيع والتفعيل</a>
              <a href="/esim-policy" data-spa-link class="${activeRoute === 'esim-policy' ? 'active' : ''}">سياسة كود eSIM QR</a>
              <a href="/guarantee" data-spa-link class="${activeRoute === 'guarantee' ? 'active' : ''}">ضمان المتجر واسترجاع المبلغ</a>
              ${wa ? `<a href="${esc(wa)}" target="_blank" rel="noopener">تواصل معنا عبر واتساب</a>` : ''}
            </div>
          </div>
        </div>
      </div>
    </footer>

    <!-- Mobile Thumb-Friendly Bottom Navigation Dock -->
    <nav class="shop-bottom-nav no-print" aria-label="التنقّل السريع للهاتف">
      <button type="button" class="shop-bnav-item ${onHome ? 'active' : ''}" data-act="nav-esim">
        ${icon('qr')}
        <span>شرائح eSIM</span>
      </button>
      <a href="/compat" data-spa-link class="shop-bnav-item ${activeRoute === 'compat' ? 'active' : ''}">
        ${icon('chip')}
        <span>التوافق</span>
      </a>
      <a href="/terms" data-spa-link class="shop-bnav-item ${onLegal ? 'active' : ''}">
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

// The shop sells eSIMs only: one catalog.
function switchCatalogTab(_kind, { scroll = false } = {}) {
  const packages = S.data?.packages || [];
  if (S.companyId !== 'all' && !packages.some((p) => String(p.companyId) === String(S.companyId))) {
    S.companyId = 'all';
  }
  if (location.pathname !== '/') {
    history.pushState(null, '', '/');
    route();
    return;
  }
  if (location.hash && location.hash !== '#/') {
    location.hash = '#/';
  } else {
    viewCatalog();
    if (scroll) document.getElementById('sec-packs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function bindGlobalTriggers(scope) {
  scope.querySelectorAll('[data-pkg-link]').forEach((a) => {
    a.onclick = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      openPackagePage(a.dataset.pkgLink);
    };
  });
  scope.querySelectorAll('[data-spa-link]').forEach((a) => {
    a.onclick = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      const target = a.getAttribute('href') || '/';
      if (location.pathname !== target || location.hash) history.pushState(null, '', target);
      route();
    };
  });
  scope.querySelectorAll('[data-act="theme"]').forEach((b) => {
    b.onclick = () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      const dark = next === 'dark';
      const label = dark ? 'الوضع الفاتح' : 'الوضع الداكن';
      document.querySelectorAll('[data-act="theme"]').forEach((btn) => {
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
        btn.innerHTML = icon(dark ? 'sun' : 'moon');
      });
    };
  });
  scope.querySelectorAll('[data-jump]').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      const targetId = b.dataset.jump;
      const el = document.getElementById(targetId);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  scope.querySelectorAll('[data-act="nav-all"], [data-act="nav-esim"]').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      switchCatalogTab('esim', { scroll: true });
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
                <td><b>حذف الـ eSIM بعد تثبيتها</b></td>
                <td>بعد تنفيذ التفعيل لدى شركة الاتصالات لا يمكن إلغاؤه.</td>
                <td><span class="pill s-bad">غير قابل للاسترجاع</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  const banks = Array.isArray(S.data?.jawwalBanks) ? S.data.jawwalBanks : [];
  const payLine = S.data?.jawwalDirect
    ? `يتم الدفع مباشرة وبشكل آمن عبر <b>Jawwal Pay</b>${banks.length ? ` أو <b>${banks.map((b) => esc(b.name)).join(' أو ')}</b>` : ''} برمز تحقق SMS يصلك على جوالك${S.data?.manualPay !== false ? '، أو عبر التحويل اليدوي' : ''} — ويتفعّل الطلب تلقائياً فور تأكيد الدفع.`
    : 'يتم الدفع عبر <b>Jawwal Pay</b> أو <b>PalPay</b> ثم إدخال اسم المحوِّل أو الرقم المرجعي لتفعيل الطلب تلقائياً.';

  return `
    <div class="esim-legal-panel">
      <h4>١. الأسعار والدفع</h4>
      <ul class="esim-legal-list">
        <li>جميع الأسعار المعروضة بالشيكل (₪) صريحة ونهائية وتشمل تفاصيل رسوم شريحة eSIM QR بوضوح قبل الدفع.</li>
        <li>${payLine}</li>
      </ul>
    </div>

    <div class="esim-legal-panel">
      <h4>٢. التفعيل وحجز الأرقام</h4>
      <ul class="esim-legal-list">
        <li><b>طلبات eSIM:</b> يُحجز رقم الخط الجديد للطلب لمدة 10 دقائق بانتظار إتمام الدفع، وفي حال عدم الإتمام خلال 10 دقائق تُلغى الطلبية تلقائياً ويُتاح الرقم من جديد.</li>
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
        <a href="/" data-act="nav-esim" class="btn ghost btn-sm">← المتجر</a>
      </div>

      <div class="esim-brand-tabs" role="tablist" aria-label="أقسام الشروط">
        <a href="/terms" data-spa-link role="tab" class="esim-brand-tab" aria-selected="${tab === 'terms'}">
          <b>شروط البيع والتفعيل</b>
        </a>
        <a href="/esim-policy" data-spa-link role="tab" class="esim-brand-tab" aria-selected="${tab === 'esim'}">
          <b>سياسة كود eSIM QR</b>
        </a>
        <a href="/guarantee" data-spa-link role="tab" class="esim-brand-tab" aria-selected="${tab === 'guarantee'}">
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
      return { go: `#/order/${encodeURIComponent(code)}` };
    },
  });
}

async function viewTrackPage(seq) {
  clearInterval(S.pollTimer);
  const codes = S.myCodes;
  if (codes.length) {
    const results = await Promise.all(codes.map((c, i) => jfetch(`/api/shop/orders/${encodeURIComponent(c)}${i === 0 ? '?check=1' : ''}`).catch(() => null)));
    if (seq !== S.seq) return;
    S.myOrders = results.filter(Boolean);
  } else {
    S.myOrders = [];
  }
  if (seq !== S.seq) return;
  const ordersList = S.myOrders || [];
  const wa = waHref(S.data?.supportWhatsapp, 'مرحباً، أحتاج مساعدة بخصوص طلبي');

  shell(`
    <section class="esim-page-wrap">
      <div class="esim-page-head">
        <div>
          <span class="esim-hero-kicker">${icon('search')}<span>متابعة الطلبات</span></span>
          <h1>طلباتي ومتابعة التفعيل</h1>
          <p class="muted">يتم التحقق من حالة الدفع وتحديث الطلبات تلقائياً فور دخولك لهذه الصفحة.</p>
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
            ${icon('search')}<span>تحقق وعرض الطلب</span>
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
              const supportNeeded = Boolean(o.needsSupport || (o.waitUntil && Date.now() >= Number(o.waitUntil) && (o.status === 'verifying' || o.status === 'review')));
              const isWaiting15 = !supportNeeded && (o.status === 'verifying' || o.status === 'review') && (Number(o.proofTries) >= 2 || o.status === 'review');
              const pillCls = supportNeeded ? 's-bad' : st.cls;
              const pillLabel = supportNeeded ? 'يرجى التحدث مع الدعم' : (isWaiting15 ? 'بانتظار التحقق (حتى 15 د)' : st.label);
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
                        ${supportNeeded ? `<small style="display:block;color:var(--danger,#dc2626);margin-top:4px;font-weight:700">مضت 15 دقيقة ولم يُعثر على المعاملة — اضغط للتحدث مع الدعم</small>` : ''}
                      </div>
                    </div>
                    <div style="text-align:end;display:grid;gap:4px;justify-items:end">
                      <b class="mono">${fmtShekel(o.amount)}</b>
                      <span class="pill ${pillCls}">${esc(pillLabel)}</span>
                    </div>
                  </div>
                </a>`;
            }).join('')}
          </div>
        ` : `
          <div class="empty" style="padding:20px 14px">
            ${icon('list')}
            <b>لا توجد طلبات محفوظة على هذا الجهاز</b>
            <span>أدخل رمز الطلب في الحقل أعلاه لعرضه والتحقق منه تلقائياً.</span>
          </div>
        `}
        ${wa && ordersList.some((o) => o.needsSupport) ? `
          <div class="row" style="justify-content:center;margin-top:12px">
            <a class="btn primary" href="${esc(wa)}" target="_blank" rel="noopener">${icon('whatsapp')}<span>التحدث مع الدعم</span></a>
          </div>
        ` : ''}
      </div>
    </section>
  `, { sub: 'طلباتي' });

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
        const order = await jfetch(`/api/shop/orders/${encodeURIComponent(raw)}?check=1`);
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

const HOME_FAQ_ITEMS = [
  {
    q: 'ما هي شريحة eSIM؟',
    a: 'هي شريحة اتصال إلكترونية مدمجة داخل هاتفك يتم تنزيلها وتفعيلها فوراً عبر مسح كود QR بعد شراء الباقة دون الحاجة لبطاقة بلاستيكية. يمكنك <a href="#sec-compat" data-jump="sec-compat">فحص توافق جهازك من هنا</a>.',
  },
  {
    q: 'كيف أعرف إذا كان جهازي يدعم شريحة eSIM؟',
    a: 'يمكنك الضغط على قسم <a href="#sec-compat" data-jump="sec-compat">الأجهزة المتوافقة</a> في هذه الصفحة واختيار نوع هاتفك، أو طلب الكود <kbd dir="ltr">*#06#</kbd> في لوحة اتصال الهاتف للتأكد من ظهور رقم <b>EID</b>.',
  },
  {
    q: 'متى تتفعل الباقة بعد الشراء؟',
    a: 'طلبت شريحة eSIM جديدة؟ تتفعل باقة الإنترنت والمكالمات فور مسح كود الـ QR والاتصال بالشبكة.',
  },
  {
    q: 'استلمت كود QR، كيف أقوم بمسحه على هاتفي؟',
    a: 'ادخل إلى إعدادات الجهاز (الإعدادات ← خلوي ← إضافة eSIM في آيفون، أو الضبط ← الاتصالات ← إدارة SIM في أندرويد) وامسح الكود أثناء اتصالك بشبكة Wi-Fi. يمكنك مراجعة <a href="#/esim-policy">دليل التثبيت الكامل هنا</a>.',
  },
  {
    q: 'كيف أفعّل شريحة HOT eSIM؟',
    a: 'بعد إتمام الدفع يظهر لك كود الـ QR مباشرة في صفحة الطلب. لتفعيل الشريحة تأكد من:<br>1. وجود اتصال بالإنترنت (Wi-Fi).<br>2. جاهزية كود الـ QR للمسح من شاشة أخرى أو استخدام كود التفعيل اليدوي (LPA).',
  },
  {
    q: 'كيف أفحص حالة طلبي؟',
    a: 'اضغط على <a href="#/track">رصيدي وطلباتي</a> لعرض حالة طلبك أو استخراج كود الـ QR في أي وقت.',
  },
  {
    q: 'الشروط والأحكام وضمان المتجر',
    a: 'يمكنك الاطلاع على كافة التفاصيل عبر صفحة <a href="#/terms">شروط البيع والتفعيل</a> وصفحة <a href="#/guarantee">ضمان المتجر واسترجاع المبلغ</a>.',
  },
];

function renderInfoTabContent(tab) {
  if (tab === 'number') {
    return `
      <div class="pele-info-panel">
        <div class="pele-dtls">
          <div class="pele-txt3">نسيت رقم هاتف شريحة eSIM الخاصة بك؟</div>
          <p>لمعرفة رقم هاتفك مباشرة من داخل الجهاز:</p>
          <p><b class="ltr">iOS (iPhone):</b> الإعدادات &gt; خلوي (Cellular) &gt; الشريحة (SIM)</p>
          <p><b class="ltr">Android:</b> الضبط &gt; الاتصالات &gt; إدارة بطاقة SIM</p>
          <div class="pele-info-highlight">
            ${icon('whatsapp')}
            <strong>تحتفظ بحسابك ورقمك على واتساب (WhatsApp) كما هو تماماً دون أي تغيير</strong>
          </div>
        </div>
      </div>
    `;
  }
  if (tab === 'credit') {
    return `
      <div class="pele-info-panel">
        <div class="pele-dtls">
          <div class="pele-txt3">فحص حالة الطلب والرصيد</div>
          <p>
            يمكنك متابعة حالة طلبك واستخراج كود الـ QR في أي وقت عبر صفحة <a href="#/track">رصيدي وطلباتي</a>.<br>
            يتم إشعارك تلقائياً بحالة التفعيل وموعد انتهاء صلاحية الباقة.
          </p>
        </div>
      </div>
    `;
  }
  return `
    <div class="pele-info-panel">
      <div class="pele-dtls">
        <div class="pele-txt3">التوافق مع شريحة eSIM</div>
        <p>
          قبل الشراء تأكد أن هاتفك <a href="#sec-compat" data-jump="sec-compat">متوافق مع تقنية eSIM</a>.<br>
          بعد إتمام الشراء والدفع يصدر لك كود QR فوراً. لتفعيل شريحة <b>HOT eSIM</b> يرجى التأكد من:<br>
          1. وجود اتصال بالإنترنت (Wi-Fi) على هاتفك.<br>
          2. أن كود الـ QR جاهز للمسح (مطبوع أو معروض على شاشة أخرى أو عبر النسخ اليدوي LPA).
        </p>
        <div class="pele-txt3" style="margin-top:16px">إعدادات الجهاز والتثبيت</div>
        <p>
          بعد مسح كود الـ QR ادخل إلى إعدادات الهاتف واتبع <a href="#/esim-policy">خطوات نظام التشغيل</a> لتفعيل الخط.<br>
          طريقة تنزيل الشريحة متاحة خطوة بخطوة لأجهزة <a href="#/esim-policy">Apple iPhone</a> وأجهزة <a href="#/esim-policy">Android / Samsung</a>.
        </p>
        <div class="pele-info-highlight" style="margin-top:14px">
          ${icon('info')}
          <div>
            <strong>ملاحظة هامة:</strong><br>
            تتفعل باقة شريحة eSIM فور مسح الكود والاتصال بالشبكة.
          </div>
        </div>
      </div>
    </div>
  `;
}

async function viewPackage(id, seq) {
  const companies = S.data?.companies || [];
  const livePackages = S.data?.packages || [];
  const coMap = new Map(companies.map((c) => [c.id, c]));

  let pk = livePackages.find((p) => String(p.id) === String(id));
  let co = pk ? (coMap.get(pk.companyId) || { id: pk.companyId, name: pk.companyName }) : null;
  let available = Boolean(pk && S.data?.enabled);
  let related = pk
    ? [
        ...livePackages.filter((r) => r.id !== pk.id && r.companyId === pk.companyId),
        ...livePackages.filter((r) => r.id !== pk.id && r.companyId !== pk.companyId),
      ].slice(0, 6)
    : [];

  if (!pk) {
    shell(`<div class="card empty"><p class="muted">جارٍ تحميل تفاصيل الباقة...</p></div>`, { sub: 'تفاصيل الباقة' });
    try {
      const res = await jfetch(`/api/shop/package/${encodeURIComponent(id)}`);
      if (seq !== S.seq) return;
      pk = res.package;
      co = res.company || { id: pk.companyId, name: pk.companyName };
      available = Boolean(res.available);
      related = Array.isArray(res.related) ? res.related : [];
    } catch {
      if (seq !== S.seq) return;
      setPageMeta({ title: `الباقة غير متوفرة | ${S.data?.shopTitle || 'Hot eSIM'}`, canonicalPath: '/' });
      shell(`
        <div class="card empty">
          ${icon('alert')}
          <p>هذه الباقة غير متوفرة حالياً — يمكنك اختيار باقة أخرى متوفرة الآن.</p>
          <a href="/" class="btn primary" data-act="nav-esim">${icon('qr')}<span>تصفّح جميع الباقات</span></a>
        </div>
      `, { sub: 'الباقة غير متوفرة' });
      return;
    }
  }
  if (seq !== S.seq) return;

  const shopName = S.data?.shopTitle || 'Hot eSIM';
  const sp = extractPackageSpecs(pk, co);
  const cm = carrierSeoInfo(sp.companyName);
  const qrFee = Number(pk.esimFee ?? co?.esimFee ?? S.data?.esimFee ?? 0);
  const total = pkgTotalPrice(pk, co);
  const featured = isFeaturedPkg(pk);
  const cleanName = String(pk.name || '').trim();
  const headline = cleanName && !cleanName.toLowerCase().startsWith(sp.companyName.toLowerCase())
    ? `${sp.companyName} ${cleanName}`
    : (cleanName || `${sp.companyName} ${sp.mainCap}`);
  const banks = Array.isArray(S.data?.jawwalBanks) ? S.data.jawwalBanks : [];
  const payBadges = S.data?.jawwalDirect
    ? ['Jawwal Pay', ...banks.map((b) => b.name)].join(' · ')
    : 'Jawwal Pay · PalPay';
  const wa = waHref(S.data?.supportWhatsapp, `مرحباً، أستفسر عن باقة ${headline} (${fmtShekel(total)})`);

  const feeText = qrFee > 0
    ? `يشمل سعر الباقة (${fmtShekel(pk.price)}) بالإضافة إلى رسوم إصدار شريحة eSIM QR (${fmtShekel(qrFee)}) بدون أي رسوم مخفية.`
    : 'يشمل كود eSIM QR مجاناً بدون أي رسوم إضافية.';

  const pkgFaqs = [
    {
      q: `كم سعر باقة ${headline} شاملة شريحة eSIM؟`,
      a: `السعر الإجمالي لباقة ${headline} هو ${fmtShekel(total)} فقط، و${feeText}`,
    },
    {
      q: `ماذا تشمل باقة ${sp.companyName}${sp.gb ? ` ${fmtNum(sp.gb)} جيجا` : ''} وهل تعمل في الضفة الغربية وغزة؟`,
      a: `نعم، تعمل الباقة في الضفة الغربية وقطاع غزة والقدس وفلسطين، وتشمل ${sp.dataLabel} و${sp.callsLabel} على شريحة eSIM برقم جديد صالحة لمدة ${fmtNum(sp.days)} يوماً.`,
    },
    {
      q: `كيف أحصل على كود QR لتفعيل باقة ${sp.companyName} في الضفة وغزة؟`,
      a: `بعد إتمام الطلب والدفع الآمن عبر ${payBadges} في متجر ${shopName}، يظهر لك كود QR وكود التفعيل اليدوي (LPA) تلقائياً خلال ثوانٍ، ويمكنك مسحه من إعدادات هاتفك أثناء الاتصال بشبكة Wi-Fi.`,
    },
    {
      q: 'هل يتغيّر رقم واتساب (WhatsApp) عند إضافة شريحة eSIM الجديدة؟',
      a: 'لا، يحتفظ هاتفك بحسابك ورقمك الحالي على واتساب كما هو تماماً دون أي تغيير، وتعمل شريحة eSIM كخط إنترنت واتصال إضافي على نفس الجهاز.',
    },
    {
      q: `كيف أتأكد أن هاتفي يدعم شريحة eSIM لباقة ${sp.companyName}؟`,
      a: 'اطلب الكود *#06# من لوحة اتصال هاتفك؛ إذا ظهر رقم EID فجهازك متوافق مع شريحة eSIM (معظم أجهزة iPhone XS والأحدث، سامسونج Galaxy S20–S25، و Google Pixel).',
    },
  ];

  setPageMeta({
    title: `باقة ${headline} eSIM (${fmtNum(sp.days)} يوم) بسعر ${fmtShekel(total)} | ${shopName} الضفة وغزة`,
    description: `اشترِ باقة ${headline} (${cm.en}) شريحة eSIM في الضفة الغربية وقطاع غزة والقدس وفلسطين: ${sp.dataLabel}، ${sp.callsLabel}، صالحة ${fmtNum(sp.days)} يوماً بسعر ${fmtShekel(total)} شامل كود QR فوري.`,
    canonicalPath: `/package/${pk.id}`,
  });

  let openFaq = 0;

  function renderPage() {
    shell(`
      <div class="pkg-page">
        <div class="pkg-breadcrumb-bar">
          <nav class="pkg-breadcrumb" aria-label="مسار التنقل">
            <a href="/" data-act="nav-esim">الرئيسية</a>
            <span>/</span>
            <a href="/" data-co-filter="${esc(String(pk.companyId))}">باقات ${esc(sp.companyName)}</a>
            <span>/</span>
            <strong aria-current="page">${esc(headline)}</strong>
          </nav>
          <a href="/" class="btn ghost btn-sm" data-act="nav-esim">→ كل الباقات</a>
        </div>

        <!-- 1. Hero Overview & Instant Buy Card -->
        <section class="pkg-hero" style="--co:${esc(co?.color || '#D9142F')}">
          <div class="pkg-hero-top">
            <div class="pkg-hero-badges">
              <span class="pele-5g-pill" dir="ltr"><i>e</i>SIM${sp.is5G ? ' <b>5G</b>' : ''}</span>
              ${featured ? '<span class="pele-offer-tag is-pop">الأكثر طلباً</span>' : sp.days >= 60 ? `<span class="pele-offer-tag">عرض ${fmtNum(sp.days)} يوم</span>` : ''}
              <span class="pkg-stock-pill ${available ? 'is-ok' : 'is-out'}">
                ${icon(available ? 'checkCircle' : 'clock')}
                <span>${available ? 'متوفرة الآن للتفعيل الفوري' : 'نفدت الأرقام مؤقتاً'}</span>
              </span>
            </div>
            <div class="pele-superlative">
              <div>
                <span>${fmtNum(sp.days)}</span>
                <span>يوماً</span>
              </div>
            </div>
          </div>

          <div class="pkg-hero-main">
            <div class="pkg-hero-info">
              <div class="pkg-carrier-chip">
                ${companyLogo(co || { name: sp.companyName }, 'sm')}
                <span>${esc(sp.companyName)}</span>
                <small class="ltr">${esc(cm.en)}</small>
              </div>
              <h1>باقة ${esc(headline)} — شريحة eSIM فورية</h1>
              <p class="pkg-hero-lead">
                ${esc(sp.dataLabel)} · ${esc(sp.callsLabel)} · صالحة لمدة ${fmtNum(sp.days)} يوماً برقم جديد وتفعيل تلقائي بكود QR في الضفة الغربية وقطاع غزة والقدس وفلسطين.
              </p>
              <div class="pkg-hero-highlights">
                <span>${icon('bolt')}تفعيل فوري بكود QR</span>
                <span>${icon('phone')}رقم جديد (واتسابك يبقى كما هو)</span>
                <span>${icon('shield')}دفع آمن: ${esc(payBadges)}</span>
              </div>
            </div>

            <div class="pkg-price-box">
              <div class="pkg-price-cap" dir="ltr">${esc(sp.mainCap)}</div>
              <div class="pkg-price-val" dir="ltr">${fmtNum(total)}<span>₪</span></div>
              <div class="pkg-price-note">
                ${qrFee > 0 ? `شامل الباقة (${fmtShekel(pk.price)}) + شريحة eSIM QR (${fmtShekel(qrFee)})` : 'شامل كود eSIM QR مجاناً بدون رسوم إضافية'}
              </div>
              ${available ? `
                <a class="btn primary lg pkg-buy-cta" id="pkg-buy-btn" href="#/buy/${pk.id}?esim=1">
                  ${icon('qr')}<span>شراء الآن · ${fmtShekel(total)}</span>
                </a>
              ` : `
                <a class="btn ghost lg pkg-buy-cta" href="/" data-act="nav-esim">
                  ${icon('search')}<span>تصفّح الباقات المتوفرة الآن</span>
                </a>
              `}
              <div class="pkg-secondary-actions">
                <button type="button" class="btn ghost btn-sm" data-act="compat-sheet">${icon('chip')}<span>فحص توافق جهازي</span></button>
                <button type="button" class="btn ghost btn-sm" id="pkg-share-btn">${icon('share')}<span>مشاركة الباقة</span></button>
              </div>
            </div>
          </div>
        </section>

        <!-- 2. Structured Package Specifications -->
        <section class="card pkg-section">
          <h2 class="pkg-sec-title">${icon('list')}<span>مواصفات باقة ${esc(headline)}</span></h2>
          <div class="pkg-specs-grid">
            <div class="pkg-spec-item">
              <span class="pkg-spec-k">الشبكة / المشغّل</span>
              <b class="pkg-spec-v">${esc(sp.companyName)} <small class="ltr muted">(${esc(cm.en)})</small></b>
            </div>
            <div class="pkg-spec-item">
              <span class="pkg-spec-k">حزمة الإنترنت</span>
              <b class="pkg-spec-v">${esc(sp.dataLabel)}</b>
            </div>
            <div class="pkg-spec-item">
              <span class="pkg-spec-k">المكالمات والرسائل</span>
              <b class="pkg-spec-v">${esc(sp.callsLabel)}</b>
            </div>
            <div class="pkg-spec-item">
              <span class="pkg-spec-k">مدة الصلاحية</span>
              <b class="pkg-spec-v">${fmtNum(sp.days)} يوماً من التفعيل</b>
            </div>
            <div class="pkg-spec-item">
              <span class="pkg-spec-k">نوع الشريحة</span>
              <b class="pkg-spec-v">شريحة إلكترونية eSIM برقم جديد</b>
            </div>
            <div class="pkg-spec-item">
              <span class="pkg-spec-k">طريقة الاستلام</span>
              <b class="pkg-spec-v">كود QR فوري + كود LPA يدوي + إيميل</b>
            </div>
            <div class="pkg-spec-item">
              <span class="pkg-spec-k">طرق الدفع المتاحة</span>
              <b class="pkg-spec-v">${esc(payBadges)}</b>
            </div>
            <div class="pkg-spec-item">
              <span class="pkg-spec-k">السعر الإجمالي</span>
              <b class="pkg-spec-v mono">${fmtShekel(total)}${qrFee > 0 ? ` <small class="muted">(${fmtNum(pk.price)} + ${fmtNum(qrFee)})</small>` : ''}</b>
            </div>
            ${sp.extraBonus ? `
              <div class="pkg-spec-item is-wide">
                <span class="pkg-spec-k">مزايا إضافية</span>
                <b class="pkg-spec-v">${esc(sp.extraBonus)}</b>
              </div>
            ` : ''}
          </div>
        </section>

        <!-- 3. Carrier & West Bank / Gaza SEO Guide -->
        <section class="card pkg-section">
          <h2 class="pkg-sec-title">${icon('info')}<span>عن باقة ${esc(sp.companyName)} (${esc(cm.en)}) في الضفة الغربية وغزة وفلسطين</span></h2>
          <p class="pkg-seo-text">${esc(cm.about)}</p>
          ${pk.description ? `<p class="pkg-seo-text">${esc(pk.description)}</p>` : ''}
          <div class="pkg-value-grid">
            <div class="pkg-value-card">
              <span class="pkg-value-ic">${icon('bolt')}</span>
              <b>تفعيل تلقائي خلال ثوانٍ</b>
              <p>يصدر كود QR وكود التفعيل اليدوي (LPA) فور إتمام الدفع مباشرة دون انتظار شريحة بلاستيكية.</p>
            </div>
            <div class="pkg-value-card">
              <span class="pkg-value-ic">${icon('whatsapp')}</span>
              <b>واتسابك يبقى كما هو</b>
              <p>تعمل الشريحة الإلكترونية كخط بيانات واتصال إضافي دون أي تأثير على حسابك ورقمك الحالي على واتساب.</p>
            </div>
            <div class="pkg-value-card">
              <span class="pkg-value-ic">${icon('shield')}</span>
              <b>ضمان التفعيل ودعم 24/7</b>
              <p>نضمن استلام كود QR فعّال 100% مع دعم مباشر عبر واتساب ومتابعة فورية لأي استفسار.</p>
            </div>
          </div>
        </section>

        <!-- 4. Step-by-Step eSIM Installation Guide -->
        <section class="card pkg-section">
          <h2 class="pkg-sec-title">${icon('qr')}<span>طريقة تفعيل شريحة eSIM على هاتفك</span></h2>
          <div class="shop-qr-guides">
            <div class="shop-qr-guide-col">
              <b>على أجهزة Apple iPhone (XS والأحدث):</b>
              <ol>
                <li>تأكد من الاتصال بشبكة Wi-Fi وافتح <b>الإعدادات ← خلوي ← إضافة eSIM</b>.</li>
                <li>اختر <b>استخدام رمز QR</b> (أو التثبيت المباشر على iOS 17.4+ / الإدخال اليدوي بكود LPA).</li>
                <li>فعّل <b>تجوال البيانات</b> واختر الشريحة الجديدة لبيانات الإنترنت.</li>
              </ol>
            </div>
            <div class="shop-qr-guide-col">
              <b>على أجهزة Android / Samsung Galaxy / Pixel:</b>
              <ol>
                <li>تأكد من الاتصال بشبكة Wi-Fi وافتح <b>الضبط ← الاتصالات ← إدارة SIM ← إضافة eSIM</b>.</li>
                <li>امسح كود الـ QR أو اختر صورة الـ QR المحفوظة من المعرض أو أدخل كود LPA يدوياً.</li>
                <li>انتظر ثوانٍ لاكتمال التثبيت واستمتع بالإنترنت فوراً.</li>
              </ol>
            </div>
          </div>
          <div class="esim-eid-check" style="margin-top:12px">
            <div class="esim-eid-icon">${icon('phone')}</div>
            <div class="grow">
              <strong>تأكّد من توافق جهازك قبل الشراء بـ <kbd dir="ltr">*#06#</kbd></strong>
              <p class="muted" style="margin:3px 0 0;font-size:.85rem">إذا ظهر رقم <b>EID</b> على الشاشة فجهازك يدعم شريحة eSIM. يمكنك أيضاً استخدام <a href="#/compat">أداة فحص توافق الأجهزة</a>.</p>
            </div>
          </div>
        </section>

        <!-- 5. Package-Specific FAQ Accordion -->
        <section class="pele-faq">
          <h2>أسئلة شائعة حول باقة ${esc(headline)}</h2>
          <div class="pele-faq-inner">
            ${pkgFaqs.map((item, idx) => {
              const isOpen = openFaq === idx;
              return `
                <div class="pele-faq-question ${isOpen ? 'open' : ''}" role="button" tabindex="0" data-pfaq-idx="${idx}" is-open="${isOpen ? 'yes' : 'no'}">
                  <span>${esc(item.q)}</span>
                  <i class="pele-faq-arrow">${icon('chevL')}</i>
                </div>
                <div class="pele-faq-answer ${isOpen ? 'open' : ''}">
                  <span>${esc(item.a)}</span>
                </div>
              `;
            }).join('')}
          </div>
        </section>

        <!-- 6. Related Packages (Internal Links for SEO & Easy Comparison) -->
        ${related.length ? `
          <section class="card pkg-section">
            <div class="row between" style="flex-wrap:wrap;gap:8px;margin-bottom:12px">
              <h2 class="pkg-sec-title" style="margin:0">${icon('grid')}<span>باقات eSIM أخرى قد تهمك</span></h2>
              <a href="/" class="btn ghost btn-sm" data-act="nav-esim">عرض الكل</a>
            </div>
            <div class="pkg-related-grid">
              ${related.map((r) => {
                const rCo = coMap.get(r.companyId) || { name: r.companyName };
                const rSp = extractPackageSpecs(r, rCo);
                const rTotal = pkgTotalPrice(r, rCo);
                return `
                  <a class="pkg-rel-card" href="/package/${r.id}" data-pkg-link="${esc(String(r.id))}">
                    <div class="pkg-rel-top">
                      <span class="pkg-rel-co">${companyLogo(rCo, 'sm')}<b>${esc(rSp.companyName)}</b></span>
                      <span class="pkg-rel-price" dir="ltr">${fmtNum(rTotal)}₪</span>
                    </div>
                    <div class="pkg-rel-meta">
                      <span>${esc(rSp.dataLabel)}</span>
                      <span>${fmtNum(rSp.days)} يوماً</span>
                    </div>
                  </a>
                `;
              }).join('')}
            </div>
          </section>
        ` : ''}

        <!-- Bottom Sticky-Friendly CTA -->
        <div class="esim-page-cta">
          <div>
            <h3 style="margin:0 0 2px">جاهز لتفعيل باقة ${esc(sp.companyName)} ${esc(sp.mainCap)}؟</h3>
            <p class="muted" style="margin:0;font-size:.85rem">السعر الإجمالي ${fmtShekel(total)} — استلام فوري لكود QR ودعم متواصل.</p>
          </div>
          <div class="row" style="gap:8px;flex-wrap:wrap">
            ${available ? `<a href="#/buy/${pk.id}?esim=1" class="btn primary lg" data-pkg-buy>${icon('qr')}<span>شراء الآن · ${fmtShekel(total)}</span></a>` : ''}
            ${wa ? `<a href="${esc(wa)}" target="_blank" rel="noopener" class="btn ghost">${icon('whatsapp')}<span>استفسار عبر واتساب</span></a>` : ''}
          </div>
        </div>
      </div>
    `, { sub: headline });

    const buyHandler = (e) => {
      e.preventDefault();
      go(`#/buy/${pk.id}?esim=1`);
    };
    root.querySelectorAll('#pkg-buy-btn, [data-pkg-buy]').forEach((b) => { b.onclick = buyHandler; });

    root.querySelectorAll('[data-co-filter]').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        S.companyId = a.dataset.coFilter;
        switchCatalogTab('esim', { scroll: true });
      };
    });

    const shareBtn = document.getElementById('pkg-share-btn');
    if (shareBtn) {
      shareBtn.onclick = async () => {
        const shareUrl = `${location.origin}/package/${pk.id}`;
        if (navigator.share) {
          try { await navigator.share({ title: `باقة ${headline} — ${fmtShekel(total)}`, url: shareUrl }); return; } catch {}
        }
        copyWithFeedback(shareBtn, shareUrl);
      };
    }

    root.querySelectorAll('[data-pfaq-idx]').forEach((qEl) => {
      qEl.onclick = () => {
        const idx = Number(qEl.dataset.pfaqIdx);
        openFaq = openFaq === idx ? -1 : idx;
        renderPage();
      };
    });
  }

  renderPage();
}

function pkgTotalPrice(pk, co) {
  const qrFee = Number(pk?.esimFee ?? co?.esimFee ?? S.data?.esimFee ?? 0);
  return Math.round((Number(pk?.price || 0) + qrFee) * 100) / 100;
}

function filterAndSortPackages(packages, coMap) {
  const q = S.q.trim().toLowerCase();
  const shown = packages.filter((p) => {
    const co = coMap.get(p.companyId);
    const sp = extractPackageSpecs(p, co);
    if (S.companyId !== 'all' && String(p.companyId) !== String(S.companyId)) return false;
    if (S.duration === '30' && sp.days > 45) return false;
    if (S.duration === '90' && sp.days <= 45) return false;
    if (q) {
      const coName = co?.name || p.companyName || '';
      const hay = `${p.name} ${p.description || ''} ${p.tag || ''} ${coName} ${sp.gb || ''} ${sp.days || ''} esim إلكترونية الكترونية شريحة باقة حزمة نت ${pkgTotalPrice(p, co)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  shown.sort((a, b) => {
    const ca = coMap.get(a.companyId);
    const cb = coMap.get(b.companyId);
    const sa = extractPackageSpecs(a, ca);
    const sb = extractPackageSpecs(b, cb);
    const ga = sa.gb || 0;
    const gb = sb.gb || 0;
    const pa = pkgTotalPrice(a, ca);
    const pb = pkgTotalPrice(b, cb);
    if (S.sort === 'price_asc') {
      if (pa !== pb) return pa - pb;
      if (gb !== ga) return gb - ga;
      if (sa.days !== sb.days) return sa.days - sb.days;
      return (isFeaturedPkg(b) ? 1 : 0) - (isFeaturedPkg(a) ? 1 : 0);
    }
    // Default ('gb_desc'): sort by data quantity (highest GB first), then cheapest total price.
    if (gb !== ga) return gb - ga;
    if (pa !== pb) return pa - pb;
    if (sa.days !== sb.days) return sa.days - sb.days;
    return (isFeaturedPkg(b) ? 1 : 0) - (isFeaturedPkg(a) ? 1 : 0);
  });
  return shown;
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
  const rawBrand = S.data?.shopTitle || S.data?.appName || 'Hot eSIM';
  const wa = waHref(S.data?.supportWhatsapp, 'مرحباً، أحتاج مساعدة في المتجر');
  const banks = Array.isArray(S.data?.jawwalBanks) ? S.data.jawwalBanks : [];
  const payBadges = S.data?.jawwalDirect
    ? ['Jawwal Pay', ...banks.map((b) => b.name)].join(' · ')
    : 'Jawwal Pay · PalPay';

  const hasMonthly = packages.some((p) => extractPackageSpecs(p, coMap.get(p.companyId)).days <= 45);
  const hasMultiMonth = packages.some((p) => extractPackageSpecs(p, coMap.get(p.companyId)).days > 45);
  if (S.duration === '30' && !hasMonthly) S.duration = 'all';
  if (S.duration === '90' && !hasMultiMonth) S.duration = 'all';

  const shown = filterAndSortPackages(packages, coMap);
  const compatSearchRes = evaluateDeviceQuery(S.compatSearch);

  const packsGridMarkup = (list) => (list.length ? `
    <div class="pele-packs" aria-label="باقات eSIM">
      ${list.map((pk) => renderPlanCard(pk, coMap.get(pk.companyId))).join('')}
    </div>
  ` : `
    <div class="card empty">
      ${icon('sim')}
      <p>لا توجد شرائح eSIM متوفرة مطابقة حالياً — تُعرض فقط الباقات التي لها أرقام متاحة الآن.</p>
      <button type="button" class="btn ghost btn-sm" id="reset-filters">إعادة ضبط البحث والفلاتر</button>
    </div>
  `);

  shell(`
    <!-- 1. Hero Banner with 3-Step Instant Flow -->
    <section class="pele-hero-slider">
      <div class="pele-hero-overlay">
        <div class="pele-top-banner">
          <div class="pele-banner-head">
            <div class="pele-banner-logo">
              <span class="pele-banner-mark">${brandLogoSvg('hsim-logo-svg')}</span>
              ${renderBrandWordmark(rawBrand)}
            </div>
            <span class="pele-banner-tag">${icon('bolt')}<span>${fmtNum(packages.length)} باقة جاهزة الآن</span></span>
          </div>
          <h1>${esc(rawBrand)}</h1>
          <p class="pele-hero-sub">شريحة eSIM برقم جديد وتفعيل تلقائي في <b>الضفة الغربية وقطاع غزة والقدس</b> — الدفع الآمن عبر <b>${esc(payBadges)}</b></p>
          <div class="pele-hero-steps" aria-label="خطوات الشراء">
            <span><i>1</i>اختر الباقة</span>
            <span><i>2</i>ادفع برمز SMS</span>
            <span><i>3</i>امسح كود QR</span>
          </div>
          <div class="pele-hero-ctas">
            <a href="#sec-packs" class="btn primary" data-jump="sec-packs">${icon('qr')}<span>تصفّح الباقات</span></a>
            <a href="#/compat" class="btn ghost pele-hero-ghost">${icon('chip')}<span>فحص توافق جهازي</span></a>
          </div>
        </div>

        <div class="pele-hero-illustration" aria-hidden="true">
          <div class="pele-sim-card-art">
            <div class="pele-sim-art-top">
              <span class="ltr">eSIM · QR</span>
              ${esimChipSvg('esim-chip-svg lg')}
            </div>
            <div class="pele-sim-art-mid">
              ${brandLogoSvg('hsim-logo-svg')}
              <div>
                <strong>${esc(rawBrand)}</strong>
                <small>كود QR فوري · رقم جديد</small>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 2. Packages Section (#sec-packs -> .packs) -->
    <section id="sec-packs" class="pele-content-section">
      ${packages.length > 0 ? `
        <div class="pele-filter-bar">
          <div class="shop-packs-search-wrap">
            <div class="shop-search-input-box">
              <span class="shop-search-icon">${icon('search')}</span>
              <input id="packs-search-input" class="input" type="search" value="${esc(S.q)}" placeholder="ابحث بالاسم، حجم الجيجا، أو الشركة (مثال: هوت موبايل، 500 جيجا، سلكوم، 90 يوم)..." autocomplete="off">
              <button type="button" class="btn ghost btn-sm" id="packs-search-clear"${S.q ? '' : ' hidden'}>مسح</button>
            </div>
          </div>

          ${companies.length > 1 ? `
            <div class="pele-co-pills" role="group" aria-label="الشبكات">
              <button type="button" class="pele-co-pill" aria-pressed="${S.companyId === 'all'}" data-co="all">كل الشبكات (${fmtNum(packages.length)})</button>
              ${companies.map((c) => {
                const cnt = packages.filter((p) => p.companyId === c.id).length;
                return `
                  <button type="button" class="pele-co-pill" aria-pressed="${String(S.companyId) === String(c.id)}" data-co="${c.id}">
                    ${esc(c.name)} <small>(${fmtNum(cnt)})</small>
                  </button>
                `;
              }).join('')}
            </div>
          ` : ''}

          <div class="pele-subfilters">
            ${hasMonthly && hasMultiMonth ? `
              <div class="pele-filter-group" role="group" aria-label="المدة">
                <button type="button" class="pele-mini-pill" data-dur="all" aria-pressed="${S.duration === 'all'}">كل المدد</button>
                <button type="button" class="pele-mini-pill" data-dur="30" aria-pressed="${S.duration === '30'}">شهري (30 يوم)</button>
                <button type="button" class="pele-mini-pill" data-dur="90" aria-pressed="${S.duration === '90'}">عروض 90 يوم</button>
              </div>
            ` : ''}
            <div class="pele-filter-group" role="group" aria-label="الترتيب">
              <button type="button" class="pele-mini-pill" data-sort="gb_desc" aria-pressed="${S.sort === 'gb_desc'}">الكمية ثم السعر</button>
              <button type="button" class="pele-mini-pill" data-sort="price_asc" aria-pressed="${S.sort === 'price_asc'}">الأرخص أولاً</button>
            </div>
          </div>
        </div>
      ` : ''}

      <div id="packs-grid">${packsGridMarkup(shown)}</div>
    </section>

    <!-- 4. "Everything You Need to Know" Interactive Icon Tabs (#sec-info -> .imp_info / .main_sec + .main_sec_info) -->
    <section id="sec-info" class="pele-content-section">
      <div class="pele-imp-info">
        <div class="pele-main-sec">
          <h2>كل ما تحتاج معرفته عن شريحة ${esc(rawBrand)}</h2>
          <div class="pele-icns" role="tablist">
            <a role="tab" tabindex="0" class="pele-icn-item ${S.infoTab === 'credit' ? 'active' : ''}" data-itab="credit">
              <span class="pele-icn-svg">${icon('bolt')}</span>
              <span>حالة الطلب</span>
            </a>
            <a role="tab" tabindex="0" class="pele-icn-item ${S.infoTab === 'number' ? 'active' : ''}" data-itab="number">
              <span class="pele-icn-svg">${icon('phone')}</span>
              <span>رقم هاتفي المحمول</span>
            </a>
            <a role="tab" tabindex="0" class="pele-icn-item ${S.infoTab === 'purchase' ? 'active' : ''}" data-itab="purchase">
              <span class="pele-icn-svg">${icon('qr')}</span>
              <span>الشراء والتفعيل</span>
            </a>
          </div>
        </div>
      </div>

      ${S.infoTab ? `
        <div class="pele-main-sec-info open">
          <button type="button" class="pele-close-main-info" id="close-info-tab" aria-label="إغلاق">${icon('x')}</button>
          ${renderInfoTabContent(S.infoTab)}
        </div>
      ` : ''}
    </section>

    <!-- 5. Device Compatibility Accordion Section (#sec-compat -> .checkEsim) -->
    <section id="sec-compat" class="pele-check-esim">
      <h2 class="h2-1 h2-line">هل ترغب بفحص توافق جهازك مع شريحة eSIM؟</h2>

      <div class="pele-compat-quick">
        <input id="home-compat-q" class="input" type="search" value="${esc(S.compatSearch)}" placeholder="ابحث بطراز هاتفك (مثال: iPhone 15 أو S24) أو اختر الشركة أدناه..." autocomplete="off">
        ${compatSearchRes ? `
          <div class="esim-compat-result is-${compatSearchRes.status}" style="margin-top:10px;text-align:start">
            <div class="row" style="gap:8px">
              ${icon(compatSearchRes.status === 'ok' ? 'checkCircle' : 'alert')}
              <strong>${esc(compatSearchRes.title)}</strong>
            </div>
            <p style="margin:4px 0 0;font-size:.86rem">${esc(compatSearchRes.detail)}</p>
          </div>
        ` : ''}
      </div>

      <div class="pele-div-check">
        ${Object.entries(COMPAT_DEVICES).map(([brandKey, group]) => {
          const isOpen = S.openCompatBrand === brandKey;
          return `
            <a href="#sec-compat" class="pele-brand-bar ${isOpen ? 'on' : ''}" data-compat-toggle="${brandKey}">
              <span class="ltr">${esc(group.label)}</span>
              <i class="pele-brand-arrow">${icon('chevL')}</i>
            </a>
            <div class="pele-flex-degem ${isOpen ? 'on' : ''}" dir="ltr">
              ${group.models.map((m) => `<span>${esc(m)}</span>`).join('')}
            </div>
          `;
        }).join('')}
      </div>

      <div class="pele-not-found">
        اطلب الكود <kbd dir="ltr">*#06#</kbd> من هاتفك — إذا ظهر رمز <b>EID</b> فجهازك متوافق مع <a href="#/compat">شريحة eSIM</a>.
      </div>
    </section>

    <!-- 6. 24/7 Service Strip (.serv) -->
    <section class="pele-content-section">
      <div class="pele-serv">
        <h2>خدمة ودعم مجاني على مدار الساعة 24/7</h2>
        <div class="pele-serv-flex">
          <a href="#/track">
            <span class="pele-serv-badge">${icon('qr')}</span>
            <span>فحص حالة الطلب<br>واستلام كود QR</span>
          </a>
          <a href="#/guarantee">
            <span class="pele-serv-badge">${icon('shield')}</span>
            <span>ضمان المتجر 100%<br>وفحص التوافق <b class="ltr">*#06#</b></span>
          </a>
          <a href="${esc(wa || '#/terms')}" ${wa ? 'target="_blank" rel="noopener"' : ''}>
            <span class="pele-serv-badge">${icon('whatsapp')}</span>
            <span>خدمة واتساب<br>بالعربية على مدار الساعة<br>${S.data?.supportWhatsapp ? `<b class="ltr">${esc(fmtPhone(S.data.supportWhatsapp))}</b>` : 'تواصل فوري'}</span>
          </a>
        </div>
      </div>
    </section>

    <!-- 7. Questions and Answers Accordion (.faq) -->
    <div class="pele-faq">
      <h2>أسئلة وأجوبة</h2>
      <div class="pele-faq-inner">
        ${HOME_FAQ_ITEMS.map((item, idx) => {
          const isOpen = S.openFaqIdx === idx;
          return `
            <div class="pele-faq-question ${isOpen ? 'open' : ''}" role="button" tabindex="0" data-faq-idx="${idx}" is-open="${isOpen ? 'yes' : 'no'}">
              <span>${esc(item.q)}</span>
              <i class="pele-faq-arrow">${icon('chevL')}</i>
            </div>
            <div class="pele-faq-answer ${isOpen ? 'open' : ''}">
              <span>${item.a}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `);

  const packsGrid = document.getElementById('packs-grid');
  const packsQ = document.getElementById('packs-search-input');
  const packsQClear = document.getElementById('packs-search-clear');

  function bindPacksGrid() {
    if (!packsGrid) return;
    const resetBtn = packsGrid.querySelector('#reset-filters');
    if (resetBtn) {
      resetBtn.onclick = () => {
        S.companyId = 'all';
        S.duration = 'all';
        S.q = '';
        if (packsQ) packsQ.value = '';
        updatePacksOnly();
      };
    }
    bindGlobalTriggers(packsGrid);
  }

  function updatePacksOnly() {
    if (packsQClear) packsQClear.hidden = !S.q;
    root.querySelectorAll('[data-co]').forEach((b) => b.setAttribute('aria-pressed', String(S.companyId) === String(b.dataset.co)));
    root.querySelectorAll('[data-dur]').forEach((b) => b.setAttribute('aria-pressed', S.duration === b.dataset.dur));
    root.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', S.sort === b.dataset.sort));
    if (packsGrid) {
      packsGrid.innerHTML = packsGridMarkup(filterAndSortPackages(packages, coMap));
      bindPacksGrid();
    }
  }

  bindPacksGrid();

  if (packsQ) {
    packsQ.oninput = (e) => {
      S.q = e.currentTarget.value;
      updatePacksOnly();
    };
  }
  if (packsQClear) {
    packsQClear.onclick = () => {
      S.q = '';
      if (packsQ) { packsQ.value = ''; packsQ.focus(); }
      updatePacksOnly();
    };
  }
  root.querySelectorAll('[data-co]').forEach((b) => {
    b.onclick = () => { S.companyId = b.dataset.co; updatePacksOnly(); };
  });
  root.querySelectorAll('[data-dur]').forEach((b) => {
    b.onclick = () => { S.duration = b.dataset.dur; updatePacksOnly(); };
  });
  root.querySelectorAll('[data-sort]').forEach((b) => {
    b.onclick = () => { S.sort = b.dataset.sort; updatePacksOnly(); };
  });
  root.querySelectorAll('[data-itab]').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      const t = b.dataset.itab;
      S.infoTab = S.infoTab === t ? '' : t;
      viewCatalog();
    };
  });
  const closeInfoBtn = document.getElementById('close-info-tab');
  if (closeInfoBtn) {
    closeInfoBtn.onclick = () => {
      S.infoTab = '';
      viewCatalog();
    };
  }
  root.querySelectorAll('[data-compat-toggle]').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      const k = b.dataset.compatToggle;
      S.openCompatBrand = S.openCompatBrand === k ? '' : k;
      viewCatalog();
    };
  });
  const homeCompatQ = document.getElementById('home-compat-q');
  if (homeCompatQ) {
    homeCompatQ.oninput = (e) => {
      S.compatSearch = e.currentTarget.value;
      const pos = e.currentTarget.selectionStart;
      viewCatalog();
      const next = document.getElementById('home-compat-q');
      if (next) { next.focus(); try { next.setSelectionRange(pos, pos); } catch {} }
    };
  }
  root.querySelectorAll('[data-faq-idx]').forEach((b) => {
    b.onclick = () => {
      const idx = Number(b.dataset.faqIdx);
      S.openFaqIdx = S.openFaqIdx === idx ? -1 : idx;
      viewCatalog();
    };
  });
}

// Extract structured specs (company name, internet GB, minutes, SMS, duration days, extra bonus)
// from package fields and Arabic/English text so every detail is displayed in its proper place.
function extractPackageSpecs(pk, co) {
  const companyName = String(co?.name || pk?.companyName || 'HOT eSIM').trim();
  const rawName = String(pk?.name || '').trim();
  const rawDesc = String(pk?.description || '').trim();
  const combined = `${rawName} ${rawDesc}`;

  // 1. Internet / Data (GB) & 4. Duration in Days (via shared catalog-compare parser, safe against matching 5G)
  const gb = extractGb({ name: combined, dataGb: pk?.dataGb ?? pk?.gb }) || 0;

  // 2. Minutes (عدد الدقائق)
  let minutes = pk?.minutes !== null && pk?.minutes !== undefined ? Number(pk.minutes) : null;
  const unlimitedCalls = minutes === -1 || /مكالمات\s*غير\s*محدود|غير\s*محدود/.test(combined);
  if ((minutes === null || minutes === 0) && !unlimitedCalls) {
    const minMatches = [...combined.matchAll(/(\d[\d,]*)\s*دقيق[ةه]/g)]
      .map((m) => Number(m[1].replace(/,/g, '')))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (minMatches.length) {
      minutes = Math.max(...minMatches);
    }
  }

  // 3. SMS (عدد الرسائل)
  let sms = pk?.sms !== null && pk?.sms !== undefined ? Number(pk.sms) : null;
  if (sms === null || sms === 0) {
    const smsMatch = combined.match(/(\d[\d,]*)\s*(?:رسال[ةه]|نصية|SMS)/i);
    if (smsMatch) sms = Number(smsMatch[1].replace(/,/g, '')) || null;
  }

  // 4. Duration in Days (مدة الصلاحية)
  const days = extractDays({ name: combined, days: pk?.days });

  // 5. Extra international / Palestinian calls or credit bonus
  const isOpenCredit = !gb && /لجميع\s*الشبكات/.test(combined);
  const creditMatch = rawName.match(/(\d+)\s*(?:شيقل|شيكل|₪)/);
  const creditVal = creditMatch ? Number(creditMatch[1]) : Number(pk?.price || 0);

  let extraBonus = '';
  const palMinMatch = combined.match(/(\d+)\s*دقيق[ةه]\s*(?:بونص\s*)?(?:على\s*)?(?:للشبكات\s*الفلسطيني[ةه]|لفلسطين)/);
  const intlShekelMatch = combined.match(/(\d+)\s*(?:شيقل|شيكل|₪)\s*(?:بونص\s*)?(?:مكالمات\s*)?(?:للشبكات\s*الفلسطيني[ةه]|مكالمات\s*دولي[ةه]|لخارج\s*البلاد|للشبكات\s*المحلي[ةه]\s*والخارجي[ةه]|على\s*الشبكات\s*الفلسطيني[ةه]|رصيد)/);
  if (palMinMatch && minutes && Number(palMinMatch[1]) !== minutes) {
    extraBonus = `+ ${fmtNum(Number(palMinMatch[1]))} دقيقة لفلسطين`;
  } else if (!isOpenCredit && intlShekelMatch && Number(intlShekelMatch[1]) !== Number(pk?.price)) {
    extraBonus = `+ ${fmtNum(Number(intlShekelMatch[1]))} ₪ مكالمات دولية وفلسطينية`;
  }

  // 6. Main Headline Capacity (shown next to price in .pele-pack-top)
  let mainCap = '';
  if (gb > 0) {
    mainCap = `${fmtNum(gb)}GB`;
  } else if (isOpenCredit) {
    mainCap = `${fmtNum(creditVal)}₪`;
  } else if (minutes && minutes > 0) {
    mainCap = `${fmtNum(minutes)}M`;
  } else {
    mainCap = `${fmtNum(creditVal)}₪`;
  }

  // 7. Formatted Internet & Calls labels for their dedicated places
  const is5G = /\b5g\b|الجيل\s*الخامس/i.test(`${combined} ${pk?.tag || ''}`);
  let dataLabel = '';
  if (gb > 0) {
    dataLabel = is5G ? `${fmtNum(gb)} جيجا إنترنت 5G` : `${fmtNum(gb)} جيجا إنترنت سريع`;
  } else if (isOpenCredit) {
    dataLabel = `رصيد ${fmtNum(creditVal)} ₪ لجميع الشبكات`;
  } else {
    dataLabel = 'باقة اتصال بدون إنترنت';
  }

  let callsLabel = '';
  if (unlimitedCalls) {
    callsLabel = sms > 0 ? `مكالمات غير محدودة و ${fmtNum(sms)} رسالة` : 'مكالمات ورسائل غير محدودة';
  } else if (minutes && minutes > 0) {
    if (sms && sms > 0) {
      callsLabel = `${fmtNum(minutes)} دقيقة و ${fmtNum(sms)} رسالة`;
    } else if (palMinMatch && Number(palMinMatch[1]) === minutes) {
      callsLabel = `${fmtNum(minutes)} دقيقة للشبكات الفلسطينية`;
    } else {
      callsLabel = `${fmtNum(minutes)} دقيقة مكالمات`;
    }
  } else if (pk?.tag) {
    callsLabel = pk.tag;
  } else {
    callsLabel = 'مكالمات ورسائل شاملة';
  }

  return {
    companyName,
    gb,
    minutes,
    sms,
    days,
    is5G,
    unlimitedCalls,
    extraBonus,
    mainCap,
    dataLabel,
    callsLabel,
  };
}

function renderExtractedSpecsChips(sp) {
  return `
    <span class="chip">${icon('data')}<span>${esc(sp.dataLabel)}</span></span>
    <span class="chip">${icon('call')}<span>${esc(sp.callsLabel)}</span></span>
    <span class="chip">${icon('clock')}<span>${fmtNum(sp.days)} يوماً</span></span>
    ${sp.extraBonus ? `<span class="chip">${icon('bolt')}<span>${esc(sp.extraBonus)}</span></span>` : ''}
  `;
}

function renderPlanCard(pk, co) {
  const coColor = co?.color || '#1f6ff2';
  const featured = isFeaturedPkg(pk);
  const sp = extractPackageSpecs(pk, co);

  const qrFee = Number(pk.esimFee ?? co?.esimFee ?? S.data?.esimFee ?? 0);
  const total = Math.round((Number(pk.price || 0) + qrFee) * 100) / 100;
  const qrFeeLine = qrFee > 0
    ? `السعر الإجمالي شامل شريحة eSIM (${fmtNum(pk.price)} + ${fmtNum(qrFee)} ₪)`
    : 'السعر الإجمالي شامل كود eSIM QR مجاناً';
  const offerPill = featured
    ? '<span class="pele-offer-tag is-pop">الأكثر طلباً</span>'
    : sp.days >= 60 ? `<span class="pele-offer-tag">عرض ${fmtNum(sp.days)} يوم</span>` : '';

  return `
    <div class="pele-pack-card ${featured ? 'is-featured' : ''}" style="--co:${esc(coColor)}">
      <div class="pele-pack-card-head">
        <div class="pele-best-offer">
          <span class="pele-5g-pill" dir="ltr"><i>e</i>SIM${sp.is5G ? ' <b>5G</b>' : ''}</span>
          ${offerPill}
        </div>
        <div class="pele-superlative">
          <div>
            <span>${fmtNum(sp.days)}</span>
            <span>يوماً</span>
          </div>
        </div>
      </div>

      <div class="pele-pack-top" dir="ltr">
        <div class="pele-pack-name"><span>${esc(sp.mainCap)}</span></div>
        <div class="pele-pack-price">${fmtNum(total)}<span>₪</span></div>
      </div>

      <div class="pele-pack-carrier">
        ${companyLogo(co || { name: sp.companyName }, 'sm')}
        <span>${esc(sp.companyName)}</span>
      </div>

      <div class="pele-pack-body-box">
        <div class="pele-pack-specs-list">
          <div class="pele-pack-spec-row">
            <i class="pele-spec-ic">${icon('data')}</i>
            <span>${esc(sp.dataLabel)}</span>
          </div>
          <div class="pele-pack-spec-row">
            <i class="pele-spec-ic">${icon('call')}</i>
            <span>${esc(sp.callsLabel)}</span>
          </div>
          ${sp.extraBonus ? `
            <div class="pele-pack-spec-row is-bonus">
              <i class="pele-spec-ic">${icon('bolt')}</i>
              <span>${esc(sp.extraBonus)}</span>
            </div>
          ` : ''}
        </div>
        <div class="pele-trust-mini">
          <span>${icon('bolt')}تفعيل فوري QR</span>
          <span>${icon('phone')}رقم جديد</span>
        </div>
        <div class="pele-new-txt2">
          <span>${esc(qrFeeLine)}</span>
        </div>
      </div>

      <div class="pele-pack-btns is-single">
        <a class="pele-btn-b order-b" href="#/buy/${pk.id}?esim=1">
          شراء الآن · ${fmtNum(total)} ₪
        </a>
      </div>
      <a class="pele-lnk-inc" href="/package/${pk.id}" data-pkg-link="${esc(String(pk.id))}">
        المزيد من التفاصيل
      </a>
    </div>
  `;
}

function renderCheckoutPackageSummary(pk, co) {
  const sp = extractPackageSpecs(pk, co);
  const total = pkgTotalPrice(pk, co);
  const badgeText = 'شريحة eSIM فورية';
  return `
    <div class="esim-checkout-head">
      <div class="pele-checkout-top">
        <div class="pele-checkout-brand">
          ${companyLogo(co, 'sm')}
          <div class="pele-checkout-titles">
            <span class="esim-carrier-label">${esc(badgeText)}</span>
            <h2>${esc(sp.companyName)}</h2>
          </div>
        </div>
        <div class="pele-checkout-cap" dir="ltr">
          <b class="pele-checkout-maincap">${esc(sp.mainCap)}</b>
          <span class="pele-checkout-price">${fmtNum(total)}<span>₪</span></span>
        </div>
      </div>
      <div class="pele-pack-specs-list pele-checkout-specs">
        <div class="pele-pack-spec-row">
          <i class="pele-spec-ic">${icon('data')}</i>
          <span>${esc(sp.dataLabel)}</span>
        </div>
        <div class="pele-pack-spec-row">
          <i class="pele-spec-ic">${icon('call')}</i>
          <span>${esc(sp.callsLabel)}</span>
        </div>
        <div class="pele-pack-spec-row">
          <i class="pele-spec-ic">${icon('clock')}</i>
          <span>صلاحية ${fmtNum(sp.days)} يوماً</span>
        </div>
        ${sp.extraBonus ? `
          <div class="pele-pack-spec-row is-bonus">
            <i class="pele-spec-ic">${icon('bolt')}</i>
            <span>${esc(sp.extraBonus)}</span>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// Every package in the shop is an eSIM on a new number from its supplier: straight to the eSIM checkout.
function viewBuy(id, seq) {
  const pk = (S.data?.packages || []).find((p) => String(p.id) === String(id));
  if (!pk) { location.hash = '#/'; return; }
  const co = (S.data?.companies || []).find((c) => c.id === pk.companyId) || { name: pk.companyName };
  return esimForm(pk, co, seq);
}

// eSIM checkout: checks /api/shop/available, shows price + QR fee breakdown, and creates eSIM order
async function esimForm(pk, co, seq) {
  const sp = extractPackageSpecs(pk, co);
  const qrFee = Number(pk.esimFee ?? co?.esimFee ?? S.data?.esimFee ?? 0);
  const total = Math.round((Number(pk.price || 0) + qrFee) * 100) / 100;
  const savedBuyer = loadBuyer();
  const banks = Array.isArray(S.data?.jawwalBanks) ? S.data.jawwalBanks : [];
  const payHint = S.data?.jawwalDirect
    ? `الدفع المباشر برمز SMS عبر Jawwal Pay${banks.length ? ` أو ${banks.map((b) => b.name).join(' أو ')}` : ''}`
    : 'الدفع عبر Jawwal Pay أو PalPay';

  shell(`<div class="card empty"><p class="muted">جارٍ التحقق من توفّر الشريحة...</p></div>`, { sub: sp.companyName });
  if (S.esimAvailable === null || S.esimAvailable.pkgId !== pk.id) {
    try {
      const r = await jfetch(`/api/shop/available?packageId=${encodeURIComponent(pk.id)}`);
      S.esimAvailable = { pkgId: pk.id, available: Boolean(r.available) };
    } catch (err) {
      S.esimAvailable = { pkgId: pk.id, available: false, error: err.message };
    }
  }
  if (seq !== S.seq) return;
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

      ${renderCheckoutPackageSummary(pk, co)}

      ${available ? `
        <div class="esim-ready-notice">
          ${icon('qr')}
          <div class="grow">
            <b>الشريحة متوفرة وجاهزة للإصدار</b>
            <small class="muted" style="display:block">${esc(payHint)} — والتفعيل تلقائي خلال ثوانٍ.</small>
          </div>
        </div>
      ` : `
        <div class="card empty">
          ${icon('alert')}
          <p>${esc(S.esimAvailable.error || 'نفدت شرائح eSIM لهذه الباقة حالياً — جرّب باقة أخرى.')}</p>
        </div>
      `}

      ${pk.fullName ? `
        <div class="field">
          <label for="f-cname">الاسم</label>
          <input id="f-cname" name="customerName" class="input" autocomplete="name" required minlength="2" value="${esc(savedBuyer.customerName)}" placeholder="مثال: محمد">
          <span class="hint muted" style="font-size:.8rem">مطلوب لتسجيل الخط الجديد باسمك</span>
        </div>
      ` : ''}

      <div class="field">
        <label for="f-email">البريد الإلكتروني <span class="muted">(اختياري — لإرسال نسخة من الـ QR)</span></label>
        <input id="f-email" name="email" type="email" class="input ltr" autocomplete="email" value="${esc(savedBuyer.email)}" placeholder="you@example.com">
      </div>

      <div class="shop-breakdown-box">
        <div class="shop-bd-row">
          <span>سعر الباقة</span>
          <b class="mono">${fmtShekel(pk.price)}</b>
        </div>
        <div class="shop-bd-row">
          <span>رسوم شريحة eSIM QR</span>
          <b class="mono">${qrFee > 0 ? fmtShekel(qrFee) : 'مجاناً'}</b>
        </div>
        <div class="shop-bd-total">
          <span>الإجمالي</span>
          <b class="mono">${fmtShekel(total)}</b>
        </div>
      </div>

      <div class="esim-consent-wrap">
        <label class="esim-consent-label">
          <input type="checkbox" name="consent" required>
          <span>هاتفي يدعم eSIM وأوافق على الشروط.</span>
        </label>
        <button type="button" class="btn ghost btn-sm" data-act="legal-sheet" data-tab="esim">${icon('shield')}<span>سياسة eSIM والضمان</span></button>
      </div>

      ${renderPaymentSecurityShield({ mode: 'checkout', amount: total })}

      <button class="btn primary lg" type="submit" ${available ? '' : 'disabled'}>
        ${icon('checkCircle')}
        <span>متابعة للدفع الآمن (${fmtShekel(total)})</span>
      </button>
    </form>
  `, { sub: pk.name });

  document.getElementById('buy-f').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    const fd = new FormData(f);
    const customerName = String(fd.get('customerName') || '').trim();
    // The first name is enough (letters only).
    if (pk.fullName && (customerName.length < 2 || /\d/.test(customerName))) {
      notify('اكتب اسمك', true);
      btn.disabled = false;
      return;
    }
    try {
      const emailVal = String(fd.get('email') || '').trim();
      const order = await jfetch('/api/shop/orders', {
        method: 'POST',
        body: {
          kind: 'esim',
          esim: true,
          includeEsimFee: qrFee > 0,
          packageId: pk.id,
          customerName: customerName || 'زبون المتجر',
          email: emailVal,
        },
      });
      saveBuyer({ customerName, email: emailVal });
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
      if (err.code) {
        rememberOrderCode(err.code);
        S.myCodes = savedOrderCodes();
        let box = f.querySelector('.shop-active-res-box');
        if (!box) {
          box = document.createElement('div');
          box.className = 'shop-active-res-box';
          box.style.cssText = 'margin-top:12px;padding:12px;background:rgba(234,88,12,0.1);border:1px solid rgba(234,88,12,0.3);border-radius:12px;display:flex;flex-direction:column;gap:8px';
          f.appendChild(box);
        }
        box.innerHTML = `
          <div style="font-size:13px;font-weight:700;color:var(--text, #111)">⚠️ لديك حجز بطاقة نشط حالياً (طلب ${esc(err.code)})</div>
          <div style="font-size:12px;color:var(--text-muted, #666)">لا يمكن حجز أكثر من بطاقة في نفس الوقت منعاً لنفاد الأرقام. يمكنك إتمام دفع الحجز السابق أو إلغاؤه لحجز هذه الباقة.</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <a href="#/order/${encodeURIComponent(err.code)}" class="btn primary sm">متابعة دفع الطلب المحجوز</a>
            <button type="button" class="btn sm" id="cancel-active-res-btn">إلغاء الحجز السابق وحجز هذه الباقة</button>
          </div>
        `;
        const cBtn = box.querySelector('#cancel-active-res-btn');
        if (cBtn) {
          cBtn.onclick = async () => {
            cBtn.disabled = true;
            try {
              await jfetch(`/api/shop/orders/${encodeURIComponent(err.code)}/cancel`, { method: 'POST' });
              notify('تم إلغاء الحجز السابق بنجاح');
              box.remove();
              btn.click();
            } catch (ce) {
              notify(ce.message, true);
              cBtn.disabled = false;
            }
          };
        }
      }
    }
  };
}

const STAGES_AR = {
  awaiting_payment: { label: 'بانتظار الدفع', cls: 's-open', step: 1, desc: 'أرسل المبلغ عبر Jawwal Pay أو PalPay ثم أكّد الإرسال — يتم التحقق تلقائياً وخلال ثوانٍ.' },
  verifying: { label: 'جارٍ التحقق التلقائي…', cls: 's-open', step: 2, desc: 'يتم التحقق من التحويل تلقائياً وخلال ثوانٍ.' },
  review: { label: 'بانتظار التحقق التلقائي', cls: 's-open', step: 2, desc: '' },
  processing: { label: 'تم الدفع — جارٍ التفعيل…', cls: 's-open', step: 2, desc: 'يتم الآن تفعيل الباقة وإصدار كود الـ QR.' },
  paid_issue: { label: 'تم الدفع — قيد المعالجة', cls: 's-open', step: 2, desc: 'يتابع الفريق إتمام التفعيل.' },
  done: { label: 'مفعّل وجاهز', cls: 's-done', step: 3, desc: 'تم تفعيل طلبك بنجاح.' },
  failed: { label: 'تعذّر التفعيل — تواصل مع الدعم', cls: 's-bad', step: 0, desc: 'تواصل مع الدعم لاسترجاع المبلغ أو إعادة المحاولة.' },
  rejected: { label: 'مرفوض — تواصل مع الدعم', cls: 's-bad', step: 0, desc: '' },
  cancelled: { label: 'ملغى', cls: 's-bad', step: 0, desc: 'تم إلغاء الطلبية وإتاحة الرقم من جديد.' },
};
const PAYABLE_STATUSES = ['awaiting_payment', 'verifying', 'review'];
const FINAL_STAGES = ['done', 'cancelled', 'rejected', 'failed'];

async function viewOrder(code, seq) {
  clearInterval(S.pollTimer);
  clearInterval(S.countdownTimer);
  try {
    const fetched = await jfetch(`/api/shop/orders/${encodeURIComponent(code)}?check=1`);
    if (seq !== S.seq) return;
    S.order = fetched;
    rememberOrderCode(S.order.code);
    S.myCodes = savedOrderCodes();
  } catch (err) {
    if (seq !== S.seq) return;
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
    let polling = false;
    S.pollTimer = setInterval(async () => {
      if (seq !== S.seq) { clearInterval(S.pollTimer); return; }
      if (polling || document.querySelector('#proof-f :focus, #jc-f :focus, #jc-send-f :focus')) return;
      polling = true;
      try {
        const next = await jfetch(`/api/shop/orders/${encodeURIComponent(code)}`);
        if (seq !== S.seq) { clearInterval(S.pollTimer); return; }
        if (
          next.status !== S.order.status ||
          next.stage !== S.order.stage ||
          next.proofSent !== S.order.proofSent ||
          next.proofTries !== S.order.proofTries ||
          next.canRetryProof !== S.order.canRetryProof ||
          next.needsSupport !== S.order.needsSupport ||
          next.esimQr !== S.order.esimQr ||
          next.esimCode !== S.order.esimCode ||
          Boolean(next.qrMailed) !== Boolean(S.order.qrMailed) ||
          Boolean(next.jawwal?.checking) !== Boolean(S.order.jawwal?.checking)
        ) {
          S.order = next;
          renderOrder();
          if (FINAL_STAGES.includes(next.stage)) clearInterval(S.pollTimer);
        }
      } catch {} finally {
        polling = false;
      }
    }, 5000);
  }
}

function fmtRemaining(untilMs) {
  const diff = Math.max(0, Math.floor((Number(untilMs) - Date.now()) / 1000));
  const m = String(Math.floor(diff / 60)).padStart(2, '0');
  const s = String(diff % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// Direct Jawwal Pay: the customer's Jawwal Pay mobile, then the code texted to it. The money is taken only when the
// code is confirmed.
// Where the code comes from: the Jawwal Pay wallet, or a bank the shop offers (Bank of Palestine, by mobile number).
function directBanks() { return Array.isArray(S.data?.jawwalBanks) ? S.data.jawwalBanks : []; }
function renderDirectPay(o) {
  const j = o.jawwal || {};
  const sent = Boolean(j.otpSent);
  const canResend = (j.sendsLeft ?? 3) > 0;
  const banks = directBanks();
  const via = banks.some((b) => b.code === S.jcBank) ? S.jcBank : '';
  const viaName = via ? (banks.find((b) => b.code === via)?.name || via) : 'Jawwal Pay';
  if (j.checking) {
    return `
      <div class="card shop-pay shop-direct no-print">
        <div class="esim-ready-notice">${icon('clock')}<span>نتحقق من دفعتك — <b>لا تدفع مرة أخرى</b>. تتحدّث هذه الصفحة تلقائياً.</span></div>
      </div>`;
  }
  return `
    <div class="card shop-pay shop-direct no-print">
      <div class="row between" style="flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">${banks.length ? 'ادفع مباشرة: جوال باي أو البنك' : 'ادفع مباشرة من Jawwal Pay'}</h3>
        <span class="shop-sec-tag">${icon('bolt')}<span>تفعيل فوري</span></span>
      </div>
      ${sent ? `
        <p class="muted" style="margin:0;font-size:.86rem">
          ${j.bankName ? `أرسل <b>${esc(j.bankName)}</b>` : 'أرسلنا'} رمز تحقق إلى <bdi dir="ltr" class="mono"><b>${esc(j.mobile || '')}</b></bdi> لدفع <b class="ltr mono">${fmtShekel(o.amount)}</b>.
          اكتبه هنا لإتمام الدفع — صالح لمدة <b id="jc-countdown" class="ltr mono">${fmtRemaining(j.expiresAt)}</b>.
        </p>
        <form id="jc-f" class="form" style="margin-top:4px" autocomplete="off">
          <div class="field">
            <label for="jc-otp">رمز التحقق</label>
            <input id="jc-otp" name="otp" class="input ltr mono" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="••••••" required>
          </div>
          <button class="btn primary lg" type="submit">${icon('checkCircle')}<span>تأكيد الدفع ${fmtShekel(o.amount)}</span></button>
        </form>
        ${canResend ? `
          <div class="row" style="justify-content:center;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn ghost btn-sm" id="jc-change">${icon('phone')}<span>تغيير الرقم أو إعادة إرسال الرمز</span></button>
          </div>` : ''}
      ` : canResend ? `
        ${banks.length ? `<div class="segmented" role="radiogroup" aria-label="الدفع من" style="margin:2px 0">
          <button type="button" data-jc-bank="" aria-pressed="${!via}">محفظة جوال باي</button>
          ${banks.map((b) => `<button type="button" data-jc-bank="${esc(b.code)}" aria-pressed="${via === b.code}">${esc(b.name)}</button>`).join('')}
        </div>` : ''}
        <p class="muted" style="margin:0;font-size:.86rem">
          ${via ? `اكتب رقم جوالك <b>المسجّل لدى ${esc(viaName)}</b> ويرسل لك البنك رمز تحقق` : 'اكتب رقم جوالك المسجّل في <b>Jawwal Pay</b> وسيصلك رمز تحقق'} لدفع <b class="ltr mono">${fmtShekel(o.amount)}</b> — لا حاجة لتحويل يدوي أو إرسال إشعار.
        </p>
        <form id="jc-send-f" class="form" style="margin-top:4px">
          <div class="field">
            <label for="jc-mobile">${via ? `رقم الجوال المسجّل في ${esc(viaName)}` : 'رقم جوال باي'}</label>
            <input id="jc-mobile" name="mobile" class="input ltr" inputmode="tel" autocomplete="tel" maxlength="16" placeholder="059XXXXXXX" value="${esc(S.jcMobile || '')}" required>
          </div>
          <button class="btn primary lg" type="submit">${icon('phone')}<span>إرسال رمز التحقق</span></button>
        </form>
      ` : `
        <div class="esim-ready-notice">${icon('info')}<span>استُخدمت كل رموز التحقق لهذا الطلب. ${S.data?.manualPay !== false ? 'ادفع بالتحويل اليدوي أدناه أو تواصل معنا.' : 'يرجى التواصل مع الدعم أو إنشاء طلب جديد.'}</span></div>
      `}
    </div>`;
}

function bindDirectPay(o) {
  document.querySelectorAll('[data-jc-bank]').forEach((b) => {
    b.onclick = () => {
      S.jcMobile = document.getElementById('jc-mobile')?.value || S.jcMobile || '';
      S.jcBank = b.dataset.jcBank || '';
      renderOrder();
    };
  });
  const sendForm = document.getElementById('jc-send-f');
  if (sendForm) {
    sendForm.onsubmit = async (e) => {
      e.preventDefault();
      const mobile = String(new FormData(sendForm).get('mobile') || '').trim();
      if (!mobile) return;
      S.jcMobile = mobile;
      const btn = sendForm.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const bank = directBanks().some((x) => x.code === S.jcBank) ? S.jcBank : '';
        S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}/jawwal/otp`, { method: 'POST', body: { mobile, bank } });
        notify(bank ? 'أرسل البنك رمز التحقق إلى جوالك' : 'تم إرسال رمز التحقق إلى جوالك');
        renderOrder();
        document.getElementById('jc-otp')?.focus();
      } catch (err) {
        notify(err.message, true);
        btn.disabled = false;
      }
    };
  }
  const change = document.getElementById('jc-change');
  if (change) {
    change.onclick = () => {
      const wait = Number(o.jawwal?.resendAt || 0) - Date.now();
      if (wait > 0) { notify(`يمكنك طلب رمز جديد بعد ${Math.ceil(wait / 1000)} ثانية`, true); return; }
      S.order = { ...o, jawwal: { ...o.jawwal, otpSent: false } };
      renderOrder();
      document.getElementById('jc-mobile')?.focus();
    };
  }
  const otpForm = document.getElementById('jc-f');
  if (otpForm) {
    otpForm.onsubmit = async (e) => {
      e.preventDefault();
      const otp = String(new FormData(otpForm).get('otp') || '').trim();
      if (!otp) return;
      const btn = otpForm.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}/jawwal/confirm`, { method: 'POST', body: { otp } });
        if (S.order.status === 'paid') notify('تم الدفع بنجاح — جارٍ تفعيل طلبك');
        renderOrder();
      } catch (err) {
        notify(err.message, true);
        btn.disabled = false;
        // An expired or used-up code, or a payment being checked: the page shows what to do next.
        if ([402, 409, 410, 429, 502].includes(err.status)) {
          try { S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}`); renderOrder(); } catch {}
        }
      }
    };
  }
  if (o.jawwal?.otpSent && o.jawwal.expiresAt) {
    S.jcTimer = setInterval(() => {
      const el = document.getElementById('jc-countdown');
      if (!el) { clearInterval(S.jcTimer); return; }
      el.textContent = fmtRemaining(o.jawwal.expiresAt);
      if (Date.now() >= Number(o.jawwal.expiresAt)) {
        clearInterval(S.jcTimer);
        S.order = { ...o, jawwal: { ...o.jawwal, otpSent: false } };
        renderOrder();
      }
    }, 1000);
  }
}

function renderOrder() {
  clearInterval(S.countdownTimer);
  clearInterval(S.jcTimer);
  const o = S.order;
  const st = STAGES_AR[o.stage] || STAGES_AR[o.status] || STAGES_AR.awaiting_payment;
  const jp = S.data?.jawwalpay || {};
  const pp = S.data?.palpay || {};
  const hasSeparatePalpay = Boolean(pp.number && pp.number !== jp.number);
  const isEsim = Boolean(o.esim);
  const hasQr = validQrDataUrl(o.esimQr);
  const hasCode = Boolean(o.esimCode && String(o.esimCode).trim());
  const hasEsimDelivery = hasQr || hasCode;
  const payable = PAYABLE_STATUSES.includes(o.status);
  const isInitialConfirm = o.status === 'awaiting_payment';
  const isRetryChance = Boolean(o.status === 'verifying' && o.canRetryProof);
  // Direct Jawwal Pay (a code to the customer's mobile): offered first while the order waits for payment. While a
  // direct payment is being checked, no manual transfer is offered (it would be paid twice).
  const jcChecking = Boolean(o.jawwal?.checking);
  const showDirect = Boolean((S.data?.jawwalDirect || jcChecking) && isInitialConfirm);
  const manualOk = S.data?.manualPay !== false;
  const canShowForm = ((isInitialConfirm && (manualOk || !showDirect)) || isRetryChance) && !jcChecking;
  // A transfer's details were sent and are being checked: only then the wait (up to 15 minutes), never for a direct payment.
  const transferChecking = Boolean(payable && !canShowForm && !jcChecking && o.proofSent && o.status !== 'awaiting_payment');
  const isSupportNeeded = Boolean(transferChecking && (o.needsSupport || (o.waitUntil && Date.now() >= Number(o.waitUntil))));
  const statusPillCls = isSupportNeeded ? 's-bad' : st.cls;
  const stageDesc = o.status === 'awaiting_payment' && showDirect && !canShowForm
    ? `ادفع مباشرة من محفظة جوال باي${directBanks().length ? ` أو ${directBanks().map((b) => b.name).join(' أو ')}` : ''}: اكتب رقمك ويصلك رمز تحقق، وبعد الدفع يتفعّل طلبك تلقائياً.`
    : jcChecking ? 'نتأكد من دفعتك لدى جوال باي — لا تدفع مرة أخرى.' : st.desc;
  const statusPillLabel = isSupportNeeded ? 'يرجى التحدث مع الدعم' : jcChecking ? 'جارٍ التحقق من الدفع…' : (transferChecking ? 'بانتظار التحقق (حتى 15 دقيقة)' : st.label);
  const wa = waHref(S.data?.supportWhatsapp, `مرحباً، بخصوص الطلب ${o.code}`);
  const appleInstallHref = o.esimCode && /^LPA:1\$/i.test(String(o.esimCode).trim())
    ? `https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(String(o.esimCode).trim())}`
    : '';

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
        <span class="${st.step >= 3 || hasEsimDelivery ? 'done' : ''}"><i>3</i>${isEsim ? 'استلام QR' : 'التفعيل'}</span>
      </div>

      <div class="row between" style="flex-wrap:wrap;gap:10px">
        <div class="row" style="gap:10px;min-width:0;flex:1">
          <span class="shop-brand-mark sm">${icon(isEsim ? 'qr' : 'sim')}</span>
          <div class="grow">
            <span class="esim-carrier-label">طلب #<b class="ltr mono">${esc(o.code)}</b></span>
            <h3 style="margin:2px 0;word-break:break-word">${esc(o.packageLabel)}${isEsim ? ' · eSIM' : ''}</h3>
            <small class="muted">${o.customerName && o.customerName !== 'زبون المتجر' ? `${esc(o.customerName)} · ` : ''}${o.number ? `<span class="ltr">${esc(fmtPhone(o.number))}</span>` : 'يظهر الرقم فور تفعيل الطلب'}</small>
          </div>
        </div>
        <b class="mono shop-amount">${fmtShekel(o.amount)}</b>
      </div>

      ${isEsim ? `
        <div class="shop-breakdown-box">
          <div class="shop-bd-row">
            <span>سعر الباقة</span>
            <b class="mono">${fmtShekel(o.packagePrice ?? o.amount)}</b>
          </div>
          <div class="shop-bd-row">
            <span>رسوم eSIM QR</span>
            <b class="mono">${Number(o.esimFee) > 0 ? fmtShekel(o.esimFee) : 'مجاناً'}</b>
          </div>
        </div>
      ` : ''}

      <div class="row between" style="flex-wrap:wrap;gap:8px">
        <span class="pill ${statusPillCls}">${esc(statusPillLabel)}</span>
        ${o.reservedUntil && o.status === 'awaiting_payment' ? `
          <span class="shop-reserve-pill" title="مهلة حجز الرقم (10 دقائق)">
            ${icon('clock')}
            <span>حجز الرقم: <b id="reserve-countdown" class="ltr mono">${fmtRemaining(o.reservedUntil)}</b></span>
          </span>
        ` : isRetryChance && o.retryUntil ? `
          <span class="shop-reserve-pill" title="مهلة المحاولة الثانية">
            ${icon('clock')}
            <span>المحاولة الثانية: <b id="retry-countdown" class="ltr mono">${fmtRemaining(o.retryUntil)}</b></span>
          </span>
        ` : transferChecking && !isSupportNeeded && o.waitUntil ? `
          <span class="shop-reserve-pill" title="مهلة الانتظار القصوى (15 دقيقة)">
            ${icon('clock')}
            <span>مهلة الانتظار: <b id="wait-countdown" class="ltr mono">${fmtRemaining(o.waitUntil)}</b></span>
          </span>
        ` : `<small class="muted">${fmtDateTime(o.createdAt)}</small>`}
      </div>
      ${stageDesc ? `<p class="muted" style="margin:0;font-size:.86rem">${esc(stageDesc)}</p>` : ''}
      ${o.response ? `<div class="esim-ready-notice">${icon('info')}<span>${esc(o.response)}</span></div>` : ''}
      ${o.expiresAt ? `<div class="shop-kv"><span>صلاحية الباقة حتى</span><b>${fmtDate(o.expiresAt)}</b></div>` : ''}
      ${['awaiting_payment', 'verifying', 'review'].includes(o.status) ? `
        <div class="row no-print" style="justify-content:flex-end">
          <button type="button" class="btn ghost btn-sm" id="cancel-order-btn">إلغاء الطلب</button>
        </div>` : ''}
    </div>

    ${showDirect ? renderDirectPay(o) : ''}
    ${showDirect && canShowForm ? `<div class="shop-pay-or no-print" role="separator"><span>أو حوّل المبلغ يدوياً</span></div>` : ''}

    <!-- Step 2: Jawwal Pay & PalPay Payment & Confirmation Box -->
    ${canShowForm ? `
      <div class="card shop-pay no-print">
        ${isRetryChance ? `
          <div class="esim-ready-notice" style="background:rgba(245,158,11,.10);border-color:rgba(245,158,11,.35)">
            ${icon('alert')}
            <div class="grow">
              <b style="display:block;color:#b45309">لم يتم العثور على المعاملة بعد — يرجى التأكد من البيانات والمحاولة مرة ثانية</b>
              <small style="display:block;line-height:1.55">
                تأكد من كتابة اسم المرسل أو رقم المحفظة بشكل صحيح ثم اضغط تأكيد ليتم التحقق تلقائياً خلال ثوانٍ.
              </small>
            </div>
          </div>
        ` : `
          <div class="row between" style="flex-wrap:wrap;gap:8px">
            <h3 style="margin:0">الدفع عبر Jawwal Pay أو PalPay</h3>
            <span class="shop-sec-tag">${icon('bolt')}<span>التحقق تلقائي وخلال ثوانٍ</span></span>
          </div>
          <p class="muted" style="margin:0;font-size:.85rem">
            أرسل المبلغ المطلوب من تطبيق <b>Jawwal Pay</b> أو <b>PalPay (الدفع لصديق)</b> إلى الرقم أدناه ثم أكّد الإرسال:
          </p>
        `}

        <div class="shop-pay-kvs">
          <div class="shop-kv shop-copy-card">
            <div class="shop-kv-meta">
              <span>المبلغ المطلوب</span>
              <b class="ltr mono shop-kv-val">${fmtShekel(o.amount)}</b>
            </div>
            <button type="button" class="btn ghost btn-sm shop-copy-btn" data-copy="${esc(String(o.amount))}">${icon('copy')}<span>نسخ المبلغ</span></button>
          </div>
          ${jp.number ? `
            <div class="shop-kv shop-copy-card">
              <div class="shop-kv-meta">
                <span>${hasSeparatePalpay ? 'رقم محفظة جوال باي (Jawwal Pay)' : 'رقم المحفظة (Jawwal Pay / PalPay)'}</span>
                <b class="ltr mono shop-kv-val">${esc(fmtPhone(jp.number))}</b>
              </div>
              <button type="button" class="btn ghost btn-sm shop-copy-btn" data-copy="${esc(jp.number)}">${icon('copy')}<span>نسخ الرقم</span></button>
            </div>
          ` : ''}
          ${hasSeparatePalpay ? `
            <div class="shop-kv shop-copy-card">
              <div class="shop-kv-meta">
                <span>رقم بال باي / الدفع لصديق (PalPay)</span>
                <b class="ltr mono shop-kv-val">${esc(fmtPhone(pp.number))}</b>
              </div>
              <button type="button" class="btn ghost btn-sm shop-copy-btn" data-copy="${esc(pp.number)}">${icon('copy')}<span>نسخ الرقم</span></button>
            </div>
          ` : !jp.number && pp.number ? `
            <div class="shop-kv shop-copy-card">
              <div class="shop-kv-meta">
                <span>رقم بال باي / الدفع لصديق (PalPay)</span>
                <b class="ltr mono shop-kv-val">${esc(fmtPhone(pp.number))}</b>
              </div>
              <button type="button" class="btn ghost btn-sm shop-copy-btn" data-copy="${esc(pp.number)}">${icon('copy')}<span>نسخ الرقم</span></button>
            </div>
          ` : ''}
          ${jp.name || pp.name ? `
            <div class="shop-kv">
              <span>اسم المستلم</span>
              <b>${esc(jp.name || pp.name)}</b>
            </div>
          ` : ''}
        </div>

        ${renderPaymentSecurityShield()}

        <hr style="border:0;border-top:1px solid var(--line);margin:4px 0">

        <h3>${isRetryChance ? 'تأكيد البيانات للمحاولة الثانية' : 'تأكيد الإرسال'}</h3>

        <form id="proof-f" class="form" style="margin-top:4px">
          <div class="field">
            <label for="f-pname">اسم صاحب المحفظة / الحساب المحوِّل</label>
            <input id="f-pname" name="payName" class="input" autocomplete="name" value="${esc(o.payName || (o.customerName && o.customerName !== 'زبون المتجر' ? o.customerName : ''))}" placeholder="مثال: المعتز بالله عاطف أبو خاطر">
          </div>
          <div class="field">
            <label for="f-payer">رقم المحفظة المحوَّل منها <span class="muted">(اختياري)</span></label>
            <input id="f-payer" name="payPhone" class="input ltr" inputmode="tel" value="${esc(o.payPhone || '')}" placeholder="059XXXXXXX">
          </div>
          <div class="field">
            <label for="f-ref">الرقم المرجعي للحركة <span class="muted">(اختياري)</span></label>
            <input id="f-ref" name="payReference" class="input ltr" inputmode="numeric" autocomplete="off" value="${esc(o.payReference || '')}" placeholder="اختياري">
          </div>
          <div class="field">
            <label>صورة إشعار التحويل <span class="muted">(اختياري)</span></label>
            <label class="upload-box" id="proof-box">
              <input id="f-proof" type="file" accept="image/*" hidden>
              <img id="proof-preview" class="shop-proof-thumb" alt="معاينة الإشعار" hidden>
              <span id="proof-ic">${icon('image')}</span>
              <span id="proof-label">${o.proofSent ? 'تم إرسال الإشعار — اضغط للتغيير' : 'اضغط لاختيار لقطة شاشة الإشعار'}</span>
            </label>
          </div>
          <button class="btn primary lg" type="submit">${icon('checkCircle')}<span>${isRetryChance ? 'تأكيد البيانات وإعادة التحقق' : 'أرسلت المبلغ — تأكيد الآن'}</span></button>
        </form>
      </div>
    ` : transferChecking ? `
      <div class="card shop-pay no-print">
        ${isSupportNeeded ? `
          <div class="esim-ready-notice" style="background:rgba(220,38,38,.09);border-color:rgba(220,38,38,.35)">
            ${icon('alert')}
            <div class="grow">
              <b style="display:block;color:var(--danger,#dc2626)">مضت 15 دقيقة ولم يعثر النظام على المعاملة تلقائياً</b>
              <small style="display:block;line-height:1.55">
                يرجى التحدث مع الدعم الآن لتأكيد عملية التحويل وتفعيل طلبك فوراً.
              </small>
            </div>
          </div>
          ${wa ? `<a class="btn primary lg" href="${esc(wa)}" target="_blank" rel="noopener">${icon('whatsapp')}<span>التحدث مع الدعم الآن</span></a>` : ''}
        ` : `
          <div class="row between" style="flex-wrap:wrap;gap:8px">
            <h3 style="margin:0">يرجى الانتظار حتى 15 دقيقة كحد أقصى</h3>
            <span class="shop-sec-tag">${icon('clock')}<span>تحقق تلقائي</span></span>
          </div>
          <p class="muted" style="margin:0;font-size:.88rem;line-height:1.6">
            لم يتم العثور على المعاملة بعد. يرجى الانتظار <b>ربع ساعة (15 دقيقة) كحد أقصى</b> ومراجعة <b>صفحة الطلبات</b>، حيث يتم التحقق تلقائياً مرة أخرى فور دخولك لصفحة الطلبات.
          </p>
          <div class="row" style="gap:10px;flex-wrap:wrap;margin-top:4px">
            <a href="#/orders" class="btn primary lg grow">${icon('list')}<span>مراجعة صفحة الطلبات</span></a>
          </div>
        `}
        <div class="shop-breakdown-box">
          ${o.payName ? `<div class="shop-bd-row"><span>اسم المحوِّل</span><b>${esc(o.payName)}</b></div>` : ''}
          ${o.payPhone ? `<div class="shop-bd-row"><span>رقم المحفظة</span><b class="ltr mono">${esc(fmtPhone(o.payPhone))}</b></div>` : ''}
          ${o.payReference ? `<div class="shop-bd-row"><span>الرقم المرجعي</span><b class="ltr mono">${esc(o.payReference)}</b></div>` : ''}
        </div>
      </div>
    ` : ''}

    <!-- Step 3: Scannable eSIM QR Code Pass -->
    ${hasEsimDelivery ? `
      <div class="card shop-qr-modern">
        <div class="shop-qr-badge">
          ${icon('checkCircle')}
          <span>شريحة eSIM جاهزة للمسح والتثبيت</span>
        </div>

        <h3 style="margin:0">${hasQr ? 'امسح كود الـ QR أو ثبّت الشريحة مباشرة' : 'ثبّت شريحة eSIM باستخدام كود التفعيل'}</h3>
        <p class="muted" style="margin:0;font-size:.86rem">
          تأكد من اتصال هاتفك بشبكة Wi-Fi أثناء تثبيت الشريحة الإلكترونية:
        </p>

        ${hasQr ? `
          <div class="shop-qr-frame">
            <img id="qr-img" src="${esc(o.esimQr)}" alt="كود QR لشريحة eSIM ${esc(o.number || '')}">
          </div>
        ` : ''}

        <div class="esim-qr-details">
          ${o.number ? `
            <div class="shop-kv shop-copy-card">
              <div class="shop-kv-meta">
                <span>رقم الخط المخصّص لك</span>
                <b class="ltr mono shop-kv-val">${esc(fmtPhone(o.number))}</b>
              </div>
              <button type="button" class="btn ghost btn-sm no-print shop-copy-btn" data-copy="${esc(o.number)}">${icon('copy')}<span>نسخ الرقم</span></button>
            </div>
          ` : ''}
        </div>

        ${hasCode ? `
          <div class="shop-lpa-box no-print">
            <small class="muted">كود التفعيل اليدوي (LPA) — للتثبيت على نفس الهاتف بدون كاميرا:</small>
            <div class="shop-lpa-row">
              <code class="ltr">${esc(o.esimCode)}</code>
              <button type="button" class="btn ghost btn-sm shop-copy-btn" data-copy="${esc(o.esimCode)}">${icon('copy')}<span>نسخ الكود</span></button>
            </div>
          </div>
        ` : ''}

        <div class="shop-qr-actions no-print">
          ${appleInstallHref ? `
            <a class="btn primary shop-apple-esim-btn" href="${esc(appleInstallHref)}">
              ${icon('phone')}<span>تثبيت مباشر على iPhone (iOS 17.4+)</span>
            </a>
          ` : ''}
          ${hasQr ? `
            <a class="btn ${appleInstallHref ? 'ghost' : 'primary'}" href="${esc(o.esimQr)}" download="esim-${esc(o.number || o.code)}.png">
              ${icon('download')}<span>حفظ صورة الـ QR في الهاتف</span>
            </a>
          ` : ''}
          <button type="button" class="btn ghost" id="share-order-btn">
            ${icon('share')}<span>فتح على جهاز آخر</span>
          </button>
          <button type="button" class="btn ghost" id="print-qr-btn">
            ${icon('print')}<span>طباعة</span>
          </button>
        </div>

        ${o.qrMailed ? `<p class="muted" style="margin:0;font-size:.84rem">${icon('checkCircle')} أُرسلت نسخة إلى <span class="ltr">${esc(o.email)}</span></p>` : ''}

        <div class="shop-single-phone-tip no-print">
          <b>📱 هل تفتح هذه الصفحة من نفس الهاتف الذي تريد تثبيت الشريحة عليه؟</b>
          <p>${hasQr ? 'اضغط <b>حفظ صورة الـ QR في الهاتف</b> ثم افتح إعدادات إضافة eSIM واختر <b>اختيار من الصور / المعرض</b>، أو انسخ <b>كود التفعيل اليدوي (LPA)</b> أعلاه والصقه في خيار «إدخال التفاصيل يدوياً».' : 'اضغط زر التثبيت المباشر على iPhone أو انسخ <b>كود التفعيل اليدوي (LPA)</b> أعلاه والصقه في خيار «إدخال التفاصيل يدوياً».'}</p>
        </div>

        <div class="shop-qr-guides">
          <div class="shop-qr-guide-col">
            <b>على iPhone:</b>
            <ol>
              <li>الإعدادات ← خلوي ← إضافة شريحة إلكترونية.</li>
              <li>اختر <b>استخدام رمز QR</b> (أو فتح من الصور / إدخال يدوي).</li>
            </ol>
          </div>
          <div class="shop-qr-guide-col">
            <b>على Android:</b>
            <ol>
              <li>الضبط ← الاتصالات ← إدارة SIM ← إضافة eSIM.</li>
              <li>امسح الكود أو اختر صورة الـ QR من المعرض.</li>
            </ol>
          </div>
        </div>
      </div>
    ` : ''}

    ${o.stage === 'done' && !hasEsimDelivery ? `
      <div class="card empty">
        ${icon('checkCircle')}
        <p>${isEsim ? 'تمّ تفعيل باقتك — إذا لم يظهر رمز الـ QR تواصل مع الدعم لإرساله لك فوراً.' : 'تمّ تفعيل باقتك بنجاح.'}</p>
        <a href="#/" class="btn ghost">العودة للمتجر</a>
      </div>
    ` : ''}

    ${wa ? `<a class="btn ghost no-print" style="justify-self:center" href="${esc(wa)}" target="_blank" rel="noopener">${icon('whatsapp')}<span>تواصل مع الدعم</span></a>` : ''}
  `, { sub: `طلب ${o.code}` });

  if (o.reservedUntil && o.status === 'awaiting_payment') {
    S.countdownTimer = setInterval(async () => {
      const el = document.getElementById('reserve-countdown');
      if (!el) { clearInterval(S.countdownTimer); return; }
      el.textContent = fmtRemaining(o.reservedUntil);
      if (Date.now() >= Number(o.reservedUntil)) {
        clearInterval(S.countdownTimer);
        try {
          S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}`);
          renderOrder();
        } catch {}
      }
    }, 1000);
  } else if (isRetryChance && o.retryUntil) {
    S.countdownTimer = setInterval(async () => {
      const el = document.getElementById('retry-countdown');
      if (!el) { clearInterval(S.countdownTimer); return; }
      el.textContent = fmtRemaining(o.retryUntil);
      if (Date.now() >= Number(o.retryUntil)) {
        clearInterval(S.countdownTimer);
        try {
          S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}`);
          renderOrder();
        } catch {}
      }
    }, 1000);
  } else if (transferChecking && !isSupportNeeded && o.waitUntil) {
    S.countdownTimer = setInterval(async () => {
      const el = document.getElementById('wait-countdown');
      if (!el) { clearInterval(S.countdownTimer); return; }
      el.textContent = fmtRemaining(o.waitUntil);
      if (Date.now() >= Number(o.waitUntil)) {
        clearInterval(S.countdownTimer);
        try {
          S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}?check=1`);
          renderOrder();
        } catch {}
      }
    }, 1000);
  }

  const copyCode = document.getElementById('copy-code');
  if (copyCode) copyCode.onclick = () => copyWithFeedback(copyCode, o.code);
  const printBtn = document.getElementById('print-order');
  if (printBtn) printBtn.onclick = () => window.print();
  const printQrBtn = document.getElementById('print-qr-btn');
  if (printQrBtn) printQrBtn.onclick = () => window.print();
  const shareOrderBtn = document.getElementById('share-order-btn');
  if (shareOrderBtn) {
    shareOrderBtn.onclick = async () => {
      const url = `${location.origin}/#/order/${encodeURIComponent(o.code)}`;
      if (navigator.share) {
        try { await navigator.share({ title: `طلب eSIM ${o.code}`, url }); return; } catch {}
      }
      copyWithFeedback(shareOrderBtn, url);
    };
  }

  root.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => copyWithFeedback(b, b.dataset.copy);
  });

  const cancelBtn = document.getElementById('cancel-order-btn');
  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      // After the transfer details were sent: the money may already be with the shop, which then contacts them.
      if (o.status !== 'awaiting_payment' && !window.confirm('أرسلت بيانات التحويل لهذا الطلب. إذا كنت حوّلت المبلغ، المتجر بيتواصل معك بخصوصه. إلغاء الطلب؟')) return;
      try {
        S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}/cancel`, { method: 'POST' });
        notify('تم إلغاء الطلب');
        renderOrder();
      } catch (err) {
        notify(err.message, true);
      }
    };
  }

  if (showDirect) bindDirectPay(o);

  const fileInput = document.getElementById('f-proof');
  let proofData = '';
  if (fileInput) {
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        proofData = await fileToDataUrl(file, { max: 1400 });
        document.getElementById('proof-label').textContent = `تم إرفاق: ${file.name}`;
        const prevImg = document.getElementById('proof-preview');
        const prevIc = document.getElementById('proof-ic');
        if (prevImg && validQrDataUrl(proofData)) {
          prevImg.src = proofData;
          prevImg.hidden = false;
          if (prevIc) prevIc.hidden = true;
        }
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
        notify('أدخل اسم صاحب المحفظة أو رقم المحفظة أو الرقم المرجعي', true);
        return;
      }
      const btn = pf.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}/proof`, {
          method: 'POST',
          body: { payReference, payName, payPhone, receipt: proofData },
        });
        if (S.order.status === 'paid') {
          notify('تم التحقق من الدفع وتفعيل الطلب بنجاح');
        } else if (S.order.canRetryProof) {
          notify('لم يتم العثور على المعاملة — يرجى التأكد من البيانات والمحاولة مرة ثانية', true);
        } else {
          notify('لم يتم العثور على المعاملة بعد — يرجى الانتظار حتى 15 دقيقة كحد أقصى ومراجعة صفحة الطلبات', true);
        }
        renderOrder();
      } catch (err) {
        notify(err.message, true);
        btn.disabled = false;
      }
    };
  }
}

async function route() {
  const seq = ++S.seq;
  clearInterval(S.pollTimer);
  clearInterval(S.countdownTimer);
  try {
    await ensureCatalog();
  } catch (err) {
    if (seq !== S.seq) return;
    root.innerHTML = `<main class="shop-main"><div class="card empty">${icon('alert')}<p>${esc(err.message)}</p></div></main>`;
    return;
  }
  if (seq !== S.seq) return;
  const rawHash = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = rawHash.split('?');
  const params = new URLSearchParams(queryPart || '');
  const [head, arg] = pathPart.split('/');
  const cleanPath = location.pathname.replace(/^\/|\/$/g, '').toLowerCase();
  const pathPkgMatch = !rawHash && location.pathname.match(/^\/package\/(\d+)/);

  if (rawHash && location.pathname !== '/') {
    history.replaceState(null, '', `/#/${rawHash}`);
  }

  window.scrollTo({ top: 0, behavior: 'instant' });

  if (pathPkgMatch) return viewPackage(pathPkgMatch[1], seq);
  if (head === 'package' && arg) return viewPackage(arg, seq);
  const infoRoute = head || (!rawHash ? cleanPath : '');
  if (infoRoute === 'compat') {
    setPageMeta({ title: `فحص توافق الأجهزة مع شريحة eSIM | ${S.data?.shopTitle || 'Hot eSIM'}`, canonicalPath: '/compat' });
    return viewCompatPage();
  }
  if (infoRoute === 'terms') {
    setPageMeta({ title: `شروط البيع والتفعيل | ${S.data?.shopTitle || 'Hot eSIM'}`, canonicalPath: '/terms' });
    return viewLegalPage('terms');
  }
  if (infoRoute === 'esim-policy') {
    setPageMeta({ title: `دليل التثبيت وسياسة كود eSIM QR | ${S.data?.shopTitle || 'Hot eSIM'}`, canonicalPath: '/esim-policy' });
    return viewLegalPage('esim');
  }
  if (infoRoute === 'guarantee') {
    setPageMeta({ title: `ضمان المتجر واسترجاع المبلغ | ${S.data?.shopTitle || 'Hot eSIM'}`, canonicalPath: '/guarantee' });
    return viewLegalPage('guarantee');
  }
  if (head === 'track' || head === 'orders') {
    S.myOrders = null;
    return viewTrackPage(seq);
  }
  if (head === 'buy' && arg) {
    if (params.get('esim') === '1') S.wantEsim = true;
    else if (!queryPart) S.wantEsim = false;
    return viewBuy(arg, seq);
  }
  if (head === 'order' && arg) {
    let decoded = arg;
    try { decoded = decodeURIComponent(arg); } catch {}
    return viewOrder(decoded, seq);
  }
  setPageMeta({
    title: `${S.data?.shopTitle || 'Hot eSIM'} | شرائح eSIM وباقات الإنترنت في الضفة الغربية وقطاع غزة وفلسطين`,
    canonicalPath: '/',
  });
  viewCatalog();
}

window.addEventListener('hashchange', route);
window.addEventListener('popstate', route);
route();
