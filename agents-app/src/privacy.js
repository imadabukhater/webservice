'use strict';
// Who activates a line — the supplier: art-topup, QuickLine, or the manager by hand — is the manager's to know.
// Agents (and so their customers) are never sent it: not as a field, not in a message, not in a history entry.
// The server leaves it out of everything an agent can read; this module names it for the manager, and takes it out
// of free text (replies, notes, notifications) written for an agent, including text stored by earlier versions.

// The supplier behind a package ref, as the manager sees it.
function sourceOf(ref) {
  const r = String(ref || '');
  if (/^qln?:/.test(r)) return 'QuickLine';
  if (/^lyn?:/.test(r)) return 'ليان';
  if (/^tcn?:/.test(r)) return 'telecom';
  if (/^(ic|pb|pc|inv):/.test(r)) return 'art-topup';
  return 'يدوي';
}

// Free text for an agent, without any supplier's name.
const NAMES = '(?:QuickLine|art-topup|Layan|LayanT|ليان|telecom(?:\\.co\\.il)?)';
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
