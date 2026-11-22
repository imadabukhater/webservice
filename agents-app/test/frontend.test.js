'use strict';
// A missing module breaks the whole app (main.js imports every page), so check every relative import resolves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'js');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'vendor' ? [] : files(p);
  return e.name.endsWith('.js') ? [p] : [];
});

test('every frontend import points at an existing file', () => {
  const missing = [];
  for (const file of files(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g)) {
      if (!fs.existsSync(path.resolve(path.dirname(file), spec))) missing.push(`${path.relative(ROOT, file)} → ${spec}`);
    }
  }
  assert.deepEqual(missing, []);
});

// Named exports of a module (export const/function/class and export { … }).
const exportsOf = (src) => new Set([
  ...[...src.matchAll(/export\s+(?:async\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  ...[...src.matchAll(/export\s*\{([^}]+)\}/g)].flatMap((m) => m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop())),
]);

test('every named frontend import is exported by its module', () => {
  const missing = [];
  for (const file of files(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [, names, spec] of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) continue;
      const ex = exportsOf(fs.readFileSync(target, 'utf8'));
      for (const n of names.split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        if (!ex.has(n)) missing.push(`${path.relative(ROOT, file)}: ${n} from ${spec}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('every page in the router is in the offline cache, and the other way round', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, '..', 'sw.js'), 'utf8');
  const pages = [...main.matchAll(/from '\.\/views\/([\w-]+\.js)'/g)].map((m) => m[1]);
  for (const p of pages) assert.ok(sw.includes(`/js/views/${p}`), `${p} missing from sw.js`);
  for (const [, p] of sw.matchAll(/'\/js\/views\/([\w-]+\.js)'/g)) assert.ok(fs.existsSync(path.join(ROOT, 'views', p)), `sw.js caches missing ${p}`);
  for (const [, p] of sw.matchAll(/'\/js\/([\w-]+\.js)'/g)) assert.ok(fs.existsSync(path.join(ROOT, p)), `sw.js caches missing ${p}`);
});

// The panel is the eSIM shop's manager's only: no agents, balances, renewals or subscriber actions.
test('the admin panel has only the eSIM shop pages and calls no removed endpoint', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const pages = [...main.matchAll(/from '\.\/views\/([\w-]+)\.js'/g)].map((m) => m[1]).sort();
  assert.deepEqual(pages, ['buyers', 'catalog', 'home', 'login', 'reports', 'settings', 'shop', 'tasks']);
  const gone = new RegExp([
    String.raw`\/api\/(agents|lines|sims|offers|messages|invoices|art|sync-keys|supplier-subs|search|ops|transfer|numbers|companies)\b`,
    String.raw`\/api\/shop\/renew`, String.raw`\/api\/packages\/bulk`, String.raw`\/api\/catalog\/similar`,
    String.raw`\/api\/(quickline|layan|telecom|aylol)\/(pending|approve|reprice|sync)\b`,
    String.raw`api\.(post|del)\(\s*['\x60]\/api\/packages`,
    String.raw`#\/(new|renew|subscribers|agents|payments|messages|offers|invoices)\b`,
  ].join('|'));
  const admin = [path.join(ROOT, 'main.js'), path.join(ROOT, 'core.js'), ...files(path.join(ROOT, 'views'))];
  const hits = admin.filter((f) => gone.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, []);
});

// The shop price is automatic: the packages page reads the catalog and only switches «عرض في المتجر».
test('the packages page calls only GET /api/catalog, PUT /api/packages/:id { inShop } and PUT /api/settings { shopMarkup }', () => {
  const src = fs.readFileSync(path.join(ROOT, 'views', 'catalog.js'), 'utf8');
  const calls = [...src.matchAll(/api\.(get|post|put|del|blob)\(\s*(['`])([^'`]*)\2/g)].map((m) => `${m[1]} ${m[3]}`).sort();
  assert.deepEqual(calls, ['get /api/catalog', 'put /api/packages/${id}', 'put /api/settings']);
  assert.match(src, /api\.put\(`\/api\/packages\/\$\{id\}`,\s*\{\s*inShop:/);
  assert.match(src, /api\.put\('\/api\/settings',\s*\{\s*shopMarkup:/);
});

// The profit percentage lives on the packages page only.
test('no other admin page edits the shop markup', () => {
  const others = files(path.join(ROOT, 'views')).filter((f) => !f.endsWith('catalog.js'));
  const hits = others.filter((f) => /markup/i.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, []);
});

test('service worker ignores query strings for cached assets and only falls back to HTML on navigate', () => {
  const sw = fs.readFileSync(path.join(ROOT, '..', 'sw.js'), 'utf8');
  assert.match(sw, /ignoreSearch:\s*true/);
  assert.match(sw, /e\.request\.mode\s*===\s*'navigate'/);
});

test('storefront sheets navigate via go/return { go }, use no inline onclick, and guard async routes', () => {
  const shop = fs.readFileSync(path.join(ROOT, 'shop.js'), 'utf8');
  assert.doesNotMatch(shop, /\bonclick=/i);
  assert.match(shop, /return\s*\{\s*go:\s*`#\/order\//);
  assert.match(shop, /go\(`#\/buy\/\$\{pk\.id\}\?esim=1`\)/);
  assert.match(shop, /const seq = \+\+S\.seq;/);
  assert.match(shop, /function getTheme\(\)\s*\{\s*try\s*\{/);
});

test('admin portal views have valid form markup, visible WA errors, no dead shopInstant, and offline boot recovery', () => {
  const settings = fs.readFileSync(path.join(ROOT, 'views', 'settings.js'), 'utf8');
  assert.doesNotMatch(settings, /<form[^>]*<form/);
  assert.match(settings, /V\.wa\.links\.map\(\(l\) => \(l\.id === id \? \{ \.\.\.l, status: 'off', error: err\.message \} : l\)\)/);
  const shopView = fs.readFileSync(path.join(ROOT, 'views', 'shop.js'), 'utf8');
  assert.doesNotMatch(shopView, /shopInstant/);
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(main, /if \(!document\.getElementById\('view'\)\) return boot\(\);/);
  assert.match(main, /if \(e\.status !== 401\)/);
  const buyers = fs.readFileSync(path.join(ROOT, 'views', 'buyers.js'), 'utf8');
  assert.doesNotMatch(buyers, /title:\s*esc\(/);
  assert.match(shopView, /const btn = e\.currentTarget;/);
  const shopHtml = fs.readFileSync(path.join(ROOT, '..', 'shop.html'), 'utf8');
  assert.doesNotMatch(shopHtml, /USDT|Visa|MasterCard|تجديد رصيد/);
});
