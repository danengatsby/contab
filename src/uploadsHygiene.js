'use strict';

// Igiena directorului de uploads:
//  - sweepStaging(): sterge directoarele de STAGING (.import-*) ramase dupa un crash in
//    timpul unui import de firma (fluxul normal le sterge singur; astea sunt gunoi cert);
//  - orphanReport(): NUMARA fisierele nereferentiate de nimic (documente, logo-uri de
//    firma, atasamente de mesaje). Doar raport — stergerea automata ar fi riscanta
//    (o referinta noua ar putea scapa numaratorii); decizia ramane la operator.

const fs = require('fs');
const path = require('path');

/** Sterge .import-* mai vechi de maxAgeMs. Intoarce cate a sters. */
function sweepStaging(uploadDir, maxAgeMs) {
  const maxAge = maxAgeMs || 24 * 3600 * 1000;
  let sterse = 0;
  let nume;
  try { nume = fs.readdirSync(uploadDir); } catch (_) { return 0; }
  for (const n of nume) {
    if (!n.startsWith('.import-')) continue;
    const p = path.join(uploadDir, n);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > maxAge) {
        fs.rmSync(p, { recursive: true, force: true });
        sterse += 1;
      }
    } catch (_) { /* disparut intre timp */ }
  }
  return sterse;
}

/** Fisierele din uploads nereferentiate de graful d. Intoarce { total, orfane }. */
function orphanReport(d, uploadDir) {
  const ref = new Set();
  for (const doc of d.documents || []) if (doc.storedName) ref.add(path.basename(doc.storedName));
  for (const f of d.firme || []) if (f.logoFile) ref.add(path.basename(f.logoFile));
  for (const m of d.messages || []) {
    if (m.attachment && m.attachment.storedName) ref.add(path.basename(m.attachment.storedName));
  }
  let total = 0; let orfane = 0;
  let nume;
  try { nume = fs.readdirSync(uploadDir); } catch (_) { return { total: 0, orfane: 0 }; }
  for (const n of nume) {
    if (n.startsWith('.')) continue; // staging-ul e treaba sweepStaging
    total += 1;
    if (!ref.has(n)) orfane += 1;
  }
  return { total, orfane };
}

module.exports = { sweepStaging, orphanReport };
