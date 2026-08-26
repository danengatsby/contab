'use strict';

// Jurnal de audit DURABIL, append-only, pe disc — proba pentru control intern care
// SUPRAVIETUIESTE rolarii din baza vie (d.audit e plafonat pentru RAM) si unei eventuale
// coruperi/pierderi a bazei. Fiecare eveniment se scrie ca o linie NDJSON intr-un fisier
// lunar (data/audit/audit-YYYY-MM.ndjson), inclus in backupul zilnic offsite.
//
// Proprietati: APPEND-ONLY (nu se rescrie niciodata), lant SHA-256 verificabil intre fisiere,
// fail-closed la scriere/corupere si rotatie lunara (fisiere de dimensiune gestionabila).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const metrics = require('./metrics');

let warned = false;
let tailDir = '';
let tailHash = null;
let tailFingerprint = '';

// Directorul jurnalului: CONTAB_AUDIT_DIR (volum separat, durabil) sau data/audit implicit.
function auditDir() { return process.env.CONTAB_AUDIT_DIR || path.join(db.DATA_DIR, 'audit'); }

/** Calea fisierului lunar pentru un moment dat (implicit acum). */
function fileFor(ts) {
  return path.join(auditDir(), 'audit-' + String(ts || new Date().toISOString()).slice(0, 7) + '.ndjson');
}

function filesAscending(dir) {
  try {
    return fs.readdirSync(dir || auditDir()).filter((n) => /^audit-\d{4}-\d{2}\.ndjson$/.test(n)).sort();
  } catch (_) { return []; }
}

function hashRecord(record) {
  const copy = Object.assign({}, record);
  delete copy.hash;
  return crypto.createHash('sha256').update(JSON.stringify(copy), 'utf8').digest('hex');
}

function filesFingerprint() {
  return filesAscending().map((name) => {
    const s = fs.statSync(path.join(auditDir(), name));
    return name + ':' + s.size + ':' + s.mtimeMs;
  }).join('|');
}

/**
 * Verifica integral toate liniile si lantul. Liniile istorice create inainte de versiunea 1 sunt
 * acceptate numai la inceput; dupa prima linie inlantuita, o linie legacy inseamna ruptura.
 */
function verifyContents(entries) {
  const files = (Array.isArray(entries) ? entries : []).map((entry) => ({
    name: String(entry && entry.name || ''),
    text: Buffer.isBuffer(entry && entry.content) ? entry.content.toString('utf8')
      : String(entry && (entry.text != null ? entry.text : entry.content) || ''),
  })).filter((entry) => /^audit-\d{4}-\d{2}\.ndjson$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set();
  let expected = ''; let chained = 0; let legacy = 0; let chainStarted = false;
  const fileHashes = [];
  for (const file of files) {
    const name = file.name;
    if (names.has(name)) return { ok: false, motiv: name + ' apare de mai multe ori', files: files.length, chained, legacy, fileHashes };
    names.add(name);
    fileHashes.push({ name, sha256: crypto.createHash('sha256').update(file.text, 'utf8').digest('hex') });
    const lines = file.text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].trim()) continue;
      let rec;
      try { rec = JSON.parse(lines[i]); } catch (_) {
        return { ok: false, motiv: name + ':' + (i + 1) + ' nu este JSON valid', files: files.length, chained, legacy, fileHashes };
      }
      const isChained = rec.chainVersion === 1 && typeof rec.hash === 'string' && typeof rec.prevHash === 'string';
      if (!isChained) {
        if (chainStarted) return { ok: false, motiv: name + ':' + (i + 1) + ' rupe lantul de audit', files: files.length, chained, legacy, fileHashes };
        legacy += 1;
        continue;
      }
      chainStarted = true;
      if (rec.prevHash !== expected) return { ok: false, motiv: name + ':' + (i + 1) + ' are prevHash neasteptat', files: files.length, chained, legacy, fileHashes };
      const actual = hashRecord(rec);
      if (rec.hash !== actual) return { ok: false, motiv: name + ':' + (i + 1) + ' are amprenta invalida', files: files.length, chained, legacy, fileHashes };
      expected = rec.hash; chained += 1;
    }
  }
  return { ok: true, files: files.length, chained, legacy, head: expected || null, fileHashes };
}

function verifyDirectory(dir) {
  const target = dir || auditDir();
  const entries = filesAscending(target).map((name) => ({
    name, content: fs.readFileSync(path.join(target, name)),
  }));
  return verifyContents(entries);
}

function verify() {
  return verifyDirectory(auditDir());
}

function ensureTail() {
  const dir = auditDir();
  const fingerprint = filesFingerprint();
  if (tailDir === dir && tailHash !== null && tailFingerprint === fingerprint) return;
  const v = verify();
  if (!v.ok) throw new Error('Jurnalul de audit este corupt: ' + v.motiv);
  tailDir = dir;
  tailHash = v.head || '';
  tailFingerprint = fingerprint;
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
    ensureTail();
    return { ok: true };
  } catch (e) {
    return { ok: false, motiv: String((e && e.message) || e).slice(0, 200) };
  }
}

/** Adauga o inregistrare in lant. La esec arunca: o mutatie neauditabila nu este acceptata. */
function append(record) {
  try {
    const dir = auditDir();
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch (_) { /* best-effort */ }
    ensureTail();
    const file = fileFor(record.ts);
    const chained = Object.assign({}, record, { chainVersion: 1, prevHash: tailHash || '' });
    chained.hash = hashRecord(chained);
    fs.appendFileSync(file, JSON.stringify(chained) + '\n', { mode: 0o600, encoding: 'utf8' });
    try { fs.chmodSync(file, 0o600); } catch (_) { /* best-effort */ }
    tailHash = chained.hash;
    tailFingerprint = filesFingerprint();
    warned = false;
    metrics.auditOk();
    return record;
  } catch (e) {
    metrics.auditFail(e.message);
    if (!warned) { console.error('[audit] scrierea in jurnalul durabil a esuat:', e.message); warned = true; }
    throw e;
  }
}

/** Listeaza fisierele de jurnal existente (pentru export/verificare), cele mai noi primele. */
function listFiles() {
  return filesAscending().reverse();
}

/** Deduplicare crash-safe pentru outbox: daca procesul a cazut dupa append, dar inainte sa
 *  marcheze randul livrat in baza, restartul gaseste ID-ul in WORM si nu dubleaza evenimentul. */
function containsOutboxId(id) {
  const needle = '"outboxId":' + JSON.stringify(String(id || ''));
  for (const name of filesAscending()) {
    try { if (fs.readFileSync(path.join(auditDir(), name), 'utf8').includes(needle)) return true; }
    catch (_) { /* append/probe va raporta separat indisponibilitatea jurnalului */ }
  }
  return false;
}

module.exports = { append, containsOutboxId, listFiles, auditDir, fileFor, probeWritable, verify, verifyDirectory, verifyContents, hashRecord };
