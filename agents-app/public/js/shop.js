// Customer Storefront (/shop): Authentic eSIM & Telecom Plan Storefront.
// Uses ES module imports from ./core.js and sheet() modals — zero emojis, crisp vector SVGs.
import {
  esc, icon, fmtMoney, fmtNum, fmtDateTime, fmtDate, fmtTime, specs, companyLogo,
  fileToDataUrl, copyText, toast, supportHref, fmtPhone, sheet, closeSheet,
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

function pkgGb(pk) {
  return Number(pk?.dataGb ?? pk?.gb ?? 0) || 0;
}

function isFeaturedPkg(pk) {
  return Boolean(pk?.popular || pk?.featured);
}

function shell(body, { sub = '' } = {}) {
  const name = S.data?.shopTitle || (S.data?.appName ? `متجر ${S.data.appName}` : 'متجر الشرائح والباقات');
  const subtitle = sub || S.data?.shopSubtitle || 'متجر الشرائح الإلكترونية eSIM والباقات الفورية';
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
            <small><span class="shop-live-dot"></span>${esc(subtitle)}</small>
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
    subtitle: 'أدخل رمز الطلب للاطلاع على حالة التفعيل أو عرض كود eSIM QR الخاص بك',
    body: `
      <form id="track-f" class="form">
        <div class="field">
          <label for="f-code">رمز الطلب</label>
          <input id="f-code" name="code" class="ltr" required placeholder="مثال: AB12CD34" autocomplete="off">
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
            <li><b>إيصال الطلب:</b> يحصل كل طلب على رمز تتبّع فريد يمكّنك من متابعة حالة التفعيل وتحميل كود QR في أي وقت.</li>
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
            <li><b>حفظ كود QR في صفحة طلبك:</b> في حال أغلقت الصفحة بعد التفعيل، يظل كود الـ QR ومعلومات الشريحة محفوظين في صفحة تتبّع الطلب الخاصة بك.</li>
            <li><b>دعم فني مباشر:</b> فريق الدعم متواجد لمساعدتك خطوة بخطوة في تثبيت شريحة eSIM أو متابعة أي طلب عبر واتساب مع ذكر رمز الطلب.</li>
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
    <!-- Authentic eSIM & Telecom Hero -->
    <section class="esim-hero">
      <div class="esim-hero-grid">
        <div class="esim-hero-copy">
          <div class="esim-hero-kicker">
            ${icon('qr')}
            <span>الجيل الرقمي من شرائح الاتصال · eSIM & Telecom Store</span>
          </div>
          <h1>${esc(S.data.shopTitle || 'باقات الخليوي وشرائح eSIM الفورية بكود QR مباشر')}</h1>
          <p>
            ${esc(S.data.shopSubtitle || 'اختر شبكتك وباقتك المفضّلة، فعّل شريحة eSIM واستلم كود الـ QR الجاهز للمسح فوراً على شاشتك، أو اشحن رقمك الحالي خلال ثوانٍ بأسعار واضحة وشاملة.')}
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
    ? (qrFee > 0 ? `+ ${fmtMoney(qrFee)} لكود eSIM QR` : 'كود eSIM QR مشمول مجاناً')
    : null;

  return `
    <article class="esim-card ${featured ? 'is-featured' : ''} ${hasEsim ? 'has-esim' : ''}" style="--co:${esc(coColor)}">
      <!-- Top Carrier & SIM Chip Header -->
      <div class="esim-card-head">
        <div class="esim-card-carrier">
          ${companyLogo(co || { name: pk.companyName }, 'sm')}
          <div class="esim-card-titles">
            <span class="esim-carrier-label">${esc(co?.name || pk.companyName || '')}</span>
            <h3 class="esim-plan-title">${esc(pk.name)}</h3>
          </div>
        </div>
        <div class="esim-card-emblem" title="${hasEsim ? 'تدعم شريحة eSIM الرقمية وكود QR' : 'شحن وتفعيل فوري'}">
          ${hasEsim ? `
            ${esimChipSvg('esim-chip-svg')}
            <span class="esim-chip-tag">eSIM QR</span>
          ` : `
            ${simCardSvg('esim-sim-svg')}
            <span class="esim-sim-tag">${pk.kind === 'card' ? 'شحن رقم' : 'باقة خط'}</span>
          `}
        </div>
      </div>

      ${featured || hasDiscount || pk.tag ? `
        <div class="esim-card-flags">
          ${featured ? `<span class="esim-flag featured">${icon('checkCircle')}<span>الأكثر طلباً</span></span>` : ''}
          ${hasDiscount ? `<span class="esim-flag discount">وفّر ${savePct}%</span>` : ''}
          ${pk.tag && !featured ? `<span class="esim-flag featured">${esc(pk.tag)}</span>` : ''}
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
          <span class="esim-spec-k">${icon('phone')}<span>المزايا والمكالمات</span></span>
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
          ${pk.kind === 'card' && hasEsim ? `
            <a href="#/buy/${pk.id}" class="btn ghost btn-sm">شحن رقم</a>
            <a href="#/buy/${pk.id}?esim=1" class="btn primary btn-sm">${icon('qr')}<span>تفعيل eSIM</span></a>
          ` : hasEsim ? `
            <a href="#/buy/${pk.id}?esim=1" class="btn primary">${icon('qr')}<span>تفعيل شريحة eSIM الآن</span></a>
          ` : `
            <a href="#/buy/${pk.id}" class="btn primary">${icon('arrowRight')}<span>اختيار الباقة</span></a>
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
      <div class="row between">
        <a href="#/" class="btn ghost btn-sm">→ العودة للباقات</a>
        ${canEsim ? `
          <button type="button" class="esim-compat-pill" data-act="compat">
            ${icon('chip')}<span>فحص توافق الجهاز مع eSIM</span>
          </button>` : ''}
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
        <input id="f-name" name="customerName" required autocomplete="name" placeholder="الاسم كما سيظهر في الطلب">
      </div>

      <div class="field">
        <label for="f-phone">${isCard ? 'رقم الهاتف المراد شحنه بالباقة' : 'رقم الهاتف'}</label>
        <input id="f-phone" name="number" class="ltr" inputmode="tel" autocomplete="tel" required placeholder="059XXXXXXX">
      </div>

      ${!isCard ? `
        <div class="field">
          <label for="f-sim">رقم الشريحة ICCID (19 رقماً)</label>
          <input id="f-sim" name="sim" class="ltr" inputmode="numeric" required placeholder="89970...">
        </div>
      ` : ''}

      <div class="field">
        <label for="f-contact">رقم للتواصل عبر واتساب <span class="muted">(اختياري)</span></label>
        <input id="f-contact" name="contactPhone" class="ltr" inputmode="tel" autocomplete="tel" placeholder="059XXXXXXX">
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
        <button type="button" class="link-btn" data-act="legal">عرض الشروط والضمان</button>
      </div>

      <button class="btn primary lg" type="submit">
        ${icon('checkCircle')}
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
          kind: isCard ? 'recharge' : 'new',
          customerName: fd.get('customerName'),
          number: fd.get('number'),
          sim: fd.get('sim') || '',
          contactPhone: fd.get('contactPhone') || '',
          instant: Boolean(S.data?.instant),
        },
      });
      rememberOrderCode(order.code);
      S.myCodes = savedOrderCodes();
      S.myOrders = null;
      S.order = order;
      location.hash = `#/order/${order.code}`;
    } catch (err) {
      toast(err.message, 'err');
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
            <b>تفعيل رقمي مباشر مع كود QR فوري</b>
            <small class="muted" style="display:block">يُخصَّص لك رقم جديد تلقائياً ويتم توليد كود الـ QR الخاص بشريحتك ليظهر مباشرة على الشاشة بعد التفعيل.</small>
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
        <input id="f-name" name="customerName" required autocomplete="name" placeholder="الاسم الثلاثي لتسجيل الخط">
      </div>

      <div class="field">
        <label for="f-email">البريد الإلكتروني <span class="muted">(مستحسن — نرسل لك عليه نسخة من كود الـ QR أيضاً)</span></label>
        <input id="f-email" name="email" type="email" class="ltr" autocomplete="email" placeholder="you@example.com">
      </div>

      <div class="field">
        <label for="f-contact">رقم للتواصل عبر واتساب <span class="muted">(اختياري)</span></label>
        <input id="f-contact" name="contactPhone" class="ltr" inputmode="tel" autocomplete="tel" placeholder="059XXXXXXX">
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
        <button type="button" class="link-btn" data-act="legal" data-tab="esim">سياسة eSIM والضمان</button>
      </div>

      <button class="btn primary lg" type="submit" ${available ? '' : 'disabled'}>
        ${icon('qr')}
        <span>تفعيل شريحة eSIM وإصدار كود QR (${fmtMoney(total)})</span>
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
          instant: Boolean(S.data?.instant),
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
      toast(err.message, 'err');
      S.esimAvailable = null;
      btn.disabled = false;
    }
  };
}

const STAGES_AR = {
  awaiting_payment: { label: 'بانتظار الدفع أو التفعيل الفوري', cls: 's-open', step: 1, desc: 'حوّل المبلغ عبر تطبيق جوال باي ثم أكّد التحويل أدناه، أو استخدم زر التفعيل الفوري إن كان مفعّلاً.' },
  verifying: { label: 'جارٍ التحقق التلقائي من التحويل…', cls: 's-open', step: 2, desc: 'يبحث النظام عن إشعار جوال باي المطابق لتفعيل خطك وإصدار كود QR تلقائياً.' },
  review: { label: 'قيد المراجعة والتفعيل من فريق المتجر', cls: 's-open', step: 2, desc: 'يراجع فريق المتجر إشعار التحويل لتفعيل طلبك في أسرع وقت.' },
  processing: { label: 'تم استلام الدفع — جارٍ التفعيل وإصدار الشريحة…', cls: 's-open', step: 2, desc: 'وصلنا المبلغ ونفعّل خطك الآن لدى شركة الاتصالات. سيظهر رمز QR هنا فور جهوزه.' },
  paid_issue: { label: 'تم استلام الدفع — قيد المعالجة الفنية', cls: 's-open', step: 2, desc: 'وصلنا المبلغ ويتابع فريقنا إتمام التفعيل.' },
  done: { label: 'مفعّل وجاهز للاستخدام', cls: 's-done', step: 3, desc: 'تم تفعيل طلبك بنجاح.' },
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
        <a href="#/" class="btn primary">العودة للمتجر</a>
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
  const canInstant = Boolean(S.data?.instant && payable && !hasQr);
  const wa = supportHref(S.data?.supportWhatsapp, `مرحباً، بخصوص الطلب ${o.code}`);

  shell(`
    <!-- Order Summary Card -->
    <div class="card shop-status">
      <div class="row between no-print">
        <a href="#/" class="btn ghost btn-sm">← المتجر</a>
        <div class="row" style="gap:6px">
          <button type="button" class="btn ghost btn-sm" id="copy-code">${icon('copy')}<span class="ltr">${esc(o.code)}</span></button>
          <button type="button" class="btn ghost btn-sm" id="print-order">${icon('check')}<span>طباعة الإيصال</span></button>
        </div>
      </div>

      <div class="shop-steps no-print" aria-label="مراحل الطلب">
        <span class="${st.step >= 1 ? 'done' : ''}"><i>1</i>إنشاء الطلب</span>
        <span class="${st.step >= 2 ? 'done' : st.step === 1 && o.proofSent ? 'current' : ''}"><i>2</i>تأكيد الدفع والتفعيل</span>
        <span class="${st.step >= 3 || hasQr ? 'done' : ''}"><i>3</i>${isEsim ? 'استلام كود eSIM QR' : 'اكتمال التفعيل'}</span>
      </div>

      <div class="row between" style="flex-wrap:wrap;gap:10px">
        <div class="row" style="gap:10px">
          <span class="shop-brand-mark">${icon(isEsim ? 'qr' : 'sim')}</span>
          <div>
            <span class="esim-carrier-label">رمز الطلب: <b class="ltr mono">${esc(o.code)}</b></span>
            <h3 style="margin:2px 0">${esc(o.packageLabel)}${isEsim ? ' · eSIM' : ''}</h3>
            <small class="muted">${esc(o.customerName || '')} · ${o.number ? `<span class="ltr">${esc(fmtPhone(o.number))}</span>` : 'يظهر الرقم فور تأكيد التفعيل'}</small>
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

    <!-- Direct Instant eSIM Activation Action (when shopInstant is enabled and QR not yet issued) -->
    ${canInstant ? `
      <div class="card shop-instant-box no-print">
        <div class="row" style="gap:12px">
          ${esimChipSvg('esim-chip-svg')}
          <div>
            <h3 style="margin:0 0 4px">التفعيل المباشر الفوري متاح الآن</h3>
            <p class="muted" style="margin:0;font-size:.88rem">اضغط على زر التفعيل الفوري لإصدار شريحة الـ eSIM وإظهار كود الـ QR الجاهز للمسح مباشرة على هذه الشاشة.</p>
          </div>
        </div>
        <button type="button" class="btn primary lg" id="instant-act-btn" ${S.instantBusy ? 'disabled' : ''}>
          ${icon('qr')}
          <span>${S.instantBusy ? 'جارٍ التفعيل وتوليد كود QR...' : 'تفعيل فوري وإظهار كود QR الآن'}</span>
        </button>
      </div>
    ` : ''}

    <!-- Scannable eSIM QR Code Pass (shown immediately once esimQr is ready) -->
    ${hasQr ? `
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
            ${icon('qr')}<span>تحميل صورة كود QR</span>
          </a>
          <button type="button" class="btn ghost" id="print-qr-btn">
            ${icon('check')}<span>طباعة بطاقة الشريحة</span>
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

    <!-- Jawwal Pay Payment & Verification Box -->
    ${payable ? `
      <div class="card shop-pay no-print">
        <h3>١. حوّل المبلغ عبر تطبيق جوال باي (Jawwal Pay)</h3>
        <p class="muted" style="margin:0">
          حوّل المبلغ المحدّد بالضبط بتحويل واحد إلى المحفظة التالية.${o.reservedUntil ? ` رقمك محجوز لك حتى <b>${fmtTime(o.reservedUntil)}</b>.` : ''}
        </p>
        <div class="shop-kv">
          <span>المبلغ المطلوب</span>
          <b class="ltr mono">${fmtMoney(o.amount)}</b>
          <button type="button" class="btn ghost btn-sm" data-copy="${esc(String(o.amount))}">${icon('copy')}<span>نسخ</span></button>
        </div>
        ${jp.number ? `
          <div class="shop-kv">
            <span>إلى رقم المحفظة</span>
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

        <hr style="border:0;border-top:1px solid var(--line);margin:6px 0">

        <h3>٢. ${o.proofSent ? 'تحديث بيانات التحويل' : 'أكّد التحويل للتفعيل التلقائي'}</h3>
        <p class="muted" style="margin:0;font-size:.85rem">
          أدخل <b>رقم الحركة</b> من رسالة جوال باي (أسرع طريقة للمطابقة الفورية)، أو اسم المحوِّل، أو ارفع صورة الإشعار:
        </p>

        <form id="proof-f" class="form" style="margin-top:6px">
          <div class="field">
            <label for="f-ref">رقم الحركة في جوال باي</label>
            <input id="f-ref" name="payReference" class="ltr" inputmode="numeric" autocomplete="off" placeholder="مثال: 2922...">
          </div>
          <div class="field">
            <label for="f-pname">أو: اسم المحوِّل كما يظهر في جوال باي</label>
            <input id="f-pname" name="payName" autocomplete="name" placeholder="الاسم الكامل">
          </div>
          <div class="field">
            <label for="f-payer">رقم محفظة جوال باي المحوَّل منها <span class="muted">(اختياري)</span></label>
            <input id="f-payer" name="payPhone" class="ltr" inputmode="tel" placeholder="059XXXXXXX">
          </div>
          <div class="field">
            <label>صورة إشعار التحويل <span class="muted">(اختياري — تساعد في تسريع المراجعة)</span></label>
            <label class="upload-box" id="proof-box">
              <input id="f-proof" type="file" accept="image/*" hidden>
              ${icon('upload')}
              <span id="proof-label">${o.proofSent ? 'تم إرسال الإشعار — اضغط لاستبداله' : 'اضغط لاختيار لقطة شاشة لإشعار Jawwal Pay'}</span>
            </label>
          </div>
          <button class="btn primary lg" type="submit">${icon('check')}<span>${o.proofSent ? 'تحديث بيانات التحويل' : 'أرسلت المبلغ — تأكيد وتفعيل الطلب'}</span></button>
        </form>
      </div>
    ` : ''}

    ${o.stage === 'done' && !hasQr ? `
      <div class="card empty">
        ${icon('checkCircle')}
        <p>تمّ تفعيل باقتك بنجاح — شكراً لثقتك بنا.</p>
        <a href="#/" class="btn ghost">العودة للمتجر</a>
      </div>
    ` : ''}

    ${wa ? `<a class="btn ghost no-print" style="justify-self:center" href="${esc(wa)}" target="_blank" rel="noopener">${icon('whatsapp')}<span>تواصل مع الدعم بخصوص هذا الطلب</span></a>` : ''}
  `, { sub: `طلب ${o.code}` });

  const copyCode = document.getElementById('copy-code');
  if (copyCode) copyCode.onclick = () => copyText(o.code, 'تم نسخ رمز الطلب');
  const printBtn = document.getElementById('print-order');
  if (printBtn) printBtn.onclick = () => window.print();
  const printQrBtn = document.getElementById('print-qr-btn');
  if (printQrBtn) printQrBtn.onclick = () => window.print();

  root.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => copyText(b.dataset.copy, 'تم النسخ');
  });

  const cancelBtn = document.getElementById('cancel-order-btn');
  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      try {
        S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}/cancel`, { method: 'POST' });
        toast('تم إلغاء الطلب');
        renderOrder();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }

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
  let proofData = '';
  if (fileInput) {
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        proofData = await fileToDataUrl(file, { max: 1400 });
        document.getElementById('proof-label').textContent = `تم إرفاق: ${file.name}`;
      } catch (err) { toast(err.message, 'err'); }
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
        toast('أدخل رقم الحركة أو اسم/رقم المحوِّل أو ارفع صورة الإشعار', 'err');
        return;
      }
      const btn = pf.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        S.order = await jfetch(`/api/shop/orders/${encodeURIComponent(o.code)}/proof`, {
          method: 'POST',
          body: { payReference, payName, payPhone, receipt: proofData },
        });
        toast(S.order.status === 'paid' ? 'تم التحقق من الدفع وتفعيل الطلب' : 'تم استلام بيانات التحويل — جارٍ التحقّق');
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
          const st = STAGES_AR[o.stage] || STAGES_AR[o.status] || STAGES_AR.awaiting_payment;
          return `
            <a href="#/order/${esc(o.code)}" class="item" style="text-decoration:none;color:inherit">
              <div class="item-top">
                <div class="row" style="gap:10px">
                  <span class="shop-brand-mark sm">${icon(o.esim ? 'qr' : 'sim')}</span>
                  <div>
                    <div class="item-title">
                      ${esc(o.packageLabel)}
                      ${o.esim ? `<span class="pill" style="margin-inline-start:6px">eSIM QR</span>` : ''}
                    </div>
                    <div class="item-sub">
                      <span class="ltr mono">${esc(o.code)}</span>${o.number ? ` · <span class="ltr">${esc(fmtPhone(o.number))}</span>` : ''} · ${fmtDate(o.createdAt)}
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
