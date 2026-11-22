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
const WA_LABEL = { off: 'غير مربوط', missing: 'مكتبة واتساب غير مثبتة على السيرفر', connecting: 'جارٍ الاتصال…', qr: 'امسح رمز QR من هاتف المتجر', code: 'أدخل الكود على هاتف المتجر', connected: 'مربوط ويعمل' };
// Every number linked to the shop (one card each), the button to add one, and the bot's switch (for all of them).
function waStatusHtml(w) {
  if (!w) return `<div class="msg">${icon('alert')}<span>تعذّر جلب حالة واتساب.</span></div>`;
  const list = w.links?.length ? w.links : [{ ...w, id: 'main' }];
  const cards = list.map((l, i) => `<div class="card card-pad" style="margin-bottom:12px" data-wa-link="${esc(l.id)}">
      <div class="row between" style="gap:8px;flex-wrap:wrap;margin-bottom:8px"><b>رقم واتساب ${i + 1}</b>
        ${l.id !== 'main' ? `<button class="btn btn-sm" type="button" data-action="wa-remove" data-id="${esc(l.id)}">${icon('trash')}حذف الرقم</button>` : ''}</div>
      ${waLinkHtml(l)}</div>`).join('');
  const canAdd = list.length < (w.maxLinks || 5);
  return `${cards}
    ${canAdd ? `<button class="btn" type="button" data-action="wa-add">${icon('plus')}إضافة رقم واتساب</button>
      <p class="hint">كل رقم يُربط من هاتفه. كل زبون يرد عليه البوت من نفس الرقم اللي كتبله عليه.</p>` : `<p class="hint">وصلت للحد الأقصى (${w.maxLinks || 5} أرقام).</p>`}
    <div class="msg ${w.config?.enabled === false ? '' : 'info'}" style="margin-top:12px">${icon(w.config?.enabled === false ? 'alert' : 'checkCircle')}
      <span class="grow"><b>${w.config?.enabled === false ? 'البوت موقوف: ما بيرد على حدا' : 'البوت شغّال: بيرد على الرسائل'}</b>${list.length > 1 ? ' <small>(على كل الأرقام)</small>' : ''}</span>
      <button class="btn btn-sm ${w.config?.enabled === false ? 'btn-primary' : ''}" type="button" data-action="wa-replies" data-on="${w.config?.enabled === false ? '1' : '0'}">
        ${icon(w.config?.enabled === false ? 'play' : 'power')}${w.config?.enabled === false ? 'تشغيل البوت' : 'إيقاف البوت'}</button></div>`;
}
// One number: its state, its QR code or pairing code, and its buttons.
function waLinkHtml(w) {
  const busy = w.status === 'connecting' || w.status === 'qr' || w.status === 'code';
  return `<div class="msg ${w.status === 'connected' ? 'info' : ''}">${icon(w.status === 'connected' ? 'checkCircle' : w.status === 'qr' ? 'qr' : 'whatsapp')}
      <span><b>${WA_LABEL[w.status] || WA_LABEL.off}</b>${w.phone ? ` · <span class="ltr">${esc(w.phone)}</span>` : ''}</span></div>
    ${w.status === 'qr' && w.qr ? `<div style="text-align:center;margin:12px 0">
      <img src="${esc(w.qr)}" alt="رمز QR لربط واتساب" style="width:260px;max-width:100%;background:#fff;padding:8px;border-radius:12px">
      <p class="muted small">في هاتف المتجر: واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز، ثم امسح الرمز. يتجدّد الرمز كل نحو 20 ثانية.</p></div>` : ''}
    ${w.status === 'code' && w.pairCode ? `<div style="text-align:center;margin:12px 0">
      <div class="ltr mono" style="font-size:34px;font-weight:800;letter-spacing:4px">${esc(w.pairCode)}</div>
      <p class="muted small">في هاتف المتجر: واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز ← «الربط برقم الهاتف بدلاً من ذلك»، ثم أدخل هذا الكود. صالح لدقائق.</p></div>` : ''}
    ${w.error ? `<div class="msg">${icon('alert')}<span>${esc(w.error)}</span></div>` : ''}
    <div class="btn-row">
      ${w.status === 'connected'
        ? `<button class="btn" type="button" data-action="wa-logout" data-id="${esc(w.id)}">${icon('logout')}إلغاء الربط</button>`
        : `<button class="btn btn-primary" type="button" data-action="wa-connect" data-id="${esc(w.id)}" ${busy ? 'disabled' : ''}>${icon('qr')}ربط واتساب</button>
           ${busy ? `<button class="btn" type="button" data-action="wa-connect" data-id="${esc(w.id)}" data-fresh="1">${icon('refresh')}رمز جديد</button>` : ''}`}
    </div>
    ${w.status === 'connected' ? '' : `<div class="field" style="margin-top:12px"><label for="wa-pair-phone-${esc(w.id)}">أو اربط برقم الهاتف بدل مسح الرمز</label>
      <div class="row" style="gap:8px"><input class="input ltr grow" id="wa-pair-phone-${esc(w.id)}" inputmode="tel" placeholder="رقم واتساب 05XXXXXXXX">
      <button class="btn" type="button" data-action="wa-pair" data-id="${esc(w.id)}">${icon('phone')}اطلب كود</button></div>
      <span class="hint">مفيد إذا هاتف هذا الرقم هو نفس الجهاز اللي فاتح عليه البوابة.</span></div>`}`;
}
// What changes on screen (the QR codes rotate; a number comes up once scanned).
const waSig = (w) => JSON.stringify([(w?.links || []).map((l) => [l.id, l.status, l.qr, l.phone, l.error, l.pairCode]), w?.config?.enabled]);
function waHtml(w) {
  const c = w?.config || {};
  return `
        <section class="card card-pad form">
          <h2 class="dot-title">واتساب المتجر</h2>
          <p class="muted small">يربط رقم واتساب المتجر بالسيرفر (مثل واتساب ويب). بعدها يرد تلقائياً: <b>الزبون</b> يشتري eSIM في المحادثة: يختار الشركة ثم الخدمة ثم الباقة، فيُحجز له طلب حقيقي في المتجر، ثم يرسل اسم المحوِّل أو الرقم المرجعي أو صورة الإشعار، فيُفحص التحويل في إشعارات جوال باي، ويصله التفعيل ورمز eSIM في المحادثة. مع المساعد الذكي يرد على الأسئلة الحرة من باقاتك وأسعارك.</p>
          <div id="wa-status">${waStatusHtml(w)}</div>
        </section>
        <section class="card card-pad form">
          <h2 class="dot-title">الإعدادات (للعرض فقط)</h2>
          <div class="msg info">${icon('info')}<span>تُعدَّل إعدادات واتساب والمساعد الذكي وحد الصرف على السيرفر من صاحب الحساب فقط. من هنا تستطيع ربط واتساب وإلغاء ربطه.</span></div>
          <div class="kv small">
            <div>الرد على الرسائل</div><div>${c.enabled ? 'يعمل' : 'موقوف'}</div>
            <div>الرد على الزبائن</div><div>${c.customers ? 'يعمل' : 'موقوف'}</div>
            <div>أرقام المدير</div><div class="ltr">${esc(c.admins || '—')}</div>
            <div>المساعد الذكي</div><div>Google Cloud (Vertex AI) · <span class="ltr">${esc(c.aiModel || '')}</span>${Number(c.aiDailyUsd) > 0 ? '' : ' · <b>موقوف (الحد 0)</b>'}</div>
            <div>حد الصرف اليومي</div><div class="ltr">$${c.aiDailyUsd ?? '—'}</div>
            <div>صرف اليوم</div><div class="ltr">${c.aiSpend ? `$${Number(c.aiSpend.usd).toFixed(3)} · ${c.aiSpend.calls}` : '—'}</div>
          </div>
          ${w?.aiError ? `<div class="msg">${icon('alert')}<span>آخر خطأ من المساعد: ${esc(w.aiError)}</span></div>` : ''}
        </section>
`;
}

export default {
  title: () => ({ title: 'الإعدادات', subtitle: 'اسم التطبيق، الرسوم، المورّدون، واتساب والنسخ الاحتياطي' }),
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
            <span class="hint">يظهر في شاشة الدخول والقائمة.</span></div>
          <div class="row2 stack-xs">
            <div class="field"><label for="st-esim">رسوم تفعيل eSIM (₪)</label><input class="input ltr" id="st-esim" name="esimFee" type="number" min="0" step="0.5" value="${s.esimFee}">
              <span class="hint">السعر العام لرمز QR، يُضاف إلى سعر الزبون (إلا إن حددت سعراً للشركة). 0 لإلغائها.</span></div>
            <div class="field"><label for="st-wa">واتساب الدعم الفني</label><input class="input ltr" id="st-wa" name="supportWhatsapp" inputmode="tel" placeholder="972567725080" value="${esc(s.supportWhatsapp)}">
              <span class="hint">بالصيغة الدولية بدون + أو 0 في البداية. يظهر للزبائن في المتجر وفي رسالة رمز eSIM. اتركه فارغاً لإخفائه.</span></div>
          </div>
          <div class="field"><label for="st-gsc">كود تحقق Google Search Console <span class="muted">(اختياري)</span></label>
            <input class="input ltr" id="st-gsc" name="googleSiteVerification" placeholder="الصق كود content أو وسم meta من Google Search Console" value="${esc(s.googleSiteVerification || '')}">
            <span class="hint">يُضاف تلقائياً للصفحة الرئيسية وصفحات الباقات لتأكيد الملكية في Google Search Console. رابط الخريطة: <b class="ltr">https://www.hotesim.shop/sitemap.xml</b></span></div>
          <div id="settings-msg"></div>
          <button class="btn btn-primary" type="submit">${icon('check')}حفظ الإعدادات</button>
        </form>
        <section class="card card-pad form">
          <h2 class="dot-title">تثبيت التطبيق على الهاتف</h2>
          <p class="muted">افتح الرابط في Chrome على أندرويد أو Safari على آيفون، ثم اختر «إضافة إلى الشاشة الرئيسية». يعمل التطبيق بعدها بأيقونته وبملء الشاشة.</p>
        </section>
`,
      suppliers: `
        <form class="card card-pad form" id="aylol-form" novalidate autocomplete="off">
            <h2 class="dot-title">eSIM عبر أيلول تيليكوم (Aylol)</h2>
            <p class="muted small">يفعّل السيرفر شرائح eSIM التي يشتريها الزبائن من حسابك في أيلول تيليكوم تلقائياً: الرقم يؤخذ من أرقام أيلول الجاهزة ولا يكتبه الزبون. قبل كل عملية يتأكد من سعر أيلول الحالي: إن ارتفع عن المعتمد لا يشتري، ويصلك تنبيه.</p>
            <div class="row2 stack-xs">
              <div class="field"><label for="aylol-user">البريد في أيلول</label><input class="input ltr" id="aylol-user" name="aylolUser" type="email" value="${esc(s.aylolUser || '')}" autocomplete="off"></div>
              <div class="field"><label for="aylol-pass">كلمة المرور</label><input class="input ltr" id="aylol-pass" name="aylolPass" type="password" autocomplete="new-password" placeholder="${s.aylolConfigured ? 'محفوظة — اتركها فارغة للإبقاء' : ''}"></div>
            </div>
            <div class="field"><label for="aylol-secret">المفتاح السري لـ Google Authenticator (التحقق بخطوتين)</label>
              <input class="input ltr" id="aylol-secret" name="aylolSecret" type="password" autocomplete="off" placeholder="${s.aylolHasSecret ? 'محفوظ — اتركه فارغاً للإبقاء' : 'المفتاح تحت رمز QR، أو رابط otpauth'}">
              <span class="hint">أيلول يطلب رمزاً من Google Authenticator بعد كلمة المرور. انسخ المفتاح المكتوب تحت رمز QR عند تفعيل التحقق بخطوتين في أيلول (أو رابط التصدير من التطبيق)، فيصنع السيرفر الرمز بنفسه. يبقى على السيرفر ولا يظهر بعد حفظه.</span></div>
            <div class="field"><label for="aylol-low">نبّهني عندما ينزل رصيد أيلول تحت (₪)</label>
              <input class="input ltr" id="aylol-low" name="aylolLowBalance" type="number" min="0" step="1" inputmode="numeric" value="${s.aylolLowBalance ?? 100}">
              <span class="hint">يصلك تنبيه في البوابة وعلى واتساب (مرة كل 6 ساعات على الأكثر). وأي طلب لا يكفيه الرصيد يُرفض قبل أن يدفع الزبون. 0 = بلا تنبيه.</span></div>
            <div class="msg info">${icon('info')}<span>بعد الحفظ تُزامَن رزم أيلول فوراً، ثم كل ساعتين تلقائياً. الأرقام المتاحة والسعر يُقرآن من أيلول مباشرة عند كل طلب. اختر ما يظهر في المتجر من «الرزم»؛ السعر تلقائي.</span></div>
            <div id="aylol-msg"></div>
            <div class="btn-row">
              <button class="btn btn-primary" type="submit">${icon('check')}حفظ</button>
              <button class="btn" type="button" data-action="aylol-check" ${s.aylolConfigured ? '' : 'disabled'}>${icon('wallet')}اختبار الاتصال</button>
              <a class="btn" href="#/catalog">${icon('box')}الرزم</a>
            </div>
          </form>
          <form class="card card-pad form" id="ql-form" novalidate autocomplete="off">
          <h2 class="dot-title">eSIM عبر QuickLine</h2>
          <p class="muted small">يفعّل السيرفر شرائح eSIM التي يشتريها الزبائن من حسابك في QuickLine تلقائياً، على رقم من أرقامهم المتاحة.</p>
          <div class="row2 stack-xs">
            <div class="field"><label for="ql-user">البريد في QuickLine</label><input class="input ltr" id="ql-user" name="qlUser" type="email" value="${esc(s.qlUser || '')}" autocomplete="off"></div>
            <div class="field"><label for="ql-pass">كلمة المرور</label><input class="input ltr" id="ql-pass" name="qlPass" type="password" autocomplete="new-password" placeholder="${s.qlConfigured ? 'محفوظة — اتركها فارغة للإبقاء' : ''}"></div>
          </div>
          <div class="msg info">${icon('info')}<span>اختر ما يظهر في المتجر من «الرزم»؛ السعر تلقائي (سعر المورّد + نسبة ربحك، تحددها في «الرزم»).</span></div>
          <div id="ql-msg"></div>
          <div class="btn-row">
            <button class="btn btn-primary" type="submit">${icon('check')}حفظ</button>
            <button class="btn" type="button" data-action="ql-check" ${s.qlConfigured ? '' : 'disabled'}>${icon('wallet')}اختبار الاتصال والرصيد</button>
            <a class="btn" href="#/catalog">${icon('box')}الرزم</a>
          </div>
        </form>
        <form class="card card-pad form" id="ly-form" novalidate autocomplete="off">
          <h2 class="dot-title">eSIM عبر ليان</h2>
          <p class="muted small">يفعّل السيرفر شرائح eSIM التي يشتريها الزبائن من حسابك في ليان، بعد أن يتأكد من السعر. يدخل إلى ليان بنفسه، ويصنع رمز المصادقة من المفتاح السري.</p>
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
            <a class="btn" href="#/catalog">${icon('box')}الرزم</a>
          </div>
        </form>
        <form class="card card-pad form" id="tc-form" novalidate autocomplete="off">
          <h2 class="dot-title">telecom.co.il</h2>
          <p class="muted small">عند الدخول يرسل الموقع رمز تحقق إلى الجيميل. يقرأ السيرفر الرمز بنفسه من ذلك الجيميل بكلمة مرور تطبيق (App password)، دون أن يعلّم الرسائل كمقروءة. يفعّل السيرفر شرائح eSIM (ALOHA) التي يشتريها الزبائن من حسابك في telecom تلقائياً. اختر ما يظهر في المتجر من «الرزم».</p>
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
          <p class="muted">كل البيانات (الرزم، الطلبات، المشترون، الإعدادات) في ملف واحد. نزّل نسخة بانتظام واحفظها في مكان آمن.</p>
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
          if (waSig(w) !== waSig(V.wa) && !document.querySelector('#wa-status input:focus')) {
            V.wa = w;
            box.innerHTML = waStatusHtml(w);
          }
        } catch {}
      }, 3000);
    }
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
        S.settings = await api.put('/api/settings', { aylolUser: field(form, 'aylolUser'), aylolPass: form.elements.aylolPass.value, aylolSecret: form.elements.aylolSecret.value, aylolLowBalance: field(form, 'aylolLowBalance') });
        form.elements.aylolPass.value = '';
        form.elements.aylolSecret.value = '';
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
          appName: field(form, 'appName'), esimFee: field(form, 'esimFee'), supportWhatsapp: field(form, 'supportWhatsapp'),
          googleSiteVerification: field(form, 'googleSiteVerification'),
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
      const id = btn.dataset.id || 'main';
      const box = document.getElementById('wa-status');
      btn.disabled = true;
      box.insertAdjacentHTML('afterbegin', `<div class="msg info">${icon('clock')}<span>جارٍ تجهيز رمز QR…</span></div>`);
      try {
        V.wa = await api.post('/api/whatsapp/connect', { id, fresh: btn.dataset.fresh === '1' });
      } catch (err) {
        toast(err.message, { error: true });
        V.wa = V.wa?.links?.length
          ? { ...V.wa, links: V.wa.links.map((l) => (l.id === id ? { ...l, status: 'off', error: err.message } : l)) }
          : { ...(V.wa || {}), id, status: 'off', error: err.message };
      }
      box.innerHTML = waStatusHtml(V.wa);
    },
    async 'wa-replies'(btn) {
      const on = btn.dataset.on === '1';
      if (!on && !confirm('إيقاف البوت؟ ما رح يرد على الزباين لحد ما تشغّله، وواتساب بيضل مربوط.')) return;
      btn.disabled = true;
      try {
        V.wa = await api.post('/api/whatsapp/replies', { on });
        toast(on ? 'البوت شغّال' : 'البوت موقوف');
      } catch (err) {
        toast(err.message, { error: true });
      }
      document.getElementById('wa-status').innerHTML = waStatusHtml(V.wa);
    },
    async 'wa-pair'(btn) {
      const id = btn.dataset.id || 'main';
      const phone = (document.getElementById(`wa-pair-phone-${id}`)?.value || '').trim();
      if (!phone) { toast('اكتب رقم واتساب المتجر', { error: true }); return; }
      const box = document.getElementById('wa-status');
      btn.disabled = true;
      box.insertAdjacentHTML('afterbegin', `<div class="msg info">${icon('clock')}<span>جارٍ طلب كود الربط…</span></div>`);
      try {
        V.wa = await api.post('/api/whatsapp/connect', { id, phone });
      } catch (err) {
        toast(err.message, { error: true });
        V.wa = V.wa?.links?.length
          ? { ...V.wa, links: V.wa.links.map((l) => (l.id === id ? { ...l, status: 'off', error: err.message } : l)) }
          : { ...(V.wa || {}), id, status: 'off', error: err.message };
      }
      box.innerHTML = waStatusHtml(V.wa);
    },
    async 'wa-logout'(btn) {
      if (!confirm('إلغاء ربط هذا الرقم بالسيرفر؟ يتوقف الرد التلقائي عليه حتى تربطه من جديد.')) return;
      btn.disabled = true;
      try { V.wa = await api.post('/api/whatsapp/logout', { id: btn.dataset.id || 'main' }); } catch (err) { toast(err.message, { error: true }); }
      document.getElementById('wa-status').innerHTML = waStatusHtml(V.wa);
    },
    async 'wa-add'(btn) {
      btn.disabled = true;
      try {
        V.wa = await api.post('/api/whatsapp/links');
        toast('أُضيفت خانة رقم جديد — اضغط «ربط واتساب» فيها');
      } catch (err) { toast(err.message, { error: true }); }
      document.getElementById('wa-status').innerHTML = waStatusHtml(V.wa);
    },
    async 'wa-remove'(btn) {
      if (!confirm('حذف هذا الرقم؟ يُلغى ربطه بالسيرفر ويتوقف الرد عليه.')) return;
      btn.disabled = true;
      try { V.wa = await api.del(`/api/whatsapp/links/${encodeURIComponent(btn.dataset.id)}`); } catch (err) { toast(err.message, { error: true }); }
      document.getElementById('wa-status').innerHTML = waStatusHtml(V.wa);
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
        box.innerHTML = `<div class="msg info">${icon('checkCircle')}<span>تم الاتصال بـ QuickLine باسم ${esc(r.name || '')}. الرصيد: ${r.credit === null ? 'غير معروف' : `${esc(r.credit)} ₪`} · خطوط فعّالة: ${esc(r.active ?? '—')} · مدفوعات مفتوحة: ${esc(r.openPayments ?? '—')} ₪</span></div>`;
      } catch (err) {
        box.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      } finally { btn.disabled = false; }
    },
    async 'ly-check'(btn) {
      const box = document.getElementById('ly-msg');
      btn.disabled = true;
      try {
        const r = await api.post('/api/layan/check');
        box.innerHTML = `<div class="msg info">${icon('checkCircle')}<span>تم الدخول إلى ليان. الرصيد: ${r.balance === null ? 'غير معروف' : `${esc(r.balance)} ₪`} · أرقام الوكالة: ${esc(r.numbers)} (فعّالة ${esc(r.active)}، موقوفة ${esc(r.suspended)})</span></div>`;
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
        box.innerHTML = `<div class="msg info">${icon('checkCircle')}<span>تم الدخول إلى telecom برمز التحقق من الجيميل. الرصيد: ${r.balance === null ? 'غير معروف' : `${esc(r.balance)} ₪`} · المشتركون: ${esc(r.subscribers)} (فعّالون ${esc(r.active)})</span></div>`;
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
      downloadBlob(blob, `esim-shop-backup-${new Date().toISOString().slice(0, 10)}.db`);
      toast('تم تنزيل النسخة الاحتياطية');
    },
  },
};
