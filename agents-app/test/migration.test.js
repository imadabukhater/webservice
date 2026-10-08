'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

// The schema the first release of the app created.
const V1 = `
CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('admin','agent')), name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, balance REAL NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE packages (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE agent_prices (agent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  price REAL NOT NULL, PRIMARY KEY (agent_id, package_id));
CREATE TABLE offers (id INTEGER PRIMARY KEY, title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  offer_price REAL, starts_at INTEGER, ends_at INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE lines (id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, sim TEXT NOT NULL DEFAULT '', package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  package_label TEXT NOT NULL, agent_id INTEGER NOT NULL REFERENCES users(id), price REAL NOT NULL, cost REAL NOT NULL, offer_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','disconnected')), note TEXT NOT NULL DEFAULT '',
  activated_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE ops (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, agent_id INTEGER, agent_name TEXT NOT NULL DEFAULT '', actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '', line_id INTEGER, number TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0, balance_before REAL,
  balance_after REAL, cost REAL NOT NULL DEFAULT 0, profit REAL NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '');
CREATE INDEX lines_agent ON lines(agent_id);
INSERT INTO users (id, role, name, username, password_hash, balance, created_at) VALUES (1, 'admin', 'المدير', 'admin', 'x', 0, 1), (2, 'agent', 'وكيل', 'v1', 'x', 55, 1);
INSERT INTO companies (id, name, sort) VALUES (1, 'سلكوم', 1);
INSERT INTO packages (id, company_id, name, cost, price) VALUES (1, 1, '500 جيجا', 60, 80);
INSERT INTO lines (id, number, sim, package_id, package_label, agent_id, price, cost, status, activated_at, updated_at)
  VALUES (7, '0521111111', '8997202', 1, 'سلكوم 500 جيجا', 2, 80, 60, 'frozen', 1, 1);
`;

test('a first-release database is upgraded in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mig-'));
  const file = path.join(dir, 'agents.db');
  const old = new DatabaseSync(file);
  old.exec(V1);
  old.close();

  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', "require('./src/db')"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, DB_FILE: file, ADMIN_PASSWORD: 'unused1' },
  });

  const db = new DatabaseSync(file);
  const linesSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'lines'").get().sql;
  assert.ok(linesSql.includes("'pending'"));
  assert.ok(!/number TEXT NOT NULL UNIQUE/.test(linesSql), 'numbers can be reused after disconnection');
  const line = db.prepare('SELECT * FROM lines WHERE id = 7').get();
  assert.equal(line.number, '0521111111');
  assert.equal(line.status, 'frozen');
  assert.equal(line.months, 1);
  assert.equal(line.expires_at, null);
  assert.equal(db.prepare('SELECT balance, credit_limit FROM users WHERE id = 2').get().credit_limit, 0);
  assert.equal(db.prepare('SELECT iccid_prefixes FROM companies WHERE id = 1').get().iccid_prefixes, '');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'lines_agent'").get(), 'index recreated');
  for (const t of ['sims', 'tasks', 'notifications', 'settings']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n, 1, 'no second admin');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
