'use strict';

// Parser .xls (format binar BIFF, Excel vechi) prin SheetJS. Returneaza randuri [[celula,...],...].
// Folosit doar pentru .xls binar; pentru .xlsx folosim parserul propriu (src/xlsx.js).

const XLSX = require('xlsx');

function parseXls(buffer) {
  let wb;
  try { wb = XLSX.read(buffer, { type: 'buffer' }); } catch (e) { throw new Error('Fisier XLS invalid sau corupt.', { cause: e }); }
  const name = wb.SheetNames[0];
  if (!name) throw new Error('Fisierul XLS nu contine nicio foaie de calcul.');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
  return rows.map((r) => (r || []).map((c) => String(c == null ? '' : c)));
}

module.exports = { parseXls };
