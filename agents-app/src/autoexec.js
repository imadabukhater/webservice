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

const setAuto = (id, status, note, extra = {}) => q(`UPDATE tasks SET auto_status = ?, auto_note = ?${extra.ref !== undefined ? ', auto_ref = ?' : ''} WHERE id = ?`)
  .run(status, note, ...(extra.ref !== undefined ? [extra.ref] : []), id);
const tellManager = (title, body) => D.notify({ role: 'admin', kind: 'task', title, body, link: '#/tasks' });

// The package and number behind an open recharge/renewal task, or null when no supplier carries it out.
function job(taskId) {
  const t = q("SELECT * FROM tasks WHERE id = ? AND status = 'open' AND type IN ('recharge','renew')").get(taskId);
  if (!t || !t.line_id) return null;
  const line = q('SELECT number, package_id FROM lines WHERE id = ?').get(t.line_id);
  if (!line) return null;
  const packageId = t.type === 'renew' ? JSON.parse(t.payload || '{}').packageId : line.package_id;
  const p = q(`SELECT p.art_card_id, p.cost, p.art_price, c.activation FROM packages p JOIN companies c ON c.id = p.company_id WHERE p.id = ?`).get(packageId);
  if (!p || p.activation !== 'auto') return null;
  // Only recharge cards (art-topup) and extensions (QuickLine) are carried out automatically. Activating a new line
  // — art-topup's invoices (inv:) and QuickLine's new subscriptions (qln:) — stays a request for the manager.
  const supplier = /^(ic|pb|pc):/.test(p.art_card_id) ? 'art' : /^ql:/.test(p.art_card_id) ? 'ql' : null;
  if (!supplier) return null;
  // The supplier is paid its own current price, never the cost the manager may have typed.
  return { t, supplier, number: line.number, ref: p.art_card_id, price: p.art_price ?? p.cost };
}

// Finishes a task as carried out by a supplier.
function finish(taskId, note, reply, actor = ACTOR) {
  tx(() => {
    // Another check may have finished it meanwhile.
    const fresh = q("SELECT * FROM tasks WHERE id = ? AND status = 'open' AND auto_status IN ('sending','sent')").get(taskId);
    if (!fresh) return;
    resolveTask(fresh, actor, { status: 'done', response: reply || `نُفّذ تلقائياً عبر ${actor === QL_ACTOR ? 'QuickLine' : 'art-topup'}` });
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
  return sendArt(taskId, j);
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
  const { days } = ql.parseRef(j.ref) || {};
  if (!days) {
    setAuto(taskId, 'failed', 'الرزمة غير مرتبطة بمدة في QuickLine — نفّذها يدوياً');
    return;
  }
  const creds = qlCredentials();
  let sub;
  try {
    sub = await ql.findSubscription(creds, number);
  } catch (e) {
    // Nothing was sent yet: give it back to the manager.
    setAuto(taskId, 'failed', `لم يُرسل: ${e.message}`);
    tellManager('تعذّر التمديد التلقائي', `${number}: ${e.message}`);
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
  const sub = await ql.findSubscription(qlCredentials(), line?.number);
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
  if (t.auto_ref.startsWith('{')) return checkQl(t);
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

// New sale requests are sent right after their transaction commits.
D.events.on('sale-task', (id) => setImmediate(() => send(id).catch((e) => console.error('auto send', e))));

// Safety net: follow up sent requests, and send fresh ones missed (e.g. the server restarted in between).
let busy = false;
async function sweep() {
  const s = getSettings();
  if (busy || !(s.artConfigured || s.qlConfigured)) return;
  busy = true;
  try {
    for (const { id } of q("SELECT id FROM tasks WHERE status = 'open' AND auto_status = 'sent'").all()) await check(id).catch((e) => console.error('auto check', e));
    for (const { id } of q("SELECT id FROM tasks WHERE status = 'open' AND auto_status = '' AND type IN ('recharge','renew') AND created_at > ?").all(now() - PICKUP_MS)) {
      await send(id).catch((e) => console.error('auto send', e));
    }
  } finally {
    busy = false;
  }
}
setInterval(() => { sweep().catch((e) => console.error('auto sweep', e)); }, LOOP_MS).unref();

module.exports = { send, check, sweep };
