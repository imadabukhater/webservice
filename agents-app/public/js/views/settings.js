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
    async backup() {
      const blob = await api.blob('/api/backup');
      downloadBlob(blob, `agents-backup-${new Date().toISOString().slice(0, 10)}.db`);
      toast('تم تنزيل النسخة الاحتياطية');
    },
  },
};
