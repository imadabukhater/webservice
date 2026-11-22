'use strict';
// Server-side SEO pages (/package/:id) and dynamic /sitemap.xml for Google Search indexing.
// Zero inline executable scripts (strict CSP script-src 'self' compatible); JSON-LD + semantic Arabic/English markup.
const { q, getSettings } = require('./db');
const { round } = require('./util');
const { publicPackageName, forAgent } = require('./privacy');
const { shopKind, shopRows } = require('./routes/shop');

const CSS_VER = '37';
const JS_VER = '33';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
const fmtNum = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(n) || 0);

const CARRIERS = [
  { re: /سلكوم|cellcom/i, en: 'Cellcom', about: 'تتميّز شبكة سلكوم (Cellcom) بتغطية قوية وسرعات إنترنت عالية تدعم الجيل الخامس 5G في قطاع غزة وفلسطين مع استقرار ممتاز للمكالمات والإنترنت.' },
  { re: /هوت|hot/i, en: 'Hot Mobile', about: 'تُعدّ شبكة هوت موبايل (Hot Mobile) من أكثر الشبكات طلباً لشرائح eSIM في غزة وفلسطين بفضل عروضها المرنة لمدة 30 يوماً و90 يوماً وأسعارها الاقتصادية.' },
  { re: /بيلفون|pelephone/i, en: 'Pelephone', about: 'توفّر شبكة بيلفون (Pelephone) أداءً قوياً على شبكات 4G و5G مع جودة اتصال عالية وتغطية واسعة ومناسبة للاستخدام اليومي المكثّف.' },
  { re: /بارتنر|partner/i, en: 'Partner', about: 'تقدّم شبكة بارتنر (Partner) باقات إنترنت كبيرة بسرعات 5G فائقة ومناسبة للتصفح، البث، والعمل عن بُعد في قطاع غزة وفلسطين.' },
  { re: /\bwe\b|وي|wecom/i, en: 'WE (Wecom)', about: 'تتميّز باقات وي (WE / Wecom) بأكبر سعات الإنترنت مقابل السعر مع خيارات توفير شهرية وعروض 90 يوماً.' },
  { re: /019/i, en: '019 Mobile', about: 'توفّر 019 موبايل (019 Mobile) باقات eSIM سريعة وموثوقة مع تفعيل فوري وأسعار منافسة.' },
  { re: /aloha|الوها|ألوها/i, en: 'ALOHA', about: 'تتيح شرائح ALOHA تفعيل eSIM فوري وسهل مع باقات إنترنت ومكالمات مناسبة للاستخدام اليومي.' },
  { re: /جولان|golan/i, en: 'Golan Telecom', about: 'توفّر جولان تليكوم (Golan Telecom) باقات eSIM مرنة بتغطية جيدة وسرعات إنترنت عالية.' },
  { re: /رامي|rami/i, en: 'Rami Levy', about: 'تقدّم رامي ليفي (Rami Levy) باقات اتصال وإنترنت اقتصادية بتفعيل eSIM فوري.' },
];

function carrierMeta(name = '') {
  const hit = CARRIERS.find((c) => c.re.test(name));
  return hit || {
    en: name || 'Hot eSIM',
    about: `توفر شبكة ${name || 'Hot eSIM'} اتصال إنترنت سريعاً ومكالمات مستقرة عبر شريحة eSIM إلكترونية فورية في قطاع غزة وفلسطين.`,
  };
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
      q: `ماذا تشمل باقة ${sp.companyName} ${sp.gb ? `${fmtNum(sp.gb)} جيجا` : ''} وكم مدة صلاحيتها؟`,
      a: `تشمل الباقة ${sp.dataLabel} و${sp.callsLabel}، وتعمل على شريحة eSIM برقم جديد صالحة لمدة ${fmtNum(sp.days)} يوماً في قطاع غزة وفلسطين.`,
    },
    {
      q: `كيف أحصل على كود QR لتفعيل باقة ${sp.companyName} في غزة وفلسطين؟`,
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
  const host = req?.headers?.host;
  if (host && !/^(localhost|127\.0\.0\.1|\[::1\])(?::|$)/i.test(host)) {
    const proto = req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
    return `${proto}://${host}`;
  }
  return 'https://www.hotesim.shop';
}

function renderNotFoundHtml(siteUrl) {
  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>الباقة غير متوفرة | Hot eSIM</title>
  <meta name="robots" content="noindex, follow">
  <link rel="stylesheet" href="/css/app.css?v=${CSS_VER}">
</head>
<body class="shop">
  <div id="shop">
    <main class="shop-main" style="max-width:760px;margin:40px auto;padding:24px;text-align:center;">
      <div class="card empty">
        <h1 style="margin:0 0 8px;font-size:1.35rem;">هذه الباقة غير متوفرة حالياً</h1>
        <p class="muted">يمكنك تصفّح جميع باقات شرائح eSIM المتوفرة الآن في متجر Hot eSIM.</p>
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

  const title = `باقة ${sp.headline} eSIM (${fmtNum(sp.days)} يوم) بسعر ${fmtNum(sp.total)} ₪ | ${shopName} غزة وفلسطين`;
  const description = `اشترِ باقة ${sp.headline} (${sp.companyEn}) شريحة eSIM إلكترونية لقطاع غزة وفلسطين: ${sp.dataLabel}، ${sp.callsLabel}، صالحة ${fmtNum(sp.days)} يوماً بسعر إجمالي ${fmtNum(sp.total)} ₪ شامل كود QR فوري والدفع عبر جوال باي وبنك فلسطين وبال باي.`;
  const keywords = [
    `باقة ${sp.headline}`, `eSIM ${sp.companyName}`, `${sp.companyEn} eSIM`,
    sp.gb ? `${sp.companyName} ${fmtNum(sp.gb)} جيجا` : '',
    sp.gb ? `${sp.companyEn} ${fmtNum(sp.gb)}GB eSIM` : '',
    `eSIM غزة`, `شريحة الكترونية غزة`, `باقات نت غزة ${sp.is5G ? '5G' : '4G'}`,
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
      availability: 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: shopName, url: `${siteUrl}/` },
      areaServed: [
        { '@type': 'AdministrativeArea', name: 'Gaza Strip' },
        { '@type': 'Country', name: 'Palestine' },
      ],
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
  <link rel="canonical" href="${esc(pageUrl)}">

  <meta name="geo.region" content="PS">
  <meta name="geo.placename" content="Gaza Strip, Palestine">

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
          <li><b>نوع الشريحة:</b> شريحة eSIM إلكترونية برقم جديد — تفعيل فوري بكود QR وكود LPA</li>
          <li><b>طرق الدفع المتاحة:</b> جوال باي (Jawwal Pay)، بنك فلسطين، بال باي (PalPay)</li>
        </ul>

        <h2 style="font-size:1.25rem;margin:22px 0 8px;">عن شبكة ${esc(sp.companyName)} (${esc(sp.companyEn)}) في غزة وفلسطين</h2>
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
          <h2 style="font-size:1.25rem;margin:22px 0 10px;">باقات eSIM أخرى في غزة وفلسطين</h2>
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

module.exports = { renderPackageHtml, renderSitemapXml, extractSpecs, carrierMeta, siteOrigin };
