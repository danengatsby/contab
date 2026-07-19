# Scalare și creștere — decizie de arhitectură

> Document de decizie (ADR). Capturează analiza căilor de creștere ca să nu fie re-litigate și ca
> fiecare pas să pornească pe un semnal real, nu pe o presupunere. Actualizează-l când un prag e atins.

## Direcție (2026-07): migrare graduală spre PostgreSQL tranzacțional

Decizie de conducere: se migrează **treptat** de la graful integral în RAM spre persistență
PostgreSQL tranzacțională, cu scrieri per-rând (și, ulterior, tabele normalizate pentru articole/
linii/documente/audit), ca să susțină **concurență reală și mai multe instanțe**. Migrarea e
incrementală și reversibilă; fiecare pas rămâne în spatele abstracției de store (`src/store*.js`),
fără schimbări în modulele de domeniu.

- **Pas 1 — LIVRAT: scrieri incrementale per-rând în `storePg` (paritate cu SQLite).** Înainte,
  driverul PostgreSQL (producția) făcea `DELETE FROM <tabel>` + `INSERT`-tot la fiecare `save()`
  pentru fiecare colecție murdară — rescria tabele întregi și, esențial, **ar fi șters rândurile
  altei instanțe**. Acum face `INSERT/UPDATE/DELETE` doar pe rândurile schimbate (diff față de un
  snapshot per rând, `snap[colecție] = Map(id→json)`), într-o singură tranzacție, cu delete-then-
  insert idempotent (sigur la persist-uri concurente). Rândurile neschimbate nu se mai ating (dovadă:
  `test/store-pg.js` verifică stabilitatea `rowid`). Reduce amplificarea scrierilor și e prima cărămidă
  pentru multi-instanță pe colecțiile cu `id`.
- **Pași următori (neîncepuți):** tabele normalizate pentru linii (interogabile în SQL), citiri
  per-cerere din pg pentru firmele mari, lock/versionare optimistă pentru multi-instanță reală.
  Se iau incremental, fiecare cu testele lui pe driverul pg (job CI `test-postgres`).

Restul documentului rămâne analiza anterioară (partiționare pe firmă etc.), încă validă ca alternativă
complementară — migrarea la pg tranzacțional și partiționarea pe `firmaId` nu se exclud.

## Contextul: de ce arhitectura actuală e o alegere, nu o limitare

Contabo e un **monolit modular** cu întreaga bază în RAM-ul unui singur proces:

- `db.load()` hidratează baza **o singură dată** la pornire (`store.hydrate`); toate citirile de după
  sunt din graful din memorie (`db.get()` / `db.scoped(firmaId)`), **nu** din PostgreSQL per-cerere.
  PostgreSQL e doar stratul de persistență (scriere la `save()`, citire o dată la boot).
- Modulele de domeniu (`accounting`, `payroll`, `stocks`, `bank`) **nu sunt proprietari separați de
  date** — sunt co-autori ai aceleiași colecții `entries`: payroll postează prin `buildEntry`
  (`stat_plata`, `plata_salarii`), stocks postează COGS (607=371, descărcare de gestiune), bank la
  fel. Toate citesc **același plan de conturi** și respectă aceleași invariante transversale:
  partidă dublă (debit=credit), blocarea perioadei, jurnalul de audit, izolarea pe `firmaId`.
- Consistența e **sincronă și atomică**: un stat de plată → articole → solduri, într-un singur `save()`.

Aceste proprietăți (simplitate, consistență sincronă, viteză in-memory, un singur proces operabil,
dependențe minime — doar PostgreSQL) sunt cele mai mari puncte forte ale aplicației.

## Microservicii pe domenii (accounting/payroll/stocks) + mesagerie async — RESPINS

Propunerea de a sparge modulele în servicii independente care comunică prin Redis pub/sub sau
RabbitMQ **nu se potrivește** acestei aplicații, din motive structurale, nu de gust:

1. **Domeniile nu sunt separabile** — scriu toate în același registru (`entries`) cu invariante care
   trec *prin* ele. Granița corectă de izolare e `firmaId`, nu tipul de document.
2. **Mesageria async ar înlocui consistența tranzacțională cu una eventuală** — pe date contabile,
   asta e un pas înapoi în corectitudine (ar cere saga/compensări pentru ce acum e un `save()`).
3. **Workerii separați nu au acces la baza din RAM** — orice proces separat ar trebui să
   re-serializeze tot graful (măsurat: ~123MB la 50k articole) per operațiune. Exact motivul pentru
   care worker threads și BullMQ au fost respinse pentru generarea de PDF/XML.
4. **Nu rezolvă o problemă reală** — nu există „domeniu" care să fie bottleneck; datele sunt un
   singur graf mic (producție: ~157KB), iar bottleneck-ul real (dacă apare) e volumul per firmă.

## Căile de creștere care se potrivesc, în ordine

### 1. Partiționare PE FIRMĂ (axa reală) — pregătit, declanșat de date

Firmele sunt deja izolate prin `firmaId` / `db.scoped(fid)`, deci partiționarea e o chestiune de
**rutare/deploy**, nu de schimbare a modelului de date. Când o singură firmă (sau un grup) devine
prea mare pentru un proces, se pot rula mai multe instanțe, fiecare deservind un subset de firme,
cu un router în față (nginx după un antet/subdomeniu de firmă).

- **Semnalul (implementat acum):** `/api/metrics` expune `firmeLoad.maxEntries` + `top` (distribuția
  articolelor/documentelor per firmă). Aceasta e măsurătoarea care spune *când* și *pentru care firmă*.
- **Pragul orientativ:** o singură firmă peste ~20.000 de articole/an (unde deja am pus gardă OOM și
  paginare) sau RSS-ul procesului apropiindu-se constant de `max_memory_restart` (1G) — abia atunci
  merită complexitatea de multi-instanță. Sub asta, un singur proces e mai simplu și mai rapid.
- **Ce ar presupune (NU se construiește speculativ):** lock-ul single-instance devine per-partiție;
  auth/sesiuni partajate (deja pe cookie semnat, deci portabile); router pe firmă. Toate reversibile.

### 2. Read replicas PostgreSQL — NEAPLICABIL acestei arhitecturi

Un read replica ajută aplicațiile care fac **citiri per-cerere** din baza de date. Contabo **nu face
asta** — citește din RAM, iar PostgreSQL e atins doar la scriere și o dată la boot. O replică ar sta
inactivă. **Nu se implementează** (ar fi cod mort). Ar deveni relevantă doar dacă aplicația ar migra
la citiri per-cerere din pg — o schimbare de model pe care o evită deliberat.

### 3. Deja livrat (creștere fără infra)

- **Paginare + gardă OOM** pe colecțiile mari (`src/paginate.js`): răspuns plafonat la
  `CONTAB_MAX_ROWS`, paginare `?limit/?offset`.
- **Yielding cooperativ** pentru SAF-T + situații (`saftXmlAsync`, `/pdf/situatii` async): generarea
  cedează event loop-ul, deci nu blochează celelalte cereri (dovedit: health 144ms în timpul unui
  SAF-T pe 50k, vs ~1200ms blocat sincron).
- **Veghe de scalare** în raportul zilnic (`scripts/perf-report.sh`): alertă când rute O(n) cunoscute
  depășesc pragul de latență în producție.

## Regula

Fiecare pas se ia pe un **semnal real** din producție (metrici / raportul zilnic), nu pe volum
ipotetic. Producția e acum la ~157KB și zero cereri lente — deci pasul următor e **să observi**
(`firmeLoad`), nu să construiești infra. Aproape sigur primul semnal va indica „partiționează firme",
nu „sparge accounting de payroll".
