import {
  S, api, esc, icon, money, greeting, firstName, tz, debounce, relTime, fmtDate, weekday, go, daysText,
} from '../core.js';
import { drawActivity } from '../chart.js';

const SERIES = { activate: 'مبيعات eSIM' };
const D = { dash: null, activity: null, series: 'activate', days: 30, table: false };
let resizeObserver;

const tileCls = (c) => (c === 'blue' ? '' : c);

function stat({ ic, color, value, label, href, link }) {
  return `<a class="stat" href="${href}">
    <div class="stat-top"><span class="tile ${tileCls(color)}">${icon(ic)}</span>${link ? `<span class="go">${link}${icon('arrowL')}</span>` : ''}</div>
    <b>${value}</b><span class="label">${label}</span></a>`;
}

function stats() {
  const d = D.dash;
  return `<div class="stats">
    ${stat({ ic: 'card', color: 'amber', value: d.shopOpen ?? 0, label: 'طلبات تحتاج تدخلك', href: '#/shop', link: 'المتجر' })}
    ${stat({ ic: 'qr', color: 'cyan', value: d.pendingActivations ?? 0, label: 'تفعيلات بانتظارك', href: '#/tasks' })}
    ${stat({ ic: 'users', color: 'green', value: d.buyers ?? 0, label: 'المشترون', href: '#/buyers' })}
    ${stat({ ic: 'trend', color: 'blue', value: d.today?.sales ?? 0, label: 'مبيعات اليوم', href: '#/reports?r=sales', link: 'للتقرير' })}
  </div>`;
}

// The manager's "is everything running?" card: suppliers, backups, and what waits.
const DAY = 864e5;
export function healthHtml(h) {
  const rows = [];
  const row = (state, label, text, href) => rows.push(`<a class="health-row" href="${href}"><span class="pill ${{ ok: 's-active', warn: 's-expiring', bad: 's-expired' }[state]}">${{ ok: 'سليم', warn: 'انتبه', bad: 'مشكلة' }[state]}</span>
    <span class="grow"><b>${label}</b><small>${text}</small></span>${icon('arrowL')}</a>`);
  const supplier = (name, x) => {
    if (!x) return;
    if (x.error) return row('bad', name, `تعذّر الاتصال: ${esc(x.error)}`, '#/settings?tab=suppliers');
    const synced = x.synced ? `آخر مزامنة ${relTime(x.synced)}` : 'لم تتم المزامنة بعد';
    row(x.synced && Date.now() - x.synced < 7 * DAY ? 'ok' : 'warn', name, `الرصيد ${x.balance === null || x.balance === undefined ? '—' : money(x.balance)} · ${synced}`, '#/catalog');
  };
  supplier('QuickLine', h.quickline);
  supplier('ليان', h.layan);
  supplier('telecom', h.telecom);
  supplier('أيلول', h.aylol);
  const b = h.backup;
  if (b) {
    if (b.error) row('bad', 'النسخ الاحتياطي', esc(b.error), '#/settings');
    else if (b.lastAt) row(Date.now() - b.lastAt < 1.5 * DAY ? 'ok' : 'warn', 'النسخ الاحتياطي', `آخر نسخة ${relTime(b.lastAt)}`, '#/settings');
    else row('warn', 'النسخ الاحتياطي', b.bucket ? 'لم تُحفظ نسخة بعد' : 'النسخ السحابي غير مفعّل', '#/settings');
  }
  if (h.tasks) {
    row(h.tasks.attention ? 'warn' : 'ok', 'التفعيلات', `${h.tasks.attention ? `${h.tasks.attention} تحتاج تدخلك` : 'لا شيء ينتظرك'}${h.tasks.running ? ` · ${h.tasks.running} تُنفَّذ تلقائياً` : ''}`, '#/tasks');
  }
  return `<h2 class="dot-title">حالة النظام</h2><div class="health">${rows.join('')}</div>`;
}

function kpis() {
  const d = D.dash;
  const k = (label, value) => `<div class="kpi"><span>${label}</span><b>${value}</b></div>`;
  return `<div class="kpis">${k('دخل اليوم', money(d.today?.revenue))}${k('مبيعات اليوم', `${d.today?.sales ?? 0}`)}
    ${k('دخل هذا الشهر', money(d.month?.revenue))}${k('مبيعات هذا الشهر', `${d.month?.sales ?? 0}`)}</div>`;
}

function chartCard() {
  const t = D.activity.totals;
  return `<section class="card chart-card" aria-labelledby="act-title">
    <div class="section-title"><div><h2 id="act-title">المبيعات</h2><span class="muted small">آخر ${daysText(D.days)} · ${t.activate ?? 0} eSIM</span></div>
      <div class="segmented" style="width:auto">${[7, 30, 90].map((n) => `<button data-action="days" data-days="${n}" aria-pressed="${D.days === n}">${n} يوماً</button>`).join('')}</div></div>
    <div class="chart" id="activity-chart" aria-describedby="act-title"></div>
    <div class="chart-foot"><span class="small muted">مرّر على الخط أو اضغط عليه لرؤية أرقام كل يوم</span>
      <button class="link" data-action="toggle-table">${icon('list')}${D.table ? 'إخفاء الجدول' : 'عرض كجدول'}</button></div>
    ${D.table ? `<div class="table-wrap"><table class="data"><thead><tr><th>اليوم</th>${Object.values(SERIES).map((l) => `<th>${l}</th>`).join('')}</tr></thead>
      <tbody>${[...D.activity.days].reverse().map((d) => `<tr><td>${weekday(d.ts)} ${fmtDate(d.ts)}</td>${Object.keys(SERIES).map((k) => `<td class="numc">${d[k] ?? 0}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
  </section>`;
}

export default {
  title: () => ({ title: `${greeting()}، ${firstName(S.user.name)}`, subtitle: S.settings.appName }),
  async load() {
    const [dash, activity] = await Promise.all([api.get(`/api/dashboard?tz=${tz()}`), api.get(`/api/activity?days=${D.days}&tz=${tz()}`)]);
    Object.assign(D, { dash, activity });
  },
  render() {
    return `
      <form class="search-box" id="home-search">${icon('search', 'i lead')}
        <input class="input" id="global-q" type="search" placeholder="ابحث عن مشترٍ بالاسم، الرقم أو رقم الطلب…" autocomplete="off" aria-label="بحث"></form>
      <div class="quick">
        <a class="btn btn-primary" href="#/shop">${icon('card')}متجر الزبائن</a>
        <a class="btn" href="#/tasks">${icon('qr')}التفعيلات</a>
        <a class="btn" href="#/buyers">${icon('users')}المشترون</a>
      </div>
      <section class="card card-pad" id="health"><h2 class="dot-title">حالة النظام</h2><p class="muted small">جاري الفحص…</p></section>
      ${stats()}
      ${kpis()}
      ${chartCard()}`;
  },
  mount(root) {
    const health = root.querySelector('#health');
    api.get('/api/health').then((h) => { if (health.isConnected) health.innerHTML = healthHtml(h); }).catch(() => { health.hidden = true; });
    const chart = root.querySelector('#activity-chart');
    const draw = () => drawActivity(chart, D.activity.days, D.series, SERIES);
    draw();
    resizeObserver?.disconnect();
    let lastW = chart.clientWidth;
    resizeObserver = new ResizeObserver(debounce(() => { if (chart.isConnected && Math.abs(chart.clientWidth - lastW) > 8) { lastW = chart.clientWidth; draw(); } }, 120));
    resizeObserver.observe(chart);
    root.querySelector('#home-search').addEventListener('submit', (e) => {
      e.preventDefault();
      const term = root.querySelector('#global-q').value.trim();
      go(`#/buyers${term ? `?q=${encodeURIComponent(term)}` : ''}`);
    });
  },
  actions: {
    async days(btn, e, ctx) {
      D.days = Number(btn.dataset.days);
      document.getElementById('activity-chart')?.classList.add('loading');
      D.activity = await api.get(`/api/activity?days=${D.days}&tz=${tz()}`);
      ctx.rerender();
    },
    'toggle-table'(btn, e, ctx) { D.table = !D.table; ctx.rerender(); },
  },
};
