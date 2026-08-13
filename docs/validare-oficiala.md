# Dovada validării oficiale ANAF (declarații + SAF-T)

Toate ieșirile fiscale generate de aplicație sunt validate cu **validatorul oficial ANAF**
(DUKIntegrator, prin `scripts/valideaza-duk.sh`) — nu doar cu pre-validarea internă
(`src/validate.js`, care verifică bine-formarea + câmpurile obligatorii, nu XSD-ul).

Acest document e **jurnalul de conformitate**: ce versiune de schemă/validator, la ce dată,
cu ce rezultat. Se actualizează la fiecare schimbare de schemă ANAF (vezi
`docs/guvernanta-fiscala.md` pentru flux).

## Ultima verificare: 2026-08-13 — D107 și bateria completă

Poarta fiscală forțată (`scripts/poarta-fiscala.sh --intotdeauna`) a regenerat și validat
**42 din 42 de ieșiri**. Probele D107 inițială (`D107`) și rectificativă (`D107-rect`) au trecut
DUKIntegrator. Au rămas valide și cele trei probe D307: declarația inițială
(`D307`), rectificativa (`D307-rect`) și rectificativa cu un rând C agregat la zero
(`D307-zero`). Probele acoperă operațiuni A/L/C, o regularizare C negativă și păstrarea explicită
a valorii zero. Cele trei probe D301 au rămas valide: declarația inițială
(`D301`), rectificativa (`D301-rect`) și achiziția unui mijloc de transport nou
(`D301-mijloc`). Au rămas verzi și toate celelalte declarații, cele cinci variante SAF-T,
situațiile financiare și schema e-Transport.

Cele trei probe D311 sunt de asemenea valide: schema IV (`D311`), rectificativa (`D311-rect`) și
schema V după reînregistrare (`D311-reinreg`). Validatorul din manifestul oficial este
`D311Validator.jar` J2.0.0 (29.01.2021).

### Implementare D107

D107 este generată anual numai pentru plătitorii de impozit pe profit care au sponsorizări,
mecenat sau burse private în evidență. Raportul urmărește fiecare beneficiar și separă suma
acordată în anul curent (`Val1`), suma reportată din anii anteriori (`Val2`) și suma scăzută din
impozitul pe profit în anul curent (`Val3`). Alocarea scăderii se face FIFO, iar soldul detaliat
se păstrează la închiderea impozitului pe profit pentru a putea fi reportat și auditat în anul
următor.

Rădăcina XML este `<d107 xmlns="mfp:anaf:dgti:d107:declaratie:v1">`, codul obligației bugetare
acceptat de validator este `5503XXXXXX`, iar `totalPlata_A` este suma de control
`TVal1 + TVal2 + TVal3`. Pentru anul fiscal 2025 termenul electronic este 25 iunie 2026, iar
începând cu anul fiscal 2026 generatorul aplică 25 martie din anul următor, conform structurii
actuale. Declarația rectificativă este emisă cu `d_rec=1` după existența unei depuneri în registru.

Structura PDF actuală încă enumeră atributul `nr_evid`, însă validatorul D107 distribuit în
manifestul ANAF îl respinge ca atribut necunoscut. Implementarea urmează contractul verificat la
depunere: nu emite `nr_evid`. Ambele referințe trec validatorul oficial curent
(`D107Validator.jar`, J2.0.0).

Surse: [pagina electronică D107](https://static.anaf.ro/static/10/Anaf/Declaratii_R/107.html),
[structura XML actualizată la 01.07.2026](https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D107_2024_010726.pdf),
[OPANAF 355/2024](https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_355_2024.pdf).

### Implementare D307

Rădăcina este `<declaratie307 xmlns="mfp:anaf:dgti:d307:declaratie:v1">`, schema publică v1.02.
Fiecare `<operatie>` poartă tipul `A` (transfer de active), `L` (transferul proprietății după
leasing) sau `C` (ajustare/corecție/regularizare după anularea codului TVA), CUI-ul operatorului,
denumirea și TVA-ul în lei întregi. Validatorul J1.1.0 a fost publicat pentru a permite `tva <= 0`;
implementarea păstrează semnul pentru toate tipurile și nu elimină rândul agregat zero dintr-o
rectificativă.

Validatorul refuză aparițiile multiple ale aceleiași combinații tip + CUI. Raportul agregă de
aceea articolele înainte de XML, iar `tvaA`, `tvaL`, `tvaC` și `totalPlata_A` se derivă exclusiv
din rândurile emise. Monografia folosește 635=446 pentru taxa de plată și 446=635 pentru
regularizarea în favoarea firmei, fără a introduce sumele speciale în TVA curentă 4426/4427.

Formularul tipărit actualizat prin OPANAF 779/2024 include rectificarea ca urmare a notificării de
conformare. Schema electronică nu are un atribut distinct pentru acea bifă; aplicația emite
`d_rec=1`, păstrează motivul în istoricul depunerilor și nu inventează un câmp pe care validatorul
nu îl acceptă. `d_anulare` și `temei=1|2` sunt suportate separat, exact cum le cere schema.

Surse: [pagina electronică D307](https://static.anaf.ro/static/10/Anaf/Declaratii_R/307.html),
[structura XML](https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D307_2017_071117.pdf),
[schema XSD](https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/d307_20171205.xsd),
[formularul OPANAF 779/2024](https://static.anaf.ro/static/10/Anaf/formulare/307_OPANAF_779_2024.pdf).

### Implementare D311

Rădăcina este `<declaratie311 xmlns="mfp:anaf:dgti:d311:declaratie:v1">`. Schema IV emite
`Data_A`, motivul anulării și OB_11…OB_52; schema V emite exclusiv `Data_I` și OB_61/62. Cele două
se exclud reciproc, iar generatorul refuză o perioadă care le combină. `totalPlata_A` este suma de
control cerută de validator — baza plus taxa din totalurile schemei — nu numai TVA de plată.

Există o contradicție oficială: XSD-ul public `d311_20210129.xsd` marchează `Data_A`, `d_anul1` și
`d_anul2` obligatorii, dar structura oficială spune că ele lipsesc în schema V, iar DUKIntegrator
J2.0.0 acceptă exact această variantă. Generatorul urmează contractul DUK folosit efectiv la
depunere, dovedit prin `D311-reinreg`.

Formularul tipărit a primit prin OPANAF 779/2024 căsuța „rectificativă ca urmare a unei notificări
de conformare”, însă schema și validatorul electronic publicate de ANAF nu au primit un atribut
corespunzător. Aplicația nu inventează unul; emite `d_rec=1` pentru rectificativă și consemnează
motivul în istoricul intern al depunerilor.

Surse: [pagina electronică D311](https://static.anaf.ro/static/10/Anaf/Declaratii_R/311.html),
[structura XML](https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D311_2021_290121.pdf),
[schema XSD](https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/d311_20210129.xsd),
[formularul OPANAF 779/2024](https://static.anaf.ro/static/10/Anaf/formulare/311_OPANAF_779_2024.pdf).

## Verificare anterioară: 2026-08-08 — bateria completă, la push pe `main`

Nu o schimbare fiscală nouă, ci **re-dovedirea întregii baterii**: hook-ul `pre-push` a văzut că
`src/xml.js`, `src/accounting.js`, `src/declarations.js`, `src/reporting.js`, `src/fiscalProfile.js`,
`src/documentTypes/cumparari.js` și schema D301 s-au atins față de ultimul commit trimis, și a rulat
poarta înainte să lase push-ul să treacă. **24 din 24 de ieșiri: „Validare fără erori".**

| Familie | Referințe validate |
|---|---|
| D100 | `D100`, `D100-profit`, `D100-anticipat` |
| D101 | `D101`, `D101-defalcare` |
| D112 | `D112`, `D112-beneficii`, `D112-cm` |
| D177 · D205 | `D177`, `D205`, `D205-rectificativa`, `D205-retineri` |
| D300 | `D300`, `D300-report`, `D300-autofactura`, `D300-servicii`, `D300-prorata`, `D300-fara-tva` |
| D390 | `D390`, `D390-autofactura`, `D390-servicii`, `D390-triunghiular` |
| D394 | `D394` |
| SAF-T (D406) | `D406`, `D406-T`, `D406-A`, `D406-C`, `D406-storno` |
| Bilanț | `S1120`, `S1121`, `S1122` |
| e-Transport | schema XSD |

**Ce anume a validat**, ca să se poată reproduce sau contrazice mai târziu:

- **DUKIntegrator**, distribuția din cache (`CONTAB_DUK_DIR`, implicit `/var/tmp/contab-duk`):
  `dist.zip`, 36.103.651 octeți, `sha256:dddd3c7d743b4347…`, adusă de la `static.anaf.ro` pe
  2026-07-17. Validatoarele individuale din ea sunt mai noi decât distribuția — se actualizează
  separat, la cerere: `D300Validator.jar` 2026-08-03, `D406Validator.jar` 2026-08-04,
  `S1120Validator.jar` 2026-08-05.
- **e-Transport**: `schemas/eTransport/schema_ETR_v2_20230126.xsd` (versionată în repo, vezi
  `schemas/eTransport/README.md`).
- Java: `eclipse-temurin:8-jre` prin Docker — pe server nu există Java, iar jar-urile ANAF sunt pe 8.

Aceeași baterie a trecut și în CI, pe alt runner și pe o clonă curată: jobul `poarta-fiscala` din
[rularea de pe `669e868`](https://github.com/danengatsby/contab/actions/runs/31263018881), împreună
cu `validare-anaf`, `test-postgres` și restul.

## Implementare și validare 2026-08-13 — D301 (decont special de TVA)

Generatorul este legat integral la datele aplicației. Referința `D301.xml`, produsă de
`scripts/genereaza-referinte.js`, trece validatorul oficial (`D301Validator.jar`) și face parte din
poarta fiscală de release. Formularul se generează din tipul de document
`achizitie_tva_speciala_d301`; raportul și calculele comune sunt în `src/d301.js`.

**Cine îl datorează:** persoanele **neînregistrate** în scopuri de TVA conform art. 316 care fac
achiziții intracomunitare peste plafon sau primesc servicii din afara țării pentru care sunt
obligate la plata taxei. Categorie reală printre utilizatorii aplicației — o microîntreprindere
neplătitoare care cumpără reclamă sau găzduire din afară intră aici.

**Rădăcina:** `<declaratie301 xmlns="mfp:anaf:dgti:d301:declaratie:v1">`, cu secțiuni `<sectiune>`.

Atribute **obligatorii pe rădăcină** (enumerate de validator pe un document gol):

```
luna an d_rec temei mijl_trans cif denumire banca cont pers_inreg nr_evid
baza1 tva1 baza2 tva2 baza3 tva3 baza4 tva4 baza5 tva5 totalPlata_A
nume_declarant prenume_declarant functia_declarant
```

Atribute **obligatorii pe `<sectiune>`**:

```
tip_operatie nr_doc data_doc tip_valuta val_valuta curs_valutar baza tva
```

Reguli sondate, fiecare printr-o rulare (nu deduse din documentație):

| Regulă | Ce cere |
|---|---|
| R18 / R19 | `baza_i` și `tva_i` de pe rădăcină = **suma** peste secțiunile cu `tip_operatie = i`. Rădăcina e agregatul, secțiunile sunt detaliul pe document |
| R28 | `totalPlata_A` = Σ(`baza_i` + `tva_i`), i = 1..5 — deci **și bazele, nu doar taxa** |
| R16 | `nr_evid` are 23 de caractere, **același algoritm ca la D100**, cu codul `301` |
| R32 | fiecare secțiune 4.1 (`tip_operatie=5`) trebuie repetată în secțiunea-total 4; articolul contabil rămâne unic, numai XML-ul emite perechea 4 + 5 |
| — | `temei` trebuie să fie **diferit de 1** când declarația e inițială (`d_rec = 0`); valoarea 3 e respinsă, deci intervalul e {1, 2} |
| — | `pers_inreg` ∈ {1, 2}; „dacă `pers_inreg = 2` atunci trebuie să utilizați CUI" |
| — | datele în format românesc (`dd.mm.aaaa`), ca la D112 și D177 |

Cele cinci coduri sunt: (1) achiziții intracomunitare de bunuri obișnuite, (2) mijloace de transport
noi, (3) produse accizabile, (4) celelalte operațiuni de la art. 307 și (5) serviciile
intracomunitare din secțiunea 4.1. Baza se calculează conform regulii oficiale
`round(val_valuta × curs_valutar, 0)`.

**Monografia implementată:** baza este `cont cost/stoc/imobilizare = 401`; TVA-ul special,
nedeductibil, este `același cont de cost = 446`. Astfel taxa datorată bugetului intră în costul de
achiziție și nu se simulează greșit o deducere prin `4426 = 4427`. Operațiunile UE alimentează și
D390 numai când firma are bifat codul special art. 317. Formularul este refuzat pentru un plătitor
normal de TVA și pentru secțiunile 1/5 fără cod art. 317.

Surse oficiale folosite la implementare: formularul și instrucțiunile
[`301_OPANAF_779_2024.pdf`](https://static.anaf.ro/static/10/Anaf/formulare/301_OPANAF_779_2024.pdf),
[`structura_D301_2016.pdf`](https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D301_2016.pdf)
și schema [`d301_20200130.xsd`](https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/d301_20200130.xsd).
Varianta rectificativă (`d_rec="1"`, derivată automat când există deja o depunere în registru) a
fost probată separat și trece același validator oficial.

## Ultima verificare: 2026-08-09 — livrări fără TVA, triunghiular, regimul marjei

Variante noi: **`D300-fara-tva`** și **`D390-triunghiular`**, ambele ✅ validare fără erori.

**Numerotarea rândurilor din schemă NU e cea din formularul curent** — lucru aflat pe parcurs și
consemnat ca să nu se mai piardă timp: formularele publicate (OPANAF 2131/2025 și 174/2026) au
**rd. 19** ca „TOTAL TAXĂ COLECTATĂ", în timp ce schema pe care o acceptă validatorul (`v12`) are
totalul pe **R17**. Diferența vine din rândurile 17–18 (vânzări intracomunitare la distanță),
inserate în formular după versiunea schemei. **Rândurile 1–16 coincid**, deci ancorele folosite
sunt sigure:

| Rând | Ce conține | Folosit pentru |
|---|---|---|
| 1 | livrări intracomunitare de bunuri scutite (art. 294 alin. (2)) | livrare intracomunitară |
| 3 | locul livrării/prestării **în afara României** | prestări intracomunitare de servicii, livrare triunghiulară |
| 13 | livrări cu taxare inversă la beneficiar (art. 331) | art. 331 |
| 14 | scutite **cu drept de deducere**, altele decât rd. 1–3 | **export extracomunitar** |

Verificat direct în schema validatorului: `R3_1` și `R14_1` există și sunt rânduri **doar cu bază**
(nu au `_2`), ca celelalte rânduri scutite — confirmare independentă de formular.

Exportul se declară la **rd. 14**, nu la rd. 3: e o livrare cu locul **în România**, doar scutită.
Practica e împărțită, dar decontul precompletat pe care ANAF îl trimite pune exporturile vămuite
tot pe rd. 14.

**Regimul marjei (art. 312):** baza declarată e **marja fără taxă**, nu prețul de vânzare. Citită
din articol, ar da un raport de 3% (347 / 11.653) — o cotă inexistentă, iar rândul ar fi căzut tăcut
din decont. Referința verifică `R9_1 = 1653`, `R9_2 = 347` și că nicio cotă nu rămâne fără rând.

> **Rămâne nefăcut, deliberat:** e-Factura pentru vânzările în regim de marjă. Factura nu are voie
> să înscrie TVA separat (art. 312 alin. (11)), dar generatorul UBL citește sumele din articol și
> exact asta ar face. Tipul e marcat `eFactura: 'nu'`, cu motivul scris în cod. Se deblochează când
> categoria de TVA din CIUS-RO pentru regimul marjei e stabilită dintr-o sursă sigură — iar pentru
> e-Factura **nu există validator rulabil**, vezi verificarea din 2026-08-08 (3).

## Ultima verificare: 2026-08-08 (6) — concediu medical: poarta confunda „valid cu atenționări" cu „invalid"

Variantă de referință nouă: **`D112-cm`** (concediu medical, început într-o **joi**) ✅ valid, **cu
o atenționare**.

**Poarta avea un fals alarm, descoperit de această variantă.** DUKIntegrator scrie și atenționările
în același fișier ca erorile, iar la stdout nu mai apare *„Validare fără erori"* — așa că o
declarație perfect corectă era raportată `✗ INVALID … (0 erori)`. Un „0 erori" lângă „INVALID" era
chiar simptomul: nimeni nu anticipase cazul.

Cazul e legitim: la un stat cu concediu medical, **baza CAS depășește baza CASS**, fiindcă
indemnizația intră în CAS și în impozit, dar **nu** în CASS (OUG 158/2005). Regula `S26.2` semnalează
asta ca neobișnuit — pe drept, dar nu e eroare:

```
atentionare regula: S26.2: A_13 (4405) > A_11(2619) pt dat_CAS=true si dat_CASS=true
```

Poarta distinge acum cele două, **fail-closed**: se cere *atât* confirmarea din stdout
(„Atentionari la validare"), *cât și* absența oricărui bloc de eroare (`E:`/`F:`); orice altă formă
rămâne INVALID. Atenționările se afișează, nu se înghit — și în verdictul individual, și în tabelul
agregat. Verificat în ambele direcții: un XML cu eroare reală iese în continuare cu cod 1.

## Ultima verificare: 2026-08-08 (5) — rețineri la sursă: baza impozabilă și `tip_plata`

Variantă de referință nouă: **`D205-retineri`** (chirii + premii) ✅ validare fără erori. Referința
de bază conținea **doar dividende**, unde baza impozabilă *este* chiar brutul — singurul caz în care
declarația ieșea corectă din întâmplare.

**Varianta a picat la prima rulare, și pe bună dreptate:** `tip_plata="0"`, folosit pentru tot ce nu
era dividend, e respins de regula **R37** — *„tip_plata(0) nu corespunde cu tip_venit(04)"*. Sondat
pe toate valorile: **2** e singura acceptată deopotrivă pentru 08 (dividende), 11 (premii) și 04
(chirii) — ceea ce se potrivește și cu fondul, impozitul reținut fiind **final** la toate trei.

Un defect care exista de la început și pe care nici testele, nici poarta nu-l puteau vedea: nu
exista nicio declarație generată cu alt tip de venit decât dividendele. **O poartă dovedește doar
căile pe care le parcurge.**

## Verificare 2026-08-13 — D205 în calendar și rectificativă

D205 este acum urmărită în registrul anual (perioada `YYYY-12`) numai când raportul conține cel
puțin un beneficiar. Termenul este ultima zi din februarie a anului următor, mutată în prima zi
lucrătoare când aceasta cade în weekend; pentru veniturile din 2025 rezultă **2 martie 2026**.

Varianta nouă **`D205-rectificativa`**, cu `d_rec="1"`, trece DUKIntegrator fără erori. Generatorul
alege această variantă numai după ce registrul are deja o depunere; prima generare rămâne
`d_rec="0"`.

A doua eroare din aceeași rulare a fost un CNP inventat de mine: regula **R29** îi verifică cifra de
control. Ca la codurile de TVA din D390 — referințele nu pot folosi numere de fantezie.

## Ultima verificare: 2026-08-08 (4) — pro-rata în decont: R28 ≠ R27

Variantă de referință nouă: **`D300-prorata`** ✅ validare fără erori. Exercită singurul loc din
decont în care trăiește pro-rata și pe care referința de bază nu-l atingea niciodată (acolo taxa
se deduce integral).

**Întrebarea sondată**, pentru că răspunsul schimba forma decontului pentru toate firmele cu TVA
parțial deductibil: *poate „taxa dedusă" (R28) să fie mai mică decât „taxa deductibilă" (R27)?*
Sondaj: am luat referința validă, am pus `R28_2=1680` sub `R27_2=2100` și am revalidat. Verdict:
**nicio eroare de regulă** — doar suma de control, pe care n-o recalculasem. Deci R28 e exact
rândul unde se aplică limitarea.

Ce a schimbat asta: până acum, o achiziție de 1.000 lei cu deducere limitată la 80% era declarată
ca o achiziție de **800 de lei** — o bază proporțională inventată, ca să iasă raportul cerut de
regula R84. Azi decontul poartă factura așa cum a fost emisă (1.000 / 210), iar limitarea apare în
R28. R84 e satisfăcută oricum: 210/1000 = 21%.

La **taxare inversă** perechea R5/R18 rămâne pe sumele integrale — validatorul cere `R18 = R5`
(V7/V8), iar taxa colectată se datorează în întregime chiar când deducerea e limitată. Referința
verifică asta înainte de a scrie fișierul: dacă perechea nu mai e egală sau colectata nu e
integrală, generatorul aruncă.

## Ultima verificare: 2026-08-08 (3) — e-Factura B2C: fără oracol, cu două surse

**Nu există validator oficial rulabil pentru e-Factura**, spre deosebire de declarații. Verificat,
ca să nu se mai caute: manifestul DUKIntegrator (`versiuni.xml`) enumeră ~160 de formulare și
**nu are intrare pentru e-Factura**; serviciul ANAF de validare
(`api.anaf.ro/prod/FCTEL/rest/validare/FACT1`) răspunde **401 Unauthorized** fără token OAuth.

Deci regula B2C nu a putut fi sondată și a fost luată din normă, confirmată din **două surse
independente**, amândouă de acord pe ambele puncte:

| Element | Regulă | Ce făcea aplicația |
|---|---|---|
| **BT-47** — `AccountingCustomerParty/PartyLegalEntity/CompanyID` | CNP-ul dacă persoana îl dă, altfel `0000000000000` (13 zerouri) | lipsea complet la client fără cod; `RO` + CNP când exista |
| **BT-48** — `PartyTaxScheme/CompanyID` (cod TVA cumpărător) | **nu se completează** pentru persoane fizice | primea CNP-ul prefixat cu `RO` |

Poarta fiscală a rămas deschisă pe toată bateria, dar **asta nu dovedește nimic despre e-Factura** —
validatoarele acoperă declarațiile, nu UBL-ul. Dovada stă în teste, pe blocul cumpărătorului decupat
explicit din XML (prima scriere a testului citea blocul **furnizorului**, care e scris înaintea lui
și are aceleași etichete — ar fi trecut dacă aserțiunea cerea doar „nu e gol").

## Ultima verificare: 2026-08-08 (2) — serviciile intracomunitare în D390 (codurile P și S)

Variante de referință noi: **`D390-servicii`** și **`D300-servicii`**. Ambele ✅ validare fără
erori. Motivul pentru care erau necesare e același ca la `D390-autofactura`: referința de bază are
o singură livrare de **bunuri**, deci codurile de servicii n-ar fi fost exercitate niciodată la
validatorul oficial, iar în decont serviciile cad pe altă pereche de rânduri decât bunurile
(R7/R20, nu R5/R18).

**Literele codurilor au fost stabilite prin sondare, nu din memorie** — aceeași metodă ca la
rândurile D101. Trei pași, fiecare cu oracolul lui:

| Ce trebuia aflat | Oracol | Rezultat |
|---|---|---|
| Ce litere acceptă schema | XML-uri minime, câte una pe literă, la DUKIntegrator | L, T, A, P, S, R trec; `X` → „*tip: valoarea 'X' nu se află în listă*" |
| Ce câmp din rezumat ține fiecare literă | mesajele de regulă din `D390Validator.jar` | `bazaX ('@0@') = Suma(baza pt. tip = X)`, câte una pe literă |
| Ce **înseamnă** fiecare literă | instrucțiunile OPANAF (validatorul nu poartă semantica) | P = prestări servicii, S = achiziții servicii, R = regim special agricultori |

Al treilea pas a fost cel care conta: ipoteza de lucru era invers (S = prestări), iar validatorul
ar fi confirmat-o senin — o declarație cu prestările pe codul achizițiilor este perfect validă
structural și complet greșită ca fond. **Validatorul verifică forma, nu adevărul.**

Codul de TVA irlandez din referință (`IE8256796U`) trece regula R24.1, care rulează algoritmul de
checksum specific fiecărui stat membru (jar-ul înglobează bibliotecile VIES `CheckVat_*`). Deci un
cod inventat ar fi picat poarta — referințele nu pot folosi numere de fantezie.

## Ultima verificare: 2026-08-07 (2) — autofactura (art. 320)

Variante de referință noi: **`D390-autofactura`** și **`D300-autofactura`**. Ambele ✅ validare
fără erori. Exemplul integrat nu conține autofacturi, deci fără ele poarta ar fi validat în
continuare doar achiziția intracomunitară obișnuită — iar autofactura trece pe **alte căi** în
ambele generatoare (datoria stă pe 408, nu pe 401; încadrarea în decont vine de pe un marcaj de pe
articol, nu din tipul documentului).

**Poarta a BLOCAT la prima rulare, și pe bună dreptate — dar din datele de test, nu din generator:**

```
R24.1: operatorul codO = '123456789' trebuie sa respecte algoritmul specific 'DE'
```

Codul de TVA german inventat pentru referință (`DE123456789`) nu satisface cifra de control
germană. Lecția e despre *date de test*, nu despre cod: un identificator plauzibil dar invalid
trece testele proprii (nimic din suită nu verifică cifra de control a unui CUI străin) și cade abia
la validatorul oficial. Referința folosește acum `DE811907980`, cel deja prezent în `vIC`.

## Ultima verificare: 2026-08-07 — D100, sistemul anual cu plăți anticipate (art. 41)

Declanșată de atingerea lui `src/reporting.js`, `src/fiscalProfile.js`, `src/xml.js` și
`src/declarations.js` (intrat în perimetru odată cu această schimbare — vezi mai jos).

**Variantă de referință nouă: `D100-anticipat`.** Fără ea, poarta ar fi validat în continuare doar
calea trimestrială: exemplul integrat e o firmă pe micro, iar `D100-profit` exercită sistemul
implicit. Aceeași lecție ca la `D112-beneficii` — *o cale fiscală nouă fără referință proprie trece
pe lângă validatorul oficial, nu prin el*. Varianta acoperă tocmai trimestrul care nu există în
celălalt sistem (T4) și scadența lui neobișnuită.

| Declarație | Ce exercită | Rezultat |
|---|---|---|
| `D100-anticipat` | plata anticipată T4, scadență 25.12, obligație 103 | ✅ Validare fără erori |
| `D100-profit` | impozit real T1, sistem trimestrial | ✅ Validare fără erori |
| `D100` | impozit micro | ✅ Validare fără erori |

Două lucruri aflate de la validator, niciunul ghicibil:

1. **`totalPlata_A` = impozitul ÎNMULȚIT CU 2, și e corect.** Arăta ca o greșeală de copiere.
   Sondat în ambele direcții: pus pe valoarea „intuitivă" (o singură dată impozitul), fișierul e
   RESPINS cu `R11b: totalPlata_A (10450) = Suma(suma_dat + suma_ded + suma_plata + suma_rest)
   (20900)`. Declarația poartă aceeași sumă și pe `suma_dat`, și pe `suma_plata`, iar regula le
   adună pe toate patru. Consemnat în `src/xml.js`, cu îndemnul explicit de a nu-l „corecta".
2. **`nr_evid` codifică scadența** (pozițiile 12–15). Deci un termen calculat de două ori — o dată
   pentru atributul `scadenta`, o dată pentru `nr_evid` — poate produce două date diferite în
   același rând de declarație. Azi termenul are o singură sursă (`declarations.dueDate`) și e
   pasat mai departe; generatorul nu-l mai rededuce.

**`src/declarations.js` a intrat în perimetrul porții fiscale** din același motiv: `dueDate` a
devenit dependență a lui `reporting.js`, fiindcă plata anticipată a trimestrului IV are scadența
**25 decembrie** (art. 41 alin. (8)) — singurul termen din aplicație care cade în aceeași lună cu
perioada, nu în următoarea. Poarta „perimetrul e închis tranzitiv" din `test/run.js` a semnalat-o
singură, la prima rulare după modificare.

## Ultima verificare: 2026-08-06 — D177 (redirecționarea impozitului către beneficiari)

Formular **nou** în aplicație. Schema a fost ridicată din validator, nu presupusă — vezi mai jos
de ce era necesar. Reperul `D177` trece validatorul oficial (`D177_8/D177Validator.jar`).

| Declarație | Schemă (namespace) | Rezultat |
|---|---|---|
| D177 | `mfp:anaf:dgti:d177:declaratie:v1` | ✅ Validare fără erori (cu și fără bloc de reprezentant) |

Patru lucruri pe care doar validatorul le putea spune, fiecare descoperit printr-o rulare:

1. **`totalPlata_A` trebuie să fie `0`.** E o *cerere*, nu o declarație de plată. Cu suma
   redirecționată acolo: „valoarea nu se încadrează în intervalul cerut".
2. **`acord` nu e atribut al beneficiarului** în v1 (exista în versiuni anterioare) — respins ca
   „atribut necunoscut".
3. **`denR` și `cifR` merg împreună** (regula R2.1: „completat dacă și numai dacă"). Trimis doar
   numele reprezentantului, fișierul e respins — de aceea blocul se emite doar cu ambele.
4. **Datele în format românesc** (`dd.mm.aaaa`), ca la D112; ISO e respins.
5. **`tipPlatitor` are o singură valoare acceptată: `1`.** Sondate toate variantele 1–4; restul dau
   „valoarea nu se încadrează în intervalul cerut". Presupusesem o mapare „micro → 2" (care rula
   chiar pe exemplul integrat, o firmă micro) — poarta a respins-o. Același tipar ca `tipBIL="UU"`.
6. Atributele de contact se **omit** când lipsesc: un `emailC="-"` trece doar ca avertisment
   „Email invalid", deci ar fi ajuns așa la ANAF.

Reguli de conținut citite din bytecode și respectate de generator: `R2.1` (dacă `tipPlatitor=2`
atunci `tipB≠3`), `R27` (dacă `tipB<5`, `contractB` obligatoriu), `R30.1` (`ibanB` începe cu `RO`),
iar `cuiB` se verifică cu cifra de control.

Reperul exercită calea real: exemplul integrat n-are sponsorizări, deci s-a construit o variantă cu
sponsorizare de 1.500 lei și un beneficiar complet — altfel poarta ar valida un formular fără
niciun `<beneficiar>`, adică exact secțiunea obligatorie.

### D177 — corelația pe care validatorul NU o verifică (2026-08-06)

Sondat explicit: un `sumaB` de 10.000 lei pe un `sumaRest` de 3.000 trece validatorul **fără o
vorbă**. Legea o impune totuși — nu poți redirecționa mai mult decât ți-a rămas — deci o prinde
aplicația, ca la IBAN. Ruta `/xml/d177` refuză generarea, cu sumele în mesaj.

Regula generală care se repetă: validatorul verifică **forma**, nu **fondul**. Tot ce ține de fond
rămâne în sarcina aplicației, iar un „valid" de la DUK nu spune nimic despre asta.

## Sondare 2026-08-06 — F30/F40 NU fac parte din S1120/S1121/S1122

Consemnat aici fiindcă e o constatare de **schemă**, obținută de la validatorul oficial, și
pentru că infirmă o presupunere plauzibilă care ar fi stricat un depozit azi valid.

Presupunerea era că setul anual de situații financiare conține patru formulare (F10 bilanț,
F20 cont de profit și pierdere, **F30 Date informative**, **F40 Situația activelor imobilizate**),
deci că aplicația generează un bilanț incomplet. Sondat direct, cu `<F30 />` și `<F40 />` goale
adăugate la XML-ul generat:

```
eroare structura: element necunoscut ('F30') in namespace mfp:anaf:dgti:s1120:declaratie:v3
```

Același rezultat pe **toate trei**: `s1120`, `s1121`, `s1122`. Formularele F30 și F40 **nu există**
în aceste scheme — adăugarea lor face fișierul INVALID.

Ele trăiesc în **altă familie de formulare**: pe `S1002` validatorul le recunoaște („secțiunea
`F30` este greșit poziționată sau lipsesc secțiuni anterioare obligatorii" — element cunoscut,
doar prost plasat), cu namespace `mfp:anaf:dgti:s1002:declaratie:v15`.

**Concluzie:** pentru categoriile pe care le acoperă aplicația (micro / mici / mijlocii și mari,
OMFP 1802/2014), setul depus e F10 + F20, adică exact ce se genera deja. Nu era nimic de reparat.

Metoda rămâne cea din intrarea S1120: nu ghici structura, adaug-o goală și citește ce spune
validatorul. A costat trei rulări și a economisit o mapare cont→rând pe formulare care n-ar fi
fost acceptate.

## Ultima verificare: 2026-08-05 — plafonul de 33% al avantajelor (art. 76 alin. 4¹) în D112

Declanșată de atingerea lui `src/fiscal.js`, `src/fiscalConfig.js`, `src/payroll.js`, `src/xml.js`
și de modulul nou `src/beneficii.js`. Partea din avantaje care depășește plafonul de 33% (sau limita
individuală a categoriei) e venit salarial, deci intră în bazele CAS/CASS/CAM declarate în D112.
Toate cele 20 de ieșiri au trecut.

Verificat că poarta chiar **exercită** schimbarea: angajatul din exemplul integrat nu are niciun
avantaj, deci reperul `D112` ar fi validat un câmp mereu zero — exact „trecut pe lângă". S-a adăugat
o variantă de referință, `D112-beneficii` (tiparul folosit deja pentru `D390`, `D300-report` și
`D101-defalcare`), cu cazare 1.000 + pensii 800 + sport 200 peste un salariu de bază de 5.000:
plafonul e 1.650, iar cazarea are și limita ei (20% din salariul minim), deci varianta exercită
**ambele** tăieri. Confirmat prin inspecția XML-ului generat — bazele urcă de la 5.000 la 5.350
(190 lei peste limita cazării + 160 lei peste plafonul comun), iar `C4_ct` rămâne 2,25% din
`C4_baza`. Versiunile de schemă și validator sunt cele din tabelul de mai jos, nemodificate.

Reparat în aceeași trecere: `C4_baza` declara brutul simplu, deci pe orice firmă cu avantaje în
natură `C4_ct` nu mai era 2,25% din el — declarația se contrazicea singură pe două câmpuri alăturate.

## Verificare anterioară: 2026-08-03 (a doua) — diacriticele din explicațiile articolelor

Declanșată de atingerea a 21 de module fiscale (`src/documentTypes/*`, `accounting.js`,
`closingsService.js`, `payrollService.js`, `stocksService.js`…): explicațiile liniilor de articol
au primit diacritice. Ele intră în SAF-T, în `<Description>` (patru locuri în `src/saft.js`).
Toate cele 16 ieșiri au trecut.

Verificat că poarta chiar **exercită** schimbarea, nu doar că trece pe lângă ea: exemplul integrat
își construiește articolele prin `type.build()` (`src/seed.js` → `make()`), deci descrierile din
SAF-T-ul validat sunt chiar cele noi — confirmat prin inspecția XML-ului generat pe o bază
izolată (8 descrieri distincte cu diacritice, printre care „Cumpărare mărfuri (intrare în stoc)"
și „Descărcare gestiune - cost marfă vândută").

## Verificare anterioară: 2026-08-03 (prima) — diacriticele din planul de conturi

Declanșată de poartă la atingerea lui `src/chartOfAccounts.js`: denumirile conturilor au primit
diacritice, iar ele **intră în SAF-T**, în `<AccountDescription>`. Toate cele 16 ieșiri au trecut,
inclusiv D406 în cele patru variante (L/T/A/C).

Miza verificării nu era schema, ci **codarea**: un `<AccountDescription>Contribuția asiguratorie
pentru muncă (CAM)</AccountDescription>` conține octeți multi-byte pe care validatorul îi acceptă
doar dacă respectă declarația `encoding="UTF-8"` din prolog. Ipoteza dinainte de rulare era că trec,
fiindcă **același document trimitea deja diacritice** din text liber introdus de utilizator
(denumirea firmei, partenerii, denumirile de produse) — verificarea a confirmat-o, nu a presupus-o.
Versiunile de schemă și validator sunt cele din intrarea precedentă, nemodificate.

## Verificare anterioară: 2026-07-28

Rulată pe datele exemplului integrat (`npm run seed` — S.C. EXEMPLU PROD S.R.L.), cu
validatoarele curente din manifestul oficial ANAF (`versiuni.xml`).

Declanșată de hook-ul `pre-push` la publicarea unei serii de commit-uri care atingeau
`src/bilant.js`, `src/stocks.js` și `src/xml.js`. Toate cele 15 ieșiri au trecut: cele 7 declarații,
SAF-T în cele patru variante (L/T/A/C), cele 3 formulare de situații financiare și e-Transport.

Versiunile din tabel au fost **reconfirmate în aceeași zi** față de manifestul live, nu copiate din
intrarea precedentă: niciuna nu se schimbase. Jar-urile care au rulat efectiv erau descărcate în
26–28 iulie, deci în fereastra de reîmprospătare de 7 zile a validatorului — nu s-a validat cu o
copie învechită.

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
| S1122 (situații financiare, entități mijlocii și mari) | `s1122:declaratie:v3` | J4.0.4 | ✅ Validare fără erori |
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
| S1122 | complet (104) | complet (88) | mijlocii și mari |

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

> **Declarații rectificative — cele trei nu se comportă la fel (sondaj, 2026-07-28).** Presupunerea
> naturală, că fiecare declarație are un „bifați dacă e rectificativă", e **falsă**. Căutarea în
> validatoarele oficiale dă zero apariții ale noțiunii la D300 și D394; doar D112 o are:
>
> | | Steag în XML | Ce s-a dovedit |
> |---|---|---|
> | **D112** | `d_rec="1"` + `tip_rec="N"` | Regula **A3b**: când `d_rec=1`, `tip_rec` **nu poate fi 5** (probat: 1 și 3 trec, 5 respins). Când `d_rec=0`, `tip_rec` nu se completează deloc. `cnpAnt`/`numeAnt`/`prenAnt` doar la rectificative. |
> | **D300** | **niciunul** | Decontul corectat se **redepune**. Singurul câmp înrudit e `temei`, cu lista **{0, 2}** — valorile 1 și 3 sunt respinse („nu se află în listă"). `2` = depunere după anularea rezervei verificării ulterioare. |
> | **D394** | **niciunul** | Zero apariții ale noțiunii în tot validatorul. Rectificarea e o redepunere completă. `tip_D394` e tipul de **perioadă** (L/T/S/A), nu un steag de rectificare — capcană ușoară. |
>
> Consecința de proiectare: „rectificativă" e în primul rând o stare a **aplicației** (a câta
> depunere, de ce, ce s-a schimbat), nu un câmp XML. Istoricul depunerilor se ține pentru toate trei;
> XML-ul primește steag doar unde există.
>
> **Capcană de metodă, meritată o dată:** prima sondă pe D112 a „trecut" pentru că regexul insera
> atributele pe `<declaratie112`, iar rădăcina reală e `<declaratieUnica` — nu s-a inserat nimic și
> am validat fișierul original. O sondă care nu modifică fișierul raportează *valid* și pare o
> confirmare. Verifică întotdeauna că sonda chiar a schimbat ceva înainte să-i crezi rezultatul.

> **D101 — creditul de sponsorizare (adăugat 2026-07-28).** Rândul și plafonul **nu au fost ghicite**,
> ci citite din validator prin sondaj (metoda „validatorul ca oracol"). O primă încercare cu o sumă
> arbitrară a întors regula, textual:
>
> ```
> V5: round( (P41-P42)*20% ) >= P43
> ```
>
> De aici, trei lucruri care nu se deduc din formular: **P43** e rândul sumelor de sponsorizare/mecenat
> scăzute din impozit (cu subrândurile P431/P432); plafonul de 20% se aplică la **P41 − P42**, adică
> impozitul **minus creditul fiscal extern**, nu la impozitul brut (aplicația nu modelează P42, deci azi
> coincid — dar formula e cea corectă când va fi modelat); iar **P43 intră în suma de control**, în timp
> ce subrândurile nu. Ultimul punct a fost dovedit separat: validatorul a raportat diferența exactă
> dintre suma așteptată și cea trimisă, egală cu P43.
>
> Generatorul **clampează** creditul la `round(P41 × 20%)`. Nu e prisos: motorul de plafoane lucrează în
> bani (`round2`), iar D101 în lei întregi — o diferență de rotunjire ar depăși plafonul cu 1 leu și ar
> face declarația invalidă.
>
> Atenție la reluarea sondajului pe altă versiune de schemă: jar-ul de PDF conține **mai multe
> numerotări** de rânduri („rd.23+rd.33", „rd.24 la rd.34", „rd.26 la rd.36"), iar validatorul alege
> versiunea după anul din `Data_S`. Maparea de mai sus e dovedită pentru schema **v10** (exercițiile
> 2024–2026); pentru alt an se re-sondează, nu se extrapolează.

> **D100 — impozit pe profit, nu doar micro (adăugat 2026-08-04).** Generatorul avea
> `cod_oblig="620"` **fix în șablon**, iar ruta chema mereu calculul de microîntreprindere: o firmă
> pe impozit pe profit descărca o declarație de micro, cu alt cod de obligație, alt cod bugetar și
> altă sumă. Calculul trimestrial (art. 41) nu exista deloc.
>
> **Perechea (cod_oblig, cod_bugetar) a fost SONDATĂ, nu dedusă.** Mineritul de șiruri din
> `D100Validator.jar` sugera `20A010100` — singurul cod de impozit pe profit din constant pool.
> Validatorul răspunde:
>
> ```
> cod_oblig="101"  -> eroare atribut: valoarea '101' nu se afla in lista
> cod_oblig="103" cod_bugetar="20A010100"
>                  -> R14a: cod bugetar (20A010100) trebuie sa fie = 20470101 pt. acest cod_oblig
> cod_oblig="103" cod_bugetar="20470101"  -> ✓ valid
> ```
>
> Deci **103 + 20470101** (`20A010100` e „diferența de impozit pe profit redirecționată în plus" —
> exact capcana pe care sondajul o evită). Codul 103 e cel folosit deja de generatorul D101.
> `nr_evid` codifică obligația pe pozițiile 3–5 (regula R16), deci se derivă din cod, nu e fix.
> Referința **`D100-profit`** exercită calea în poartă.

> **Corecție D100 micro + D710 (2026-08-13).** Verificarea semantică a nomenclatorului curent a
> arătat că vechea pereche `620 + 20A031800`, deși era acceptată de DUK, nu reprezintă impozitul
> micro: codul 620 este impozitul pe transferul proprietăților imobiliare din patrimoniul personal.
> Creanța micro este `121 + 20470101`, iar din anul 2026 validatorul cere și `cota="1"`.
>
> D710 folosește aceeași schemă v2 și aceeași creanță/scadență ca D100, dar transmite perechile
> complete `suma_dat_I/suma_plata_I` și `suma_dat_C/suma_plata_C`; controlul este
> `2 × (suma inițială + suma corectată)`. Referințele **`D710`** și **`D710-profit`** trec
> validatorul oficial curent și acoperă separat obligațiile 121 și 103.

> **D300 — poziția reportată din decontul precedent, rândurile 35 și 38 (adăugat 2026-08-04).**
> Erau zero **prin construcție**: generatorul scria `R37 = R34` și `R40 = R33`, adică sărea peste
> ele. O firmă cu TVA de recuperat declara de plată tot TVA-ul lunii următoare, iar contul 4424
> rămânea blocat ca activ. Acum rd. 35 (TVA de plată neachitată) și rd. 38 (sumă negativă
> nerambursată) se derivă din soldurile 4423/4424 rămase **nestinse la finalul perioadei** — nu din
> soldul de deschidere: TVA-ul lunii P se plătește până pe 25 ale lunii P+1, deci un rând 35 calculat
> pe deschidere ar raporta ca neachitată exact datoria plătită la timp. Rândurile 36 și 39 (diferențe
> stabilite de inspecția fiscală) rămân zero — vin dintr-o decizie de impunere, nu din contabilitate.
>
> Formulele oficiale respectate: `R37 = R34+R35+R36`, `R40 = R33+R38+R39`, `R41/R42 = |R37−R40|`.
> Referința **`D300-report`** din `scripts/genereaza-referinte.js` există exact ca poarta să
> exercite calea: exemplul obișnuit n-are sold reportat, deci ar fi rămas verde fără s-o atingă
> vreodată (aceeași capcană ca la `D101-defalcare`).

> **D101 — defalcarea nedeductibilelor pe rândurile P23..P33 (adăugat 2026-07-29).** Până acum toate
> cheltuielile nedeductibile mergeau la **P33** „Alte cheltuieli nedeductibile", cu totalul corect în
> P34. Acum se repartizează după temeiul legal al fiecărei reguli.
>
> **Sursa mapării NU e validatorul, și asta e esențial.** Sondajul a întors doar regulile de
> aritmetică:
>
> ```
> R80: total chelt nedeductibile P34 trebuie sa fie suma cheltuielilor de la P23 pana la P33
> R56: total deduceri P16 trebuie sa fie suma P11+P12+P13+P14+P15
> R65: Profit/pierdere P22 trebuie sa fie suma P10-P16-P21
> ```
>
> Adică validatorul acceptă **orice** repartizare care torna — o mapare greșită ar trece validarea și
> ar raporta fals. De aceea etichetele au fost luate din **formularul oficial OPANAF 206/2025** și din
> instrucțiunile lui de completare, nu din sondaj. Corespondențele reținute: protocolul peste plafon →
> **rd. 26** (instrucțiunea citează chiar art. 25(3)(a)), sponsorizarea înregistrată în contabilitate →
> **rd. 27**, costul excedentar al îndatorării reportat → **rd. 31** (instrucțiunea spune că suma e
> preluată anul următor la rd. 12.1), iar cheltuielile sociale și cele auto rămân la **rd. 33** —
> corect, fiindcă instrucțiunea rândului 33 enumeră explicit „depășirile limitelor admisibile,
> stabilite prin dispozițiile art. 25 alin. (3)".
>
> **Amortizarea are DOUĂ rânduri, nu unul:** formularul cere amortizarea *contabilă* întreagă la
> **rd. 28** și pe cea *fiscală* la **rd. 11** (deducere) — nu diferența. Efectul pe impozit e identic
> (P34 crește cu amortizarea fiscală, P16 la fel, deci P22+P34 nu se mișcă), dar prezentarea e cea
> cerută și tratează natural cazul în care amortizarea fiscală o depășește pe cea contabilă: acolo
> „nedeductibilul" ar fi fost negativ, ceea ce pe formular n-ar avea sens.
>
> Invariantul e fixat în teste: **defalcarea nu are voie să miște P35/P40/P41/P52**. Iar referința
> `D101-defalcare` (`scripts/genereaza-referinte.js`) există fiindcă exemplul obișnuit n-are cheltuieli
> cu plafon — nedeductibilele ies zero și poarta ar fi rămas verde fără să fi validat vreodată calea
> nouă.

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

> **Pentru modulele de extragere, poarta e o alarmă, nu un test.** `aiExtractor.js`,
> `extractor.js`, `extractQuality.js`, `extractCheck.js`, `efacturaImport.js` și
> `einvoiceReconcile.js` sunt în perimetru, dar generatorul de referințe **nu ajunge niciodată la
> ele**: închiderea tranzitivă a lui `require()` din `scripts/genereaza-referinte.js` atinge 47 de
> module, niciunul dintre acestea (măsurat 2026-08-06). Poarta validează declarații construite din
> seed, deci nu poate vedea un defect introdus acolo. Rămân în listă fiindcă un defect acolo ajunge
> în declarații pe altă cale — cifre greșite intrate ca articole contabile — deci schimbarea merită
> oprită și ieșirile re-dovedite. Regresia se prinde însă cu **teste pe modul**, nu cu poarta.

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

Schema e-Transport e **versionată în repo** (vezi „Unde stă schema e-Transport" mai sus), deci CI
o găsește fără nicio variabilă de mediu — inclusiv pe un runner efemer. `CONTAB_ETRANSPORT_XSD`
rămâne doar suprascrierea pentru probe (cale sau URL). Dacă schema lipsește **și** variabila nu e
setată, poarta blochează orice schimbare fiscală: e-Transport iese `NEVERIFICAT`.

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

Schema **e** livrată în repo (`schemas/eTransport/`), deci comanda de mai sus e necesară doar dacă
vrei să validezi față de **altă** versiune decât cea versionată — `CONTAB_ETRANSPORT_XSD` acceptă
cale locală sau URL, cu `.zip` dezarhivat automat. Pre-validarea
rapidă din generarea aplicației rămâne `src/etransport.js` (`validate`): prinde câmpurile
obligatorii, enum-urile, formatele și coerența traseu↔tip de operațiune înainte de trimitere.
