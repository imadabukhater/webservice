import {
  S, api, esc, icon, isAdmin, fmtDate, phone, sheet, field, changed, loadCatalog, companyById, fmtIccid, digits, detectCompany, empty, simsText,
  debounce,
} from '../core.js';
import { scanSupported, scanIccids } from '../scan.js';

const V = { sims: [], agents: [], q: '', status: 'available', agentId: '', shown: 100 };

const parseList = (text) => [...new Set(String(text).split(/[\s,;]+/).map(digits).filter(Boolean))];

// Bulk stock entry: paste, type one per line, or scan several cards in a row.
export async function openAddSims(onDone) {
  await loadCatalog();
  const agents = isAdmin() ? (await api.get('/api/agents')).filter((a) => a.active) : [];
  sheet({
    title: 'إضافة شرائح إلى المخزون',
    subtitle: 'تتعرّف المنصّة على الشركة من أول أرقام الشريحة',
    body: `
      ${isAdmin() ? `<div class="field"><label for="as-agent">لمخزون</label><select class="input" id="as-agent" name="agent">
        <option value="">مخزن المدير</option>${agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="as-list">أرقام الشرائح (ICCID)</label>
        <textarea class="input ltr mono" id="as-list" name="list" rows="6" placeholder="8997202…&#10;8997202…"></textarea>
        <span class="hint" id="as-count">رقم في كل سطر، أو الصق قائمة من Excel.</span></div>
      ${scanSupported() ? `<button type="button" class="btn btn-soft" id="as-scan">${icon('scan')}مسح عدة شرائح بالكاميرا</button>` : ''}
      <div class="field"><label for="as-company">الشركة للأرقام غير المعروفة <span class="opt">(اختياري)</span></label>
        <select class="input" id="as-company" name="company"><option value="">تحديد تلقائي</option>
        ${S.catalog.companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>`,
    submit: 'إضافة',
    onMount(form) {
      form.querySelector('#as-scan')?.addEventListener('click', async () => {
        const codes = await scanIccids({ multiple: true, title: 'امسح الشرائح واحدة تلو الأخرى' });
        if (!codes.length) return;
        const list = form.querySelector('#as-list');
        list.value = [...parseList(list.value), ...codes].join('\n');
        form.dispatchEvent(new Event('input'));
      });
    },
    onInput(form) {
      const items = parseList(field(form, 'list'));
      const bad = items.filter((d) => d.length < 18 || d.length > 22).length;
      const byCo = {};
      items.forEach((d) => { const c = detectCompany(d); const k = c ? c.name : 'غير معروفة'; byCo[k] = (byCo[k] || 0) + 1; });
      const hint = form.querySelector('#as-count');
      hint.className = `hint ${bad ? 'warn' : items.length ? 'ok' : ''}`;
      hint.textContent = items.length
        ? `${simsText(items.length)} · ${Object.entries(byCo).map(([k, n]) => `${k}: ${n}`).join(' · ')}${bad ? ` · ${bad} غير صالحة` : ''}`
        : 'رقم في كل سطر، أو الصق قائمة من Excel.';
    },
    async onSubmit(form) {
      const iccids = parseList(field(form, 'list'));
      if (!iccids.length) throw new Error('أدخل رقم شريحة واحداً على الأقل');
      const r = await api.post('/api/sims', { iccids, agentId: isAdmin() ? Number(field(form, 'agent')) || null : undefined, companyId: Number(field(form, 'company')) || null });
      changed();
      onDone?.();
      if (r.duplicates.length || r.invalid.length) {
        setTimeout(() => sheet({
          title: r.added.length ? `أُضيفت ${simsText(r.added.length)}` : 'لم تُضف شرائح جديدة',
          body: `${r.duplicates.length ? `<div class="field"><b>موجودة مسبقاً (${r.duplicates.length})</b><div class="mono ltr small">${r.duplicates.map(fmtIccid).join('<br>')}</div></div>` : ''}
            ${r.invalid.length ? `<div class="field"><b>غير صالحة (${r.invalid.length})</b><div class="mono ltr small">${r.invalid.map(esc).join('<br>')}</div></div>` : ''}`,
        }), 450);
      }
      return r.added.length ? `أُضيفت ${simsText(r.added.length)} إلى المخزون` : 'لم تُضف شرائح جديدة';
    },
  });
}

function filtered() {
  const d = digits(V.q);
  return V.sims.filter((s) => (!V.status || s.status === V.status) && (!d || s.iccid.includes(d) || (s.lineNumber || '').includes(d)));
}

function rowHtml(s) {
  const co = companyById(s.companyId);
  return `<div class="item"><div class="item-top"><span class="tile sm ${s.status === 'available' ? 'green' : ''}">${icon('sim')}</span>
    <div class="grow"><b class="mono ltr" style="display:block;text-align:start">${fmtIccid(s.iccid)}</b>
      <div class="item-sub"><span>${esc(co?.name || s.companyName || 'شركة غير محددة')}</span>${isAdmin() ? `<span>${esc(s.agentName || 'مخزن المدير')}</span>` : ''}<span>أُضيفت ${fmtDate(s.createdAt)}</span>
      ${s.lineNumber ? `<span>مرتبطة بـ ${phone(s.lineNumber)}</span>` : ''}</div></div>
    <span class="pill ${s.status === 'available' ? 's-active' : ''}">${s.status === 'available' ? 'متاحة' : 'مستعملة'}</span></div>
    ${s.status === 'available' ? `<div class="item-actions">${isAdmin() ? `<button class="btn btn-sm" data-action="assign" data-id="${s.id}">${icon('swap')}نقل لوكيل</button>` : ''}
      <button class="btn btn-sm btn-ghost" data-action="delete-sim" data-id="${s.id}">${icon('trash')}حذف</button></div>` : ''}</div>`;
}

function listHtml() {
  const list = filtered();
  if (!list.length) return empty('sim', V.sims.length ? 'لا توجد شرائح بهذا الفلتر' : 'المخزون فارغ', 'أضف الشرائح بالكاميرا أو بلصق قائمة الأرقام.', `<button class="btn btn-primary" data-action="add">${icon('plus')}إضافة شرائح</button>`);
  return `<div class="grid-cards">${list.slice(0, V.shown).map(rowHtml).join('')}</div>${list.length > V.shown ? `<button class="btn btn-block" data-action="more">عرض المزيد (${list.length - V.shown})</button>` : ''}`;
}

export default {
  title: () => ({ title: 'مخزون الشرائح', subtitle: 'الشرائح الجاهزة للتفعيل' }),
  async load(ctx) {
    if (ctx.query.q !== undefined) { V.q = ctx.query.q; V.status = ''; }
    if (ctx.query.agent !== undefined) V.agentId = ctx.query.agent;
    const [sims, agents] = await Promise.all([
      api.get(`/api/sims${isAdmin() && V.agentId ? `?agentId=${V.agentId}` : ''}`), isAdmin() ? api.get('/api/agents') : [], loadCatalog(),
    ]);
    V.sims = sims;
    V.agents = agents;
  },
  render() {
    const avail = V.sims.filter((s) => s.status === 'available');
    const byCo = new Map();
    avail.forEach((s) => byCo.set(s.companyId, (byCo.get(s.companyId) || 0) + 1));
    return `
      <div class="stats">${[...byCo.entries()].slice(0, 4).map(([cid, n]) => {
        const c = companyById(cid);
        return `<div class="stat"><div class="stat-top"><span class="tile" style="background:color-mix(in srgb, ${esc(c?.color || '#64748b')} 14%, transparent);color:${esc(c?.color || 'var(--muted)')}">${icon('sim')}</span></div>
          <b>${n}</b><span class="label">${esc(c?.name || 'غير محددة')} متاحة</span></div>`;
      }).join('') || `<div class="stat"><div class="stat-top"><span class="tile">${icon('sim')}</span></div><b>0</b><span class="label">شرائح متاحة</span></div>`}</div>
      <div class="toolbar">
        <div class="search-box">${icon('search', 'i lead')}<input class="input" id="sims-q" type="search" inputmode="numeric" placeholder="ابحث برقم الشريحة أو الهاتف" value="${esc(V.q)}"></div>
        ${isAdmin() ? `<select class="input" id="sims-agent" style="width:auto;min-width:170px"><option value="">كل المخازن</option><option value="stock" ${V.agentId === 'stock' ? 'selected' : ''}>مخزن المدير</option>
          ${V.agents.map((a) => `<option value="${a.id}" ${String(a.id) === String(V.agentId) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}
        <button class="btn btn-primary" data-action="add">${icon('plus')}إضافة شرائح</button>
      </div>
      <div class="chips">${[['available', 'متاحة'], ['used', 'مستعملة'], ['', 'الكل']].map(([k, l]) => `<button class="chip" data-action="status" data-s="${k}" aria-pressed="${V.status === k}">${l}<span class="n">${V.sims.filter((s) => !k || s.status === k).length}</span></button>`).join('')}</div>
      <div id="sims-list">${listHtml()}</div>`;
  },
  mount(root, ctx) {
    root.querySelector('#sims-q').addEventListener('input', debounce((e) => { V.q = e.target.value; V.shown = 100; root.querySelector('#sims-list').innerHTML = listHtml(); }, 120));
    root.querySelector('#sims-agent')?.addEventListener('change', (e) => { V.agentId = e.target.value; ctx.reload(); });
  },
  actions: {
    add: () => openAddSims(),
    status(btn, e, ctx) { V.status = btn.dataset.s; ctx.rerender(); },
    more() { V.shown += 100; document.getElementById('sims-list').innerHTML = listHtml(); },
    'delete-sim'(btn) {
      const s = V.sims.find((x) => x.id === Number(btn.dataset.id));
      sheet({
        title: 'حذف الشريحة من المخزون', body: `<p>سيُحذف <span class="mono ltr">${fmtIccid(s.iccid)}</span> من المخزون.</p>`, submit: 'حذف', danger: true,
        async onSubmit() { await api.del(`/api/sims/${s.id}`); changed(); return 'تم حذف الشريحة'; },
      });
    },
    assign(btn) {
      const s = V.sims.find((x) => x.id === Number(btn.dataset.id));
      sheet({
        title: 'نقل الشريحة',
        subtitle: `<span class="mono ltr">${fmtIccid(s.iccid)}</span>`,
        body: `<div class="field"><label for="sa-to">إلى</label><select class="input" id="sa-to" name="to"><option value="">مخزن المدير</option>
          ${V.agents.filter((a) => a.active).map((a) => `<option value="${a.id}" ${a.id === s.agentId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>`,
        submit: 'نقل',
        async onSubmit(form) {
          await api.put('/api/sims/assign', { ids: [s.id], agentId: Number(field(form, 'to')) || null });
          changed();
          return 'تم نقل الشريحة';
        },
      });
    },
  },
};

