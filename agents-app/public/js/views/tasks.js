import {
  api, esc, icon, isAdmin, fmtMoney, fmtDate, phone, sheet, field, changed, fileToDataUrl, relTime, TASK_STATUS, TASK_TYPE, empty, daysText,
} from '../core.js';
import { openRenew } from './renew.js';
import { openTopupRequest } from './payments.js';

const V = { tasks: [], due: [], tab: 'open' };
const TYPE_ICON = { topup: ['wallet', 'green'], port: ['repeat', 'amber'], esim: ['qr', 'cyan'], general: ['msg', ''] };

function taskCard(t) {
  const [ic, color] = TYPE_ICON[t.type];
  const admin = isAdmin();
  return `<article class="item">
    <div class="item-top"><span class="tile sm ${color}">${icon(ic)}</span>
      <div class="grow"><b class="item-title">${TASK_TYPE[t.type]}${t.amount !== null && t.type === 'topup' ? ` · <span class="ltr">${fmtMoney(t.amount)}</span>` : ''}</b>
        <div class="item-sub">${admin ? `<span>${esc(t.agentName)}</span>` : ''}<span>${relTime(t.createdAt)}</span>${t.lineNumber ? `<span>${phone(t.lineNumber)}</span>` : ''}</div></div>
      <span class="pill s-${t.status}">${TASK_STATUS[t.status]}</span></div>
    ${t.note ? `<p class="small" style="color:var(--ink-2)">${esc(t.note)}</p>` : ''}
    ${t.response ? `<p class="small muted">الرد: ${esc(t.response)}${t.resolvedBy ? ` — ${esc(t.resolvedBy)}` : ''}</p>` : ''}
    <div class="item-actions">
      ${t.hasAttachment ? `<button class="btn btn-sm" data-action="attachment" data-id="${t.id}">${icon('image')}عرض المرفق</button>` : ''}
      ${admin && t.status === 'open' ? `<button class="btn btn-sm btn-good" data-action="resolve" data-id="${t.id}">${icon('check')}تنفيذ</button>
        <button class="btn btn-sm btn-danger" data-action="reject" data-id="${t.id}">${icon('x')}رفض</button>` : ''}
      ${!admin && t.status === 'open' && ['topup', 'general'].includes(t.type) ? `<button class="btn btn-sm btn-ghost" data-action="cancel" data-id="${t.id}">إلغاء الطلب</button>` : ''}
    </div></article>`;
}

function dueCard(l) {
  return `<article class="item"><div class="item-top"><span class="co-dot" style="--co:${esc(l.companyColor)}"></span>
    <div class="grow">${phone(l.number)}<div class="item-sub"><span>${esc(l.customerName || 'بدون اسم')}</span><span>${esc(l.packageLabel)}</span></div></div>
    <span class="pill s-${l.state}">${l.daysLeft >= 0 ? `بعد ${daysText(l.daysLeft)}` : `منذ ${daysText(-l.daysLeft)}`}</span></div>
    <div class="item-top" style="justify-content:space-between"><span class="small muted">${l.daysLeft >= 0 ? 'تنتهي' : 'انتهت'} ${fmtDate(l.expiresAt)}</span>
      <button class="btn btn-soft btn-sm" data-action="renew" data-id="${l.id}">${icon('repeat')}تمديد</button></div></article>`;
}

function newRequest() {
  sheet({
    title: 'طلب جديد',
    body: `<div class="action-list">
      <button type="button" data-kind="topup"><span class="tile sm green">${icon('wallet')}</span>طلب شحن رصيد</button>
      <button type="button" data-kind="general"><span class="tile sm">${icon('msg')}</span>طلب أو رسالة للمدير</button></div>`,
    onMount(form, el) {
      el.querySelector('[data-kind="topup"]').addEventListener('click', () => openTopupRequest());
      el.querySelector('[data-kind="general"]').addEventListener('click', () => sheet({
        title: 'رسالة للمدير',
        body: `<div class="field"><label for="gq-note">ماذا تحتاج؟</label><textarea class="input" id="gq-note" name="note" rows="4" placeholder="مثال: أحتاج 20 شريحة سلكوم جديدة"></textarea></div>`,
        submit: 'إرسال',
        async onSubmit(f) {
          if (!field(f, 'note')) throw new Error('اكتب تفاصيل الطلب');
          await api.post('/api/tasks', { type: 'general', note: field(f, 'note') });
          changed();
          return 'أُرسل الطلب إلى المدير';
        },
      }));
    },
  });
}

async function resolveTask(t) {
  let qr = '';
  const body = {
    topup: `<div class="field"><label for="rs-amount">المبلغ المضاف إلى رصيد ${esc(t.agentName)} (₪)</label>
        <input class="input ltr big" id="rs-amount" name="amount" type="number" min="0" step="0.01" inputmode="decimal" value="${t.amount ?? ''}"></div>`,
    esim: `<div class="field"><label for="rs-code">رمز تفعيل eSIM (LPA)</label><textarea class="input ltr" id="rs-code" name="esimCode" rows="2" placeholder="LPA:1$…"></textarea></div>
      <label class="upload" for="rs-qr"><span class="tile sm cyan">${icon('qr')}</span><span class="grow"><b>صورة رمز QR</b><br><small class="muted">يراها الوكيل في تفاصيل الرقم ليعرضها على الزبون</small></span>
        <img id="rs-qr-prev" alt="" hidden><input id="rs-qr" type="file" accept="image/*"></label>`,
    port: `<p class="muted">بعد إتمام التحويل لدى الشركة يصبح الرقم فعّالاً، ويبدأ احتساب مدة الرزمة من الآن.</p>`,
    general: '',
  }[t.type];
  sheet({
    title: `تنفيذ: ${TASK_TYPE[t.type]}`,
    subtitle: `${esc(t.agentName)}${t.lineNumber ? ` · ${t.lineNumber}` : ''}`,
    body: `${body}<div class="field"><label for="rs-resp">ملاحظة للوكيل <span class="opt">(اختياري)</span></label><input class="input" id="rs-resp" name="response"></div>`,
    submit: 'تم التنفيذ',
    onMount(form) {
      form.querySelector('#rs-qr')?.addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        qr = await fileToDataUrl(f, { max: 700, type: 'image/png' });
        const img = form.querySelector('#rs-qr-prev');
        img.src = qr; img.hidden = false;
      });
    },
    async onSubmit(form) {
      const payload = { status: 'done', response: field(form, 'response') };
      if (t.type === 'topup') payload.amount = field(form, 'amount');
      if (t.type === 'esim') { payload.esimCode = field(form, 'esimCode'); payload.attachment = qr; }
      await api.post(`/api/tasks/${t.id}/resolve`, payload);
      changed();
      return t.type === 'topup' ? 'تم شحن رصيد الوكيل' : 'تم تنفيذ الطلب';
    },
  });
}

export default {
  title: () => ({ title: 'المهام', subtitle: isAdmin() ? 'طلبات الوكلاء بانتظار التنفيذ' : 'تجديدات مستحقة وطلباتك' }),
  async load() {
    const [tasks, lines] = await Promise.all([api.get('/api/tasks'), isAdmin() ? [] : api.get('/api/lines?status=active')]);
    V.tasks = tasks;
    V.due = lines.filter((l) => l.state === 'expiring' || (l.state === 'expired' && l.daysLeft > -30)).sort((a, b) => a.expiresAt - b.expiresAt);
  },
  render() {
    if (isAdmin()) {
      const open = V.tasks.filter((t) => t.status === 'open');
      const closed = V.tasks.filter((t) => t.status !== 'open');
      const list = V.tab === 'open' ? open : closed;
      return `
        <div class="segmented"><button data-action="tab" data-tab="open" aria-pressed="${V.tab === 'open'}">مفتوحة (${open.length})</button>
          <button data-action="tab" data-tab="closed" aria-pressed="${V.tab === 'closed'}">المنجزة</button></div>
        ${list.length ? `<div class="grid-cards">${list.map(taskCard).join('')}</div>`
          : empty('checkCircle', V.tab === 'open' ? 'لا توجد مهام مفتوحة' : 'لا توجد مهام منجزة', V.tab === 'open' ? 'طلبات الشحن وتحويل الأرقام وeSIM تظهر هنا.' : '')}`;
    }
    return `
      <section class="list"><div class="section-title"><h2 class="dot-title">تجديدات مستحقة</h2><span class="muted small">${V.due.length}</span></div>
        ${V.due.length ? `<div class="grid-cards">${V.due.map(dueCard).join('')}</div>` : empty('checkCircle', 'لا توجد رزم تنتهي قريباً', 'سنذكّرك هنا قبل انتهاء رزمة أي زبون.')}</section>
      <section class="list"><div class="section-title"><h2 class="dot-title">طلباتي</h2><button class="btn btn-primary btn-sm" data-action="new-request">${icon('plus')}طلب جديد</button></div>
        ${V.tasks.length ? `<div class="grid-cards">${V.tasks.map(taskCard).join('')}</div>` : empty('send', 'لا توجد طلبات', 'اطلب شحن الرصيد أو أرسل رسالة للمدير.')}</section>`;
  },
  actions: {
    tab(btn, e, ctx) { V.tab = btn.dataset.tab; ctx.rerender(); },
    renew: (btn) => openRenew(V.due.find((l) => l.id === Number(btn.dataset.id))),
    'new-request': newRequest,
    async attachment(btn) {
      const t = await api.get(`/api/tasks/${btn.dataset.id}`);
      sheet({ title: 'المرفق', body: `<img class="thumb" style="max-height:70vh" src="${esc(t.attachment)}" alt="مرفق الطلب">` });
    },
    resolve: (btn) => resolveTask(V.tasks.find((t) => t.id === Number(btn.dataset.id))),
    reject(btn) {
      const t = V.tasks.find((x) => x.id === Number(btn.dataset.id));
      sheet({
        title: `رفض: ${TASK_TYPE[t.type]}`,
        body: `${['port', 'esim'].includes(t.type) ? `<div class="msg info">${icon('info')}<span>يُسترد للوكيل المبلغ كاملاً (${fmtMoney(t.amount)}) ويُحذف الرقم من قائمته.</span></div>` : ''}
          <div class="field"><label for="rj-reason">السبب</label><input class="input" id="rj-reason" name="response" placeholder="يظهر للوكيل"></div>`,
        submit: 'رفض الطلب', danger: true,
        async onSubmit(form) {
          await api.post(`/api/tasks/${t.id}/resolve`, { status: 'rejected', response: field(form, 'response') });
          changed();
          return 'تم رفض الطلب';
        },
      });
    },
    async cancel(btn) {
      await api.post(`/api/tasks/${btn.dataset.id}/cancel`);
      changed();
    },
  },
};
