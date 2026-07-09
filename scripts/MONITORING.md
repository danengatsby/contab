# Monitorizarea disponibilității Contabo

Endpoint public de sănătate: **`https://contabo.space/api/health`** → `{"ok":true,...,"firme":N}`.
Nu cere autentificare, nu expune date — doar confirmă că procesul și baza răspund.

Două straturi, complementare:

## 1. Watchdog local (deja activ) — `scripts/healthcheck.sh`

Rulează din cron la fiecare 5 minute (utilizatorul `dan`):

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
