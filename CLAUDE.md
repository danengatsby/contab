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
node test/http.js             # doar integrarea HTTP (pornește serverul pe portul 3891, DB temporar)
CONTAB_TEST_DRIVER=sqlite node test/http.js   # aceeași suită pe driverul sqlite (rulează ambele la schimbări de persistență!)
node test/anaf.js             # reziliență ANAF + poll SPV (async, stub-uri, fără apeluri reale)
npm run seed                  # încarcă exemplul din ghid (S.C. EXEMPLU PROD S.R.L., 2026-06)
npm run e2e                   # E2E pe live; pe acest server rulează prin Docker (vezi antetul scripts/e2e.mjs)
```

Instanță de dezvoltare izolată (nu atinge producția):

```bash
CONTAB_DB_DRIVER=sqlite CONTAB_DB_FILE=/tmp/dev.json CONTAB_DATA_DIR=/tmp/dev-data PORT=18099 node server.js
# ...și oprește-o la final: fuser -k 18099/tcp  (o instanță uitată dă fals-pozitive la verificări)
```

Deploy (după merge în `main`): `sudo -u contab PM2_HOME=/home/contab/.pm2 pm2 restart contab`,
apoi `curl -s http://127.0.0.1:8080/api/health`. Restartul din root fără `PM2_HOME` eșuează.

## Arhitectură

- **server.js** (~950 linii) — bootstrap: middleware (helmet/CSP calibrat, reqId, metrici,
  paywall per-firmă `FIRMA_BILL_EXEMPT`, mustChange), autentificare/sesiuni, impersonare,
  înregistrarea modulelor de rute cu `ctx = { S, activeId, canAccess, requireAdmin, logAudit… }`,
  joburi periodice (`safeInterval`: backup, digest, demo-reset, spv-poll, rate-limit-hygiene).
- **src/routes/*.js** — puncte de intrare subțiri: `register(app, ctx)`; parsează cererea, apelează
  serviciul, scriu auditul, traduc erorile. Tipar: `run(res, fn)` trimite JSON doar dacă `fn` nu a
  răspuns deja singur (export/PDF) și lasă erorile fără `status` să urce la handlerul global (500 + log).
- **Service layer** (`src/stocksService.js`, `src/firmeService.js`, `src/anafService.js`) — validare,
  reguli, scrieri, cu **autorizare dublată**: `reqFirma()` (firmă explicită și existentă — fără
  fallback pe `firmaActiva`; `db.scoped(fid)` cade acolo pe fid invalid = scurgere), `reqEntry()`
  (404 identic pentru inexistent și străin), `reqNotDemo`/`reqAdmin`. Erorile de business poartă
  `err.status`. Extinde acest model dacă o rută crește; rutele rămase sunt majoritar citiri.
- **src/db.js** — persistență cu driver comutabil `CONTAB_DB_DRIVER`: `sqlite` (implicit, incremental),
  `pg` (producția reală; async la load), `json` (fallback/teste). `db.get()` = obiectul viu; mutează-l
  și cheamă `db.save()`. `db.scoped(fid)` = vederea filtrată pe firmă (folosită prin `S(req)` în rute).
  Oglinda JSON (`flushMirror(true)` înainte de backup) e fișierul copiat de backup.
- **Module de domeniu** (`src/accounting|stocks|payroll|fiscal|xml|saft|reporting…`) — funcții pure
  peste vederea scoped; XML-urile de declarații sunt verificate în teste cu `wellFormed`.
- **Frontend** — vanilla JS în `public/`, spart pe module (app.js + messages/bank/settings/admin/…);
  fără framework, decizie deliberată.
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
  `test/http.js` pornește serverul real (seed în `buildDb()`, cookie-uri prin `req()`, FormData nativ);
  `test/anaf.js` e async (stub pe `global.fetch` și pe funcțiile modulului `anaf`). La teste noi de
  rute HTTP, atenție: restore-ul din suita de backup readuce baza la snapshot.
- Orice scriere externă (ANAF) trece prin `anafFetch` (timeout + retry doar pe GET); webhook-ul
  Stripe e idempotent pe `event.id` (`seenEvent`/`rememberEvent`).
- Parametrii fiscali stau centralizat în `src/fiscalConfig.js` (datați); nu hardcoda cote.
