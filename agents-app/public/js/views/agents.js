import {
  api, esc, icon, money, fmtMoney, sheet, field, changed, relTime, initials, empty, debounce, round, go, arCount, simsText,
} from '../core.js';
import { openAgentBalance, openTransfer } from './payments.js';

const V = { agents: [], q: '' };

// A stable colour per agent so avatars are easy to tell apart.
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export function openAgentForm(a, onDone) {
  sheet({
    title: a ? `تعديل ${a.name}` : 'إضافة وكيل',
    subtitle: a ? '' : 'أعطِ الوكيل اسم المستخدم وكلمة المرور ليدخل من هاتفه',
    body: `
      <div class="field"><label for="ag-name">اسم الوكيل</label><input class="input" id="ag-name" name="name" value="${esc(a?.name || '')}" required></div>
      <div class="row2 stack-xs">
        <div class="field"><label for="ag-user">اسم المستخدم</label><input class="input ltr" id="ag-user" name="username" autocapitalize="none" spellcheck="false" value="${esc(a?.username || '')}" placeholder="ahmad" required></div>
        <div class="field"><label for="ag-pass">${a ? 'كلمة مرور جديدة' : 'كلمة المرور'}</label><input class="input ltr" id="ag-pass" name="password" autocomplete="new-password" placeholder="${a ? 'اتركها فارغة دون تغيير' : '6 أحرف على الأقل'}"></div>
      </div>
      <div class="row2 stack-xs">
        <div class="field"><label for="ag-phone">الهاتف</label><input class="input ltr" id="ag-phone" name="phone" inputmode="tel" value="${esc(a?.phone || '')}"></div>
        <div class="field"><label for="ag-credit">سقف الدين (₪)</label><input class="input ltr" id="ag-credit" name="creditLimit" type="number" min="0" step="1" inputmode="numeric" value="${a?.creditLimit ?? 0}">
          <span class="hint">يسمح بالتفعيل حتى لو نزل الرصيد تحت الصفر بهذا المبلغ.</span></div>
      </div>
      ${a ? '' : '<div class="field"><label for="ag-bal">الرصيد الافتتاحي (₪)</label><input class="input ltr" id="ag-bal" name="balance" type="number" step="0.01" inputmode="decimal" value="0"></div>'}
      <div class="field"><label for="ag-notes">ملاحظات</label><input class="input" id="ag-notes" name="notes" value="${esc(a?.notes || '')}"></div>
      ${a ? `<label class="switch-row"><span class="grow"><b>الحساب فعّال</b><small>أوقفه لمنع الوكيل من الدخول دون حذف بياناته</small></span><input class="switch" type="checkbox" name="active" ${a.active ? 'checked' : ''}></label>` : ''}`,
    submit: a ? 'حفظ' : 'إضافة الوكيل',
    async onSubmit(form) {
      const body = {
        name: field(form, 'name'), username: field(form, 'username'), phone: field(form, 'phone'),
        notes: field(form, 'notes'), creditLimit: field(form, 'creditLimit') || 0,
      };
      if (field(form, 'password')) body.password = field(form, 'password');
      if (a) {
        body.active = form.elements.active.checked;
        await api.put(`/api/agents/${a.id}`, body);
      } else {
        if (!body.password) throw new Error('اكتب كلمة مرور للوكيل');
        body.balance = field(form, 'balance');
        await api.post('/api/agents', body);
      }
      changed();
      onDone?.();
      return a ? 'تم الحفظ' : `تمت إضافة ${body.name}. أرسل له اسم المستخدم «${body.username}» وكلمة المرور.`;
    },
  });
}

// The manager's pricing systems, as in «الشركات والرزم».
const SYSTEMS = [['invoice', 'الفواتير'], ['card', 'كروت الشحن'], ['qlinvoice', 'خطوط QuickLine الجديدة'], ['qlcard', 'تمديد QuickLine']];

async function openPrices(a) {
  const [rows, markups] = await Promise.all([api.get(`/api/agents/${a.id}/prices`), api.get(`/api/agents/${a.id}/markups`)]);
  const used = new Set(rows.map((r) => r.system));
  const groups = new Map();
  rows.forEach((r) => { if (!groups.has(r.companyName)) groups.set(r.companyName, []); groups.get(r.companyName).push(r); });
  // What a package comes to for this agent without a price of its own: the agent's percentage on the cost, or its price.
  const base = (form, r) => {
    const m = form.querySelector(`[data-markup="${r.system}"]`)?.value;
    return m !== '' && m !== undefined && Number(r.cost) > 0 ? round(Number(r.cost) * (1 + Number(m) / 100)) : Number(r.defaultPrice);
  };
  sheet({
    title: `أسعار ${a.name}`,
    subtitle: 'السعر الذي يراه هذا الوكيل ويُخصم من رصيده. سعر الرزمة الخاص يغلب نسبة الربح، ونسبة الربح تغلب السعر العادي.',
    wide: true,
    body: `
      <div class="card card-pad" style="display:grid;gap:10px;box-shadow:none;background:var(--surface-2)">
        <b>نسبة ربحك من هذا الوكيل</b>
        <span class="hint">سعر الوكيل = التكلفة + النسبة، لكل نظام وحده، ويتبع التكلفة إذا تغيّرت. اتركها فارغة ليأخذ أسعار الرزم العادية.</span>
        <div class="row2 stack-xs">${SYSTEMS.filter(([k]) => used.has(k) || markups[k] !== null).map(([k, label]) => `<div class="field"><label for="mk-${k}">${label} (%)</label>
          <input class="input ltr" id="mk-${k}" data-markup="${k}" type="number" min="0" max="200" step="0.5" inputmode="decimal" placeholder="سعر الرزمة" value="${markups[k] ?? ''}"></div>`).join('')}</div></div>
      <div class="search-box">${icon('search', 'i lead')}<input class="input" id="pr-q" type="search" placeholder="ابحث باسم الرزمة أو الشركة…" aria-label="بحث في الرزم"></div>
      <div class="segmented" id="pr-sys"><button type="button" data-sys="" aria-pressed="true">الكل</button>${SYSTEMS.filter(([k]) => used.has(k)).map(([k, label]) => `<button type="button" data-sys="${k}" aria-pressed="false">${label}</button>`).join('')}</div>
      <div class="card card-pad" style="display:grid;gap:10px;box-shadow:none;background:var(--surface-2)">
        <b>تعديل سريع للرزم الظاهرة</b>
        <div class="input-group wrap"><input class="input ltr" id="pr-bulk" type="number" step="0.01" inputmode="decimal" placeholder="مثال: 5">
          <button type="button" class="btn" data-bulk="minus">خصم ₪ من سعره</button><button type="button" class="btn" data-bulk="clear">إزالة الأسعار الخاصة</button></div></div>
      ${[...groups.entries()].map(([name, list]) => `<details class="pr-group" data-group><summary><b>${esc(name)}</b> <span class="muted small" data-count>${list.length}</span></summary>${list.map((r) => `
        <div class="item-top" data-row data-system="${r.system}" data-name="${esc(`${r.name} ${name}`.toLowerCase())}" style="padding:10px 0;border-bottom:1px solid var(--line)">
          <div class="grow"><b>${esc(r.name)}</b>${r.active ? '' : ' <span class="pill">موقوفة</span>'}<div class="item-sub"><span data-base="${r.packageId}"></span><span>التكلفة ${fmtMoney(r.cost)}</span><span data-margin="${r.packageId}"></span></div></div>
          <input class="input ltr" style="width:120px" type="number" min="0" step="0.01" inputmode="decimal" data-pkg="${r.packageId}" value="${r.customPrice ?? ''}" aria-label="سعر خاص">
        </div>`).join('')}</details>`).join('') || empty('box', 'لا توجد رزم', 'أضف الرزم من «الشركات والرزم».')}`,
    submit: 'حفظ الأسعار',
    onMount(form) {
      const byId = new Map(rows.map((r) => [String(r.packageId), r]));
      // Search and the system filter show only matching packages; a search opens the companies it finds.
      let sys = '';
      const filter = () => {
        const term = form.querySelector('#pr-q').value.trim().toLowerCase();
        form.querySelectorAll('[data-group]').forEach((g) => {
          let shown = 0;
          g.querySelectorAll('[data-row]').forEach((row) => {
            const on = (!sys || row.dataset.system === sys) && (!term || row.dataset.name.includes(term));
            row.hidden = !on;
            if (on) shown++;
          });
          g.hidden = !shown;
          g.querySelector('[data-count]').textContent = shown;
          if (term) g.open = true;
        });
      };
      form.querySelector('#pr-q').addEventListener('input', filter);
      form.querySelectorAll('#pr-sys [data-sys]').forEach((b) => b.addEventListener('click', () => {
        sys = b.dataset.sys;
        form.querySelectorAll('#pr-sys [data-sys]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        filter();
      }));
      // With few companies, show them open.
      if (groups.size <= 2) form.querySelectorAll('[data-group]').forEach((g) => { g.open = true; });
      form.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', () => {
        const v = Number(form.querySelector('#pr-bulk').value) || 0;
        // Only the packages on screen (after search and filter).
        form.querySelectorAll('[data-row]:not([hidden]) input[data-pkg]').forEach((i) => {
          i.value = b.dataset.bulk === 'clear' ? '' : Math.max(0, round(base(form, byId.get(i.dataset.pkg)) - v));
        });
        form.dispatchEvent(new Event('input'));
      }));
      form.dispatchEvent(new Event('input'));
    },
    onInput(form) {
      for (const r of rows) {
        const i = form.querySelector(`input[data-pkg="${r.packageId}"]`);
        const b = base(form, r);
        i.placeholder = String(b);
        const price = i.value === '' ? b : Number(i.value);
        const m = round(price - Number(r.cost));
        form.querySelector(`[data-base="${r.packageId}"]`).textContent = i.value === '' ? `يدفع ${fmtMoney(b)}` : `سعر خاص · بدونه ${fmtMoney(b)}`;
        const box = form.querySelector(`[data-margin="${r.packageId}"]`);
        box.innerHTML = `ربحك ${fmtMoney(m)}`;
        box.className = m < 0 ? 'minus' : '';
      }
    },
    async onSubmit(form) {
      const marks = Object.fromEntries([...form.querySelectorAll('[data-markup]')].map((i) => [i.dataset.markup, i.value === '' ? null : i.value]));
      await api.put(`/api/agents/${a.id}/markups`, marks);
      const prices = [...form.querySelectorAll('input[data-pkg]')].map((i) => ({ packageId: Number(i.dataset.pkg), price: i.value === '' ? null : i.value }));
      await api.put(`/api/agents/${a.id}/prices`, { prices });
      changed();
      return `تم حفظ أسعار ${a.name}`;
    },
  });
}

function agentCard(a) {
  const used = a.creditLimit > 0 ? Math.min(100, Math.round((Math.max(0, -a.balance) / a.creditLimit) * 100)) : 0;
  return `<article class="item agent-card">
    <div class="item-top"><span class="avatar" style="background:linear-gradient(140deg,hsl(${hue(a.username)} 70% 58%),hsl(${hue(a.username)} 70% 40%));box-shadow:none">${esc(initials(a.name))}</span>
      <div class="grow"><b class="item-title">${esc(a.name)}</b><div class="item-sub"><span class="ltr">@${esc(a.username)}</span>${a.phone ? `<span class="ltr">${esc(a.phone)}</span>` : ''}</div></div>
      ${a.active ? '' : '<span class="pill s-expired">موقوف</span>'}
      <button class="icon-btn plain" data-action="more" data-id="${a.id}" aria-label="خيارات أخرى">${icon('more')}</button></div>
    <div class="item-top" style="justify-content:space-between;align-items:flex-end">
      <div><span class="small muted">الرصيد</span><div class="money ${a.balance < 0 ? 'minus' : ''}">${fmtMoney(a.balance)}</div></div>
      <div style="text-align:end"><span class="small muted">المتاح</span><div><b class="ltr">${fmtMoney(a.available)}</b></div></div></div>
    ${a.creditLimit > 0 ? `<div class="line-meter"><div class="meter ${used >= 80 ? 'warn' : 'primary'}"><i style="width:${used}%"></i></div>
      <div class="row"><span>سقف الدين ${fmtMoney(a.creditLimit)}</span><span>مستخدم ${used}%</span></div></div>` : ''}
    <div class="item-sub"><span>${a.lineCount ? arCount(a.lineCount, ['رقم واحد', 'رقمان', 'أرقام', 'رقماً']) : 'لا أرقام'}</span><span>${a.simCount ? `${simsText(a.simCount)} متاحة` : 'لا شرائح'}</span><span>${a.lastSaleAt ? `آخر بيع ${relTime(a.lastSaleAt)}` : 'لا مبيعات بعد'}</span></div>
    <div class="item-actions">
      <button class="btn btn-sm btn-primary" data-action="balance" data-id="${a.id}">${icon('wallet')}الرصيد</button>
      <button class="btn btn-sm" data-action="prices" data-id="${a.id}">${icon('tag')}الأسعار</button>
      <button class="btn btn-sm" data-action="edit" data-id="${a.id}">${icon('edit')}تعديل</button>
    </div></article>`;
}

function filtered() {
  const q = V.q.trim().toLowerCase();
  return V.agents.filter((a) => !q || a.name.toLowerCase().includes(q) || a.username.toLowerCase().includes(q) || (a.phone || '').includes(q));
}

const listHtml = () => {
  const list = filtered();
  return list.length ? `<div class="grid-cards">${list.map(agentCard).join('')}</div>`
    : empty('users', V.agents.length ? 'لا نتائج' : 'لا يوجد وكلاء بعد', V.agents.length ? '' : 'أضف وكيلاً وأعطه اسم مستخدم وكلمة مرور.', V.agents.length ? '' : `<button class="btn btn-primary" data-action="add">${icon('userPlus')}إضافة وكيل</button>`);
};

export default {
  admin: true,
  title: () => ({ title: 'الوكلاء', subtitle: 'الحسابات والأرصدة والأسعار الخاصة' }),
  async load(ctx) {
    if (ctx.query.q !== undefined) V.q = ctx.query.q;
    V.agents = await api.get('/api/agents');
  },
  render() {
    const total = V.agents.reduce((s, a) => s + a.balance, 0);
    return `
      <div class="kpis"><div class="kpi"><span>عدد الوكلاء</span><b>${V.agents.length}</b></div><div class="kpi"><span>فعّالون</span><b>${V.agents.filter((a) => a.active).length}</b></div>
        <div class="kpi"><span>مجموع الأرصدة</span><b>${money(total)}</b></div><div class="kpi"><span>مدينون</span><b>${V.agents.filter((a) => a.balance < 0).length}</b></div></div>
      <div class="toolbar">
        <div class="search-box">${icon('search', 'i lead')}<input class="input" id="ag-q" type="search" placeholder="الاسم، اسم المستخدم أو الهاتف" value="${esc(V.q)}"></div>
        <button class="btn" data-action="transfer">${icon('swap')}<span class="hide-xs">نقل رصيد</span></button>
        <button class="btn btn-primary" data-action="add">${icon('userPlus')}إضافة وكيل</button>
      </div>
      <div id="ag-list">${listHtml()}</div>`;
  },
  mount(root) {
    root.querySelector('#ag-q').addEventListener('input', debounce((e) => { V.q = e.target.value; root.querySelector('#ag-list').innerHTML = listHtml(); }, 100));
  },
  actions: {
    add: () => openAgentForm(null),
    transfer: () => openTransfer(),
    balance: (btn) => openAgentBalance(Number(btn.dataset.id)),
    prices: (btn) => openPrices(V.agents.find((a) => a.id === Number(btn.dataset.id))),
    edit: (btn) => openAgentForm(V.agents.find((a) => a.id === Number(btn.dataset.id))),
    more(btn) {
      const a = V.agents.find((x) => x.id === Number(btn.dataset.id));
      sheet({
        title: a.name,
        body: `<div class="action-list">
          <button type="button" data-m="lines"><span class="tile sm">${icon('phone')}</span>أرقام الوكيل</button>
          <button type="button" data-m="statement"><span class="tile sm green">${icon('chart')}</span>كشف حساب الوكيل</button>
          <button type="button" data-m="sims"><span class="tile sm amber">${icon('sim')}</span>مخزون شرائحه</button>
          <button type="button" data-m="delete" class="danger"><span class="tile sm">${icon('trash')}</span>حذف الوكيل</button></div>`,
        onMount(form, el) {
          el.querySelector('[data-m="lines"]').addEventListener('click', () => go(`#/subscribers?agent=${a.id}&state=`));
          el.querySelector('[data-m="statement"]').addEventListener('click', () => go(`#/reports?r=statement&agent=${a.id}`));
          el.querySelector('[data-m="sims"]').addEventListener('click', () => go(`#/sims?agent=${a.id}`));
          el.querySelector('[data-m="delete"]').addEventListener('click', () => sheet({
            title: `حذف ${a.name}`,
            body: `${a.lineCount ? `<div class="msg">${icon('alert')}<span>لدى الوكيل ${a.lineCount} رقم. انقلها أولاً، أو أوقف الحساب من «تعديل».</span></div>` : ''}<p>يُحذف الوكيل نهائياً وتعود شرائحه المتاحة إلى مخزن المدير. رصيده الحالي ${fmtMoney(a.balance)}.</p>`,
            submit: 'حذف الوكيل', danger: true,
            async onSubmit() { await api.del(`/api/agents/${a.id}`); changed(); return 'تم حذف الوكيل'; },
          }));
        },
      });
    },
  },
};

