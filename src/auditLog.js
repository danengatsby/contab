'use strict';

// Jurnal de audit DURABIL, append-only, pe disc — proba pentru control intern care
// SUPRAVIETUIESTE rolarii din baza vie (d.audit e plafonat pentru RAM) si unei eventuale
// coruperi/pierderi a bazei. Fiecare eveniment se scrie ca o linie NDJSON intr-un fisier
// lunar (data/audit/audit-YYYY-MM.ndjson), inclus in backupul zilnic offsite.
//
// Proprietati: APPEND-ONLY (nu se rescrie niciodata), best-effort (un esec de scriere NU
// rupe cererea — se logheaza), rotatie lunara (fisiere de dimensiune gestionabila).

const fs = require('fs');
const path = require('path');
const db = require('./db');

let warned = false;

// Directorul jurnalului: CONTAB_AUDIT_DIR (volum separat, durabil) sau data/audit implicit.
function auditDir() { return process.env.CONTAB_AUDIT_DIR || path.join(db.DATA_DIR, 'audit'); }

/** Adauga o inregistrare de audit in fisierul lunar append-only. Best-effort. */
function append(record) {
  try {
    const dir = auditDir();
    fs.mkdirSync(dir, { recursive: true });
    const luna = String(record.ts || new Date().toISOString()).slice(0, 7); // YYYY-MM
    fs.appendFileSync(path.join(dir, 'audit-' + luna + '.ndjson'), JSON.stringify(record) + '\n');
    warned = false;
  } catch (e) {
    // nu bloca cererea; avertizeaza o singura data pana la urmatorul succes
    if (!warned) { console.error('[audit] scrierea in jurnalul durabil a esuat:', e.message); warned = true; }
  }
}

/** Listeaza fisierele de jurnal existente (pentru export/verificare), cele mai noi primele. */
function listFiles() {
  try {
    return fs.readdirSync(auditDir())
      .filter((n) => /^audit-\d{4}-\d{2}\.ndjson$/.test(n))
      .sort().reverse();
  } catch (_) { return []; }
}

module.exports = { append, listFiles, auditDir };
