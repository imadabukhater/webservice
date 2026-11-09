'use strict';
// Real QR codes for eSIM activation codes ("LPA:1$smdp.example$MATCHING-ID"), drawn on the server as PNG (Gmail does
// not show SVG). The activation code never leaves the server for a third-party image service. Only a real code is
// drawn: there is no QR without one.
const zlib = require('node:zlib');
const qrcode = require('./vendor/qrcode-generator');

qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// The QR's modules: true = dark. Error correction M, the smallest version that fits.
function matrix(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (__, c) => qr.isDark(r, c)));
}

// 8-bit greyscale PNG, `scale` pixels per module and the standard 4-module quiet zone.
function png(text, { scale = 8 } = {}) {
  const m = matrix(text);
  if (!m) return null;
  const quiet = 4;
  const size = (m.length + quiet * 2) * scale;
  const raw = Buffer.alloc((size + 1) * size, 255);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0; // filter: none
    const r = Math.floor(y / scale) - quiet;
    if (r < 0 || r >= m.length) continue;
    for (let x = 0; x < size; x++) {
      const c = Math.floor(x / scale) - quiet;
      if (c >= 0 && c < m.length && m[r][c]) raw[y * (size + 1) + 1 + x] = 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// data:image/png;base64,… for an <img>, a download or an e-mail attachment; '' without a code.
function dataUrl(text, options) {
  const buf = png(text, options);
  return buf ? `data:image/png;base64,${buf.toString('base64')}` : '';
}

module.exports = { matrix, png, dataUrl };
