'use strict';

// Garda pentru arhive ZIP primite din exterior (import de firma, XLSX, fisiere SPV):
// adm-zip citeste tot in memorie, iar o arhiva construita malitios (zip-bomb) poate
// declara/produce dimensiuni uriase la dezarhivare. Validam INAINTE de a citi datele:
// numarul de intrari, dimensiunea declarata per fisier, totalul decomprimat si raportul
// de compresie (dimensiunile vin din antetele arhivei; adm-zip 0.6 verifica el insusi
// ca datele reale nu depasesc antetul).

const AdmZip = require('adm-zip');

const DEFAULTS = {
  maxEntries: 5000,            // fisiere in arhiva
  maxEntrySize: 64 * 1024 * 1024,   // 64 MB per fisier dezarhivat
  maxTotalSize: 512 * 1024 * 1024,  // 512 MB total dezarhivat
  maxRatio: 400,               // raport de compresie per fisier (XML-urile se comprima ~100x)
};

/** Deschide arhiva si intoarce { zip, entries } dupa validarea limitelor.
 *  Arunca Error cu `status=400` (mesaj pentru utilizator) la orice depasire. */
function openGuarded(buffer, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const fail = (msg) => { const e = new Error(msg); e.status = 400; throw e; };
  let zip;
  try { zip = new AdmZip(buffer); } catch (e) { fail('Arhiva ZIP invalida sau corupta.'); }
  const entries = zip.getEntries();
  if (entries.length > o.maxEntries) fail(`Arhiva are prea multe fisiere (${entries.length} > ${o.maxEntries}).`);
  let total = 0;
  for (const en of entries) {
    if (en.isDirectory) continue;
    const size = en.header.size;               // dimensiunea DECLARATA dezarhivat
    const packed = en.header.compressedSize || 1;
    if (size > o.maxEntrySize) fail(`Fisierul "${en.entryName}" e prea mare dezarhivat (${Math.round(size / 1048576)} MB).`);
    if (size / packed > o.maxRatio) fail(`Fisierul "${en.entryName}" are un raport de compresie suspect (posibil zip-bomb).`);
    total += size;
    if (total > o.maxTotalSize) fail(`Arhiva depaseste totalul permis dezarhivat (${Math.round(o.maxTotalSize / 1048576)} MB).`);
  }
  return { zip, entries };
}

module.exports = { openGuarded, DEFAULTS };
