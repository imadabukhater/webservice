import {
  S, api, esc, icon, toast, isAdmin, setToken, onUnauthorized, fmtMoney, initials,
  sheet, closeAllSheets, navigate, go, relTime, field, skeleton, pushOverlayState, overlayBack, registerDrawer, setDrawerOpen,
  tz, loadCatalog,
} from './core.js';
import { renderLogin } from './views/login.js';
import home from './views/home.js';
import wizard from './views/wizard.js';
import renew from './views/renew.js';
import subscribers from './views/subscribers.js';
import tasks from './views/tasks.js';
import reports from './views/reports.js';
import offers from './views/offers.js';
import payments, { openTopupRequest, openAgentBalance } from './views/payments.js';
import sims from './views/sims.js';
import agents from './views/agents.js';
import catalog from './views/catalog.js';
import settings from './views/settings.js';

const VIEWS = { home, new: wizard, renew, subscribers, tasks, reports, offers, payments, sims, agents, catalog, settings };

const NAV = {
  agent: [
    ['home', 'الرئيسية', 'grid'], ['tasks', 'المهام', 'tasks', 'tasks'], ['reports', 'التقارير', 'chart'],
    ['subscribers', 'المشتركون', 'phone'], ['offers', 'العروض', 'percent'], ['payments', 'المدفوعات', 'wallet'], ['sims', 'مخزون الشرائح', 'sim'],
  ],
  admin: [
    ['home', 'الرئيسية', 'grid'], ['tasks', 'المهام', 'tasks', 'tasks'], ['reports', 'التقارير', 'chart'],
    ['subscribers', 'المشتركون', 'phone'], ['agents', 'الوكلاء', 'users'], ['catalog', 'الشركات والرزم', 'box'],
    ['offers', 'العروض', 'percent'], ['payments', 'المدفوعات', 'wallet'], ['sims', 'مخزون الشرائح', 'sim'], ['settings', 'الإعدادات', 'sliders'],
  ],
};
const TABS = {
  agent: [['home', 'الرئيسية', 'home'], ['subscribers', 'المشتركون', 'phone'], ['new', '', 'plus'], ['reports', 'التقارير', 'chart'], ['menu', 'القائمة', 'menu']],
  admin: [['home', 'الرئيسية', 'home'], ['agents', 'الوكلاء', 'users'], ['new', '', 'plus'], ['tasks', 'المهام', 'tasks'], ['menu', 'القائمة', 'menu']],
};

// ---------- theme ----------
const THEMES = ['auto', 'light', 'dark'];
let theme = 'auto';
try { theme = localStorage.getItem('agents-theme') || 'auto'; } catch { /* storage blocked */ }
function applyTheme(t) {
  theme = THEMES.includes(t) ? t : 'auto';
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('agents-theme', theme); } catch { /* storage blocked */ }
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0a101b' : '#f1f4f9');
  const btn = document.getElementById('theme-btn');
  if (btn) btn.innerHTML = icon(theme === 'auto' ? 'auto' : theme === 'dark' ? 'moon' : 'sun');
}
applyTheme(theme);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(theme));

// ---------- shell ----------
const role = () => (isAdmin() ? 'admin' : 'agent');

function drawerHtml() {
  return `
    <div class="brand"><span class="brand-mark" style="color:#1d68ec">${icon('logo')}</span>
      <div><b>${esc(S.settings.appName)}</b><small>${isAdmin() ? 'لوحة المدير' : 'بوابة المبيعات'}</small></div></div>
    <nav class="nav">${NAV[role()].map(([r, label, ic, badge]) => `
      <a href="#/${r}" data-action="nav" data-route="${r}">${icon(ic)}<span>${label}</span>${badge ? `<span class="badge" data-badge="${badge}" hidden></span>` : ''}</a>`).join('')}
    </nav>
    <div class="drawer-foot" id="drawer-wallet"></div>`;
}

function walletHtml() {
  if (isAdmin()) {
    const t = S.adminTotals;
    return `<div class="wallet-mini">
      <span>مجموع أرصدة الوكلاء</span><b class="ltr">${t ? fmtMoney(t.balances) : '—'}</b>
      <div class="row"><span>ديون الوكلاء</span><span class="ltr">${t ? fmtMoney(t.debt) : '—'}</span></div>
      <button class="btn btn-sm" data-action="agent-balance">${icon('plus')}شحن رصيد وكيل</button></div>`;
  }
  const u = S.user;
  const used = u.creditLimit > 0 ? Math.min(100, Math.round((Math.max(0, -u.balance) / u.creditLimit) * 100)) : 0;
  return `<div class="wallet-mini">
    <span>الرصيد المتاح</span><b class="ltr">${fmtMoney(u.available)}</b>
    <div class="meter"><i style="width:${used}%"></i></div>
    <div class="row"><span>من سقف <span class="ltr">${fmtMoney(u.creditLimit)}</span></span><span>مستخدم ${used}%</span></div>
    <button class="btn btn-sm" data-action="topup-request">${icon('plus')}شحن الرصيد</button></div>`;
}

function renderShell() {
  document.getElementById('app').innerHTML = `
  <div class="shell">
    <aside class="drawer" id="drawer" aria-label="القائمة الرئيسية">${drawerHtml()}</aside>
    <div class="scrim" data-action="close-drawer"></div>
    <div class="main-col">
      <header class="topbar">
        <button class="icon-btn menu-btn" data-action="open-drawer" aria-label="فتح القائمة">${icon('menu')}</button>
        <div class="title" id="top-title"></div>
        <div class="top-actions">
          <button class="icon-btn" id="sync-btn" data-action="refresh" aria-label="تحديث البيانات">${icon('refresh')}<span class="dot"></span></button>
          <button class="icon-btn hide-xs" id="theme-btn" data-action="theme" aria-label="تبديل المظهر"></button>
          <button class="icon-btn" data-action="notifications" aria-label="التنبيهات">${icon('bell')}<span class="badge" data-badge="bell" hidden></span></button>
          <button class="avatar" data-action="account" aria-label="الحساب">${esc(initials(S.user.name))}</button>
        </div>
      </header>
      <div class="offline-bar" id="offline-bar" hidden>لا يوجد اتصال بالإنترنت — تُعرض آخر بيانات محمّلة</div>
      <main class="content" id="view"></main>
    </div>
    <nav class="tabbar" aria-label="تنقل سريع">${TABS[role()].map(([r, label, ic]) => r === 'new'
      ? `<a href="#/new" data-route="new" aria-label="مشترك جديد"><span class="fab">${icon(ic)}</span></a>`
      : r === 'menu' ? `<button data-action="open-drawer">${icon(ic)}<span>${label}</span></button>`
        : `<a href="#/${r}" data-route="${r}">${icon(ic)}<span>${label}</span></a>`).join('')}</nav>
  </div>`;
  applyTheme(theme);
  updateWallet();
  updateBadges();
}

function updateWallet() {
  const box = document.getElementById('drawer-wallet');
  if (box && S.user) box.innerHTML = walletHtml();
}

function updateBadges() {
  document.querySelectorAll('[data-badge]').forEach((b) => {
    const n = S.badges[b.dataset.badge] || 0;
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : n;
  });
  const sync = document.getElementById('sync-btn');
  sync?.querySelector('.dot')?.classList.toggle('off', !S.syncOk);
  const off = document.getElementById('offline-bar');
  if (off) off.hidden = S.syncOk;
}

function setActive(name) {
  document.querySelectorAll('[data-route]').forEach((a) => {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function setTitle(view, ctx) {
  const t = view.title?.(ctx) ?? '';
  const { title, subtitle } = typeof t === 'string' ? { title: t, subtitle: '' } : t;
  const box = document.getElementById('top-title');
  if (box) box.innerHTML = `<h1>${esc(title)}</h1>${subtitle ? `<small>${esc(subtitle)}</small>` : ''}`;
  document.title = `${title} · ${S.settings.appName}`;
}

// ---------- drawer (phones) ----------
const drawerMode = () => matchMedia('(max-width: 1023px)').matches;
async function openDrawer() {
  if (!drawerMode() || document.body.classList.contains('drawer-open')) return;
  document.body.classList.add('drawer-open');
  setDrawerOpen(true);
  pushOverlayState('drawer');
}
function hideDrawer() {
  document.body.classList.remove('drawer-open');
  setDrawerOpen(false);
}
async function closeDrawer() {
  if (!document.body.classList.contains('drawer-open')) return;
  hideDrawer();
  await overlayBack();
}
registerDrawer(hideDrawer);

// ---------- routing ----------
let current = { name: null, view: null, ctx: null };
let seq = 0;

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const [name, ...params] = path.split('/');
  return { name: name || 'home', params, query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

function errorState(e) {
  return `<div class="empty"><span class="tile red">${icon('alert')}</span><b>تعذّر تحميل الصفحة</b><span>${esc(e.message)}</span>
    <button class="btn btn-soft" data-action="refresh">${icon('refresh')}حاول مرة أخرى</button></div>`;
}

function paint() {
  const { view, ctx } = current;
  const main = document.getElementById('view');
  main.innerHTML = view.render(ctx);
  view.mount?.(main, ctx);
  setTitle(view, ctx);
}

async function route() {
  if (!S.user) return;
  const r = parseHash();
  const view = VIEWS[r.name];
  if (!view || (view.admin && !isAdmin())) return navigate('#/home');
  const my = ++seq;
  const ctx = {
    ...r,
    rerender: () => { if (current.ctx === ctx) paint(); },
    reload: async () => { if (current.ctx !== ctx) return; await view.load?.(ctx); if (current.ctx === ctx) paint(); },
  };
  current = { name: r.name, view, ctx };
  setActive(r.name);
  setTitle(view, ctx);
  const main = document.getElementById('view');
  main.innerHTML = view.skeleton ? view.skeleton(ctx) : skeleton(4);
  window.scrollTo(0, 0);
  try {
    await view.load?.(ctx);
  } catch (e) {
    if (my === seq) main.innerHTML = errorState(e);
    return;
  }
  if (my !== seq) return;
  paint();
}

async function refresh({ quiet = false } = {}) {
  const btn = document.getElementById('sync-btn');
  btn?.classList.add('spinning');
  try {
    await Promise.all([
      refreshBadges(),
      api.get('/api/me').then((r) => { S.user = r.user; S.settings = r.settings; updateWallet(); }),
      current.ctx?.reload(),
    ]);
    if (!quiet) toast('تم التحديث');
  } catch (e) {
    if (!quiet) toast(e.message, { error: true });
  } finally {
    btn?.classList.remove('spinning');
    updateBadges();
  }
}

async function refreshBadges() {
  try {
    const n = await api.get('/api/notifications');
    S.notifications = n;
    S.badges = n.badges;
    if (isAdmin()) {
      S.adminTotals = await api.get(`/api/dashboard?tz=${tz()}`);
      updateWallet();
    }
  } catch { /* offline: keep the last badges */ }
  updateBadges();
}

// ---------- notifications & account ----------
async function openNotifications() {
  let n = S.notifications;
  try { n = await api.get('/api/notifications'); } catch { /* show cached */ }
  if (!n) return;
  const alertIcon = { expiring: ['calX', 'amber'], expired: ['alert', 'red'], balance: ['wallet', 'red'], tasks: ['tasks', 'blue'] };
  const kindIcon = { offer: ['gift', 'red'], balance: ['wallet', 'green'], task: ['tasks', 'blue'], line: ['phone', 'cyan'] };
  const tile = ([ic, color]) => `<span class="tile sm ${color === 'blue' ? '' : color}">${icon(ic)}</span>`;
  sheet({
    title: 'التنبيهات',
    subtitle: n.unread ? `${n.unread} غير مقروءة` : 'لا جديد',
    body: `
      ${n.alerts.length ? `<div class="list">${n.alerts.map((a) => `<a class="alert-card" href="${esc(a.link)}" data-go="${esc(a.link)}">
        ${tile(alertIcon[a.kind] || ['info', 'blue'])}<span class="grow"><b>${esc(a.title)}</b><small>${esc(a.body)}</small></span>${icon('chevL')}</a>`).join('')}</div>` : ''}
      ${n.items.length ? `<div class="list" style="gap:4px">${n.items.map((i) => `<a class="notif ${i.unread ? 'unread' : ''}" href="${esc(i.link || '#/home')}" data-go="${esc(i.link || '#/home')}">
        ${tile(kindIcon[i.kind] || ['bell', 'blue'])}<span class="grow"><b>${esc(i.title)}</b>${i.body ? `<p>${esc(i.body)}</p>` : ''}<time>${relTime(i.ts)}</time></span></a>`).join('')}</div>`
        : n.alerts.length ? '' : `<div class="empty"><span class="tile">${icon('bell')}</span><b>لا توجد تنبيهات</b><span>ستظهر هنا تنبيهات الرصيد والعروض والطلبات.</span></div>`}`,
    onMount(form) {
      form.querySelectorAll('[data-go]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.go); }));
    },
  });
  if (n.unread) {
    api.post('/api/notifications/seen').then(() => {
      S.badges.bell = Math.max(0, S.badges.bell - n.unread);
      if (S.notifications) S.notifications.items.forEach((i) => { i.unread = false; });
      updateBadges();
    }).catch(() => {});
  }
}

function openAccount() {
  const u = S.user;
  sheet({
    title: 'الحساب',
    body: `
      <div class="item-top"><span class="avatar lg">${esc(initials(u.name))}</span>
        <div class="grow"><b class="item-title">${esc(u.name)}</b><div class="item-sub"><span class="ltr">@${esc(u.username)}</span><span>${isAdmin() ? 'المدير' : 'وكيل'}</span></div></div></div>
      <div class="field"><span class="label">المظهر</span>
        <div class="segmented" id="theme-seg">${[['auto', 'تلقائي'], ['light', 'فاتح'], ['dark', 'داكن']].map(([k, l]) => `<button type="button" data-theme-pick="${k}" aria-pressed="${theme === k}">${l}</button>`).join('')}</div></div>
      <div class="divider"></div>
      <h3>تغيير كلمة المرور</h3>
      <div class="field"><label for="pw-cur">كلمة المرور الحالية</label><input class="input ltr" id="pw-cur" name="current" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="pw-new">كلمة المرور الجديدة</label><input class="input ltr" id="pw-new" name="password" type="password" autocomplete="new-password" minlength="6">
        <span class="hint">6 أحرف على الأقل. سيُسجَّل خروجك من الأجهزة الأخرى.</span></div>
      <div class="divider"></div>
      <button type="button" class="btn btn-danger btn-block" id="logout-btn">${icon('logout')}تسجيل الخروج</button>`,
    submit: 'حفظ كلمة المرور',
    async onSubmit(form) {
      if (!field(form, 'current') || !field(form, 'password')) throw new Error('اكتب كلمة المرور الحالية والجديدة');
      await api.post('/api/me/password', { current: field(form, 'current'), password: field(form, 'password') });
      return 'تم تغيير كلمة المرور';
    },
    onMount(form) {
      form.querySelectorAll('[data-theme-pick]').forEach((b) => b.addEventListener('click', () => {
        applyTheme(b.dataset.themePick);
        form.querySelectorAll('[data-theme-pick]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }));
      form.querySelector('#logout-btn').addEventListener('click', logout);
    },
  });
}

async function logout() {
  try { await api.post('/api/logout'); } catch { /* already signed out */ }
  await closeAllSheets();
  setToken(null);
  S.user = null;
  S.catalog = null;
  history.replaceState(null, '', '#/home');
  renderLogin(onLoggedIn);
}

// ---------- global actions ----------
const GLOBAL = {
  'open-drawer': openDrawer,
  'close-drawer': closeDrawer,
  async nav(a) {
    if (document.body.classList.contains('drawer-open')) await closeDrawer();
    navigate(`#/${a.dataset.route}`);
  },
  theme: () => applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]),
  refresh: () => refresh(),
  notifications: openNotifications,
  account: openAccount,
  async 'topup-request'() { await closeDrawer(); openTopupRequest(() => refresh({ quiet: true })); },
  async 'agent-balance'() { await closeDrawer(); openAgentBalance(null, () => refresh({ quiet: true })); },
};

document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-action]');
  if (!a || a.closest('.overlay')) return;
  const name = a.dataset.action;
  const handler = current.view?.actions?.[name] || GLOBAL[name];
  if (!handler) return;
  e.preventDefault();
  try {
    await handler(a, e, current.ctx);
  } catch (err) {
    toast(err.message, { error: true });
  }
});

window.addEventListener('hashchange', route);
window.addEventListener('online', () => refresh({ quiet: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.user) refresh({ quiet: true });
});
setInterval(() => { if (document.visibilityState === 'visible' && S.user) refreshBadges(); }, 60_000);
// Fired by sheets after any change: refresh the open page, the badges and the wallet.
window.addEventListener('app:changed', (e) => {
  if (!S.user) return;
  if (!e.detail?.keepView) current.ctx?.reload().catch(() => {});
  refreshBadges();
  api.get('/api/me').then((r) => { S.user = r.user; updateWallet(); }).catch(() => {});
});

onUnauthorized(() => {
  if (!S.user) return;
  setToken(null);
  S.user = null;
  closeAllSheets();
  toast('انتهت الجلسة. سجّل الدخول مرة أخرى.', { error: true });
  renderLogin(onLoggedIn);
});

// ---------- boot ----------
async function onLoggedIn() {
  renderShell();
  loadCatalog(true).catch(() => {});
  if (!location.hash) history.replaceState(null, '', '#/home');
  await route();
  refreshBadges();
}

async function boot() {
  if (S.token) {
    try {
      const r = await api.get('/api/me');
      S.user = r.user;
      S.settings = r.settings;
    } catch (e) {
      if (e.status && e.status !== 401) {
        document.getElementById('app').innerHTML = `<div class="login-form" style="min-height:100dvh">${errorState(e)}</div>`;
        return;
      }
    }
  }
  if (S.user) await onLoggedIn();
  else renderLogin(onLoggedIn);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();

