# Rulare, deploy și configurare


> **Secrete obligatorii.** Serverul refuză să pornească fără `CONTAB_AUTH_SECRET` și
> `CONTAB_SECRETS_KEY` (ambele 64 hex, generate cu
> `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Pe instanțele de
> dezvoltare și în teste, marchează-le explicit cu `CONTAB_DEV=1` — atunci pornește cu valori de
> rezervă, avertizând la fiecare pornire. Flagul nu se pune niciodată pe instalarea reală.

## Rulare

```bash
npm install
npm start            # porneste pe http://localhost:8080  (sau PORT=9000 npm start)
npm test             # suita completa: sintaxa + garda DB + module + frontend + ANAF + store + HTTP
```

Apoi deschide `http://localhost:8080` în browser. **Cere Node ≥ 22.13** (`engines` din
`package.json`; driverul implicit `node:sqlite` nu există înainte).

Navigarea e organizată pe grupuri, ca meniuri derulante în bara de sus: `📥 Documente & facturi`,
`🏦 Bani`, `🧾 Taxe`, `📦 Stocuri`, `👥 Salarii`, `🏢 Mijloace fixe`, `📊 Rapoarte`, `📁 Date firmă`,
`⚙️ Setări`. (Numele lor sunt verificate față de `public/index.html` — vezi poarta de drift din
`test/run.js`.)

Aplicația diferențiază **SRL vs PFA** (formă juridică pe firmă — taxe, calendar de declarații și
documente specifice: Declarația Unică cu variantă pe încasat, registrul de încasări și plăți,
retrageri/aporturi întreprinzător), acoperă **preluarea unei firme cu istoric** (import balanță,
solduri pe parteneri și stoc cantitativ-valoric din XLS/XLSX/DBF/CSV, cu verificarea echilibrului)
și oferă un **mod simplu pentru necontabili** (rezumat executiv „Situația firmei pe scurt",
dicționar contabil, meniu fără jargon) + **întrebări frecvente publice** pe pagina de autentificare.
Facturile se emit în **trei modele de PDF** cu logo-ul firmei, cu **chitanță tipăribilă** (sumă în
litere, serie proprie), iar utilizatorii pot primi **drepturi granulare** (doar-citire / fără salarii).

**Teste automate** (`npm test`) — numărul curent de verificări îl afișează chiar suita, deci nu îl
fixăm aici (ar drifta la fiecare test nou; există o poartă în `test/run.js` care impune asta).
Fiecare suită rulează **independent** (`scripts/run-all.js`): una picată nu le mai oprește pe
următoarele, iar la final se raportează toate, cu totalul de verificări și codul de ieșire 1 dacă
vreuna a căzut. Înlănțuirea veche cu `&&` se oprea la prima suită roșie și ascundea tăcut restul —
inclusiv toată integrarea HTTP — ceea ce făcea ca „o problemă mică" să însemne, de fapt, „două
treimi din suită nu au rulat". Suitele care se sar motivat (`test/store-pg.js` fără `CONTAB_PG_URL`)
se raportează distinct: **sărit nu e trecut**.

Fiindcă `npm test` rulează pe **sqlite**, iar producția pe **pg**, driverul real se verifică
separat cu `npm run test-pg`: pornește un PostgreSQL efemer, rulează cele trei probe (persistență
incrementală, suita HTTP, balanța cu prag SQL 0) și curăță după el. E aceeași comandă pe care o
cheamă și CI, deci nu există două liste de probe care să driftează. Docker lipsă întoarce codul
**2 — NEVERIFICAT**, distinct de un eșec de test.
Rulează, în ordine: verificarea sintaxei tuturor fișierelor (`npm run lint-syntax`), garda pe baza reală
(`test/db-guard.js`), sesiuni/auth, **verificările de module** (`test/run.js`, pe date construite
pur, fără a atinge `data/db.json`), extractorul, **logica pură de frontend** (`test/frontend.mjs`),
reziliența ANAF (`test/anaf.js`, cu stub-uri), persistența (`test/store.js`, `test/store-pg.js`) și
**verificările HTTP** (`test/http.js`, server pornit pe o bază temporară) — balanța și cele
4 egalități, TVA (decont, la încasare, taxare inversă, **pro-rata art. 300**, ajustări **art. 305**),
amortizarea (liniară/degresivă/accelerată), stocurile (CMP pe gestiuni, preluare stoc inițial,
inventariere, producție), salarizarea (CAS/CASS/impozit/CAM, deducerea personală, tichete, avantaje
în natură, **concedii medicale** cu media pe 6 luni și split angajator/FNUASS, **concediu de odihnă**
pe media pe 3 luni, **normă parțială suprataxată** OUG 16/2022), declarațiile (D300/D394/D390/D205/
D112/D100/Intrastat/SAF-T bine-formate + validare pre-depunere), **taxele PFA** (Declarația Unică cu
plafoane, registrul de încasări și plăți), e-Factura UBL, drepturile granulare pe utilizatori și
blocarea perioadelor raportate. Blochează regresiile.

**Logica pură de frontend** (`test/frontend.mjs`) e testată în Node, fără browser și fără jsdom:
escaparea HTML (stratul de apărare dinaintea CSP), formatarea și rotunjirea sumelor (cu **paritate
verificată față de `src/util.js`** — altfel ecranul și PDF-ul ar diferi la ban), aritmetica lunilor
de lucru, clasificarea documentelor, parsarea sumelor în format românesc, diagnosticul balanței
care nu se închide, insigna declarațiilor și comparația e-TVA cu decontul precompletat. Trei
verificări leagă frontend-ul de server (stările articolelor, tipurile eligibile e-Transport,
stările declarațiilor), ca o listă extinsă într-un singur loc să nu treacă neobservată. Randarea
și evenimentele rămân în sarcina `npm run e2e`.

> Atenție la scrierea de teste noi aici: helperul `eq` **rotunjește el însuși** numerele înainte de
> comparație (moștenit din `test/run.js`), deci un test despre rotunjire trece și dacă rotunjirea
> din cod lipsește. Pentru așa ceva folosește `ok(...)` cu comparație strictă.

**Previzualizarea articolului contabil vine de la server** (`POST /api/preview`), prin aceeași
compunere ca salvarea. Până acum frontend-ul avea o replică proprie a regulilor, care acoperea 42
din 107 tipuri și deviase tăcut; acum toate tipurile au previzualizare, iar ce vezi înainte de
salvare este exact ce se salvează — inclusiv regulile care depind de firmă (pro-rata, TVA la
încasare, deductibilitate auto 50%, perioade blocate), pe care o replică din browser nu le putea
ști. Se cere după o pauză de tastare, nu la fiecare tastă.

**Importul balanței de deschidere refuză valorile ambigue.** „1.234" poate însemna 1234 (separator
de mii, scrierea românească) sau 1,23 — o diferență de o mie de ori, exact pe soldurile care se
propagă în toată contabilitatea. Aplicația deduce întâi convenția din fișier (o singură valoare
neambiguă, precum `1.234,56` sau `12,5`, lămurește tot fișierul), iar dacă rămân valori ambigue
**nu importă nimic**: întreabă o dată, cu exemple reale și ambele interpretări calculate, și aplică
răspunsul întregului fișier. Sumele fără zecimale (`1.234.567`) se citesc corect.

- **Hook pre-pornire:** scriptul `prestart` rulează `npm test` înainte de `npm start` (pornirea
  locală e blocată dacă testele pică). Sub **pm2** (`node server.js` direct) hook-ul e ocolit — pentru
  a gata și acolo, rulează `npm test && pm2 restart contab`.
- **CI:** `.github/workflows/ci.yml` rulează `npm ci` + suita completă pe **Node 22 și 24** la fiecare
  push/PR, plus: balanța pe calea SQL (prag 0), suita HTTP pe **PostgreSQL** (paritate cu producția)
  și `npm audit` (blochează la HIGH/CRITICAL). Validarea oficială ANAF (DUKIntegrator) rulează
  săptămânal, manual și la push pe `main` — nu pe fiecare PR, ca o cădere a `static.anaf.ro` să nu
  blocheze munca.

**Dashboard cu grafice** (SVG, fără dependențe): evoluția lunară venituri/cheltuieli/profit (bare
grupate), comparația creanțe vs datorii și structura aging pe intervale de vechime. `/api/dashboard-charts`.

### Acces din rețea și expunerea în producție

Implicit serverul ascultă pe `0.0.0.0` (toate interfețele) — util în dezvoltare, pe rețele
de încredere. **În producție NU expuneți portul Node direct**: pe HTTP simplu cookie-ul de
sesiune nu primește flag-ul `Secure`, iar traficul ocolește TLS-ul și antetele de securitate
din nginx.

Configurația de producție (checklist la fiecare deploy):

```bash
# .env de producție:
HOST=127.0.0.1            # aplicația ascultă DOAR pe loopback; accesul vine prin nginx (HTTPS)
CONTAB_FORCE_HTTPS=1      # plasă suplimentară: HTTP din exterior → redirect 308 / 403 pe POST

# verificare după restart:
ss -tlnp | grep 8080      # trebuie să arate 127.0.0.1:8080, NU 0.0.0.0:8080
curl -s http://127.0.0.1:8080/api/health   # loopback-ul rămâne permis (nginx + health check)
```

Pentru testare rapidă pe IP public (doar dezvoltare, niciodată cu date reale):
`PORT=8080 HOST=0.0.0.0 node server.js`

**URL curat pe portul 80 (recomandat, necesită root):** pe această mașină rulează
deja `nginx` pe portul 80. Adaugă un reverse proxy către aplicație:

```nginx
# /etc/nginx/sites-available/contab  (apoi: ln -s ... sites-enabled && nginx -t && systemctl reload nginx)
server {
    listen 80;
    server_name contabo.space;    # domeniul instalării (sau IP-ul serverului)
    client_max_body_size 25m;     # pentru upload de PDF-uri
    location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; }
}
```

**Compresie (în `nginx.conf`, blocul `http`):** frontendul e câteva sute de KB de JS/CSS
necomprimat, servit ca module ES separate. `gzip on` singur NU ajunge — totul trece prin `proxy_pass`, deci nginx NU
comprimă răspunsurile fără `gzip_proxied`. Activează (câștig real ~69%: app.js 50KB→15KB):

```nginx
gzip on;
gzip_vary on;
gzip_proxied any;                 # ESENȚIAL: altfel răspunsurile proxied rămân necomprimate
gzip_comp_level 6;
gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
```

Aceasta e alternativa corectă la bundling: încărcarea e deja rapidă (fișiere mici, same-origin), iar compresia reduce octeții pe conexiuni lente **fără build step** — proiectul
rămâne servit direct de `node server.js`, fără pipeline de build (decizie deliberată).

**Pornire automată.** Pe *această* instalare procesul rulează sub **pm2**, ca utilizatorul `contab`
(vezi `ecosystem.config.js` — `max_memory_restart: 1G`, log-uri în `logs/`):

```bash
sudo -u contab PM2_HOME=/home/contab/.pm2 pm2 restart contab
curl -s http://127.0.0.1:8080/api/health
```

`pm2 restart` **nu** reaplică `ecosystem.config.js`; o modificare acolo ajunge în proces doar prin
`pm2 delete contab && pm2 start ecosystem.config.js && pm2 save`.

**Alternativa systemd** (dacă preferi, în locul pm2 — necesită root):

```ini
# /etc/systemd/system/contab.service
[Unit]
Description=Contab
After=network.target
[Service]
WorkingDirectory=/var/www/contab
Environment=PORT=8080 HOST=127.0.0.1
# Environment=ANTHROPIC_API_KEY=sk-ant-...   # optional, pentru extragerea cu AI
ExecStart=/usr/bin/node server.js
Restart=always
User=contab
[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now contab
```

### Extragere cu AI (opțional, recomandat pentru facturi variate / scanate)

Aplicația poate citi **PDF-uri și imagini (JPG/PNG/WEBP — facturi scanate sau fotografiate)** cu
**Claude API** (`@anthropic-ai/sdk`, model implicit `claude-opus-4-8`, intrare document PDF sau
imagine + ieșire structurată JSON). Tipul fișierului e detectat automat din conținut (PDF → bloc
`document`, imagine → bloc `image`). Pornește serverul cu cheia setată:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

**Furnizorul se alege singur** din cheile prezente: `ANTHROPIC_API_KEY` → Anthropic, altfel
`OPENAI_API_KEY` → OpenAI (model implicit `gpt-4.1-mini`, reglabil cu `CONTAB_AI_MODEL_OPENAI`);
fără nicio cheie se folosesc regulile locale. `CONTAB_AI_PROVIDER=anthropic|openai` forțează
alegerea când sunt prezente ambele.

Când cheia este prezentă, fiecare upload este trimis la Claude pentru a extrage
câmpurile (CUI, nr./dată, bază, TVA, cotă, total) și a propune tipul de
înregistrare; **dacă apelul eșuează, se revine automat la regulile locale**.
Fiecare utilizator are un **plafon zilnic de extrageri AI** (`CONTAB_AI_DAILY_LIMIT`,
implicit 200/zi; contul public „demo": `CONTAB_AI_DAILY_LIMIT_DEMO`, implicit 10/zi) —
peste plafon se folosesc regulile locale, cu avertisment în formular.
Avantajul față de regulile locale: citește facturi în orice format, inclusiv
**PDF-uri scanate** (prin viziune). Poți activa/dezactiva din Setări. Modelul se
poate schimba cu `CONTAB_AI_MODEL=...`.

Pentru a încărca exemplul integrat din ghid (luna iunie, S.C. EXEMPLU PROD S.R.L.):

```bash
npm run seed         # din linia de comanda
# sau din interfata: Setări → „Încarcă exemplul din ghid”
```


### Validarea oficială ANAF a declarațiilor (opt-in, prin Docker)

Guvernanța regulilor fiscale (sursă unică datată, fluxul schimbărilor legislative,
statusurile pre-depunere, jurnalul reviziilor): vezi **docs/guvernanta-fiscala.md**.
Revizia de specialitate a cifrelor (ce se trimite revizorului, simplificările cunoscute,
cazurile-test aprobate): **docs/dosar-revizie-fiscala.md** + `node test/cazuri-aprobate.js`.

Aplicația face o pre-validare rapidă la generare (`src/validate.js`: bine-format + câmpuri
obligatorii + CUI/perioadă). Pentru validarea **oficială** — aceeași pe care o face ANAF la
depunere — există un script care rulează DUKIntegrator (validatorul oficial) prin Docker,
fără să instaleze Java pe server:

```bash
scripts/valideaza-duk.sh D300 decont.xml     # 0 = valid, 1 = erori (afișate), 2 = tip greșit
```

La prima rulare descarcă distribuția DUKIntegrator și validatorul declarației din manifestul
oficial (`versiuni.xml`); validatoarele se reîmprospătează automat după 7 zile (ANAF le
actualizează frecvent). Cache-ul stă în `/var/tmp/contab-duk` (reglabil cu `CONTAB_DUK_DIR`),
în afara repo-ului. Validarea e deliberat **în afara fluxului de generare**: nu legăm serverul
de un runtime Java și de ciclul de update-uri ANAF, iar validarea oficială oricum se repetă
obligatoriu la depunerea în SPV.

## Plafon de debit la nivel nginx (prima plasă)

Aplicația are plafoane proprii — 8 încercări eșuate de login pe IP, 5 înscrieri/oră/IP, 600 de
cereri/min general — și **ele rămân autoritatea pe reguli**. Rolul nginx e altul: să nu coste o tură
de event loop fiecare cerere dintr-un val.

`nginx-contab.conf` limitează căile de autentificare (`/api/login`, `/api/demo-login`,
`/api/register`, `/api/forgot-password`, `/api/reset/accept`) la **10r/min per IP, burst 20,
`nodelay`** — calibrat peste folosirea umană normală (un contabil face 1–3 încercări pe minut) și
sub abuz. Peste burst se răspunde `503`, fără să se atingă Node.

Măsurat pe un val de 40 de cereri: **8 × 401** (respinse de aplicație ca parolă greșită), **13 × 429**
(anti-brute-force propriu), **19 × 503** (tăiate de nginx, nu au atins aplicația). Căile normale
rămân neafectate.

**HTTP/2 e activ** (`http2 on`): aplicația încarcă ~27 de resurse la prima vizită (modulele ES din
`public/`), iar pe HTTP/1.1 acestea se serializau în valuri de câte ~6 conexiuni. Prima încărcare,
măsurată cu gzip activ: **193 KB** (HTML 41 + CSS 16 + JS 135). Nu există pas de build — decizie
măsurată, motivată în backlog.

> **Fișierul din repo poate drifta față de cel viu**: `certbot --nginx` modifică
> `/etc/nginx/sites-available/contab` direct (liniile „managed by Certbot"). Procedura la orice
> schimbare: modifici fișierul viu → `nginx -t` → `systemctl reload nginx` → copiezi înapoi în repo.

## Copie offsite: stocare obiect, criptată

Backupul zilnic (cron 03:30, `scripts/backup.js`) produce arhiva locală și o trimite offsite.
**Destinația recomandată e stocarea obiect S3-compatibilă** (Backblaze B2, Hetzner, MinIO,
Cloudflare R2) — semnarea AWS SigV4 e implementată nativ în [`src/offsite.js`](../src/offsite.js),
fără `rclone` și fără dependențe noi.

| Variabilă | Ce face |
|---|---|
| `CONTAB_OFFSITE_ENDPOINT` | URL-ul serviciului, ex. `https://s3.eu-central-003.backblazeb2.com` |
| `CONTAB_OFFSITE_BUCKET` | bucketul destinație |
| `CONTAB_OFFSITE_KEY` / `CONTAB_OFFSITE_SECRET` | credențialele |
| `CONTAB_OFFSITE_REGION` | regiunea (implicit `us-east-1`) |
| `CONTAB_OFFSITE_PREFIX` | prefixul obiectelor (implicit `contab`) |
| `CONTAB_BACKUP_KEY` | **cheia de criptare** — vezi mai jos |
| `CONTAB_BACKUP_EMAIL_TO` | destinatarul notificării (nu al datelor, dacă e configurat S3) |
| `RCLONE_REMOTE` | cale alternativă, moștenită; cere `rclone` instalat (**nu e** pe acest server) |

### Criptarea e fail-closed

Cu `CONTAB_BACKUP_KEY` setat, arhiva se criptează (AES-256-CBC, PBKDF2 200.000 iterații) **înainte**
de urcare, iar scriptul verifică *round-trip* — descifrează și compară amprenta cu originalul —
înainte să trimită ceva. Dacă criptarea sau verificarea eșuează, **copia offsite nu pleacă deloc**.

Comportamentul vechi trimitea necriptat cu un simplu avertisment în log: adică exact când ceva nu
era în regulă, datele fiscale plecau în clar. O cheie configurată e o cerință, nu o preferință.

Formatul e cel `openssl`, deliberat: o restaurare de dezastru trebuie să fie posibilă cu unelte de
pe orice mașină, fără aplicație și fără Node.

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in full-20260728.zip.enc -out full-20260728.zip -pass env:CONTAB_BACKUP_KEY
```

### RTO / RPO

| | Valoare | De unde vine |
|---|---|---|
| **RPO** (cât se poate pierde) | **24 h** | backupul rulează zilnic la 03:30; o cădere la 03:29 pierde ziua precedentă |
| **RTO** (cât durează revenirea) | **~1,4 s** de la arhivă în mână la serviciu verificat (măsurat) | `npm run rto-drill` |

**Măsurat, nu estimat** (2026-07-29, pe arhiva reală de producție, 72 KB, 4 firme / 58 articole).
Cifra se reproduce oricând cu:

```bash
npm run rto-drill            # implicit: cea mai recentă data/backups/full-*.zip
```

Drill-ul cronometrează fiecare etapă și **verifică datele restaurate**, nu doar că serviciul
pornește: despachetare `0,012 s` → rejucarea `contab.sql` `0,162 s` → fișiere (93) `0,014 s` →
pornirea aplicației `1,062 s` → verificare `0,086 s`. Nu atinge producția: bază efemeră, director
de date temporar, port liber. Versiunea de PostgreSQL se **derivă din antetul dump-ului** — un dump
de pe 18 nu se rejoacă pe 16, iar prima rulare a picat exact așa.

**Ce NU intră în cifră, deliberat:**
- **obținerea arhivei din offsite** — azi e un atașament de e-mail, deci un pas *manual*: deschizi
  mesajul, descarci. Depinde de om și de rețea, nu de cod. Un total care ar înghiți tăcut o etapă
  manuală ar fi ficțiune;
- **pornirea PostgreSQL** (1,4 s în drill) — artefact al probei; la o restaurare reală serverul de
  baze e deja pornit;
- **timpul operatorului** — găsirea arhivei, decizia, verificarea. Acesta domină RTO-ul real.

Concluzia onestă: partea *tehnică* a revenirii e sub 2 secunde la volumul actual și scalează cu
dimensiunea dump-ului; ce rămâne de scurtat e pasul manual de mai sus.

> ⚠️ **Starea reală a copiei offsite diferă de procedura de mai jos.** Măsurat pe server la
> 2026-07-29: `CONTAB_BACKUP_KEY` **absent** (deci arhiva pleacă **necriptată**) și toate
> variabilele `CONTAB_OFFSITE_*` **absente** (deci calea pe stocare obiect **nu e activă**).
> Transportul efectiv e e-mailul către `CONTAB_BACKUP_EMAIL_TO`, cu `db.json` + `contab.sql` +
> `uploads/` în clar. Codul pentru varianta criptată pe S3 există și e testat — doar nu e
> configurat. Până când este, procedura de mai jos descrie o instalare care nu e în funcțiune.
> Backupul zilnic **avertizează** acum explicit când copia pleacă necriptată — nu mai raportează
> doar „Offsite email OK".

### Activarea copiei offsite criptate (pași exacți)

Totul e configurare — codul există și e testat. **Verifică oricând starea cu:**

```bash
npm run offsite-check     # 0 = verde | 1 = ceva chiar nu merge | 2 = neconfigurat
```

Comanda face exact drumul backupului real, dar pe un obiect de probă de câteva zeci de octeți:
criptare + descifrare cu comparare de amprentă, apoi `PUT` și `GET` înapoi din bucket. Nu atinge
arhivele reale și nu trimite e-mail. Rulează-o **după fiecare pas de mai jos**, ca să nu afli
dimineața din log că ai greșit o literă în secret.

**1. Cheia de criptare.** Generează una și pune-o în `.env`:

```bash
openssl rand -base64 48        # 64 de caractere, suficient pentru AES-256 prin PBKDF2
```

```
CONTAB_BACKUP_KEY=<valoarea generată>
```

> **Cheia nu se ține lângă backup.** Nu în același bucket, nu în aceeași cutie poștală, nu în
> același furnizor. Dacă se pierde, arhivele sunt irecuperabile — acesta e și scopul, și riscul.
> Păstreaz-o într-un manager de parole separat, plus o copie fizică offline.

**2. Stocarea obiect.** Orice furnizor S3-compatibil (Backblaze B2, Hetzner, Cloudflare R2, MinIO).
Creează un bucket **privat**, cu versionare și retenție dacă furnizorul le oferă, apoi o cheie de
acces limitată **doar** la acel bucket:

```
CONTAB_OFFSITE_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
CONTAB_OFFSITE_BUCKET=contab-backup
CONTAB_OFFSITE_KEY=<access key>
CONTAB_OFFSITE_SECRET=<secret key>
CONTAB_OFFSITE_REGION=eu-central-003        # opțional, implicit us-east-1
CONTAB_OFFSITE_PREFIX=contab                # opțional, implicit „contab"
```

Semnarea e **AWS SigV4 nativă**, fără `rclone` și fără dependențe noi — verificată atât față de
vectorii oficiali, cât și cap-coadă împotriva unui server S3 real (MinIO local, 2026-07-29):
credențiale greșite dau `SignatureDoesNotMatch`, bucket inexistent dă `NoSuchBucket`.

**3. Confirmă și lasă e-mailul ca notificare.** După `npm run offsite-check` verde, e-mailul poate
rămâne pentru **notificare**, dar nu mai e nevoie să fie transportul datelor: arhiva criptată pleacă
în bucket. Prima rulare reală se vede în `logs/backup.log` ca `Offsite S3 OK -> …(verificat)`.

Ce se întâmplă dacă ceva cedează: criptarea e **fail-closed** (dacă `openssl` eșuează iar cheia e
setată, copia offsite **nu pleacă** — refuz deliberat de a trimite în clar), iar urcarea se
verifică descărcând obiectul înapoi și comparând amprenta, fiindcă o urcare care a truncat fișierul
arată identic în log cu una bună.

### Procedura de restaurare, pas cu pas

1. Obține ultima arhivă. **Astăzi:** atașamentul din e-mailul zilnic către `CONTAB_BACKUP_EMAIL_TO`
   (`full-AAAALLZZ-HHMMSS.zip`, necriptat). **După configurarea offsite-ului:** din bucket
   (`contab/full-AAAALLZZ-HHMMSS.zip.enc`). Vezi avertismentul de mai sus — cele două diferă azi.
2. Decriptează **doar dacă** arhiva e `.enc` (deci doar după ce `CONTAB_BACKUP_KEY` e setat), cu
   comanda `openssl` de mai sus.
3. Dezarhivează: conține `db.json`, dump-ul PostgreSQL (`contab.sql`) și `uploads/`.
   Pașii 3–7 sunt exact ce automatizează și cronometrează `npm run rto-drill` — rulează-l periodic,
   ca procedura să fie dovedită, nu presupusă.
4. Restaurează baza: fie din Setări → Backup → „Restaurează", fie rejucând `contab.sql`.
5. Copiază `uploads/` înapoi în `data/uploads/`.
6. Repornește: `sudo -u contab PM2_HOME=/home/contab/.pm2 pm2 restart contab`.
7. Verifică: `curl -s http://localhost:8080/api/health` și o balanță pe o lună cunoscută.

**Cheia de criptare nu se ține în același loc cu backupul.** Dacă `CONTAB_BACKUP_KEY` se pierde,
arhivele offsite sunt irecuperabile — asta e și scopul lor, și riscul lor.

## Curs de schimb BNR

Cursul oficial BNR se descarcă automat (job la 6 ore) și se păstrează cu **istoric**: o factură din
martie se evaluează la cursul din martie, nu la cel de azi. Într-o zi nelucrătoare se folosește
ultimul curs publicat înainte — regula BNR — iar interfața marchează explicit când cursul provine
din altă zi.

```bash
curl -s 'http://localhost:8080/api/curs-bnr?moneda=EUR&data=2026-03-15'   # cursul la o dată
# reîmprospătare la cerere (admin); `?an=2026` aduce un an întreg de istoric
curl -s -X POST 'http://localhost:8080/api/curs-bnr/refresh?an=2026'
```

Atenție la **multiplicator**: BNR publică unele valute la 100 de unități (HUF, JPY, KRW, ISK…).
Aplicația îl aplică la parsare, deci cursul stocat e mereu pentru *o* unitate.

Indisponibilitatea feed-ului **nu blochează nimic**: reîmprospătarea răspunde `503` cu un mesaj
explicit, iar cursul se poate tasta manual ca înainte.

| Variabilă | Ce face |
|---|---|
| `CONTAB_BNR_URL_ZI` | suprascrie URL-ul feed-ului zilnic (probe/teste) |
| `CONTAB_BNR_URL_AN` | idem, pentru istoricul anual; `{AN}` se înlocuiește cu anul |
| `CONTAB_BNR_TIMEOUT_MS` | timeout per cerere (implicit 20000) |
| `CONTAB_BNR_RETRIES` | reîncercări la eroare tranzitorie (implicit 2) |
| `CONTAB_BNR_BACKOFF_MS` | pauza inițială între reîncercări (implicit 500) |

Suita de teste **nu iese pe rețea**: `test/http.js` pornește un fixture HTTP local și îi indică
serverul-copil prin `CONTAB_BNR_URL_ZI`. Serverul de test e un proces copil, deci un stub pe
`global.fetch` din procesul de test n-ar avea niciun efect asupra lui.

## Note

- Baza autoritară e cea relațională aleasă de `CONTAB_DB_DRIVER` (`data/contab.sqlite` sau
  PostgreSQL); `data/db.json` e **oglinda** ei, folosită de backup și de restaurare. Fișierele
  încărcate stau în `data/uploads/`.
- **Uploadurile sunt validate** (allowlist de extensii: PDF, imagini, CSV/TXT, XLS(X), DBF, XML,
  ZIP, JSON — HTML/JS/SVG sunt respinse, anti-XSS stocat). La descărcare, doar tipurile inerte
  (PDF/imagini) se afișează inline; orice altceva se descarcă forțat ca octeți. Accesul la
  `/api/document/:id/file` e restricționat la firmele alocate utilizatorului.
- **Oglinda JSON** (`data/db.json`) se scrie cu întârziere de max. 30s după modificări (debounce);
  baza relațională (SQLite/PostgreSQL) e mereu la zi. Backupul manual și oprirea curată
  (SIGINT/SIGTERM) o aduc la zi întâi.

### Baze de date (driver comutabil)

`CONTAB_DB_DRIVER` alege stratul de persistență, fără nicio schimbare în restul aplicației:

- **`sqlite`** (implicit) — `node:sqlite` sincron, fișier `data/contab.sqlite`, WAL. Zero configurare.
  **Cere Node ≥ 22.13** (`node:sqlite` nu există înainte de 22.5 și e sub flag până la 22.13);
  pe un Node mai vechi pornirea eșuează cu un mesaj clar care indică alternativa (`pg`/`json`).
- **`pg`** (PostgreSQL) — pentru concurență reală și scalare. Se conectează implicit pe socketul
  local `/var/run/postgresql` cu autentificare **peer** (rolul = utilizatorul OS, ex. `contab`) și
  baza `contab`; sau explicit prin `CONTAB_PG_URL=postgres://user:parola@host:5432/contab`.
  Layout identic cu SQLite: câte un tabel per colecție, cu coloane `id`/`firmaId` indexate + o
  coloană `data` **JSONB**. Clientul `pg` e asincron, dar `save()`-ul aplicației rămâne sincron:
  driverul fotografiază sincron colecțiile modificate și scrie printr-o **coadă serială** (o
  singură tranzacție în zbor); oprirea curată așteaptă golirea cozii.
- **`json`** — VECHI, păstrat doar ca rollback rapid de urgență (doar `data/db.json`, fără server de
  bază de date). Nimic nu mai rulează implicit pe el — testele și instanțele de dev folosesc `sqlite`
  (`CONTAB_TEST_DRIVER=json` există pentru verificarea căii de rollback); la pornire avertizează.

**Migrare între drivere:** la prima pornire pe o bază relațională goală, dacă există `data/db.json`,
conținutul e importat automat o singură dată (copie de siguranță în `data/db.pre-sqlite.json`,
respectiv `data/db.pre-pg.json`). Fiindcă oglinda JSON e comună tuturor driverelor, comutarea se
face doar schimbând `CONTAB_DB_DRIVER` și repornind. Setup PostgreSQL pe acest server:

```bash
sudo -u postgres psql -c "CREATE ROLE contab LOGIN" -c "CREATE DATABASE contab OWNER contab"
# în .env:  CONTAB_DB_DRIVER=pg
sudo -u contab pm2 restart contab --update-env
```
- Cotele și tratamentele sunt simplificate pentru claritate; situațiile concrete pot
  necesita conturi și prelucrări suplimentare conform Codului fiscal.
- Extragerea din PDF funcționează pe documente cu **text** (PDF-uri generate de programe
  de facturare). Pentru PDF-uri scanate (imagine) datele se pot introduce manual —
  câmpurile rămân editabile, iar documentul se atașează ca justificativ.
