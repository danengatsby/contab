# Dosar de revizie fiscală de specialitate

Documentul care se **trimite revizorului** (expert contabil CECCAR / consultant fiscal) și
în care se **consemnează** rezultatul. Completează [guvernanța fiscală](guvernanta-fiscala.md):
acolo e cum se întreține setul de reguli, aici e cum se dovedește că e corect.

> **Starea la 2026‑07‑27: nicio revizie externă efectuată încă.** Cele 17 cazuri-test există și
> rulează, dar niciunul nu are semnătura unui specialist. Vezi §6.

---

## 1. De ce e nevoie de ea (ce NU dovedește suita de teste)

Suita automată (~1.200 aserțiuni) și validatorul oficial ANAF acoperă două lucruri:

| Ce se dovedește azi | Cu ce |
|---|---|
| Aplicația calculează **consecvent** (fără regresii de la o versiune la alta) | `npm test` |
| Declarațiile sunt **valide ca formă** (schemă, câmpuri, corelații) | `scripts/valideaza-duk.sh` (DUKIntegrator) |
| Cifrele sunt **corecte față de lege** | ❌ **nimic — asta e golul pe care îl acoperă revizia** |

Un test verde spune „codul face ce făcea ieri". Nu spune că ce făcea ieri era legal. DUKIntegrator
validează *forma* declarației, nu *fondul*: un D112 cu o indemnizație de concediu medical calculată
greșit trece validarea fără o vorbă.

## 2. Obiectul reviziei (perimetru)

Se revizuiesc **trei straturi**, în ordinea asta:

1. **Parametrii** — [`src/fiscalConfig.js`](../src/fiscalConfig.js): cotele, pragurile, grilele și
   referințele legale din harta `SURSE`. Sursă unică, datată (`AN`, `DATA_ACTUALIZARE`);
   nicio cotă nu e hardcodată în afara acestui fișier.
2. **Tratamentele** — logica de calcul:
   - [`src/fiscal.js`](../src/fiscal.js) — salarii, deducere personală, taxe PFA;
   - [`src/payroll.js`](../src/payroll.js) — statul de plată, concedii medicale și de odihnă,
     normă parțială;
   - [`src/reporting.js`](../src/reporting.js) — jurnale TVA, pro‑rata, estimarea Declarației Unice.
3. **Cazurile-test** — [`test/cazuri-aprobate.js`](../test/cazuri-aprobate.js): perechile
   intrare → cifră așteptată, cu temeiul legal pe fiecare. Acesta e **artefactul semnat**.

**În afara perimetrului:** structura declarațiilor XML (acoperită de validatorul ANAF), corectitudinea
partidei duble (acoperită de balanță/bilanț), infrastructura.

## 3. Cadența

**Anual, în ianuarie**, după publicarea actelor normative pentru anul nou — momentul în care se
schimbă simultan salariul minim, plafoanele și, de obicei, cel puțin o cotă.

Suplimentar, **la fiecare modificare legislativă majoră** care atinge un caz aprobat (schimbarea
îl invalidează automat — vezi §5).

Restanța se semnalează singură: dacă ultima aprobare e dintr-un an anterior lui `fiscalConfig.AN`,
rularea corpusului avertizează („revizia anuală e restantă").

## 4. Procedura

1. **Se trimite revizorului** acest document + tabelul cazurilor
   (`node test/cazuri-aprobate.js --md`) + capitolul de simplificări (§7).
2. **Revizorul se pronunță pe fiecare caz**: cifra așteptată e corectă / e greșită (cu valoarea
   corectă și temeiul) / cazul e irelevant.
3. **Cifrele contestate se corectează în cod**, nu în test. Un caz-test nu se aliniază niciodată la
   ce produce codul; codul se aliniază la ce a spus revizorul.
4. **Se consemnează aprobarea** (§5) și se completează jurnalul din
   [guvernanta-fiscala.md §5](guvernanta-fiscala.md).
5. Commit tematic: `Revizie fiscală <an>: <cine>, <ce s-a schimbat>`.

## 5. Cum se consemnează o aprobare

Fiecare caz aprobat poartă cine l-a aprobat, când, și o **amprentă** a ceea ce s-a aprobat:

```bash
node test/cazuri-aprobate.js --semnatura SAL-01     # -> 8501524eb1e6abf4
```

...iar în `test/cazuri-aprobate.js`, pe cazul respectiv:

```js
aprobare: {
  de: 'Ing. X Y, expert contabil CECCAR nr. 12345',
  la: '2027-01-20',
  nota: 'Confirmat pe grila ANAF publicată la 2027-01-10.',
  semnatura: '8501524eb1e6abf4',
},
```

Amprenta e SHA‑256 peste tripleta **(temei, intrare, cifre așteptate)**. Rostul ei: dacă cineva
modifică ulterior un caz aprobat — altă intrare, altă cifră, alt temei — amprenta nu mai corespunde
și **suita pică** cu „caz APROBAT dar modificat ulterior; re-supune-l la revizie". O aprobare nu
poate fi moștenită tacit de alte cifre decât cele văzute de revizor.

Stările și consecințele:

| Stare | Ce înseamnă | Efect |
|---|---|---|
| calculat ≠ așteptat | regresie sau cifră greșită | **eroare**, `npm test` pică |
| aprobat, amprentă schimbată | modificat după semnătură | **eroare**, `npm test` pică |
| `aprobare: null` | nerevizuit încă | **avertisment** — nu blochează |

Alegerea deliberată: cazurile nerevizuite **nu** blochează suita (altfel `prestart` ar opri
producția pentru o chestiune de guvernanță), dar apar la fiecare rulare, nominal, cu mențiunea
că cifrele sunt „doar consecvente cu implementarea, nu confirmate față de lege".

## 6. Cazurile supuse aprobării

17 cazuri, în 6 arii. Tabelul de mai jos e un instantaneu — sursa de adevăr e
`node test/cazuri-aprobate.js --md`.

### Cote și praguri

| Caz | Ce se verifică | Temei |
|---|---|---|
| `COT-01` | Cotele CAS 25% / CASS 10% / impozit 10% / CAM 2,25% | Art. 138, 156, 78, 220^3 Cod fiscal |
| `COT-02` | Salariul minim S1/S2 și sumele neimpozabile | HG salariu minim; art. 76 Cod fiscal |
| `COT-03` | TVA 21% / 11%, plafon scutire 395.000 lei, TVA auto 50% | Legea 141/2025; art. 310, 298 Cod fiscal |
| `COT-04` | Impozit profit 16% / micro 1% / dividende 16%, plafon micro 100.000 EUR | Art. 17, 51, 47 Cod fiscal; Legea 141/2025 |

### Salarii

| Caz | Ce se verifică | Temei |
|---|---|---|
| `SAL-01` | Brut 5.000 lei fără deduceri (cazul de bază) | Art. 138, 156, 78, 220^3 Cod fiscal |
| `SAL-02` | Tichete de masă 400 lei (CASS + impozit, fără CAS) | Art. 76 alin. (3), art. 157 Cod fiscal |
| `SAL-03` | Avantaje în natură 1.000 lei (intră în toate bazele) | Art. 76 alin. (3) Cod fiscal |
| `SAL-04` | Normă parțială sub salariul minim | Art. 146 Cod fiscal, OUG 16/2022 |

### Deducerea personală

| Caz | Ce se verifică | Temei |
|---|---|---|
| `DED-01` | Deducerea de bază la salariul minim, 0 și 2 persoane în întreținere | Art. 77 Cod fiscal, Legea 34/2023 |
| `DED-02` | Diminuarea peste salariul minim (+1.000 / +2.000 lei) | Art. 77 Cod fiscal |
| `DED-03` | Suplimentul pentru tineri sub 26 de ani | Art. 77 alin. (7) Cod fiscal |

### Concedii medicale

| Caz | Ce se verifică | Temei |
|---|---|---|
| `CM-01` | 10 zile din 21, fără istoric de state postate | OUG 158/2005; art. 157 Cod fiscal |
| `CM-02` | Același concediu, cu baza din media a 6 state postate | OUG 158/2005 art. 10 |

### Concedii de odihnă

| Caz | Ce se verifică | Temei |
|---|---|---|
| `CO-01` | 10 zile din 21, indemnizația pe media a 3 luni | Art. 150 Codul muncii |

### PFA — Declarația Unică

| Caz | Ce se verifică | Temei |
|---|---|---|
| `PFA-01` | Venit net 30.000 lei (între 6 și 12 SM): CASS da, CAS nu | Art. 148, 170 Cod fiscal |
| `PFA-02` | Venit net 60.000 lei: baza CAS = 12 SM | Art. 148 Cod fiscal |
| `PFA-03` | Venit net 300.000 lei: baza CAS = 24 SM, CASS plafonată la 60 SM | Art. 148, 170 Cod fiscal |

## 7. Simplificări cunoscute — lista de întrebări pentru revizor

Inventarul onest al locurilor unde implementarea e deliberat simplificată. **Acestea sunt punctele
pe care revizia trebuie să se pronunțe în primul rând** — nu sunt bug-uri raportate, ci decizii care
au nevoie de o semnătură calificată.

### 7.1 Concediile medicale (`src/payroll.js:43‑57`) — zona cea mai expusă

Marcată în cod „OUG 158/2005, **simplificat**". Șapte întrebări:

1. **Zile calendaristice vs lucrătoare.** Codul tratează `zileCM` ca zile *lucrătoare* și scade
   primele 5 din ele pentru partea angajatorului. OUG 158/2005 vorbește de primele 5 zile
   *calendaristice*. Ce convenție se adoptă?
2. **Numitorul mediei zilnice.** Codul împarte baza la zilele lucrătoare ale **lunii curente**
   (`zileLucratoare`, implicit 21). Legal, media zilnică se raportează la zilele de stagiu din
   perioada celor 6 luni. Diferența e materială pentru luni cu număr atipic de zile.
3. **Tipul de concediu nu e modelat.** Regula celor 5 zile în sarcina angajatorului se aplică
   *indiferent* de codul de indemnizație. Pentru maternitate, îngrijirea copilului bolnav sau
   accident de muncă / boală profesională, suportarea e integral din FNUASS/FAAMBP.
   Se introduce codul de indemnizație ca dimensiune?
4. **Procentul e liber.** `procentCM` are implicit 75% și e editabil fără legătură cu codul de
   indemnizație (100% pentru bolile din anexa OUG 158/2005, 85% risc maternal etc.).
   Se leagă procentul de cod, sau rămâne responsabilitatea operatorului?
5. **Stagiul minim de cotizare nu e verificat** (6 luni în ultimele 12). Aplicația calculează
   indemnizația indiferent de stagiu. Se adaugă un control, măcar ca avertisment?
6. **Fallback pe brutul curent.** Când nu există state postate anterior (firmă migrată la mijloc
   de an), baza cade pe brutul lunii curente. Acceptabil, sau trebuie refuzat calculul?
7. **Plafonarea la 12 salarii minime** se aplică *mediei lunare* (48.600 lei la S1), nu
   indemnizației rezultate. De confirmat.

Contribuțiile pe indemnizație (CAS da, CASS nu, impozit da, CAM doar pe partea angajatorului)
sunt implementate în `src/fiscal.js:103‑121` și se confirmă prin `CM-01`.

### 7.2 Deducerea personală (`src/fiscal.js:49‑52`)

Peste salariul minim, valoarea scade la 0 la (minim + 2.000 lei) prin **interpolare liniară**, în
loc de citirea grilei oficiale ANAF pe trepte de 50 lei. Diferențele sunt de ordinul câtorva lei pe
treaptă. Se acceptă aproximarea (cu suprascriere manuală pentru cazuri exacte) sau se introduce
grila completă? — caz `DED-02`.

### 7.3 Taxele PFA (`src/fiscal.js:126‑134`)

Marcate „ESTIMARE" în cod, în interfață și în PDF. CAS sub 12 SM e opțională și e considerată 0
(neoptată); opțiunile individuale (bază CAS mai mare, alte venituri asigurate) rămân la
contribuabil. E suficientă marcarea ca estimare? — cazurile `PFA-01..03`.

### 7.4 Baza CAM la tichete (`src/fiscal.js:121`)

CAM se calculează doar pe salariul brut + avantaje + partea de CM a angajatorului; tichetele de
masă sunt **excluse** din bază. De confirmat tratamentul — caz `SAL-02`.

### 7.5 Cursul pentru plafonul micro (`src/fiscalConfig.js:44`)

`cursPlafonMicro: 5.0` e o valoare **orientativă** fixă; legal se folosește cursul de la închiderea
exercițiului precedent. Rămâne parametru manual sau se preia automat? — caz `COT-04`.

### 7.6 Clasificări orientative în rapoarte

- `src/reporting.js:275` — clasificarea pro‑rata (cu/fără drept de deducere) se face aproximativ,
  din jurnal;
- `src/reporting.js:252` — controlul plafonului de scutire TVA doar **avertizează**; încadrarea
  finală rămâne la contribuabil;
- `src/pdf/registre.js:202,236` — deductibilitățile din registrul de evidență fiscală sunt marcate
  explicit ca orientative.

Sunt aceste avertismente suficiente ca poziționare, sau trebuie transformate în controale ferme?

## 8. Ce rămâne în sarcina utilizatorului, oricum

Revizia nu transferă răspunderea. Chiar cu toate cazurile aprobate, rămân la contabilul autorizat
al firmei utilizatoare: încadrarea corectă a operațiunilor, deducerile aplicabile, spețele
particulare și depunerea propriu-zisă. Vezi
[guvernanta-fiscala.md §4](guvernanta-fiscala.md).
