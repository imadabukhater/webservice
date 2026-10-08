import { api, esc, icon, isAdmin, sheet, fmtMoney, fmtDate, fmtISO, fmtPhone, fmtIccid, debounce, go } from '../core.js';
import { cellText, exportCSV, exportExcel, copyTable, printTable } from '../exporter.js';

const V = {
  list: [], key: null, data: null, agents: [], agentId: '',
  range: 'month', from: '', to: '',
  q: '', filters: {}, sort: null, dir: 1, page: 1, size: 10,
};

const PRESETS = [['today', 'اليوم'], ['7', '7 أيام'], ['month', 'هذا الشهر'], ['lastmonth', 'الشهر الماضي'], ['30', '30 يوماً'], ['custom', 'مخصص']];

function rangeBounds() {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const tomorrow = startOfDay(now) + 864e5;
  switch (V.range) {
    case 'today': return [startOfDay(now), tomorrow];
    case '7': return [tomorrow - 7 * 864e5, tomorrow];
    case '30': return [tomorrow - 30 * 864e5, tomorrow];
    case 'lastmonth': return [new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime()];
    case 'custom': {
      const f = V.from ? new Date(`${V.from}T00:00:00`).getTime() : tomorrow - 30 * 864e5;
      const t = V.to ? new Date(`${V.to}T00:00:00`).getTime() + 864e5 : tomorrow;
      return [f, t];
    }
    default: return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), tomorrow];
  }
}

const meta = () => V.list.find((r) => r.key === V.key);
const number = () => V.list.findIndex((r) => r.key === V.key) + 1;

function display(col, v) {
  if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
  if (col.type === 'phone') return `<span class="ltr mono">${esc(fmtPhone(v))}</span>`;
  if (col.type === 'iccid') return `<span class="ltr mono">${esc(fmtIccid(v))}</span>`;
  if (col.type === 'money') return `<span class="ltr ${v < 0 ? 'minus' : ''}">${fmtMoney(v)}</span>`;
  return esc(cellText(col, v));
}

function rows() {
  const { columns, rows: all } = V.data;
  const q = V.q.trim().toLowerCase();
  let out = all.filter((r) => {
    if (q && !columns.some((c) => cellText(c, r[c.key]).toLowerCase().includes(q) || String(r[c.key] ?? '').includes(q))) return false;
    for (const [k, f] of Object.entries(V.filters)) {
      if (!f) continue;
      const c = columns.find((x) => x.key === k);
      const text = cellText(c, r[k]).toLowerCase();
      if (!text.includes(f.toLowerCase()) && !String(r[k] ?? '').includes(f)) return false;
    }
    return true;
  });
  if (V.sort) {
    const c = columns.find((x) => x.key === V.sort);
    const numeric = ['money', 'num', 'date', 'datetime'].includes(c.type);
    out = [...out].sort((a, b) => {
      const x = a[V.sort];
      const y = b[V.sort];
      if (x === y) return 0;
      if (x === null || x === undefined || x === '') return 1;
      if (y === null || y === undefined || y === '') return -1;
      return (numeric ? x - y : String(x).localeCompare(String(y), 'ar')) * V.dir;
    });
  }
  return out;
}

function bodyHtml() {
  const { columns } = V.data;
  const list = rows();
  const size = V.size || list.length || 1;
  const pages = Math.max(1, Math.ceil(list.length / size));
  V.page = Math.min(V.page, pages);
  const start = (V.page - 1) * size;
  const pageRows = list.slice(start, start + size);
  const sums = columns.map((c) => (c.type === 'money' || (c.type === 'num' && !/day|days/.test(c.key))) ? list.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) : null);
  const tbody = pageRows.length
    ? pageRows.map((r) => `<tr>${columns.map((c) => `<td class="${c.type === 'money' ? 'money' : c.type === 'num' ? 'numc' : ''}">${display(c, r[c.key])}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length}" style="text-align:center;padding:34px" class="muted">لا توجد بيانات في هذا التقرير${V.q || Object.values(V.filters).some(Boolean) ? ' بهذا البحث' : ''}.</td></tr>`;
  const tfoot = sums.some((s) => s !== null) && list.length
    ? `<tfoot><tr>${columns.map((c, i) => `<th class="${c.type === 'money' ? 'money' : ''}">${i === 0 ? 'المجموع' : sums[i] === null ? '' : c.type === 'money' ? `<span class="ltr">${fmtMoney(sums[i])}</span>` : sums[i]}</th>`).join('')}</tr></tfoot>` : '';
  const pagerBtns = [];
  const windowPages = [...new Set([1, V.page - 1, V.page, V.page + 1, pages])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  windowPages.forEach((p, i) => {
    if (i && p - windowPages[i - 1] > 1) pagerBtns.push('<button disabled>…</button>');
    pagerBtns.push(`<button data-page="${p}" ${p === V.page ? 'aria-current="page"' : ''}>${p}</button>`);
  });
  return {
    tbody, tfoot,
    foot: `<span>عرض ${list.length ? start + 1 : 0} إلى ${Math.min(start + size, list.length)} من ${list.length}${list.length !== V.data.rows.length ? ` (من أصل ${V.data.rows.length})` : ''}</span>
      <div class="pager"><button data-page="${V.page - 1}" ${V.page <= 1 ? 'disabled' : ''}>السابق</button>${pagerBtns.join('')}<button data-page="${V.page + 1}" ${V.page >= pages ? 'disabled' : ''}>التالي</button></div>`,
  };
}

function paintBody(root) {
  const b = bodyHtml();
  root.querySelector('#rp-body').innerHTML = b.tbody;
  const foot = root.querySelector('#rp-tfoot');
  foot.innerHTML = b.tfoot.replace(/^<tfoot>|<\/tfoot>$/g, '');
  root.querySelector('#rp-foot').innerHTML = b.foot;
}

function openPicker() {
  const groups = [...new Set(V.list.map((r) => r.group))];
  sheet({
    title: 'مكتبة التقارير',
    body: `<div class="report-list">${groups.map((g) => `<div class="group">${esc(g)}</div>${V.list.map((r, i) => (r.group === g
      ? `<button type="button" data-key="${r.key}" aria-current="${r.key === V.key}"><span class="no">${i + 1}</span>${esc(r.title)}</button>` : '')).join('')}`).join('')}</div>`,
    onMount(form) {
      form.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => go(`#/reports?r=${b.dataset.key}`)));
    },
  });
}

export default {
  title: () => ({ title: 'التقارير', subtitle: meta()?.title || 'مكتبة التقارير' }),
  async load(ctx) {
    if (!V.list.length) V.list = await api.get('/api/reports');
    if (isAdmin() && !V.agents.length) V.agents = await api.get('/api/agents');
    if (ctx.query.agent !== undefined) V.agentId = ctx.query.agent;
    const key = ctx.query.r && V.list.some((r) => r.key === ctx.query.r) ? ctx.query.r : V.key || 'active';
    if (key !== V.key) { V.q = ''; V.filters = {}; V.sort = null; V.page = 1; }
    V.key = key;
    const [from, to] = rangeBounds();
    const params = new URLSearchParams({ from, to, ...(isAdmin() && V.agentId ? { agentId: V.agentId } : {}) });
    V.data = await api.get(`/api/reports/${V.key}?${params}`);
  },
  render() {
    const m = meta();
    const b = bodyHtml();
    const [from, to] = rangeBounds();
    return `
      <section class="card report-head">
        <div><div class="kicker">مكتبة التقارير</div><h2>${icon('file')}<span class="num">${number()}</span> - ${esc(m.title)}</h2>
          ${V.data.subtitle ? `<p class="small muted">${esc(V.data.subtitle)}</p>` : ''}</div>
        <button class="btn" data-action="pick">${icon('list')}تغيير التقرير</button>
      </section>
      ${m.dated || isAdmin() ? `<div class="filter-row">
        ${m.dated ? `<div class="chips">${PRESETS.map(([k, l]) => `<button class="chip" data-action="range" data-range="${k}" aria-pressed="${V.range === k}">${l}</button>`).join('')}</div>
          ${V.range === 'custom' ? `<input class="input" type="date" id="rp-from" value="${esc(V.from || fmtISO(from))}" aria-label="من"><input class="input" type="date" id="rp-to" value="${esc(V.to || fmtISO(to - 864e5))}" aria-label="إلى">` : `<span class="small muted">${fmtDate(from)} — ${fmtDate(to - 864e5)}</span>`}` : ''}
        ${isAdmin() ? `<select class="input" id="rp-agent"><option value="">كل الوكلاء</option>${V.agents.map((a) => `<option value="${a.id}" ${String(a.id) === String(V.agentId) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}
      </div>` : ''}
      <section class="card table-card">
        <div class="table-tools">
          <div class="search-box">${icon('search', 'i lead')}<input class="input" id="rp-q" type="search" placeholder="ابحث" value="${esc(V.q)}"></div>
          <label class="rows-select">أسطر<select id="rp-size">${[10, 25, 50, 100, 0].map((n) => `<option value="${n}" ${V.size === n ? 'selected' : ''}>${n || 'الكل'}</option>`).join('')}</select>عرض</label>
          <div class="export">
            <button class="btn btn-sm" data-action="export" data-kind="copy">${icon('copy')}Copy</button>
            <button class="btn btn-sm" data-action="export" data-kind="csv">${icon('file')}CSV</button>
            <button class="btn btn-sm" data-action="export" data-kind="excel">${icon('excel')}Excel</button>
            <button class="btn btn-sm" data-action="export" data-kind="pdf">${icon('pdf')}PDF</button>
            <button class="btn btn-sm" data-action="export" data-kind="print">${icon('print')}Print</button>
          </div>
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr>${V.data.columns.map((c) => `<th ${V.sort === c.key ? `aria-sort="${V.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button data-action="sort" data-key="${c.key}">${esc(c.label)}${icon('sort')}</button></th>`).join('')}</tr>
            <tr class="filters">${V.data.columns.map((c) => `<th><input data-filter="${c.key}" value="${esc(V.filters[c.key] || '')}" aria-label="تصفية ${esc(c.label)}"></th>`).join('')}</tr></thead>
          <tbody id="rp-body">${b.tbody}</tbody>
          <tfoot id="rp-tfoot">${b.tfoot.replace(/^<tfoot>|<\/tfoot>$/g, '')}</tfoot>
        </table></div>
        <div class="table-foot" id="rp-foot">${b.foot}</div>
      </section>`;
  },
  mount(root, ctx) {
    root.querySelector('#rp-q').addEventListener('input', debounce((e) => { V.q = e.target.value; V.page = 1; paintBody(root); }, 150));
    root.querySelectorAll('[data-filter]').forEach((i) => i.addEventListener('input', debounce(() => { V.filters[i.dataset.filter] = i.value.trim(); V.page = 1; paintBody(root); }, 150)));
    root.querySelector('#rp-size').addEventListener('change', (e) => { V.size = Number(e.target.value); V.page = 1; paintBody(root); });
    root.querySelector('#rp-foot').addEventListener('click', (e) => {
      const b = e.target.closest('[data-page]');
      if (!b || b.disabled) return;
      V.page = Number(b.dataset.page);
      paintBody(root);
    });
    root.querySelector('#rp-agent')?.addEventListener('change', (e) => { V.agentId = e.target.value; ctx.reload(); });
    const dates = () => { V.from = root.querySelector('#rp-from').value; V.to = root.querySelector('#rp-to').value; ctx.reload(); };
    root.querySelector('#rp-from')?.addEventListener('change', dates);
    root.querySelector('#rp-to')?.addEventListener('change', dates);
  },
  actions: {
    pick: openPicker,
    range(btn, e, ctx) { V.range = btn.dataset.range; ctx.reload(); },
    sort(btn, e, ctx) {
      const k = btn.dataset.key;
      if (V.sort === k) V.dir = -V.dir; else { V.sort = k; V.dir = 1; }
      ctx.rerender();
    },
    export(btn) {
      const title = `${number()} - ${meta().title}`;
      const { columns } = V.data;
      const list = rows();
      const [from, to] = rangeBounds();
      const subtitle = meta().dated ? `${fmtDate(from)} — ${fmtDate(to - 864e5)}` : (V.data.subtitle || '');
      ({
        copy: () => copyTable(columns, list),
        csv: () => exportCSV(title, columns, list, `report-${V.key}`),
        excel: () => exportExcel(title, columns, list, `report-${V.key}`),
        pdf: () => printTable(title, subtitle, columns, list),
        print: () => printTable(title, subtitle, columns, list),
      })[btn.dataset.kind]();
    },
  },
};
