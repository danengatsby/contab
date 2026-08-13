#!/bin/sh
# Genereaza toate iesirile fiscale din exemplul de seed si le valideaza cu validatoarele OFICIALE:
#   - declaratiile (D300/D301/D311/D394/D112/D390/D100/D101/D205) si SAF-T (D406, toate variantele)
#     -> DUKIntegrator, prin scripts/valideaza-duk.sh (validatorul se ia din manifestul ANAF);
#   - RO e-Transport -> XSD oficial, prin scripts/valideaza-etransport.sh (offline, xmllint).
# Prinde: regresii in generatoare (src/xml.js, src/saft.js, src/etransport.js) si drift de schema.
#
# Folosit manual, in CI (jobul saptamanal `validare-anaf`) si de POARTA DE RELEASE
# (scripts/poarta-fiscala.sh), care ii impune semantica stricta de mai jos.
#
# TREI rezultate posibile per fisier — distinctia conteaza:
#   valid         trece validatorul oficial
#   INVALID       validatorul respinge fisierul  -> defect real in generator
#   NEVERIFICAT   validarea n-a putut rula (ANAF indisponibil, Docker/xmllint lipsa, XSD nesetat)
#                 -> NU e o dovada de conformitate; „n-am putut verifica" != „e bine"
#
# Iesire: 0 = toate valide | 1 = cel putin unul INVALID | 2 = cel putin unul NEVERIFICAT
#
#   CONTAB_ETRANSPORT_XSD   schema e-Transport (cale sau URL) — fara ea, e-Transport = NEVERIFICAT
#   scripts/valideaza-referinte.sh [dir-referinte]   (implicit: genereaza intr-un dir temporar)
set -eu

AICI=$(dirname "$0")

if [ $# -ge 1 ]; then
  DIR=$1
  [ -d "$DIR" ] || { echo "Directorul de referinte nu exista: $DIR" >&2; exit 2; }
else
  DIR=$(mktemp -d)
  trap 'rm -rf "$DIR"' EXIT
  node "$AICI/genereaza-referinte.js" "$DIR" >/dev/null
fi

invalide=""
neverificate=""

for f in "$DIR"/*.xml; do
  nume=$(basename "$f" .xml)
  printf '%-12s ' "$nume"
  case "$nume" in
    eTransport*)
      # schema XSD publicata separat de ANAF/MF — nu e in DUKIntegrator
      set +e
      iesire=$(sh "$AICI/valideaza-etransport.sh" "$f" 2>&1); cod=$?
      set -e
      motiv="XSD e-Transport"
      ;;
    *)
      tip=$(echo "$nume" | cut -d- -f1)   # D406-T/A/C -> validatorul D406
      set +e
      iesire=$(sh "$AICI/valideaza-duk.sh" "$tip" "$f" 2>&1); cod=$?
      set -e
      motiv="DUKIntegrator $tip"
      ;;
  esac
  case "$cod" in
    0) if echo "$iesire" | grep -q "atentionare regula"; then
         # Valid, dar validatorul a semnalat ceva neobisnuit. NU blocheaza (nu e eroare), insa nici
         # nu tace: o atentionare pe care n-o vede nimeni e o atentionare degeaba.
         echo "✓ valid, cu atentionari ($motiv)"
         echo "$iesire" | grep "atentionare regula" | sed 's/^/                 /'
       else
         echo "✓ valid          ($motiv)"
       fi ;;
    1) echo "✗ INVALID        ($motiv)"; invalide="$invalide $nume"
       echo "$iesire" | sed 's/^/                 /' ;;
    *) echo "⚠ NEVERIFICAT    ($motiv — validarea n-a putut rula)"; neverificate="$neverificate $nume"
       echo "$iesire" | tail -3 | sed 's/^/                 /' ;;
  esac
done

echo ""
if [ -n "$invalide" ]; then
  echo "INVALIDE:$invalide" >&2
  [ -n "$neverificate" ] && echo "NEVERIFICATE:$neverificate" >&2
  exit 1
fi
if [ -n "$neverificate" ]; then
  echo "NEVERIFICATE:$neverificate" >&2
  echo "Nicio iesire respinsa, dar validarea n-a putut rula peste tot — conformitatea NU e dovedita." >&2
  exit 2
fi
echo "Toate referintele trec validatoarele oficiale (declaratii + SAF-T + e-Transport)."
