'use strict';
// The manager links and unlinks the shop's WhatsApp (QR code), and sees its state. Its settings (who it answers, the
// assistant, its daily spending limit) are changed only on the server by the owner: scripts/whatsapp-settings.js.
const { route, ADMIN } = require('../router');
const { fail } = require('../util');
const wa = require('../whatsapp');

// The shop's address, from the address the manager uses, until one is set.
function shopUrlFrom(req) {
  if (wa.config().shopUrl) return;
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  if (/^[\w.-]+(:\d+)?$/.test(host) && !/^(localhost|127\.|\[)/.test(host)) wa.saveConfig({ shopUrl: `https://${host}/shop` });
}

route('GET', '/api/whatsapp', ADMIN, () => wa.status());

route('PUT', '/api/whatsapp', ADMIN, () => fail(403, 'إعدادات واتساب والمساعد تُعدَّل على السيرفر من صاحب الحساب فقط'));

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

