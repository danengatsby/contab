#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
#  POARTA FISCALA — conditie de RELEASE pentru modulele fiscale
#
#  Regula: nicio schimbare care atinge un generator fiscal nu ajunge in `main`
#  (si de acolo in productie) fara sa fi trecut VALIDATOARELE OFICIALE:
#    - DUKIntegrator (ANAF) pentru declaratii + SAF-T (D406, toate variantele);
#    - XSD-ul oficial ANAF/MF pentru RO e-Transport.
#
#  De ce e nevoie de ea: suita de teste dovedeste ca generatoarele produc ce
#  produceau ieri (aserttii pe continut + `wellFormed`), iar `wellFormed` verifica
#  DOAR echilibrul etichetelor. Nimic din suita nu dovedeste ca ANAF accepta
#  fisierul. Validarea saptamanala prinde driftul de schema, dar prinde regresia
#  proprie abia dupa merge — adica prea tarziu.
#
#  Poarta se aplica DOAR cand s-a atins ceva fiscal (lista CAI_FISCALE de mai jos):
#  o schimbare de CSS nu asteapta un container Java.
#
#  Folosire:
#    scripts/poarta-fiscala.sh                 fata de origin/main (implicit)
#    scripts/poarta-fiscala.sh <ref>           fata de alta baza (ex. HEAD~1)
#    scripts/poarta-fiscala.sh --intotdeauna   ruleaza indiferent ce s-a schimbat
#
#  Iesire: 0 = release permis | 1 = BLOCAT (fisier respins) | 2 = BLOCAT (nu s-a putut verifica)
#
#  Cerinte: docker (DUKIntegrator ruleaza intr-un container efemer), xmllint si schema
#  e-Transport. Schema se ia implicit din depozitul stabil /var/lib/contab/schemas (cel mai
#  recent *.xsd) sau din CONTAB_ETRANSPORT_XSD (cale ori URL). Lipsa ei = NEVERIFICAT = blocat.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

AICI=$(dirname "$0")

# ── SURSA UNICA a perimetrului „fiscal" (folosita si de CI, prin acest script) ──
# Orice fisier de aici schimba, direct sau indirect, continutul unei declaratii:
#   generatoarele XML; regulile si cotele; monografiile (schimba articolele contabile,
#   deci si jurnalele si declaratiile); seed-ul (= datele de referinta validate);
#   scripturile de generare/validare insele.
CAI_FISCALE='
src/xml.js
src/saft.js
src/etransport.js
src/fiscal.js
src/fiscalConfig.js
src/beneficii.js
src/fiscalProfile.js
src/fiscalControls.js
src/payroll.js
src/reporting.js
src/bilant.js
src/stocks.js
src/accounting.js
src/deductibilitate.js
src/profitTaxOptions.js
src/impozitMicro.js
src/assets.js
src/statements.js
src/chartOfAccounts.js
src/bilantNomenclator.js
src/reconcile.js
src/analytic.js
src/recurring.js
src/matching.js
src/validate.js
src/seed.js
src/fxreval.js
src/closingsService.js
src/production.js
src/stocksService.js
src/entriesService.js
src/payrollService.js
src/anafService.js
src/extractor.js
src/extractQuality.js
src/extractCheck.js
src/efacturaImport.js
src/einvoiceReconcile.js
src/bnr.js
src/documentTypes/
scripts/genereaza-referinte.js
scripts/valideaza-duk.sh
scripts/valideaza-etransport.sh
scripts/valideaza-referinte.sh
schemas/
'

BAZA=${1:-}
if [ "$BAZA" = "--intotdeauna" ]; then
  MOTIV="rulare fortata (--intotdeauna)"
  ATINSE="(neverificat — rulare fortata)"
else
  if [ -z "$BAZA" ]; then
    # implicit: origin/main daca exista, altfel main
    if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then BAZA=origin/main; else BAZA=main; fi
  fi
  git rev-parse --verify --quiet "$BAZA" >/dev/null 2>&1 || { echo "Referinta de baza inexistenta: $BAZA" >&2; exit 2; }
  # fata de punctul comun, nu fata de varful bazei (altfel apar si schimbarile din main)
  PUNCT=$(git merge-base "$BAZA" HEAD 2>/dev/null || echo "$BAZA")
  SCHIMBATE=$(git diff --name-only "$PUNCT" HEAD; git diff --name-only; git ls-files --others --exclude-standard)

  ATINSE=""
  for cale in $CAI_FISCALE; do
    for f in $SCHIMBATE; do
      case "$f" in
        "$cale"|"$cale"*) ATINSE="$ATINSE $f" ;;
      esac
    done
  done
  ATINSE=$(echo "$ATINSE" | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ')

  if [ -z "$ATINSE" ]; then
    echo "Poarta fiscala: NU SE APLICA — nicio schimbare in modulele fiscale (fata de $BAZA)."
    exit 0
  fi
  MOTIV="s-au atins module fiscale fata de $BAZA"
fi

echo "─────────────────────────────────────────────────────────────────────"
echo " POARTA FISCALA — validare oficiala ANAF ca preconditie de release"
echo " Motiv: $MOTIV"
echo " Atinse:$ATINSE"
echo "─────────────────────────────────────────────────────────────────────"
echo ""

set +e
sh "$AICI/valideaza-referinte.sh"
cod=$?
set -e

echo ""
case "$cod" in
  0)
    echo "✓ POARTA DESCHISA — toate iesirile fiscale trec validatoarele oficiale."
    echo "  Consemneaza versiunile de schema/validator in docs/validare-oficiala.md."
    ;;
  1)
    echo "✗ RELEASE BLOCAT — cel putin o iesire fiscala e RESPINSA de validatorul oficial." >&2
    echo "  Repara generatorul; nu ocoli poarta." >&2
    ;;
  *)
    echo "✗ RELEASE BLOCAT — validarea n-a putut rula peste tot (vezi NEVERIFICATE mai sus)." >&2
    echo "  Cauze uzuale: static.anaf.ro indisponibil, Docker oprit, xmllint lipsa," >&2
    echo "  sau CONTAB_ETRANSPORT_XSD nesetat (schema e-Transport nu se tine in repo)." >&2
    echo "  „N-am putut verifica\" NU e acelasi lucru cu „e bine\" — reia rularea." >&2
    ;;
esac
exit $cod
