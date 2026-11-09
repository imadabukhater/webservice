'use strict';
// Real eSIM QR codes: what src/qr.js draws scans back to the exact activation code; the old made-up picture is
// recognised so it is never shown or e-mailed.
const test = require('node:test');
const assert = require('node:assert/strict');
const qr = require('../src/qr');
const { decodeQrDataUrl } = require('./qr-decode');

test('eSIM QR codes are real: each scans back to its exact activation code', () => {
  const codes = [
    'LPA:1$smdp.example.com$ABCD-1234-EFGH-5678',
    'LPA:1$rsp-eu.simlessly.com$0F3B8C2E4D6A1B9C7E5F3A1D2C4B6E8F$1.3.6.1.4.1.31746',
    'LPA:1$consumer.rsp.world$' + 'A'.repeat(90),
  ];
  for (const code of codes) {
    const url = qr.dataUrl(code);
    assert.match(url, /^data:image\/png;base64,/);
    assert.equal(decodeQrDataUrl(url), code);
  }
  assert.equal(qr.dataUrl(''), '', 'no code, no QR');
  assert.equal(qr.dataUrl('   '), '');
});

test('the made-up activation codes and QR pictures of earlier versions are recognised', () => {
  const shop = require('../src/shop');
  assert.equal(shop.isMadeUpCode('LPA:1$rsp.aloha.portal$ESIM-ABCD1234-0553381540'), true);
  assert.equal(shop.isMadeUpCode('LPA:1$rsp.esim.local$ACTIVATE'), true);
  assert.equal(shop.isMadeUpCode('LPA:1$smdp.example$ACT-77'), false);
  const oldSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 245 267" width="280" height="280"><rect width="100%" height="100%" rx="16" fill="#ffffff"/><g fill="#0f172a"><rect x="21" y="21" width="7" height="7" rx="1.2"/></g></svg>`;
  assert.equal(shop.isMadeUpQr(`data:image/svg+xml;base64,${Buffer.from(oldSvg).toString('base64')}`), true);
  assert.equal(shop.isMadeUpQr(qr.dataUrl('LPA:1$smdp.example$ACT-77')), false);
  assert.equal(shop.makeEsimQr(''), '', 'no QR is ever made without a real code');
});
