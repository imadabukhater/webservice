import { S, api, icon, esc, field, toast, downloadBlob, changed } from '../core.js';

export default {
  admin: true,
  title: () => ({ title: 'الإعدادات', subtitle: 'اسم التطبيق، الرسوم، الدعم الفني والنسخ الاحتياطي' }),
  async load() { S.settings = await api.get('/api/settings'); },
  render() {
    const s = S.settings;
    return `
      <div class="two-col">
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
        <form class="card card-pad form" id="ql-form" novalidate autocomplete="off">
          <h2 class="dot-title">التمديد التلقائي عبر QuickLine</h2>
          <p class="muted small">يمدّد السيرفر خطوط الشركات المضبوطة على «تلقائي» من حسابك في QuickLine، ويُكمل الطلب بنفسه. التمديد يحتاج أن يكون الرقم موجوداً في QuickLine تحت وكالتك؛ تفعيل خط جديد يبقى طلباً عندك.</p>
          <div class="row2 stack-xs">
            <div class="field"><label for="ql-user">البريد في QuickLine</label><input class="input ltr" id="ql-user" name="qlUser" type="email" value="${esc(s.qlUser || '')}" autocomplete="off"></div>
            <div class="field"><label for="ql-pass">كلمة المرور</label><input class="input ltr" id="ql-pass" name="qlPass" type="password" autocomplete="new-password" placeholder="${s.qlConfigured ? 'محفوظة — اتركها فارغة للإبقاء' : ''}"></div>
          </div>
          <div class="msg info">${icon('info')}<span>المزامنة ونسبة الربح منفصلتان لكل نظام: افتح «الشركات والرزم» ← تبويب «تمديد QuickLine» أو «خطوط QuickLine».</span></div>
          <div id="ql-msg"></div>
          <div class="btn-row">
            <button class="btn btn-primary" type="submit">${icon('check')}حفظ</button>
            <button class="btn" type="button" data-action="ql-check" ${s.qlConfigured ? '' : 'disabled'}>${icon('wallet')}اختبار الاتصال والرصيد</button>
            <a class="btn" href="#/catalog">${icon('box')}الشركات والرزم</a>
          </div>
        </form>
        <section class="card card-pad form">
          <h2 class="dot-title">النسخ الاحتياطي</h2>
          <p class="muted">كل البيانات (الوكلاء، الأرصدة، الأرقام، السجل) في ملف واحد. نزّل نسخة بانتظام واحفظها في مكان آمن.</p>
          <button class="btn" data-action="backup">${icon('download')}تنزيل نسخة احتياطية</button>
          <div class="divider"></div>
          <h2 class="dot-title">تثبيت التطبيق على الهاتف</h2>
          <p class="muted">افتح الرابط في Chrome على أندرويد أو Safari على آيفون، ثم اختر «إضافة إلى الشاشة الرئيسية». يعمل التطبيق بعدها بأيقونته وبملء الشاشة.</p>
        </section>
      </div>`;
  },
  mount(root) {
    root.querySelector('#art-form').addEventListener('submit', async (e) => {
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
    root.querySelector('#ql-form').addEventListener('submit', async (e) => {
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
    root.querySelector('#settings-form').addEventListener('submit', async (e) => {
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
    async backup() {
      const blob = await api.blob('/api/backup');
      downloadBlob(blob, `agents-backup-${new Date().toISOString().slice(0, 10)}.db`);
      toast('تم تنزيل النسخة الاحتياطية');
    },
  },
};
