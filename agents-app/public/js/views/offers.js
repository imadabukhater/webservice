import {
  S, api, esc, icon, isAdmin, money, fmtMoney, fmtDate, fmtISO, companyLogo, companyById, specs, sheet, field, changed, loadCatalog, empty, daysText, fmtNum,
} from '../core.js';

const V = { offers: [] };

function offerTiming(o) {
  if (!o.endsAt) return o.startsAt ? `من ${fmtDate(o.startsAt)}` : 'بدون تاريخ انتهاء';
  const left = Math.ceil((o.endsAt - Date.now()) / 864e5);
  if (left < 0) return `انتهى في ${fmtDate(o.endsAt)}`;
  if (left <= 3) return left === 0 ? 'ينتهي اليوم' : `ينتهي خلال ${daysText(left)}`;
  return `حتى ${fmtDate(o.endsAt)}`;
}

export function offerCard(o) {
  const co = o.companyId ? companyById(o.companyId) || { name: o.companyName, color: o.companyColor, logo: o.companyLogo } : null;
  const admin = isAdmin();
  const status = !o.active ? '<span class="pill">متوقف</span>' : o.live ? '<span class="pill s-active">ظاهر للوكلاء</span>' : '<span class="pill s-expired">خارج التاريخ</span>';
  return `<article class="offer-card">
    <div class="item-top">${co ? companyLogo(co, 'sm') : `<span class="tile sm red">${icon('gift')}</span>`}
      <div class="grow"><b class="item-title">${esc(o.title)}</b><div class="item-sub">${o.packageLabel ? `<span>${esc(o.packageLabel)}</span>` : '<span>إعلان</span>'}<span>${esc(offerTiming(o))}</span></div></div>
      ${admin ? status : '<span class="pill campaign">حملة</span>'}</div>
    ${o.details ? `<p class="small" style="white-space:pre-line;color:var(--ink-2)">${esc(o.details)}</p>` : ''}
    ${o.dataGb || o.minutes !== null || o.sms !== null ? `<div class="pkg-specs" style="justify-content:flex-start;direction:rtl">${o.dataGb ? `<span>${icon('data')}${fmtNum(o.dataGb)} GB</span>` : ''}${specs(o)}</div>` : ''}
    ${o.offerPrice !== null ? `<div class="offer-price"><small class="muted" style="direction:rtl">للشهر</small>${o.regularPrice && o.regularPrice !== o.offerPrice ? `<s>${o.regularPrice.toFixed(2)}</s>` : ''}<b>${money(o.offerPrice)}</b></div>` : ''}
    <div class="item-actions">
      ${!admin && o.packageId ? `<button class="btn btn-campaign btn-block" data-action="use-offer" data-id="${o.id}">${icon('userPlus')}تفعيل بهذا العرض</button>` : ''}
      ${admin ? `<button class="btn btn-sm" data-action="edit-offer" data-id="${o.id}">${icon('edit')}تعديل</button>
        <button class="btn btn-sm btn-danger" data-action="delete-offer" data-id="${o.id}">${icon('trash')}حذف</button>` : ''}
    </div></article>`;
}

export function openOfferForm(o, onDone) {
  const pk = S.catalog?.packages || [];
  const byCompany = (S.catalog?.companies || []).map((c) => [c, pk.filter((p) => p.companyId === c.id)]).filter(([, l]) => l.length);
  sheet({
    title: o ? 'تعديل عرض' : 'عرض جديد',
    subtitle: 'يظهر للوكلاء في الرئيسية وفي خطوة اختيار الرزمة بعلامة «حملة»',
    body: `
      <div class="field"><label for="of-title">عنوان العرض</label><input class="input" id="of-title" name="title" value="${esc(o?.title || '')}" placeholder="مثال: سلكوم 300 جيجا — حملة الشهر" required></div>
      <div class="field"><label for="of-details">التفاصيل <span class="opt">(اختياري)</span></label><textarea class="input" id="of-details" name="details" rows="3">${esc(o?.details || '')}</textarea></div>
      <div class="field"><label for="of-pkg">الرزمة</label><select class="input" id="of-pkg" name="packageId">
        <option value="">بدون رزمة (إعلان فقط)</option>
        ${byCompany.map(([c, list]) => `<optgroup label="${esc(c.name)}">${list.map((p) => `<option value="${p.id}" ${p.id === o?.packageId ? 'selected' : ''}>${esc(c.name)} ${esc(p.name)}</option>`).join('')}</optgroup>`).join('')}
      </select><span class="hint">مع رزمة يستطيع الوكيل التفعيل مباشرة بسعر العرض.</span></div>
      <div class="field"><label for="of-price">سعر العرض للوكيل في الشهر (₪) <span class="opt">(فارغ = سعر الوكيل العادي)</span></label>
        <input class="input ltr" id="of-price" name="offerPrice" type="number" step="0.01" min="0" inputmode="decimal" value="${o?.offerPrice ?? ''}">
        <span class="hint" id="of-margin"></span></div>
      <div class="row2"><div class="field"><label for="of-from">يبدأ</label><input class="input" id="of-from" name="startsAt" type="date" value="${fmtISO(o?.startsAt)}"></div>
        <div class="field"><label for="of-to">ينتهي</label><input class="input" id="of-to" name="endsAt" type="date" value="${fmtISO(o?.endsAt)}"></div></div>
      <label class="switch-row"><span class="grow"><b>العرض ظاهر للوكلاء</b><small>أوقفه مؤقتاً دون حذفه</small></span><input class="switch" type="checkbox" name="active" ${!o || o.active ? 'checked' : ''}></label>`,
    submit: o ? 'حفظ العرض' : 'نشر العرض',
    // Warns when the campaign price would sell below the package cost.
    onInput(form) {
      const p = pk.find((x) => x.id === Number(field(form, 'packageId')));
      const box = form.querySelector('#of-margin');
      const price = field(form, 'offerPrice');
      if (!p || price === '') { box.className = 'hint'; box.innerHTML = p ? `${icon('info')}<span>التكلفة عليك ${fmtMoney(p.cost)} في الشهر</span>` : ''; return; }
      const m = Number(price) - p.cost;
      box.className = `hint ${m < 0 ? 'bad' : 'ok'}`;
      box.innerHTML = `${icon(m < 0 ? 'alert' : 'coins')}<span>${m < 0 ? `أقل من التكلفة بـ ${fmtMoney(-m)} — ستخسر في كل تفعيل` : `ربحك في الشهر ${fmtMoney(m)}`}</span>`;
    },
    async onSubmit(form) {
      const day = (s, end) => (s ? new Date(`${s}T${end ? '23:59:59' : '00:00:00'}`).getTime() : null);
      const body = {
        title: field(form, 'title'), details: field(form, 'details'),
        packageId: field(form, 'packageId') ? Number(field(form, 'packageId')) : null,
        offerPrice: field(form, 'offerPrice'), startsAt: day(field(form, 'startsAt')), endsAt: day(field(form, 'endsAt'), true),
        active: form.elements.active.checked,
      };
      if (!body.title) throw new Error('اكتب عنوان العرض');
      await (o ? api.put(`/api/offers/${o.id}`, body) : api.post('/api/offers', body));
      changed();
      onDone?.();
      return o ? 'تم حفظ العرض' : 'تم نشر العرض وإشعار الوكلاء';
    },
  });
}

export default {
  title: () => ({ title: 'العروض', subtitle: isAdmin() ? 'الحملات والأسعار الخاصة للوكلاء' : 'حملات سارية بأسعار خاصة' }),
  async load() {
    const [offers] = await Promise.all([api.get('/api/offers'), loadCatalog()]);
    V.offers = offers;
  },
  render() {
    return `
      <div class="page-head"><div><h2 class="dot-title">العروض</h2><p>${isAdmin() ? 'العرض المرتبط برزمة يظهر للوكيل في خطوة اختيار الرزمة بسعره الخاص.' : 'فعّل مشتركاً جديداً بسعر العرض مباشرة.'}</p></div>
        ${isAdmin() ? `<button class="btn btn-primary" data-action="add-offer">${icon('plus')}عرض جديد</button>` : ''}</div>
      ${V.offers.length ? `<div class="grid-cards">${V.offers.map(offerCard).join('')}</div>`
        : empty('gift', 'لا توجد عروض حالياً', isAdmin() ? 'أضف عرضاً بسعر خاص ومدة محددة، وسيصل إشعار لكل الوكلاء.' : 'ستظهر هنا الحملات الجديدة فور نشرها.',
          isAdmin() ? `<button class="btn btn-primary" data-action="add-offer">${icon('plus')}عرض جديد</button>` : '')}`;
  },
  actions: {
    'add-offer': () => openOfferForm(null),
    'edit-offer': (btn) => openOfferForm(V.offers.find((o) => o.id === Number(btn.dataset.id))),
    'delete-offer'(btn) {
      const o = V.offers.find((x) => x.id === Number(btn.dataset.id));
      sheet({
        title: 'حذف العرض', body: `<p>سيُحذف العرض «${esc(o.title)}» ولن يظهر للوكلاء.</p>`, submit: 'حذف العرض', danger: true,
        async onSubmit() { await api.del(`/api/offers/${o.id}`); changed(); return 'تم حذف العرض'; },
      });
    },
    'use-offer': (btn) => { location.hash = `#/new?offer=${btn.dataset.id}`; },
  },
};
