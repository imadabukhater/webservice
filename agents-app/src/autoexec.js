'use strict';
// Carries out card recharges and renewals through the suppliers for companies set to "auto":
//   art-topup  — recharge cards (refs ic:/pb:/pc:), the result read from its operations list.
//   QuickLine  — extending a line the dealer already has (refs ql:), the result read back from the subscription,
//                whose cut date moves when the extension went through.
// Money safety: a request is sent at most once (claimed with auto_status). Anything unclear (no answer, rejected,
// no sign it took effect) leaves the task open for the manager, who checks the supplier before acting.
const { q, tx, getSettings, artCredentials, qlCredentials } = require('./db');
const { now } = require('./util');
const D = require('./domain');
const art = require('./art');
const ql = require('./quickline');
const { resolveTask } = require('./routes/tasks');

const ACTOR = { id: null, name: 'art-topup (تلقائي)', role: 'admin' };
const QL_ACTOR = { id: null, name: 'QuickLine (تلقائي)', role: 'admin' };
const CHECK_MS = Number(process.env.ART_CHECK_MS) || 15_000; // first look at the operations list after sending
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

// The package and number behind an open recharge/renewal task, or null when no supplier carries it out.
function job(taskId) {
  const t = q("SELECT * FROM tasks WHERE id = ? AND status = 'open' AND type IN ('recharge','renew','activate','esim','port')").get(taskId);
  if (!t || !t.line_id) return null;
  const line = q('SELECT number, package_id, sim, customer_name, customer_price FROM lines WHERE id = ?').get(t.line_id);
  if (!line) return null;
  const packageId = t.type === 'renew' ? JSON.parse(t.payload || '{}').packageId : line.package_id;
  const p = q(`SELECT p.art_card_id, p.cost, p.art_price, c.activation FROM packages p JOIN companies c ON c.id = p.company_id WHERE p.id = ?`).get(packageId);
  if (!p || p.activation !== 'auto') return null;
  // Recharges and renewals: art-topup cards and QuickLine extensions. Activations (a new line, an eSIM, a ported
  // number): QuickLine new lines only — art-topup's invoices (inv:) stay requests for the manager.
  const ref = p.art_card_id;
  const supplier = ['recharge', 'renew'].includes(t.type)
    ? (/^(ic|pb|pc):/.test(ref) ? 'art' : /^ql:/.test(ref) ? 'ql' : null)
    : (/^qln:/.test(ref) ? 'qln' : null);
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
    resolveTask(fresh, actor, { ...extra, status: 'done', response: reply || `نُفّذ تلقائياً عبر ${actor === QL_ACTOR ? 'QuickLine' : 'art-topup'}` });
    setAuto(taskId, 'done', note);
  });
}

async function send(taskId) {
  const j = job(taskId);
  if (!j) return;
  const s = getSettings();
  if (j.supplier === 'art' ? !s.artConfigured : !s.qlConfigured) return;
  // Claim it: only one sender, only once.
  if (!q("UPDATE tasks SET auto_status = 'sending', auto_at = ? WHERE id = ? AND status = 'open' AND auto_status = ''").run(now(), taskId).changes) return;
  if (j.supplier === 'ql') return sendQl(taskId, j);
  if (j.supplier === 'qln') return sendQlNew(taskId, j);
  return sendArt(taskId, j);
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
  // An offer's duration is fixed by QuickLine; if it changed since the sale, the agent paid for something else.
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
      tellManager('رفض QuickLine التفعيل', `${number}: ${e.message}. ارفض الطلب ليُسترد المبلغ أو نفّذه يدوياً.`);
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
    finish(t.id, `QuickLine: تم التفعيل — اشتراك #${sub.id} (${sub.status})`, `تم التفعيل عبر QuickLine`, QL_ACTOR, extra);
    return;
  }
  if (now() - t.auto_at > GIVE_UP_MS) {
    setAuto(t.id, 'unknown', 'لم يظهر الخط في QuickLine بعد 30 دقيقة. افحص هناك قبل أي تنفيذ يدوي.');
    tellManager('تفعيل تلقائي غير مؤكد', `${line?.number}: لم يظهر الخط في QuickLine`);
  } else {
    later(t.id);
  }
}

// ---------- QuickLine: extend a line the dealer already has ----------
// The portal extends a subscription, not a number, so the number is looked up first. What proves it went through is
// the subscription itself: its cut date moves and its remaining days grow.
const subState = (s) => JSON.stringify({ id: s.id, cutDate: s.cutDate, daysLeft: s.daysLeft });

async function sendQl(taskId, j) {
  const number = ql.localNumber(j.number);
  if (!number) {
    setAuto(taskId, 'failed', 'الرقم ليس رقماً محلياً من 10 أرقام — نفّذه يدوياً');
    return;
  }
  const { days, packageId } = ql.parseRef(j.ref) || {};
  if (!days) {
    setAuto(taskId, 'failed', 'الرزمة غير مرتبطة بمدة في QuickLine — نفّذها يدوياً');
    return;
  }
  const creds = qlCredentials();
  let sub;
  try {
    sub = await ql.findSubscription(creds, number);
  } catch (e) {
    // Nothing was sent yet.
    notSentYet({ ...j.t, number }, taskId, e, 'تعذّر التمديد التلقائي');
    return;
  }
  if (!sub) {
    setAuto(taskId, 'failed', `الرقم ${number} غير موجود في QuickLine تحت هذه الوكالة — نفّذه يدوياً`);
    tellManager('تعذّر التمديد التلقائي', `${number}: الرقم غير موجود في QuickLine`);
    return;
  }
  if (!sub.canExtend) {
    setAuto(taskId, 'failed', `QuickLine لا يسمح بتمديد ${number} (${sub.status}) — نفّذه يدوياً`);
    tellManager('تعذّر التمديد التلقائي', `${number}: ${sub.status}`);
    return;
  }
  // QuickLine extends a line on its own package and charges that package's price: the sold one must be it.
  if (sub.packageId && sub.packageId !== packageId) {
    setAuto(taskId, 'failed', `الخط في QuickLine على رزمة «${sub.packageName}» وليس الرزمة المبيعة — نفّذه يدوياً أو ارفضه`);
    tellManager('تعذّر التمديد التلقائي', `${number}: رزمة الخط في QuickLine مختلفة`);
    return;
  }
  const before = subState(sub);
  let r;
  try {
    r = await ql.renew(creds, { subscriptionId: sub.id, days });
  } catch (e) {
    if (e.refused) {
      // QuickLine answered and declined, so nothing was carried out there and nothing was charged.
      setAuto(taskId, 'failed', `رفض QuickLine التمديد: ${e.message}`, { ref: before });
      tellManager('رفض QuickLine التمديد', `${number}: ${e.message}. ارفض الطلب ليُسترد المبلغ أو نفّذه يدوياً.`);
      return;
    }
    // The request may or may not have reached QuickLine: never resend automatically.
    setAuto(taskId, 'unknown', `انقطع الاتصال أثناء الإرسال (${e.message}). افحص الخط في QuickLine قبل أي تنفيذ يدوي.`, { ref: before });
    tellManager('تمديد تلقائي غير مؤكد', `${number}: افحص QuickLine قبل التنفيذ`);
    return;
  }
  setAuto(taskId, 'sent', `أُرسل إلى QuickLine (${days} يوم)${r.text ? ` · ${r.text.slice(0, 120)}` : ''}`, { ref: before });
  // The portal applies an extension at once, so the first look usually settles it.
  later(taskId);
}

// Reads the subscription back and finishes the task once QuickLine's extension shows on it.
async function checkQl(t) {
  let before;
  try { before = JSON.parse(t.auto_ref || '{}'); } catch { before = {}; }
  const line = q('SELECT number FROM lines WHERE id = ?').get(t.line_id);
  // The very subscription that was extended: another one for the same number says nothing about it.
  const sub = (await ql.subscriptions(qlCredentials())).find((s) => s.id === before.id);
  const applied = sub && (sub.cutDate !== before.cutDate || (sub.daysLeft ?? 0) > (before.daysLeft ?? 0));
  if (applied) {
    finish(t.id, `QuickLine: تم التمديد حتى ${sub.cutDate} (${sub.daysLeft} يوم متبقٍ)`, `تم التمديد عبر QuickLine حتى ${sub.cutDate}`, QL_ACTOR);
    return;
  }
  if (now() - t.auto_at > GIVE_UP_MS) {
    setAuto(t.id, 'unknown', 'لم يظهر أثر التمديد في QuickLine بعد 30 دقيقة. افحص الخط هناك قبل أي تنفيذ يدوي.');
    tellManager('تمديد تلقائي غير مؤكد', `${line?.number}: لم يظهر أثر التمديد في QuickLine`);
  } else {
    later(t.id);
  }
}

async function sendArt(taskId, j) {
  const number = art.localNumber(j.number);
  if (!number) {
    setAuto(taskId, 'failed', 'الرقم ليس رقماً محلياً من 10 أرقام — نفّذه يدوياً');
    return;
  }
  const creds = artCredentials();
  const israeli = j.ref.startsWith('ic:');
  let before = 0;
  if (israeli) {
    // Israeli cards report their result in the operations list: remember where it stood before sending.
    try {
      before = Math.max(0, ...(await art.operations(creds)).map((o) => o.id));
    } catch (e) {
      // Nothing was sent yet: give it back to the manager.
      setAuto(taskId, 'failed', `لم يُرسل: ${e.message}`);
      tellManager('تعذّر الشحن التلقائي', `${number}: ${e.message}`);
      return;
    }
  }
  let r;
  try {
    r = await art.recharge(creds, { ref: j.ref, number, price: j.price });
  } catch (e) {
    // The request may or may not have reached art-topup: never resend automatically.
    setAuto(taskId, 'unknown', `انقطع الاتصال أثناء الإرسال (${e.message}). افحص «العمليات» في art-topup قبل أي تنفيذ يدوي.`);
    tellManager('شحن تلقائي غير مؤكد', `${number}: افحص art-topup قبل التنفيذ`);
    return;
  }
  const lowBalance = /رصيد/.test(r.text) && /كاف|يكفي/.test(r.text);
  if (!r.async) {
    // Palestinian bundles and cash: the answer is final.
    if (r.ok) return finish(taskId, 'art-topup: success', 'تم الشحن عبر art-topup');
    if (r.error || lowBalance) {
      setAuto(taskId, 'failed', `رفض art-topup: ${r.error || r.text}`);
      tellManager(lowBalance ? 'رصيد art-topup لا يكفي' : 'رفض art-topup الشحن', `${number}: ${r.error || r.text}. نفّذه يدوياً أو ارفضه ليُسترد المبلغ.`);
      return undefined;
    }
    setAuto(taskId, 'unknown', `ردّ غير متوقع من art-topup: «${r.text || 'فارغ'}». افحص «العمليات» هناك قبل أي تنفيذ يدوي.`);
    tellManager('شحن تلقائي غير مؤكد', `${number}: افحص art-topup قبل التنفيذ`);
    return undefined;
  }
  if (lowBalance) {
    setAuto(taskId, 'failed', `رصيد art-topup لا يكفي: ${r.text}`, { ref: String(before) });
    tellManager('رصيد art-topup لا يكفي', `اشحن رصيد art-topup ثم نفّذ طلب ${number} يدوياً`);
    return undefined;
  }
  setAuto(taskId, 'sent', `أُرسل إلى art-topup${r.text ? ` · ${r.text.slice(0, 120)}` : ''}`, { ref: String(before) });
  later(taskId);
  return undefined;
}

// Looks again while the supplier is still working on it (the sweep is the slower safety net).
const later = (taskId) => setTimeout(() => check(taskId).catch((e) => console.error('auto check', e)), CHECK_MS).unref?.();

// Looks at what the supplier did with the request sent for this task, and finishes the task once it is through.
async function check(taskId) {
  const t = q("SELECT * FROM tasks WHERE id = ? AND status = 'open' AND auto_status = 'sent'").get(taskId);
  if (!t) return;
  // auto_ref holds JSON for QuickLine (the subscription before the extension) and an operation id for art-topup.
  if (t.auto_ref.startsWith('{')) {
    let before;
    try { before = JSON.parse(t.auto_ref); } catch { before = {}; }
    return before.new ? checkQlNew(t, before) : checkQl(t);
  }
  const line = q('SELECT number FROM lines WHERE id = ?').get(t.line_id);
  const number = art.localNumber(line?.number);
  const ops = await art.operations(artCredentials());
  const op = ops.filter((o) => o.id > Number(t.auto_ref || 0) && o.number === number).sort((a, b) => b.id - a.id)[0];
  if (!op) {
    if (now() - t.auto_at > GIVE_UP_MS) {
      setAuto(taskId, 'unknown', 'لم تظهر العملية في art-topup بعد 30 دقيقة. افحص «العمليات» هناك قبل أي تنفيذ يدوي.');
      tellManager('شحن تلقائي غير مؤكد', `${line?.number}: لم تظهر العملية في art-topup`);
    } else later(taskId);
    return;
  }
  const result = art.outcome(op.status);
  const note = `art-topup #${op.id}: ${op.status}${op.reply ? ` — ${op.reply}` : ''}`;
  if (result === 'done') {
    finish(taskId, note, op.reply);
  } else if (result === 'failed') {
    setAuto(taskId, 'failed', note);
    tellManager('رفض art-topup الشحن', `${line?.number}: ${op.status}. ارفض الطلب ليُسترد المبلغ أو نفّذه يدوياً.`);
  } else if (now() - t.auto_at > GIVE_UP_MS) {
    setAuto(taskId, 'unknown', `${note} — ما زالت قيد التنفيذ بعد 30 دقيقة`);
    tellManager('شحن تلقائي متأخر', `${line?.number}: ${op.status}`);
  } else {
    later(taskId);
  }
}

// ---------- QuickLine: a line closed, paused or reactivated here changes there too ----------
// The line's status there is read first, so a change already made (or made again after a dropped connection) is
// never sent twice. A refusal goes to the manager; a dropped connection is tried again by the sweep.
const MIRROR = {
  close: { want: ql.STATUS.closed, from: [2, 3, 6], call: ql.closeNumber, done: 'فُصل الرقم نهائياً في QuickLine', what: 'الفصل' },
  pause: { want: ql.STATUS.paused, from: [2], call: ql.pauseNumber, done: 'فُصل الرقم مؤقتاً في QuickLine', what: 'التجميد' },
  activate: { want: ql.STATUS.active, from: [6], call: ql.activateNumber, done: 'أُعيد تفعيل الرقم في QuickLine', what: 'إلغاء التجميد' },
};
const mirroring = new Set();
// A line QuickLine still shows as «جديد» is not activated there yet, and QuickLine takes no state change for it
// (it accepts one and then activates the line anyway): wait until it is active, for up to a day.
const NOT_YET = 1;
const WAIT_MS = 24 * 60 * 60_000;
const waitLogged = new Set();

async function mirrorLine(lineId) {
  if (!getSettings().qlConfigured || mirroring.has(lineId)) return;
  const line = q('SELECT id, number, agent_id, package_label, ql_pending, updated_at FROM lines WHERE id = ?').get(lineId);
  const m = line && MIRROR[line.ql_pending];
  if (!m) return;
  mirroring.add(lineId);
  const pending = line.ql_pending;
  let retry = false;
  // Take it; a newer change made meanwhile sets it again and is carried out next.
  q("UPDATE lines SET ql_pending = '' WHERE id = ? AND ql_pending = ?").run(lineId, pending);
  const agent = q('SELECT id, name, balance FROM users WHERE id = ?').get(line.agent_id);
  const log = (detail) => D.logLineOp('supplier_sync', line, agent, QL_ACTOR, detail, { package: line.package_label });
  const problem = (detail) => { log(detail); tellManager(`QuickLine: تعذّر ${m.what}`, `${line.number}: ${detail}`); };
  try {
    const number = ql.localNumber(line.number);
    const subs = (await ql.subscriptions(qlCredentials())).filter((s) => s.number === number);
    const sub = subs.find((s) => s.statusValue !== ql.STATUS.closed) || subs[0];
    if (!sub) return problem('الرقم غير موجود في QuickLine تحت هذه الوكالة — لم يتغيّر شيء هناك');
    if (sub.statusValue === m.want) return log(`${m.done} (كان كذلك مسبقاً)`);
    if (sub.statusValue === NOT_YET) {
      if (now() - line.updated_at > WAIT_MS) return problem(`ما زال الخط «${sub.status}» في QuickLine بعد يوم، ولم يُنفَّذ ${m.what} — نفّذه هناك يدوياً`);
      // Keep it queued: the sweep looks again until QuickLine has activated the line.
      if (q("UPDATE lines SET ql_pending = ? WHERE id = ? AND ql_pending = ''").run(pending, lineId).changes) retry = true;
      const key = `${lineId}:${pending}`;
      if (!waitLogged.has(key)) { waitLogged.add(key); log(`${m.what} بانتظار أن يفعّل QuickLine الخط (حالته الآن «${sub.status}»)`); }
      return undefined;
    }
    if (!m.from.includes(sub.statusValue)) return problem(`حالة الرقم في QuickLine «${sub.status}» لا تسمح بـ${m.what} — نفّذه هناك يدوياً`);
    await m.call(qlCredentials(), sub.id);
    const after = (await ql.subscriptions(qlCredentials())).find((s) => s.id === sub.id);
    if (after && after.statusValue !== m.want) return problem(`أُرسل ${m.what} لكن الحالة في QuickLine ما زالت «${after.status}» — افحصه هناك`);
    return log(`${m.done} (اشتراك #${sub.id})`);
  } catch (e) {
    if (!(e instanceof ql.QuickLineError)) throw e;
    if (e.refused) return problem(`رفض QuickLine ${m.what}: ${e.message}`);
    // Not sure it arrived: queue it again (unless a newer change took its place); the status check makes it safe.
    if (q("UPDATE lines SET ql_pending = ? WHERE id = ? AND ql_pending = ''").run(pending, lineId).changes) retry = true;
    return undefined;
  } finally {
    mirroring.delete(lineId);
    // A newer change made while this one was on its way goes now, not at the next sweep.
    if (!retry && q("SELECT ql_pending FROM lines WHERE id = ?").get(lineId)?.ql_pending) {
      setImmediate(() => mirrorLine(lineId).catch((e) => console.error('ql mirror', e)));
    }
  }
}
// ---------- QuickLine: a new SIM put on a line here goes on it there too ----------
// Same safety as above: QuickLine's current SIM is read first, a refusal goes to the manager, a dropped connection
// is tried again, and a line still «جديد» there waits.
const simming = new Set();
async function mirrorSim(lineId) {
  if (!getSettings().qlConfigured || simming.has(lineId)) return;
  const line = q(`SELECT l.id, l.number, l.agent_id, l.package_label, l.ql_sim, l.updated_at, p.art_card_id
                  FROM lines l LEFT JOIN packages p ON p.id = l.package_id WHERE l.id = ?`).get(lineId);
  if (!line || !line.ql_sim) return;
  simming.add(lineId);
  const iccid = line.ql_sim;
  let again = false;
  q("UPDATE lines SET ql_sim = '' WHERE id = ? AND ql_sim = ?").run(lineId, iccid);
  const requeue = () => { if (q("UPDATE lines SET ql_sim = ? WHERE id = ? AND ql_sim = ''").run(iccid, lineId).changes) again = true; };
  const agent = q('SELECT id, name, balance FROM users WHERE id = ?').get(line.agent_id);
  const log = (detail) => D.logLineOp('supplier_sync', line, agent, QL_ACTOR, detail, { package: line.package_label });
  const problem = (detail) => { log(detail); tellManager('QuickLine: تعذّر تبديل الشريحة', `${line.number}: ${detail}`); };
  try {
    const creds = qlCredentials();
    const qlPkg = ql.supplierOfRef(line.art_card_id).qlPackage;
    const rule = (qlPkg && require('./routes/quickline').simRuleFor(qlPkg))
      || (await ql.catalog(creds, 'invoice')).find((x) => x.packageId === qlPkg);
    if (!rule) return problem('لم أجد قاعدة شرائح رزمة هذا الخط في QuickLine — بدّل الشريحة هناك يدوياً');
    const number = ql.localNumber(line.number);
    const sub = (await ql.subscriptions(creds)).find((s) => s.number === number && s.statusValue !== ql.STATUS.closed);
    if (!sub) return problem('الرقم غير موجود في QuickLine تحت هذه الوكالة (أو مفصول هناك) — لم يتغيّر شيء');
    if (sub.sim === iccid) return log(`الشريحة ${iccid} على الخط في QuickLine (كانت كذلك مسبقاً)`);
    if (sub.statusValue === NOT_YET) {
      if (now() - line.updated_at > WAIT_MS) return problem(`ما زال الخط «${sub.status}» في QuickLine بعد يوم، ولم تُبدَّل الشريحة — بدّلها هناك يدوياً`);
      requeue();
      const key = `${lineId}:sim:${iccid}`;
      if (!waitLogged.has(key)) { waitLogged.add(key); log(`تبديل الشريحة بانتظار أن يفعّل QuickLine الخط (حالته الآن «${sub.status}»)`); }
      return undefined;
    }
    await ql.changeSim(creds, sub.id, iccid, rule);
    const after = (await ql.subscriptions(creds)).find((s) => s.id === sub.id);
    if (after && after.sim !== iccid) return problem(`أُرسلت الشريحة الجديدة لكن QuickLine ما زال يعرض ${after.sim || 'غيرها'} — افحصه هناك`);
    return log(`وُضعت الشريحة ${iccid} على الخط في QuickLine (اشتراك #${sub.id})`);
  } catch (e) {
    if (!(e instanceof ql.QuickLineError)) throw e;
    if (e.refused) return problem(`رفض QuickLine تبديل الشريحة: ${e.message}`);
    requeue();
    return undefined;
  } finally {
    simming.delete(lineId);
    // A newer SIM put on meanwhile goes now.
    if (!again && q('SELECT ql_sim FROM lines WHERE id = ?').get(lineId)?.ql_sim) {
      setImmediate(() => mirrorSim(lineId).catch((e) => console.error('ql sim', e)));
    }
  }
}

D.events.on('line-supplier', (id) => setImmediate(() => {
  mirrorLine(id).catch((e) => console.error('ql mirror', e));
  mirrorSim(id).catch((e) => console.error('ql sim', e));
}));

// New sale requests are sent right after their transaction commits.
D.events.on('sale-task', (id) => setImmediate(() => send(id).catch((e) => console.error('auto send', e))));

// Safety net: follow up sent requests, and send fresh ones missed (e.g. the server restarted in between).
let busy = false;
async function sweep() {
  const s = getSettings();
  if (busy || !(s.artConfigured || s.qlConfigured)) return;
  busy = true;
  try {
    // A send interrupted midway (e.g. the server restarted) may or may not have reached the supplier: never resend it,
    // tell the manager to check there.
    for (const t of q("SELECT t.id, l.number FROM tasks t LEFT JOIN lines l ON l.id = t.line_id WHERE t.status = 'open' AND t.auto_status = 'sending' AND t.auto_at < ?")
      .all(now() - STUCK_MS)) {
      setAuto(t.id, 'unknown', 'انقطع الإرسال قبل أن يُعرف إن وصل إلى المورّد. افحصه هناك قبل أي تنفيذ يدوي.');
      tellManager('تنفيذ تلقائي غير مؤكد', `${t.number || ''}: افحص المورّد قبل التنفيذ`);
    }
    for (const { id } of q("SELECT id FROM tasks WHERE status = 'open' AND auto_status = 'sent'").all()) await check(id).catch((e) => console.error('auto check', e));
    for (const { id } of q("SELECT id FROM tasks WHERE status = 'open' AND auto_status = '' AND type IN ('recharge','renew','activate','esim','port') AND created_at > ?").all(now() - PICKUP_MS)) {
      await send(id).catch((e) => console.error('auto send', e));
    }
    if (s.qlConfigured) {
      for (const { id } of q("SELECT id FROM lines WHERE ql_pending != ''").all()) await mirrorLine(id).catch((e) => console.error('ql mirror', e));
      for (const { id } of q("SELECT id FROM lines WHERE ql_sim != ''").all()) await mirrorSim(id).catch((e) => console.error('ql sim', e));
    }
  } finally {
    busy = false;
  }
}
setInterval(() => { sweep().catch((e) => console.error('auto sweep', e)); }, LOOP_MS).unref();

module.exports = { send, check, sweep, mirrorLine, mirrorSim };
