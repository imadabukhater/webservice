'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./passwords');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'agents.db');
if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const LINES_DDL = `
CREATE TABLE lines (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL,
  sim TEXT NOT NULL DEFAULT '',
  company_id INTEGER,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  package_label TEXT NOT NULL,
  agent_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'new' CHECK (kind IN ('new','external')),
  esim INTEGER NOT NULL DEFAULT 0,
  port INTEGER NOT NULL DEFAULT 0,
  months INTEGER NOT NULL DEFAULT 1,
  price REAL NOT NULL,
  cost REAL NOT NULL,
  offer_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','frozen','disconnected')),
  customer_name TEXT NOT NULL DEFAULT '',
  customer_price REAL,
  note TEXT NOT NULL DEFAULT '',
  esim_code TEXT NOT NULL DEFAULT '',
  esim_qr TEXT NOT NULL DEFAULT '',
  activated_at INTEGER NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
)`;

const tableSql = (name) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.sql;

// Version 1 of the app kept phone numbers unique forever and had no 'pending' status. Rebuild that table once.
function migrateLines() {
  const sql = tableSql('lines');
  if (!sql || sql.includes("'pending'")) return;
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE lines RENAME TO lines_v1; DROP INDEX IF EXISTS lines_agent;');
    db.exec(LINES_DDL);
    db.exec(`INSERT INTO lines (id, number, sim, package_id, package_label, agent_id, price, cost, offer_id, status, note, activated_at, updated_at)
             SELECT id, number, sim, package_id, package_label, agent_id, price, cost, offer_id, status, note, activated_at, updated_at FROM lines_v1;
             DROP TABLE lines_v1;`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
migrateLines();

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin','agent')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0,
  credit_limit REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  notif_seen_at INTEGER NOT NULL DEFAULT 0,
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
  sort INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  iccid_prefixes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  data_gb REAL,
  minutes INTEGER,
  sms INTEGER,
  tag TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS agent_prices (
  agent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  price REAL NOT NULL,
  PRIMARY KEY (agent_id, package_id)
);
-- The manager's profit percentage for one agent on one pricing system (see domain.SYSTEM_SQL).
CREATE TABLE IF NOT EXISTS agent_markups (
  agent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  system TEXT NOT NULL CHECK (system IN ('invoice','card','qlinvoice','qlcard')),
  markup REAL NOT NULL,
  PRIMARY KEY (agent_id, system)
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
CREATE TABLE IF NOT EXISTS sims (
  id INTEGER PRIMARY KEY,
  iccid TEXT NOT NULL UNIQUE,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','used')),
  line_id INTEGER,
  created_at INTEGER NOT NULL,
  used_at INTEGER
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
  detail TEXT NOT NULL DEFAULT '',
  package TEXT NOT NULL DEFAULT '',
  customer_price REAL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_admin INTEGER NOT NULL DEFAULT 0,
  sender_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  ts INTEGER NOT NULL,
  read_at INTEGER
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  agent_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected')),
  issue_date INTEGER NOT NULL,
  due_date INTEGER,
  paid_date INTEGER,
  notes TEXT NOT NULL DEFAULT ''
);
`);
if (!tableSql('lines')) db.exec(LINES_DDL);

// activate / recharge / renew: sales the manager carries out by hand on the company's site.
// payload: JSON with what a renewal applies once it is done.
const TASKS_DDL = `
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('topup','port','esim','general','activate','recharge','renew')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','rejected')),
  agent_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  line_id INTEGER,
  amount REAL,
  note TEXT NOT NULL DEFAULT '',
  response TEXT NOT NULL DEFAULT '',
  attachment TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT NOT NULL DEFAULT ''
)`;
// Earlier versions allowed fewer task types; SQLite cannot change a CHECK, so rebuild the table once.
function migrateTasks() {
  const sql = tableSql('tasks');
  if (!sql) { db.exec(TASKS_DDL); return; }
  if (sql.includes("'renew'")) return;
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE tasks RENAME TO tasks_v2; DROP INDEX IF EXISTS tasks_status;');
    db.exec(TASKS_DDL);
    db.exec(`INSERT INTO tasks (id, type, status, agent_id, line_id, amount, note, response, attachment, created_at, resolved_at, resolved_by)
             SELECT id, type, status, agent_id, line_id, amount, note, response, attachment, created_at, resolved_at, resolved_by FROM tasks_v2;
             DROP TABLE tasks_v2;`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
migrateTasks();
db.exec(`
CREATE INDEX IF NOT EXISTS lines_agent ON lines(agent_id);
CREATE INDEX IF NOT EXISTS lines_number ON lines(number);
CREATE INDEX IF NOT EXISTS lines_expires ON lines(expires_at);
CREATE INDEX IF NOT EXISTS ops_agent ON ops(agent_id, ts);
CREATE INDEX IF NOT EXISTS ops_ts ON ops(ts);
CREATE INDEX IF NOT EXISTS ops_line ON ops(line_id);
CREATE INDEX IF NOT EXISTS sims_agent ON sims(agent_id, status);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS notif_user ON notifications(user_id, ts);
CREATE INDEX IF NOT EXISTS messages_agent ON messages(agent_id, id);
`);

// Columns added after version 1.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('users', 'credit_limit', 'credit_limit REAL NOT NULL DEFAULT 0');
ensureColumn('users', 'notif_seen_at', 'notif_seen_at INTEGER NOT NULL DEFAULT 0');
ensureColumn('companies', 'color', "color TEXT NOT NULL DEFAULT ''");
ensureColumn('companies', 'logo', "logo TEXT NOT NULL DEFAULT ''");
ensureColumn('companies', 'iccid_prefixes', "iccid_prefixes TEXT NOT NULL DEFAULT ''");
ensureColumn('packages', 'data_gb', 'data_gb REAL');
ensureColumn('packages', 'minutes', 'minutes INTEGER');
ensureColumn('packages', 'sms', 'sms INTEGER');
ensureColumn('packages', 'tag', "tag TEXT NOT NULL DEFAULT ''");
ensureColumn('packages', 'description', "description TEXT NOT NULL DEFAULT ''");
ensureColumn('ops', 'package', "package TEXT NOT NULL DEFAULT ''");
ensureColumn('ops', 'customer_price', 'customer_price REAL');
// manual: the agent's sale becomes a request the manager carries out; direct: active at once, no disconnect or refund.
ensureColumn('companies', 'activation', "activation TEXT NOT NULL DEFAULT 'manual'");
ensureColumn('lines', 'direct', 'direct INTEGER NOT NULL DEFAULT 0');
// art-topup: the card a package stands for, and the state of a request sent there automatically
// (auto_status: '' not sent, sending, sent, done, failed, unknown; auto_ref: last operation id seen before sending).
ensureColumn('packages', 'art_card_id', "art_card_id TEXT NOT NULL DEFAULT ''");
// Two separate systems: 'invoice' = activating a new line (SIM), 'card' = recharging a number (card, bundle, cash).
// days: fixed duration of the package (e.g. a 90-day invoice); null = priced per month.
// edited: the manager changed it by hand, so an art-topup sync only refreshes its cost.
ensureColumn('packages', 'kind', "kind TEXT NOT NULL DEFAULT 'invoice'");
ensureColumn('packages', 'days', 'days INTEGER');
ensureColumn('packages', 'edited', 'edited INTEGER NOT NULL DEFAULT 0');
ensureColumn('lines', 'days', 'days INTEGER');
db.exec("UPDATE packages SET kind = 'card' WHERE kind != 'card' AND (art_card_id LIKE 'ic:%' OR art_card_id LIKE 'pb:%' OR art_card_id LIKE 'pc:%')");
// art_price: the portal's current price, refreshed by every sync and used when buying there. cost and price change
// only with the manager's approval; art_ack is a portal price the manager chose to ignore.
// These three columns serve every supplier, not only art-topup: art_card_id says which one and how to buy.
//   ic:/pb:/pc: art-topup card, bundle or cash · inv: art-topup invoice
//   ql:<package>:<days> QuickLine extension · qln:<package>:<days> QuickLine new line
ensureColumn('packages', 'art_price', 'art_price REAL');
ensureColumn('packages', 'art_ack', 'art_ack REAL');
db.exec("UPDATE packages SET art_price = cost WHERE art_card_id != '' AND art_price IS NULL");
ensureColumn('tasks', 'auto_status', "auto_status TEXT NOT NULL DEFAULT ''");
ensureColumn('tasks', 'auto_note', "auto_note TEXT NOT NULL DEFAULT ''");
ensureColumn('tasks', 'auto_ref', "auto_ref TEXT NOT NULL DEFAULT ''");
ensureColumn('tasks', 'auto_at', 'auto_at INTEGER');
// QuickLine lines: a state change made here (close, pause, activate) still to be carried out there.
ensureColumn('lines', 'ql_pending', "ql_pending TEXT NOT NULL DEFAULT ''");
// QuickLine lines: a new SIM put on the line here, still to be put on it there.
ensureColumn('lines', 'ql_sim', "ql_sim TEXT NOT NULL DEFAULT ''");

const q = (sql) => db.prepare(sql);

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

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  app_name: 'بوابة الوكلاء', warn_days: '7', low_balance: '50', esim_fee: '7', support_whatsapp: '972567725080',
  art_user: '', art_pass: '', art_markup: '15',
  ql_user: '', ql_pass: '', ql_markup: '15',
};
function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of q('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return {
    appName: out.app_name,
    warnDays: Math.max(1, Number(out.warn_days) || 7),
    lowBalance: Number(out.low_balance) || 0,
    esimFee: Math.max(0, Number(out.esim_fee) || 0),
    supportWhatsapp: out.support_whatsapp,
    // art-topup sign-in: the password never leaves the server (see artCredentials).
    artUser: out.art_user,
    artConfigured: !!(out.art_user && out.art_pass),
    // The manager's profit on top of art-topup's price, separately for recharge cards and for invoices
    // (both start from the older single art_markup).
    artMarkupCard: Math.max(0, Number(out.art_markup_card ?? out.art_markup) || 0),
    artMarkupInvoice: Math.max(0, Number(out.art_markup_invoice ?? out.art_markup) || 0),
    artSyncedCard: Number(out.art_synced_card) || null,
    artSyncedInvoice: Number(out.art_synced_invoice) || null,
    // QuickLine sign-in: the password never leaves the server (see qlCredentials).
    qlUser: out.ql_user,
    qlConfigured: !!(out.ql_user && out.ql_pass),
    // The manager's profit on top of QuickLine's price, separately for extensions ('card') and new lines ('invoice').
    qlMarkupCard: Math.max(0, Number(out.ql_markup_card ?? out.ql_markup) || 0),
    qlMarkupInvoice: Math.max(0, Number(out.ql_markup_invoice ?? out.ql_markup) || 0),
    qlSyncedCard: Number(out.ql_synced_card) || null,
    qlSyncedInvoice: Number(out.ql_synced_invoice) || null,
    // The daily copy in Google Cloud Storage (see cloudbackup.js): where, the last good one, and the last failure.
    backupBucket: out.backup_bucket || '',
    backupLastAt: Number(out.backup_last_at) || null,
    backupLastName: out.backup_last_name || '',
    backupLastBytes: Number(out.backup_last_bytes) || null,
    backupError: out.backup_error || '',
  };
}
function artCredentials() {
  const get = (k) => q('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  return { user: get('art_user'), pass: get('art_pass') };
}
function qlCredentials() {
  const get = (k) => q('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  return { user: get('ql_user'), pass: get('ql_pass') };
}
function setSetting(key, value) {
  q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ---------- first run ----------
function bootstrap() {
  if (!q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    let password = process.env.ADMIN_PASSWORD;
    if (!password) {
      password = crypto.randomBytes(6).toString('base64url');
      console.log(`\n*** Admin account created: username "${username}" password "${password}" — change it after first login ***\n`);
    }
    q("INSERT INTO users (role, name, username, password_hash, created_at) VALUES ('admin', 'المدير', ?, ?, ?)")
      .run(username, hashPassword(password), Date.now());
  }
  if (!q('SELECT COUNT(*) AS n FROM companies').get().n) {
    const co = q('INSERT INTO companies (name, sort, color, iccid_prefixes) VALUES (?, ?, ?, ?)');
    const pk = q('INSERT INTO packages (company_id, name, sort, data_gb) VALUES (?, ?, ?, ?)');
    const pkFull = q('INSERT INTO packages (company_id, name, sort, cost, price) VALUES (?, ?, ?, ?, ?)');
    const cellcom = co.run('سلكوم', 1, '#6b2c91', '8997202').lastInsertRowid;
    pk.run(cellcom, '500 جيجا', 1, 500);
    pk.run(cellcom, '300 جيجا', 2, 300);
    pk.run(cellcom, '100 جيجا', 3, 100);
    pk.run(co.run('بارتنر', 2, '#12a39a', '').lastInsertRowid, 'باقة بارتنر', 1, null);
    pk.run(co.run('بيلفون', 3, '#0a74c9', '8997250').lastInsertRowid, 'باقة بيلفون', 1, null);
    pk.run(co.run('هوت موبايل', 4, '#d7192d', '').lastInsertRowid, 'باقة هوت موبايل', 1, null);
    pkFull.run(co.run('الكروت', 5, '#ff5722', '').lastInsertRowid, 'كرت 70 شيكل', 1, 70, 70);
  }
}
bootstrap();

module.exports = { db, q, tx, getSettings, setSetting, artCredentials, qlCredentials, DB_FILE };
