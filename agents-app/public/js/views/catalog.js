import { api, esc, icon, money, empty, toast } from '../core.js';

// Every eSIM package the suppliers have, by company, on or off in the shop. The shop price is automatic: the
// supplier's price + the manager's profit percentage (set at the top, kept by the server). The manager's only
// choice per package is whether it shows in the shop.
const V = { packages: [], markup: 20, q: '' };
const SUPPLIER = { ql: 'QuickLine', ly: 'ليان', tc: 'telecom', ay: 'أيلول' };
const hasPrice = (v) => v !== null && v !== undefined;

function row(p) {
  const off = !p.available;
  const price = p.inShop && hasPrice(p.shopPrice)
    ? `<span>سعر المتجر <b>${money(p.shopPrice)}</b> <small class="muted">(تلقائي +${esc(V.markup)}%)</small></span>`
    : '<span class="muted">غير معروض</span>';
  return `<article class="item" data-pkg="${p.id}"${off ? ' style="opacity:.6"' : ''}>
    <div class="item-top">
      <div class="grow"><b class="item-title">${esc(p.name)}</b>${off ? ' <span class="pill s-expiring">غير متوفر عند المورّد</span>' : ''}
        <div class="item-sub">${p.supplier ? `<span>${esc(SUPPLIER[p.supplier] || p.supplier)}</span>` : ''}
          <span>سعر المورّد ${money(p.supplierPrice)}</span>${price}</div></div>
      <label class="switch-row" style="padding:0;border:0;background:none">
        <span class="small">عرض في المتجر</span>
        <input class="switch" type="checkbox" data-in-shop="${p.id}" ${p.inShop ? 'checked' : ''} ${off ? 'disabled' : ''} aria-label="عرض ${esc(p.name)} في المتجر">
      </label>
    </div></article>`;
}

function listHtml() {
  const term = V.q.trim().toLowerCase();
  const shown = V.packages.filter((p) => !term || `${p.name} ${p.companyName}`.toLowerCase().includes(term));
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

async function loadCatalog() {
  const c = await api.get('/api/catalog');
  V.packages = c.packages || [];
  if (hasPrice(c.markup)) V.markup = Number(c.markup);
}

export default {
  title: () => ({ title: 'الرزم', subtitle: 'اختر ما يظهر في المتجر — السعر تلقائي (سعر المورّد + نسبة ربحك)' }),
  load: loadCatalog,
  render() {
    return `<form class="card card-pad form" id="markup-form" novalidate>
        <div class="field"><label for="shop-markup">نسبة الربح فوق سعر المورّد %</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input class="input ltr" id="shop-markup" name="shopMarkup" type="number" min="0" max="500" step="0.5" inputmode="decimal" value="${esc(V.markup)}" style="max-width:140px">
            <button class="btn btn-primary" type="submit">${icon('check')}حفظ</button></div>
          <span class="hint">سعر المتجر لكل رزمة = سعر المورّد + هذه النسبة. يتحدّث كل سعر في المتجر عند الحفظ.</span></div>
      </form>
      <div class="search-box">${icon('search', 'i lead')}<input class="input" id="pkg-q" type="search" placeholder="ابحث باسم الرزمة أو الشركة…" value="${esc(V.q)}" aria-label="بحث في الرزم"></div>
      <div id="pkg-list">${listHtml()}</div>`;
  },
  mount(root) {
    const list = root.querySelector('#pkg-list');
    const form = root.querySelector('#markup-form');
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
        list.innerHTML = listHtml();
        toast(`حُفظت النسبة: ${V.markup}%`);
      } catch (err) {
        toast(err.message, { error: true });
      } finally { btn.disabled = false; }
    });
    // Only the list is redrawn, so typing keeps the search box's focus.
    root.querySelector('#pkg-q').addEventListener('input', (e) => { V.q = e.target.value; list.innerHTML = listHtml(); });
    list.addEventListener('change', async (e) => {
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
      list.innerHTML = listHtml();
    });
  },
};
