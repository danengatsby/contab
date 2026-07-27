#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
#  HOOK `pre-push`: leaga poarta fiscala de calea PROPRIE de livrare
#
#  De ce e nevoie si de asta, pe langa protectia ramurii: checkurile obligatorii de pe
#  GitHub se evalueaza la merge-ul unui PULL REQUEST. Fluxul de aici e merge local
#  `--no-ff` + push direct in `main` — nu trece prin PR, deci protectia de repo nu-l
#  atinge (iar `enforce_admins=true` n-ar proteja, ci ar respinge push-ul: checkurile
#  ruleaza DUPA push). Singurul loc unde calea proprie poate fi legata e local.
#
#    sh scripts/hook-fiscal.sh                 instaleaza hook-ul
#    sh scripts/hook-fiscal.sh --dezinstaleaza sterge-l
#    sh scripts/hook-fiscal.sh --arata         ce e instalat acum
#
#  Hook-ul ruleaza poarta DOAR daca commit-urile impinse ating module fiscale (perimetrul
#  din scripts/poarta-fiscala.sh) — un push de CSS nu asteapta un container Java.
#
#  Iesire de urgenta, documentata: `git push --no-verify`. Exista deliberat — un hook fara
#  portita se ocoleste oricum, dar dezordonat (dezinstalat si uitat asa). Cand il folosesti,
#  poarta ramane obligatorie in CI pe push, deci ocolirea se vede.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

RADACINA=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "Nu esti intr-un depozit git." >&2; exit 2; }
HOOK="$(git rev-parse --git-path hooks)/pre-push"
MARCA='# contab:poarta-fiscala'

case "${1:-}" in
  --arata)
    if [ -f "$HOOK" ] && grep -q "$MARCA" "$HOOK" 2>/dev/null; then
      echo "Instalat: $HOOK"
      echo "Ocolire: git push --no-verify"
    elif [ -f "$HOOK" ]; then
      echo "Exista un pre-push, dar NU e al nostru: $HOOK"; exit 1
    else
      echo "Neinstalat."; exit 1
    fi
    exit 0 ;;
  --dezinstaleaza)
    if [ -f "$HOOK" ] && grep -q "$MARCA" "$HOOK" 2>/dev/null; then
      rm -f "$HOOK"; echo "Sters: $HOOK"
    else
      echo "Nimic de sters (nu e hook-ul nostru)."; fi
    exit 0 ;;
esac

# Nu suprascriem un hook strain fara sa spunem.
if [ -f "$HOOK" ] && ! grep -q "$MARCA" "$HOOK" 2>/dev/null; then
  echo "Exista deja un pre-push care nu e al nostru: $HOOK" >&2
  echo "Muta-l sau imbina-l manual; nu-l suprascriu." >&2
  exit 2
fi

mkdir -p "$(dirname "$HOOK")"
cat > "$HOOK" <<'HOOKEOF'
#!/bin/sh
# contab:poarta-fiscala — generat de scripts/hook-fiscal.sh (nu edita direct)
# Ruleaza validatoarele OFICIALE ANAF inainte de push, daca se ating module fiscale.
# Ocolire: git push --no-verify
set -eu
RADACINA=$(git rev-parse --show-toplevel)
ZERO=$(git hash-object --stdin </dev/null | tr '0-9a-f' '0')

cod=0
while read -r _local_ref local_sha _remote_ref remote_sha; do
  [ "$local_sha" = "$ZERO" ] && continue            # stergere de ramura: nimic de validat
  if [ "$remote_sha" = "$ZERO" ]; then
    # ramura noua pe remote: comparam cu main, altfel n-avem baza
    baza=$(git merge-base "$local_sha" main 2>/dev/null || echo "$local_sha")
  else
    baza=$remote_sha
  fi
  # poarta decide singura daca se aplica (perimetrul CAI_FISCALE) si iese 0 daca nu
  sh "$RADACINA/scripts/poarta-fiscala.sh" "$baza" || cod=$?
done

if [ "$cod" -ne 0 ]; then
  echo "" >&2
  echo "PUSH OPRIT de poarta fiscala (cod $cod)." >&2
  echo "  cod 1 = o iesire fiscala e RESPINSA de validatorul oficial — repara generatorul." >&2
  echo "  cod 2 = validarea n-a putut rula (ANAF picat, Docker/xmllint lipsa, schema absenta)." >&2
  echo "Ocolire constienta: git push --no-verify" >&2
fi
exit "$cod"
HOOKEOF
chmod +x "$HOOK"

echo "✓ Instalat: $HOOK"
echo "  Ruleaza poarta la push, doar cand se ating module fiscale."
echo "  Ocolire: git push --no-verify   |   Stergere: sh scripts/hook-fiscal.sh --dezinstaleaza"
