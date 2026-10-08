(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const money = (n) => '₪' + round(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));
  const p2 = (x) => String(x).padStart(2, '0');
  const fmtDate = (ts) => { const d = new Date(ts); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  const fmtDay = (ts) => { const d = new Date(ts); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`; };
  const toInputDate = (ts) => { if (!ts) return ''; const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

  const STATUS = { active: 'فعّال', frozen: 'مجمّد', disconnected: 'مفصول' };
  const OP = {
    activate: 'تفعيل خط', topup: 'شحن رصيد', deduct: 'خصم رصيد', transfer_in: 'رصيد وارد', transfer_out: 'رصيد صادر',
    freeze: 'تجميد', unfreeze: 'إلغاء تجميد', disconnect: 'فصل', swap_sim: 'تبديل شريحة', line_move: 'نقل رقم', line_delete: 'حذف خط',
  };

  const ICONS = {
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    sim: '<path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><rect x="9" y="11" width="6" height="6" rx="1"/>',
    offer: '<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    log: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.8 2.7 2.6 3 5.2"/>',
    box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  };
  const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

  // ---------- state & api ----------
  const S = {
    token: null, user: null, view: 'home', loading: false,
    summary: null, catalog: { companies: [], packages: [] }, offers: [], lines: [], ops: [], agents: [],
    act: {}, lineFilter: { q: '', status: '', agentId: '' }, logFilter: { agentId: '', type: '' }, agentQ: '',
  };
  try { S.token = localStorage.getItem('agents-token'); } catch { /* storage blocked */ }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && url !== '/api/login') { logoutLocal(); throw new Error(data.error || 'انتهت الجلسة'); }
    if (!res.ok) throw new Error(data.error || 'تعذّر الاتصال بالخادم');
    return data;
  }
  function logoutLocal() {
    S.token = null; S.user = null;
    try { localStorage.removeItem('agents-token'); } catch { /* ignore */ }
    render();
  }

  let toastTimer;
  function toast(text) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2800);
  }
  const isAdmin = () => S.user?.role === 'admin';

  // ---------- data loading ----------
  const loaders = {
    summary: async () => { S.summary = await api('GET', '/api/summary'); },
    catalog: async () => { S.catalog = await api('GET', '/api/catalog'); },
    offers: async () => { S.offers = await api('GET', '/api/offers'); },
    lines: async () => { S.lines = await api('GET', '/api/lines'); },
    ops: async () => {
      const f = S.logFilter;
      S.ops = await api('GET', `/api/ops?limit=300${f.agentId ? '&agentId=' + f.agentId : ''}${f.type ? '&type=' + f.type : ''}`);
    },
    recent: async () => { S.ops = await api('GET', '/api/ops?limit=15'); },
    agents: async () => { if (isAdmin()) S.agents = await api('GET', '/api/agents'); },
  };
  const NEEDS = {
    home: ['summary', 'recent', 'offers'], activate: ['catalog', 'offers', 'agents', 'summary'], lines: ['lines', 'agents'],
    offers: ['offers', 'catalog'], log: ['ops', 'agents'], agents: ['agents'], catalog: ['catalog'],
  };
  async function load(view = S.view) {
    try { await Promise.all((NEEDS[view] || []).map((k) => loaders[k]())); }
    catch (e) { if (S.user) toast(e.message); }
  }
  async function go(view) {
    S.view = view;
    render();
    await load(view);
    render();
    window.scrollTo(0, 0);
  }
  async function refresh() { await load(); render(); }

  // ---------- render ----------
  function render() {
    const root = $('#app');
    if (!S.user) { root.innerHTML = loginView(); return; }
    const tabs = isAdmin()
      ? [['home', 'الرئيسية', 'home'], ['agents', 'الوكلاء', 'users'], ['lines', 'الأرقام', 'sim'], ['catalog', 'الباقات', 'box'], ['offers', 'العروض', 'offer'], ['log', 'السجل', 'log']]
      : [['home', 'الرئيسية', 'home'], ['activate', 'تفعيل', 'plus'], ['lines', 'أرقامي', 'sim'], ['offers', 'العروض', 'offer'], ['log', 'السجل', 'log']];
    const views = { home: homeView, activate: activateView, lines: linesView, offers: offersView, log: logView, agents: agentsView, catalog: catalogView };
    root.innerHTML = `
      <header class="appbar">
        <div><h1>${esc(S.user.name)}</h1><small>${isAdmin() ? 'المدير' : 'وكيل · ' + esc(S.user.username)}</small></div>
        <button class="btn sm" data-act="account">الحساب</button>
      </header>
      <main>${views[S.view]()}</main>
      <nav class="bottom">${tabs.map(([v, l, i]) => `<button data-go="${v}" ${S.view === v ? 'aria-current="page"' : ''}>${icon(i)}<span>${l}</span></button>`).join('')}</nav>`;
    afterRender();
  }

  function loginView() {
    return `<div class="login"><form class="login-card" id="login-form" autocomplete="on">
      <div class="login-mark">و</div>
      <div><h1>تسجيل الدخول</h1><p>أدخل اسم المستخدم وكلمة المرور التي أعطاك إياها المدير.</p></div>
      <label>اسم المستخدم<input id="login-user" name="username" autocomplete="username" autocapitalize="none" dir="ltr" required></label>
      <label>كلمة المرور<input id="login-pass" name="password" type="password" autocomplete="current-password" dir="ltr" required></label>
      <div id="login-msg"></div>
      <button class="btn primary block" type="submit">دخول</button>
    </form></div>`;
  }

  // ----- home -----
  function homeView() {
    const s = S.summary;
    const top = !s ? `<div class="card note">جارٍ التحميل…</div>` : isAdmin()
      ? `<div class="stats">
          <div class="stat"><span>مجموع أرصدة الوكلاء</span><b>${money(s.balances)}</b></div>
          <div class="stat"><span>عدد الوكلاء</span><b>${s.agents}</b></div>
          <div class="stat"><span>تفعيلات اليوم</span><b>${s.today}</b></div>
          <div class="stat"><span>ربح اليوم</span><b>${money(s.profitToday)}</b></div>
        </div>`
      : `<div class="balance-card"><span>رصيدك الحالي</span><b>${money(s.balance)}</b>
          <div class="row"><span>تفعيلات اليوم: ${s.today}</span><span>أرقام فعّالة: ${s.lines}</span></div></div>
         <button class="btn primary block" data-go="activate">تفعيل خط جديد</button>`;
    const liveOffers = S.offers.filter((o) => o.live).slice(0, 2);
    return `${top}
      ${liveOffers.length ? `<div class="section-head"><h2>العروض</h2><button class="btn sm ghost" data-go="offers">الكل</button></div>
        <div class="list">${liveOffers.map(offerCard).join('')}</div>` : ''}
      <div class="section-head"><h2>آخر العمليات</h2><button class="btn sm ghost" data-go="log">السجل كاملاً</button></div>
      ${opsList(S.ops)}`;
  }

  // ----- activate -----
  function agentPrice(pkg) {
    if (!isAdmin()) return pkg.price;
    const custom = S.act.prices?.[pkg.id];
    return custom ?? pkg.price;
  }
  function activateView() {
    const a = S.act;
    const offer = a.offerId ? S.offers.find((o) => o.id === a.offerId) : null;
    const cos = S.catalog.companies;
    const pkgs = S.catalog.packages.filter((p) => p.active && (!a.companyId || p.companyId === a.companyId));
    const pkg = S.catalog.packages.find((p) => p.id === (offer ? offer.packageId : a.packageId));
    const agent = isAdmin() ? S.agents.find((x) => x.id === a.agentId) : null;
    const balance = isAdmin() ? agent?.balance : S.summary?.balance;
    let price = null;
    if (offer && pkg) price = offer.offerPrice ?? (isAdmin() ? agentPrice(pkg) : offer.regularPrice);
    else if (pkg) price = agentPrice(pkg);
    if (isAdmin() && a.priceOverride !== undefined && a.priceOverride !== '') price = round(a.priceOverride);
    const after = balance != null && price != null ? round(balance - price) : null;
    const short = after != null && after < 0;
    return `<div class="section-head"><h2>تفعيل خط جديد</h2>${isAdmin() ? '<button class="btn sm ghost" data-go="lines">رجوع</button>' : ''}</div>
      ${isAdmin() ? `<label>الوكيل<select id="act-agent"><option value="">اختر الوكيل</option>${S.agents.filter((x) => x.active).map((x) => `<option value="${x.id}" ${x.id === a.agentId ? 'selected' : ''}>${esc(x.name)} — ${money(x.balance)}</option>`).join('')}</select></label>` : ''}
      ${offer ? `<div class="item offer-card"><div class="item-top"><div><span class="pill offer">عرض</span> <b>${esc(offer.title)}</b><div class="meta">${esc(offer.packageLabel)}</div></div>
          <button class="btn sm" data-act="clear-offer">إلغاء العرض</button></div></div>`
        : `<div class="chips">${cos.map((c) => `<button class="chip" data-company="${c.id}" aria-pressed="${a.companyId === c.id}">${esc(c.name)}</button>`).join('')}</div>
          <div class="pkg-grid">${pkgs.length ? pkgs.map((p) => `<button class="pkg" data-pkg="${p.id}" aria-pressed="${a.packageId === p.id}">
            <span>${esc(p.companyName)}</span><strong>${esc(p.name)}</strong><b>${money(agentPrice(p))}</b></button>`).join('') : '<div class="empty">لا توجد باقات لهذه الشركة.</div>'}</div>`}
      <form class="stack card" id="act-form" autocomplete="off">
        <label>رقم الخط<input id="act-number" class="num" inputmode="tel" placeholder="05XXXXXXXX" value="${esc(a.number || '')}" required></label>
        <label>رقم الشريحة (ICCID)<input id="act-sim" class="num" inputmode="numeric" placeholder="8997…" value="${esc(a.sim || '')}"></label>
        <label>ملاحظة<input id="act-note" placeholder="اختياري: اسم الزبون" value="${esc(a.note || '')}"></label>
        ${isAdmin() ? `<label>سعر خاص لهذه العملية (اختياري)<input id="act-price" class="num" type="number" step="0.01" min="0" value="${esc(a.priceOverride ?? '')}"></label>` : ''}
        <div class="preview">
          <div><span>الرصيد قبل</span><b>${balance == null ? '—' : money(balance)}</b></div>
          <div><span>السعر</span><b>${price == null ? '—' : money(price)}</b></div>
          <div><span>الرصيد بعد</span><b class="${short ? 'minus' : ''}">${after == null ? '—' : money(after)}</b></div>
        </div>
        ${short ? `<div class="msg">الرصيد لا يكفي. ينقص ${money(-after)}.${isAdmin() ? '' : ' تواصل مع المدير لشحن رصيدك.'}</div>` : ''}
        <div id="act-msg"></div>
        <button class="btn primary block" type="submit" ${!pkg || short || (isAdmin() && !agent) ? 'disabled' : ''}>تفعيل الخط</button>
      </form>`;
  }

  // ----- lines -----
  function linesView() {
    const f = S.lineFilter;
    const qq = f.q.trim();
    const list = S.lines.filter((l) => (!f.status || l.status === f.status) && (!f.agentId || l.agentId === Number(f.agentId))
      && (!qq || l.number.includes(qq) || l.sim.includes(qq) || (l.agentName || '').includes(qq)));
    return `<div class="section-head"><h2>${isAdmin() ? 'كل الأرقام' : 'أرقامي'}</h2>
        ${isAdmin() ? '<button class="btn sm primary" data-act="admin-activate">تفعيل خط</button>' : ''}</div>
      <input id="line-q" type="search" placeholder="بحث بالرقم أو الشريحة${isAdmin() ? ' أو الوكيل' : ''}" value="${esc(f.q)}">
      <div class="chips">${[['', 'الكل'], ['active', 'فعّال'], ['frozen', 'مجمّد'], ['disconnected', 'مفصول']]
        .map(([v, l]) => `<button class="chip" data-status="${v}" aria-pressed="${f.status === v}">${l}</button>`).join('')}</div>
      ${isAdmin() ? `<select id="line-agent"><option value="">كل الوكلاء</option>${S.agents.map((x) => `<option value="${x.id}" ${String(x.id) === String(f.agentId) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
      ${!list.length ? `<div class="empty">${S.lines.length ? 'لا توجد أرقام تطابق البحث.' : 'لا توجد أرقام بعد. فعّل أول خط من «تفعيل».'}</div>`
        : `<div class="list">${list.map(lineCard).join('')}</div>`}`;
  }
  function lineCard(l) {
    const off = l.status === 'disconnected';
    return `<div class="item">
      <div class="item-top"><div><b class="num">${esc(l.number)}</b><div class="meta"><span>${esc(l.packageLabel)}</span>${isAdmin() ? `<span>${esc(l.agentName)}</span>` : ''}</div></div>
        <span class="pill ${l.status}">${STATUS[l.status]}</span></div>
      <div class="meta"><span>الشريحة: <span class="num">${esc(l.sim || '—')}</span></span><span>تفعيل: <span class="num">${fmtDay(l.activatedAt)}</span></span><span>السعر: <span class="num">${money(l.price)}</span></span></div>
      ${off && !isAdmin() ? '' : `<div class="actions">
        ${l.status === 'active' ? `<button class="btn sm" data-line="freeze" data-id="${l.id}">تجميد</button>` : ''}
        ${l.status === 'frozen' ? `<button class="btn sm" data-line="unfreeze" data-id="${l.id}">إلغاء التجميد</button>` : ''}
        ${!off ? `<button class="btn sm" data-line="swap_sim" data-id="${l.id}">تبديل الشريحة</button>
          <button class="btn sm danger" data-line="disconnect" data-id="${l.id}">فصل الرقم</button>` : ''}
        ${isAdmin() ? `<button class="btn sm" data-line="move" data-id="${l.id}">نقل لوكيل آخر</button>
          <button class="btn sm danger" data-line="delete" data-id="${l.id}">حذف</button>` : ''}
      </div>`}
    </div>`;
  }

  // ----- offers -----
  function offerCard(o) {
    const price = o.offerPrice;
    return `<div class="item offer-card">
      <div class="item-top"><div><h3>${esc(o.title)}</h3>${o.packageLabel ? `<div class="meta">${esc(o.packageLabel)}</div>` : ''}</div>
        ${isAdmin() ? `<span class="pill ${o.live ? 'active' : ''}">${o.live ? 'ظاهر للوكلاء' : o.active ? 'خارج التاريخ' : 'متوقف'}</span>` : '<span class="pill offer">عرض</span>'}</div>
      ${o.details ? `<p class="note" style="color:var(--ink);white-space:pre-line">${esc(o.details)}</p>` : ''}
      ${price != null ? `<div class="offer-price"><b>${money(price)}</b>${o.regularPrice != null && o.regularPrice !== price ? `<s>${money(o.regularPrice)}</s>` : ''}</div>` : ''}
      ${o.startsAt || o.endsAt ? `<div class="meta">${o.startsAt ? `<span>من ${fmtDay(o.startsAt)}</span>` : ''}${o.endsAt ? `<span>حتى ${fmtDay(o.endsAt)}</span>` : ''}</div>` : ''}
      <div class="actions">
        ${!isAdmin() && o.packageId ? `<button class="btn offer" data-act="use-offer" data-id="${o.id}">تفعيل بهذا العرض</button>` : ''}
        ${isAdmin() ? `<button class="btn sm" data-act="edit-offer" data-id="${o.id}">تعديل</button><button class="btn sm danger" data-act="delete-offer" data-id="${o.id}">حذف</button>` : ''}
      </div></div>`;
  }
  function offersView() {
    return `<div class="section-head"><h2>العروض</h2>${isAdmin() ? '<button class="btn sm primary" data-act="add-offer">إضافة عرض</button>' : ''}</div>
      ${S.offers.length ? `<div class="list">${S.offers.map(offerCard).join('')}</div>`
        : `<div class="empty">${isAdmin() ? 'لا توجد عروض. اضغط «إضافة عرض» لنشر أول عرض للوكلاء.' : 'لا توجد عروض حالياً.'}</div>`}`;
  }

  // ----- log -----
  function opsList(list) {
    if (!list.length) return '<div class="empty">لا توجد عمليات بعد.</div>';
    return `<div class="list">${list.map((o) => `<div class="item">
      <div class="item-top"><div><span class="pill ${o.type}">${OP[o.type] || o.type}</span> ${o.number ? `<b class="num">${esc(o.number)}</b>` : ''}
        <div class="meta"><span class="num">${fmtDate(o.ts)}</span>${isAdmin() ? `<span>${esc(o.agentName)}</span>` : ''}</div></div>
        ${o.amount ? `<b class="num ${o.amount > 0 ? 'plus' : 'minus'}">${signed(o.amount)}</b>` : ''}</div>
      ${o.detail ? `<div class="note">${esc(o.detail)}</div>` : ''}
      ${o.before != null && o.amount ? `<div class="meta"><span>الرصيد قبل: <span class="num">${money(o.before)}</span></span><span>بعد: <span class="num">${money(o.after)}</span></span>
        ${isAdmin() && o.type === 'activate' ? `<span>التكلفة: <span class="num">${money(o.cost)}</span></span><span>الربح: <span class="num">${money(o.profit)}</span></span>` : ''}</div>` : ''}
    </div>`).join('')}</div>`;
  }
  function logView() {
    const f = S.logFilter;
    return `<div class="section-head"><h2>سجل العمليات</h2></div>
      ${isAdmin() ? `<select id="log-agent"><option value="">كل الوكلاء</option>${S.agents.map((x) => `<option value="${x.id}" ${String(x.id) === String(f.agentId) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
      <select id="log-type"><option value="">كل العمليات</option>${Object.entries(OP).map(([k, v]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      ${opsList(S.ops)}`;
  }

  // ----- admin: agents -----
  function agentsView() {
    const qq = S.agentQ.trim().toLowerCase();
    const list = S.agents.filter((a) => !qq || a.name.toLowerCase().includes(qq) || a.username.toLowerCase().includes(qq) || a.phone.includes(qq));
    return `<div class="section-head"><h2>الوكلاء</h2><div class="actions">
        <button class="btn sm" data-act="transfer">نقل رصيد</button><button class="btn sm primary" data-act="add-agent">إضافة وكيل</button></div></div>
      <input id="agent-q" type="search" placeholder="بحث بالاسم أو اسم المستخدم" value="${esc(S.agentQ)}">
      ${!list.length ? `<div class="empty">${S.agents.length ? 'لا نتائج.' : 'لا يوجد وكلاء. اضغط «إضافة وكيل» وأعطه اسم مستخدم وكلمة مرور.'}</div>`
        : `<div class="list">${list.map((a) => `<div class="item">
          <div class="item-top"><div><b>${esc(a.name)}</b><div class="meta"><span class="num">@${esc(a.username)}</span>${a.phone ? `<span class="num">${esc(a.phone)}</span>` : ''}<span>${a.lineCount} رقم</span></div></div>
            <div style="text-align:end"><b class="num ${a.balance < 0 ? 'minus' : ''}">${money(a.balance)}</b>${a.active ? '' : '<div><span class="pill disconnected">موقوف</span></div>'}</div></div>
          <div class="actions">
            <button class="btn sm primary" data-agent="balance" data-id="${a.id}">الرصيد</button>
            <button class="btn sm" data-agent="prices" data-id="${a.id}">أسعار الوكيل</button>
            <button class="btn sm" data-agent="activate" data-id="${a.id}">تفعيل خط</button>
            <button class="btn sm" data-agent="edit" data-id="${a.id}">تعديل</button>
            <button class="btn sm" data-agent="log" data-id="${a.id}">السجل</button>
            <button class="btn sm danger" data-agent="delete" data-id="${a.id}">حذف</button>
          </div></div>`).join('')}</div>`}`;
  }

  // ----- admin: catalog -----
  function catalogView() {
    const { companies, packages } = S.catalog;
    return `<div class="section-head"><h2>الشركات والباقات</h2><div class="actions">
        <button class="btn sm" data-act="add-company">إضافة شركة</button><button class="btn sm primary" data-act="add-package">إضافة باقة</button></div></div>
      <p class="note">السعر هنا هو السعر الافتراضي. لتحديد سعر مختلف لوكيل معيّن افتح «الوكلاء» ثم «أسعار الوكيل».</p>
      ${!companies.length ? '<div class="empty">لا توجد شركات. أضف أول شركة.</div>' : companies.map((c) => {
        const pk = packages.filter((p) => p.companyId === c.id);
        return `<div class="card list">
          <div class="item-top"><h2>${esc(c.name)}</h2><div class="actions">
            <button class="btn sm" data-act="add-package" data-company="${c.id}">باقة</button>
            <button class="btn sm" data-act="edit-company" data-id="${c.id}">تعديل</button>
            <button class="btn sm danger" data-act="delete-company" data-id="${c.id}">حذف</button></div></div>
          ${!pk.length ? '<p class="note">لا توجد باقات.</p>' : pk.map((p) => `<div class="item" style="border-style:${p.active ? 'solid' : 'dashed'}">
            <div class="item-top"><div><b>${esc(p.name)}</b> ${p.active ? '' : '<span class="pill">موقوفة</span>'}${!p.price ? ' <span class="pill frozen">حدد السعر</span>' : ''}
              <div class="meta"><span>التكلفة: <span class="num">${money(p.cost)}</span></span><span>السعر: <span class="num">${money(p.price)}</span></span><span>الربح: <span class="num">${money(p.price - p.cost)}</span></span></div></div></div>
            <div class="actions"><button class="btn sm" data-act="edit-package" data-id="${p.id}">تعديل</button><button class="btn sm danger" data-act="delete-package" data-id="${p.id}">حذف</button></div>
          </div>`).join('')}</div>`;
      }).join('')}`;
  }

  // ---------- events after render ----------
  function afterRender() {
    const lq = $('#line-q');
    if (lq) lq.addEventListener('input', (e) => { S.lineFilter.q = e.target.value; rerenderKeepFocus('#line-q'); });
    const aq = $('#agent-q');
    if (aq) aq.addEventListener('input', (e) => { S.agentQ = e.target.value; rerenderKeepFocus('#agent-q'); });
    const la = $('#line-agent');
    if (la) la.addEventListener('change', (e) => { S.lineFilter.agentId = e.target.value; render(); });
    const lgA = $('#log-agent');
    if (lgA) lgA.addEventListener('change', async (e) => { S.logFilter.agentId = e.target.value; await loaders.ops(); render(); });
    const lgT = $('#log-type');
    if (lgT) lgT.addEventListener('change', async (e) => { S.logFilter.type = e.target.value; await loaders.ops(); render(); });
    const actAgent = $('#act-agent');
    if (actAgent) actAgent.addEventListener('change', async (e) => { await selectActAgent(Number(e.target.value) || null); });
    ['number', 'sim', 'note'].forEach((k) => { const el = $('#act-' + k); if (el) el.addEventListener('input', () => { S.act[k] = el.value; }); });
    const ap = $('#act-price');
    if (ap) ap.addEventListener('change', () => { S.act.priceOverride = ap.value; rerenderKeepFocus(null); });
  }
  function rerenderKeepFocus(sel) {
    const pos = sel ? $(sel)?.selectionStart : null;
    render();
    if (sel) { const el = $(sel); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* not text */ } } }
  }
  async function selectActAgent(id) {
    S.act.agentId = id;
    S.act.prices = {};
    if (id) {
      const rows = await api('GET', `/api/agents/${id}/prices`);
      rows.forEach((r) => { if (r.customPrice != null) S.act.prices[r.packageId] = r.customPrice; });
    }
    render();
  }

  // ---------- bottom sheet ----------
  function sheet(title, body, { submit = 'حفظ', danger = false, onSubmit, onInput, noSubmit = false } = {}) {
    const root = $('#sheet-root');
    root.innerHTML = `<div class="overlay"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="btn sm ghost" data-close>إغلاق</button></div>
      <form class="stack" id="sheet-form" autocomplete="off">${body}<div id="sheet-msg"></div>
        ${noSubmit ? '' : `<div class="sheet-foot"><button class="btn ${danger ? 'danger solid' : 'primary'}" type="submit">${esc(submit)}</button><button class="btn" type="button" data-close>إلغاء</button></div>`}
      </form></div></div>`;
    const form = $('#sheet-form');
    const close = () => { root.innerHTML = ''; };
    $$('[data-close]', root).forEach((b) => b.addEventListener('click', close));
    $('.overlay', root).addEventListener('click', (e) => { if (e.target.classList.contains('overlay')) close(); });
    if (onInput) { form.addEventListener('input', () => onInput(form)); onInput(form); }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', form);
      if (btn) btn.disabled = true;
      try {
        const done = await onSubmit(form);
        close();
        if (done) toast(done);
        await refresh();
      } catch (err) {
        $('#sheet-msg').innerHTML = `<div class="msg">${esc(err.message)}</div>`;
        if (btn) btn.disabled = false;
      }
    });
    return form;
  }
  const v = (form, name) => (form.elements[name]?.value ?? '').trim();

  // ---------- actions ----------
  const lineActions = {
    freeze: (l) => sheet(`تجميد ${l.number}`, `<p class="note">يتوقف الخط مؤقتاً ويمكن إلغاء التجميد لاحقاً.</p>
      <label>السبب (اختياري)<input name="reason"></label>`, {
      submit: 'تجميد الرقم',
      onSubmit: async (f) => { await api('POST', `/api/lines/${l.id}/action`, { action: 'freeze', reason: v(f, 'reason') }); return 'تم تجميد الرقم'; },
    }),
    unfreeze: (l) => sheet(`إلغاء تجميد ${l.number}`, '<p class="note">سيعود الخط فعّالاً.</p>', {
      submit: 'إلغاء التجميد',
      onSubmit: async () => { await api('POST', `/api/lines/${l.id}/action`, { action: 'unfreeze' }); return 'عاد الرقم فعّالاً'; },
    }),
    swap_sim: (l) => sheet(`تبديل شريحة ${l.number}`, `<p class="note">الشريحة الحالية: <span class="num">${esc(l.sim || '—')}</span></p>
      <label>رقم الشريحة الجديدة (ICCID)<input name="sim" class="num" inputmode="numeric" required></label>`, {
      submit: 'تبديل الشريحة',
      onSubmit: async (f) => { await api('POST', `/api/lines/${l.id}/action`, { action: 'swap_sim', sim: v(f, 'sim') }); return 'تم تبديل الشريحة'; },
    }),
    disconnect: (l) => sheet(`فصل ${l.number}`, `<p class="msg">فصل الرقم نهائي ولا يمكن التراجع عنه من التطبيق.</p>
      <label>السبب (اختياري)<input name="reason"></label>`, {
      submit: 'فصل الرقم', danger: true,
      onSubmit: async (f) => { await api('POST', `/api/lines/${l.id}/action`, { action: 'disconnect', reason: v(f, 'reason') }); return 'تم فصل الرقم'; },
    }),
    move: (l) => sheet(`نقل ${l.number}`, `<p class="note">الوكيل الحالي: <b>${esc(l.agentName)}</b></p>
      <label>إلى الوكيل<select name="to" required><option value="">اختر</option>${S.agents.filter((a) => a.id !== l.agentId).map((a) => `<option value="${a.id}">${esc(a.name)} — ${money(a.balance)}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="withMoney"> نقل قيمة الخط (${money(l.price)}): تُرجع للوكيل الحالي وتُخصم من الجديد</label>`, {
      submit: 'نقل الرقم',
      onSubmit: async (f) => { await api('POST', `/api/lines/${l.id}/move`, { toAgentId: Number(v(f, 'to')), withMoney: f.elements.withMoney.checked }); return 'تم نقل الرقم'; },
    }),
    delete: (l) => sheet(`حذف ${l.number}`, `<p class="note">يُحذف الرقم من القائمة (لتصحيح خطأ في الإدخال). لإيقاف خط حقيقي استعمل «فصل الرقم».</p>
      <label class="check"><input type="checkbox" name="refund"> إرجاع ${money(l.price)} إلى رصيد ${esc(l.agentName)}</label>`, {
      submit: 'حذف', danger: true,
      onSubmit: async (f) => { await api('DELETE', `/api/lines/${l.id}${f.elements.refund.checked ? '?refund=1' : ''}`); return 'تم الحذف'; },
    }),
  };

  function agentForm(a) {
    sheet(a ? `تعديل ${a.name}` : 'إضافة وكيل', `
      <label>اسم الوكيل<input name="name" value="${esc(a?.name || '')}" required></label>
      <div class="row2"><label>اسم المستخدم<input name="username" dir="ltr" autocapitalize="none" value="${esc(a?.username || '')}" required></label>
        <label>${a ? 'كلمة مرور جديدة' : 'كلمة المرور'}<input name="password" dir="ltr" ${a ? 'placeholder="اتركها فارغة بدون تغيير"' : 'required'} minlength="6"></label></div>
      <div class="row2"><label>الهاتف<input name="phone" class="num" inputmode="tel" value="${esc(a?.phone || '')}"></label>
        ${a ? '' : '<label>الرصيد الافتتاحي (₪)<input name="balance" class="num" type="number" step="0.01" value="0"></label>'}</div>
      <label>ملاحظات<input name="notes" value="${esc(a?.notes || '')}"></label>
      ${a ? `<label class="check"><input type="checkbox" name="active" ${a.active ? 'checked' : ''}> الحساب فعّال (ألغِ التحديد لمنع الوكيل من الدخول)</label>` : ''}`, {
      submit: a ? 'حفظ' : 'إضافة الوكيل',
      onSubmit: async (f) => {
        const body = { name: v(f, 'name'), username: v(f, 'username'), phone: v(f, 'phone'), notes: v(f, 'notes') };
        if (v(f, 'password')) body.password = v(f, 'password');
        if (a) { body.active = f.elements.active.checked; await api('PUT', `/api/agents/${a.id}`, body); return 'تم الحفظ'; }
        body.balance = v(f, 'balance');
        await api('POST', '/api/agents', body);
        return `تمت إضافة ${body.name}. أعطه اسم المستخدم وكلمة المرور.`;
      },
    });
  }

  const agentActions = {
    edit: (a) => agentForm(a),
    balance: (a) => sheet(`رصيد ${a.name}`, `
      <div class="row2"><label>العملية<select name="kind"><option value="topup">شحن</option><option value="deduct">خصم</option><option value="set">تعيين رصيد جديد</option></select></label>
        <label>المبلغ (₪)<input name="amount" class="num" type="number" step="0.01" min="0" required></label></div>
      <label>ملاحظة<input name="note" placeholder="مثال: دفعة نقدية"></label>
      <div class="preview" id="bal-prev"></div>`, {
      submit: 'تنفيذ',
      onInput: (f) => {
        const amt = round(v(f, 'amount')); const k = v(f, 'kind');
        const after = k === 'set' ? amt : k === 'topup' ? a.balance + amt : a.balance - amt;
        $('#bal-prev').innerHTML = `<div><span>قبل</span><b>${money(a.balance)}</b></div><div><span>التغيير</span><b>${signed(round(after - a.balance))}</b></div><div><span>بعد</span><b>${money(after)}</b></div>`;
      },
      onSubmit: async (f) => { await api('POST', `/api/agents/${a.id}/balance`, { kind: v(f, 'kind'), amount: v(f, 'amount'), note: v(f, 'note') }); return 'تم تحديث الرصيد'; },
    }),
    prices: async (a) => {
      const rows = await api('GET', `/api/agents/${a.id}/prices`);
      sheet(`أسعار ${a.name}`, `<p class="note">اكتب سعراً خاصاً لهذا الوكيل، أو اترك الخانة فارغة ليأخذ السعر الافتراضي.</p>
        ${rows.length ? rows.map((r) => `<div class="price-row"><div><b>${esc(r.companyName)} ${esc(r.name)}</b><small>الافتراضي ${money(r.defaultPrice)} · التكلفة ${money(r.cost)}</small></div>
          <input class="num" type="number" step="0.01" min="0" name="p${r.packageId}" data-pkg="${r.packageId}" placeholder="${round(r.defaultPrice)}" value="${r.customPrice ?? ''}"></div>`).join('') : '<div class="empty">لا توجد باقات.</div>'}`, {
        submit: 'حفظ الأسعار',
        onSubmit: async (f) => {
          const prices = $$('input[data-pkg]', f).map((i) => ({ packageId: Number(i.dataset.pkg), price: i.value.trim() === '' ? null : i.value }));
          await api('PUT', `/api/agents/${a.id}/prices`, { prices });
          return 'تم حفظ أسعار الوكيل';
        },
      });
    },
    activate: async (a) => { S.act = {}; S.view = 'activate'; await load('activate'); await selectActAgent(a.id); },
    log: async (a) => { S.logFilter = { agentId: String(a.id), type: '' }; await go('log'); },
    delete: (a) => sheet(`حذف ${a.name}`, `<p>هل تريد حذف الوكيل نهائياً؟ رصيده ${money(a.balance)}.</p>
      ${a.lineCount ? '<p class="msg">لدى الوكيل أرقام. انقلها أولاً، أو أوقف حسابه من «تعديل» بدلاً من الحذف.</p>' : ''}`, {
      submit: 'حذف الوكيل', danger: true,
      onSubmit: async () => { await api('DELETE', `/api/agents/${a.id}`); return 'تم حذف الوكيل'; },
    }),
  };

  function packageForm(p, companyId) {
    const cos = S.catalog.companies;
    if (!cos.length) return toast('أضف شركة أولاً');
    sheet(p ? 'تعديل باقة' : 'إضافة باقة', `
      <label>الشركة<select name="companyId">${cos.map((c) => `<option value="${c.id}" ${c.id === (p?.companyId ?? companyId) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>اسم الباقة<input name="name" value="${esc(p?.name || '')}" placeholder="مثال: 500 جيجا" required></label>
      <div class="row2"><label>التكلفة عليّ (₪)<input name="cost" class="num" type="number" step="0.01" min="0" value="${p ? round(p.cost) : ''}" required></label>
        <label>السعر الافتراضي للوكلاء (₪)<input name="price" class="num" type="number" step="0.01" min="0" value="${p ? round(p.price) : ''}" required></label></div>
      <label class="check"><input type="checkbox" name="active" ${!p || p.active ? 'checked' : ''}> الباقة متاحة للتفعيل</label>`, {
      submit: p ? 'حفظ' : 'إضافة الباقة',
      onSubmit: async (f) => {
        const body = { companyId: Number(v(f, 'companyId')), name: v(f, 'name'), cost: v(f, 'cost'), price: v(f, 'price'), active: f.elements.active.checked };
        await api(p ? 'PUT' : 'POST', p ? `/api/packages/${p.id}` : '/api/packages', body);
        return p ? 'تم حفظ الباقة' : 'تمت إضافة الباقة';
      },
    });
  }

  function offerForm(o) {
    const pk = S.catalog.packages;
    sheet(o ? 'تعديل عرض' : 'إضافة عرض', `
      <label>عنوان العرض<input name="title" value="${esc(o?.title || '')}" placeholder="مثال: سلكوم 500 جيجا بسعر خاص" required></label>
      <label>التفاصيل<textarea name="details" rows="3">${esc(o?.details || '')}</textarea></label>
      <label>الباقة (اختياري — لتمكين الوكيل من التفعيل بالعرض)<select name="packageId"><option value="">بدون باقة (إعلان فقط)</option>
        ${pk.map((p) => `<option value="${p.id}" ${p.id === o?.packageId ? 'selected' : ''}>${esc(p.companyName)} ${esc(p.name)}</option>`).join('')}</select></label>
      <label>سعر العرض للوكيل (₪)<input name="offerPrice" class="num" type="number" step="0.01" min="0" value="${o?.offerPrice ?? ''}" placeholder="فارغ = سعر الوكيل العادي"></label>
      <div class="row2"><label>يبدأ<input name="startsAt" type="date" value="${toInputDate(o?.startsAt)}"></label>
        <label>ينتهي<input name="endsAt" type="date" value="${toInputDate(o?.endsAt)}"></label></div>
      <label class="check"><input type="checkbox" name="active" ${!o || o.active ? 'checked' : ''}> العرض ظاهر للوكلاء</label>`, {
      submit: o ? 'حفظ' : 'نشر العرض',
      onSubmit: async (f) => {
        const day = (s, end) => (s ? new Date(s + (end ? 'T23:59:59' : 'T00:00:00')).getTime() : null);
        const body = { title: v(f, 'title'), details: v(f, 'details'), packageId: v(f, 'packageId') ? Number(v(f, 'packageId')) : null,
          offerPrice: v(f, 'offerPrice'), startsAt: day(v(f, 'startsAt')), endsAt: day(v(f, 'endsAt'), true), active: f.elements.active.checked };
        await api(o ? 'PUT' : 'POST', o ? `/api/offers/${o.id}` : '/api/offers', body);
        return o ? 'تم حفظ العرض' : 'تم نشر العرض';
      },
    });
  }

  const actions = {
    account: () => sheet('الحساب', `
      <p class="note">${esc(S.user.name)} · <span class="num">@${esc(S.user.username)}</span></p>
      <h3>تغيير كلمة المرور</h3>
      <label>كلمة المرور الحالية<input name="current" type="password" dir="ltr" autocomplete="current-password"></label>
      <label>كلمة المرور الجديدة<input name="password" type="password" dir="ltr" autocomplete="new-password" minlength="6"></label>
      <button class="btn danger" type="button" id="logout-btn">تسجيل الخروج</button>`, {
      submit: 'تغيير كلمة المرور',
      onSubmit: async (f) => { await api('POST', '/api/me/password', { current: v(f, 'current'), password: v(f, 'password') }); return 'تم تغيير كلمة المرور'; },
    }),
    'add-agent': () => agentForm(null),
    transfer: () => sheet('نقل رصيد بين وكيلين', `
      <label>من الوكيل<select name="from" required><option value="">اختر</option>${S.agents.map((a) => `<option value="${a.id}">${esc(a.name)} — ${money(a.balance)}</option>`).join('')}</select></label>
      <label>إلى الوكيل<select name="to" required><option value="">اختر</option>${S.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
      <label>المبلغ (₪)<input name="amount" class="num" type="number" step="0.01" min="0" required></label>`, {
      submit: 'نقل الرصيد',
      onSubmit: async (f) => { await api('POST', '/api/transfer', { fromId: Number(v(f, 'from')), toId: Number(v(f, 'to')), amount: v(f, 'amount') }); return 'تم نقل الرصيد'; },
    }),
    'admin-activate': async () => { S.act = {}; await go('activate'); },
    'add-company': () => sheet('إضافة شركة', '<label>اسم الشركة<input name="name" required></label>', {
      submit: 'إضافة', onSubmit: async (f) => { await api('POST', '/api/companies', { name: v(f, 'name') }); return 'تمت إضافة الشركة'; },
    }),
    'edit-company': (id) => {
      const c = S.catalog.companies.find((x) => x.id === id);
      sheet('تعديل شركة', `<label>اسم الشركة<input name="name" value="${esc(c.name)}" required></label>`, {
        onSubmit: async (f) => { await api('PUT', `/api/companies/${id}`, { name: v(f, 'name') }); return 'تم الحفظ'; },
      });
    },
    'delete-company': (id) => {
      const c = S.catalog.companies.find((x) => x.id === id);
      sheet(`حذف ${c.name}`, '<p>تُحذف الشركة نهائياً. يجب حذف باقاتها أولاً.</p>', {
        submit: 'حذف الشركة', danger: true, onSubmit: async () => { await api('DELETE', `/api/companies/${id}`); return 'تم حذف الشركة'; },
      });
    },
    'add-package': (_, el) => packageForm(null, Number(el.dataset.company) || undefined),
    'edit-package': (id) => packageForm(S.catalog.packages.find((p) => p.id === id)),
    'delete-package': (id) => {
      const p = S.catalog.packages.find((x) => x.id === id);
      sheet(`حذف ${p.name}`, '<p>تُحذف الباقة. الأرقام المفعّلة عليها تبقى في القائمة باسمها. لإخفائها مؤقتاً استعمل «تعديل» وألغِ «متاحة للتفعيل».</p>', {
        submit: 'حذف الباقة', danger: true, onSubmit: async () => { await api('DELETE', `/api/packages/${id}`); return 'تم حذف الباقة'; },
      });
    },
    'add-offer': () => offerForm(null),
    'edit-offer': (id) => offerForm(S.offers.find((o) => o.id === id)),
    'delete-offer': (id) => sheet('حذف العرض', '<p>يُحذف العرض ولا يظهر للوكلاء بعد ذلك.</p>', {
      submit: 'حذف العرض', danger: true, onSubmit: async () => { await api('DELETE', `/api/offers/${id}`); return 'تم حذف العرض'; },
    }),
    'use-offer': async (id) => { S.act = { offerId: id }; await go('activate'); },
    'clear-offer': () => { S.act.offerId = null; render(); },
  };

  // ---------- global listeners ----------
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.id === 'logout-btn') {
      try { await api('POST', '/api/logout'); } catch { /* already gone */ }
      $('#sheet-root').innerHTML = '';
      return logoutLocal();
    }
    const goBtn = t.closest('[data-go]');
    if (goBtn) { if (goBtn.dataset.go === 'activate' && !isAdmin()) S.act = {}; return go(goBtn.dataset.go); }
    const company = t.closest('[data-company]:not([data-act])');
    if (company) { const id = Number(company.dataset.company); S.act.companyId = S.act.companyId === id ? null : id; S.act.packageId = null; return render(); }
    const pkg = t.closest('[data-pkg].pkg');
    if (pkg) { S.act.packageId = Number(pkg.dataset.pkg); return render(); }
    const status = t.closest('[data-status]');
    if (status) { S.lineFilter.status = status.dataset.status; return render(); }
    const line = t.closest('[data-line]');
    if (line) { const l = S.lines.find((x) => x.id === Number(line.dataset.id)); return l && lineActions[line.dataset.line](l); }
    const ag = t.closest('[data-agent]');
    if (ag) {
      const a = S.agents.find((x) => x.id === Number(ag.dataset.id));
      try { return a && (await agentActions[ag.dataset.agent](a)); } catch (err) { return toast(err.message); }
    }
    const act = t.closest('[data-act]');
    if (act && actions[act.dataset.act]) {
      try { await actions[act.dataset.act](Number(act.dataset.id) || null, act); } catch (err) { toast(err.message); }
    }
  });

  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'login-form') {
      e.preventDefault();
      const btn = $('button[type=submit]', e.target);
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/login', { username: $('#login-user').value.trim(), password: $('#login-pass').value });
        S.token = r.token; S.user = r.user; S.view = 'home';
        try { localStorage.setItem('agents-token', r.token); } catch { /* storage blocked */ }
        await go('home');
      } catch (err) {
        $('#login-msg').innerHTML = `<div class="msg">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    }
    if (e.target.id === 'act-form') {
      e.preventDefault();
      const a = S.act;
      const body = { number: $('#act-number').value, sim: $('#act-sim').value, note: $('#act-note').value };
      if (a.offerId) body.offerId = a.offerId; else body.packageId = a.packageId;
      if (isAdmin()) { body.agentId = a.agentId; if (a.priceOverride) body.price = a.priceOverride; }
      const btn = $('button[type=submit]', e.target);
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/lines', body);
        toast(`تم تفعيل ${r.line.number}. الرصيد الآن ${money(r.balance)}`);
        S.act = isAdmin() ? { agentId: a.agentId, prices: a.prices } : { companyId: a.companyId };
        await refresh();
      } catch (err) {
        $('#act-msg').innerHTML = `<div class="msg">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#sheet-root').innerHTML = ''; });

  // Refresh when the app returns to the foreground (balances may have changed).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.user) refresh(); });

  // ---------- boot ----------
  async function boot() {
    if (S.token) {
      try { S.user = (await api('GET', '/api/me')).user; await load('home'); } catch { S.user = null; }
    }
    render();
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  boot();
})();
