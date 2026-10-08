'use strict';
// Agents app server: zero dependencies (node:http + node:sqlite + node:crypto). Requires Node 22.13+.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'agents.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 30;

// ---------- database ----------
if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin','agent')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_prices (
  agent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  price REAL NOT NULL,
  PRIMARY KEY (agent_id, package_id)
);
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  offer_price REAL,
  starts_at INTEGER,
  ends_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lines (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  sim TEXT NOT NULL DEFAULT '',
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  package_label TEXT NOT NULL,
  agent_id INTEGER NOT NULL REFERENCES users(id),
  price REAL NOT NULL,
  cost REAL NOT NULL,
  offer_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','disconnected')),
  note TEXT NOT NULL DEFAULT '',
  activated_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  agent_id INTEGER,
  agent_name TEXT NOT NULL DEFAULT '',
  actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  line_id INTEGER,
  number TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  balance_before REAL,
  balance_after REAL,
  cost REAL NOT NULL DEFAULT 0,
  profit REAL NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ops_agent ON ops(agent_id, ts);
CREATE INDEX IF NOT EXISTS lines_agent ON lines(agent_id);
`);

const q = (sql) => db.prepare(sql);
const now = () => Date.now();
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- passwords & sessions ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, now() + SESSION_DAYS * 864e5);
  return token;
}

// ---------- first run ----------
function bootstrap() {
  const admins = q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (!admins) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    let password = process.env.ADMIN_PASSWORD;
    if (!password) {
      password = crypto.randomBytes(6).toString('base64url');
      console.log(`\n*** Admin account created: username "${username}" password "${password}" — change it after first login ***\n`);
    }
    q("INSERT INTO users (role, name, username, password_hash, created_at) VALUES ('admin', 'المدير', ?, ?, ?)").run(username, hashPassword(password), now());
  }
  if (!q('SELECT COUNT(*) AS n FROM companies').get().n) {
    const co = q('INSERT INTO companies (name, sort) VALUES (?, ?)');
    const pk = q('INSERT INTO packages (company_id, name, sort) VALUES (?, ?, ?)');
    const cellcom = co.run('سلكوم', 1).lastInsertRowid;
    pk.run(cellcom, '500 جيجا', 1);
    pk.run(cellcom, '300 جيجا', 2);
    pk.run(cellcom, '100 جيجا', 3);
    pk.run(co.run('بارتنر', 2).lastInsertRowid, 'باقة بارتنر', 1);
    pk.run(co.run('بيلفون', 3).lastInsertRowid, 'باقة بيلفون', 1);
    pk.run(co.run('هوت موبايل', 4).lastInsertRowid, 'باقة هوت موبايل', 1);
  }
}
bootstrap();

// ---------- domain helpers ----------
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new ApiError(status, message); };

const publicUser = (u) => u && ({
  id: u.id, role: u.role, name: u.name, phone: u.phone, username: u.username,
  balance: round(u.balance), notes: u.notes, active: !!u.active, createdAt: u.created_at,
});
const getUser = (id) => q('SELECT * FROM users WHERE id = ?').get(id);
function getAgent(id) {
  const u = q("SELECT * FROM users WHERE id = ? AND role = 'agent'").get(Number(id));
  if (!u) fail(404, 'الوكيل غير موجود');
  return u;
}

function logOp(op) {
  q(`INSERT INTO ops (ts, type, agent_id, agent_name, actor_id, actor_name, line_id, number, amount, balance_before, balance_after, cost, profit, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    now(), op.type, op.agentId ?? null, op.agentName || '', op.actor?.id ?? null, op.actor?.name || '',
    op.lineId ?? null, op.number || '', round(op.amount), op.before ?? null, op.after ?? null,
    round(op.cost), round(op.profit), op.detail || '');
}

function changeBalance(agent, delta, op) {
  const before = round(agent.balance);
  const after = round(before + delta);
  q('UPDATE users SET balance = ? WHERE id = ?').run(after, agent.id);
  agent.balance = after;
  logOp({ ...op, agentId: agent.id, agentName: agent.name, amount: delta, before, after });
}

// Offers currently running (active and within their dates).
const LIVE_OFFER = '(o.active = 1 AND (o.starts_at IS NULL OR o.starts_at <= ?) AND (o.ends_at IS NULL OR o.ends_at >= ?))';

function packagesFor(agentId) {
  return q(`SELECT p.id, p.name, p.company_id AS companyId, c.name AS companyName, p.active,
              COALESCE(ap.price, p.price) AS price, ap.price IS NOT NULL AS custom
            FROM packages p JOIN companies c ON c.id = p.company_id
            LEFT JOIN agent_prices ap ON ap.package_id = p.id AND ap.agent_id = ?
            WHERE p.active = 1 ORDER BY c.sort, c.id, p.sort, p.id`).all(agentId)
    .map((p) => ({ ...p, price: round(p.price), custom: !!p.custom, active: !!p.active }))
    // A package with no price set yet is not offered to agents.
    .filter((p) => p.price > 0);
}

function priceFor(agentId, packageId) {
  const p = q(`SELECT p.*, c.name AS company_name, COALESCE(ap.price, p.price) AS agent_price
               FROM packages p JOIN companies c ON c.id = p.company_id
               LEFT JOIN agent_prices ap ON ap.package_id = p.id AND ap.agent_id = ?
               WHERE p.id = ?`).get(agentId, Number(packageId));
  if (!p || !p.active) fail(404, 'الباقة غير متوفرة');
  return p;
}

const lineRow = (l) => l && ({
  id: l.id, number: l.number, sim: l.sim, packageId: l.package_id, packageLabel: l.package_label,
  agentId: l.agent_id, agentName: l.agent_name, price: round(l.price), status: l.status, note: l.note,
  activatedAt: l.activated_at, updatedAt: l.updated_at, offerId: l.offer_id,
  ...(l.cost !== undefined && l.withCost ? { cost: round(l.cost) } : {}),
});

function getLine(id, user) {
  const l = q('SELECT l.*, u.name AS agent_name FROM lines l JOIN users u ON u.id = l.agent_id WHERE l.id = ?').get(Number(id));
  if (!l || (user.role === 'agent' && l.agent_id !== user.id)) fail(404, 'الرقم غير موجود');
  return l;
}

const cleanNumber = (s) => String(s || '').replace(/[^\d+]/g, '');
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) fail(400, `قيمة غير صحيحة: ${name}`);
  return round(n);
};
const dateOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t)) fail(400, 'تاريخ غير صحيح');
  return t;
};

// ---------- routes ----------
const routes = [];
const route = (method, pattern, roles, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, roles, handler });
};
const ADMIN = ['admin'];
const ANY = ['admin', 'agent'];

// Login attempts: simple in-memory throttle per username+ip.
const attempts = new Map();
route('POST', '/api/login', null, ({ body, ip }) => {
  const username = str(body.username, 64);
  const key = username.toLowerCase() + '|' + ip;
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > now()) fail(429, 'محاولات كثيرة. حاول بعد دقيقة.');
  const u = q('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) {
    a.n += 1;
    if (a.n >= 5) { a.until = now() + 60_000; a.n = 0; }
    attempts.set(key, a);
    fail(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
  }
  attempts.delete(key);
  if (!u.active) fail(403, 'هذا الحساب موقوف. تواصل مع المدير.');
  return { token: createSession(u.id), user: publicUser(u) };
});

route('POST', '/api/logout', ANY, ({ token }) => {
  q('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  return { ok: true };
});

route('GET', '/api/me', ANY, ({ user }) => ({ user: publicUser(user) }));

route('POST', '/api/me/password', ANY, ({ user, body }) => {
  if (!verifyPassword(String(body.current || ''), user.password_hash)) fail(400, 'كلمة المرور الحالية غير صحيحة');
  const pw = String(body.password || '');
  if (pw.length < 6) fail(400, 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل');
  q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), user.id);
  return { ok: true };
});

// Catalog as the current user sees it. Agents get their own price and never the cost.
route('GET', '/api/catalog', ANY, ({ user }) => {
  const companies = q('SELECT id, name, sort FROM companies ORDER BY sort, id').all();
  if (user.role === 'agent') return { companies, packages: packagesFor(user.id) };
  const packages = q(`SELECT p.id, p.name, p.company_id AS companyId, c.name AS companyName, p.cost, p.price, p.active, p.sort
                      FROM packages p JOIN companies c ON c.id = p.company_id ORDER BY c.sort, c.id, p.sort, p.id`).all()
    .map((p) => ({ ...p, active: !!p.active }));
  return { companies, packages };
});

route('GET', '/api/offers', ANY, ({ user }) => {
  const t = now();
  const agent = user.role === 'agent';
  const rows = q(`SELECT o.*, p.name AS package_name, c.name AS company_name, p.active AS package_active
                  FROM offers o LEFT JOIN packages p ON p.id = o.package_id LEFT JOIN companies c ON c.id = p.company_id
                  ${agent ? `WHERE ${LIVE_OFFER}` : ''} ORDER BY o.created_at DESC`).all(...(agent ? [t, t] : []));
  return rows
    .filter((o) => !agent || !o.package_id || o.package_active)
    .map((o) => ({
      id: o.id, title: o.title, details: o.details, packageId: o.package_id,
      packageLabel: o.package_id ? `${o.company_name} ${o.package_name}` : '',
      offerPrice: o.offer_price === null ? null : round(o.offer_price),
      regularPrice: o.package_id && agent ? round(priceFor(user.id, o.package_id).agent_price) : undefined,
      startsAt: o.starts_at, endsAt: o.ends_at, active: !!o.active,
      live: !!o.active && (o.starts_at === null || o.starts_at <= t) && (o.ends_at === null || o.ends_at >= t),
    }));
});

route('GET', '/api/lines', ANY, ({ user, query }) => {
  const args = [];
  let where = '1=1';
  if (user.role === 'agent') { where += ' AND l.agent_id = ?'; args.push(user.id); }
  else if (query.agentId) { where += ' AND l.agent_id = ?'; args.push(Number(query.agentId)); }
  if (query.status) { where += ' AND l.status = ?'; args.push(String(query.status)); }
  return q(`SELECT l.*, u.name AS agent_name FROM lines l JOIN users u ON u.id = l.agent_id WHERE ${where} ORDER BY l.activated_at DESC LIMIT 2000`)
    .all(...args).map((l) => lineRow({ ...l, withCost: user.role === 'admin' }));
});

route('POST', '/api/lines', ANY, ({ user, body }) => tx(() => {
  const agent = user.role === 'agent' ? getUser(user.id) : getAgent(body.agentId);
  if (!agent.active) fail(403, 'حساب الوكيل موقوف');
  const number = cleanNumber(body.number);
  if (number.length < 7 || number.length > 15) fail(400, 'أدخل رقم خط صحيح');
  if (q('SELECT 1 FROM lines WHERE number = ?').get(number)) fail(409, `الرقم ${number} مفعّل مسبقاً`);
  let pkg;
  let price;
  let offer = null;
  if (body.offerId) {
    const t = now();
    offer = q(`SELECT o.* FROM offers o WHERE o.id = ? AND ${LIVE_OFFER}`).get(Number(body.offerId), t, t);
    if (!offer || !offer.package_id) fail(400, 'هذا العرض غير متاح للتفعيل');
    pkg = priceFor(agent.id, offer.package_id);
    price = offer.offer_price === null ? round(pkg.agent_price) : round(offer.offer_price);
  } else {
    pkg = priceFor(agent.id, body.packageId);
    price = round(pkg.agent_price);
  }
  // Only the admin may override the price for a single activation.
  if (user.role === 'admin' && body.price !== undefined && body.price !== '') price = num(body.price, 'السعر');
  if (user.role === 'agent' && !(price > 0)) fail(400, 'لم يحدد المدير سعر هذه الباقة بعد');
  if (agent.balance < price) fail(400, `الرصيد لا يكفي. الرصيد ${round(agent.balance)} والسعر ${price}`);
  const label = `${pkg.company_name} ${pkg.name}`;
  const t = now();
  const lineId = q(`INSERT INTO lines (number, sim, package_id, package_label, agent_id, price, cost, offer_id, note, activated_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(number, str(body.sim, 40), pkg.id, label, agent.id, price, pkg.cost, offer?.id ?? null, str(body.note), t, t).lastInsertRowid;
  changeBalance(agent, -price, {
    type: 'activate', actor: user, lineId, number, cost: pkg.cost, profit: price - pkg.cost,
    detail: `${label}${offer ? ' — عرض: ' + offer.title : ''}`,
  });
  return { line: lineRow(getLine(lineId, user)), balance: round(agent.balance) };
}));

const LINE_ACTIONS = {
  freeze: { from: ['active'], to: 'frozen', label: 'تجميد الرقم' },
  unfreeze: { from: ['frozen'], to: 'active', label: 'إلغاء التجميد' },
  disconnect: { from: ['active', 'frozen'], to: 'disconnected', label: 'فصل الرقم' },
};
route('POST', '/api/lines/:id/action', ANY, ({ user, params, body }) => tx(() => {
  const l = getLine(params.id, user);
  const agent = getUser(l.agent_id);
  const action = String(body.action);
  if (action === 'swap_sim') {
    if (l.status === 'disconnected') fail(400, 'لا يمكن تبديل شريحة رقم مفصول');
    const sim = str(body.sim, 40);
    if (sim.length < 6) fail(400, 'أدخل رقم الشريحة الجديدة');
    q('UPDATE lines SET sim = ?, updated_at = ? WHERE id = ?').run(sim, now(), l.id);
    logOp({ type: 'swap_sim', agentId: agent.id, agentName: agent.name, actor: user, lineId: l.id, number: l.number,
      before: agent.balance, after: agent.balance, detail: `الشريحة القديمة ${l.sim || '—'} ← الجديدة ${sim}` });
  } else {
    const a = LINE_ACTIONS[action];
    if (!a) fail(400, 'إجراء غير معروف');
    if (!a.from.includes(l.status)) fail(400, 'لا يمكن تنفيذ هذا الإجراء على حالة الرقم الحالية');
    q('UPDATE lines SET status = ?, updated_at = ? WHERE id = ?').run(a.to, now(), l.id);
    logOp({ type: action, agentId: agent.id, agentName: agent.name, actor: user, lineId: l.id, number: l.number,
      before: agent.balance, after: agent.balance, detail: a.label + (body.reason ? ' — ' + str(body.reason) : '') });
  }
  return { line: lineRow(getLine(l.id, user)) };
}));

route('POST', '/api/lines/:id/move', ADMIN, ({ user, params, body }) => tx(() => {
  const l = getLine(params.id, user);
  const from = getUser(l.agent_id);
  const to = getAgent(body.toAgentId);
  if (to.id === from.id) fail(400, 'اختر وكيلاً آخر');
  const detail = `نقل ${l.number} من ${from.name} إلى ${to.name}`;
  if (body.withMoney) {
    if (to.balance < l.price) fail(400, `رصيد ${to.name} لا يكفي`);
    changeBalance(from, l.price, { type: 'line_move', actor: user, lineId: l.id, number: l.number, detail });
    changeBalance(to, -l.price, { type: 'line_move', actor: user, lineId: l.id, number: l.number, detail });
  } else {
    logOp({ type: 'line_move', agentId: to.id, agentName: to.name, actor: user, lineId: l.id, number: l.number, before: to.balance, after: to.balance, detail });
  }
  q('UPDATE lines SET agent_id = ?, updated_at = ? WHERE id = ?').run(to.id, now(), l.id);
  return { line: lineRow(getLine(l.id, user)) };
}));

route('DELETE', '/api/lines/:id', ADMIN, ({ user, params, query }) => tx(() => {
  const l = getLine(params.id, user);
  const agent = getUser(l.agent_id);
  if (query.refund === '1') changeBalance(agent, l.price, { type: 'line_delete', actor: user, number: l.number, cost: -l.cost, detail: 'حذف الخط مع إرجاع المبلغ' });
  else logOp({ type: 'line_delete', agentId: agent.id, agentName: agent.name, actor: user, number: l.number, before: agent.balance, after: agent.balance, detail: 'حذف الخط' });
  q('DELETE FROM lines WHERE id = ?').run(l.id);
  return { ok: true };
}));

route('GET', '/api/ops', ANY, ({ user, query }) => {
  const args = [];
  let where = '1=1';
  const agentId = user.role === 'agent' ? user.id : Number(query.agentId) || null;
  if (agentId) { where += ' AND agent_id = ?'; args.push(agentId); }
  if (query.type) { where += ' AND type = ?'; args.push(String(query.type)); }
  const limit = Math.min(Number(query.limit) || 200, 1000);
  return q(`SELECT * FROM ops WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ${limit}`).all(...args).map((o) => ({
    id: o.id, ts: o.ts, type: o.type, agentId: o.agent_id, agentName: o.agent_name, actorName: o.actor_name,
    number: o.number, amount: round(o.amount), before: o.balance_before, after: o.balance_after, detail: o.detail,
    ...(user.role === 'admin' ? { cost: round(o.cost), profit: round(o.profit) } : {}),
  }));
});

route('GET', '/api/summary', ANY, ({ user }) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const s = start.getTime();
  if (user.role === 'agent') {
    const me = getUser(user.id);
    return {
      balance: round(me.balance),
      today: q("SELECT COUNT(*) AS n FROM ops WHERE agent_id = ? AND type = 'activate' AND ts >= ?").get(user.id, s).n,
      lines: q("SELECT COUNT(*) AS n FROM lines WHERE agent_id = ? AND status != 'disconnected'").get(user.id).n,
    };
  }
  const today = q("SELECT COUNT(*) AS n, COALESCE(SUM(profit),0) AS p FROM ops WHERE type = 'activate' AND ts >= ?").get(s);
  return {
    balances: round(q("SELECT COALESCE(SUM(balance),0) AS b FROM users WHERE role = 'agent'").get().b),
    agents: q("SELECT COUNT(*) AS n FROM users WHERE role = 'agent'").get().n,
    today: today.n, profitToday: round(today.p),
    lines: q("SELECT COUNT(*) AS n FROM lines WHERE status != 'disconnected'").get().n,
  };
});

// ----- admin: agents -----
route('GET', '/api/agents', ADMIN, () => q(`SELECT u.*, (SELECT COUNT(*) FROM lines l WHERE l.agent_id = u.id AND l.status != 'disconnected') AS line_count
  FROM users u WHERE role = 'agent' ORDER BY name`).all().map((u) => ({ ...publicUser(u), lineCount: u.line_count })));

function validUsername(u) {
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(u)) fail(400, 'اسم المستخدم: 3 أحرف إنجليزية أو أرقام على الأقل، بدون مسافات');
  return u;
}

route('POST', '/api/agents', ADMIN, ({ user, body }) => tx(() => {
  const name = str(body.name, 80);
  if (!name) fail(400, 'اكتب اسم الوكيل');
  const username = validUsername(str(body.username, 32));
  if (q('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'اسم المستخدم مستخدم من قبل');
  const pw = String(body.password || '');
  if (pw.length < 6) fail(400, 'كلمة المرور 6 أحرف على الأقل');
  const id = q("INSERT INTO users (role, name, phone, username, password_hash, notes, created_at) VALUES ('agent', ?, ?, ?, ?, ?, ?)")
    .run(name, str(body.phone, 30), username, hashPassword(pw), str(body.notes, 500), now()).lastInsertRowid;
  const opening = round(body.balance);
  if (opening) changeBalance(getUser(id), opening, { type: 'topup', actor: user, detail: 'رصيد افتتاحي' });
  return publicUser(getUser(id));
}));

route('PUT', '/api/agents/:id', ADMIN, ({ params, body }) => {
  const a = getAgent(params.id);
  const name = str(body.name ?? a.name, 80);
  if (!name) fail(400, 'اكتب اسم الوكيل');
  const username = validUsername(str(body.username ?? a.username, 32));
  if (q('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, a.id)) fail(409, 'اسم المستخدم مستخدم من قبل');
  const active = body.active === undefined ? a.active : body.active ? 1 : 0;
  q('UPDATE users SET name = ?, phone = ?, username = ?, notes = ?, active = ? WHERE id = ?')
    .run(name, str(body.phone ?? a.phone, 30), username, str(body.notes ?? a.notes, 500), active, a.id);
  if (body.password) {
    if (String(body.password).length < 6) fail(400, 'كلمة المرور 6 أحرف على الأقل');
    q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.password)), a.id);
    q('DELETE FROM sessions WHERE user_id = ?').run(a.id);
  }
  if (!active) q('DELETE FROM sessions WHERE user_id = ?').run(a.id);
  return publicUser(getUser(a.id));
});

route('DELETE', '/api/agents/:id', ADMIN, ({ params }) => {
  const a = getAgent(params.id);
  if (q('SELECT 1 FROM lines WHERE agent_id = ?').get(a.id)) fail(400, 'لدى الوكيل أرقام. انقلها أو احذفها أولاً، أو أوقف الحساب بدلاً من حذفه.');
  q('DELETE FROM users WHERE id = ?').run(a.id);
  return { ok: true };
});

route('POST', '/api/agents/:id/balance', ADMIN, ({ user, params, body }) => tx(() => {
  const a = getAgent(params.id);
  const amount = num(body.amount, 'المبلغ');
  const kind = String(body.kind);
  let delta;
  if (kind === 'topup') delta = amount;
  else if (kind === 'deduct') delta = -amount;
  else if (kind === 'set') delta = round(amount - a.balance);
  else fail(400, 'نوع العملية غير معروف');
  if (kind !== 'set' && !(amount > 0)) fail(400, 'أدخل مبلغاً أكبر من صفر');
  if (!delta) fail(400, 'الرصيد لم يتغير');
  changeBalance(a, delta, { type: delta > 0 ? 'topup' : 'deduct', actor: user, detail: str(body.note) || (kind === 'set' ? 'تعيين رصيد' : '') });
  return publicUser(getUser(a.id));
}));

route('POST', '/api/transfer', ADMIN, ({ user, body }) => tx(() => {
  const from = getAgent(body.fromId);
  const to = getAgent(body.toId);
  if (from.id === to.id) fail(400, 'اختر وكيلين مختلفين');
  const amount = num(body.amount, 'المبلغ');
  if (!(amount > 0)) fail(400, 'أدخل مبلغاً أكبر من صفر');
  if (from.balance < amount) fail(400, `رصيد ${from.name} لا يكفي`);
  changeBalance(from, -amount, { type: 'transfer_out', actor: user, detail: `إلى ${to.name}` });
  changeBalance(to, amount, { type: 'transfer_in', actor: user, detail: `من ${from.name}` });
  return { ok: true };
}));

// Per-agent prices: list every package with the agent's price (custom or default).
route('GET', '/api/agents/:id/prices', ADMIN, ({ params }) => {
  const a = getAgent(params.id);
  return q(`SELECT p.id AS packageId, c.name AS companyName, p.name, p.cost, p.price AS defaultPrice, ap.price AS customPrice
            FROM packages p JOIN companies c ON c.id = p.company_id
            LEFT JOIN agent_prices ap ON ap.package_id = p.id AND ap.agent_id = ?
            ORDER BY c.sort, c.id, p.sort, p.id`).all(a.id);
});
route('PUT', '/api/agents/:id/prices', ADMIN, ({ params, body }) => tx(() => {
  const a = getAgent(params.id);
  for (const item of Array.isArray(body.prices) ? body.prices : []) {
    const pid = Number(item.packageId);
    if (item.price === null || item.price === '' || item.price === undefined) {
      q('DELETE FROM agent_prices WHERE agent_id = ? AND package_id = ?').run(a.id, pid);
    } else {
      const price = num(item.price, 'السعر');
      if (price < 0) fail(400, 'السعر لا يكون سالباً');
      q('INSERT INTO agent_prices (agent_id, package_id, price) VALUES (?, ?, ?) ON CONFLICT(agent_id, package_id) DO UPDATE SET price = excluded.price').run(a.id, pid, price);
    }
  }
  return { ok: true };
}));

// ----- admin: companies & packages -----
route('POST', '/api/companies', ADMIN, ({ body }) => {
  const name = str(body.name, 60);
  if (!name) fail(400, 'اكتب اسم الشركة');
  if (q('SELECT 1 FROM companies WHERE name = ?').get(name)) fail(409, 'الشركة موجودة');
  const sort = q('SELECT COALESCE(MAX(sort),0)+1 AS s FROM companies').get().s;
  return { id: Number(q('INSERT INTO companies (name, sort) VALUES (?, ?)').run(name, sort).lastInsertRowid) };
});
route('PUT', '/api/companies/:id', ADMIN, ({ params, body }) => {
  const name = str(body.name, 60);
  if (!name) fail(400, 'اكتب اسم الشركة');
  if (q('SELECT 1 FROM companies WHERE name = ? AND id != ?').get(name, Number(params.id))) fail(409, 'الشركة موجودة');
  q('UPDATE companies SET name = ? WHERE id = ?').run(name, Number(params.id));
  return { ok: true };
});
route('DELETE', '/api/companies/:id', ADMIN, ({ params }) => {
  if (q('SELECT 1 FROM packages WHERE company_id = ?').get(Number(params.id))) fail(400, 'احذف باقات الشركة أولاً');
  q('DELETE FROM companies WHERE id = ?').run(Number(params.id));
  return { ok: true };
});

function packageFields(body, existing = {}) {
  const companyId = Number(body.companyId ?? existing.company_id);
  if (!q('SELECT 1 FROM companies WHERE id = ?').get(companyId)) fail(400, 'اختر الشركة');
  const name = str(body.name ?? existing.name, 80);
  if (!name) fail(400, 'اكتب اسم الباقة');
  const cost = num(body.cost ?? existing.cost ?? 0, 'التكلفة');
  const price = num(body.price ?? existing.price ?? 0, 'السعر');
  if (cost < 0 || price < 0) fail(400, 'الأسعار لا تكون سالبة');
  const active = body.active === undefined ? (existing.active ?? 1) : body.active ? 1 : 0;
  return { companyId, name, cost, price, active };
}
route('POST', '/api/packages', ADMIN, ({ body }) => {
  const f = packageFields(body);
  const sort = q('SELECT COALESCE(MAX(sort),0)+1 AS s FROM packages WHERE company_id = ?').get(f.companyId).s;
  return { id: Number(q('INSERT INTO packages (company_id, name, cost, price, active, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(f.companyId, f.name, f.cost, f.price, f.active, sort).lastInsertRowid) };
});
route('PUT', '/api/packages/:id', ADMIN, ({ params, body }) => {
  const p = q('SELECT * FROM packages WHERE id = ?').get(Number(params.id));
  if (!p) fail(404, 'الباقة غير موجودة');
  const f = packageFields(body, p);
  q('UPDATE packages SET company_id = ?, name = ?, cost = ?, price = ?, active = ? WHERE id = ?').run(f.companyId, f.name, f.cost, f.price, f.active, p.id);
  return { ok: true };
});
route('DELETE', '/api/packages/:id', ADMIN, ({ params }) => {
  // Lines keep their package label, so deleting a package never loses history.
  q('DELETE FROM packages WHERE id = ?').run(Number(params.id));
  return { ok: true };
});

// ----- admin: offers -----
function offerFields(body, existing = {}) {
  const title = str(body.title ?? existing.title, 100);
  if (!title) fail(400, 'اكتب عنوان العرض');
  const packageId = body.packageId === undefined ? existing.package_id ?? null : body.packageId ? Number(body.packageId) : null;
  if (packageId && !q('SELECT 1 FROM packages WHERE id = ?').get(packageId)) fail(400, 'الباقة غير موجودة');
  const rawPrice = body.offerPrice === undefined ? existing.offer_price : body.offerPrice;
  const offerPrice = rawPrice === null || rawPrice === '' || rawPrice === undefined ? null : num(rawPrice, 'سعر العرض');
  const startsAt = body.startsAt === undefined ? existing.starts_at ?? null : dateOrNull(body.startsAt);
  const endsAt = body.endsAt === undefined ? existing.ends_at ?? null : dateOrNull(body.endsAt);
  if (startsAt && endsAt && endsAt < startsAt) fail(400, 'تاريخ النهاية قبل تاريخ البداية');
  const active = body.active === undefined ? (existing.active ?? 1) : body.active ? 1 : 0;
  return { title, details: str(body.details ?? existing.details, 1000), packageId, offerPrice, startsAt, endsAt, active };
}
route('POST', '/api/offers', ADMIN, ({ body }) => {
  const f = offerFields(body);
  return { id: Number(q('INSERT INTO offers (title, details, package_id, offer_price, starts_at, ends_at, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(f.title, f.details, f.packageId, f.offerPrice, f.startsAt, f.endsAt, f.active, now()).lastInsertRowid) };
});
route('PUT', '/api/offers/:id', ADMIN, ({ params, body }) => {
  const o = q('SELECT * FROM offers WHERE id = ?').get(Number(params.id));
  if (!o) fail(404, 'العرض غير موجود');
  const f = offerFields(body, o);
  q('UPDATE offers SET title = ?, details = ?, package_id = ?, offer_price = ?, starts_at = ?, ends_at = ?, active = ? WHERE id = ?')
    .run(f.title, f.details, f.packageId, f.offerPrice, f.startsAt, f.endsAt, f.active, o.id);
  return { ok: true };
});
route('DELETE', '/api/offers/:id', ADMIN, ({ params }) => {
  q('DELETE FROM offers WHERE id = ?').run(Number(params.id));
  return { ok: true };
});

// ---------- http plumbing ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new ApiError(413, 'الطلب كبير جداً')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ApiError(400, 'بيانات غير صالحة')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
    ...SECURITY_HEADERS,
  });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, decodeURIComponent(url.pathname));
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) fail(404, 'غير موجود');
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    let user = null;
    let token = null;
    if (r.roles) {
      token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const s = token && q('SELECT * FROM sessions WHERE token_hash = ?').get(sha(token));
      if (!s || s.expires_at < now()) fail(401, 'انتهت الجلسة. سجّل الدخول مرة أخرى.');
      user = getUser(s.user_id);
      if (!user || !user.active) fail(401, 'الحساب غير متاح');
      if (!r.roles.includes(user.role)) fail(403, 'ليست لديك صلاحية لهذه العملية');
    }
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const ip = req.socket.remoteAddress || '';
    const out = await r.handler({ req, user, token, params, body, query: Object.fromEntries(url.searchParams), ip });
    send(res, 200, out);
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'حدث خطأ في الخادم' });
  }
}

const server = http.createServer(handle);
if (require.main === module) {
  server.listen(PORT, () => console.log(`Agents app running on http://localhost:${PORT}`));
}
module.exports = { server, db };
