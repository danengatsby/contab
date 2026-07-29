#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
#  DRILL DE RTO — cat dureaza sa reintre aplicatia in functiune dintr-o arhiva
#
#  De ce exista: RTO era o ESTIMARE, nu o masuratoare (backlog, itemul 7, criteriu
#  de acceptanta neindeplinit). Un numar de continuitate scris din burta e mai rau
#  decat lipsa lui, fiindca cineva se bazeaza pe el la ora cea mai proasta.
#
#  Ce face, cronometrand fiecare etapa:
#    1. despachetare       arhiva -> contab.sql + db.json + uploads/
#    2. descifrare         doar daca arhiva e .enc (openssl) — vezi nota de mai jos
#    3. restaurare baza    rejoaca contab.sql intr-un PostgreSQL EFEMER (docker)
#    4. fisiere            uploads/ intr-un CONTAB_DATA_DIR temporar
#    5. pornire + probe    porneste serverul pe port efemer si asteapta /api/health
#    6. verificare date    firme din /api/health + coerenta contabila pe baza restaurata
#
#  NU atinge productia: baza e intr-un container efemer, datele intr-un director
#  temporar, portul e liber, iar lock-ul single-instance urmeaza CONTAB_DATA_DIR.
#  Nu scrie nimic in data/ real si nu trimite niciun e-mail.
#
#  CE NU MASOARA: obtinerea arhivei din offsite. Astazi offsite-ul e un ATASAMENT
#  DE E-MAIL, deci etapa aceea e manuala (deschide mesajul, descarca) si depinde de
#  om si de retea, nu de cod. Drill-ul porneste de la arhiva deja in mana si o spune
#  raspicat in raport — un total care ar inghiti tacut o etapa manuala ar fi fictiune.
#
#  Folosire:
#    sh scripts/rto-drill.sh [cale/arhiva.zip]     implicit: cea mai recenta full-*.zip
#
#  Iesire: 0 = restaurare reusita si date corecte | 1 = restaurare esuata
#          2 = NEVERIFICAT (docker/psql lipsa, arhiva absenta)
# ─────────────────────────────────────────────────────────────────────────────
set -eu

AICI=$(dirname "$0")
RADACINA=$(cd "$AICI/.." && pwd)
cd "$RADACINA"

# Milisecunde. NU prin `date +%s%3N`: pe aceasta masina `%3N` nu e onorat si intoarce
# NANOsecunde, deci toate duratele ieseau de un milion de ori mai mari (si totalul, negativ prin
# depasire). Convertim explicit din %N si cadem pe node daca `date` nu-l cunoaste.
acum_ms() {
  n=$(date +%s%N 2>/dev/null || echo x)
  case "$n" in
    ''|*[!0-9]*) node -e 'process.stdout.write(String(Date.now()))' ;;
    *) echo $(( n / 1000000 )) ;;
  esac
}
T_START=$(acum_ms)

CONTAINER=''
TMP=''
SRV_PID=''
curata() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [ -n "$TMP" ] && rm -rf "$TMP" || true
}
trap curata EXIT INT TERM

# ── arhiva ────────────────────────────────────────────────────────────────────
ARHIVA=${1:-}
if [ -z "$ARHIVA" ]; then
  ARHIVA=$(ls -1t data/backups/full-*.zip 2>/dev/null | head -1 || true)
fi
if [ -z "$ARHIVA" ] || [ ! -f "$ARHIVA" ]; then
  echo "[rto] NEVERIFICAT: nu am gasit nicio arhiva (data/backups/full-*.zip)." >&2
  exit 2
fi
for unealta in docker psql unzip; do
  command -v "$unealta" >/dev/null 2>&1 || { echo "[rto] NEVERIFICAT: lipseste \`$unealta\`." >&2; exit 2; }
done

MARIME=$(du -h "$ARHIVA" | cut -f1)
echo "[rto] arhiva: $ARHIVA ($MARIME)"
TMP=$(mktemp -d /tmp/contab-rto-XXXXXX)

# ── 1/2. descifrare (daca e cazul) + despachetare ─────────────────────────────
t0=$(acum_ms)
SURSA="$ARHIVA"
case "$ARHIVA" in
  *.enc)
    [ -n "${CONTAB_BACKUP_KEY:-}" ] || { echo "[rto] NEVERIFICAT: arhiva e criptata, dar CONTAB_BACKUP_KEY nu e setat." >&2; exit 2; }
    SURSA="$TMP/arhiva.zip"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$ARHIVA" -out "$SURSA" -pass env:CONTAB_BACKUP_KEY
    ;;
esac
T_DECRIPT=$(( $(acum_ms) - t0 ))

t0=$(acum_ms)
unzip -q "$SURSA" -d "$TMP/continut"
T_UNZIP=$(( $(acum_ms) - t0 ))
[ -f "$TMP/continut/contab.sql" ] || { echo "[rto] NEVERIFICAT: arhiva nu contine contab.sql." >&2; exit 2; }

# ── 3. baza: PostgreSQL efemer + rejucarea dump-ului ──────────────────────────
t0=$(acum_ms)
PORT_PG=$(node -e 'const n=require("net"),s=n.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')
# Versiunea majora se DERIVA din antetul dump-ului („Dumped from database version 18.4"), nu se
# fixeaza aici: un dump de pe 18 nu se rejoaca pe 16 (`transaction_timeout` e parametru nou), deci
# un numar scris de mana ar face drill-ul sa pice — sau, mai rau, sa masoare o restaurare pe alta
# versiune decat cea reala. Prima rulare a picat exact asa, pe un `postgres:16` scris de mana.
MAJOR=$(sed -n 's/.*Dumped from database version \([0-9][0-9]*\).*/\1/p' "$TMP/continut/contab.sql" | head -1)
[ -n "$MAJOR" ] || MAJOR=18
# CONTAB_PGTEST_IMAGE suprascrie imaginea (probe pe alta versiune decat cea a dump-ului).
IMAGINE=${CONTAB_PGTEST_IMAGE:-postgres:$MAJOR}
echo "[rto] dump produs de PostgreSQL $MAJOR -> restaurez pe $IMAGINE"
CONTAINER="contab-rto-$$"
docker run -d --name "$CONTAINER" -e POSTGRES_USER=contab -e POSTGRES_PASSWORD=contab \
  -e POSTGRES_DB=contab -p "$PORT_PG:5432" "$IMAGINE" >/dev/null
i=0
while [ "$i" -lt 90 ]; do
  docker exec "$CONTAINER" pg_isready -U contab >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 1
done
[ "$i" -lt 90 ] || { echo "[rto] NEVERIFICAT: baza efemera nu a pornit." >&2; exit 2; }
T_BAZA_UP=$(( $(acum_ms) - t0 ))

PG="postgres://contab:contab@127.0.0.1:$PORT_PG/contab"
t0=$(acum_ms)
PGPASSWORD=contab psql -v ON_ERROR_STOP=1 -q -d "$PG" -f "$TMP/continut/contab.sql" >/dev/null
T_RESTORE=$(( $(acum_ms) - t0 ))

# ── 4. fisiere (uploads) ──────────────────────────────────────────────────────
t0=$(acum_ms)
DATA_TMP="$TMP/data"
mkdir -p "$DATA_TMP"
[ -d "$TMP/continut/uploads" ] && cp -r "$TMP/continut/uploads" "$DATA_TMP/uploads" || mkdir -p "$DATA_TMP/uploads"
NR_FISIERE=$(find "$DATA_TMP/uploads" -type f | wc -l)
T_FISIERE=$(( $(acum_ms) - t0 ))

# ── 5. pornirea aplicatiei pe baza restaurata ─────────────────────────────────
t0=$(acum_ms)
PORT_APP=$(node -e 'const n=require("net"),s=n.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')
CONTAB_DEV=1 CONTAB_DB_DRIVER=pg CONTAB_PG_URL="$PG" \
  CONTAB_DATA_DIR="$DATA_TMP" CONTAB_DB_FILE="$DATA_TMP/db.json" \
  PORT="$PORT_APP" STRIPE_SECRET_KEY='' \
  node server.js >"$TMP/server.log" 2>&1 &
SRV_PID=$!
SANATATE=''
i=0
while [ "$i" -lt 90 ]; do
  SANATATE=$(curl -s "http://127.0.0.1:$PORT_APP/api/health" 2>/dev/null || true)
  case "$SANATATE" in *'"ok":true'*) break ;; esac
  kill -0 "$SRV_PID" 2>/dev/null || { echo "[rto] serverul a murit la pornire:"; tail -20 "$TMP/server.log"; exit 1; }
  i=$((i + 1)); sleep 1
done
case "$SANATATE" in *'"ok":true'*) : ;; *) echo "[rto] serverul nu a raspuns la /api/health in 90s:"; tail -20 "$TMP/server.log" >&2; exit 1 ;; esac
T_APP_UP=$(( $(acum_ms) - t0 ))

# ── 6. datele restaurate sunt CORECTE, nu doar prezente ───────────────────────
t0=$(acum_ms)
VERIF=$(CONTAB_PG_URL="$PG" node -e '
const drill = require("./src/restoreDrill");
const { graphFromDb } = require("./src/pgRestoreDrill");
graphFromDb(process.env.CONTAB_PG_URL, "contab").then(({ d }) => {
  const r = drill.drillGraph(d);
  console.log(JSON.stringify({ ok: r.ok, firme: r.nrFirme, articole: r.totalEntries, motiv: r.motiv || "" }));
}).catch((e) => { console.log(JSON.stringify({ ok: false, motiv: String(e.message) })); });
')
T_VERIF=$(( $(acum_ms) - t0 ))

FIRME_HEALTH=$(echo "$SANATATE" | sed 's/.*"firme":\([0-9]*\).*/\1/')
VERIF_OK=$(echo "$VERIF" | sed 's/.*"ok":\([a-z]*\).*/\1/')

TOTAL=$(( $(acum_ms) - T_START ))
ms() { printf '%d.%03d s' $(( $1 / 1000 )) $(( $1 % 1000 )); }

echo
echo "┌─ RTO masurat ────────────────────────────────────────────────"
printf "│ descifrare            %s\n" "$(ms "$T_DECRIPT")"
printf "│ despachetare          %s\n" "$(ms "$T_UNZIP")"
printf "│ pornire PostgreSQL    %s   (artefact al probei — vezi nota)\n" "$(ms "$T_BAZA_UP")"
printf "│ rejucare contab.sql   %s\n" "$(ms "$T_RESTORE")"
printf "│ fisiere (uploads)     %s   (%s fisiere)\n" "$(ms "$T_FISIERE")" "$NR_FISIERE"
printf "│ pornire aplicatie     %s\n" "$(ms "$T_APP_UP")"
printf "│ verificare date       %s\n" "$(ms "$T_VERIF")"
echo "├──────────────────────────────────────────────────────────────"
printf "│ TOTAL (de la arhiva in mana pana la serviciu verificat)  %s\n" "$(ms "$TOTAL")"
echo "└──────────────────────────────────────────────────────────────"
echo "  /api/health: $FIRME_HEALTH firme   |   coerenta contabila: $VERIF"
echo "  NEINCLUS: obtinerea arhivei din offsite (azi = atasament de e-mail, pas manual)."
echo "  NOTA: „pornire PostgreSQL\" e artefact al probei (container efemer). La o restaurare"
echo "        reala serverul de baze e deja pornit, deci acel timp NU face parte din RTO."

[ "$VERIF_OK" = "true" ] || { echo "[rto] PICAT: baza restaurata nu e coerenta contabil." >&2; exit 1; }
echo "[rto] VERDE — serviciul a fost readus si datele verificate."
