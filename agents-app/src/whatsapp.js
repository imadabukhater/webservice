'use strict';
// The WhatsApp agent: the shop's WhatsApp number, linked by scanning a QR code (WhatsApp → Linked devices), answers
// three kinds of people:
//   - agents (the number saved on their account): their packages and prices, their balance and lines, and sales —
//     a card top-up, or a new eSIM / Layan line on a number picked from the free list. Nothing is charged without
//     their «نعم»; the sale is the portal's own (createLine: balance, supplier, autoexec), and its result — with the
//     eSIM's real QR code — comes back in the same chat once the supplier has carried it out (taskResolved);
//   - the manager (numbers listed in the settings): open requests, packages, any line's state;
//   - anyone else, when allowed: the shop's packages at the shop's prices, and the shop's link for each, where they
//     pay and the payment is verified. Nothing is bought or activated for them here.
// Optionally (a Gemini key in the settings) free text is understood too; it only picks among these same actions.
// The library (@whiskeysockets/baileys) is loaded only when linking, so the app runs without it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { q, tx, getSettings, setSetting, DB_FILE } = require('./db');
const { now, round, normalizePhone, str } = require('./util');
const qrcode = require('./qr');
const { forAgent } = require('./privacy');

// ---------- settings ----------
const get = (k, d = '') => q('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? d;
const phoneList = (v) => [...new Set(String(v || '').split(/[\s,،;]+/).map(normalizePhone).filter((p) => /^\d{9,13}$/.test(p)))];

function config() {
  return {
    enabled: get('wa_enabled', '1') !== '0',
    customers: get('wa_customers', '1') !== '0',
    admins: phoneList(get('wa_admins')),
    shopUrl: get('wa_shop_url'),
    aiKey: get('wa_ai_key'),
    aiModel: get('wa_ai_model', 'gemini-2.5-flash'),
    welcome: get('wa_welcome'),
  };
}

// What the settings screen sees: never the AI key itself.
function configView() {
  const c = config();
  return { enabled: c.enabled, customers: c.customers, admins: c.admins.join(', '), shopUrl: c.shopUrl, hasAiKey: !!c.aiKey, aiModel: c.aiModel, welcome: c.welcome };
}

function saveConfig(body = {}) {
  const fail = require('./util').fail;
  if (body.enabled !== undefined) setSetting('wa_enabled', body.enabled ? '1' : '0');
  if (body.customers !== undefined) setSetting('wa_customers', body.customers ? '1' : '0');
  if (body.admins !== undefined) setSetting('wa_admins', phoneList(body.admins).join(','));
  if (body.shopUrl !== undefined) {
    const u = str(body.shopUrl, 200);
    if (u && !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(u)) fail(400, 'رابط المتجر يبدأ بـ https://');
    setSetting('wa_shop_url', u.replace(/[#?].*$/, '').replace(/\/+$/, ''));
  }
  if (body.aiKey) setSetting('wa_ai_key', String(body.aiKey).trim().slice(0, 200));
  if (body.aiKeyClear) setSetting('wa_ai_key', '');
  if (body.aiModel !== undefined) setSetting('wa_ai_model', /^[\w.-]{3,60}$/.test(String(body.aiModel)) ? String(body.aiModel) : 'gemini-2.5-flash');
  if (body.welcome !== undefined) setSetting('wa_welcome', str(body.welcome, 300));
  return configView();
}

// ---------- the linked session (kept beside the database, like the suppliers' cookies) ----------
let dir = null;
function authDir() {
  if (dir) return dir;
  dir = process.env.WA_DATA || (DB_FILE === ':memory:' ? path.join(os.tmpdir(), `agents-wa-${process.pid}`) : path.join(path.dirname(DB_FILE), 'whatsapp'));
  return dir;
}
const linked = () => {
  try { return !!JSON.parse(fs.readFileSync(path.join(authDir(), 'creds.json'), 'utf8')).me; } catch { return false; }
};

const state = { sock: null, status: 'off', qr: '', qrAt: 0, phone: '', error: '', starting: false, retries: 0 };
let transport = null; // tests: replaces the socket's sendMessage

const SILENT = {
  level: 'silent', isLevelEnabled: () => false, child() { return SILENT; },
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};
function logger() {
  try { return require('pino')({ level: 'silent' }); } catch { return SILENT; }
}

const phoneOfJid = (jid) => normalizePhone(String(jid || '').split('@')[0].split(':')[0]);
const connected = () => !!transport || (state.status === 'connected' && !!state.sock);

function status() {
  return {
    status: state.status, qr: state.status === 'qr' ? state.qr : '', qrAt: state.qrAt, phone: state.phone, error: state.error,
    linked: linked(), config: configView(),
  };
}

async function start({ fresh = false } = {}) {
  if (state.starting) return status();
  if (state.sock && !fresh) return status();
  state.starting = true;
  try {
    let B;
    try {
      B = await import('@whiskeysockets/baileys');
    } catch {
      state.status = 'missing';
      state.error = 'مكتبة واتساب غير مثبتة على السيرفر بعد. شغّل أمر التحديث (agents-update) ثم أعد المحاولة.';
      return status();
    }
    if (fresh) {
      closeSocket();
      fs.rmSync(authDir(), { recursive: true, force: true });
    }
    fs.mkdirSync(authDir(), { recursive: true, mode: 0o700 });
    const { state: auth, saveCreds } = await B.useMultiFileAuthState(authDir());
    let version;
    try {
      version = (await Promise.race([B.fetchLatestBaileysVersion(), new Promise((r) => setTimeout(r, 10_000, null))]))?.version;
    } catch {}
    const make = B.makeWASocket || B.default;
    const sock = make({
      auth, logger: logger(), markOnlineOnConnect: false, syncFullHistory: false,
      browser: B.Browsers?.ubuntu ? B.Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04'],
      ...(version ? { version } : {}),
    });
    state.sock = sock;
    state.status = 'connecting';
    state.error = '';
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => onConnection(B, sock, auth, u));
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages || []) onRaw(m).catch((e) => console.error('whatsapp message', e.message));
    });
  } catch (e) {
    state.status = 'off';
    state.error = `تعذّر بدء واتساب: ${e.message}`;
  } finally {
    state.starting = false;
  }
  return status();
}

function closeSocket() {
  const s = state.sock;
  state.sock = null;
  if (s) try { s.end(undefined); } catch {}
}

function onConnection(B, sock, auth, u) {
  if (state.sock !== sock) return;
  if (u.qr) {
    state.status = 'qr';
    state.qr = qrcode.dataUrl(u.qr, { scale: 6 });
    state.qrAt = now();
  }
  if (u.connection === 'open') {
    state.status = 'connected';
    state.qr = '';
    state.error = '';
    state.retries = 0;
    state.phone = phoneOfJid(sock.user?.id);
    flush().catch((e) => console.error('whatsapp flush', e.message));
  }
  if (u.connection === 'close') {
    const code = u.lastDisconnect?.error?.output?.statusCode || 0;
    const R = B.DisconnectReason || {};
    state.sock = null;
    if (code === (R.loggedOut ?? 401) || code === 403) {
      fs.rmSync(authDir(), { recursive: true, force: true });
      Object.assign(state, { status: 'off', qr: '', phone: '', error: 'أُلغي ربط واتساب من الهاتف. اضغط «ربط واتساب» لربطه من جديد.' });
    } else if (code === (R.connectionReplaced ?? 440)) {
      Object.assign(state, { status: 'off', qr: '', error: 'فُتح واتساب هذا الرقم من مكان آخر بدل السيرفر. اضغط «ربط واتساب» لإعادته.' });
    } else if (!auth.creds?.me && code !== (R.restartRequired ?? 515)) {
      // Not linked yet: stop until the manager asks again (the QR expired, or WhatsApp could not be reached).
      const why = state.status === 'qr' ? 'انتهت مهلة رمز QR قبل مسحه.' : `تعذّر الوصول إلى خوادم واتساب (${u.lastDisconnect?.error?.message || code || 'بلا رد'}).`;
      Object.assign(state, { status: 'off', qr: '', error: `${why} اضغط «ربط واتساب» للمحاولة من جديد.` });
    } else {
      state.status = 'connecting';
      const wait = Math.min(60_000, 2_000 * 2 ** state.retries++);
      setTimeout(() => { if (!state.sock) start().catch(() => {}); }, wait).unref();
    }
  }
}

async function logout() {
  const s = state.sock;
  if (s) try { await s.logout(); } catch {}
  closeSocket();
  fs.rmSync(authDir(), { recursive: true, force: true });
  Object.assign(state, { status: 'off', qr: '', phone: '', error: '' });
  return status();
}

async function send(jid, content) {
  if (transport) return transport(jid, content);
  if (!connected()) throw new Error('واتساب غير مربوط الآن');
  return state.sock.sendMessage(jid, content);
}
const say = (jid, text) => send(jid, { text: String(text).slice(0, 4000) });

// A message to any number (the settings screen's test).
// A local number (05…) is Palestinian when it starts 059 or 056 (970), Israeli otherwise (972).
function jidOf(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^05\d{8}$/.test(d)) d = (/^05[69]/.test(d) ? '970' : '972') + d.slice(1);
  return /^\d{10,15}$/.test(d) ? `${d}@s.whatsapp.net` : '';
}
async function sendTo(phone, text) {
  const jid = jidOf(phone);
  if (!jid) require('./util').fail(400, 'أدخل رقم واتساب صحيحاً');
  if (!connected()) require('./util').fail(409, 'واتساب غير مربوط الآن');
  await say(jid, text);
  return { ok: true };
}

// ---------- incoming ----------
const textOf = (m) => {
  const x = m?.ephemeralMessage?.message || m?.viewOnceMessage?.message || m || {};
  return String(x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.buttonsResponseMessage?.selectedDisplayText
    || x.listResponseMessage?.title || '').trim();
};

async function onRaw(m) {
  if (!m?.message || m.key?.fromMe) return;
  const jid = m.key.remoteJid || '';
  // Private chats only: no groups, statuses or channels.
  if (!/@(s\.whatsapp\.net|lid)$/.test(jid)) return;
  // Old messages delivered after a reconnect are not answered (a «نعم» from yesterday must not sell anything).
  const raw = m.messageTimestamp;
  const ts = raw && typeof raw === 'object' ? (typeof raw.toNumber === 'function' ? raw.toNumber() : Number(raw.low) || 0) : Number(raw || 0);
  if (ts && Date.now() / 1000 - ts > 600) return;
  const pn = [jid, m.key.remoteJidAlt, m.key.senderPn, m.key.participantPn].find((j) => /@s\.whatsapp\.net$/.test(j || ''));
  const text = textOf(m.message);
  if (!text) return;
  await handle({ jid, phone: pn ? phoneOfJid(pn) : '', text });
}

// At most 15 messages a minute from one chat.
const recent = new Map();
function tooMany(jid) {
  const t = Date.now();
  const list = (recent.get(jid) || []).filter((x) => t - x < 60_000);
  list.push(t);
  recent.set(jid, list);
  if (recent.size > 5000) for (const [k, v] of recent) if (!v.some((x) => t - x < 60_000)) recent.delete(k);
  return list.length > 15;
}

// What someone is in the middle of (picking a number, typing the customer's name, confirming), for 10 minutes.
const sessions = new Map();
const SESSION_MS = 10 * 60_000;
const session = (jid) => {
  const s = sessions.get(jid);
  return s && Date.now() - s.at < SESSION_MS ? s : null;
};
const remember = (jid, s) => sessions.set(jid, { ...s, at: Date.now() });

function whoIs(phone) {
  if (!phone) return { kind: 'customer' };
  const p = normalizePhone(phone);
  if (config().admins.includes(p)) {
    const user = q("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get();
    if (user) return { kind: 'admin', user };
  }
  // An agent is known by the phone saved on their account (and only when no other account has it).
  const agents = q("SELECT * FROM users WHERE role = 'agent' AND phone != ''").all().filter((u) => normalizePhone(u.phone) === p);
  if (agents.length === 1) return agents[0].active ? { kind: 'agent', user: agents[0] } : { kind: 'blocked' };
  return { kind: 'customer' };
}

// Arabic as typed on phones: Arabic-Indic digits, hamza forms, taa marbuta, tatweel.
function norm(t) {
  return String(t || '')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/ـ/g, '').replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}
const PHONE_RE = /(?:\+|00)?(?:972|970)5\d{8}|05\d{8}/;
const RE = {
  help: /^(مرحبا|مرحبه|اهلا|اهلين|هلا|السلام عليكم|سلام|مساعده|القائمه|قائمه|الاوامر|اوامر|ابدا|start|help|menu|hi|hello|0)[!.؟?]*$/,
  yes: /^(نعم|ايوه|ايوا|اه|موافق|تاكيد|اكد|yes|ok|تمام)[!.]*$/,
  no: /^(لا|الغاء|الغ|cancel|no)[!.]*$/,
  balance: /^(رصيدي|الرصيد|رصيد|كم رصيدي|حسابي)[؟?]*$/,
  orders: /^(طلباتي|طلبات|الطلبات|اخر الطلبات)$/,
  packages: /(باقات|الباقات|باقه|رزم|الرزم|رزمه|اسعار|الاسعار|عروض|العروض|كروت|الكروت|esim|اي سيم|ايسيم)/,
  recharge: /^(شحن|اشحن|تعبئه|عبي|تمديد|مدد)(\s|$)/,
  esim: /(esim|اي سيم|ايسيم|شريحه الكترونيه)/,
  line: /^(تفعيل|فعل) خط(\s|$)/,
  status: /^(حاله|فحص|استعلام)(\s|$)/,
  code: /^#?(\d{1,6})$/,
};
const pkgIdIn = (t) => Number((t.replace(PHONE_RE, ' ').match(/#?\b(\d{1,6})\b/) || [])[1]) || 0;
const phoneIn = (t) => {
  const m = t.replace(/[\s-]/g, '').match(PHONE_RE);
  return m ? normalizePhone(m[0]) : '';
};

async function handle({ jid, phone, text }) {
  const cfg = config();
  if (!cfg.enabled || tooMany(jid)) return;
  const who = whoIs(phone);
  if (who.kind === 'blocked') return say(jid, 'حسابك موقوف. تواصل مع المدير.');
  if (who.kind === 'customer' && !cfg.customers) return undefined;
  const t = norm(text);
  try {
    if (who.kind === 'agent') return await agentSays(jid, who.user, t, text);
    if (who.kind === 'admin') return await adminSays(jid, who.user, t);
    return await customerSays(jid, t, text);
  } catch (e) {
    // Messages from the portal's checks are written for whoever sells (fail(...)); anything else stays on the server.
    if (e && e.status) return say(jid, `⚠️ ${forAgent(e.message)}`);
    console.error('whatsapp', e);
    return say(jid, '⚠️ حدث خطأ. حاول بعد قليل.');
  }
}

// ---------- agents ----------
function agentMenu(user) {
  return [
    `أهلاً ${user.name} 👋`,
    '',
    '*الباقات* — رزمك وأسعارها (أو: باقات + اسم الشركة، باقات esim، كروت)',
    '*شحن 05XXXXXXXX رقم_الرزمة* — شحن كرت أو تمديد رقم',
    '*esim رقم_الرزمة* — خط eSIM جديد: تختار الرقم، ويصلك رمز QR هنا',
    '*تفعيل خط رقم_الرزمة* — خط جديد بشريحته (رزم الأرقام الجاهزة)',
    '*رصيدي* — رصيدك المتاح',
    '*حالة 05XXXXXXXX* — حالة رقم من أرقامك',
    '*طلباتي* — آخر طلباتك',
    '*إلغاء* — لإلغاء ما بدأته',
  ].join('\n');
}

const catalog = (user) => require('./routes/catalog').catalogFor(user);

function filterPackages(cat, t) {
  let list = cat.packages.filter((p) => p.active !== false);
  const companies = cat.companies.filter((c) => t.includes(norm(c.name)));
  if (companies.length) list = list.filter((p) => companies.some((c) => c.id === p.companyId));
  if (RE.esim.test(t)) list = list.filter((p) => p.pool);
  else if (/(كروت|كرت|شحن)/.test(t)) list = list.filter((p) => p.kind === 'card');
  return list;
}

function packageLines(list, { price = (p) => p.price, tags = () => '' } = {}) {
  const out = [];
  let last = null;
  for (const p of list.slice(0, 40)) {
    if (p.companyName !== last) {
      out.push('', `*${p.companyName}*`);
      last = p.companyName;
    }
    out.push(`• #${p.id} ${p.name}${p.dataGb ? ` · ${p.dataGb}GB` : ''} — *${round(price(p))} ₪*${tags(p)}`);
  }
  if (list.length > 40) out.push('', `… و${list.length - 40} رزمة أخرى. اكتب اسم الشركة لعرض رزمها فقط، مثل: باقات ${list[40].companyName}`);
  return out;
}

const agentTags = (p) => (p.kind === 'card' ? ' · شحن' : p.pool ? (p.ownSim ? ' · خط / eSIM' : ' · eSIM') : '');
const esimFeeOf = (cat, p) => {
  const c = cat.companies.find((x) => x.id === p.companyId);
  return c && c.esimFee !== null && c.esimFee !== undefined ? Number(c.esimFee) : getSettings().esimFee;
};

async function agentSays(jid, user, t, raw) {
  const s = session(jid);
  if (RE.no.test(t)) {
    sessions.delete(jid);
    return say(jid, 'تم الإلغاء.');
  }
  if (s) {
    const done = await agentStep(jid, user, s, t, raw);
    if (done !== false) return done;
  }
  if (RE.help.test(t)) return say(jid, agentMenu(user));
  if (RE.balance.test(t)) {
    const u = q('SELECT * FROM users WHERE id = ?').get(user.id);
    return say(jid, `💰 رصيدك: *${round(u.balance)} ₪*${u.credit_limit ? `\nالمتاح مع الدين: *${round(u.balance + u.credit_limit)} ₪*` : ''}`);
  }
  if (RE.orders.test(t)) {
    const rows = q('SELECT number, package_label, status, price, updated_at FROM lines WHERE agent_id = ? ORDER BY id DESC LIMIT 5').all(user.id);
    if (!rows.length) return say(jid, 'لا طلبات بعد.');
    return say(jid, ['📋 آخر طلباتك:', ...rows.map((r) => `• ${r.number} — ${r.package_label} — ${round(r.price)} ₪ — ${STATUS[r.status] || r.status}`)].join('\n'));
  }
  if (RE.status.test(t)) {
    const number = phoneIn(t);
    if (!number) return say(jid, 'اكتب الرقم، مثل: حالة 0521234567');
    const l = q('SELECT * FROM lines WHERE agent_id = ? AND number = ? ORDER BY id DESC LIMIT 1').get(user.id, number);
    if (!l) return say(jid, `الرقم ${number} ليس من أرقامك.`);
    return say(jid, `📞 ${l.number}\n${l.package_label}\nالحالة: *${STATUS[l.status] || l.status}*${l.expires_at ? `\nينتهي: ${new Date(l.expires_at).toISOString().slice(0, 10)}` : ''}`);
  }
  if (RE.recharge.test(t)) return agentRecharge(jid, user, phoneIn(t), pkgIdIn(t));
  if (RE.line.test(t)) return agentNewLine(jid, user, pkgIdIn(t), false);
  if (RE.esim.test(t) && pkgIdIn(t)) return agentNewLine(jid, user, pkgIdIn(t), true);
  if (RE.packages.test(t)) {
    const cat = catalog(user);
    const list = filterPackages(cat, t);
    if (!list.length) return say(jid, 'لا رزم مطابقة. اكتب *الباقات* لعرض كل رزمك.');
    return say(jid, ['📦 *رزمك وأسعارك*', ...packageLines(list, { tags: agentTags }), '',
      'للشحن: *شحن 05XXXXXXXX رقم_الرزمة*', 'لخط eSIM: *esim رقم_الرزمة*'].join('\n'));
  }
  if (RE.code.test(t)) {
    const p = catalog(user).packages.find((x) => x.id === Number(t.replace('#', '')));
    if (!p) return say(jid, 'لا رزمة بهذا الرقم عندك. اكتب *الباقات*.');
    const how = p.kind === 'card' ? `شحن 05XXXXXXXX ${p.id}` : p.pool ? `esim ${p.id}` : '';
    return say(jid, `#${p.id} ${p.companyName} — ${p.name}\nالسعر: *${round(p.price)} ₪*${how ? `\nللطلب: *${how}*` : '\nتُباع من البوابة.'}`);
  }
  const ai = await understand(t, raw, 'agent');
  if (ai) return agentAi(jid, user, ai);
  return say(jid, agentMenu(user));
}

const STATUS = { active: 'فعّال ✅', pending: 'قيد التنفيذ ⏳', disconnected: 'مفصول', expired: 'منتهٍ' };

function agentRecharge(jid, user, number, packageId) {
  if (!number || !packageId) return say(jid, 'اكتب الرقم ورقم الرزمة، مثل: *شحن 0521234567 12*');
  const cat = catalog(user);
  const p = cat.packages.find((x) => x.id === packageId);
  if (!p) return say(jid, `لا رزمة #${packageId} عندك. اكتب *كروت* لرزم الشحن.`);
  if (p.kind !== 'card') return say(jid, `#${p.id} رزمة خط جديد وليست شحناً.${p.pool ? ` لخط eSIM اكتب: *esim ${p.id}*` : ''}`);
  remember(jid, { step: 'confirm', body: { kind: 'external', number, packageId: p.id }, number, label: `${p.companyName} ${p.name}` });
  return say(jid, `شحن *${number}*\n${p.companyName} — ${p.name}\nالسعر: *${round(p.price)} ₪* من رصيدك\n\nأرسل *نعم* للتأكيد أو *لا* للإلغاء.`);
}

async function agentNewLine(jid, user, packageId, esim) {
  if (!packageId) return say(jid, `اكتب رقم الرزمة، مثل: *${esim ? 'esim' : 'تفعيل خط'} 15*`);
  const cat = catalog(user);
  const p = cat.packages.find((x) => x.id === packageId);
  if (!p) return say(jid, `لا رزمة #${packageId} عندك. اكتب *باقات esim*.`);
  if (!p.pool) return say(jid, `#${p.id} لا تختار رقمها من قائمة: بِعها من البوابة.`);
  if (!esim && !p.ownSim) return say(jid, `#${p.id} تُفعَّل كـ eSIM: اكتب *esim ${p.id}*`);
  await say(jid, '⏳ أجلب الأرقام المتاحة…');
  const list = (await require('./routes/quickline').freeNumbersFor(p.id, esim)).slice(0, 10);
  if (!list.length) return say(jid, `لا أرقام متاحة الآن لهذه الرزمة. جرّب لاحقاً أو رزمة أخرى.`);
  const fee = esim ? esimFeeOf(cat, p) : 0;
  remember(jid, { step: 'pick', p: { id: p.id, label: `${p.companyName} ${p.name}`, price: round(p.price + fee) }, esim, list });
  return say(jid, [`📱 الأرقام المتاحة — ${p.companyName} ${p.name}:`, ...list.map((n, i) => `${i + 1}) ${n.phone}`), '',
    'أرسل رقم الاختيار (مثل 1) أو الرقم نفسه.'].join('\n'));
}

// Continues what the agent started; false when the message is something else (it is then handled as new).
async function agentStep(jid, user, s, t, raw) {
  if (s.step === 'pick') {
    const typed = phoneIn(t);
    const n = typed ? s.list.find((x) => x.phone === typed) : s.list[Number(t) - 1];
    if (!n) {
      if (/^\d{1,2}$/.test(t) || typed) return say(jid, 'اختر من القائمة: أرسل رقم الاختيار أو الرقم نفسه.');
      return false;
    }
    remember(jid, { ...s, step: 'name', number: n.phone, numberId: String(n.id) !== n.phone ? Number(n.id) : 0 });
    return say(jid, `الرقم *${n.phone}*. اكتب اسم الزبون:`);
  }
  if (s.step === 'name') {
    const name = str(raw, 80);
    if (name.length < 2 || /^\d+$/.test(name)) return say(jid, 'اكتب اسم الزبون (حرفان على الأقل):');
    const body = { kind: 'new', esim: s.esim, packageId: s.p.id, number: s.number, customerName: name, ...(Number(s.numberId) ? { qlNumberId: Number(s.numberId) } : {}) };
    remember(jid, { step: 'confirm', body, number: s.number, label: s.p.label });
    return say(jid, `${s.esim ? 'خط eSIM' : 'خط جديد'} *${s.number}*\n${s.p.label}\nالزبون: ${name}\nالسعر: *${s.p.price} ₪* من رصيدك\n\nأرسل *نعم* للتأكيد أو *لا* للإلغاء.`);
  }
  if (s.step === 'confirm') {
    if (!RE.yes.test(t)) return say(jid, 'أرسل *نعم* للتأكيد أو *لا* للإلغاء.');
    sessions.delete(jid);
    return placeOrder(jid, user, s.body, s);
  }
  return false;
}

// The portal's own sale: charged here, carried out by the supplier (autoexec), the result sent back when done.
async function placeOrder(jid, user, body, s) {
  const r = tx(() => {
    const out = require('./routes/lines').createLine(user, body);
    const lineId = out.line?.id;
    const task = lineId ? q("SELECT id FROM tasks WHERE line_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(lineId) : null;
    if (task) {
      q('INSERT OR REPLACE INTO wa_orders (task_id, line_id, jid, number, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(task.id, lineId, jid, s.number, s.label, now());
    }
    return { out, task };
  });
  const bal = r.out.balance !== undefined ? `\nرصيدك الآن: ${round(r.out.balance)} ₪` : '';
  if (r.task) return say(jid, `⏳ استلمنا الطلب: ${s.label} للرقم *${s.number}*. يُنفَّذ الآن، وتصلك النتيجة هنا.${bal}`);
  return say(jid, `✅ تم: ${s.label} للرقم *${s.number}*.${bal}`);
}

async function agentAi(jid, user, ai) {
  if (ai.action === 'balance') return agentSays(jid, user, 'رصيدي', 'رصيدي');
  if (ai.action === 'recharge') return agentRecharge(jid, user, normalizePhone(ai.number || ''), Number(ai.packageId) || 0);
  if (ai.action === 'esim') return agentNewLine(jid, user, Number(ai.packageId) || 0, true);
  if (ai.action === 'packages') return agentSays(jid, user, norm(`باقات ${ai.company || ''} ${ai.kind === 'esim' ? 'esim' : ai.kind === 'card' ? 'كروت' : ''}`), '');
  if (ai.action === 'answer' && ai.reply) return say(jid, String(ai.reply).slice(0, 1500));
  return say(jid, agentMenu(user));
}

// ---------- the manager ----------
async function adminSays(jid, user, t) {
  if (RE.orders.test(t) || /^(المهام|مهام)$/.test(t)) {
    const open = q("SELECT id, type, note FROM tasks WHERE status = 'open' ORDER BY id DESC LIMIT 8").all();
    const n = q("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").get().n;
    return say(jid, n ? [`📋 طلبات مفتوحة: ${n}`, ...open.map((x) => `• #${x.id} ${x.note}`)].join('\n') : 'لا طلبات مفتوحة ✅');
  }
  if (RE.status.test(t)) {
    const number = phoneIn(t);
    const l = number && q('SELECT l.*, u.name AS agent_name FROM lines l JOIN users u ON u.id = l.agent_id WHERE l.number = ? ORDER BY l.id DESC LIMIT 1').get(number);
    if (!l) return say(jid, number ? `لا خط بالرقم ${number}.` : 'اكتب الرقم، مثل: حالة 0521234567');
    return say(jid, `📞 ${l.number} — ${l.package_label}\nالوكيل: ${l.agent_name}\nالحالة: *${STATUS[l.status] || l.status}*`);
  }
  if (RE.packages.test(t)) {
    const cat = catalog(user);
    const list = filterPackages({ ...cat, packages: cat.packages.filter((p) => p.active) }, t);
    if (!list.length) return say(jid, 'لا رزم مطابقة.');
    return say(jid, ['📦 *الرزم* (سعر الوكلاء)', ...packageLines(list)].join('\n'));
  }
  return say(jid, ['أهلاً بالمدير 👋', '*الطلبات* — الطلبات المفتوحة', '*الباقات* — الرزم وأسعار الوكلاء', '*حالة 05XXXXXXXX* — حالة أي رقم',
    '', 'البيع والموافقات من البوابة.'].join('\n'));
}

// ---------- customers: the shop's packages, and the shop's link to pay ----------
function shopLink(id, esim) {
  const base = config().shopUrl;
  return base ? `${base}#/buy/${id}${esim ? '?esim=1' : ''}` : '';
}

async function customerSays(jid, t, raw) {
  const shop = require('./routes/shop').shopCatalogResponse();
  const cfg = config();
  const base = cfg.shopUrl;
  if (!shop.enabled) return say(jid, `${cfg.welcome || `أهلاً بك في ${shop.shopName}`}\nالمتجر مغلق الآن. سنرد عليك قريباً.`);
  const menu = () => say(jid, [cfg.welcome || `أهلاً بك في ${shop.shopName} 👋`, '',
    '*الباقات* — الباقات والأسعار (أو اسم الشركة، أو: باقات esim، كروت)', 'أرسل *رقم الباقة* لتطلبها.',
    ...(base ? ['', `🛒 المتجر: ${base}`] : [])].join('\n'));
  if (RE.help.test(t)) return menu();
  const asked = (RE.code.test(t) && Number(t.replace('#', ''))) || ((RE.esim.test(t) || RE.recharge.test(t) || /^(تفعيل|اطلب|شراء)/.test(t)) && pkgIdIn(t));
  if (asked) {
    const p = shop.packages.find((x) => x.id === asked);
    if (!p) return say(jid, 'لا باقة بهذا الرقم. اكتب *الباقات*.');
    const link = shopLink(p.id, p.esim);
    const fee = p.esim && p.esimFee ? ` + ${round(p.esimFee)} ₪ رسوم eSIM` : '';
    return say(jid, [`*${p.companyName} — ${p.name}*`, `السعر: *${round(p.price)} ₪*${fee}`, p.description ? p.description.slice(0, 300) : '', '',
      link ? `للطلب والدفع: ${link}` : 'اطلبها من المتجر.', 'يتم الدفع بجوال باي، وبعد التحقق من الدفع يصلك رمز التفعيل مباشرة.'].filter((x) => x !== '').join('\n'));
  }
  if (RE.packages.test(t) || shop.companies.some((c) => t.includes(norm(c.name)))) {
    const cat = { companies: shop.companies, packages: shop.packages.map((p) => ({ ...p, pool: p.esim })) };
    const list = filterPackages(cat, t);
    if (!list.length) return say(jid, 'لا باقات مطابقة. اكتب *الباقات*.');
    return say(jid, ['📦 *الباقات*', ...packageLines(list, { tags: (p) => (p.esim ? ' · eSIM' : p.kind === 'card' ? ' · شحن' : '') }), '',
      'أرسل *رقم الباقة* (مثل 12) لرابط الطلب والدفع.', ...(base ? [`🛒 ${base}`] : [])].join('\n'));
  }
  const ai = await understand(t, raw, 'customer');
  if (ai?.action === 'package' && ai.packageId) return customerSays(jid, String(ai.packageId), String(ai.packageId));
  if (ai?.action === 'packages') return customerSays(jid, norm(`باقات ${ai.company || ''}`), '');
  if (ai?.action === 'answer' && ai.reply) return say(jid, `${String(ai.reply).slice(0, 1500)}${base ? `\n\n🛒 ${base}` : ''}`);
  return menu();
}

// ---------- optional: free text understood by Gemini (it only chooses among the actions above) ----------
// At most 200 questions an hour go to it (strangers cannot run the key's bill up), and what it writes carries no link.
const aiCalls = [];
const noLinks = (text) => String(text || '').replace(/(?:https?:\/\/|www\.)\S+/gi, '').replace(/\b[\w-]+\.(?:com|net|org|io|me|co|shop|xyz|info)\b\S*/gi, '').trim();
async function understand(t, raw, kind) {
  const cfg = config();
  if (!cfg.aiKey || !raw) return null;
  const hourAgo = Date.now() - 60 * 60_000;
  while (aiCalls.length && aiCalls[0] < hourAgo) aiCalls.shift();
  if (aiCalls.length >= 200) return null;
  aiCalls.push(Date.now());
  const actions = kind === 'agent'
    ? '"balance" | "recharge" (needs number and packageId) | "esim" (needs packageId) | "packages" (company, kind: card|esim|"") | "answer"'
    : '"packages" (company) | "package" (packageId) | "answer"';
  const prompt = `أنت مساعد متجر خطوط وشرائح eSIM وكروت شحن. افهم رسالة ${kind === 'agent' ? 'الوكيل' : 'الزبون'} وأعد JSON فقط:
{"action": ${actions}, "packageId": 0, "number": "", "company": "", "kind": "", "reply": ""}
"answer": رد قصير ومهذب بالعربية في reply، دون أسعار أو وعود غير مذكورة. لا تخترع أرقام رزم.
الرسالة: ${String(raw).slice(0, 500)}`;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.aiModel)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.aiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const v = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || 'null');
    if (!v || typeof v.action !== 'string') return null;
    if (v.reply) v.reply = noLinks(v.reply);
    return v;
  } catch {
    return null;
  }
}

// ---------- results of sales made here ----------
const WHAT = { esim: 'تفعيل eSIM', activate: 'تفعيل الخط', recharge: 'الشحن', renew: 'التمديد', port: 'تحويل الرقم' };

function resultMessages(t, l, o) {
  const number = l?.number || o.number;
  const label = l?.package_label || o.label;
  const response = forAgent(t.response || '');
  if (t.status !== 'done') {
    return [{ text: `❌ لم يُنفَّذ ${WHAT[t.type] || 'الطلب'} للرقم *${number}*${response ? `: ${response}` : ''}.\nأُعيد المبلغ إلى رصيدك.` }];
  }
  if (t.type === 'esim' && l) {
    const code = l.esim_code || '';
    let image = null;
    const m = /^data:image\/png;base64,(.+)$/.exec(l.esim_qr || '');
    if (m) image = Buffer.from(m[1], 'base64');
    else if (/^LPA:/i.test(code)) image = qrcode.png(code, { scale: 8 });
    const caption = `✅ تم تفعيل eSIM للرقم *${number}*\n${label}\n\nامسح الرمز من الهاتف: الإعدادات ← الشبكة الخلوية ← إضافة eSIM.`;
    const out = image ? [{ image, caption }] : [{ text: `${caption}\n\nرمز QR محفوظ عند الرقم في البوابة.` }];
    if (code) out.push({ text: `رمز التفعيل اليدوي:\n${code}` });
    return out;
  }
  return [{ text: `✅ تم ${WHAT[t.type] || 'الطلب'} للرقم *${number}*\n${label}${response && response !== 'نُفّذ تلقائياً' ? `\n${response}` : ''}` }];
}

// Called once a task is done or rejected (routes/tasks.resolveTask), after its transaction.
async function taskResolved(taskId) {
  const o = q('SELECT * FROM wa_orders WHERE task_id = ? AND sent_at IS NULL').get(Number(taskId));
  if (!o || !connected()) return; // sent once WhatsApp is linked again (flush)
  const t = q('SELECT * FROM tasks WHERE id = ?').get(o.task_id);
  if (!t || t.status === 'open') return;
  // Claimed first, so a resolve and a reconnect never send it twice.
  if (!q('UPDATE wa_orders SET sent_at = ? WHERE task_id = ? AND sent_at IS NULL').run(now(), o.task_id).changes) return;
  const l = o.line_id ? q('SELECT * FROM lines WHERE id = ?').get(o.line_id) : null;
  try {
    for (const msg of resultMessages(t, l, o)) await send(o.jid, msg);
  } catch (e) {
    q('UPDATE wa_orders SET sent_at = NULL WHERE task_id = ?').run(o.task_id);
    console.error('whatsapp result', e.message);
  }
}

async function flush() {
  q('DELETE FROM wa_orders WHERE sent_at IS NOT NULL AND sent_at < ?').run(now() - 30 * 864e5);
  const due = q("SELECT w.task_id FROM wa_orders w JOIN tasks t ON t.id = w.task_id WHERE w.sent_at IS NULL AND t.status != 'open'").all();
  for (const r of due) await taskResolved(r.task_id);
}

// Linked before: reconnect when the server starts.
if (linked()) setTimeout(() => start().catch((e) => console.error('whatsapp start', e.message)), 3_000).unref();

module.exports = {
  start, logout, status, config, configView, saveConfig, sendTo, taskResolved, handle,
  _test: { setTransport: (fn) => { transport = fn; }, sessions, recent, norm, onRaw, jidOf },
};
