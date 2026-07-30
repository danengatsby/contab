---
name: run-app
description: Lansează și conduce aplicația Contabo (serverul live pm2 sau o instanță de dev pe DB temporar) și o verifică vizual în browser prin Playwright rulat în Docker. Folosește la „rulează/lansează aplicația", „fă un screenshot", „verifică vizual în browser".
---

# Lansarea și conducerea aplicației Contabo

Aplicația e un monolit Node/Express (server.js) cu frontend vanilla în `public/`.
**Instanța live rulează deja sub pm2** — de cele mai multe ori „a lansa" înseamnă
a verifica live-ul, nu a porni ceva nou.

## 1. Instanța live (calea uzuală)

```bash
pm2 restart contab --update-env        # doar după modificări de cod server
sleep 2
curl -s http://127.0.0.1:8080/api/health   # {"ok":true,...,"firme":N}
```

- Port local: **8080**; public: **https://contabo.space**.
- HTML/JS/CSS se servesc cu `no-cache` — modificările de frontend NU cer restart.
- Un lockfile împiedică a doua instanță pe același DB (`CONTAB_SKIP_LOCK=1` doar dacă știi ce faci).
- Loguri: `pm2 logs contab --lines 20 --nostream`.

## 2. Instanță de dev izolată (fără să atingi datele live)

Cum o pornesc și testele HTTP (DB temporar sqlite — calea `.sqlite` e derivată din
`CONTAB_DB_FILE`; Stripe dezactivat determinist):

```bash
PORT=3891 CONTAB_DB_DRIVER=sqlite CONTAB_DB_FILE=/tmp/contab-dev.json \
  CONTAB_JSON_MIRROR=0 STRIPE_SECRET_KEY='' node server.js &
timeout 20 bash -c 'until curl -sf http://127.0.0.1:3891/api/health >/dev/null; do sleep 1; done'
```

`STRIPE_SECRET_KEY=''` (gol, dar prezent) contează: loader-ul de .env respectă
variabilele setate explicit, inclusiv goale — altfel s-ar încărca cheia LIVE.
Pe DB proaspăt există `admin`/`admin`; user demo NU există (se creează prin
`POST /api/users` cu admin, username `demo`, apoi `POST /api/demo-login`).

## 3. Conducerea în browser (screenshot-uri)

**Nu există chromium-cli pe server** și nici bibliotecile de sistem pentru
Chromium — calea verificată e imaginea Docker Playwright (aceeași din
`scripts/e2e.mjs`):

```bash
# scrie un script de drive in DIR (ex. scratchpad/drive/launch.mjs), apoi:
docker run --rm -v DIR:/w -w /w mcr.microsoft.com/playwright:v1.58.2-noble \
  sh -c "npm i --no-save playwright@1.58.2 >/dev/null 2>&1 && node launch.mjs"
```

Șablon de drive minim (login → demo → screenshot):

```js
import { chromium } from 'playwright';
const BASE = process.env.BASE_URL || 'https://contabo.space';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pg.goto(BASE + '/', { waitUntil: 'networkidle' });
await pg.click('#demoLoginBtn');                 // intrare demo cu un click
await pg.waitForTimeout(2500);
await pg.evaluate(() => document.querySelectorAll('#welcomeOverlay,.toast').forEach((e) => e.remove()));
await pg.screenshot({ path: 'dashboard.png' });  // apare in DIR (montat ca /w)
await b.close();
```

Capcane confirmate:
- **Din container, `127.0.0.1` nu e host-ul** — folosește `https://contabo.space`
  sau IP-ul public al serverului; pentru instanța de dev, `--network host`.
- **Contul demo pornește în modul simplu**: navigarea e prin meniul lateral cu
  text (`pg.click('text=Emite factură')`), NU prin `#tabs button[data-tab=…]`
  (acela e modul expert). Comutare mod: `#uiModeBtn`.
- După login demo, șterge `#welcomeOverlay` (acoperă pagina) și `.toast`.
- Login clasic: `#loginForm` cu `name="username"` / `name="password"`.
- Un 401 în consolă pe pagina de login e normal (verificarea sesiunii).

## 4. E2E complet existent

Verificări cap-coadă pe live, cu aceeași rută Docker (comanda exactă e în antetul fișierului).
Numărul exact nu se scrie aici — driftează la fiecare test nou; `docs/arhitectura.md` îl ține,
confruntat automat cu realitatea de registrul `AFIRMATII` din `test/run.js`:

```bash
docker run --rm -v /var/www/contab/scripts:/w -w /w mcr.microsoft.com/playwright:v1.58.2-noble \
  sh -c "npm i --no-save playwright@1.58.2 >/dev/null 2>&1 && node e2e.mjs"
```
