#!/bin/sh
# Genereaza toate iesirile fiscale din exemplul de seed si le valideaza cu validatorul OFICIAL
# ANAF (DUKIntegrator). Folosit manual si in CI (job separat) ca sa prinda:
#   - regresii in generatoare (src/xml.js, src/saft.js),
#   - drift de schema ANAF (validatoarele se reimprospateaza din manifestul oficial).
# Iese cu 0 daca TOATE trec „Validare fara erori", altfel 1 (cu lista celor picate).
set -eu

DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
node "$(dirname "$0")/genereaza-referinte.js" "$DIR" >/dev/null

esuate=""
for f in "$DIR"/*.xml; do
  nume=$(basename "$f" .xml)
  tip=$(echo "$nume" | cut -d- -f1)   # D406-T/A/C -> validatorul D406
  printf '%-10s ' "$nume"
  if sh "$(dirname "$0")/valideaza-duk.sh" "$tip" "$f" >/dev/null 2>&1; then
    echo "✓ valid"
  else
    echo "✗ INVALID"
    esuate="$esuate $nume"
  fi
done

if [ -n "$esuate" ]; then
  echo "" >&2
  echo "ESUATE:$esuate" >&2
  exit 1
fi
echo ""
echo "Toate referintele trec validatorul oficial ANAF."
