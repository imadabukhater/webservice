'use strict';
// The daily copy in Google Cloud Storage, against a fake metadata server (bucket, token) and a fake Storage API.
const http = require('node:http');
const zlib = require('node:zlib');
const test = require('node:test');
const assert = require('node:assert/strict');

const fake = { bucket: '', uploads: [], answer: 200 };
const google = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/meta/')) {
      if (req.headers['metadata-flavor'] !== 'Google') return res.writeHead(403).end();
      if (url.pathname === '/meta/instance/attributes/backup-bucket') return fake.bucket ? res.end(fake.bucket) : res.writeHead(404).end();
      if (url.pathname === '/meta/instance/service-accounts/default/token') return res.end(JSON.stringify({ access_token: 'tok-1', expires_in: 3599 }));
      return res.writeHead(404).end();
    }
    if (url.pathname.startsWith('/storage/upload/storage/v1/b/')) {
      fake.uploads.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(chunks) });
      if (fake.answer !== 200) return res.writeHead(fake.answer).end('{"error":{"message":"denied"}}');
      return res.end('{}');
    }
    return res.writeHead(404).end();
  });
});

let base;
let server;
const call = async (token, method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test.before(async () => {
  await new Promise((r) => google.listen(0, r));
  const g = `http://127.0.0.1:${google.address().port}`;
  process.env.GCE_METADATA_URL = `${g}/meta`;
  process.env.GCS_URL = `${g}/storage`;
  process.env.DB_FILE = ':memory:';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); google.close(); });

test('cloud backup: a full, compressed copy of the database, created under a new name and never overwritten', async () => {
  const admin = (await call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' })).body.token;
  await call(admin, 'POST', '/api/agents', { name: 'وكيل', username: 'agent1', password: 'secret1', balance: 123 });

  // ----- no bucket set on this server: nothing is sent -----
  const none = await call(admin, 'POST', '/api/backup/cloud');
  assert.equal(none.status, 502);
  assert.match(none.body.error, /backup-bucket/);
  assert.equal(fake.uploads.length, 0);

  // ----- with the bucket in the instance metadata -----
  fake.bucket = 'agents-backups';
  const r = await call(admin, 'POST', '/api/backup/cloud');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const up = fake.uploads[0];
  assert.equal(up.path, '/storage/upload/storage/v1/b/agents-backups/o');
  assert.equal(up.auth, 'Bearer tok-1', 'signed in as the server');
  assert.equal(up.query.ifGenerationMatch, '0', 'created only: an existing copy is never overwritten');
  assert.match(up.query.name, /^agents-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db\.gz$/);
  assert.equal(up.type, 'application/gzip');
  const copy = zlib.gunzipSync(up.body);
  assert.equal(copy.subarray(0, 15).toString(), 'SQLite format 3', 'a real database file');
  // The copy holds the data: open it and find the agent.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(os.tmpdir(), `restore-test-${process.pid}.db`);
  fs.writeFileSync(file, copy);
  const { DatabaseSync } = require('node:sqlite');
  const restored = new DatabaseSync(file);
  assert.equal(restored.prepare("SELECT balance FROM users WHERE username = 'agent1'").get().balance, 123);
  restored.close();
  fs.rmSync(file, { force: true });

  const s = (await call(admin, 'GET', '/api/settings')).body;
  assert.equal(s.backupBucket, 'agents-backups');
  assert.ok(s.backupLastAt > Date.now() - 60_000);
  assert.equal(s.backupLastName, up.query.name);
  assert.equal(s.backupError, '');

  // ----- the daily schedule: nothing more within the day -----
  const { tick } = require('../src/cloudbackup');
  await tick();
  assert.equal(fake.uploads.length, 1, 'one copy a day');

  // ----- no permission to write: recorded and the manager is told -----
  fake.answer = 403;
  const denied = await call(admin, 'POST', '/api/backup/cloud');
  assert.equal(denied.status, 502);
  assert.match(denied.body.error, /لا صلاحية للكتابة/);
  assert.match((await call(admin, 'GET', '/api/settings')).body.backupError, /لا صلاحية/);
  // A day later the scheduled copy fails too: the manager gets one notification.
  require('../src/db').setSetting('backup_last_at', Date.now() - 25 * 60 * 60_000);
  require('../src/db').setSetting('backup_error', '');
  await tick();
  await tick();
  const notes = (await call(admin, 'GET', '/api/notifications')).body.items.filter((n) => /النسخ الاحتياطي/.test(n.title));
  assert.equal(notes.length, 1);
  fake.answer = 200;
  await tick();
  assert.equal((await call(admin, 'GET', '/api/settings')).body.backupError, '', 'cleared once a copy succeeds again');
});
