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
  if (r.status >= 400) throw new QuickLineError(`QuickLine: رُفض الطلب (${r.status})${r.text ? ` — ${r.text}` : ''}`, { refused: true });
  return r;
}

const gbOf = (s) => { const m = /(\d+(?:\.\d+)?)\s*(?:جيجا|جبجا|GB|G\b)/i.exec(s); return m ? Number(m[1]) : null; };
const money = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);

// ---------- reading ----------
async function companies(creds) {
  const { data } = await api(creds, 'GET', 'Companies/GetDealerCompanies');
  return Array.isArray(data) ? data : [];
}

// Everything on offer, as one entry per package and duration. A duration other than 30 days is priced as that many
// 30-day units, the way the portal charges a repeated extension; the manager approves every price before it sells.
async function catalog(creds) {
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
      for (const days of DURATIONS) {
        if (days === 7 && Number(co.id) === NO_WEEK_COMPANY) continue;
        const units = days / 30;
        out.push({
          ref: `ql:${pkg.id}:${days}`,
          newRef: `qln:${pkg.id}:${days}`,
          kind: 'card',
          company: co.name,
          companyId: co.id,
          packageId: pkg.id,
          days,
          name: DURATIONS.length > 1 && days !== 30 ? `${name} — ${days} يوم` : name,
          agentPrice: Math.round(cost * units * 100) / 100,
          customerPrice: money(row.prices?.pricePerCustomer),
          dataGb: pkg.gb ?? gbOf(name),
          minutes: pkg.minutes ?? null,
          sms: pkg.sms ?? null,
          description: [pkg.isOffer && pkg.offer?.title ? pkg.offer.title : '', pkg.gb ? `${pkg.gb} جيجا` : '']
            .filter(Boolean).join(' · ').slice(0, 300),
        });
      }
    }
  }
  return out;
}

// The dealer's lines, so a number can be turned into the subscription id an extension needs.
async function subscriptions(creds) {
  const { data } = await api(creds, 'POST', 'Subscriptions/DealersGetAllDT', {
    draw: 1, start: 0, length: 5000, search: { value: '', regex: false }, order: [], columns: [],
  });
  return (data?.data || []).map((r) => ({
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

// Phone numbers in the portal's 10-digit local form (05XXXXXXXX).
function localNumber(n) {
  let d = String(n).replace(/\D/g, '');
  if (d.startsWith('972')) d = `0${d.slice(3)}`;
  return /^0\d{9}$/.test(d) ? d : null;
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
};
