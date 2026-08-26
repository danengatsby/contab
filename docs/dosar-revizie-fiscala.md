# Dosar de revizie fiscală de specialitate

Documentul care se **trimite revizorului** (expert contabil CECCAR / consultant fiscal) și
în care se **consemnează** rezultatul. Completează [guvernanța fiscală](guvernanta-fiscala.md):
acolo e cum se întreține setul de reguli, aici e cum se dovedește că e corect.

> **Starea la 2026‑08‑24: nicio revizie externă efectuată încă.** Cazurile-test există și rulează,
> dar **niciunul** nu are semnătura unui specialist. Numărul curent și starea fiecăruia se citesc
> din corpus (`node test/cazuri-aprobate.js`), nu de aici — o cifră scrisă în document ar drifta la
> fiecare caz nou. Vezi §6.
>
> **Adăugat 2026‑07‑28:** aria *Plafoane de deductibilitate* (`PLF-01..05`), cu regulile art. 25 și
> 40² — cea mai urgentă de revizuit din tot corpusul, fiindcă acolo interpretarea schimbă direct
> impozitul datorat, iar la art. 40² citirea alternativă dă **altă cifră** (vezi §6).

---

## 1. De ce e nevoie de ea (ce NU dovedește suita de teste)

Suita automată (`npm test`) și validatorul oficial ANAF acoperă două lucruri:

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

Restanța se semnalează singură. Cât timp acoperirea nu este completă și validă, aplicația lasă
disponibile calculele, rapoartele și validarea internă, dar blochează cu `409` artefactele XML de
depunere și operațiunile de închidere anuală.

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

## 5. Cum se consemnează o aprobare verificabilă

Poarta se deschide numai la **25/25** cazuri aprobate. Fiecare aprobare poartă separat numele,
calitatea profesională, data, temeiul confirmat, amprenta dosarului extern și **hash-ul** exact al
rezultatului, codului și configurației active verificate. Valoarea `signature` nu este un text
declarativ: este o semnătură Ed25519 verificată față de o cheie publică autorizată separat.

```bash
npm run revizie-fiscala -- --hash SAL-01
npm run revizie-fiscala -- --template SAL-01
npm run revizie-fiscala -- --key-id cheie-publica-revizor.pem
```

### 5.1 Înrolarea revizorului (separarea încrederii de aprobare)

Cheia publică a revizorului se înscrie de administrator în registrul separat
`src/fiscalReviewTrust.json` (sau în fișierul indicat de
`CONTAB_FISCAL_REVIEW_TRUST_FILE`). Identitatea și calitatea se verifică în afara aplicației, din
documentele/registrele profesionale aplicabile, iar dovada și data verificării se consemnează:

```json
{
  "schemaVersion": 1,
  "reviewers": {
    "<SHA-256 al cheii publice>": {
      "reviewer": "Nume Prenume",
      "credential": "expert contabil CECCAR nr. 12345",
      "credentialVerifiedAt": "2026-08-24",
      "credentialEvidence": "referința dovezii arhivate / registrului verificat",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----\\n",
      "validFrom": "2026-08-24"
    }
  }
}
```

Cheia privată rămâne exclusiv la revizor. O cheie absentă, expirată, revocată, ne-Ed25519 sau
nepotrivită identității/calității blochează toate aprobările sale.

### 5.2 Înregistrarea și semnarea fiecărui caz

După primirea dosarului profesional semnat, în `src/fiscalReviewApprovals.json` (schema 2) se
pregătește înregistrarea. `evidenceDocumentSha256` este SHA-256 al PDF-ului/dosarului original
arhivat, nu al unei copii regenerate:

```json
"SAL-01": {
  "decision": "approved",
  "fiscalYear": 2026,
  "reviewer": "Nume Prenume",
  "credential": "expert contabil CECCAR nr. 12345",
  "reviewedAt": "2026-08-24",
  "legalBasis": "Articolele și actele confirmate în dosarul semnat",
  "evidenceDocumentSha256": "SHA-256 al dosarului extern semnat",
  "keyId": "SHA-256 al cheii publice Ed25519 autorizate",
  "signature": "semnătura Ed25519 în base64 peste mesajul canonic",
  "hash": "hash-ul afișat de comanda de mai sus"
}
```

Mesajul exact de semnat se emite read-only după completarea câmpurilor (fără `signature`):

```bash
npm run revizie-fiscala -- --payload SAL-01 aprobare-SAL-01.json > payload-SAL-01.txt
openssl pkeyutl -sign -rawin -inkey cheie-privata-revizor.pem \
  -in payload-SAL-01.txt | openssl base64 -A
```

Rezultatul base64 se copiază în `signature`. Aplicația nu primește cheia privată și nu poate
fabrica aprobări.

Hash-ul SHA‑256 acoperă definiția cazului, versiunea setului fiscal, **manifestul automat al
întregului domeniu de cod și reguli** și configurația fiscală efectivă (`FISCAL`) după
suprascrierile din Setări. Manifestul inventariază automat fișierele executabile/configurabile din
`src/`, `public/`, `scripts/` și `test/`, dependențele Node și documentele de guvernanță. Adăugarea,
ștergerea sau schimbarea unui fișier din acest domeniu invalidează toate aprobările; modificarea
definiției unui caz îl invalidează cel puțin pe acela. Numai registrele de aprobări și chei sunt
excluse pentru a evita o amprentă autoreferențială.

`GET /api/fiscal-review` arată amprenta manifestului și a regulilor **active în procesul
serverului**. Aceasta este sursa autoritativă când există cote suprascrise. Pentru rularea CLI cu
aceleași suprascrieri se salvează răspunsul admin `GET /api/fiscal-config` și se furnizează prin
`--runtime-rules fisier.json`.

Semnătura Ed25519 dovedește tehnic integritatea aprobării și posesia cheii înrolate; nu este
declarată automat semnătură electronică calificată. Dacă dosarul este semnat calificat/PAdES,
originalul și raportul de validare a certificatului se arhivează. Art. 25 din [Regulamentul eIDAS](https://eur-lex.europa.eu/eli/reg/2014/910)
acordă numai semnăturii electronice calificate efectul echivalent semnăturii olografe, iar art. 26
stabilește cerințele unei semnături avansate. Domeniul profesional și calitatea expertului contabil
sunt reglementate de [OG nr. 65/1994](https://legislatie.just.ro/Public/DetaliiDocument/190971).

Stările și consecințele:

| Stare | Ce înseamnă | Efect |
|---|---|---|
| calculat ≠ așteptat | regresie sau cifră greșită | **eroare**, `npm test` pică |
| aprobat, hash schimbat | cod/regulă/configurație/rezultat modificat după semnătură | **eroare** în suită + blocaj operațional |
| semnătură sau cheie invalidă | aprobarea nu poate fi atribuită revizorului autorizat | **eroare** în suită + blocaj operațional |
| lipsă din registrul aprobărilor | nerevizuit încă | avertisment în suită + **blocaj la depuneri/închidere anuală** |

Cazurile nerevizuite nu blochează pornirea sau munca de pregătire: contabilul trebuie să poată
corecta date și rula validări. Blochează însă exact trecerea de încredere — descărcarea XML-ului
destinat depunerii, marcarea transmis/depus și închiderea anuală. Status: `GET /api/fiscal-review`.

## 6. Cazurile supuse aprobării

**Ce se trimite efectiv revizorului:**

```bash
node test/cazuri-aprobate.js --dosar > cazuri-fiscale-2026.md
```

Documentul de lucru: fiecare caz cu **temeiul**, **intrarea**, **cifrele propuse** și punctele
„De decis", plus o casetă de verdict per caz și rubrica de semnătură la final. Revizorul bifează
sau contestă direct pe el — nu are nevoie să citească JavaScript, ceea ce scurtează revizia și
elimină scuza „n-am putut verifica implementarea".

Tabelul de mai jos e doar un rezumat; sursa de adevăr rămâne `node test/cazuri-aprobate.js --md`.

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
| `SAL-03b` | Plafonul de 33%: cazare + pensii facultative + abonament sport peste plafon | Art. 76 alin. (4¹) și (4²) Cod fiscal |
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

### Plafoane de deductibilitate (impozit pe profit) — **prioritatea reviziei**

Adăugate 2026‑07‑28. Spre deosebire de restul corpusului, unde o eroare afectează un salariat sau o
estimare, aici interpretarea schimbă **impozitul pe profit datorat de firmă**.

| Caz | Ce se verifică | Temei |
|---|---|---|
| `PLF-01` | Protocol — plafonul de 2% și **baza** lui de calcul | Art. 25(3)(a) Cod fiscal |
| `PLF-02` | Cheltuieli sociale — 5% din fondul de salarii | Art. 25(3)(b) Cod fiscal |
| `PLF-03` | Sponsorizare — cheltuială nedeductibilă + credit fiscal cu dublu plafon | Art. 25(4)(i) Cod fiscal |
| `PLF-04` | Cheltuieli auto — 50% nedeductibil pe **cheltuială** (distinct de TVA) | Art. 25(3)(l) Cod fiscal |
| `PLF-05` | Costuri excedentare ale îndatorării — plafon în EUR + 30% din bază | Art. 40² Cod fiscal |

## 7. Simplificări cunoscute — lista de întrebări pentru revizor

Inventarul onest al locurilor unde implementarea e deliberat simplificată. **Acestea sunt punctele
pe care revizia trebuie să se pronunțe în primul rând** — nu sunt bug-uri raportate, ci decizii care
au nevoie de o semnătură calificată.

### 7.1 Concediile medicale — limitele software închise la 2026-08-20

Au fost închise diferențele materiale identificate la revizie:

- baza zilnică folosește `ΣV / NTZ` din ultimele șase luni și plafonul lunar de 12 salarii minime;
- calendarul separă zilele calendaristice de cele lucrătoare și elimină sărbătorile legale;
- regula temporară 01.02.2026–31.12.2027 scade o singură zi lucrătoare pe episod și mută intervalul
  angajatorului pe pozițiile calendaristice 2–6, cu excepțiile legale;
- codul indemnizației, procentul, sursa angajator/FNUASS și datele certificatului sunt dimensiuni
  explicite; codul 01 refuză alte procente decât 55/65/75;
- CASS se calculează pentru codurile 01, 07 și 10, nu uniform pentru toate concediile;
- D112 emite B1–B4, D și familia C2 corectă; toate cele 19 coduri acceptate sunt probate separat
  și trec validatorul oficial curent fără erori sau atenționări. Câmpurile condiționale D8/D8a,
  D11/D12/D13 și diagnosticul `RM` sunt obligatorii la salvare pentru codurile care le cer;
- continuările cod 01 din iulie 2026 declară separat diferențele recalculate ale lunii anterioare
  în D20a/D21a, B3_7D și C2_155/C2_156; sumele sunt introduse explicit de operator după
  recalcularea episodului și intră în taxele și venitul lunii curente;
- se pot înregistra până la 10 certificate distincte pentru același angajat și aceeași lună.
  Calculul intersectează fiecare certificat cu pozițiile episodului, scade o singură zi pe episod
  continuu și emite câte o secțiune D; proba `D112-cm-multiple` trece DUKIntegrator;
- istoricul extern din adeverințe se introduce ca luni `venit + zile` și se combină fără dublare cu
  statele postate. Brutul curent poate servi numai la previzualizare: postarea este refuzată cât
  timp baza ori repartizarea zilelor este aproximată;
- aplicația nu pretinde că poate deduce istoricul de asigurare din afara firmei. Operatorul alege
  explicit „stagiu” sau „excepție” și consemnează documentul justificativ; fără ambele, statul cu
  CM nu se postează. Aceasta este o separare de responsabilitate verificabilă, nu o aproximare.

### 7.2 Deducerea personală (`src/fiscal.js`)

**Rezolvat la 2026-08-20:** calculul urmează tabelul art. 77 alin. (4), cu 40 de tranșe de câte
50 lei și reducerea procentului cu 0,5 puncte pe tranșă. Corpusul verifică explicit primele două
praguri (+1 și +51 lei), nu doar punctele +1.000/+2.000 unde vechea interpolare liniară dădea
întâmplător același rezultat — caz `DED-02`.

### 7.3 Taxele PFA (`src/fiscal.js:126‑134`)

Marcate „ESTIMARE" în cod, în interfață și în PDF. CAS sub 12 SM e opțională și e considerată 0
(neoptată); opțiunile individuale (bază CAS mai mare, alte venituri asigurate) rămân la
contribuabil. E suficientă marcarea ca estimare? — cazurile `PFA-01..03`.

### 7.4 Baza CAM la tichete (`src/fiscal.js:121`)

CAM se calculează doar pe salariul brut + avantaje + partea de CM a angajatorului; tichetele de
masă sunt **excluse** din bază. De confirmat tratamentul — caz `SAL-02`.

### 7.4b Plafonul de 33% — controale închise la 2026-08-20 (`src/beneficii.js`)

- Ordinea în care categoriile ocupă plafonul de 33% este editabilă per angajat. Dacă plafonul comun
  este efectiv depășit, statul nu poate fi postat până când angajatorul nu confirmă ordinea; alegerea
  și confirmarea rămân în fotografia lunii.
- Plafoanele anuale în EUR folosesc cursul BNR în vigoare în ultima zi a lunii. Cursul, data și
  proveniența sunt păstrate pe rând; lipsa cursului definitiv blochează postarea, fără fallback
  fiscal tăcut la 5,0.
- Categoria `e¹`, pensii ocupaționale, introdusă prin OUG 8/2026, este distinctă și are plafonul
  anual propriu de 400 EUR.

Consumul plafoanelor anuale se citește numai din reviziile **active postate** (`payrollHistory`).
Închis tehnic la 2026-08-20: o fotografie stornată rămâne în audit, dar nu mai consumă plafon;
postarea retroactivă este blocată cât timp există state ulterioare active. Corecția cere storno în
ordine inversă și repostare cronologică, deci partea impozabilă a unei luni ulterioare nu poate
rămâne calculată pe un istoric salarial schimbat.

### 7.5 Cursul pentru plafonul micro — rezolvat

Motorul folosește cursul BNR de la 31 decembrie al exercițiului precedent (ultimul curs publicat
înainte, dacă data nu este zi bancară). Valoarea orientativă din configurare este doar fallback
vizibil și produce avertisment lângă plafon; nu mai este prezentată ca sursă legală.

### 7.6 Clasificări orientative în rapoarte

- `src/reporting.js:275` — clasificarea pro‑rata (cu/fără drept de deducere) se face aproximativ,
  din jurnal;
- `src/reporting.js:252` — controlul plafonului de scutire TVA doar **avertizează**; încadrarea
  finală rămâne la contribuabil;
- `src/pdf/registre.js:202,236` — deductibilitățile din registrul de evidență fiscală sunt marcate
  explicit ca orientative.

Sunt aceste avertismente suficiente ca poziționare, sau trebuie transformate în controale ferme?

### 7.7 Plafoanele de deductibilitate (`src/deductibilitate.js`) — cea mai mare incertitudine deschisă

Adăugat 2026‑07‑28, odată cu motorul. Patru întrebări, în ordinea impactului:

**(a) Art. 40² — costurile excedentare ale îndatorării. Aici există două citiri care dau cifre
diferite, și e nevoie de o decizie, nu de o preferință.** Implementarea tratează plafonul în EUR ca
deductibil necondiționat și aplică cei 30% **doar părții care îl depășește**:

```
deductibil = plafonEUR + min(cost − plafonEUR ; 30% × bază)
```

Citirea alternativă ar fi `deductibil = max(plafonEUR ; 30% × bază)`. Pe cazul `PLF-05` (cost
20.000.000 lei, bază 20.100.000, curs 5): implementarea dă **8.970.000** nedeductibil, alternativa dă
**13.970.000**. Diferența e de 5 milioane de lei pe un singur exercițiu.

În plus, la această regulă: baza de calcul folosește amortizarea **fiscală**, care astăzi coincide cu
cea contabilă (item separat în backlog), iar **diferențele de curs valutar aferente împrumuturilor NU
sunt incluse** în costul excedentar, deși legea le menționează.

**(b) Protocol — baza de calcul.** Implementarea include în bază cheltuiala de protocol **însăși** și
cheltuiala cu impozitul pe profit. Dacă revizorul consideră baza altfel (de exemplu doar profitul
contabil), plafonul din `PLF-01` scade de la 2.420 la 2.000 și nedeductibilul crește la 3.000.

**(c) Sponsorizare — regimul reportului.** Creditul neutilizat se reportează pe
`sponsorizareReportAni` ani (azi 7), consumat cel mai vechi întâi. Regulile de report și de
redirecționare s-au schimbat de câteva ori în ultimii ani — de confirmat că regimul implementat e cel
în vigoare pentru exercițiul revizuit. Notă tehnică: plafonul de 20% e impus și de validatorul oficial
D101 ca `round((P41−P42)×20%) ≥ P43`, deci pe impozitul **minus creditul fiscal extern**; aplicația nu
modelează P42, deci azi cele două coincid.

**(d) Fondul de salarii la cheltuielile sociale.** Baza e rulajul contului **641**. De confirmat dacă
pentru firmele care folosesc și 642/643/644 acestea trebuie incluse.

## 8. Ce rămâne în sarcina utilizatorului, oricum

Revizia nu transferă răspunderea. Chiar cu toate cazurile aprobate, rămân la contabilul autorizat
al firmei utilizatoare: încadrarea corectă a operațiunilor, deducerile aplicabile, spețele
particulare și depunerea propriu-zisă. Vezi
[guvernanta-fiscala.md §4](guvernanta-fiscala.md).
