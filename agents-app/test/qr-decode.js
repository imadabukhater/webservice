'use strict';
// Test helper (not a test file): reads a QR code drawn by src/qr.js (8-bit grey PNG data URL) with the ZXing library the
// app already ships for its camera scanner, so tests prove a code is a real, scannable QR.
const zlib = require('node:zlib');
const ZXing = require('../public/js/vendor/zxing.min.js');

function decodeQrDataUrl(dataUrl) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('not a PNG data URL');
  const buf = Buffer.from(m[1], 'base64');
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const lum = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) lum[y * width + x] = raw[y * (width + 1) + 1 + x];
  const hints = new Map([[ZXing.DecodeHintType.PURE_BARCODE, true], [ZXing.DecodeHintType.TRY_HARDER, true]]);
  const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.RGBLuminanceSource(lum, width, height)));
  return new ZXing.QRCodeReader().decode(bitmap, hints).getText();
}

module.exports = { decodeQrDataUrl };
