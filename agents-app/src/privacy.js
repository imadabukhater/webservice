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
const NAMES = '(?:QuickLine|Aylol|أيلول|art-topup|Layan|LayanT|ليان|telecom(?:\\.co\\.il)?)';
function forAgent(text) {
  if (text === null || text === undefined) return text;
  return String(text)
    .replace(new RegExp(`${NAMES}\\s*\\(تلقائي\\)`, 'gi'), 'تلقائي') // who carried it out
    .replace(new RegExp(`\\s*(?:عبر|من|في|على|لدى)\\s+${NAMES}`, 'gi'), '') // "… عبر QuickLine"
    .replace(new RegExp(`${NAMES}\\s*:?\\s*`, 'gi'), '') // anything else
    .replace(/\s{2,}/g, ' ')
    .trim();
}

module.exports = { sourceOf, forAgent };
