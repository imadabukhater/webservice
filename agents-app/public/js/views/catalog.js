import {
  S, api, esc, icon, money, fmtMoney, sheet, field, changed, loadCatalog, companyLogo, specs, fileToDataUrl, empty, fmtNum, round,
} from '../core.js';

const V = { tab: 'packages' };

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
        <span class="hint">أول 7 أرقام من شرائح هذه الشركة. تتعلّمها المنصّة تلقائياً من أول تفعيل، ويمكنك تعديلها هنا.</span></div>`,
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
      const body = { name: field(form, 'name'), color: field(form, 'color'), logo, prefixes: field(form, 'prefixes') };
      await (c ? api.put(`/api/companies/${c.id}`, body) : api.post('/api/companies', body));
      await loadCatalog(true);
      changed();
      return c ? 'تم حفظ الشركة' : 'تمت إضافة الشركة';
    },
  });
}

export function openPackageForm(p, companyId) {
  const cos = S.catalog.companies;
  if (!cos.length) { openCompanyForm(null); return; }
  const amountVal = (v) => (v === -1 ? 'غير محدود' : v ?? '');
  sheet({
    title: p ? 'تعديل رزمة' : 'رزمة جديدة',
    body: `
      <div class="field"><label for="pk-co">الشركة</label><select class="input" id="pk-co" name="companyId">${cos.map((c) => `<option value="${c.id}" ${c.id === (p?.companyId ?? companyId) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="pk-name">اسم الرزمة</label><input class="input" id="pk-name" name="name" value="${esc(p?.name || '')}" placeholder="مثال: 300 جيجا رزمة شهرية" required></div>
      <div class="row2"><div class="field"><label for="pk-gb">الإنترنت (GB)</label><input class="input ltr" id="pk-gb" name="dataGb" type="number" min="0" step="1" inputmode="numeric" value="${p?.dataGb ?? ''}"></div>
        <div class="field"><label for="pk-tag">وسم <span class="opt">(مثل RENTERS)</span></label><input class="input ltr" id="pk-tag" name="tag" value="${esc(p?.tag || '')}"></div></div>
      <div class="row2"><div class="field"><label for="pk-min">الدقائق</label><input class="input ltr" id="pk-min" name="minutes" list="unlimited" value="${esc(amountVal(p?.minutes))}" placeholder="5000"></div>
        <div class="field"><label for="pk-sms">الرسائل</label><input class="input ltr" id="pk-sms" name="sms" list="unlimited" value="${esc(amountVal(p?.sms))}" placeholder="5000"></div></div>
      <datalist id="unlimited"><option value="غير محدود"></option></datalist>
      <div class="field"><label for="pk-desc">وصف قصير <span class="opt">(اختياري)</span></label><input class="input" id="pk-desc" name="description" value="${esc(p?.description || '')}"></div>
      <div class="row2"><div class="field"><label for="pk-cost">التكلفة عليك (₪/شهر)</label><input class="input ltr" id="pk-cost" name="cost" type="number" min="0" step="0.01" inputmode="decimal" value="${p ? round(p.cost) : ''}"></div>
        <div class="field"><label for="pk-price">سعر الوكيل الافتراضي (₪/شهر)</label><input class="input ltr" id="pk-price" name="price" type="number" min="0" step="0.01" inputmode="decimal" value="${p ? round(p.price) : ''}"></div></div>
      <div class="hint" id="pk-margin"></div>
      <label class="switch-row"><span class="grow"><b>متاحة للتفعيل</b><small>أوقفها لإخفائها عن الوكلاء مؤقتاً</small></span><input class="switch" type="checkbox" name="active" ${!p || p.active ? 'checked' : ''}></label>`,
    submit: p ? 'حفظ' : 'إضافة الرزمة',
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
    <div class="pkg-head"><span class="pkg-name">${esc(p.name)}</span>${p.active ? '' : '<span class="pill">موقوفة</span>'}${!p.price ? '<span class="pill s-expiring">حدد السعر</span>' : ''}</div>
    ${p.dataGb ? `<div class="pkg-data"><b>${fmtNum(p.dataGb)}</b><span>GB</span></div>` : ''}
    ${specs(p) ? `<div class="pkg-specs">${specs(p)}</div>` : ''}
    <div class="kv small"><div>التكلفة</div><div>${money(p.cost)}</div><div>سعر الوكيل</div><div>${money(p.price)}</div><div>ربحك</div><div class="${p.price - p.cost < 0 ? 'minus' : 'plus'}">${money(p.price - p.cost)}</div></div>
    <div class="item-actions" style="padding-bottom:16px"><button class="btn btn-sm" data-action="edit-package" data-id="${p.id}">${icon('edit')}تعديل</button>
      <button class="btn btn-sm btn-ghost" data-action="delete-package" data-id="${p.id}">${icon('trash')}حذف</button></div>
    ${p.tag ? `<div class="pkg-tag"><span>${esc(p.tag)}</span><span></span></div>` : ''}
  </article>`;
}

export default {
  admin: true,
  title: () => ({ title: 'الشركات والرزم', subtitle: 'الأسعار الافتراضية ومواصفات الرزم' }),
  async load() { await loadCatalog(true); },
  render() {
    const { companies, packages } = S.catalog;
    const tabs = `<div class="segmented"><button data-action="tab" data-tab="packages" aria-pressed="${V.tab === 'packages'}">الرزم (${packages.length})</button>
      <button data-action="tab" data-tab="companies" aria-pressed="${V.tab === 'companies'}">الشركات (${companies.length})</button></div>`;
    if (V.tab === 'companies') {
      return `${tabs}<div class="page-head"><p>الشعار واللون وبادئات الشرائح لكل شركة.</p><button class="btn btn-primary" data-action="add-company">${icon('plus')}شركة جديدة</button></div>
        ${companies.length ? `<div class="grid-cards">${companies.map((c) => `<article class="item"><div class="item-top">${companyLogo(c, 'sm')}
          <div class="grow"><b class="item-title">${esc(c.name)}</b><div class="item-sub"><span>${c.packageCount} رزمة</span><span class="mono ltr">${esc((c.prefixes || []).join(', ') || 'بدون بادئة')}</span></div></div></div>
          <div class="item-actions"><button class="btn btn-sm" data-action="edit-company" data-id="${c.id}">${icon('edit')}تعديل</button>
            <button class="btn btn-sm btn-ghost" data-action="delete-company" data-id="${c.id}">${icon('trash')}حذف</button></div></article>`).join('')}</div>`
          : empty('building', 'لا توجد شركات', 'أضف أول شركة اتصالات.')}`;
    }
    return `${tabs}<div class="page-head"><p>السعر الافتراضي يراه كل الوكلاء ما لم تحدد لأحدهم سعراً خاصاً من صفحة «الوكلاء».</p>
        <button class="btn btn-primary" data-action="add-package">${icon('plus')}رزمة جديدة</button></div>
      ${companies.map((c) => {
        const list = packages.filter((p) => p.companyId === c.id);
        return `<section class="list"><div class="section-title"><h2 style="display:flex;align-items:center;gap:10px">${companyLogo(c, 'xs')}${esc(c.name)}</h2>
          <button class="btn btn-sm btn-soft" data-action="add-package" data-company="${c.id}">${icon('plus')}رزمة</button></div>
          ${list.length ? `<div class="pkg-grid">${list.map(packageCardAdmin).join('')}</div>` : '<p class="muted small">لا توجد رزم لهذه الشركة.</p>'}</section>`;
      }).join('') || empty('box', 'لا توجد رزم', 'أضف شركة ثم رزمها.')}`;
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
    'add-package': (btn) => openPackageForm(null, Number(btn.dataset.company) || undefined),
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
