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
const metrics = require('./metrics');

let warned = false;

// Directorul jurnalului: CONTAB_AUDIT_DIR (volum separat, durabil) sau data/audit implicit.
function auditDir() { return process.env.CONTAB_AUDIT_DIR || path.join(db.DATA_DIR, 'audit'); }

/** Calea fisierului lunar pentru un moment dat (implicit acum). */
function fileFor(ts) {
  return path.join(auditDir(), 'audit-' + String(ts || new Date().toISOString()).slice(0, 7) + '.ndjson');
}

/**
 * Sonda PROACTIVA: se mai poate scrie in jurnal? Raspunde INAINTE sa avem un eveniment de
 * consemnat, deci o permisiune stricata se vede la urmatoarea verificare, nu la urmatoarea
 * actiune auditabila (care oricum n-ar rupe cererea — append e best-effort).
 *
 * Verifica FISIERUL lunii curente cand exista, nu doar directorul: esecul real intalnit pe
 * aceasta instalare a fost EACCES pe `open` al fisierului, cu directorul perfect scriibil
 * (fisier ramas de la un proces rulat sub alt utilizator). O sonda pe director l-ar fi ratat.
 * @returns { ok: true } | { ok: false, motiv }
 */
function probeWritable() {
  try {
    const dir = auditDir();
    fs.mkdirSync(dir, { recursive: true });
    const f = fileFor();
    if (fs.existsSync(f)) fs.accessSync(f, fs.constants.W_OK);
    else fs.accessSync(dir, fs.constants.W_OK);
    return { ok: true };
  } catch (e) {
    return { ok: false, motiv: String((e && e.message) || e).slice(0, 200) };
  }
}

/** Adauga o inregistrare de audit in fisierul lunar append-only. Best-effort. */
function append(record) {
  try {
    const dir = auditDir();
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch (_) { /* best-effort */ }
    const file = fileFor(record.ts);
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (_) { /* best-effort */ }
    warned = false;
    metrics.auditOk();
  } catch (e) {
    // Cererea NU se rupe (best-effort, deliberat), iar consola primeste o singura avertizare
    // pana la urmatorul succes — altfel logul s-ar inunda. Dar CONTORUL creste de fiecare data:
    // throttle-ul e pentru zgomot, nu pentru a ascunde faptul. Fara el, o permisiune stricata
    // dadea o linie in log si apoi tacere la nesfarsit, in timp ce proba de audit nu se mai
    // scria — vezi jobul audit-watch, care de aici isi ia semnalul.
    metrics.auditFail(e.message);
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

module.exports = { append, listFiles, auditDir, fileFor, probeWritable };
