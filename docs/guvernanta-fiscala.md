# Guvernanța regulilor fiscale

Cum se întrețin regulile fiscale din Contabo: unde stau, cum se schimbă, cum se verifică
și ce garantează (respectiv NU garantează) aplicația la depunere.

## 1. Sursa unică, datată

Toți parametrii fiscali stau în **`src/fiscalConfig.js`** — date, nu logică:

- `AN` + `DATA_ACTUALIZARE` — versiunea setului de reguli;
- fiecare cotă are **referința legală** în comentariu și în harta `SURSE`
  (ex. `cas: 25 // art. 138 Cod fiscal`);
- valorile cu **interval de valabilitate** sunt modelate explicit (ex. salariul minim
  S1/S2 cu trecerea la 1 iulie prin `salariuMinimLa(data)`; cotele TVA 21/11 de la
  1 august 2025 prin Legea 141/2025);
- cotele sunt **suprascriabile per instalare** din Setări → Cote fiscale — valorile din
  fișier sunt implicitele de referință.

Regula de aur: **nicio cotă hardcodată în afara acestui fișier.** (Convenție impusă și
în CLAUDE.md; încălcările se prind la review.)

## 2. Fluxul unei schimbări legislative

1. Se modifică valoarea în `fiscalConfig.js` + `AN`/`DATA_ACTUALIZARE` + nota din `SURSE`
   (cu actul normativ și data intrării în vigoare).
2. Se actualizează/adaugă **testele datate** din `test/run.js` — fiecare schimbare
   legislativă are aserțiuni cu valorile noi (ex. TVA 21/11, dividende 16% din 2026,
   salariul minim pe semestre). Suita de module pică dacă o cotă veche a rămas undeva
   (numărul curent de verificări îl spune `npm test` — nu îl fixăm aici, ar drifta la
   fiecare test nou).
3. **Poarta fiscală, obligatoriu înainte de merge:** `sh scripts/poarta-fiscala.sh` —
   generează toate ieșirile din seed și le trece prin validatoarele **oficiale**
   (DUKIntegrator pentru declarații + SAF-T, XSD pentru e-Transport). Se aplică automat
   doar dacă s-a atins ceva fiscal. Blochează atât la „invalid", cât și la „n-am putut
   verifica". Detalii: **docs/validare-oficiala.md**.
4. Commit tematic cu actul normativ în mesaj → review → merge → deploy.

Istoricul git al `fiscalConfig.js` este astfel **jurnalul versiunilor de reguli**:
cine, când, ce act normativ, ce teste însoțesc schimbarea.

## 2. Profilul fiscal pe firmă (`src/fiscalProfile.js`)

Dacă `fiscalConfig.js` ține **cotele** (aceleași pentru toți), profilul fiscal ține
**regimul fiecărei firme** și e **sursa unică** din care se derivă declarațiile așteptate,
alertele (termene) și controalele — nu boolean-uri (`tvaPlatitor`) citite ad-hoc prin cod.

`fiscalProfile.build(company, { angajați })` normalizează firma într-un profil structurat:
plătitor TVA + **perioadă L/T**, **TVA la încasare**, **regim** (`micro`/`profit`/`pfa`),
**are angajați**, **cadență D406** (L/T/A), **obligație Intrastat**, **excepții** (scutiri
per declarație). Toate câmpurile au implicite compatibile cu firmele existente: un profil
construit dintr-o firmă veche dă exact comportamentul de dinainte.

`fiscalProfile.expected(profile, period, hasIntracom, hasIntracomServices, hasD301)` derivă lista
de declarații din profil;
`declarations.expectedForFirma` (și, prin ea, registrul, portofoliul și notificările) **deleagă**
aici. Câmpurile de profil se editează prin `/api/company` (allowlist `FIRMA_EDITABLE`) și profilul
calculat se citește la `GET /api/fiscal-profile`. Un regim nou (ex. D100 micro vs D101 profit,
prag Intrastat) se adaugă în acest motor, cu teste în secțiunea „Motor de profil fiscal".

Jurnalul dovezilor de validare (versiuni de schemă/validator, dată, rezultat):
**docs/validare-oficiala.md**.

## 3. Statusul „pre-depunere" al unei declarații

Trei trepte, în ordinea încrederii:

| Status | Ce înseamnă | Cum se obține |
|---|---|---|
| **calcul intern** | XML bine-format + câmpuri obligatorii + CUI/perioadă valide | automat, la generare (`src/validate.js`) |
| **validat oficial** | trece validatorul ANAF (DUKIntegrator) fără erori | `scripts/valideaza-duk.sh D300/D301/D394/D112/D390/D100/D205/D406 fișier.xml` |
| **necesită verificare contabilă** | corectitudinea de FOND (încadrări, deduceri, spețe) | întotdeauna — vezi §4 |

Toate ieșirile fiscale din bateria de referință, inclusiv D301 în variantele inițială,
rectificativă și mijloc de transport nou, trec treapta „validat oficial" pe datele de exemplu.
Numărul și jurnalul probei sunt în `docs/validare-oficiala.md`. Validarea oficială se repetă
oricum obligatoriu la depunerea în SPV.

## 4. Ce NU garantează aplicația (și cine răspunde)

Tratamentele sunt implementate pentru cazurile uzuale și unele sunt **simplificate
deliberat** (marcate în cod: ex. concediile medicale „OUG 158/2005, simplificat").
Validarea oficială verifică *forma*, nu *fondul*: încadrarea corectă a operațiunilor,
deducerile aplicabile și spețele particulare rămân responsabilitatea unui
**contabil autorizat (CECCAR)** al firmei utilizatoare.

Pentru operatorii care oferă Contabo ca serviciu: programați o **revizie anuală de
specialist** a `fiscalConfig.js` + a tratamentelor din `fiscal.js`/`payroll.js`
(ideal în ianuarie, după publicarea actelor pentru anul nou) și consemnați-o mai jos.

Perimetrul, procedura, inventarul simplificărilor cunoscute și cazurile supuse aprobării:
**docs/dosar-revizie-fiscala.md** — documentul care se trimite revizorului.

## 5. Cazurile-test aprobate (`test/cazuri-aprobate.js`)

Restul suitei dovedește că aplicația calculează **consecvent**; corpusul acesta dovedește că un
**om calificat a confirmat cifrele față de lege**. 17 cazuri (cote, salarii, deducere personală,
concedii, PFA), fiecare cu intrare, cifre așteptate și temei legal.

Când un specialist confirmă un caz, se completează `aprobare` cu cine/când și cu **amprenta**
tripletei (temei, intrare, cifre) — `node test/cazuri-aprobate.js --semnatura <ID>`. Dacă un caz
aprobat e modificat ulterior, amprenta nu mai corespunde și suita **pică**: o aprobare nu se
moștenește tacit de alte cifre. Cazurile nerevizuite doar avertizează (nu blochează `prestart`),
dar apar nominal la fiecare rulare.

Regula de aur a corpusului: **un caz-test nu se aliniază niciodată la ce produce codul.** Dacă
revizorul contestă o cifră, se corectează codul.

```bash
node test/cazuri-aprobate.js                 # rulează corpusul + raportul de acoperire
node test/cazuri-aprobate.js --semnatura ID  # amprenta de lipit în `aprobare`
node test/cazuri-aprobate.js --md            # tabelul pentru dosar
```

## 6. Jurnalul reviziilor de specialitate

| Data | Cine | Ce s-a revizuit | Concluzie |
|---|---|---|---|
| — | — | — | (nicio revizie externă consemnată încă; 0/17 cazuri aprobate) |
