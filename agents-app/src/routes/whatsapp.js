'use strict';
// The manager links the shop's WhatsApp (QR code), sets who it answers, and sends a test message. Manager only.
const { route, ADMIN } = require('../router');
const { str } = require('../util');
const wa = require('../whatsapp');

// The shop's address, from the address the manager uses, until one is set.
function shopUrlFrom(req) {
  if (wa.config().shopUrl) return;
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  if (/^[\w.-]+(:\d+)?$/.test(host) && !/^(localhost|127\.|\[)/.test(host)) wa.saveConfig({ shopUrl: `https://${host}/shop` });
}

route('GET', '/api/whatsapp', ADMIN, () => wa.status());

route('PUT', '/api/whatsapp', ADMIN, ({ body }) => {
  wa.saveConfig(body || {});
  return wa.status();
});

// Starts the link and waits a few seconds for the QR code (or the link, when it was linked before).
route('POST', '/api/whatsapp/connect', ADMIN, async ({ body, req }) => {
  shopUrlFrom(req);
  await wa.start({ fresh: !!body?.fresh });
  for (let i = 0; i < 24; i++) {
    const s = wa.status();
    if (['qr', 'connected', 'missing', 'off'].includes(s.status) && !(s.status === 'off' && i < 2)) return s;
    await new Promise((r) => setTimeout(r, 400));
  }
  return wa.status();
});

route('POST', '/api/whatsapp/logout', ADMIN, () => wa.logout());

route('POST', '/api/whatsapp/test', ADMIN, ({ body }) => wa.sendTo(body?.phone, str(body?.text, 500) || '✅ واتساب المتجر مربوط ويعمل. اكتب *مساعدة* لعرض الأوامر.'));
