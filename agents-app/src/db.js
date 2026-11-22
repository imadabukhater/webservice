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
CREATE TABLE IF NOT EXISTS shop_orders (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  package_label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'recharge' CHECK (kind IN ('recharge','new')),
  number TEXT NOT NULL,
  sim TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment','verifying','review','paid','rejected','cancelled')),
  pay_phone TEXT NOT NULL DEFAULT '',
  pay_name TEXT NOT NULL DEFAULT '',
  pay_reference TEXT NOT NULL DEFAULT '',
  receipt TEXT NOT NULL DEFAULT '',
  proof_at INTEGER,
  mail_id INTEGER,
  paid_at INTEGER,
  verified_by TEXT NOT NULL DEFAULT '',
  line_id INTEGER,
  error TEXT NOT NULL DEFAULT '',
  response TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Direct Jawwal Pay (corporate API): what happened to each order's payment, for the manager. Never the OTP.
CREATE TABLE IF NOT EXISTS jc_log (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  invoice_id TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jc_log_order ON jc_log(order_id);
CREATE TABLE IF NOT EXISTS payment_mails (
  id INTEGER PRIMARY KEY,
  uid_validity INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  message_id TEXT NOT NULL DEFAULT '',
  trusted INTEGER NOT NULL DEFAULT 0,
  from_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL,
  amount REAL,
  reference TEXT NOT NULL DEFAULT '',
  sender_phone TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  order_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (uid_validity, uid)
);
-- Shop orders a customer follows over WhatsApp: each change (payment verified, eSIM ready) is sent to that chat.
CREATE TABLE IF NOT EXISTS wa_shop (
  order_id INTEGER PRIMARY KEY,
  jid TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  done_at INTEGER
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
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS notif_user ON notifications(user_id, ts);
CREATE INDEX IF NOT EXISTS shop_orders_status ON shop_orders(status, created_at);
CREATE INDEX IF NOT EXISTS payment_mails_order ON payment_mails(order_id, received_at);
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
// Customer shop: the price customers pay (null = not sold in the shop).
ensureColumn('packages', 'shop_price', 'shop_price REAL');
// Customer shop eSIM orders: the number picked from the supplier's free eSIM numbers (its id there, its eSIM in `sim`
// and the QR code to install it, kept for the manager until the line is active), and the e-mail the QR is sent to.
ensureColumn('shop_orders', 'esim', 'esim INTEGER NOT NULL DEFAULT 0');
ensureColumn('shop_orders', 'number_id', 'number_id INTEGER');
ensureColumn('shop_orders', 'esim_qr', "esim_qr TEXT NOT NULL DEFAULT ''");
ensureColumn('shop_orders', 'email', "email TEXT NOT NULL DEFAULT ''");
ensureColumn('shop_orders', 'qr_mailed_at', 'qr_mailed_at INTEGER');
// JawwalPay e-mails come from noreply@jawwalpay.ps: the first default ("jawwal") also trusted look-alike domains.
db.exec("UPDATE settings SET value = 'jawwalpay.ps' WHERE key = 'mail_from' AND value = 'jawwal'");
// gone_at: when a sync hid the package because its supplier no longer listed it. Such a package comes back by itself
// when the supplier lists it again; a package the manager hid (gone_at NULL) stays hidden.
ensureColumn('packages', 'gone_at', 'gone_at INTEGER');
// Per-company eSIM QR fee (since QR code fee differs from one telecom company to another), package marketing/eSIM flags, and shop order QR code details.
ensureColumn('companies', 'esim_fee', 'esim_fee REAL');
ensureColumn('packages', 'popular', 'popular INTEGER NOT NULL DEFAULT 0');
ensureColumn('packages', 'old_price', 'old_price REAL');
ensureColumn('packages', 'esim_enabled', 'esim_enabled INTEGER NOT NULL DEFAULT 0');
// What the supplier really takes from the account for the package, when it says so (Aylol lists only the customer's
// price on its charge page; its eSIM list gives the agent's price of the same packages). Shown to the manager only.
ensureColumn('packages', 'supplier_cost', 'supplier_cost REAL');
// The supplier's own company number of the package (Aylol: its order form depends on it).
ensureColumn('packages', 'supplier_company', 'supplier_company INTEGER');
// What the supplier's line can be on (Aylol's sim_type): 'sim', 'esim' or 'any'; unknown until the site is asked.
ensureColumn('packages', 'supplier_sim_type', 'supplier_sim_type TEXT');
// The WhatsApp assistant runs on the owner's Google Cloud only: no AI key or other service is kept.
db.exec("DELETE FROM settings WHERE key IN ('wa_ai_key', 'wa_ai_provider')");
// Aylol's bill lines are new numbers on a SIM card (as its site sells them), not eSIMs.
db.exec("UPDATE packages SET esim_enabled = 0 WHERE art_card_id LIKE 'ay:bill:%' AND esim_enabled = 1");
ensureColumn('shop_orders', 'esim_fee', 'esim_fee REAL NOT NULL DEFAULT 0');
ensureColumn('shop_orders', 'esim_code', "esim_code TEXT NOT NULL DEFAULT ''");
ensureColumn('shop_orders', 'proof_tries', 'proof_tries INTEGER NOT NULL DEFAULT 0');
ensureColumn('shop_orders', 'first_proof_at', 'first_proof_at INTEGER');
ensureColumn('shop_orders', 'client_id', "client_id TEXT NOT NULL DEFAULT ''");
// Direct Jawwal Pay (MaalCards corporate API, see jawwalcorp.js): the invoice a code was sent for, the customer's
// mobile, until when that code can be confirmed, how many codes were sent and confirmations tried, and whether a
// confirmation got no clear answer (its invoice is looked up again until it does).
ensureColumn('shop_orders', 'jc_invoice_id', "jc_invoice_id TEXT NOT NULL DEFAULT ''");
ensureColumn('shop_orders', 'jc_mobile', "jc_mobile TEXT NOT NULL DEFAULT ''");
ensureColumn('shop_orders', 'jc_expires_at', 'jc_expires_at INTEGER');
ensureColumn('shop_orders', 'jc_sent_at', 'jc_sent_at INTEGER');
ensureColumn('shop_orders', 'jc_sends', 'jc_sends INTEGER NOT NULL DEFAULT 0');
ensureColumn('shop_orders', 'jc_tries', 'jc_tries INTEGER NOT NULL DEFAULT 0');
ensureColumn('shop_orders', 'jc_unsure', 'jc_unsure INTEGER NOT NULL DEFAULT 0');
// The invoice's last known state at the corporate API: pending | confirmed | expired | failed ('' before any).
ensureColumn('shop_orders', 'jc_status', "jc_status TEXT NOT NULL DEFAULT ''");
// The shop's WhatsApp number a followed order's chat is on (src/whatsapp.js: several numbers may be linked).
ensureColumn('wa_shop', 'link', "link TEXT NOT NULL DEFAULT ''");
// Where a direct payment's code was sent from: '' (Jawwal Pay wallet) or 'PALS' (Bank of Palestine).
ensureColumn('shop_orders', 'jc_bank', "jc_bank TEXT NOT NULL DEFAULT ''");
db.exec("CREATE INDEX IF NOT EXISTS shop_orders_client_status ON shop_orders(client_id, status)");
db.exec("CREATE INDEX IF NOT EXISTS shop_orders_ip_status ON shop_orders(ip, status)");
// Before gone_at, a sync that briefly got an incomplete list from QuickLine hid packages for good. The manager hid
// none of them by hand, so they are marked as the sync's, once, and the next sync brings back those QuickLine lists.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migr_ql_gone'").get()) {
  db.prepare("UPDATE packages SET gone_at = ? WHERE active = 0 AND gone_at IS NULL AND art_card_id LIKE 'ql%'").run(Date.now());
  db.prepare("INSERT INTO settings (key, value) VALUES ('migr_ql_gone', '1')").run();
}
// The shop: a package is in it while shop_on = 1, at its supplier's price + the manager's percentage (shop_markup;
// domain.refreshShopPrices keeps shop_price). Once: the packages on sale (a customer price, shown, still listed) stay.
ensureColumn('packages', 'shop_on', 'shop_on INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migr_shop_on'").get()) {
  db.exec('UPDATE packages SET shop_on = 1 WHERE shop_price > 0 AND active = 1 AND gone_at IS NULL');
  db.prepare("INSERT INTO settings (key, value) VALUES ('migr_shop_on', '1')").run();
}
// Security hardening: disable unverified instant self-activation by default so orders require payment verification unless explicitly enabled by admin.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migr_disable_instant_default'").get()) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('shop_instant', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('migr_disable_instant_default', '1')").run();
}

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
  app_name: 'متجر eSIM', esim_fee: '7', support_whatsapp: '972567725080',
  shop_enabled: '0', shop_instant: '0', shop_title: '', shop_subtitle: '',
  jawwalpay_number: '', jawwalpay_name: '', palpay_number: '', palpay_name: '', gmail_user: '', gmail_pass: '', mail_from: 'jawwalpay.ps',
  ql_user: '', ql_pass: '',
  ly_user: '', ly_pass: '', ly_secret: '',
  tc_user: '', tc_pass: '', tc_mail_user: '', tc_mail_pass: '', tc_reg_address: '', tc_reg_city: '', tc_reg_zip: '',
  aylol_user: '', aylol_pass: '',
  // Direct Jawwal Pay through the MaalCards corporate API: the subscriber (manager_id) and the corporate account.
  jc_enabled: '0', jc_manager_id: '', jc_user: '', jc_pass: '',
  // Paying from Bank of Palestine too (E-SADAD, by the mobile registered with the bank), beside the Jawwal Pay wallet.
  jc_pals: '1',
  // Paying by a manual transfer, confirmed from the payment e-mails: on unless the manager stops it.
  mail_pay: '1',
  // Safety: a paid customer order above this amount waits for the manager (0: none); orders a customer may make in an
  // hour; Aylol's balance under which the manager is told.
  shop_auto_max: '200', shop_hour_limit: '3', aylol_low_balance: '100',
  // The shop's price: the supplier's price + this percentage.
  shop_markup: '20',
  // Optional Google Search Console HTML-tag verification token.
  google_site_verification: '',
};
function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of q('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return {
    appName: out.app_name,
    esimFee: Math.max(0, Number(out.esim_fee) || 0),
    supportWhatsapp: out.support_whatsapp,
    // QuickLine sign-in: the password never leaves the server (see qlCredentials).
    qlUser: out.ql_user,
    qlConfigured: !!(out.ql_user && out.ql_pass),
    qlSyncedInvoice: Number(out.ql_synced_invoice) || null,
    // Layan sign-in: the password and the authenticator secret never leave the server (see lyCredentials).
    lyUser: out.ly_user,
    lyConfigured: !!(out.ly_user && out.ly_pass),
    lyHasSecret: !!out.ly_secret,
    lySyncedInvoice: Number(out.ly_synced_invoice) || null,
    // telecom.co.il sign-in: it e-mails a code, which the server reads from that Gmail over IMAP (see mailcode.js).
    // The password and the Gmail App password never leave the server (see tcCredentials).
    tcUser: out.tc_user,
    tcConfigured: !!(out.tc_user && out.tc_pass),
    tcMailUser: out.tc_mail_user,
    tcMailConfigured: !!(out.tc_mail_user && out.tc_mail_pass),
    // Signing in needs both: the site's account and the Gmail its codes go to.
    tcReady: !!(out.tc_user && out.tc_pass && out.tc_mail_user && out.tc_mail_pass),
    tcSyncedInvoice: Number(out.tc_synced_invoice) || null,
    // telecom asks a new line's address, city and postcode: the shop registers its eSIMs with these.
    tcRegAddress: out.tc_reg_address, tcRegCity: out.tc_reg_city, tcRegZip: out.tc_reg_zip,
    // Aylol Telecom (aylol-telecom.com) sign-in: the password never leaves the server (see aylolCredentials).
    aylolUser: out.aylol_user,
    aylolConfigured: !!(out.aylol_user && out.aylol_pass),
    // The Google Authenticator key Aylol's two-step sign-in asks a code from (never sent back, like the password).
    aylolHasSecret: !!out.aylol_secret,
    aylolSyncedInvoice: Number(out.aylol_synced_invoice) || null,
    tcRegReady: !!(out.tc_reg_address && out.tc_reg_city && out.tc_reg_zip),
    // The daily copy in Google Cloud Storage (see cloudbackup.js): where, the last good one, and the last failure.
    backupBucket: out.backup_bucket || '',
    backupLastAt: Number(out.backup_last_at) || null,
    backupLastName: out.backup_last_name || '',
    backupLastBytes: Number(out.backup_last_bytes) || null,
    backupError: out.backup_error || '',
    // Customer shop paid by JawwalPay or instant self-service; transfers are confirmed from the notification emails in Gmail.
    // The shop's price: the supplier's price + this percentage (domain.shopPriceOf).
    shopMarkup: Math.max(0, Number.isFinite(Number(out.shop_markup)) && out.shop_markup !== '' ? Number(out.shop_markup) : 20),
    shopEnabled: out.shop_enabled === '1',
    shopInstant: out.shop_instant === '1',
    shopAutoMax: Math.max(0, Number(out.shop_auto_max ?? 200) || 0),
    shopHourLimit: Math.max(0, Number(out.shop_hour_limit ?? 3) || 0),
    aylolLowBalance: Math.max(0, Number(out.aylol_low_balance ?? 100) || 0),
    shopTitle: out.shop_title || '',
    shopSubtitle: out.shop_subtitle || '',
    googleSiteVerification: out.google_site_verification || '',
    jawwalpayNumber: out.jawwalpay_number,
    jawwalpayName: out.jawwalpay_name,
    palpayNumber: out.palpay_number,
    palpayName: out.palpay_name,
    gmailUser: out.gmail_user,
    gmailConfigured: !!(out.gmail_user && out.gmail_pass),
    mailFrom: out.mail_from,
    // Direct Jawwal Pay (corporate API): the password never leaves the server (see jcCredentials).
    jcEnabled: out.jc_enabled === '1',
    jcPals: out.jc_pals !== '0',
    jcManagerId: out.jc_manager_id,
    jcUser: out.jc_user,
    jcConfigured: !!(out.jc_manager_id && out.jc_user && out.jc_pass),
    jcReady: out.jc_enabled === '1' && !!(out.jc_manager_id && out.jc_user && out.jc_pass),
    mailPay: out.mail_pay !== '0',
  };
}
function jcCredentials() {
  const get = (k) => q('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  return { managerId: Number(get('jc_manager_id')) || 0, user: get('jc_user'), pass: get('jc_pass') };
}
function gmailCredentials() {
  const get = (k) => q('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  return { user: get('gmail_user'), pass: get('gmail_pass').replace(/\s+/g, '') };
}
function lyCredentials() {
  const get = (k) => q('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  return { user: get('ly_user'), pass: get('ly_pass'), secret: get('ly_secret') };
}
function tcCredentials() {
  const get = (k) => q('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  return { user: get('tc_user'), pass: get('tc_pass'), mail: { user: get('tc_mail_user'), pass: get('tc_mail_pass') } };
}
function aylolCredentials() {
  const get = (k) => q('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  return { user: get('aylol_user'), pass: get('aylol_pass'), secret: get('aylol_secret') };
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
    // The companies only: their eSIM packages come from the suppliers' syncs (or the manager adds them).
    const co = q('INSERT INTO companies (name, sort, color, iccid_prefixes) VALUES (?, ?, ?, ?)');
    co.run('سلكوم', 1, '#6b2c91', '8997202');
    co.run('بارتنر', 2, '#12a39a', '');
    co.run('بيلفون', 3, '#0a74c9', '8997250');
    co.run('هوت موبايل', 4, '#d7192d', '');
  }
}
bootstrap();

module.exports = { db, q, tx, getSettings, setSetting, qlCredentials, aylolCredentials, lyCredentials, tcCredentials, gmailCredentials, jcCredentials, DB_FILE };
