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

test('every page in the router is in the offline cache, and the other way round', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, '..', 'sw.js'), 'utf8');
  const pages = [...main.matchAll(/from '\.\/views\/([\w-]+\.js)'/g)].map((m) => m[1]);
  for (const p of pages) assert.ok(sw.includes(`/js/views/${p}`), `${p} missing from sw.js`);
  for (const [, p] of sw.matchAll(/'\/js\/views\/([\w-]+\.js)'/g)) assert.ok(fs.existsSync(path.join(ROOT, 'views', p)), `sw.js caches missing ${p}`);
});
