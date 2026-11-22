import { api, esc, icon, money, empty, toast } from '../core.js';
import { SUPPLIER, hasValidPrice, supplierLabel, compareCatalog } from '../catalog-compare.js';

// Every eSIM package the suppliers have, by company, on or off in the shop. The shop price is automatic: the
// supplier's price + the manager's profit percentage (set at the top, kept by the server). The manager's only
// choice per package is whether it shows in the shop.
const V = { packages: [], markup: 20, q: '', tab: 'all', company: 'all', mode: 'all' };
const hasPrice = (v) => v !== null && v !== undefined;

function row(p) {
  const off = !p.available;
  const price = p.inShop && hasPrice(p.shopPrice)
    ? `<span>سعر المتجر <b>${money(p.shopPrice)}</b> <small class="muted">(تلقائي +${esc(V.markup)}%)</small></span>`
    : '<span class="muted">غير معروض</span>';
  const supPrice = hasValidPrice(p.supplierPrice) ? money(p.supplierPrice) : '—';
  return `<article class="item" data-pkg="${p.id}"${off ? ' style="opacity:.6"' : ''}>
    <div class="item-top">
      <div class="grow"><b class="item-title">${esc(p.name)}</b>${off ? ' <span class="pill s-expiring">غير متوفر عند المورّد</span>' : ''}
        <div class="item-sub">${p.supplier ? `<span>${esc(SUPPLIER[p.supplier] || p.supplier)}</span>` : ''}
          <span>سعر المورّد ${supPrice}</span>${price}</div></div>
      <label class="switch-row" style="padding:0;border:0;background:none">
        <span class="small">عرض في المتجر</span>
        <input class="switch" type="checkbox" data-in-shop="${p.id}" ${p.inShop ? 'checked' : ''} ${off ? 'disabled' : ''} aria-label="عرض ${esc(p.name)} في المتجر">
      </label>
    </div></article>`;
}

function allListHtml() {
  const term = V.q.trim().toLowerCase();
  const shown = V.packages.filter((p) => !term || `${p.name} ${p.companyName} ${supplierLabel(p.supplier)}`.toLowerCase().includes(term));
  if (!shown.length) return empty('box', term ? 'لا نتائج' : 'لا توجد رزم', term ? '' : 'تظهر هنا رزم eSIM من المورّدين.');
  const groups = new Map();
  for (const p of shown) {
    const k = p.companyName || 'بدون شركة';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  return [...groups].map(([name, list]) => `<section class="list">
      <div class="section-title"><h2 class="dot-title">${esc(name)}</h2><span class="muted small">${list.filter((p) => p.inShop).length} في المتجر من ${list.length}</span></div>
      ${list.map(row).join('')}</section>`).join('');
}

function offerRowHtml(o, tier) {
  const off = !o.available;
  const isWinner = o.isCheapest && tier.isComparable && !off;
  let badge = '';
  if (off) badge = '<span class="pill s-expiring">غير متوفر</span>';
  else if (isWinner) badge = '<span class="pill s-active">الأرخص</span>';
  else if (o.isCheapest) badge = '<span class="pill plain">خيار وحيد</span>';
  else if (o.diff > 0) badge = `<span class="pill s-expiring plain">+${money(o.diff)}</span>`;

  const supPrice = hasValidPrice(o.supplierPrice) ? money(o.supplierPrice) : '—';
  const shopPrice = o.inShop && hasPrice(o.shopPrice)
    ? `<span>المتجر <b>${money(o.shopPrice)}</b></span>`
    : '<span class="muted">غير معروض</span>';

  return `<div class="cmp-row${isWinner ? ' is-best' : ''}${off ? ' is-off' : ''}" data-pkg="${o.id}">
    <div class="grow">
      <div class="cmp-row-top">
        <b class="cmp-sup">${esc(o.supplierLabel)}</b>
        ${badge}
        ${o.inShop ? '<span class="pill s-pending plain">في المتجر</span>' : ''}
      </div>
      <div class="cmp-name">${esc(o.name)}</div>
      <div class="item-sub">
        <span>سعر المورّد <b class="cmp-price">${supPrice}</b></span>
        ${shopPrice}
      </div>
    </div>
    <label class="switch-row cmp-switch">
      <span class="small">عرض في المتجر</span>
      <input class="switch" type="checkbox" data-in-shop="${o.id}" ${o.inShop ? 'checked' : ''} ${off ? 'disabled' : ''} aria-label="عرض ${esc(o.name)} في المتجر">
    </label>
  </div>`;
}

function tierCardHtml(t) {
  const metaParts = [t.durationLabel, t.supplierCount > 1 ? `${t.supplierCount} مورّدين` : 'مورّد واحد'];
  if (t.offers.length > t.supplierCount) metaParts.push(`${t.offers.length} عروض`);
  const bestPill = t.cheapestSuppliers.length && t.minPrice !== null
    ? `<span class="pill s-active">${t.isComparable ? 'الأرخص' : 'السعر'}: ${esc(t.cheapestSuppliers.join('، '))} · ${money(t.minPrice)}</span>`
    : '';
  const savePill = t.savings > 0 ? `<span class="pill s-pending plain">وفّر حتى ${money(t.savings)}</span>` : '';
  const warnPill = t.hasOverpricedInShop ? `<span class="pill s-expiring">المعروض أغلى بـ ${money(t.overpricedDiff)}</span>` : '';

  return `<article class="card cmp-card${t.hasOverpricedInShop ? ' has-warn' : ''}">
    <div class="cmp-head">
      <div class="grow">
        <h3 class="cmp-title">${esc(t.label)}</h3>
        <span class="muted small">${esc(metaParts.join(' · '))}</span>
      </div>
      <div class="cmp-badges">${bestPill}${savePill}${warnPill}</div>
    </div>
    <div class="cmp-rows">${t.offers.map((o) => offerRowHtml(o, t)).join('')}</div>
  </article>`;
}

function cheapestWindowHtml() {
  if (!V.packages.length) return empty('box', 'لا توجد رزم', 'تظهر هنا مقارنة أسعار رزم eSIM من المورّدين.');

  const term = V.q.trim().toLowerCase();
  const base = compareCatalog(V.packages);

  // Filter at tier level so searching a supplier name still keeps competing suppliers visible for comparison.
  const searchedCompanies = base.companies.map((co) => {
    const tiers = !term ? co.tiers : co.tiers.filter((t) => {
      if (`${co.companyName} ${t.label} ${t.durationLabel}`.toLowerCase().includes(term)) return true;
      return t.offers.some((o) => `${o.name} ${o.supplierLabel}`.toLowerCase().includes(term));
    });
    return { ...co, tiers };
  }).filter((co) => co.tiers.length);

  if (!searchedCompanies.length) return empty('search', 'لا نتائج مطابقة', 'جرّب البحث باسم شركة أو حجم جيجا أو اسم مورّد.');

  if (V.company !== 'all' && !searchedCompanies.some((c) => c.companyName === V.company)) V.company = 'all';

  const companyScoped = V.company === 'all' ? searchedCompanies : searchedCompanies.filter((c) => c.companyName === V.company);
  const scopedTiers = companyScoped.flatMap((c) => c.tiers);
  const totalCount = scopedTiers.length;
  const multiCount = scopedTiers.filter((t) => t.isComparable).length;
  const overpricedCount = scopedTiers.filter((t) => t.hasOverpricedInShop).length;

  if (V.mode === 'overpriced' && overpricedCount === 0) V.mode = 'all';

  const visibleCompanies = companyScoped.map((co) => {
    const tiers = co.tiers.filter((t) => {
      if (V.mode === 'multi') return t.isComparable;
      if (V.mode === 'overpriced') return t.hasOverpricedInShop;
      return true;
    });
    return { ...co, tiers };
  }).filter((co) => co.tiers.length);

  const scopePkgs = companyScoped.flatMap((c) => c.tiers.flatMap((t) => t.offers));
  const stats = compareCatalog(scopePkgs).summary;

  const kpis = `<div class="kpis">
    <div class="kpi"><span>باقات للمقارنة</span><b>${stats.comparableTiers} <small class="muted small">من ${stats.totalTiers}</small></b></div>
    <div class="kpi"><span>الأرخص غالباً</span><b>${esc(stats.topSupplier?.label || '—')}</b>${stats.topSupplier ? `<small class="muted small">الأرخص في ${stats.topSupplier.wins} باقات</small>` : ''}</div>
    <div class="kpi"><span>أعلى فرق سعر</span><b>${stats.maxSavings > 0 ? money(stats.maxSavings) : '—'}</b></div>
    <button type="button" class="kpi cmp-kpi-btn${overpricedCount > 0 ? ' is-warn' : ''}" data-kpi-overpriced ${overpricedCount === 0 ? 'disabled' : ''}>
      <span>معروض بأغلى من الأرخص</span>
      <b>${overpricedCount}</b>
    </button>
  </div>`;

  const modeChips = `<div class="chips">
    <button type="button" class="chip" data-mode="all" aria-pressed="${V.mode === 'all'}">كل الباقات <span class="n">${totalCount}</span></button>
    <button type="button" class="chip" data-mode="multi" aria-pressed="${V.mode === 'multi'}">للمقارنة فقط (2+) <span class="n">${multiCount}</span></button>
    ${overpricedCount > 0 ? `<button type="button" class="chip" data-mode="overpriced" aria-pressed="${V.mode === 'overpriced'}">تحتاج تبديل للأرخص <span class="n">${overpricedCount}</span></button>` : ''}
  </div>`;

  const coChips = searchedCompanies.length > 1
    ? `<div class="chips">
        <button type="button" class="chip" data-company="all" aria-pressed="${V.company === 'all'}">كل الشركات <span class="n">${searchedCompanies.reduce((s, c) => s + c.tiers.length, 0)}</span></button>
        ${searchedCompanies.map((c) => `<button type="button" class="chip" data-company="${esc(c.companyName)}" aria-pressed="${V.company === c.companyName}">${esc(c.companyName)} <span class="n">${c.tiers.length}</span></button>`).join('')}
      </div>`
    : '';

  const body = visibleCompanies.length
    ? visibleCompanies.map((co) => {
      const compCount = co.tiers.filter((t) => t.isComparable).length;
      const meta = [`${co.tiers.length} باقات`, compCount ? `${compCount} للمقارنة` : ''].filter(Boolean).join(' · ');
      const topNote = co.topSupplier ? ` · الأوفر غالباً: ${co.topSupplier.label}` : '';
      return `<section class="list">
        <div class="section-title"><h2 class="dot-title">${esc(co.companyName)}</h2><span class="muted small">${esc(meta + topNote)}</span></div>
        ${co.tiers.map(tierCardHtml).join('')}
      </section>`;
    }).join('')
    : empty('chart', 'لا توجد باقات متعددة العروض هنا', 'كل الباقات الظاهرة حالياً متوفرة من مورّد واحد فقط — اختر «كل الباقات» لعرضها.');

  return `<div class="list">${kpis}${modeChips}${coChips}${body}</div>`;
}

function tabsHtml() {
  const cmp = compareCatalog(V.packages).summary;
  const warnDot = cmp.overpricedTiers > 0 ? ` · ${cmp.overpricedTiers} تنبيه` : '';
  return `<button type="button" data-tab="all" aria-pressed="${V.tab === 'all'}">كل الرزم<small>${V.packages.length} رزمة</small></button>
    <button type="button" data-tab="cheapest" aria-pressed="${V.tab === 'cheapest'}">مقارنة الأرخص حسب الشركة<small>${cmp.comparableTiers} مقارنة${esc(warnDot)}</small></button>`;
}

function panelHtml() {
  return V.tab === 'cheapest' ? cheapestWindowHtml() : allListHtml();
}

async function loadCatalog() {
  const c = await api.get('/api/catalog');
  V.packages = c.packages || [];
  if (hasPrice(c.markup)) V.markup = Number(c.markup);
}

export default {
  title: () => ({ title: 'الرزم', subtitle: 'اختر ما يظهر في المتجر وقارن أرخص مورّد لكل باقة حسب الشركة' }),
  load: loadCatalog,
  render() {
    return `<form class="card card-pad form" id="markup-form" novalidate>
        <div class="field"><label for="shop-markup">نسبة الربح فوق سعر المورّد %</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input class="input ltr" id="shop-markup" name="shopMarkup" type="number" min="0" max="500" step="0.5" inputmode="decimal" value="${esc(V.markup)}" style="max-width:140px">
            <button class="btn btn-primary" type="submit">${icon('check')}حفظ</button></div>
          <span class="hint">سعر المتجر لكل رزمة = سعر المورّد + هذه النسبة (مقرّباً لأقرب شيكل). يتحدّث كل سعر في المتجر عند الحفظ.</span></div>
      </form>
      <div class="segmented" id="cat-tabs" role="group" aria-label="عرض الرزم">${tabsHtml()}</div>
      <div class="search-box">${icon('search', 'i lead')}<input class="input" id="pkg-q" type="search" placeholder="ابحث باسم الرزمة أو الشركة أو المورّد…" value="${esc(V.q)}" aria-label="بحث في الرزم"></div>
      <div id="pkg-panel">${panelHtml()}</div>`;
  },
  mount(root) {
    const tabs = root.querySelector('#cat-tabs');
    const panel = root.querySelector('#pkg-panel');
    const form = root.querySelector('#markup-form');
    const redraw = () => { tabs.innerHTML = tabsHtml(); panel.innerHTML = panelHtml(); };

    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn || btn.dataset.tab === V.tab) return;
      V.tab = btn.dataset.tab;
      redraw();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.elements.shopMarkup;
      const value = Number(input.value);
      if (input.value.trim() === '' || !Number.isFinite(value) || value < 0 || value > 500) {
        toast('اكتب نسبة بين 0 و500', { error: true });
        return;
      }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api.put('/api/settings', { shopMarkup: value });
        // Every shop price follows the new percentage: the catalog as the server now prices it.
        await loadCatalog();
        input.value = V.markup;
        redraw();
        toast(`حُفظت النسبة: ${V.markup}%`);
      } catch (err) {
        toast(err.message, { error: true });
      } finally { btn.disabled = false; }
    });

    // Only the panel is redrawn, so typing keeps the search box's focus.
    root.querySelector('#pkg-q').addEventListener('input', (e) => { V.q = e.target.value; panel.innerHTML = panelHtml(); });

    panel.addEventListener('click', (e) => {
      const modeBtn = e.target.closest('[data-mode]');
      if (modeBtn) { V.mode = modeBtn.dataset.mode; panel.innerHTML = panelHtml(); return; }
      const coBtn = e.target.closest('[data-company]');
      if (coBtn) { V.company = coBtn.dataset.company; panel.innerHTML = panelHtml(); return; }
      const kpiBtn = e.target.closest('[data-kpi-overpriced]');
      if (kpiBtn && !kpiBtn.disabled) {
        V.mode = V.mode === 'overpriced' ? 'all' : 'overpriced';
        panel.innerHTML = panelHtml();
      }
    });

    panel.addEventListener('change', async (e) => {
      const box = e.target.closest('[data-in-shop]');
      if (!box) return;
      const id = Number(box.dataset.inShop);
      box.disabled = true;
      try {
        const p = await api.put(`/api/packages/${id}`, { inShop: box.checked });
        const i = V.packages.findIndex((x) => x.id === id);
        if (i >= 0) V.packages[i] = { ...V.packages[i], ...p };
        toast(V.packages[i]?.inShop ? 'تظهر في المتجر' : 'أُخفيت من المتجر');
      } catch (err) {
        box.checked = !box.checked;
        toast(err.message, { error: true });
      }
      // The rows as the server says they are now (shop price, availability, the company's count).
      redraw();
    });
  },
};
