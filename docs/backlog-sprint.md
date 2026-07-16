# Backlog sprint — iulie 2026

Backlog verificat față de codul real la 2026-07-16 (starea de pe `main`, commit 3450958).
Itemii propuși inițial care s-au dovedit deja implementați sunt listați la final, la
„Tăiat din backlog", ca să nu reapară la următoarea planificare.

Estimare totală: **10–15 zile** pentru toți cei 5 itemi; primii 4 (~8–12 zile) formează
sprintul recomandat.

Convenții de lucru (din CLAUDE.md): o ramură pe item, commit-uri tematice în română,
merge în `main` cu `--no-ff`. Orice item care atinge persistența rulează suita HTTP pe
ambele drivere (`node test/http.js` și `CONTAB_TEST_DRIVER=sqlite node test/http.js`).

---

## 1. Refactorizare rute → servicii (subsetul cu scrieri) — ✅ ÎNCHIS 2026-07-16

**Estimare:** 5–7 zile · **Realizat:** 1 zi · **Prioritate:** 1

> Toate cele 7 rute au service layer (câte o ramură + merge `--no-ff` per rută):
> `accountService`, `entriesService`, `messagesService`, `partnersService`,
> `configService`, `closingsService`, `payrollService`. Suita `test/run.js` a crescut
> de la 899 la 1003 verificări; contractele istorice sunt conservate și documentate
> în comentarii. Abateri deliberate față de plan: mesageria a primit serviciu NOU
> (`src/messages.js` rămâne pur, nu se extinde), iar `buildEntry`/`upsertPartner`
> rămân în server.js (folosite de bancă/ANAF) și intră ca dependențe.

### Descriere

Modelul de service layer există și e documentat (`src/stocksService.js`,
`src/firmeService.js`, `src/anafService.js`, cu gărzile `reqFirma`/`reqEntry`/
`reqNotDemo`/`reqAdmin` și erori purtând `err.status`), dar doar 4 din 25 de module de
rute îl folosesc. Restul scriu direct în baza de date din handler. Nu se refactorizează
tot: doar rutele cu scrieri multiple, în ordinea numărului de `db.save()` inline:

| Rută | Scrieri inline | Serviciu țintă |
|---|---|---|
| `src/routes/account.js` | 8 | `src/accountService.js` |
| `src/routes/entries.js` | 7 | `src/entriesService.js` |
| `src/routes/messages.js` | 7 | extindere `src/messages.js` |
| `src/routes/partners.js` | 6 | `src/partnersService.js` |
| `src/routes/config.js` | 6 | `src/configService.js` |
| `src/routes/payroll.js` | 4 | extindere `src/payroll.js` |
| `src/routes/closings.js` | 5 | `src/closingsService.js` |

Rutele read-only și cele cu 1–2 scrieri simple rămân cum sunt (decizie explicită, nu
omisiune).

### Cerințe tehnice

- Fiecare serviciu urmează tiparul din `src/stocksService.js`: primește `fid` explicit
  (fără fallback pe `firmaActiva`), validează prin `reqFirma()`, caută înregistrări doar
  în firma dată (`reqEntry()` — 404 identic pentru inexistent și străin), aruncă erori
  cu `err.status`.
- Ruta rămâne adaptor: parse cerere → apel serviciu → `logAudit` → răspuns prin `run(res, fn)`.
- Refactorizare pură: fără schimbări de comportament HTTP (aceleași coduri, aceleași
  corpuri de răspuns). Testele existente din `test/http.js` trebuie să treacă neatinse.
- Per serviciu nou: secțiune de teste sincrone în `test/run.js` cu `errStatus` pentru
  gărzi (autorizare pe firmă, perioadă închisă, demo).
- Un commit / o ramură per serviciu extras, ca review-ul (cubic) să rămână digerabil.

### Acceptanță

- [x] Cele 7 rute din tabel nu mai conțin logică de business — doar parse/apel/răspuns.
- [x] Fiecare serviciu are teste directe în `test/run.js` (inclusiv gărzile de autorizare).
- [x] `npm test` verde, plus `test/http.js` pe ambele drivere.
- [x] Niciun endpoint nu-și schimbă contractul (verificabil prin testele HTTP existente).

---

## 2. Protecție upload: validare de conținut + rate limit — ✅ ÎNCHIS 2026-07-16

**Estimare:** 1–2 zile · **Realizat:** ~2 ore · **Prioritate:** 2

> Implementat în `src/uploadGuard.js`: magic bytes pentru PDF/imagini + verificare
> „fără NUL" pentru text; containerele (.xlsx/.xls/.zip/.dbf) rămân deliberat pe
> validarea parserului (variante istorice multe, nu se servesc inline). Plafoane per
> utilizator: upload 60/oră (`CONTAB_RATE_UPLOAD`), exporturi mari 10/oră
> (`CONTAB_RATE_EXPORT`, pe SAF-T + backup + export firmă). Plafonul AI exista deja
> (zilnic, per utilizator, în documents.js) — punctul din plan era deja acoperit.

### Descriere

Upload-ul are deja limită de 20 MB și allowlist de extensii care blochează HTML/JS/SVG
(`server.js`, `UPLOAD_EXT_OK`). Două goluri reale:

1. **Extensia nu garantează conținutul** — un fișier `.pdf` poate fi orice; extractorul
   și Claude API primesc conținut nevalidat.
2. **Niciun plafon de frecvență** pe upload și pe exporturile costisitoare (SAF-T, PDF-uri
   mari) — un cont autentificat poate satura discul sau bugetul de API AI.

### Cerințe tehnice

- Validare magic bytes după salvarea multer, înaintea procesării: PDF (`%PDF`),
  PNG/JPEG/WebP/GIF (semnăturile standard), CSV/TXT (euristică text). Nepotrivire
  extensie/conținut → 400 cu mesaj clar + ștergerea fișierului de pe disc.
- Rate limit per utilizator (nu per IP — utilizatorii sunt autentificați) pe:
  - upload documente: plafon generos (~60/oră) — nu deranjează contabilul, oprește abuzul;
  - extragere AI: plafon separat, mai strâns (cost extern);
  - exporturi mari (SAF-T, backup): ~10/oră.
- Refolosește tiparul existent de rate limit din `server.js` (map + job
  `rate-limit-hygiene` din `safeInterval`), nu o dependență nouă.
- Depășire → 429 cu mesaj în română, ca la login.

### Acceptanță

- [x] Un fișier `.pdf` cu conținut non-PDF e respins cu 400 și nu ajunge la extractor
      (nici pe disc după respingere).
- [x] Depășirea plafonului răspunde 429; sub plafon, comportamentul e neschimbat.
- [x] Teste în `test/http.js`: fișier deghizat respins, al N+1-lea upload primește 429.
- [x] Map-urile noi de rate limit sunt curățate de jobul de igienă existent.

---

## 3. Wizard de primă autentificare — ✅ ÎNCHIS 2026-07-16

**Estimare:** 1–2 zile · **Realizat:** ~2 ore · **Prioritate:** 3

> Overlay de bun venit peste dashboard pentru firmele fără nicio înregistrare,
> cu pașii checklist-ului „Primii pași" (extins cu „Adaugă primul partener");
> `primiiPasi` expune în plus `arePartener`/`areProdus`/`wizardAscuns`. „Mai târziu"
> persistă pe cont prin `POST /api/onboarding/dismiss` (accountService). Verificat
> vizual pe instanță dev izolată cu Playwright în Docker (overlay apare / se
> ascunde / rămâne ascuns după reload).

### Descriere

Piesele există deja: checklist-ul „Primii pași" pe dashboard
(`src/routes/dashboard.js`, `primiiPasi`), wizard-ul „Înregistrează ghidat" pentru tipul
de operațiune (`public/app.js`), importuri de parteneri/produse, seed demo. Planul de
conturi e built-in (`src/chartOfAccounts.js`) — nu necesită import. Ce lipsește: un flux
care **leagă** pașii pentru un utilizator nou, în loc să-l lase să-i descopere singur.

### Cerințe tehnice

- Extinde `primiiPasi` din `/api/dashboard` cu pașii lipsă: date fiscale complete
  (CUI + plătitor TVA + serie facturi), cel puțin un partener, cel puțin un produs
  (doar dacă firma are activitate de stocuri).
- Frontend: overlay/panou pas-cu-pas afișat când `primiiPasi` indică firmă goală;
  fiecare pas deschide direct formularul existent (nu duplică formulare). Buton
  „mai târziu" care îl retrogradează la checklist-ul discret existent pe dashboard.
- Starea „văzut/ascuns" per utilizator, persistată (nu localStorage — utilizatorul
  poate schimba browserul).
- Fără framework — vanilla JS, în stilul modulelor din `public/`.
- Condiția de afișare derivă din datele reale ale firmei (ca `primiiPasi` acum), nu
  dintr-un flag „prima autentificare" — astfel funcționează și pentru firme noi ale
  utilizatorilor vechi.

### Acceptanță

- [x] Un utilizator nou cu firmă goală vede wizard-ul la autentificare și poate ajunge
      la primul document înregistrat în sub 10 minute doar urmând pașii.
- [x] Wizard-ul nu apare pentru firme cu date suficiente și nici după ce a fost închis
      explicit (persistent între sesiuni/browsere).
- [x] Test în `test/http.js` pentru pașii noi din `primiiPasi` (pe modelul testului
      existent de onboarding).
- [x] Verificare vizuală prin skill-ul `run-app` (instanță dev izolată, nu producția).

---

## 4. Loguri de business: upload + extragere AI — ✅ ÎNCHIS 2026-07-16

**Estimare:** 1 zi · **Realizat:** ~1 oră · **Prioritate:** 4

> `document.upload` în audit (nume + KB + sursa extragerii, fără conținut), plus
> `bank.parse`/`bank.import` pentru extrasul bancar. Apelurile AI sunt cronometrate:
> contoare `n/fail/avgMs/lastError` în `/api/metrics` (secțiunea `ai`) și log
> structurat cu `reqId` la succes/eșec. Instrumentarea stă în rută, în jurul
> apelului — `aiExtractor.js` neatins.

### Descriere

Auditul (`logAudit`) acoperă ~80 de acțiuni, dar exact zona cu cost extern e oarbă:
nu există `document.upload` și nici o urmă pentru extragerea AI (succes/eșec/durată/
dimensiune). La un incident de cost API sau la un document „pierdut", singura urmă e
logul generic de cereri.

### Cerințe tehnice

- `logAudit('document.upload', …)` în `src/routes/documents.js`: nume fișier, dimensiune,
  tip detectat, firmă.
- În `src/aiExtractor.js`, prin `src/log.js`: început/sfârșit extragere cu durată,
  model, dimensiune document, succes/eșec + motiv (`log.info`/`log.warn` cu `log.ctx`).
  Atenție la conținut: se loghează metadate, niciodată textul documentului.
- Contor simplu în `src/metrics.js` pentru extragerile AI (număr, eșecuri, durată medie),
  expus în `GET /api/metrics` — intră automat și în raportul zilnic de performanță.
- Fără logare de date personale din documente (doar identificatori și metadate).

### Acceptanță

- [x] Fiecare upload apare în audit cu utilizator, firmă și metadatele fișierului.
- [x] O extragere AI eșuată e localizabilă în log după `reqId`, cu motivul eșecului.
- [x] `/api/metrics` expune contoarele AI; testul de metrics din `test/http.js` extins.
- [x] Zero conținut de document în loguri (verificat în review).

---

## 5. Documentare API / contracte

**Estimare:** 2–3 zile · **Prioritate:** 5 (poate aluneca în sprintul următor)

### Descriere

`docs/arhitectura.md` descrie modulele și menționează multe endpoint-uri inline, dar nu
există un contract per endpoint (parametri, formatul răspunsului, erori). De făcut
**după** itemul 1 — refactorizarea stabilizează exact contractele care se documentează.

### Cerințe tehnice

- Un fișier nou `docs/api.md`, organizat pe module (ca `src/routes/`), pentru rutele
  principale: autentificare/cont, firme, documente + upload, entries, rapoarte,
  declarații, stocuri, salarizare.
- Per endpoint: metodă + cale, parametri (query/body), formatul răspunsului de succes,
  erorile posibile cu status (400/401/403/404/409/429) și forma `{ error: '…' }`.
- Documentează convențiile transversale o singură dată, la început: autentificarea pe
  sesiune, scoping-ul pe firmă activă, tiparul de erori, rate limit-urile.
- În română cu diacritice (e în `docs/`), ținut sincron manual — fără generator
  OpenAPI deocamdată (decizie explicită: costul de întreținere nu se justifică la
  dimensiunea actuală a echipei).

### Acceptanță

- [ ] Rutele principale au contract documentat (parametri, răspuns, erori).
- [ ] Un dezvoltator nou poate urmări fluxul upload → extragere → articol contabil →
      raport doar din document.
- [ ] Convențiile transversale sunt descrise o dată, nu repetate per endpoint.

---

## Tăiat din backlog (deja implementat, verificat în cod)

- **Dashboard KPI** — `rep.dashboard()` (`src/reporting.js`) livrează TVA de plată/
  recuperat, solduri clienți/furnizori cu top 5, numerar/bancă, venituri/cheltuieli/
  profit cu variație an-la-an; rute separate pentru grafice, aging, cash-forecast,
  documente lipsă. Frontend în `public/dashboard.js`.
- **CI/CD** — `.github/workflows/ci.yml`: lint + teste pe Node 22/24, plus suita HTTP
  pe PostgreSQL real (paritate cu producția) la fiecare push/PR. `test/http.js`
  pornește serverul real, deci depășește un smoke test. Rest posibil: un Dockerfile —
  neinclus deliberat, producția rulează pe pm2 pe acest server.
- **Rate limit pe autentificare** — login cu anti-brute-force și 429, înregistrare
  5/oră/IP, forgot-password plafonat (commit 9b5b8ba), job de igienă a map-urilor.
- **Limite de upload** — 20 MB + allowlist de extensii care blochează fișierele active
  (HTML/JS/SVG). Rămâne doar validarea de conținut (itemul 2).
- **Observabilitate de infrastructură** — `src/log.js` structurat (reqId, mod JSON),
  `/api/metrics` cu durate pe rută + `recentErrors` + starea joburilor, raport zilnic
  `scripts/perf-report.sh`. Rămân doar logurile de business (itemul 4).
- **Import plan de conturi** — non-task: planul de conturi RO e built-in
  (`src/chartOfAccounts.js`).
