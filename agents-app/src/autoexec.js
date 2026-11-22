'use strict';
// Activates the eSIMs sold in the shop (tasks of type 'esim', see sale.js) at their supplier, for companies set to "auto":
//   QuickLine  — a new eSIM line on one of its free numbers (refs qln:), proven by the new subscription.
//   Layan      — a new eSIM on one of its free numbers (refs lyn:), with its QR code.
//   telecom    — a new ALOHA eSIM (refs tcn:).
//   Aylol      — one of its ready eSIMs (ay:esim:), or a new line as an eSIM (ay:bill:).
// Money safety: a request is sent at most once (claimed with auto_status). Anything unclear (no answer, rejected,
// no sign it took effect) leaves the task open for the manager, who checks the supplier before acting.
const { q, tx, getSettings, qlCredentials, aylolCredentials, lyCredentials, tcCredentials } = require('./db');
const aylol = require('./aylol');
const { now } = require('./util');
const D = require('./domain');
const ql = require('./quickline');
const ly = require('./layan');
const tc = require('./telecom');
const { resolveTask } = require('./routes/tasks');

const ACTOR = { id: null, name: 'تلقائي', role: 'admin' };
const QL_ACTOR = { id: null, name: 'QuickLine (تلقائي)', role: 'admin' };
const LY_ACTOR = { id: null, name: 'ليان (تلقائي)', role: 'admin' };
const TC_ACTOR = { id: null, name: 'telecom (تلقائي)', role: 'admin' };
const AY_ACTOR = { id: null, name: 'أيلول (تلقائي)', role: 'admin' };
const CHECK_MS = Number(process.env.ART_CHECK_MS) || 15_000; // first look at the supplier after sending
const GIVE_UP_MS = 30 * 60_000; // still not finished after this: hand over to the manager
const LOOP_MS = Number(process.env.ART_LOOP_MS) || 30_000;
const PICKUP_MS = 10 * 60_000; // the loop only sends requests younger than this (e.g. after a restart)
const STUCK_MS = 10 * 60_000; // a send still "sending" after this was interrupted (a send takes well under a minute)

const setAuto = (id, status, note, extra = {}) => q(`UPDATE tasks SET auto_status = ?, auto_note = ?${extra.ref !== undefined ? ', auto_ref = ?' : ''} WHERE id = ?`)
  .run(status, note, ...(extra.ref !== undefined ? [extra.ref] : []), id);
const tellManager = (title, body) => D.notify({ role: 'admin', kind: 'task', title, body, link: '#/tasks' });

// QuickLine could not be reached before anything was sent. That is safe to try again, so a fresh task goes back to
// the sweep (claimed again, sent at most once); one past the pickup window goes to the manager.
function notSentYet(t, taskId, e, title) {
  if (now() - t.created_at < PICKUP_MS - LOOP_MS) {
    setAuto(taskId, '', `لم يُرسل بعد (${e.message}) — يُعاد المحاولة تلقائياً`);
    return;
  }
  setAuto(taskId, 'failed', `لم يُرسل: ${e.message}`);
  tellManager(title, `${t.number || ''} ${e.message}`.trim());
}

// The package and number behind an open eSIM activation, or null when no supplier carries it out (the manager does).
function job(taskId) {
  const t = q("SELECT * FROM tasks WHERE id = ? AND status = 'open' AND type = 'esim'").get(taskId);
  if (!t || !t.line_id) return null;
  const line = q('SELECT number, package_id, sim, customer_name, customer_price FROM lines WHERE id = ?').get(t.line_id);
  if (!line) return null;
  const p = q(`SELECT p.art_card_id, p.cost, p.art_price, p.supplier_company, c.activation FROM packages p JOIN companies c ON c.id = p.company_id WHERE p.id = ?`).get(line.package_id);
  if (!p || p.activation !== 'auto') return null;
  // An Aylol bill line of a company whose order form is not known yet: carried out automatically only for a shop order
  // the site sells so; otherwise the manager carries it out.
  if (/^ay:bill:/.test(p.art_card_id || '') && !aylol.billAuto(p.art_card_id, p.supplier_company)) {
    const fromShop = !!q('SELECT 1 FROM shop_orders WHERE line_id = ?').get(t.line_id);
    if (!(fromShop && aylol.billShop(p.art_card_id, p.supplier_company))) return null;
  }
  const ref = p.art_card_id || '';
  const supplier = /^qln:/.test(ref) ? 'qln' : /^lyn:/.test(ref) ? 'lye' : /^tcn:/.test(ref) ? 'tce' : /^ay:(esim|bill):/.test(ref) ? 'ay' : null;
  if (!supplier) return null;
  // The supplier is paid its own current price, never the cost the manager may have typed.
  return { t, supplier, line, number: line.number, ref, price: p.art_price ?? p.cost };
}

// Finishes a task as carried out by a supplier.
function finish(taskId, note, reply, actor = ACTOR, extra = {}) {
  tx(() => {
    // Another check may have finished it meanwhile.
    const fresh = q("SELECT * FROM tasks WHERE id = ? AND status = 'open' AND auto_status IN ('sending','sent')").get(taskId);
    if (!fresh) return;
    // The supplier's details stay in auto_note, for the manager.
    resolveTask(fresh, actor, { ...extra, status: 'done', response: reply || 'نُفّذ تلقائياً' });
    setAuto(taskId, 'done', note);
  });
}

async function send(taskId) {
  const j = job(taskId);
  if (!j) return;
  const s = getSettings();
  const ready = { qln: s.qlConfigured, lye: s.lyConfigured, tce: s.tcReady, ay: s.aylolConfigured }[j.supplier];
  if (!ready) return;
  // Claim it: only one sender, only once.
  if (!q("UPDATE tasks SET auto_status = 'sending', auto_at = ? WHERE id = ? AND status = 'open' AND auto_status = ''").run(now(), taskId).changes) return;
  if (j.supplier === 'qln') return sendQlNew(taskId, j);
  if (j.supplier === 'lye') return sendLyEsim(taskId, j);
  if (j.supplier === 'tce') return sendTcEsim(taskId, j);
  return sendAy(taskId, j);
}

// ---------- Layan: a new eSIM line on one of its free numbers ----------
// Nothing is sent when Layan's price for the package is above the approved one, or when Layan has no eSIM for the
// number (taken meanwhile). Layan's answer is the proof: done at once (the QR code is the eSIM's, read before), or —
// for a company that makes its eSIM later — followed until its QR code is ready. Without a QR code the task stays with
// the manager, who attaches it.
async function sendLyEsim(taskId, j) {
  const fail = (note) => { setAuto(taskId, 'failed', note); tellManager('تعذّر تفعيل eSIM التلقائي', `${j.number}: ${note}`); };
  const number = ly.localNumber(j.number);
  const ref = ly.parseRef(j.ref);
  if (!number || !ref) { setAuto(taskId, 'failed', 'ناقصة بيانات ليان لهذا الخط — نفّذه يدوياً'); return undefined; }
  const creds = lyCredentials();
  let pkg;
  let esim;
  try {
    pkg = (await ly.catalog(creds, 'invoice')).find((c) => c.ref === j.ref);
    if (pkg) esim = await ly.emptyEsim(creds, ref.packageId, number);
  } catch (e) {
    if (e.refused) return fail(`رفض ليان تفعيل eSIM: ${e.message}`);
    return notSentYet({ ...j.t, number }, taskId, e, 'تعذّر تفعيل eSIM التلقائي');
  }
  if (!pkg) return fail('الرزمة لم تعد عند ليان بهذه المدة — زامن ليان ثم نفّذه يدوياً أو ارفضه');
  if (pkg.agentPrice > Number(j.price) + 0.01) return fail(`سعر ليان الآن ${pkg.agentPrice} ₪ وهو أعلى من المعتمد ${j.price} ₪ — زامن ليان وراجع السعر، ثم نفّذه يدوياً أو ارفضه`);
  if (!esim?.sim) return fail('ليان لم يعطِ eSIM لهذا الرقم (ربما أُخذ) — اختر رقماً آخر في ليان أو ارفض الطلب');
  let qr = '';
  try { qr = await ly.imageDataUrl(esim.qrUrl); } catch (e) { console.error('layan esim qr', e.message); }
  const before = { lye: true, number, sim: esim.sim };
  let r;
  try {
    r = await ly.newEsimLine(creds, {
      packageId: ref.packageId, number, sim: esim.sim, customerName: j.line.customer_name, price: j.line.customer_price ?? pkg.agentPrice, days: ref.days, saleId: ref.saleId,
    });
  } catch (e) {
    if (e.refused) {
      setAuto(taskId, 'failed', `رفض ليان تفعيل eSIM: ${e.message}`, { ref: JSON.stringify(before) });
      tellManager('رفض ليان تفعيل eSIM', `${number}: ${e.message}. نفّذه يدوياً أو ارفضه.`);
      return undefined;
    }
    setAuto(taskId, 'unknown', `انقطع الاتصال أثناء الإرسال (${e.message}). افحص ليان قبل أي تنفيذ يدوي.`, { ref: JSON.stringify(before) });
    tellManager('تفعيل eSIM تلقائي غير مؤكد', `${number}: افحص ليان قبل التنفيذ`);
    return undefined;
  }
  // The eSIM is the line's SIM.
  q('UPDATE lines SET sim = ? WHERE id = ?').run(esim.sim, j.t.line_id);
  if (r.asyncActionId) {
    setAuto(taskId, 'sent', `أُرسل تفعيل eSIM إلى ليان — بانتظار أن تجهّز الشركة الـ eSIM (${pkg.agentPrice} ₪)`, { ref: JSON.stringify({ ...before, asyncActionId: r.asyncActionId }) });
    later(taskId);
    return undefined;
  }
  if (r.esimLink) { try { qr = await ly.imageDataUrl(r.esimLink); } catch (e) { console.error('layan esim qr', e.message); } }
  setAuto(taskId, 'sent', `ليان: ${r.text || 'تم'}`, { ref: JSON.stringify(before) });
  return esimDone(taskId, number, qr, `ليان: تم تفعيل eSIM (${pkg.agentPrice} ₪)`);
}

function esimDone(taskId, number, qr, note) {
  if (qr) {
    finish(taskId, note, 'تم التفعيل', LY_ACTOR, { attachment: qr });
    return undefined;
  }
  setAuto(taskId, 'unknown', `${note}، لكن رمز QR لم يصل من ليان — خذه من ليان وأرفقه عند تنفيذ الطلب.`);
  tellManager('eSIM مفعّل بلا رمز QR', `${number}: أرفق رمز QR من ليان`);
  return undefined;
}

// A company that makes its eSIM later (Partner): Layan says when its QR code (or an activation link) is ready.
async function checkLyEsim(t, before) {
  const st = await ly.esimStatus(lyCredentials(), before.asyncActionId);
  if (/^(Pending|PendingEsimUrl)$/.test(st.status)) {
    if (now() - t.auto_at > GIVE_UP_MS) {
      setAuto(t.id, 'unknown', 'ما زالت ليان تجهّز الـ eSIM بعد 30 دقيقة. افحص هناك قبل أي تنفيذ يدوي.');
      tellManager('تفعيل eSIM تلقائي متأخر', `${before.number}: ما زال قيد التجهيز في ليان`);
    } else later(t.id);
    return;
  }
  if (st.esimLink) {
    let qr = '';
    try { qr = await ly.imageDataUrl(st.esimLink); } catch (e) { console.error('layan esim qr', e.message); }
    esimDone(t.id, before.number, qr, `ليان: eSIM جاهز (${st.status})`);
    return;
  }
  setAuto(t.id, 'unknown', st.esimUrl
    ? `ليان: eSIM جاهز برابط تفعيل وليس رمز QR — ${st.esimUrl.slice(0, 200)}. أرسله للزبون أو حوّله إلى رمز QR وأرفقه.`
    : `ليان: حالة الـ eSIM «${st.status || 'غير معروفة'}» — افحص هناك قبل أي تنفيذ يدوي.`);
  tellManager('تفعيل eSIM يحتاج تدخلك', `${before.number}: ${st.esimUrl ? 'رابط تفعيل بدل رمز QR' : st.status || 'حالة غير معروفة'}`);
}

// ---------- telecom: a new ALOHA eSIM line on one of its free numbers ----------
// Nothing is sent when the site's price for the package is above the approved one, or when the shop's registration
// address is missing. The site's answer ({ result: true, leadId }) is the proof; the QR code is drawn from the eSIM's
// activation code. Without a QR code the task stays with the manager, who attaches it.
async function sendTcEsim(taskId, j) {
  const fail = (note) => { setAuto(taskId, 'failed', note); tellManager('تعذّر تفعيل eSIM التلقائي', `${j.number}: ${note}`); };
  const number = tc.localNumber(j.number);
  const ref = tc.parseRef(j.ref);
  const job = JSON.parse(j.t.payload || '{}').tc || {};
  if (!number || !ref) { setAuto(taskId, 'failed', 'ناقصة بيانات telecom لهذا الخط — نفّذه يدوياً'); return undefined; }
  const s = getSettings();
  if (!s.tcRegReady) return fail('أدخل عنوان تسجيل خطوط eSIM (العنوان، المدينة، الرمز البريدي) في إعدادات telecom، ثم نفّذه يدوياً');
  const creds = tcCredentials();
  let pkg;
  let esim;
  try {
    pkg = (await tc.catalog(creds, 'invoice')).find((p) => p.ref === j.ref);
    if (!pkg) return fail('الرزمة لم تعد في telecom بهذه المدة — زامن telecom ثم نفّذه يدوياً أو ارفضه');
    if (pkg.cost > Number(j.price) + 0.01) return fail(`سعر telecom الآن ${pkg.cost} ₪ وهو أعلى من المعتمد ${j.price} ₪ — زامن telecom وراجع السعر، ثم نفّذه يدوياً أو ارفضه`);
    esim = await tc.takeEsim(creds);
  } catch (e) {
    if (e.refused) return fail(e.message);
    return notSentYet({ ...j.t, number }, taskId, e, 'تعذّر تفعيل eSIM التلقائي');
  }
  const before = JSON.stringify({ tce: true, number, esimId: esim.id });
  const customer = {
    name: j.line.customer_name, email: job.email || s.gmailUser || s.tcMailUser, phone: tc.localNumber(job.phone) || number,
    address: s.tcRegAddress, city: s.tcRegCity, zip: s.tcRegZip, comment: 'eSIM',
  };
  let r;
  try {
    r = await tc.newEsimLine(creds, { packageId: ref.packageId, number, esim, months: Math.max(1, Math.round(ref.days / 30)), customer });
  } catch (e) {
    if (e.refused) {
      setAuto(taskId, 'failed', `رفض telecom تفعيل eSIM: ${e.message}`, { ref: before });
      tellManager('رفض telecom تفعيل eSIM', `${number}: ${e.message}. نفّذه يدوياً أو ارفضه.`);
      return undefined;
    }
    setAuto(taskId, 'unknown', `انقطع الاتصال أثناء الإرسال (${e.message}). افحص telecom قبل أي تنفيذ يدوي.`, { ref: before });
    tellManager('تفعيل eSIM تلقائي غير مؤكد', `${number}: افحص telecom قبل التنفيذ`);
    return undefined;
  }
  q('UPDATE lines SET sim = ? WHERE id = ?').run(esim.sim, j.t.line_id);
  let qr = '';
  try { qr = await tc.qrImage(esim.code); } catch (e) { console.error('telecom esim qr', e.message); }
  setAuto(taskId, 'sent', `telecom: خط جديد #${r.leadId || ''}`, { ref: before });
  const note = `telecom: تم تفعيل eSIM — مشترك #${r.leadId || '؟'} (${pkg.cost} ₪)`;
  if (qr) { finish(taskId, note, 'تم التفعيل', TC_ACTOR, { attachment: qr, esimCode: esim.code }); return undefined; }
  setAuto(taskId, 'unknown', `${note}، لكن تعذّر رسم رمز QR — رمز التفعيل: ${esim.code.slice(0, 200)}. أرفق رمز QR عند تنفيذ الطلب.`);
  tellManager('eSIM مفعّل بلا رمز QR', `${number}: أرفق رمز QR`);
  return undefined;
}

// ---------- QuickLine: activate a new line (pool number, eSIM, or a ported number) ----------
// What proves it went through is a subscription for the number that did not exist before sending, so the ids of
// any older (disconnected) subscriptions of that number are kept and ignored.
async function sendQlNew(taskId, j) {
  const fail = (note, title) => { setAuto(taskId, 'failed', note); if (title) tellManager(title, `${j.number}: ${note}`); };
  const number = ql.localNumber(j.number);
  const ref = ql.parseRef(j.ref);
  const job = JSON.parse(j.t.payload || '{}').ql;
  if (!number || !ref || !job) return fail('ناقصة بيانات QuickLine لهذا الخط — نفّذه يدوياً');
  const creds = qlCredentials();
  let pkg;
  let known;
  try {
    pkg = (await ql.catalog(creds, 'invoice')).find((x) => x.packageId === ref.packageId);
    known = (await ql.subscriptions(creds)).filter((s) => s.number === number);
  } catch (e) {
    // Nothing was sent yet.
    return notSentYet({ ...j.t, number }, taskId, e, 'تعذّر التفعيل التلقائي');
  }
  if (!pkg) return fail('الرزمة لم تعد موجودة في QuickLine — نفّذه يدوياً أو ارفضه', 'تعذّر التفعيل التلقائي');
  // An offer's duration is fixed by QuickLine; if it changed since the sale, the customer paid for something else.
  if (pkg.ref !== j.ref) return fail(`تغيّرت مدة هذه الرزمة في QuickLine (${pkg.days} يوماً) — زامن «خطوط QuickLine» ثم نفّذه يدوياً`, 'تعذّر التفعيل التلقائي');
  // Never activate a number twice: a live subscription for it means someone already did.
  const live = known.find((s) => s.statusValue !== 4);
  if (live) {
    setAuto(taskId, 'unknown', `الرقم ${number} موجود في QuickLine (${live.status}، اشتراك #${live.id}). افحصه هناك قبل أي تنفيذ يدوي.`);
    tellManager('تفعيل تلقائي غير مؤكد', `${number}: موجود مسبقاً في QuickLine`);
    return undefined;
  }
  const problem = ql.simProblem(j.line.sim, pkg);
  if (problem) return fail(problem, 'تعذّر التفعيل التلقائي');
  const before = JSON.stringify({ new: true, number, known: known.map((s) => s.id) });
  try {
    await ql.newSubscription(creds, {
      type: job.type, packageId: ref.packageId, days: ref.days, numberId: job.numberId, phone: number, oldCompany: job.oldCompany,
      sim: j.line.sim, rule: pkg, customerName: j.line.customer_name, customerPrice: j.line.customer_price ?? pkg.customerPrice,
    });
  } catch (e) {
    if (e.refused) {
      // QuickLine answered and declined: nothing was activated and nothing was charged.
      setAuto(taskId, 'failed', `رفض QuickLine التفعيل: ${e.message}`, { ref: before });
      tellManager('رفض QuickLine التفعيل', `${number}: ${e.message}. نفّذه يدوياً أو ارفضه.`);
      return undefined;
    }
    setAuto(taskId, 'unknown', `انقطع الاتصال أثناء الإرسال (${e.message}). افحص QuickLine قبل أي تنفيذ يدوي.`, { ref: before });
    tellManager('تفعيل تلقائي غير مؤكد', `${number}: افحص QuickLine قبل التنفيذ`);
    return undefined;
  }
  setAuto(taskId, 'sent', `أُرسل التفعيل إلى QuickLine (${{ newSubscription: 'خط جديد', newEsimSubscription: 'eSIM', neyod: 'تحويل رقم' }[job.type]})`, { ref: before });
  later(taskId);
  return undefined;
}

// Finishes the activation once QuickLine shows a new subscription for the number. An eSIM gets its QR code.
async function checkQlNew(t, before) {
  const line = q('SELECT number FROM lines WHERE id = ?').get(t.line_id);
  const subs = await ql.subscriptions(qlCredentials());
  const sub = subs.find((s) => s.number === before.number && !(before.known || []).includes(s.id));
  if (sub) {
    const job = JSON.parse(t.payload || '{}').ql || {};
    const extra = t.type === 'esim' && job.qr ? { attachment: `data:image/png;base64,${job.qr}` } : {};
    finish(t.id, `QuickLine: تم التفعيل — اشتراك #${sub.id} (${sub.status})`, 'تم التفعيل', QL_ACTOR, extra);
    return;
  }
  if (now() - t.auto_at > GIVE_UP_MS) {
    setAuto(t.id, 'unknown', 'لم يظهر الخط في QuickLine بعد 30 دقيقة. افحص هناك قبل أي تنفيذ يدوي.');
    tellManager('تفعيل تلقائي غير مؤكد', `${line?.number}: لم يظهر الخط في QuickLine`);
  } else {
    later(t.id);
  }
}

const later = (taskId) => setTimeout(() => check(taskId).catch((e) => console.error('auto check', e)), CHECK_MS).unref?.();

// Looks at what the supplier did with the request sent for this task, and finishes the task once it is through.
async function check(taskId) {
  const t = q("SELECT * FROM tasks WHERE id = ? AND status = 'open' AND auto_status = 'sent'").get(taskId);
  if (!t) return;
  // auto_ref holds JSON: what the supplier showed before sending.
  let before;
  try { before = JSON.parse(t.auto_ref || '{}'); } catch { before = {}; }
  if (before.lye) return checkLyEsim(t, before);
  if (before.new) return checkQlNew(t, before);
}

// New sale requests are sent right after their transaction commits.
D.events.on('sale-task', (id) => setImmediate(() => send(id).catch((e) => console.error('auto send', e))));

// Safety net: follow up sent requests, and send fresh ones missed (e.g. the server restarted in between).
let busy = false;
async function sweep() {
  const s = getSettings();
  if (busy || !(s.qlConfigured || s.lyConfigured || s.tcReady || s.aylolConfigured)) return;
  busy = true;
  try {
    // A send interrupted midway (e.g. the server restarted) may or may not have reached the supplier: never resend it,
    // tell the manager to check there.
    for (const t of q("SELECT t.id, l.number FROM tasks t LEFT JOIN lines l ON l.id = t.line_id WHERE t.status = 'open' AND t.auto_status = 'sending' AND t.auto_at < ?")
      .all(now() - STUCK_MS)) {
      setAuto(t.id, 'unknown', 'انقطع الإرسال قبل أن يُعرف إن وصل إلى المورّد. افحصه هناك قبل أي تنفيذ يدوي.');
      tellManager('تنفيذ تلقائي غير مؤكد', `${t.number || ''}: افحص المورّد قبل التنفيذ`);
    }
    for (const { id } of q("SELECT id FROM tasks WHERE status = 'open' AND auto_status = 'sent' AND type = 'esim'").all()) await check(id).catch((e) => console.error('auto check', e));
    for (const { id } of q("SELECT id FROM tasks WHERE status = 'open' AND auto_status = '' AND type = 'esim' AND created_at > ?").all(now() - PICKUP_MS)) {
      await send(id).catch((e) => console.error('auto send', e));
    }
  } finally {
    busy = false;
  }
}
setInterval(() => { sweep().catch((e) => console.error('auto sweep', e)); }, LOOP_MS).unref();


// ---------- Aylol: an eSIM, or a new line as an eSIM ----------
// The order goes to aylol-telecom.com once the customer's payment is verified. A new line without a number gets
// one of the site's ready numbers there. An eSIM's QR code is drawn from its real activation code; without one the
// task stays with the manager, who attaches it.
async function sendAy(taskId, j) {
  const isEsim = j.t.type === 'esim';
  const number = String(j.number || '').replace(/\D/g, '');
  const retrieveNewNumber = !number || /^050{7,8}$/.test(number);
  const creds = aylolCredentials();
  // The site's price now, before anything is bought: never above the approved price (the shop sold it by it), and
  // never a package the site no longer lists.
  let live;
  try {
    live = await aylol.currentPrice(j.ref, creds);
  } catch (e) {
    return notSentYet({ ...j.t, number }, taskId, e, 'تعذّر التنفيذ التلقائي عبر أيلول');
  }
  const stop = (note) => { setAuto(taskId, 'failed', note); tellManager('لم يُرسَل إلى أيلول', `${number}: ${note}`); };
  if (live === null) return stop('الرزمة غير معروضة في أيلول الآن — زامن أيلول، ثم نفّذه يدوياً أو ارفضه');
  if (live > Number(j.price) + 0.01) return stop(`سعر أيلول الآن ${live} ₪ وهو أعلى من المعتمد ${j.price} ₪ — زامن أيلول وراجع السعر، ثم نفّذه يدوياً أو ارفضه`);
  let r;
  try {
    r = await aylol.executeOrder({
      ref: j.ref, phoneNumber: retrieveNewNumber ? '' : number, price: j.price, simNumber: j.line?.sim || '',
      useEsim: isEsim, retrieveNewNumber, note: j.t.note || '', customerName: j.line?.customer_name || '',
    }, creds);
  } catch (e) {
    if (e.refused) {
      setAuto(taskId, 'failed', `رفض أيلول: ${e.message}`);
      tellManager('رفض أيلول التنفيذ', `${j.number}: ${e.message}`);
      return undefined;
    }
    setAuto(taskId, 'unknown', `انقطع الاتصال مع أيلول (${e.message}). افحص أيلول قبل أي تنفيذ يدوي.`);
    tellManager('تنفيذ أيلول غير مؤكد', `${j.number}: ${e.message}`);
    return undefined;
  }
  // The site may give another number than the one picked: the line carries the real one.
  const realNumber = r.phoneNumber && /^05\d{8}$/.test(r.phoneNumber) ? r.phoneNumber : '';
  const moved = realNumber && realNumber !== number ? ` — الرقم المفعّل: ${realNumber}` : '';
  if (j.t.line_id) {
    if (realNumber) q('UPDATE lines SET number = ? WHERE id = ?').run(realNumber, j.t.line_id);
    if (r.simNumber) q('UPDATE lines SET sim = ? WHERE id = ?').run(String(r.simNumber).replace(/\D/g, ''), j.t.line_id);
  }
  const parts = [`أيلول: ${r.message || 'تم التنفيذ'}`];
  if (r.phoneNumber) parts.push(`الرقم: ${r.phoneNumber}`);
  if (r.simNumber) parts.push(`شريحة: ${r.simNumber}`);
  if (isEsim && !r.qr) {
    setAuto(taskId, 'unknown', `${parts.join(' | ')} — لكن أيلول لم يُرجع كود eSIM. أرفق رمز QR عند تنفيذ الطلب.`);
    tellManager('eSIM من أيلول بلا كود', `${r.phoneNumber || j.number}: أرفق رمز QR`);
    return undefined;
  }
  const extra = isEsim ? { attachment: r.qr, esimCode: r.esimCode } : {};
  finish(taskId, parts.join(' | '), `تم التفعيل${moved}`, AY_ACTOR, extra);
  return undefined;
}

module.exports = { send, check, sweep };
