# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ce este

Contabo — aplicație de contabilitate românească (partidă dublă, plan de conturi RO): documente
primare PDF → articole contabile → registre → balanță → declarații ANAF (D300/D394/D112/SAF-T…)
+ e-Factura/SPV, stocuri, salarizare, billing Stripe per-firmă. Multi-firmă strict: orice date
sunt izolate pe `firmaId`. **Acest director (`/var/www/contab`) este și instalarea de producție**
(pm2, utilizatorul `contab`) — ai grijă pe ce ramură lași working tree-ul (`main`!).

## Comenzi

```bash
npm test                      # suita completă: sintaxă + module + store + HTTP (rulează și la `prestart`)
node test/run.js              # doar verificările de module (sincron, eq/ok, secțiuni)
node test/http.js             # doar integrarea HTTP (server real pe port efemer, DB temporar per-pid)
CONTAB_TEST_DRIVER=json node test/http.js     # aceeași suită pe driverul json (vechi, doar rollback; rulează ambele la schimbări de persistență!)
node test/frontend.mjs        # doar logica pură din public/*.js (shim DOM, fără browser/jsdom)
node test/anaf.js             # reziliență ANAF + poll SPV (async, stub-uri, fără apeluri reale)
npm run seed                  # încarcă exemplul din ghid (S.C. EXEMPLU PROD S.R.L., 2026-06)
npm run e2e                   # E2E pe live; pe acest server rulează prin Docker (vezi antetul scripts/e2e.mjs)
```

**Producția rulează pe `pg`, dar `npm test` rulează pe `sqlite`** — iar `test/store-pg.js` se sare
tăcut fără `CONTAB_PG_URL`. Deci o suită verde local NU înseamnă că driverul de producție e
verificat. (În CI **e**: jobul `test-postgres` din `.github/workflows/ci.yml` rulează store-pg +
suita HTTP + balanța cu prag 0 pe un Postgres real.) Înainte de o schimbare care atinge
persistența, rulează și local pe pg:

```bash
docker run -d --name contab-pgtest -e POSTGRES_USER=contab -e POSTGRES_PASSWORD=contab \
  -e POSTGRES_DB=contab_test -p 55432:5432 postgres:16
PG='postgres://contab:contab@localhost:55432/contab_test'
CONTAB_PG_URL="$PG" node test/store-pg.js                      # persistența incrementală pe pg
CONTAB_TEST_DRIVER=pg CONTAB_PG_URL="$PG" node test/http.js    # suita HTTP completă pe pg
docker rm -f contab-pgtest                                      # ...și oprește containerul
```

**Variabila e `CONTAB_TEST_DRIVER`, NU `CONTAB_DB_DRIVER`.** `test/http.js` își pornește propriul
server și îi impune driverul din `CONTAB_TEST_DRIVER`; un `CONTAB_DB_DRIVER=pg` pus în față era
ignorat tăcut, suita rula pe sqlite și raporta „557 verificări trecute" — încredere falsă exact în
locul unde voiai o verificare. Astăzi acea formă se oprește cu eroare și îți spune comanda corectă.
Suita golește singură tabelele aplicației la pornire, deci se poate rula de câte ori vrei pe
aceeași bază.

Instanță de dezvoltare izolată (nu atinge producția):

```bash
CONTAB_DB_DRIVER=sqlite CONTAB_DB_FILE=/tmp/dev.json CONTAB_DATA_DIR=/tmp/dev-data PORT=18099 node server.js
# ...și oprește-o la final: fuser -k 18099/tcp  (o instanță uitată dă fals-pozitive la verificări)
```

Deploy (după merge în `main`): `sudo -u contab PM2_HOME=/home/contab/.pm2 pm2 restart contab`,
apoi `curl -s http://127.0.0.1:8080/api/health`. Restartul din root fără `PM2_HOME` eșuează.
**`pm2 restart` NU reaplică `ecosystem.config.js`** — păstrează configurația cu care procesul a fost
pornit prima dată. O modificare acolo (plafon de memorie, căi de log, env) ajunge în producție doar
prin `pm2 delete contab && pm2 start ecosystem.config.js && pm2 save`; altfel fișierul rămâne o
declarație de intenție (verifică înainte ce variabile ar dispărea din env-ul procesului).

## Arhitectură

- **server.js** (~350 linii) — doar ASAMBLAREA: înregistrarea modulelor de rute cu
  `ctx = { S, activeId, canAccess, requireAdmin, logAudit… }`, `composeEntry`/`buildEntry`/`upsertPartner`
  (partajate de entries/bank/anaf/payroll) și `activeId`/`S` (izolarea pe firmă — sursa unică).
  Restul e spart pe module: **src/bootstrap.js** (`.env`, `createApp` cu helmet/CSP calibrat,
  reqId, metrici, multer + garda upload; `applySecurityGuards` cu garda CSRF pe origine
  (`CONTAB_CSRF=0` rollback), autentificare, mustChange, drepturi granulare, paywall per-firmă
  `FIRMA_BILL_EXEMPT`, plafon general de API (`CONTAB_RATE_API`, implicit 600/min per
  utilizator/IP) și plafon exporturi),
  **src/authRoutes.js** (login/2FA, înscriere, resetare, impersonare, me/meta/health/metrics/audit),
  **src/jobs.js** (`safeInterval`: backup, digest-termene, demo-reset, rate-limit-hygiene,
  uploads-hygiene, memory-watch, spv-poll),
  **src/serverErrors.js** (fereastra 5xx + alertă email, handlerul global de erori, plasele pe
  proces), **src/lifecycle.js** (lock single-instance, listen după `dbReady`, oprirea curată).
- **src/routes/*.js** — puncte de intrare subțiri: `register(app, ctx)`; parsează cererea, apelează
  serviciul, scriu auditul, traduc erorile. Tipar: `run(res, fn)` trimite JSON doar dacă `fn` nu a
  răspuns deja singur (export/PDF) și lasă erorile fără `status` să urce la handlerul global (500 + log).
- **Închiderea lunară** (`src/monthlyClose.js` motor pur + `src/monthlyCloseService.js` scrieri +
  `public/inchidere.js` cockpit, în capul tabului „Închideri de lună") — fluxul unic documente →
  extras bancar → TVA → declarații → aprobare → blocare. **Starea fiecărui pas se DERIVĂ din date**,
  nu se bifează: o bifă manuală ar rămâne adevărată după ce datele se schimbă. Se persistă
  (colecția `closings`) doar ce nu se poate deduce: responsabil, termen, notă, dovada validării,
  aprobarea, forțarea cu motiv. Închiderea peste pași deschiși = **admin + motiv scris**.
- **Service layer** (`src/stocksService.js`, `src/firmeService.js`, `src/anafService.js`) — validare,
  reguli, scrieri, cu **autorizare dublată**: `reqFirma()` (firmă explicită și existentă — fără
  fallback pe `firmaActiva`; `db.scoped(fid)` cade acolo pe fid invalid = scurgere), `reqEntry()`
  (404 identic pentru inexistent și străin), `reqNotDemo`/`reqAdmin`. Erorile de business poartă
  `err.status`. Extinde acest model dacă o rută crește; rutele rămase sunt majoritar citiri.
- **src/db.js** — persistență cu driver comutabil `CONTAB_DB_DRIVER`: `sqlite` (implicit, incremental),
  `pg` (producția reală; async la load), `json` (VECHI — doar rollback de urgență; nimic nu mai
  rulează implicit pe el, iar la pornire avertizează). `db.get()` = obiectul viu; mutează-l
  și cheamă `db.save()`. `db.scoped(fid)` = vederea filtrată pe firmă (folosită prin `S(req)` în rute).
  Oglinda JSON (`flushMirror(true)` înainte de backup) e fișierul copiat de backup.
- **Module de domeniu** (`src/accounting|stocks|payroll|fiscal|xml|saft|reporting…`) — funcții pure
  peste vederea scoped; XML-urile de declarații sunt verificate în teste cu `wellFormed`. **Atenție:
  `wellFormed` verifică DOAR echilibrul etichetelor** — un `<b>x</b>` injectat dintr-o denumire de
  partener e echilibrat, deci trece. Escaparea se dovedește separat (vezi secțiunea Convenții).
- **Frontend** — vanilla JS în `public/`, spart pe module (app.js + messages/bank/settings/admin/…);
  fără framework, decizie deliberată. Previzualizarea articolului contabil din formular NU se
  calculează local: vine de la server (`POST /api/preview` → `composeEntry`), ca regulile contabile
  să aibă o singură implementare. `composeEntry` compune articolul FĂRĂ identitate; `buildEntry`
  adaugă id-ul din secvență — previzualizarea nu are voie să consume un id (ar lăsa goluri).
- **Observabilitate** — `src/log.js` (structurat, reqId), `src/metrics.js` + `GET /api/metrics`
  (admin: durate pe rută, `recentErrors`, starea joburilor, proces). `/api/health` e PUBLIC și
  **intenționat minimal** — există test negativ care blochează orice câmp de diagnostic pe el.
  Raport zilnic: `scripts/perf-report.sh` (cron 07:45, email doar dacă e ceva de raportat;
  la testare folosește `CONTAB_PERF_NOMAIL=1` — variabilele goale NU opresc trimiterea, `.env` câștigă).

## Convenții

- Comentariile din `src/` sunt în română **fără diacritice**; docs/ și mesajele către utilizator cu
  diacritice. Comentariile explică *de ce*, nu *ce*.
- Commit-uri tematice în română (titlu scurt + corp explicativ), o ramură pe temă, merge în `main`
  cu `--no-ff` (nu squash). `gh` nu e autentificat — PR-urile se deschid manual dacă e nevoie de review.
- Teste: `test/run.js` e sincron (helper-ele `eq/ok/section`; `errStatus` pentru gărzile de serviciu);
  `test/http.js` pornește serverul real pe un **port efemer** (`freePort()` — nu mai fix; suita e
  paralelizabilă, DBF e per-pid) și include un test de concurență (scrieri paralele pe `/api/entries`);
  seed în `buildDb()`, cookie-uri prin `req()`, FormData nativ;
  `test/anaf.js` e async (stub pe `global.fetch` și pe funcțiile modulului `anaf`). La teste noi de
  rute HTTP, atenție: restore-ul din suita de backup readuce baza la snapshot.
- Frontend: `test/frontend.mjs` testează **doar logica pură** din `public/*.js` (funcții și
  construire de HTML ca șiruri), nu randarea — aceea e treaba lui `npm run e2e`. `test/dom-shim.mjs`
  dă globalii atinși la import (`document`, `window`, `MutationObserver`…) și întoarce mereu
  elemente inerte, niciodată `null` (disciplina de gardă pe null nu e uniformă în `public/`).
  Modulele se importă dintr-o **oglindă în /tmp** marcată `{"type":"module"}`, fiindcă `package.json`
  de la rădăcină e `"commonjs"`; `public/` rămâne curat (un `public/package.json` ar ajunge servit
  static). Pentru a testa o funcție pură nouă, adaug-o într-un `export` separat, marcat cu comentariu.
- Orice scriere externă (ANAF) trece prin `anafFetch` (timeout + retry doar pe GET); webhook-ul
  Stripe e idempotent pe `event.id` (`seenEvent`/`rememberEvent`).
- Parametrii fiscali stau centralizat în `src/fiscalConfig.js` (datați); nu hardcoda cote — nici în
  frontend: cotele afișate și implicite vin din `META.fiscal` prin `fiscalRate`/`fiscalPct`/
  `fiscalText`/`data-rate` (`public/core.js`).
- **Escapare, după CONTEXTUL de ieșire.** Datele externe (parteneri din e-Factura/SPV, extrase
  bancare, extragere AI, nume de fișiere, mesaje de la utilizatori) ajung în patru contexte, fiecare
  cu regula lui:
  - HTML, în **text**: `escMsg` (sau `H`); în **atribut**: `escAttr` sau `H` — `escMsg` NU escapează
    ghilimelele, deci într-un atribut permite adăugarea de atribute noi;
  - XML de declarații: `esc()` din `src/xml.js` (toate cele 5 entități) — neescapat înseamnă
    declarație INVALIDĂ, adică respinsă de ANAF;
  - CSV: `src/csv.js` neutralizează formulele (`= + - @` TAB/CR) cu prefix apostrof, dar **numai
    pentru text** — sumele negative rămân numere (gardă `NUMERIC`);
  - e-mail și jurnale: sigure deja (doar `text:`, nodemailer codifică subiectul; `JSON.stringify`).
  Există patru porți în `test/frontend.mjs` (câmp extern neescapat, `escMsg` în atribut, toate
  modulele se importă, fiecare funcție folosită în șabloane e importată) și una în `test/run.js`
  (interpolare fără `esc()` în generatoarele XML). Nu te baza pe „browserul nu poate trimite asta":
  clientul nu e obligat să fie un browser.
- Migrări DB, două straturi (schema NU e SQL cu ALTER TABLE — vezi mai jos):
  - **Schema/DDL** (`schema()` din store.js/storePg.js): fiecare colecție e un tabel generic
    `id` + `firmaId` + blob `data` (TEXT/JSONB) — TOATE câmpurile trăiesc în `data`. Deci un câmp
    nou NU cere DDL (intră în blob); o colecție/index nou = o linie în `ARRAY_COLLS` / `schema()`,
    creată idempotent + aditiv (`CREATE ... IF NOT EXISTS`) la fiecare pornire. Nu există evoluție
    de schemă relațională de versionat — migrări SQL-file (`001_*.sql`) ar fi nepotrivite arhitecturii.
  - **Date** (evoluția formei câmpurilor, backfill, transformări): `src/db.js` `migrate()` =
    normalizarea idempotentă de bază (rulează integral la fiecare load); deasupra, `src/migrations.js`
    = pași **versionați** (numerotați, aplicați o singură dată, urmăriți prin `db.schemaVersion`,
    persistat în meta pe toate driverele — echivalentul tabelului `_migrations`). Hook unic la finalul
    `migrate()`. Un pas nou = `{ v, desc, up(d) }` cu `v` strict crescător; `up(d)` mută graful în loc
    și **trebuie** idempotent + data-driven (rulează și pe bază goală, și pe date deja migrate).
- Rutele care întorc colecții vii din memorie trec prin `src/paginate.js` (`sendList`): fără
  `?limit` → array simplu, dar **plafonat** la `CONTAB_MAX_ROWS` (implicit 20000, gardă contra
  OOM, cu antet `X-Rows-Truncated` când taie); cu `?limit`/`?offset` → plic `{ items, total,
  offset, limit }`. Extinde acest tipar la orice rută nouă care serializează o listă mare.
