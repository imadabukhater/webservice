import {
  S, api, esc, icon, isAdmin, money, fmtMoney, fmtDate, fmtDateTime, fmtISO, phone, fmtPhone, statePill, sheet, field, changed,
  loadCatalog, companyLogo, companyById, daysText, monthsText, digits, empty, fmtIccid, copyText, OP, OP_ICON, relTime, signedMoney,
  skeleton, debounce, toast, closeAllSheets,
} from '../core.js';
import { openRenew } from './renew.js';
import { simFieldHtml, bindSimField } from '../simfield.js';

const V = { lines: [], agents: [], q: '', state: '', agentId: '', shown: 60 };

const FILTERS = [
  ['', 'الكل'], ['active', 'فعّال'], ['expiring', 'ينتهي قريباً'], ['expired', 'منتهي'], ['frozen', 'مجمّد'], ['pending', 'قيد التنفيذ'], ['disconnected', 'مفصول'],
];

const matchesState = (l, s) => {
  if (!s) return l.status !== 'disconnected';
  if (s === 'active') return l.state === 'active' || l.state === 'expiring';
  return l.state === s;
};

function whenText(l) {
  if (l.status === 'pending') return l.port ? 'تحويل الرقم بانتظار تنفيذ المدير' : 'eSIM بانتظار تنفيذ المدير';
  if (l.status === 'disconnected') return `فُصل في ${fmtDate(l.updatedAt)}`;
  if (!l.expiresAt) return 'بدون تاريخ انتهاء';
  return l.daysLeft >= 0 ? `متبقٍ ${daysText(l.daysLeft)}` : `انتهى منذ ${daysText(-l.daysLeft)}`;
}

export function lineCard(l) {
  const span = Math.max(1, (l.months || 1) * 30);
  const pct = l.daysLeft === null ? 100 : Math.max(0, Math.min(100, Math.round((l.daysLeft / span) * 100)));
  const meter = l.state === 'expired' ? 'bad' : l.state === 'expiring' ? 'warn' : l.state === 'frozen' ? 'primary' : '';
  const renewable = ['active', 'frozen'].includes(l.status);
  return `<article class="item clickable" data-action="open-line" data-id="${l.id}">
    <div class="item-top">${companyLogo(companyById(l.companyId) || (l.companyName ? { name: l.companyName, color: l.companyColor } : null), 'xs')}
      <div class="grow">${phone(l.number)}<div class="item-sub"><span>${esc(l.customerName || 'بدون اسم')}</span><span>${esc(l.packageLabel)}</span>${isAdmin() ? `<span>${esc(l.agentName)}</span>` : ''}${l.esim ? '<span>eSIM</span>' : ''}${l.kind === 'external' ? '<span>خارجي</span>' : ''}</div></div>
      ${statePill(l.state)}</div>
    ${l.status !== 'disconnected' && l.status !== 'pending'
      ? `<div class="line-meter"><div class="meter ${meter}"><i style="width:${pct}%"></i></div>
          <div class="row"><span>${whenText(l)}</span><span>${l.expiresAt ? `حتى <span class="ltr">${fmtDate(l.expiresAt)}</span>` : ''}</span></div></div>`
      : `<div class="small muted">${whenText(l)}</div>`}
    ${renewable ? `<div class="item-actions"><button class="btn btn-soft btn-sm" data-action="line-renew" data-id="${l.id}">${icon('repeat')}تمديد</button>
      ${l.status === 'active' ? `<button class="btn btn-sm" data-action="line-act" data-act="freeze" data-id="${l.id}">${icon('snow')}تجميد</button>` : `<button class="btn btn-sm" data-action="line-act" data-act="unfreeze" data-id="${l.id}">${icon('play')}إلغاء التجميد</button>`}
      <button class="btn btn-sm" data-action="line-act" data-act="swap" data-id="${l.id}">${icon('sim')}تبديل الشريحة</button></div>` : ''}
  </article>`;
}

// ---------- line actions (sheets) ----------
// After any change the details sheet underneath is stale, so the whole stack closes and the page reloads.
async function finish(message) {
  await closeAllSheets();
  changed();
  return message;
}

async function act(line, action, extra = {}) {
  await api.post(`/api/lines/${line.id}/action`, { action, ...extra });
}

export async function lineAction(line, name) {
  switch (name) {
    case 'renew': return openRenew(line);
    case 'freeze':
      return sheet({
        title: `تجميد ${fmtPhone(line.number)}`, subtitle: 'يتوقف الخط مؤقتاً ويمكن إعادته في أي وقت',
        body: `<div class="field"><label for="fr-reason">السبب <span class="opt">(اختياري)</span></label><input class="input" id="fr-reason" name="reason" placeholder="مثال: الزبون مسافر"></div>`,
        submit: 'تجميد الرقم',
        async onSubmit(form) { await act(line, 'freeze', { reason: field(form, 'reason') }); return finish('تم تجميد الرقم'); },
      });
    case 'unfreeze':
      return sheet({
        title: `إلغاء تجميد ${fmtPhone(line.number)}`, body: '<p>سيعود الخط فعّالاً.</p>', submit: 'إلغاء التجميد',
        async onSubmit() { await act(line, 'unfreeze'); return finish('عاد الرقم فعّالاً'); },
      });
    case 'swap': {
      const stock = (await api.get(isAdmin() ? `/api/sims?status=available&forAgent=${line.agentId}` : '/api/sims?status=available'))
        .filter((s) => !s.companyId || s.companyId === line.companyId);
      let sim = { valid: false };
      return sheet({
        title: `تبديل شريحة ${fmtPhone(line.number)}`,
        subtitle: line.sim ? `الشريحة الحالية: <span class="ltr mono">${fmtIccid(line.sim)}</span>` : 'الرقم بدون شريحة مسجّلة',
        body: `${simFieldHtml({ id: 'swap-sim', label: 'رقم الشريحة الجديدة', stock })}
          <div class="field"><label for="sw-reason">السبب <span class="opt">(اختياري)</span></label><input class="input" id="sw-reason" name="reason" placeholder="مثال: شريحة تالفة"></div>`,
        submit: 'تبديل الشريحة',
        onMount(form) { bindSimField(form, { id: 'swap-sim', companyId: line.companyId, stock, onChange: (s) => { sim = s; } }); },
        async onSubmit(form) {
          if (!sim.valid) throw new Error('أدخل رقم شريحة صالحاً');
          await act(line, 'swap_sim', { ...(sim.simId ? { simId: sim.simId } : { sim: sim.iccid }), reason: field(form, 'reason') });
          return finish('تم تبديل الشريحة');
        },
      });
    }
    case 'disconnect':
      return sheet({
        title: `فصل ${fmtPhone(line.number)}`,
        body: `<div class="msg">${icon('alert')}<span>الفصل نهائي: لا يمكن إعادة الخط من التطبيق، ويصبح الرقم متاحاً للتفعيل من جديد.</span></div>
          <div class="field"><label for="dc-reason">السبب <span class="opt">(اختياري)</span></label><input class="input" id="dc-reason" name="reason"></div>`,
        submit: 'فصل الرقم', danger: true,
        async onSubmit(form) { await act(line, 'disconnect', { reason: field(form, 'reason') }); return finish('تم فصل الرقم'); },
      });
    case 'edit':
      return sheet({
        title: 'بيانات الزبون',
        body: `<div class="field"><label for="ed-name">اسم الزبون</label><input class="input" id="ed-name" name="customerName" value="${esc(line.customerName)}"></div>
          <div class="field"><label for="ed-price">سعر الزبون (₪) <span class="opt">(ما يدفعه لك)</span></label><input class="input ltr" id="ed-price" name="customerPrice" type="number" min="0" step="0.01" inputmode="decimal" value="${line.customerPrice ?? ''}"></div>
          <div class="field"><label for="ed-note">ملاحظة</label><input class="input" id="ed-note" name="note" value="${esc(line.note)}"></div>
          ${isAdmin() ? `<div class="field"><label for="ed-exp">تاريخ نهاية الرزمة <span class="opt">(تصحيح يدوي)</span></label><input class="input" id="ed-exp" name="expiresAt" type="date" value="${fmtISO(line.expiresAt)}"></div>` : ''}`,
        async onSubmit(form) {
          const body = { customerName: field(form, 'customerName'), customerPrice: field(form, 'customerPrice'), note: field(form, 'note') };
          if (isAdmin()) body.expiresAt = field(form, 'expiresAt') ? new Date(`${field(form, 'expiresAt')}T23:59:00`).getTime() : null;
          await api.put(`/api/lines/${line.id}`, body);
          return finish('تم الحفظ');
        },
      });
    case 'move': {
      const agents = (await api.get('/api/agents')).filter((a) => a.id !== line.agentId && a.active);
      return sheet({
        title: `نقل ${fmtPhone(line.number)}`, subtitle: `من ${esc(line.agentName)}`,
        body: `<div class="field"><label for="mv-to">إلى الوكيل</label><select class="input" id="mv-to" name="to"><option value="">اختر الوكيل</option>
            ${agents.map((a) => `<option value="${a.id}">${esc(a.name)} — ${fmtMoney(a.available)}</option>`).join('')}</select></div>
          <label class="switch-row"><span class="grow"><b>نقل قيمة الخط (${fmtMoney(line.price)})</b><small>تُرجع للوكيل الحالي وتُخصم من الوكيل الجديد</small></span><input class="switch" type="checkbox" name="withMoney"></label>`,
        submit: 'نقل الرقم',
        async onSubmit(form) {
          if (!field(form, 'to')) throw new Error('اختر الوكيل');
          await api.post(`/api/lines/${line.id}/move`, { toAgentId: Number(field(form, 'to')), withMoney: form.elements.withMoney.checked });
          return finish('تم نقل الرقم');
        },
      });
    }
    case 'delete':
      return sheet({
        title: `حذف ${fmtPhone(line.number)}`,
        body: `<p class="muted">الحذف لتصحيح خطأ في الإدخال فقط. لإيقاف خط حقيقي استعمل «فصل الرقم». الشريحة تعود إلى المخزون إن كانت منه.</p>
          <label class="switch-row"><span class="grow"><b>إرجاع ${fmtMoney(line.price)} إلى رصيد ${esc(line.agentName)}</b></span><input class="switch" type="checkbox" name="refund"></label>`,
        submit: 'حذف الخط', danger: true,
        async onSubmit(form) {
          await api.del(`/api/lines/${line.id}${form.elements.refund.checked ? '?refund=1' : ''}`);
          return finish('تم حذف الخط');
        },
      });
    case 'share': {
      const text = `${S.settings.appName}\nالرقم: ${fmtPhone(line.number)}\nالرزمة: ${line.packageLabel}${line.expiresAt ? `\nصالحة حتى: ${fmtDate(line.expiresAt)}` : ''}${line.esimCode ? `\nرمز eSIM: ${line.esimCode}` : ''}`;
      if (navigator.share) { try { await navigator.share({ text }); return; } catch { /* cancelled */ } }
      return sheet({
        title: 'مشاركة تفاصيل الخط',
        body: `<pre class="input" style="white-space:pre-wrap;min-height:auto">${esc(text)}</pre>`,
        footer: `<a class="btn btn-good" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">${icon('msg')}واتساب</a><button class="btn" type="button" data-copy>${icon('copy')}نسخ</button>`,
        onMount(form, el) { el.querySelector('[data-copy]').addEventListener('click', () => copyText(text)); },
      });
    }
    default: return undefined;
  }
}

// ---------- line details ----------
export async function openLine(id) {
  const { line: l, history } = await api.get(`/api/lines/${id}`);
  const admin = isAdmin();
  const co = companyById(l.companyId) || (l.companyName ? { name: l.companyName, color: l.companyColor } : null);
  const actions = [];
  const add = (key, label, ic, color = '', danger = false) => actions.push(`<button type="button" data-line-act="${key}" class="${danger ? 'danger' : ''}"><span class="tile sm ${color}">${icon(ic)}</span>${label}</button>`);
  if (['active', 'frozen'].includes(l.status)) add('renew', 'تمديد الرزمة', 'repeat', 'green');
  if (l.status === 'active') add('freeze', 'تجميد الرقم', 'snow', 'violet');
  if (l.status === 'frozen') add('unfreeze', 'إلغاء التجميد', 'play', 'green');
  if (['active', 'frozen'].includes(l.status)) add('swap', 'تبديل الشريحة', 'sim', 'amber');
  add('edit', 'بيانات الزبون والملاحظات', 'edit');
  if (l.status !== 'disconnected') add('share', 'مشاركة التفاصيل مع الزبون', 'share', 'cyan');
  if (admin && l.status !== 'disconnected') add('move', 'نقل لوكيل آخر', 'swap', 'amber');
  if (['active', 'frozen'].includes(l.status)) add('disconnect', 'فصل الرقم', 'power', 'red', true);
  if (admin) add('delete', 'حذف الخط (تصحيح خطأ)', 'trash', 'red', true);

  const kv = [
    ['اسم الزبون', esc(l.customerName || '—')],
    ['الرزمة', esc(l.packageLabel)],
    ['الشريحة', l.esim ? 'eSIM' : l.sim ? `<span class="mono ltr">${fmtIccid(l.sim)}</span>` : '—'],
    ['تاريخ التفعيل', fmtDate(l.activatedAt)],
    ['تنتهي في', l.expiresAt ? `${fmtDate(l.expiresAt)} <span class="muted small">(${whenText(l)})</span>` : '—'],
    ['آخر مدة', monthsText(l.months)],
    ['المبلغ المدفوع', money(l.price)],
    ['سعر الزبون', l.customerPrice !== null ? money(l.customerPrice) : '—'],
    ...(admin ? [['الوكيل', esc(l.agentName)], ['التكلفة', money(l.cost)]] : []),
    ...(l.note ? [['ملاحظة', esc(l.note)]] : []),
  ];

  sheet({
    title: fmtPhone(l.number),
    subtitle: `${statePill(l.state)} ${l.kind === 'external' ? '<span class="pill plain">رقم خارجي</span>' : ''} ${l.port ? '<span class="pill plain">تحويل رقم</span>' : ''}`,
    wide: true,
    body: `
      <div class="summary-pkg">${companyLogo(co, 'sm')}<div class="grow"><b>${esc(l.packageLabel)}</b><small>${esc(co?.name || '')}</small></div></div>
      ${l.esim && (l.esimQr || l.esimCode) ? `<div class="card card-pad" style="display:grid;gap:10px;justify-items:center;text-align:center">
          <b>رمز تفعيل eSIM</b>${l.esimQr ? `<img class="qr" src="${esc(l.esimQr)}" alt="رمز QR لتفعيل eSIM">` : ''}
          ${l.esimCode ? `<code class="mono ltr small" style="overflow-wrap:anywhere">${esc(l.esimCode)}</code><button type="button" class="btn btn-sm" data-copy-code>${icon('copy')}نسخ الرمز</button>` : ''}
          <span class="small muted">اعرض الرمز على الزبون ليمسحه من إعدادات هاتفه: الشبكة الخلوية ← إضافة eSIM.</span></div>` : ''}
      <div class="kv">${kv.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('')}</div>
      <div class="action-list">${actions.join('')}</div>
      <h3>سجل الرقم</h3>
      ${history.length ? `<div>${history.map((o) => {
        const [ic, color] = OP_ICON[o.type] || ['info', ''];
        return `<div class="op-row"><span class="tile sm ${color === 'blue' ? '' : color}">${icon(ic)}</span><div class="grow"><b>${OP[o.type] || o.type}</b>
          <div class="item-sub"><span>${esc(o.detail || o.package || '')}</span><span>${fmtDateTime(o.ts)}</span>${o.actorName ? `<span>${esc(o.actorName)}</span>` : ''}</div></div>
          ${o.amount ? signedMoney(o.amount) : ''}</div>`;
      }).join('')}</div>` : '<p class="muted small">لا يوجد سجل.</p>'}`,
    onMount(form) {
      form.querySelectorAll('[data-line-act]').forEach((b) => b.addEventListener('click', () => lineAction(l, b.dataset.lineAct).catch((e) => alertError(e))));
      form.querySelector('[data-copy-code]')?.addEventListener('click', () => copyText(l.esimCode));
    },
  });
}

const alertError = (e) => toast(e.message, { error: true });

// ---------- list view ----------
function filtered() {
  const q = V.q.trim();
  const d = digits(q);
  let list = V.lines.filter((l) => matchesState(l, V.state) && (!q || (d.length >= 2 && (l.number.includes(d) || l.sim.includes(d))) || (l.customerName || '').includes(q) || (l.packageLabel || '').includes(q)));
  if (V.state === 'expiring' || V.state === 'expired') list = [...list].sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0));
  return list;
}

function listHtml() {
  const list = filtered();
  if (!list.length) {
    return V.lines.length ? empty('search', 'لا توجد أرقام بهذا الفلتر', 'غيّر الفلتر أو كلمة البحث.')
      : empty('phone', 'لا يوجد مشتركون بعد', 'فعّل أول خط وسيظهر هنا مع تاريخ انتهاء رزمته.', `<a class="btn btn-primary" href="#/new">${icon('userPlus')}مشترك جديد</a>`);
  }
  return `<div class="grid-cards">${list.slice(0, V.shown).map(lineCard).join('')}</div>
    ${list.length > V.shown ? `<button class="btn btn-block" data-action="more">عرض المزيد (${list.length - V.shown})</button>` : ''}`;
}

function chipsHtml() {
  const count = (s) => V.lines.filter((l) => matchesState(l, s)).length;
  return FILTERS.map(([k, label]) => `<button class="chip" data-action="state" data-state="${k}" aria-pressed="${V.state === k}">${label}<span class="n">${count(k)}</span></button>`).join('');
}

export default {
  title: () => ({ title: isAdmin() ? 'كل المشتركين' : 'المشتركون', subtitle: 'الأرقام المفعّلة وحالة رزمها' }),
  skeleton: () => skeleton(4, 120),
  async load(ctx) {
    if (ctx.query.state !== undefined) V.state = ctx.query.state;
    if (ctx.query.q !== undefined) V.q = ctx.query.q;
    if (ctx.query.agent !== undefined) V.agentId = ctx.query.agent;
    const [lines, agents] = await Promise.all([
      api.get(`/api/lines${isAdmin() && V.agentId ? `?agentId=${V.agentId}` : ''}`),
      isAdmin() ? api.get('/api/agents') : [],
      loadCatalog(),
    ]);
    V.lines = lines;
    V.agents = agents;
  },
  render() {
    return `
      <div class="toolbar">
        <div class="search-box">${icon('search', 'i lead')}<input class="input" id="sub-q" type="search" placeholder="رقم، اسم زبون، شريحة أو رزمة" value="${esc(V.q)}" autocomplete="off"></div>
        ${isAdmin() ? `<select class="input" id="sub-agent" style="width:auto;min-width:180px"><option value="">كل الوكلاء</option>${V.agents.map((a) => `<option value="${a.id}" ${String(a.id) === String(V.agentId) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}
        <a class="btn btn-primary" href="#/new">${icon('userPlus')}<span class="hide-xs">مشترك جديد</span></a>
      </div>
      <div class="chips" id="sub-chips">${chipsHtml()}</div>
      <div id="sub-list">${listHtml()}</div>`;
  },
  mount(root, ctx) {
    root.querySelector('#sub-q').addEventListener('input', debounce((e) => {
      V.q = e.target.value;
      V.shown = 60;
      root.querySelector('#sub-list').innerHTML = listHtml();
    }, 120));
    root.querySelector('#sub-agent')?.addEventListener('change', (e) => { V.agentId = e.target.value; ctx.reload(); });
  },
  actions: {
    state(btn, e, ctx) {
      V.state = btn.dataset.state;
      V.shown = 60;
      document.getElementById('sub-chips').innerHTML = chipsHtml();
      document.getElementById('sub-list').innerHTML = listHtml();
    },
    more(btn, e, ctx) { V.shown += 60; document.getElementById('sub-list').innerHTML = listHtml(); },
    'open-line': (btn) => openLine(Number(btn.dataset.id)),
    'line-renew': (btn) => openRenew(V.lines.find((l) => l.id === Number(btn.dataset.id))),
    'line-act': (btn) => lineAction(V.lines.find((l) => l.id === Number(btn.dataset.id)), btn.dataset.act),
  },
};

