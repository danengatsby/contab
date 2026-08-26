#!/bin/bash
# Generează și publică toate capturile pe o instanță izolată. Nu citește și nu
# modifică baza live. Rulare: npm run capturi-marketing
# CONTAB_CAPTURI_IZOLAT este garda internă setată de launcher: fixture-ul refuză
# să ruleze fără ea sau în afara unei baze temporare; nu este un knob de producție.
set -euo pipefail

RADACINA=$(cd "$(dirname "$0")/.." && pwd)
PORT=${CAPTURI_PORT:-18099}
PERIOD=${CAPTURI_PERIOD:-$(date -u +%Y-%m)}
IMAGINE=${E2E_IMAGE:-mcr.microsoft.com/playwright:v1.58.2-noble}
TMP=$(mktemp -d /tmp/contab-capturi-XXXXXX)
OUT="$TMP/output"
DBF="$TMP/capturi.json"
DATA="$TMP/data"
mkdir -p "$OUT"

curata() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true
  rm -rf "$TMP"
}
trap curata EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo 'Capturile cer Docker pentru browserul Playwright.' >&2
  exit 2
fi
if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "Portul $PORT este deja folosit de o aplicație; alege CAPTURI_PORT." >&2
  exit 2
fi

echo "── capturi marketing: instanță izolată pe portul $PORT ($PERIOD)"
export CONTAB_DB_DRIVER=sqlite CONTAB_DB_FILE="$DBF" CONTAB_DATA_DIR="$DATA"
export CONTAB_JSON_MIRROR=0 CONTAB_DEV=1 CONTAB_CAPTURI_IZOLAT=1 CAPTURI_PERIOD="$PERIOD"
node "$RADACINA/scripts/seed.js" >/dev/null
node "$RADACINA/scripts/pregateste-capturi-marketing.js"

PORT=$PORT HOST=127.0.0.1 STRIPE_SECRET_KEY='' CONTAB_HIBP=0 \
  CONTAB_RATE_API=100000 CONTAB_RATE_UPLOAD=1000 CONTAB_RATE_IMPORT=1000 \
  node "$RADACINA/server.js" >"$TMP/server.log" 2>&1 &
SRV=$!
timeout 40 bash -c "until curl -sf http://127.0.0.1:$PORT/api/health >/dev/null; do sleep 1; done" \
  || { echo 'Serverul de capturi nu a pornit:'; tail -20 "$TMP/server.log"; exit 1; }

docker run --rm --network host \
  -v "$RADACINA/scripts/capturi-marketing.mjs:/w/capturi.mjs:ro" \
  -v "$OUT:/out" \
  -e BASE_URL="http://127.0.0.1:$PORT" -e CAPTURI_OUTPUT=/out \
  -e CAPTURI_INITIAL_PW="${CAPTURI_INITIAL_PW:-ParolaCapturi2026x!}" \
  -w /w "$IMAGINE" \
  sh -c "npm i --no-save playwright@1.58.2 >/dev/null 2>&1 && node capturi.mjs"

for nume in fb-1-acasa fb-2-portofoliu fb-3-document fb-4-tva fb-5-balanta; do
  for extensie in png jpg; do
    fisier="$nume.$extensie"
    [ -s "$OUT/$fisier" ] || { echo "Lipsește captura $fisier" >&2; exit 1; }
    install -m 0644 "$OUT/$fisier" "$RADACINA/marketing/capturi/$fisier"
    install -m 0644 "$OUT/$fisier" "$RADACINA/public/materiale/$fisier"
  done
done
[ -s "$OUT/capturi-manifest.json" ] || { echo 'Lipsește manifestul capturilor.' >&2; exit 1; }
install -m 0644 "$OUT/capturi-manifest.json" "$RADACINA/marketing/capturi/capturi-manifest.json"
install -m 0644 "$OUT/capturi-manifest.json" "$RADACINA/public/materiale/capturi-manifest.json"

echo '✓ 5 capturi PNG + JPG publicate împreună cu manifestul anti-drift.'
