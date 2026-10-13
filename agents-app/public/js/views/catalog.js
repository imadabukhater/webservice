import {
  S, api, esc, icon, money, fmtMoney, sheet, field, changed, loadCatalog, companyLogo, specs, fileToDataUrl, empty, fmtNum, round,
} from '../core.js';

// Two separate systems, each with its own packages: invoices (activating a new line with a SIM) and
// recharge cards (cards, bundles and cash for an existing number).
const V = { tab: 'invoice', q: '' };
const KINDS = {
  invoice: { label: 'الفواتير', icon: 'sim', color: '', note: 'رزم تفعيل خط جديد بشريحة. تظهر للوكيل في «مشترك جديد».' },
  card: { label: 'كروت الشحن', icon: 'card', color: 'green', note: 'كروت وحزم ورصيد لرقم موجود. تظهر للوكيل في «شحن كرت» و«تمديد».' },
};

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
          <label class="switch-row"><span class="tile sm green">${icon('refresh')}</span><span class="grow"><b>تلقائي عبر art-topup</b><small>شحن الكروت والتمديد يُنفَّذ تلقائياً من حسابك في art-topup (للكروت المستوردة منه). التفعيل بشريحة يبقى طلباً لك.</small></span>
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
    subtitle: p?.artCode ? `رمز art-topup: <span class="mono ltr">${esc(p.artCode)}</span>` : '',
    body: `
      ${p?.artCode ? `<div class="msg info">${icon('info')}<span>رزمة من art-topup. بعد حفظ تعديلك تبقى قيمك كما هي عند كل مزامنة، وتتحدث «التكلفة» فقط.</span></div>` : ''}
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

function packageCardAdmin(p) {
  return `<article class="pkg-card ${p.active ? '' : 'inactive'}" style="cursor:default">
    <div class="pkg-head"><span class="pkg-name">${esc(p.name)}</span>${p.active ? '' : '<span class="pill">مخفية عن الوكلاء</span>'}${!p.price ? '<span class="pill s-expiring">حدد السعر</span>' : ''}</div>
    ${p.dataGb ? `<div class="pkg-data"><b>${fmtNum(p.dataGb)}</b><span>GB</span></div>` : ''}
    ${specs(p) ? `<div class="pkg-specs">${specs(p)}</div>` : ''}
    <div class="kv small"><div>المدة</div><div>${p.days ? `${p.days} يوماً` : 'شهرية'}</div>
      <div>التكلفة</div><div>${money(p.cost)}</div><div>سعر الوكيل</div><div>${money(p.price)}</div><div>ربحك</div><div class="${p.price - p.cost < 0 ? 'minus' : 'plus'}">${money(p.price - p.cost)}</div>
      ${p.artCode ? `<div>رمز art-topup</div><div class="mono ltr">${esc(p.artCode)}${p.edited ? ' · <span class="muted">معدّلة</span>' : ''}</div>` : ''}</div>
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
  async load() { await loadCatalog(true); },
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
    const count = (k) => packages.filter((p) => p.kind === k).length;
    const tabs = `<div class="segmented">${Object.entries(KINDS).map(([k, d]) => `<button data-action="tab" data-tab="${k}" aria-pressed="${V.tab === k}">${icon(d.icon)}${d.label} (${count(k)})</button>`).join('')}
      <button data-action="tab" data-tab="companies" aria-pressed="${V.tab === 'companies'}">${icon('building')}الشركات (${companies.length})</button></div>`;
    if (V.tab === 'companies') {
      return `${tabs}<div class="page-head"><p>الشعار واللون وبادئات الشرائح وطريقة التفعيل لكل شركة.</p><button class="btn btn-primary" data-action="add-company">${icon('plus')}شركة جديدة</button></div>
        ${companies.length ? `<div class="grid-cards">${companies.map((c) => `<article class="item"><div class="item-top">${companyLogo(c, 'sm')}
          <div class="grow"><b class="item-title">${esc(c.name)}</b><div class="item-sub"><span>${c.packageCount} رزمة</span><span class="mono ltr">${esc((c.prefixes || []).join(', ') || 'بدون بادئة')}</span></div></div>
            <span class="pill ${c.activation === 'direct' ? 's-expiring' : c.activation === 'auto' ? 's-active' : 'plain'}">${{ direct: 'تفعيل مباشر', auto: 'تلقائي art-topup' }[c.activation] || 'طلب للمدير'}</span></div>
          <div class="item-actions"><button class="btn btn-sm" data-action="edit-company" data-id="${c.id}">${icon('edit')}تعديل</button>
            <button class="btn btn-sm btn-ghost" data-action="delete-company" data-id="${c.id}">${icon('trash')}حذف</button></div></article>`).join('')}</div>`
          : empty('building', 'لا توجد شركات', 'أضف أول شركة اتصالات.')}`;
    }
    const kind = KINDS[V.tab] ? V.tab : 'invoice';
    const term = V.q.trim().toLowerCase();
    const mine = packages.filter((p) => p.kind === kind && (!term || `${p.name} ${p.companyName} ${p.artCode}`.toLowerCase().includes(term)));
    const shown = mine.filter((p) => p.active).length;
    return `${tabs}<div class="page-head"><p><b>${KINDS[kind].label}:</b> ${KINDS[kind].note} ظاهرة للوكلاء ${shown} من ${mine.length}.</p>
        <button class="btn btn-primary" data-action="add-package">${icon('plus')}رزمة جديدة</button></div>
      <div class="search-box">${icon('search', 'i lead')}<input class="input" id="pkg-q" type="search" placeholder="ابحث باسم الرزمة أو الشركة أو رمز art-topup…" value="${esc(V.q)}" aria-label="بحث في الرزم"></div>
      ${companies.map((c) => {
        const list = mine.filter((p) => p.companyId === c.id);
        if (!list.length && (term || !packages.some((p) => p.companyId === c.id && p.kind === kind))) return '';
        return `<section class="list"><div class="section-title"><h2 style="display:flex;align-items:center;gap:10px">${companyLogo(c, 'xs')}${esc(c.name)}</h2>
          <button class="btn btn-sm btn-soft" data-action="add-package" data-company="${c.id}">${icon('plus')}رزمة</button></div>
          <div class="pkg-grid">${list.map(packageCardAdmin).join('')}</div></section>`;
      }).join('') || empty(KINDS[kind].icon, term ? 'لا نتائج' : `لا توجد رزم في ${KINDS[kind].label}`, term ? '' : 'أضفها يدوياً، أو من الإعدادات ← «مزامنة الكروت والأسعار» من art-topup.')}`;
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
    'add-package': (btn) => openPackageForm(null, Number(btn.dataset.company) || undefined, KINDS[V.tab] ? V.tab : 'invoice'),
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
