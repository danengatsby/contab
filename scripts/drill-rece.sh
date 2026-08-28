#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
#  DRILL RECE — restaurarea pe o masina pe care aplicatia NU exista
#
#  Ce probeaza, si nimic altceva nu proba pana acum: ca din formatul copiei offsite CRIPTATE plus
#  cheia de criptare se poate ajunge inapoi la date, PE O MASINA GOALA. Drill-urile existente
#  ruleaza pe
#  acest server, cu codul, cu Node si cu `.env` la indemana — deci raspund la „arhiva e buna?",
#  nu la „ce fac daca serverul nu mai exista?".
#
#  Scenariul simulat e chiar cel de dezastru: container curat, fara depozit, fara Node, fara
#  aplicatie. Doar `openssl` si `unzip` — utilitare care exista pe orice masina si care au fost
#  alese deliberat in scripts/backup.js tocmai pentru asta (un format propriu ar fi legat
#  recuperarea de codul tocmai pierdut).
#
#  Folosire:
#    sh scripts/drill-rece.sh                 ultima arhiva locala, cheia din .env
#    sh scripts/drill-rece.sh <arhiva.zip>    o arhiva anume
#
#  Coduri: 0 = restaurare dovedita | 1 = ESUAT | 2 = NEVERIFICAT (docker/cheie lipsa)
#  Distinctia 1 vs 2 e deliberata, ca la poarta fiscala: „n-am putut verifica" nu e „e bine".
# ─────────────────────────────────────────────────────────────────────────────
set -eu
RADACINA=$(cd "$(dirname "$0")/.." && pwd)
cd "$RADACINA"

ARHIVA=${1:-$(ls -t data/backups/full-*.zip 2>/dev/null | head -1)}
[ -n "${ARHIVA:-}" ] && [ -f "$ARHIVA" ] || { echo "NEVERIFICAT: nicio arhiva de backup gasita."; exit 2; }

# Cheia se ia din .env, ca la backup. NU se afiseaza si NU se scrie nicaieri.
CHEIE=$(sed -n 's/^CONTAB_BACKUP_KEY=//p' .env 2>/dev/null | head -1 | tr -d '"'"'"'')
[ -n "${CHEIE:-}" ] || { echo "NEVERIFICAT: CONTAB_BACKUP_KEY nu e in .env — copia offsite nu e criptata."; exit 2; }

command -v docker >/dev/null 2>&1 || { echo "NEVERIFICAT: docker lipseste."; exit 2; }

LUCRU=$(mktemp -d)
trap 'rm -rf "$LUCRU"' EXIT
cp "$ARHIVA" "$LUCRU/arhiva.zip"

echo "── Drill rece: $(basename "$ARHIVA") ($(wc -c < "$ARHIVA") octeti)"

# 1) Criptam exact ca backupul offsite, ca sa plecam de la ce chiar pleaca de pe server.
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -in "$LUCRU/arhiva.zip" -out "$LUCRU/arhiva.zip.enc" -pass "pass:$CHEIE"
echo "   criptat ca offsite:            $(wc -c < "$LUCRU/arhiva.zip.enc") octeti"
rm -f "$LUCRU/arhiva.zip"   # de aici incolo exista DOAR fisierul criptat, ca in cutia postala

# 2) Masina goala: container fara depozit, fara Node, cu doar ce ar avea oricine.
cat > "$LUCRU/inauntru.sh" <<'INEOF'
set -eu
apk add --no-cache openssl unzip >/dev/null 2>&1 || { apt-get -qq update >/dev/null && apt-get -qq install -y openssl unzip >/dev/null; }
cd /w
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in arhiva.zip.enc -out clar.zip -pass "env:CHEIE"
unzip -qo clar.zip -d desfacut
echo "FISIERE=$(find desfacut -type f | wc -l)"
echo "ARE_DB=$([ -f desfacut/db.json ] && echo da || echo nu)"
echo "OCTETI_DB=$(wc -c < desfacut/db.json 2>/dev/null || echo 0)"
# CONTINUTUL, nu doar prezenta: un drill care spune „trecut" pentru un db.json gol nu probeaza
# nimic. Se numara chei care exista doar intr-o baza reala si se afiseaza cate s-au gasit.
echo "FIRME=$(grep -o '"firme"' desfacut/db.json | wc -l)"
echo "ARTICOLE=$(grep -o '"entries"' desfacut/db.json | wc -l)"
echo "CUI=$(grep -o '"cui"' desfacut/db.json | wc -l)"
INEOF

IES=$(docker run --rm -v "$LUCRU:/w" -w /w -e CHEIE="$CHEIE" alpine:3 sh /w/inauntru.sh 2>&1) || {
  echo "$IES" | tail -5; echo "ESUAT: restaurarea pe masina goala nu a reusit."; exit 1; }

echo "$IES" | sed 's/^/   /'
ARE_DB=$(echo "$IES" | sed -n 's/^ARE_DB=//p')
FISIERE=$(echo "$IES" | sed -n 's/^FISIERE=//p')
OCTETI=$(echo "$IES" | sed -n 's/^OCTETI_DB=//p')
FIRME=$(echo "$IES" | sed -n 's/^FIRME=//p')
CUI=$(echo "$IES" | sed -n 's/^CUI=//p')
[ "$ARE_DB" = "da" ] || { echo "ESUAT: arhiva s-a desfacut, dar fara db.json."; exit 1; }
[ "${FISIERE:-0}" -gt 10 ] || { echo "ESUAT: doar ${FISIERE:-0} fisiere in arhiva — prea putine."; exit 1; }
# Continut, nu doar prezenta: un db.json de cateva sute de octeti sau fara firme ar trece o
# verificare pe existenta si n-ar valora nimic la o restaurare adevarata.
[ "${OCTETI:-0}" -gt 10000 ] || { echo "ESUAT: db.json are doar ${OCTETI:-0} octeti."; exit 1; }
[ "${FIRME:-0}" -gt 0 ] && [ "${CUI:-0}" -gt 0 ] || { echo "ESUAT: db.json nu contine firme cu CUI — restaurare goala."; exit 1; }

echo ""
echo "✓ DRILL RECE TRECUT — din arhiva in formatul offsite plus cheie se ajunge la date"
echo "  pe o masina fara depozit, fara Node si fara aplicatie (doar openssl + unzip)."
echo "  Continut dovedit: $FISIERE fisiere, db.json de $OCTETI octeti, cu firme si CUI-uri."
echo ""
echo "  ATENTIE, partea pe care drill-ul NU o poate proba: cheia a fost citita din .env, adica"
echo "  DE PE ACEST SERVER. Daca serverul dispare, dispare si ea, iar arhivele din stocarea obiect"
echo "  raman necitibile. Copia cheii in alt loc e singurul pas ramas, si e o actiune omeneasca."
