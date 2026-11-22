import {
  S, api, esc, icon, money, fmtMoney, sheet, field, changed, loadCatalog, companyLogo, specs, fileToDataUrl, empty, fmtNum, round, relTime, toast,
} from '../core.js';

// One tab per supplier: its eSIM / new-line packages (the shop sells only those), its sync, and the price changes
// awaiting the manager. co: the company shown (0 = all); sort: order inside a company; open: companies unfolded.
const V = { tab: 'ql', q: '', msg: {}, co: 0, sort: 'size', open: new Set(), selected: new Set() };
const SUPPLIERS = {
  ql: {
    name: 'QuickLine', api: 'quickline', configured: () => S.settings.qlConfigured, synced: () => S.settings.qlSyncedInvoice,
    note: 'eSIM على أرقام QuickLine المتاحة. يُفعَّل تلقائياً بعد الدفع.',
  },
  ly: {
    name: 'ليان', api: 'layan', configured: () => S.settings.lyConfigured, synced: () => S.settings.lySyncedInvoice,
    note: 'eSIM على أرقام ليان المتاحة. يُفعَّل تلقائياً ويظهر رمز QR بعد التفعيل.',
  },
  tc: {
    name: 'telecom', api: 'telecom', configured: () => S.settings.tcReady, synced: () => S.settings.tcSyncedInvoice,
    note: 'eSIM من telecom (ALOHA) على أرقامها المتاحة. يُفعَّل تلقائياً بعد الدفع.',
  },
  ay: {
    name: 'أيلول', api: 'aylol', configured: () => !!S.settings.aylolConfigured, synced: () => S.settings.aylolSyncedInvoice,
    note: 'eSIM وخطوط أيلول الجديدة كـ eSIM، برقم من أرقامها المتاحة ورمز QR بعد التفعيل.',
  },
};
const TAB_ICON = 'qr';
// Not connected yet: a plain way to the supplier's account settings, instead of a button that does nothing.
const setupLink = (sup) => `<a class="btn btn-sm btn-primary" href="#/settings?tab=suppliers">${icon('sliders')}أدخل بيانات ${sup.name}</a>`;
const supplierName = (p) => SUPPLIERS[p?.supplier]?.name || 'المورّد';
const tabKey = () => (SUPPLIERS[V.tab] ? V.tab : 'ql');
const inTab = (p, key) => p.supplier === key && p.kind !== 'card';

// Aylol's charge page lists the customer's price; what it really takes is supplierCost, when the site says so.
const isAy = (p) => p.supplier === 'ay';
const realCost = (p) => (isAy(p) && p.supplierCost !== null && p.supplierCost !== undefined ? p.supplierCost : p.cost);
// What the shop earns on a package: the customer's price less what it costs.
const shopProfit = (p) => (p.shopPrice ? round(p.shopPrice - realCost(p)) : null);

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
      <div class="row2">
        <div class="field"><label for="co-color">اللون</label><div class="input-group"><input class="input" id="co-color" name="color" type="color" value="${esc(c?.color || '#2563eb')}" style="padding:4px;max-width:90px">
          <span class="hint">للنقاط والشعار الافتراضي</span></div></div>
        <div class="field"><label for="co-esim-fee">سعر كود QR / eSIM للشركة (₪)</label>
          <input class="input ltr" id="co-esim-fee" name="esimFee" type="number" min="0" step="0.5" inputmode="decimal" value="${c?.esimFee ?? ''}" placeholder="افتراضي (${S.settings?.esimFee ?? 0} ₪)">
          <span class="hint">يُضاف إلى سعر الزبون. اتركه فارغاً لاستعمال السعر العام.</span></div>
      </div>
      <div class="field"><span class="label">طريقة التفعيل بعد الدفع</span>
        <div class="switches">
          <label class="switch-row"><span class="tile sm green">${icon('refresh')}</span><span class="grow"><b>تلقائي عبر المورّد</b><small>يُفعَّل الـ eSIM عند المورّد فور تأكيد الدفع ويظهر رمز QR للزبون.</small></span>
            <input type="radio" name="activation" value="auto" ${c?.activation === 'auto' ? 'checked' : ''}></label>
          <label class="switch-row"><span class="tile sm">${icon('tasks')}</span><span class="grow"><b>يدوي</b><small>يصلك في «التفعيلات»: تفعّله عند المورّد وترفق رمز QR.</small></span>
            <input type="radio" name="activation" value="manual" ${c?.activation !== 'auto' ? 'checked' : ''}></label>
        </div></div>`,
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
      const body = {
        name: field(form, 'name'), color: field(form, 'color'), logo,
        activation: form.elements.activation.value, esimFee: field(form, 'esimFee'),
      };
      await (c ? api.put(`/api/companies/${c.id}`, body) : api.post('/api/companies', body));
      await loadCatalog(true);
      changed();
      return c ? 'تم حفظ الشركة' : 'تمت إضافة الشركة';
    },
  });
}

// Packages come from the suppliers' syncs; the manager sets how the shop shows and prices them.
export function openPackageForm(p) {
  const amountVal = (v) => (v === -1 ? 'غير محدود' : v ?? '');
  sheet({
    title: 'تعديل رزمة',
    subtitle: p.artCode ? `رمز ${supplierName(p)}: <span class="mono ltr">${esc(p.artCode)}</span>` : esc(p.companyName || ''),
    body: `
      <div class="msg info">${icon('info')}<span>رزمة من ${supplierName(p)}. بعد حفظ تعديلك تبقى قيمك كما هي عند كل مزامنة، وتتحدث «التكلفة» فقط.</span></div>
      <div class="field"><label for="pk-name">اسم الرزمة</label><input class="input" id="pk-name" name="name" value="${esc(p.name || '')}" required></div>
      <div class="row2"><div class="field"><label for="pk-gb">حجم الإنترنت (GB)</label><input class="input ltr" id="pk-gb" name="dataGb" type="number" min="0" step="1" inputmode="numeric" value="${p.dataGb ?? ''}"></div>
        <div class="field"><label for="pk-days">المدة بالأيام <span class="opt">(فارغ = شهرية)</span></label><input class="input ltr" id="pk-days" name="days" type="number" min="1" max="730" step="1" inputmode="numeric" value="${p.days ?? ''}" placeholder="30، 90…"></div></div>
      <div class="field"><label for="pk-tag">وسم <span class="opt">(مثل 5G)</span></label><input class="input ltr" id="pk-tag" name="tag" value="${esc(p.tag || '')}"></div>
      <div class="row2"><div class="field"><label for="pk-min">الدقائق</label><input class="input ltr" id="pk-min" name="minutes" list="unlimited" value="${esc(amountVal(p.minutes))}" placeholder="5000"></div>
        <div class="field"><label for="pk-sms">الرسائل</label><input class="input ltr" id="pk-sms" name="sms" list="unlimited" value="${esc(amountVal(p.sms))}" placeholder="5000"></div></div>
      <datalist id="unlimited"><option value="غير محدود"></option></datalist>
      <div class="field"><label for="pk-desc">وصف قصير <span class="opt">(اختياري)</span></label><input class="input" id="pk-desc" name="description" value="${esc(p.description || '')}"></div>
      <div class="field">${isAy(p)
        ? `<label for="pk-cost">سعر أيلول للزبون (₪)</label><input class="input ltr" id="pk-cost" name="cost" type="number" value="${round(p.cost)}" readonly>
           <span class="hint">من أيلول نفسه، ويُرسل معه الطلب. سعرك منه: ${p.supplierCost !== null && p.supplierCost !== undefined ? `<b>${fmtMoney(p.supplierCost)}</b>` : 'غير معروف بعد'}</span>`
        : `<label for="pk-cost">التكلفة عليك (₪)</label><input class="input ltr" id="pk-cost" name="cost" type="number" min="0" step="0.01" inputmode="decimal" value="${round(p.cost)}">`}</div>
      <div class="row2">
        <div class="field"><label for="pk-shop">سعر الزبون في المتجر (₪)</label>
          <input class="input ltr" id="pk-shop" name="shopPrice" type="number" min="0" step="0.01" inputmode="decimal" value="${p.shopPrice ?? ''}" placeholder="فارغ = مخفية عن المتجر"></div>
        <div class="field"><label for="pk-old">السعر قبل الخصم (₪) <span class="opt">(اختياري)</span></label>
          <input class="input ltr" id="pk-old" name="oldPrice" type="number" min="0" step="0.01" inputmode="decimal" value="${p.oldPrice ?? ''}" placeholder="مثال: 120 لإظهار التوفير"></div>
      </div>
      <div class="hint" id="pk-margin"></div>
      <label class="switch-row"><span class="tile sm cyan">${icon('qr')}</span><span class="grow"><b>eSIM</b><small>تُباع الرزمة كشريحة eSIM مع رمز QR وسعر QR الخاص بالشركة</small></span><input class="switch" type="checkbox" name="esimEnabled" ${p.esimEnabled || p.lyEsim ? 'checked' : ''}></label>
      <label class="switch-row"><span class="tile sm amber">${icon('bolt')}</span><span class="grow"><b>الأكثر مبيعاً / مميزة في المتجر</b><small>إبراز الباقة بشارة «الأكثر طلباً» في متجر الزبائن</small></span><input class="switch" type="checkbox" name="popular" ${p.popular ? 'checked' : ''}></label>
      <label class="switch-row"><span class="grow"><b>ظاهرة في المتجر</b><small>أوقفها لإخفائها مؤقتاً</small></span><input class="switch" type="checkbox" name="active" ${p.active ? 'checked' : ''}></label>`,
    submit: 'حفظ',
    onInput(form) {
      const cost = isAy(p) ? realCost(p) : Number(field(form, 'cost')) || 0;
      const price = Number(field(form, 'shopPrice')) || 0;
      const box = form.querySelector('#pk-margin');
      box.className = `hint ${price - cost < 0 ? 'bad' : 'ok'}`;
      box.innerHTML = price ? `${icon('coins')}<span>ربحك من الزبون: ${fmtMoney(price - cost)} (قبل رسوم QR)</span>` : `${icon('info')}<span>بلا سعر للزبون لا تظهر الرزمة في المتجر.</span>`;
    },
    async onSubmit(form) {
      const body = {
        companyId: p.companyId, name: field(form, 'name'), dataGb: field(form, 'dataGb'), minutes: field(form, 'minutes'), sms: field(form, 'sms'),
        tag: field(form, 'tag'), description: field(form, 'description'), cost: field(form, 'cost') || 0,
        shopPrice: field(form, 'shopPrice'), oldPrice: field(form, 'oldPrice'),
        popular: form.elements.popular.checked, esimEnabled: form.elements.esimEnabled.checked,
        active: form.elements.active.checked, days: field(form, 'days'),
      };
      await api.put(`/api/packages/${p.id}`, body);
      await loadCatalog(true);
      changed();
      return 'تم حفظ الرزمة';
    },
  });
}

// ---------- one supplier's controls: its sync and the price changes awaiting approval ----------
function supplierBar(key) {
  const sup = SUPPLIERS[key];
  const pending = S.catalog.packages.filter((p) => inTab(p, key) && p.artPending).length;
  const synced = sup.synced();
  const msg = V.msg[key];
  return `<section class="card card-pad sys-bar">
    <div class="sys-row"><span class="tile sm">${icon('refresh')}</span>
      <div class="grow"><b>المزامنة من ${sup.name}</b><small>${synced ? `آخر مزامنة ${relTime(synced)}` : 'لم تتم بعد'} · تضيف الجديد ولا تغيّر أسعارك الحالية</small></div>
      ${sup.configured() ? `<button class="btn btn-sm" data-action="sync" data-tab="${key}">${icon('refresh')}مزامنة ${sup.name}</button>` : setupLink(sup)}</div>
    ${pending ? `<div class="msg warn" style="align-items:center">${icon('alert')}<span class="grow"><b>${pending} رزمة تغيّر سعرها في ${sup.name}</b> — لن تتغيّر تكلفتك إلا بموافقتك.</span>
      <button class="btn btn-sm" data-action="pending" data-tab="${key}">مراجعة</button></div>` : ''}
    ${msg ? `<div class="msg ${msg.error ? '' : 'info'}">${icon(msg.error ? 'alert' : 'checkCircle')}<span>${esc(msg.text)}</span></div>` : ''}
  </section>`;
}

async function refreshAll(ctx) {
  S.settings = await api.get('/api/settings');
  await loadCatalog(true);
  ctx.rerender();
}

function openPending(key, ctx) {
  const sup = SUPPLIERS[key];
  api.get(`/api/${sup.api}/pending?kind=invoice`).then((rows) => {
    if (!rows.length) { toast('لا توجد تغييرات بانتظارك'); return; }
    const row = (p) => `<article class="item pend-row" data-id="${p.id}">
      <div class="item-top"><div class="grow"><b class="item-title">${esc(p.name)}</b><div class="item-sub"><span>${esc(p.companyName)}</span>${p.active ? '' : '<span>مخفية</span>'}${p.edited ? '<span>معدّلة يدوياً</span>' : ''}</div></div></div>
      <div class="kv small"><div>التكلفة</div><div>${money(p.cost)} ← <b>${money(p.artPrice)}</b></div></div>
      <div class="item-actions"><button type="button" class="btn btn-sm btn-good" data-mode="cost">${icon('check')}اعتماد التكلفة الجديدة</button>
        <button type="button" class="btn btn-sm btn-ghost" data-mode="ignore">تجاهل</button></div></article>`;
    sheet({
      title: `تغييرات أسعار ${sup.name}`,
      subtitle: 'راجع سعر الزبون في المتجر بعد اعتماد تكلفة أعلى',
      wide: true,
      body: `<div class="list" id="pend-list">${rows.map(row).join('')}</div>`,
      footer: `<button type="button" class="btn btn-primary" data-bulk="cost">${icon('check')}اعتماد الكل (${rows.length})</button>
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
            toast(b.dataset.bulk === 'ignore' ? `تُجوهل ${ids.length}` : `اعتُمد ${ids.length}`);
            el.querySelector('[data-close]').click();
          } catch (err) { toast(err.message, { error: true }); b.disabled = false; }
        }));
      },
    });
  });
}

// ---------- one company: its packages by supplier ----------
function sourceCounts(companyId) {
  const pk = S.catalog.packages.filter((p) => p.companyId === companyId);
  return Object.entries(SUPPLIERS).map(([k, s]) => [s.name, pk.filter((p) => inTab(p, k)).length])
    .filter(([, n]) => n).map(([label, n]) => `${label} ${n}`).join(' · ');
}
function companyPackagesHtml(c) {
  const pk = S.catalog.packages.filter((p) => p.companyId === c.id);
  const groups = Object.entries(SUPPLIERS).map(([k, s]) => [s.name, pk.filter((p) => inTab(p, k))]).filter(([, l]) => l.length);
  const row = (p) => `<div class="item-top cp-row">
      <div class="grow"><b>${esc(p.name)}</b>${p.active ? '' : p.gone ? ' <span class="pill s-expiring">لم تعد عند المورّد</span>' : ' <span class="pill">مخفية</span>'}
        <div class="item-sub"><span>${p.days ? `${p.days} يوماً` : 'شهرية'}</span><span>التكلفة ${money(p.cost)}</span>${p.shopPrice ? `<span>المتجر ${money(p.shopPrice)}</span>` : ''}${p.artCode ? `<span class="mono ltr">${esc(p.artCode)}</span>` : ''}</div></div>
      <button type="button" class="btn btn-sm" data-cp-toggle="${p.id}">${icon(p.active ? 'eyeOff' : 'eye')}${p.active ? 'إخفاء' : 'إظهار'}</button>
      <button type="button" class="btn btn-sm" data-cp-edit="${p.id}">${icon('edit')}تعديل</button></div>`;
  return groups.map(([label, list]) => `<details class="pr-group" open><summary><b>${label}</b> <span class="muted small">${list.length} · ظاهرة ${list.filter((p) => p.active).length}</span></summary>${list.map(row).join('')}</details>`).join('')
    || empty('box', 'لا توجد رزم لهذه الشركة', 'تأتي الرزم من مزامنة المورّدين.');
}
function openCompanyPackages(c) {
  let box;
  // Edits made from here (or anywhere) show here at once.
  const redraw = async () => {
    await loadCatalog(true);
    if (box?.isConnected) box.innerHTML = companyPackagesHtml(c);
  };
  const onChanged = () => { redraw().catch(() => {}); };
  window.addEventListener('app:changed', onChanged);
  sheet({
    title: `رزم ${c.name}`,
    subtitle: 'كل رزم الشركة حسب المورّد',
    wide: true,
    body: `<div id="cp-body">${companyPackagesHtml(c)}</div>`,
    onClose: () => window.removeEventListener('app:changed', onChanged),
    onMount(form) {
      box = form.querySelector('#cp-body');
      box.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const find = (id) => S.catalog.packages.find((p) => p.id === Number(id));
        if (b.dataset.cpEdit) openPackageForm(find(b.dataset.cpEdit));
        else if (b.dataset.cpToggle) {
          b.disabled = true;
          const p = find(b.dataset.cpToggle);
          await api.put(`/api/packages/${p.id}`, { active: !p.active });
          changed({ keepView: true });
        }
      });
    },
  });
}

// ---------- the same eSIM from two suppliers: keep the cheaper one in the shop ----------
// Groups the manager chose to keep as they are (this browser only), until their prices change.
const IGNORED_KEY = 'agents-similar-ignored';
const ignored = () => { try { return JSON.parse(localStorage.getItem(IGNORED_KEY) || '[]'); } catch { return []; } };
const groupSig = (g) => `${g.key}|${g.packages.map((p) => `${p.id}:${p.cost}:${p.active ? 1 : 0}`).join(',')}`;
const openGroups = () => (V.similar || []).filter((g) => !ignored().includes(groupSig(g)));

function similarBanner() {
  const groups = openGroups();
  if (!groups.length) return '';
  const saving = groups.reduce((t, g) => t + g.saving, 0);
  return `<div class="msg warn" style="align-items:center">${icon('coins')}<span class="grow"><b>${groups.length} رزمة متوفّرة عند أكثر من مورّد</b>
    — نفس الشركة ونفس الإنترنت والمدة، وأحدهما أرخص عليك${saving > 0 ? ` (توفير حتى ${fmtMoney(saving)})` : ''}.</span>
    <button class="btn btn-sm" data-action="similar">مراجعة</button></div>`;
}

function similarHtml() {
  const groups = openGroups();
  if (!groups.length) return empty('checkCircle', 'لا توجد رزم متشابهة تحتاج قراراً', '');
  return groups.map((g) => `<section class="card card-pad" style="display:grid;gap:8px;box-shadow:none;background:var(--surface-2)">
    <b>${esc(g.companyName)} · ${fmtNum(g.dataGb)} جيجا · ${g.days} يوماً</b>
    ${g.packages.map((p) => `<div class="item-top cp-row"><div class="grow"><b>${esc(p.name)}</b>
      <div class="item-sub"><span>${p.source}</span><span>التكلفة ${money(p.cost)}</span><span>${p.active ? 'ظاهرة' : 'مخفية'}</span></div></div>
      ${p.id === g.cheapestId ? '<span class="pill s-active">الأرخص عليك</span>' : ''}</div>`).join('')}
    <div class="btn-row"><button type="button" class="btn btn-primary btn-sm" data-sim-pick="${esc(g.key)}">${icon('check')}أظهر الأرخص فقط</button>
      <button type="button" class="btn btn-ghost btn-sm" data-sim-ignore="${esc(g.key)}">تجاهل</button></div>
    <small class="muted">«أظهر الأرخص فقط»: يُظهر الأرخص ويُخفي الأخرى. تبقى كلها في القائمة عندك.</small>
  </section>`).join('');
}

function openSimilar(ctx) {
  let box;
  const redraw = async () => {
    [, V.similar] = await Promise.all([loadCatalog(true), api.get('/api/catalog/similar')]);
    if (box?.isConnected) box.innerHTML = similarHtml();
    ctx.rerender();
  };
  sheet({
    title: 'رزم متشابهة من مورّدَين',
    subtitle: 'نفس الشركة ونفس الإنترنت والمدة: الأرخص عليك يربحك أكثر بنفس سعر الزبون',
    wide: true,
    body: `<div id="sim-body" style="display:grid;gap:12px">${similarHtml()}</div>`,
    onMount(form) {
      box = form.querySelector('#sim-body');
      box.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        const g = b && (V.similar || []).find((x) => x.key === (b.dataset.simPick || b.dataset.simIgnore));
        if (!g) return;
        b.disabled = true;
        if (b.dataset.simIgnore) {
          try { localStorage.setItem(IGNORED_KEY, JSON.stringify([...ignored(), groupSig(g)])); } catch { /* storage blocked */ }
        } else {
          for (const p of g.packages) {
            const want = p.id === g.cheapestId;
            if (p.active !== want) await api.put(`/api/packages/${p.id}`, { active: want });
          }
          toast('صار الأرخص هو الظاهر');
        }
        await redraw();
      });
    },
  });
}

// One package as a compact row: what it is, what it costs and earns in the shop, and its actions.
function packageRowAdmin(p) {
  const profit = shopProfit(p);
  const checked = V.selected.has(p.id);
  const pills = [
    p.active ? '' : p.gone ? `<span class="pill s-expiring">لم تعد عند ${supplierName(p)}</span>` : '<span class="pill">مخفية</span>',
    p.shopPrice ? `<span class="pill s-active">المتجر ${money(p.shopPrice)}</span>` : '<span class="pill s-expiring">بلا سعر للزبون</span>',
    p.popular ? '<span class="pill s-expiring">الأكثر طلباً</span>' : '',
    p.artPending ? '<span class="pill s-expiring">سعر جديد</span>' : '',
  ].join('');
  return `<article class="item pk-row ${p.active ? '' : 'inactive'}">
    <div class="item-top">
      <input type="checkbox" class="pk-check" data-action="check-package" data-id="${p.id}" ${checked ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--brand);cursor:pointer;margin-top:2px" aria-label="تحديد ${esc(p.name)}">
      <div class="grow"><b class="item-title">${esc(p.name)}</b> ${pills}
      <div class="item-sub">${p.dataGb ? `<span><b>${fmtNum(p.dataGb)}</b> GB</span>` : ''}<span>${p.days ? `${p.days} يوماً` : 'شهرية'}</span>
        ${isAy(p)
          ? `<span>أيلول للزبون ${money(p.cost)}</span><span>سعرك منه ${p.supplierCost !== null && p.supplierCost !== undefined ? `<b>${money(p.supplierCost)}</b>` : 'غير معروف'}</span>`
          : `<span>التكلفة ${money(p.cost)}</span>`}
        ${profit !== null ? `<span class="${profit < 0 ? 'minus' : 'plus'}">ربح ${money(profit)}</span>` : ''}
        ${specs(p) ? `<span class="pkg-specs">${specs(p)}</span>` : ''}
        ${p.artCode ? `<span class="mono ltr">${esc(p.artCode)}</span>` : ''}${p.edited ? '<span>معدّلة</span>' : ''}</div></div>
      <div class="item-actions">
        <button class="icon-btn pk-act" data-action="toggle-package" data-id="${p.id}" title="${p.active ? 'إخفاء' : 'إظهار'}" aria-label="${p.active ? 'إخفاء' : 'إظهار'}">${icon(p.active ? 'eyeOff' : 'eye')}</button>
        <button class="icon-btn pk-act" data-action="edit-package" data-id="${p.id}" title="تعديل" aria-label="تعديل">${icon('edit')}</button>
        <button class="icon-btn plain pk-act" data-action="delete-package" data-id="${p.id}" title="حذف" aria-label="حذف">${icon('trash')}</button></div></div>
  </article>`;
}

function bulkToolbar(mine) {
  const selCount = [...V.selected].filter((id) => S.catalog.packages.some((p) => p.id === id)).length;
  const allInViewSelected = mine.length > 0 && mine.every((p) => V.selected.has(p.id));
  return `<section class="card card-pad" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between;background:var(--surface-2)">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <button type="button" class="btn btn-sm ${allInViewSelected ? 'btn-soft' : ''}" data-action="select-all-view">
        ${icon('check')}${allInViewSelected ? 'إلغاء تحديد المعروض' : `تحديد كل المعروض (${mine.length})`}
      </button>
      ${selCount ? `<span class="pill s-active">محدد: ${selCount} رزمة</span>
        <button type="button" class="btn btn-sm btn-good" data-action="bulk-act" data-bulk="show">${icon('eye')}إظهار المحدد</button>
        <button type="button" class="btn btn-sm" data-action="bulk-act" data-bulk="hide">${icon('eyeOff')}إخفاء المحدد</button>
        <button type="button" class="btn btn-sm btn-soft" data-action="bulk-shop">${icon('card')}سعر المتجر</button>
        <button type="button" class="btn btn-sm btn-soft" data-action="bulk-act" data-bulk="esim-enable">${icon('qr')}تفعيل eSIM</button>
        <button type="button" class="btn btn-sm btn-danger" data-action="bulk-delete">${icon('trash')}حذف المحدد (${selCount})</button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="clear-selection">مسح التحديد</button>` : '<span class="muted small">حدد رزماً من القائمة لإخفائها أو إظهارها أو تسعيرها دفعة واحدة</span>'}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" class="btn btn-sm btn-danger" data-action="reset-resync">${icon('refresh')}حذف كل الرزم وإعادة المزامنة</button>
    </div>
  </section>`;
}
const SORTS = { size: 'الحجم', price: 'السعر', days: 'المدة', name: 'الاسم' };
function sortPackages(list) {
  const key = {
    size: (a, b) => (a.dataGb ?? -1) - (b.dataGb ?? -1) || a.cost - b.cost,
    price: (a, b) => a.cost - b.cost || (a.dataGb ?? 0) - (b.dataGb ?? 0),
    days: (a, b) => (a.days || 30) - (b.days || 30) || a.cost - b.cost,
    name: (a, b) => a.name.localeCompare(b.name, 'ar'),
  }[V.sort] || (() => 0);
  // Packages the supplier no longer lists go last.
  return [...list].sort((a, b) => (a.gone - b.gone) || key(a, b));
}
const matches = (p, term) => !term || `${p.name} ${p.companyName} ${p.artCode}`.toLowerCase().includes(term);

export default {
  title: () => ({ title: 'الشركات والرزم', subtitle: 'رزم eSIM من المورّدين: الأسعار وما يظهر في المتجر' }),
  async load() { [S.settings, , V.similar] = await Promise.all([api.get('/api/settings'), loadCatalog(true), api.get('/api/catalog/similar')]); },
  mount(root, ctx) {
    root.querySelector('#pkg-sort')?.addEventListener('change', (e) => { V.sort = e.target.value; ctx.rerender(); });
    // Which companies the manager unfolded stays as it is when the page redraws.
    root.querySelectorAll('details.co-sec').forEach((d) => d.addEventListener('toggle', () => {
      const id = Number(d.dataset.company);
      if (d.open) V.open.add(id); else V.open.delete(id);
    }));
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
    const tabs = `<div class="segmented">${Object.entries(SUPPLIERS).map(([k, s]) => `<button data-action="tab" data-tab="${k}" aria-pressed="${tabKey() === k && V.tab !== 'companies'}">${icon(TAB_ICON)}${s.name} (${packages.filter((p) => inTab(p, k)).length})</button>`).join('')}
      <button data-action="tab" data-tab="companies" aria-pressed="${V.tab === 'companies'}">${icon('building')}الشركات (${companies.length})</button></div>`;
    if (V.tab === 'companies') {
      return `${tabs}<div class="page-head"><p>الشعار واللون وسعر رمز QR (eSIM) وطريقة التفعيل لكل شركة.</p><button class="btn btn-primary" data-action="add-company">${icon('plus')}شركة جديدة</button></div>
        ${companies.length ? `<div class="grid-cards">${companies.map((c) => `<article class="item"><div class="item-top">${companyLogo(c, 'sm')}
          <div class="grow"><b class="item-title">${esc(c.name)}</b><div class="item-sub"><span>${c.packageCount} رزمة${c.packageCount && sourceCounts(c.id) ? ` (${sourceCounts(c.id)})` : ''}</span><span>سعر QR: <b>${c.esimFee !== null && c.esimFee !== undefined ? fmtMoney(c.esimFee) : `${fmtMoney(S.settings?.esimFee || 0)} (عام)`}</b></span></div></div>
            <span class="pill ${c.activation === 'auto' ? 's-active' : 'plain'}">${c.activation === 'auto' ? 'تلقائي' : 'يدوي'}</span></div>
          <div class="item-actions"><button class="btn btn-sm btn-soft" data-action="company-packages" data-id="${c.id}">${icon('box')}الرزم</button>
            <button class="btn btn-sm" data-action="edit-company" data-id="${c.id}">${icon('edit')}تعديل</button>
            <button class="btn btn-sm btn-ghost" data-action="delete-company" data-id="${c.id}">${icon('trash')}حذف</button></div></article>`).join('')}</div>`
          : empty('building', 'لا توجد شركات', 'أضف أول شركة اتصالات.')}`;
    }
    const key = tabKey();
    const sup = SUPPLIERS[key];
    const term = V.q.trim().toLowerCase();
    const all = packages.filter((p) => inTab(p, key));
    const mine = all.filter((p) => matches(p, term));
    const shown = mine.filter((p) => p.active).length;
    return `${tabs}${similarBanner()}${supplierBar(key)}<div class="page-head"><p><b>${sup.name}:</b> ${sup.note} ظاهرة ${shown} من ${mine.length}.</p></div>
      ${bulkToolbar(mine)}
      <div class="search-box">${icon('search', 'i lead')}<input class="input" id="pkg-q" type="search" placeholder="ابحث باسم الرزمة أو الشركة أو رمز المورّد…" value="${esc(V.q)}" aria-label="بحث في الرزم"></div>
      ${(() => {
        // The companies that have packages here, as chips; one chosen shows only it.
        const cos = companies.filter((c) => all.some((p) => p.companyId === c.id));
        if (V.co && !cos.some((c) => c.id === V.co)) V.co = 0;
        return `<div class="cat-tools">${cos.length > 1 ? `<div class="chips">${[{ id: 0, name: 'كل الشركات' }, ...cos].map((c) => `<button class="chip" data-action="pick-company" data-id="${c.id}" aria-pressed="${V.co === c.id}">${esc(c.name)}${c.id ? ` <span class="n">${mine.filter((p) => p.companyId === c.id).length}</span>` : ''}</button>`).join('')}</div>` : ''}
          <label class="cat-sort">ترتيب الرزم <select class="input" id="pkg-sort">${Object.entries(SORTS).map(([k, l]) => `<option value="${k}" ${V.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>`;
      })()}
      ${companies.filter((c) => !V.co || c.id === V.co).map((c) => {
        const list = sortPackages(mine.filter((p) => p.companyId === c.id));
        if (!list.length) return '';
        const visible = list.filter((p) => p.active).length;
        const cheapest = list.filter((p) => p.active && p.shopPrice > 0).reduce((m, p) => Math.min(m, p.shopPrice), Infinity);
        // Unfolded: a company searched for or chosen, one the manager opened, or the only one.
        const open = term || V.co || V.open.has(c.id) || companies.filter((x) => mine.some((p) => p.companyId === x.id)).length === 1;
        return `<details class="co-sec card" data-company="${c.id}" ${open ? 'open' : ''}>
          <summary><span class="co-head">${companyLogo(c, 'xs')}<b>${esc(c.name)}</b></span>
            <span class="co-meta">${visible} ظاهرة من ${list.length}${Number.isFinite(cheapest) ? ` · من ${money(cheapest)}` : ''}</span></summary>
          <div class="list">${list.map(packageRowAdmin).join('')}</div>
        </details>`;
      }).join('') || empty(TAB_ICON, term ? 'لا نتائج' : `لا توجد رزم من ${sup.name}`, term ? '' : `اضغط «مزامنة ${sup.name}» أعلى الصفحة.`)}`;
  },
  actions: {
    tab(btn, e, ctx) { V.tab = btn.dataset.tab; V.co = 0; ctx.rerender(); },
    'pick-company'(btn, e, ctx) { V.co = Number(btn.dataset.id); ctx.rerender(); },
    'add-company': () => openCompanyForm(null),
    'edit-company': (btn) => openCompanyForm(S.catalog.companies.find((c) => c.id === Number(btn.dataset.id))),
    similar: (btn, e, ctx) => openSimilar(ctx),
    'company-packages': (btn) => openCompanyPackages(S.catalog.companies.find((c) => c.id === Number(btn.dataset.id))),
    'delete-company'(btn) {
      const c = S.catalog.companies.find((x) => x.id === Number(btn.dataset.id));
      sheet({
        title: `حذف ${c.name}`, body: `<p>تُحذف الشركة نهائياً. يجب حذف رزمها أولاً.</p>`, submit: 'حذف الشركة', danger: true,
        async onSubmit() { await api.del(`/api/companies/${c.id}`); await loadCatalog(true); changed(); return 'تم حذف الشركة'; },
      });
    },
    'check-package'(btn, e, ctx) {
      const id = Number(btn.dataset.id);
      if (btn.checked) V.selected.add(id); else V.selected.delete(id);
      ctx.rerender();
    },
    'select-all-view'(btn, e, ctx) {
      const term = V.q.trim().toLowerCase();
      const mine = S.catalog.packages.filter((p) => inTab(p, tabKey()) && (!V.co || p.companyId === V.co) && matches(p, term));
      const allSel = mine.length > 0 && mine.every((p) => V.selected.has(p.id));
      for (const p of mine) {
        if (allSel) V.selected.delete(p.id);
        else V.selected.add(p.id);
      }
      ctx.rerender();
    },
    'clear-selection'(btn, e, ctx) {
      V.selected.clear();
      ctx.rerender();
    },
    async 'bulk-act'(btn, e, ctx) {
      const ids = [...V.selected];
      if (!ids.length) return;
      btn.disabled = true;
      try {
        const r = await api.post('/api/packages/bulk', { ids, action: btn.dataset.bulk });
        toast(`تم تحديث ${r.affected} رزمة`);
        await loadCatalog(true);
        ctx.rerender();
      } finally { btn.disabled = false; }
    },
    'bulk-shop'(btn, e, ctx) {
      const ids = [...V.selected];
      if (!ids.length) return;
      sheet({
        title: `إظهار ${ids.length} رزمة في متجر الزبائن`,
        subtitle: 'حدّد سعراً موحّداً للزبون، أو اتركه فارغاً ليُحسب تلقائياً',
        body: `<div class="field"><label for="bs-price">سعر الزبون في المتجر (₪) <span class="opt">(اختياري)</span></label>
          <input class="input ltr" id="bs-price" name="shopPrice" type="number" min="0" step="0.5" placeholder="اتركه فارغاً للحساب التلقائي"></div>`,
        submit: 'تطبيق وإظهار في المتجر',
        async onSubmit(form) {
          const shopPrice = field(form, 'shopPrice');
          const r = await api.post('/api/packages/bulk', { ids, action: 'shop-show', shopPrice: shopPrice || undefined });
          await loadCatalog(true);
          ctx.rerender();
          return `تم إظهار ${r.affected} رزمة في المتجر`;
        },
      });
    },
    'bulk-delete'(btn, e, ctx) {
      const ids = [...V.selected];
      if (!ids.length) return;
      sheet({
        title: `حذف ${ids.length} رزمة محددة`,
        body: `<p>هل أنت متأكد من حذف <b>${ids.length}</b> رزمة نهائياً؟ يمكنك إعادة المزامنة لاحقاً لجلب الرزم من جديد.</p>`,
        submit: `حذف ${ids.length} رزمة`,
        danger: true,
        async onSubmit() {
          const r = await api.post('/api/packages/bulk', { ids, action: 'delete' });
          V.selected.clear();
          await loadCatalog(true);
          ctx.rerender();
          return `تم حذف ${r.affected} رزمة`;
        },
      });
    },
    'reset-resync'(btn, e, ctx) {
      const totalAll = S.catalog.packages.length;
      sheet({
        title: 'حذف كل الرزم وإعادة المزامنة',
        subtitle: 'حذف كافة الرزم الحالية وإعادة جلب أحدث الرزم والأسعار من المورّدين',
        body: `<div class="msg warn">${icon('alert')}<span>سيتم حذف جميع الرزم الحالية (${totalAll} رزمة) وإعادة المزامنة مع المورّدين المفعّلين. أسعار الزبائن في المتجر تحتاج إعادة تحديد بعدها.</span></div>
          <label class="switch-row"><span class="grow"><b>إعادة المزامنة تلقائياً بعد الحذف</b><small>يجلب أحدث الرزم والأسعار فوراً من المورّدين المتصلين</small></span><input class="switch" type="checkbox" name="doSync" checked></label>`,
        submit: 'حذف الكل وإعادة المزامنة الآن',
        danger: true,
        async onSubmit(form) {
          const doSync = form.elements.doSync.checked;
          const delRes = await api.post('/api/packages/bulk', { all: true, action: 'delete' });
          V.selected.clear();
          const syncedParts = [];
          if (doSync) {
            for (const sup of Object.values(SUPPLIERS)) {
              if (!sup.configured()) continue;
              try {
                const r = await api.post(`/api/${sup.api}/sync`, { kind: 'invoice' });
                if (r.added) syncedParts.push(`${sup.name}: +${r.added}`);
              } catch { /* not connected */ }
            }
          }
          await refreshAll(ctx);
          return `تم حذف ${delRes.affected} رزمة${syncedParts.length ? ` · المزامنة: ${syncedParts.join(' ، ')}` : ''}`;
        },
      });
    },
    pending: (btn, e, ctx) => openPending(btn.dataset.tab, ctx),
    async sync(btn, e, ctx) {
      const key = btn.dataset.tab;
      const sup = SUPPLIERS[key];
      btn.disabled = true;
      btn.innerHTML = `${icon('clock')}جاري القراءة من ${sup.name}…`;
      try {
        const r = await api.post(`/api/${sup.api}/sync`, { kind: 'invoice' });
        V.msg[key] = { text: `${r.total} من ${sup.name}: أُضيف ${r.added} جديدة${r.switchedOff ? `، أُخفيت ${r.switchedOff} لم تعد موجودة` : ''}. أسعارك الحالية لم تتغيّر${r.pending ? `، و${r.pending} تغيّر سعرها بانتظار موافقتك` : ''}.${r.hidden ? ` ${r.hidden} رزمة لم تظهر لأن رصيد ${sup.name} أقل من سعرها.` : ''}` };
      } catch (err) {
        V.msg[key] = { text: err.message, error: true };
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
        title: `حذف ${p.name}`, body: `<p>تُحذف الرزمة. سجل المشترين عليها يبقى كما هو. لإخفائها مؤقتاً استعمل «إخفاء».</p>`, submit: 'حذف الرزمة', danger: true,
        async onSubmit() { await api.del(`/api/packages/${p.id}`); await loadCatalog(true); changed(); return 'تم حذف الرزمة'; },
      });
    },
  },
};
