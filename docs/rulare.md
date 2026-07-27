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
Rulează, în ordine: verificarea sintaxei tuturor fișierelor (`npm run lint`), garda pe baza reală
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
