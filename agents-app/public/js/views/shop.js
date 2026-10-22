import {
  api, esc, icon, fmtMoney, fmtDateTime, relTime, phone, sheet, field, changed, empty, copyText, toast,
} from '../core.js';

const V = { tab: 'orders', filter: 'open', orders: [], mails: [], keys: [], settings: null, agents: [] };

const STAGE = {
  awaiting_payment: ['بانتظار التحويل', ''], verifying: ['يتحقق تلقائياً', 'open'], review: ['تحقق يدوي', 'open'],
  processing: ['قيد التفعيل', 'pending'], paid_issue: ['مدفوع — يحتاج تدخلك', 'rejected'], done: ['تم', 'done'],
  failed: ['تعذّر', 'rejected'], rejected: ['مرفوض', 'rejected'], cancelled: ['ملغى', ''],
};

function orderCard(o) {
  const [label, cls] = STAGE[o.stage] || [o.stage, ''];
  const proof = [o.payReference && `مرجع: <span class="ltr">${esc(o.payReference)}</span>`, o.payPhone && `من رقم ${phone(o.payPhone)}`, o.payName && `باسم ${esc(o.payName)}`, o.hasReceipt && 'صورة إشعار']
    .filter(Boolean).join(' · ');
  const decidable = ['awaiting_payment', 'verifying', 'review'].includes(o.status);
  return `<article class="item">
    <div class="item-top"><span class="tile sm ${o.stage === 'done' ? 'green' : o.stage === 'review' || o.stage === 'paid_issue' ? 'red' : 'amber'}">${icon('card')}</span>
      <div class="grow"><b class="item-title">${esc(o.packageLabel)} · <span class="ltr">${fmtMoney(o.amount)}</span></b>
        <div class="item-sub"><span class="ltr">${esc(o.code)}</span>${phone(o.number)}<span>${o.esim ? 'eSIM' : o.kind === 'new' ? 'خط جديد' : 'شحن'}</span><span>${relTime(o.createdAt)}</span></div></div>
      <span class="pill s-${cls}">${label}</span></div>
    ${o.customerName ? `<p class="small">الزبون: ${esc(o.customerName)}${o.contactPhone && o.contactPhone !== o.number ? ` · تواصل ${phone(o.contactPhone)}` : ''}</p>` : ''}
    ${proof ? `<p class="small" style="color:var(--ink-2)">${proof}</p>` : ''}
    ${o.verifiedBy ? `<p class="small muted">التحقق: ${esc(o.verifiedBy)}</p>` : ''}
    ${o.error ? `<div class="msg">${icon('alert')}<span>${esc(o.error)}</span></div>` : ''}
    <div class="item-actions">
      <button class="btn btn-sm" data-action="open-order" data-id="${o.id}">${icon('eye')}التفاصيل</button>
      ${decidable ? `<button class="btn btn-sm btn-good" data-action="open-order" data-id="${o.id}">${icon('check')}تأكيد الدفع</button>` : ''}
      ${o.stage === 'paid_issue' ? `<button class="btn btn-sm btn-good" data-action="retry" data-id="${o.id}">${icon('repeat')}إعادة التنفيذ</button>` : ''}
      ${decidable || o.stage === 'paid_issue' ? `<button class="btn btn-sm btn-danger" data-action="reject" data-id="${o.id}">${icon('x')}رفض</button>` : ''}
    </div></article>`;
}

function mailRow(m) {
  return `<article class="item"><div class="item-top"><span class="tile sm ${m.trusted ? 'green' : 'red'}">${icon(m.trusted ? 'shield' : 'alert')}</span>
    <div class="grow"><b class="item-title">${m.amount !== null ? `<span class="ltr">${fmtMoney(m.amount)}</span>` : 'مبلغ غير مقروء'}${m.senderName ? ` · ${esc(m.senderName)}` : ''}</b>
      <div class="item-sub">${m.reference ? `<span class="ltr">${esc(m.reference)}</span>` : ''}${m.senderPhone ? phone(m.senderPhone) : ''}<span>${fmtDateTime(m.receivedAt)}</span></div></div>
    <span class="pill ${m.orderCode ? 's-done' : ''}">${m.orderCode ? `طلب ${esc(m.orderCode)}` : 'غير مستخدم'}</span></div>
    ${!m.trusted ? '<p class="small" style="color:var(--bad)">المرسل غير موثَّق من Gmail — لا يُعتمد تلقائياً. تأكد من التحويل في تطبيق جوال باي.</p>' : ''}
    <div class="item-actions"><button class="btn btn-sm" data-action="open-mail" data-id="${m.id}">${icon('eye')}نص الإشعار</button></div></article>`;
}

function keyRow(k) {
  return `<article class="item"><div class="item-top"><span class="tile sm cyan">${icon('share')}</span>
    <div class="grow"><b class="item-title">${esc(k.name)}</b><div class="item-sub"><span>الوكيل: ${esc(k.agentName)}</span><span class="ltr">${esc(k.prefix)}…</span>
      <span>${k.lastUsedAt ? `آخر استخدام ${relTime(k.lastUsedAt)}` : 'لم يُستخدم بعد'}</span></div></div></div>
    <div class="item-actions"><button class="btn btn-sm btn-danger" data-action="del-key" data-id="${k.id}">${icon('trash')}إلغاء المفتاح</button></div></article>`;
}

function setupNote() {
  const s = V.settings;
  const missing = [!s.shopEnabled && 'المتجر مغلق', !(s.jawwalpayNumber || s.palpayNumber) && 'رقم المحفظة (جوال باي / بال باي)', !s.gmailConfigured && 'ربط Gmail'].filter(Boolean);
  if (!missing.length) return '';
  return `<div class="msg warn">${icon('info')}<span>لإكمال الإعداد: ${missing.join('، ')}. <button class="btn btn-sm btn-soft" data-action="settings">${icon('sliders')}الإعدادات</button></span></div>`;
}

function syncDocs() {
  const origin = location.origin;
  return `<section class="card card-pad"><h3>ربط موقع آخر</h3>
    <p class="small muted">كل مفتاح مرتبط بحساب وكيل: طلبات الموقع تُخصم من رصيده بأسعاره، وتظهر عنده كأي عملية بيع. أرسل المفتاح في الترويسة <span class="ltr">X-Api-Key</span> من خادم الموقع فقط.</p>
    <pre class="ltr small" style="white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface-2);padding:12px;border-radius:12px">GET  ${origin}/api/v1/catalog
GET  ${origin}/api/v1/balance
POST ${origin}/api/v1/orders  {"packageId":1,"number":"0521234567","kind":"recharge","customerName":"","reference":"W-1"}
GET  ${origin}/api/v1/orders/:id</pre></section>`;
}

function openSettings() {
  const s = V.settings;
  sheet({
    title: 'إعدادات متجر الزبائن',
    subtitle: `رابط المتجر: ${location.origin}/`,
    body: `
      <label class="switch-row"><span class="grow"><b>المتجر مفتوح للزبائن</b><small>الباقات التي لها «سعر الزبون» في الشركات والرزم تظهر فيه</small></span><input class="switch" type="checkbox" name="shopEnabled" ${s.shopEnabled ? 'checked' : ''}></label>
      <label class="switch-row"><span class="grow"><b>وضع التفعيل التجريبي بدون انتظار الدفع</b><small>إتاحة تفعيل الطلبات وإظهار كود QR مباشرة عبر واجهة البرمجة دون انتظار التحقق من الدفع (أبقِه مغلقاً في الوضع الفعلي)</small></span><input class="switch" type="checkbox" name="shopInstant" ${s.shopInstant ? 'checked' : ''}></label>
      <div class="row2"><div class="field"><label for="st-title">عنوان المتجر الترحيبي <span class="opt">(اختياري)</span></label><input class="input" id="st-title" name="shopTitle" value="${esc(s.shopTitle || '')}" placeholder="فعّل خطك أو شريحتك الإلكترونية eSIM فوراً"></div>
        <div class="field"><label for="st-sub">وصف المتجر الفرعي <span class="opt">(اختياري)</span></label><input class="input" id="st-sub" name="shopSubtitle" value="${esc(s.shopSubtitle || '')}" placeholder="أفضل الباقات المحلية والـ eSIM بأسعار شفافة وتفعيل فوري"></div></div>
      <div class="row2"><div class="field"><label for="st-jp">رقم محفظة جوال باي</label><input class="input ltr" id="st-jp" name="jawwalpayNumber" value="${esc(s.jawwalpayNumber)}" inputmode="tel"></div>
        <div class="field"><label for="st-jpn">اسم صاحب محفظة جوال باي</label><input class="input" id="st-jpn" name="jawwalpayName" value="${esc(s.jawwalpayName)}"></div></div>
      <div class="row2"><div class="field"><label for="st-pp">رقم بال باي / الدفع لصديق <span class="opt">(اتركه فارغاً إن كان نفس رقم جوال باي)</span></label><input class="input ltr" id="st-pp" name="palpayNumber" value="${esc(s.palpayNumber || '')}" inputmode="tel"></div>
        <div class="field"><label for="st-ppn">اسم المستلم في بال باي <span class="opt">(اختياري)</span></label><input class="input" id="st-ppn" name="palpayName" value="${esc(s.palpayName || '')}"></div></div>
      <div class="divider"></div>
      <h3>بريد إشعارات التحويل (Gmail)</h3>
      <p class="small muted">فعّل IMAP في Gmail وأنشئ «كلمة مرور التطبيقات» من إعدادات أمان حساب Google. البريد يُقرأ فقط ولا تُعلَّم الرسائل كمقروءة.</p>
      <div class="field"><label for="st-gu">عنوان Gmail</label><input class="input ltr" id="st-gu" name="gmailUser" type="email" value="${esc(s.gmailUser)}" autocomplete="off"></div>
      <div class="field"><label for="st-gp">كلمة مرور التطبيقات ${s.gmailConfigured ? '<span class="opt">(محفوظة — اتركها فارغة للإبقاء عليها)</span>' : ''}</label>
        <input class="input ltr" id="st-gp" name="gmailPass" type="password" autocomplete="new-password" placeholder="xxxx xxxx xxxx xxxx"></div>
      <div class="field"><label for="st-mf">نطاق مرسل الإشعارات</label><input class="input ltr" id="st-mf" name="mailFrom" value="${esc(s.mailFrom)}">
        <span class="hint">نطاق المرسل، مثل jawwalpay.ps. كما يعتمد النظام تلقائياً إشعارات بال باي («الدفع لصديق» / SMSForwarder) المرسلة من نفس بريد Gmail المربوط أعلاه.</span></div>
      <button type="button" class="btn btn-soft btn-block" id="st-check">${icon('refresh')}فحص البريد الآن</button>`,
    submit: 'حفظ',
    onMount(form) {
      form.querySelector('#st-check').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const r = await api.post('/api/shop/admin/check-mail');
          toast(`تمت القراءة: ${r.fetched} إشعار جديد، ${r.matched} طلب مطابق`);
          changed();
        } catch (ex) { toast(ex.message, { error: true }); } finally { e.target.disabled = false; }
      });
    },
    async onSubmit(form) {
      V.settings = await api.put('/api/settings', {
        shopEnabled: form.elements.shopEnabled.checked,
        shopInstant: form.elements.shopInstant.checked,
        shopTitle: field(form, 'shopTitle'),
        shopSubtitle: field(form, 'shopSubtitle'),
        jawwalpayNumber: field(form, 'jawwalpayNumber'), jawwalpayName: field(form, 'jawwalpayName'),
        palpayNumber: field(form, 'palpayNumber'), palpayName: field(form, 'palpayName'),
        gmailUser: field(form, 'gmailUser'), gmailPass: field(form, 'gmailPass'), mailFrom: field(form, 'mailFrom'),
      });
      changed();
      return 'تم حفظ إعدادات المتجر';
    },
  });
}

async function openOrder(id) {
  const o = await api.get(`/api/shop/admin/orders/${id}`);
  const decidable = ['awaiting_payment', 'verifying', 'review'].includes(o.status);
  const kv = (k, v) => (v ? `<div>${k}</div><div>${v}</div>` : '');
  sheet({
    title: `طلب ${o.code}`,
    subtitle: `${esc(o.packageLabel)} · ${fmtMoney(o.amount)}`,
    wide: true,
    body: `
      <div class="kv">${kv('الرقم', phone(o.number))}${kv('الشريحة', o.sim ? `<span class="ltr">${esc(o.sim)}</span>` : '')}${kv('الزبون', esc(o.customerName))}
        ${kv('رقم التواصل', o.contactPhone && o.contactPhone !== o.number ? phone(o.contactPhone) : '')}${kv('أُنشئ', fmtDateTime(o.createdAt))}${kv('أرسل التحويل', o.proofAt ? fmtDateTime(o.proofAt) : '')}
        ${kv('الرقم المرجعي', o.payReference ? `<span class="ltr">${esc(o.payReference)}</span>` : '')}${kv('رقم المحوِّل', o.payPhone ? phone(o.payPhone) : '')}${kv('اسم المحوِّل', esc(o.payName))}
        ${kv('التحقق', esc(o.verifiedBy))}${kv('البريد', o.email ? `<span class="ltr">${esc(o.email)}</span>` : '')}
        ${o.esim ? kv('رسوم QR', fmtMoney(o.esimFee || 0)) : ''}
        ${o.esim ? kv('رمز QR', o.qrMailedAt ? `أُرسل بالبريد ${fmtDateTime(o.qrMailedAt)}` : o.email ? 'يُرسل بالبريد بعد التفعيل' : 'يظهر للزبون في صفحة الطلب') : ''}
        ${o.esimCode ? kv('كود التفعيل اليدوي', `<code class="ltr small">${esc(o.esimCode)}</code>`) : ''}</div>
      ${o.esimQr ? `<div style="text-align:center;margin:10px 0"><img src="${esc(o.esimQr)}" alt="رمز QR لـ eSIM" style="max-width:220px;border-radius:16px;border:1px solid var(--line);padding:8px;background:#fff"></div>` : ''}
      ${o.receipt ? `<img class="thumb" style="max-height:50vh" src="${esc(o.receipt)}" alt="صورة إشعار التحويل">` : ''}
      ${o.mail ? `<h3>الإشعار المعتمد</h3><pre class="small" style="white-space:pre-wrap">${esc(o.mail.body)}</pre>` : ''}
      ${decidable ? `<h3>تأكيد الدفع</h3>
        ${o.candidates.length ? `<p class="small muted">إشعارات غير مستخدمة بالمبلغ نفسه. اختر الإشعار الذي يثبت التحويل:</p>
          <div class="list">${o.candidates.map((m) => `<label class="switch-row"><span class="grow"><b>${esc(m.senderName || '—')} ${m.senderPhone ? phone(m.senderPhone) : ''}</b>
            <small>${m.reference ? `<span class="ltr">${esc(m.reference)}</span> · ` : ''}${fmtDateTime(m.receivedAt)}${m.trusted ? '' : ' · <b style="color:var(--bad)">مرسل غير موثَّق</b>'}</small></span>
            <input type="radio" name="mailId" value="${m.id}"></label>`).join('')}
          <label class="switch-row"><span class="grow"><b>بدون إشعار</b><small>تأكدت من التحويل في تطبيق جوال باي</small></span><input type="radio" name="mailId" value="" checked></label></div>`
    : `<div class="msg warn">${icon('info')}<span>لا يوجد إشعار بالمبلغ نفسه. تأكد من التحويل في تطبيق جوال باي قبل التأكيد.</span></div>`}` : ''}`,
    submit: decidable ? 'تأكيد الدفع وتنفيذ الطلب' : 'إغلاق',
    async onSubmit(form) {
      if (!decidable) return '';
      const mailId = form.querySelector('input[name=mailId]:checked')?.value || null;
      const r = await api.post(`/api/shop/admin/orders/${o.id}/approve`, { mailId: mailId ? Number(mailId) : null });
      changed();
      if (r.error) throw new Error(`تم تسجيل الدفع، لكن تعذّر التنفيذ: ${r.error}`);
      return 'تم تأكيد الدفع وتنفيذ الطلب';
    },
  });
}

async function openKeyForm() {
  const agents = (await api.get('/api/agents')).filter((a) => a.active);
  sheet({
    title: 'مفتاح ربط موقع',
    subtitle: 'أنشئ حساب وكيل للموقع أولاً من «الوكلاء» وحدد رصيده وأسعاره',
    body: `
      <div class="field"><label for="k-name">اسم الموقع</label><input class="input" id="k-name" name="name" placeholder="مثال: example.com" required></div>
      <div class="field"><label for="k-agent">حساب الوكيل</label><select class="input" id="k-agent" name="agentId" required><option value="">اختر الوكيل</option>
        ${agents.map((a) => `<option value="${a.id}">${esc(a.name)} — ${fmtMoney(a.balance)}</option>`).join('')}</select></div>`,
    submit: 'إنشاء المفتاح',
    async onSubmit(form) {
      if (!field(form, 'agentId')) throw new Error('اختر الوكيل');
      const r = await api.post('/api/sync-keys', { name: field(form, 'name'), agentId: Number(field(form, 'agentId')) });
      changed({ keepView: true });
      setTimeout(() => sheet({
        title: 'انسخ المفتاح الآن',
        body: `<div class="msg warn">${icon('lock')}<span>لن يظهر هذا المفتاح مرة أخرى. احفظه في إعدادات خادم الموقع.</span></div>
          <pre class="ltr" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(r.key)}</pre>`,
        submit: 'نسخ المفتاح',
        async onSubmit() { await copyText(r.key); return ''; },
        onClose: () => changed(),
      }), 350);
      return 'تم إنشاء المفتاح';
    },
  });
}

const byId = (list, btn) => list.find((x) => x.id === Number(btn.dataset.id));

export default {
  admin: true,
  title: () => ({ title: 'متجر الزبائن', subtitle: 'طلبات الزبائن ودفعات جوال باي' }),
  async load() {
    const filter = V.filter === 'all' ? '' : V.filter;
    const [orders, mails, keys, settings] = await Promise.all([
      api.get(`/api/shop/admin/orders?filter=${filter}`), api.get('/api/shop/admin/mails'), api.get('/api/sync-keys'), api.get('/api/settings'),
    ]);
    Object.assign(V, { orders, mails, keys, settings });
  },
  render() {
    const tabs = [['orders', 'الطلبات'], ['mails', 'إشعارات جوال باي'], ['sites', 'المواقع المرتبطة']];
    let body = '';
    if (V.tab === 'orders') {
      body = `<div class="chips">${[['open', 'تحتاج إجراء'], ['waiting', 'بانتظار التحويل'], ['all', 'الكل']]
        .map(([k, l]) => `<button class="chip" data-action="filter" data-f="${k}" aria-pressed="${V.filter === k}">${l}</button>`).join('')}</div>
        ${V.orders.length ? `<div class="grid-cards">${V.orders.map(orderCard).join('')}</div>`
    : empty('card', V.filter === 'open' ? 'لا توجد طلبات تحتاج إجراء' : 'لا توجد طلبات', 'الطلبات المدفوعة والمطابقة تلقائياً تُنفَّذ دون تدخلك.')}`;
    } else if (V.tab === 'mails') {
      body = V.mails.length ? `<div class="grid-cards">${V.mails.map(mailRow).join('')}</div>`
        : empty('msg', 'لا توجد إشعارات', V.settings.gmailConfigured ? 'يُقرأ البريد كل دقيقة ما دامت هناك طلبات بانتظار الدفع.' : 'اربط Gmail من الإعدادات.');
    } else {
      body = `${V.keys.length ? `<div class="grid-cards">${V.keys.map(keyRow).join('')}</div>` : empty('share', 'لا توجد مواقع مرتبطة', 'أنشئ مفتاحاً لكل موقع يبيع باقاتك.')}
        ${syncDocs()}`;
    }
    return `
      <div class="page-head"><div><h2 class="dot-title">متجر الزبائن</h2><p>رابط المتجر: <a class="ltr" href="/" target="_blank" rel="noopener">${esc(location.origin)}/</a></p></div>
        <div class="btn-row">${V.tab === 'sites' ? `<button class="btn btn-primary" data-action="add-key">${icon('plus')}مفتاح جديد</button>` : ''}
          <button class="btn" data-action="check-mail">${icon('refresh')}فحص البريد</button><button class="btn" data-action="settings">${icon('sliders')}الإعدادات</button></div></div>
      ${setupNote()}
      <div class="segmented">${tabs.map(([k, l]) => `<button data-action="tab" data-tab="${k}" aria-pressed="${V.tab === k}">${l}</button>`).join('')}</div>
      ${body}`;
  },
  actions: {
    tab(btn, e, ctx) { V.tab = btn.dataset.tab; ctx.rerender(); },
    async filter(btn, e, ctx) { V.filter = btn.dataset.f; await ctx.reload(); },
    settings: openSettings,
    async 'check-mail'(btn, e, ctx) {
      btn.disabled = true;
      try {
        const r = await api.post('/api/shop/admin/check-mail');
        toast(`تمت القراءة: ${r.fetched} إشعار جديد، ${r.matched} طلب مطابق`);
        await ctx.reload();
      } finally { btn.disabled = false; }
    },
    'open-order': (btn) => openOrder(Number(btn.dataset.id)),
    async 'open-mail'(btn) {
      const m = await api.get(`/api/shop/admin/mails/${btn.dataset.id}`);
      sheet({ title: m.subject || 'إشعار', subtitle: esc(m.from), body: `<pre class="small" style="white-space:pre-wrap">${esc(m.body)}</pre>`, submit: 'إغلاق', async onSubmit() { return ''; } });
    },
    retry(btn) {
      const o = byId(V.orders, btn);
      sheet({
        title: `إعادة تنفيذ ${o.code}`,
        body: `<div class="msg">${icon('alert')}<span>${esc(o.error)}</span></div>
          <div class="field"><label for="rt-n">الرقم</label><input class="input ltr" id="rt-n" name="number" value="${esc(o.number)}"></div>
          ${o.kind === 'new' ? `<div class="field"><label for="rt-s">الشريحة</label><input class="input ltr" id="rt-s" name="sim" value="${esc(o.sim)}"></div>` : ''}`,
        submit: 'إعادة التنفيذ',
        async onSubmit(form) {
          await api.post(`/api/shop/admin/orders/${o.id}/retry`, { number: field(form, 'number'), sim: form.elements.sim ? field(form, 'sim') : undefined });
          changed();
          return 'تم تنفيذ الطلب';
        },
      });
    },
    reject(btn) {
      const o = byId(V.orders, btn);
      sheet({
        title: `رفض ${o.code}`,
        body: `${o.status === 'paid' ? `<div class="msg warn">${icon('info')}<span>الزبون دفع ${fmtMoney(o.amount)}: أعد له المبلغ عبر جوال باي.</span></div>` : ''}
          <div class="field"><label for="rj">السبب</label><input class="input" id="rj" name="response" placeholder="يظهر للزبون"></div>`,
        submit: 'رفض الطلب', danger: true,
        async onSubmit(form) { await api.post(`/api/shop/admin/orders/${o.id}/reject`, { response: field(form, 'response') }); changed(); return 'تم رفض الطلب'; },
      });
    },
    'add-key': openKeyForm,
    'del-key'(btn) {
      const k = byId(V.keys, btn);
      sheet({
        title: 'إلغاء المفتاح', body: `<p>سيتوقف الموقع «${esc(k.name)}» عن الوصول فوراً.</p>`, submit: 'إلغاء المفتاح', danger: true,
        async onSubmit() { await api.del(`/api/sync-keys/${k.id}`); changed(); return 'تم إلغاء المفتاح'; },
      });
    },
  },
};
