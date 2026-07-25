'use strict';

// Generator CSV compatibil cu Excel (separator ';', BOM UTF-8 pentru diacritice, CRLF).

// Injectie de formule in foaia de calcul: Excel/LibreOffice EVALUEAZA continutul unei celule
// care incepe cu `=`, `+`, `@` sau TAB/CR. Denumirile de parteneri vin din e-Factura/SPV — adica
// le scrie partea cealalta — din extrase bancare si din extragerea AI, iar exporturile astea
// ajung deschise in Excel de contabil. Prefixarea cu apostrof e conventia recunoscuta: celula se
// afiseaza ca text, formula nu se evalueaza (apostroful ramane vizibil — pretul sigurantei).
//
// `-` E in lista (vectorul DDE clasic incepe cu `-2+3+cmd|…`), dar NUMAI impreuna cu garda
// NUMERIC: `-1234.56` e o suma negativa legitima si foarte frecventa in contabilitate, iar un
// prefix acolo ar strica orice export cu valori negative. Deci: numerele se lasa in pace,
// indiferent de semn; se prefixeaza doar textul care ar fi interpretat drept formula.
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMERIC = /^[-+]?\d+([.,]\d+)?$/;
function cell(v) {
  let s = String(v == null ? '' : v);
  if (FORMULA_START.test(s) && !NUMERIC.test(s)) s = "'" + s;
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
  // Scoate apostroful pus la EXPORT ca protectie contra formulelor, ca un dus-intors
  // (export -> reimport) sa nu adauge un caracter in denumire. Se scoate doar cand e urmat de un
  // caracter de formula: un nume care chiar incepe cu apostrof ramane neatins. Setul de
  // caractere e DERIVAT din FORMULA_START, ca cele doua capete sa nu poata devia.
  const stripApostrof = new RegExp("^'(?=" + FORMULA_START.source.replace(/^\^/, '') + ')');
  return rows.map((r) => r.map((x) => x.trim().replace(stripApostrof, ''))).filter((r) => r.some((c) => c !== ''));
}

module.exports = { toCsv, parseCsv };
