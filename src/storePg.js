'use strict';

// Strat relational PostgreSQL (pg, async). Acelasi layout ca src/store.js (SQLite):
const { stringifyDb, stringifyRow } = require('./util');
const plan = require('./persistPlan');
// tabele reale per-colectie cu coloane id/"firmaId" indexate + coloana `data` JSONB
// pentru restul campurilor. Aplicatia lucreaza tot pe graful in memorie: `hydrate()`
// il construieste din tabele, `persist(db)` il scrie inapoi.
//
// Deosebirea fata de SQLite: clientul pg e asincron, dar save()-ul aplicatiei e sincron.
// persist() FOTOGRAFIAZA sincron colectiile murdare (serializare + amprenta) si pune
// aplicarea SQL intr-o COADA seriala (o singura tranzactie in zbor la un moment dat,
// in ordinea apelurilor). La esec, amprentele raman neschimbate -> urmatorul save()
// reincearca aceleasi colectii. flush() asteapta golirea cozii SI respinge promisiunea
// daca ultima stare fotografiata nu a ajuns durabil in baza (folosit de bariera HTTP).
//
// Conexiunea: CONTAB_PG_URL (connection string) sau, implicit, socketul local
// /var/run/postgresql cu autentificare peer (rolul = utilizatorul OS) si baza
// PGDATABASE || 'contab'.

const crypto = require('crypto');
const os = require('os');
const { Pool } = require('pg');
const { ARRAY_COLLS, PROJECTIONS } = require('./store'); // sursa unica a listei de colectii + registrul de proiectii (identice cu SQLite)

let pool = null;
let queue = Promise.resolve(); // coada seriala de tranzactii persist
let pendingWork = null;        // un singur `work` asteapta intrarea in tranzactie (vezi persist)
let draining = false;          // santinela: o singura bucla de golire activa
// OBSERVABILITATEA COZII. Dupa colapsare (vezi persist) coada nu mai poate CRESTE — deci
// „adancimea" nu mai e semnalul util. Ce ramane periculos e VECHIMEA: cat timp `pendingWork`
// asteapta necomis, scrierile traiesc doar in RAM (nedurabile) si tin in viata un snapshot al
// colectiilor schimbate. O coada care nu se goleste inseamna baza lenta, cazuta sau blocata —
// exact situatia in care procesul creste spre plafonul pm2 fara ca nimeni sa observe.
let pendingSince = 0;   // ms epoch de cand asteapta lucrarea curenta (0 = nimic in asteptare)
let pendingBytes = 0;   // marimea aproximativa a lucrarii retinute in RAM
let commits = 0;        // tranzactii comise cu succes
let failStreak = 0;     // esecuri consecutive de persist (se reseteaza la primul commit reusit)
let lastPersistError = null;   // { msg, at } — ultimul esec de scriere
let lastCommitAt = null;       // ISO — ultima scriere ajunsa efectiv in baza
// Dirty-tracking, ca in store.js (SQLite): colectiile cu `id` primesc INSERT/UPDATE/DELETE per rand
// (diff fata de `snap`), nu DELETE+INSERT integral. `snap[colectie]` = Map(id -> json persistat la
// ultimul commit reusit. Restul (colectii fara id, partners/opening/meta) raman pe rescriere completa
// portita de amprenta (`lastHash`). Starea se actualizeaza DOAR dupa commit -> esec = retry idempotent.
let snap = {};     // { [colectie hasId]: Map(id -> json) }
let lastHash = {}; // amprenta pt colectiile rescrise integral
let lastWritten = [];
// FENCING multi-scriitor (paritate cu store.js): `dbEpoch` (meta) verificat si avansat in aceeasi
// tranzactie cu datele. Alt scriitor detectat -> persistenta INGHETATA (fail-loud, nu clobber).
let epoch = 0;
let planStare = plan.stareNoua();
let conflictedFlag = false;
// In modul HA, dbEpoch ramane o plasa contra scriitorilor necoordonati, iar acest provider adauga
// fencing-ul distribuit: fiecare tranzactie trebuie sa dovedeasca holder-ul si GENERATIA lease-ului
// curent. Providerul nu este importat din haCoordinator (ar crea un ciclu); db.js il injecteaza.
let haFenceProvider = null;
let haFenceRejected = null;
// Coada `queue` ramane deliberat rezolvata chiar dupa un esec: save() este apelat sincron in
// multe locuri (inclusiv joburi fara raspuns HTTP), iar o promisiune respinsa si ignorata ar
// produce unhandledRejection. Eroarea durabilitatii se pastreaza separat si este expusa NUMAI
// prin flush(), unde apelantul o poate trata explicit (bariera HTTP, backup, oprire, teste).
let flushError = null;

function sha(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function asInt(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function firmaOf(c, item) { return c.firma && item && item.firmaId != null ? asInt(item.firmaId) : null; }

/**
 * Configuratia de conectare LOCALA (socket, autentificare peer). Rolul se pune EXPLICIT, nu se
 * lasa pe seama bibliotecii: `pg` il deduce din `process.env.USER`, iar cron ruleaza cu un mediu
 * minimal, FARA USER — acolo pachetul de start pleaca fara nume de rol si serverul raspunde
 * „no PostgreSQL user name specified in startup packet". `psql` (libpq) nu are problema, fiindca
 * citeste passwd-ul; deci defectul apare DOAR pe calea node si DOAR sub cron, adica orice proba
 * manuala il rateaza. Exact asa a picat tacut drill-ul de restaurare nativa (2026-07-28): psql
 * rejuca dump-ul cu succes, iar verificarea de dupa el nu se mai putea conecta.
 * `os.userInfo()` citeste passwd-ul, deci nu depinde de mediu.
 */
function localPgConfig(dbname) {
  return {
    host: process.env.PGHOST || '/var/run/postgresql',
    database: dbname || process.env.PGDATABASE || 'contab',
    user: process.env.PGUSER || process.env.USER || os.userInfo().username,
  };
}

async function open() {
  if (pool) return pool;
  pool = new Pool(
    process.env.CONTAB_PG_URL
      ? { connectionString: process.env.CONTAB_PG_URL }
      : localPgConfig()
  );
  pool.on('error', (e) => console.error('[contab] pg pool:', e.message));
  await schema();
  return pool;
}

async function schema() {
  for (const c of ARRAY_COLLS) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${c.key.toLowerCase()} (
      rowid BIGSERIAL PRIMARY KEY,
      id TEXT,
      "firmaId" INTEGER,
      data JSONB NOT NULL
    )`);
    if (c.firma) await pool.query(`CREATE INDEX IF NOT EXISTS idx_${c.key.toLowerCase()}_firma ON ${c.key.toLowerCase()}("firmaId")`);
    if (c.hasId) await pool.query(`CREATE INDEX IF NOT EXISTS idx_${c.key.toLowerCase()}_id ON ${c.key.toLowerCase()}(id)`);
  }
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_declarations_dossier_unique
    ON declarations("firmaId", lower(data ->> 'tip'), (data ->> 'period'))
    WHERE data ->> 'tip' IS NOT NULL AND data ->> 'period' IS NOT NULL`);
  await pool.query(`CREATE TABLE IF NOT EXISTS partners (
    "firmaId" INTEGER NOT NULL, cui TEXT NOT NULL, data JSONB NOT NULL,
    PRIMARY KEY ("firmaId", cui)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS opening_balances (
    "firmaId" INTEGER NOT NULL, cont TEXT NOT NULL, d DOUBLE PRECISION DEFAULT 0, c DOUBLE PRECISION DEFAULT 0,
    PRIMARY KEY ("firmaId", cont)
  )`);
  await pool.query('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value JSONB)');
  // proiectie normalizata a liniilor (interogabila in SQL); derivata din blob-ul entries
  await pool.query(`CREATE TABLE IF NOT EXISTS entry_lines (
    rowid BIGSERIAL PRIMARY KEY,
    entry_id TEXT NOT NULL, "firmaId" INTEGER, period TEXT, status TEXT, seq INTEGER,
    data TEXT, document TEXT, partener TEXT, "tipNume" TEXT,
    debit TEXT, credit TEXT, suma DOUBLE PRECISION DEFAULT 0, explicatie TEXT
  )`);
  // migrare aditiva pt tabelele entry_lines create inainte de coloanele data/document/partener/tipNume
  await pool.query('ALTER TABLE entry_lines ADD COLUMN IF NOT EXISTS data TEXT');
  await pool.query('ALTER TABLE entry_lines ADD COLUMN IF NOT EXISTS document TEXT');
  await pool.query('ALTER TABLE entry_lines ADD COLUMN IF NOT EXISTS partener TEXT');
  await pool.query('ALTER TABLE entry_lines ADD COLUMN IF NOT EXISTS "tipNume" TEXT');
  // BACKFILL (conditionat pe date, fara marker): randurile proiectate inainte de coloanele noi au
  // NULL in `data`/`tipNume` (proiectia noua scrie mereu tipNume >= '') -> reproiecteaza integral.
  const hasNull = await pool.query('SELECT 1 FROM entry_lines WHERE data IS NULL OR "tipNume" IS NULL LIMIT 1');
  if (hasNull.rows.length) {
    const p = PROJECTIONS.find((x) => x.coll === 'entries');
    const rows = [];
    for (const r of (await pool.query('SELECT id, "firmaId", data FROM entries')).rows) {
      for (const lr of p.rows(r.id, r.firmaId, r.data)) rows.push(lr);
    }
    const insertCols = p.cols.map((c) => (/[A-Z]/.test(c) ? '"' + c + '"' : c)).join(', ');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM entry_lines');
      if (rows.length) {
        await client.query(
          `INSERT INTO entry_lines (${insertCols}) SELECT ${p.pgSelect} FROM jsonb_to_recordset($1::jsonb) AS x(${p.pgRecordset})`,
          [stringifyRow(rows)]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignora */ }
      throw e;
    } finally { client.release(); }
  }
  await pool.query('CREATE INDEX IF NOT EXISTS idx_entry_lines_entry ON entry_lines(entry_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_entry_lines_firma ON entry_lines("firmaId", period)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_entry_lines_debit ON entry_lines("firmaId", debit)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_entry_lines_credit ON entry_lines("firmaId", credit)');
  // proiectie normalizata a documentelor (metadate interogabile + text pentru cautare SQL)
  await pool.query(`CREATE TABLE IF NOT EXISTS documents_meta (
    doc_id TEXT PRIMARY KEY, "firmaId" INTEGER, "fileName" TEXT, "uploadedAt" TEXT, "spvMsgId" TEXT,
    "textLen" INTEGER DEFAULT 0, text TEXT
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_documents_meta_firma ON documents_meta("firmaId", "uploadedAt")');
  // proiectie audit APPEND-ONLY, durabila (decuplata de plafonul RAM); PK pe audit_id (dedup)
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (
    audit_id TEXT PRIMARY KEY, "firmaId" INTEGER, ts TEXT, "userId" TEXT, username TEXT,
    action TEXT, detail TEXT, "viaAdmin" TEXT
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_log_firma ON audit_log("firmaId", ts)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)');
}

/** Baza e proaspata (fara date persistate)? */
async function isEmpty() {
  const r = await pool.query('SELECT COUNT(*) AS n FROM meta');
  return !r.rows[0] || Number(r.rows[0].n) === 0;
}

/** Reseteaza starea persistata -> urmatorul persist rescrie tot (dupa hydrate/restore). */
function resetDirty() { snap = {}; lastHash = {}; pendingWork = null; flushError = null; planStare = plan.stareNoua(); }

/** Aplica un set de colectii fotografiate, intr-o singura tranzactie. */
async function applyWork(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (haFenceProvider) {
      const fence = haFenceProvider();
      if (!fence) {
        const e = new Error('Scriere HA refuzata: procesul nu detine un lease de lider pregatit.');
        e.code = 'CONTAB_HA_FENCE_REJECTED';
        throw e;
      }
      // FOR UPDATE tine randul pana la COMMIT/ROLLBACK. O promovare concurenta nu poate schimba
      // generatia la jumatatea tranzactiei; fie scrierea vechiului lider comite prima, fie noul
      // lider obtine lease-ul si tokenul vechi este respins.
      const fr = await client.query(
        `SELECT 1 FROM contab_ha_leases
          WHERE name = $1 AND holder_id = $2 AND generation = $3
            AND lease_until > clock_timestamp()
          FOR UPDATE`,
        [fence.name, fence.holderId, fence.generation]
      );
      if (!fr.rows.length) {
        const e = new Error('Scriere HA refuzata: lease expirat, schimbat sau detinut de alta instanta.');
        e.code = 'CONTAB_HA_FENCE_REJECTED';
        throw e;
      }
    }
    // FENCING: verifica si avanseaza dbEpoch in aceeasi tranzactie cu datele. Coada e seriala,
    // deci `epoch` la momentul executiei reflecta toate commit-urile anterioare ale procesului.
    const er = await client.query("SELECT value FROM meta WHERE key = 'dbEpoch'");
    const curEpoch = er.rows.length ? Number(er.rows[0].value) : 0;
    if (curEpoch !== epoch) {
      const e = new Error('Conflict de scriitor: dbEpoch in baza este ' + curEpoch + ', procesul curent are ' + epoch + ' — alt proces a scris intre timp.');
      e.code = 'CONTAB_WRITER_CONFLICT';
      throw e;
    }
    await client.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['dbEpoch', stringifyDb(epoch + 1)]);
    for (const w of work) {
      if (w.kind === 'incr') {
        // diff per rand: sterge randurile schimbate/scoase, apoi (re)insereaza cele curente.
        // delete-then-insert = idempotent (sigur si daca un persist concurent a rescris deja randul).
        const t = w.c.key.toLowerCase();
        const upserts = w.inserts.concat(w.updates);
        const delIds = upserts.map((r) => r.id).concat(w.deletes);
        if (delIds.length) await client.query(`DELETE FROM ${t} WHERE id = ANY($1::text[])`, [delIds]);
        if (upserts.length) {
          await client.query(
            `INSERT INTO ${t} (id, "firmaId", data)
             SELECT x.id, x."firmaId", x.data FROM jsonb_to_recordset($1::jsonb) AS x(id TEXT, "firmaId" INTEGER, data JSONB)`,
            [stringifyDb(upserts)]
          );
        }
        for (const p of PROJECTIONS) if (p.coll === w.c.key) await projectInto(client, p, w);
      } else if (w.kind === 'array') {
        const t = w.c.key.toLowerCase();
        await client.query(`DELETE FROM ${t}`);
        if (w.items.length) {
          // un singur INSERT per colectie, din snapshotul JSON (rowid pastreaza ordinea)
          await client.query(
            `INSERT INTO ${t} (id, "firmaId", data)
             SELECT x.id, x."firmaId", x.data FROM jsonb_to_recordset($1::jsonb) AS x(id TEXT, "firmaId" INTEGER, data JSONB)`,
            [w.json]
          );
        }
        for (const p of PROJECTIONS) if (p.coll === w.c.key) await projectInto(client, p, w);
      } else if (w.kind === 'partners') {
        await client.query('DELETE FROM partners');
        await client.query(
          `INSERT INTO partners ("firmaId", cui, data)
           SELECT x."firmaId", x.cui, x.data FROM jsonb_to_recordset($1::jsonb) AS x("firmaId" INTEGER, cui TEXT, data JSONB)`,
          [w.json]
        );
      } else if (w.kind === 'opening') {
        await client.query('DELETE FROM opening_balances');
        await client.query(
          `INSERT INTO opening_balances ("firmaId", cont, d, c)
           SELECT x."firmaId", x.cont, x.d, x.c FROM jsonb_to_recordset($1::jsonb) AS x("firmaId" INTEGER, cont TEXT, d DOUBLE PRECISION, c DOUBLE PRECISION)`,
          [w.json]
        );
      } else if (w.kind === 'meta') {
        for (const [k, v] of w.entries) {
          await client.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
        }
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignora */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Fotografiaza sincron colectiile schimbate de la ultimul persist si pune scrierea
 * in coada seriala. Intoarce promisiunea cozii (rutele sincrone o ignora; flush() o asteapta).
 */
function persist(db, opts) {
  // Indiciul de colectie (vezi src/persistPlan.js). Pe pg exista o conditie IN PLUS fata de sqlite:
  // daca o lucrare asteapta deja in coada, diff-ul e OBLIGATORIU complet. Colapsarea de mai jos
  // inlocuieste lucrarea in asteptare cu cea noua, si e sigura doar fiindca fiecare `work` e diff
  // fata de ACELASI `snap`, deci il contine integral pe cel inlocuit. Un diff PARTIAL nu-l contine —
  // ar amana schimbarile in asteptare pana la urmatorul diff complet. Deci: nu colapsam partial
  // peste complet, ci ridicam persistul la complet.
  const only = plan.colectiiDeDiffuit(opts && opts.only, plan.stareCu(planStare, pendingWork != null));
  const work = [];
  for (const c of ARRAY_COLLS) {
    if (only && !only.has(c.key)) continue; // sarita: snapshot-ul ei ramane neatins (vezi persistPlan)
    const arr = Array.isArray(db[c.key]) ? db[c.key] : [];

    // Colectiile cu `id`: diff incremental per rand fata de snapshot-ul persistat.
    if (c.hasId) {
      const cur = new Map();      // id -> json (pt. diff + snapshot)
      const rowById = new Map();  // id -> { id, firmaId, data } (pt. INSERT)
      let bad = false;
      for (const item of arr) {
        const key = item && item.id != null ? String(item.id) : null;
        if (key == null || cur.has(key)) { bad = true; break; } // id lipsa/duplicat -> rescriere completa
        cur.set(key, stringifyRow(item));
        rowById.set(key, { id: key, firmaId: firmaOf(c, item), data: item });
      }
      const prev = snap[c.key];
      if (!bad && prev !== undefined) {
        const inserts = []; const updates = []; const deletes = [];
        for (const [id, json] of cur) {
          const before = prev.get(id);
          if (before === undefined) inserts.push(rowById.get(id));
          else if (before !== json) updates.push(rowById.get(id));
        }
        for (const id of prev.keys()) if (!cur.has(id)) deletes.push(id);
        if (inserts.length || updates.length || deletes.length) work.push({ kind: 'incr', c, inserts, updates, deletes, cur, snapKey: c.key, name: c.key.toLowerCase() });
        continue;
      }
      if (!bad && prev === undefined && cur.size === 0) { snap[c.key] = cur; continue; } // colectie goala: fixeaza snapshot
      // fallback: fara snapshot (init) SAU id-uri stricate -> rescriere completa + (re)initializare snapshot
      const rows = arr.map((item) => ({ id: item && item.id != null ? String(item.id) : null, firmaId: firmaOf(c, item), data: item }));
      work.push({ kind: 'array', c, items: rows, json: stringifyRow(rows), cur, snapKey: c.key, name: c.key.toLowerCase() });
      continue;
    }

    // Colectii fara `id` (openingAnalytic, customAccounts): rescriere completa portita de amprenta.
    const rows = arr.map((item) => ({ id: null, firmaId: firmaOf(c, item), data: item }));
    const json = stringifyRow(rows);
    const h = sha(json);
    if (lastHash['a:' + c.key] !== h) work.push({ kind: 'array', c, items: rows, json, h, hk: 'a:' + c.key, name: c.key.toLowerCase() });
  }
  {
    const rows = [];
    for (const fid of Object.keys(db.partners || {})) {
      const byCui = db.partners[fid] || {};
      for (const cui of Object.keys(byCui)) rows.push({ firmaId: asInt(fid), cui: String(cui), data: byCui[cui] });
    }
    const json = stringifyRow(rows);
    const h = sha(stringifyDb(db.partners || {}));
    if (lastHash.partners !== h) work.push({ kind: 'partners', json, h, hk: 'partners', name: 'partners' });
  }
  {
    const rows = [];
    for (const fid of Object.keys(db.openingBalances || {})) {
      const byCont = db.openingBalances[fid] || {};
      for (const cont of Object.keys(byCont)) {
        const v = byCont[cont] || {};
        rows.push({ firmaId: asInt(fid), cont: String(cont), d: Number(v.d) || 0, c: Number(v.c) || 0 });
      }
    }
    const json = stringifyRow(rows);
    const h = sha(stringifyDb(db.openingBalances || {}));
    if (lastHash.opening !== h) work.push({ kind: 'opening', json, h, hk: 'opening', name: 'opening_balances' });
  }
  {
    const h = sha(stringifyDb({ s: db.settings || {}, f: db.firmaActiva, q: db.seq, v: db.schemaVersion != null ? db.schemaVersion : 0 }));
    if (lastHash.meta !== h) {
      work.push({
        kind: 'meta', h, hk: 'meta', name: 'meta',
        entries: [
          ['settings', stringifyDb(db.settings || {})],
          ['firmaActiva', stringifyDb(db.firmaActiva != null ? db.firmaActiva : 1)],
          ['seq', stringifyDb(db.seq != null ? db.seq : 1)],
          ['schemaVersion', stringifyDb(db.schemaVersion != null ? db.schemaVersion : 0)],
        ],
      });
    }
  }

  if (!work.length) { lastWritten = []; plan.noteazaDiff(planStare, only); return queue; } // nimic schimbat -> nicio tranzactie

  // Fail-fast pe standby: nu pastra in coada o fotografie a unui graf pe care promovarea il va
  // inlocui oricum prin rehidratare. Middleware-ul opreste rutele, iar aceasta este plasa pentru
  // joburi/cod intern care ar incerca accidental sa scrie fara rolul de lider.
  if (haFenceProvider && !haFenceProvider()) {
    const e = new Error('Scriere HA refuzata: instanta nu este lider.');
    e.code = 'CONTAB_HA_NOT_LEADER';
    throw e;
  }

  // Inghetat dupa un conflict de scriitor: RAM-ul nostru e invechit — reincercarea ar suprascrie
  // datele celuilalt proces. Refuza zgomotos (o data pe apel), pana la restart + rehidratare.
  if (conflictedFlag) {
    lastWritten = [];
    console.error('[contab] persist REFUZAT: conflict de scriitor detectat anterior (dbEpoch). Reporneste procesul.');
    return queue;
  }

  // COLAPSARE: un singur `work` poate astepta intrarea in tranzactie; unul nou il INLOCUIESTE.
  // E sigur fiindca `work` nu e un delta incremental, ci diff-ul fata de `snap` — iar `snap` se
  // actualizeaza DOAR dupa commit. Cat timp nimic nu s-a comis, fiecare `work` nou e calculat fata
  // de ACELASI `snap`, deci il contine integral pe cel pe care il inlocuieste.
  //
  // De ce conteaza: fara colapsare, fiecare save() adauga in coada un snapshot COMPLET al
  // colectiilor (`cur` = Map cu JSON-ul fiecarui rand). Sub scrieri mai rapide decat comite baza,
  // snapshot-urile se acumulau si duceau procesul in OOM — masurat: 800 de scrieri in 3s au dus
  // memoria de la 136 la 475 MB, in timp ce aceleasi scrieri cu 25ms pauza au ramas la 151 MB.
  // Vezi docs/scalare-crestere.md. SQLite (store.js) nu are problema: persista sincron.
  pendingWork = work;
  plan.noteazaDiff(planStare, only);
  if (!pendingSince) pendingSince = Date.now(); // vechimea se masoara de la PRIMA lucrare neconsumata
  pendingBytes = approxBytes(work);
  if (!draining) { draining = true; queue = queue.then(drain); }
  return queue;
}

// Goleste `pendingWork` pana nu mai are ce; ruleaza o singura data (santinela `draining`), pe coada
// seriala, deci tranzactiile raman una dupa alta.
async function drain() {
  try {
    while (pendingWork) {
      const work = pendingWork;
      pendingWork = null;
      try {
        await applyWork(work);
        epoch += 1; // versiunea avansata odata cu commit-ul
        commits += 1; failStreak = 0; flushError = null; lastCommitAt = new Date().toISOString();
        if (!pendingWork) { pendingSince = 0; pendingBytes = 0; } // coada golita
        else pendingSince = Date.now();                            // a intrat deja alta lucrare
        // starea persistata se actualizeaza DOAR dupa commit reusit (esec -> retry idempotent la urmatorul save)
        for (const w of work) {
          if (w.snapKey) snap[w.snapKey] = w.cur;   // colectii cu id: snapshot per rand
          else if (w.hk) lastHash[w.hk] = w.h;       // colectii fara id + partners/opening/meta
        }
        lastWritten = work.map((w) => w.name);
      } catch (e) {
        if (e && (e.code === 'CONTAB_WRITER_CONFLICT' || e.code === 'CONTAB_HA_FENCE_REJECTED')) {
          conflictedFlag = true; // ingheata scrierile viitoare (nu retry — ar suprascrie alt proces)
          flushError = e;
          failStreak += 1;
          lastPersistError = { msg: String(e.message || e).slice(0, 300), at: new Date().toISOString() };
          console.error('[contab] CONFLICT/FENCE DE SCRIITOR (pg): ' + e.message + ' Persistenta e inghetata pana la rehidratare.');
          pendingWork = null; // nu mai incerca nimic din coada
          if (e.code === 'CONTAB_HA_FENCE_REJECTED' && haFenceRejected) {
            try { Promise.resolve(haFenceRejected(e)).catch(() => {}); } catch (_) { /* nu rupe drain */ }
          }
          return;
        }
        // `snap` a ramas neatins, deci urmatorul save recalculeaza diff-ul si reincearca
        failStreak += 1;
        flushError = e;
        lastPersistError = { msg: String(e.message || e).slice(0, 300), at: new Date().toISOString() };
        console.error('[contab] persist PostgreSQL ESUAT (se reincearca la urmatorul save):', e.message);
      }
    }
  } finally {
    draining = false; // si pe calea de eroare, altfel persistenta ar ramane blocata definitiv
  }
}

/** Marimea aproximativa (octeti) a unei lucrari retinute in coada — cat RAM tine ocupat. */
function approxBytes(work) {
  let n = 0;
  for (const w of work || []) {
    if (w.json) n += w.json.length;
    if (w.cur) for (const v of w.cur.values()) n += v.length;
    if (Array.isArray(w.entries)) for (const [, v] of w.entries) n += String(v).length;
  }
  return n;
}

/**
 * Starea cozii de persistenta — pentru /api/metrics si pentru jobul de veghe.
 * `pendingAgeMs` > 0 inseamna scrieri care NU au ajuns inca in baza (traiesc doar in RAM).
 */
function queueStats() {
  return {
    driver: 'pg',
    // Dupa ROLLBACK, pendingWork a fost consumat de bucla, dar fotografia RAM ramane nedurabila
    // (snap nu s-a avansat) si flushError o tine rosie pana la un commit ulterior. Raportata ca
    // „pending: false”, veghea spunea in mod fals „la zi” exact dupa o pierdere de persistenta.
    pending: !!pendingWork || !!flushError,
    pendingAgeMs: pendingSince ? Date.now() - pendingSince : 0,
    pendingBytes,
    draining,
    commits,
    failStreak,
    lastCommitAt,
    lastError: lastPersistError,
    conflicted: conflictedFlag,
  };
}

/** A fost detectat alt scriitor (persistenta inghetata)? Diagnostic pentru metrici/teste. */
function conflicted() { return conflictedFlag; }

/** Sincronizeaza o proiectie (din PROJECTIONS) pentru work-ul colectiei sursa (in aceeasi tranzactie). */
async function projectInto(client, p, w) {
  const rows = [];
  const insertCols = p.cols.map((c) => (/[A-Z]/.test(c) ? '"' + c + '"' : c)).join(', '); // "firmaId","fileName"... citate
  if (p.append) {
    // APPEND-ONLY (audit): insereaza doar randuri noi (ON CONFLICT DO NOTHING), nu sterge niciodata.
    const src = w.kind === 'incr' ? w.inserts.concat(w.updates) : w.items; // deletes (plafonate) IGNORATE
    for (const r of src) for (const pr of p.rows(r.id, r.firmaId, r.data)) rows.push(pr);
    if (rows.length) {
      await client.query(
        `INSERT INTO ${p.table} (${insertCols}) SELECT ${p.pgSelect} FROM jsonb_to_recordset($1::jsonb) AS x(${p.pgRecordset}) ON CONFLICT (${p.idCol}) DO NOTHING`,
        [stringifyRow(rows)]
      );
    }
    return;
  }
  // OGLINDA (entries/documents): reflecta exact starea din RAM.
  if (w.kind === 'incr') {
    const upserts = w.inserts.concat(w.updates); // [{id, firmaId, data}]
    const ids = upserts.map((r) => r.id).concat(w.deletes);
    for (const r of upserts) for (const pr of p.rows(r.id, r.firmaId, r.data)) rows.push(pr);
    if (ids.length) await client.query(`DELETE FROM ${p.table} WHERE ${p.idCol} = ANY($1::text[])`, [ids]);
  } else { // 'array' = rescriere completa a colectiei sursa
    await client.query(`DELETE FROM ${p.table}`);
    for (const r of w.items) for (const pr of p.rows(r.id, r.firmaId, r.data)) rows.push(pr);
  }
  if (rows.length) {
    await client.query(
      `INSERT INTO ${p.table} (${insertCols}) SELECT ${p.pgSelect} FROM jsonb_to_recordset($1::jsonb) AS x(${p.pgRecordset})`,
      [stringifyRow(rows)]
    );
  }
}

/** Rulajul pe conturi calculat DIRECT in SQL din entry_lines (doar articole postate), pentru o firma
 *  si optional o perioada (YYYY sau YYYY-MM). Intoarce { cont: { d, c } } — aceeasi forma ca
 *  accounting.accumulate. Demonstreaza calcul analitic fara a incarca graful in RAM. */
async function linesTurnover(firmaId, period, opts) {
  const acc = {};
  const bump = (cont, side, s) => { if (cont == null) return; acc[cont] = acc[cont] || { d: 0, c: 0 }; acc[cont][side] += s; };
  const params = [asInt(firmaId), 'postat'];
  let where = '"firmaId" = $1 AND (status IS NULL OR status = $2)';
  if (opts && opts.before) { if (period) { params.push(period); where += ' AND period < $3'; } } // rulaj INAINTE de perioada
  else if (period) { params.push(String(period).length === 4 ? period + '-%' : period); where += String(period).length === 4 ? ' AND period LIKE $3' : ' AND period = $3'; }
  const dq = await pool.query(`SELECT debit AS cont, SUM(suma) AS s FROM entry_lines WHERE ${where} AND debit IS NOT NULL GROUP BY debit`, params);
  const cq = await pool.query(`SELECT credit AS cont, SUM(suma) AS s FROM entry_lines WHERE ${where} AND credit IS NOT NULL GROUP BY credit`, params);
  for (const r of dq.rows) bump(r.cont, 'd', Number(r.s) || 0);
  for (const r of cq.rows) bump(r.cont, 'c', Number(r.s) || 0);
  return acc;
}

/** TOATE liniile perioadei, DIRECT din SQL (entry_lines) — pentru registrul-jurnal si cartea mare
 *  fara a itera graful. Doar articole postate. Ordinea finala (data + id natural) se face in
 *  apelant (localeCompare numeric nu se reproduce in SQL). Perioada YYYY sau YYYY-MM. */
async function linesForPeriod(firmaId, period) {
  const params = [asInt(firmaId), 'postat'];
  let where = '"firmaId" = $1 AND (status IS NULL OR status = $2)';
  if (period) { params.push(String(period).length === 4 ? period + '-%' : period); where += String(period).length === 4 ? ' AND period LIKE $3' : ' AND period = $3'; }
  const r = await pool.query(`SELECT entry_id, seq, data, document, partener, "tipNume", explicatie, debit, credit, suma FROM entry_lines WHERE ${where}`, params);
  return r.rows.map((x) => ({ entry_id: x.entry_id, seq: x.seq, data: x.data, document: x.document, partener: x.partener, tipNume: x.tipNume, explicatie: x.explicatie, debit: x.debit, credit: x.credit, suma: Number(x.suma) || 0 }));
}

/** Miscarile unui cont in perioada, DIRECT din SQL (entry_lines), ordonate cronologic — pentru fisa de
 *  cont fara a itera graful. Doar articole postate. Perioada YYYY sau YYYY-MM. */
async function linesForAccount(firmaId, cont, period) {
  const params = [asInt(firmaId), 'postat'];
  let where = '"firmaId" = $1 AND (status IS NULL OR status = $2)';
  if (period) { params.push(String(period).length === 4 ? period + '-%' : period); where += String(period).length === 4 ? ' AND period LIKE $3' : ' AND period = $3'; }
  params.push(String(cont));
  where += ` AND (debit = $${params.length} OR credit = $${params.length})`;
  const r = await pool.query(`SELECT data, document, partener, explicatie, debit, credit, suma FROM entry_lines WHERE ${where} ORDER BY data, seq`, params);
  return r.rows.map((x) => ({ data: x.data, document: x.document, partener: x.partener, explicatie: x.explicatie, debit: x.debit, credit: x.credit, suma: Number(x.suma) || 0 }));
}

/** Statistici pe documente calculate in SQL din documents_meta (fara graful in RAM), per firma. */
async function documentsStats(firmaId) {
  const r = await pool.query(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE "textLen" > 0) AS cutext, COUNT(*) FILTER (WHERE "spvMsgId" IS NOT NULL) AS dinspv
     FROM documents_meta WHERE "firmaId" = $1`, [asInt(firmaId)]
  );
  const x = r.rows[0] || {};
  return { total: Number(x.total) || 0, cuText: Number(x.cutext) || 0, dinSpv: Number(x.dinspv) || 0 };
}

/** Cautare documente in SQL (nume fisier sau text extras), per firma. Fara a incarca graful in RAM. */
async function documentsSearch(firmaId, q, limit) {
  const like = '%' + String(q || '').toLowerCase() + '%';
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const r = await pool.query(
    `SELECT doc_id, "fileName", "uploadedAt" FROM documents_meta
     WHERE "firmaId" = $1 AND (LOWER("fileName") LIKE $2 OR LOWER(text) LIKE $2) ORDER BY "uploadedAt" DESC LIMIT $3`,
    [asInt(firmaId), like, lim]
  );
  return r.rows.map((x) => ({ id: x.doc_id, fileName: x.fileName, uploadedAt: x.uploadedAt }));
}

/** Jurnalul de audit DURABIL (append-only) interogat in SQL: numar total (per firma optional).
 *  Decuplat de plafonul RAM -> total poate depasi CONTAB_AUDIT_MAX. */
async function auditCount(firmaId) {
  const r = firmaId == null
    ? await pool.query('SELECT COUNT(*) AS n FROM audit_log')
    : await pool.query('SELECT COUNT(*) AS n FROM audit_log WHERE "firmaId" = $1', [asInt(firmaId)]);
  return Number(r.rows[0] && r.rows[0].n) || 0;
}
async function auditRecent(opts) {
  const o = opts || {};
  const cond = []; const params = [];
  if (o.firmaId != null) { params.push(asInt(o.firmaId)); cond.push('"firmaId" = $' + params.length); }
  if (o.action) { params.push(String(o.action)); cond.push('action = $' + params.length); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  params.push(Math.min(1000, Math.max(1, Number(o.limit) || 100)));
  const r = await pool.query(`SELECT audit_id, "firmaId", ts, "userId", username, action, detail, "viaAdmin" FROM audit_log ${where} ORDER BY ts DESC LIMIT $${params.length}`, params);
  return r.rows.map((x) => ({ id: x.audit_id, firmaId: x.firmaId, ts: x.ts, userId: x.userId, username: x.username, action: x.action, detail: x.detail, viaAdmin: x.viaAdmin }));
}

/** Colectiile scrise la ultimul persist reusit (diagnostic). */
function written() { return lastWritten.slice(); }

/**
 * Asteapta golirea cozii de scrieri si confirma DURABILITATEA, nu doar terminarea buclei.
 * `queue` nu se respinge (vezi flushError), astfel incat save()-urile sincrone care nu consuma
 * promisiunea sa nu genereze unhandledRejection. Fiecare apel flush primeste insa o promisiune
 * respinsa cat timp ultima fotografie RAM nu a fost comisa. Un commit ulterior reusit o vindeca.
 */
function flush() {
  return queue.then(() => {
    if (flushError) throw flushError;
  });
}

/** Reconstruieste graful in memorie din tabele (forma identica cu cea folosita de aplicatie). */
async function hydrate(defaults) {
  const db = {};
  for (const c of ARRAY_COLLS) {
    const r = await pool.query(`SELECT data FROM ${c.key.toLowerCase()} ORDER BY rowid`);
    db[c.key] = r.rows.map((x) => x.data);
  }
  db.partners = {};
  for (const r of (await pool.query('SELECT "firmaId", cui, data FROM partners')).rows) {
    if (!db.partners[r.firmaId]) db.partners[r.firmaId] = {};
    db.partners[r.firmaId][r.cui] = r.data;
  }
  db.openingBalances = {};
  for (const r of (await pool.query('SELECT "firmaId", cont, d, c FROM opening_balances')).rows) {
    if (!db.openingBalances[r.firmaId]) db.openingBalances[r.firmaId] = {};
    db.openingBalances[r.firmaId][r.cont] = { d: r.d, c: r.c };
  }
  const meta = {};
  for (const r of (await pool.query('SELECT key, value FROM meta')).rows) meta[r.key] = r.value;
  epoch = Number(meta.dbEpoch) || 0; // sincronizeaza fence-ul cu versiunea persistata
  db.settings = meta.settings || (defaults ? JSON.parse(JSON.stringify(defaults.settings)) : {});
  db.firmaActiva = meta.firmaActiva != null ? meta.firmaActiva : 1;
  db.seq = meta.seq != null ? meta.seq : 1;
  if (meta.schemaVersion != null) db.schemaVersion = meta.schemaVersion;
  return db;
}

/** Configureaza fencing-ul HA. Providerul intoarce {name, holderId, generation} numai cat
 * instanta este lider pregatit. Callback-ul demite imediat procesul daca PostgreSQL respinge
 * tokenul in tranzactie. `null` dezactiveaza fencing-ul (mod standalone/teste vechi). */
function setHaFenceProvider(provider, onRejected) {
  haFenceProvider = typeof provider === 'function' ? provider : null;
  haFenceRejected = typeof onRejected === 'function' ? onRejected : null;
}

/** Reinitializare permisa EXCLUSIV la promovare, dupa ce coada veche s-a incheiat si inainte sa
 * se deschida readiness. Spre deosebire de resetDirty(), vindeca un conflict vechi deoarece
 * apelantul va rehidrata baza sub o generatie noua, nu va reincerca graful invechit. */
function resetForLeadership() {
  snap = {};
  lastHash = {};
  pendingWork = null;
  pendingSince = 0;
  pendingBytes = 0;
  draining = false;
  conflictedFlag = false;
  flushError = null;
  failStreak = 0;
  lastPersistError = null;
  lastWritten = [];
  planStare = plan.stareNoua();
}

async function close() {
  if (!pool) return;
  try { await flush(); } catch (_) { /* ignora */ }
  const p = pool; pool = null;
  try { await p.end(); } catch (_) { /* ignora */ }
}

module.exports = { localPgConfig, open, schema, isEmpty, persist, hydrate, close, resetDirty,
  resetForLeadership, setHaFenceProvider, written, flush, queueStats, linesTurnover,
  linesForAccount, linesForPeriod, documentsStats, documentsSearch, auditCount, auditRecent, conflicted };
