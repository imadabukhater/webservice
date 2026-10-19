// Customer Storefront (/shop): Authentic eSIM & Telecom Plan Storefront.
// Uses ES module imports from ./core.js and sheet() modals — zero emojis, crisp vector SVGs.
import {
  esc, icon, fmtMoney, fmtNum, fmtDateTime, fmtDate, specs, companyLogo,
  fileToDataUrl, copyText, toast, supportHref, fmtPhone, sheet, closeSheet,
} from './core.js';

const MY_ORDERS_KEY = 'shop_orders_v1';
function savedOrderCodes() {
  try { return JSON.parse(localStorage.getItem(MY_ORDERS_KEY) || '[]').filter((x) => typeof x === 'string'); }
  catch { return []; }
}
function rememberOrderCode(code) {
  if (!code) return;
  const list = [code, ...savedOrderCodes().filter((c) => c !== code)].slice(0, 30);
  try { localStorage.setItem(MY_ORDERS_KEY, JSON.stringify(list)); } catch {}
}

const S = {
  data: null,
  companyId: 'all',
  kindFilter: 'all', // 'all' | 'esim' | 'card' | 'line'
  q: '',
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
  return localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
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

// Vector eSIM metallic chip SVG emblem (authentic SIM contact pad geometry)
function esimChipSvg(cls = 'esim-chip-svg') {
  return `<svg class="${cls}" viewBox="0 0 44 34" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="42" height="32" rx="6" fill="url(#chipGrad)" stroke="currentColor" stroke-width="1.4" stroke-opacity=".35"/>
    <path d="M14 1v32M30 1v32M1 12h13M30 12h13M1 22h13M30 22h13M18 11h8v12h-8z" stroke="#78530d" stroke-width="1.2" stroke-opacity=".55"/>
    <defs>
      <linearGradient id="chipGrad" x1="0" y1="0" x2="44" y2="34" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#fde68a"/>
        <stop offset="50%" stop-color="#f59e0b"/>
        <stop offset="100%" stop-color="#d97706"/>
      </linearGradient>
    </defs>
  </svg>`;
}

function simCardSvg(cls = 'esim-sim-svg') {
  return `<svg class="${cls}" viewBox="0 0 28 34" fill="none" aria-hidden="true">
    <path d="M5 1.5h12.2L26.5 10v19A3.5 3.5 0 0 1 23 32.5H5A3.5 3.5 0 0 1 1.5 29V5A3.5 3.5 0 0 1 5 1.5z" stroke="currentColor" stroke-width="1.8"/>
    <rect x="7" y="14" width="14" height="12" rx="2.5" stroke="currentColor" stroke-width="1.6"/>
    <path d="M11.5 14v12M16.5 14v12M7 20h14" stroke="currentColor" stroke-width="1.2" opacity=".7"/>
  </svg>`;
}

function isEsimPkg(pk) {
  return Boolean(pk && (pk.esim || pk.kind === 'esim'));
}

function shell(body, { sub = '' } = {}) {
  const name = S.data?.shopName || 'متجر الشرائح والباقات';
  const wa = supportHref(S.data?.supportWhatsapp, `مرحباً، أحتاج مساعدة في ${name}`);
  const dark = document.documentElement.dataset.theme === 'dark';
  const hash = location.hash.replace(/^#\/?/, '');
  const onHome = !hash || hash.startsWith('?');

  root.innerHTML = `
    <header class="shop-top">
      <div class="shop-top-inner">
        <a href="#/" class="shop-brand">
          <span class="shop-brand-mark">${icon('sim')}</span>
          <span class="shop-brand-text">
            <strong>${esc(name)}</strong>
            <small><span class="shop-live-dot"></span>${esc(sub || 'متجر الشرائح الإلكترونية eSIM والباقات الفورية')}</small>
          </span>
        </a>

        <nav class="shop-nav" aria-label="التنقّل في المتجر">
          <a href="#/" class="shop-nav-link ${onHome && S.kindFilter !== 'esim' ? 'active' : ''}" data-act="nav-all">
            ${icon('sim')}<span>جميع الباقات</span>
          </a>
          <button type="button" class="shop-nav-link ${onHome && S.kindFilter === 'esim' ? 'active' : ''}" data-act="nav-esim">
            ${icon('qr')}<span>شرائح eSIM فورية</span>
          </button>
          <button type="button" class="shop-nav-link" data-act="compat">
            ${icon('chip')}<span>فحص توافق الجهاز</span>
          </button>
          <button type="button" class="shop-nav-link" data-act="legal">
            ${icon('shield')}<span>الضمان والشروط</span>
          </button>
          ${S.myCodes.length ? `
            <a href="#/orders" class="shop-nav-link ${hash === 'orders' ? 'active' : ''}">
              ${icon('list')}<span>طلباتي (${fmtNum(S.myCodes.length)})</span>
            </a>` : ''}
          <button type="button" class="shop-nav-link" data-act="track">
            ${icon('search')}<span>تتبّع طلب</span>
          </button>
        </nav>

        <div class="shop-utils">
          ${wa ? `<a class="btn btn-sm ghost" href="${esc(wa)}" target="_blank" rel="noopener">${icon('whatsapp')}<span>الدعم</span></a>` : ''}
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
          <div class="row" style="gap:8px">
            <span class="shop-brand-mark sm">${icon('sim')}</span>
            <b>${esc(name)}</b>
          </div>
          <p class="muted" style="margin:6px 0 0;font-size:.84rem">
            منصة معتمدة لتفعيل شرائح eSIM الرقمية الفورية، شحن الرصيد، وتجديد باقات الخليوي والإنترنت بأسعار واضحة وشاملة.
          </p>
        </div>
        <div class="shop-footer-links">
          <button type="button" class="link-btn" data-act="compat">فحص توافق الهاتف مع eSIM</button>
          <button type="button" class="link-btn" data-act="legal" data-tab="terms">شروط البيع والتفعيل</button>
          <button type="button" class="link-btn" data-act="legal" data-tab="esim">سياسة كود eSIM QR</button>
          <button type="button" class="link-btn" data-act="legal" data-tab="guarantee">ضمان المتجر واسترجاع المبلغ</button>
          <button type="button" class="link-btn" data-act="track">تتبّع حالة طلب</button>
        </div>
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
  scope.querySelectorAll('[data-act="track"]').forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); openTrackSheet(); };
  });
  scope.querySelectorAll('[data-act="compat"]').forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openCompatSheet(); };
  });
  scope.querySelectorAll('[data-act="legal"]').forEach((b) => {
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

function openTrackSheet() {
  sheet({
    title: 'تتبّع حالة طلبك',
    subtitle: 'أدخل رقم الطلب للاطلاع على حالة التفعيل أو عرض كود eSIM QR الخاص بك',
    body: `
      <form id="track-f" class="form">
        <div class="field">
          <label for="f-code">رقم الطلب</label>
          <input id="f-code" name="code" class="ltr" required placeholder="ORD-XXXXXX-XXXX" autocomplete="off">
        </div>
      </form>`,
    footer: `
      <button type="button" class="btn ghost" data-close>إلغاء</button>
      <button type="submit" form="track-f" class="btn primary">${icon('search')}<span>عرض تفاصيل الطلب</span></button>`,
  });
  document.getElementById('track-f').onsubmit = (e) => {
    e.preventDefault();
    const code = new FormData(e.currentTarget).get('code').trim().toUpperCase();
    if (!code) return;
    closeSheet();
    location.hash = `#/order/${encodeURIComponent(code)}`;
  };
}

const COMPAT_DEVICES = {
  apple: {
    label: 'أجهزة Apple iPhone',
    note: 'جميع هواتف iPhone منذ عام 2018 (بدءاً من iPhone XS / XR فما فوق) تدعم شريحة eSIM بشكل كامل.',
    models: [
      'iPhone 16 / 16 Plus / 16 Pro / 16 Pro Max',
      'iPhone 15 / 15 Plus / 15 Pro / 15 Pro Max',
      'iPhone 14 / 14 Plus / 14 Pro / 14 Pro Max',
      'iPhone 13 / 13 mini / 13 Pro / 13 Pro Max',
      'iPhone 12 / 12 mini / 12 Pro / 12 Pro Max',
      'iPhone 11 / 11 Pro / 11 Pro Max',
      'iPhone XS / XS Max / XR / SE (الجيل 2 و 3)',
    ],
  },
  samsung: {
    label: 'أجهزة Samsung Galaxy',
    note: 'معظم هواتف الفئة العليا S و Z Fold/Flip تدعم شريحة eSIM الرقمية.',
    models: [
      'Galaxy S25 / S25+ / S25 Ultra',
      'Galaxy S24 / S24+ / S24 Ultra / S24 FE',
      'Galaxy S23 / S23+ / S23 Ultra / S23 FE',
      'Galaxy S22 / S22+ / S22 Ultra',
      'Galaxy S21 / S21+ / S21 Ultra',
      'Galaxy S20 / S20+ / S20 Ultra / Note 20',
      'Galaxy Z Fold & Z Flip (جميع الأجيال 2 حتى 6)',
      'Galaxy A55 5G / A54 5G / A35 5G (النسخ الداعمة لـ eSIM)',
    ],
  },
  google: {
    label: 'أجهزة Google Pixel',
    note: 'هواتف Google Pixel هي من أوائل الهواتف الداعمة لتقنية eSIM.',
    models: [
      'Pixel 9 / 9 Pro / 9 Pro XL / 9 Pro Fold',
      'Pixel 8 / 8a / 8 Pro',
      'Pixel 7 / 7a / 7 Pro',
      'Pixel 6 / 6a / 6 Pro / Pixel 5 / Pixel 4',
    ],
  },
  other: {
    label: 'Xiaomi / Honor / Huawei / Motorola',
    note: 'العديد من الإصدارات الحديثة تدعم eSIM — تحقق دائماً عبر كود *#06#.',
    models: [
      'Xiaomi 14 / 14 Pro / 13 / 13 Pro / 13T / 12T Pro',
      'Redmi Note 13 Pro+ 5G (النسخة العالمية)',
      'Honor Magic 6 Pro / Magic 5 Pro / Honor 90 / 200 Pro',
      'Huawei P40 / P40 Pro / Mate 40 Pro / Pura 70 Pro',
      'Motorola Edge 50 / Edge 40 / Razr 40 & 50',
    ],
  },
};

function openCompatSheet() {
  let activeBrand = 'apple';
  const el = sheet({
    title: 'فحص توافق هاتفك مع شريحة eSIM',
    subtitle: 'تأكد خلال ثوانٍ من أن هاتفك يدعم الشريحة الرقمية قبل الشراء',
    wide: true,
    body: `<div id="compat-body"></div>`,
    footer: `<button type="button" class="btn primary" data-close>تم الفحص — العودة للمتجر</button>`,
  });

  function renderCompat() {
    const info = COMPAT_DEVICES[activeBrand] || COMPAT_DEVICES.apple;
    const container = el.querySelector('#compat-body');
    container.innerHTML = `
      <div class="esim-eid-check">
        <div class="esim-eid-icon">${icon('phone')}</div>
        <div class="grow">
          <strong>الطريقة الأسرع والأدقّ (خلال 5 ثوانٍ):</strong>
          <p class="muted" style="margin:4px 0 0;font-size:.86rem">
            افتح لوحة الاتصال في هاتفك واطلب الكود <kbd dir="ltr">*#06#</kbd> — إذا ظهر لك رقم تحت اسم <b>EID</b> (مكوّن من 32 رقماً)، فهاتفك يدعم شريحة <b>eSIM</b> بنسبة 100% بشرط أن يكون مفتوح الشبكة (غير مقفل).
          </p>
        </div>
      </div>

      <div class="seg" role="tablist" style="margin-top:14px">
        ${Object.entries(COMPAT_DEVICES).map(([k, v]) => `
          <button type="button" role="tab" aria-selected="${activeBrand === k}" data-brand="${k}">${esc(v.label)}</button>
        `).join('')}
      </div>

      <div class="esim-compat-box" style="margin-top:12px">
        <p class="muted" style="margin:0 0 10px;font-size:.86rem">${esc(info.note)}</p>
        <ul class="esim-compat-list">
          ${info.models.map((m) => `<li>${icon('checkCircle')}<span class="ltr">${esc(m)}</span></li>`).join('')}
        </ul>
      </div>
    `;
    container.querySelectorAll('[data-brand]').forEach((btn) => {
      btn.onclick = () => {
        activeBrand = btn.dataset.brand;
        renderCompat();
      };
    });
  }
  renderCompat();
}

function openLegalSheet(initialTab = 'terms') {
  let tab = initialTab || 'terms';
  const el = sheet({
    title: 'شروط البيع، سياسة eSIM، وضمان المتجر',
    subtitle: 'شفافية كاملة لحماية حقوق المشترك وتوضيح آلية التفعيل الفوري',
    wide: true,
    body: `<div id="legal-body"></div>`,
    footer: `<button type="button" class="btn primary" data-close>فهمت وموافق</button>`,
  });

  function renderLegal() {
    const container = el.querySelector('#legal-body');
    container.innerHTML = `
      <div class="seg" role="tablist">
        <button type="button" role="tab" aria-selected="${tab === 'terms'}" data-ltab="terms">شروط التفعيل والبيع</button>
        <button type="button" role="tab" aria-selected="${tab === 'esim'}" data-ltab="esim">سياسة شرائح eSIM وكود QR</button>
        <button type="button" role="tab" aria-selected="${tab === 'guarantee'}" data-ltab="guarantee">ضمان المتجر والاسترجاع</button>
      </div>
      <div class="esim-legal-panel" style="margin-top:14px">
        ${tab === 'terms' ? `
          <h4>شروط التفعيل والبيع العامة</h4>
          <ul class="esim-legal-list">
            <li><b>شفافية الأسعار:</b> جميع الأسعار المعروضة بالشيكل (₪) نهائية وشاملة، وتظهر لك تفاصيل سعر الباقة ورسوم كود eSIM QR (إن وجدت) بوضوح قبل إتمام الطلب.</li>
            <li><b>صحة رقم الهاتف:</b> في طلبات شحن الرصيد وتجديد الباقات، يتحمّل المشترك مسؤولية إدخال رقم الهاتف الصحيح. بمجرد تنفيذ الشحن على الرقم المدخل لدى شركة الاتصالات، لا يمكن سحبه أو نقله لرقم آخر.</li>
            <li><b>التفعيل الفوري والتلقائي:</b> يتم تنفيذ الطلبات تلقائياً فور تأكيد الدفع، أو مباشرةً عبر زر التفعيل الفوري في باقات eSIM المربوطة بالنظام المباشر.</li>
            <li><b>إيصال الطلب:</b> يحصل كل طلب على كود تتبّع فريد (مثل <code class="ltr">ORD-XXXXXX</code>) يمكّنك من متابعة حالة التفعيل وتحميل كود QR في أي وقت.</li>
          </ul>
        ` : tab === 'esim' ? `
          <h4>سياسة شرائح eSIM الرقمية وكود الـ QR</h4>
          <ul class="esim-legal-list">
            <li><b>توافق الجهاز قبل الشراء:</b> يرجى التحقق من دعم هاتفك لتقنية eSIM عبر طلب <kbd dir="ltr">*#06#</kbd> وظهور رقم <b>EID</b>، والتأكد من أن الجهاز غير مقفل على شبكة أخرى (Network Unlocked).</li>
            <li><b>صلاحية كود QR للاستخدام مرة واحدة:</b> كود الـ QR الخاص بشريحة eSIM مخصّص للمسح والتثبيت على جهاز واحد فقط. لا تشارك صورة الكود مع أي طرف آخر.</li>
            <li><b>عدم حذف الشريحة بعد التثبيت:</b> بعد مسح الكود وتثبيت شريحة eSIM في إعدادات الهاتف، لا تقم بحذفها (Delete / Remove eSIM) لأن معظم شركات الاتصالات لا تسمح بإعادة مسح نفس الكود مرة ثانية إلا بإصدار بدل شريحة جديد.</li>
            <li><b>اتصال الإنترنت أثناء المسح:</b> يتطلب مسح كود eSIM QR وتنزيل ملف الشريحة اتصالاً مستقراً بشبكة Wi-Fi أو بيانات خلوية.</li>
          </ul>
        ` : `
          <h4>ضمان المتجر وحماية المشتري</h4>
          <ul class="esim-legal-list">
            <li><b>ضمان التفعيل 100%:</b> إذا تعذّر تفعيل الباقة أو إصدار شريحة eSIM من المصدر لأي سبب تقني، يلتزم المتجر باستبدالها فوراً أو إرجاع كامل المبلغ المدفوع دون أي اقتطاع.</li>
            <li><b>حفظ كود QR في صفحة طلبك:</b> في حال أغلقت الصفحة بعد التفعيل، يظل كود الـ QR ومعلومات الشريحة (الرقم و ICCID) محفوظين في صفحة تتبّع الطلب الخاصة بك.</li>
            <li><b>دعم فني مباشر:</b> فريق الدعم متواجد لمساعدتك خطوة بخطوة في تثبيت شريحة eSIM أو متابعة أي طلب عبر واتساب مع ذكر رقم الطلب.</li>
          </ul>
        `}
      </div>
    `;
    container.querySelectorAll('[data-ltab]').forEach((btn) => {
      btn.onclick = () => {
        tab = btn.dataset.ltab;
        renderLegal();
      };
    });
  }
  renderLegal();
}

async function ensureCatalog() {
  if (!S.data) S.data = await jfetch('/api/shop/catalog');
}

function viewCatalog() {
  const { companies, packages } = S.data;
  const coMap = new Map(companies.map((c) => [c.id, c]));

  // Counts per service type
  const totalCount = packages.length;
  const esimCount = packages.filter((p) => isEsimPkg(p)).length;
  const cardCount = packages.filter((p) => p.kind === 'card').length;
  const lineCount = packages.filter((p) => p.kind === 'line').length;

  // Filtered packages
  const q = S.q.trim().toLowerCase();
  const shown = packages.filter((p) => {
    if (S.companyId !== 'all' && String(p.companyId) !== String(S.companyId)) return false;
    if (S.kindFilter === 'esim' && !isEsimPkg(p)) return false;
    if (S.kindFilter === 'card' && p.kind !== 'card') return false;
    if (S.kindFilter === 'line' && p.kind !== 'line') return false;
    if (q) {
      const coName = coMap.get(p.companyId)?.name || '';
      const hay = `${p.name} ${p.description || ''} ${coName} ${p.gb || ''} ${p.days || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Sort: featured first, then eSIM when in esim filter, then price ascending
  shown.sort((a, b) => {
    if (Boolean(b.featured) !== Boolean(a.featured)) return (b.featured ? 1 : 0) - (a.featured ? 1 : 0);
    return Number(a.price || 0) - Number(b.price || 0);
  });

  const maxGb = Math.max(100, ...packages.map((p) => Number(p.gb) || 0));

  shell(`
    <!-- Authentic eSIM & Telecom Hero -->
    <section class="esim-hero">
      <div class="esim-hero-grid">
        <div class="esim-hero-copy">
          <div class="esim-hero-kicker">
            ${icon('qr')}
            <span>الجيل الرقمي من شرائح الاتصال · eSIM & Telecom Store</span>
          </div>
          <h1>باقات الخليوي وشرائح eSIM الفورية بكود QR مباشر</h1>
          <p>
            اختر شبكتك وباقتك المفضّلة، فعّل شريحة <b>eSIM</b> واستلم كود الـ QR الجاهز للمسح فوراً على شاشتك، أو اشحن رقمك الحالي خلال ثوانٍ بأسعار واضحة وشاملة.
          </p>

          <div class="esim-search-box" role="search">
            <span class="esim-search-ic">${icon('search')}</span>
            <input id="shop-q" type="search" value="${esc(S.q)}" placeholder="ابحث عن باقة، حجم الإنترنت (GB)، أو اسم الشبكة..." autocomplete="off">
            ${S.q ? `<button type="button" class="icon-btn sm" id="shop-q-clear" aria-label="مسح البحث">${icon('x')}</button>` : ''}
          </div>

          <div class="esim-trust-row">
            <span>${icon('qr')} استلام فوري لكود eSIM QR</span>
            <span>${icon('shield')} أسعار نهائية شاملة بدون رسوم مخفية</span>
            <button type="button" class="esim-compat-pill" data-act="compat">
              ${icon('chip')}
              <span>هل هاتفي يدعم eSIM؟ افحص الآن</span>
            </button>
          </div>
        </div>

        <!-- Visual Digital eSIM Card Showcase -->
        <div class="esim-hero-card-wrap" aria-hidden="true">
          <div class="esim-showcase-card">
            <div class="esim-showcase-top">
              <div>
                <span class="esim-showcase-tag">DIGITAL eSIM PROFILE</span>
                <strong>شريحة إلكترونية فورية</strong>
              </div>
              ${esimChipSvg('esim-chip-svg lg')}
            </div>
            <div class="esim-showcase-specs">
              <div><small>التقنية</small><b class="ltr">4G LTE / 5G Ready</b></div>
              <div><small>طريقة التثبيت</small><b>مسح كود QR فوري</b></div>
              <div><small>الأجهزة الداعمة</small><b class="ltr">iPhone · Samsung · Pixel</b></div>
            </div>
            <div class="esim-showcase-foot">
              <span class="esim-showcase-status"><i class="shop-live-dot"></i> التفعيل المباشر متاح الآن</span>
              <span class="mono ltr" style="font-size:.78rem;opacity:.8">LPA:1$INSTANT.ESIM</span>
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
          <span>كل الباقات</span>
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
            <span>شحن وتجديد رقم حالي</span>
            <small>${fmtNum(cardCount)}</small>
          </button>` : ''}
        ${lineCount ? `
          <button type="button" role="tab" class="esim-type-tab" aria-selected="${S.kindFilter === 'line'}" data-kind="line">
            ${icon('phone')}
            <span>خطوط جديدة</span>
            <small>${fmtNum(lineCount)}</small>
          </button>` : ''}
      </div>

      ${companies.length > 1 ? `
        <div class="esim-carrier-strip" role="tablist" aria-label="شركات الاتصالات">
          <button type="button" class="esim-carrier-pill" aria-pressed="${S.companyId === 'all'}" data-co="all">
            <span class="esim-carrier-all-ic">${icon('globe')}</span>
            <span class="esim-carrier-meta">
              <b>جميع الشبكات</b>
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
                  <small>${fmtNum(cPkgs.length)} باقة${hasEsim ? ' · تدعم eSIM' : ''}</small>
                </span>
              </button>`;
          }).join('')}
        </div>
      ` : ''}
    </section>

    <!-- Package Cards Grid (Airalo / Saily Telecom Card Layout) -->
    ${shown.length ? `
      <section class="esim-grid" aria-label="قائمة الباقات">
        ${shown.map((pk) => renderPlanCard(pk, coMap.get(pk.companyId), maxGb)).join('')}
      </section>
    ` : `
      <div class="card empty">
        ${icon('sim')}
        <p>لا توجد باقات مطابقة للفلتر المحدد حالياً</p>
        <button type="button" class="btn ghost btn-sm" id="reset-filters">إظهار جميع الباقات</button>
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
  const isDirectEsim = pk.kind === 'esim';
  const hasDiscount = Number(pk.oldPrice) > Number(pk.price);
  const savePct = hasDiscount ? Math.round(((pk.oldPrice - pk.price) / pk.oldPrice) * 100) : 0;
  const gbVal = Number(pk.gb) || 0;
  const gbPct = gbVal > 0 ? Math.min(100, Math.max(14, Math.round((gbVal / maxGb) * 100))) : 100;
  const daysVal = Number(pk.days) || 0;
  const perDay = daysVal >= 7 && pk.price > 0 ? (pk.price / daysVal).toFixed(1) : null;

  const callsLabel = pk.unlimitedCalls
    ? 'مكالمات ورسائل لا محدودة'
    : pk.minutes
      ? `${fmtNum(pk.minutes)} دقيقة مكالمات${pk.sms ? ` · ${fmtNum(pk.sms)} رسالة` : ''}`
      : 'إنترنت وبيانات خلوية';

  const qrFeeText = isDirectEsim
    ? 'كود QR مشمول بالسعر'
    : pk.esim
      ? (Number(pk.esimFee) > 0 ? `+ ${fmtMoney(pk.esimFee)} لكود eSIM QR` : 'كود eSIM QR مجاناً')
      : null;

  return `
    <article class="esim-card ${pk.featured ? 'is-featured' : ''} ${hasEsim ? 'has-esim' : ''}" style="--co:${esc(coColor)}">
      <!-- Top Carrier & SIM Chip Header -->
      <div class="esim-card-head">
        <div class="esim-card-carrier">
          ${companyLogo(co, 'sm')}
          <div class="esim-card-titles">
            <span class="esim-carrier-label">${esc(co?.name || '')}</span>
            <h3 class="esim-plan-title">${esc(pk.name)}</h3>
          </div>
        </div>
        <div class="esim-card-emblem" title="${hasEsim ? 'تدعم شريحة eSIM الرقمية وكود QR' : 'شحن وتفعيل فوري'}">
          ${hasEsim ? `
            ${esimChipSvg('esim-chip-svg')}
            <span class="esim-chip-tag">eSIM QR</span>
          ` : `
            ${simCardSvg('esim-sim-svg')}
            <span class="esim-sim-tag">${pk.kind === 'line' ? 'خط جديد' : 'شحن رقم'}</span>
          `}
        </div>
      </div>

      ${pk.featured || hasDiscount ? `
        <div class="esim-card-flags">
          ${pk.featured ? `<span class="esim-flag featured">${icon('checkCircle')}<span>الأكثر طلباً</span></span>` : ''}
          ${hasDiscount ? `<span class="esim-flag discount">وفّر ${savePct}%</span>` : ''}
        </div>
      ` : ''}

      <!-- Airalo-Style Structured Specification Rows -->
      <div class="esim-spec-box">
        <div class="esim-spec-row highlight">
          <span class="esim-spec-k">${icon('globe')}<span>حجم البيانات</span></span>
          <strong class="esim-spec-v ltr">${gbVal > 0 ? `${fmtNum(gbVal)} GB` : 'حسب الباقة'}</strong>
        </div>
        ${gbVal > 0 ? `<div class="esim-gb-meter" aria-hidden="true"><span style="width:${gbPct}%"></span></div>` : ''}

        <div class="esim-spec-row">
          <span class="esim-spec-k">${icon('clock')}<span>الصلاحية</span></span>
          <strong class="esim-spec-v">${daysVal > 0 ? `${fmtNum(daysVal)} يوم` : 'شهرية'}</strong>
        </div>

        <div class="esim-spec-row">
          <span class="esim-spec-k">${icon('phone')}<span>المكالمات</span></span>
          <strong class="esim-spec-v">${esc(callsLabel)}</strong>
        </div>

        ${hasEsim ? `
          <div class="esim-spec-row esim-qr-row">
            <span class="esim-spec-k">${icon('qr')}<span>شريحة eSIM</span></span>
            <strong class="esim-spec-v">${esc(qrFeeText)}</strong>
          </div>
        ` : ''}
      </div>

      ${pk.description ? `<p class="esim-plan-desc">${esc(pk.description)}</p>` : ''}

      <!-- Price & Action Footer -->
      <div class="esim-card-foot">
        <div class="esim-price-block">
          <span class="esim-price-label">
            سعر الباقة
            ${perDay ? `<small class="esim-daily-hint">(≈ ${perDay} ₪ / يوم)</small>` : ''}
          </span>
          <div class="esim-price-val">
            ${hasDiscount ? `<s>${fmtMoney(pk.oldPrice)}</s>` : ''}
            <b>${fmtMoney(pk.price)}</b>
          </div>
        </div>

        <div class="esim-card-btns">
          ${pk.kind === 'card' && pk.esim ? `
            <a href="#/buy/${pk.id}" class="btn ghost btn-sm">شحن رقم</a>
            <a href="#/buy/${pk.id}?esim=1" class="btn primary btn-sm">${icon('qr')}<span>تفعيل eSIM</span></a>
          ` : `
            <a href="#/buy/${pk.id}" class="btn primary">${icon(hasEsim ? 'qr' : 'arrowRight')}<span>${isDirectEsim ? 'تفعيل شريحة eSIM الآن' : 'اختيار الباقة'}</span></a>
          `}
        </div>
      </div>
    </article>
  `;
}

function viewBuy(id, forceEsim = false) {
  const pk = S.data.packages.find((p) => String(p.id) === String(id));
  if (!pk) { location.hash = '#/'; return; }
  const co = S.data.companies.find((c) => c.id === pk.companyId);
  if (pk.kind === 'esim') {
    S.wantEsim = true;
    return esimForm(pk, co);
  }
  const isCard = pk.kind === 'card';
  const canEsim = isCard && pk.esim;
  const wantEsim = canEsim && S.wantEsim;
  const qrFee = Number(pk.esimFee || 0);
  const total = Number(pk.price || 0) + (wantEsim ? qrFee : 0);

  shell(`
    <form id="buy-f" class="card shop-form" style="--co:${esc(co?.color || '#2563eb')}">
      <div class="row between">
        <a href="#/" class="btn ghost btn-sm">→ العودة للباقات</a>
        <button type="button" class="esim-compat-pill" data-act="compat">
          ${icon('chip')}<span>فحص توافق الجهاز مع eSIM</span>
        </button>
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
          ${wantEsim ? esimChipSvg('esim-chip-svg') : ''}
        </div>
        ${pk.description ? `<p class="muted" style="margin:8px 0 0;font-size:.88rem">${esc(pk.description)}</p>` : ''}
      </div>

      ${canEsim ? `
        <div class="field">
          <label>اختر طريقة التفعيل المطلوبة</label>
          <div class="shop-mode-cards" role="radiogroup" aria-label="طريقة التفعيل">
            <button type="button" class="shop-mode-card" data-esim="0" aria-pressed="${!wantEsim}">
              <div class="row between">
                ${icon('refresh')}
                <span class="mono">${fmtMoney(pk.price)}</span>
              </div>
              <b>شحن وتجديد رقمي الحالي</b>
              <small>شحن الباقة مباشرة على شريحتك الحالية دون تغييرها</small>
            </button>
            <button type="button" class="shop-mode-card" data-esim="1" aria-pressed="${wantEsim}">
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
        <input id="f-name" name="customerName" required autocomplete="name" placeholder="الاسم كما سيظهر في الطلب">
      </div>

      <div class="field">
        <label for="f-phone">${isCard ? (wantEsim ? 'رقم الهاتف المراد تحويله إلى eSIM وشحنه' : 'رقم الهاتف المراد شحنه بالباقة') : 'رقم للتواصل عبر واتساب أو اتصال'}</label>
        <input id="f-phone" name="phone" class="ltr" inputmode="tel" autocomplete="tel" required placeholder="059XXXXXXX">
      </div>

      ${wantEsim ? `
        <div class="field">
          <label for="f-email">البريد الإلكتروني <span class="muted">(اختياري — لإرسال نسخة من كود QR لبريدك)</span></label>
          <input id="f-email" name="email" type="email" class="ltr" autocomplete="email" placeholder="you@example.com">
        </div>
      ` : ''}

      <div class="field">
        <label for="f-notes">ملاحظات إضافية <span class="muted">(اختياري)</span></label>
        <input id="f-notes" name="notes" placeholder="أي تفصيل إضافي تودّ إبلاغنا به">
      </div>

      <!-- Transparent Price Breakdown -->
      <div class="shop-breakdown-box">
        <h4>${icon('shield')}<span>ملخص السعر الشامل</span></h4>
        <div class="shop-bd-row">
          <span>سعر الباقة (${esc(pk.name)})</span>
          <b class="mono">${fmtMoney(pk.price)}</b>
        </div>
        ${wantEsim ? `
          <div class="shop-bd-row">
            <span>رسوم إصدار كود eSIM QR (${esc(co?.name || '')})</span>
            <b class="mono">${qrFee > 0 ? fmtMoney(qrFee) : 'مجاناً'}</b>
          </div>
        ` : ''}
        <div class="shop-bd-total">
          <span>المبلغ الإجمالي النهائي</span>
          <b class="mono">${fmtMoney(total)}</b>
        </div>
      </div>

      <!-- Legal Consent (Button separated from label so clicking never toggles checkbox) -->
      <div class="esim-consent-wrap">
        <label class="esim-consent-label">
          <input type="checkbox" name="consent" required>
          <span>أقرّ بصحة الرقم المدخل وبموافقتي على شروط التفعيل${wantEsim ? ' وتوافق جهازي مع تقنية eSIM' : ''}.</span>
        </label>
        <button type="button" class="link-btn" data-act="legal">عرض الشروط والضمان</button>
      </div>

      <button class="btn primary lg" type="submit">
        ${icon(wantEsim ? 'qr' : 'checkCircle')}
        <span>تأكيد الطلب والمتابعة (${fmtMoney(total)})</span>
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
          customerName: fd.get('customerName'),
          phone: fd.get('phone'),
          email: fd.get('email') || '',
          esim: wantEsim,
          notes: fd.get('notes'),
        },
      });
      rememberOrderCode(order.code);
      S.myCodes = savedOrderCodes();
      S.myOrders = null;
      S.order = order;
      S.wantEsim = false;
      location.hash = `#/order/${order.code}`;
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  };
}

// Direct eSIM package checkout: reserves a free number & activates QR automatically or via instant activation button
async function esimForm(pk, co) {
  shell(`<div class="card empty"><p class="muted">جارٍ التحقق من توفّر شرائح eSIM للباقة...</p></div>`, { sub: pk.name });
  if (S.esimAvailable === null || S.esimAvailable.pkgId !== pk.id) {
    try {
      const r = await jfetch(`/api/shop/available?packageId=${encodeURIComponent(pk.id)}`);
      S.esimAvailable = { pkgId: pk.id, available: Boolean(r.available) };
    } catch (err) {
      toast(err.message, 'err');
      S.esimAvailable = { pkgId: pk.id, available: false };
    }
  }
  const available = S.esimAvailable.available;

  shell(`
    <form id="buy-f" class="card shop-form" style="--co:${esc(co?.color || '#2563eb')}">
      <div class="row between">
        <a href="#/" class="btn ghost btn-sm">→ العودة للباقات</a>
        <button type="button" class="esim-compat-pill" data-act="compat">
          ${icon('chip')}<span>فحص توافق الجهاز مع eSIM</span>
        </button>
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

      ${available ? `
        <div class="esim-ready-notice">
          ${icon('qr')}
          <div class="grow">
            <b>تفعيل رقمي مباشر مع كود QR فوري</b>
            <small class="muted" style="display:block">سيتم تخصيص رقم جديد وتوليد كود الـ QR الخاص بشريحتك ليظهر مباشرة على الشاشة ويرسل لبريدك الإلكتروني.</small>
          </div>
        </div>
      ` : `
        <div class="card empty">
          ${icon('alert')}
          <p>جميع أرقام eSIM لهذه الباقة محجوزة حالياً — يرجى المحاولة بعد قليل أو التواصل مع الدعم.</p>
        </div>
      `}

      <div class="field">
        <label for="f-name">الاسم الكامل</label>
        <input id="f-name" name="customerName" required autocomplete="name" placeholder="الاسم الثلاثي">
      </div>

      <div class="field">
        <label for="f-email">البريد الإلكتروني <span class="muted">(يُرسل إليه كود الـ QR أيضاً)</span></label>
        <input id="f-email" name="email" type="email" class="ltr" required autocomplete="email" placeholder="you@example.com">
      </div>

      <div class="field">
        <label for="f-contact">رقم واتساب للتواصل <span class="muted">(اختياري)</span></label>
        <input id="f-contact" name="contactPhone" class="ltr" inputmode="tel" autocomplete="tel" placeholder="059XXXXXXX">
      </div>

      <div class="shop-breakdown-box">
        <h4>${icon('shield')}<span>ملخص السعر الشامل</span></h4>
        <div class="shop-bd-row">
          <span>باقة وشريحة eSIM (${esc(pk.name)})</span>
          <b class="mono">${fmtMoney(pk.price)}</b>
        </div>
        <div class="shop-bd-row">
          <span>إصدار كود eSIM QR وتخصيص الرقم</span>
          <b class="mono">مشمول بالسعر</b>
        </div>
        <div class="shop-bd-total">
          <span>المبلغ الإجمالي النهائي</span>
          <b class="mono">${fmtMoney(pk.price)}</b>
        </div>
      </div>

      <div class="esim-consent-wrap">
        <label class="esim-consent-label">
          <input type="checkbox" name="consent" required>
          <span>أؤكد أن هاتفي يدعم شريحة eSIM ومفتوح الشبكة وأوافق على شروط التفعيل.</span>
        </label>
        <button type="button" class="link-btn" data-act="legal" data-tab="esim">سياسة eSIM والضمان</button>
      </div>

      <button class="btn primary lg" type="submit" ${available ? '' : 'disabled'}>
        ${icon('qr')}
        <span>تفعيل شريحة eSIM وإصدار كود QR (${fmtMoney(pk.price)})</span>
      </button>
    </form>
  `, { sub: pk.name });

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
          customerName: fd.get('customerName'),
          email: fd.get('email'),
          contactPhone: fd.get('contactPhone') || '',
          esim: true,
        },
      });
      S.esimAvailable = null;
      rememberOrderCode(order.code);
      S.myCodes = savedOrderCodes();
      S.myOrders = null;
      S.order = order;
      location.hash = `#/order/${order.code}`;
    } catch (err) {
      toast(err.message, 'err');
      S.esimAvailable = null;
      btn.disabled = false;
    }
  };
}

const STATUS_AR = {
  pending: { label: 'بانتظار الدفع أو التفعيل', cls: 's-open', step: 1 },
  paid: { label: 'تم استلام الدفع — جارٍ التفعيل وإصدار الشريحة…', cls: 's-open', step: 2 },
  review: { label: 'قيد المراجعة والتفعيل من فريق المتجر', cls: 's-open', step: 2 },
  done: { label: 'مفعّل وجاهز للاستخدام', cls: 's-done', step: 3 },
  rejected: { label: 'مرفوض — تواصل مع الدعم', cls: 's-bad', step: 0 },
};

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
        <a href="#/" class="btn primary">العودة للمتجر</a>
      </div>`);
    return;
  }
  renderOrder();
  if (S.order.status === 'pending' || S.order.status === 'paid' || S.order.status === 'review') {
    S.pollTimer = setInterval(async () => {
      try {
        const next = await jfetch(`/api/shop/orders/${encodeURIComponent(code)}`);
        if (next.status !== S.order.status || next.proofSent !== S.order.proofSent || next.qrReady !== S.order.qrReady) {
          S.order = next;
          renderOrder();
          if (next.status === 'done' || next.status === 'rejected') clearInterval(S.pollTimer);
        }
      } catch {}
    }, 5000);
  }
}

function renderOrder() {
  const o = S.order;
  const st = STATUS_AR[o.status] || STATUS_AR.pending;
  const payPhone = S.data?.payPhone || '';
  const isEsim = Boolean(o.esim);
  const working = o.status === 'paid' || (o.status === 'pending' && o.proofSent);
  const wa = supportHref(S.data?.supportWhatsapp, `مرحباً، بخصوص الطلب ${o.code}`);

  shell(`
    <!-- Order Summary Card -->
    <div class="card shop-status">
      <div class="row between no-print">
        <a href="#/" class="btn ghost btn-sm">← المتجر</a>
        <div class="row" style="gap:6px">
          <button type="button" class="btn ghost btn-sm" id="copy-code">${icon('copy')}<span class="ltr">${esc(o.code)}</span></button>
          <button type="button" class="btn ghost btn-sm" id="print-order">${icon(' list' in {} ? 'list' : 'file') || ''}${icon('check')}<span>طباعة الإيصال</span></button>
        </div>
      </div>

      <div class="shop-steps no-print" aria-label="مراحل الطلب">
        <span class="${st.step >= 1 ? 'done' : ''}"><i>1</i>إنشاء الطلب</span>
        <span class="${st.step >= 2 ? 'done' : st.step === 1 && o.proofSent ? 'current' : ''}"><i>2</i>تأكيد الدفع والتفعيل</span>
        <span class="${st.step >= 3 ? 'done' : ''}"><i>3</i>${isEsim ? 'استلام كود eSIM QR' : 'اكتمال التفعيل'}</span>
      </div>

      <div class="row between" style="flex-wrap:wrap;gap:10px">
        <div class="row" style="gap:10px">
          ${companyLogo({ name: o.companyName, color: o.companyColor })}
          <div>
            <span class="esim-carrier-label">${esc(o.companyName || '')}</span>
            <h3 style="margin:2px 0">${esc(o.packageName)}</h3>
            <small class="muted">${esc(o.customerName)} · <span class="ltr">${esc(o.phone ? fmtPhone(o.phone) : o.email || '')}</span></small>
          </div>
        </div>
        <b class="mono shop-amount">${fmtMoney(o.amount)}</b>
      </div>

      ${isEsim ? `
        <div class="shop-breakdown-box">
          <div class="shop-bd-row">
            <span>سعر الباقة الأساسي</span>
            <b class="mono">${fmtMoney(o.basePrice ?? o.amount)}</b>
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
      ${o.note ? `<p class="muted" style="margin:0">${esc(o.note)}</p>` : ''}
    </div>

    <!-- Direct Instant eSIM Activation Action (when available and QR not yet issued) -->
    ${!o.qrReady && o.canInstantActivate && o.status !== 'rejected' ? `
      <div class="card shop-instant-box no-print">
        <div class="row" style="gap:12px">
          ${esimChipSvg('esim-chip-svg')}
          <div>
            <h3 style="margin:0 0 4px">التفعيل المباشر لشريحة eSIM متاح الآن</h3>
            <p class="muted" style="margin:0;font-size:.88rem">اضغط على زر التفعيل الفوري لإصدار شريحة الـ eSIM من النظام وإظهار كود الـ QR الجاهز للمسح مباشرة على هذه الشاشة.</p>
          </div>
        </div>
        <button type="button" class="btn primary lg" id="instant-act-btn" ${S.instantBusy ? 'disabled' : ''}>
          ${icon('qr')}
          <span>${S.instantBusy ? 'جارٍ التفعيل وتوليد كود QR...' : 'تفعيل فوري وإظهار كود QR الآن'}</span>
        </button>
      </div>
    ` : ''}

    <!-- Scannable eSIM QR Code Pass (shown immediately once qrReady is true) -->
    ${o.qrReady && o.qrImage ? `
      <div class="card shop-qr-modern">
        <div class="shop-qr-badge">
          ${icon('checkCircle')}
          <span>شريحة eSIM مفعّلة وجاهزة للمسح الفوري</span>
        </div>

        <h3 style="margin:0">امسح كود الـ QR لتثبيت شريحة eSIM على هاتفك</h3>
        <p class="muted" style="margin:0">
          تأكد من اتصال هاتفك بالـ Wi-Fi، ثم افتح الكاميرا أو إعدادات الخليوي وامسح الكود التالي:
        </p>

        <div class="shop-qr-frame">
          <img id="qr-img" src="${esc(o.qrImage)}" alt="كود QR لتفعيل شريحة eSIM">
        </div>

        <div class="esim-qr-details">
          ${o.phone ? `
            <div class="shop-kv">
              <span>رقم الخط المخصّص</span>
              <b class="ltr mono">${esc(fmtPhone(o.phone))}</b>
              <button type="button" class="btn ghost btn-sm no-print" data-copy="${esc(o.phone)}">${icon('copy')}<span>نسخ</span></button>
            </div>
          ` : ''}
          ${o.simNumber ? `
            <div class="shop-kv">
              <span>الرقم التسلسلي ICCID</span>
              <b class="ltr mono">${esc(o.simNumber)}</b>
              <button type="button" class="btn ghost btn-sm no-print" data-copy="${esc(o.simNumber)}">${icon('copy')}<span>نسخ</span></button>
            </div>
          ` : ''}
        </div>

        ${o.qrCode ? `
          <div class="shop-lpa-box no-print">
            <small class="muted">كود التفعيل اليدوي (LPA / Activation Code) في حال التثبيت من نفس الجهاز:</small>
            <div class="shop-lpa-row">
              <code class="ltr">${esc(o.qrCode)}</code>
              <button type="button" class="btn ghost btn-sm" data-copy="${esc(o.qrCode)}">${icon('copy')}<span>نسخ الكود</span></button>
            </div>
          </div>
        ` : ''}

        <div class="row no-print" style="justify-content:center;gap:10px;flex-wrap:wrap">
          <a class="btn primary" href="${esc(o.qrImage)}" download="${esc(o.code)}-esim-qr.png">
            ${icon('qr')}<span>تحميل صورة كود QR</span>
          </a>
          <button type="button" class="btn ghost" id="print-qr-btn">
            ${icon('check')}<span>طباعة بطاقة الشريحة</span>
          </button>
        </div>

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

    ${working && !o.qrReady ? `
      <div class="card empty">
        <div class="tile pulse">${icon('clock')}</div>
        <p>${o.status === 'paid'
          ? (isEsim ? 'تم تأكيد الدفع — جارٍ تفعيل الشريحة وتوليد كود eSIM QR، ستتحدّث هذه الصفحة تلقائياً خلال لحظات…' : 'تم تأكيد الدفع — جارٍ تفعيل باقتك لدى شركة الاتصالات، ستتحدّث الصفحة تلقائياً…')
          : 'وصلنا إشعار الدفع — يتحقّق النظام تلقائياً من الحوالة ويُفعّل طلبك فور المطابقة.'}</p>
      </div>
    ` : ''}

    ${o.status === 'pending' ? `
      <div class="card shop-pay no-print">
        <h3>الدفع عبر محفظة جوال باي (Jawwal Pay)</h3>
        <p class="muted" style="margin:0">حوّل المبلغ المحدّد بالضبط من تطبيق <b>Jawwal Pay</b> إلى رقم المحفظة التالي، ثم ارفع صورة الإيصال أو أدخل رقم محفظتك للتفعيل التلقائي:</p>
        <div class="shop-kv">
          <span>رقم المحفظة المستلمة</span>
          <b class="ltr mono">${esc(payPhone || 'غير مضبوط بعد')}</b>
          ${payPhone ? `<button type="button" class="btn ghost btn-sm" id="copy-pay">${icon('copy')}<span>نسخ</span></button>` : ''}
        </div>
        <div class="shop-kv">
          <span>المبلغ المطلوب</span>
          <b class="mono">${fmtMoney(o.amount)}</b>
        </div>
        <div class="shop-kv">
          <span>بيان الحوالة (اختياري)</span>
          <b class="ltr mono">${esc(o.code)}</b>
        </div>

        <form id="proof-f" class="form" style="margin-top:8px">
          <div class="field">
            <label for="f-payer">رقم محفظة Jawwal Pay التي حوّلت منها</label>
            <input id="f-payer" name="payerPhone" class="ltr" inputmode="tel" value="${esc(o.payerPhone || o.phone)}" placeholder="059XXXXXXX">
          </div>
          <div class="field">
            <label>صورة إشعار التحويل <span class="muted">(تُسرّع المطابقة التلقائية)</span></label>
            <label class="upload-box" id="proof-box">
              <input id="f-proof" type="file" accept="image/*" hidden>
              ${icon('upload')}
              <span id="proof-label">${o.proofSent ? 'تم إرسال الإشعار — اضغط لاستبداله' : 'اضغط لاختيار لقطة شاشة لإشعار Jawwal Pay'}</span>
            </label>
          </div>
          <button class="btn primary lg" type="submit">${icon('check')}<span>${o.proofSent ? 'تحديث إشعار الدفع' : 'أرسلت المبلغ — تأكيد وتفعيل الطلب'}</span></button>
        </form>
      </div>
    ` : ''}

    ${o.status === 'done' && !o.qrImage ? `
      <div class="card empty">
        ${icon('checkCircle')}
        <p>تمّ تفعيل باقتك بنجاح — شكراً لثقتك بنا.</p>
        <a href="#/" class="btn ghost">العودة للمتجر</a>
      </div>
    ` : ''}

    ${wa ? `<a class="btn ghost no-print" style="justify-self:center" href="${esc(wa)}" target="_blank" rel="noopener">${icon('whatsapp')}<span>تواصل مع الدعم بخصوص هذا الطلب</span></a>` : ''}
  `, { sub: `طلب ${o.code}` });

  const copyCode = document.getElementById('copy-code');
  if (copyCode) copyCode.onclick = () => copyText(o.code, 'تم نسخ رقم الطلب');
  const printBtn = document.getElementById('print-order');
  if (printBtn) printBtn.onclick = () => window.print();
  const printQrBtn = document.getElementById('print-qr-btn');
  if (printQrBtn) printQrBtn.onclick = () => window.print();
  const copyPay = document.getElementById('copy-pay');
  if (copyPay) copyPay.onclick = () => copyText(payPhone, 'تم نسخ رقم المحفظة');

  root.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => copyText(b.dataset.copy, 'تم النسخ');
  });

  const instantBtn = document.getElementById('instant-act-btn');
  if (instantBtn) {
    instantBtn.onclick = async () => {
      if (S.instantBusy) return;
      S.instantBusy = true;
      renderOrder();
      try {
        S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}/instant`, { method: 'POST' });
        toast('تم تفعيل شريحة eSIM وإصدار كود الـ QR بنجاح');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        S.instantBusy = false;
        renderOrder();
      }
    };
  }

  const fileInput = document.getElementById('f-proof');
  let proofData = null;
  if (fileInput) {
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        proofData = await fileToDataUrl(file);
        document.getElementById('proof-label').textContent = `تم إرفاق: ${file.name}`;
      } catch (err) { toast(err.message, 'err'); }
    };
  }
  const pf = document.getElementById('proof-f');
  if (pf) {
    pf.onsubmit = async (e) => {
      e.preventDefault();
      const btn = pf.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}/proof`, {
          method: 'POST',
          body: { payerPhone: new FormData(pf).get('payerPhone'), proofImage: proofData },
        });
        toast('تم استلام إشعار الدفع — جارٍ التحقّق والتفعيل التلقائي');
        renderOrder();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    };
  }
}

async function viewMyOrders() {
  clearInterval(S.pollTimer);
  const codes = S.myCodes;
  if (!codes.length) { location.hash = '#/'; return; }
  if (!S.myOrders) {
    const results = await Promise.all(codes.map((c) => jfetch(`/api/shop/orders/${encodeURIComponent(c)}`).catch(() => null)));
    S.myOrders = results.filter(Boolean);
  }
  shell(`
    <div class="row between">
      <h2 style="margin:0">طلباتي السابقة على هذا الجهاز</h2>
      <a href="#/" class="btn ghost btn-sm">← العودة للمتجر</a>
    </div>
    ${S.myOrders.length ? `
      <div class="list">
        ${S.myOrders.map((o) => {
          const st = STATUS_AR[o.status] || STATUS_AR.pending;
          return `
            <a href="#/order/${esc(o.code)}" class="item" style="text-decoration:none;color:inherit">
              <div class="item-top">
                <div class="row" style="gap:10px">
                  ${companyLogo({ name: o.companyName, color: o.companyColor }, 'sm')}
                  <div>
                    <div class="item-title">
                      ${esc(o.packageName)}
                      ${o.esim ? `<span class="pill" style="margin-inline-start:6px">eSIM QR</span>` : ''}
                    </div>
                    <div class="item-sub">
                      <span class="ltr mono">${esc(o.code)}</span> · <span class="ltr">${esc(fmtPhone(o.phone))}</span> · ${fmtDate(o.createdAt)}
                    </div>
                  </div>
                </div>
                <div style="text-align:end">
                  <b class="mono">${fmtMoney(o.amount)}</b>
                  <div><span class="pill ${st.cls}">${esc(st.label)}</span></div>
                </div>
              </div>
            </a>`;
        }).join('')}
      </div>
    ` : `<div class="card empty">${icon('list')}<p>لم يُعثر على طلبات محفوظة</p></div>`}
  `, { sub: 'طلباتي' });
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

  if (head === 'buy' && arg) {
    if (params.get('esim') === '1') S.wantEsim = true;
    else if (!queryPart) S.wantEsim = false;
    return viewBuy(arg);
  }
  if (head === 'order' && arg) return viewOrder(decodeURIComponent(arg));
  if (head === 'orders') { S.myOrders = null; return viewMyOrders(); }
  viewCatalog();
}

window.addEventListener('hashchange', route);
route();
