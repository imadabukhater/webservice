// New subscriber wizard: 1 company → 2 package (or campaign) → 3 SIM & number → 4 summary & confirm.
// "External prepaid" mode skips the SIM. The order summary beside the steps updates on every change.
import {
  S, api, esc, icon, isAdmin, fmtMoney, fmtDate, fmtPhone, phone, changed, loadCatalog, companyLogo, companyById, specs,
  monthsText, normalizePhone, empty, round, fmtNum, fmtIccid, copyText, debounce, toast,
} from '../core.js';
import { simFieldHtml, bindSimField } from '../simfield.js';
import { addMonths } from './renew.js';

const MONTHS = [1, 2, 3, 6, 12];
let W = null;
const D = { offers: [], stock: [], agents: [], prices: null, me: null };

const fresh = (mode, query) => ({
  mode, step: 1, agentId: null, companyId: null, packageId: null, offerId: null,
  esim: false, port: false, sim: { iccid: '', simId: null, valid: false }, months: 1, number: '', numberState: 'idle',
  customerName: '', customerPrice: '', note: '', unitPrice: '', result: null, error: '', query,
});

const external = () => W.mode === 'external';
const company = () => companyById(W.companyId);
const pkg = () => S.catalog.packages.find((p) => p.id === W.packageId) || null;
const offer = () => D.offers.find((o) => o.id === W.offerId) || null;
const agent = () => (isAdmin() ? D.agents.find((a) => a.id === W.agentId) : null);
const priceOf = (p) => (isAdmin() ? (D.prices?.get(p.id) ?? p.price) : p.price);
const unit = () => {
  if (isAdmin() && W.unitPrice !== '') return Number(W.unitPrice) || 0;
  const o = offer();
  if (o) return o.offerPrice ?? priceOf(pkg());
  return pkg() ? priceOf(pkg()) : 0;
};
const total = () => round(unit() * W.months);
const available = () => (isAdmin() ? agent()?.available ?? 0 : D.me?.available ?? 0);
const STEPS = () => ['الشركة', 'الرزمة', external() ? 'الرقم' : 'الشريحة والرقم', 'التأكيد'];

const step3Valid = () => {
  const numberOk = W.numberState === 'ok';
  if (external() || W.esim) return numberOk;
  return numberOk && W.sim.valid;
};

// ---------- step views ----------
function stepper() {
  return `<div class="card stepper" role="list">${STEPS().map((label, i) => {
    const n = i + 1;
    const cls = W.result ? 'done' : n < W.step ? 'done' : n === W.step ? 'current' : '';
    const canGo = !W.result && n < W.step;
    return `${i ? `<span class="step-line ${n <= W.step || W.result ? 'done' : ''}"></span>` : ''}
      <button class="step ${cls}" role="listitem" ${canGo ? `data-action="wz-step" data-step="${n}"` : 'tabindex="-1"'} aria-current="${n === W.step ? 'step' : 'false'}">
        <span class="circle">${cls === 'done' ? icon('check') : n}</span><span>${label}</span></button>`;
  }).join('')}</div>`;
}

function agentPicker() {
  if (!isAdmin()) return '';
  return `<div class="card card-pad"><div class="field"><label for="wz-agent">الوكيل</label>
    <select class="input" id="wz-agent"><option value="">اختر الوكيل الذي تفعّل له</option>
    ${D.agents.filter((a) => a.active).map((a) => `<option value="${a.id}" ${a.id === W.agentId ? 'selected' : ''}>${esc(a.name)} — المتاح ${fmtMoney(a.available)}</option>`).join('')}</select>
    <span class="hint">يُخصم السعر من رصيد هذا الوكيل حسب أسعاره الخاصة.</span></div></div>`;
}

function step1() {
  const cos = S.catalog.companies.filter((c) => S.catalog.packages.some((p) => p.companyId === c.id && p.active && priceOf(p) > 0));
  const last = lastUsed();
  return `${agentPicker()}
    <section class="card card-pad" style="display:grid;gap:16px">
      <h2 class="dot-title">شركة الاتصالات</h2>
      ${last ? `<button class="alert-card" data-action="wz-last" style="text-align:start">${companyLogo(companyById(last.companyId), 'xs')}
        <span class="grow"><b>آخر رزمة استعملتها</b><small>${esc(last.label)}</small></span>${icon('arrowL')}</button>` : ''}
      ${cos.length ? `<div class="co-grid">${cos.map((c) => {
        const n = S.catalog.packages.filter((p) => p.companyId === c.id && p.active && priceOf(p) > 0).length;
        return `<button class="co-tile" data-action="wz-company" data-id="${c.id}" aria-pressed="${c.id === W.companyId}">
          ${companyLogo(c)}<b>${esc(c.name)}</b><small>${n} ${n === 1 ? 'رزمة' : n === 2 ? 'رزمتان' : n <= 10 ? 'رزم' : 'رزمة'}</small></button>`;
      }).join('')}</div>` : empty('box', 'لا توجد رزم متاحة', isAdmin() ? 'حدّد أسعار الرزم من «الشركات والرزم».' : 'لم يحدد المدير أسعار الرزم بعد.')}
    </section>`;
}

function packageCard({ id, offerId, name, p, price, regular, campaign, tagNote }) {
  const selected = offerId ? W.offerId === offerId : !W.offerId && W.packageId === id;
  return `<button class="pkg-card ${campaign ? 'campaign' : ''}" data-action="wz-package" data-id="${id}" ${offerId ? `data-offer="${offerId}"` : ''} aria-pressed="${selected}">
    <div class="pkg-head"><span class="pkg-name">${esc(name)}</span>${campaign ? '<span class="pill campaign">حملة</span>' : ''}</div>
    ${p.dataGb ? `<div class="pkg-data"><b>${fmtNum(p.dataGb)}</b><span>GB</span></div>` : ''}
    ${specs(p) ? `<div class="pkg-specs">${specs(p)}</div>` : ''}
    ${p.description ? `<p class="small muted">${esc(p.description)}</p>` : ''}
    <div class="pkg-price"><small>للشهر</small>${regular && regular !== price ? `<s>${regular.toFixed(2)}</s>` : ''}<b>${fmtMoney(price)}</b></div>
    <div class="pkg-tag"><span>${esc(p.tag || '')}</span><span>${esc(tagNote || '')}</span></div>
  </button>`;
}

function step2() {
  const pk = S.catalog.packages.filter((p) => p.companyId === W.companyId && p.active && priceOf(p) > 0);
  const offers = D.offers.filter((o) => pk.some((p) => p.id === o.packageId));
  const c = company();
  return `<section class="card card-pad" style="display:grid;gap:16px">
    <div class="section-title"><h2 class="dot-title">اختر الرزمة</h2><span class="muted small">${esc(c?.name || '')}</span></div>
    <div class="pkg-grid">
      ${offers.map((o) => {
        const p = pk.find((x) => x.id === o.packageId);
        return packageCard({ id: p.id, offerId: o.id, name: o.title, p, price: o.offerPrice ?? priceOf(p), regular: priceOf(p), campaign: true, tagNote: o.endsAt ? `حتى ${fmtDate(o.endsAt)}` : '' });
      }).join('')}
      ${pk.map((p) => packageCard({ id: p.id, name: `${p.companyName} ${p.name}`, p, price: priceOf(p) })).join('')}
    </div>
    <div class="step-foot"><button class="btn" data-action="wz-back">${icon('arrowR')}السابق</button></div>
  </section>`;
}

function step3() {
  const stock = D.stock.filter((s) => !s.companyId || s.companyId === W.companyId);
  return `<section class="card card-pad" style="display:grid;gap:18px">
    <h2 class="dot-title">${external() ? 'رقم الزبون' : 'إعدادات الشريحة ورقم الهاتف'}</h2>
    ${external() ? `<div class="msg info">${icon('info')}<span>رقم مسبق الدفع مفعّل خارج المنصّة: تُشحن له الرزمة ويُضاف إلى مشتركيك لتتابع تاريخ انتهائها.</span></div>` : `
    <div class="switches">
      <label class="switch-row"><span class="tile sm cyan">${icon('qr')}</span><span class="grow"><b>eSIM</b><small>بدون شريحة — يرسل المدير رمز QR</small></span>
        <input class="switch" type="checkbox" id="wz-esim" ${W.esim ? 'checked' : ''}></label>
      <label class="switch-row"><span class="tile sm amber">${icon('repeat')}</span><span class="grow"><b>تحويل رقم</b><small>الزبون ينقل رقمه من شركة أخرى</small></span>
        <input class="switch" type="checkbox" id="wz-port" ${W.port ? 'checked' : ''}></label>
    </div>
    ${W.esim || W.port ? `<div class="msg warn">${icon('clock')}<span>يُرسَل الطلب إلى المدير لتنفيذه، ويبدأ احتساب مدة الرزمة من لحظة التنفيذ. يُسترد المبلغ كاملاً إن رُفض الطلب.</span></div>` : ''}
    ${W.esim ? '' : `<div id="wz-sim-box">${simFieldHtml({ id: 'wz-sim', label: 'اختر شريحة', value: W.sim.iccid, stock })}</div>`}`}
    <div class="field"><label for="wz-number">${W.port ? 'الرقم المراد تحويله' : 'رقم الهاتف'}</label>
      <input class="input ltr big" id="wz-number" inputmode="tel" autocomplete="off" placeholder="05X-XXX-XXXX" value="${esc(W.number)}">
      <div class="hint" id="wz-number-hint"></div></div>
    <div class="field"><span class="label">المدة</span>
      <div class="months">${MONTHS.map((m) => `<button type="button" data-action="wz-months" data-m="${m}" aria-pressed="${m === W.months}">${m}<small>${m === 1 ? 'شهر' : m === 2 ? 'شهران' : m <= 10 ? 'أشهر' : 'شهراً'}</small></button>`).join('')}</div></div>
    <div class="step-foot"><button class="btn" data-action="wz-back">${icon('arrowR')}السابق</button>
      <button class="btn btn-primary" data-action="wz-next" id="wz-next" ${step3Valid() ? '' : 'disabled'}>التالي${icon('arrowL')}</button></div>
  </section>`;
}

function step4() {
  const after = round(available() - total());
  const short = after < 0;
  return `<section class="card card-pad" style="display:grid;gap:16px">
    <h2 class="dot-title">تلخيص الطلبية</h2>
    <div class="kv">${rows().map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('')}</div>
    <div class="row2 stack-xs">
      <div class="field"><label for="wz-cname">اسم الزبون</label><input class="input" id="wz-cname" value="${esc(W.customerName)}" placeholder="اختياري"></div>
      <div class="field"><label for="wz-cprice">سعر الزبون (₪)</label><input class="input ltr" id="wz-cprice" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(W.customerPrice)}" placeholder="اختياري"></div>
    </div>
    <div class="hint" id="wz-margin"></div>
    ${isAdmin() ? `<div class="field"><label for="wz-unit">سعر خاص للشهر <span class="opt">(اختياري — بدل سعر الوكيل ${fmtMoney(offer()?.offerPrice ?? priceOf(pkg()))})</span></label>
      <input class="input ltr" id="wz-unit" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(W.unitPrice)}"></div>` : ''}
    <div class="field"><label for="wz-note">ملاحظة <span class="opt">(اختياري)</span></label><input class="input" id="wz-note" value="${esc(W.note)}"></div>
    <div class="balance-preview" id="wz-balance">${balanceHtml()}</div>
    ${short ? `<div class="msg">${icon('alert')}<span>الرصيد المتاح لا يكفي. ينقص ${fmtMoney(-after)}.${isAdmin() ? '' : ' اطلب شحن الرصيد من «المدفوعات».'}</span></div>` : ''}
    ${W.error ? `<div class="msg">${icon('alert')}<span>${esc(W.error)}</span></div>` : ''}
    <div class="step-foot"><button class="btn" data-action="wz-back">${icon('arrowR')}السابق</button>
      <button class="btn btn-primary btn-lg" data-action="wz-confirm" id="wz-confirm" ${short ? 'disabled' : ''}>${icon('check')}تأكيد الطلبية</button></div>
  </section>`;
}

function balanceHtml() {
  const after = round(available() - total());
  return `<div><span>المتاح قبل</span><b>${fmtMoney(available())}</b></div><div><span>السعر</span><b>${fmtMoney(total())}</b></div>
    <div><span>المتاح بعد</span><b class="${after < 0 ? 'minus' : ''}">${fmtMoney(after)}</b></div>`;
}

function resultView() {
  const l = W.result.line;
  const pending = l.status === 'pending';
  return `<section class="card card-pad"><div class="success">
    <div class="success-mark ${pending ? 'pending' : ''}">${icon(pending ? 'clock' : 'check')}</div>
    <h2>${pending ? 'أُرسل الطلب إلى المدير' : 'تم تفعيل الخط'}</h2>
    <p class="muted">${phone(l.number)} · ${esc(l.packageLabel)}${l.expiresAt ? ` · <span class="nowrap">حتى ${fmtDate(l.expiresAt)}</span>` : ''}</p>
    <p class="small muted">الرصيد المتاح الآن ${fmtMoney(W.result.available)}</p>
    <div class="btn-row" style="width:100%;max-width:420px">
      <button class="btn" data-action="wz-share">${icon('share')}مشاركة مع الزبون</button>
      <button class="btn" data-action="wz-copy">${icon('copy')}نسخ التفاصيل</button></div>
    <div class="btn-row" style="width:100%;max-width:420px">
      <button class="btn btn-primary" data-action="wz-again">${icon('userPlus')}مشترك جديد آخر</button>
      <a class="btn" href="#/subscribers">${icon('phone')}المشتركون</a></div>
  </div></section>`;
}

function rows() {
  const c = company();
  const p = pkg();
  const o = offer();
  const unset = '<span class="muted">لم يُختر بعد</span>';
  const r = [];
  if (isAdmin()) r.push(['الوكيل', agent() ? esc(agent().name) : unset]);
  r.push(['المشغّل', c ? esc(c.name) : unset]);
  r.push(['الرزمة', o ? `${esc(o.title)} <span class="pill campaign">حملة</span>` : p ? esc(`${p.companyName} ${p.name}`) : unset]);
  if (!external()) r.push(['الشريحة', W.esim ? 'eSIM' : W.sim.valid ? `<span class="mono ltr">${fmtIccid(W.sim.iccid)}</span>` : unset]);
  r.push([W.port ? 'الرقم المحوَّل' : 'رقم الهاتف', W.numberState === 'ok' ? phone(normalizePhone(W.number)) : unset]);
  r.push(['مدة الخدمة', monthsText(W.months)]);
  if (W.step >= 4 && p) r.push(['تنتهي في', W.esim || W.port ? 'بعد تنفيذ الطلب' : fmtDate(addMonths(Date.now(), W.months))]);
  return r;
}

function summary() {
  const c = company();
  const p = pkg();
  return `<aside class="card summary" aria-label="ملخص الطلبية">
    <div><h2>ملخص الطلبية</h2><span class="small muted">يتحدّث في كل خطوة</span></div>
    ${p ? `<div class="summary-pkg">${companyLogo(c, 'sm')}<div class="grow"><b>${esc(offer()?.title || `${p.companyName} ${p.name}`)}</b>
      <small>${[p.dataGb ? `${fmtNum(p.dataGb)} GB` : '', p.minutes !== null ? `${p.minutes === -1 ? '∞' : fmtNum(p.minutes)} MIN` : '', p.sms !== null ? `${p.sms === -1 ? '∞' : fmtNum(p.sms)} SMS` : ''].filter(Boolean).join(' · ')}</small></div></div>`
      : c ? `<div class="summary-pkg">${companyLogo(c, 'sm')}<div class="grow"><b>${esc(c.name)}</b><small>اختر الرزمة</small></div></div>` : ''}
    <div class="kv" id="wz-rows">${rows().map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('')}</div>
    <div class="total-row"><span>الإجمالي</span><b>${p ? fmtMoney(total()) : '—'}</b></div>
    ${W.step > 1 ? `<button class="btn btn-ghost btn-sm" data-action="wz-reset">${icon('x')}بدء طلبية جديدة</button>` : ''}
  </aside>`;
}

function refreshSummary() {
  const box = document.getElementById('wz-summary');
  if (box) box.innerHTML = summary();
  const next = document.getElementById('wz-next');
  if (next) next.disabled = !step3Valid();
}

// ---------- number check ----------
const checkNumber = debounce(async () => {
  const hint = document.getElementById('wz-number-hint');
  const n = normalizePhone(W.number);
  const set = (state, cls, text, num = '') => {
    W.numberState = state;
    if (hint) {
      hint.className = `hint ${cls}`;
      hint.innerHTML = `${icon(cls === 'ok' ? 'checkCircle' : cls ? 'alert' : 'info')}<span>${esc(text)}${num ? ` <span class="ltr">${esc(num)}</span>` : ''}</span>`;
    }
    refreshSummary();
  };
  if (!n) return set('idle', '', 'رقم الخط 10 أرقام ويبدأ بـ 05');
  if (!/^\d{9,13}$/.test(n)) return set('invalid', 'warn', 'الرقم غير مكتمل');
  try {
    const r = await api.get(`/api/lines/check?number=${n}`);
    if (normalizePhone(W.number) !== n) return undefined;
    if (r.exists) return set('taken', 'bad', r.mine ? 'هذا الرقم مفعّل لديك. لتمديده استعمل «زبون قائم».' : 'هذا الرقم مفعّل في المنصّة');
    const local = /^05\d{8}$/.test(n);
    return set('ok', local ? 'ok' : 'warn', local ? 'الرقم متاح ·' : 'الرقم متاح · تأكد منه: أرقام الجوال عادة 10 أرقام تبدأ بـ 05', local ? fmtPhone(n) : '');
  } catch {
    return set('ok', 'warn', 'تعذّر التحقق الآن. سيتحقق الخادم عند التأكيد.');
  }
}, 280);

// ---------- persistence of the last package (quick repeat) ----------
const LAST_KEY = () => `agents-last-pkg-${S.user.id}`;
function lastUsed() {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY()) || 'null');
    if (!v) return null;
    const p = S.catalog.packages.find((x) => x.id === v.packageId && x.active && priceOf(x) > 0);
    return p ? { companyId: p.companyId, packageId: p.id, label: `${p.companyName} ${p.name}` } : null;
  } catch { return null; }
}
function rememberPackage() {
  try { localStorage.setItem(LAST_KEY(), JSON.stringify({ packageId: W.packageId })); } catch { /* storage blocked */ }
}

async function loadAgentContext() {
  if (!isAdmin()) return;
  if (!W.agentId) { D.prices = null; D.stock = []; return; }
  const [prices, stock] = await Promise.all([api.get(`/api/agents/${W.agentId}/prices`), api.get(`/api/sims?status=available&forAgent=${W.agentId}`)]);
  D.prices = new Map(prices.map((r) => [r.packageId, r.customPrice ?? r.defaultPrice]));
  D.stock = stock;
}

function shareText() {
  const l = W.result.line;
  return `${S.settings.appName}\nتم ${l.status === 'pending' ? 'استلام طلب' : 'تفعيل'} خطك\nالرقم: ${fmtPhone(l.number)}\nالرزمة: ${l.packageLabel}${l.expiresAt ? `\nصالحة حتى: ${fmtDate(l.expiresAt)}` : ''}`;
}

export default {
  title: () => ({ title: W?.mode === 'external' ? 'زبون مسبق الدفع خارجي' : 'مشترك جديد', subtitle: W?.result ? 'تم' : `الخطوة ${W?.step || 1} من 4` }),
  async load(ctx) {
    const mode = ctx.query.type === 'external' ? 'external' : 'new';
    if (!W || W.mode !== mode || W.result || JSON.stringify(W.query) !== JSON.stringify(ctx.query)) W = fresh(mode, ctx.query);
    const [, offers, me, agents, stock] = await Promise.all([
      loadCatalog(true), api.get('/api/offers'),
      isAdmin() ? null : api.get('/api/me'),
      isAdmin() ? api.get('/api/agents') : [],
      isAdmin() ? [] : api.get('/api/sims?status=available'),
    ]);
    D.offers = offers.filter((o) => o.live && o.packageId);
    D.me = me?.user || null;
    D.agents = agents;
    if (!isAdmin()) D.stock = stock;
    else await loadAgentContext();
    // Deep link from an offer: jump straight to the SIM step.
    if (ctx.query.offer && W.step === 1 && !isAdmin()) {
      const o = D.offers.find((x) => x.id === Number(ctx.query.offer));
      const p = o && S.catalog.packages.find((x) => x.id === o.packageId);
      if (p) Object.assign(W, { companyId: p.companyId, packageId: p.id, offerId: o.id, step: 3 });
    }
  },
  render() {
    if (W.result) return `${stepper()}${resultView()}`;
    const body = [step1, step2, step3, step4][W.step - 1]();
    return `${stepper()}<div class="wizard"><div class="list" style="gap:18px">${body}</div><div id="wz-summary">${summary()}</div></div>`;
  },
  mount(root, ctx) {
    this._ctx = ctx;
    root.querySelector('#wz-agent')?.addEventListener('change', async (e) => {
      W.agentId = Number(e.target.value) || null;
      W.packageId = null; W.offerId = null;
      await loadAgentContext();
      this.rerenderSelf();
    });
    if (W.step === 3) {
      root.querySelector('#wz-esim')?.addEventListener('change', (e) => { W.esim = e.target.checked; this.rerenderSelf(); });
      root.querySelector('#wz-port')?.addEventListener('change', (e) => { W.port = e.target.checked; this.rerenderSelf(); });
      if (!external() && !W.esim) {
        bindSimField(root, {
          id: 'wz-sim', companyId: W.companyId, stock: D.stock,
          onChange: (s) => { W.sim = s; refreshSummary(); },
        });
      }
      const num = root.querySelector('#wz-number');
      num.addEventListener('input', () => { W.number = num.value; W.numberState = 'checking'; refreshSummary(); checkNumber(); });
      num.addEventListener('blur', () => { const n = normalizePhone(num.value); if (/^0\d{9}$/.test(n)) num.value = fmtPhone(n); });
      num.addEventListener('keydown', (e) => { if (e.key === 'Enter' && step3Valid()) { e.preventDefault(); W.step = 4; this.rerenderSelf(); } });
      checkNumber();
    }
    if (W.step === 4) {
      const bind = (id, key) => root.querySelector(id)?.addEventListener('input', (e) => {
        W[key] = e.target.value;
        if (key === 'unitPrice') { refreshSummary(); root.querySelector('#wz-balance').innerHTML = balanceHtml(); }
        if (key === 'customerPrice' || key === 'unitPrice') updateMargin(root);
      });
      bind('#wz-cname', 'customerName'); bind('#wz-cprice', 'customerPrice'); bind('#wz-note', 'note'); bind('#wz-unit', 'unitPrice');
      updateMargin(root);
    }
  },
  rerenderSelf() { this._ctx?.rerender(); },
  actions: {
    'wz-step'(btn, e, ctx) { W.step = Number(btn.dataset.step); W.error = ''; ctx.rerender(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
    'wz-company'(btn, e, ctx) {
      if (isAdmin() && !W.agentId) return toast('اختر الوكيل أولاً', { error: true });
      const id = Number(btn.dataset.id);
      if (W.companyId !== id) { W.packageId = null; W.offerId = null; W.sim = { iccid: '', simId: null, valid: false }; }
      W.companyId = id;
      W.step = 2;
      ctx.rerender();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return undefined;
    },
    'wz-last'(btn, e, ctx) {
      if (isAdmin() && !W.agentId) return toast('اختر الوكيل أولاً', { error: true });
      const last = lastUsed();
      Object.assign(W, { companyId: last.companyId, packageId: last.packageId, offerId: null, step: 3 });
      ctx.rerender();
      return undefined;
    },
    'wz-package'(btn, e, ctx) {
      W.packageId = Number(btn.dataset.id);
      W.offerId = btn.dataset.offer ? Number(btn.dataset.offer) : null;
      W.step = 3;
      ctx.rerender();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    'wz-months'(btn) {
      W.months = Number(btn.dataset.m);
      document.querySelectorAll('[data-action="wz-months"]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      refreshSummary();
    },
    'wz-back'(btn, e, ctx) { W.step = Math.max(1, W.step - 1); W.error = ''; ctx.rerender(); },
    'wz-next'(btn, e, ctx) { if (step3Valid()) { W.step = 4; ctx.rerender(); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
    async 'wz-confirm'(btn, e, ctx) {
      btn.disabled = true;
      W.error = '';
      const body = {
        kind: W.mode, packageId: W.packageId, offerId: W.offerId || undefined, months: W.months, number: normalizePhone(W.number),
        esim: W.esim, port: W.port, customerName: W.customerName, customerPrice: W.customerPrice, note: W.note,
      };
      if (!external() && !W.esim) Object.assign(body, W.sim.simId ? { simId: W.sim.simId } : { sim: W.sim.iccid });
      if (isAdmin()) { body.agentId = W.agentId; if (W.unitPrice !== '') body.unitPrice = W.unitPrice; }
      try {
        W.result = await api.post('/api/lines', body);
        rememberPackage();
        changed({ keepView: true });
        try { navigator.vibrate?.([30, 40, 30]); } catch { /* not supported */ }
      } catch (err) {
        W.error = err.message;
      }
      ctx.rerender();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    'wz-reset'(btn, e, ctx) {
      W = fresh(W.mode, W.query);
      ctx.rerender();
    },
    'wz-again'(btn, e, ctx) {
      const keep = { agentId: W.agentId, companyId: W.companyId, packageId: W.packageId, offerId: W.offerId, months: W.months };
      W = fresh(W.mode, W.query);
      Object.assign(W, keep, { step: keep.packageId ? 3 : 1 });
      ctx.reload();
    },
    async 'wz-share'() {
      const text = shareText();
      if (navigator.share) { try { await navigator.share({ text }); return; } catch { /* cancelled */ } }
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    },
    'wz-copy': () => copyText(shareText()),
  },
};

function updateMargin(root) {
  const box = root.querySelector('#wz-margin');
  if (!box) return;
  if (W.customerPrice === '') { box.innerHTML = `${icon('coins')}<span>أدخل سعر الزبون لترى ربحك من هذه العملية.</span>`; box.className = 'hint'; return; }
  const m = round(Number(W.customerPrice) - total());
  box.className = `hint ${m >= 0 ? 'ok' : 'bad'}`;
  box.innerHTML = `${icon('coins')}<span>ربحك من هذه العملية: ${fmtMoney(m)}</span>`;
}

