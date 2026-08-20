# Monitorizarea disponibilității Contabo

Endpoint public de sănătate: **`https://contabo.space/api/health`** → `{"ok":true,...,"firme":N}`.
Nu cere autentificare, nu expune date — doar confirmă că procesul și baza răspund.

Performanță și diagnostic: **`/api/metrics`** (doar admin) — de la ultimul restart:
- `routes` — duratele agregate pe rută (n, avg, max, câte au depășit pragul `CONTAB_SLOW_MS`,
  implicit 500 ms), ordonate după timpul total consumat;
- `recentErrors` — ultimele 20 de erori 5xx (cu `reqId`), cele mai noi primele — complementar
  alertei pe email, care vede doar fereastra de 15 minute;
- `jobs` — starea job-urilor de background (backup, digest-termene, demo-reset, spv-poll,
  rate-limit-hygiene): ultimul tick, ultimul rezultat, ultima eroare; pentru backup/digest/demo
  și ultima rulare reușită din settings (supraviețuiește restartului);
- `process` — memorie RSS/heap, versiune Node, PID, driver DB, număr firme/utilizatori, plus
  **marja față de plafonul pm2**: `memoryLimitMb` (= `max_memory_restart`), `memoryWarnMb` (pragul
  de avertizare, implicit 70% din plafon) și `memoryPctDinPlafon`;
- `persist` — starea **cozii de persistență**: `pending`, `pendingAgeMs` (de cât timp există
  scrieri necomise — cât timp e > 0, datele trăiesc DOAR în RAM), `pendingBytes`, `commits`,
  `failStreak`, `lastCommitAt`, `lastError`, `conflicted`.

Cererile peste prag apar și în log ca avertismente `cerere lenta`, cu `reqId` pentru corelare.

**Două vegheri care alertează ÎNAINTE de plafonul pm2** (email cel mult o dată pe zi, ca alerta 5xx):
- `memory-watch` (la 5 min) — RSS peste `CONTAB_MEM_WARN_MB` (implicit 70% din `CONTAB_PM2_MAX_MB`,
  la rândul lui implicit 1024 = `max_memory_restart`). Mesajul spune procentul din plafon, nu doar
  megaocteții. `ecosystem.config.js` NU e citit din fișier: `pm2 restart` nu îl reaplică, deci
  valoarea de acolo e o declarație de intenție — plafonul real se verifică cu `pm2 jlist`.
- `persist-watch` (la 1 min) — coada de persistență: scrieri necomise de peste
  `CONTAB_PERSIST_LAG_MS` (implicit 60s), `CONTAB_PERSIST_FAILS` eșecuri consecutive (implicit 3),
  sau persistență înghețată de conflict `dbEpoch`. Pe pg, `save()` fotografiază sincron dar comite
  asincron: cât timp coada nu se golește, scrierile nu sunt durabile ȘI țin memorie ocupată — adică
  exact drumul către plafonul pm2. Pe SQLite persist e sincron, deci semnalul e constant zero.
Optimizările pornesc de aici, nu din instinct.

Raport zilnic prin email: `scripts/perf-report.sh` (cron la 07:45, utilizatorul `contab`) numără
în log-urile pm2 avertismentele `cerere lenta` și erorile de server din ultimele 24h și trimite
email (Resend, către `CONTAB_BACKUP_EMAIL_TO`) **doar dacă a găsit ceva** — liniște = totul e ok.
Rulare manuală fără email: `CONTAB_PERF_NOMAIL=1 bash scripts/perf-report.sh`.

> **Liniștea contează doar dacă raportul chiar vede log-urile.** `ecosystem.config.js` declară
> log-urile în `<repo>/logs`, dar dacă procesul a fost pornit fără acel fișier, pm2 scrie în
> `$PM2_HOME/logs` — iar raportul scana un director înghețat și spunea „zero" la nesfârșit
> (constatat 2026-07-25: fișierul din `<repo>/logs` nu mai fusese scris din 18 iulie). Acum
> caută în toți candidații cunoscuți, iar dacă **niciunul** n-a fost scris în ultimele 25h
> raportează explicit „MONITORIZARE OARBĂ" în loc să tacă. `CONTAB_PM2_LOG_DIR`, dacă e setat,
> devine sursa unică (configurare explicită și cale testabilă).
>
> Verifică unde scrie pm2 acum:
> `sudo -u contab PM2_HOME=/home/contab/.pm2 pm2 jlist | grep pm_out_log_path`

Intenționat, `/api/health` rămâne minimal: e public, iar detaliile de proces pe un endpoint
neautentificat ar însemna fingerprinting gratuit al serverului (există test care impune asta).

Două straturi, complementare:

## 1. Watchdog local (deja activ) — `scripts/healthcheck.sh`

Rulează din cron la fiecare 5 minute (utilizatorul `contab`, cel sub care rulează și pm2):

```
*/5 * * * * /usr/bin/bash /var/www/contab/scripts/healthcheck.sh
```

Ce face:
- verifică `/api/health` (prin domeniul public → prinde și nginx/TLS căzut, nu doar node);
- la **2 eșecuri consecutive** (prag configurabil) încearcă **auto-vindecarea**: `pm2 restart contab`;
- dacă tot nu revine, trimite **alertă pe email** (Resend, cheia din `.env`), cel mult una pe oră;
- când aplicația revine după o alertă, trimite un email de **revenire** („✓ a revenit");
- loghează totul în `data/backups/health.log`.

Config (mediu sau `.env`): `CONTAB_BACKUP_EMAIL_TO`, `RESEND_API_KEY`,
`CONTAB_HEALTH_AUTORESTART` (implicit 1), `CONTAB_HEALTH_THRESHOLD` (implicit 2),
`CONTAB_HEALTH_URL`.

**Limita** (prin natura lui): rulează pe același server. Dacă serverul întreg sau
rețeaua cade — inclusiv cron-ul — nu are cine să te anunțe. De aceea:

## 2. Monitor extern (de configurat de tine, o dată) — UptimeRobot

Un serviciu gratuit care verifică endpoint-ul **din afara** serverului tău, deci
te anunță și când tot serverul e jos.

Pași (5 minute, o singură dată):
1. Cont gratuit pe <https://uptimerobot.com> (50 monitoare gratis, verificare la 5 min).
2. **Add New Monitor**:
   - Monitor Type: **HTTP(s)**
   - Friendly Name: `Contabo`
   - URL: `https://contabo.space/api/health`
   - Monitoring Interval: 5 minute
3. (Recomandat) **Advanced → Keyword**: tip „exists", keyword `"ok":true` — ca să
   alerteze și dacă serverul răspunde 200 dar cu conținut greșit.
4. **Alert Contacts**: adaugă emailul tău (și opțional SMS/Telegram/push din app).
5. Save.

Alternative echivalente: HetrixTools, BetterStack (Better Uptime), Pingdom.

## Recomandare
Ține-le pe amândouă: watchdog-ul local repară singur procesul (cazul frecvent),
monitorul extern acoperă căderea totală a serverului. Împreună = și auto-vindecare,
și notificare garantată.

## RPO / RTO asumate + exercițiul de restaurare

**RPO (pierdere maximă de date):**
- local: ≤ 30 s (oglinda JSON e scrisă cu debounce 30 s; baza relațională e sincronă);
- la dezastru total al mașinii: ≤ 24 h (arhiva zilnică offsite de la 03:30).

**RTO (timp de repunere):** ≤ 30 min — instalare Node + `npm ci`, dezarhivarea ultimei
arhive offsite, `db.json` → `data/`, `uploads/*` → `data/uploads/`, pornire.

**Backup restaurabil, nu doar creat — în două straturi:** `scripts/backup.js` verifică fiecare
arhivă după creare și scrie starea (ambele straturi) în `data/backups/last-backup.json` —
vizibilă în `/api/metrics` (`ops.ultimulBackup`), alături de spațiul liber pe disc:
- **structural** (`backup.verifyArchive`): arhiva se deschide, `db.json` e valid cu firmele
  numărate, instantaneul SQLite e prezent;
- **drill de restaurare** (`src/restoreDrill.js`, `ops.ultimulBackup.drill`): extrage `db.json`
  și RULEAZĂ agregarea contabilă în izolare (fără a atinge baza vie), verificând **balanța de
  verificare** (Σdebit == Σcredit, rulaj + solduri de preluare) pe FIECARE firmă. Prinde ce
  verificarea structurală nu vede: date restaurate care se parsează dar nu mai sunt procesabile
  sau nu se mai închid (preluare stricată, sumă coruptă). Automatizează exercițiul de mai jos.

La eșecul oricărui strat: alertă pe email + exit 1 (vizibil în cron).

**Offsite criptat:** `CONTAB_BACKUP_KEY` este obligatorie pentru orice transport offsite; fără ea
transportul este refuzat și backupul iese cu cod 1. Copiile pleacă AES-256. Restaurare:
`openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in f.zip.enc -out f.zip -pass env:CONTAB_BACKUP_KEY`.

**Exercițiu de restaurare — AUTOMAT la fiecare backup:** drill-ul de mai sus
(`src/restoreDrill.js`) face ce înainte cerea o rulare manuală trimestrială — deschide
arhiva, restaurează `db.json` în izolare și verifică balanța fiecărei firme — la fiecare
backup zilnic, cu alertă pe email la eșec. Restaurarea la nivel de firmă (bundle) e testată
în plus la fiecare rulare a suitei HTTP și în CI.

**Restaurare NATIVĂ PostgreSQL — rejucată periodic, nu doar produsă** (`src/pgRestoreDrill.js`):
arhiva conține și `contab.sql` (dump `pg_dump`), dar până acum acesta era doar *creat*, niciodată
*rejucat* — un dump se poate strica în tăcere (pg_dump eșuat parțial, versiune incompatibilă, tabel
lipsă) și afli abia în ziua în care ai nevoie de el. Acum, o dată la `CONTAB_PG_DRILL_DAYS` zile
(implicit 7), backupul zilnic:

1. creează o bază **temporară** (`contab_drill_<pid>_<ts>`) pe același server PostgreSQL;
2. rejoacă `contab.sql` cu `psql -v ON_ERROR_STOP=1` (fără asta, un dump stricat ar ieși cu cod 0);
3. reconstruiește graful din baza restaurată și verifică **balanța fiecărei firme** (aceeași
   verificare ca drill-ul pe `db.json`);
4. compară cu `db.json` din **aceeași arhivă** — dacă cele două căi de restaurare dau date diferite,
   una e învechită sau incompletă, deși fiecare pare validă separat;
5. **șterge baza temporară**, inclusiv pe calea de eroare.

Starea intră în `data/backups/last-pg-drill.json` și în `/api/metrics` (`ops.ultimulBackup.pgDrill`).
Manual, oricând: `POST /api/pg-restore-drill` (admin) — util imediat după o schimbare de
infrastructură, fără să aștepți rularea programată.

> **„Nu se aplică" ≠ „nu pot verifica".** Fără `contab.sql` în arhivă (instalare pe SQLite) drill-ul
> tace — corect. Dar dacă dump-ul EXISTĂ și totuși nu poate fi rejucat (lipsește `psql`, sau rolul
> aplicației nu are dreptul `CREATEDB`), rezultatul e `neverificabil` și **se trimite alertă**:
> altfel absența verificării ar semăna leit cu o verificare trecută — exact tiparul care a ținut
> raportul zilnic orb și backupul offsite oprit șapte zile.
>
> Rolul `contab` are `CREATEDB` (acordat 2026-07-27, tocmai pentru acest drill; reversibil cu
> `sudo -u postgres psql -c 'ALTER ROLE contab NOCREATEDB;'` — dar atunci drill-ul devine
> `neverificabil` și alertează). Verificare:
> `sudo -u contab psql -d contab -tAc "select rolcreatedb from pg_roles where rolname=current_user"`.
>
> Prima rulare pe arhiva reală de producție (2026-07-27): restaurare nativă reușită — 4 firme,
> 56 articole, echivalente cu `db.json` din aceeași arhivă, în 238 ms, baza temporară ștearsă.

**Exercițiu manual complet (opțional, ~o dată pe an):** pentru încrederea „end-to-end pe
mașină curată", ia ultima arhivă offsite (decripteaz-o dacă e cazul), dezarhiveaz-o pe o
mașină/instanță curată, pornește-o și verifică vizual câteva firme. Drill-ul automat acoperă
coerența datelor; exercițiul manual anual acoperă și pașii de infrastructură (Node, `npm ci`,
nginx, TLS) pe care un job nu-i poate valida.

## Jurnal de audit — proba durabilă

Auditul are DOUĂ straturi:
- **baza vie** (`d.audit`, plafon `CONTAB_AUDIT_MAX`, implicit 20.000) — pentru UI/API,
  în RAM; se rotește la depășire.
- **jurnal DURABIL append-only** (`data/audit/audit-YYYY-MM.ndjson`) — fiecare eveniment
  scris pe disc la producere (o linie NDJSON), fișiere lunare. Nu se rescrie niciodată,
  supraviețuiește rolării din baza vie ȘI unei coruperi/pierderi a bazei. Inclus în
  backupul zilnic offsite (folderul `audit/` din arhiva completă). Descărcabil (admin):
  `GET /api/audit/durable` (listă fișiere) și `?file=audit-2026-07.ndjson` (conținut).
