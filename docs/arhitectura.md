# Arhitectură, multi-firmă și utilizatori

## Arhitectură

- `server.js` — asamblarea aplicației: înregistrarea modulelor de rute cu ctx + `composeEntry`/`buildEntry`.
  `composeEntry` construiește articolul complet **fără identitate**; `buildEntry` adaugă id-ul din
  secvență. Separarea există pentru ca previzualizarea din formular (`POST /api/preview`) să treacă
  prin **exact aceleași reguli** ca salvarea — inclusiv cele care depind de firmă (pro-rata, TVA la
  încasare, auto 50%, perioade blocate) — fără să consume un id. Regulile contabile au astfel o
  singură implementare: frontend-ul nu le mai reproduce.
  **Conturile se verifică însă în altă parte.** `composeEntry` refuză liniile cu conturi din afara
  planului, dar păzește o singură cale: 21 de locuri împingeau direct în `d.entries` și o ocoleau —
  așa a scris amortizarea lunară, ani la rând, pe conturi inexistente care plecau drept
  „(cont necunoscut)” în SAF-T, la ANAF. Astăzi **orice** articol intră prin `db.pushEntry`
  (`src/db.js`), care validează conturile și aruncă o eroare cu `status: 400` purtând contul vinovat
  și contextul (`amortizare lunara`, `import extras bancar`…). O poartă din `test/run/porti.js`
  refuză reapariția lui `entries.push(` oriunde în afara lui `src/db.js`, iar o a doua verifică
  faptul că punctul unic chiar *refuză* — fără ea, golirea verificării trecea suita verde, fiindcă
  cele două mecanisme se masau reciproc.
  Infrastructura stă în module dedicate: `src/bootstrap.js` (middleware + garduri de acces),
  `src/authRoutes.js` (nucleul de autentificare), `src/jobs.js` (joburile periodice),
  `src/serverErrors.js` (erori globale + alertă), `src/lifecycle.js` (lock, listen, oprire curată).
- `src/chartOfAccounts.js` — planul de conturi (clasele 1–8) + regula debit/credit.
- `src/documentTypes/` — tipurile de documente și formulele contabile, pe module tematice
  (vânzări, cumpărări, trezorerie, salarii…); `index.js` le asamblează în ordinea din UI,
  `helpers.js` ține câmpurile comune și constructorul de linii contabile.
- `src/extractor.js` — extragere text din PDF (pdf-parse + pdf2json) și euristici RO.
- `src/fiscal.js` — parametri fiscali 2026 + calculul salariului din brut (CAS/CASS/impozit/CAM).
- `src/aiExtractor.js` — extragere cu Claude API (document PDF + ieșire structurată).
- `src/reporting.js` — livrabile (oglinda borderoului de primire): recap D112/D300/D100, obligații ANAF, registru-inventar.
- `src/xml.js` — generare XML: e-Factura UBL 2.1 (CIUS-RO) pentru facturi emise, D300 și D394 (format ANAF).
- `src/saft.js` — generare SAF-T (D406): Header + MasterFiles (conturi, clienți, furnizori, TVA, mijloace fixe) + GeneralLedgerEntries + SourceDocuments.
- `src/assets.js` — registrul de mijloace fixe + amortizare liniară/degresivă/accelerată (calcul lunar, plan, înregistrare 6811=281x).
- `src/stocks.js` — gestiunea stocurilor cantitativ-valoric la cost mediu ponderat (CMP): fișă de magazie, stoc curent.
- `src/stocksService.js` — **service layer** pentru scrierile de stocuri (nomenclatoare, mișcări,
  postare notă, stoc inițial, inventariere/storno): rutele din `src/routes/stocks.js` sunt doar
  puncte de intrare; validarea, regulile și **autorizarea pe firmă** (`reqFirma` + căutări doar în
  firma dată, erori cu `status` HTTP) stau în serviciu — model de urmat la extragerea altor rute groase.
- `src/payroll.js` — salarizare: nomenclator angajați (cu **spor** impozabil, **avans** → 425 și
  **rețineri** din net → 427) + stat de plată per angajat (CAS/CASS/impozit/CAM, rest de plată),
  PDF stat + **fluturaș per
  angajat** (`/pdf/fluturas/:id`) + articol contabil agregat + **D112 XML** (tab „Salarizare").
  API: `GET/POST/DELETE /api/angajati`, `GET/POST /api/stat-plata`. **Plata efectivă** a salariilor
  (rest de plată → `421 = 5121`/`5311`) cu un click: `POST /api/stat-plata/pay?period=&cont=`.
  La fiecare înregistrare a statului se salvează un **instantaneu lunar** (`payrollHistory`), din care
  se construiește **registrul anual de salarii** (cumul per angajat, bază pentru adeverințe de venit):
  `/api/registru-salarii?year=`, `/pdf/registru-salarii?year=`. Din registru se generează
  **adeverința de venit** per angajat (`/pdf/adeverinta/:id?year=`) — venit brut/net anual + contribuții,
  cu formular oficial și rubrici de semnătură.
- `src/accounting.js` — jurnal, carte mare, balanță, închideri TVA/anuală.
- `src/analytic.js` — balanță analitică pe partener/etichetă + **scadențar cu vechimea soldurilor (aging)**:
  solduri restante per partener, repartizate pe intervale **0-30 / 31-60 / 61-90 / >90 zile** prin
  stingere FIFO a facturilor cu plățile (factura cea mai veche se stinge prima), la o dată de referință
  (`?asOf=`). `/api/aging`, `/pdf/aging`, `/csv/aging`, card în tab-ul Analitic.
  Pe baza creanțelor &gt;90 zile se poate înregistra **ajustarea pentru deprecierea creanțelor**
  (`6814 = 491`, sau reluare `491 = 7814` la diminuare), cu procent configurabil; `/api/provizion`.
  Vechimea are **două praguri, cu roluri diferite**: 90 de zile pentru ajustarea *contabilă*
  (judecată de depreciere) și grupa `b270plus` pentru *baza fiscală* (art. 26 alin. (1) lit. c).
  A doua e o **submulțime** a lui `b90plus`, nu o grupă alături de ele: cele patru grupe rămân
  disjuncte și se adună la total, ca scadențarul afișat să nu se schimbe pentru o nevoie fiscală.
  Creanțele neîncasabile se pot **scoate din evidență** direct din scadențar (buton „scoate"):
  `654 = 4111` (pierdere) + reluarea automată a ajustării aferente `491 = 7814`; `/api/writeoff`.
- `src/temeiLegal.js` — **temeiul legal al fiecărui pas din ciclul contabil**, sursă unică pentru
  cockpitul de închidere lunară, tabul de închidere a anului, ghid și documentație. Structura
  răspunde la trei întrebări: ce fac (pasul), de ce sunt obligat (actul + articolul), ce anume
  prevede (rezumatul). Două reguli de redactare, ambele păzite de o poartă din suită: articolul se
  scrie cât de precis se poate **susține** (unde alineatul nu e sigur, rămâne doar articolul — o
  trimitere falsă e mai rea decât una lipsă); iar aici **nu stau termene și nu stau cote** — au
  sursele lor (`declarations.dueDate`, `fiscalConfig`), iar o cifră copiată ar deveni a doua sursă
  de adevăr și s-ar învechi tăcut. Cheile fazei „lunar" trebuie să coincidă exact cu pașii din
  `monthlyClose.STEPS`, altfel un pas nou ar apărea fără temei. `GET /api/temei-legal[?faza=]`.
- `src/ajustari.js` — ajustările pentru depreciere: harta **explicită** cont de activ → cont de
  ajustare (39x stocuri, 29x imobilizări) + contul de cheltuială/venit (6813/7813 la imobilizări,
  6814/7814 la active circulante). Nu compune coduri din cifre: ce nu e în hartă nu are ajustare și
  se spune răspicat — lecția de la conturile de amortizare, unde `'281' + cifră` producea conturi
  inexistente care plecau în SAF-T. Sursă unică pentru monografii, pentru propunerea din
  registrul-inventar și pentru încadrarea fiscală pe familii.
- `src/statements.js` — cont de profit și pierdere, bilanț.
- `src/pdf/` — generarea rapoartelor PDF (PDFKit), spart pe domenii: `index.js` (compunerea),
  `registre.js`, `declaratii.js`, `facturare.js`, `salarii.js`, `imobilizari.js`, `helpers.js`.
- `src/csv.js` — export CSV compatibil Excel (separator `;`, BOM UTF-8) pentru mișcări de stoc,
  stoc curent, registrul-jurnal, balanță, **cartea mare** (cu sold inițial/final și mișcări),
  **balanța analitică** și **parteneri** (`/csv/stock-movements`, `/csv/stocks`, `/csv/journal`,
  `/csv/balance`, `/csv/ledger`, `/csv/analytic`, `/csv/partners`); butoane „⬇ CSV” în tab-uri.
- `src/db.js` — stratul de persistență, cu driver comutabil prin `CONTAB_DB_DRIVER`:
  **`sqlite`** (implicit, `src/store.js`, `node:sqlite`), **`pg`** (PostgreSQL, `src/storePg.js`,
  pachetul `pg`) sau **`json`** (vechi, doar `data/db.json` — exclusiv rollback de urgență; testele
  și instanțele de dev rulează implicit pe `sqlite`). Indiferent de driver,
  aplicația lucrează pe același graf în memorie; driverele relaționale păstrează în plus o
  **oglindă `data/db.json`** pentru backup și rollback. Vezi „Baze de date” mai jos.
- `public/` — interfața web (HTML/CSS/JS vanilla).
- **Aspectul clasic de aplicație de contabilitate** (`public/erp.css` + `public/erp.js`) — **singurul
  aspect**, pe ecrane de la 901px în sus. E un **strat peste același DOM**, nu o a doua interfață: `erp.js`
  pune clasa `erp` pe `<body>` și injectează chrome-ul de birou (bară de titlu, bară de meniu,
  bandă de unelte, bară de stare, bară de titlu pe fiecare ecran), iar `erp.css` îmbracă restul —
  densitate mare, colțuri drepte, grile cu chenar pe fiecare celulă, etichete la stânga câmpurilor.
  Nicio regulă de afaceri nu trece pe aici: elementele de meniu **reemit clicuri** pe butoanele
  reale din `#tabs`, iar selectorul de firmă și navigarea pe luni sunt **mutate**, nu duplicate —
  deci drepturile, modul simplu și ascunderile din `app.js` rămân singura sursă de adevăr.
  Comutatorul de aspect („🌐 Aspect modern” / „🖥️ Aspect clasic”, cu alegerea în `localStorage`,
  cheia `contab.aspect`) **a fost scos în august 2026**: aspectul clasic e singurul, deci n-are către
  ce comuta, iar cheia rămasă în browserele care apucaseră să comute e inertă — nimic n-o mai
  citește, deci nu poate lăsa pe nimeni blocat în celălalt aspect. Sub 901px stratul nu se montează
  deloc; acolo rămâne așezarea din `styles.css`.

## Multi-firmă

Aplicația gestionează **mai multe firme** în aceeași instanță:
- Tabelul `firme` (în `data/db.json`) ține firmele; câmpul **`firmaId`** este adăugat la
  toate înregistrările (entries, documents, partners, solduri inițiale sintetice și analitice).
- **Firma activă** se alege din selectorul din bara de sus; toată aplicația (rapoarte, jurnale,
  balanță, declarații, parteneri, reconciliere, dashboard) este filtrată automat pe ea, printr-o
  „vedere” scoped — modulele de raportare nu au fost modificate.
- Gestionarea firmelor (activare, ștergere) e în Setări → „Firmele mele”.
- **Două feluri de cont la înscriere** (`POST /api/register`, câmpul `tipCont`), pentru că oamenii
  intră în aplicație din două direcții: **patronul** vine cu firma lui, deci contul și firma se
  creează deodată; **contabilul** vine să țină contabilitatea altora, deci contul se creează
  **fără nicio firmă** (`firme: []`, `firmaActiva: null`) și, dacă acceptă bifa, intră direct în
  lista de contabili. A-l obliga să inventeze o firmă la înscriere ar fi produs exact dublurile
  împotriva cărora e construită poarta pe CUI. „Fără nicio firmă" e o stare distinctă de „probă
  expirată" (`user.faraFirma` în `/api/me` și `/api/meta`) — altfel contul nou ateriza pe bannerul
  de read-only și pe ecranul de prețuri, despre un abonament pe care nu-l are. Alegerea se
  stochează (`user.tipCont`) și decide ce se oferă în Setări → „Adaugă o firmă la contul tău":
  patronului i se deschide formularul de **înscriere a unei firme proprii**, contabilului îi
  rămâne **cererea de acces** (formularul propriu e la un rând de text distanță — un contabil are
  adesea și firma lui). Conturile dinaintea câmpului sunt clasificate de migrarea **v4**, din
  realitate: cine e proprietarul unei firme e patron.
- **O firmă, o singură evidență.** Fiecare firmă are un **proprietar** (`firma.ownerId` — contul
  care a înscris-o). O firmă se înregistrează o singură dată: `POST /api/firme` și înscrierea
  publică refuză cu **409** un CUI deja folosit și trimit spre cererea de acces (aceeași gardă
  și la schimbarea CUI-ului unei firme existente, altfel poarta s-ar ocoli în doi pași). Ca să
  poți deține firme, contul trebuie să aibă **CNP** valid în profil — proprietarul e o persoană
  identificată, nu doar un nume de utilizator. Codurile se validează cu cifra de control
  (`src/identitate.js`).
- **Două căi de a primi acces la o firmă, ambele prin acord explicit** — decide de fiecare dată
  celălalt, nu cel care cere:
  - **contabil → patron** (`accessRequests`): contabilul cere acces după CUI, proprietarul aprobă.
    Răspunsul e identic fie că firma există sau nu (fără enumerare).
    `POST /api/firme/cerere-acces` · `GET /api/firme/cereri` · `POST /api/firme/cereri/:id`.
  - **patron → contabil** (`serviceRequests`): patronul alege din **lista contabililor înscriși**
    (opt-in explicit: `profil.disponibilContabil`) și trimite o cerere de servicii; contabilul
    acceptă sau refuză, și abia atunci primește acces.
    `GET /api/firme/contabili` · `GET/POST /api/firme/servicii` · `POST /api/firme/servicii/:id` ·
    `POST /api/firme/servicii/:id/retrage`.
- Bazele vechi (o singură firmă, fără `firmaId`) sunt **migrate automat** la prima pornire.
- e-Factura, D300/D394 și trimiterea în SPV folosesc datele firmei căreia îi aparține înregistrarea.
- API: `GET/POST /api/firme`, `POST /api/firme/:id`, `POST /api/firme/:id/activate`,
  `DELETE /api/firme/:id`; orice rută acceptă și `?firma=ID` pentru a forța o firmă anume.
- **Export / import firmă** (migrare/arhivare): `GET /api/firme/:id/export` descarcă un pachet JSON cu
  toate datele firmei; `POST /api/firme/import` îl încarcă **ca firmă nouă**, remapând toate id-urile
  și referințele interne (entries↔mișcări, produse, gestiuni, mijloace fixe, angajați, inventare,
  istoric salarii). Buton în Setări → Firme.

## Utilizatori și autentificare

Aplicația cere **login** și aplică **drepturi pe firmă**:
- Tabelul `users` în `data/db.json`: `{ id, username, salt, hash, role, firme[] }`. Parolele sunt
  hash-uite cu **scrypt** + salt; sesiunea e un **cookie semnat HMAC** (`sid`, HttpOnly, 7 zile).
- Roluri: **admin** (vede toate firmele, gestionează utilizatori) și **user** (vede doar firmele
  alocate). Toate rutele `/api`, `/pdf`, `/xml` sunt protejate; rapoartele sunt filtrate pe firma
  activă a utilizatorului, iar `?firma=ID` e ignorat dacă nu are acces.
- La prima pornire se creează automat **admin / admin** (schimbă parola imediat din Setări →
  „Schimbă parola”; aplicația te avertizează).
- Gestionarea utilizatorilor (adăugare, rol, firme alocate, resetare parolă) e în Setări →
  „Utilizatori” (doar admin). Module: `src/auth.js`.
- API: `POST /api/login` · `POST /api/logout` · `GET /api/me` · `POST /api/change-password` ·
  `GET/POST /api/users` · `POST /api/users/:id` · `DELETE /api/users/:id`.
- **Cookie Secure automat pe HTTPS:** serverul citește `X-Forwarded-Proto` de la reverse proxy
  (`trust proxy`); pe HTTPS cookie-ul de sesiune primește flag-ul `Secure`, pe HTTP nu (ca să
  funcționeze și acum, înainte de certificat).
- **Jurnal de audit** (`audit` în db): acțiunile importante (creare/ștergere înregistrări,
  închideri, firme, utilizatori, login) cu autor, firmă și dată. Vizibil în Setări → „Jurnal de
  audit” (adminul vede tot, userul doar firmele lui). `GET /api/audit`.
- **Invitații prin link:** adminul creează o invitație (Setări → „Utilizatori” → „Trimite
  invitație”); rezultă un link `/?invite=TOKEN` pe care îl trimite (manual sau pe email dacă SMTP
  e configurat în `settings.smtp`). Invitatul deschide linkul, își setează parola și e autentificat.
  API: `POST /api/invites` · `GET /api/invite/:token` · `POST /api/invite/accept`.
- **SMTP real:** Setări → „Server email (SMTP)” (admin) configurează host/port/SSL/user/parolă/from;
  când e completat, invitațiile se trimit automat pe email (prin `nodemailer`). `GET/POST /api/smtp`.
- **Expirarea invitațiilor:** fiecare invitație expiră în **7 zile** (`inviteExp`); după expirare
  linkul nu mai funcționează și adminul trebuie să trimită altul.
- **2FA (TOTP):** Setări → „Autentificare în doi pași” — activezi cu o aplicație de autentificator
  (Google Authenticator/Authy/FreeOTP), scanezi codul (sau introduci secretul) și confirmi cu un cod.
  La login se cere codul de 6 cifre sau unul dintre cele opt coduri de rezervă one-time. Codurile
  de rezervă se afișează numai la creare/regenerare și se păstrează în bază doar ca hash-uri;
  regenerarea cere un TOTP curent și invalidează întreg setul vechi. Implementare standard RFC
  6238 fără dependențe externe (`src/totp.js`). API: `POST /api/2fa/setup` ·
  `/api/2fa/enable` · `/api/2fa/disable` · `/api/2fa/recovery-codes`.
- **Anti-brute-force la login:** după 8 încercări eșuate de pe același IP, login-ul e blocat ~15
  minute (răspuns `429`). Contorul se resetează la prima autentificare reușită.
- **„Remember device” pentru 2FA:** la login cu cod poți bifa „Ține minte acest dispozitiv 30 de
  zile” → un cookie semnat `tfd` sare peste codul 2FA pe acel dispozitiv. „Revocă dispozitivele de
  încredere” (sau dezactivarea 2FA) le invalidează pe toate (`tfdEpoch`).
- **Backup automat al bazei de date:** Setări → „Backup” (admin) — buton „Fă backup acum”, listă cu
  descărcare, și **backup automat zilnic**. Mecanism: `src/backup.js` (`backupNow`) copiază `data/db.json`
  în `data/backups/db-YYYYMMDD-HHMMSS.json` și păstrează ultimele 30. Rularea zilnică e făcută de
  `scripts/backup.js` printr-un **cron** (`30 3 * * * node /var/www/contab/scripts/backup.js`,
  log în `data/backups/backup.log`). API: `POST /api/backup` · `GET /api/backups` ·
  `GET /api/backup/file/:name` · `POST /api/backups/auto`.
- **Monitorizare:** `GET /api/health` (public) confirmă că procesul și baza răspund;
  `scripts/healthcheck.sh` rulează din cron la 5 minute și trimite **alertă pe email** (Resend)
  când aplicația nu răspunde (max. una pe oră). Pentru căderi de server complet, adaugă și un
  monitor extern (ex. UptimeRobot) pe același URL.
- **Contul demo se resetează zilnic** (după 04:00) din snapshot-ul `data/demo-firma.json` —
  junk-ul vizitatorilor dispare peste noapte, împreună cu mesajele și contorul AI al contului.
  Admin: `POST /api/demo/reset` (manual) · `POST /api/demo/snapshot` (re-face snapshot-ul din
  starea curentă, după o curatare manuală).
- **Politica de confidențialitate (GDPR):** `public/confidentialitate.html` — legată din
  prezentare și din panoul de înscriere; acoperă datele colectate, împuterniciții (Stripe,
  Anthropic, Resend, ANAF), duratele și drepturile utilizatorilor.
- **Teste de integrare HTTP** (`test/http.js`, în `npm test`): pornește serverul pe un port de
  test cu bază temporară și verifică 21 de puncte cap-coadă — autentificare, autorizarea pe
  firmă, filtrul de upload, blocarea probei expirate, registrul depunerilor, portofoliul.
- **Alerte operaționale pe email:** la ≥5 erori de server (5xx) în 15 minute se trimite o
  alertă (max. una pe oră); la înscriere, utilizatorii cu email primesc un **mesaj de bun venit**
  cu primii pași.
- **E2E pe live:** `npm run e2e` (`scripts/e2e.mjs`, Playwright — pe acest server prin Docker,
  comanda e în antetul scriptului): 42 verificări cap-coadă pe instanța reală, cu contul demo —
  inclusiv FAQ-ul public de pe login, dicționarul contabil, cardul de pro-rata din tab-ul TVA, căutarea globală (Ctrl+K) și
  două porți care au nevoie de un browser adevărat, deci nu pot trăi în `npm test`: contrastul AA
  al comenzilor din bara laterală (în ambele teme) și **modul simplu fără coduri de cont** —
  se numără codurile din planul de conturi care ajung efectiv pe ecran (zero în simplu, nenul în
  expert, ca să nu treacă nici o regresie care ar ascunde totul pentru toată lumea).
- **E2E pe instanță izolată:** `npm run e2e-izolat` (`scripts/e2e-izolat.sh` +
  `scripts/e2e-izolat.mjs`) ridică o instanță proprie (bază și date temporare, port separat) și
  rulează **82 verificări pe instanță izolată** (unele verifică fiecare pagină/declarație,
  deci rularea produce mai multe rezultate) — exact fluxurile care nu se pot atinge pe demo
  live: roluri și drepturi granulare, resetare de parolă cu token real, importuri, erori SPV fără
  credențiale, toate cele 10 declarații XML, **restaurarea efectivă** a unui backup (verificată
  prin dispariția unui marcaj scris după arhivare) și panoul „Cine accesează aplicația" (tabelele
  se randează, filtrul schimbă conținutul, iar un cont fără drepturi nu vede nici cardul, nici
  datele din spatele lui). Importul balanței verifică în browser previzualizarea, salvarea unei
  mapări și reutilizarea ei după reordonarea coloanelor. Secțiunea 2FA parcurge fluxul complet prin interfață: configurare cu
  QR/cheie, activare cu TOTP, afișarea codurilor de rezervă, login cu un asemenea cod și
  dezactivare cu un TOTP valid.
- **Arhivă completă + copie offsite (zilnic):** pe lângă copia `db.json`, cronul creează
  `data/backups/full-YYYYMMDD-HHMMSS.zip` — `db.json` + un **instantaneu consistent** al bazei
  relaționale (SQLite prin `VACUUM INTO`, sigur sub WAL; sau `contab.sql` prin `pg_dump` pe
  driverul PostgreSQL) + **toate documentele din `data/uploads/`** — păstrează
  ultimele 14 și o trimite **în afara serverului**: pe email (Resend, `CONTAB_BACKUP_EMAIL_TO` +
  `RESEND_API_KEY` în `.env`) și/sau cu **rclone** (`RCLONE_REMOTE`, obligatoriu peste 20MB).
  Restaurare după dezastru: dezarhivezi zip-ul → `db.json` prin Setări → Backup → Restaurează,
  `uploads/*` înapoi în `data/uploads/`.
- **Restaurare backup din UI:** Setări → „Backup” → încarcă un fișier `db.json`; serverul îl
  validează (trebuie să conțină `firme`/`users`), face automat un backup al stării curente, apoi
  înlocuiește baza și o reîncarcă. `POST /api/restore` (admin, multipart).
- **Resetare parolă prin email:** „Ai uitat parola?” pe ecranul de login → introduci utilizator/email
  → primești un link `/?reset=TOKEN` (valabil 1 oră) dacă ai email setat și SMTP e configurat.
  Răspunsul e identic indiferent dacă există contul (nu dezvăluie utilizatorii). Setezi emailul în
  Setări → „Contul meu”. API: `POST /api/forgot-password` · `GET /api/reset/:token` ·
  `POST /api/reset/accept` · `GET/POST /api/profile`.
- **Sesiuni active + „deconectează peste tot”:** sesiunile sunt înregistrate server-side (dispozitiv,
  IP, ultima activitate); cookie-ul de sesiune e legat de un `sessId` — dacă sesiunea e revocată,
  cookie-ul devine invalid. Setări → „Contul meu” arată sesiunile, cu „deconectează” per dispozitiv și
  „Deconectează celelalte dispozitive”. Resetarea parolei deconectează automat toate sesiunile.
  API: `GET /api/sessions` · `POST /api/sessions/logout-others` · `DELETE /api/sessions/:id`.
