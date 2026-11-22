'use strict';
// The supplier behind a line (QuickLine, Layan, telecom, Aylol, or the manager by hand), named for the manager; and
// free text with any supplier's name taken out, for text a customer may read.

// The supplier behind a package ref, as the manager sees it.
function sourceOf(ref) {
  const r = String(ref || '');
  if (/^ay:/.test(r)) return 'أيلول';
  if (/^qln?:/.test(r)) return 'QuickLine';
  if (/^lyn?:/.test(r)) return 'ليان';
  if (/^tcn?:/.test(r)) return 'telecom';
  return 'يدوي';
}

// Free text without any supplier's name.
const NAMES = '(?:QuickLine|كويك\\s*لاين|Aylol|أيلول|ايلول|art-topup|LayanT?|ليان|تليكوم|telecom(?:\\.co\\.il)?)';
function forAgent(text) {
  if (text === null || text === undefined) return text;
  return String(text)
    .replace(new RegExp(`${NAMES}\\s*\\(تلقائي\\)`, 'gi'), 'تلقائي') // who carried it out
    .replace(new RegExp(`\\s*(?:عبر|من|في|على|لدى)\\s+${NAMES}`, 'gi'), '') // "… عبر QuickLine"
    .replace(new RegExp(`${NAMES}\\s*:?\\s*`, 'gi'), '') // anything else
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Customer-facing package name: removes supplier names, internal DB id suffixes like "(213)",
// raw supplier tags ("ESIM JUST"), and common typos ("جبجا" -> "جيجا").
function publicPackageName(name) {
  let s = forAgent(String(name || ''));
  s = s
    .replace(/\bESIM\s+JUST\b/gi, '')
    .replace(/جبجا/g, 'جيجا')
    .replace(/\s*\(\d{2,6}\)\s*$/g, '')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/([—–-])\s*(?=[—–-]|$)/g, '')
    .replace(/^\s*[—–-]\s*/, '')
    .replace(/\s*\/\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s || String(name || '').trim();
}

module.exports = { sourceOf, forAgent, publicPackageName };
