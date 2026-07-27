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
  depășește `CONTAB_SQL_READ_THRESHOLD` articole (implicit **100.000** din 2026-07-27, vezi mai jos;
  inițial 20.000) și driverul suportă SQL (pg/sqlite);
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

### Măsurătoare pe volum (2026-07-25) — primul semnal real

Documentul cere ca fiecare pas să pornească pe un semnal real. Până acum nimeni nu produsese
măsurătoarea, iar toate firmele din producție sunt mici (57 articole). Am generat **27.350 de
articole** prin API-ul real (toate regulile, toate proiecțiile) pe o instanță izolată și am
cronometrat rutele grele. Mediana din 3 rulări, driver `sqlite`:

| Rută | Domeniu | RAM | SQL | Prag 500 ms |
|---|---|---|---|---|
| `/api/dashboard` | tot anul | **749–797 ms** | 859 ms | **⚠ DEPĂȘIT** |
| `/xml/saft?year` | tot anul | 380–404 ms | — | se apropie |
| `/api/journal?period=an` | tot anul | 290 ms | — | ok |
| `/api/balance?period=an` | tot anul | 30 ms | — | ok |
| `/api/balance?period=lună` | 2.279 art. | 18–27 ms | 47 ms | ok |
| `/api/journal?period=lună` | 2.279 art. | 30–32 ms | 52 ms | ok |
| `/api/ledger?period=lună` | 2.279 art. | 43–45 ms | 74 ms | ok |
| `/api/fisa-cont` | 2.279 art. | 13–16 ms | 24 ms | ok |

**1. `/api/dashboard` e singura rută peste prag** — și singura dintre cele grele **fără** cale SQL.
Confirmă exact veghea de scalare din `scripts/perf-report.sh`, care o are pe listă cu acțiunea deja
formulată („cache pe /api/dashboard"). Extrapolare grosieră din două puncte (18 ms la 500 articole,
~780 ms la 27.350): ~0,028 ms/articol, deci pragul de 500 ms se atinge pe la **~18.000 de articole**.
Ordin de mărime, nu cifră exactă.

**2. Calea SQL e mai LENTĂ decât RAM la acest volum** — de 1,6–2,6× pe fiecare rută gate-uită. Adică
`CONTAB_SQL_READ_THRESHOLD` = 20.000 comută pe calea mai lentă exact când se activează. Asta
contrazice premisa „reduce CPU la firmele mari" de la pașii 5–8.

**Limitele măsurătorii, explicit.** E făcută pe **sqlite**, iar producția rulează pe **pg** — pg
peste socket ar fi probabil și mai lent față de RAM in-process, dar asta e inferență, nu măsurătoare.
27.350 e doar puțin peste prag; punctul unde SQL începe să câștige poate fi mult mai sus (100k+),
netestat. Și, cel mai important: scopul declarat al căii SQL nu e doar viteza, ci **seam-ul** către
hidratarea lazy — singurul pas care reduce efectiv RAM-ul. Nu e cod inutil; e cod al cărui beneficiu
de CPU nu se vede încă.

**Măsurat pe pg, PESTE prag (2026-07-25) — punctul de decizie.** 22.000 de articole generate prin
API-ul real, confirmate ca **rânduri în postgres** (22.000 entries, 44.000 entry_lines), nu doar în
RAM. Poarta se activează natural (22.000 > 20.000), iar ambele căi sunt verificate prin anteturile
`X-*-Source`. Mediana din 3 rulări:

| Rută | SQL | RAM | RAM mai rapid de |
|---|---|---|---|
| balanță (lună) | 17 ms | 14 ms | 1,2× |
| jurnal (lună) | 82 ms | 21 ms | **3,9×** |
| cartea mare (lună) | 87 ms | 30 ms | **2,9×** |
| fișă cont | 26 ms | 16 ms | 1,6× |
| balanță (tot anul) | 21 ms | 16 ms | 1,3× |
| dashboard *(fără cale SQL)* | 736 ms | 634 ms | ⚠ peste prag |
| SAF-T *(fără cale SQL)* | 419 ms | 345 ms | — |

**Concluzia, acum la volumul unde poarta chiar contează:** RAM e mai rapid decât SQL pe **fiecare**
rută gate-uită, pe ambele drivere. `CONTAB_SQL_READ_THRESHOLD` = 20.000 comută pe calea mai lentă
exact în clipa în care se activează. Confirmă și extrapolarea de mai sus: `/api/dashboard` trece
pragul de 500 ms (estimat ~18.000, măsurat 634–736 ms la 22.000).

**Ce ar trebui făcut, în ordine** (toate trei rezolvate pe 2026-07-27 — vezi secțiunea următoare):
(a) **ridicat** `CONTAB_SQL_READ_THRESHOLD` — calea SQL nu-și
merită gate-ul pe criteriu de CPU. Atenție însă la ce NU spune măsurătoarea: scopul declarat al
căii SQL e *seam*-ul către hidratarea lazy, adică reducerea RAM-ului, nu viteza. Ridicarea pragului
o dezactivează practic; păstrarea codului rămâne justificată de acel scop. Decizia e „pe ce criteriu
se activează", nu „se șterge sau nu"; (b) `/api/dashboard` e
următoarea investiție reală (cache per-firmă invalidat la `db.save`), fiindcă e singura rută care
chiar doare, pe la ~18.000 de articole; (c) hidratarea lazy rămâne pe semnal de **RAM**, nu de CPU.

### REZOLVAT (2026-07-27): dashboard memoizat, comparator natural refolosit, prag SQL ridicat

Cele două acțiuni cerute de măsurătoarea de mai sus — (a) ridicarea pragului SQL și (b) cache pe
`/api/dashboard` — sunt livrate. Pe drum, profilarea pe componente a scos la iveală o a treia
cauză, mai mare decât ambele: **construirea unui `Intl.Collator` la fiecare comparație**.

**1. Comparatorul natural, refolosit (`util.naturalCompare`).** Toate sortările cronologice
(articole, mișcări de stoc, linii din SQL) comparau id-urile cu
`String.prototype.localeCompare(x, undefined, { numeric: true })` — spec-ul definește asta ca
`Collator(locale, opts).compare(...)`, adică **un colator construit per comparație**. Un singur
`Intl.Collator` refolosit dă, prin aceeași definiție, **exact aceeași ordine** (verificat în teste
pe id-uri amestecate), la o fracțiune din cost. Măsurat pe 22.000 de articole: sortarea completă
**175 ms → 12 ms**. Beneficiul nu e doar pe dashboard — atinge orice rută care sortează articole.

**2. `accounting.lastEntries(entries, n)`.** Dashboard-ul sorta toată colecția ca să afișeze
ultimele **cinci** operațiuni. Acum face o singură trecere cu o listă de `n` elemente; rezultat
identic cu `sortEntries(...).slice(-n).reverse()` (dovedit în teste, inclusiv pe capete: n=0,
n>lungime, ordine de intrare inversată).

**3. Memo per firmă pentru `/api/dashboard` (`src/cache.js`).** Cheia e `(nume raport, firmaId)`;
validitatea stă pe **revizia globală de scriere** (`db.dataRev()`, avansată la fiecare
`save()`/`restore`/`load`) plus **ziua curentă** (agregatele care depind de „azi", ca termenul de
5 zile la e-Factura). Invalidarea e deliberat **globală, nu per firmă**: e corectă *prin
construcție*, fără a inventaria căile de scriere — o cale uitată ar însemna cifre contabile
învechite afișate ca fiind curente, iar asta nu merită schimbat pe o rată de hit mai bună. Câmpul
per utilizator (`primiiPasi.wizardAscuns`) se suprapune **după** memo, pe o copie superficială;
memoizarea folosește `db.scoped(fid)`, nu `S(req)`, tocmai ca rezultatul să nu depindă de cine
cere. Plafon LRU de 64 de intrări. Diagnostic: antetul `X-Dashboard-Cache: hit|miss` și
`cache: { entries, hits, misses, hitRate }` în `/api/metrics`.

Măsurat pe aceeași instanță de bench (sqlite, `scripts/bench.sh`), mediana din 3 rulări:

| Rută | Înainte | După (miss) | După (hit) |
|---|---|---|---|
| `/api/dashboard` (22.000 art.) | **611 ms** | **100 ms** | **2–3 ms** |
| `/api/entries` (22.000 art.) | 212 ms | 52 ms | — |
| `/api/vat-journals?period=lună` | 21 ms | 6 ms | — |

Componentele dashboard-ului la 22.000 de articole (înainte → după): `reconcile` 217 → 50 ms,
`vatJournals` 201 → 30 ms, `sortEntries` 176 → 13 ms, total `rep.dashboard` 403 → 86 ms.

**p95, măsurat pe amestecuri citiri/scrieri** (20 de cicluri, fiecare cu o scriere reală prin
`POST /api/entries` urmată de citiri):

| Volum | doar MISS (p50/p95) | doar HIT (p50/p95) | 1 scriere la 5 citiri (p95) |
|---|---|---|---|
| 22.000 articole | 100 / 131 ms | 3 / 5 ms | 112 ms |
| 60.000 articole | 278 / 336 ms | 5 / 7 ms | 299 ms |

**Ținta p95 < 500 ms e atinsă cu marjă, indiferent de amestec** — inclusiv în cazul degenerat în
care *fiecare* citire e precedată de o scriere (adică memo-ul nu ajută deloc): 131 ms la 22.000 și
336 ms la 60.000. Cache-ul nu mai e singurul lucru care ține pragul; calea de recalculare singură
îl respectă până pe la ~100.000 de articole (extrapolare din cele două puncte măsurate).

**3bis. Reparat pe drum: citire-după-scriere pe calea SQL (pg).** Verificarea pe `pg` cu prag 0 a
scos un defect **preexistent**, invizibil pe sqlite: pe pg, `save()` fotografiază sincron dar
**comite printr-o coadă asincronă**, iar citirile din proiecții (`entry_lines`) nu o așteptau. O
citire imediat după o scriere vedea starea DE DINAINTE — un articol tocmai postat lipsea din
balanță și din registrul-jurnal (suita pica reproductibil pe combinația pg + prag 0, deci și în
jobul `test-postgres` din CI). Toate cele patru citiri SQL (`trialBalanceSql`, `journalSql`,
`ledgerSql`, `trialFisaContSql`) așteaptă acum coada (`sqlReady()` → `flushStore()`); pe sqlite e o
promisiune deja rezolvată, deci zero cost. Verificat pe toate patru combinațiile (sqlite/pg ×
prag implicit/0): 580 de verificări HTTP verzi peste tot.

**4. `CONTAB_SQL_READ_THRESHOLD`: 20.000 → 100.000.** Pe criteriu de CPU, calea SQL nu-și merita
poarta (era mai lentă decât RAM pe fiecare rută gate-uită, exact la volumul unde se activa). Codul
SQL **rămâne**: scopul lui declarat e seam-ul către hidratarea lazy — reducerea RAM-ului, nu viteza.
Noua valoare e deliberat **nemăsurată** (punctul unde SQL ar câștiga rămâne necunoscut): până la o
măsurătoare acolo, calea implicită e cea dovedit mai rapidă. CI-ul continuă să ruleze suita și cu
prag 0, deci echivalența celor două căi rămâne verificată.

### Coada de persistență pg acumulează sub scrieri rapide (2026-07-25)

Încercând să repet măsurătoarea de mai sus pe **pg** (driverul din producție), instanța a murit cu
`heap out of memory` la ~6.000 de articole — pe sqlite dusese 27.350 fără probleme. Cauza e o
**asimetrie între drivere**:

- `src/store.js` (sqlite): `persist()` e **sincron** — scrie și se întoarce, nimic nu se acumulează;
- `src/storePg.js`: `persist()` construiește sincron un **snapshot complet** al colecțiilor
  (`cur` = Map cu JSON-ul fiecărui rând) și îl adaugă în coada serială async. Dacă scrierile vin mai
  repede decât comite baza, snapshot-urile se adună în RAM.

Dovedit prin control, aceleași 800 de scrieri și aceleași date finale:

| Ritm | Durată | Memorie proces |
|---|---|---|
| rapid (fără pauză) | 3,0 s | 136 → **413 MB**, urcă la 475 MB *după* ce scrierile s-au oprit |
| lent (pauză 25 ms) | 23,9 s | 153 → 185 MB, **revine la 151 MB** după 8 s de liniște |

**Cât de aproape e producția — onest: nu e.** Ritmul care a produs acumularea (~267 scrieri/s) a
cerut ridicarea plafonului de API la 2.000.000; plafonul real e 600/min ≈ 10/s, adică **~26× sub**
prag. Și căile de scriere în masă ale aplicației sunt scrise corect: importul de extras bancar și
generatorul de recurente construiesc toate articolele și apoi fac **un singur** `db.save()`, nu unul
per articol.

**Ce rămâne totuși de reținut:** dimensiunea unui snapshot crește cu firma. La 800 de articole s-au
măsurat ~350 KB reținuți per scriere în coadă; la 27.000 de articole snapshot-ul e de ~30× mai mare,
deci câteva zeci de scrieri în coadă ating plafonul de 1 GB (`max_memory_restart`). Riscul apare
dacă: (a) se ridică plafonul de API, (b) o cale nouă de import face `save()` per element, sau
(c) o firmă crește mult. Nu e o problemă de azi; e o fragilitate care scalează invers față de cum
ne-am dori.

**REMEDIAT (2026-07-25):** colapsarea persistărilor în așteptare. Un singur `work` poate aștepta
intrarea în tranzacție; unul nou îl **înlocuiește**. E sigur fiindcă `work` nu e un delta, ci diff-ul
față de `snap` — iar `snap` se actualizează doar după commit, deci cât timp nimic nu s-a comis fiecare
`work` nou pornește din același punct și îl conține integral pe cel înlocuit. Fencing-ul rămâne
valid: `epoch` avansează o dată per commit, la fel ca `dbEpoch` din bază.

Verificat: aceleași 800 de scrieri rapide rămân la **181 MB** (înainte: 475 MB), cu aceeași durată —
și, mai important, fără pierdere de date: 800 în RAM = 800 rânduri în postgres = 1.600 linii
proiectate, iar după repornire și rehidratare din bază tot 800, cu balanța echilibrată. Suita
`test/store-pg.js` a primit o secțiune dedicată (rafală de 20 de persist-uri fără await, ștergeri
propagate printr-o rafală colapsată): 53 de verificări, plus suita HTTP completă pe pg.

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
