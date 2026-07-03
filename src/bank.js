'use strict';

const { round2, period: periodOf } = require('./util');
const { parseRoNumber } = require('./extractor');

/** Imparte un rand CSV respectand ghilimelele. */
function splitCsvLine(line, delim) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === delim && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function detectDelim(text) {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n');
  return (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ';' : ',';
}

function parseDateRo(s) {
  let m = String(s).match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** Parseaza un extras CSV (cu sau fara antet). Returneaza tranzactii. */
function parseCsv(text) {
  const delim = detectDelim(text);
  const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => splitCsvLine(l, delim));
  if (!rows.length) return [];
  // gaseste randul de antet
  let headIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const j = rows[i].join('|').toLowerCase();
    if (/data|date/.test(j) && /(suma|amount|debit|credit|valoare)/.test(j)) { headIdx = i; break; }
  }
  const norm = (s) => s.toLowerCase();
  let cols = { data: 0, desc: 1, debit: -1, credit: -1, suma: -1 };
  let start = 0;
  if (headIdx >= 0) {
    const h = rows[headIdx].map(norm);
    const find = (re) => h.findIndex((x) => re.test(x));
    cols = {
      data: find(/data|date/),
      desc: find(/descri|detal|explica|referin|beneficiar|ordonator|partener|denumire/),
      debit: find(/debit|plati|iesiri/),
      credit: find(/credit|incasari|intrari/),
      suma: find(/^suma$|amount|valoare/),
    };
    start = headIdx + 1;
  }
  const txns = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const data = parseDateRo(r[cols.data >= 0 ? cols.data : 0] || '');
    if (!data) continue;
    const descParts = [];
    if (cols.desc >= 0 && r[cols.desc]) descParts.push(r[cols.desc]);
    else r.forEach((c, idx) => { if (idx !== cols.data && idx !== cols.debit && idx !== cols.credit && idx !== cols.suma && /[a-zA-Z]/.test(c)) descParts.push(c); });
    const descriere = descParts.join(' ').trim();
    let suma = 0; let sens = '';
    const deb = cols.debit >= 0 ? parseRoNumber(r[cols.debit]) : null;
    const cre = cols.credit >= 0 ? parseRoNumber(r[cols.credit]) : null;
    if (deb || cre) {
      if (cre && cre > 0) { suma = cre; sens = 'in'; } else if (deb && deb > 0) { suma = deb; sens = 'out'; } else continue;
    } else {
      const v = parseRoNumber(r[cols.suma >= 0 ? cols.suma : r.length - 1]);
      if (v == null || v === 0) continue;
      suma = Math.abs(v); sens = v >= 0 ? 'in' : 'out';
    }
    txns.push({ data, descriere, suma: round2(suma), sens });
  }
  return txns;
}

/** Parseaza un extras MT940 (tag-uri :61: si :86:). */
function parseMt940(text) {
  const lines = text.split(/\r?\n/);
  const txns = []; let cur = null;
  for (const line of lines) {
    if (line.startsWith(':61:')) {
      if (cur) txns.push(cur);
      const body = line.slice(4);
      const m = body.match(/^(\d{6})(\d{4})?(R?[CD])([0-9.,]+)/);
      if (!m) { cur = null; continue; }
      const yy = m[1].slice(0, 2); const mm = m[1].slice(2, 4); const dd = m[1].slice(4, 6);
      const sens = /C/.test(m[3]) && !/RC/.test(m[3]) ? 'in' : (/D/.test(m[3]) ? 'out' : 'in');
      cur = { data: `20${yy}-${mm}-${dd}`, sens, suma: round2(parseRoNumber(m[4]) || 0), descriere: '' };
    } else if (line.startsWith(':86:') && cur) {
      cur.descriere += line.slice(4).replace(/\?\d{2}/g, ' ').trim() + ' ';
    } else if (cur && line && !line.startsWith(':')) {
      cur.descriere += line.trim() + ' ';
    }
  }
  if (cur) txns.push(cur);
  return txns.map((t) => ({ ...t, descriere: t.descriere.trim() }));
}

function parseStatement(text) {
  return /:61:/.test(text) ? parseMt940(text) : parseCsv(text);
}

/** Cauta partenerul potrivit dupa CUI sau denumire in descriere. */
function matchPartner(db, descriere) {
  const D = String(descriere).toUpperCase();
  for (const cui of Object.keys(db.partners || {})) {
    if (D.replace(/\D/g, '').includes(cui) || D.includes('RO' + cui)) return db.partners[cui];
  }
  const names = new Map();
  for (const p of Object.values(db.partners || {})) if (p.den) names.set(p.den.toUpperCase(), { den: p.den, cui: p.cui });
  for (const e of db.entries) if (e.partener) names.set(e.partener.toUpperCase(), { den: e.partener, cui: e.partenerCui ? e.partenerCui.replace(/^ro/i, '') : '' });
  for (const [up, info] of names) if (up.length > 3 && D.includes(up)) return info;
  return null;
}

/** Construieste o sugestie de inregistrare pentru o tranzactie bancara. */
function suggest(db, t) {
  const lc = t.descriere.toLowerCase();
  if (/comision|spez|taxa adm|cost adm/.test(lc)) {
    return { tip: 'comision_bancar', fields: { data: t.data, document: '', suma: t.suma } };
  }
  if (/dobanda|dobânda/.test(lc) && t.sens === 'out') {
    return { tip: 'dobanda_bancara', fields: { data: t.data, document: '', suma: t.suma } };
  }
  const p = matchPartner(db, t.descriere);
  const partener = (p && p.den) || t.descriere.slice(0, 40);
  const cui = p && p.cui ? 'RO' + String(p.cui).replace(/^ro/i, '') : '';
  if (t.sens === 'in') {
    return { tip: 'incasare_client', matched: !!p, fields: { data: t.data, partener, cuiPartener: cui, document: '', suma: t.suma, cont: '5121' } };
  }
  return { tip: 'plata_furnizor', matched: !!p, fields: { data: t.data, partener, cuiPartener: cui, document: '', suma: t.suma, cont: '5121', contFz: '401' } };
}

function parseAndSuggest(db, text) {
  const txns = parseStatement(text);
  return txns.map((t, i) => Object.assign({ idx: i, data: t.data, descriere: t.descriere, suma: t.suma, sens: t.sens }, suggest(db, t)));
}

module.exports = { parseStatement, parseCsv, parseMt940, parseAndSuggest, matchPartner };
