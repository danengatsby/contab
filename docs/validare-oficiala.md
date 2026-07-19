# Dovada validării oficiale ANAF (declarații + SAF-T)

Toate ieșirile fiscale generate de aplicație sunt validate cu **validatorul oficial ANAF**
(DUKIntegrator, prin `scripts/valideaza-duk.sh`) — nu doar cu pre-validarea internă
(`src/validate.js`, care verifică bine-formarea + câmpurile obligatorii, nu XSD-ul).

Acest document e **jurnalul de conformitate**: ce versiune de schemă/validator, la ce dată,
cu ce rezultat. Se actualizează la fiecare schimbare de schemă ANAF (vezi
`docs/guvernanta-fiscala.md` pentru flux).

## Ultima verificare: 2026-07-19

Rulată pe datele exemplului integrat (`npm run seed` — S.C. EXEMPLU PROD S.R.L.), cu
validatoarele curente din manifestul oficial ANAF (`versiuni.xml`).

| Declarație | Schemă (namespace)                          | Validator ANAF | Rezultat |
|-----------|----------------------------------------------|----------------|----------|
| D300      | `d300:declaratie:v12`                       | J12.0.1        | ✅ Validare fără erori |
| D394      | `d394:declaratie:v5`                        | J8.0.2         | ✅ Validare fără erori |
| D112      | `declaratie_unica:declaratie:v7`            | J26.0.3        | ✅ Validare fără erori |
| D390      | `d390:declaratie:v3`                        | J4.1.2         | ✅ Validare fără erori |
| D100      | `d100:declaratie:v2`                        | J21.0.6        | ✅ Validare fără erori |
| D205      | `d205:declaratie:v3`                        | J9.0.5         | ✅ Validare fără erori |
| D406 (SAF-T) | `Ro_SAFT_Schema` v2.4.9 (`AuditFileVersion` 2.4.9) | J2.2.18 (16-Feb-2026) | ✅ Validare fără erori — variantele **L** (lunară), **T** (trimestrială), **A** (active), **C** (stocuri) |

## Reproducere

```bash
# generează o ieșire din exemplul de seed și o validează oficial (validatorul se
# descarcă/reîmprospătează automat din manifestul ANAF, rulează prin Docker):
scripts/valideaza-duk.sh D300 fișier.xml     # 0 = valid, 1 = erori (afișate), 2 = tip greșit
```

## Automatizare (CI)

Validarea oficială rulează și în **CI** (`.github/workflows/ci.yml`, jobul `validare-anaf`):
generează toate ieșirile din seed (`scripts/genereaza-referinte.js`) și le trece prin
DUKIntegrator (`scripts/valideaza-referinte.sh`) — **săptămânal** (prinde driftul de schemă
când ANAF actualizează validatoarele), **manual** (`workflow_dispatch`) și **post-merge pe
main**. Nu rulează pe fiecare PR: o cădere temporară a `static.anaf.ro` nu trebuie să
blocheze PR-urile, iar regresiile de generator le prinde oricum suita de teste.

Local: `sh scripts/valideaza-referinte.sh` (generează + validează toate; 0 = toate valide).

Validarea oficială se repetă **obligatoriu** la depunerea în SPV — acest jurnal atestă că
fișierele generate trec validatorul, nu înlocuiește depunerea.
