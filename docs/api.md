# API Contabo — contracte pentru rutele principale

Document de referință pentru dezvoltatori, întreținut manual (decizie explicită: fără
generator OpenAPI cât timp echipa e mică — costul de întreținere nu se justifică).
Organizat pe modulele din `src/routes/`; endpoint-urile mărunte sau pur interne nu sunt
listate exhaustiv — pentru ele, sursa e ruta însăși, care după refactorizarea pe servicii
e doar un adaptor subțire ușor de citit.

Actualizat: 2026-07-16.

---

## Convenții transversale

Descrise o singură dată aici; secțiunile per modul nu le repetă.

### Autentificare și sesiuni

- Sesiune pe **cookie `sid`** (HttpOnly, SameSite=Lax, Secure), creată de `POST /api/login`.
- Orice cale `/api|/pdf|/xml|/csv|/efactura` cere sesiune — fără ea: **401** `{ "error": "Neautentificat" }`.
- Rute publice (fără sesiune): `/api/health`, `/api/login`, `/api/logout`, `/api/me`,
  `/api/register`, `/api/forgot-password`, `/api/reset/:token`, `/api/invite/:token`,
  `/api/plans`, `/api/demo-login`, `/api/stripe/webhook`.
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

- Erorile de business: `{ "error": "<mesaj în română>" }` cu status **400/403/404/429**.
- Excepții documentate: rutele care servesc **PDF/imagini** (`/pdf/*`, `GET /api/company/logo`)
  răspund cu **text**, nu JSON; dezechilibrul soldurilor inițiale adaugă câmpuri lângă
  `error` (vezi `POST /api/opening`).
- Erorile neprevăzute: **500** `{ "error": "...", "reqId": "..." }` — `reqId` corelează cu
  logul structurat.
- **402** = firma activă nu are abonament/probă validă (paywall per firmă); corpul conține
  `firmaTrialExpired`, `firmaId`, `firmaNume`.

### Plafoane (rate limit)

- Login: blocare progresivă pe IP la eșecuri repetate (429 cu minutele rămase).
- Înscriere și forgot-password: 5/oră/IP (429).
- **Upload**: 60/oră/utilizator (`CONTAB_RATE_UPLOAD`); conținutul fișierului e validat pe
  magic bytes — nepotrivirea cu extensia = 400 și fișierul e șters.
- **Exporturi mari** (SAF-T, creare backup, export firmă): 10/oră/utilizator (`CONTAB_RATE_EXPORT`).
- Extragere AI: plafon zilnic/utilizator (peste el se revine tăcut la regulile locale).

### Formate

- Perioade: `YYYY-MM`; date: `YYYY-MM-DD`; ani: `YYYY`. Sume: numere cu 2 zecimale.
- CUI: normalizat intern fără prefixul `RO` și fără spații.
- Contul demo e public și partajat: scrierile pe cont/firme sunt refuzate cu 403.

---

## Fluxul principal (cap-coadă)

1. `POST /api/login` → cookie de sesiune.
2. `POST /api/upload` (multipart, câmp `file`) → extragere AI sau reguli locale →
   `{ documentId, suggestedType, fields, cuis, source }`.
3. `POST /api/entries` cu `{ tip, fields, fileId: documentId }` → articolul contabil
   `{ ok, entry, stoc }` (liniile de stoc generează automat descărcarea de gestiune la CMP).
4. Rapoartele se construiesc singure din articole: `GET /api/journal?period=`,
   `GET /api/balance?period=`, `GET /api/dashboard`, declarațiile din `GET /api/livrabile`
   și `/xml/d300?period=` etc.

---

## Autentificare & cont (`server.js`, `src/routes/account.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `POST /api/login` | `{ username, password, code?, remember? }` | `{ ok, user }`; `{ twofa: true }` dacă mai trebuie codul; 401 credențiale/cod greșit; 429 lockout |
| `POST /api/logout` | — | `{ ok }` |
| `GET /api/me` | — | `{ user }` sau `{ user: null }` (public) |
| `POST /api/register` | `{ nume, username, password }` | `{ ok, firma, user }` + sesiune; 400 validări; 403 înscriere dezactivată; 429 peste 5/oră |
| `POST /api/forgot-password` | `{ login }` | mereu `{ ok, message }` generic (fără enumerare de conturi) |
| `GET /api/reset/:token` / `POST /api/reset/accept` | token din email | validare + setare parolă nouă; 400 token invalid/expirat |
| `POST /api/change-password` | `{ oldPassword, newPassword }` | `{ ok }`; 400 parolă veche greșită / nouă slabă / identică |
| `GET /api/profile` | — | `{ username, email, role, tip, notifyDeadlines, profil }` |
| `POST /api/profile` | `{ email?, notifyDeadlines?, profil? }` | `{ ok, email, notifyDeadlines, profil }` (câmpurile profil sunt tăiate la 120 caractere) |
| `POST /api/2fa/setup` | — | `{ secret, otpauth, qrSvg }`; 400 dacă 2FA e deja activ |
| `POST /api/2fa/enable` / `disable` | `{ code }` | `{ ok }`; 400 cod greșit sau stare nepotrivită |
| `POST /api/2fa/revoke-devices` | — | `{ ok }` — invalidează dispozitivele „ține minte" |
| `GET /api/sessions` | — | lista sesiunilor active, cea curentă marcată |
| `POST /api/sessions/logout-others` / `DELETE /api/sessions/:id` | — | `{ ok }` |
| `POST /api/onboarding/dismiss` | — | `{ ok }` — ascunde definitiv wizard-ul de primă autentificare (per cont) |

## Firme (`src/routes/firme.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET /api/firme` | — | `{ firme: [...cu _sub (starea abonamentului)], firmaActiva }` — doar firmele accesibile |
| `POST /api/firme` | `{ nume, cui?, ... }` | `{ ok, firma, firmaActiva }`; 403 demo |
| `POST /api/firme/:id` | câmpuri de firmă | `{ ok, firma }`; 403 fără acces |
| `POST /api/firme/:id/activate` | — | `{ ok, firmaActiva }` — comută firma activă |
| `DELETE /api/firme/:id` | — | `{ ok }`; 400 dacă e singura firmă |
| `GET /api/firme/:id/export` / `export-zip` | — | descărcare JSON / ZIP (cu fișierele documentelor) |
| `POST /api/firme/import` (`?mode=replace`) / `import-zip` | bundle JSON / ZIP multipart | `{ ok, firmaId, replaced }`; `replace` suprascrie firma activă (cu plasă de siguranță pe server) |
| `POST /api/firme/:id/test-clone` | — | `{ ok, firmaId, nume }` — clonă `[TEST]` + comutare pe ea |
| `POST /api/firme/:id/subscribe`, `GET /api/subscription`, `POST /api/subscription/*` | — | fluxul de abonare Stripe per firmă |

## Documente & upload (`src/routes/documents.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `POST /api/upload` | multipart `file` (max 20 MB, extensii permise) | `{ documentId, fileName, suggestedType, fields, cuis, source: 'ai'\|'heuristic', warning?, incredere?, motiv? }`; 400 fișier lipsă/deghizat; 429 peste plafon |
| `POST /api/upload-only` | multipart `file` | `{ documentId, fileName }` — fără extragere |
| `GET /api/document/:id/file` | — | fișierul; inline doar PDF/imagini, restul attachment; 403 firmă străină; 404 |
| `GET /api/documents` | — | `[{ id, fileName, uploadedAt }]` |
| `GET /api/documents/gallery` / `emitted` | — | galeria documentelor primite (cu articolul asociat) / facturile emise (cu bază/TVA/total) |
| `POST /api/xlsx-to-csv` | multipart `file` (XLSX/XLS/DBF) | `{ ok, rows, csv }` — conversie pentru importuri; 400 format nerecunoscut |

## Articole contabile (`src/routes/entries.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET /api/entries` | `?period=YYYY-MM` | articolele firmei active, sortate |
| `POST /api/entries` | `{ tip, fields, fileId?, spvMsgId? }` | `{ ok, entry, stoc }`; liniile `fields.stoc[]` (productId+cantitate) generează descărcarea la CMP atomic; 400 tip/câmpuri invalide sau perioadă închisă |
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
| `POST /api/accounts/import` (admin) | `{ csv }` (Cod;Denumire;Clasă;Tip) | `{ ok, importati, totalConturi }` — planul e global, partajat între firme, **de aceea scrierea e rezervată adminului**; 403 altfel. Primul rând e sărit dacă pare antet (conține „cont"/„cod"/„denumire") |
| `GET/POST /api/opening` | `{ openingBalances: { cont: { d, c } } }` | `{ ok, totalDebit, totalCredit }`; dezechilibru → 400 cu `totalDebit`, `totalCredit`, `diferenta` lângă `error` |
| `GET/POST /api/opening-analytic`, `DELETE /:idx` | `{ cont, partener?, cui?, d, c }` | upsert pe cheia cont+CUI; ștergerea cu index invalid NU e eroare |

## Stocuri (`src/routes/stocks.js`, `stockdocs.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET/POST /api/products`, `DELETE /:id`, `POST /api/products/import` | `{ cod, denumire, um?, cont?, grupa? }` / CSV | upsert pe cod; ștergerea curăță și mișcările |
| `GET/POST /api/gestiuni`, `DELETE /:id` | `{ cod, denumire, gestionar?, cont? }` | 400 la ștergere dacă are mișcări |
| `GET/POST /api/stock-movements`, `DELETE /:id` | `{ productId, tip: receptie\|iesire\|transfer, cantitate, data, gestiuneId?, pretUnitar? }` | ștergerea elimină și nota contabilă legată |
| `POST /api/stock-movements/:id/post` | — | `{ ok, entry, ... }` — nota 3xx=401 / 60x=3xx la CMP; 400 dacă e deja postată sau mișcare de stoc inițial |
| `GET /api/stocks`, `/api/stocks/:id/ledger` | `?gestiune=` | stoc curent la CMP / fișa de magazie |
| `POST /api/stocks/import-initial` | `{ data, csv }` | `{ ok, importate, produseNoi, gestiuniNoi, erori, totaluri }` — preluare sold inițial, fără note contabile |
| `POST /api/inventory`, `GET /api/inventories`, `POST /api/inventories/:id/storno` | `{ gestiuneId, data, lines[] }` | plusuri 3xx=758, minusuri 60x=3xx, imputări 4282=7588+4427; storno reversează tot |
| `GET/POST /api/doc-series` | `{ NIR\|BC\|AVIZ\|CH: { serie, next } }` | seriile per firmă; numerotarea NIR/bon/aviz refolosește numărul la retipărire |

## Salarizare (`src/routes/payroll.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `GET/POST /api/angajati`, `DELETE /:id` | `{ nume, salariuBrut, ... }` | valori igienizate (procentCM ∈ {75,85,100}, sector cunoscut); 400 nume/brut lipsă |
| `GET /api/stat-plata?period=` | — | statul calculat (nu scrie nimic) |
| `POST /api/stat-plata?period=` | — | `{ ok, totals, entry }` — articolul agregat + instantaneu lunar (repostarea înlocuiește luna); 400 fără angajați sau fără perioadă |
| `POST /api/stat-plata/pay?period=&cont=` | `cont ∈ {5121, 5311}` (implicit 5121) | `{ ok, suma, cont, entry }` — plata restului (421=512x); 400 rest 0 |
| `GET /api/registru-salarii?year=`, `/api/dosar-cm?period=` | — | registrul anual / dosarul FNUASS |
| PDF-uri | `/pdf/stat-plata`, `/pdf/fluturas/:id`, `/pdf/registru-salarii`, `/pdf/adeverinta/:id`, `/pdf/dosar-cm` | erorile sunt text, nu JSON |

## Închideri fiscale (`src/routes/closings.js`)

| Endpoint | Cerere | Răspuns / erori |
|---|---|---|
| `POST /api/close-vat?period=YYYY-MM` | — | `{ ok, result, lockedUntil, message? }` — postează regularizarea și **blochează perioada** (blocajul doar avansează); 400 dacă perioada nu e o lună |
| `POST /api/close-year?year=` | — | `{ ok, result }` sau `{ ok, message: 'Nimic de inchis.' }` |
| `GET /api/profit-tax-preview`, `POST /api/close-profit-tax?year=` | `cheltNedeductibile?, deduceri?, pierdereReportata?` (query sau body) | 691=4411 o dată pe an (400 la dublă înregistrare); pierderea de reportat se memorează pe firmă și la impozit 0; pierderea explicită bate pe cea memorată |
| `GET /api/distribute-preview`, `POST /api/distribute-result?year=` | — | 121→117 (profit) sau 117→121 (pierdere) |

## Rapoarte & situații (`src/routes/reports.js`, `dashboard.js`)

Citiri pure pe firma activă; parametrii uzuali `?period=` / `?year=`.

- `GET /api/journal`, `/api/ledger?cont=`, `/api/balance`, `/api/fisa-cont?cont=` — registre.
- `GET /api/statements/pl|bilant|bilant-f10|cashflow|equity` — situații financiare.
- `GET /api/analytic`, `/api/aging?asOf=` — balanța analitică și scadențarul (FIFO).
- `GET /api/dashboard` — KPI + `primiiPasi` (onboarding) + alerte e-Factura;
  `/api/dashboard-charts`, `/api/cash-forecast?months=`, `/api/missing-docs?period=`.
- `GET /api/reconcile`, `/api/compensations` (+ `POST` pentru nota 401=4111).
- Export: aceleași rapoarte există ca `/pdf/*` și `/csv/*` (CSV cu `;` și BOM UTF-8).

## Declarații & e-Factura (`src/routes/declarations.js`, `declarationsXml.js`, `anaf.js`)

- `GET /api/livrabile?period=` — borderoul lunar: ce declarații se depun și termenele.
- `GET /xml/d300|d394|d390|d112|d100|d205|saft?period=/an=` — XML-urile de declarații
  (validate structural înainte de servire; `/xml/saft` intră sub plafonul de export).
- `GET /api/declarations` + `POST /api/declarations/set` — registrul depunerilor.
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
- `POST /api/impersonate` / `POST /api/impersonate/stop` — intrare pe contul unui
  utilizator (auditată; alt admin nu poate fi impersonat).
- `POST /api/backup`, `GET /api/backups`, `GET /api/backup/file/:name`,
  `POST /api/restore` (multipart) — backup/restaurare completă.
- `POST /api/pg-restore-drill` — restaurează `contab.sql` din ultima arhivă într-o bază PostgreSQL
  **temporară** și verifică rezultatul (rejucare fără erori, balanța fiecărei firme, echivalență cu
  `db.json` din aceeași arhivă); baza temporară e ștearsă mereu. Răspuns:
  `{ ok, sarit?, neverificabil?, motiv?, arhiva, firme, totalEntries, randuri, durataMs }` —
  `sarit` = nu se aplică (instalare fără dump nativ), `neverificabil` = dump există dar nu poate fi
  rejucat (lipsă `psql` sau drept `CREATEDB`), caz în care rularea periodică trimite alertă.
  400 dacă nu există nicio arhivă completă.
- `GET /api/metrics` — durate pe rută, `recentErrors`, starea joburilor, contoare AI,
  proces (inclusiv marja față de plafonul pm2) și `persist` (starea cozii de persistență). `GET /api/audit` / `/api/audit/system` — jurnalul de audit (JSON, ultimele 300;
  `?limit/offset` pentru istoric). `GET /csv/audit` / `/csv/audit/system` — export CSV (tot ce
  e reținut, plafon 3000; arhivă / control intern / GDPR; sistemul doar admin).
- `GET/POST /api/fiscal-config` — cotele fiscale configurabile (reset la standard cu
  `{ reset: true }`). `GET /api/health` e public și intenționat minimal.
