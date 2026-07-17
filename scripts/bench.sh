#!/bin/bash
# Benchmark: masoara endpoint-urile cheie pe o instanta DEV izolata cu N inregistrari
# sintetice (baza temporara; nu atinge productia). Folosire: bash scripts/bench.sh 50000
# Politica proiectului: optimizarile de performanta se fac DOAR pe baza acestor masuratori
# (referinte in docs si in mesajele de commit).
set -e
N=$1
SP="$(dirname "$0")"
fuser -k 3891/tcp 2>/dev/null || true; sleep 1
rm -f /tmp/contab-bench.json* /tmp/contab-bench.sqlite*
export CONTAB_DB_DRIVER=sqlite CONTAB_DB_FILE=/tmp/contab-bench.json
node /var/www/contab/scripts/seed.js >/dev/null 2>&1
node "$SP"/bench-seed.js $N | tail -1
PORT=3891 CONTAB_JSON_MIRROR=0 STRIPE_SECRET_KEY='' CONTAB_RATE_API=100000 nohup node /var/www/contab/server.js > /dev/null 2>&1 &
timeout 30 bash -c 'until curl -sf http://127.0.0.1:3891/api/health >/dev/null; do sleep 1; done'
# login admin (+ schimbarea fortata a parolei pe DB proaspat)
C=$(curl -s -D - -o /dev/null -X POST http://127.0.0.1:3891/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}' | grep -i '^set-cookie' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
curl -s -X POST http://127.0.0.1:3891/api/change-password -H "Cookie: $C" -H 'Content-Type: application/json' -d '{"oldPassword":"admin","newPassword":"Bench-2026-Parola!"}' >/dev/null
echo "── N=$N (medii pe 3 rulari, dupa una de incalzire) ──"
for url in '/api/entries' '/api/dashboard' '/api/balance?period=2026-06' '/api/vat-journals?period=2026-06' '/xml/saft?year=2026' '/pdf/journal?period=2026-06' '/api/statements/pl-f20?year=2026' '/csv/balance?period=2026-06'; do
  curl -s -o /dev/null -H "Cookie: $C" "http://127.0.0.1:3891$url"   # incalzire
  T=0; SZ=0
  for i in 1 2 3; do
    R=$(curl -s -o /dev/null -w '%{time_total} %{size_download} %{http_code}' -H "Cookie: $C" "http://127.0.0.1:3891$url")
    T=$(echo "$T $(echo $R | cut -d' ' -f1)" | awk '{print $1+$2}')
    SZ=$(echo $R | cut -d' ' -f2); CODE=$(echo $R | cut -d' ' -f3)
  done
  AVG=$(echo $T | awk '{printf "%d", $1/3*1000}')
  printf '%-42s %4d ms  %8d B  (%s)\n' "$url" "$AVG" "$SZ" "$CODE"
done
fuser -k 3891/tcp 2>/dev/null || true
