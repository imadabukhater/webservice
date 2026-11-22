import {
  api, esc, icon, money, phone, fmtDateTime, sheet, empty, debounce, copyText,
} from '../core.js';
import { exportCSV, exportExcel } from '../exporter.js';

// Everyone who bought an eSIM from the shop: a read-only record (no actions on a line).
const V = { rows: [], q: '', from: '', to: '' };

const STATUS = { active: ['s-active', 'مفعّل'], pending: ['s-pending', 'قيد التفعيل'] };
const statusPill = (s) => {
  const [cls, label] = STATUS[s] || ['s-disconnected', 'غير مفعّل'];
  return `<span class="pill ${cls}">${label}</span>`;
};

const COLUMNS = [
  { key: 'code', label: 'رقم الطلب', type: 'text' },
  { key: 'customerName', label: 'الاسم', type: 'text' },
  { key: 'number', label: 'رقم الخط', type: 'phone' },
  { key: 'packageLabel', label: 'الرزمة', type: 'text' },
  { key: 'amount', label: 'المبلغ', type: 'money' },
  { key: 'email', label: 'البريد', type: 'text' },
  { key: 'contactPhone', label: 'هاتف التواصل', type: 'phone' },
  { key: 'paidAt', label: 'تاريخ الشراء', type: 'datetime' },
  { key: 'status', label: 'الحالة', type: 'text' },
];
const exportRows = () => V.rows.map((b) => ({ ...b, status: (STATUS[b.lineStatus] || [0, 'غير مفعّل'])[1] }));

function query() {
  const p = new URLSearchParams();
  if (V.q) p.set('q', V.q);
  if (V.from) p.set('from', String(new Date(`${V.from}T00:00`).getTime()));
  if (V.to) p.set('to', String(new Date(`${V.to}T00:00`).getTime() + 864e5));
  const s = p.toString();
  return `/api/buyers${s ? `?${s}` : ''}`;
}

function card(b) {
  return `<button type="button" class="item clickable" data-action="open" data-id="${b.id}" style="width:100%;text-align:start">
    <div class="item-top"><span class="tile sm cyan">${icon('qr')}</span>
      <div class="grow"><b class="item-title">${esc(b.customerName || 'بدون اسم')}</b>
        <div class="item-sub">${b.number ? `<span>${phone(b.number)}</span>` : ''}<span>${esc(b.packageLabel)}</span><span>${fmtDateTime(b.paidAt)}</span></div></div>
      ${statusPill(b.lineStatus)}</div></button>`;
}

function listHtml() {
  return `<div class="section-title"><h2 class="dot-title">${V.rows.length} مشترٍ</h2></div>
    ${V.rows.length ? `<div class="grid-cards">${V.rows.map(card).join('')}</div>` : empty('users', 'لا يوجد مشترون', V.q || V.from || V.to ? 'جرّب بحثاً آخر.' : 'من يشتري eSIM من المتجر يظهر هنا.')}`;
}

const row = (label, value) => (value ? `<div>${label}</div><div>${value}</div>` : '');

async function openBuyer(id) {
  const b = await api.get(`/api/buyers/${id}`);
  sheet({
    title: b.customerName || 'بدون اسم',
    subtitle: `طلب <span class="ltr">${esc(b.code)}</span>`,
    body: `${statusPill(b.lineStatus)}
      <div class="kv">
        ${row('رقم الخط', b.number ? phone(b.number) : '')}
        ${row('الشركة', esc(b.companyName || ''))}
        ${row('الرزمة', esc(b.packageLabel || ''))}
        ${row('المبلغ', money(b.amount))}
        ${row('تاريخ الشراء', fmtDateTime(b.paidAt))}
        ${row('البريد', b.email ? `<span class="ltr">${esc(b.email)}</span>` : '')}
        ${row('هاتف التواصل', b.contactPhone ? phone(b.contactPhone) : '')}
      </div>
      ${b.esimQr ? `<div style="text-align:center;margin-top:12px"><img class="thumb" style="max-width:240px" src="${esc(b.esimQr)}" alt="رمز QR لتثبيت eSIM"></div>` : ''}
      ${b.esimCode ? `<div class="field"><span class="label">رمز التفعيل</span><div style="display:flex;gap:8px;align-items:center">
        <code class="ltr grow" style="word-break:break-all">${esc(b.esimCode)}</code><button type="button" class="btn btn-sm" data-copy-code>${icon('copy')}نسخ</button></div></div>` : ''}`,
    onMount(form) {
      form.querySelector('[data-copy-code]')?.addEventListener('click', () => copyText(b.esimCode));
    },
  });
}

export default {
  title: () => ({ title: 'المشترون', subtitle: 'سجل من اشترى eSIM من المتجر' }),
  async load(ctx) {
    if (ctx.query.q !== undefined) V.q = ctx.query.q;
    V.rows = await api.get(query());
  },
  render() {
    return `
      <div class="search-box">${icon('search', 'i lead')}
        <input class="input" id="buyers-q" type="search" placeholder="ابحث بالاسم، الرقم، البريد أو رقم الطلب…" value="${esc(V.q)}" autocomplete="off" aria-label="بحث"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <div class="field" style="flex:1;min-width:140px"><label for="buyers-from">من</label><input class="input ltr" id="buyers-from" type="date" value="${esc(V.from)}"></div>
        <div class="field" style="flex:1;min-width:140px"><label for="buyers-to">إلى</label><input class="input ltr" id="buyers-to" type="date" value="${esc(V.to)}"></div>
        <button class="btn btn-sm" data-action="csv">${icon('file')}CSV</button>
        <button class="btn btn-sm" data-action="excel">${icon('excel')}Excel</button>
      </div>
      <div id="buyers-list">${listHtml()}</div>`;
  },
  mount(root) {
    const list = root.querySelector('#buyers-list');
    // Only the list is redrawn, so typing in the search box keeps its focus.
    const refresh = async () => {
      try { V.rows = await api.get(query()); } catch { return; }
      if (list.isConnected) list.innerHTML = listHtml();
    };
    const qBox = root.querySelector('#buyers-q');
    qBox.addEventListener('input', debounce(() => { V.q = qBox.value.trim(); refresh(); }, 300));
    root.querySelector('#buyers-from').addEventListener('change', (e) => { V.from = e.target.value; refresh(); });
    root.querySelector('#buyers-to').addEventListener('change', (e) => { V.to = e.target.value; refresh(); });
  },
  actions: {
    open: (btn) => openBuyer(Number(btn.dataset.id)),
    csv: () => exportCSV('المشترون', COLUMNS, exportRows(), 'buyers'),
    excel: () => exportExcel('المشترون', COLUMNS, exportRows(), 'buyers'),
  },
};
