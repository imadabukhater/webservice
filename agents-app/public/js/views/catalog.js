import {
  S, api, esc, icon, money, fmtMoney, sheet, field, changed, loadCatalog, companyLogo, specs, fileToDataUrl, empty, fmtNum, round, relTime, toast,
} from '../core.js';

// A tab is one supplier's one system. Each has its own packages, its own profit percentage, its own sync and its own
// list of price changes awaiting the manager. Packages the manager typed by hand belong to no supplier and are shown
// with art-topup's two tabs, the ones that existed before any supplier.
const V = { tab: 'invoice', q: '', msg: {} };
const TABS = {
  invoice: { label: 'الفواتير', icon: 'sim', color: '', supplier: 'art', kind: 'invoice', note: 'رزم تفعيل خط جديد بشريحة. تظهر للوكيل في «مشترك جديد».' },
  card: { label: 'كروت الشحن', icon: 'card', color: 'green', supplier: 'art', kind: 'card', note: 'كروت وحزم ورصيد لرقم موجود. تظهر للوكيل في «شحن كرت» و«تمديد».' },
  qlcard: { label: 'تمديد QuickLine', short: 'التمديد', icon: 'refresh', color: 'green', supplier: 'ql', kind: 'card', note: 'تمديد خط موجود في QuickLine تحت وكالتك. يُنفَّذ تلقائياً. تظهر للوكيل في «تمديد».' },
  qlinvoice: { label: 'خطوط QuickLine', short: 'الخط الجديد', icon: 'sim', color: '', supplier: 'ql', kind: 'invoice', note: 'تفعيل خط جديد في QuickLine: رقم من أرقامهم المتاحة، eSIM، أو تحويل رقم. يُنفَّذ تلقائياً. تظهر للوكيل في «مشترك جديد».' },
};
// What the manager sees: art-topup's two systems each in its own tab, and QuickLine's two together in one tab.
const VIEWS = {
  invoice: { systems: ['invoice'] },
  card: { systems: ['card'] },
  ql: {
    label: 'QuickLine', icon: 'refresh', systems: ['qlcard', 'qlinvoice'],
    note: 'تمديد الخطوط الموجودة وتفعيل خطوط جديدة (شريحة، eSIM، تحويل رقم) — كلها تُنفَّذ تلقائياً.',
  },
};
const viewKey = () => (VIEWS[V.tab] ? V.tab : /^ql/.test(V.tab) ? 'ql' : 'invoice');
// The tab a system's messages show in.
const viewOf = (systemKey) => (/^ql/.test(systemKey) ? 'ql' : systemKey);
const SUPPLIERS = {
  art: {
    name: 'art-topup', api: 'art', configured: () => S.settings.artConfigured,
    markup: (k) => (k === 'card' ? S.settings.artMarkupCard : S.settings.artMarkupInvoice) ?? 0,
    synced: (k) => (k === 'card' ? S.settings.artSyncedCard : S.settings.artSyncedInvoice),
    markupField: (k) => (k === 'card' ? 'artMarkupCard' : 'artMarkupInvoice'),
  },
  ql: {
    name: 'QuickLine', api: 'quickline', configured: () => S.settings.qlConfigured,
    markup: (k) => (k === 'card' ? S.settings.qlMarkupCard : S.settings.qlMarkupInvoice) ?? 0,
    synced: (k) => (k === 'card' ? S.settings.qlSyncedCard : S.settings.qlSyncedInvoice),
    markupField: (k) => (k === 'card' ? 'qlMarkupCard' : 'qlMarkupInvoice'),
  },
};
const tabOf = (key) => TABS[key] || TABS.invoice;
// The supplier a package came from, for the labels on its card and form.
const supplierName = (p) => SUPPLIERS[p?.supplier]?.name || 'المورّد';
// Packages shown under one tab: its supplier's, plus the hand-typed ones under art-topup's original tabs.
const inTab = (p, t) => p.kind === t.kind && (p.supplier === t.supplier || (!p.supplier && t.supplier === 'art'));
const inView = (p, v) => v.systems.some((k) => inTab(p, TABS[k]));

export function openCompanyForm(c) {
  let logo = c?.logo || '';
  sheet({
    title: c ? `تعديل ${c.name}` : 'شركة جديدة',
    body: `
      <div class="item-top"><span id="co-prev">${companyLogo({ name: c?.name || '؟', color: c?.color || '#2563eb', logo })}</span>
        <div class="grow" style="display:grid;gap:8px">
          <label class="btn btn-sm" for="co-logo">${icon('image')}${logo ? 'تغيير الشعار' : 'رفع شعار'}</label><input id="co-logo" type="file" accept="image/*" hidden>
          <button type="button" class="btn btn-sm btn-ghost" id="co-logo-rm" ${logo ? '' : 'hidden'}>${icon('trash')}إزالة الشعار</button></div></div>
      <div class="field"><label for="co-name">اسم الشركة</label><input class="input" id="co-name" name="name" value="${esc(c?.name || '')}" placeholder="مثال: سلكوم" required></div>
      <div class="field"><label for="co-color">اللون</label><div class="input-group"><input class="input" id="co-color" name="color" type="color" value="${esc(c?.color || '#2563eb')}" style="padding:4px;max-width:90px">
        <span class="hint">يُستعمل عندما لا يوجد شعار، وفي النقاط الملونة بجانب الأرقام.</span></div></div>
      <div class="field"><label for="co-prefix">بادئات أرقام الشرائح (ICCID)</label><input class="input ltr mono" id="co-prefix" name="prefixes" value="${esc((c?.prefixes || []).join(', '))}" placeholder="8997202">
        <span class="hint">أول 7 أرقام من شرائح هذه الشركة. تتعلّمها المنصّة تلقائياً من أول تفعيل، ويمكنك تعديلها هنا.</span></div>
      <div class="field"><span class="label">طريقة التفعيل</span>
        <div class="switches">
          <label class="switch-row"><span class="tile sm">${icon('tasks')}</span><span class="grow"><b>طلب للمدير</b><small>يُخصم المبلغ ويصلك طلب، تفعّل الخط على موقع الشركة ثم تضغط «تنفيذ». يُسترد المبلغ إن رفضت.</small></span>
            <input type="radio" name="activation" value="manual" ${!['direct', 'auto'].includes(c?.activation) ? 'checked' : ''}></label>
          <label class="switch-row"><span class="tile sm green">${icon('refresh')}</span><span class="grow"><b>تلقائي عبر المورّد</b><small>شحن الكروت (art-topup) وتمديد الخطوط (QuickLine) يُنفَّذ تلقائياً من حسابك هناك، للرزم المستوردة منه. وتفعيل خطوط QuickLine الجديدة (شريحة، eSIM، تحويل رقم) تلقائي أيضاً. تفعيل فواتير art-topup يبقى طلباً لك.</small></span>
            <input type="radio" name="activation" value="auto" ${c?.activation === 'auto' ? 'checked' : ''}></label>
          <label class="switch-row"><span class="tile sm amber">${icon('bolt')}</span><span class="grow"><b>تفعيل مباشر</b><small>الخط فعّال فوراً. لا يستطيع الوكيل فصله ولا يُسترد المبلغ.</small></span>
            <input type="radio" name="activation" value="direct" ${c?.activation === 'direct' ? 'checked' : ''}></label>
        </div><span class="hint">eSIM وتحويل الأرقام تصلك دائماً كطلبات.</span></div>`,
    submit: c ? 'حفظ' : 'إضافة الشركة',
    onMount(form) {
      const prev = () => { form.querySelector('#co-prev').innerHTML = companyLogo({ name: field(form, 'name') || '؟', color: field(form, 'color'), logo }); };
      form.querySelector('#co-logo').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        logo = await fileToDataUrl(f, { max: 320, type: 'image/png' });
        form.querySelector('#co-logo-rm').hidden = false;
        prev();
      });
      form.querySelector('#co-logo-rm').addEventListener('click', (e) => { logo = ''; e.currentTarget.hidden = true; prev(); });
      form.addEventListener('input', prev);
    },
    async onSubmit(form) {
      const body = { name: field(form, 'name'), color: field(form, 'color'), logo, prefixes: field(form, 'prefixes'), activation: form.elements.activation.value };
      await (c ? api.put(`/api/companies/${c.id}`, body) : api.post('/api/companies', body));
      await loadCatalog(true);
      changed();
      return c ? 'تم حفظ الشركة' : 'تمت إضافة الشركة';
    },
  });
}

export function openPackageForm(p, companyId, kind = 'invoice') {
  const cos = S.catalog.companies;
  if (!cos.length) { openCompanyForm(null); return; }
  const amountVal = (v) => (v === -1 ? 'غير محدود' : v ?? '');
  const k = p?.kind || kind;
  sheet({
    title: p ? 'تعديل رزمة' : 'رزمة جديدة',
    subtitle: p?.artCode ? `رمز ${supplierName(p)}: <span class="mono ltr">${esc(p.artCode)}</span>` : '',
    body: `
      ${p?.artCode ? `<div class="msg info">${icon('info')}<span>رزمة من ${supplierName(p)}. بعد حفظ تعديلك تبقى قيمك كما هي عند كل مزامنة، وتتحدث «التكلفة» فقط.</span></div>` : ''}
      <div class="field"><span class="label">النظام</span><div class="segmented" id="pk-kind">
        <button type="button" data-kind="invoice" aria-pressed="${k === 'invoice'}">${icon('sim')}فاتورة (تفعيل خط)</button>
        <button type="button" data-kind="card" aria-pressed="${k === 'card'}">${icon('card')}كرت شحن</button></div>
        <input type="hidden" name="kind" value="${k}"></div>
      <div class="field"><label for="pk-co">الشركة</label><select class="input" id="pk-co" name="companyId">${cos.map((c) => `<option value="${c.id}" ${c.id === (p?.companyId ?? companyId) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="pk-name">اسم الرزمة</label><input class="input" id="pk-name" name="name" value="${esc(p?.name || '')}" placeholder="مثال: 300 جيجا رزمة شهرية" required></div>
      <div class="row2"><div class="field"><label for="pk-gb">حجم الإنترنت (GB)</label><input class="input ltr" id="pk-gb" name="dataGb" type="number" min="0" step="1" inputmode="numeric" value="${p?.dataGb ?? ''}"></div>
        <div class="field"><label for="pk-days">المدة بالأيام <span class="opt">(فارغ = شهرية)</span></label><input class="input ltr" id="pk-days" name="days" type="number" min="1" max="730" step="1" inputmode="numeric" value="${p?.days ?? ''}" placeholder="30، 90…"></div></div>
      <div class="field"><label for="pk-tag">وسم <span class="opt">(مثل RENTERS)</span></label><input class="input ltr" id="pk-tag" name="tag" value="${esc(p?.tag || '')}"></div>
      <div class="row2"><div class="field"><label for="pk-min">الدقائق</label><input class="input ltr" id="pk-min" name="minutes" list="unlimited" value="${esc(amountVal(p?.minutes))}" placeholder="5000"></div>
        <div class="field"><label for="pk-sms">الرسائل</label><input class="input ltr" id="pk-sms" name="sms" list="unlimited" value="${esc(amountVal(p?.sms))}" placeholder="5000"></div></div>
      <datalist id="unlimited"><option value="غير محدود"></option></datalist>
      <div class="field"><label for="pk-desc">وصف قصير <span class="opt">(اختياري)</span></label><input class="input" id="pk-desc" name="description" value="${esc(p?.description || '')}"></div>
      <div class="row2"><div class="field"><label for="pk-cost">التكلفة عليك (₪)</label><input class="input ltr" id="pk-cost" name="cost" type="number" min="0" step="0.01" inputmode="decimal" value="${p ? round(p.cost) : ''}"></div>
        <div class="field"><label for="pk-price">سعر الوكيل (₪)</label><input class="input ltr" id="pk-price" name="price" type="number" min="0" step="0.01" inputmode="decimal" value="${p ? round(p.price) : ''}"></div></div>
      <div class="hint" id="pk-margin"></div>
      <label class="switch-row"><span class="grow"><b>ظاهرة للوكلاء</b><small>أوقفها لإخفائها عن الوكلاء</small></span><input class="switch" type="checkbox" name="active" ${!p || p.active ? 'checked' : ''}></label>`,
    submit: p ? 'حفظ' : 'إضافة الرزمة',
    onMount(form) {
      form.querySelectorAll('#pk-kind [data-kind]').forEach((b) => b.addEventListener('click', () => {
        form.elements.kind.value = b.dataset.kind;
        form.querySelectorAll('#pk-kind [data-kind]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }));
    },
    onInput(form) {
      const cost = Number(field(form, 'cost')) || 0;
      const price = Number(field(form, 'price')) || 0;
      const box = form.querySelector('#pk-margin');
      box.className = `hint ${price - cost < 0 ? 'bad' : 'ok'}`;
      box.innerHTML = price ? `${icon('coins')}<span>ربحك في الشهر: ${fmtMoney(price - cost)}</span>` : `${icon('info')}<span>الرزمة بسعر صفر لا تظهر للوكلاء حتى تحدد سعرها.</span>`;
    },
    async onSubmit(form) {
      const body = {
        companyId: Number(field(form, 'companyId')), name: field(form, 'name'), dataGb: field(form, 'dataGb'), minutes: field(form, 'minutes'), sms: field(form, 'sms'),
        tag: field(form, 'tag'), description: field(form, 'description'), cost: field(form, 'cost') || 0, price: field(form, 'price') || 0, active: form.elements.active.checked,
        kind: form.elements.kind.value, days: field(form, 'days'),
      };
      await (p ? api.put(`/api/packages/${p.id}`, body) : api.post('/api/packages', body));
      await loadCatalog(true);
      changed();
      return p ? 'تم حفظ الرزمة' : 'تمت إضافة الرزمة';
    },
  });
}

// ---------- one tab's controls: profit percentage, the supplier's sync, price changes awaiting approval ----------
const markupOf = (key) => { const t = tabOf(key); return SUPPLIERS[t.supplier].markup(t.kind); };

function systemBar(key) {
  const t = tabOf(key);
  const sup = SUPPLIERS[t.supplier];
  const pending = S.catalog.packages.filter((p) => inTab(p, t) && p.artPending).length;
  const synced = sup.synced(t.kind);
  const msg = V.msg[key];
  const other = Object.entries(TABS).filter(([k]) => k !== key).map(([, x]) => x.label).join(' و');
  return `<section class="card card-pad sys-bar">
    <div class="sys-row"><span class="tile sm ${t.color}">${icon('percent')}</span>
      <div class="grow"><b>نسبة ربحك على ${t.label}: <span class="ltr">${markupOf(key)}%</span></b><small>سعر الوكيل = التكلفة + ${markupOf(key)}%. منفصلة عن ${other}.</small></div>
      <button class="btn btn-sm" data-action="set-markup" data-tab="${key}">${icon('edit')}تغيير</button></div>
    <div class="sys-row"><span class="tile sm">${icon('refresh')}</span>
      <div class="grow"><b>المزامنة من ${sup.name}</b><small>${synced ? `آخر مزامنة ${relTime(synced)}` : 'لم تتم بعد'} · تضيف الجديد ولا تغيّر أسعارك الحالية</small></div>
      <button class="btn btn-sm" data-action="sync" data-tab="${key}" ${sup.configured() ? '' : `disabled title="أدخل بيانات ${sup.name} في الإعدادات"`}>${icon('refresh')}مزامنة ${t.label}</button></div>
    ${pending ? `<div class="msg warn" style="align-items:center">${icon('alert')}<span class="grow"><b>${pending} رزمة تغيّر سعرها في ${sup.name}</b> — لن تتغيّر أسعارك إلا بموافقتك.</span>
      <button class="btn btn-sm" data-action="pending" data-tab="${key}">مراجعة</button></div>` : ''}
    ${msg ? `<div class="msg ${msg.error ? '' : 'info'}">${icon(msg.error ? 'alert' : 'checkCircle')}<span>${esc(msg.text)}</span></div>` : ''}
  </section>`;
}

// QuickLine's tab: both systems' percentages, one sync for both, and each system's price changes to review.
function qlBar() {
  const sup = SUPPLIERS.ql;
  const keys = VIEWS.ql.systems;
  const synced = keys.map((k) => sup.synced(TABS[k].kind));
  const last = synced.every(Boolean) ? Math.min(...synced) : null;
  const msg = V.msg.ql;
  const pending = keys.map((k) => [k, S.catalog.packages.filter((p) => inTab(p, TABS[k]) && p.artPending).length]).filter(([, n]) => n);
  return `<section class="card card-pad sys-bar">
    <div class="sys-row"><span class="tile sm green">${icon('percent')}</span>
      <div class="grow"><b>نسبة ربحك: ${keys.map((k) => `${TABS[k].short} <span class="ltr">${markupOf(k)}%</span>`).join(' · ')}</b>
        <small>سعر الوكيل = التكلفة + النسبة، ولكل نوع نسبته.</small></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${keys.map((k) => `<button class="btn btn-sm" data-action="set-markup" data-tab="${k}">${icon('edit')}${TABS[k].short}</button>`).join('')}</div></div>
    <div class="sys-row"><span class="tile sm">${icon('refresh')}</span>
      <div class="grow"><b>المزامنة من QuickLine</b><small>${last ? `آخر مزامنة ${relTime(last)}` : 'لم تتم بعد'} · التمديد والخطوط الجديدة معاً · تضيف الجديد ولا تغيّر أسعارك الحالية</small></div>
      <button class="btn btn-sm" data-action="sync-ql" ${sup.configured() ? '' : 'disabled title="أدخل بيانات QuickLine في الإعدادات"'}>${icon('refresh')}مزامنة QuickLine</button></div>
    ${pending.map(([k, n]) => `<div class="msg warn" style="align-items:center">${icon('alert')}<span class="grow"><b>${n} رزمة ${TABS[k].short} تغيّر سعرها في QuickLine</b> — لن تتغيّر أسعارك إلا بموافقتك.</span>
      <button class="btn btn-sm" data-action="pending" data-tab="${k}">مراجعة</button></div>`).join('')}
    ${msg ? `<div class="msg ${msg.error ? '' : 'info'}">${icon(msg.error ? 'alert' : 'checkCircle')}<span>${esc(msg.text)}</span></div>` : ''}
  </section>`;
}

async function refreshAll(ctx) {
  S.settings = await api.get('/api/settings');
  await loadCatalog(true);
  ctx.rerender();
}

function openMarkup(key, ctx) {
  const d = tabOf(key);
  const sup = SUPPLIERS[d.supplier];
  api.get(`/api/${sup.api}/reprice?kind=${d.kind}`).then((info) => sheet({
    title: `نسبة ربحك على ${d.label}`,
    subtitle: 'سعر الوكيل = التكلفة + النسبة',
    body: `<div class="field"><label for="mk-val">النسبة (%)</label><input class="input ltr big" id="mk-val" name="markup" type="number" min="0" max="200" step="0.5" inputmode="decimal" value="${info.markup}"></div>
      <div class="hint" id="mk-example"></div>
      <div class="field"><span class="label">ماذا يحدث للأسعار الحالية؟</span><div class="switches">
        <label class="switch-row"><span class="grow"><b>طبّقها على الرزم التي لم أعدّل سعرها يدوياً (${info.total - info.edited})</b><small>الرزم التي وضعت سعرها بنفسك (${info.edited}) تبقى كما هي.</small></span><input type="radio" name="scope" value="unedited" checked></label>
        <label class="switch-row"><span class="grow"><b>طبّقها على كل رزم ${d.label} (${info.total})</b><small>تستبدل الأسعار التي وضعتها يدوياً أيضاً.</small></span><input type="radio" name="scope" value="all"></label>
        <label class="switch-row"><span class="grow"><b>احفظ النسبة فقط</b><small>للرزم الجديدة من المزامنة وللاعتمادات القادمة.</small></span><input type="radio" name="scope" value="none"></label>
      </div></div>`,
    submit: 'حفظ',
    onInput(form) {
      const m = Number(field(form, 'markup')) || 0;
      form.querySelector('#mk-example').innerHTML = `${icon('coins')}<span>مثال: رزمة تكلفتها 50 ₪ تصبح للوكيل ${fmtMoney(50 * (1 + m / 100))}</span>`;
    },
    async onSubmit(form) {
      const markup = field(form, 'markup');
      await api.put('/api/settings', { [sup.markupField(d.kind)]: markup });
      const scope = form.elements.scope.value;
      let text = `حُفظت نسبة ${d.label}: ${Number(markup)}%`;
      if (scope !== 'none') {
        const r = await api.post(`/api/${sup.api}/reprice`, { kind: d.kind, scope });
        text += ` — تحدّث سعر ${r.changed} رزمة`;
      }
      V.msg[viewOf(key)] = { text };
      await refreshAll(ctx);
      return text;
    },
  }));
}

function openPending(key, ctx) {
  const d = tabOf(key);
  const sup = SUPPLIERS[d.supplier];
  api.get(`/api/${sup.api}/pending?kind=${d.kind}`).then((rows) => {
    if (!rows.length) { toast('لا توجد تغييرات بانتظارك'); return; }
    const row = (p) => `<article class="item pend-row" data-id="${p.id}">
      <div class="item-top"><div class="grow"><b class="item-title">${esc(p.name)}</b><div class="item-sub"><span>${esc(p.companyName)}</span>${p.active ? '' : '<span>مخفية</span>'}${p.edited ? '<span>سعرها معدّل يدوياً</span>' : ''}</div></div></div>
      <div class="kv small"><div>التكلفة</div><div>${money(p.cost)} ← <b>${money(p.artPrice)}</b></div>
        <div>سعر الوكيل</div><div>${money(p.price)} ← <b>${money(p.suggested)}</b> <span class="muted">(+${markupOf(key)}%)</span></div></div>
      <div class="item-actions"><button type="button" class="btn btn-sm btn-good" data-mode="all">${icon('check')}اعتماد</button>
        <button type="button" class="btn btn-sm" data-mode="cost">التكلفة فقط</button>
        <button type="button" class="btn btn-sm btn-ghost" data-mode="ignore">تجاهل</button></div></article>`;
    sheet({
      title: `تغييرات أسعار ${sup.name} — ${d.label}`,
      subtitle: '«اعتماد»: التكلفة والسعر الجديدان · «التكلفة فقط»: يبقى سعر الوكيل · «تجاهل»: يبقى كل شيء',
      wide: true,
      body: `<div class="list" id="pend-list">${rows.map(row).join('')}</div>`,
      footer: `<button type="button" class="btn btn-primary" data-bulk="all">${icon('check')}اعتماد الكل (${rows.length})</button>
        <button type="button" class="btn" data-bulk="ignore">تجاهل الكل</button>`,
      onMount(form, el) {
        const left = () => form.querySelectorAll('.pend-row').length;
        const act = async (ids, mode) => {
          await api.post(`/api/${sup.api}/approve`, { ids, mode });
          await loadCatalog(true);
          ctx.rerender();
        };
        form.querySelector('#pend-list').addEventListener('click', async (e) => {
          const b = e.target.closest('[data-mode]');
          if (!b) return;
          const card = b.closest('.pend-row');
          card.querySelectorAll('button').forEach((x) => { x.disabled = true; });
          try {
            await act([Number(card.dataset.id)], b.dataset.mode);
            card.remove();
            if (!left()) el.querySelector('[data-close]').click();
          } catch (err) { toast(err.message, { error: true }); card.querySelectorAll('button').forEach((x) => { x.disabled = false; }); }
        });
        el.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', async () => {
          const ids = [...form.querySelectorAll('.pend-row')].map((c) => Number(c.dataset.id));
          b.disabled = true;
          try {
            await act(ids, b.dataset.bulk);
            toast(b.dataset.bulk === 'all' ? `اعتُمد ${ids.length}` : `تُجوهل ${ids.length}`);
            el.querySelector('[data-close]').click();
          } catch (err) { toast(err.message, { error: true }); b.disabled = false; }
        }));
      },
    });
  });
}

function packageCardAdmin(p) {
  return `<article class="pkg-card ${p.active ? '' : 'inactive'}" style="cursor:default">
    <div class="pkg-head"><span class="pkg-name">${esc(p.name)}</span>${p.supplier === 'ql' ? `<span class="pill ${p.kind === 'card' ? 's-active' : 'plain'}">${p.kind === 'card' ? 'تمديد' : 'خط جديد'}</span>` : ''}${p.active ? '' : '<span class="pill">مخفية عن الوكلاء</span>'}${!p.price ? '<span class="pill s-expiring">حدد السعر</span>' : ''}${p.artPending ? `<span class="pill s-expiring">سعر ${supplierName(p)} الجديد: ${fmtMoney(p.artPrice)}</span>` : ''}</div>
    ${p.dataGb ? `<div class="pkg-data"><b>${fmtNum(p.dataGb)}</b><span>GB</span></div>` : ''}
    ${specs(p) ? `<div class="pkg-specs">${specs(p)}</div>` : ''}
    <div class="kv small"><div>المدة</div><div>${p.days ? `${p.days} يوماً` : 'شهرية'}</div>
      <div>التكلفة</div><div>${money(p.cost)}</div><div>سعر الوكيل</div><div>${money(p.price)}</div><div>ربحك</div><div class="${p.price - p.cost < 0 ? 'minus' : 'plus'}">${money(p.price - p.cost)}</div>
      ${p.artCode ? `<div>رمز ${supplierName(p)}</div><div class="mono ltr">${esc(p.artCode)}${p.edited ? ' · <span class="muted">معدّلة</span>' : ''}</div>` : ''}</div>
    <div class="item-actions" style="padding-bottom:16px">
      <button class="btn btn-sm ${p.active ? '' : 'btn-soft'}" data-action="toggle-package" data-id="${p.id}">${icon(p.active ? 'eyeOff' : 'eye')}${p.active ? 'إخفاء' : 'إظهار للوكلاء'}</button>
      <button class="btn btn-sm" data-action="edit-package" data-id="${p.id}">${icon('edit')}تعديل</button>
      <button class="btn btn-sm btn-ghost" data-action="delete-package" data-id="${p.id}">${icon('trash')}حذف</button></div>
    ${p.tag ? `<div class="pkg-tag"><span>${esc(p.tag)}</span><span></span></div>` : ''}
  </article>`;
}

export default {
  admin: true,
  title: () => ({ title: 'الشركات والرزم', subtitle: 'الفواتير وكروت الشحن: الأسعار والأحجام وما يظهر للوكلاء' }),
  async load() { [S.settings] = await Promise.all([api.get('/api/settings'), loadCatalog(true)]); },
  mount(root, ctx) {
    const box = root.querySelector('#pkg-q');
    box?.addEventListener('input', () => {
      V.q = box.value;
      const pos = box.selectionStart;
      ctx.rerender();
      const again = document.getElementById('pkg-q');
      again.focus();
      again.setSelectionRange(pos, pos);
    });
  },
  render() {
    const { companies, packages } = S.catalog;
    const count = (v) => packages.filter((p) => inView(p, v)).length;
    const tabs = `<div class="segmented">${Object.entries(VIEWS).map(([k, v]) => {
      const d = v.label ? v : TABS[v.systems[0]];
      return `<button data-action="tab" data-tab="${k}" aria-pressed="${viewKey() === k && V.tab !== 'companies'}">${icon(d.icon)}${d.label} (${count(v)})</button>`;
    }).join('')}
      <button data-action="tab" data-tab="companies" aria-pressed="${V.tab === 'companies'}">${icon('building')}الشركات (${companies.length})</button></div>`;
    if (V.tab === 'companies') {
      return `${tabs}<div class="page-head"><p>الشعار واللون وبادئات الشرائح وطريقة التفعيل لكل شركة.</p><button class="btn btn-primary" data-action="add-company">${icon('plus')}شركة جديدة</button></div>
        ${companies.length ? `<div class="grid-cards">${companies.map((c) => `<article class="item"><div class="item-top">${companyLogo(c, 'sm')}
          <div class="grow"><b class="item-title">${esc(c.name)}</b><div class="item-sub"><span>${c.packageCount} رزمة</span><span class="mono ltr">${esc((c.prefixes || []).join(', ') || 'بدون بادئة')}</span></div></div>
            <span class="pill ${c.activation === 'direct' ? 's-expiring' : c.activation === 'auto' ? 's-active' : 'plain'}">${{ direct: 'تفعيل مباشر', auto: 'تلقائي' }[c.activation] || 'طلب للمدير'}</span></div>
          <div class="item-actions"><button class="btn btn-sm" data-action="edit-company" data-id="${c.id}">${icon('edit')}تعديل</button>
            <button class="btn btn-sm btn-ghost" data-action="delete-company" data-id="${c.id}">${icon('trash')}حذف</button></div></article>`).join('')}</div>`
          : empty('building', 'لا توجد شركات', 'أضف أول شركة اتصالات.')}`;
    }
    const vk = viewKey();
    const v = VIEWS[vk];
    const t = v.label ? v : TABS[v.systems[0]];
    // QuickLine's packages come from its sync only; hand-typed packages go in art-topup's tabs.
    const canAdd = vk !== 'ql';
    const term = V.q.trim().toLowerCase();
    const mine = packages.filter((p) => inView(p, v) && (!term || `${p.name} ${p.companyName} ${p.artCode}`.toLowerCase().includes(term)));
    const shown = mine.filter((p) => p.active).length;
    // Within a company: extensions first, then new lines.
    const byKind = (a, b) => (a.kind === b.kind ? 0 : a.kind === 'card' ? -1 : 1);
    return `${tabs}${vk === 'ql' ? qlBar() : systemBar(v.systems[0])}<div class="page-head"><p><b>${t.label}:</b> ${t.note} ظاهرة للوكلاء ${shown} من ${mine.length}.</p>
        ${canAdd ? `<button class="btn btn-primary" data-action="add-package">${icon('plus')}رزمة جديدة</button>` : ''}</div>
      <div class="search-box">${icon('search', 'i lead')}<input class="input" id="pkg-q" type="search" placeholder="ابحث باسم الرزمة أو الشركة أو رمز المورّد…" value="${esc(V.q)}" aria-label="بحث في الرزم"></div>
      ${companies.map((c) => {
        const list = mine.filter((p) => p.companyId === c.id).sort(byKind);
        if (!list.length && (term || !packages.some((p) => p.companyId === c.id && inView(p, v)))) return '';
        return `<section class="list"><div class="section-title"><h2 style="display:flex;align-items:center;gap:10px">${companyLogo(c, 'xs')}${esc(c.name)}</h2>
          ${canAdd ? `<button class="btn btn-sm btn-soft" data-action="add-package" data-company="${c.id}">${icon('plus')}رزمة</button>` : ''}</div>
          <div class="pkg-grid">${list.map(packageCardAdmin).join('')}</div></section>`;
      }).join('') || empty(t.icon, term ? 'لا نتائج' : `لا توجد رزم في ${t.label}`, term ? '' : canAdd ? `أضفها يدوياً، أو اضغط «مزامنة ${t.label}» أعلى الصفحة.` : 'اضغط «مزامنة QuickLine» أعلى الصفحة.')}`;
  },
  actions: {
    tab(btn, e, ctx) { V.tab = btn.dataset.tab; ctx.rerender(); },
    'add-company': () => openCompanyForm(null),
    'edit-company': (btn) => openCompanyForm(S.catalog.companies.find((c) => c.id === Number(btn.dataset.id))),
    'delete-company'(btn) {
      const c = S.catalog.companies.find((x) => x.id === Number(btn.dataset.id));
      sheet({
        title: `حذف ${c.name}`, body: `<p>تُحذف الشركة نهائياً. يجب حذف رزمها أولاً.</p>`, submit: 'حذف الشركة', danger: true,
        async onSubmit() { await api.del(`/api/companies/${c.id}`); await loadCatalog(true); changed(); return 'تم حذف الشركة'; },
      });
    },
    'add-package': (btn) => openPackageForm(null, Number(btn.dataset.company) || undefined, TABS[VIEWS[viewKey()].systems[0]].kind),
    // Both QuickLine systems, one after the other, reported together.
    async 'sync-ql'(btn, e, ctx) {
      btn.disabled = true;
      btn.innerHTML = `${icon('clock')}جاري القراءة من QuickLine…`;
      try {
        const parts = [];
        let pending = 0;
        let off = 0;
        for (const k of VIEWS.ql.systems) {
          const r = await api.post('/api/quickline/sync', { kind: TABS[k].kind });
          parts.push(`${TABS[k].short}: ${r.total}، أُضيف ${r.added} بسعر التكلفة + ${r.markup}%`);
          pending += r.pending;
          off += r.switchedOff;
        }
        V.msg.ql = { text: `من QuickLine — ${parts.join(' · ')}${off ? `، أُخفيت ${off} لم تعد موجودة` : ''}. أسعارك الحالية لم تتغيّر${pending ? `، و${pending} تغيّر سعرها بانتظار موافقتك` : ''}.` };
      } catch (err) {
        V.msg.ql = { text: err.message, error: true };
      }
      await refreshAll(ctx);
    },
    'set-markup': (btn, e, ctx) => openMarkup(btn.dataset.tab, ctx),
    pending: (btn, e, ctx) => openPending(btn.dataset.tab, ctx),
    async sync(btn, e, ctx) {
      const key = btn.dataset.tab;
      const t = tabOf(key);
      const sup = SUPPLIERS[t.supplier];
      btn.disabled = true;
      btn.innerHTML = `${icon('clock')}جاري القراءة من ${sup.name}…`;
      try {
        const r = await api.post(`/api/${sup.api}/sync`, { kind: t.kind });
        V.msg[viewOf(key)] = { text: `${r.total} من ${sup.name}: أُضيف ${r.added} جديدة بسعر التكلفة + ${r.markup}%${r.switchedOff ? `، أُخفيت ${r.switchedOff} لم تعد موجودة` : ''}. أسعارك الحالية لم تتغيّر${r.pending ? `، و${r.pending} تغيّر سعرها بانتظار موافقتك` : ''}.${r.hidden ? ` ${r.hidden} حزمة لم تظهر لأن رصيد ${sup.name} أقل من سعرها.` : ''}` };
      } catch (err) {
        V.msg[viewOf(key)] = { text: err.message, error: true };
      }
      await refreshAll(ctx);
    },
    async 'toggle-package'(btn, e, ctx) {
      const p = S.catalog.packages.find((x) => x.id === Number(btn.dataset.id));
      btn.disabled = true;
      await api.put(`/api/packages/${p.id}`, { active: !p.active });
      await loadCatalog(true);
      ctx.rerender();
    },
    'edit-package': (btn) => openPackageForm(S.catalog.packages.find((p) => p.id === Number(btn.dataset.id))),
    'delete-package'(btn) {
      const p = S.catalog.packages.find((x) => x.id === Number(btn.dataset.id));
      sheet({
        title: `حذف ${p.name}`, body: `<p>تُحذف الرزمة. الأرقام المفعّلة عليها تبقى باسمها. لإخفائها مؤقتاً استعمل «تعديل» وأوقفها.</p>`, submit: 'حذف الرزمة', danger: true,
        async onSubmit() { await api.del(`/api/packages/${p.id}`); await loadCatalog(true); changed(); return 'تم حذف الرزمة'; },
      });
    },
  },
};
