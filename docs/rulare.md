# Rulare, deploy și configurare

## Rulare

```bash
npm install
npm start            # porneste pe http://localhost:3000  (sau PORT=3787 npm start)
npm test             # ruleaza suita completa: lint + ~750 verificari de module + ~140 verificari HTTP
```

Apoi deschide `http://localhost:8080` în browser.

Navigarea e organizată pe categorii (meniuri în bara de sus): **Dashboard**, **Operațional**
(documente, bancă/casă, reconciliere, stocuri, mijloace fixe, salarizare), **Registre** (jurnal,
carte mare, balanță, analitic/scadențar), **Declarații & situații** (TVA/D300/D394, închideri,
situații financiare, livrabile), **Nomenclatoare** (parteneri, plan de conturi, ghid) și **Setări**.

Aplicația diferențiază **SRL vs PFA** (formă juridică pe firmă — taxe, calendar de declarații și
documente specifice: Declarația Unică cu variantă pe încasat, registrul de încasări și plăți,
retrageri/aporturi întreprinzător), acoperă **preluarea unei firme cu istoric** (import balanță,
solduri pe parteneri și stoc cantitativ-valoric din XLS/XLSX/DBF/CSV, cu verificarea echilibrului)
și oferă un **mod simplu pentru necontabili** (rezumat executiv „Situația firmei pe scurt",
dicționar contabil, meniu fără jargon) + **întrebări frecvente publice** pe pagina de autentificare.
Facturile se emit în **trei modele de PDF** cu logo-ul firmei, cu **chitanță tipăribilă** (sumă în
litere, serie proprie), iar utilizatorii pot primi **drepturi granulare** (doar-citire / fără salarii).

**Teste automate** (`npm test`): verificarea sintaxei tuturor fișierelor (`npm run lint`) +
**~750 de verificări de module** (`test/run.js`, pe date construite pur, fără a atinge `data/db.json`)
+ **~140 de verificări HTTP** (`test/http.js`, server pornit pe o bază temporară) — balanța și cele
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
de lucru, clasificarea documentelor și parsarea sumelor în format românesc. Două verificări leagă
frontend-ul de server (stările articolelor, tipurile eligibile e-Transport), ca o listă extinsă
într-un singur loc să nu treacă neobservată. Randarea și evenimentele rămân în sarcina `npm run e2e`.

- **Hook pre-pornire:** scriptul `prestart` rulează `npm test` înainte de `npm start` (pornirea
  locală e blocată dacă testele pică). Sub **pm2** (`node server.js` direct) hook-ul e ocolit — pentru
  a gata și acolo, rulează `npm test && pm2 restart contab`.
- **CI:** `.github/workflows/ci.yml` rulează `npm ci` + `npm run lint` + testele pe Node 18 și 20 la
  fiecare push/PR.

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
    server_name 159.69.200.202;   # sau domeniul tău
    client_max_body_size 25m;     # pentru upload de PDF-uri
    location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; }
}
```

**Compresie (în `nginx.conf`, blocul `http`):** frontendul e ~344KB de JS/CSS necomprimat
(21 module ES). `gzip on` singur NU ajunge — totul trece prin `proxy_pass`, deci nginx NU
comprimă răspunsurile fără `gzip_proxied`. Activează (câștig real ~69%: app.js 50KB→15KB):

```nginx
gzip on;
gzip_vary on;
gzip_proxied any;                 # ESENȚIAL: altfel răspunsurile proxied rămân necomprimate
gzip_comp_level 6;
gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
```

Aceasta e alternativa corectă la bundling: încărcarea e deja rapidă (~230ms, 21 fișiere mici
same-origin), iar compresia reduce octeții pe conexiuni lente **fără build step** — proiectul
rămâne servit direct de `node server.js`, fără pipeline de build (decizie deliberată).

**Pornire automată (recomandat, necesită root):** rulează ca serviciu systemd
ca să repornească la boot și să nu depindă de o sesiune:

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
User=dan
[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now contab
```

### Extragere cu AI (opțional, recomandat pentru facturi variate / scanate)

Aplicația poate citi **PDF-uri și imagini (JPG/PNG/WEBP — facturi scanate sau fotografiate)** cu
**Claude API** (`@anthropic-ai/sdk`, model `claude-opus-4-8`, intrare document PDF sau imagine +
ieșire structurată JSON). Tipul fișierului e detectat automat din conținut (PDF → bloc `document`,
imagine → bloc `image`). Pornește serverul cu cheia setată:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

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

- Datele se păstrează în `data/db.json`; fișierele PDF încărcate în `data/uploads/`.
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
