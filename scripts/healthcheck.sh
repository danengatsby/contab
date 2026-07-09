#!/usr/bin/env bash
# Healthcheck Contab (cron la 5 min): verifica /api/health. La 2 esecuri consecutive incearca
# auto-vindecarea (pm2 restart) si trimite o alerta pe email (Resend, cheia din .env), cel mult
# una pe ora. Cand aplicatia revine dupa o alerta, trimite un email de revenire („totul e ok").
#
# NB: ruland pe acelasi server, prinde aplicatia cazuta/blocata (cazul frecvent), NU si serverul
# ori reteaua cazuta — pentru acoperire externa reala foloseste in plus un monitor din afara
# (ex. UptimeRobot pe https://contabo.space/api/health). Vezi scripts/MONITORING.md.
#
# Variabile (din mediu sau .env):
#   CONTAB_HEALTH_URL          URL-ul verificat            (implicit https://contabo.space/api/health)
#   CONTAB_BACKUP_EMAIL_TO     destinatarul alertelor
#   RESEND_API_KEY             cheia Resend pentru email
#   CONTAB_HEALTH_AUTORESTART  1 = restart pm2 la incident (implicit 1); 0 = doar alerta
#   CONTAB_HEALTH_THRESHOLD    cate esecuri consecutive inainte de alerta (implicit 2)
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
envval() { grep -E "^$1=" "$DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'\'']//;s/["'\'']$//'; }

URL="${CONTAB_HEALTH_URL:-https://contabo.space/api/health}"
TO="${CONTAB_BACKUP_EMAIL_TO:-$(envval CONTAB_BACKUP_EMAIL_TO)}"
KEY="${RESEND_API_KEY:-$(envval RESEND_API_KEY)}"
AUTORESTART="${CONTAB_HEALTH_AUTORESTART:-1}"
THRESHOLD="${CONTAB_HEALTH_THRESHOLD:-2}"
LOCK="/tmp/contab-health-alert.lock"   # exista => o alerta e activa (nu spama)
FAILS="/tmp/contab-health-fails"       # contor de esecuri consecutive
LOG="$DIR/data/backups/health.log"
mkdir -p "$DIR/data/backups" 2>/dev/null

send_mail() { # $1=subiect  $2=text
  [ -n "$KEY" ] && [ -n "$TO" ] || return 0
  local text; text=$(printf '%s' "$2" | sed 's/"/\\"/g; s/$/\\n/' | tr -d '\n')
  curl -sS -m 15 https://api.resend.com/emails \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -H "User-Agent: contab-healthcheck/1.0" \
    -d "{\"from\":\"Contab alerta <comenzi@poetio.site>\",\"to\":[\"$TO\"],\"subject\":\"$1\",\"text\":\"$text\"}" \
    >> "$LOG" 2>&1
  echo "" >> "$LOG"
}

body=$(curl -sS -m 10 "$URL" 2>&1)
if echo "$body" | grep -q '"ok":true'; then
  rm -f "$FAILS" 2>/dev/null
  # revenire dupa o alerta activa -> anunta „totul e ok" si curata lacatul
  if [ -f "$LOCK" ]; then
    echo "$(date -Is) HEALTH RECOVERED" >> "$LOG"
    send_mail "[Contab] ✓ Aplicatia a revenit" "Aplicatia raspunde din nou normal la $(date -Is).\nURL: $URL"
    rm -f "$LOCK" 2>/dev/null
  fi
  exit 0
fi

# --- esec ---
n=$(( $(cat "$FAILS" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAILS"
echo "$(date -Is) HEALTH FAIL (#$n): $(echo "$body" | head -c 200)" >> "$LOG"

# sub prag: doar numaram (evita alarme false la un blip / restart de deploy)
[ "$n" -lt "$THRESHOLD" ] && exit 1

# la prag: incearca auto-vindecarea o singura data pe incident (cat timp nu e alerta activa)
if [ "$AUTORESTART" = "1" ] && [ ! -f "$LOCK" ]; then
  PM2="$(command -v pm2 || echo /usr/bin/pm2)"
  if [ -x "$PM2" ] || command -v pm2 >/dev/null 2>&1; then
    echo "$(date -Is) AUTO-RESTART: pm2 restart contab" >> "$LOG"
    "$PM2" restart contab --update-env >> "$LOG" 2>&1
    sleep 5
    if curl -sS -m 10 "$URL" 2>/dev/null | grep -q '"ok":true'; then
      echo "$(date -Is) AUTO-RESTART OK: aplicatia a revenit" >> "$LOG"
      rm -f "$FAILS" 2>/dev/null
      send_mail "[Contab] ⚠ Repornita automat" "Aplicatia nu raspundea si a fost repornita automat (pm2). Acum raspunde normal.\nMoment: $(date -Is)\nURL: $URL\n\nVerifica pm2 logs contab pentru cauza."
      touch "$LOCK"  # evita re-alerta imediata; se curata la urmatorul ciclu ok
      exit 0
    fi
  fi
fi

# alerta (cel mult una pe ora)
if [ -f "$LOCK" ] && [ $(( $(date +%s) - $(stat -c %Y "$LOCK") )) -lt 3600 ]; then exit 1; fi
touch "$LOCK"
send_mail "[Contab] ALERTA: aplicatia nu raspunde" "Healthcheck esuat de $n ori consecutiv la $(date -Is).\nURL: $URL\nRaspuns: $(echo "$body" | head -c 200)\n\nAuto-restart: ${AUTORESTART} (nereusit sau dezactivat). Verifica: pm2 status / pm2 logs contab"
exit 1
