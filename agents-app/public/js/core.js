// Shared state, API access, formatting, icons, sheets and toasts.

export const S = {
  token: null,
  user: null,
  settings: { appName: 'بوابة الوكلاء', warnDays: 7, lowBalance: 0 },
  badges: { bell: 0, tasks: 0 },
  catalog: null,
  syncOk: true,
  syncing: false,
};
try { S.token = localStorage.getItem('agents-token'); } catch { /* storage blocked */ }

export const isAdmin = () => S.user?.role === 'admin';

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const listeners = { unauthorized: [] };
export const onUnauthorized = (fn) => listeners.unauthorized.push(fn);

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    S.syncOk = false;
    throw new ApiError(0, 'لا يوجد اتصال بالإنترنت. تحقّق من الشبكة وحاول مرة أخرى.');
  }
  S.syncOk = true;
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && url !== '/api/login') listeners.unauthorized.forEach((fn) => fn());
  if (!res.ok) throw new ApiError(res.status, data.error || 'تعذّر الاتصال بالخادم');
  return data;
}
export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
  async blob(url) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + S.token } });
    if (!res.ok) throw new ApiError(res.status, 'تعذّر التنزيل');
    return res.blob();
  },
};
export const tz = () => new Date().getTimezoneOffset();

export function setToken(token) {
  S.token = token;
  try {
    if (token) localStorage.setItem('agents-token', token);
    else localStorage.removeItem('agents-token');
  } catch { /* storage blocked */ }
}

export async function loadCatalog(force = false) {
  if (!S.catalog || force) S.catalog = await api.get('/api/catalog');
  return S.catalog;
}

// ---------- formatting ----------
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
export const fmtNum = (n) => nf0.format(Number(n) || 0);
export const fmtMoney = (n) => `${nf2.format(round(n))} ₪`;
export const money = (n) => `<span class="ltr nowrap">${fmtMoney(n)}</span>`;
export const signedMoney = (n) => `<span class="ltr nowrap ${n > 0 ? 'plus' : n < 0 ? 'minus' : ''}">${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtMoney(Math.abs(n))}</span>`;
const p2 = (x) => String(x).padStart(2, '0');
export const fmtDate = (ts) => { if (!ts) return '—'; const d = new Date(ts); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`; };
export const fmtISO = (ts) => { if (!ts) return ''; const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
export const fmtTime = (ts) => { const d = new Date(ts); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
export const fmtDateTime = (ts) => (ts ? `${fmtDate(ts)} ${fmtTime(ts)}` : '—');
export const fmtDayMonth = (ts) => { const d = new Date(ts); return `${d.getDate()}/${d.getMonth() + 1}`; };
const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export const weekday = (ts) => WEEKDAYS[new Date(ts).getDay()];

export function relTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'الآن';
  if (m < 60) return `قبل ${arCount(m, ['دقيقة', 'دقيقتين', 'دقائق', 'دقيقة'])}`;
  const h = Math.round(m / 60);
  if (h < 24) return `قبل ${arCount(h, ['ساعة', 'ساعتين', 'ساعات', 'ساعة'])}`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? 'أمس' : `قبل ${arCount(d, ['يوم', 'يومين', 'أيام', 'يوماً'])}`;
  return fmtDate(ts);
}

// [one, two, few (3-10), many (11+)] → "دقيقة", "دقيقتين", "5 دقائق", "12 دقيقة"
export function arCount(n, [one, two, few, many]) {
  if (n === 1) return one;
  if (n === 2) return two;
  const r = n % 100;
  return `${n} ${r >= 3 && r <= 10 ? few : many}`;
}
export const monthsText = (m) => arCount(m, ['شهر', 'شهران', 'أشهر', 'شهراً']);
export const daysText = (d) => arCount(d, ['يوم', 'يومان', 'أيام', 'يوماً']);
export const simsText = (n) => arCount(n, ['شريحة واحدة', 'شريحتان', 'شرائح', 'شريحة']);

export const fmtPhone = (n) => {
  const d = String(n || '');
  return /^0\d{9}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
};
export const phone = (n) => `<span class="phone">${esc(fmtPhone(n))}</span>`;
export const fmtIccid = (s) => String(s || '').replace(/(\d{4})(?=\d)/g, '$1 ');
export const normalizePhone = (s) => {
  let d = String(s || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if ((d.startsWith('972') || d.startsWith('970')) && d.length >= 11) d = '0' + d.slice(3);
  return d;
};
export const digits = (s) => String(s || '').replace(/\D/g, '');

export function greeting() {
  const h = new Date().getHours();
  return h >= 5 && h < 12 ? 'صباح الخير' : 'مساء الخير';
}
export const firstName = (name) => String(name || '').trim().split(/\s+/).slice(0, 2).join(' ');
export const initials = (name) => {
  const parts = String(name || '؟').trim().split(/\s+/);
  return (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
};

// ---------- domain display ----------
export const STATE = {
  active: 'فعّال', expiring: 'ينتهي قريباً', expired: 'منتهي', frozen: 'مجمّد', pending: 'قيد التنفيذ', disconnected: 'مفصول',
};
export const statePill = (state) => `<span class="pill s-${state}">${STATE[state] || state}</span>`;
export const TASK_STATUS = { open: 'بانتظار التنفيذ', done: 'تم', rejected: 'مرفوض' };
export const TASK_TYPE = { topup: 'طلب شحن رصيد', port: 'تحويل رقم', esim: 'تفعيل eSIM', general: 'طلب عام' };
export const OP = {
  activate: 'تفعيل خط', renew: 'تمديد', topup: 'شحن رصيد', deduct: 'خصم رصيد', transfer_in: 'رصيد وارد', transfer_out: 'رصيد صادر',
  freeze: 'تجميد', unfreeze: 'إلغاء تجميد', disconnect: 'فصل', swap_sim: 'تبديل شريحة', line_move: 'نقل رقم', line_delete: 'حذف خط',
  refund: 'استرجاع', port_done: 'تحويل رقم', esim_done: 'تفعيل eSIM',
};
export const OP_ICON = {
  activate: ['plus', 'blue'], renew: ['repeat', 'green'], topup: ['wallet', 'green'], deduct: ['wallet', 'red'],
  transfer_in: ['swap', 'green'], transfer_out: ['swap', 'red'], freeze: ['snow', 'violet'], unfreeze: ['play', 'green'],
  disconnect: ['power', 'red'], swap_sim: ['sim', 'amber'], line_move: ['swap', 'amber'], line_delete: ['trash', 'red'],
  refund: ['undo', 'green'], port_done: ['repeat', 'cyan'], esim_done: ['qr', 'cyan'],
};

// Uploaded logo when there is one; otherwise the name as a wordmark (large tiles) or its first letter (small badges).
export function companyLogo(c, size = '') {
  if (!c) return `<span class="co-logo ${size}"><span class="mono" style="--co:#64748b">؟</span></span>`;
  const word = !size && String(c.name).length <= 14;
  const inner = c.logo
    ? `<img src="${esc(c.logo)}" alt="">`
    : `<span class="mono ${word ? 'word' : ''}" style="--co:${esc(c.color || '#475569')}">${esc(word ? c.name : String(c.name).trim()[0] || '؟')}</span>`;
  return `<span class="co-logo ${size}">${inner}</span>`;
}

export const companyById = (id) => S.catalog?.companies.find((c) => c.id === id) || null;

// Detects the company from an ICCID using the prefixes the manager configured (or the app learned).
export function detectCompany(iccid) {
  const d = digits(iccid);
  let best = null;
  let len = 0;
  for (const c of S.catalog?.companies || []) {
    for (const p of c.prefixes || []) if (d.startsWith(p) && p.length > len) { best = c; len = p.length; }
  }
  return best;
}

export function specs(p, { compact = false } = {}) {
  const amount = (v, unit) => (v === -1 ? `∞ ${unit}` : `${fmtNum(v)} ${unit}`);
  const out = [];
  if (p.sms !== null && p.sms !== undefined) out.push(`<span>${icon('msg')}${amount(p.sms, 'SMS')}</span>`);
  if (p.minutes !== null && p.minutes !== undefined) out.push(`<span>${icon('call')}${amount(p.minutes, 'MIN')}</span>`);
  if (compact && p.dataGb) out.unshift(`<span>${icon('data')}${fmtNum(p.dataGb)} GB</span>`);
  return out.join('');
}

// ---------- icons ----------
const P = {
  home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  tasks: '<path d="M10.5 6.5H20M10.5 12H20M10.5 17.5H20"/><path d="m3.5 6.5 1.6 1.6L8 5.2"/><path d="m3.5 12 1.6 1.6L8 10.7"/><path d="m3.5 17.5 1.6 1.6L8 16.2"/>',
  chart: '<path d="M4 20h16"/><rect x="5.5" y="11" width="3" height="6.5" rx="1"/><rect x="10.5" y="5.5" width="3" height="12" rx="1"/><rect x="15.5" y="13" width="3" height="4.5" rx="1"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><path d="M10.5 18.5h3"/>',
  percent: '<path d="M18.5 5.5 5.5 18.5"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/>',
  wallet: '<path d="M17 7.5V6a2 2 0 0 0-2-2H6a2.5 2.5 0 0 0-2.5 2.5"/><rect x="3.5" y="6.5" width="17" height="13.5" rx="2.6"/><path d="M15.5 13.25h2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M15.5 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.8c1.9.8 3 2.4 3.5 5.2"/>',
  userPlus: '<circle cx="9.5" cy="8" r="3.5"/><path d="M3 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M19 7.5v6M16 10.5h6"/>',
  repeat: '<path d="M17 3 20.5 6.5 17 10"/><path d="M3.5 11.5v-1.5A3.5 3.5 0 0 1 7 6.5h13.5"/><path d="M7 21 3.5 17.5 7 14"/><path d="M20.5 12.5V14a3.5 3.5 0 0 1-3.5 3.5H3.5"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 5.6 6.3L4 8"/><path d="M4 3.5V8h4.5"/><path d="M4 13a8 8 0 0 0 14.4 4.7L20 16"/><path d="M20 20.5V16h-4.5"/>',
  bolt: '<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z"/>',
  sim: '<path d="M7.5 2.5h7l4.5 4.5v13a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 20V4a1.5 1.5 0 0 1 1.5-1.5z"/><rect x="9" y="11" width="6" height="7" rx="1"/><path d="M12 11v7M9 14.5h6"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9.5 2.5v3.5M14.5 2.5v3.5M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>',
  snow: '<path d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8l16.4-9.6"/><path d="m9.5 4 2.5 2 2.5-2M9.5 20l2.5-2 2.5 2M4.1 10.6l3.1-.6-1-3M17.8 17l-1-3 3.1-.6M4.1 13.4l3.1.6-1 3M17.8 7l-1 3 3.1.6"/>',
  calX: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.6"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><path d="m10 13 4 4M14 13l-4 4"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.6"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  camera: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.4-2h4.6l1.4 2h1.8A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/>',
  scan: '<path d="M4 7.5V5.5A1.5 1.5 0 0 1 5.5 4h2M16.5 4h2A1.5 1.5 0 0 1 20 5.5v2M20 16.5v2a1.5 1.5 0 0 1-1.5 1.5h-2M7.5 20h-2A1.5 1.5 0 0 1 4 18.5v-2"/><path d="M8 8.5v7M11 8.5v7M14 8.5v7M17 8.5v7"/>',
  bell: '<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  arrowL: '<path d="M19 12H5.5M11 6l-6 6 6 6"/>',
  arrowR: '<path d="M5 12h13.5M13 6l6 6-6 6"/>',
  chevL: '<path d="m14.5 6-6 6 6 6"/>',
  chevR: '<path d="m9.5 6 6 6-6 6"/>',
  chevD: '<path d="m6 9.5 6 6 6-6"/>',
  sort: '<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M9.5 16.5 5 12l4.5-4.5M5 12h10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l2.5 2.5M14.5 8.5l2 2"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  file: '<path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z"/><path d="M14 3.5v4h4"/>',
  excel: '<path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z"/><path d="M14 3.5v4h4M9.5 11.5l5 5M14.5 11.5l-5 5"/>',
  pdf: '<path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z"/><path d="M14 3.5v4h4M9 12.5h6M9 16h4"/>',
  print: '<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14.5h10v6H7z"/>',
  list: '<path d="M8 6.5h12M8 12h12M8 17.5h12"/><circle cx="4.5" cy="6.5" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="17.5" r="1" fill="currentColor"/>',
  swap: '<path d="M7 4 3.5 7.5 7 11"/><path d="M3.5 7.5H17"/><path d="M17 13l3.5 3.5L17 20"/><path d="M20.5 16.5H7"/>',
  power: '<path d="M12 3v8"/><path d="M6.6 6.6a7.5 7.5 0 1 0 10.8 0"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  trend: '<path d="m3.5 16.5 6-6 4 4 7-7.5"/><path d="M15 7h5.5v5.5"/>',
  coins: '<ellipse cx="9" cy="7" rx="5.5" ry="2.5"/><path d="M3.5 7v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V7"/><path d="M9.5 16.5c.6 1.1 2.9 2 5.5 2 3 0 5.5-1.1 5.5-2.5v-4c0-1.4-2.5-2.5-5.5-2.5"/>',
  gift: '<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5 12v7.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V12M12 8v12.5"/><path d="M12 8C10.5 4.5 7 4 7 6s2.5 2 5 2c2.5 0 5 0 5-2s-3.5-1.5-5 2z"/>',
  tag: '<path d="M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l8.2 8.2a1.5 1.5 0 0 1 0 2.1l-6.4 6.4a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.5"/>',
  box: '<path d="m3.5 7.5 8.5-4 8.5 4v9l-8.5 4-8.5-4z"/><path d="m3.5 7.5 8.5 4 8.5-4M12 11.5v9"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  building: '<path d="M4 20.5V5a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 15 5v15.5"/><path d="M15 9.5h3.5A1.5 1.5 0 0 1 20 11v9.5M2.5 20.5h19M7.5 7.5h4M7.5 11.5h4M7.5 15.5h4"/>',
  msg: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 3.5V17H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  call: '<path d="M5.5 3.5h3l1.5 4.5-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4.5 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 3.5 5.5a2 2 0 0 1 2-2z"/>',
  data: '<path d="M2.5 9a14 14 0 0 1 19 0"/><path d="M5.5 12.5a9.5 9.5 0 0 1 13 0"/><path d="M8.7 16a5 5 0 0 1 6.6 0"/><circle cx="12" cy="19.2" r="1" fill="currentColor"/>',
  share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4M8.2 13.2l7.6 4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m4 17.5 5-4.5 4 3.5 2.5-2 4.5 3.5"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5l1-13"/>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m14.5 7.5 3 3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.5"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  send: '<path d="M20.5 3.5 3.5 10.5l7 3 3 7z"/><path d="m10.5 13.5 4-4"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  logo: '<path d="M12 3.2c-4.9 0-8.8 3.9-8.8 8.8s3.9 8.8 8.8 8.8 8.8-3.9 8.8-8.8" stroke-width="2.4"/><path d="M8.2 12.4a4 4 0 0 1 7.5-1.9M12 12l6.2-6.2" stroke-width="2.4"/><circle cx="18.6" cy="5.4" r="1.6" fill="currentColor" stroke="none"/>',
};
export const icon = (name, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;

// ---------- toast ----------
let toastTimer;
export function toast(text, { error = false } = {}) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.className = 'toast' + (error ? ' error' : '');
  t.innerHTML = `${icon(error ? 'alert' : 'checkCircle')}<span></span>`;
  t.querySelector('span').textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), error ? 4200 : 2800);
  if (!error) try { navigator.vibrate?.(18); } catch { /* not supported */ }
}

// ---------- sheets (bottom sheet on phones, dialog on desktop) ----------
// Every open sheet (and the phone drawer) owns one history entry, so the Android back button closes it.
const stack = [];
let ignorePop = 0;
let popWaiters = [];
const overlays = { drawerOpen: false, onDrawerBack: null };

window.addEventListener('popstate', () => {
  if (ignorePop > 0) ignorePop--;
  else if (stack.length) closeTop(false);
  else if (overlays.drawerOpen) overlays.onDrawerBack?.();
  const waiters = popWaiters;
  popWaiters = [];
  waiters.forEach((r) => r());
});

// Resolves after the next popstate (or a short timeout if the browser has nothing to go back to).
function back() {
  ignorePop++;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    popWaiters.push(finish);
    setTimeout(() => { if (!done) { ignorePop = Math.max(0, ignorePop - 1); finish(); } }, 400);
    history.back();
  });
}

export const pushOverlayState = (kind) => history.pushState({ overlay: kind }, '');
export const overlayBack = back;
export function registerDrawer(onBack) { overlays.onDrawerBack = onBack; }
export function setDrawerOpen(open) { overlays.drawerOpen = open; }

function closeTop(viaUi = true) {
  const s = stack.pop();
  if (!s) return Promise.resolve();
  s.el.remove();
  s.onClose?.();
  if (!stack.length) document.body.style.overflow = '';
  return viaUi ? back() : Promise.resolve();
}
export const closeSheet = () => closeTop(true);
export async function closeAllSheets() { while (stack.length) await closeTop(true); }
export const sheetOpen = () => stack.length > 0;

async function closeEntry(entry) {
  if (!stack.includes(entry)) return;
  while (stack.length && stack[stack.length - 1] !== entry) await closeTop(true);
  await closeTop(true);
}

/**
 * body: HTML for the form. onSubmit(form) may return a toast message, { toast, go } to navigate afterwards,
 * `false` to stay open, or throw to show the error inside the sheet.
 * Without onSubmit the sheet is informational (no footer unless `footer` HTML is given).
 */
export function sheet({ title, subtitle = '', body, submit = 'حفظ', danger = false, onSubmit, onInput, onMount, onClose, wide = false, footer, cancel = 'إلغاء' }) {
  const el = document.createElement('div');
  el.className = 'overlay';
  const formId = `sheet-form-${Date.now().toString(36)}${stack.length}`;
  const foot = onSubmit
    ? `<div class="sheet-foot"><button class="btn ${danger ? 'btn-danger solid' : 'btn-primary'}" type="submit" form="${formId}">${esc(submit)}</button>${cancel ? `<button class="btn" type="button" data-close>${esc(cancel)}</button>` : ''}</div>`
    : footer ? `<div class="sheet-foot">${footer}</div>` : '';
  el.innerHTML = `<div class="sheet ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><div class="grow"><h2>${esc(title)}</h2>${subtitle ? `<small>${subtitle}</small>` : ''}</div>
        <button class="icon-btn plain" type="button" data-close aria-label="إغلاق">${icon('x')}</button></div>
      <form class="sheet-body" id="${formId}" autocomplete="off" novalidate>${body}<div class="sheet-msg"></div></form>
      ${foot}</div>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  const entry = { el, onClose };
  stack.push(entry);
  pushOverlayState('sheet');
  const form = el.querySelector('form');
  el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeEntry(entry)));
  el.addEventListener('mousedown', (e) => { if (e.target === el) closeEntry(entry); });
  if (onInput) { form.addEventListener('input', () => onInput(form)); form.addEventListener('change', () => onInput(form)); onInput(form); }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const btn = el.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    const msgBox = form.querySelector('.sheet-msg');
    msgBox.innerHTML = '';
    try {
      const result = await onSubmit(form);
      if (result === false) { if (btn) btn.disabled = false; return; }
      await closeEntry(entry);
      const msg = typeof result === 'string' ? result : result?.toast;
      if (msg) toast(msg);
      if (result?.go) navigate(result.go);
    } catch (err) {
      msgBox.innerHTML = `<div class="msg">${icon('alert')}<span>${esc(err.message)}</span></div>`;
      msgBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (btn) btn.disabled = false;
    }
  });
  onMount?.(form, el);
  return { form, el, close: () => closeEntry(entry) };
}

export function confirmSheet({ title, message, confirm = 'تأكيد', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    sheet({
      title, body: `<p>${message}</p>`, submit: confirm, danger,
      onSubmit: () => { done = true; resolve(true); },
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && stack.length) closeSheet(); });

// ---------- misc helpers ----------
export const field = (form, name) => (form.elements[name]?.value ?? '').trim();
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Images are shrunk on the phone before upload: receipts and logos rarely need more than ~1000px.
export async function fileToDataUrl(file, { max = 1100, type = 'image/jpeg', quality = 0.82 } = {}) {
  if (!file) return '';
  if (file.type === 'image/svg+xml') {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(type, quality);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('تم النسخ'); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
    ta.remove();
    toast(ok ? 'تم النسخ' : 'تعذّر النسخ', { error: !ok });
    return ok;
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const empty = (iconName, title, text = '', action = '') =>
  `<div class="empty"><span class="tile">${icon(iconName)}</span><b>${title}</b>${text ? `<span>${text}</span>` : ''}${action}</div>`;

export const skeleton = (rows = 3, h = 84) => `<div class="list">${Array.from({ length: rows }, () => `<div class="skel" style="height:${h}px"></div>`).join('')}</div>`;

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

// Tell the shell that data changed (reloads the open page, badges and wallet).
export const changed = (detail = {}) => window.dispatchEvent(new CustomEvent('app:changed', { detail }));

// Navigate from inside a sheet: close the sheets first so their history entries do not undo the navigation.
export async function go(hash) {
  await closeAllSheets();
  navigate(hash);
}
