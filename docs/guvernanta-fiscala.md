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

`fiscalProfile.profileAt(view, data/perioada, { angajați })` citește tabelul separat
`fiscal_profile_history` și normalizează firma într-un profil structurat:
plătitor TVA + **perioadă L/T**, **TVA la încasare**, **regim** (`micro`/`profit`/`pfa`),
**are angajați**, **cadență D406** (L/T/A), **obligație Intrastat**, **excepții** (scutiri
per declarație). Toate câmpurile au implicite compatibile cu firmele existente: un profil
construit dintr-o firmă veche dă exact comportamentul de dinainte.

Fiecare rând temporal are `firmaId`, `validFrom`, `validTo` (capăt exclusiv), `recordedAt`
(momentul UTC în care versiunea a fost consemnată), fotografia completă `values` și autorul.
Timpul efectiv și timpul înregistrării nu se suprapun semantic: o decizie poate fi introdusă azi
cu efect de luna viitoare sau poate consemna retroactiv un document primit târziu. La introducerea
unei revizii viitoare se închide doar intervalul
precedent; valorile lui nu sunt rescrise. Istoricul înglobat în obiectul firmei din versiunile vechi
este migrat idempotent în tabel; `createdAt` devine sursa legacy pentru `recordedAt`, iar când nici
acela nu există se consemnează onest momentul migrării. La generarea XML-ului, profilul perioadei
este fotografiat și hash-uit; snapshotul include `recordedAt` și un `provenanceHash`, este copiat în
depunere și rămâne legat de hash-ul artefactului.

`fiscalProfile.expected(profile, period, hasIntracom, hasIntracomServices, hasD301, hasD307, hasD311, hasD107)` derivă lista
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
| **validat oficial** | trece validatorul ANAF (DUKIntegrator) fără erori | `scripts/valideaza-duk.sh D300/D301/D307/D311/D394/D112/D390/D100/D107/D205/D406 fișier.xml` |
| **poartă externă de lansare** | cele 25 de cazuri și codul aferent au semnătură + hash valabile | `npm run revizie-fiscala`; 25/25 înainte de artefactul de depunere |
| **corpus de autonomie** | minimum 500 scenarii unice, acoperire structurală, doi revizori și zero incertitudini pe regulă | `src/fiscalAutonomy.js`; separat de 25/25 |
| **necesită verificare contabilă** | corectitudinea de FOND a firmei (încadrări, deduceri, spețe) | întotdeauna — vezi §4 |

Toate ieșirile fiscale din bateria de referință, inclusiv D107, D301, D307 și D311 în variantele lor distincte,
trec treapta „validat oficial" pe datele de exemplu.
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

## 5. Setul de lansare aprobat (`test/cazuri-aprobate.js`)

Restul suitei dovedește că aplicația calculează **consecvent**; setul acesta dovedește că un
**om calificat a confirmat cifrele față de lege**. Setul are 25 de cazuri (cote, salarii,
deducere personală, concedii, PFA și deductibilități), fiecare cu intrare, cifre așteptate și temei.
Este o poartă de lansare/depunere, nu un corpus suficient pentru autonomie.

Când un specialist confirmă un caz, în `src/fiscalReviewApprovals.json` (schema 2) se consemnează
numele, calitatea, data, temeiul, SHA-256 al dosarului extern, cheia și semnătura Ed25519, plus
hash-ul dat de `npm run revizie-fiscala -- --hash <ID>`. Cheia publică și verificarea datată a
calității profesionale stau separat în `src/fiscalReviewTrust.json`; cheia privată nu intră în
aplicație. Un simplu text în `signature` nu este acceptat.

Hash-ul include manifestul automat al codului/regulilor și fotografia configurației fiscale active,
inclusiv suprascrierile din Setări. Orice adăugare, ștergere sau modificare în domeniul sursă ori
orice schimbare a unei cote active invalidează automat aprobările. Poarta cere exact setul
complet, minimum 25 de cazuri și 25/25 aprobări valide. Cazurile nerevizuite nu blochează pornirea
și calculele, dar blochează artefactele XML de depunere, stările transmis/depus și operațiunile de
închidere anuală.

Această revizie a motorului nu este aprobarea unei declarații concrete. Pentru fiecare dosar,
aprobatorul confirmă separat SHA-256-ul complet al fișierului verificat. Dovada documentului
include actorul, momentul, dimensiunea, hash-ul reviziei fiscale și un `approvalHash`; numai acel
artefact poate trece din `generata` în `aprobata` și apoi în `transmisa`. O regenerare păstrează
aprobarea veche în istoric, dar o invalidează ca proiecție curentă.

Regula de aur a setului: **un caz-test nu se aliniază niciodată la ce produce codul.** Dacă
revizorul contestă o cifră, se corectează codul.

```bash
node test/cazuri-aprobate.js                 # rulează setul de lansare + raportul 25/25
node test/cazuri-aprobate.js --semnatura ID  # compatibil: hash-ul runtime curent
node test/cazuri-aprobate.js --md            # tabelul pentru dosar
npm run revizie-fiscala                      # status runtime; exit 2 cât timp nu e complet
npm run revizie-fiscala -- --template ID     # scheletul înregistrării externe
npm run revizie-fiscala -- --payload ID aprobare.json  # octeții canonici semnați extern
npm run revizie-fiscala -- --key-id public.pem         # amprenta cheii de înrolat
```

## 5.1 Corpusul distinct de autonomie

`src/fiscalAutonomyCorpus.json` pornește deliberat cu zero cazuri și păstrează separat
incertitudinile materiale. Poarta cere cel puțin 500 de scenarii **unice și trecute**, minimum 30
pe tratament (36 pentru limitările auto), toate dimensiunile structurale declarate în
`src/fiscalAutonomyCoverage.js` și două aprobări Ed25519 de la persoane profesionale distincte.
Contractul este legat de hash-ul regulii fără să rescrie snapshot-urile istorice. Dublarea aceleiași
intrări sub alte ID-uri nu crește volumul.

Dimensiunile obligatorii sunt: ramuri; sub/la/peste fiecare prag; înainte/la/după tranziții;
combinații de excepții; rectificări; date incomplete; date contradictorii; refuzuri obligatorii.
O incertitudine `open` blochează regulile indicate. Ea nu poate fi eliminată din JSON; pentru
`resolved` sunt obligatorii persoana, data și SHA-256 al dovezii profesionale. Art. 40² și celelalte
întrebări deschise din §7.7 al dosarului blochează în prezent `ro.tax.profit`.

Utilitarul este read-only; cheia privată rămâne la revizor:

```bash
npm run revizie-autonomie
npm run revizie-autonomie -- --hash
npm run revizie-autonomie -- --template
npm run revizie-autonomie -- --payload aprobare.json [keyId]
npm run revizie-autonomie -- --key-id public.pem
```

## 6. Jurnalul reviziilor de specialitate

| Data | Cine | Ce s-a revizuit | Concluzie |
|---|---|---|---|
| — | — | — | (nicio revizie externă consemnată încă; 0/25 cazuri aprobate) |
