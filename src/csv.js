'use strict';

// Generator CSV compatibil cu Excel (separator ';', BOM UTF-8 pentru diacritice, CRLF).

function cell(v) {
  const s = String(v == null ? '' : v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** headers: string[]; rows: (string|number)[][] */
const BOM = '﻿';
function toCsv(headers, rows) {
  const lines = [headers.map(cell).join(';')];
  for (const r of rows) lines.push(r.map(cell).join(';'));
  return BOM + lines.join('\r\n') + '\r\n';
}

/** Parseaza CSV (separator `;` sau `,`, ghilimele cu `""` escapate, BOM tolerat). */
function parseCsv(text) {
  const s = String(text || '').replace(new RegExp('^' + BOM), '');
  const sep = (s.split('\n')[0] || '').includes(';') ? ';' : ',';
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((c) => c !== ''));
}

module.exports = { toCsv, parseCsv };
