'use strict';

// Parser minimal XLSX (Excel modern, .xlsx) -> randuri [[celula,...],...], fara dependinte noi.
// .xlsx e o arhiva ZIP de fisiere XML; folosim adm-zip (deja in proiect) ca sa citim
// tabelul de siruri partajate + prima foaie de calcul. (Formatul vechi .xls binar NU e suportat.)

const zipGuard = require('./zipGuard');

function decodeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Litera coloanei (A, B, ... AA) -> index 0-based. */
function colIndex(ref) {
  const m = String(ref).match(/^([A-Z]+)/);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Parseaza un buffer .xlsx in randuri (array de array de string-uri). */
function parseXlsx(buffer) {
  let zip;
  try {
    // garda anti zip-bomb (XLSX e tot un ZIP): limite mai stranse decat la importul de firma
    zip = zipGuard.openGuarded(buffer, { maxEntries: 200, maxEntrySize: 64 * 1024 * 1024, maxTotalSize: 128 * 1024 * 1024 }).zip;
  } catch (e) { throw new Error(e.status ? e.message : 'Fisier XLSX invalid sau corupt.', { cause: e }); }

  // 1) tabelul de siruri partajate (optional)
  const shared = [];
  const ss = zip.getEntry('xl/sharedStrings.xml');
  if (ss) {
    const xml = ss.getData().toString('utf8');
    for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) || []) {
      const texts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
      shared.push(texts.join(''));
    }
  }

  // 2) prima foaie de calcul
  let sheet = zip.getEntry('xl/worksheets/sheet1.xml');
  if (!sheet) sheet = zip.getEntries().find((x) => /^xl\/worksheets\/.*\.xml$/i.test(x.entryName));
  if (!sheet) throw new Error('Fisierul XLSX nu contine nicio foaie de calcul.');
  const xml = sheet.getData().toString('utf8');

  const rows = [];
  for (const rowXml of xml.match(/<row[\s\S]*?<\/row>|<row[^>]*\/>/g) || []) {
    const cells = [];
    for (const cm of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const col = colIndex((attrs.match(/r="([A-Z]+)\d+"/) || [])[1] || '');
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      let val = '';
      if (type === 's') {
        const idx = parseInt((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1], 10);
        val = Number.isFinite(idx) && shared[idx] != null ? shared[idx] : '';
      } else if (type === 'inlineStr') {
        val = decodeXml((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
      } else {
        val = decodeXml((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
      }
      if (col >= 0) cells[col] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

module.exports = { parseXlsx };
