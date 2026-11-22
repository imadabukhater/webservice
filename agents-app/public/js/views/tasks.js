import {
  api, esc, icon, fmtMoney, phone, sheet, field, changed, fileToDataUrl, relTime, TASK_STATUS, empty, copyText,
} from '../core.js';

// eSIM activations of paid shop orders: carried out by the supplier automatically, or by the manager when that did
// not work (attach the QR code) — or rejected with a reason.
const V = { tasks: [], tab: 'open' };

// What the supplier did with an activation. failed/unknown need the manager; while sending or sent, wait.
const AUTO = {
  sending: ['clock', 'info', 'يُرسل الآن إلى المورّد…'], sent: ['clock', 'info', 'أُرسل — بانتظار تأكيد المورّد'],
  done: ['checkCircle', 'info', 'نُفّذ تلقائياً'], failed: ['alert', '', 'لم ينجح التفعيل التلقائي — نفّذه يدوياً (أرفق رمز QR) أو ارفضه'],
  unknown: ['alert', 'warn', 'غير مؤكد — افحص عند المورّد قبل أي تنفيذ يدوي'],
};
const running = (t) => ['sending', 'sent'].includes(t.autoStatus);
const needsYou = (t) => t.status === 'open' && !running(t);

function autoBox(t) {
  const [ic, cls, label] = AUTO[t.autoStatus] || AUTO.sent;
  return `<div class="msg ${cls}">${icon(ic)}<span><b>${label}</b>${t.autoNote ? `<br><small>${esc(t.autoNote)}</small>` : ''}</span></div>`;
}

function taskCard(t) {
  return `<article class="item">
    <div class="item-top"><span class="tile sm cyan">${icon('qr')}</span>
      <div class="grow"><b class="item-title">تفعيل eSIM${t.amount !== null && t.amount !== undefined ? ` · <span class="ltr">${fmtMoney(t.amount)}</span>` : ''}</b>
        <div class="item-sub"><span>${relTime(t.createdAt)}</span>${t.lineNumber ? `<span>${phone(t.lineNumber)}</span>` : ''}${t.source ? `<span>المورّد: ${esc(t.source)}</span>` : ''}</div></div>
      <span class="pill s-${esc(t.status)}">${esc(TASK_STATUS[t.status] || t.status)}</span></div>
    ${t.note ? `<p class="small" style="color:var(--ink-2)">${esc(t.note)}</p>` : ''}
    ${t.autoStatus ? autoBox(t) : ''}
    ${t.response ? `<p class="small muted">الرد: ${esc(t.response)}${t.resolvedBy ? ` — ${esc(t.resolvedBy)}` : ''}</p>` : ''}
    <div class="item-actions">
      ${t.status === 'open' && t.note ? `<button class="btn btn-sm" data-action="copy-task" data-id="${t.id}">${icon('copy')}نسخ التفاصيل</button>` : ''}
      ${t.hasAttachment ? `<button class="btn btn-sm" data-action="attachment" data-id="${t.id}">${icon('image')}رمز QR</button>` : ''}
      ${needsYou(t) ? `<button class="btn btn-sm btn-good" data-action="resolve" data-id="${t.id}">${icon('check')}تم التفعيل</button>
        <button class="btn btn-sm btn-danger" data-action="reject" data-id="${t.id}">${icon('x')}رفض</button>` : ''}
    </div></article>`;
}

function resolveTask(t) {
  let qr = '';
  sheet({
    title: 'تنفيذ تفعيل eSIM',
    subtitle: t.lineNumber ? esc(t.lineNumber) : '',
    body: `${t.note ? `<div class="msg info" style="align-items:center">${icon('info')}<span class="grow">${esc(t.note)}</span>
        <button type="button" class="btn btn-sm" data-copy-note>${icon('copy')}نسخ</button></div>` : ''}
      <div class="field"><label for="rs-code">رمز تفعيل eSIM (LPA) <span class="opt">(اختياري)</span></label><textarea class="input ltr" id="rs-code" name="esimCode" rows="2" placeholder="LPA:1$…"></textarea></div>
      <label class="upload" for="rs-qr"><span class="tile sm cyan">${icon('qr')}</span><span class="grow"><b>صورة رمز QR</b><br><small class="muted">تظهر للزبون في صفحة طلبه وتُرسل إلى بريده</small></span>
        <img id="rs-qr-prev" alt="" hidden><input id="rs-qr" type="file" accept="image/*"></label>
      <div class="field"><label for="rs-resp">ملاحظة <span class="opt">(اختياري)</span></label><input class="input" id="rs-resp" name="response"></div>`,
    submit: 'تم التفعيل',
    onMount(form) {
      form.querySelector('[data-copy-note]')?.addEventListener('click', () => copyText(t.note));
      form.querySelector('#rs-qr').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        qr = await fileToDataUrl(f, { max: 700, type: 'image/png' });
        const img = form.querySelector('#rs-qr-prev');
        img.src = qr; img.hidden = false;
      });
    },
    async onSubmit(form) {
      await api.post(`/api/tasks/${t.id}/resolve`, { status: 'done', response: field(form, 'response'), esimCode: field(form, 'esimCode'), attachment: qr });
      changed();
      return 'تم تفعيل الـ eSIM';
    },
  });
}

export default {
  title: () => ({ title: 'التفعيلات', subtitle: 'تفعيل شرائح eSIM للطلبات المدفوعة' }),
  async load() {
    V.tasks = await api.get('/api/tasks');
  },
  render() {
    const mine = V.tasks.filter(needsYou);
    const auto = V.tasks.filter((t) => t.status === 'open' && running(t));
    const closed = V.tasks.filter((t) => t.status !== 'open');
    const tab = ['open', 'auto', 'closed'].includes(V.tab) ? V.tab : 'open';
    const list = { open: mine, auto, closed }[tab];
    const none = {
      open: ['checkCircle', 'لا شيء يحتاج تدخلك', 'التفعيلات التي لم تنجح تلقائياً تظهر هنا.'],
      auto: ['clock', 'لا شيء يُنفَّذ الآن', 'ما يُرسل إلى المورّد يظهر هنا حتى يكتمل.'],
      closed: ['checkCircle', 'لا توجد تفعيلات منجزة', ''],
    }[tab];
    return `
      <div class="segmented"><button data-action="tab" data-tab="open" aria-pressed="${tab === 'open'}">تحتاج تدخلك (${mine.length})</button>
        <button data-action="tab" data-tab="auto" aria-pressed="${tab === 'auto'}">يُنفَّذ تلقائياً (${auto.length})</button>
        <button data-action="tab" data-tab="closed" aria-pressed="${tab === 'closed'}">المنجزة</button></div>
      ${list.length ? `<div class="grid-cards">${list.map(taskCard).join('')}</div>` : empty(...none)}`;
  },
  actions: {
    tab(btn, e, ctx) { V.tab = btn.dataset.tab; ctx.rerender(); },
    async attachment(btn) {
      const t = await api.get(`/api/tasks/${btn.dataset.id}`);
      sheet({ title: 'رمز QR', body: `<img class="thumb" style="max-height:70vh" src="${esc(t.attachment)}" alt="رمز QR">` });
    },
    resolve: (btn) => resolveTask(V.tasks.find((t) => t.id === Number(btn.dataset.id))),
    'copy-task': (btn) => copyText(V.tasks.find((t) => t.id === Number(btn.dataset.id)).note),
    reject(btn) {
      const t = V.tasks.find((x) => x.id === Number(btn.dataset.id));
      sheet({
        title: 'رفض تفعيل eSIM',
        body: `<div class="msg info">${icon('info')}<span>الطلب مدفوع: بعد الرفض راجع إرجاع المبلغ للزبون من «متجر الزبائن».</span></div>
          <div class="field"><label for="rj-reason">السبب</label><input class="input" id="rj-reason" name="response"></div>`,
        submit: 'رفض', danger: true,
        async onSubmit(form) {
          await api.post(`/api/tasks/${t.id}/resolve`, { status: 'rejected', response: field(form, 'response') });
          changed();
          return 'تم الرفض';
        },
      });
    },
  },
};
