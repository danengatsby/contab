# Dovada validării oficiale ANAF (declarații + SAF-T)

Toate ieșirile fiscale generate de aplicație sunt validate cu **validatorul oficial ANAF**
(DUKIntegrator, prin `scripts/valideaza-duk.sh`) — nu doar cu pre-validarea internă
(`src/validate.js`, care verifică bine-formarea + câmpurile obligatorii, nu XSD-ul).

Acest document e **jurnalul de conformitate**: ce versiune de schemă/validator, la ce dată,
cu ce rezultat. Se actualizează la fiecare schimbare de schemă ANAF (vezi
`docs/guvernanta-fiscala.md` pentru flux).

## Ultima verificare: 2026-07-27

Rulată pe datele exemplului integrat (`npm run seed` — S.C. EXEMPLU PROD S.R.L.), cu
validatoarele curente din manifestul oficial ANAF (`versiuni.xml`).

| Declarație | Schemă (namespace)                          | Validator ANAF | Rezultat |
|-----------|----------------------------------------------|----------------|----------|
| D300      | `d300:declaratie:v12`                       | J12.0.1        | ✅ Validare fără erori |
| D394      | `d394:declaratie:v5`                        | J8.0.2         | ✅ Validare fără erori |
| D112      | `declaratie_unica:declaratie:v7`            | J26.0.3        | ✅ Validare fără erori |
| D390      | `d390:declaratie:v3`                        | J4.1.2         | ✅ Validare fără erori |
| D100      | `d100:declaratie:v2`                        | J21.0.6        | ✅ Validare fără erori |
| D101      | `d101:declaratie:v10`                       | J11.0.3        | ✅ Validare fără erori (profit, pierdere curentă, pierdere reportată, rezultat financiar, rotunjire) |
| D205      | `d205:declaratie:v3`                        | J9.0.5         | ✅ Validare fără erori |
| D406 (SAF-T) | `Ro_SAFT_Schema` v2.4.9 (`AuditFileVersion` 2.4.9) | J2.2.18 (16-Feb-2026) | ✅ Validare fără erori — variantele **L** (lunară), **T** (trimestrială), **A** (active), **C** (stocuri) |
| S1120 (situații financiare, microentități) | `s1120:declaratie:v3` | J4.0.1 | ✅ Validare fără erori |
| S1121 (situații financiare, entități mici) | `s1121:declaratie:v3` | J4.0.4 | ✅ Validare fără erori |
| e-Transport | `mfp:anaf:dgti:eTransport:declaratie:v2`     | XSD oficial `schema_ETR_v2_20230126.xsd` (v1.02) | ✅ Valid — **după corectarea a 8 neconformități**, vezi mai jos |

> **SAF-T nu cere o integrare separată.** ANAF publică validatorul SAF-T pe pagină proprie, dar
> intrarea `<D406>` există în **același manifest** `versiuni.xml` (`J2.2.18`, `D406_35/D406Validator.jar`),
> deci `scripts/valideaza-duk.sh D406` îl rezolvă pe aceeași cale ca restul declarațiilor. Toate cele
> patru variante (L/T/A/C) trec validatorul oficial.

### Situațiile financiare anuale (adăugate 2026-07-28)

Formularele se aleg după **categoria de entitate** (OMFP 1802/2014). `F10` (bilanțul prescurtat,
51 de rânduri) e **identic** între S1120 și S1121 — diferă doar contul de profit și pierdere:

| Cod | F10 | F20 | Categorie |
|---|---|---|---|
| S1120 | prescurtat (51) | prescurtat (14) | microentități |
| S1121 | prescurtat (51) | complet (88) | entități mici |
| S1122 | complet (104) | complet (88) | mijlocii și mari — **neimplementat** |

Patru particularități pe care validatorul le impune și care nu se deduc din documentație:

| # | Regulă | Consecință în cod |
|---|---|---|
| 1 | Versiunea de namespace se alege după **anul raportat** (`v1`/`v2`/`v3`), nu e fixă | `xml.bilantNsVersion()`; același tipar ca la D101 (unde versiunea vine din anul din `Data_S`) |
| 2 | Sumele sunt în **lei întregi**; un total rotunjit separat nu mai egalează suma părților lui rotunjite | rotunjire pe rândurile **elementare**, apoi totalurile din formulele validatorului |
| 3 | `F10_043 = F20_069` — rezultatul din bilanț trebuie să fie **identic** cu cel din contul de profit | F20 e autoritatea; `f10At()` preia rezultatul, nu-l recalculează (două calcule independente divergeau cu 1 leu) |
| 4 | Un atribut **gol** nu e neutru — e respins | câmpurile opționale se omit complet |

Nomenclatoarele antetului (`tipBIL`, forme de proprietate, calități, coduri de județ) sunt extrase
din validatorul oficial, nu redactate de mână — `src/bilantNomenclator.js`. `tipBIL` are o singură
valoare validă per formular (`UU` la micro, `BS` la mici).

Antetul cere date pe care doar firma le știe (administrator, întocmitor, formă de proprietate).
Când lipsesc, generarea e **refuzată cu lista exactă** a câmpurilor — un antet plauzibil dar
inventat trece validatorul și ajunge la ANAF ca declarație greșită.

### e-Transport: ce a găsit prima rulare a porții cu schema oficială

Până la 2026-07-27, e-Transport fusese validat doar față de o schemă reconstruită local — XML-ul
era bine-format și trecea toate aserțiunile de conținut, dar **ANAF l-ar fi respins**. Prima rulare
față de XSD-ul oficial a găsit opt neconformități, toate reparate în `src/etransport.js`:

| # | Neconformitate | Regula din schemă |
|---|---|---|
| 1 | element `<transport>` | schema are `<notificare>` (choice cu `stergere`/`confirmare`/`modifVehicul`) |
| 2 | `bunuriTransportate/@nrCrt` | atribut inexistent — acum e doar model intern, nu se serializează |
| 3 | adresa pusă direct pe `locStart/FinalTraseuRutier` | adresa stă în copilul `<locatie>`; pe element rămân doar `codPtf`/`codBirouVamal` |
| 4 | `greutateNeta="0.00"` când lipsea | `PosDec_12_2_Type` are `minExclusive=0` → atribut opțional, se omite |
| 5 | `numarDocument=""`, `observatii=""`, `cod=""` | tipurile `Str*`/`Cod*` au `minLength=1` → gol ≠ neutru, invalidează |
| 6 | cod tarifar de 5 sau 7 cifre doar avertizat | pattern `[0-9]{4}\|[0-9]{6}\|[0-9]{8}` → e eroare, nu avertisment |
| 7 | `codPtf="NADLAC2"` (etichetă text) | `CodPtfType` e `xs:int`, enumerare 1..38 |
| 8 | trunchieri la 500 de caractere | `Str200`/`Str100`/`Str50`/`Str30`/`Str20` |

În plus, nomenclatoarele: lipseau tipurile 12/14/22/24 (lohn, call-off stock), lipseau scopurile
1101 și 9901, iar 801/802/901/1001 aveau denumirile altor scopuri. `<locatie>` cere **și strada**
(`denumireStrada use="required"`), nu doar județ + localitate — validarea internă o cere acum.

Fiecare punct are test în `test/run.js` (secțiunea RO e-Transport) și în `test/http.js`.

### Unde stă schema e-Transport

**Versionată în repo:** `schemas/eTransport/schema_ETR_v2_20230126.xsd` (versiune `1.02`,
39.496 octeți). Poarta merge în orice clonă, fără nicio variabilă de mediu — verificat pe un
export curat al repo-ului, cu depozitul de pe server mascat.

Ordinea de căutare (`scripts/valideaza-etransport.sh`):

1. `CONTAB_ETRANSPORT_XSD` — cale locală **sau URL** (`.xsd`/`.zip`, dezarhivat automat), pentru probe;
2. `schemas/eTransport/*.xsd` — **locul normal**;
3. `CONTAB_ETRANSPORT_SCHEMA_DIR` (implicit `/var/lib/contab/schemas`) — depozitul de pe server;
4. altfel `NEVERIFICAT` → poarta **blochează**. Fără schemă nu există dovadă.

> **Revenire pe o decizie anterioară.** Politica era „schema NU se ține în repo, s-ar învechi".
> Valabilă pentru o schemă neversionată — dar runnerul de CI e o mașină efemeră, deci o variabilă
> de repo care conține o *cale* (`/var/lib/contab/schemas/…`) nu indică nimic acolo, iar poarta ar
> bloca fiecare PR fiscal pe `NEVERIFICAT`. Cu data în numele fișierului, jobul săptămânal
> `validare-anaf` și jurnalul de aici, învechirea nu mai e tăcută. Motivarea completă și procedura
> de înlocuire: `schemas/eTransport/README.md`.
>
> `/var/tmp` **nu** e depozit: `systemd-tmpfiles` îl curăță la 30 de zile
> (`q /var/tmp 1777 root root 30d`) — o schemă acolo dispare fără urmă.

> **D101 (adăugat 2026-07-21):** validatorul alege singur versiunea de schemă după **anul din `Data_S`**
> (tabelul intern `_dateVersionTable` din `D101Validator`), nu după un atribut liber — un exercițiu
> încheiat în 2024/2025/2026 → schema **v10** (`declaratie101`, indicatorii P1..P53 ca atribute pe
> rădăcină). Generatorul modelează cazul uzual: PJ română plătitoare de impozit pe profit
> (`cod_obligatie=103`), exercițiu = an calendaristic. `scadenta`/`nr_evid` sunt calculate exact după
> regulile validatorului (termen extins +6 luni pentru exercițiile 2021-12…2025).

## Reproducere

```bash
# generează o ieșire din exemplul de seed și o validează oficial (validatorul se
# descarcă/reîmprospătează automat din manifestul ANAF, rulează prin Docker):
scripts/valideaza-duk.sh D300 fișier.xml     # 0 = valid, 1 = erori (afișate), 2 = tip greșit
```

## Poarta fiscală — validarea oficială ca **condiție de release**

Validarea oficială **blochează** orice schimbare care atinge un modul fiscal. Nu mai e o
verificare periodică pe lângă flux, ci o precondiție de merge.

```bash
sh scripts/poarta-fiscala.sh                 # față de origin/main (implicit)
sh scripts/poarta-fiscala.sh HEAD~1          # față de altă bază
sh scripts/poarta-fiscala.sh --intotdeauna   # indiferent ce s-a schimbat
```

Poarta se aplică **doar când s-a atins ceva fiscal** — o schimbare de CSS nu așteaptă un
container Java. Perimetrul e sursă unică, în `CAI_FISCALE` din `scripts/poarta-fiscala.sh`:
generatoarele (`xml.js`, `saft.js`, `etransport.js`), regulile și cotele (`fiscal*.js`,
`payroll.js`, `reporting.js`, `accounting.js`, `validate.js`), monografiile
(`src/documentTypes/` — schimbă articolele contabile, deci și declarațiile), seed-ul
(= datele de referință) și scripturile de generare/validare însele.

**Trei rezultate, nu două** — distincția e miezul porții:

| Rezultat | Ce înseamnă | Cod |
|---|---|---|
| `valid` | trece validatorul oficial | 0 — release permis |
| `INVALID` | validatorul respinge fișierul → defect real în generator | 1 — **blocat** |
| `NEVERIFICAT` | validarea n-a putut rula (ANAF picat, Docker/xmllint lipsă, XSD nesetat) | 2 — **blocat** |

Poarta blochează și pe `NEVERIFICAT`, deliberat: „n-am putut verifica" nu e același lucru cu
„e bine", iar un gate care trece când n-a verificat nimic e mai rău decât lipsa lui (dă
încredere falsă exact acolo unde voiai o dovadă). Remediul e re-rularea, nu o portiță.

### În CI

Două joburi, cu roluri distincte (`.github/workflows/ci.yml`):

| Job | Când | Ce prinde |
|---|---|---|
| `poarta-fiscala` | **fiecare push/PR** care atinge module fiscale | regresia proprie, **înainte** de merge |
| `validare-anaf` | săptămânal, manual, post-merge pe main | driftul de schemă ANAF — cazul în care codul nostru *nu* s-a schimbat, dar validatorul da |

Ca poarta să blocheze efectiv merge-ul pe GitHub, rulează **`sh scripts/protectie-ramura.sh`**
(cere `gh auth login` o dată — cheia SSH autentifică `git`, nu API-ul REST). Fișierul de workflow
rulează poarta; obligativitatea e o setare de repo.

**Ce blochează și ce nu.** Checkurile obligatorii se evaluează la merge-ul unui *pull request* —
adică exact pentru PR-urile dependabot. Fluxul propriu (merge local `--no-ff` + push direct în
`main`) nu trece prin PR, deci protecția nu-l atinge cât timp `enforce_admins=false`. Pe `true`,
push-ul direct ar fi **respins**: checkurile rulează *după* push, deci un commit nou n-are cum să
aibă deja statusuri verzi — ar fi o blocare a propriei căi, nu o protecție.

### Calea proprie: hook `pre-push`

Pentru merge local + push direct, singurul loc unde poarta poate fi legată e local:

```bash
sh scripts/hook-fiscal.sh                 # instalează
sh scripts/hook-fiscal.sh --arata         # ce e instalat
sh scripts/hook-fiscal.sh --dezinstaleaza # scoate-l
```

Hook-ul rulează poarta **doar dacă** commit-urile împinse ating module fiscale — un push de CSS nu
așteaptă un container Java. Refuză push-ul atât la `INVALID` (cod 1), cât și la `NEVERIFICAT`
(cod 2). Ieșire de urgență, deliberată și documentată: `git push --no-verify`; poarta rămâne
obligatorie în CI pe push, deci ocolirea se vede.

Cele două mecanisme sunt complementare: protecția de repo acoperă PR-urile (dependabot), hook-ul
acoperă calea proprie.

Schema e-Transport nu se ține în repo (ANAF o actualizează; s-ar învechi) — CI o ia din
variabila de repo `CONTAB_ETRANSPORT_XSD` (*Settings → Secrets and variables → Actions →
Variables*). **Nesetată, poarta blochează** orice schimbare fiscală: e-Transport iese
`NEVERIFICAT`.

Local, fără detecția de cale: `sh scripts/valideaza-referinte.sh` (generează + validează tot).

Validarea oficială se repetă **obligatoriu** la depunerea în SPV — acest jurnal atestă că
fișierele generate trec validatorul, nu înlocuiește depunerea.

## RO e-Transport (cod UIT) — validare XSD

e-Transport **nu** trece prin DUKIntegrator (acela e pentru declarații D300/D394/…): schema lui
e un XSD publicat separat, deci validarea e directă, cu `xmllint` (validarea XSD e o operație
**locală, offline** — nu cere apeluri live la ANAF):

```bash
# schema oficială (versionată) se descarcă din pagina tehnică și se indică o singură dată:
#   https://etransport.mfinante.gov.ro/informatii-tehnice  →  „Schema XSD"
CONTAB_ETRANSPORT_XSD=/cale/eTransport.xsd \
  scripts/valideaza-etransport.sh fișier.xml     # 0 = valid, 1 = erori (afișate), 2 = folosire/schemă lipsă
```

Schema **nu** e livrată în repo (ANAF o actualizează periodic; s-ar învechi) — de aceea se indică
prin `CONTAB_ETRANSPORT_XSD` (cale locală sau URL, cu `.zip` dezarhivat automat). Pre-validarea
rapidă din generarea aplicației rămâne `src/etransport.js` (`validate`): prinde câmpurile
obligatorii, enum-urile, formatele și coerența traseu↔tip de operațiune înainte de trimitere.
