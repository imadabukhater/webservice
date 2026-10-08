import {
  api, esc, icon, isAdmin, fmtMoney, fmtDateTime, phone, sheet, field, changed, fileToDataUrl, relTime, OP, OP_ICON, signedMoney,
  TASK_STATUS, empty, tz, round,
} from '../core.js';

const V = { me: null, dash: null, ops: [], requests: [], agents: [], tab: 'statement', filter: '', agentId: '' };

// ---------- shared sheets ----------
export function openTopupRequest(onDone) {
  let receipt = '';
  sheet({
    title: 'طلب شحن رصيد',
    subtitle: 'يصل الطلب إلى المدير فوراً، ويُضاف المبلغ لرصيدك عند الموافقة',
    body: `
      <div class="field"><label for="tp-amount">المبلغ (₪)</label>
        <input class="input ltr big" id="tp-amount" name="amount" type="number" min="1" step="1" inputmode="numeric" placeholder="0">
        <div class="chips">${[100, 200, 500, 1000].map((v) => `<button type="button" class="chip" data-amt="${v}">${v} ₪</button>`).join('')}</div></div>
      <div class="field"><label for="tp-note">ملاحظة <span class="opt">(طريقة الدفع، رقم الحوالة…)</span></label>
        <input class="input" id="tp-note" name="note" placeholder="مثال: حوالة بنكية رقم 4471"></div>
      <label class="upload" for="tp-file"><span class="tile sm">${icon('camera')}</span><span class="grow"><b>صورة الإيصال</b><br><small class="muted">اختياري — صوّر الإيصال أو اختره من المعرض</small></span>
        <img id="tp-preview" alt="" hidden><input id="tp-file" type="file" accept="image/*"></label>`,
    submit: 'إرسال الطلب',
    onMount(form) {
      form.querySelectorAll('[data-amt]').forEach((b) => b.addEventListener('click', () => { form.amount.value = b.dataset.amt; }));
      form.querySelector('#tp-file').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        receipt = await fileToDataUrl(f, { max: 1400 });
        const img = form.querySelector('#tp-preview');
        img.src = receipt;
        img.hidden = false;
      });
    },
    async onSubmit(form) {
      const amount = Number(field(form, 'amount'));
      if (!(amount > 0)) throw new Error('أدخل المبلغ المطلوب');
      await api.post('/api/tasks', { type: 'topup', amount, note: field(form, 'note'), attachment: receipt });
      changed();
      onDone?.();
      return 'أُرسل طلب الشحن إلى المدير';
    },
  });
}

export async function openAgentBalance(agentId, onDone) {
  const agents = (await api.get('/api/agents')).filter((a) => a.active || a.id === agentId);
  const current = () => agents.find((a) => a.id === Number(document.querySelector('#ab-agent')?.value || agentId));
  sheet({
    title: 'رصيد الوكيل',
    body: `
      <div class="field"><label for="ab-agent">الوكيل</label><select class="input" id="ab-agent" name="agent">
        <option value="">اختر الوكيل</option>${agents.map((a) => `<option value="${a.id}" ${a.id === agentId ? 'selected' : ''}>${esc(a.name)} — ${fmtMoney(a.balance)}</option>`).join('')}</select></div>
      <div class="segmented" id="ab-kind">${[['topup', 'شحن'], ['deduct', 'خصم'], ['set', 'تعيين رصيد']].map(([k, l], i) => `<button type="button" data-kind="${k}" aria-pressed="${i === 0}">${l}</button>`).join('')}</div>
      <div class="field"><label for="ab-amount">المبلغ (₪)</label><input class="input ltr big" id="ab-amount" name="amount" type="number" step="0.01" inputmode="decimal" placeholder="0"></div>
      <div class="field"><label for="ab-note">ملاحظة <span class="opt">(تظهر للوكيل في كشف حسابه)</span></label><input class="input" id="ab-note" name="note" placeholder="مثال: دفعة نقدية"></div>
      <div class="balance-preview" id="ab-preview"></div>`,
    submit: 'تنفيذ',
    onMount(form) {
      form.dataset.kind = 'topup';
      form.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
        form.dataset.kind = b.dataset.kind;
        form.querySelectorAll('[data-kind]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        form.dispatchEvent(new Event('input'));
      }));
    },
    onInput(form) {
      const a = current();
      const box = form.querySelector('#ab-preview');
      if (!a) { box.innerHTML = ''; return; }
      const amt = Number(field(form, 'amount')) || 0;
      const kind = form.dataset.kind || 'topup';
      const after = round(kind === 'set' ? amt : kind === 'topup' ? a.balance + amt : a.balance - amt);
      box.innerHTML = `<div><span>الرصيد قبل</span><b>${fmtMoney(a.balance)}</b></div><div><span>التغيير</span><b>${signedMoney(round(after - a.balance))}</b></div>
        <div><span>الرصيد بعد</span><b class="${after < 0 ? 'minus' : ''}">${fmtMoney(after)}</b></div>`;
    },
    async onSubmit(form) {
      const a = current();
      if (!a) throw new Error('اختر الوكيل');
      await api.post(`/api/agents/${a.id}/balance`, { kind: form.dataset.kind || 'topup', amount: field(form, 'amount'), note: field(form, 'note') });
      changed();
      onDone?.();
      return 'تم تحديث رصيد الوكيل';
    },
  });
}

export async function openTransfer() {
  const agents = (await api.get('/api/agents')).filter((a) => a.active);
  sheet({
    title: 'نقل رصيد بين وكيلين',
    body: `
      <div class="field"><label for="tr-from">من الوكيل</label><select class="input" id="tr-from" name="from"><option value="">اختر</option>
        ${agents.map((a) => `<option value="${a.id}">${esc(a.name)} — ${fmtMoney(a.balance)}</option>`).join('')}</select></div>
      <div class="field"><label for="tr-to">إلى الوكيل</label><select class="input" id="tr-to" name="to"><option value="">اختر</option>
        ${agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="tr-amount">المبلغ (₪)</label><input class="input ltr big" id="tr-amount" name="amount" type="number" min="0" step="0.01" inputmode="decimal"></div>`,
    submit: 'نقل الرصيد',
    async onSubmit(form) {
      await api.post('/api/transfer', { fromId: Number(field(form, 'from')), toId: Number(field(form, 'to')), amount: field(form, 'amount') });
      changed();
      return 'تم نقل الرصيد';
    },
  });
}

// ---------- page ----------
const FILTERS = [['', 'الكل'], ['in', 'شحن ووارد'], ['out', 'مدفوعات وخصومات']];

function statementHtml() {
  let ops = V.ops;
  if (V.filter === 'in') ops = ops.filter((o) => o.amount > 0);
  if (V.filter === 'out') ops = ops.filter((o) => o.amount < 0);
  if (!ops.length) return empty('wallet', 'لا توجد حركات', 'ستظهر هنا كل عمليات الشحن والخصم والتفعيل.');
  return `<div class="card card-pad">${ops.map((o) => {
    const [ic, color] = OP_ICON[o.type] || ['wallet', ''];
    return `<div class="op-row"><span class="tile sm ${color === 'blue' ? '' : color}">${icon(ic)}</span>
      <div class="grow"><b>${OP[o.type] || o.type}</b> ${o.number ? phone(o.number) : ''}
        <div class="item-sub">${o.package ? `<span>${esc(o.package)}</span>` : ''}${o.detail ? `<span>${esc(o.detail)}</span>` : ''}${isAdmin() ? `<span>${esc(o.agentName)}</span>` : ''}<span>${fmtDateTime(o.ts)}</span></div></div>
      <div style="text-align:end">${signedMoney(o.amount)}${o.after !== null ? `<div class="small muted ltr">${fmtMoney(o.after)}</div>` : ''}</div></div>`;
  }).join('')}</div>`;
}

function requestsHtml() {
  if (!V.requests.length) return empty('send', 'لا توجد طلبات شحن', isAdmin() ? 'تظهر هنا طلبات الوكلاء.' : 'اطلب شحن رصيدك وأرفق صورة الإيصال.');
  return `<div class="list">${V.requests.map((t) => `<div class="item"><div class="item-top"><span class="tile sm ${t.status === 'done' ? 'green' : t.status === 'rejected' ? 'red' : 'amber'}">${icon('wallet')}</span>
    <div class="grow"><b class="item-title ltr">${fmtMoney(t.amount)}</b><div class="item-sub">${isAdmin() ? `<span>${esc(t.agentName)}</span>` : ''}<span>${relTime(t.createdAt)}</span>${t.note ? `<span>${esc(t.note)}</span>` : ''}</div></div>
    <span class="pill s-${t.status}">${TASK_STATUS[t.status]}</span></div>
    ${t.response ? `<div class="small muted">ردّ المدير: ${esc(t.response)}</div>` : ''}
    ${isAdmin() && t.status === 'open' ? `<a class="btn btn-sm btn-soft" href="#/tasks">${icon('tasks')}معالجة في المهام</a>` : ''}</div>`).join('')}</div>`;
}

function walletCard() {
  if (isAdmin()) {
    const d = V.dash;
    return `<section class="wallet"><small>مجموع أرصدة الوكلاء</small><div class="amount">${fmtMoney(d.balances)}</div>
      <div class="row"><span>ديون الوكلاء <b class="ltr">${fmtMoney(d.debt)}</b></span><span>عدد الوكلاء <b>${d.agents}</b></span><span>مبيعات الشهر <b class="ltr">${fmtMoney(d.month.revenue)}</b></span></div>
      <div class="btn-row"><button class="btn" data-action="agent-balance">${icon('plus')}شحن رصيد وكيل</button><button class="btn btn-ghost" data-action="transfer">${icon('swap')}نقل رصيد</button></div></section>`;
  }
  const u = V.me;
  const used = u.creditLimit > 0 ? Math.min(100, Math.round((Math.max(0, -u.balance) / u.creditLimit) * 100)) : 0;
  return `<section class="wallet"><small>الرصيد المتاح</small><div class="amount">${fmtMoney(u.available)}</div>
    ${u.creditLimit > 0 ? `<div class="meter ${used >= 80 ? 'warn' : ''}"><i style="width:${used}%"></i></div>` : ''}
    <div class="row"><span>الرصيد <b class="ltr">${fmtMoney(u.balance)}</b></span><span>سقف الدين <b class="ltr">${fmtMoney(u.creditLimit)}</b></span>${u.creditLimit > 0 ? `<span>مستخدم ${used}%</span>` : ''}</div>
    <div class="btn-row"><button class="btn" data-action="topup">${icon('plus')}طلب شحن رصيد</button></div></section>`;
}

export default {
  title: () => ({ title: 'المدفوعات', subtitle: 'الرصيد وكشف الحساب وطلبات الشحن' }),
  async load() {
    const [ops, requests, extra, agents] = await Promise.all([
      api.get(`/api/ops?money=1&limit=300${isAdmin() && V.agentId ? `&agentId=${V.agentId}` : ''}`),
      api.get('/api/tasks?type=topup'),
      isAdmin() ? api.get(`/api/dashboard?tz=${tz()}`) : api.get('/api/me'),
      isAdmin() ? api.get('/api/agents') : [],
    ]);
    V.ops = ops;
    V.requests = requests;
    V.agents = agents;
    if (isAdmin()) V.dash = extra; else V.me = extra.user;
  },
  render() {
    const open = V.requests.filter((t) => t.status === 'open').length;
    return `
      ${walletCard()}
      <div class="segmented"><button data-action="tab" data-tab="statement" aria-pressed="${V.tab === 'statement'}">كشف الحساب</button>
        <button data-action="tab" data-tab="requests" aria-pressed="${V.tab === 'requests'}">طلبات الشحن${open ? ` (${open})` : ''}</button></div>
      ${V.tab === 'statement' ? `<div class="toolbar"><div class="chips">${FILTERS.map(([k, l]) => `<button class="chip" data-action="filter" data-f="${k}" aria-pressed="${V.filter === k}">${l}</button>`).join('')}</div>
        ${isAdmin() ? `<select class="input" id="pay-agent" style="width:auto;min-width:170px"><option value="">كل الوكلاء</option>${V.agents.map((a) => `<option value="${a.id}" ${String(a.id) === String(V.agentId) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}
        <a class="link" href="#/reports?r=statement">${icon('chart')}تصدير كشف الحساب</a></div>
        ${statementHtml()}` : requestsHtml()}`;
  },
  mount(root, ctx) {
    root.querySelector('#pay-agent')?.addEventListener('change', (e) => { V.agentId = e.target.value; ctx.reload(); });
  },
  actions: {
    tab(btn, e, ctx) { V.tab = btn.dataset.tab; ctx.rerender(); },
    filter(btn, e, ctx) { V.filter = btn.dataset.f; ctx.rerender(); },
    topup: () => openTopupRequest(),
    'agent-balance': () => openAgentBalance(V.agentId ? Number(V.agentId) : null),
    transfer: () => openTransfer(),
  },
};

