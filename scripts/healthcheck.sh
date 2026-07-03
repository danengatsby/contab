#!/usr/bin/env bash
# Healthcheck Contab (cron la 5 min): verifica /api/health; la esec trimite alerta pe email
# (Resend, cheia din .env) — cel mult una pe ora (fisier-lacat) — si logheaza.
# NB: ruland pe acelasi server, prinde aplicatia cazuta/blocata, nu si serverul cazut —
# pentru asta foloseste si un monitor extern (ex. UptimeRobot pe https://contabo.space/api/health).
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${CONTAB_HEALTH_URL:-https://contabo.space/api/health}"
TO="${CONTAB_BACKUP_EMAIL_TO:-$(grep -E '^CONTAB_BACKUP_EMAIL_TO=' "$DIR/.env" 2>/dev/null | cut -d= -f2-)}"
KEY="${RESEND_API_KEY:-$(grep -E '^RESEND_API_KEY=' "$DIR/.env" 2>/dev/null | cut -d= -f2-)}"
LOCK="/tmp/contab-health-alert.lock"
LOG="$DIR/data/backups/health.log"

body=$(curl -sS -m 10 "$URL" 2>&1)
if echo "$body" | grep -q '"ok":true'; then
  rm -f "$LOCK" 2>/dev/null
  exit 0
fi

echo "$(date -Is) HEALTH FAIL: $body" >> "$LOG"
# alerta cel mult o data pe ora
if [ -f "$LOCK" ] && [ $(( $(date +%s) - $(stat -c %Y "$LOCK") )) -lt 3600 ]; then exit 1; fi
touch "$LOCK"
if [ -n "$KEY" ] && [ -n "$TO" ]; then
  curl -sS -m 15 https://api.resend.com/emails \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -H "User-Agent: contab-healthcheck/1.0" \
    -d "{\"from\":\"Contab alerta <comenzi@poetio.site>\",\"to\":[\"$TO\"],\"subject\":\"[Contab] ALERTA: aplicatia nu raspunde\",\"text\":\"Healthcheck esuat la $(date -Is)\\nURL: $URL\\nRaspuns: $(echo "$body" | head -c 200 | tr '\"' \\' )\\n\\nVerifica: pm2 status / pm2 logs contab\"}" \
    >> "$LOG" 2>&1
  echo "" >> "$LOG"
fi
exit 1
