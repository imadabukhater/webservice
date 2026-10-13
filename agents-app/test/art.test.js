'use strict';
// art-topup integration against a fake portal that mimics the real pages (login, card dialogs, makeIR, operations).
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const fake = { ops: [], recharges: [], next: 'done', nextId: 900, pal: [], palNext: 'success' };
const CARDS = {
  111: [['5001', 'سلكوم 350 جيجا (79.90 شيقل) 5G', '76', '350 جيجا تصفح'], ['5002', 'اضافة 4 جيجا (15 شيقل)', '14.25', 'تصفح انترنت: 4 جيجا']],
  222: [['6001', 'بطاقة جولان 49 شيكل شهريًا: ‏50 جيجابايت', '46.55', '50 جيجابايت']],
};
const loginPage = '<html><form id="loginFormA"><input name="username" id="ppusername"><input type="password" name="password" id="pppassword"></form></html>';
function page(url) {
  if (url.startsWith('/Portal/index.php')) {
    return `<div class="section-card" onclick="location.href='israel_c.php?id=111'"><div class="hover-badge badge-api">API</div>
        <img src="x.png" alt="شحن سيلكوم" class="section-image"><div class="section-title">شحن سيلكوم</div></div>
      <div class="section-card" onclick="location.href='israel_c.php?id=222'"><img src="y.png" alt="شحن جولان" class="section-image"></div>
      <div class="section-card" onclick="location.href='pal_chargen.php?type=jawwal_minutes'"><img src="z.png" alt="حزم دقائق جوال" class="section-image"></div>
      <div class="section-card" onclick="location.href='pal_charge.php?id=27713199'"><img src="w.png" alt="شحن جوال" class="section-image"></div>
      <div class="balance"><b>40.00 ₪</b><br><span>رصيدك</span></div>`;
  }
  if (url.startsWith('/Portal/pal_chargen.php')) {
    return `<div class="pkg-grid"><div class="pkg-card " onclick="openModal('277', 'حزمة جوال أسبوعية 90 دقيقة 15 شيكل', 15, '')">
        <div class="pkg-title">حزمة جوال أسبوعية 90 دقيقة 15 شيكل</div><div class="pkg-price">15 <small>₪</small></div></div>
      <div class="pkg-card disabled" onclick=""><div class="pkg-title">حزمة شهرية 400 دقيقة 63 شيكل</div><button class="pkg-btn" disabled="">رصيد غير كافٍ</button></div></div>`;
  }
  if (url.startsWith('/Portal/invoices.php')) {
    return `<div class="company-card api-card" onclick="showIPackages2(45511371, 'ramilevy', 'Ramilevy')"></div>
      <div class="company-card" onclick="showIPackages2(16666331, '', 'celecom')"></div>`;
  }
  if (url.startsWith('/Portal/pal_charge.php')) {
    return '<input type="hidden" id="product_id" value="27713199"><button data-amount="10">10 ₪</button><button data-amount="20">20 ₪</button>';
  }
  const m = /israel_c\.php\?id=(\d+)/.exec(url);
  if (m) {
    return (CARDS[m[1]] || []).map(([id, name, price, desc]) => `<div class="modal fade" id="ISModal_${id}"><h4 class="modal-title">شحن كرت  ${name}</h4>
      <span>اسم الشركة</span><span>celecom</span><span>سعر الكرت للوكيل</span><span>${price}₪</span><span>وصف الكرت</span><span>${desc}</span>
      <span>رقم الجوال</span><input type="text" class="form-control" name="no" id="i_no_${id}">
      <input type="hidden" id="i_comp_${id}" value="${m[1]}"><input type="hidden" id="i_name_${id}" value="${name}">
      <input type="hidden" id="i_price_${id}" value="${price}"><input type="hidden" id="i_cust_price_${id}" value="${price}">
      <button onclick="makeIR(${id})">شحن الان</button></div>`).join('\n');
  }
  if (url.startsWith('/Portal/processes.php')) {
    // The portal finishes a recharge between two looks at the list.
    for (const o of fake.ops) if (o.status === 'قيد التنفيذ' && o.seen++) Object.assign(o, o.final);
    const rows = fake.ops.length ? [...fake.ops].reverse().map((o) => `<tr><td>${o.id}</td><td>شحن كرت</td><td>${o.name}</td><td>${o.no}</td><td>${o.cost}₪</td>
      <td>2026-10-12 18:00</td><td><span class="badge">${o.status}</span></td><td>${o.reply}</td></tr>`).join('')
      : '<tr><td colspan="8" class="dataTables_empty">No data available in table</td></tr>';
    return `<table><thead><tr><th>#</th><th>نوع العملية</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  return '';
}
const portal = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const signed = /PHPSESSID=s1/.test(req.headers.cookie || '');
    if (req.url.startsWith('/controllers/users_db.php?loginTK')) {
      const f = new URLSearchParams(body);
      if (f.get('username') === 'ag1' && f.get('password') === 'portal-pass-123') {
        res.setHeader('Set-Cookie', 'PHPSESSID=s1; path=/');
        return res.end('true');
      }
      return res.end('wrong');
    }
    if (req.url.startsWith('/controllers/packages_tk_db.php?getIPackages2')) {
      if (!signed) return res.end(loginPage);
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      const INV = { 45511371: [['716', 'رامي ليفي شهر 200 جيجا &amp;quot; 30 شيكل &amp;quot; 5G', '30.00', '30']],
        16666331: [['94853317', 'سلكوم 3 شهور 400 جيجا كل شهر', '75.00', '90']] };
      return res.end((INV[id] || []).map(([pid, name, price, days]) => `<a href="#" onclick="showISModal2(${pid}); return false;"><h4 id="package_name_${pid}">${name}</h4></a>
        <div class="modal fade" id="ISModal2_${pid}"><table><tr><th>اسم الشركة</th><td>x</td></tr><tr><th>وصف العرض</th><td>400 جيجا</td></tr>
        <tr><th>عدد الأيام</th><td>${days} يوم</td></tr><tr><th>رقم الشريحة</th><td><input name="sim" id="isim_${pid}"></td></tr></table>
        <input type="hidden" id="i_comp2_${pid}" value="${id}"><input type="hidden" id="i_name2_${pid}" value="${name}">
        <input type="hidden" id="i_cust_price2_${pid}" value="${price}"></div>`).join('\n'));
    }
    if (req.url.startsWith('/controllers/makePC1.php') || req.url.startsWith('/controllers/makePC2.php')) {
      if (!signed) return res.end(loginPage);
      fake.pal.push(Object.fromEntries(new URL(req.url, 'http://x').searchParams));
      return res.end(fake.palNext === 'success' ? 'success' : 'error: الرقم غير صحيح');
    }
    if (req.url.startsWith('/controllers/agents_tk_db.php?makeIR')) {
      if (!signed) return res.end(loginPage);
      const q = new URL(req.url, 'http://x').searchParams;
      fake.recharges.push({ id: q.get('id'), no: q.get('no'), price: q.get('price'), cust: q.get('cust_price') });
      const final = fake.next === 'done' ? { status: 'تم الشحن بنجاح', reply: 'رقم العملية 777' } : { status: 'مرفوض', reply: 'الرقم غير صحيح' };
      fake.ops.push({ id: fake.nextId++, no: q.get('no'), name: q.get('id'), cost: q.get('price'), status: 'قيد التنفيذ', reply: '', seen: 0, final });
      return res.end('');
    }
    if (req.url.startsWith('/Portal/login.php')) return res.end(loginPage);
    if (!signed) return res.end(loginPage);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(page(req.url));
  });
});

let base;
let server;
const call = async (token, method, url, body) => {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const ok = async (p) => { const r = await p; assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const login = async (u, p) => (await ok(call(null, 'POST', '/api/login', { username: u, password: p }))).token;
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 60));
  }
};

test.before(async () => {
  await new Promise((r) => portal.listen(0, r));
  process.env.ART_BASE = `http://127.0.0.1:${portal.address().port}`;
  process.env.ART_CHECK_MS = '50';
  process.env.DB_FILE = ':memory:';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); portal.close(); });

test('art-topup: sync cards with the markup, recharge automatically, hand failures to the manager', async () => {
  const admin = await login('admin', 'admin-pass');
  assert.equal((await call(admin, 'POST', '/api/art/check')).status, 400, 'not configured yet');
  const s = await ok(call(admin, 'PUT', '/api/settings', { artUser: 'ag1', artPass: 'portal-pass-123', artMarkup: 15 }));
  assert.equal(s.artConfigured, true);
  assert.ok(!JSON.stringify(await ok(call(admin, 'GET', '/api/settings'))).includes('portal-pass-123'), 'the password is never sent back');
  assert.equal((await ok(call(admin, 'POST', '/api/art/check'))).balance, 40);

  // ----- sync -----
  const sync = await ok(call(admin, 'POST', '/api/art/sync'));
  assert.deepEqual([sync.total, sync.cards, sync.invoices, sync.hidden, sync.added, sync.updated, sync.switchedOff], [8, 6, 2, 1, 8, 0, 0],
    '3 cards + 1 bundle (1 hidden) + 2 cash amounts, and 2 invoice packages');
  const cat = await ok(call(admin, 'GET', '/api/catalog'));
  const card = cat.packages.find((p) => p.name === 'سلكوم 350 جيجا (79.90 شيقل) 5G');
  assert.equal(card.cost, 76);
  assert.equal(card.price, 87.4, 'agents pay art-topup price + 15%');
  assert.equal(card.art, true);
  assert.equal(card.dataGb, 350);
  assert.equal(cat.companies.find((c) => c.id === card.companyId).name, 'سلكوم', 'matched to the existing company');
  assert.equal(cat.companies.find((c) => c.id === card.companyId).activation, 'auto');
  assert.ok(cat.companies.some((c) => c.name === 'جولان' && c.activation === 'auto'), 'a missing company is created');
  assert.deepEqual([(await ok(call(admin, 'POST', '/api/art/sync'))).added, (await ok(call(admin, 'POST', '/api/art/sync'))).updated], [0, 8]);
  assert.equal(card.kind, 'card');

  // ----- invoices: their own system, with a set duration -----
  const inv = cat.packages.filter((p) => p.kind === 'invoice' && p.art);
  assert.equal(inv.length, 2);
  const rami = inv.find((p) => p.artCode === '716');
  assert.equal(rami.name, 'رامي ليفي شهر 200 جيجا " 30 شيكل " 5G', 'double-escaped names are decoded');
  assert.equal(rami.price, 34.5);
  assert.equal(rami.days, 30);
  const cel3 = inv.find((p) => p.artCode === '94853317');
  assert.equal(cel3.days, 90);
  assert.equal(cel3.companyId, card.companyId, 'celecom invoices belong to سلكوم');

  // ----- the manager's edits and visibility survive a sync; only the cost follows art-topup -----
  await ok(call(admin, 'PUT', `/api/packages/${cel3.id}`, { name: 'سلكوم 3 شهور (عرضي)', price: 99, dataGb: 400 }));
  await ok(call(admin, 'PUT', `/api/packages/${rami.id}`, { active: false }));
  await ok(call(admin, 'POST', '/api/art/sync'));
  const after = (await ok(call(admin, 'GET', '/api/catalog'))).packages;
  const cel3b = after.find((p) => p.id === cel3.id);
  assert.deepEqual([cel3b.name, cel3b.price, cel3b.dataGb, cel3b.cost, cel3b.edited], ['سلكوم 3 شهور (عرضي)', 99, 400, 75, true]);
  const ramib = after.find((p) => p.id === rami.id);
  assert.equal(ramib.active, false, 'stays hidden');
  assert.equal(ramib.edited, false, 'hiding is not an edit');
  assert.equal(ramib.price, 34.5);

  // ----- automatic recharge -----
  const agent = await ok(call(admin, 'POST', '/api/agents', { name: 'وكيل', username: 'agent1', password: 'secret1', balance: 500 }));
  const t = await login('agent1', 'secret1');
  const r = await ok(call(t, 'POST', '/api/lines', { kind: 'external', packageId: card.id, number: '050-123-4567' }));
  assert.equal(r.line.status, 'pending');
  assert.equal(r.balance, 412.6);
  const line = await until(async () => { const l = (await ok(call(t, 'GET', `/api/lines/${r.line.id}`))).line; return l.status === 'active' && l; });
  assert.ok(line.expiresAt > Date.now() + 27 * 864e5);
  assert.deepEqual(fake.recharges, [{ id: '5001', no: '0501234567', price: '76', cust: '76' }], 'sent once, with art-topup\'s price');
  const done = (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === r.line.id);
  assert.equal(done.status, 'done');
  assert.equal(done.autoStatus, 'done');
  assert.equal(done.resolvedBy, 'art-topup (تلقائي)');
  assert.match(done.autoNote, /تم الشحن بنجاح/);
  assert.ok((await ok(call(t, 'GET', '/api/notifications'))).items.some((i) => i.title.includes('تم تنفيذ')));

  // ----- rejected by art-topup: stays with the manager, who refunds -----
  fake.next = 'failed';
  const r2 = await ok(call(t, 'POST', '/api/lines', { kind: 'external', packageId: card.id, number: '0501234568' }));
  const failed = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === r2.line.id && x.autoStatus === 'failed'));
  assert.equal(failed.status, 'open');
  assert.match(failed.autoNote, /مرفوض/);
  assert.equal((await ok(call(t, 'GET', `/api/lines/${r2.line.id}`))).line.status, 'pending');
  await ok(call(admin, 'POST', `/api/tasks/${failed.id}/resolve`, { status: 'rejected', response: 'رفضه art-topup' }));
  assert.equal((await ok(call(t, 'GET', '/api/me'))).user.balance, 412.6);
  assert.equal(fake.recharges.length, 2, 'never resent');

  // ----- Jawwal: bundles and cash answer at once -----
  const cat2 = await ok(call(admin, 'GET', '/api/catalog'));
  const jawwal = cat2.companies.find((c) => c.name === 'جوال');
  assert.equal(jawwal.activation, 'auto');
  const bundle = cat2.packages.find((p) => p.companyId === jawwal.id && p.name.includes('90 دقيقة'));
  assert.equal(bundle.price, 17.25);
  const cash10 = cat2.packages.find((p) => p.companyId === jawwal.id && p.name === 'شحن جوال 10 ₪');
  assert.equal(cash10.cost, 10);
  const rb = await ok(call(t, 'POST', '/api/lines', { kind: 'external', packageId: bundle.id, number: '0591234567' }));
  await until(async () => (await ok(call(t, 'GET', `/api/lines/${rb.line.id}`))).line.status === 'active');
  assert.deepEqual(fake.pal[0], { phone: '0591234567', product_id: '277', company: 'jawwal', price: '15', category: '', pkg_type: 'jawwal_minutes' });
  fake.palNext = 'error';
  const rc = await ok(call(t, 'POST', '/api/lines', { kind: 'external', packageId: cash10.id, number: '0591234568' }));
  const cashTask = await until(async () => (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === rc.line.id && x.autoStatus === 'failed'));
  assert.match(cashTask.autoNote, /الرقم غير صحيح/);
  assert.deepEqual(fake.pal[1], { no2: '0591234568', id2: '27713199', price2: '10' });
  assert.equal(fake.pal.length, 2);

  // ----- an invoice activation is a request for the manager (never sent automatically) and lasts its days -----
  const sent = fake.recharges.length + fake.pal.length;
  const ri = await ok(call(t, 'POST', '/api/lines', { packageId: cel3.id, number: '0521112233', sim: '8997202000000000110', months: 3 }));
  assert.equal(ri.line.status, 'pending');
  assert.equal(ri.line.price, 99, 'a fixed-duration package is sold once, whatever months says');
  await new Promise((res) => setTimeout(res, 200));
  const invTask = (await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === ri.line.id);
  assert.equal(invTask.type, 'activate');
  assert.equal(invTask.autoStatus, '');
  assert.match(invTask.note, /90 يوماً/);
  assert.equal(fake.recharges.length + fake.pal.length, sent);
  await ok(call(admin, 'POST', `/api/tasks/${invTask.id}/resolve`, { status: 'done' }));
  const invLine = (await ok(call(t, 'GET', `/api/lines/${ri.line.id}`))).line;
  assert.ok(Math.abs(invLine.expiresAt - (Date.now() + 90 * 864e5)) < 60_000, 'expires after 90 days');

  // ----- a manual company is not sent -----
  await ok(call(admin, 'PUT', `/api/companies/${card.companyId}`, { activation: 'manual' }));
  const r3 = await ok(call(t, 'POST', '/api/lines', { kind: 'external', packageId: card.id, number: '0501234569' }));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(fake.recharges.length, 2);
  assert.equal((await ok(call(admin, 'GET', '/api/tasks'))).find((x) => x.lineId === r3.line.id).autoStatus, '');

  // ----- wrong password -----
  await ok(call(admin, 'PUT', '/api/settings', { artPass: 'nope' }));
  const bad = await call(admin, 'POST', '/api/art/check');
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /خاطئة/);
  assert.equal(agent.balance, 500);
});
