'use strict';

class ApiError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (status, message, extra = null) => {
  throw new ApiError(status, message, extra);
};

const now = () => Date.now();
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isBlank = (v) => v === '' || v === null || v === undefined;

function num(v, label) {
  const n = Number(v);
  if (isBlank(v) || !Number.isFinite(n)) fail(400, `قيمة غير صحيحة: ${label}`);
  return round(n);
}
const optNum = (v, label) => (isBlank(v) ? null : num(v, label));

function int(v, label, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `قيمة غير صحيحة: ${label}`);
  return n;
}

function dateOrNull(v) {
  if (isBlank(v)) return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t)) fail(400, 'تاريخ غير صحيح');
  return t;
}

// Phone numbers are stored as local digits: +972 52… and 00972 52… become 052…
function normalizePhone(s) {
  let d = String(s || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if ((d.startsWith('972') || d.startsWith('970')) && d.length >= 11) d = '0' + d.slice(3);
  return d;
}
function validPhone(d) {
  if (!/^\d{9,13}$/.test(d)) fail(400, 'أدخل رقم هاتف صحيح');
  return d;
}

const normalizeIccid = (s) => String(s || '').replace(/\D/g, '');
function validIccid(d) {
  if (!/^\d{18,22}$/.test(d)) fail(400, 'رقم الشريحة (ICCID) يجب أن يكون من 18 إلى 22 رقماً');
  return d;
}

// Calendar months, clamped to the end of shorter months (31 Jan + 1 month = 28/29 Feb).
function addMonths(ts, months) {
  const d = new Date(ts);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d.getTime();
}

// End of a period: a fixed number of days (packages with a set duration) or calendar months.
const periodEnd = (ts, months, days) => (days ? ts + days * 864e5 : addMonths(ts, months));

// Day boundaries in the viewer's time zone. tzOffset is Date#getTimezoneOffset() (minutes, UTC - local).
function dayStart(ts, tzOffset) {
  const shift = tzOffset * 60000;
  return Math.floor((ts - shift) / 864e5) * 864e5 + shift;
}
function monthStart(ts, tzOffset) {
  const shift = tzOffset * 60000;
  const local = new Date(ts - shift);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) + shift;
}
function tzFrom(query) {
  const t = Number(query.tz);
  return Number.isFinite(t) && Math.abs(t) <= 14 * 60 ? t : 0;
}

const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
function imageOrEmpty(v, { maxKb, allowSvg = false, label }) {
  if (isBlank(v)) return '';
  const s = String(v);
  const m = s.match(IMAGE_RE);
  if (!m || (m[1] === 'svg+xml' && !allowSvg)) fail(400, `صورة غير صالحة: ${label}`);
  if (s.length > maxKb * 1024 * 1.37) fail(413, `الصورة كبيرة جداً: ${label}`);
  return s;
}

// Detect real raster image format from file magic bytes (Azure Blob Storage often serves PNGs as application/octet-stream).
function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return '';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
      && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return 'image/gif';
  return '';
}

// Normalizes a raster QR image data URL or raw base64 PNG/JPEG (e.g. QuickLine barcodeImage) into a valid data:image/... URL.
function normalizeQrDataUrl(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) {
    return s.replace(/^data:image\/jpg;/i, 'data:image/jpeg;').replace(/\s+/g, '');
  }
  const compact = s.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/]+=*$/.test(compact) && compact.length >= 12) {
    const mime = sniffImageMime(Buffer.from(compact.slice(0, 32), 'base64'));
    if (mime) return `data:${mime};base64,${compact}`;
  }
  return '';
}

// Arabic count phrases: 1 رقم واحد، 2 رقمان، 3-10 أرقام، 11+ رقماً.
function arCount(n, { one, two, few, many }) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n % 100 >= 3 && n % 100 <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

module.exports = {
  arCount,
  ApiError, fail, now, round, str, isBlank, num, optNum, int, dateOrNull,
  normalizePhone, validPhone, normalizeIccid, validIccid, addMonths, periodEnd,
  dayStart, monthStart, tzFrom, imageOrEmpty, sniffImageMime, normalizeQrDataUrl,
};
