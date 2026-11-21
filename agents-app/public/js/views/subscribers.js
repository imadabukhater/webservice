import {
  S, api, esc, icon, isAdmin, money, fmtMoney, fmtDate, fmtDateTime, fmtISO, phone, fmtPhone, statePill, sheet, field, changed,
  loadCatalog, companyLogo, companyById, daysText, monthsText, digits, empty, fmtIccid, copyText, OP, OP_ICON, relTime, signedMoney,
  skeleton, debounce, toast, closeAllSheets,
} from '../core.js';
import { openRenew } from './renew.js';
import { simFieldHtml, bindSimField } from '../simfield.js';

const V = { lines: [], agents: [], q: '', state: '', agentId: '', shown: 60, view: 'ours', sup: null, supQ: '', supKey: '', supState: 'active', supShown: 80 };

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
      <div class="grow">${phone(l.number)}<div class="item-sub"><span>${esc(l.customerName || 'بدون اسم')}</span><span>${esc(l.packageLabel)}</span>${isAdmin() ? `<span>${esc(l.agentName)}</span>` : ''}${l.esim ? '<span>eSIM</span>' : ''}${l.kind === 'external' ? '<span>دفع مسبق</span>' : ''}</div></div>
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
      let sim = { valid: false };
      return sheet({
        title: `تبديل شريحة ${fmtPhone(line.number)}`,
        subtitle: line.sim ? `الشريحة الحالية: <span class="ltr mono">${fmtIccid(line.sim)}</span>` : 'الرقم بدون شريحة مسجّلة',
        body: `${simFieldHtml({ id: 'swap-sim', label: 'رقم الشريحة الجديدة — امسحه بالكاميرا أو اكتبه' })}
          <div class="field"><label for="sw-reason">السبب <span class="opt">(اختياري)</span></label><input class="input" id="sw-reason" name="reason" placeholder="مثال: شريحة تالفة"></div>`,
        submit: 'تبديل الشريحة',
        onMount(form) { bindSimField(form, { id: 'swap-sim', companyId: line.companyId, onChange: (s) => { sim = s; } }); },
        async onSubmit(form) {
          if (!sim.valid) throw new Error('أدخل رقم شريحة صالحاً');
          await act(line, 'swap_sim', { sim: sim.iccid, reason: field(form, 'reason') });
          return finish('تم تبديل الشريحة');
        },
      });
    }
    case 'disconnect':
      return sheet({
        title: `فصل نهائي ${fmtPhone(line.number)}`,
        body: `<div class="msg">${icon('alert')}<span>الفصل نهائي: لا يمكن إعادة الخط من التطبيق، ويصبح الرقم متاحاً للتفعيل من جديد. خطوط QuickLine تُفصل هناك نهائياً أيضاً.</span></div>
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
    case 'correct': {
      await loadCatalog();
      const pkgs = S.catalog.packages.filter((p) => p.active || p.id === line.packageId);
      return sheet({
        title: `تعديل ${fmtPhone(line.number)}`, subtitle: `خط ${esc(line.agentName)}`,
        body: `<div class="field"><label for="cr-number">رقم الهاتف</label><input class="input ltr" id="cr-number" name="number" inputmode="tel" value="${esc(fmtPhone(line.number))}"></div>
          <div class="field"><label for="cr-pkg">الرزمة</label><select class="input" id="cr-pkg" name="packageId">
            ${pkgs.map((p) => `<option value="${p.id}" ${p.id === line.packageId ? 'selected' : ''}>${esc(`${p.companyName} ${p.name} — ${{ ql: 'QuickLine', art: 'art-topup', ly: 'ليان', tc: 'telecom' }[p.supplier] || 'يدوي'}`)}</option>`).join('')}</select>
            <span class="hint">جهة التفعيل تتبع الرزمة: لتغييرها اختر رزمة الجهة المطلوبة.</span></div>
          <div class="field"><label for="cr-price">السعر المخصوم من الوكيل (₪)</label><input class="input ltr" id="cr-price" name="price" type="number" min="0" step="0.01" inputmode="decimal" value="${line.price}">
            <div class="hint" id="cr-diff"></div></div>
          <div class="field"><label for="cr-reason">السبب <span class="opt">(اختياري — يظهر في السجل)</span></label><input class="input" id="cr-reason" name="reason"></div>`,
        submit: 'حفظ التعديل',
        onInput(form) {
          const diff = Math.round((Number(field(form, 'price')) - line.price) * 100) / 100;
          const box = form.querySelector('#cr-diff');
          box.className = `hint ${diff > 0 ? 'warn' : diff < 0 ? 'ok' : ''}`;
          box.innerHTML = diff > 0 ? `${icon('alert')}<span>يُخصم ${fmtMoney(diff)} إضافية من رصيد ${esc(line.agentName)}</span>`
            : diff < 0 ? `${icon('checkCircle')}<span>يُرجع ${fmtMoney(-diff)} إلى رصيد ${esc(line.agentName)}</span>` : '';
        },
        async onSubmit(form) {
          await api.post(`/api/lines/${line.id}/correct`, {
            number: digits(field(form, 'number')), packageId: Number(field(form, 'packageId')), price: field(form, 'price'), reason: field(form, 'reason'),
          });
          return finish('تم تعديل الخط');
        },
      });
    }
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
  if (l.status === 'active') add('freeze', 'تجميد الرقم (فصل مؤقت)', 'snow', 'violet');
  if (l.status === 'frozen') add('unfreeze', 'إلغاء التجميد', 'play', 'green');
  if (['active', 'frozen'].includes(l.status)) add('swap', 'تبديل الشريحة', 'sim', 'amber');
  add('edit', 'بيانات الزبون والملاحظات', 'edit');
  if (l.status !== 'disconnected') add('share', 'مشاركة التفاصيل مع الزبون', 'share', 'cyan');
  if (admin && l.status !== 'disconnected') add('correct', 'تعديل الرقم والرزمة والسعر', 'edit', 'amber');
  if (admin && l.status !== 'disconnected') add('move', 'نقل لوكيل آخر', 'swap', 'amber');
  // A final disconnect is the manager's; agents freeze (a temporary disconnect).
  if (['active', 'frozen'].includes(l.status) && admin) add('disconnect', 'فصل نهائي', 'power', 'red', true);
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
    ...(admin ? [['الوكيل', esc(l.agentName)], ['التكلفة', money(l.cost)],
      // Who activates the line: the manager's only (the server never sends it to agents).
      ['جهة التفعيل', `${esc(l.source || 'يدوي')}${l.status !== 'disconnected' ? ` <button type="button" class="btn btn-sm btn-ghost" data-line-act="correct">${icon('edit')}تغيير</button>` : ''}`]] : []),
    ...(l.note ? [['ملاحظة', esc(l.note)]] : []),
  ];

  sheet({
    title: fmtPhone(l.number),
    subtitle: `${statePill(l.state)} ${l.kind === 'external' ? '<span class="pill plain">دفع مسبق</span>' : ''} ${l.port ? '<span class="pill plain">تحويل رقم</span>' : ''} ${l.direct ? '<span class="pill plain">تفعيل مباشر</span>' : ''}`,
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
      : empty('phone', 'لا يوجد مشتركون بعد', 'فعّل أول خط وسيظهر هنا مع تاريخ انتهاء رزمته.', `<a class="btn btn-primary" href="#/new">${icon('userPlus')}اشتراك فاتورة جديدة</a>`);
  }
  return `<div class="grid-cards">${list.slice(0, V.shown).map(lineCard).join('')}</div>
    ${list.length > V.shown ? `<button class="btn btn-block" data-action="more">عرض المزيد (${list.length - V.shown})</button>` : ''}`;
}

function chipsHtml() {
  const count = (s) => V.lines.filter((l) => matchesState(l, s)).length;
  return FILTERS.map(([k, label]) => `<button class="chip" data-action="state" data-state="${k}" aria-pressed="${V.state === k}">${label}<span class="n">${count(k)}</span></button>`).join('');
}

// ---------- the suppliers' subscribers (the manager's): every supplier's list in one table, read every hour ----------
const SUP_FILTERS = [['active', 'فعّال'], ['inactive', 'غير فعّال'], ['notOurs', 'غير مسجّل عندنا'], ['oursOnly', 'عندنا وليس عند المورّد'], ['', 'الكل']];
function supRows() {
  const qv = digits(V.supQ) || V.supQ.trim().toLowerCase();
  const all = (V.sup?.rows || []).filter((r) => !V.supKey || r.supplier === V.supKey);
  const by = {
    active: (r) => r.active && !r.gone, inactive: (r) => !r.active || r.gone, notOurs: (r) => r.active && !r.gone && !r.line, '': () => true,
  }[V.supState] || (() => true);
  return all.filter(by).filter((r) => !qv || [r.number, r.customer, r.package, r.company, r.sim, r.line?.agentName].some((x) => String(x || '').toLowerCase().includes(qv)));
}
function supCount(state) {
  if (state === 'oursOnly') return (V.sup?.oursOnly || []).filter((l) => !V.supKey || l.supplier === V.supKey).length;
  const keep = V.supState;
  V.supState = state;
  const qSaved = V.supQ;
  V.supQ = '';
  const n = supRows().length;
  V.supState = keep;
  V.supQ = qSaved;
  return n;
}
function supCards() {
  return `<div class="grid-cards" style="margin-bottom:12px">${(V.sup?.suppliers || []).filter((s) => s.configured).map((s) => `
    <article class="card card-pad" style="padding:12px">
      <div class="row between"><b>${esc(s.name)}</b><button class="btn btn-sm" type="button" data-action="sup-sync" data-sup="${s.key}" ${s.running ? 'disabled' : ''}>${icon('refresh')}تحديث</button></div>
      <div class="small muted">${s.at ? `${s.count} مشترك · آخر تحديث ${esc(relTime(s.at))}` : 'لم يُقرأ بعد'}</div>
      ${s.error ? `<div class="small" style="color:var(--bad)">${icon('alert')} ${esc(s.error)}</div>` : ''}
    </article>`).join('') || '<p class="muted">لا يوجد مورّد بحساب محفوظ.</p>'}</div>`;
}
function supRowHtml(r) {
  const days = r.endsAt ? Math.ceil((r.endsAt - Date.now()) / 864e5) : null;
  const when = r.gone ? `لم يعد عند المورّد منذ ${fmtDate(r.goneAt)}` : r.endsAt ? `${days >= 0 ? `متبقٍ ${daysText(days)}` : `انتهى منذ ${daysText(-days)}`} · حتى <span class="ltr">${fmtDate(r.endsAt)}</span>` : 'بدون تاريخ انتهاء';
  const renewable = r.line && ['active', 'frozen'].includes(r.line.status);
  return `<article class="item">
    <div class="item-top"><span class="chip" style="pointer-events:none">${esc(r.supplierName)}</span>
      <div class="grow">${phone(r.number)}<div class="item-sub"><span>${esc(r.company)}</span><span>${esc(r.package)}</span>${r.customer ? `<span>${esc(r.customer)}</span>` : ''}</div></div>
      <span class="pill ${r.active && !r.gone ? 's-done' : 's-bad'}">${esc(r.gone ? 'غير موجود' : r.status || '—')}</span></div>
    <div class="small muted">${when}</div>
    <div class="row between" style="margin-top:6px;gap:8px;flex-wrap:wrap">
      <span class="small">${r.line ? `عندنا: <b>${esc(r.line.agentName)}</b>` : '<b style="color:var(--warn,#b45309)">غير مسجّل عندنا</b>'}</span>
      ${r.line ? `<span class="btn-row"><button class="btn btn-sm" type="button" data-action="open-line" data-id="${r.line.id}">${icon('eye')}الخط</button>
        ${renewable ? `<button class="btn btn-sm btn-primary" type="button" data-action="sup-renew" data-id="${r.line.id}">${icon('refresh')}تمديد</button>` : ''}</span>` : ''}
    </div></article>`;
}
function supListHtml() {
  if (!V.sup) return empty('refresh', 'جارٍ التحميل…', '');
  if (V.supState === 'oursOnly') {
    const list = (V.sup.oursOnly || []).filter((l) => !V.supKey || l.supplier === V.supKey);
    return list.length ? `<div class="list">${list.map((l) => `<article class="item clickable" data-action="open-line" data-id="${l.id}">
      <div class="item-top"><div class="grow">${phone(l.number)}<div class="item-sub"><span>${esc(l.packageLabel)}</span><span>${esc(l.agentName)}</span></div></div>
      <span class="pill s-bad">ليس عند المورّد</span></div></article>`).join('')}</div>` : empty('checkCircle', 'لا يوجد', 'كل خطوطنا الفعّالة موجودة عند مورّديها.');
  }
  const rows = supRows();
  if (!rows.length) return empty('users', 'لا يوجد مشتركون', V.sup.rows.length ? 'غيّر الفلتر أو البحث.' : 'اضغط «تحديث» لقراءة قوائم المورّدين.');
  return `<div class="list">${rows.slice(0, V.supShown).map(supRowHtml).join('')}</div>
    ${rows.length > V.supShown ? `<button class="btn btn-block" type="button" data-action="sup-more">عرض المزيد (${rows.length - V.supShown})</button>` : ''}`;
}
function supChips() {
  return SUP_FILTERS.map(([k, label]) => `<button class="chip" data-action="sup-state" data-state="${k}" aria-pressed="${V.supState === k}">${label}<span class="n">${supCount(k)}</span></button>`).join('');
}
function supHtml() {
  return `${supCards()}
    <div class="toolbar">
      <div class="search-box">${icon('search', 'i lead')}<input class="input" id="sup-q" type="search" placeholder="رقم، زبون، رزمة، شريحة أو وكيل" value="${esc(V.supQ)}" autocomplete="off"></div>
      <select class="input" id="sup-key" style="width:auto;min-width:150px"><option value="">كل المورّدين</option>${(V.sup?.suppliers || []).filter((s) => s.configured).map((s) => `<option value="${s.key}" ${V.supKey === s.key ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <button class="btn" type="button" data-action="sup-sync">${icon('refresh')}<span class="hide-xs">تحديث الكل</span></button>
      <button class="btn" type="button" data-action="sup-export">${icon('download')}<span class="hide-xs">تصدير</span></button>
    </div>
    <div class="chips" id="sup-chips">${supChips()}</div>
    <p class="hint">تُقرأ قوائم المورّدين تلقائياً كل ساعة (قراءة فقط). «غير مسجّل عندنا»: فعّال عند المورّد ولا يوجد خط بنفس الرقم في نظامنا.</p>
    <div id="sup-list">${supListHtml()}</div>`;
}
const supRefresh = () => {
  const list = document.getElementById('sup-list');
  if (list) list.innerHTML = supListHtml();
  const chips = document.getElementById('sup-chips');
  if (chips) chips.innerHTML = supChips();
};

export default {
  title: () => ({ title: isAdmin() ? 'كل المشتركين' : 'المشتركون', subtitle: 'الأرقام المفعّلة وحالة رزمها' }),
  skeleton: () => skeleton(4, 120),
  async load(ctx) {
    if (ctx.query.state !== undefined) V.state = ctx.query.state;
    if (ctx.query.q !== undefined) V.q = ctx.query.q;
    if (ctx.query.agent !== undefined) V.agentId = ctx.query.agent;
    if (ctx.query.view !== undefined) V.view = ctx.query.view === 'suppliers' && isAdmin() ? 'sup' : 'ours';
    if (V.view === 'sup' && isAdmin()) V.sup = await api.get('/api/supplier-subs').catch(() => ({ suppliers: [], rows: [], oursOnly: [] }));
    const [lines, agents] = await Promise.all([
      api.get(`/api/lines${isAdmin() && V.agentId ? `?agentId=${V.agentId}` : ''}`),
      isAdmin() ? api.get('/api/agents') : [],
      loadCatalog(),
    ]);
    V.lines = lines;
    V.agents = agents;
  },
  render() {
    const switcher = isAdmin() ? `<div class="segmented" style="margin-bottom:12px">
        <button data-action="sub-view" data-view="ours" aria-pressed="${V.view !== 'sup'}">${icon('users')}في نظامنا</button>
        <button data-action="sub-view" data-view="sup" aria-pressed="${V.view === 'sup'}">${icon('refresh')}عند المورّدين</button></div>` : '';
    if (V.view === 'sup' && isAdmin()) return switcher + supHtml();
    return switcher + `
      <div class="toolbar">
        <div class="search-box">${icon('search', 'i lead')}<input class="input" id="sub-q" type="search" placeholder="رقم، اسم زبون، شريحة أو رزمة" value="${esc(V.q)}" autocomplete="off"></div>
        ${isAdmin() ? `<select class="input" id="sub-agent" style="width:auto;min-width:180px"><option value="">كل الوكلاء</option>${V.agents.map((a) => `<option value="${a.id}" ${String(a.id) === String(V.agentId) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}
        <a class="btn btn-primary" href="#/new">${icon('userPlus')}<span class="hide-xs">اشتراك فاتورة جديدة</span></a>
      </div>
      <div class="chips" id="sub-chips">${chipsHtml()}</div>
      <div id="sub-list">${listHtml()}</div>`;
  },
  mount(root, ctx) {
    if (V.view === 'sup' && isAdmin()) {
      root.querySelector('#sup-q')?.addEventListener('input', debounce((e) => { V.supQ = e.target.value; V.supShown = 80; supRefresh(); }, 120));
      root.querySelector('#sup-key')?.addEventListener('change', (e) => { V.supKey = e.target.value; V.supShown = 80; supRefresh(); });
      return;
    }
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
    async 'sub-view'(btn, e, ctx) {
      V.view = btn.dataset.view === 'sup' ? 'sup' : 'ours';
      await ctx.reload();
    },
    'sup-state'(btn) { V.supState = btn.dataset.state; V.supShown = 80; supRefresh(); },
    'sup-more'() { V.supShown += 80; supRefresh(); },
    async 'sup-sync'(btn, e, ctx) {
      btn.disabled = true;
      toast(btn.dataset.sup ? 'جارٍ قراءة قائمة المورّد…' : 'جارٍ قراءة قوائم كل المورّدين… قد يأخذ دقيقة');
      try {
        V.sup = await api.post('/api/supplier-subs/sync', btn.dataset.sup ? { supplier: btn.dataset.sup } : {});
        const bad = (V.sup.result || []).filter((r) => r.error);
        toast(bad.length ? `تعذّر: ${bad.map((r) => r.key).join('، ')}` : 'تم التحديث', { error: !!bad.length });
        ctx.rerender();
      } catch (ex) { toast(ex.message, { error: true }); btn.disabled = false; }
    },
    'sup-renew'(btn) {
      const l = V.lines.find((x) => x.id === Number(btn.dataset.id));
      if (l) openRenew(l); else openLine(Number(btn.dataset.id));
    },
    'sup-export'() {
      const rows = supRows();
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const head = ['المورّد', 'الرقم', 'الشركة', 'الرزمة', 'الحالة', 'ينتهي في', 'الزبون', 'الشريحة', 'الوكيل عندنا'];
      const body = rows.map((r) => [r.supplierName, r.number, r.company, r.package, r.gone ? 'غير موجود' : r.status, r.endsAt ? fmtISO(r.endsAt) : '', r.customer, r.sim, r.line?.agentName || 'غير مسجّل عندنا'].map(cell).join(','));
      const blob = new Blob([`\ufeff${[head.map(cell).join(','), ...body].join('\n')}`], { type: 'text/csv;charset=utf-8' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `مشتركو-المورّدين-${fmtISO(Date.now())}.csv` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
    'open-line': (btn) => openLine(Number(btn.dataset.id)),
    'line-renew': (btn) => openRenew(V.lines.find((l) => l.id === Number(btn.dataset.id))),
    'line-act': (btn) => lineAction(V.lines.find((l) => l.id === Number(btn.dataset.id)), btn.dataset.act),
  },
};

