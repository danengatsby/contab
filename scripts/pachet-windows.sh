#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
#  PACHETUL WINDOWS — Contabo care ruleaza LOCAL, pe calculatorul utilizatorului.
#
#  Produce `public/descarcari/Contabo-Windows.zip` + manifestul `pachet.json`
#  (versiune, data, marime, amprenta), pe care interfata il citeste ca sa arate
#  butonul de descarcare. Numele fisierului e STABIL: acelasi link serveste si
#  ca instalare, si ca actualizare — utilizatorul nu trebuie sa caute de fiecare
#  data alta adresa.
#
#  Ce intra: codul aplicatiei + node_modules + node.exe (Node oficial pentru
#  Windows, ca sa nu instaleze nimeni nimic) + lansatorul .bat + instructiunile.
#  Ce NU intra, verificat la final si nu doar exclus: `.env` (chei reale),
#  `data/` (baza si documentele), `logs/`, `.git`.
#
#  Rulare:  sh scripts/pachet-windows.sh
#  Coduri:  0 = pachet construit | 1 = eroare | 2 = NEVERIFICAT (unelte lipsa)
#  — distinctia e deliberata, ca la poarta fiscala: „n-am putut construi" nu e
#  „e gata".
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")/.."
RADACINA=$(pwd)

NODE_VER=${CONTAB_PACHET_NODE:-$(node -p "process.versions.node")}
IESIRE="$RADACINA/public/descarcari"
LUCRU=$(mktemp -d)
trap 'rm -rf "$LUCRU"' EXIT

for u in curl unzip zip rsync; do
  command -v "$u" >/dev/null 2>&1 || { echo "NEVERIFICAT: lipseste unealta '$u'." >&2; exit 2; }
done

echo "── Pachet Windows — Node $NODE_VER"

# 1) Runtime-ul Windows, din sursa oficiala. Se ia o singura data si se tine in
#    cache: 35 MB descarcati la fiecare build ar face comanda greu de rulat des.
CACHE=${CONTAB_PACHET_CACHE:-/var/tmp/contab-node-win}
mkdir -p "$CACHE"
ZIPNODE="$CACHE/node-v$NODE_VER-win-x64.zip"
if [ ! -f "$ZIPNODE" ]; then
  echo "   descarc Node $NODE_VER pentru Windows..."
  curl -sfL -o "$ZIPNODE.part" "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-win-x64.zip" \
    || { echo "NEVERIFICAT: nu s-a putut descarca Node pentru Windows." >&2; rm -f "$ZIPNODE.part"; exit 2; }
  mv "$ZIPNODE.part" "$ZIPNODE"
fi
unzip -q -o "$ZIPNODE" -d "$LUCRU/node"
NODEEXE="$LUCRU/node/node-v$NODE_VER-win-x64/node.exe"
[ -f "$NODEEXE" ] || { echo "EROARE: node.exe lipseste din arhiva descarcata." >&2; exit 1; }

# 2) Aplicatia. Excluderile sunt LISTA SCURTA a ce nu are voie sa plece;
#    verificarea de la pasul 5 e cea care chiar dovedeste.
D="$LUCRU/Contabo"
mkdir -p "$D/app" "$D/date"
rsync -a \
  --exclude='.git' --exclude='data' --exclude='logs' \
  --exclude='.env' --exclude='.env.*' --exclude='!.env.example' \
  --exclude='scripts/node_modules' --exclude='*.log' \
  --exclude='.github' --exclude='marketing' --exclude='.claude' \
  --exclude='public/descarcari' \
  "$RADACINA/" "$D/app/"
cp "$RADACINA/.env.example" "$D/app/.env.example" 2>/dev/null || true
cp "$NODEEXE" "$D/node.exe"
cp "$RADACINA/scripts/pachet-windows/Porneste Contabo.bat" "$D/"
cp "$RADACINA/scripts/pachet-windows/CITESTE-MA.txt" "$D/"
cp "$RADACINA/scripts/pachet-windows/genereaza-config.js" "$D/"
printf 'Datele tale apar aici la prima pornire.\r\n' > "$D/date/CITESTE-MA.txt"

# 3) Versiunea: data + commitul. `package.json` are 1.0.0 de la inceput, deci nu
#    spune nimic despre ce ai in mana. Utilizatorul compara VERSIUNE.txt din
#    instalarea lui cu ce scrie pe butonul de descarcare.
COMMIT=$(git -C "$RADACINA" rev-parse --short HEAD 2>/dev/null || echo 'necunoscut')
DATA=$(date +%Y-%m-%d)
VERSIUNE="$DATA ($COMMIT)"
printf 'Contabo pentru Windows\r\nVersiune: %s\r\nNode: %s\r\n' "$VERSIUNE" "$NODE_VER" > "$D/VERSIUNE.txt"

# CRLF pe fisierele citite in Notepad (altfel apar pe un singur rand)
for f in "$D/CITESTE-MA.txt" "$D/Porneste Contabo.bat" "$D/date/CITESTE-MA.txt"; do
  [ -f "$f" ] && python3 -c "import sys;p=sys.argv[1];d=open(p,'rb').read().replace(b'\r\n',b'\n').replace(b'\n',b'\r\n');open(p,'wb').write(d)" "$f"
done

# 4) Arhiva
mkdir -p "$IESIRE"
( cd "$LUCRU" && zip -qr9 "$IESIRE/Contabo-Windows.zip.nou" Contabo )

# 5) VERIFICAREA care conteaza: nicio cheie reala, nicio baza, niciun jurnal.
#    Se face pe ARHIVA CONSTRUITA, nu pe lista de excluderi — o excludere gresita
#    arata identic cu una corecta pana deschizi zip-ul.
LISTA=$(unzip -l "$IESIRE/Contabo-Windows.zip.nou")
for interzis in 'Contabo/app/.env$' 'app/data/' 'app/logs/' 'app/.git/'; do
  if echo "$LISTA" | grep -qE "$interzis"; then
    echo "EROARE: pachetul contine ceva ce nu are voie ($interzis)." >&2
    rm -f "$IESIRE/Contabo-Windows.zip.nou"; exit 1
  fi
done
# Se compara doar SECRETELE, nu tot `.env`. Prima forma lua orice linie cu valoare lunga si
# pica pe `APP_URL=https://contabo.space` — care apare legitim in cod, in docs si in README.
# O verificare care pica din motivul gresit se dezactiveaza dupa a doua oara; una care numeste
# cheia gasita se repara.
#    Cautarea se face PRIN FLUX (`unzip -p`), nu pe arhiva dezarhivata: desfacerea inseamna ~200 MB
#    pe disc, iar `/tmp` e un tmpfs de 3,8 G — build-ul a si picat o data cu „disk full", adica
#    dintr-un motiv care n-avea nimic de-a face cu ce verifica.
if [ -f "$RADACINA/.env" ]; then
  GASIT=0
  for cheie in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET ANTHROPIC_API_KEY OPENAI_API_KEY \
               RESEND_API_KEY CONTAB_AUTH_SECRET CONTAB_SECRETS_KEY CONTAB_SECRETS_KEY_OLD \
               CONTAB_BACKUP_KEY CONTAB_OFFSITE_SECRET CONTAB_OFFSITE_KEY CONTAB_PG_URL; do
    val=$(grep -E "^$cheie=" "$RADACINA/.env" 2>/dev/null | head -1 | cut -d= -f2-)
    [ -z "$val" ] && continue
    [ ${#val} -lt 12 ] && continue
    if unzip -p "$IESIRE/Contabo-Windows.zip.nou" 2>/dev/null | grep -qF "$val"; then
      echo "EROARE: valoarea lui $cheie a ajuns in pachet." >&2; GASIT=1
    fi
  done
  [ "$GASIT" = 1 ] && { rm -f "$IESIRE/Contabo-Windows.zip.nou"; exit 1; }
fi

mv "$IESIRE/Contabo-Windows.zip.nou" "$IESIRE/Contabo-Windows.zip"
chmod 644 "$IESIRE/Contabo-Windows.zip"

# 6) Manifestul citit de interfata. Fara el, butonul nu se arata — o instalare
#    proaspata (unde pachetul nu e construit) nu trebuie sa ofere un link mort.
OCTETI=$(stat -c%s "$IESIRE/Contabo-Windows.zip")
AMPRENTA=$(sha256sum "$IESIRE/Contabo-Windows.zip" | cut -d' ' -f1)
cat > "$IESIRE/pachet.json" <<JSON
{
  "versiune": "$VERSIUNE",
  "data": "$DATA",
  "node": "$NODE_VER",
  "octeti": $OCTETI,
  "sha256": "$AMPRENTA",
  "fisier": "/descarcari/Contabo-Windows.zip"
}
JSON
chmod 644 "$IESIRE/pachet.json"

echo "── Gata: $(du -h "$IESIRE/Contabo-Windows.zip" | cut -f1)  versiunea $VERSIUNE"
echo "   https://contabo.space/descarcari/Contabo-Windows.zip"
