#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
#  SUITA PE DRIVERUL DE PRODUCTIE (PostgreSQL)
#
#  De ce exista: `npm test` ruleaza pe SQLITE, iar test/store-pg.js se sare tacit
#  fara CONTAB_PG_URL. Deci o suita verde local NU inseamna ca driverul cu care
#  ruleaza productia e verificat — exact genul de incredere falsa impotriva careia
#  e construit restul proiectului.
#
#  Pana acum pasul era o reteta manuala de sase comenzi din CLAUDE.md. Retetele
#  manuale se uita si se scriu gresit: aceasta chiar a FOST gresita o vreme
#  (CONTAB_DB_DRIVER in loc de CONTAB_TEST_DRIVER), iar suita rula pe sqlite
#  raportand „557 verificari trecute" — verde, pe driverul nepotrivit.
#
#  Ce ruleaza — ACELEASI trei probe ca jobul `test-postgres` din CI, ca sa nu existe
#  „verde local, rosu in CI" (si nici invers):
#    test/store-pg.js                       persistenta incrementala pe pg
#    CONTAB_TEST_DRIVER=pg test/http.js     suita HTTP completa pe pg
#    ...aceeasi, cu CONTAB_SQL_READ_THRESHOLD=0   balanta pe calea SQL
#  A treia nu e un lux: read-after-write invechit s-a vazut DOAR pe pg cu prag 0
#  (citirile SQL nu asteptau coada de persistenta). CI o ruleaza chemand tot acest
#  script, deci lista de mai sus e sursa unica — nu doua liste paralele care driftează.
#
#  Containerul e EFEMER: se sterge si daca suita pica (trap EXIT). Portul se alege
#  liber, deci doua rulari in paralel nu se ciocnesc.
#
#  Daca CONTAB_PG_URL e deja setat (CI, baza proprie), se foloseste ACELA si nu se
#  porneste niciun container.
#
#  Iesire: 0 = verde | 1 = teste picate | 2 = NEVERIFICAT (docker lipsa, baza nu
#  porneste). Ultimul e distinct deliberat: „n-am putut verifica" nu e „e bine".
# ─────────────────────────────────────────────────────────────────────────────
set -eu

AICI=$(dirname "$0")
RADACINA=$(cd "$AICI/.." && pwd)
cd "$RADACINA"

CONTAINER=''
curata() {
  [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap curata EXIT INT TERM

if [ -n "${CONTAB_PG_URL:-}" ]; then
  echo "[test-pg] folosesc CONTAB_PG_URL din mediu (fara container)."
  PG="$CONTAB_PG_URL"
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "[test-pg] NEVERIFICAT: docker lipseste si CONTAB_PG_URL nu e setat." >&2
    echo "           Driverul de productie (pg) NU a fost verificat — asta nu e o suita verde." >&2
    echo "           Instaleaza docker, sau da o baza proprie: CONTAB_PG_URL=postgres://... npm run test-pg" >&2
    exit 2
  fi
  # port liber cerut de la OS (ca `freePort()` din test/http.js): fara el, doua rulari
  # in paralel — sau o instanta uitata — s-ar ciocni pe un port fix
  PORT=$(node -e 'const n=require("net"),s=n.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')
  CONTAINER="contab-pgtest-$$"
  echo "[test-pg] pornesc ${CONTAB_PGTEST_IMAGE:-postgres:18} efemer ($CONTAINER) pe portul $PORT…"
  # Versiunea majora urmareste PRODUCTIA (18.4 la 2026-07-29), nu o valoare veche: un `postgres:16`
  # scris de mana ar verifica driverul pe alt server decat cel real — si chiar difera destul incat
  # un dump de pe 18 sa nu se rejoace pe 16. Se poate suprascrie pentru probe pe alta versiune.
  IMAGINE=${CONTAB_PGTEST_IMAGE:-postgres:18}
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_USER=contab -e POSTGRES_PASSWORD=contab -e POSTGRES_DB=contab_test \
    -p "$PORT:5432" "$IMAGINE" >/dev/null

  # asteptam sa accepte conexiuni; o baza care nu porneste e NEVERIFICAT, nu esec de test
  gata=0
  i=0
  while [ "$i" -lt 60 ]; do
    if docker exec "$CONTAINER" pg_isready -U contab >/dev/null 2>&1; then gata=1; break; fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$gata" -eq 0 ]; then
    echo "[test-pg] NEVERIFICAT: baza nu a pornit in 60s." >&2
    docker logs "$CONTAINER" 2>&1 | tail -20 >&2
    exit 2
  fi
  PG="postgres://contab:contab@127.0.0.1:$PORT/contab_test"
fi

esec=0

echo
echo "── test/store-pg.js (persistenta incrementala pe pg) ─────────────────────"
if CONTAB_PG_URL="$PG" node test/store-pg.js; then :; else esec=1; fi

echo
echo "── test/http.js pe driverul pg (suita HTTP completa) ─────────────────────"
# ATENTIE: variabila e CONTAB_TEST_DRIVER. test/http.js isi porneste propriul server
# si de acolo isi impune driverul; un CONTAB_DB_DRIVER pus in fata ar fi ignorat.
if CONTAB_TEST_DRIVER=pg CONTAB_PG_URL="$PG" node test/http.js; then :; else esec=1; fi

echo
echo "── test/http.js pe pg cu prag SQL 0 (balanta pe calea SQL) ───────────────"
# Pragul 0 forteaza TOATE citirile pe calea SQL. Acolo s-a vazut, si numai acolo,
# read-after-write invechit: citirile nu asteptau coada de persistenta.
if CONTAB_TEST_DRIVER=pg CONTAB_PG_URL="$PG" CONTAB_SQL_READ_THRESHOLD=0 node test/http.js; then :; else esec=1; fi

echo
if [ "$esec" -eq 0 ]; then
  echo "[test-pg] VERDE — driverul de productie (pg) e verificat."
else
  echo "[test-pg] PICAT — vezi mai sus ce suita a cazut pe pg." >&2
fi
exit "$esec"
