# API Contabo — contracte pentru rutele principale

Document de referință pentru dezvoltatori, întreținut manual (decizie explicită: fără
generator OpenAPI cât timp echipa e mică — costul de întreținere nu se justifică).
Organizat pe modulele din `src/routes/`; endpoint-urile mărunte sau pur interne nu sunt
listate exhaustiv — pentru ele, sursa e ruta însăși, care după refactorizarea pe servicii
e doar un adaptor subțire ușor de citit.

Actualizat: 2026-08-26.

---

## Convenții transversale

Descrise o singură dată aici; secțiunile per modul nu le repetă.

### Autentificare și sesiuni

- Sesiune pe **cookie `sid`** (HttpOnly, SameSite=Lax, Secure), creată de `POST /api/login`.
- Orice cale `/api|/pdf|/xml|/csv|/efactura` cere sesiune — fără ea: **401** `{ "error": "Neautentificat" }`.
- Rute publice (fără sesiune): `/api/health`, `/api/login`, `/api/logout`, `/api/me`,
  `/api/register`, `/api/forgot-password`, `/api/reset/:token`, `/api/invite/:token`,
  `/api/plans`, `/api/legal-status`, `/api/demo-login`, `/api/stripe/webhook`.
- Un cont cu parolă implicită e forțat să o schimbe: până atunci are acces doar la
  `/api/me`, `/api/logout`, `/api/change-password` (restul: 403 cu `mustChange`).

### Multi-firmă (scoping)

- Toate datele poartă `firmaId`. Cererile lucrează implicit pe **firma activă** a
  utilizatorului (selectată prin `POST /api/firme/:id/activate`); rapoartele acceptă
  și `?firma=<id>` dacă utilizatorul are acces la ea.
- **Izolarea** e impusă în service layer (`reqFirma`, `reqEntry`): o resursă a altei
  firme răspunde **404 identic** cu una inexistentă (fără enumerare); o firmă invalidă
  sau inexistentă răspunde **403** — nu există fallback pe altă firmă.

### Formatul erorilor

- Erorile de business: `{ "error": "<mesaj în română>" }` cu status **400/403/404/409/429**.
- Excepții documentate: rutele care servesc **PDF/imagini** (`/pdf/*`, `GET /api/company/logo`)
  răspund cu **text**, nu JSON; dezechilibrul soldurilor inițiale adaugă câmpuri lângă
  `error` (vezi `POST /api/opening`).
- Erorile neprevăzute: **500** `{ "error": "...", "reqId": "..." }` — `reqId` corelează cu
  logul structurat.
- **402** = firma activă nu are abonament/probă validă (paywall per firmă); corpul conține
  `firmaTrialExpired`, `firmaId`, `firmaNume`.
- **428** = regimul datelor firmei este neclasificat ori acceptarea DPA pentru date reale nu mai
  este curentă. Răspunsul conține `code` și `legalMode`; clasificarea se face prin `/api/legal/mode`.

### Plafoane (rate limit)

- Login: blocare progresivă pe IP la eșecuri repetate (429 cu minutele rămase).
- Înscriere și forgot-password: 5/oră/IP (429).
- **Upload**: 60/oră/utilizator (`CONTAB_RATE_UPLOAD`); conținutul fișierului e validat pe
  magic bytes — nepotrivirea cu extensia = 400 și fișierul e șters.
- **Exporturi mari** (SAF-T, creare backup, export firmă): 10/oră/utilizator (`CONTAB_RATE_EXPORT`).
- Extragere AI: plafon zilnic/utilizator (peste el se revine tăcut la regulile locale).

### Formate

- Perioade: luni calendaristice reale `YYYY-MM`; date: date calendaristice reale `YYYY-MM-DD`;
  ani: `YYYY`. Articolele cer concordanță exactă între dată și perioadă, cel puțin o linie și sume
  finite, nenule. Sume: numere cu 2 zecimale.
- CUI: normalizat intern fără prefixul `RO` și fără spații.
- Contul demo e public și partajat: scrierile pe cont/firme sunt refuzate cu 403.

---

## Fluxul principal (cap-coadă)

1. `POST /api/login` → cookie de sesiune.
2. `POST /api/upload` (multipart, câmp `file`) → extragere AI sau reguli locale →
   `{ documentId, suggestedType, fields, cuis, source }`.
3. `POST /api/entries` cu `{ tip, fields, fileId: documentId }` → articolul contabil
   `{ ok, entry, stoc }` (liniile de stoc generează automat descărcarea la metoda firmei, CMP/FIFO).
4. Rapoartele se construiesc singure din articole: `GET /api/journal?period=`,
   `GET /api/balance?period=`, `GET /api/dashboard`, declarațiile din `GET /api/livrabile`
   și `/xml/d300?period=` etc.

---

## Autentificare & cont (`server.js`, `src/routes/account.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `POST /api/login` | `{ username, password, code?, remember? }` | `code` acceptă TOTP sau cod de rezervă one-time; `{ twofa: true }` dacă mai trebuie codul; 401 credențiale/cod greșit; 429 lockout |
| `POST /api/logout` | — | `{ ok }` |
| `GET /api/me` | — | `{ user }` sau `{ user: null }` (public) |
| `POST /api/register` | `{ nume, username, password, email, tvaPlatitor, acceptLegal:true }` | `{ ok, firma, user }` + sesiune; firma pornește `dataMode:test`; acceptarea păstrează versiunile și SHA-256-urile documentelor; 400 validări; 403 înscriere dezactivată; 429 peste 5/oră |
| `POST /api/forgot-password` | `{ login }` | mereu `{ ok, message }` generic (fără enumerare de conturi) |
| `GET /api/reset/:token` / `POST /api/reset/accept` | token din email | validare + setare parolă nouă; 400 token invalid/expirat |
| `POST /api/change-password` | `{ oldPassword, newPassword }` | `{ ok, sessionsRevoked, trustedDevicesRevoked }`; păstrează numai sesiunea curentă și invalidează dispozitivele 2FA „de încredere”; 400 parolă veche greșită / nouă slabă / identică; 409 schimbare concurentă |
| `GET /api/profile` | — | `{ username, email, role, tip, notifyDeadlines, profil }` |
| `POST /api/profile` | `{ email?, notifyDeadlines?, profil? }` | `{ ok, email, notifyDeadlines, profil }` (câmpurile profil sunt tăiate la 120 caractere) |
| `POST /api/2fa/setup` | — | `{ secret, otpauth, qrSvg }`; 400 dacă 2FA e deja activ |
| `POST /api/2fa/enable` | `{ code }` | `{ ok, recoveryCodes[8] }`; codurile în clar sunt afișate o singură dată |
| `POST /api/2fa/disable` | `{ code }` | `{ ok }`; acceptă TOTP sau cod de rezervă |
| `POST /api/2fa/recovery-codes` | `{ code }` | regenerează setul numai cu TOTP valid; `{ ok, recoveryCodes[8] }` |
| `POST /api/2fa/revoke-devices` | — | `{ ok }` — invalidează dispozitivele „ține minte" |
| `GET /api/sessions` | — | lista sesiunilor active, cea curentă marcată |
| `POST /api/sessions/logout-others` / `DELETE /api/sessions/:id` | — | `{ ok }` |
| `POST /api/onboarding/dismiss` | — | `{ ok }` — ascunde definitiv wizard-ul de primă autentificare (per cont) |
| `DELETE /api/account` | `{ confirmUsername, password }` | ștergere self-service pentru un cont care nu mai deține firme; confirmare exactă + parola curentă, pseudonimizarea auditului viu și închiderea sesiunii; 409 cât timp contul deține firme |

Rutele personale de profil, parolă, sesiuni și 2FA răspund `403` în modul de impersonare. Adminul
trebuie să revină explicit la propriul cont; impersonarea permite lucrul pe datele firmei, nu
preluarea identității și a factorilor de autentificare ai utilizatorului.

## Firme (`src/routes/firme.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET /api/firme` | — | `{ firme: [...cu _sub (starea abonamentului)], firmaActiva }` — doar firmele accesibile |
| `POST /api/firme` | `{ nume, cui?, confirmFictitious:true, ... }` | `{ ok, firma, firmaActiva }`; firma pornește în modul test; 403 demo |
| `POST /api/firme/:id` | câmpuri de firmă | `{ ok, firma }`; 403 fără acces |
| `POST /api/firme/:id/activate` | — | `{ ok, firmaActiva }` — comută firma activă |
| `DELETE /api/firme/:id` | `{ confirmName }` | `{ ok, filesDeleted }`; numai proprietarul firmei sau administratorul, cu denumirea exactă drept confirmare; elimină toate colecțiile și fișierele firmei |
| `GET /api/firme/:id/export` / `export-zip` | — | descărcare JSON / ZIP (cu fișierele documentelor); cere `data.export` pe firma cerută |
| `POST /api/firme/import` (`?mode=replace`) / `import-zip` | firmă nouă: `{ bundle, dataMode:"test", confirmFictitious:true }` sau acceptările `real`; ZIP: aceleași câmpuri multipart; `replace` cere ca firma activă să aibă deja regim juridic operațional | `{ ok, firmaId, replaced }`; `replace` suprascrie firma activă (cu plasă de siguranță pe server) |
| `POST /api/firme/:id/test-clone` | — | `{ ok, firmaId, nume }` — clonă `[TEST]` numai dintr-o sursă deja fictivă; o firmă reală nu poate fi reetichetată fără anonimizare |
| `POST /api/firme/:id/subscribe`, `GET /api/subscription`, `POST /api/subscription/*` | — | fluxul de abonare Stripe per firmă |

## Regimul juridic și AI per firmă (`src/routes/legal.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET /api/legal-status` | — | public: `{ ready, mode, missing, versions, documents, provider }`; nu expune secrete |
| `GET /api/legal` | — | starea firmei active, acceptarea curentă, dreptul de administrare și opt-in-ul AI |
| `POST /api/legal/mode` | `{ mode:"test", confirmFictitious:true }` | declară exclusiv date fictive; proprietarul firmei; revocă opt-in-ul AI anterior |
| `POST /api/legal/mode` | `{ mode:"real", acceptTerms:true, acceptPrivacy:true, acceptDpa:true }` | activează date reale numai dacă poarta globală este completă; păstrează actor/data/versiuni/hash-uri; 503 `LEGAL_READINESS_INCOMPLETE` altfel |
| `POST /api/legal/ai` | `{ enabled, confirmExternalProcessing? }` | opt-in/revocare per firmă; activarea păstrează furnizorul, modelul, scopul și documentele juridice curente |

Un import ca firmă nouă este refuzat cu 428 până când cererea declară explicit regimul; regimul și
acceptarea din pachet nu sunt niciodată considerate autoritate. Restaurarea peste firma activă este
permisă numai dacă regimul ei juridic este deja operațional. Schimbarea oricărui document juridic
schimbă hash-ul și invalidează acceptarea pentru scrieri noi pe firmele reale. AI este implicit oprit
și folosește fallback-ul local.

## Profil fiscal cu istoric (`src/routes/config.js`)

Profilul este rezolvat prin `profileAt(...)` la data operațiunii, nu din setările curente. Fiecare
revizie este o fotografie completă în tabelul `fiscal_profile_history`, cu intervalul efectiv
`validFrom`/`validTo` și momentul tranzacțional `recordedAt`. Astfel, data de la care o schimbare
produce efecte nu este confundată cu momentul în care a fost consemnată; o schimbare de regim din
2026 nu modifică retroactiv declarațiile din 2025.
Pentru o lună se folosește ultima zi a lunii, iar pentru un an data de 31 decembrie.

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET /api/fiscal-profile?asOf=` | `asOf=YYYY-MM-DD`, `YYYY-MM` sau `YYYY` | profilul normalizat valabil la data cerută, inclusiv `fiscalRevisionId`, `fiscalValidFrom`, `fiscalValidTo` și `fiscalRecordedAt` |
| `GET /api/fiscal-profile/history` | — | `{ fields, history[] }`, cu fotografiile, intervalele `validFrom`/`validTo` și `recordedAt` în ordine descrescătoare |
| `POST /api/fiscal-profile/history` | `{ validFrom, note?, changes }` | `{ ok, revision, company, history }`; `recordedAt` este stabilit exclusiv de server; cere `fiscal.manage`; 400 la dată/câmp fiscal necunoscut |
| `GET /api/fiscal-review` | — | starea reviziei externe a motorului: `{ ready, fiscalYear, approved, pending, invalid, total, sourceManifestHash, sourceFiles, runtimeRulesHash, signatureScheme, cases[] }`; fiecare caz expune hash-ul runtime și aprobarea verificată, dacă există |

`POST /api/company` acceptă în continuare câmpurile fiscale pentru compatibilitate. Interfața îi
trimite explicit data curentă prin `fiscalValidFrom`; un client API vechi care nu trimite data
păstrează semantica istorică, retroactivă. Pentru importuri sau schimbări de regim datate se
folosește ruta dedicată de istoric.

## Categoria contabilă a bilanțului (`src/balanceCategory.js`)

Categoria este calculată separat de profilul fiscal, din total active, cifra de afaceri și
numărul mediu de salariați, cu pragurile aplicabile exercițiului și regula celor două exerciții
consecutive. Deciziile sunt append-only în `balance_category_history`; o reconfirmare păstrează
revizia veche ca supersedată. Hash-ul include indicatorii anului curent și precedent, pragurile și
decizia anterioară, astfel că modificarea datelor blochează XML-ul până la reconfirmare.

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET /api/balance-category?year=` | `year=YYYY`, opțional `numarMediuSalariati=` | `{ assessment, confirmation, confirmedAndCurrent }`; calculul nu folosește `regimImpozit` |
| `GET /api/balance-category/history` | — | `{ history, labels }`, câte o decizie activă pe exercițiu |
| `POST /api/balance-category/confirm` | `{ year, category, numarMediuSalariati?, justification? }` | confirmare versionată; cere cont de contabil + `balance.category.confirm` (adminul poate remedia controlat); abaterea de la calcul sau datele neconcludente cer justificare |
| `GET /xml/bilant?year=` | — | 409 dacă lipsește confirmarea ori hash-ul ei nu mai corespunde; formularul este ales numai din confirmarea anuală |

## Permisiuni pe firmă (`src/permissions.js`, `src/routes/users.js`)

`GET /api/permissions/matrix` întoarce contractul unic `{ roles, actions }` folosit și de server,
și de interfața de administrare. Rolurile sunt `vizualizare`, `operator`, `verificator`,
`aprobator`, `proprietar`, `administrator`; acțiunile separă citirea/operarea, salariile,
trezoreria (`treasury.read|write|approve`), articolele, pregătirea și confirmarea declarațiilor,
administrarea fiscală, aprobarea/închiderea lunii, anul, exportul și echipa. Restricțiile
istorice `readonly` și `faraSalarii` se aplică peste rol. Migrarea v7 materializează o singură dată
rolul istoric `aprobator` pentru colaboratorii existenți; după migrare, lipsa unui rol explicit
înseamnă strict `vizualizare`, nu aprobare implicită.

`operator` pregătește documente, salarii, trezorerie și declarații, dar nu le confirmă și nu
închide perioade. `verificator` poate aproba articole/trezorerie și exporta. Numai
`aprobator`/`proprietar`/`administrator` confirmă depuneri și închid luna/anul. Derogarea
`control.override` și blocarea administrativă sunt rezervate administratorului; derogarea cere
motiv și produce eveniment de audit distinct.

## Documente & upload (`src/routes/documents.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `POST /api/upload` | multipart `file` (max 20 MB, extensii permise) | `{ documentId, fileName, suggestedType, fields, cuis, source: 'ai'\|'heuristic', warning?, incredere?, motiv?, calitate: { scor, decizie: 'auto'\|'revizuire', controale[], motive[] }, autoCiorna? }`; automatizarea creează cel mult o ciornă, nu postează fără verificare umană; 400 fișier lipsă/deghizat; 429 peste plafon |
| `POST /api/upload-only` | multipart `file` | `{ documentId, fileName }` — fără extragere |
| `GET /api/document/:id/file` | — | fișierul; inline doar PDF/imagini, restul attachment; 403 firmă străină; 404 |
| `GET /api/documents` | — | `[{ id, fileName, uploadedAt }]` |
| `GET /api/documents/gallery` / `emitted` | — | galeria documentelor primite (cu articolul asociat) / facturile emise (cu bază/TVA/total) |
| `GET /api/extract-quality?days=` | — | raportul calității citirii automate: `{ documenteCitite, scorMediu, eligibileAutomat, autoDraftActiv, interventii, corectii, rataCorectie, furnizori[], formate[], peControl[], peCamp[], recente[] }` — eligibilitatea poate crea numai o ciornă; grupat pe furnizor/format |
| `POST /api/xlsx-to-csv` | multipart `file` (XLSX/XLS/DBF) | `{ ok, rows, csv }` — conversie pentru importuri; 400 format nerecunoscut |

## Articole contabile (`src/routes/entries.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET /api/entries` | `?period=YYYY-MM` | articolele firmei active, sortate |
| `POST /api/entries` | `{ tip, fields, fileId?, spvMsgId?, motivRevizuire?, duplicateOverride?: { duplicateId, reason } }` | `{ ok, entry, stoc }`; liniile `fields.stoc[]` (productId+gestiuneId+cantitate) generează descărcarea CMP/FIFO atomic; 409 la stoc insuficient/recalcul retroactiv sau duplicat central. Duplicatul răspunde `{ error, code:"DUPLICATE_ENTRY", duplicateId, duplicateKeys }`; cheia facturii este direcție+CUI+serie/număr normalizat+exercițiu, suplimentată cu SPV ID/SHA-256, fără sumă/monografie. `duplicateOverride` cere `control.override` (administrator), motiv de minimum 10 caractere și `duplicateId` exact; succesul păstrează metadatele pe articol și evenimentul durabil `entry.duplicate.override`. 400 la tip/câmpuri/data invalide ori perioadă închisă; după storno, repostarea este permisă |
| `POST /api/preview` | `{ tip, fields }` | `{ ok: true, tipNume, lines, total }` — articolul **exact** cum va fi salvat, prin aceeași compunere (`composeEntry`); nu scrie nimic și nu consumă un id. Un articol încă incomplet întoarce **200** `{ ok: false, mesaj }` (e starea normală în timpul completării, nu o eroare); 400 doar fără `tip` |
| `DELETE /api/entries/:id` | — | `{ ok, removed }`; id inexistent NU e eroare (`removed: 0`); 404 articol străin; 400 perioadă închisă |
| `GET /api/recurring` / `due?period=` | — | șabloanele firmei / cele scadente în perioadă |
| `POST /api/recurring` | `{ tip, partener?, fields?, frecventa?, ziua?, startDate?, activ? }` | `{ ok, template }`; ziua e plafonată la 28 |
| `POST /api/recurring/generate?period=` | — | `{ ok, period, created, errors, items }` — idempotent pe perioadă |
| `POST /api/period-lock` (admin) | `{ lockedUntil: 'YYYY-MM' \| null }` | `{ ok, lockedUntil }`; 400 format; **404** firmă inexistentă (contract istoric) |
| `POST /api/tva-incasare/exigibilitate` | `{ brut, cota, tip?: 'deductibila', data?, partener? }` | `{ ok, tva, brut, cota, entry }` — TVA din suta mărită; 400 sumă/cotă lipsă |

## Parteneri & solduri inițiale (`src/routes/partners.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET /api/partners` | — | nomenclatorul firmei (obiect pe CUI) |
| `POST /api/partners` | `{ cui, den?, adresa?, oras?, judet?, tara?, tip? }` | `{ ok, partner }`; CUI normalizat; `tip` se păstrează la actualizare dacă lipsește; 400 CUI lipsă |
| `POST /api/partners/import` | `{ csv }` (CUI;Denumire;Adresă;Oraș;Județ;Țară;Tip) | `{ ok, importati, erori[] }` — rândurile fără CUI ajung în erori |
| `GET /api/bunuri-capital` | `?an=` | registrul bunurilor de capital (art. 305 alin. (4)) — obligatoriu prin lege. Se **derivă** din articole (imobilizare + TVA dedusă pe același articol), deci nu are rută de scriere. Perioada de ajustare începe la **1 ianuarie** al anului achiziției (alin. (2)); 20 de ani la bunuri imobile, 5 la restul; activele amortizabile sub 5 ani sunt excluse (alin. (1) lit. a). Întoarce `{ anReferinta, bunuri[], ajustari[], totaluri }` |
| `POST /api/partners/verifica-anaf` | `{ cuiuri?[], data?, actualizeazaDate? }` | `{ ok, sumar, rezultate[] }` — registrul public ANAF: inactiv (art. 11), înregistrare TVA, TVA la încasare (art. 297 alin. 2), split, e-Factura, radiere. Fără `cuiuri` verifică toți partenerii firmei; `data` dă starea la o dată anume (implicit azi), utilă pentru o factură veche; `actualizeazaDate` copiază denumirea/adresa/județul din registru (implicit **nu** — diferențele se raportează, nu se aplică tăcut). Rezultatul se păstrează pe partener și alimentează controalele din `/api/fiscal-controls` |
| `POST /api/accounts/import` (admin) | `{ csv }` (Cod;Denumire;Clasă;Tip) | `{ ok, importati, totalConturi }` — planul e global, partajat între firme, **de aceea scrierea e rezervată adminului**; 403 altfel. Primul rând e sărit dacă pare antet (conține „cont"/„cod"/„denumire") |
| `GET/POST /api/opening` | `{ openingBalances: { cont: { d, c } } }` | `{ ok, totalDebit, totalCredit }`; dezechilibru → 400 cu `totalDebit`, `totalCredit`, `diferenta` lângă `error` |
| `GET/POST /api/opening-analytic`, `DELETE /:idx` | `{ cont, partener?, cui?, d, c }` | upsert pe cheia cont+CUI; ștergerea cu index invalid NU e eroare |
| `POST /api/migrare/preview` | multipart: `file`, `sursa?`, `presetId?`, `mapare?`, `idxAntet?`, `zecimal?` | previzualizare fără scriere pentru CSV/XLS/XLSX/DBF; detectează antetul și maparea, raportează ambiguitățile și dezechilibrul |
| `GET/POST /api/migrare/presets`, `DELETE /:id` | `{ nume, antet[], mapare, sursa, zecimal? }` | formate de coloane per utilizator, maximum 20; același nume actualizează presetul; un preset străin răspunde 404 |
| `POST /api/migrare/import` | `{ firmaId, conturi[], suprascrie? }` | import atomic într-o firmă explicită; revalidează echilibrul și cere confirmare la suprascriere |
| `POST /api/migrare/complet/preview` | `{ firmaId, conturi?, parteneriCsv?, activeCsv?, stocCsv?, data?, zecimal?: ","|"." }` | validează împreună componentele fără scriere; întoarce `{ ok, problems[], summary, sample }`; reconciliază valoric fiecare cont 3xx cu stocul cantitativ |
| `POST /api/migrare/complet/import` | același corp, plus `suprascrie?` | revalidează și aplică pachetul într-o singură salvare; ținta trebuie să fie firma activă; 400 la orice componentă invalidă, 409 dacă datele selectate există și lipsește confirmarea |

## Stocuri (`src/routes/stocks.js`, `stockdocs.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET/POST /api/products`, `DELETE /:id`, `POST /api/products/import` | `{ cod, denumire, um?, cont?, grupa? }` / CSV | upsert pe cod; după prima mișcare contul nu se mai schimbă. Ștergerea este permisă numai fără mișcări; altfel produsul se dezactivează, păstrând istoricul |
| `GET/POST /api/gestiuni`, `DELETE /:id` | `{ cod, denumire, gestionar?, cont? }` | 400 la ștergere dacă are mișcări |
| `GET/POST /api/stock-movements`, `DELETE /:id` | `{ productId, tip: receptie\|iesire\|transfer, cantitate, data, gestiuneId?, pretUnitar? }` | cantitatea/data trebuie să fie valide, iar recepția cere preț pozitiv. Răspunsul expune `lipsa` când motorul nu găsește întreaga cantitate. Se șterg numai mișcările necontabilizate; una cu notă se corectează prin storno |
| `POST /api/stock-movements/:id/post` | — | `{ ok, entry, ... }` — nota 3xx=401 / 60x=3xx la metoda firmei (CMP/FIFO); 409 la descărcare parțială, 400 la transfer (intern, fără notă), stoc inițial, dublură sau perioadă închisă |
| `POST /api/stock-movements/:id/storno` | `{ data? }` | corecție append-only: mișcare inversă + notă în roșu, legate de original. Dacă nota (factură/producție) are mai multe mișcări, le neutralizează atomic pe toate. Refuză dacă eliminarea originalului ar lăsa o mișcare ulterioară fără stoc |
| `GET /api/stocks`, `/api/stocks/:id/ledger` | `?gestiune=` | stoc curent cantitativ-valoric / fișa de magazie, evaluate prin metoda firmei (CMP/FIFO) |
| `POST /api/stocks/import-initial` | `{ data, csv }` | `{ ok, importate, produseNoi, gestiuniNoi, erori, totaluri }` — preluare sold inițial, fără note contabile; data trebuie să fie reală, iar importul este refuzat după prima ieșire contabilizată |
| `POST /api/inventory`, `GET /api/inventories`, `POST /api/inventories/:id/storno` | `{ gestiuneId, data, lines:[{productId,faptic,pret?,imputa?}] }` | o singură linie/produs, faptic ≥ 0; plusul fără CMP cere cost pozitiv. Plusuri 3xx=758, minusuri 60x=3xx, imputări 4282=7588+4427; storno în roșu + mișcări inverse, fără ștergerea istoricului |
| `GET/POST /api/doc-series` | `{ NIR\|BC\|AVIZ\|CH: { serie, next } }` | seriile per firmă; numerotarea NIR/bon/aviz refolosește numărul la retipărire |

## Salarizare (`src/routes/payroll.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET/POST /api/angajati`, `DELETE /:id` | `{ nume, salariuBrut, certificateCM?, cmEligibilitate?, cmStagiuDocument?, istoricBazaCM?, ordineBeneficii?, beneficiiOrdineConfirmata?, ... }` | maximum 10 certificate CM complete și nesuprapuse; procentCM ∈ {55,65,75,80,85,100}; pentru continuări cod 01: diferențe angajator/FNUASS. Postarea refuză baza/repartizarea CM aproximată, lipsa dovezii de stagiu, cursul BNR nedefinit pentru beneficii EUR sau ordinea neconfirmată când plafonul de 33% este depășit |
| `GET /api/stat-plata?period=` | — | statul calculat; după postare întoarce fotografia activă cu `postat:true`, `entryId`, `snapshotId`, `platit` și `paymentEntryId` (`&live=1` previzualizează fișele curente, fără scriere). O fotografie stornată nu mai este selectată |
| `POST /api/stat-plata?period=` | — | `{ ok, totals, entry }` — articolul agregat + revizie salarială completă v3, legată prin `entryId`; repostarea fără storno e refuzată. 409 dacă există luni ulterioare active: se stornează în ordine inversă și se repostează cronologic. Revizia veche rămâne în audit, marcată stornată/suprascrisă |
| `POST /api/stat-plata/pay?period=&cont=` | `cont ∈ {5121, 5311}` (implicit 5121) | `{ ok, suma, cont, entry }` — plata restului (421=512x), legată prin `payrollEntryId`; cere un stat activ postat și refuză a doua plată integrală a lunii. Corecția: storno plată → storno stat |
| `GET /api/registru-salarii?year=`, `/api/dosar-cm?period=` | — | registrul anual / dosarul FNUASS; dosarul final cere stat postat (409), iar `&live=1` întoarce numai previzualizarea marcată drept ciornă |
| PDF-uri | `/pdf/stat-plata`, `/pdf/fluturas/:id`, `/pdf/registru-salarii`, `/pdf/adeverinta/:id`, `/pdf/dosar-cm` | statul, fluturașul și dosarul CM finale cer fotografia postată; `&live=1` este previzualizare vizibil marcată „CIORNĂ”, fără rubrică de semnătură; erorile sunt text, nu JSON |

`/xml/d112`, `/pdf/d112` și validarea pre-depunere D112 nu recalculează niciodată din fișa vie.
Fără o fotografie salarială activă și completă răspund cu 409/verdict invalid. Astfel, după storno
nu poate fi descărcată accidental o declarație din corecția încă nepostată.

## Plăți bancare pain.001 — EXPERIMENTAL (`src/routes/plati.js`)

> **Experimental — format nedovedit.** Exportul nu este validat față de XSD-ul oficial ISO 20022
> și nu există încă o acceptare documentată de la o bancă reală. `GET /api/plati/propuneri`
> întoarce `featureStatus`, iar descărcarea poartă statutul în antet, în numele fișierului și în
> comentariul XML. Eticheta poate fi eliminată numai după documentarea ambelor probe externe.

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET /api/plati/propuneri?tip=salarii&period=YYYY-MM` | — | propunerile folosesc `restPlata` (net minus avansuri și rețineri), nu netul brut de virat; `gata:false` dacă statul nu este postat, luna este deja plătită sau IBAN-ul lipsește/este invalid. Întoarce și `statPostat`, `salariiPlatite`, `payrollEntryId`, `snapshotId` |
| `GET /api/plati/propuneri?tip=furnizori&asOf=YYYY-MM-DD` | — | soldurile furnizorilor cu starea IBAN-ului și totalul rândurilor pregătite |
| `POST /xml/pain001` | `{ execDate, moneda?, plati:[{ beneficiar, iban, bic?, suma, detalii?, ref? }] }` | fișier **experimental** ISO 20022 `pain.001`; validează local plătitorul, beneficiarii, IBAN-urile, sumele și setul de caractere EPC, fără a pretinde validare XSD sau acceptare bancară |

## Extrase bancare și reconciliere (`src/routes/bank.js`, `src/bankStatements.js`)

Fișierul încărcat devine document justificativ persistent, cu amprentă SHA-256. Fiecare extras
din fișier păstrează IBAN-ul, moneda, intervalul și soldurile, iar fiecare tranzacție păstrează
referința băncii, data contabilizării și data valutei. Un fișier cu mai multe `<Stmt>` creează
extrase distincte, inclusiv pentru IBAN-uri și valute diferite.

| Rută | Corp / parametri | Răspuns / regulă |
|---|---|---|
| `POST /api/bank/parse` | multipart `file` — CSV, MT940 sau CAMT.053 | creează `bank_statement` + `bank_transaction`; același hash este refuzat cu 409, iar o tranzacție deja cunoscută este marcată `exclusa` cu legătură la original |
| `GET /api/bank/statements?period=YYYY-MM` | perioadă opțională | lista extraselor; fiecare include verdictul soldurilor și al dovezilor din jurnal |
| `GET /api/bank/statements/:id` | — | extrasul, tranzacțiile și reconcilierea completă |
| `PATCH /api/bank/statements/:id` | `{ iban?, currency?, openingBalance?, closingBalance?, periodFrom?, periodTo?, reason? }` | completează metadatele cu istoric append-only; suprascrierea cere motiv, intervalul trebuie să cuprindă liniile, iar IBAN/moneda se blochează după prima postare |
| `PATCH /api/bank/transactions/:id` | `{ tip, fields, stinge?[] }` | confirmă clasificarea/punctajul și trece linia în `punctata`, fără articol contabil încă |
| `POST /api/bank/import` | `{ statementId, transactions:[{ id, tip?, fields?, stinge?[] }] }` | prevalidează și postează atomic liniile selectate; cere identitate/interval/solduri complete și `sold inițial + mișcări = sold final`; tranzacțiile valutare cer curs și folosesc 5124 |
| `POST /api/bank/transactions/:id/exclude` | `{ reason, entryId? }` | excluderea cere duplicatul detectat sau un articol existent care reproduce exact suma și sensul |
| `GET /api/bank/reconciliation?period=YYYY-MM` | — | controlul cockpitului: diferență totală, extrase lipsă, tranzacții nepostate, articole 5121/5124 nelegate și continuitatea soldurilor între extrase succesive |

Stările liniei sunt `propusa → punctata → postata`; `exclusa` este o ramură justificată, nu o
ștergere. Începând cu `company.bankReconciliationFrom`, cockpitul nu permite închiderea lunii până
când diferența bancară este zero. Lunile anterioare datei de adoptare rămân accesibile fără a cere
reconstruirea retroactivă a tuturor extraselor istorice.

## Documente deschise și scadențe (`src/routes/openItems.js`, `src/openItems.js`)

| Rută | Corp / parametri | Răspuns / regulă |
|---|---|---|
| `GET /api/open-items?asOf=YYYY-MM-DD&sens=creanta|datorie` | — | documente, sold rezidual, scadență, stingeri și totaluri din jurnalul postat |
| `PATCH /api/open-items/:entryId` | `{ dueDate?, contractualTermDays?, dispute?, disputeSince?, affiliated?, guaranteed?, reason }` | PATCH parțial; păstrează câmpurile omise și adaugă versiunea veche/nouă, autorul și motivul în istoric |
| `GET /api/open-items/:entryId/history` | — | metadata curentă și versiunile auditate, în ordine descrescătoare |
| `POST /api/open-items/allocate` | `{ paymentId, allocations:[{ documentId, amount?, allocationDate? }] }` | stingeri parțiale document-cu-document, append-only și idempotente; data nu poate preceda documentul sau plata |
| `GET /api/open-items/reconciliation?asOf=` | — | punctaj registru–carte mare pe toate conturile de terți; alocările orfane/cross-partner/overflow fac verdictul invalid chiar dacă totalurile coincid |

Aging-ul, provizioanele, propunerile de plată, Nota 5 și cash-flow-ul citesc această proiecție
centrală; nu mențin solduri paralele.

## Închideri fiscale (`src/routes/closings.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `POST /api/close-vat?period=YYYY-MM` | — | `{ ok, result, lockedUntil, message? }` — postează doar regularizarea TVA; **nu blochează perioada**. `lockedUntil` rămâne în răspuns pentru compatibilitate și nu este modificat; 400 dacă perioada nu e o lună |
| `GET /api/annual-close?year=` | — | cockpitul anual derivat din dovezi: revizia externă + pașii contabili, progres, blocaje, detalii, temeiuri legale și verdictul `annual.manage` al utilizatorului |
| `POST /api/annual-inventory-control` | `{ year, control: { categories, reconciliation, governance } }` | salvează cele nouă controale de completitudine și invalidează orice aprobare anterioară; cere `annual.manage` |
| `POST /api/annual-inventory-control/approve` | `{ year }` | aprobă hash-ul exact al matricei numai după acoperirea domeniilor, punctaj/regularizare, comisie, proces-verbal și semnături |
| `POST /api/close-year?year=` | — | `{ ok, result }` sau `{ ok, message: 'Nimic de inchis.' }`; cere `annual.manage` și refuză închiderea dacă matricea inventarierii nu este completă și aprobată |
| `GET /api/profit-tax-preview`, `POST /api/close-profit-tax?year=` | `cheltNedeductibile?, deduceri?, pierdereReportata?` (query sau body) | 691=4411 o dată pe an (409 la dublă înregistrare); pierderea de reportat se memorează pe firmă și la impozit 0; pierderea explicită bate pe cea memorată; POST cere `annual.manage` |
| `GET /api/distribute-preview`, `POST /api/distribute-result?year=` | POST: `{ data?: YYYY-MM-DD }` (implicit `01-01` din anul următor) | 121→117 (profit) sau 117→121 (pierdere); articolul se postează obligatoriu în anul următor celui închis; 409 la dublură; POST cere `annual.manage` |
| `GET /api/dosar-anual/status?year=` | — | anul este închis sau nu, toate versiunile persistente și rezultatul verificării ZIP/manifest/semnătură pentru fiecare |
| `POST /api/dosar-anual/seal?year=` | `{ newRevision?, reason? }` | cere `annual.manage` și cockpit anual complet; prima sigilare este idempotentă, cererile concurente sunt serializate per firmă/an, iar o revizie cere motiv de minimum 10 caractere și păstrează versiunea anterioară |
| `GET /api/dosar-anual?year=&version=` | — | servește octeții versiunii sigilate după verificare, chiar dacă un marcaj derivat de închidere s-a pierdut ulterior; 409 dacă versiunea lipsește ori integritatea nu se confirmă; ruta nu regenerează rapoarte |

Cockpitul anual parcurge, în ordine, revizia fiscală externă, inventarierea, evaluarea, amortizarea, balanța, impozitul,
închiderea conturilor, generarea situațiilor, depunerea și repartizarea rezultatului. Starea este
recalculată din registre și articole; nu există o bifă manuală care să poată declara un pas gata
fără dovadă contabilă.

## Rapoarte & situații (`src/routes/reports.js`, `dashboard.js`)

Citiri pure pe firma activă; parametrii uzuali `?period=` / `?year=`.

- `GET /api/journal`, `/api/ledger?cont=`, `/api/balance`, `/api/fisa-cont?cont=` — registre.
- `GET /api/statements/pl|bilant|bilant-f10|cashflow|equity` — situații financiare.
- `GET /api/notes?year=` și `GET /pdf/note?year=` — cele 8 note explicative generate din
  balanță, documentele deschise, active, stocuri și politicile contabile configurate.
- `GET /api/cash-forecast/13-weeks?start=&scenario=`, `POST /api/cash-forecast/13-weeks/snapshot`
  și `GET /api/cash-forecast/13-weeks/backtest?id=` — prognoza directă, fotografia imuabilă și
  comparația cu realizatul. `GET /pdf/cash-forecast-13-weeks?start=&scenario=` exportă calculul
  live, iar `?snapshot=` exportă exact fotografia verificată, fără recalculare.
- `GET /api/analytic`, `/api/aging?asOf=` — balanța analitică și scadențarul (FIFO).
- `GET /api/dashboard` — KPI + `primiiPasi` (onboarding) + alerte e-Factura;
  `/api/dashboard-charts`, `/api/cash-forecast?months=`, `/api/missing-docs?period=`.
  Răspunsul e memoizat pe firmă și invalidat de orice scriere; antetul de diagnostic
  `X-Dashboard-Cache: hit|miss` spune care cale a servit cererea. Câmpul
  `primiiPasi.wizardAscuns` e per utilizator, deci se suprapune *după* memo.
- `GET /api/reconcile`, `/api/compensations` (+ `POST` pentru nota 401=4111).

La sigilarea dosarului anual, notele explicative intră în PDF și JSON. Fiecare fotografie de
cash-flow pe 13 săptămâni din exercițiu este verificată intern și arhivată separat în PDF și JSON;
o fotografie cu hash invalid blochează sigilarea în loc să fie împachetată drept probă validă.

### Catalogul duratelor normale de funcționare — `src/routes/assets.js`

Ajutor de completare pentru `durataLuni` la mijloacele fixe (HG 2139/2004). **Nu intră în niciun
calcul**: `src/assets.js` nu importă modulul, iar amortizarea se face în continuare din
`durataLuni` salvat pe activ. Catalogul **nu vine scris în aplicație** — anexa are sute de coduri,
iar un interval greșit ar produce ani de amortizare greșită fără să se vadă; se încarcă din anexa
oficială (vezi `src/catalogDurate.js`).

| Rută | Corp / parametri | Răspuns |
|---|---|---|
| `GET /api/catalog-durate?q=&limit=` | `q` = cod sau cuvinte din denumire | `{ total, rezultate: [{ cod, denumire, aniMin, aniMax }] }`. Fără `q` întoarce doar `total` (lista goală) — sute de rânduri nu se revarsă degeaba, dar interfața poate ști dacă e încărcat |
| `POST /api/catalog-durate/import` (admin) | `{ csv }` — `cod;denumire;ani` (`8-12`) sau `cod;denumire;aniMin;aniMax` | `{ ok, importate, total, respinse: [{ linie, cod, motiv }] }`. Catalogul e **global**, ca planul de conturi, **de aceea scrierea e rezervată adminului**; 403 altfel. Upsert pe cod. Rândurile stricate sunt **raportate cu linia din fișier**, nu înghițite |

### Închiderea lunară (cockpit) — `src/routes/monthlyClose.js`

Fluxul unic *documente → extras bancar → TVA → declarații → aprobare → blocare*. Starea fiecărui
pas se **derivă din date** (`src/monthlyClose.js`); se persistă doar alocarea, dovada validării,
aprobarea și eventuala forțare.

- `GET /api/monthly-close?period=YYYY-MM` — pașii cu `stare` (`gata|deschis|blocat|nuseaplica`),
  `blocaje[]` (motivul), `blocatDe` (pasul care îl ține), `responsabil`, `due`, plus `responsabili`
  (conturile firmei) și `validabile` (declarațiile lunii care se pot valida).
- `POST /api/monthly-close/step` `{period, step, responsabilId, due, nota}` — alocarea unui pas;
  `due: ''` revine la termenul implicit (derivat din termenul real de depunere al lunii).
- `POST /api/monthly-close/validate` `{period, tip}` — cere `entry.validate`, rulează validarea pre-depunere și **păstrează
  dovada** (cine, când, verdict, SHA-256 al XML-ului și amprenta datelor-sursă). Dacă cifrele,
  configurarea fiscală sau subregistrele se schimbă, dovada devine automat „învechită” și cere
  revalidare. Aceeași funcție ca `GET /api/validate/:type` (`src/declarationCheck.js`).
- `POST /api/monthly-close/approve` / `unapprove` `{period, nota}` — cer `close.approve`; reprezintă asumarea explicită a lunii;
  refuzată cât timp există pași nerezolvați. Aprobarea este legată de amprenta conținutului; orice
  modificare anterioară blocării sau a dovezilor XML o invalidează și versiunea veche rămâne în
  istoricul dosarului. Utilizatorul care a creat articole, a punctat banca, a completat pași ori a
  validat dovezi/declarații în lună nu își poate da singur aprobarea (`409
  SELF_APPROVAL_REQUIRED`). Numai administratorul poate consemna excepția cu
  `{override:true,motiv}` și motiv de minimum 10 caractere; contribuțiile detectate și motivul
  rămân în dosar și în audit (`control.override`).
- `POST /api/monthly-close/close` `{period, force, motiv}` — cere `close.manage` și blochează perioada. Cu pași deschiși
  se refuză (400); **doar un administrator** poate forța (`force:true`), obligatoriu cu `motiv`
  (≥10 caractere), care rămâne pe dosarul lunii și în audit (`inchidere.fortata`).
- Export: aceleași rapoarte există ca `/pdf/*` și `/csv/*` (CSV cu `;` și BOM UTF-8).

## Declarații & e-Factura (`src/routes/declarations.js`, `declarationsXml.js`, `anaf.js`)

Artefactele XML destinate depunerii și tranzițiile `transmisa`/`depusa` răspund
`409 FISCAL_REVIEW_REQUIRED` până când toate cazurile externe au aprobare validă pe hash-ul codului
curent. `GET /api/validate/:type`, rapoartele și recapitulările rămân disponibile pentru revizie.
Rectificativele trec prin aceeași poartă; istoricul deja depus rămâne integral vizibil.

- `GET /api/livrabile?period=` — borderoul lunar: ce declarații se depun și termenele.
- `GET /xml/d300|d301|d307|d311|d394|d390|d112|d100|d107|d205|saft?period=/an=` — XML-urile de declarații
  (validate structural înainte de servire; `/xml/saft` intră sub plafonul de export).
- `GET /api/d205?year=YYYY` / `GET /xml/d205?year=YYYY` — recapitularea și XML-ul anual pentru
  dividende, chirii și premii cu reținere la sursă. D205 apare automat în registrul lunii decembrie
  numai dacă raportul are beneficiari; descărcarea o marchează `generata`, iar o redepunere după
  existența unei depuneri emite automat `d_rec="1"`.
- `GET /api/d301?period=YYYY-MM` — recapitularea operațiunilor D301, pe secțiuni, cu baza, TVA-ul
  datorat și suma de control; `GET /xml/d301` refuză firmele plătitoare normal de TVA, perioadele
  fără operațiuni și antetul fără bancă/cont.
- `GET /api/d307?period=YYYY-MM` — recapitularea ajustărilor/corecțiilor/regularizărilor TVA,
  agregate pe tip (`A` transfer active, `L` leasing, `C` cod TVA anulat) și CUI operator.
  `GET /xml/d307?period=` emite totalurile semnate și varianta rectificativă automată; opțional,
  `dupaRezerva=1&temei=1|2` completează depunerea după anularea rezervei verificării ulterioare.
- `GET /api/d107?year=YYYY` — raportul anual al sponsorizărilor pe beneficiar, cu sumele acordate,
  reportate și scăzute din impozitul pe profit. `GET /xml/d107?year=` generează declarația numai
  pentru profilul de impozit pe profit și alege automat varianta rectificativă din registrul
  depunerilor.
- `GET /api/d311?period=YYYY-MM` — recapitularea operațiunilor din perioada în care codul normal
  de TVA este anulat. `GET /xml/d311?period=` generează schema IV (data anulării și OB_11…OB_52)
  sau schema V (data reînregistrării și OB_61/62), fără a permite combinarea lor.
- `GET /api/declarations` + `POST /api/declarations/set` — registrul depunerilor. Matricea autorizată
  este `nedepusa → generata → aprobata → transmisa → depusa`, cu ramurile explicate `generata/aprobata/transmisa → eroare`,
  `eroare → generata` și `nedepusa/generata/aprobata → scutita`; celelalte salturi sunt refuzate. `set` nu
  poate marca direct `aprobata` sau `depusa`. Artefactul și fiecare element din `depuneri[]` păstrează
  `profileSnapshot` și `profileHash` pentru profilul valabil în perioada declarată. Stările terminale
  nu pot fi retrogradate.
  Fiecare rând expune `dossier`: identitatea deterministă și unică pe `(firmaId, tip, period)`,
  starea de persistență, numărul de artefacte/depuneri/evenimente, hash-ul terminal și verdictul de integritate.
- `POST /api/declarations/approve` — `{ tip, period, dossierId?, artifactHash, note? }`. Este
  singura cale către `aprobata`: clientul trebuie să numească SHA-256-ul complet văzut de aprobator,
  iar serverul îl confruntă cu binarul arhivat. Dovada append-only conține dosarul, hash-ul și
  dimensiunea documentului, actorul, momentul UTC, hash-ul reviziei fiscale, legătura la aprobarea
  precedentă și propriul `approvalHash`. Retry-ul identic este idempotent. Regenerarea cu alți
  octeți revine la `generata` și cere o aprobare nouă; aprobarea veche nu este ștearsă.
  Tranziția la `transmisa` copiază exclusiv `approval.artifactHash` în câmpul imuabil
  `transmittedArtifactHash` și leagă `transmittedApprovalHash`; nu alege ultimul element din
  `artifacts[]` și nici proiecția ultimei versiuni generate.
- `POST /api/declarations/confirm-filed` (multipart: `tip`, `period`, `dossierId?`, `recipisa`,
  `file`) — singura confirmare inițială `transmisa → depusa`. Numărul și fișierul XML/ZIP/PDF al
  recipisei sunt obligatorii și se scriu atomic împreună cu depunerea; nu poate exista o proiecție
  `depusa` fără dovada exactă. Artefactul depunerii este `transmittedArtifactHash`, adică artefactul
  ales de aprobare, chiar dacă dosarul conține versiuni generate ulterior. SHA-256 și dimensiunea
  fișierului sunt recalculate înainte de scriere. Depunerea primește un `submissionId` determinist
  din dosar și ordinal, plus un `submissionHash` care sigilează semantic firma, declarația, perioada,
  ordinalul, caracterul inițial/rectificativ, artefactul transmis, aprobarea și numărul recipisei.
  Fiecare fișier de recipisă păstrează aceeași ancoră în `filingBinding`; `receiptBindingHash` acoperă
  împreună această ancoră, SHA-256-ul, dimensiunea, numele și tipul fișierului. O recipisă copiată la
  altă depunere rămâne un binar valid, dar face verificarea semantică a dosarului să eșueze.
- Fiecare schimbare este un eveniment append-only în `stateEvents[]`: secvență, stare inițială/finală,
  moment, actor, acțiunea autorizată, dovezi, `previousHash` și `hash`. Verificarea dosarului recalculează
  lanțul și validează din nou matricea, autorizația și dovezile obligatorii. Bazele anterioare sunt
  materializate onest printr-un singur `legacy.snapshot` care sigilează starea observată și hash-ul
  istoricului vechi; migrarea nu inventează tranziții retroactive. Hash-ul terminal este inclus și
  în jurnalul durabil NDJSON la fiecare generare, tranziție, depunere sau atașare, ca ancoră externă
  dosarului din baza operațională.
  Evenimentele noi folosesc schema v2 și verifică explicit `approval.recorded` plus egalitatea
  dintre hash-ul aprobat și artefactul transmis/depus. Evenimentele v1 istorice rămân verificabile
  după matricea sub care au fost create, fără a li se fabrica retroactiv aprobări de document.
- `GET /api/declarations/dosar?tip=&period=` — proiecția canonică a unui singur dosar de depunere:
  aceeași identitate reunește profilul fiscal fotografiat, artefactele, istoricul stărilor, toate
  evenimentele sigilate, depunerile/rectificativele și recipisele. `timeline[]` este proiecția
  server-side, în ordine de consemnare: evenimentele dosarului păstrează secvența, actorul și
  hash-urile compacte, iar schimbările de profil păstrează distinct `occurredAt` (`recordedAt`),
  `effectiveAt` (`validFrom`) și `validTo`. Fiecare revizie indică dacă se aplică perioadei și dacă
  fotografia ei a fost folosită de dosar/artefact/depunere; fiecare rectificativă apare separat cu
  ordinal, motiv, `submissionHash` și referințele recipiselor. Aceeași proiecție este inclusă în
  rândurile `GET /api/declarations`, pentru cronologia vizibilă din registru. Răspunsul nu include base64. `dossierId` poate fi trimis
  pe mutații și descărcări; o identitate care nu corespunde perechii declarație/perioadă este refuzată.
- `POST /api/declarations/rectificativa` (multipart: `tip`, `period`, `dossierId?`, `motiv?`,
  `tipRec?`, `recipisa`, `file`) — adaugă o depunere, nu o rescrie pe cea veche. Fișierul exact al
  recipisei este obligatoriu; pe o perioadă închisă rămâne obligatoriu și motivul scris.
- `POST /api/declarations/recipisa-file` (multipart: `tip`, `period`, `ordinal`, `file`) — păstrează
  binarul exact al recipisei cu SHA-256 pe depunerea aleasă și construiește server-side legătura
  `submissionId`/`submissionHash`/`receiptBindingHash`; clientul nu poate furniza sau schimba această
  asociere. Atașarea repetată a aceluiași binar este idempotentă. `POST /api/declarations/artifact-file`
  repară bazele istorice care aveau numai hash-ul XML-ului depus. Dacă originalul diferă de
  artefactul selectat anterior, cere motiv și păstrează ambele versiuni plus schimbarea de hash;
  istoricul nu se suprascrie. Corecția resigilează ancora depunerii și recipisele, păstrând
  `submissionBindingHistory` și `filingBindingHistory`. Sunt acceptate numai originale XML, ZIP și PDF.
- `GET /api/declarations/artifact-file?tip=&period=&ordinal=&variant=submitted|generated` și
  `GET /api/declarations/recipisa-file?tip=&period=&ordinal=&sha256=` — descarcă octeții arhivați
  ai oricărei depuneri/rectificative. Înainte de răspuns se recalculează SHA-256 și dimensiunea;
  un binar lipsă sau deteriorat este refuzat, nu regenerat din datele curente. Descărcarea trece
  și prin verificarea globală a tuturor lanțurilor și răspunde cu `X-Contab-Integrity-Root`.
- `GET /xml/efactura/:id` — factura UBL 2.1 (CIUS-RO); `GET /api/efactura-list?period=`.
- ANAF/SPV (OAuth per firmă): `GET /api/anaf/authorize|callback|config`,
  `POST /api/anaf/upload|verify`, `GET /api/anaf/inbox|spv-mesaje`,
  `POST /api/efactura/import` — importul facturilor primite ca articole.

## Mesagerie suport (`src/routes/messages.js`)

- `GET /api/messages` — utilizatorul: propriul fir (deschiderea marchează citit);
  adminul: sumarul conversațiilor. `GET /api/messages/thread/:userId` (admin).
- `POST /api/messages` — `{ text, userId? (admin) }` + atașament multipart opțional;
  max 4000 caractere; mesajul unui utilizator redeschide conversația arhivată.
- `PATCH /api/messages/:id` — doar propriile mesaje (403 altfel);
  `DELETE /api/messages/:id` (admin); `GET /api/messages/:id/file` — 403 pe firul altuia.
- `GET /api/messages/unread|poll`, `POST /api/messages/typing|archive`.

## Administrare (admin)

- `GET/POST /api/users`, `DELETE /api/users/:id`, `POST /api/invites` +
  `GET /api/invite/:token` / `POST /api/invite/accept` — conturi și invitații.
- `POST /api/impersonate` — `{ userId, password, code, reason, ticket, durationMinutes? }`;
  cere reautentificarea administratorului, cod TOTP curent (nu recovery code), motiv și tichet;
  accesul expiră automat în maximum 30 de minute și este auditat cu întregul context.
  `POST /api/impersonate/stop` îl oprește anticipat; alt admin nu poate fi impersonat.
- `POST /api/backup`, `GET /api/backups`, `GET /api/backup/file/:name`,
  `POST /api/restore` (multipart) — backup/restaurare completă. Crearea, descărcarea și preflight-ul
  restaurării folosesc același verificator global; răspunsul de creare/restaurare include
  `integrityRoot`, iar descărcarea îl pune în `X-Contab-Integrity-Root`. Arhivele `full-*.zip`
  includ `integrity/global-chain.json`, confruntat la verificare cu rădăcina recalculată din
  `db.json` și copiile jurnalului din arhivă.
- `POST /api/pg-restore-drill` — restaurează `contab.sql` din ultima arhivă într-o bază PostgreSQL
  **temporară** și verifică rezultatul (rejucare fără erori, balanța fiecărei firme, echivalență cu
  `db.json` din aceeași arhivă); baza temporară e ștearsă mereu. Răspuns:
  `{ ok, sarit?, neverificabil?, motiv?, arhiva, firme, totalEntries, randuri, durataMs }` —
  `sarit` = nu se aplică (instalare fără dump nativ), `neverificabil` = dump există dar nu poate fi
  rejucat (lipsă `psql` sau drept `CREATEDB`), caz în care rularea periodică trimite alertă.
  400 dacă nu există nicio arhivă completă.
- `GET /api/continuity-status` — verdictul fail-closed al continuității: topologia runtime
  standalone sau HA activ–pasiv, numărul declarat de replici/gazde, stocarea comună, failoverul
  PostgreSQL, prospețimea drill-urilor și copia offsite. `applicationFailoverReady` nu implică
  automat `contractualHighAvailability.supported`: acesta cere și multi-host, baza redundantă,
  probe curente și `CONTAB_HA_CONTRACTUAL=1` asumat explicit.
- `GET /api/health` — liveness public minimal; răspunde și pe standby. `GET /api/ready` — readiness
  public minimal, 200 numai pe lider și 503 pe standby. Load-balancerul folosește readiness, nu
  health. `GET /api/ha/status` — diagnostic HA complet, numai admin: rol, instanță, generație,
  expirarea lease-ului, liderul observat și declarațiile de topologie.
- `GET /api/metrics` — durate pe rută, `recentErrors`, starea joburilor **cu durata fiecărei ture**
  (`n`/`maxMs`/`avgMs`/`lastMs` — partea sincronă, singura care blochează bucla), contoare AI,
  proces (inclusiv marja față de plafonul pm2), `persist` (starea cozii de persistență) și
  `persistDurate` (cât a blocat bucla `db.save()`). Ultimele două sunt mărimi diferite, cu nume
  diferite: cât așteaptă scrierile vs. cât ține procesul pe loc. `GET /api/audit` / `/api/audit/system` — jurnalul de audit (JSON, ultimele 300;
  `?limit/offset` pentru istoric). `GET /csv/audit` / `/csv/audit/system` — export CSV (tot ce
  e reținut în baza vie, implicit maximum 20.000; sistemul doar admin). `GET /api/audit/durable`
  listează/descarcă fișierele lunare append-only, iar `/api/audit/durable/verify` verifică lanțul
  SHA-256 peste toate lunile și răspunde 409 la orice ruptură. `GET /api/integrity/global`
  (admin) întoarce verdictul comun, rădăcina SHA-256, numărătorile, ancorele, lipsurile și problemele
  localizate pentru profiluri, dosare de depunere, arhive anuale, cash-flow și audit. Exporturile
  CSV/durabile de audit sunt refuzate dacă acest verdict global nu este valid.
- `GET/POST /api/fiscal-config` — cotele fiscale configurabile (reset la standard cu
  `{ reset: true }`). Administratorii trebuie să activeze 2FA înainte de orice operațiune în afara
  configurării factorului. `GET /api/health` e public și intenționat minimal: nu expune numărul
  firmelor/utilizatorilor sau diagnostice de proces.
