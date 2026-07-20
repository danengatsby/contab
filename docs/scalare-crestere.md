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
- **Pas 2 — LIVRAT: tabelul normalizat `entry_lines` (o linie contabilă = un rând), interogabil în SQL.**
  Proiecție derivată din blob-ul articolului, scrisă **tranzacțional în aceeași tranzacție** cu articolul
  (pe ambele drivere), sincronizată la insert/update/delete. Blob-ul `entries` rămâne **sursa de adevăr**
  (hydrate NU folosește `entry_lines`), deci e non-breaking și reversibil (drop tabel). Coloane: `entry_id,
  firmaId, period, status, seq, debit, credit, suma, explicatie`. Metodă `store.linesTurnover(firmaId,
  period)` calculează rulajul pe conturi **direct în SQL** (SUM/GROUP BY, doar articole postate) — dovedit
  în teste **identic** cu `accounting.accumulate` din RAM. E prima capacitate de analitică fără a încărca
  graful în RAM (fundația pentru citiri per-cerere la firmele mari).
- **Pas 3 — LIVRAT: tabelul normalizat `documents_meta` + registru de proiecții generic.** Metadatele
  documentelor (id, firmaId, fileName, uploadedAt, spvMsgId, textLen) + textul extras sunt proiectate în
  `documents_meta`, dual-write tranzacțional (blob-ul `documents` rămâne sursa de adevăr). Mecanismul de
  proiecție e acum un **registru unic** (`store.PROJECTIONS`) folosit identic de ambele drivere — un pas
  nou (ex. audit) = o intrare în registru + o metodă de interogare, fără cod nou de sincronizare. Metode:
  `store.documentsStats(firmaId)` (numărători SQL) și `store.documentsSearch(firmaId, q)` (căutare în SQL
  pe nume fișier + text extras — analitică peste graf fără a-l încărca în RAM).
- **Pas 4 — LIVRAT: proiecția audit `audit_log`, APPEND-ONLY (durabilă, decuplată de plafonul RAM).**
  Registrul de proiecții a căpătat un mod `append` (mod separat de „oglindă"): inserează doar rânduri noi
  (dedup pe id: `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`), **nu șterge niciodată**. Baza vie `d.audit`
  rămâne plafonată (RAM/UI), tabelul blob `audit` o oglindește (plafonat), dar `audit_log` păstrează TOT —
  probă durabilă nativă în DB, interogabilă în SQL (`store.auditCount`, `store.auditRecent({firmaId, action}`)),
  complementară jurnalului NDJSON offsite. Coloane reale: audit_id, firmaId, ts, userId, username, action,
  detail, viaAdmin. Dovedit în teste: după plafonarea RAM, `audit_log` păstrează evenimentele ieșite din RAM.
- **Pas 5 — LIVRAT (seam, gated pe prag): citiri per-cerere din SQL pentru firmele MARI.** `/api/balance`
  se calculează acum **direct în SQL** (proiecția `entry_lines`, prin `db.trialBalanceSql`) când firma
  depășește `CONTAB_SQL_READ_THRESHOLD` articole (implicit **20.000**) și driverul suportă SQL (pg/sqlite);
  altfel din RAM. Rezultat **identic** (dovedit: suita HTTP trece cu ACELEASI aserttii de balanță și pe
  calea RAM, și pe cea SQL forțată cu prag 0 — rulat în CI pe sqlite și pg). `accounting.buildBalanceRows`
  a fost extras ca să fie alimentabil din ambele surse; `store.linesTurnover(fid, period, {before})` dă
  rulajul dinainte de perioadă (solduri inițiale). Header diagnostic `X-Balance-Source: ram|sql`. Sub prag
  (toate firmele actuale, inclusiv producția), calea rămâne RAM — zero schimbare de comportament. Acesta e
  **seam-ul** pentru per-request SQL: reduce CPU/latența agregărilor grele la firmele mari (nu reduce încă
  RAM-ul — graful e tot hidratat integral; hidratarea lazy e un pas ulterior, mai mare).
- **Pas 6 — LIVRAT: fișa de cont pe calea SQL + îmbogățirea proiecției.** `entry_lines` a primit coloanele
  `data`, `document`, `partener` (migrare aditivă `ALTER TABLE ... IF NOT EXISTS` + **backfill fără marker**:
  rândurile vechi au `data IS NULL` → reproiectare integrală din blob la boot, idempotent, no-op pe DB
  proaspăt) + indecși pe `(firmaId, debit)` / `(firmaId, credit)`. `store.linesForAccount(fid, cont, period)`
  întoarce mișcările unui cont direct din SQL, cronologic; `db.trialFisaContSql` reconstruiește fișa de cont
  identic cu `accounting.fisaCont`. `/api/fisa-cont` folosește calea SQL peste același prag (header
  `X-FisaCont-Source`). Dovada de echivalență: suita HTTP trece cu aceleași aserții pe RAM și pe SQL forțat
  (prag 0), pe sqlite și pg; testele de store compară mișcările SQL cu `allLines` din RAM.
- **Pas 7 — LIVRAT: fencing multi-scriitor (versionare optimistă `dbEpoch`).** Fiecare persist verifică
  și avansează `dbEpoch` (meta) **în aceeași tranzacție** cu datele. Dacă alt proces a scris între timp
  (epoch avansat), scrierea noastră ar porni din RAM învechit și ar suprascrie rândurile lui — deci e
  **refuzată** (rollback) și persistența se **îngheață** până la restart (fail-loud, nu clobber silențios;
  reîncercarea ar fi coruperea). Implementat identic pe sqlite (throw sincron → 500 vizibil pe rută) și pg
  (log CRITIC + refuz în coada serială). Expus în `/api/metrics` (`process.storeConflict`) și
  `store.conflicted()`. Completează lock-ul single-instance local (lifecycle) cu o gardă la nivel de DB
  care funcționează **peste mașini** — fundația de siguranță pentru multi-instanță: două instanțe pe
  aceeași bază nu se mai pot suprascrie una pe alta neobservat. Dovedit în teste pe ambele drivere
  (al doilea scriitor simulat: conflict detectat, rândul străin intact, scrierea proprie rollback, freeze).
- **Pas 8 — LIVRAT: registrul-jurnal + cartea mare pe calea SQL.** `entry_lines` a primit `tipNume`
  (fallback-ul explicației din jurnal), iar `explicatie` a fost aliniat exact la lanțul `allLines`
  (`ln.explicatie || e.explicatie || ''`) — backfill condiționat extins (`data IS NULL OR tipNume IS
  NULL`). `store.linesForPeriod(fid, period)` întoarce toate liniile perioadei din SQL; ordinea finală
  (data + **id natural** — `localeCompare numeric`, nereproductibil în SQL) se face în JS cu exact
  comparatorul din `sortEntries`. `db.journalSql`/`db.ledgerSql` reconstruiesc identic ieșirile;
  `/api/journal` + `/api/ledger` gate-uite pe același prag (headere `X-Journal-Source`/`X-Ledger-Source`).
  Schimbare de comportament asumată (îmbunătățire): mișcările din cartea mare (RAM) sunt acum ordonate
  **cronologic** (înainte: ordinea colecției). Dovadă: invariante încrucișate în suită (jurnal.total ==
  balanță.tot.rd; cartea mare 4111 == rândul balanței), rulate pe ambele căi (prag 0) pe sqlite și pg.
  Toate cele patru agregări grele (balanță, fișă de cont, jurnal, cartea mare) au acum cale SQL.
- **Pași următori (neîncepuți):** multi-instanță reală (necesită citiri per-cerere generalizate, nu doar
  fencing — fencing-ul actual protejează, nu partajează); eventual hidratare lazy (a nu încărca tot
  graful) — pasul care reduce efectiv RAM-ul, luat doar pe semnal real (`firmeLoad`).

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
