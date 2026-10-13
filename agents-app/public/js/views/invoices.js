import { t, call, n, today, formatDate, openModal, closeModal, empty, mkInput, mkButton, mkNote } from '../util.js';

export default function invoices() {
  const container = t('div', { class: 'page' });
  const [, data] = call('/api/invoices', { timeout: 5000 });
  const agents = call('/api/agents', { timeout: 5000 })[1];
  const currentUser = call('/api/user')[1];
  const isAdmin = currentUser?.role === 'admin';

  if (!Array.isArray(data)) {
    container.appendChild(mkNote('خطأ في تحميل الفواتير'));
    return container;
  }

  let selectedStatus = 'all';

  const statuses = { pending: 'معلقة', paid: 'مدفوعة', rejected: 'مرفوضة' };
  const statusColors = { pending: '#ff9800', paid: '#4caf50', rejected: '#f44336' };

  // Calculate KPIs
  const calculateKPIs = () => {
    const pending = data.filter((i) => i.status === 'pending');
    const paid = data.filter((i) => i.status === 'paid');
    const totalPaid = paid.reduce((sum, i) => sum + i.amount, 0);
    return { total: data.length, pending: pending.length, paid: paid.length, totalPaid };
  };

  const renderKPIs = () => {
    const kpis = calculateKPIs();
    const section = t('div', { class: 'kpis' });

    const mkKPI = (label, value) => {
      const kpi = t('div', { class: 'kpi' });
      kpi.appendChild(t('div', { class: 'kpi-value' }, String(value)));
      kpi.appendChild(t('div', { class: 'kpi-label' }, label));
      return kpi;
    };

    section.appendChild(mkKPI('عدد الفواتير', kpis.total));
    section.appendChild(mkKPI('معلقة', kpis.pending));
    section.appendChild(mkKPI('مدفوعة', kpis.paid));
    section.appendChild(mkKPI('إجمالي المدفوع', n(kpis.totalPaid)));
    return section;
  };

  const renderInvoices = () => {
    const section = t('div', { class: 'invoices-list' });
    const filtered = selectedStatus === 'all' ? data : data.filter((i) => i.status === selectedStatus);

    if (!filtered.length) {
      section.appendChild(empty('لا توجد فواتير'));
      return section;
    }

    const table = t('table');
    const thead = t('thead');
    const headerRow = t('tr');
    ['رقم الفاتورة', 'الوكيل', 'المبلغ', 'الحالة', 'تاريخ الإصدار', 'الإجراءات'].forEach((h) => {
      headerRow.appendChild(t('th', {}, h));
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = t('tbody');
    filtered.forEach((inv) => {
      const row = t('tr');

      const statusCell = t('td');
      const statusBadge = t('span', { class: 'status-badge', style: `background-color: ${statusColors[inv.status]}` }, statuses[inv.status]);
      statusCell.appendChild(statusBadge);

      const actionsCell = t('td', { class: 'actions' });

      if (isAdmin) {
        if (inv.status === 'pending') {
          actionsCell.appendChild(mkButton('دفع', () => payInvoice(inv.id)));
          actionsCell.appendChild(mkButton('تعديل', () => editInvoice(inv)));
          actionsCell.appendChild(mkButton('حذف', () => deleteInvoice(inv.id)));
          actionsCell.appendChild(mkButton('رفض', () => rejectInvoice(inv.id)));
        } else if (inv.status === 'paid') {
          actionsCell.appendChild(mkButton('عرض', () => viewInvoice(inv)));
        } else {
          actionsCell.appendChild(mkButton('عرض', () => viewInvoice(inv)));
        }
      } else {
        actionsCell.appendChild(mkButton('عرض', () => viewInvoice(inv)));
      }

      row.appendChild(t('td', {}, inv.invoiceNumber));
      row.appendChild(t('td', {}, inv.agentName || ''));
      row.appendChild(t('td', {}, n(inv.amount)));
      row.appendChild(statusCell);
      row.appendChild(t('td', {}, formatDate(inv.issueDate)));
      row.appendChild(actionsCell);

      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  };

  const viewInvoice = (inv) => {
    const modal = openModal('عرض الفاتورة');
    const content = modal.querySelector('.modal-content');

    const details = t('div', { class: 'invoice-details' });
    details.appendChild(t('p', {}, `رقم الفاتورة: ${inv.invoiceNumber}`));
    details.appendChild(t('p', {}, `الوكيل: ${inv.agentName}`));
    details.appendChild(t('p', {}, `المبلغ: ${n(inv.amount)}`));
    details.appendChild(t('p', {}, `الحالة: ${statuses[inv.status]}`));
    details.appendChild(t('p', {}, `الوصف: ${inv.description}`));
    details.appendChild(t('p', {}, `تاريخ الإصدار: ${formatDate(inv.issueDate)}`));
    if (inv.dueDate) details.appendChild(t('p', {}, `تاريخ الاستحقاق: ${formatDate(inv.dueDate)}`));
    if (inv.paidDate) details.appendChild(t('p', {}, `تاريخ الدفع: ${formatDate(inv.paidDate)}`));
    if (inv.notes) details.appendChild(t('p', {}, `ملاحظات: ${inv.notes}`));

    content.appendChild(details);
    content.appendChild(mkButton('إغلاق', closeModal));
  };

  const payInvoice = async (id) => {
    if (!confirm('هل أنت متأكد من دفع هذه الفاتورة؟')) return;
    const [ok] = call(`/api/invoices/${id}/pay`, { method: 'POST' });
    if (!ok) return;
    location.reload();
  };

  const rejectInvoice = async (id) => {
    if (!confirm('هل أنت متأكد من رفض هذه الفاتورة؟')) return;
    const [ok] = call(`/api/invoices/${id}/reject`, { method: 'POST' });
    if (!ok) return;
    location.reload();
  };

  const deleteInvoice = async (id) => {
    if (!confirm('حذف هذه الفاتورة؟')) return;
    const [ok] = call(`/api/invoices/${id}`, { method: 'DELETE' });
    if (!ok) return;
    location.reload();
  };

  const editInvoice = (inv) => {
    const modal = openModal('تعديل الفاتورة');
    const content = modal.querySelector('.modal-content');

    const form = t('form');
    const inputs = {
      amount: mkInput('number', 'المبلغ', inv.amount),
      description: mkInput('text', 'الوصف', inv.description),
      dueDate: mkInput('date', 'تاريخ الاستحقاق', inv.dueDate ? new Date(inv.dueDate).toISOString().split('T')[0] : ''),
      notes: mkInput('text', 'ملاحظات', inv.notes),
    };

    Object.values(inputs).forEach((input) => form.appendChild(input));

    const submitBtn = mkButton('حفظ', async () => {
      const payload = {
        amount: parseFloat(inputs.amount.querySelector('input').value),
        description: inputs.description.querySelector('input').value,
        dueDate: inputs.dueDate.querySelector('input').value ? new Date(inputs.dueDate.querySelector('input').value).getTime() : null,
        notes: inputs.notes.querySelector('input').value,
      };

      const [ok] = call(`/api/invoices/${inv.id}`, { method: 'PUT', body: payload });
      if (!ok) return;
      closeModal();
      location.reload();
    });

    form.appendChild(submitBtn);
    form.appendChild(mkButton('إلغاء', closeModal));
    content.appendChild(form);
  };

  const renderCreateForm = () => {
    if (!isAdmin) return t('div');

    const section = t('div', { class: 'create-form' });
    const heading = t('h3', {}, 'فاتورة جديدة');
    section.appendChild(heading);

    const form = t('form');
    const inputs = {
      agentId: mkInput('select', 'الوكيل', ''),
      amount: mkInput('number', 'المبلغ', ''),
      description: mkInput('text', 'الوصف', ''),
      dueDate: mkInput('date', 'تاريخ الاستحقاق', ''),
      notes: mkInput('text', 'ملاحظات', ''),
    };

    // Populate agent select
    const agentSelect = inputs.agentId.querySelector('input');
    agentSelect.type = 'hidden';
    const selectWrapper = t('div', { class: 'form-group' });
    selectWrapper.appendChild(t('label', {}, 'الوكيل'));
    const select = t('select');
    const emptyOption = t('option', { value: '' }, 'اختر وكيل');
    select.appendChild(emptyOption);
    agents.forEach((agent) => {
      const option = t('option', { value: agent.id }, agent.name);
      select.appendChild(option);
    });
    select.addEventListener('change', (e) => { agentSelect.value = e.target.value; });
    selectWrapper.appendChild(select);
    form.appendChild(selectWrapper);

    Object.entries(inputs).forEach(([key, input]) => {
      if (key !== 'agentId') form.appendChild(input);
    });

    const submitBtn = mkButton('إنشاء فاتورة', async () => {
      const amount = parseFloat(inputs.amount.querySelector('input').value);
      if (!agentSelect.value || !amount || amount <= 0) {
        alert('يرجى ملء جميع الحقول بشكل صحيح');
        return;
      }

      const payload = {
        agentId: parseInt(agentSelect.value),
        amount,
        description: inputs.description.querySelector('input').value,
        dueDate: inputs.dueDate.querySelector('input').value ? new Date(inputs.dueDate.querySelector('input').value).getTime() : null,
        notes: inputs.notes.querySelector('input').value,
      };

      const [ok] = call('/api/invoices', { method: 'POST', body: payload });
      if (!ok) return;
      location.reload();
    });

    form.appendChild(submitBtn);
    section.appendChild(form);
    return section;
  };

  const renderFilters = () => {
    const section = t('div', { class: 'filters' });
    const label = t('label', {}, 'الحالة:');
    const select = t('select');

    const options = [
      { value: 'all', label: 'جميع' },
      { value: 'pending', label: 'معلقة' },
      { value: 'paid', label: 'مدفوعة' },
      { value: 'rejected', label: 'مرفوضة' },
    ];

    options.forEach(({ value, label }) => {
      const option = t('option', { value }, label);
      select.appendChild(option);
    });

    select.addEventListener('change', (e) => {
      selectedStatus = e.target.value;
      container.replaceChild(renderInvoices(), container.querySelector('.invoices-list'));
    });

    section.appendChild(label);
    section.appendChild(select);
    return section;
  };

  container.appendChild(t('h2', {}, 'الفواتير'));
  container.appendChild(renderKPIs());
  container.appendChild(renderFilters());
  container.appendChild(renderInvoices());
  if (isAdmin) container.appendChild(renderCreateForm());

  return container;
}
