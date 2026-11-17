'use strict';
// A phone number is read only when it stands on its own: never out of a SIM's ICCID, whose digits may hold one.
process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'admin-pass';
process.env.WA_DATA = require('node:path').join(require('node:os').tmpdir(), `wa-phone-${process.pid}`);
const test = require('node:test');
const assert = require('node:assert/strict');
const { phoneIn } = require('../src/whatsapp')._test;

test('phone numbers read from a message, never out of an ICCID', () => {
  for (const [text, want] of [
    ['0599123456', '0599123456'], ['059 912 3456', '0599123456'], ['رقمي 0599-123-456 لو سمحت', '0599123456'],
    ['972599123456', '0599123456'], ['+972599123456', '0599123456'], ['00970599123456', '0599123456'],
    ['8997250408008240211', ''], ['89972096000017022954', ''], ['8997205123456789012', ''], ['8997 2504 0800 8240 211', ''],
    ['10599123456', ''], ['05991234567', ''],
    ['شحن 0521112233 12', '0521112233'], ['شحن 12 0521112233', '0521112233'], ['حالة 0521112233', '0521112233'],
    ['رقم الشريحة 8997250408008240211 والرقم 0599123456', '0599123456'],
  ]) assert.equal(phoneIn(text), want, text);
});
