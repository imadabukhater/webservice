'use strict';
// Server-side SEO pages (/, /package/:id, 404) and dynamic /sitemap.xml for Google Search Console & Rich Results.
// Zero inline executable scripts (strict CSP script-src 'self' compatible); JSON-LD + semantic Arabic/English markup.
const { q, getSettings } = require('./db');
const { round } = require('./util');
const { publicPackageName, forAgent } = require('./privacy');
const { shopKind, shopRows } = require('./routes/shop');

const CSS_VER = '37';
const JS_VER = '34';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
const fmtNum = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(n) || 0);

const REGION_AR = 'الضفة الغربية وقطاع غزة والقدس وفلسطين';
const AREA_SERVED = [
  { '@type': 'AdministrativeArea', name: 'West Bank', alternateName: 'الضفة الغربية' },
  { '@type': 'AdministrativeArea', name: 'Gaza Strip', alternateName: 'قطاع غزة' },
  { '@type': 'City', name: 'Jerusalem', alternateName: 'القدس' },
  { '@type': 'Country', name: 'Palestine', alternateName: 'دولة فلسطين' },
];

const CARRIERS = [
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

function carrierMeta(name = '') {
  const hit = CARRIERS.find((c) => c.re.test(name));
  return hit || {
    en: name || 'Hot eSIM',
    about: `توفّر شبكة ${name || 'Hot eSIM'} اتصال إنترنت سريعاً ومكالمات مستقرة عبر شريحة eSIM إلكترونية فورية في ${REGION_AR}.`,
  };
}

function priceValidUntil() {
  const d = new Date(Date.now() + 90 * 86400_000);
  return d.toISOString().slice(0, 10);
}

// Merchant Listings compliant digital shipping & return policy metadata (prevents Search Console warnings).
function digitalOfferExtras(siteUrl, shopName) {
  return {
    priceValidUntil: priceValidUntil(),
    availability: 'https://schema.org/InStock',
    itemCondition: 'https://schema.org/NewCondition',
    seller: { '@type': 'Organization', name: shopName, url: `${siteUrl}/` },
    areaServed: AREA_SERVED,
    shippingDetails: {
      '@type': 'OfferShippingDetails',
      shippingRate: { '@type': 'MonetaryAmount', value: '0', currency: 'ILS' },
      shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'PS' },
      deliveryTime: {
        '@type': 'ShippingDeliveryTime',
        handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: 0, unitCode: 'DAY' },
        transitTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: 0, unitCode: 'DAY' },
      },
    },
    hasMerchantReturnPolicy: {
      '@type': 'MerchantReturnPolicy',
      applicableCountry: 'PS',
      returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
      merchantReturnDays: 7,
      returnMethod: 'https://schema.org/ReturnByMail',
      returnFees: 'https://schema.org/FreeReturn',
    },
  };
}

function verificationMeta(s = getSettings()) {
  const token = String(s.googleSiteVerification || process.env.GOOGLE_SITE_VERIFICATION || '').trim();
  return token ? `  <meta name="google-site-verification" content="${esc(token)}">\n` : '';
}

function extractSpecs(p, s = getSettings()) {
  const companyName = String(p.company_name || 'Hot eSIM').trim();
  const cleanName = publicPackageName(p.name || '') || companyName;
  const cleanDesc = forAgent(p.description || '');
  const cleanTag = forAgent(p.tag || '');
  const combined = `${cleanName} ${cleanDesc}`;

  let gb = Number(p.data_gb) || 0;
  if (!gb) {
    const m = combined.match(/(\d+(?:\.\d+)?)\s*(?:GB|G\b|جيجابايت|جيجا|جبجا|غيغا)/i);
    if (m) gb = Number(m[1]) || 0;
  }

  let minutes = p.minutes !== null && p.minutes !== undefined ? Number(p.minutes) : null;
  const unlimitedCalls = minutes === -1 || /مكالمات\s*غير\s*محدود|غير\s*محدود/.test(combined);
  if ((minutes === null || minutes === 0) && !unlimitedCalls) {
    const ms = [...combined.matchAll(/(\d[\d,]*)\s*دقيق[ةه]/g)]
      .map((m) => Number(m[1].replace(/,/g, '')))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ms.length) minutes = Math.max(...ms);
  }

  let sms = p.sms !== null && p.sms !== undefined ? Number(p.sms) : null;
  if (sms === null || sms === 0) {
    const m = combined.match(/(\d[\d,]*)\s*(?:رسال[ةه]|نصية|SMS)/i);
    if (m) sms = Number(m[1].replace(/,/g, '')) || null;
  }

  let days = Number(p.days) || 0;
  if (!days) {
    if (/شهرين|شهران/.test(combined)) days = 60;
    else if (/3\s*[أا]شهر|ثلاث[ةه]\s*[أا]شهر/.test(combined)) days = 90;
    else {
      const ds = [...combined.matchAll(/(\d+)\s*يوم(?![ي])/g)]
        .map((m) => Number(m[1]))
        .filter((n) => n >= 7 && n <= 365);
      if (ds.length) days = ds[0];
    }
  }
  if (!days) days = 30;

  const is5G = /\b5g\b|الجيل\s*الخامس/i.test(`${combined} ${cleanTag}`);
  const price = round(p.shop_price);
  const esimFee = p.company_esim_fee === null || p.company_esim_fee === undefined ? round(s.esimFee) : round(p.company_esim_fee);
  const total = round(price + esimFee);

  const dataLabel = gb > 0
    ? (is5G ? `${fmtNum(gb)} جيجا إنترنت 5G` : `${fmtNum(gb)} جيجا إنترنت سريع`)
    : 'باقة اتصال eSIM';

  let callsLabel = 'مكالمات ورسائل شاملة';
  if (unlimitedCalls) callsLabel = sms > 0 ? `مكالمات غير محدودة و ${fmtNum(sms)} رسالة` : 'مكالمات ورسائل غير محدودة';
  else if (minutes && minutes > 0) callsLabel = sms > 0 ? `${fmtNum(minutes)} دقيقة و ${fmtNum(sms)} رسالة` : `${fmtNum(minutes)} دقيقة مكالمات`;
  else if (cleanTag) callsLabel = cleanTag;

  const headline = cleanName.toLowerCase().startsWith(companyName.toLowerCase()) ? cleanName : `${companyName} ${cleanName}`;
  const cm = carrierMeta(companyName);

  return {
    id: p.id, companyId: p.company_id, companyName, companyEn: cm.en, carrierAbout: cm.about,
    cleanName, cleanDesc, headline, gb, minutes, sms, days, is5G, price, esimFee, total,
    dataLabel, callsLabel,
    mainCap: gb > 0 ? `${fmtNum(gb)}GB` : `${fmtNum(total)}₪`,
  };
}

function buildPackageFaqs(sp, shopName) {
  const feeText = sp.esimFee > 0
    ? `يشمل سعر الباقة (${fmtNum(sp.price)} ₪) بالإضافة إلى رسوم إصدار شريحة eSIM QR (${fmtNum(sp.esimFee)} ₪) بدون أي رسوم مخفية.`
    : 'يشمل كود eSIM QR مجاناً بدون أي رسوم إضافية.';
  return [
    {
      q: `كم سعر باقة ${sp.headline} شاملة شريحة eSIM؟`,
      a: `السعر الإجمالي لباقة ${sp.headline} هو ${fmtNum(sp.total)} ₪ فقط، و${feeText}`,
    },
    {
      q: `ماذا تشمل باقة ${sp.companyName}${sp.gb ? ` ${fmtNum(sp.gb)} جيجا` : ''} وهل تعمل في الضفة الغربية وغزة؟`,
      a: `نعم، تعمل الباقة في ${REGION_AR}، وتشمل ${sp.dataLabel} و${sp.callsLabel} على شريحة eSIM برقم جديد صالحة لمدة ${fmtNum(sp.days)} يوماً.`,
    },
    {
      q: `كيف أحصل على كود QR لتفعيل باقة ${sp.companyName} في الضفة وغزة؟`,
      a: `بعد إتمام الطلب والدفع الآمن عبر جوال باي (Jawwal Pay) أو بنك فلسطين أو بال باي (PalPay) في متجر ${shopName}، يظهر لك كود QR وكود التفعيل اليدوي (LPA) تلقائياً خلال ثوانٍ، ويمكنك مسحه من إعدادات هاتفك أثناء الاتصال بشبكة Wi-Fi.`,
    },
    {
      q: 'هل يتغيّر رقم واتساب (WhatsApp) عند إضافة شريحة eSIM الجديدة؟',
      a: 'لا، يحتفظ هاتفك بحسابك ورقمك الحالي على واتساب كما هو تماماً دون أي تغيير، وتعمل شريحة eSIM كخط إنترنت واتصال إضافي على نفس الجهاز.',
    },
    {
      q: `كيف أتأكد أن هاتفي يدعم شريحة eSIM لباقة ${sp.companyName}؟`,
      a: 'اطلب الكود *#06# من لوحة اتصال هاتفك؛ إذا ظهر رقم EID فجهازك متوافق مع شريحة eSIM (يدعم معظم أجهزة iPhone XS والأحدث، وسامسونج Galaxy S20/S21/S22/S23/S24/S25، و Google Pixel).',
    },
  ];
}

function siteOrigin(req) {
  if (process.env.SHOP_URL) return process.env.SHOP_URL.replace(/\/+$/, '');
  const host = String(req?.headers?.host || '').trim();
  if (!host || /^(localhost|127\.0\.0\.1|\[::1\])(?::|$)/i.test(host) || /^(?:www\.)?hotesim\.shop(?::\d+)?$/i.test(host)) {
    return 'https://www.hotesim.shop';
  }
  const proto = req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
  return `${proto}://${host}`;
}

function renderNotFoundHtml(siteUrl = 'https://www.hotesim.shop') {
  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>الصفحة غير موجودة | Hot eSIM</title>
  <meta name="robots" content="noindex, nofollow">
  <link rel="stylesheet" href="/css/app.css?v=${CSS_VER}">
</head>
<body class="shop">
  <div id="shop">
    <main class="shop-main" style="max-width:760px;margin:40px auto;padding:24px;text-align:center;">
      <div class="card empty">
        <h1 style="margin:0 0 8px;font-size:1.35rem;">هذه الصفحة أو الباقة غير متوفرة حالياً</h1>
        <p class="muted">يمكنك تصفّح جميع باقات شرائح eSIM المتوفرة الآن في الضفة الغربية وقطاع غزة وفلسطين.</p>
        <a class="btn primary" href="${esc(siteUrl)}/">تصفّح باقات eSIM المتاحة</a>
      </div>
    </main>
  </div>
  <div id="toasts" class="toasts" aria-live="polite" aria-atomic="false"></div>
  <script type="module" src="/js/shop.js?v=${JS_VER}"></script>
</body>
</html>`;
  return { status: 404, html };
}

function renderHomeHtml({ siteUrl = 'https://www.hotesim.shop' } = {}) {
  const s = getSettings();
  const shopName = s.shopTitle || 'Hot eSIM';
  const rows = shopRows();
  const items = rows.map((r) => extractSpecs(r, s));
  const carriers = [...new Set(items.map((x) => x.companyName))];
  const minTotal = items.length ? Math.min(...items.map((x) => x.total)) : null;

  const title = `${shopName} | شرائح eSIM وباقات الإنترنت في الضفة الغربية وقطاع غزة وفلسطين`;
  const carriersText = carriers.length ? carriers.join('، ') : 'سلكوم، هوت موبايل، بيلفون، بارتنر، WE، رامي ليفي';
  const description = `متجر ${shopName} لشرائح eSIM الإلكترونية وباقات الإنترنت 5G في الضفة الغربية (رام الله، نابلس، الخليل، بيت لحم، جنين، طولكرم) والقدس وقطاع غزة: ${carriersText}${minTotal ? ` بأسعار تبدأ من ${fmtNum(minTotal)} ₪` : ''}. تفعيل فوري بكود QR ودفع آمن عبر جوال باي (Jawwal Pay) وبنك فلسطين وبال باي (PalPay).`;
  const keywords = [
    'eSIM الضفة الغربية', 'eSIM غزة', 'eSIM فلسطين', 'eSIM القدس',
    'شريحة الكترونية الضفة الغربية', 'شريحة الكترونية غزة', 'باقات نت الضفة وغزة',
    'eSIM رام الله', 'eSIM نابلس', 'eSIM الخليل', 'eSIM بيت لحم', 'eSIM جنين', 'eSIM طولكرم',
    'سلكوم eSIM', 'هوت موبايل eSIM', 'بيلفون eSIM', 'بارتنر eSIM', 'WE eSIM', 'رامي ليفي eSIM',
    'Cellcom eSIM Palestine', 'Hot Mobile eSIM', 'Pelephone eSIM', 'Wecom 500GB',
    'تفعيل eSIM فوري QR', 'شراء eSIM جوال باي', 'شراء eSIM بنك فلسطين', 'PalPay eSIM',
  ].join(', ');

  const homeFaqs = [
    {
      q: 'هل تعمل شرائح eSIM في الضفة الغربية وقطاع غزة والقدس؟',
      a: `نعم، جميع باقات وشرائح eSIM في متجر ${shopName} تعمل في الضفة الغربية (رام الله، نابلس، الخليل، بيت لحم، جنين، طولكرم، قلقيلية، أريحا)، والقدس، وقطاع غزة وفلسطين على شبكات ${carriersText}.`,
    },
    {
      q: 'كيف تعمل شريحة eSIM الإلكترونية وما سرعة استلام كود QR؟',
      a: `شريحة eSIM هي شريحة رقمية مدمجة داخل هاتفك بدون بطاقة بلاستيكية. بعد إتمام الطلب والدفع في ${shopName}، يظهر لك كود QR وكود التفعيل اليدوي (LPA) تلقائياً خلال ثوانٍ، وتمسحه من إعدادات هاتفك أثناء الاتصال بشبكة Wi-Fi ليعمل الإنترنت فوراً.`,
    },
    {
      q: 'ما هي طرق الدفع المتاحة في المتجر؟',
      a: 'يدعم المتجر الدفع المباشر والآمن عبر محفظة جوال باي (Jawwal Pay)، وبنك فلسطين، ومحفظة بال باي (PalPay) بالشيكل (₪) مع تحقق وتفعيل فوري وتلقائي خلال ثوانٍ.',
    },
    {
      q: 'هل تتوفر باقات شهرية وعروض توفير لمدة 90 يوماً (3 أشهر)؟',
      a: 'نعم، نوفر باقات شهرية (30 يوماً) وعروض توفير ممتدة لمدة 90 يوماً (3 أشهر) لشبكات سلكوم وهوت موبايل وWE وغيرها بأسعار شاملة لشريحة eSIM بدون رسوم خفية.',
    },
    {
      q: 'هل يتغيّر رقم واتساب (WhatsApp) عند تثبيت شريحة eSIM؟',
      a: 'لا، يحتفظ هاتفك بحسابك ورقمك على واتساب كما هو تماماً دون أي تغيير، وتعمل شريحة eSIM كخط إنترنت واتصال إضافي برقم جديد.',
    },
    {
      q: 'كيف أعرف إذا كان هاتفي يدعم شريحة eSIM؟',
      a: 'اطلب الكود *#06# من لوحة اتصال هاتفك؛ إذا ظهر رقم EID فجهازك متوافق مع eSIM (تدعمها أجهزة iPhone XS والأحدث، سامسونج Galaxy S20 فما فوق وسلسلة Z Fold/Flip، وأجهزة Google Pixel).',
    },
  ];

  const offerExtras = digitalOfferExtras(siteUrl, shopName);
  const websiteSchema = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: shopName,
    alternateName: `متجر ${shopName} لشرائح eSIM في الضفة الغربية وقطاع غزة وفلسطين`,
    url: `${siteUrl}/`,
    inLanguage: 'ar',
  };

  const storeSchema = {
    '@context': 'https://schema.org',
    '@type': 'OnlineStore',
    name: shopName,
    alternateName: `متجر ${shopName} لشرائح eSIM والإنترنت في الضفة الغربية وغزة وفلسطين`,
    url: `${siteUrl}/`,
    logo: `${siteUrl}/icon-512.png`,
    image: `${siteUrl}/icon-512.png`,
    description,
    currenciesAccepted: 'ILS',
    paymentAccepted: 'Jawwal Pay, Bank of Palestine, PalPay',
    priceRange: minTotal ? `${minTotal}₪+` : '₪',
    areaServed: AREA_SERVED,
    ...(s.supportWhatsapp ? {
      contactPoint: {
        '@type': 'ContactPoint',
        contactType: 'customer support',
        availableLanguage: ['Arabic', 'English'],
        url: `https://wa.me/${String(s.supportWhatsapp).replace(/\D/g, '')}`,
      },
    } : {}),
  };

  const itemListSchema = items.length ? {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'باقات وشرائح eSIM المتوفرة في الضفة الغربية وقطاع غزة وفلسطين',
    numberOfItems: items.length,
    itemListElement: items.map((sp, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${siteUrl}/package/${sp.id}`,
      item: {
        '@type': 'Product',
        name: `باقة ${sp.headline} eSIM`,
        description: `${sp.dataLabel} و${sp.callsLabel} لمدة ${fmtNum(sp.days)} يوماً على شبكة ${sp.companyName} (${sp.companyEn}) في ${REGION_AR}.`,
        sku: `HOTESIM-${sp.id}`,
        category: 'eSIM Plans & Mobile Internet',
        image: `${siteUrl}/icon-512.png`,
        brand: { '@type': 'Brand', name: sp.companyEn },
        offers: {
          '@type': 'Offer',
          url: `${siteUrl}/package/${sp.id}`,
          priceCurrency: 'ILS',
          price: String(sp.total),
          ...offerExtras,
        },
      },
    })),
  } : null;

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: homeFaqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#17111F">
  <meta name="color-scheme" content="light dark">

  <title>${esc(title)}</title>
  <meta name="title" content="${esc(title)}">
  <meta name="description" content="${esc(description)}">
  <meta name="keywords" content="${esc(keywords)}">
  <meta name="author" content="${esc(shopName)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
${verificationMeta(s)}  <link rel="canonical" href="${esc(siteUrl)}/">
  <link rel="alternate" hreflang="ar-PS" href="${esc(siteUrl)}/">
  <link rel="alternate" hreflang="ar" href="${esc(siteUrl)}/">
  <link rel="alternate" hreflang="x-default" href="${esc(siteUrl)}/">

  <meta name="geo.region" content="PS">
  <meta name="geo.placename" content="West Bank, Gaza Strip, Jerusalem, Palestine">

  <meta property="og:type" content="website">
  <meta property="og:url" content="${esc(siteUrl)}/">
  <meta property="og:site_name" content="${esc(shopName)} فلسطين">
  <meta property="og:locale" content="ar_AR">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${esc(siteUrl)}/icon-512.png">
  <meta property="og:image:width" content="512">
  <meta property="og:image:height" content="512">
  <meta property="og:image:alt" content="باقات وشرائح ${esc(shopName)} في الضفة الغربية وقطاع غزة وفلسطين">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:url" content="${esc(siteUrl)}/">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(siteUrl)}/icon-512.png">

  <link rel="icon" href="/icon.svg?v=30" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Outfit:wght@500;600;700;800&family=IBM+Plex+Mono:wght@500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/app.css?v=${CSS_VER}">

  <script type="application/ld+json">${jsonLd(websiteSchema)}</script>
  <script type="application/ld+json">${jsonLd(storeSchema)}</script>
${itemListSchema ? `  <script type="application/ld+json">${jsonLd(itemListSchema)}</script>\n` : ''}  <script type="application/ld+json">${jsonLd(faqSchema)}</script>
</head>
<body class="shop">
  <div id="shop">
    <main class="shop-main" style="max-width:980px;margin:28px auto;padding:20px 16px;font-family:'IBM Plex Sans Arabic',sans-serif;color:#1A1325;direction:rtl;">
      <header style="text-align:center;margin-bottom:24px;">
        <h1 style="font-size:1.8rem;margin:0 0 10px;color:#D9142F;line-height:1.4;">
          ${esc(shopName)} — شرائح eSIM وباقات الإنترنت في الضفة الغربية وقطاع غزة وفلسطين
        </h1>
        <p style="font-size:1rem;line-height:1.8;color:#3A3346;max-width:780px;margin:0 auto;">
          احصل على شريحة eSIM إلكترونية فورية وباقات إنترنت 5G تعمل في الضفة الغربية (رام الله، نابلس، الخليل، بيت لحم، جنين، طولكرم، قلقيلية)، القدس، وقطاع غزة خلال ثوانٍ عبر كود QR، بدفع آمن عبر جوال باي (Jawwal Pay) وبنك فلسطين وبال باي (PalPay).
        </p>
      </header>

      ${items.length ? `
        <section style="background:#fff;border:1px solid #F0E2DC;border-radius:18px;padding:20px;margin-bottom:22px;">
          <h2 style="font-size:1.28rem;margin:0 0 14px;border-bottom:1px solid #F0E2DC;padding-bottom:10px;">
            الباقات وشرائح eSIM المتوفرة للتفعيل الفوري (${fmtNum(items.length)} باقة)
          </h2>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;">
            ${items.map((sp) => `
              <article style="padding:13px;border:1px solid #F0E2DC;border-radius:12px;background:#FFF8F4;">
                <h3 style="margin:0 0 6px;font-size:1.02rem;">
                  <a href="/package/${sp.id}" style="color:#D9142F;text-decoration:none;">باقة ${esc(sp.headline)} eSIM</a>
                </h3>
                <div style="color:#5B5368;font-size:.88rem;">${esc(sp.dataLabel)} · ${esc(sp.callsLabel)} · ${esc(fmtNum(sp.days))} يوماً</div>
                <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
                  <strong style="color:#1A1325;">${esc(fmtNum(sp.total))} ₪</strong>
                  <a href="/package/${sp.id}" style="color:#D9142F;font-size:.85rem;font-weight:700;">المزيد من التفاصيل ←</a>
                </div>
              </article>
            `).join('')}
          </div>
        </section>
      ` : ''}

      <section style="background:#fff;border:1px solid #F0E2DC;border-radius:18px;padding:20px;margin-bottom:22px;">
        <h2 style="font-size:1.25rem;margin:0 0 12px;">أسئلة شائعة حول شرائح eSIM في الضفة الغربية وغزة وفلسطين</h2>
        ${homeFaqs.map((f) => `<div style="margin-bottom:12px;"><h3 style="font-size:.98rem;margin:0 0 4px;">${esc(f.q)}</h3><p style="margin:0;line-height:1.7;color:#3A3346;font-size:.92rem;">${esc(f.a)}</p></div>`).join('')}
      </section>
    </main>
  </div>

  <noscript>
    <div style="max-width:860px;margin:20px auto;padding:18px;background:#FFF8F4;border:1px solid #F0E2DC;border-radius:14px;direction:rtl;">
      يرجى تفعيل JavaScript في المتصفح لإتمام الشراء التفاعلي واستلام كود QR مباشرة.
    </div>
  </noscript>

  <div id="toasts" class="toasts" aria-live="polite" aria-atomic="false"></div>
  <script type="module" src="/js/shop.js?v=${JS_VER}"></script>
</body>
</html>`;
}

function renderPackageHtml(rawId, { siteUrl = 'https://www.hotesim.shop' } = {}) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return renderNotFoundHtml(siteUrl);

  const s = getSettings();
  const p = q(`SELECT p.*, c.name AS company_name, c.color AS company_color, c.logo AS company_logo, c.esim_fee AS company_esim_fee
               FROM packages p JOIN companies c ON c.id = p.company_id
               WHERE p.id = ? AND p.active = 1 AND p.shop_price > 0`).get(id);
  if (!p || !shopKind(p)) return renderNotFoundHtml(siteUrl);

  const shopName = s.shopTitle || 'Hot eSIM';
  const sp = extractSpecs(p, s);
  const pageUrl = `${siteUrl}/package/${sp.id}`;
  const buyUrl = `${siteUrl}/#/buy/${sp.id}?esim=1`;
  const faqs = buildPackageFaqs(sp, shopName);

  const allRows = shopRows().filter((r) => r.id !== sp.id);
  const related = [
    ...allRows.filter((r) => r.company_id === sp.companyId),
    ...allRows.filter((r) => r.company_id !== sp.companyId),
  ].slice(0, 6).map((r) => extractSpecs(r, s));

  const title = `باقة ${sp.headline} eSIM (${fmtNum(sp.days)} يوم) بسعر ${fmtNum(sp.total)} ₪ | ${shopName} الضفة وغزة`;
  const description = `اشترِ باقة ${sp.headline} (${sp.companyEn}) شريحة eSIM إلكترونية في ${REGION_AR}: ${sp.dataLabel}، ${sp.callsLabel}، صالحة ${fmtNum(sp.days)} يوماً بسعر إجمالي ${fmtNum(sp.total)} ₪ شامل كود QR فوري والدفع عبر جوال باي وبنك فلسطين وبال باي.`;
  const keywords = [
    `باقة ${sp.headline}`, `eSIM ${sp.companyName}`, `${sp.companyEn} eSIM`,
    sp.gb ? `${sp.companyName} ${fmtNum(sp.gb)} جيجا` : '',
    sp.gb ? `${sp.companyEn} ${fmtNum(sp.gb)}GB eSIM` : '',
    `eSIM الضفة الغربية`, `eSIM غزة`, `eSIM القدس`, `eSIM فلسطين`,
    `شريحة الكترونية الضفة الغربية`, `شريحة الكترونية غزة`, `باقات نت الضفة وغزة ${sp.is5G ? '5G' : '4G'}`,
    `تفعيل eSIM فوري QR`, `دفع جوال باي Jawwal Pay`, `بنك فلسطين`, `PalPay`,
    sp.days >= 60 ? `عرض ${fmtNum(sp.days)} يوم ${sp.companyName}` : `باقة شهرية ${sp.companyName}`,
  ].filter(Boolean).join(', ');

  const productSchema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: `باقة ${sp.headline} eSIM`,
    description,
    sku: `HOTESIM-${sp.id}`,
    category: 'eSIM Plans & Mobile Internet',
    image: `${siteUrl}/icon-512.png`,
    brand: { '@type': 'Brand', name: sp.companyEn },
    offers: {
      '@type': 'Offer',
      url: pageUrl,
      priceCurrency: 'ILS',
      price: String(sp.total),
      ...digitalOfferExtras(siteUrl, shopName),
    },
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: shopName, item: `${siteUrl}/` },
      { '@type': 'ListItem', position: 2, name: `باقات ${sp.companyName}`, item: `${siteUrl}/` },
      { '@type': 'ListItem', position: 3, name: `باقة ${sp.headline}`, item: pageUrl },
    ],
  };

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#17111F">
  <meta name="color-scheme" content="light dark">

  <title>${esc(title)}</title>
  <meta name="title" content="${esc(title)}">
  <meta name="description" content="${esc(description)}">
  <meta name="keywords" content="${esc(keywords)}">
  <meta name="author" content="${esc(shopName)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
${verificationMeta(s)}  <link rel="canonical" href="${esc(pageUrl)}">
  <link rel="alternate" hreflang="ar-PS" href="${esc(pageUrl)}">
  <link rel="alternate" hreflang="ar" href="${esc(pageUrl)}">
  <link rel="alternate" hreflang="x-default" href="${esc(pageUrl)}">

  <meta name="geo.region" content="PS">
  <meta name="geo.placename" content="West Bank, Gaza Strip, Jerusalem, Palestine">

  <meta property="og:type" content="product">
  <meta property="og:url" content="${esc(pageUrl)}">
  <meta property="og:site_name" content="${esc(shopName)} فلسطين">
  <meta property="og:locale" content="ar_AR">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${esc(siteUrl)}/icon-512.png">
  <meta property="og:image:width" content="512">
  <meta property="og:image:height" content="512">
  <meta property="product:price:amount" content="${esc(String(sp.total))}">
  <meta property="product:price:currency" content="ILS">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:url" content="${esc(pageUrl)}">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(siteUrl)}/icon-512.png">

  <link rel="icon" href="/icon.svg?v=30" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Outfit:wght@500;600;700;800&family=IBM+Plex+Mono:wght@500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/app.css?v=${CSS_VER}">

  <script type="application/ld+json">${jsonLd(productSchema)}</script>
  <script type="application/ld+json">${jsonLd(breadcrumbSchema)}</script>
  <script type="application/ld+json">${jsonLd(faqSchema)}</script>
</head>
<body class="shop">
  <div id="shop">
    <main class="shop-main" style="max-width:960px;margin:24px auto;padding:16px;font-family:'IBM Plex Sans Arabic',sans-serif;direction:rtl;">
      <nav aria-label="مسار التنقل" style="margin-bottom:14px;font-size:.9rem;">
        <a href="/">الرئيسية — ${esc(shopName)}</a> / <span>باقات ${esc(sp.companyName)}</span> / <strong>${esc(sp.headline)}</strong>
      </nav>

      <article style="background:#fff;border:1px solid #F0E2DC;border-radius:18px;padding:22px;margin-bottom:20px;">
        <h1 style="font-size:1.7rem;margin:0 0 10px;color:#D9142F;">باقة ${esc(sp.headline)} — شريحة eSIM فورية (${esc(sp.companyEn)})</h1>
        <p style="font-size:1rem;line-height:1.8;color:#3A3346;margin:0 0 16px;">${esc(description)}</p>
        <p style="font-size:1.25rem;font-weight:700;color:#1A1325;margin:0 0 14px;">
          السعر الإجمالي: ${esc(fmtNum(sp.total))} ₪ ${sp.esimFee > 0 ? `(الباقة ${esc(fmtNum(sp.price))} ₪ + شريحة eSIM QR ${esc(fmtNum(sp.esimFee))} ₪)` : '(شامل كود eSIM QR مجاناً)'}
        </p>
        <a href="${esc(buyUrl)}" style="display:inline-block;padding:12px 24px;border-radius:12px;background:#D9142F;color:#fff;font-weight:700;text-decoration:none;">
          شراء الباقة الآن واستلام كود QR · ${esc(fmtNum(sp.total))} ₪
        </a>

        <h2 style="font-size:1.25rem;margin:24px 0 10px;">مواصفات باقة ${esc(sp.headline)}</h2>
        <ul style="line-height:1.9;padding-right:20px;color:#3A3346;">
          <li><b>الشبكة / المشغّل:</b> ${esc(sp.companyName)} (${esc(sp.companyEn)})</li>
          <li><b>الإنترنت:</b> ${esc(sp.dataLabel)}</li>
          <li><b>المكالمات والرسائل:</b> ${esc(sp.callsLabel)}</li>
          <li><b>مدة الصلاحية:</b> ${esc(fmtNum(sp.days))} يوماً</li>
          <li><b>التغطية:</b> ${esc(REGION_AR)}</li>
          <li><b>نوع الشريحة:</b> شريحة eSIM إلكترونية برقم جديد — تفعيل فوري بكود QR وكود LPA</li>
          <li><b>طرق الدفع المتاحة:</b> جوال باي (Jawwal Pay)، بنك فلسطين، بال باي (PalPay)</li>
        </ul>

        <h2 style="font-size:1.25rem;margin:22px 0 8px;">عن شبكة ${esc(sp.companyName)} (${esc(sp.companyEn)}) في الضفة الغربية وغزة وفلسطين</h2>
        <p style="line-height:1.8;color:#3A3346;">${esc(sp.carrierAbout)}</p>

        <h2 style="font-size:1.25rem;margin:22px 0 8px;">طريقة تفعيل شريحة eSIM على iPhone و Android</h2>
        <ol style="line-height:1.9;padding-right:20px;color:#3A3346;">
          <li>تأكد من توافق هاتفك بطلب الكود *#06# والتأكد من ظهور رقم EID.</li>
          <li>أكمل الدفع الآمن لتستلم كود QR وكود التفعيل اليدوي (LPA) تلقائياً خلال ثوانٍ.</li>
          <li>على iPhone: الإعدادات ← خلوي ← إضافة eSIM ← مسح كود QR. على Android: الضبط ← الاتصالات ← إدارة SIM ← إضافة eSIM.</li>
        </ol>

        <h2 style="font-size:1.25rem;margin:22px 0 10px;">أسئلة شائعة حول باقة ${esc(sp.headline)}</h2>
        ${faqs.map((f) => `<div style="margin-bottom:12px;"><h3 style="font-size:1rem;margin:0 0 4px;">${esc(f.q)}</h3><p style="margin:0;line-height:1.7;color:#3A3346;">${esc(f.a)}</p></div>`).join('')}

        ${related.length ? `
          <h2 style="font-size:1.25rem;margin:22px 0 10px;">باقات eSIM أخرى في الضفة الغربية وقطاع غزة وفلسطين</h2>
          <ul style="line-height:1.9;padding-right:20px;">
            ${related.map((r) => `<li><a href="/package/${r.id}">${esc(r.headline)} (${esc(r.dataLabel)} · ${esc(fmtNum(r.days))} يوماً) — ${esc(fmtNum(r.total))} ₪</a></li>`).join('')}
          </ul>
        ` : ''}
      </article>
    </main>
  </div>
  <div id="toasts" class="toasts" aria-live="polite" aria-atomic="false"></div>
  <script type="module" src="/js/shop.js?v=${JS_VER}"></script>
</body>
</html>`;

  return { status: 200, html };
}

function renderSitemapXml({ siteUrl = 'https://www.hotesim.shop' } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = shopRows();
  const urls = [
    { loc: `${siteUrl}/`, changefreq: 'daily', priority: '1.0' },
    ...rows.map((p) => ({ loc: `${siteUrl}/package/${p.id}`, changefreq: 'daily', priority: '0.9' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${esc(u.loc)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
}

module.exports = { renderHomeHtml, renderPackageHtml, renderNotFoundHtml, renderSitemapXml, extractSpecs, carrierMeta, siteOrigin };
