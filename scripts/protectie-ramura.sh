#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
#  PROTECTIA RAMURII `main` — face `poarta-fiscala` un check OBLIGATORIU
#
#  Setarea nu e un fisier din repo, ci o configuratie de pe GitHub: trebuie un token
#  cu drepturi de admin. Push-ul merge pe cheie SSH, care autentifica `git`, NU API-ul
#  REST — de aceea nu se poate aplica din fluxul obisnuit. Scriptul cere `gh auth login`
#  o singura data, apoi e idempotent (se poate rula de cate ori vrei).
#
#    sh scripts/protectie-ramura.sh              aplica protectia
#    sh scripts/protectie-ramura.sh --arata      doar citeste starea curenta
#
#  CE BLOCHEAZA SI CE NU (important, altfel te astepti la altceva):
#  - checkurile obligatorii se evalueaza la MERGE-ul unui pull request. Cele 8 PR-uri
#    dependabot sunt exact cazul: 6 din 8 au CI rosu azi si s-ar putea imbina fara asta.
#  - fluxul propriu (merge local `--no-ff` + push direct in main) NU trece prin PR, deci
#    protectia nu-l atinge cat timp `enforce_admins=false`. Daca l-ai pune pe `true`,
#    push-ul direct ar fi RESPINS: checkurile ruleaza DUPA push, deci un commit nou n-are
#    cum sa aiba deja statusuri verzi — te-ai bloca singur. De aia ramane `false`, explicit.
#    Ca sa fie legata si calea proprie, foloseste un hook `pre-push` local, nu aceasta setare.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

REPO=${CONTAB_REPO:-danengatsby/contab}
RAMURA=${CONTAB_BRANCH:-main}
# Checkurile care trebuie sa treaca. `poarta-fiscala` e cel care blocheaza declaratiile
# invalide; celelalte sunt suita si paritatea cu productia (pg).
CHECKS='poarta-fiscala
test (22)
test (24)
test-postgres
audit'

command -v gh >/dev/null 2>&1 || { echo "gh nu e instalat." >&2; exit 2; }
if ! gh auth status >/dev/null 2>&1; then
  cat >&2 <<MSG
gh nu e autentificat — protectia ramurii cere un token cu drepturi de ADMIN pe repo.
(Cheia SSH cu care se face push autentifica git, nu API-ul REST.)

  gh auth login            # o singura data, apoi reia comanda asta

MSG
  exit 2
fi

if [ "${1:-}" = "--arata" ]; then
  echo "Protectia curenta a lui $REPO@$RAMURA:"
  gh api "repos/$REPO/branches/$RAMURA/protection" 2>/dev/null \
    || echo "  (niciuna — ramura nu e protejata)"
  exit 0
fi

# Construim payload-ul ca JSON (nu prin -f, ca sa fie limpede ce se trimite).
contexte=$(echo "$CHECKS" | sed 's/.*/"&"/' | paste -sd, -)
payload=$(cat <<JSON
{
  "required_status_checks": { "strict": false, "contexts": [$contexte] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
)
# `strict: false` deliberat: cu `true`, fiecare PR ar trebui rebazat la fiecare commit din
# main — iar main se misca des (26 de commit-uri intr-o zi). Checkurile raman obligatorii.

echo "Aplic protectia pe $REPO@$RAMURA, cu checkurile:"
echo "$CHECKS" | sed 's/^/  - /'
echo ""
printf '%s' "$payload" | gh api -X PUT "repos/$REPO/branches/$RAMURA/protection" \
  -H "Accept: application/vnd.github+json" --input - >/dev/null

echo "✓ Aplicat. Verificare (citit inapoi de la GitHub):"
gh api "repos/$REPO/branches/$RAMURA/protection" \
  --jq '"  checkuri obligatorii: " + (.required_status_checks.contexts | join(", "))
        + "\n  strict: " + (.required_status_checks.strict | tostring)
        + "\n  enforce_admins: " + (.enforce_admins.enabled | tostring)
        + "\n  force push: " + (.allow_force_pushes.enabled | tostring)
        + "\n  stergerea ramurii: " + (.allow_deletions.enabled | tostring)'
