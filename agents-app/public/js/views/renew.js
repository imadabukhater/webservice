import {
  S, api, esc, icon, isAdmin, money, fmtMoney, fmtDate, phone, statePill, sheet, field, changed, loadCatalog, companyLogo, companyById,
  monthsText, daysText, digits, empty, round, fmtNum, closeAllSheets, fmtPhone,
} from '../core.js';

const MONTHS = [1, 2, 3, 6, 12];

const addMonths = (ts, m) => {
  const d = new Date(ts);
  const day = d.getDate();
  d.setMonth(d.getMonth() + m);
  if (d.getDate() < day) d.setDate(0);
  return d.getTime();
};

// Renew (extend) a line: same company, any of its packages or running offers, 1–12 months.
export async function openRenew(line) {
  const admin = isAdmin();
  const [cat, offers, extra] = await Promise.all([
    loadCatalog(),
    api.get('/api/offers'),
    admin ? Promise.all([api.get(`/api/agents/${line.agentId}/prices`), api.get('/api/agents')]) : api.get('/api/me'),
  ]);
  let available;
  let priceOf;
  if (admin) {
    const [prices, agents] = extra;
    const map = new Map(prices.map((r) => [r.packageId, r.customPrice ?? r.defaultPrice]));
    priceOf = (p) => map.get(p.id) ?? p.price;
    available = agents.find((a) => a.id === line.agentId)?.available ?? 0;
  } else {
    priceOf = (p) => p.price;
    available = extra.user.available;
  }
  const pkgs = cat.packages.filter((p) => p.companyId === line.companyId && p.active && priceOf(p) > 0);
  const options = [
    ...offers.filter((o) => o.live && o.packageId && pkgs.some((p) => p.id === o.packageId)).map((o) => {
      const p = pkgs.find((x) => x.id === o.packageId);
      return { key: `o${o.id}`, offerId: o.id, packageId: p.id, title: o.title, sub: `${p.companyName} ${p.name}`, unit: o.offerPrice ?? priceOf(p), regular: priceOf(p), campaign: true };
    }),
    ...pkgs.map((p) => ({ key: `p${p.id}`, packageId: p.id, title: `${p.companyName} ${p.name}`, sub: p.dataGb ? `${fmtNum(p.dataGb)} GB` : '', unit: priceOf(p) })),
  ];
  if (!options.length) {
    sheet({ title: `تمديد ${line.number}`, body: empty('box', 'لا توجد رزم متاحة لهذه الشركة', 'اطلب من المدير تحديد سعر رزم الشركة.') });
    return;
  }
  const st = { key: (options.find((o) => o.packageId === line.packageId && !o.offerId) || options[0]).key, months: 1 };
  const base = Math.max(Date.now(), line.expiresAt || Date.now());

  sheet({
    title: `تمديد الرزمة`,
    subtitle: `<span class="ltr">${fmtPhone(line.number)}</span> · ${esc(line.customerName || 'بدون اسم')}`,
    body: `
      <div class="summary-pkg">${companyLogo(companyById(line.companyId), 'sm')}<div class="grow"><b>${esc(line.packageLabel)}</b>
        <small>${line.expiresAt ? (line.daysLeft >= 0 ? `تنتهي ${fmtDate(line.expiresAt)} · متبقٍ ${daysText(line.daysLeft)}` : `انتهت ${fmtDate(line.expiresAt)}`) : 'بدون تاريخ انتهاء'}</small></div>${statePill(line.state)}</div>
      <div class="field"><span class="label">الرزمة</span><div class="list" style="gap:8px">${options.map((o) => `
        <label class="switch-row" style="${o.campaign ? 'border-color:color-mix(in srgb,#e8336d 40%,var(--line))' : ''}">
          <input type="radio" name="opt" value="${o.key}" ${o.key === st.key ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--primary)">
          <span class="grow"><b>${esc(o.title)}</b><small>${esc(o.sub)}</small></span>
          ${o.campaign ? '<span class="pill campaign">حملة</span>' : ''}<b class="ltr nowrap">${fmtMoney(o.unit)}</b></label>`).join('')}</div></div>
      <div class="field"><span class="label">المدة</span><div class="months">${MONTHS.map((m) => `<button type="button" data-m="${m}" aria-pressed="${m === st.months}">${m}<small>${m === 1 ? 'شهر' : m === 2 ? 'شهران' : m <= 10 ? 'أشهر' : 'شهراً'}</small></button>`).join('')}</div></div>
      <div class="field"><label for="rn-cp">سعر الزبون <span class="opt">(اختياري — لحساب ربحك)</span></label>
        <input class="input ltr" id="rn-cp" name="customerPrice" type="number" min="0" step="0.01" inputmode="decimal"></div>
      ${admin ? `<div class="field"><label for="rn-unit">سعر خاص للشهر <span class="opt">(اختياري)</span></label><input class="input ltr" id="rn-unit" name="unitPrice" type="number" min="0" step="0.01" inputmode="decimal"></div>` : ''}
      <div id="rn-preview"></div>`,
    submit: 'تأكيد التمديد',
    onMount(form) {
      form.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => {
        st.months = Number(b.dataset.m);
        form.querySelectorAll('[data-m]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        form.dispatchEvent(new Event('input'));
      }));
    },
    onInput(form) {
      st.key = form.querySelector('input[name=opt]:checked')?.value || st.key;
      const o = options.find((x) => x.key === st.key);
      const unit = admin && field(form, 'unitPrice') !== '' ? Number(field(form, 'unitPrice')) : o.unit;
      const total = round(unit * st.months);
      const after = round(available - total);
      const cp = field(form, 'customerPrice');
      const box = form.querySelector('#rn-preview');
      box.innerHTML = `
        <div class="total-row"><span>الإجمالي · ${monthsText(st.months)}</span><b>${fmtMoney(total)}</b></div>
        <div class="balance-preview" style="margin-top:10px">
          <div><span>تنتهي في</span><b>${fmtDate(addMonths(base, st.months))}</b></div>
          <div><span>المتاح قبل</span><b>${fmtMoney(available)}</b></div>
          <div><span>المتاح بعد</span><b class="${after < 0 ? 'minus' : ''}">${fmtMoney(after)}</b></div></div>
        ${cp !== '' ? `<p class="hint ${Number(cp) - total >= 0 ? 'ok' : 'bad'}" style="margin-top:8px">${icon('coins')}<span>ربحك من هذا التمديد: ${fmtMoney(Number(cp) - total)}</span></p>` : ''}
        ${after < 0 ? `<div class="msg" style="margin-top:10px">${icon('alert')}<span>الرصيد المتاح لا يكفي. ينقص ${fmtMoney(-after)}.</span></div>` : ''}`;
    },
    async onSubmit(form) {
      const o = options.find((x) => x.key === st.key);
      const body = { months: st.months, customerPrice: field(form, 'customerPrice') };
      if (o.offerId) body.offerId = o.offerId; else body.packageId = o.packageId;
      if (admin && field(form, 'unitPrice') !== '') body.unitPrice = field(form, 'unitPrice');
      const r = await api.post(`/api/lines/${line.id}/renew`, body);
      await closeAllSheets();
      changed();
      return `تم التمديد حتى ${fmtDate(r.line.expiresAt)}`;
    },
  });
}

const V = { lines: [], q: '' };

function renewCard(l) {
  return `<article class="item clickable" data-action="renew-line" data-id="${l.id}">
    <div class="item-top"><span class="co-dot" style="--co:${esc(l.companyColor)}"></span>
      <div class="grow">${phone(l.number)}<div class="item-sub"><span>${esc(l.customerName || 'بدون اسم')}</span><span>${esc(l.packageLabel)}</span>${isAdmin() ? `<span>${esc(l.agentName)}</span>` : ''}</div></div>
      ${statePill(l.state)}</div>
    <div class="item-top" style="justify-content:space-between"><span class="small muted">${l.expiresAt ? (l.daysLeft >= 0 ? `تنتهي ${fmtDate(l.expiresAt)}` : `انتهت ${fmtDate(l.expiresAt)}`) : 'بدون تاريخ انتهاء'}</span>
      <span class="btn btn-soft btn-sm">${icon('repeat')}تمديد</span></div></article>`;
}

function filtered() {
  const q = V.q.trim();
  const d = digits(q);
  return V.lines.filter((l) => !q || (d.length >= 2 && (l.number.includes(d) || l.sim.includes(d))) || (l.customerName || '').includes(q));
}

export default {
  title: () => ({ title: 'زبون قائم', subtitle: 'تمديد رزمة لرقم مفعّل' }),
  async load() {
    const [lines] = await Promise.all([api.get('/api/lines'), loadCatalog()]);
    const rank = { expired: 0, expiring: 1, frozen: 2, active: 3 };
    V.lines = lines.filter((l) => ['active', 'frozen'].includes(l.status))
      .sort((a, b) => (rank[a.state] - rank[b.state]) || ((a.expiresAt || Infinity) - (b.expiresAt || Infinity)));
  },
  render() {
    const list = filtered();
    return `
      <div class="search-box">${icon('search', 'i lead')}<input class="input" id="renew-q" type="search" placeholder="ابحث برقم الهاتف، اسم الزبون أو الشريحة" value="${esc(V.q)}" autocomplete="off"></div>
      <p class="small muted">الأرقام التي تنتهي قريباً تظهر أولاً. الرقم غير موجود في قائمتك؟ <a href="#/new?type=external">فعّله كزبون مسبق الدفع خارجي</a>.</p>
      <div class="list" id="renew-list">${list.length ? list.slice(0, 80).map(renewCard).join('') : empty('phone', V.lines.length ? 'لا توجد نتائج' : 'لا توجد أرقام مفعّلة بعد', V.lines.length ? 'جرّب جزءاً آخر من الرقم أو الاسم.' : 'فعّل أول مشترك من «مشترك جديد».')}</div>`;
  },
  mount(root) {
    root.querySelector('#renew-q').addEventListener('input', (e) => {
      V.q = e.target.value;
      const list = filtered();
      root.querySelector('#renew-list').innerHTML = list.length ? list.slice(0, 80).map(renewCard).join('') : empty('search', 'لا توجد نتائج', 'جرّب جزءاً آخر من الرقم أو الاسم.');
    });
  },
  actions: {
    'renew-line': (btn) => openRenew(V.lines.find((l) => l.id === Number(btn.dataset.id))),
  },
};

export { addMonths };
