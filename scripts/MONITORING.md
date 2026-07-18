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
- `process` — memorie RSS/heap, versiune Node, PID, driver DB, număr firme/utilizatori.

Cererile peste prag apar și în log ca avertismente `cerere lenta`, cu `reqId` pentru corelare.
Optimizările pornesc de aici, nu din instinct.

Raport zilnic prin email: `scripts/perf-report.sh` (cron la 07:45, utilizatorul `contab`) numără
în log-urile pm2 avertismentele `cerere lenta` și erorile de server din ultimele 24h și trimite
email (Resend, către `CONTAB_BACKUP_EMAIL_TO`) **doar dacă a găsit ceva** — liniște = totul e ok.
Rulare manuală fără email: `CONTAB_PERF_NOMAIL=1 bash scripts/perf-report.sh`.

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

**Backup restaurabil, nu doar creat:** `scripts/backup.js` VERIFICĂ fiecare arhivă după
creare (se deschide, `db.json` valid cu firmele numărate) și scrie starea în
`data/backups/last-backup.json` — vizibilă în `/api/metrics` (`ops.ultimulBackup`),
alături de spațiul liber pe disc. La eșec: alertă pe email + exit 1 (vizibil în cron).

**Offsite criptat:** cu `CONTAB_BACKUP_KEY` setat, copiile offsite (email/rclone) pleacă
AES-256. Restaurare: `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in f.zip.enc -out f.zip -pass env:CONTAB_BACKUP_KEY`.

**Exercițiu de restaurare (trimestrial, manual, ~10 min):** ia ultima arhivă offsite,
dezarhiveaz-o pe o mașină curată (sau `CONTAB_DATA_DIR` temporar), pornește instanța
izolată și verifică balanța unei firme contra producției. Restaurarea la nivel de firmă
(bundle) e testată AUTOMAT la fiecare rulare a suitei HTTP și în CI.
