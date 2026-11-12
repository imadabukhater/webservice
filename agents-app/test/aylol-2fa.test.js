'use strict';
// Aylol's two-step sign-in, against a fake site that does what the real one does: after the password it redirects
// to /two-factor, whose form (hidden token, a code field, "remember this device") takes the Google Authenticator
// code. The key is saved in the settings (never sent back); without it the manager is told what to enter.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { totp } = require('../src/layan');

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const site = { pending: new Set(), signedIn: new Set(), codes: [], remember: [] };
let base;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const sid = /aylol_session=(\w+)/.exec(req.headers.cookie || '')?.[1];
    const html = (s, headers = {}) => { res.writeHead(200, { 'Content-Type': 'text/html', ...headers }); res.end(s); };
    const to = (where) => { res.writeHead(302, { Location: `${base}${where}` }); res.end(`<meta http-equiv="refresh" content="0;url='${base}${where}'" />`); };
    if (u.pathname === '/login' && req.method === 'GET') {
      return html('<form method="POST" action="/login"><input type="hidden" name="_token" value="CSRF-LOGIN"><input name="email"><input type="password" name="password"></form><meta name="csrf-token" content="CSRF-LOGIN">', { 'Set-Cookie': `aylol_session=s${Date.now()}; Path=/` });
    }
    if (u.pathname === '/login' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      if (f.get('email') === 'dealer@example.com' && f.get('password') === 'right-pass' && f.get('_token') === 'CSRF-LOGIN') site.pending.add(sid);
      return to('/two-factor');
    }
    if (u.pathname === '/two-factor' && req.method === 'GET') {
      if (!site.pending.has(sid)) return to('/login');
      return html(`<meta name="csrf-token" content="CSRF-2FA"><form method="POST" action="${base}/two-factor">
        <input type="hidden" name="_token" value="CSRF-2FA"><input type="text" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
        <label><input type="checkbox" name="remember_device" value="1"> تذكر هذا الجهاز</label><button>تحقق</button></form>`);
    }
    if (u.pathname === '/two-factor' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      site.codes.push(f.get('code'));
      site.remember.push(f.get('remember_device'));
      if (site.pending.has(sid) && f.get('_token') === 'CSRF-2FA' && f.get('code') === totp(SECRET)) { site.pending.delete(sid); site.signedIn.add(sid); }
      return to(site.signedIn.has(sid) ? '/dashboard/charge-system' : '/two-factor');
    }
    if (u.pathname === '/dashboard/charge-system') {
      if (site.pending.has(sid)) return to('/two-factor');
      if (!site.signedIn.has(sid)) return to('/login');
      return html('<meta name="csrf-token" content="CSRF-APP"><body>رصيدك: 100 ₪<script>window.cfg = { seed: "abcdef0123456789abcdef0123456789" };</script></body>');
    }
    res.writeHead(404);
    return res.end('Not Found');
  });
});

let app;
let api;
let dataDir;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aylol-2fa-'));
  Object.assign(process.env, { AYLOL_BASE: base, AYLOL_DATA: dataDir, DB_FILE: ':memory:', ADMIN_PASSWORD: 'admin-pass' });
  ({ server: app } = require('../server'));
  await new Promise((r) => app.listen(0, r));
  const root = `http://127.0.0.1:${app.address().port}`;
  api = async (token, method, url, body) => {
    const r = await fetch(root + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
});
test.after(() => { app.close(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('Aylol: the two-step sign-in is passed with the Google Authenticator key from the settings', async () => {
  const admin = (await api(null, 'POST', '/api/login', { username: 'admin', password: 'admin-pass' })).body.token;
  await api(admin, 'PUT', '/api/settings', { aylolUser: 'dealer@example.com', aylolPass: 'right-pass' });

  // No key yet: the site's code page is recognised and the manager is told exactly what is missing.
  const noKey = await api(admin, 'POST', '/api/aylol/check');
  assert.equal(noKey.status, 502);
  assert.match(noKey.body.error, /Google Authenticator/);
  assert.equal(site.codes.length, 0, 'no code sent without a key');

  // A bad key is refused when saved; a good one (as typed, with spaces) is kept and never sent back.
  assert.equal((await api(admin, 'PUT', '/api/settings', { aylolSecret: 'not a key!' })).status, 400);
  const saved = await api(admin, 'PUT', '/api/settings', { aylolSecret: SECRET.toLowerCase().replace(/(.{4})/g, '$1 ') });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.aylolHasSecret, true);
  assert.equal(JSON.stringify(saved.body).includes(SECRET), false);

  const ok = await api(admin, 'POST', '/api/aylol/check');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.user, ok.body.balance], ['dealer@example.com', 100]);
  assert.equal(site.codes.at(-1), totp(SECRET));
  assert.equal(site.remember.at(-1), '1', '"remember this device" is ticked');
  assert.equal(site.signedIn.size, 1);

  // The code never appears on curl's command line, nor does the key.
  for (const f of fs.readdirSync(dataDir)) assert.equal(fs.readFileSync(path.join(dataDir, f), 'utf8').includes(SECRET), false);
});
