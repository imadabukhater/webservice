import { S, api, esc, icon, setToken } from '../core.js';

export async function renderLogin(onDone) {
  let appName = S.settings.appName;
  try { appName = (await api.get('/api/public')).appName; } catch { /* offline: keep the default */ }
  document.title = `تسجيل الدخول · ${appName}`;
  document.getElementById('app').innerHTML = `
  <div class="login">
    <section class="login-art">
      <div class="brand" style="padding:0"><span class="brand-mark" style="color:#1d68ec">${icon('logo')}</span>
        <div><b>${esc(appName)}</b><small>بوابة المبيعات للوكلاء</small></div></div>
      <div>
        <h1>كل خطوطك وأرصدتك في مكان واحد</h1>
        <p>فعّل الخطوط، مدّد الرزم، تابع الأرقام التي تقترب من الفصل، واطلب شحن رصيدك من هاتفك.</p>
      </div>
      <div class="login-feats">
        <div><span class="tile sm">${icon('scan')}</span>مسح باركود الشريحة بالكاميرا ومعرفة الشركة تلقائياً</div>
        <div><span class="tile sm">${icon('calX')}</span>تنبيه قبل انتهاء رزمة أي زبون</div>
        <div><span class="tile sm">${icon('chart')}</span>تقارير جاهزة للتصدير إلى Excel وPDF</div>
      </div>
    </section>
    <section class="login-form">
      <form class="login-card" id="login-form" autocomplete="on" novalidate>
        <div><h2>تسجيل الدخول</h2><p>أدخل اسم المستخدم وكلمة المرور التي أعطاك إياها المدير.</p></div>
        <div class="field"><label for="login-user">اسم المستخدم</label>
          <input class="input ltr" id="login-user" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
        <div class="field"><label for="login-pass">كلمة المرور</label>
          <div class="pw-wrap"><input class="input ltr" id="login-pass" name="password" type="password" autocomplete="current-password" required>
            <button type="button" class="icon-btn plain" id="pw-toggle" aria-label="إظهار كلمة المرور">${icon('eye')}</button></div></div>
        <div id="login-msg"></div>
        <button class="btn btn-primary btn-lg btn-block" type="submit">دخول ${icon('arrowL')}</button>
      </form>
    </section>
  </div>`;
  const form = document.getElementById('login-form');
  const pass = document.getElementById('login-pass');
  document.getElementById('pw-toggle').addEventListener('click', (e) => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    e.currentTarget.innerHTML = icon(show ? 'eyeOff' : 'eye');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const msg = document.getElementById('login-msg');
    msg.innerHTML = '';
    const username = form.username.value.trim();
    if (!username || !pass.value) {
      msg.innerHTML = `<div class="msg">${icon('alert')}<span>أدخل اسم المستخدم وكلمة المرور.</span></div>`;
      return;
    }
    btn.disabled = true;
    try {
      const r = await api.post('/api/login', { username, password: pass.value });
      setToken(r.token);
      S.user = r.user;
      S.settings = r.settings;
      await onDone();
    } catch (err) {
      msg.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      btn.disabled = false;
    }
  });
}
