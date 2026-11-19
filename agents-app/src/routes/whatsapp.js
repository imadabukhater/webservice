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

// The one switch the manager has: the bot answers, or stays silent (WhatsApp stays linked). Everything else: the owner.
route('POST', '/api/whatsapp/replies', ADMIN, ({ body }) => {
  if (typeof body?.on !== 'boolean') fail(400, 'on: true أو false');
  wa.saveConfig({ enabled: body.on });
  return wa.status();
});

// Several numbers may be linked: each request names its number (id from GET's links; the first, 'main', when none).
function linkId(body) {
  const id = String(body?.id || 'main');
  if (!wa.status().links.some((l) => l.id === id)) fail(404, 'رقم واتساب غير موجود');
  return id;
}
const linkState = (id) => wa.status().links.find((l) => l.id === id) || {};

// A new number to link (its QR or code is then asked with /connect and its id).
route('POST', '/api/whatsapp/links', ADMIN, () => {
  const id = wa.addLink();
  return { ...wa.status(), added: id };
});
// A number removed: unlinked, and its session forgotten (the first number is only unlinked: /logout).
route('DELETE', '/api/whatsapp/links/:id', ADMIN, ({ params }) => wa.removeLink(String(params.id)));

// Starts the link and waits a few seconds for the QR code (or the link, when it was linked before).
// With a phone number: linked by an 8-character code typed on that phone instead of the QR code.
route('POST', '/api/whatsapp/connect', ADMIN, async ({ body, req }) => {
  const id = linkId(body);
  let pairPhone = '';
  if (body?.phone) {
    pairPhone = wa.jidOf(String(body.phone)).split('@')[0];
    if (!/^\d{11,15}$/.test(pairPhone)) fail(400, 'اكتب رقم واتساب المتجر، مثل 0599123456 أو 972599123456');
  }
  shopUrlFrom(req);
  await wa.start({ fresh: !!body?.fresh, pairPhone, id });
  for (let i = 0; i < 24; i++) {
    const s = linkState(id);
    if (['qr', 'code', 'connected', 'missing', 'off'].includes(s.status) && !(s.status === 'off' && i < 2)) return wa.status();
    await new Promise((r) => setTimeout(r, 400));
  }
  return wa.status();
});

route('POST', '/api/whatsapp/logout', ADMIN, ({ body }) => wa.logout(linkId(body)));

