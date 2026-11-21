'use strict';
// The manager's view of every supplier's subscribers (src/supsubs.js), and reading them again now.
const { route, ADMIN } = require('../router');
const subs = require('../supsubs');

route('GET', '/api/supplier-subs', ADMIN, ({ query }) => (query?.summary ? subs.summary() : subs.view()));
route('POST', '/api/supplier-subs/sync', ADMIN, async ({ body }) => {
  const key = body?.supplier && subs.NAMES[body.supplier] ? body.supplier : '';
  const result = key ? [await subs.syncOne(key)] : await subs.syncAll({ force: true });
  return { ...subs.summary(), result };
});
