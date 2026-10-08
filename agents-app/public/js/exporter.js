// Report export: copy (tab-separated, pastes into Excel/Sheets), CSV, Excel, print / save as PDF.
import { esc, fmtDate, fmtDateTime, fmtMoney, downloadBlob, copyText } from './core.js';

export function cellText(col, v) {
  if (v === null || v === undefined || v === '') return '';
  switch (col.type) {
    case 'date': return fmtDate(v);
    case 'datetime': return fmtDateTime(v);
    case 'money': return fmtMoney(v);
    default: return String(v);
  }
}

// Raw values for spreadsheets: numbers stay numbers, identifiers stay text.
function rawValue(col, v) {
  if (v === null || v === undefined) return '';
  if (col.type === 'money' || col.type === 'num') return String(v);
  return cellText(col, v);
}

const stamp = () => new Date().toISOString().slice(0, 10);
const safeName = (title) => String(title).replace(/[\\/:*?"<>|]+/g, ' ').trim();
// Download names stay ASCII: several phone browsers replace Arabic file names with "download".
const fileName = (base, ext) => `${String(base || 'report').replace(/[^A-Za-z0-9_-]+/g, '-')}-${stamp()}.${ext}`;

export function exportCSV(title, columns, rows, base) {
  const quote = (s) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = [columns.map((c) => quote(c.label)).join(',')];
  for (const r of rows) {
    lines.push(columns.map((c) => {
      const v = rawValue(c, r[c.key]);
      // Long digit strings (ICCIDs, phone numbers with a leading 0) must not become numbers in Excel.
      return quote((c.type === 'iccid' || c.type === 'phone') && v ? `="${v}"` : v);
    }).join(','));
  }
  downloadBlob(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), fileName(base, 'csv'));
}

export function exportExcel(title, columns, rows, base) {
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr>${columns.map((c) => {
    const v = rawValue(c, r[c.key]);
    const style = c.type === 'iccid' || c.type === 'phone' ? ' style="mso-number-format:\'\\@\'"' : '';
    return `<td${style}>${esc(v)}</td>`;
  }).join('')}</tr>`).join('');
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${esc(safeName(title).slice(0, 30))}</x:Name>
<x:WorksheetOptions><x:DisplayRightToLeft/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>
<body dir="rtl"><table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
  downloadBlob(new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8' }), fileName(base, 'xls'));
}

export function copyTable(columns, rows) {
  const lines = [columns.map((c) => c.label).join('\t'), ...rows.map((r) => columns.map((c) => cellText(c, r[c.key])).join('\t'))];
  return copyText(lines.join('\n'));
}

// Prints only the table through a hidden frame; "Save as PDF" in the print dialog gives the PDF.
export function printTable(title, subtitle, columns, rows) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { margin: 14mm; }
  body { font-family: "IBM Plex Sans Arabic", Tahoma, Arial, sans-serif; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; } p { color: #555; margin: 0 0 14px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  th, td { border: 1px solid #ccd3dd; padding: 6px 8px; text-align: right; }
  th { background: #eef2f8; }
  td.ltr { direction: ltr; text-align: left; }
  tr:nth-child(even) td { background: #f8fafc; }
</style></head><body><h1>${esc(title)}</h1><p>${esc(subtitle)} · ${esc(fmtDateTime(Date.now()))} · ${rows.length} سطر</p>
<table><thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
${rows.map((r) => `<tr>${columns.map((c) => `<td class="${['phone', 'iccid', 'money', 'num'].includes(c.type) ? 'ltr' : ''}">${esc(cellText(c, r[c.key]))}</td>`).join('')}</tr>`).join('')}
</tbody></table></body></html>`);
  doc.close();
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1500);
  }, 250);
}
