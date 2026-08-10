#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
#  PACHETUL PORTABIL — aplicatia cu tot cu dependintele ei, pentru orice sistem
#
#  Produce `public/descarcari/Contabo-portabil.tar.gz` + manifestul
#  `portabil.json`. Spre deosebire de pachetul Windows, NU contine Node: cere
#  un Node >= 22.13 deja instalat. In schimb merge pe Linux, macOS si WSL,
#  si e de doua ori si jumatate mai mic.
#
#  Ce intra: codul aplicatiei + `node_modules` (deci nu e nevoie de `npm ci`,
#  care ar cere retea si ar putea aduce alte versiuni decat cele probate aici).
#
#  Ce NU intra, si e VERIFICAT la final, nu doar exclus: `.env` si orice
#  `.env.*` (chei reale), `data/` (baza, documentele, backupurile), `logs/`,
#  `.git`, si arhivele din `public/descarcari` (altfel pachetul s-ar contine
#  pe sine, iar la a doua rulare ar creste cu 90 MB).
#
#  DE CE se verifica arhiva CONSTRUITA si nu lista de excluderi: o excludere
#  gresita arata exact ca una corecta pana deschizi arhiva. S-a intamplat:
#  prima arhiva portabila, construita ad-hoc, a inclus `.env.bak-prepg` cu chei
#  vii, fiindca excluderea era `.env`, nu `.env.*`. A fost prinsa inainte de
#  publicare — dar numai fiindca cineva s-a uitat. Scriptul asta se uita singur.
#
#  Rulare:  sh scripts/pachet-portabil.sh   (sau `npm run pachet-portabil`)
#  Coduri:  0 = pachet construit | 1 = EROARE (inclusiv „contine ce nu trebuie")
#           | 2 = NEVERIFICAT (unelte lipsa) — distinctia e deliberata, ca la
#           poarta fiscala: „n-am putut construi" nu e „e gata".
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")/.."
RADACINA=$(pwd)
IESIRE="$RADACINA/public/descarcari"

for u in rsync tar sha256sum; do
  command -v "$u" >/dev/null 2>&1 || { echo "NEVERIFICAT: lipseste \`$u\`." >&2; exit 2; }
done
[ -d "$RADACINA/node_modules" ] || { echo "NEVERIFICAT: node_modules lipseste — ruleaza \`npm ci\` intai." >&2; exit 2; }

# Directorul de lucru NU merge in /tmp: pe acest server e un tmpfs de 3,8 G, iar copia
# aplicatiei cu tot cu node_modules trece de 250 MB — build-ul a picat din „No space left
# on device", adica dintr-un motiv care n-are nimic de-a face cu ce construieste.
# Se foloseste discul real, langa depozit, cu revenire la /tmp doar daca nu se poate scrie.
LUCRU=$(mktemp -d "$RADACINA/../.pachet-portabil.XXXXXX" 2>/dev/null || mktemp -d)
trap 'rm -rf "$LUCRU"' EXIT
D="$LUCRU/Contabo"
mkdir -p "$D"

echo "── Pachetul portabil"

# 1) Aplicatia.
#
# Toate excluderile sunt ANCORATE cu `/` la radacina depozitului. In rsync, un tipar fara `/`
# se potriveste la ORICE adancime — iar `--exclude='data'` a sters si `node_modules/pdfkit/js/
# data/`, adica fonturile Helvetica. Consecinta: TOATE cele 20 de rute PDF raspundeau cu 500 pe
# masina clientului, in timp ce arhiva arata perfect la inspectie. Excluderea gresita nu se vede
# in lista de excluderi; se vede abia cand rulezi ce ai construit — de aceea exista pasul 5.
rsync -a \
  --exclude='/.git' --exclude='/data' --exclude='/logs' \
  --exclude='/.env' --exclude='/.env.*' \
  --exclude='/scripts/node_modules' --exclude='/*.log' \
  --exclude='/marketing' --exclude='/.claude' \
  --exclude='/public/descarcari' --exclude='/tmp' \
  "$RADACINA/" "$D/"
# `.env.example` e SINGURUL fisier din familia `.env` care are voie: e sablonul,
# fara valori. Se copiaza explicit, dupa excluderea intregii familii.
cp "$RADACINA/.env.example" "$D/.env.example"
mkdir -p "$D/public/descarcari"
printf 'Descărcările generate apar aici.\n' > "$D/public/descarcari/CITESTE-MA.txt"

# MARCAJUL DE DISTRIBUTIE. `marketing/` (98 MB de capturi si text comercial intern) nu pleaca
# in pachet, dar suita are o poarta care il citeste — si `npm test` ruleaza la `prestart`, deci
# fara marcaj aplicatia pur si simplu nu porneste la client. Marcajul e un semnal POZITIV: poarta
# sare doar cand il vede, si spune ca a sarit. Pe depozit marcajul nu exista, deci poarta e intreaga.
cat > "$D/.distributie-portabila" <<MARCAJ
Aceasta copie e o DISTRIBUȚIE, nu depozitul de dezvoltare.

Nu conține: marketing/ (sursele materialelor comerciale), .git, data/, logs/, cheile.
Porțile din suită care compară materialele publicate cu sursele lor se sar aici — nu
au ce compara — și o spun explicit la rulare. Restul suitei rulează integral.
MARCAJ

# 2) Versiunea: data + commitul. `package.json` are 1.0.0 de la inceput, deci nu
#    spune nimic despre ce ai in mana.
COMMIT=$(git -C "$RADACINA" rev-parse --short HEAD 2>/dev/null || echo 'necunoscut')
DATA=$(date +%Y-%m-%d)
VERSIUNE="$DATA ($COMMIT)"
NODE_MIN=$(node -p "require('$RADACINA/package.json').engines.node" 2>/dev/null || echo '>=22.13')

cat > "$D/CITESTE-MA.txt" <<TXT
Contabo — pachet portabil
Versiune: $VERSIUNE
Node necesar: $NODE_MIN (nu e inclus în arhivă)

PORNIRE
  1. Dezarhivează:            tar -xzf Contabo-portabil.tar.gz
  2. Intră în director:       cd Contabo
  3. Pregătește configurarea: cp .env.example .env   apoi completează cheile
     Minimul obligatoriu, altfel serverul REFUZĂ să pornească:
       CONTAB_AUTH_SECRET   (minim 32 de caractere)
       CONTAB_SECRETS_KEY   (exact 64 de caractere hexazecimale)
     Le poți genera cu:
       node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  4. Pornește:                npm start
  5. Deschide:                http://127.0.0.1:8080

CE E ÎNĂUNTRU
  Codul aplicației și node_modules — deci nu e nevoie de conexiune la internet
  ca să instalezi dependințe, iar versiunile sunt exact cele cu care a fost
  probată aplicația.

CE NU E ÎNĂUNTRU
  Nicio cheie, nicio bază de date, niciun document, niciun jurnal. Arhiva e
  verificată la construire: dacă ar conține vreuna dintre ele, nu s-ar publica.

  Baza de date se creează singură la prima pornire, în data/.
TXT

printf 'Contabo portabil\nVersiune: %s\nNode necesar: %s\n' "$VERSIUNE" "$NODE_MIN" > "$D/VERSIUNE.txt"

# 3) Arhiva
mkdir -p "$IESIRE"
NOUA="$IESIRE/Contabo-portabil.tar.gz.nou"
( cd "$LUCRU" && tar -czf "$NOUA" Contabo )

# 4) VERIFICAREA. Pe arhiva construita, nu pe intentie.
LISTA=$(tar -tzf "$NOUA")
for interzis in '^Contabo/\.env$' '^Contabo/\.env\.' '^Contabo/data/' '^Contabo/logs/' '^Contabo/\.git/' '^Contabo/marketing/'; do
  # `.env.example` e permis explicit — e singurul din familie fara valori.
  GASITE=$(echo "$LISTA" | grep -E "$interzis" | grep -v '^Contabo/\.env\.example$' || true)
  if [ -n "$GASITE" ]; then
    echo "EROARE: pachetul contine ceva ce nu are voie:" >&2
    echo "$GASITE" | head -5 | sed 's/^/  /' >&2
    rm -f "$NOUA"; exit 1
  fi
done

# Marcajul de distributie trebuie sa FIE acolo: fara el, `npm start` pica la client pe poarta
# de marketing. E o verificare pozitiva — absenta lui e o eroare, nu o scapare cosmetica.
echo "$LISTA" | grep -q '^Contabo/\.distributie-portabila$' \
  || { echo "EROARE: lipseste marcajul .distributie-portabila — suita ar pica la client." >&2; rm -f "$NOUA"; exit 1; }

# Secretele VII, cautate dupa VALOARE. Nu se cauta tot `.env`: `APP_URL` apare
# legitim in cod, in docs si in README, iar o verificare care pica din motivul
# gresit se dezactiveaza dupa a doua oara. Cautarea trece prin FLUX, ca sa nu
# desfacem ~250 MB pe un /tmp care e tmpfs.
if [ -f "$RADACINA/.env" ]; then
  GASIT=0
  for cheie in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET ANTHROPIC_API_KEY OPENAI_API_KEY \
               RESEND_API_KEY CONTAB_AUTH_SECRET CONTAB_SECRETS_KEY CONTAB_SECRETS_KEY_OLD \
               CONTAB_BACKUP_KEY CONTAB_OFFSITE_SECRET CONTAB_OFFSITE_KEY CONTAB_PG_URL; do
    val=$(grep -E "^$cheie=" "$RADACINA/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'')
    [ -z "$val" ] && continue
    [ ${#val} -lt 12 ] && continue
    if tar -xzOf "$NOUA" 2>/dev/null | grep -qF "$val"; then
      echo "EROARE: valoarea lui $cheie a ajuns in pachet." >&2; GASIT=1
    fi
  done
  [ "$GASIT" = 1 ] && { rm -f "$NOUA"; exit 1; }
fi

# 5) PROBA POZITIVA: se dezarhiveaza ce s-a construit si se RULEAZA din el.
#
# Pasul 4 raspunde doar la „ce nu are voie sa fie acolo". Intrebarea cealalta — „e acolo tot ce
# trebuie?" — nu se poate pune ca lista de excluderi, fiindca un fisier lipsa nu lasa nicio urma.
# S-a intamplat: fonturile `.afm` ale lui pdfkit au disparut printr-o excludere neancorata, arhiva
# a trecut toate verificarile de mai sus, si toate rutele PDF dadeau 500 la client. Singurul lucru
# care prinde asta e sa rulezi ce ai impachetat.
VERIF="$LUCRU/verificare"
mkdir -p "$VERIF"
tar -xzf "$NOUA" -C "$VERIF"
V="$VERIF/Contabo"

for f in server.js package.json .env.example .distributie-portabila \
         node_modules/pdfkit/js/data/Helvetica.afm .github/workflows/ci.yml; do
  [ -e "$V/$f" ] || { echo "EROARE: lipseste din pachet: $f" >&2; rm -f "$NOUA"; exit 1; }
done

# Un PDF adevarat, generat din pachet, verificat pe semnatura de fisier.
node -e '
const P = require(process.argv[1] + "/node_modules/pdfkit");
const fs = require("fs");
const d = new P(); const buc = [];
d.on("data", (c) => buc.push(c));
d.on("end", () => {
  const b = Buffer.concat(buc);
  if (b.subarray(0, 4).toString() !== "%PDF" || b.length < 500) { console.error("PDF invalid"); process.exit(1); }
  process.exit(0);
});
d.fontSize(12).text("proba de impachetare"); d.end();
' "$V" || { echo "EROARE: pachetul nu poate genera PDF-uri (fonturi lipsa?)." >&2; rm -f "$NOUA"; exit 1; }

# Codul se incarca: `require` pe modulele de domeniu, din pachet, nu din depozit.
node -e '
const p = process.argv[1];
for (const m of ["src/db", "src/accounting", "src/reporting", "src/xml", "src/saft", "src/payroll", "src/fiscalConfig"])
  require(p + "/" + m);
' "$V" || { echo "EROARE: modulele din pachet nu se incarca." >&2; rm -f "$NOUA"; exit 1; }

mv "$NOUA" "$IESIRE/Contabo-portabil.tar.gz"
chmod 644 "$IESIRE/Contabo-portabil.tar.gz"

# 6) Manifestul: amprenta se publica, ca sa poata fi verificata descarcarea.
OCTETI=$(stat -c%s "$IESIRE/Contabo-portabil.tar.gz")
AMPRENTA=$(sha256sum "$IESIRE/Contabo-portabil.tar.gz" | cut -d' ' -f1)
cat > "$IESIRE/portabil.json" <<JSON
{
  "versiune": "$VERSIUNE",
  "data": "$DATA",
  "node": "necesita Node $NODE_MIN instalat",
  "octeti": $OCTETI,
  "sha256": "$AMPRENTA",
  "fisier": "/descarcari/Contabo-portabil.tar.gz"
}
JSON
chmod 644 "$IESIRE/portabil.json"

echo "   $(du -h "$IESIRE/Contabo-portabil.tar.gz" | cut -f1)  versiunea $VERSIUNE"
echo "   fisiere in arhiva: $(echo "$LISTA" | wc -l)"
echo "   sha256: $AMPRENTA"
echo "   https://contabo.space/descarcari/Contabo-portabil.tar.gz"
