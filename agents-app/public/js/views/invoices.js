import {
  api, esc, icon, isAdmin, fmtMoney, fmtDate, fmtISO, sheet, field, changed, empty,
} from '../core.js';

const V = { invoices: [], filter: '' };
const STATUS = { pending: 'معلقة', paid: 'مدفوعة', rejected: 'مرفوضة' };
const PILL = { pending: 'open', paid: 'done', rejected: 'rejected' };

function card(i) {
  const admin = isAdmin();
  return `<article class="item">
    <div class="item-top"><span class="tile sm ${i.status === 'paid' ? 'green' : i.status === 'rejected' ? 'red' : 'amber'}">${icon('file')}</span>
      <div class="grow"><b class="item-title"><span class="ltr">${esc(i.invoiceNumber)}</span> · <span class="ltr">${fmtMoney(i.amount)}</span></b>
        <div class="item-sub">${admin ? `<span>${esc(i.agentName)}</span>` : ''}<span>صدرت ${fmtDate(i.issueDate)}</span>
          ${i.dueDate ? `<span>تستحق ${fmtDate(i.dueDate)}</span>` : ''}${i.paidDate ? `<span>دُفعت ${fmtDate(i.paidDate)}</span>` : ''}</div></div>
      <span class="pill s-${PILL[i.status]}">${STATUS[i.status]}</span></div>
    ${i.description ? `<p class="small" style="color:var(--ink-2)">${esc(i.description)}</p>` : ''}
    ${i.notes ? `<p class="small muted">${esc(i.notes)}</p>` : ''}
    ${admin && i.status === 'pending' ? `<div class="item-actions">
      <button class="btn btn-sm btn-good" data-action="pay" data-id="${i.id}">${icon('check')}مدفوعة</button>
      <button class="btn btn-sm" data-action="edit" data-id="${i.id}">${icon('edit')}تعديل</button>
      <button class="btn btn-sm btn-danger" data-action="reject" data-id="${i.id}">${icon('x')}رفض</button>
      <button class="btn btn-sm btn-ghost" data-action="delete" data-id="${i.id}">${icon('trash')}حذف</button></div>` : ''}
  </article>`;
}

async function openForm(inv) {
  const agents = inv ? [] : (await api.get('/api/agents')).filter((a) => a.active);
  sheet({
    title: inv ? `تعديل ${inv.invoiceNumber}` : 'فاتورة جديدة',
    body: `
      ${inv ? '' : `<div class="field"><label for="iv-agent">الوكيل</label><select class="input" id="iv-agent" name="agentId" required>
        <option value="">اختر الوكيل</option>${agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>`}
      <div class="field"><label for="iv-amount">المبلغ (₪)</label><input class="input ltr" id="iv-amount" name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" value="${inv?.amount ?? ''}" required></div>
      <div class="field"><label for="iv-desc">الوصف</label><input class="input" id="iv-desc" name="description" value="${esc(inv?.description || '')}"></div>
      <div class="field"><label for="iv-due">تاريخ الاستحقاق <span class="opt">(اختياري)</span></label><input class="input" id="iv-due" name="dueDate" type="date" value="${fmtISO(inv?.dueDate)}"></div>
      <div class="field"><label for="iv-notes">ملاحظات <span class="opt">(اختياري)</span></label><textarea class="input" id="iv-notes" name="notes" rows="2">${esc(inv?.notes || '')}</textarea></div>`,
    submit: inv ? 'حفظ' : 'إصدار الفاتورة',
    async onSubmit(form) {
      const due = field(form, 'dueDate');
      const body = { amount: field(form, 'amount'), description: field(form, 'description'), notes: field(form, 'notes'), dueDate: due ? new Date(`${due}T23:59:59`).getTime() : null };
      if (inv) await api.put(`/api/invoices/${inv.id}`, body);
      else {
        if (!field(form, 'agentId')) throw new Error('اختر الوكيل');
        await api.post('/api/invoices', { ...body, agentId: Number(field(form, 'agentId')) });
      }
      changed();
      return inv ? 'تم حفظ الفاتورة' : 'تم إصدار الفاتورة';
    },
  });
}

function confirmAction(i, { title, text, submit, danger, run, done }) {
  sheet({
    title, body: `<p>${text}</p>`, submit, danger,
    async onSubmit() { await run(i); changed(); return done; },
  });
}

const byId = (btn) => V.invoices.find((x) => x.id === Number(btn.dataset.id));

export default {
  title: () => ({ title: 'الفواتير', subtitle: isAdmin() ? 'فواتير الوكلاء وحالة الدفع' : 'فواتيرك' }),
  async load() { V.invoices = await api.get('/api/invoices'); },
  render() {
    const all = V.invoices;
    const list = V.filter ? all.filter((i) => i.status === V.filter) : all;
    const paid = all.filter((i) => i.status === 'paid');
    const open = all.filter((i) => i.status === 'pending');
    const sum = (l) => l.reduce((s, i) => s + i.amount, 0);
    return `
      <div class="page-head"><div><h2 class="dot-title">الفواتير</h2><p>معلقة ${open.length} بقيمة <span class="ltr">${fmtMoney(sum(open))}</span> · مدفوعة ${paid.length} بقيمة <span class="ltr">${fmtMoney(sum(paid))}</span></p></div>
        ${isAdmin() ? `<button class="btn btn-primary" data-action="add">${icon('plus')}فاتورة جديدة</button>` : ''}</div>
      <div class="chips">${[['', 'الكل'], ['pending', 'معلقة'], ['paid', 'مدفوعة'], ['rejected', 'مرفوضة']]
        .map(([k, l]) => `<button class="chip" data-action="filter" data-f="${k}" aria-pressed="${V.filter === k}">${l}</button>`).join('')}</div>
      ${list.length ? `<div class="grid-cards">${list.map(card).join('')}</div>` : empty('file', 'لا توجد فواتير', isAdmin() ? 'أصدر فاتورة لأي وكيل وتابع دفعها من هنا.' : '')}`;
  },
  actions: {
    filter(btn, e, ctx) { V.filter = btn.dataset.f; ctx.rerender(); },
    add: () => openForm(null),
    edit: (btn) => openForm(byId(btn)),
    pay: (btn) => confirmAction(byId(btn), {
      title: 'تأكيد الدفع', text: 'ستُسجَّل الفاتورة مدفوعة.', submit: 'مدفوعة', run: (i) => api.post(`/api/invoices/${i.id}/pay`), done: 'تم تسجيل الدفع',
    }),
    reject: (btn) => confirmAction(byId(btn), {
      title: 'رفض الفاتورة', text: 'ستُسجَّل الفاتورة مرفوضة.', submit: 'رفض', danger: true, run: (i) => api.post(`/api/invoices/${i.id}/reject`), done: 'تم رفض الفاتورة',
    }),
    delete: (btn) => confirmAction(byId(btn), {
      title: 'حذف الفاتورة', text: 'ستُحذف الفاتورة نهائياً.', submit: 'حذف', danger: true, run: (i) => api.del(`/api/invoices/${i.id}`), done: 'تم حذف الفاتورة',
    }),
  },
};
