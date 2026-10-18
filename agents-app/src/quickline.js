'use strict';
// quicklinecrm.com client. Unlike art-topup this portal has a real JSON API (the site itself is a single page that
// calls it), so this signs in once for a JWT and then calls the same endpoints the site's pages call:
// Account/Login, Companies/GetDealerCompanies, Packages/GetPackagesByCompany/<id>, Subscriptions/DealersGetAllDT
// and Subscriptions/Renew.
//
// What can be sold here is not a card: the portal keeps subscriptions (lines).
//   renewal  (ref ql:<packageId>:<days>)  — extends a line the dealer already has. Carried out automatically.
//   new line (ref qln:<packageId>:<days>) — activating a new subscription. Needs a customer and a SIM, so it stays
//                                           a request for the manager, like art-topup's invoices.
const BASE = process.env.QL_BASE || 'https://api.quicklinecrm.com';
const TIMEOUT_MS = 30_000;
// Durations the portal offers for an extension (its own duration list). 7 days is not offered for company 7 (We4g).
const DURATIONS = (process.env.QL_DURATIONS || '30').split(',').map(Number).filter((n) => [7, 30, 60, 90].includes(n));
const NO_WEEK_COMPANY = 7;

// refused: the API answered and declined (an HTTP 4xx), so nothing was carried out and nothing was charged.
// Without it the request may have arrived or not — the caller must never assume either way.
class QuickLineError extends Error {
  constructor(message, { refused = false } = {}) {
    super(message);
    this.refused = refused;
  }
}

const session = { key: '', jwt: '' };

async function request(method, route, { body, jwt } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api/${route}`, {
      method,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Language: 'ar',
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new QuickLineError(`QuickLine: تعذّر الاتصال (${e.name === 'TimeoutError' ? 'انتهى الوقت' : e.message})`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (res.status >= 500) throw new QuickLineError(`QuickLine: خطأ في الخادم (${res.status})`);
  // The API answers errors with a plain string body, which the site shows as-is.
  return { status: res.status, data, text: text.slice(0, 300) };
}

async function login({ user, pass }) {
  if (!user || !pass) throw new QuickLineError('أدخل بريد QuickLine وكلمة المرور في الإعدادات');
  session.jwt = '';
  session.key = '';
  const r = await request('POST', 'Account/Login', { body: { email: user, password: pass } });
  if (r.status === 401 || r.status === 400) throw new QuickLineError('QuickLine: البريد أو كلمة المرور خاطئة');
  if (r.status >= 400) throw new QuickLineError(`QuickLine: تعذّر تسجيل الدخول (${r.status}) ${r.text}`);
  // 202 means the portal wants a verification code sent to the phone: it cannot be answered by the server.
  if (r.data?.statusCode === 202) throw new QuickLineError('QuickLine: الحساب يطلب رمز تحقق عند الدخول. أوقف التحقق بخطوتين لهذا الحساب لتعمل الأتمتة.');
  const jwt = r.data?.data?.jwt;
  if (!jwt) throw new QuickLineError('QuickLine: لم يرجع الخادم رمز دخول');
  session.jwt = jwt;
  session.key = `${user}\n${pass}`;
  return r.data.data; // { jwt, userId, type, name, email, roleId, … }
}

// Calls the API signed in, signing in first (or again when the token expired).
async function api(creds, method, route, body) {
  if (session.key !== `${creds.user}\n${creds.pass}`) await login(creds);
  let r = await request(method, route, { body, jwt: session.jwt });
  if (r.status === 401 || r.status === 403) {
    await login(creds);
    r = await request(method, route, { body, jwt: session.jwt });
  }
  if (r.status >= 400) throw new QuickLineError(refusal(r.status, r.text), { refused: true });
  return r;
}

// A refusal in plain words and what to do, with QuickLine's own words kept in brackets for checking there.
const REFUSALS = [
  [/استعمال|مستعمل|مستخدم|used|בשימוש/i, 'الرقم أو الشريحة مستعملان من قبل في QuickLine — جرّب شريحة أو رقماً آخر'],
  [/رصيد|credit|balance|יתרה/i, 'رصيد حسابك في QuickLine لا يكفي — اشحن الرصيد هناك ثم نفّذ الطلب'],
  [/غير موجود|not found|לא נמצא/i, 'غير موجود في QuickLine'],
  [/شريحة|sim/i, 'QuickLine لم يقبل الشريحة — تأكد من رقمها'],
];
function refusal(status, text) {
  const said = String(text || '').replace(/^"|"$/g, '').trim();
  const known = REFUSALS.find(([re]) => re.test(said))?.[1]
    || (status === 401 || status === 403 ? 'QuickLine رفض صلاحية الحساب — تأكد من بريد QuickLine وكلمة المرور في الإعدادات' : 'QuickLine رفض الطلب');
  return said ? `${known} (QuickLine: ${said.slice(0, 160)})` : known;
}

const gbOf = (s) => { const m = /(\d+(?:\.\d+)?)\s*(?:جيجا|جبجا|GB|G\b)/i.exec(s); return m ? Number(m[1]) : null; };
const money = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);

// ---------- reading ----------
async function companies(creds) {
  const { data } = await api(creds, 'GET', 'Companies/GetDealerCompanies');
  return Array.isArray(data) ? data : [];
}

const round2 = (n) => Math.round(n * 100) / 100;

// Everything on offer for one system.
//   card (extension): the line's regular monthly price (prices.cost), one entry per duration; a duration other than
//     30 days is priced as that many 30-day units, the way the portal charges a repeated extension.
//   invoice (new line): one entry per package. An offer package opens for its offer period at its offer price
//     (prices.costOffer for offer.months × 30 days) — the portal's own form fixes that duration — others for 30 days.
// Each entry carries the company's SIM rule (prefix and length) the portal checks when a line is activated.
async function catalog(creds, kind = 'card') {
  const list = await companies(creds);
  if (!list.length) throw new QuickLineError('QuickLine: لم أجد شركات لهذه الوكالة');
  const out = [];
  for (const co of list) {
    const { data } = await api(creds, 'GET', `Packages/GetPackagesByCompany/${encodeURIComponent(co.id)}`);
    for (const row of Array.isArray(data) ? data : []) {
      const pkg = row.package || {};
      const cost = money(row.prices?.cost);
      if (!pkg.id || !pkg.name || cost === null) continue;
      const name = String(pkg.name).replace(/\s+/g, ' ').trim();
      const base = {
        company: co.name,
        companyId: co.id,
        packageId: pkg.id,
        postalCode: String(co.postalCode || ''),
        simLength: Number(co.simLength) || null,
        customerPrice: money(row.prices?.pricePerCustomer),
        dataGb: pkg.gb ?? gbOf(name),
        minutes: pkg.minutes ?? null,
        sms: pkg.sms ?? null,
        description: [pkg.isOffer && pkg.offer?.title ? pkg.offer.title : '', pkg.gb ? `${pkg.gb} جيجا` : '']
          .filter(Boolean).join(' · ').slice(0, 300),
      };
      if (kind === 'invoice') {
        const offerMonths = pkg.isOffer ? Number(pkg.offer?.months) || 0 : 0;
        const days = offerMonths ? offerMonths * 30 : 30;
        const price = offerMonths ? money(row.prices?.costOffer) ?? cost : cost;
        out.push({ ...base, ref: `qln:${pkg.id}:${days}`, kind: 'invoice', days, name, agentPrice: round2(price) });
        continue;
      }
      for (const days of DURATIONS) {
        if (days === 7 && Number(co.id) === NO_WEEK_COMPANY) continue;
        out.push({
          ...base,
          ref: `ql:${pkg.id}:${days}`,
          kind: 'card',
          days,
          name: DURATIONS.length > 1 && days !== 30 ? `${name} — ${days} يوم` : name,
          agentPrice: round2(cost * (days / 30)),
        });
      }
    }
  }
  return out;
}

// Free numbers QuickLine offers for a package, ten at a time; exclude holds the ids already shown.
// An eSIM number comes with its eSIM (sim) and the QR code to install it (barcodeImage, base64 PNG).
async function freeNumbers(creds, { packageId, exclude = [], esim = false }) {
  const { data } = await api(creds, 'POST', 'Numbers/GetFreeNumbers', { packageId: Number(packageId), Numbers: exclude.map(String), isEsim: !!esim });
  return (Array.isArray(data) ? data : []).filter((n) => n.id && n.phone)
    .map((n) => ({ id: Number(n.id), phone: String(n.phone).replace(/\D/g, ''), sim: String(n.sim || ''), qr: n.barcodeImage || '' }));
}

// What is wrong with a SIM for a company's rule, or '' when it fits. The portal takes the full ICCID (check digit
// included) and checks it starts with the company's prefix and has exactly its length.
function simProblem(iccid, { postalCode, simLength, company }) {
  const d = String(iccid || '').replace(/\D/g, '');
  if (!postalCode || !simLength) return '';
  if (!d.startsWith(postalCode) || d.length !== simLength) {
    return `شريحة ${company || 'هذه الشركة'} يجب أن تكون ${simLength} رقماً وتبدأ بـ ${postalCode} (المُدخلة ${d.length} رقماً)`;
  }
  return '';
}

// QuickLine asks for a first name (required) and a last name.
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

// Today in Israel, as the portal's form fills its start date (DD/MM/YYYY).
const israelDate = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem' }).format(new Date());

// Activates a subscription, the way the portal's «اشتراك جديد» form does:
//   type newSubscription — a number from the pool (numberId) on a physical SIM
//   type newEsimSubscription — a number from the eSIM pool, whose own eSIM is the SIM
//   type neyod — porting the customer's number (phone) from another company (oldCompany)
// The SIM is sent without the company prefix, which the portal adds back.
async function newSubscription(creds, { type, packageId, days, numberId = null, phone = null, oldCompany = null, sim, rule, customerName, customerPrice }) {
  const { firstName, lastName } = splitName(customerName);
  const customer = { firstName, lastName, email: '', number: '', city: '', zip: '' };
  const body = {
    packageId: String(packageId),
    ...customer,
    startDate: israelDate(),
    daysValues: Number(days),
    customerPrice: Number(customerPrice) || 0,
    automaticRenew: false,
    constantRenewal: false,
    simNumber: String(sim).replace(/\D/g, '').slice(rule.postalCode.length),
    notes: '',
    newSubscriptionType: type,
    oldCompany: type === 'neyod' ? Number(oldCompany) : null,
    phone: type === 'neyod' ? String(phone) : null,
    numberId: type === 'neyod' ? null : String(numberId),
    customer,
  };
  const r = await api(creds, 'POST', 'Subscriptions/NewSubscription', body);
  return { ok: r.status < 300, text: r.text || '' };
}

// The dealer's lines, so a number can be turned into the subscription id an extension needs.
// Read page by page until every line QuickLine counts is in, so a number is never missed because a page was capped.
async function subscriptions(creds) {
  const rows = [];
  for (let page = 0; page < 50; page++) {
    const { data } = await api(creds, 'POST', 'Subscriptions/DealersGetAllDT', {
      draw: page + 1, start: rows.length, length: 1000, search: { value: '', regex: false }, order: [], columns: [],
    });
    const got = Array.isArray(data?.data) ? data.data : [];
    rows.push(...got);
    const total = Number(data?.recordsFiltered ?? data?.recordsTotal);
    if (!got.length || !(total > rows.length)) break;
  }
  return rows.map((r) => ({
    id: r.subscription?.id,
    number: String(r.subscription?.phoneNumber || '').replace(/\D/g, ''),
    sim: r.subscription?.simNumber || '',
    company: r.company?.name || '',
    companyId: r.company?.id ?? null,
    packageId: r.package?.id ?? null,
    packageName: r.package?.name || '',
    status: r.status?.name || '',
    statusValue: r.status?.valueInt ?? null,
    canExtend: !!r.actions?.canExtend,
    daysLeft: r.daysLeft?.value ?? null,
    cutDate: r.cutDate || '',
    customer: r.customer?.name || '',
  })).filter((s) => s.id && s.number);
}

// The one line behind a phone number. A number may appear more than once over time, so the active one wins.
async function findSubscription(creds, number) {
  const want = localNumber(number);
  if (!want) return null;
  const all = await subscriptions(creds);
  const mine = all.filter((s) => s.number === want);
  return mine.find((s) => s.canExtend) || mine.find((s) => s.statusValue === 2) || mine[0] || null;
}

async function balance(creds) {
  const { data } = await api(creds, 'GET', 'Home/GetHomePageData');
  return money(data?.credit);
}

async function homeData(creds) {
  const { data } = await api(creds, 'GET', 'Home/GetHomePageData');
  return {
    active: data?.activeSubscriptions ?? null,
    inactive: data?.inActiveSubscriptions ?? null,
    openPayments: money(data?.openPayments),
    credit: money(data?.credit),
  };
}

// ---------- selling ----------
// Extends one subscription. The portal answers with a plain message and the charge appears on the dealer's bills,
// so the result is read back from the subscription itself (its cut date moves) rather than from an operations list.
async function renew(creds, { subscriptionId, days }) {
  if (!subscriptionId) throw new QuickLineError('QuickLine: لا يوجد اشتراك لهذا الرقم');
  if (!DURATION_OK(days)) throw new QuickLineError(`QuickLine: مدة غير مقبولة (${days})`);
  const r = await api(creds, 'POST', 'Subscriptions/Renew', { subscriptionId: Number(subscriptionId), days: Number(days) });
  return { ok: r.status < 300, text: r.text || '' };
}
const DURATION_OK = (d) => [7, 30, 60, 90].includes(Number(d));

// ---------- a line's state ----------
// The portal's line actions: a final disconnect (status 4), a temporary one (status 6), and back to active (2).
// cutNoReceive: true also stops incoming calls, as the portal does unless «קבלת שיחות» is ticked.
const STATUS = { active: 2, closed: 4, paused: 6 };
async function closeNumber(creds, subscriptionId) {
  await api(creds, 'POST', 'Subscriptions/CloseNumber', { subscriptionId: Number(subscriptionId), cutNoReceive: true });
}
async function pauseNumber(creds, subscriptionId) {
  await api(creds, 'POST', 'Subscriptions/PauseNumber', { subscriptionId: Number(subscriptionId), cutNoReceive: true });
}
async function activateNumber(creds, subscriptionId) {
  await api(creds, 'POST', `Subscriptions/ActivateNumber/${encodeURIComponent(subscriptionId)}`, {});
}
// A new SIM for a line; like an activation, it goes without the company prefix.
async function changeSim(creds, subscriptionId, iccid, rule) {
  await api(creds, 'POST', 'Subscriptions/ChangeSim', {
    subscriptionId: Number(subscriptionId), simNumber: String(iccid).replace(/\D/g, '').slice(rule.postalCode.length),
  });
}

// Phone numbers in the portal's 10-digit local form (05XXXXXXXX).
function localNumber(n) {
  let d = String(n).replace(/\D/g, '');
  if (d.startsWith('972')) d = `0${d.slice(3)}`;
  return /^0\d{9}$/.test(d) ? d : null;
}

// Who supplies a package, from its ref: art-topup (ic:/pb:/pc:/inv:), QuickLine (ql:/qln:, with its package id there),
// or nobody (typed by the manager).
function supplierOfRef(ref) {
  const r = String(ref || '');
  if (/^(ic|pb|pc|inv):/.test(r)) return { supplier: 'art', qlPackage: null };
  // Layan: its package id (a GUID) plays the part of QuickLine's package number.
  const l = /^lyn?:([0-9a-f-]{36}):/i.exec(r);
  if (l) return { supplier: 'ly', qlPackage: l[1] };
  const m = /^qln?:(\d+):/.exec(r);
  return m ? { supplier: 'ql', qlPackage: Number(m[1]) } : { supplier: '', qlPackage: null };
}

// Which package may extend a line. A QuickLine line is extended there on its own package (QuickLine renews that one
// and charges its price), so only that package's extension (ql:<same id>:) fits; an art-topup line takes no QuickLine
// package; and a new-line package (qln:) never extends anything. Returns '' when it fits, else why not.
function renewalProblem(lineRef, pkgRef) {
  const line = supplierOfRef(lineRef);
  const pkg = supplierOfRef(pkgRef);
  // Seen by agents: says what to do, never who activates the line.
  if (/^(qln|lyn):/.test(String(pkgRef || ''))) return 'هذه رزمة تفعيل خط جديد، وليست للتمديد';
  // A QuickLine or Layan line is extended there, on its own package: only that package's extension fits.
  if (['ql', 'ly'].includes(line.supplier) && !(pkg.supplier === line.supplier && pkg.qlPackage === line.qlPackage)) {
    return 'لا يمكن تمديد هذا الخط بهذه الرزمة: اختر رزمة التمديد الخاصة به';
  }
  // A line from another supplier is not extended by QuickLine or Layan (a line typed by hand may be: an older customer).
  if (line.supplier && line.supplier !== pkg.supplier && ['ql', 'ly'].includes(pkg.supplier)) return 'لا يمكن تمديد هذا الخط بهذه الرزمة: اختر كرتاً آخر';
  return '';
}

// Which system a package ref belongs to: ql: an extension (sold automatically), qln: a new line (manager's request).
const refKind = (ref) => (/^ql:/.test(ref) ? 'card' : /^qln:/.test(ref) ? 'invoice' : null);
const parseRef = (ref) => {
  const m = /^(ql|qln):(\d+):(\d+)$/.exec(String(ref));
  return m ? { system: m[1], packageId: Number(m[2]), days: Number(m[3]) } : null;
};

module.exports = {
  QuickLineError, DURATIONS, login, api, companies, catalog, subscriptions, findSubscription,
  balance, homeData, renew, localNumber, refKind, parseRef, gbOf,
  freeNumbers, simProblem, splitName, newSubscription, STATUS, closeNumber, pauseNumber, activateNumber, changeSim,
  supplierOfRef, renewalProblem,
};
