'use strict';

// DRILL DE RESTAURARE NATIVA PostgreSQL — restaureaza efectiv `contab.sql` (dump-ul pg_dump din
// arhiva zilnica) intr-o baza TEMPORARA si verifica ce a iesit.
//
// De ce, cand exista deja src/restoreDrill.js: acela verifica graful din `db.json` — adica oglinda
// JSON, nu baza de productie. Dump-ul nativ era doar PRODUS si pus in arhiva, niciodata REJUCAT.
// Un dump se poate strica in tacere (pg_dump esuat partial, versiune incompatibila, tabel lipsa
// din cauza unei colectii noi neinregistrate) si nimeni nu afla pana in ziua in care e nevoie de el.
// Aici se raspunde la intrebarea corecta: „daca as restaura ACUM baza de productie din dump, ce as
// obtine?".
//
// Ce verifica, in ordinea increderii:
//   1. dump-ul se REJOACA fara erori (psql -v ON_ERROR_STOP=1) intr-o baza proaspata;
//   2. baza restaurata are TABELELE si RANDURILE asteptate (firme, entries, si toate colectiile);
//   3. graful reconstruit din blob-urile restaurate e COERENT CONTABIL — aceeasi verificare de
//      balanta (Σdebit == Σcredit pe fiecare firma) ca drill-ul pe db.json, prin restoreDrill;
//   4. baza restaurata e ECHIVALENTA cu `db.json` din ACEEASI arhiva (acelasi numar de firme si de
//      articole). Asta prinde divergenta dintre cele doua cai de restaurare — cazul in care una
//      dintre ele e veche sau incompleta, desi fiecare pare valida separat.
//
// Nu atinge NICIODATA baza vie: creeaza o baza noua cu nume unic si o sterge la final, si pe calea
// de eroare. Nu arunca — intoarce { ok, motiv, ... }, ca un job de veghe sa-l poata rula linistit.

const fs = require('fs');
const os = require('os');
const path = require('path');
// execFile, NU spawnSync: drill-ul e declansabil din aplicatie (POST /api/pg-restore-drill,
// admin), iar procesul e unul singur. Cu spawnSync, rejucarea dump-ului — pana la 10 MINUTE —
// bloca bucla de evenimente, adica TOTI utilizatorii asteptau cat verifica adminul un backup.
// `runPgDrill` era deja `async`, dar asincronia era cosmetica: inauntru totul era sincron.
const { execFile } = require('child_process');

const restoreDrill = require('./restoreDrill');

// Colectiile-blob si maparea lor catre cheile grafului. Sursa: store.ARRAY_COLLS (aceeasi lista
// folosita de schema) — nu o dublam aici, ca o colectie noua sa nu ramana neverificata.
function blobCollections() {
  try { return require('./store').ARRAY_COLLS.map((c) => c.key); } catch (_) { return []; }
}

/** `psql` si `pg_dump` exista in PATH? Fara ele drill-ul nu are cum sa ruleze (dump plain-text). */
async function toolAvailable(bin) {
  const r = await run(bin, ['--version'], 15000);
  return r.ok;
}

/** URL-ul bazei de intretinere (`postgres`) + al bazei temporare, derivate din CONTAB_PG_URL. */
function urlsFor(baseUrl, tempName) {
  if (!baseUrl) return null; // fara URL explicit ramanem pe socket local (vezi psqlArgs)
  let u;
  try { u = new URL(baseUrl); } catch (_) { return null; }
  const maint = new URL(baseUrl); maint.pathname = '/postgres';
  const temp = new URL(baseUrl); temp.pathname = '/' + tempName;
  return { maint: maint.toString(), temp: temp.toString() };
}

/** Argumentele de conectare pentru psql: URL explicit sau socket local (autentificare peer). */
function psqlArgs(url, dbname) {
  return url ? ['--dbname=' + url] : ['-d', dbname];
}

// maxBuffer generos: implicitul lui execFile e 1 MB, iar depasirea OMOARA procesul si intoarce
// eroare. Cu `-q` + ON_ERROR_STOP=1 psql scoate aproape nimic pe succes, deci 64 MB e mult peste
// orice caz real; iar daca totusi s-ar depasi, rezultatul e `ok:false` — adica o ALERTA, nu o
// trecere tacuta. Directia sigura pentru un modul a carui treaba e sa nu confunde „n-am putut
// verifica" cu „e bine".
function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs || 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || ''),
        err: String(stderr || (err && err.message) || '').slice(0, 500),
      }));
  });
}

/**
 * Extrage o intrare din arhiva intr-un fisier temporar.
 * @returns { path } | { absent: true } | { eroare: '<motiv>' }
 *
 * Cele trei rezultate TREBUIE separate. Varianta care intorcea `null` pentru toate le confunda:
 * o arhiva ilizibila (sau `adm-zip` care nu se incarca — s-a intamplat, rulare dintr-un checkout
 * fara node_modules) era raportata drept „arhiva nu contine contab.sql", adica „nu se aplica",
 * adica TACERE. Exact eroarea pe care restul modulului o evita cu grija.
 */
function extractEntry(zipPath, entryName, destDir) {
  let zip;
  try {
    const AdmZip = require('adm-zip');
    zip = new AdmZip(zipPath);
  } catch (e) { return { eroare: 'arhiva nu s-a putut deschide: ' + String(e.message || e).slice(0, 200) }; }
  try {
    const e = zip.getEntry(entryName);
    if (!e || !e.header.size) return { absent: true };
    const dest = path.join(destDir, entryName);
    fs.writeFileSync(dest, zip.readFile(e));
    return { path: dest };
  } catch (e) { return { eroare: 'intrarea „' + entryName + '" nu s-a putut extrage: ' + String(e.message || e).slice(0, 200) }; }
}

/** Graful din arhiva (db.json), pentru comparatia de echivalenta. Null daca lipseste. */
function graphFromArchive(zipPath) {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    const je = zip.getEntry('db.json');
    if (!je) return null;
    return JSON.parse(zip.readAsText(je));
  } catch (_) { return null; }
}

/**
 * Reconstruieste graful (forma db.json) din baza restaurata, citind blob-urile.
 * Schema e generica (id + firmaId + data JSONB per colectie), deci reconstructia e directa —
 * aceeasi pe care o face store.hydrate, dar peste o conexiune ad-hoc, fara singletonul de pool.
 */
async function graphFromDb(connString, dbname) {
  const { Client } = require('pg');
  // Fara URL explicit folosim EXACT aceeasi conventie ca storePg.open(): socketul local
  // (/var/run/postgresql, autentificare peer). Altfel `pg` cade pe TCP catre localhost si cere
  // parola — psql reusea prin socket, iar verificarea de dupa el pica cu „client password must
  // be a string", adica drill-ul raporta esec desi restaurarea mersese.
  // Conventia se IMPORTA din storePg, nu se rescrie aici: doua copii ale ei chiar au driftat, iar
  // cea de aici a ramas fara `user` — vezi localPgConfig pentru ce a costat asta sub cron.
  const { localPgConfig } = require('./storePg');
  const client = connString
    ? new Client({ connectionString: connString })
    : new Client(localPgConfig(dbname));
  await client.connect();
  try {
    const d = { firme: [], entries: [], openingBalances: {}, partners: {} };
    const counts = {};
    for (const key of blobCollections()) {
      const t = key.toLowerCase();
      const r = await client.query('SELECT data FROM ' + t);
      const rows = r.rows.map((x) => (typeof x.data === 'string' ? JSON.parse(x.data) : x.data));
      d[key] = rows;
      counts[key] = rows.length;
    }
    // partners / opening_balances au tabele proprii (chei compuse), nu blob per rand
    const ob = await client.query('SELECT "firmaId", cont, d, c FROM opening_balances');
    for (const r of ob.rows) {
      (d.openingBalances[r.firmaId] = d.openingBalances[r.firmaId] || {})[r.cont] = { d: Number(r.d) || 0, c: Number(r.c) || 0 };
    }
    counts.opening_balances = ob.rows.length;
    const pr = await client.query('SELECT "firmaId", cui, data FROM partners');
    for (const r of pr.rows) {
      (d.partners[r.firmaId] = d.partners[r.firmaId] || {})[r.cui] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    }
    counts.partners = pr.rows.length;
    const meta = await client.query('SELECT key, value FROM meta');
    for (const r of meta.rows) {
      try { d[r.key] = JSON.parse(r.value); } catch (_) { d[r.key] = r.value; }
    }
    return { d, counts };
  } finally {
    try { await client.end(); } catch (_) { /* best-effort */ }
  }
}

/**
 * Ruleaza drill-ul nativ pe o arhiva completa.
 * @param opts { zipPath, pgUrl, keepDb } — `keepDb` doar pentru depanare manuala.
 * @returns { ok, sarit?, neverificabil?, motiv?, dbTemp, durataMs, randuri, firme, totalEntries, echivalent }
 *   `sarit`         — nu se aplica (fara arhiva / fara contab.sql): tacere corecta;
 *   `neverificabil` — SE aplica, dar nu putem verifica (psql lipsa, fara drept CREATEDB): se alerteaza;
 *   `ok:false` fara niciunul — dump-ul chiar nu e bun.
 */
async function runPgDrill(opts) {
  const o = opts || {};
  const started = Date.now();
  const zipPath = o.zipPath;
  const pgUrl = o.pgUrl !== undefined ? o.pgUrl : (process.env.CONTAB_PG_URL || '');
  const out = { ok: false, dbTemp: null, durataMs: 0 };

  if (!zipPath || !fs.existsSync(zipPath)) return Object.assign(out, { sarit: true, motiv: 'nicio arhiva de verificat' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contab-pgdrill-'));
  const cleanupDir = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ } };

  // PRIMA intrebare: exista un dump nativ de verificat? Daca NU, drill-ul chiar nu se aplica
  // (instalare pe sqlite) si tacerea e corecta. Daca DA, orice ne impiedica sa-l rejucam devine
  // un rezultat NEGATIV, nu o sarire tacuta — vezi `neverificabil` mai jos.
  const ex = extractEntry(zipPath, 'contab.sql', tmpDir);
  if (ex.eroare) { cleanupDir(); return Object.assign(out, { neverificabil: true, motiv: ex.eroare }); }
  if (ex.absent) { cleanupDir(); return Object.assign(out, { sarit: true, motiv: 'arhiva nu contine contab.sql (dump nativ) — instalarea nu e pe PostgreSQL' }); }
  const sqlPath = ex.path;

  // De aici incolo EXISTA un dump care ar trebui sa fie restaurabil. Daca nu putem verifica —
  // psql lipsa, fara drept de a crea baza temporara — asta NU e „nu se aplica", ci „calea de
  // restaurare nativa ramane NEVERIFICATA". Diferenta conteaza: proiectul a mai fost muscat de
  // monitorizare care tace (raportul care scana un director inghetat, backupul offsite oprit 7
  // zile). O verificare care nu poate rula trebuie sa se auda, altfel seamana leit cu „e bine".
  if (!await toolAvailable('psql')) {
    cleanupDir();
    return Object.assign(out, {
      neverificabil: true,
      motiv: 'arhiva contine contab.sql, dar `psql` nu e in PATH — restaurarea nativa nu poate fi verificata (instaleaza postgresql-client)',
    });
  }

  // Nume unic: procesul + timpul. Prefixul face evidenta provenienta daca vreodata ramane o baza.
  const tempName = 'contab_drill_' + process.pid + '_' + Date.now();
  const urls = urlsFor(pgUrl, tempName);
  const maintArgs = psqlArgs(urls ? urls.maint : '', 'postgres');
  const tempArgs = psqlArgs(urls ? urls.temp : '', tempName);
  out.dbTemp = tempName;

  const dropDb = () => run('psql', maintArgs.concat(['-v', 'ON_ERROR_STOP=1', '-c', 'DROP DATABASE IF EXISTS "' + tempName + '"']), 60000);

  try {
    const created = await run('psql', maintArgs.concat(['-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE "' + tempName + '"']), 60000);
    if (!created.ok) {
      // Cazul REAL intalnit pe productie: rolul aplicatiei nu are dreptul CREATEDB, deci drill-ul
      // n-ar putea rula niciodata. Fara semnalul asta, absenta verificarii ar fi trecut drept
      // verificare trecuta. Remediul e o singura instructiune, deci il scriem in mesaj.
      const faraDrept = /permission denied|must be superuser|nu aveti|denied to create/i.test(created.err);
      return Object.assign(out, {
        neverificabil: true,
        motiv: (faraDrept
          ? 'rolul PostgreSQL al aplicatiei nu poate crea baze temporare, deci restaurarea nativa ramane NEVERIFICATA. '
            + 'Remediu (o data, ca superuser): ALTER ROLE <rol> CREATEDB;'
          : 'nu s-a putut crea baza temporara') + ' — ' + created.err,
      });
    }

    // REJUCAREA dump-ului. ON_ERROR_STOP=1 e esential: fara el psql trece peste instructiunile
    // esuate si iese cu 0, adica un dump stricat ar trece drept restaurat cu succes.
    const restored = await run('psql', tempArgs.concat(['-v', 'ON_ERROR_STOP=1', '-q', '-f', sqlPath]), 10 * 60 * 1000);
    if (!restored.ok) return Object.assign(out, { motiv: 'restaurarea dump-ului a esuat: ' + (restored.err || 'psql a intors eroare') });

    const { d, counts } = await graphFromDb(urls ? urls.temp : '', tempName);
    out.randuri = counts;

    // Coerenta contabila pe datele RESTAURATE (aceeasi verificare ca drill-ul pe db.json).
    const drill = restoreDrill.drillGraph(d);
    out.firme = drill.nrFirme;
    out.totalEntries = drill.totalEntries;
    if (!drill.ok) return Object.assign(out, { motiv: 'baza restaurata nu e coerenta contabil: ' + drill.motiv });

    // Echivalenta cu db.json din ACEEASI arhiva: cele doua cai de restaurare trebuie sa duca la
    // aceleasi date. Daca difera, una dintre ele e invechita sau incompleta — desi fiecare, luata
    // separat, pare valida.
    const jsonGraph = graphFromArchive(zipPath);
    if (jsonGraph) {
      const jsonFirme = (jsonGraph.firme || []).length;
      const jsonEntries = (jsonGraph.entries || []).length;
      out.echivalent = { firme: jsonFirme === drill.nrFirme, entries: jsonEntries === drill.totalEntries, jsonFirme, jsonEntries };
      if (!out.echivalent.firme || !out.echivalent.entries) {
        return Object.assign(out, {
          motiv: 'dump-ul nativ si db.json din aceeasi arhiva difera: SQL are ' + drill.nrFirme + ' firme / '
            + drill.totalEntries + ' articole, JSON are ' + jsonFirme + ' / ' + jsonEntries,
        });
      }
    }
    out.ok = true;
    return out;
  } catch (e) {
    return Object.assign(out, { motiv: 'drill esuat: ' + String(e.message || e).slice(0, 300) });
  } finally {
    out.durataMs = Date.now() - started;
    // AWAIT obligatoriu de cand `run` e asincron: nedasteptat, drill-ul s-ar intoarce inaintea
    // stergerii, iar in scriptul de cron procesul ar putea iesi lasand baza temporara in urma —
    // exact ce garanta forma sincrona. `finally` asteapta promisiunea returnata dintr-un async.
    if (!o.keepDb) await dropDb(); // si pe calea de eroare: nu lasam baze temporare in urma
    cleanupDir();
  }
}

module.exports = { runPgDrill, graphFromDb, urlsFor, toolAvailable, blobCollections };
