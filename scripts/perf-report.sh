#!/usr/bin/env bash
# Raport zilnic de performanta (cron, o data pe zi): numara in log-urile pm2 avertismentele
# `cerere lenta` (cereri peste CONTAB_SLOW_MS, scrise de middleware-ul de metrici) si erorile
# de server din ultimele 24h. Trimite email DOAR daca a gasit ceva — liniste = totul e ok
# (acelasi stil ca healthcheck.sh). Detaliile pe rute: /api/metrics (admin), in aplicatie.
#
# Veghe de SCALARE: anumite rute (dashboard-ul agregat, SAF-T) sunt O(n) pe numarul de
# inregistrari — inofensive la volumul actual, dar cresc cu datele. Cand una dintre ele apare
# printre cererile lente, raportul o SEMNALEAZA distinct (cu latenta maxima si actiunea de
# optimizare pregatita: cache pe dashboard / streaming SAF-T), ca decizia de scalare sa se ia
# pe un semnal real din productie, nu pe volum ipotetic. Lista: CONTAB_PERF_SCALE_ROUTES.
#
# Variabile (din mediu sau .env):
#   CONTAB_BACKUP_EMAIL_TO    destinatarul raportului
#   RESEND_API_KEY            cheia Resend pentru email
#   CONTAB_PM2_LOG_DIR        directorul log-urilor pm2 (implicit <repo>/logs, vezi ecosystem.config.js)
#   CONTAB_PERF_SCALE_ROUTES  rute urmarite pentru scalare (implicit "dashboard saft")
#   CONTAB_PERF_NOMAIL        1 = nu trimite email, doar afiseaza (teste / rulare manuala)
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
envval() { grep -E "^$1=" "$DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'\'']//;s/["'\'']$//'; }

TO="${CONTAB_BACKUP_EMAIL_TO:-$(envval CONTAB_BACKUP_EMAIL_TO)}"
KEY="${RESEND_API_KEY:-$(envval RESEND_API_KEY)}"
# Log-urile pm2: se cauta in mai multe locuri, fiindca ecosystem.config.js DECLARA
# <repo>/logs, dar procesul poate rula pornit fara acel fisier (atunci pm2 scrie in
# $PM2_HOME/logs). Cautarea in locul gresit e mai rea decat lipsa raportului: scriptul ar
# raporta „nimic de semnalat" la nesfarsit, fara sa vada nimic. Se iau toate directoarele
# candidate care exista, iar prospetimea lor se verifica mai jos.
# CONTAB_PM2_LOG_DIR setat = sursa UNICA (configurare explicita si cale testabila); nesetat =
# se cauta in candidatii cunoscuti.
LOGDIRS=""
if [ -n "${CONTAB_PM2_LOG_DIR:-}" ]; then
  LOGDIRS="$CONTAB_PM2_LOG_DIR"
else
  for d in "$DIR/logs" "/home/contab/.pm2/logs" "$HOME/.pm2/logs"; do
    [ -d "$d" ] && case " $LOGDIRS " in *" $d "*) ;; *) LOGDIRS="$LOGDIRS $d";; esac
  done
fi
LOGDIR="${CONTAB_PM2_LOG_DIR:-$DIR/logs}"   # pastrat pentru compatibilitate/mesaje
LOG="$DIR/data/backups/perf-report.log"
mkdir -p "$DIR/data/backups" 2>/dev/null

# liniile logger-ului incep cu timestamp ISO — pastram doar ultimele 24h (azi + ieri e supra-
# acoperitor, filtrul pe secunde de mai jos taie exact)
AZI=$(date -u +%Y-%m-%d); IERI=$(date -u -d yesterday +%Y-%m-%d)
PRAG=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S)

scan() { # $1 = tiparul cautat; scoate liniile din ultimele 24h
  # shellcheck disable=SC2086
  grep -h "$1" $(for d in $LOGDIRS; do echo "$d"/contab-*.log; done) 2>/dev/null \
    | grep -E "($AZI|$IERI)" \
    | awk -v prag="$PRAG" '{ ts=$1; gsub(/^.*(2[0-9]{3}-)/, "\\1", ts); if (ts >= prag) print }' \
    | tail -200
}

LENTE=$(scan "cerere lenta")
ERORI=$(scan "eroare de server")
NL=$(printf '%s' "$LENTE" | grep -c . || true)
NE=$(printf '%s' "$ERORI" | grep -c . || true)

# ORB vs LINISTE: daca niciun log candidat nu a fost scris in ultimele 25h, scriptul NU are ce
# citi — iar „zero erori" ar fi o minciuna linistitoare. Se raporteaza ca defect de monitorizare.
PROASPAT=0
for d in $LOGDIRS; do
  if [ -n "$(find "$d" -maxdepth 1 -name 'contab-*.log' -mmin -1500 2>/dev/null | head -1)" ]; then PROASPAT=1; break; fi
done
echo "$(date -Is) lente=$NL erori5xx=$NE dirs=[$LOGDIRS] proaspat=$PROASPAT" >> "$LOG"
if [ "$PROASPAT" -eq 0 ]; then
  BODY="Raport performanta Contabo — MONITORIZARE OARBA ($(date -Is)):

Niciun log pm2 scris in ultimele 25h in directoarele cautate:$LOGDIRS

Raportul nu poate vedea cererile lente sau erorile 5xx, deci tacerea lui NU inseamna
ca totul e in regula. Verifica unde scrie pm2:
  sudo -u contab PM2_HOME=/home/contab/.pm2 pm2 jlist | grep pm_out_log_path
si fie porneste procesul cu ecosystem.config.js, fie seteaza CONTAB_PM2_LOG_DIR in cron.
"
  echo "$BODY"
  if [ -n "$TO" ] && [ -n "$KEY" ] && [ "${CONTAB_PERF_NOMAIL:-0}" != "1" ]; then
    curl -s -X POST https://api.resend.com/emails -H "Authorization: Bearer $KEY" \
      -H 'Content-Type: application/json' \
      -d "$(node -e 'const b=process.argv[1],t=process.argv[2];process.stdout.write(JSON.stringify({from:"Contab <comenzi@poetio.site>",to:[t],subject:"[Contab] Raportul de performanta e ORB",text:b}))' "$BODY" "$TO")" >/dev/null || true
  fi
  exit 0
fi
[ "$NL" -eq 0 ] && [ "$NE" -eq 0 ] && exit 0   # nimic de raportat -> niciun email

# rezumat pe rute pentru cererile lente (tiparul url=... din logul structurat)
TOP=$(printf '%s\n' "$LENTE" | grep -o 'url=[^ ]*' | sed 's/url=//; s/?.*//' | sort | uniq -c | sort -rn | head -10)

# ── Veghe de scalare: printre cererile lente, sunt rutele O(n) cunoscute? Daca da, cu ce latenta
# maxima si ce actiune de optimizare le corespunde. (Sub-pragul CONTAB_SLOW_MS nu ajunge in log,
# deci semnalul e chiar traversarea pragului de catre o ruta care ar trebui sa ramana rapida.)
SCALE_ROUTES="${CONTAB_PERF_SCALE_ROUTES:-dashboard saft}"
scale_action() { case "$1" in
  # Memoizarea per-firma EXISTA deja (src/cache.js, invalidata de db.save). Daca dashboard-ul
  # apare totusi ca lent, cauza nu mai e „lipseste cache-ul": ori rata de hit e mica (scrieri
  # dese — vezi `cache` in /api/metrics), ori calea de RECALCULARE a crescut peste prag.
  *dashboard*) echo "verifica hitRate din /api/metrics (cache); daca e bun, calea de recalculare a crescut — profileaza componentele din rep.dashboard";;
  *saft*)      echo "streaming la /xml/saft (fara buffer integral), evita blocarea event loop-ului";;
  *)           echo "vezi src/reporting.js / generatorul rutei";;
esac; }
SCALE=""
for rt in $SCALE_ROUTES; do
  hits=$(printf '%s\n' "$LENTE" | grep "url=/[^ ]*$rt")
  [ -z "$hits" ] && continue
  n=$(printf '%s\n' "$hits" | grep -c .)
  maxms=$(printf '%s\n' "$hits" | grep -o 'ms=[0-9]*' | sed 's/ms=//' | sort -rn | head -1)
  SCALE="$SCALE  • $rt: $n cereri lente, maxim ${maxms}ms — actiune: $(scale_action "$rt")
"
done

BODY="Raport performanta Contabo — ultimele 24h ($(date -Is)):

Cereri lente (peste prag): $NL
Erori de server (5xx): $NE
"
[ -n "$TOP" ] && BODY="$BODY
Rute cu cereri lente:
$TOP
"
[ -n "$SCALE" ] && BODY="$BODY
⚠ Semnal de SCALARE (rute care cresc cu volumul — timpul e sa optimizezi):
$SCALE"
[ "$NE" -gt 0 ] && BODY="$BODY
Ultimele erori:
$(printf '%s\n' "$ERORI" | tail -5)
"
BODY="$BODY
Detalii pe rute si joburi: /api/metrics (admin). Loguri: pm2 logs contab"

if [ "${CONTAB_PERF_NOMAIL:-0}" = "1" ]; then
  printf '%s\n' "$BODY"
elif [ -n "$KEY" ] && [ -n "$TO" ]; then
  text=$(printf '%s' "$BODY" | sed 's/"/\\"/g; s/$/\\n/' | tr -d '\n')
  curl -sS -m 15 https://api.resend.com/emails \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -H "User-Agent: contab-perf-report/1.0" \
    -d "{\"from\":\"Contab alerta <comenzi@poetio.site>\",\"to\":[\"$TO\"],\"subject\":\"[Contab] Raport performanta: $NL lente, $NE erori in 24h\",\"text\":\"$text\"}" \
    >> "$LOG" 2>&1
  echo "" >> "$LOG"
else
  printf '%s\n' "$BODY"
fi
