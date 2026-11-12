import { S, api, icon, esc, field, toast, downloadBlob, changed, relTime, fmtDateTime } from '../core.js';

// The daily copy in Google Cloud Storage: when the last one was made, and why the last attempt failed if it did.
function cloudBackupHtml(s) {
  if (!s.backupBucket && !s.backupError) {
    return `<p class="muted small">يحفظ السيرفر نسخة كاملة كل يوم في Google Cloud Storage. لم يُضبط مكان الحفظ على هذا السيرفر بعد.</p>`;
  }
  const kb = s.backupLastBytes ? ` · ${Math.max(1, Math.round(s.backupLastBytes / 1024))} KB` : '';
  return `<p class="muted small">نسخة كاملة كل يوم في <span class="ltr mono">${esc(s.backupBucket)}</span>، تُحفظ 30 يوماً ولا يستطيع السيرفر حذفها.</p>
    ${s.backupLastAt ? `<div class="msg info">${icon('checkCircle')}<span>آخر نسخة ${relTime(s.backupLastAt)} (${fmtDateTime(s.backupLastAt)})${kb}</span></div>` : ''}
    ${s.backupError ? `<div class="msg">${icon('alert')}<span>فشلت آخر محاولة: ${esc(s.backupError)}</span></div>` : ''}`;
}

// Four tabs, so each part is short: the app itself, the suppliers' accounts, WhatsApp, and the backups.
const V = { tab: 'general', wa: null, waTimer: null };
const TABS = [['general', 'عام', 'sliders'], ['suppliers', 'المورّدون', 'refresh'], ['whatsapp', 'واتساب', 'whatsapp'], ['backup', 'النسخ الاحتياطي', 'download']];

// ---------- WhatsApp: the link (QR code), and who it answers ----------
const WA_LABEL = { off: 'غير مربوط', missing: 'مكتبة واتساب غير مثبتة على السيرفر', connecting: 'جارٍ الاتصال…', qr: 'امسح رمز QR من هاتف المتجر', connected: 'مربوط ويعمل' };
function waStatusHtml(w) {
  if (!w) return `<div class="msg">${icon('alert')}<span>تعذّر جلب حالة واتساب.</span></div>`;
  const busy = w.status === 'connecting' || w.status === 'qr';
  return `<div class="msg ${w.status === 'connected' ? 'info' : ''}">${icon(w.status === 'connected' ? 'checkCircle' : w.status === 'qr' ? 'qr' : 'whatsapp')}
      <span><b>${WA_LABEL[w.status] || WA_LABEL.off}</b>${w.phone ? ` · <span class="ltr">${esc(w.phone)}</span>` : ''}</span></div>
    ${w.status === 'qr' && w.qr ? `<div style="text-align:center;margin:12px 0">
      <img src="${w.qr}" alt="رمز QR لربط واتساب" style="width:260px;max-width:100%;background:#fff;padding:8px;border-radius:12px">
      <p class="muted small">في هاتف المتجر: واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز، ثم امسح الرمز. يتجدّد الرمز كل نحو 20 ثانية.</p></div>` : ''}
    ${w.error ? `<div class="msg">${icon('alert')}<span>${esc(w.error)}</span></div>` : ''}
    <div class="btn-row">
      ${w.status === 'connected'
        ? `<button class="btn" type="button" data-action="wa-test">${icon('send')}رسالة تجريبية</button>
           <button class="btn" type="button" data-action="wa-logout">${icon('logout')}إلغاء الربط</button>`
        : `<button class="btn btn-primary" type="button" data-action="wa-connect" ${busy ? 'disabled' : ''}>${icon('qr')}ربط واتساب</button>
           ${busy ? `<button class="btn" type="button" data-action="wa-connect" data-fresh="1">${icon('refresh')}رمز جديد</button>` : ''}`}
    </div>`;
}
function waHtml(w) {
  const c = w?.config || {};
  return `
        <section class="card card-pad form">
          <h2 class="dot-title">واتساب المتجر</h2>
          <p class="muted small">يربط رقم واتساب المتجر بالسيرفر (مثل واتساب ويب). بعدها يرد تلقائياً: <b>الوكيل</b> (رقمه المحفوظ في حسابه) يرى رزمه وأسعاره ورصيده، ويشحن ويفعّل eSIM من رصيده بعد أن يرسل «نعم»، وتصله النتيجة ورمز QR الحقيقي في المحادثة. <b>الزبون</b> يرى باقات المتجر وأسعاره، ويأخذ رابط الطلب والدفع في المتجر — لا يُفعَّل له شيء قبل التحقق من الدفع.</p>
          <div id="wa-status">${waStatusHtml(w)}</div>
        </section>
        <form class="card card-pad form" id="wa-form" novalidate autocomplete="off">
          <h2 class="dot-title">الرد التلقائي</h2>
          <label class="switch-row"><span class="grow"><b>الرد على الرسائل</b><small>أوقفه ليبقى واتساب مربوطاً دون رد تلقائي</small></span><input class="switch" type="checkbox" name="enabled" ${c.enabled !== false ? 'checked' : ''}></label>
          <label class="switch-row"><span class="grow"><b>الرد على الزبائن</b><small>غير الوكلاء: باقات المتجر وأسعاره ورابط الطلب والدفع</small></span><input class="switch" type="checkbox" name="customers" ${c.customers !== false ? 'checked' : ''}></label>
          <div class="field"><label for="wa-admins">أرقام المدير</label><input class="input ltr" id="wa-admins" name="admins" inputmode="tel" placeholder="0599123456, 0521234567" value="${esc(c.admins || '')}">
            <span class="hint">من هذه الأرقام: الطلبات المفتوحة وحالة أي رقم. الوكيل يُعرف من رقم الهاتف في حسابه (الوكلاء ← تعديل).</span></div>
          <div class="field"><label for="wa-shop">رابط المتجر</label><input class="input ltr" id="wa-shop" name="shopUrl" placeholder="https://www.example.com/shop" value="${esc(c.shopUrl || '')}">
            <span class="hint">يُرسَل للزبون مع كل باقة ليطلبها ويدفع.</span></div>
          <div class="field"><label for="wa-welcome">رسالة الترحيب</label><input class="input" id="wa-welcome" name="welcome" maxlength="300" value="${esc(c.welcome || '')}" placeholder="أهلاً بك في متجرنا 👋"></div>
          <div class="field"><label for="wa-ai">مفتاح Gemini (اختياري)</label><input class="input ltr" id="wa-ai" name="aiKey" type="password" autocomplete="new-password" placeholder="${c.hasAiKey ? 'محفوظ — اتركه فارغاً للإبقاء' : 'بدونه يفهم الأوامر المكتوبة فقط'}">
            <span class="hint">لفهم الرسائل الحرة. يُرسَل نص الرسالة إلى Google لفهمها، ولا يُنفَّذ شيء بدون «نعم».</span></div>
          ${c.hasAiKey ? '<label class="switch-row"><span class="grow"><b>حذف مفتاح Gemini المحفوظ</b></span><input class="switch" type="checkbox" name="aiKeyClear"></label>' : ''}
          <div id="wa-msg"></div>
          <button class="btn btn-primary" type="submit">${icon('check')}حفظ</button>
        </form>
`;
}

export default {
  admin: true,
  title: () => ({ title: 'الإعدادات', subtitle: 'اسم التطبيق، الرسوم، الدعم الفني والنسخ الاحتياطي' }),
  async load(ctx) {
    if (TABS.some(([k]) => k === ctx?.query?.tab)) V.tab = ctx.query.tab;
    S.settings = await api.get('/api/settings');
    if (V.tab === 'whatsapp') V.wa = await api.get('/api/whatsapp').catch(() => null);
  },
  render() {
    const s = S.settings;
    const tab = TABS.some(([k]) => k === V.tab) ? V.tab : 'general';
    const parts = {
      general: `
        <form class="card card-pad form" id="settings-form" novalidate>
          <h2 class="dot-title">عام</h2>
          <div class="field"><label for="st-name">اسم التطبيق</label><input class="input" id="st-name" name="appName" value="${esc(s.appName)}">
            <span class="hint">يظهر للوكلاء في شاشة الدخول والقائمة.</span></div>
          <div class="row2 stack-xs">
            <div class="field"><label for="st-warn">التنبيه قبل انتهاء الرزمة (أيام)</label><input class="input ltr" id="st-warn" name="warnDays" type="number" min="1" max="60" value="${s.warnDays}">
              <span class="hint">تظهر الأرقام في «قيد الفصل» وفي المهام قبل هذه المدة.</span></div>
            <div class="field"><label for="st-low">حد الرصيد المنخفض (₪)</label><input class="input ltr" id="st-low" name="lowBalance" type="number" min="0" step="1" value="${s.lowBalance}">
              <span class="hint">ينبّه الوكيل والمدير عندما ينزل الرصيد المتاح تحته. 0 لإيقاف التنبيه.</span></div>
          </div>
          <div class="row2 stack-xs">
            <div class="field"><label for="st-esim">رسوم تفعيل eSIM (₪)</label><input class="input ltr" id="st-esim" name="esimFee" type="number" min="0" step="0.5" value="${s.esimFee}">
              <span class="hint">تُضاف إلى سعر كل تفعيل eSIM جديد وتُخصم من رصيد الوكيل. 0 لإلغائها.</span></div>
            <div class="field"><label for="st-wa">واتساب الدعم الفني</label><input class="input ltr" id="st-wa" name="supportWhatsapp" inputmode="tel" placeholder="972567725080" value="${esc(s.supportWhatsapp)}">
              <span class="hint">بالصيغة الدولية بدون + أو 0 في البداية. يظهر للوكلاء زر واتساب في أعلى الشاشة. اتركه فارغاً لإخفائه.</span></div>
          </div>
          <div id="settings-msg"></div>
          <button class="btn btn-primary" type="submit">${icon('check')}حفظ الإعدادات</button>
        </form>
        <section class="card card-pad form">
          <h2 class="dot-title">تثبيت التطبيق على الهاتف</h2>
          <p class="muted">افتح الرابط في Chrome على أندرويد أو Safari على آيفون، ثم اختر «إضافة إلى الشاشة الرئيسية». يعمل التطبيق بعدها بأيقونته وبملء الشاشة.</p>
        </section>
`,
      suppliers: `
        <form class="card card-pad form" id="art-form" novalidate autocomplete="off">
          <h2 class="dot-title">الشحن التلقائي عبر art-topup</h2>
          <p class="muted small">يشحن السيرفر كروت الشركات المضبوطة على «تلقائي» من حسابك في art-topup، ويُكمل الطلب بنفسه. إن تعذّر، يبقى الطلب عندك.</p>
          <div class="row2 stack-xs">
            <div class="field"><label for="art-user">اسم المستخدم في art-topup</label><input class="input ltr" id="art-user" name="artUser" value="${esc(s.artUser || '')}" autocomplete="off"></div>
            <div class="field"><label for="art-pass">كلمة المرور</label><input class="input ltr" id="art-pass" name="artPass" type="password" autocomplete="new-password" placeholder="${s.artConfigured ? 'محفوظة — اتركها فارغة للإبقاء' : ''}"></div>
          </div>
          <div class="msg info">${icon('info')}<span>المزامنة ونسبة الربح منفصلتان لكل نظام: افتح «الشركات والرزم» ← تبويب «كروت الشحن» أو «الفواتير».</span></div>
          <div id="art-msg"></div>
          <div class="btn-row">
            <button class="btn btn-primary" type="submit">${icon('check')}حفظ</button>
            <button class="btn" type="button" data-action="art-check" ${s.artConfigured ? '' : 'disabled'}>${icon('wallet')}اختبار الاتصال والرصيد</button>
            <a class="btn" href="#/catalog">${icon('box')}الشركات والرزم</a>
          </div>
        </form>
                  <form class="card card-pad form" id="aylol-form" novalidate autocomplete="off">
            <h2 class="dot-title">البيع والشحن التلقائي عبر أيلول تيليكوم (Aylol)</h2>
            <p class="muted small">يشحن السيرفر كروت الشركات ويفعّل خطوط الفواتير الجديدة وشرائح eSIM (هوت موبايل و019) من حسابك في أيلول تيليكوم تلقائياً. قبل كل عملية يتأكد من سعر أيلول الحالي: إن ارتفع عن المعتمد لا يشتري، ويصلك تنبيه.</p>
            <div class="row2 stack-xs">
              <div class="field"><label for="aylol-user">البريد في أيلول</label><input class="input ltr" id="aylol-user" name="aylolUser" type="email" value="${esc(s.aylolUser || '')}" autocomplete="off"></div>
              <div class="field"><label for="aylol-pass">كلمة المرور</label><input class="input ltr" id="aylol-pass" name="aylolPass" type="password" autocomplete="new-password" placeholder="${s.aylolConfigured ? 'محفوظة — اتركها فارغة للإبقاء' : ''}"></div>
            </div>
            <div class="msg info">${icon('info')}<span>بعد الحفظ تُزامَن رزم أيلول فوراً، ثم كل يوم تلقائياً. نسبة الربح لكل نظام في «الشركات والرزم» ← تبويب «أيلول».</span></div>
            <div id="aylol-msg"></div>
            <div class="btn-row">
              <button class="btn btn-primary" type="submit">${icon('check')}حفظ</button>
              <button class="btn" type="button" data-action="aylol-check" ${s.aylolConfigured ? '' : 'disabled'}>${icon('wallet')}اختبار الاتصال</button>
              <a class="btn" href="#/catalog">${icon('box')}الشركات والرزم</a>
            </div>
          </form>
          <form class="card card-pad form" id="ql-form" novalidate autocomplete="off">
          <h2 class="dot-title">البيع التلقائي عبر QuickLine</h2>
          <p class="muted small">يمدّد السيرفر خطوط الشركات المضبوطة على «تلقائي» من حسابك في QuickLine، ويُكمل الطلب بنفسه. ويفعّل الخطوط الجديدة هناك (رقم من أرقامهم المتاحة، eSIM، أو تحويل رقم). التمديد يحتاج أن يكون الرقم موجوداً في QuickLine تحت وكالتك.</p>
          <div class="row2 stack-xs">
            <div class="field"><label for="ql-user">البريد في QuickLine</label><input class="input ltr" id="ql-user" name="qlUser" type="email" value="${esc(s.qlUser || '')}" autocomplete="off"></div>
            <div class="field"><label for="ql-pass">كلمة المرور</label><input class="input ltr" id="ql-pass" name="qlPass" type="password" autocomplete="new-password" placeholder="${s.qlConfigured ? 'محفوظة — اتركها فارغة للإبقاء' : ''}"></div>
          </div>
          <div class="msg info">${icon('info')}<span>المزامنة ونسبة الربح منفصلتان لكل نظام: افتح «الشركات والرزم» ← تبويب «QuickLine».</span></div>
          <div id="ql-msg"></div>
          <div class="btn-row">
            <button class="btn btn-primary" type="submit">${icon('check')}حفظ</button>
            <button class="btn" type="button" data-action="ql-check" ${s.qlConfigured ? '' : 'disabled'}>${icon('wallet')}اختبار الاتصال والرصيد</button>
            <a class="btn" href="#/catalog">${icon('box')}الشركات والرزم</a>
          </div>
        </form>
        <form class="card card-pad form" id="ly-form" novalidate autocomplete="off">
          <h2 class="dot-title">البيع التلقائي عبر ليان</h2>
          <p class="muted small">يمدّد السيرفر أرقام الوكالة الفعّالة في ليان، ويفعّل أرقامها الموقوفة كخطوط جديدة، بعد أن يتأكد من السعر. يدخل إلى ليان بنفسه، ويصنع رمز المصادقة من المفتاح السري.</p>
          <div class="row2 stack-xs">
            <div class="field"><label for="ly-user">اسم المستخدم في ليان</label><input class="input ltr" id="ly-user" name="lyUser" value="${esc(s.lyUser || '')}" autocomplete="off"></div>
            <div class="field"><label for="ly-pass">كلمة المرور</label><input class="input ltr" id="ly-pass" name="lyPass" type="password" autocomplete="new-password" placeholder="${s.lyConfigured ? 'محفوظة — اتركها فارغة للإبقاء' : ''}"></div>
          </div>
          <div class="field"><label for="ly-secret">المفتاح السري للمصادقة (Authenticator)</label>
            <input class="input ltr" id="ly-secret" name="lySecret" type="password" autocomplete="off" placeholder="${s.lyHasSecret ? 'محفوظ — اتركه فارغاً للإبقاء' : 'المفتاح تحت رمز QR، أو رابط otpauth'}">
            <span class="hint">المفتاح المكتوب تحت رمز QR عند تفعيل المصادقة في ليان (أو رابط التصدير من تطبيق Google Authenticator). يبقى على السيرفر ولا يظهر بعد حفظه.</span></div>
          <div id="ly-msg"></div>
          <div class="btn-row">
            <button class="btn btn-primary" type="submit">${icon('check')}حفظ</button>
            <button class="btn" type="button" data-action="ly-check" ${s.lyConfigured ? '' : 'disabled'}>${icon('wallet')}اختبار الاتصال والرصيد</button>
            <a class="btn" href="#/catalog">${icon('box')}الشركات والرزم</a>
          </div>
        </form>
        <form class="card card-pad form" id="tc-form" novalidate autocomplete="off">
          <h2 class="dot-title">telecom.co.il</h2>
          <p class="muted small">عند الدخول يرسل الموقع رمز تحقق إلى الجيميل. يقرأ السيرفر الرمز بنفسه من ذلك الجيميل بكلمة مرور تطبيق (App password)، دون أن يعلّم الرسائل كمقروءة. يمدّد السيرفر مشتركي الوكالة في telecom تلقائياً بعد أن يتأكد من السعر؛ الخطوط الجديدة تصلك كطلبات. الرزم ونسب الربح في «الشركات والرزم».</p>
          <div class="row2 stack-xs">
            <div class="field"><label for="tc-user">البريد في telecom</label><input class="input ltr" id="tc-user" name="tcUser" type="email" value="${esc(s.tcUser || '')}" autocomplete="off"></div>
            <div class="field"><label for="tc-pass">كلمة المرور</label><input class="input ltr" id="tc-pass" name="tcPass" type="password" autocomplete="new-password" placeholder="${s.tcConfigured ? 'محفوظة — اتركها فارغة للإبقاء' : ''}"></div>
          </div>
          <div class="row2 stack-xs">
            <div class="field"><label for="tc-mail-user">الجيميل الذي يصله الرمز</label>
              <input class="input ltr" id="tc-mail-user" name="tcMailUser" type="email" placeholder="name@gmail.com" value="${esc(s.tcMailUser || '')}" autocomplete="off"></div>
            <div class="field"><label for="tc-mail-pass">كلمة مرور التطبيق (App password)</label>
              <input class="input ltr" id="tc-mail-pass" name="tcMailPass" type="password" autocomplete="new-password" placeholder="${s.tcMailConfigured ? 'محفوظة — اتركها فارغة للإبقاء' : 'xxxx xxxx xxxx xxxx'}"></div>
          </div>
          <span class="hint">من حساب Google ← الأمان ← كلمات مرور التطبيقات (تحتاج التحقق بخطوتين). تبقى على السيرفر ولا تظهر بعد حفظها.</span>
          <p class="muted small" style="margin-top:8px">عنوان تسجيل خطوط eSIM التي يبيعها المتجر (telecom يطلبه لكل خط جديد). اكتب المدينة كما تظهر في قائمة telecom، مثل ירושלים.</p>
          <div class="row2 stack-xs">
            <div class="field"><label for="tc-reg-address">العنوان</label><input class="input" id="tc-reg-address" name="tcRegAddress" value="${esc(s.tcRegAddress || '')}" autocomplete="off"></div>
            <div class="field"><label for="tc-reg-city">المدينة</label><input class="input" id="tc-reg-city" name="tcRegCity" value="${esc(s.tcRegCity || '')}" autocomplete="off"></div>
          </div>
          <div class="field"><label for="tc-reg-zip">الرمز البريدي</label><input class="input ltr" id="tc-reg-zip" name="tcRegZip" inputmode="numeric" value="${esc(s.tcRegZip || '')}" autocomplete="off"></div>
          <div id="tc-msg"></div>
          <div class="btn-row">
            <button class="btn btn-primary" type="submit">${icon('check')}حفظ</button>
            <button class="btn" type="button" data-action="tc-mail-check" ${s.tcMailConfigured ? '' : 'disabled'}>${icon('checkCircle')}اختبار الجيميل</button>
            <button class="btn" type="button" data-action="tc-check" ${s.tcReady ? '' : 'disabled'}>${icon('wallet')}اختبار الدخول إلى telecom</button>
          </div>
        </form>
`,
      whatsapp: waHtml(V.wa),
      backup: `
        <section class="card card-pad form">
          <h2 class="dot-title">النسخ الاحتياطي</h2>
          <p class="muted">كل البيانات (الوكلاء، الأرصدة، الأرقام، السجل) في ملف واحد. نزّل نسخة بانتظام واحفظها في مكان آمن.</p>
          <button class="btn" data-action="backup">${icon('download')}تنزيل نسخة احتياطية</button>
          <div class="divider"></div>
          <h2 class="dot-title">النسخ السحابي التلقائي</h2>
          <div id="cloud-backup">${cloudBackupHtml(s)}</div>
          <button class="btn" data-action="cloud-backup" ${s.backupBucket ? '' : 'disabled title="لم يُحدَّد مكان النسخ بعد"'}>${icon('refresh')}نسخة سحابية الآن</button>
        </section>
`,
    };
    return `<div class="segmented">${TABS.map(([k, label, ic]) => `<button data-action="tab" data-tab="${k}" aria-pressed="${tab === k}">${icon(ic)}${label}</button>`).join('')}</div>
      <div class="two-col">${parts[tab]}</div>`;
  },
  mount(root) {
    clearInterval(V.waTimer);
    if (V.tab === 'whatsapp') {
      // The QR code changes every ~20 seconds, and the link comes up once it is scanned.
      V.waTimer = setInterval(async () => {
        const box = document.getElementById('wa-status');
        if (!box) { clearInterval(V.waTimer); return; }
        try {
          const w = await api.get('/api/whatsapp');
          if (!document.getElementById('wa-status')) return;
          if (JSON.stringify([w.status, w.qr, w.phone, w.error]) !== JSON.stringify([V.wa?.status, V.wa?.qr, V.wa?.phone, V.wa?.error])) {
            V.wa = w;
            box.innerHTML = waStatusHtml(w);
          }
        } catch {}
      }, 3000);
    }
    root.querySelector('#wa-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const msg = root.querySelector('#wa-msg');
      try {
        V.wa = await api.put('/api/whatsapp', {
          enabled: form.elements.enabled.checked, customers: form.elements.customers.checked,
          admins: field(form, 'admins'), shopUrl: field(form, 'shopUrl'), welcome: field(form, 'welcome'),
          aiKey: form.elements.aiKey.value, aiKeyClear: !!form.elements.aiKeyClear?.checked,
        });
        form.elements.aiKey.value = '';
        msg.innerHTML = '';
        toast('تم حفظ إعدادات واتساب');
      } catch (err) {
        msg.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      }
    });
    root.querySelector('#art-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const msg = root.querySelector('#art-msg');
      try {
        S.settings = await api.put('/api/settings', { artUser: field(form, 'artUser'), artPass: form.elements.artPass.value });
        toast('تم حفظ إعدادات art-topup');
        changed();
      } catch (err) {
        msg.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      }
    });
    root.querySelector('#ly-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const msg = root.querySelector('#ly-msg');
      try {
        S.settings = await api.put('/api/settings', { lyUser: field(form, 'lyUser'), lyPass: form.elements.lyPass.value, lySecret: form.elements.lySecret.value });
        toast('تم حفظ إعدادات ليان');
        changed();
      } catch (err) {
        msg.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      }
    });
    root.querySelector('#tc-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const msg = root.querySelector('#tc-msg');
      try {
        S.settings = await api.put('/api/settings', {
          tcUser: field(form, 'tcUser'), tcPass: form.elements.tcPass.value,
          tcMailUser: field(form, 'tcMailUser'), tcMailPass: form.elements.tcMailPass.value,
          tcRegAddress: field(form, 'tcRegAddress'), tcRegCity: field(form, 'tcRegCity'), tcRegZip: field(form, 'tcRegZip'),
        });
        toast('تم حفظ إعدادات telecom');
        changed();
      } catch (err) {
        msg.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      }
    });
    root.querySelector('#aylol-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const msg = root.querySelector('#aylol-msg');
      try {
        S.settings = await api.put('/api/settings', { aylolUser: field(form, 'aylolUser'), aylolPass: form.elements.aylolPass.value });
        toast('تم حفظ إعدادات أيلول');
        changed();
      } catch (err) {
        msg.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      }
    });
    root.querySelector('#ql-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const msg = root.querySelector('#ql-msg');
      try {
        S.settings = await api.put('/api/settings', { qlUser: field(form, 'qlUser'), qlPass: form.elements.qlPass.value });
        toast('تم حفظ إعدادات QuickLine');
        changed();
      } catch (err) {
        msg.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      }
    });
    root.querySelector('#settings-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const msg = root.querySelector('#settings-msg');
      msg.innerHTML = '';
      try {
        S.settings = await api.put('/api/settings', {
          appName: field(form, 'appName'), warnDays: field(form, 'warnDays'), lowBalance: field(form, 'lowBalance'),
          esimFee: field(form, 'esimFee'), supportWhatsapp: field(form, 'supportWhatsapp'),
        });
        toast('تم حفظ الإعدادات');
        changed({ keepView: true });
        document.querySelectorAll('.brand b').forEach((b) => { b.textContent = S.settings.appName; });
      } catch (err) {
        msg.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      }
    });
  },
  actions: {
    async tab(btn, e, ctx) {
      V.tab = btn.dataset.tab;
      if (V.tab === 'whatsapp') V.wa = await api.get('/api/whatsapp').catch(() => null);
      ctx.rerender();
    },
    async 'wa-connect'(btn) {
      const box = document.getElementById('wa-status');
      btn.disabled = true;
      box.insertAdjacentHTML('afterbegin', `<div class="msg info">${icon('clock')}<span>جارٍ تجهيز رمز QR…</span></div>`);
      try {
        V.wa = await api.post('/api/whatsapp/connect', { fresh: btn.dataset.fresh === '1' });
      } catch (err) {
        V.wa = { ...(V.wa || {}), status: 'off', error: err.message };
      }
      box.innerHTML = waStatusHtml(V.wa);
    },
    async 'wa-logout'(btn) {
      if (!confirm('إلغاء ربط واتساب المتجر بالسيرفر؟ يتوقف الرد التلقائي حتى تربطه من جديد.')) return;
      btn.disabled = true;
      try { V.wa = await api.post('/api/whatsapp/logout'); } catch (err) { toast(err.message, { error: true }); }
      document.getElementById('wa-status').innerHTML = waStatusHtml(V.wa);
    },
    async 'wa-test'() {
      const phone = prompt('رقم الهاتف الذي تصله الرسالة التجريبية (مثل 0599123456):');
      if (!phone) return;
      try {
        await api.post('/api/whatsapp/test', { phone });
        toast('أُرسلت الرسالة');
      } catch (err) {
        toast(err.message, { error: true });
      }
    },
    async 'art-check'(btn) {
      const box = document.getElementById('art-msg');
      btn.disabled = true;
      try {
        const r = await api.post('/api/art/check');
        box.innerHTML = `<div class="msg info">${icon('checkCircle')}<span>تم الاتصال بـ art-topup. الرصيد: ${r.balance === null ? 'غير معروف' : `${r.balance} ₪`}</span></div>`;
      } catch (err) {
        box.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      } finally { btn.disabled = false; }
    },
    async 'aylol-check'(btn) {
      const box = document.getElementById('aylol-msg');
      btn.disabled = true;
      try {
        const r = await api.post('/api/aylol/check');
        box.innerHTML = `<div class="msg info">${icon('checkCircle')}<span>تم الاتصال بـ أيلول تيليكوم بنجاح (${esc(r.user || '')}).</span></div>`;
      } catch (err) {
        box.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      } finally { btn.disabled = false; }
    },
    async 'ql-check'(btn) {
      const box = document.getElementById('ql-msg');
      btn.disabled = true;
      try {
        const r = await api.post('/api/quickline/check');
        box.innerHTML = `<div class="msg info">${icon('checkCircle')}<span>تم الاتصال بـ QuickLine باسم ${esc(r.name || '')}. الرصيد: ${r.credit === null ? 'غير معروف' : `${r.credit} ₪`} · خطوط فعّالة: ${r.active ?? '—'} · مدفوعات مفتوحة: ${r.openPayments ?? '—'} ₪</span></div>`;
      } catch (err) {
        box.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      } finally { btn.disabled = false; }
    },
    async 'ly-check'(btn) {
      const box = document.getElementById('ly-msg');
      btn.disabled = true;
      try {
        const r = await api.post('/api/layan/check');
        box.innerHTML = `<div class="msg info">${icon('checkCircle')}<span>تم الدخول إلى ليان. الرصيد: ${r.balance === null ? 'غير معروف' : `${r.balance} ₪`} · أرقام الوكالة: ${r.numbers} (فعّالة ${r.active}، موقوفة ${r.suspended})</span></div>`;
      } catch (err) {
        box.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      } finally { btn.disabled = false; }
    },
    async 'tc-check'(btn) {
      const box = document.getElementById('tc-msg');
      btn.disabled = true;
      box.innerHTML = `<div class="msg info">${icon('clock')}<span>جارٍ الدخول وانتظار رمز التحقق في الجيميل…</span></div>`;
      try {
        const r = await api.post('/api/telecom/check');
        box.innerHTML = `<div class="msg info">${icon('checkCircle')}<span>تم الدخول إلى telecom برمز التحقق من الجيميل. الرصيد: ${r.balance === null ? 'غير معروف' : `${r.balance} ₪`} · المشتركون: ${r.subscribers} (فعّالون ${r.active})</span></div>`;
      } catch (err) {
        box.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      } finally { btn.disabled = false; }
    },
    async 'tc-mail-check'(btn) {
      const box = document.getElementById('tc-msg');
      btn.disabled = true;
      try {
        await api.post('/api/telecom/mail-check');
        box.innerHTML = `<div class="msg info">${icon('checkCircle')}<span>الدخول إلى الجيميل يعمل.</span></div>`;
      } catch (err) {
        box.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      } finally { btn.disabled = false; }
    },
    async 'cloud-backup'(btn) {
      btn.disabled = true;
      try {
        const r = await api.post('/api/backup/cloud');
        toast(`تم حفظ النسخة (${Math.max(1, Math.round(r.bytes / 1024))} KB)`);
      } catch (err) {
        toast(err.message, { error: true });
      }
      S.settings = await api.get('/api/settings');
      document.getElementById('cloud-backup').innerHTML = cloudBackupHtml(S.settings);
      btn.disabled = false;
    },
    async backup() {
      const blob = await api.blob('/api/backup');
      downloadBlob(blob, `agents-backup-${new Date().toISOString().slice(0, 10)}.db`);
      toast('تم تنزيل النسخة الاحتياطية');
    },
  },
};
