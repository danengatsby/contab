#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  E2E IZOLAT — scenarii care NU se pot rula pe demo live
#
#  E2E-ul existent (scripts/e2e.mjs) verifica instanta LIVE cu contul demo: e util, dar poate
#  atinge doar ce e sigur pe date reale. Nu poate reseta o parola, activa 2FA, importa fisiere,
#  restaura un backup sau strica ceva intentionat ca sa vada mesajul de eroare.
#
#  Aici pornim o instanta PROPRIE (baza temporara, director de date temporar, port liber), o
#  populam cu seed, rulam scenariile in browser real si o stergem la final. Nimic nu atinge
#  productia: CONTAB_DB_FILE si CONTAB_DATA_DIR sunt obligatorii si temporare (un CONTAB_DATA_DIR
#  uitat ar scrie backup-uri si audit in data/ al instalarii reale).
#
#  Rulare:  bash scripts/e2e-izolat.sh
#  Browserul ruleaza in Docker (serverul nu are bibliotecile de sistem pentru Chromium), cu
#  --network host ca sa ajunga la instanta de pe gazda.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RADACINA=$(cd "$(dirname "$0")/.." && pwd)
PORT=${E2E_PORT:-18777}
TMP=$(mktemp -d /tmp/contab-e2e-XXXXXX)
DBF="$TMP/db.json"
DATA="$TMP/data"
IMG=${E2E_IMAGE:-mcr.microsoft.com/playwright:v1.58.2-noble}
PAROLA='E2E-Izolat-2026!'

curata() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true
  fuser -k "$PORT"/tcp 2>/dev/null || true
  rm -rf "$TMP"
}
trap curata EXIT

echo "── instanta izolata pe portul $PORT (date in $TMP)"
export CONTAB_DB_DRIVER=sqlite CONTAB_DB_FILE="$DBF" CONTAB_DATA_DIR="$DATA"
export CONTAB_DEV=1                 # instanta de test: fara secretele de productie (vezi secretsGuard)
node "$RADACINA/scripts/seed.js" >/dev/null 2>&1

PORT=$PORT HOST=127.0.0.1 CONTAB_JSON_MIRROR=0 STRIPE_SECRET_KEY='' \
  CONTAB_RATE_API=100000 CONTAB_RATE_UPLOAD=1000 CONTAB_RATE_IMPORT=1000 CONTAB_HIBP=0 \
  node "$RADACINA/server.js" >"$TMP/server.log" 2>&1 &
SRV=$!
timeout 40 bash -c "until curl -sf http://127.0.0.1:$PORT/api/health >/dev/null; do sleep 1; done" \
  || { echo "serverul nu a pornit:"; tail -20 "$TMP/server.log"; exit 1; }

# ── pregatire out-of-band: lucruri pe care browserul nu le poate face singur ──
# 1. parola de admin (contul de seed porneste cu admin/admin + mustChange)
API="http://127.0.0.1:$PORT"
C=$(curl -s -D - -o /dev/null -X POST "$API/api/login" -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"admin"}' | grep -i '^set-cookie' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
TOK=$(curl -s -H "Cookie: $C" "$API/api/me" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).csrf||"")}catch(e){console.log("")}})')
curl -s -X POST "$API/api/change-password" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" \
  -H 'Content-Type: application/json' -d "{\"oldPassword\":\"admin\",\"newPassword\":\"$PAROLA\"}" >/dev/null

# 2. SMTP „configurat" (altfel /api/forgot-password nu genereaza token, prin proiectare) + email pe cont
curl -s -X POST "$API/api/smtp" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" -H 'Content-Type: application/json' \
  -d '{"host":"localhost","port":1025,"from":"e2e@local"}' >/dev/null || true
curl -s -X POST "$API/api/profile" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" -H 'Content-Type: application/json' \
  -d '{"email":"admin@e2e.local"}' >/dev/null || true

# 3. utilizator cu drepturi RESTRANSE. ATENTIE: POST /api/users NU accepta `drepturi` la creare
#    (le ignora tacut) — se pun DUPA, pe /api/users/<id>. Prima varianta a acestui script le
#    trimitea la creare si scenariul de roluri trecea degeaba: utilizatorul avea drepturi depline.
UTILIZ=$(curl -s -X POST "$API/api/users" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" -H 'Content-Type: application/json' \
  -d "{\"username\":\"limitat\",\"password\":\"$PAROLA\",\"role\":\"user\",\"firme\":[1]}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).user.id))}catch(e){process.stdout.write("")}})')
[ -n "$UTILIZ" ] && curl -s -X POST "$API/api/users/$UTILIZ" -H "Cookie: $C" -H "X-CSRF-Token: $TOK" \
  -H 'Content-Type: application/json' -d '{"drepturi":{"faraSalarii":true}}' >/dev/null || true

# 4. token de resetare: se cere prin API, apoi se citeste din baza (browserul n-are cum — pleaca pe email)
curl -s -X POST "$API/api/forgot-password" -H 'Content-Type: application/json' \
  -d '{"login":"admin@e2e.local"}' >/dev/null || true
# Tokenul sta pe utilizator, in baza. Driverul e sqlite si oglinda JSON e oprita, deci se
# citeste din tabelul `users` (fiecare rand = blob JSON in coloana `data`), read-only.
RESET=$(node -e '
try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  for (const r of db.prepare("SELECT data FROM users").all()) {
    const u = JSON.parse(r.data);
    if (u && u.resetToken) { process.stdout.write(u.resetToken); break; }
  }
  db.close();
} catch (e) { process.stdout.write(""); }' "$TMP/db.sqlite")
echo "── pregatire: admin ok | utilizator limitat id=${UTILIZ:-?} | token resetare: ${RESET:+prezent}${RESET:-ABSENT}"

echo "── scenarii in browser (Docker)"
set +e
docker run --rm --network host \
  -v "$RADACINA/scripts/e2e-izolat.mjs:/w/e2e.mjs:ro" \
  -e BASE_URL="http://127.0.0.1:$PORT" -e E2E_PAROLA="$PAROLA" -e E2E_RESET="$RESET" \
  -w /w "$IMG" \
  sh -c "npm i --no-save playwright@1.58.2 >/dev/null 2>&1 && node e2e.mjs"
COD=$?
set -e
exit $COD
