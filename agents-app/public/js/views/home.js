import {
  S, api, esc, icon, isAdmin, money, greeting, firstName, tz, statePill, phone, debounce, OP, OP_ICON, relTime,
  signedMoney, companyLogo, companyById, fmtIccid, fmtDate, weekday, go, daysText,
} from '../core.js';
import { drawActivity } from '../chart.js';
import { openLine } from './subscribers.js';
import { openAddSims } from './sims.js';
import { openAgentForm } from './agents.js';
import { offerCard } from './offers.js';

const SERIES = { total: 'إجمالي العمليات', activate: 'تفعيل جديد', renew: 'تمديد', swap_sim: 'تبديل شريحة' };
const D = { dash: null, activity: null, offers: [], ops: [], series: 'total', days: 30, table: false };
let resizeObserver;

// Clicking anywhere outside the search closes its results.
document.addEventListener('click', (e) => {
  const box = document.getElementById('search-results');
  if (box && !e.target.closest('#home-search')) box.hidden = true;
}, { capture: true });

const tileCls = (c) => (c === 'blue' ? '' : c);

function quickActions() {
  if (isAdmin()) {
    return `<div class="quick">
      <a class="btn btn-primary" href="#/new">${icon('userPlus')}مشترك جديد لوكيل</a>
      <button class="btn" data-action="add-agent">${icon('users')}إضافة وكيل</button>
      <button class="btn" data-action="agent-balance">${icon('wallet')}شحن رصيد وكيل</button>
      <button class="btn" data-action="add-sims">${icon('chip')}إضافة شرائح</button>
    </div>`;
  }
  return `<div class="quick">
    <a class="btn btn-primary" href="#/new">${icon('userPlus')}مشترك جديد</a>
    <a class="btn" href="#/renew">${icon('repeat')}زبون قائم</a>
    <a class="btn" href="#/new?type=external">${icon('bolt')}زبون مسبق الدفع خارجي</a>
    <button class="btn" data-action="add-sims">${icon('chip')}إضافة شرائح</button>
  </div>`;
}

function stat({ ic, color, value, label, href, link }) {
  return `<a class="stat" href="${href}">
    <div class="stat-top"><span class="tile ${tileCls(color)}">${icon(ic)}</span>${link ? `<span class="go">${link}${icon('arrowL')}</span>` : ''}</div>
    <b>${value}</b><span class="label">${label}</span></a>`;
}

function stats() {
  const d = D.dash;
  const warn = S.settings.warnDays;
  return `<div class="stats">
    ${stat({ ic: 'users', color: 'green', value: d.lines.active, label: 'الأرقام المفعّلة', href: '#/subscribers?state=active' })}
    ${stat({ ic: 'snow', color: 'violet', value: d.lines.frozen, label: 'الأرقام المجمّدة', href: '#/reports?r=frozen', link: 'للتقرير' })}
    ${stat({ ic: 'calX', color: 'amber', value: d.lines.expiring, label: `قيد الفصل - خلال ${daysText(warn)}`, href: '#/reports?r=expiring', link: 'للتقرير' })}
    ${stat({ ic: 'tasks', color: 'blue', value: isAdmin() ? d.openTasks : d.openTasks + d.lines.expiring, label: 'مهام مفتوحة', href: '#/tasks' })}
  </div>`;
}

function kpis() {
  const d = D.dash;
  const k = (label, value) => `<div class="kpi"><span>${label}</span><b>${value}</b></div>`;
  if (isAdmin()) {
    return `<div class="kpis">${k('أرباح اليوم', money(d.today.profit))}${k('أرباح هذا الشهر', money(d.month.profit))}
      ${k('مجموع أرصدة الوكلاء', money(d.balances))}${k('ديون الوكلاء', money(d.debt))}</div>`;
  }
  return `<div class="kpis">${k('الرصيد المتاح', money(d.available))}${k('مبيعات اليوم', `${d.today.activations + d.today.renewals}`)}
    ${k('ربحك هذا الشهر', money(d.month.margin))}${k('شرائح في مخزونك', d.sims)}</div>`;
}

function chartCard() {
  const t = D.activity.totals;
  return `<section class="card chart-card" aria-labelledby="act-title">
    <div class="section-title"><div><h2 id="act-title">النشاط</h2><span class="muted small">آخر ${daysText(D.days)}</span></div>
      <div class="segmented" style="width:auto">${[7, 30, 90].map((n) => `<button data-action="days" data-days="${n}" aria-pressed="${D.days === n}">${n} يوماً</button>`).join('')}</div></div>
    <div class="series-tabs" role="group" aria-label="اختر نوع العمليات">
      ${Object.entries(SERIES).map(([k, label]) => `<button data-action="series" data-key="${k}" aria-pressed="${D.series === k}"><b>${k === 'total' ? t.total : t[k]}</b>${label}</button>`).join('')}
    </div>
    <div class="chart" id="activity-chart" aria-describedby="act-title"></div>
    <div class="chart-foot"><span class="small muted">مرّر على الخط أو اضغط عليه لرؤية أرقام كل يوم</span>
      <button class="link" data-action="toggle-table">${icon('list')}${D.table ? 'إخفاء الجدول' : 'عرض كجدول'}</button></div>
    ${D.table ? `<div class="table-wrap"><table class="data"><thead><tr><th>اليوم</th>${Object.values(SERIES).map((l) => `<th>${l}</th>`).join('')}</tr></thead>
      <tbody>${[...D.activity.days].reverse().map((d) => `<tr><td>${weekday(d.ts)} ${fmtDate(d.ts)}</td>${Object.keys(SERIES).map((k) => `<td class="numc">${d[k]}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
  </section>`;
}

function opsCard() {
  return `<section class="card card-pad">
    <div class="section-title"><h2>آخر العمليات</h2><a class="link" href="#/reports?r=statement">كشف الحساب${icon('arrowL')}</a></div>
    ${D.ops.length ? `<div>${D.ops.map((o) => {
      const [ic, color] = OP_ICON[o.type] || ['info', 'blue'];
      return `<div class="op-row"><span class="tile sm ${tileCls(color)}">${icon(ic)}</span>
        <div class="grow"><b>${OP[o.type] || o.type}</b> ${o.number ? phone(o.number) : ''}
          <div class="item-sub">${o.package ? `<span>${esc(o.package)}</span>` : ''}${isAdmin() && o.agentName ? `<span>${esc(o.agentName)}</span>` : ''}<span>${relTime(o.ts)}</span></div></div>
        ${o.amount ? signedMoney(o.amount) : ''}</div>`;
    }).join('')}</div>` : `<p class="muted" style="padding:14px 0 4px">لا توجد عمليات بعد. ابدأ بتفعيل أول خط.</p>`}
  </section>`;
}

function searchResults(r) {
  if (!r.lines.length && !r.agents.length && !r.sims.length) return `<div class="group">لا نتائج</div>`;
  return `${r.lines.length ? `<div class="group">الأرقام</div>${r.lines.map((l) => `<button class="res" data-res-line="${l.id}">
      ${companyLogo(companyById(l.companyId), 'xs')}<span class="grow">${phone(l.number)}<span class="item-sub"><span>${esc(l.customerName || 'بدون اسم')}</span><span>${esc(l.packageLabel)}</span></span></span>${statePill(l.state)}</button>`).join('')}` : ''}
    ${r.agents.length ? `<div class="group">الوكلاء</div>${r.agents.map((a) => `<button class="res" data-res-go="#/agents?q=${encodeURIComponent(a.username)}">
      <span class="avatar sm">${esc(a.name[0] || '')}</span><span class="grow"><b>${esc(a.name)}</b><span class="item-sub ltr">@${esc(a.username)}</span></span>${money(a.balance)}</button>`).join('')}` : ''}
    ${r.sims.length ? `<div class="group">الشرائح</div>${r.sims.map((s) => `<button class="res" data-res-go="#/sims?q=${s.iccid}">
      <span class="tile sm">${icon('sim')}</span><span class="grow"><b class="mono ltr">${fmtIccid(s.iccid)}</b><span class="item-sub"><span>${esc(s.companyName)}</span><span>${s.status === 'available' ? 'متاحة' : 'مستعملة'}</span></span></span></button>`).join('')}` : ''}`;
}

export default {
  title: () => ({ title: `${greeting()}، ${firstName(S.user.name)}`, subtitle: isAdmin() ? 'لوحة المدير' : S.settings.appName }),
  async load() {
    const [dash, activity, offers, ops] = await Promise.all([
      api.get(`/api/dashboard?tz=${tz()}`), api.get(`/api/activity?days=${D.days}&tz=${tz()}`), api.get('/api/offers'), api.get('/api/ops?limit=6'),
    ]);
    Object.assign(D, { dash, activity, offers: offers.filter((o) => o.live && o.packageId), ops });
    if (isAdmin()) S.adminTotals = dash;
  },
  render() {
    return `
      <div class="search-box" id="home-search">${icon('search', 'i lead')}
        <input class="input" id="global-q" type="search" placeholder="${isAdmin() ? 'ابحث برقم، اسم زبون، شريحة أو وكيل…' : 'ابحث برقم، اسم زبون أو رقم شريحة…'}" autocomplete="off" aria-label="بحث">
        <div class="search-results" id="search-results" hidden></div></div>
      ${quickActions()}
      ${stats()}
      ${kpis()}
      ${chartCard()}
      ${D.offers.length ? `<section class="list"><div class="section-title"><h2>العروض الحالية</h2><a class="link" href="#/offers">كل العروض${icon('arrowL')}</a></div>
        <div class="offer-strip">${D.offers.map((o) => offerCard(o)).join('')}</div></section>` : ''}
      ${opsCard()}`;
  },
  mount(root) {
    const chart = root.querySelector('#activity-chart');
    const draw = () => drawActivity(chart, D.activity.days, D.series, SERIES);
    draw();
    resizeObserver?.disconnect();
    let lastW = chart.clientWidth;
    resizeObserver = new ResizeObserver(debounce(() => { if (chart.isConnected && Math.abs(chart.clientWidth - lastW) > 8) { lastW = chart.clientWidth; draw(); } }, 120));
    resizeObserver.observe(chart);

    const q = root.querySelector('#global-q');
    const box = root.querySelector('#search-results');
    let lastQuery = '';
    const run = debounce(async () => {
      const term = q.value.trim();
      lastQuery = term;
      if (term.length < 2) { box.hidden = true; return; }
      try {
        const r = await api.get(`/api/search?q=${encodeURIComponent(term)}`);
        if (term !== lastQuery) return;
        box.innerHTML = searchResults(r);
        box.hidden = false;
      } catch { /* offline */ }
    }, 220);
    q.addEventListener('input', run);
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { box.hidden = true; q.blur(); } });
    box.addEventListener('click', (e) => {
      const line = e.target.closest('[data-res-line]');
      const link = e.target.closest('[data-res-go]');
      if (line) { box.hidden = true; openLine(Number(line.dataset.resLine)); }
      if (link) go(link.dataset.resGo);
    });
  },
  actions: {
    series(btn, e, ctx) {
      D.series = btn.dataset.key;
      document.querySelectorAll('.series-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      drawActivity(document.getElementById('activity-chart'), D.activity.days, D.series, SERIES);
    },
    async days(btn, e, ctx) {
      D.days = Number(btn.dataset.days);
      document.getElementById('activity-chart')?.classList.add('loading');
      D.activity = await api.get(`/api/activity?days=${D.days}&tz=${tz()}`);
      ctx.rerender();
    },
    'toggle-table'(btn, e, ctx) { D.table = !D.table; ctx.rerender(); },
    'add-sims': () => openAddSims(),
    'add-agent': () => openAgentForm(null),
    'use-offer': (btn) => go(`#/new?offer=${btn.dataset.id}`),
  },
};
