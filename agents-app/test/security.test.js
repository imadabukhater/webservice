'use strict';
// Requests that must not hurt the server, and what an agent must never be sent.
const net = require('node:net');
const test = require('node:test');
const assert = require('node:assert/strict');

let base;
let port;
let server;
const call = async (token, method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
// A raw request, exactly as written (fetch would clean the address up first).
const raw = (path) => new Promise((resolve, reject) => {
  const s = net.connect(port, '127.0.0.1', () => s.end(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
  let out = '';
  s.on('data', (d) => { out += d; });
  s.on('end', () => resolve(Number((/^HTTP\/1\.1 (\d+)/.exec(out) || [])[1]) || 0));
  s.on('error', reject);
});

test.before(async () => {
  process.env.DB_FILE = ':memory:';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
test.after(() => server.close());

test('a malformed address is refused and the server stays up; nothing outside public/ is served', async () => {
  assert.equal(await raw('/%E0%A4%A'), 400);
  assert.equal(await raw('/%'), 400);
  assert.equal((await fetch(`${base}/`)).status, 200, 'still running');
  // Encoded slashes reach the file lookup as written: still only public/.
  assert.equal(await raw('/..%2Fserver.js'), 403);
  assert.equal(await raw('/..%2Fpublic-copy%2Findex.html'), 403);
  assert.equal(await raw('/..%2Fsrc%2Fdb.js'), 403);
});

test('an agent is sent only the settings its screens need', async () => {
  const admin = (await call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' })).body.token;
  await call(admin, 'PUT', '/api/settings', { qlUser: 'dealer@example.com', qlPass: 'secret-pass', qlMarkupCard: 25, artUser: 'ag1', artPass: 'p', supportWhatsapp: '972567725080' });
  await call(admin, 'POST', '/api/agents', { name: 'وكيل', username: 'agent1', password: 'secret1', balance: 10 });
  const login = (await call(null, 'POST', '/api/login', { username: 'agent1', password: 'secret1' })).body;
  for (const s of [login.settings, (await call(login.token, 'GET', '/api/me')).body.settings]) {
    assert.deepEqual(Object.keys(s).sort(), ['appName', 'esimFee', 'lowBalance', 'supportWhatsapp', 'warnDays']);
    assert.ok(!JSON.stringify(s).includes('dealer@example.com'));
  }
  assert.equal((await call(login.token, 'GET', '/api/settings')).status, 403);
  // The manager still gets everything (but never a password).
  const all = (await call(admin, 'GET', '/api/settings')).body;
  assert.equal(all.qlUser, 'dealer@example.com');
  assert.equal(all.qlMarkupCard, 25);
  assert.ok(!JSON.stringify(all).includes('secret-pass'));
});

test('telecom: the password and the Gmail App password are never sent back', async () => {
  const admin = (await call(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' })).body.token;
  assert.equal((await call(admin, 'POST', '/api/telecom/mail-check')).status, 400, 'not set up yet');
  assert.equal((await call(admin, 'PUT', '/api/settings', { tcMailUser: 'not an address' })).status, 400);
  const s = (await call(admin, 'PUT', '/api/settings', { tcUser: 'me@example.com', tcPass: 'tc-secret-pass', tcMailUser: 'box@gmail.com', tcMailPass: 'abcd efgh ijkl mnop' })).body;
  assert.equal(s.tcUser, 'me@example.com');
  assert.equal(s.tcMailUser, 'box@gmail.com');
  assert.equal(s.tcConfigured, true);
  assert.equal(s.tcMailConfigured, true);
  const all = JSON.stringify((await call(admin, 'GET', '/api/settings')).body);
  assert.ok(!all.includes('tc-secret-pass') && !all.includes('abcd'));
  // An empty password keeps the saved one.
  assert.equal((await call(admin, 'PUT', '/api/settings', { tcPass: '', tcMailPass: '' })).body.tcMailConfigured, true);
});
