# Backlog sprint — iulie 2026 (runda a doua)

Backlog verificat față de codul real la 2026-07-28 (starea de pe `main`, commit b72c45f), în urma
unei analize complete pe două axe: informatică și contabilă. Fiecare gol de mai jos a fost
**confirmat în cod**, nu presupus — referințele trimit la linia care îl dovedește.

Estimare totală: **16–24 de zile** pentru toți cei 10 itemi. Sprintul recomandat = P0 (3 itemi,
7–9 zile), fiindcă acolo aplicația calculează astăzi cifre pe care un client le-ar semna.

Convenții de lucru (din CLAUDE.md): o ramură pe item, commit-uri tematice în română, merge în
`main` cu `--no-ff`. Orice item care atinge un generator fiscal trece prin
`sh scripts/poarta-fiscala.sh` înainte de merge. Orice item care atinge persistența rulează suita
HTTP pe ambele drivere (vezi rețeta `CONTAB_TEST_DRIVER` + `CONTAB_PG_URL` din CLAUDE.md).

---

## Starea măsurată la deschiderea backlogului (2026-07-28)

Măsurători datate, nu descrieri ale prezentului permanent:

| | |
|---|---|
| Cod | 26.900 linii, 599 commit-uri, 332 de rute |
| Teste | 3.488 de verificări verzi, 0 picate (1 suită sărită: store-pg, fără `CONTAB_PG_URL`) |
| Dependențe | 0 vulnerabilități (`npm audit`), 0 markere TODO/FIXME în cod |
| Producție | pm2 online, `/api/health` 1,8 ms, TLS valid până la 12 oct. 2026 |
| **Date reale în producție** | **56 de articole contabile, 4 firme, 674 de rânduri de audit** |

Ultimul rând ordonează tot ce urmează. Ingineria e cu două ordine de mărime înaintea utilizării,
deci marginalul pe infrastructură e mic, iar marginalul pe „ce face un cabinet să-și mute clienții
aici" e mare. De aceea P0 e contabil, nu informatic, iar multi-instanța rămâne nefăcută.

---

# P0 — corectitudine fiscală

Blochează orice client plătitor de impozit pe profit. Aplicația produce astăzi un „rezultat fiscal"
care poate fi greșit fără ca nimic să semnaleze.

## 1. Motor de plafoane de deductibilitate — ✅ ÎNCHIS 2026-07-28

**Estimare:** 3–4 zile · **Realizat:** ~1 zi · **Prioritate:** 1

> Livrat în `deductibilitate.js` (modul pur, două faze: ajustările care nu depind de impozit, apoi
> creditul care depinde de el). Parametrii în `fiscalConfig.js` cu `SURSE`. Legat în `registruFiscal`
> (rânduri noi cu bază + plafon, în UI și PDF) și în `profitTax` — unde `cheltNedeductibile` se
> **calculează** acum, rămânând suprascriabil manual. Reportul sponsorizării se persistă pe firmă în
> bucket-uri anuale (prescripția la 7 ani cere vechimea, un total unic n-ar putea fi prescris).
> Contul 6582 adăugat în plan; marcajul `auto50` se persistă acum pe articol — art. 25(3)(l) se
> calculează la final de an, când formularul din care s-a bifat nu mai există.
>
> **D101:** rândul `P43` și plafonul lui au fost dovedite prin sondaj pe validatorul oficial, nu
> ghicite — regula `V5: round((P41-P42)*20%) >= P43`, consemnată în jurnalul de validare.
>
> 36 de verificări noi în `test/run.js` (validate prin trei mutații deliberate: baza protocolului,
> min→max la credit, FIFO→LIFO la report) + 5 cazuri pentru revizor, `PLF-01..05`. Poarta fiscală
> verde pe toate cele 15 ieșiri.
>
> **Defalcarea pe P23..P33 — ✅ ÎNCHISĂ 2026-07-29.** Estimarea de mai jos („fiecare categorie cere
> propriul sondaj") s-a dovedit greșită ca metodă: validatorul **nu poate** confirma maparea, fiindcă
> regula R80 cere doar ca P34 să fie suma de la P23 la P33 — orice repartizare care torna trece. Deci
> sondajul n-ar fi ajutat oricât s-ar fi insistat. Sursa corectă e **formularul oficial OPANAF
> 206/2025** plus instrucțiunile lui de completare; sondajul a servit doar la aflarea aritmeticii
> (R80, R56, R65). Protocol → rd. 26, sponsorizare → rd. 27, dobânzi excedentare → rd. 31, social și
> auto rămân la rd. 33 (instrucțiunea rândului 33 le enumeră explicit), iar amortizarea ocupă **două**
> rânduri: contabilă la rd. 28, fiscală la rd. 11. Invariant fixat în teste: defalcarea nu mișcă
> P35/P40/P41/P52. Referință nouă `D101-defalcare` în poarta fiscală — exemplul obișnuit n-are
> cheltuieli cu plafon, deci calea nouă ar fi rămas neverificată. Detalii: `docs/validare-oficiala.md`.

### Descriere

Deductibilitatea e modelată astăzi ca **procent fix pe cont**: tabela `NEDEDUCTIBILE` din
[`src/reporting.js`](../src/reporting.js) (linia ~396) are 5 conturi, fiecare cu un `pct`. Lipsesc
exact regulile **cu plafon**, care sunt miezul impozitului pe profit românesc — verificat prin
căutare în tot `src/`:

| Regulă | Temei | Apariții în cod azi |
|---|---|---|
| Protocol (623) — 2% din profitul contabil ajustat | art. 25(3)(a) | **0** |
| Cheltuieli sociale (6458) — 5% din fondul de salarii | art. 25(3)(b) | **0** |
| Sponsorizare — credit fiscal min(0,75% CA, 20% impozit), report 7 ani | art. 25(4)(i) | **1**, o etichetă de checklist |
| Dobânzi / costuri excedentare ale îndatorării — 1 M EUR + 30% EBITDA | art. 40² | **0** |
| Auto 50% pe **cheltuială** (nu doar pe TVA) | art. 25(3)(l) | doar jumătatea de TVA |

Consecința directă: `profitTax()` din [`src/accounting.js`](../src/accounting.js) primește
`cheltNedeductibile` ca **număr tastat de om**, iar generatorul D101 din
[`src/xml.js`](../src/xml.js) (linia ~921) îl varsă nedetaliat în P33/P34 („toate nedeductibilele
la «alte cheltuieli»"). Registrul de evidență fiscală arată corect ca formă, dar nu calculează
ce trebuie calculat.

### Cerințe tehnice

- Modul nou `deductibilitate.js` în `src/`, **pur** (fără scrieri), pe modelul modulelor de domeniu:
  primește vederea scoped + anul, întoarce liniile de ajustare cu bază, plafon, sumă deductibilă,
  sumă nedeductibilă și temeiul legal per rând.
- Parametrii (2%, 5%, 0,75%, 20%, 30%, 1 M EUR) intră în [`src/fiscalConfig.js`](../src/fiscalConfig.js),
  datați și cu `SURSE`, ca orice cotă — nu se hardcodează în motor.
- Ordinea de aplicare contează și e parte din contract: protocolul se calculează pe profitul
  contabil **înainte** de impozitul pe profit și **inclusiv** cheltuiala de protocol; sponsorizarea
  e credit fiscal (se scade din impozit), nu cheltuială deductibilă.
- Reportul de 7 ani al sponsorizării neutilizate se **persistă** (nu se poate deduce din rulajul
  anului) — o colecție nouă sau un câmp pe `closings`, după modelul din CLAUDE.md.
- `registruFiscal()` și `profitTax()` consumă motorul; `cheltNedeductibile` rămâne acceptat ca
  suprascriere manuală (contract istoric conservat), dar valoarea implicită vine din calcul.
- D101 primește defalcarea reală pe rânduri, nu suma globală. **Trece prin poarta fiscală.**

### Acceptanță

- [x] Fiecare din cele 5 reguli are cel puțin un caz semnat în [`test/cazuri-aprobate.js`](../test/cazuri-aprobate.js)
      (amprentă pe temei + intrare + cifre), inclusiv un caz la limita plafonului și unul peste.
- [x] Sponsorizarea neutilizată se reportează corect peste 3 ani consecutivi, cu prescripția la 7.
- [x] `registruFiscal()` nu mai raportează zero nedeductibile pentru o firmă cu protocol și amenzi.
- [x] D101 generat rămâne „Validare fără erori" la validatorul oficial, cu creditul de sponsorizare.
- [x] `npm test` verde + `sh scripts/poarta-fiscala.sh` verde.

---

## 2. Amortizare fiscală separată de cea contabilă — ✅ ÎNCHIS 2026-07-28

**Estimare:** 2 zile · **Realizat:** ~2 ore · **Prioritate:** 2

> `metodaFiscala` / `durataFiscalaLuni` pe mijlocul fix, opționale. Motorul de amortizare e
> **refolosit**, nu duplicat: `fiscalView()` proiectează activul cu planul fiscal și `schedule()`
> rulează neatins pe el. Diferența intră în motorul de plafoane ca singura regulă care poate da
> nedeductibil **negativ** (deducere), iar mențiunea „fără diferență" e acum condiționată.
>
> **Abatere deliberată de la plan: nicio migrare de date.** Absența câmpurilor înseamnă „identic cu
> planul contabil", iar fallback-ul din `fiscalView()` o rezolvă fără să scrie nimic. O migrare care
> ar copia aceleași valori în fiecare rând ar fi amplificare de scriere pentru zero efect — și ar
> îngheța planul fiscal dacă metoda contabilă se schimbă ulterior, exact invers față de intenție.
>
> Partea contabilă a ajustării vine din **rulajul real al contului 6811**, nu din plan: registrul
> fiscal pornește de la ce s-a înregistrat efectiv. Diferența dintre plan și realitate e o problemă
> de contabilitate, nu una fiscală, și nu are voie să fie ascunsă într-o ajustare.
>
> 17 verificări noi (mutații: `fiscalView` inertă, semn inversat — ambele prinse) + cazul `PLF-06`.

### Descriere

Ipoteza „amortizarea fiscală = amortizarea contabilă" e **hardcodată și scrisă explicit** în
[`src/reporting.js`](../src/reporting.js) (linia ~433), care emite mențiunea „art. 28: amortizarea
fiscală = amortizarea contabilă […] — nicio diferență". [`src/assets.js`](../src/assets.js) ține o
singură metodă per mijloc fix. Orice client cu amortizare accelerată fiscal și liniară contabil
(cazul uzual la echipamente) primește un rezultat fiscal greșit, tăcut.

### Cerințe tehnice

- Al doilea plan pe fiecare mijloc fix: `metodaFiscala` + `durataFiscalaLuni`, implicit **egale** cu
  cele contabile (migrare aditivă, idempotentă, pe modelul pașilor versionați din
  [`src/migrations.js`](../src/migrations.js) — rulează și pe bază goală, și pe date migrate).
- Motorul de amortizare existent se refolosește pe ambele planuri; nu se duplică formulele.
- Diferența (contabilă − fiscală) intră **automat** ca ajustare în registrul de evidență fiscală și
  în motorul de la itemul 1 — în ambele sensuri (deducere suplimentară sau cheltuială nedeductibilă).
- Doar planul **contabil** postează 6811 = 281x. Planul fiscal e extracontabil, nu generează articole.
- Mențiunea din registru devine condiționată: „fără diferență" doar când chiar nu e.

### Acceptanță

- [x] Un mijloc fix cu accelerată fiscal / liniară contabil produce ajustare nenulă în anul 1 și
      ajustare de semn opus în anii următori, cu suma cumulată **zero** pe toată durata.
- [x] Bazele existente rămân neschimbate (fără migrare: planurile pornesc egale prin fallback).
- [x] Caz semnat în [`test/cazuri-aprobate.js`](../test/cazuri-aprobate.js) — `PLF-06`.
- [x] Poarta fiscală verde (atinge registrul fiscal și D101).

---

## 3. Declarații rectificative (D300 / D394 / D112) — ✅ ÎNCHIS 2026-07-28

**Estimare:** 2–3 zile · **Realizat:** ~2 ore · **Prioritate:** 3

> **Sondajul a infirmat premisa itemului.** Planul presupunea că fiecare declarație are un câmp de
> semnalizare de găsit. Adevărul, citit din validatoarele oficiale: doar **D112** are steag
> (`d_rec` + `tip_rec`, cu regula A3b — `tip_rec` nu poate fi 5); **D300** și **D394** nu au
> niciunul, rectificarea fiind o redepunere. Tabelul complet e în jurnalul de validare.
>
> Deci „rectificativă" e în primul rând stare a aplicației: istoric de depuneri cu ordinal, motiv,
> autor și sumele-cheie de la momentul depunerii — din care se calculează **diferența** față de
> depunerea anterioară. Perioada închisă nu blochează rectificativa (e scopul ei), dar cere motiv
> scris și intră în audit.
>
> Steagul D112 se **derivă din istoric**, nu se cere din interfață: dacă există deja o depunere pe
> perioadă, XML-ul următor e rectificativ prin definiție — o bifă manuală ar putea fi uitată și
> declarația ar pleca la ANAF ca inițială.
>
> Reparat pe parcurs un dezacord real: marcarea „depusă" din registru nu crea istoric, deci ruta de
> rectificativă nu găsea nicio depunere anterioară și refuza corecția. `set` seedează acum prima
> depunere; redepunerile trec prin ruta dedicată.
>
> 23 de verificări noi în `test/run.js` + 10 în `test/http.js` (mutații: istoric reinițializat,
> prima depunere marcată rectificativă, clamparea `tip_rec=5` scoasă — toate trei prinse).

### Descriere

Zero apariții pentru „rectificativ" în tot codul. Depunerea unei rectificative e muncă **lunară de
rutină** într-un cabinet, nu caz de colț: o factură primită târziu după depunerea decontului
înseamnă D300 rectificativ, iar o corecție de salariu înseamnă D112 rectificativ.

### Cerințe tehnice

- Câmpul exact de semnalizare per declarație **nu se ghicește**: se sondează validatorul oficial cu
  XML-uri minime și se citește regula din eroare — metoda documentată în
  [`docs/validare-oficiala.md`](validare-oficiala.md) și folosită deja pentru R65 / V7 / V8 / R84.
- Starea se ține pe cheia existentă (firmaId, tip, period) din colecția `declarations`: o
  rectificativă e o **depunere nouă** peste aceeași perioadă, cu ordinal, nu o suprascriere — se
  păstrează istoricul depunerilor și XML-ul fiecăreia.
- Perioada închisă nu blochează rectificativa (ăsta e scopul ei), dar cere **motiv scris**, pe
  modelul forțării închiderii din [`src/monthlyClose.js`](../src/monthlyClose.js) — și intră în audit.
- UI: în tabul de declarații, acțiune explicită „Depune rectificativă", cu diferența față de
  depunerea anterioară afișată înainte de confirmare.

### Acceptanță

- [x] Câte o rectificativă pentru D300, D394 și D112 trece la validatorul oficial („Validare fără
      erori"). Pentru D300/D394 rectificativa e XML-ul normal (nu există steag), dovedit prin sondaj.
- [x] Rectificativa peste o perioadă închisă cere motiv și îl consemnează în audit.
- [x] Istoricul depunerilor per perioadă e vizibil și nu se pierde la a doua rectificativă.
- [x] Cele trei declarații rămân în jurnalul din [`docs/validare-oficiala.md`](validare-oficiala.md),
      cu tabelul comparativ al mecanismelor.

---

# P1 — deblochează utilizarea zilnică

## 4. Feed curs valutar BNR — ✅ ÎNCHIS 2026-07-28

**Estimare:** 1–2 zile · **Realizat:** ~2 ore · **Prioritate:** 4

> `bnr.js`: parsare pură + fetch cu timeout/retry (tiparul `anafFetch`, cu prefix de log și knob-uri
> proprii). Cursurile stau într-o **colecție nouă** (`cursuriBnr`, o linie în `ARRAY_COLLS` — deci
> tabel creat idempotent pe ambele drivere, scriere incrementală per rând), nu în `settings`, care
> se rescrie integral la orice modificare.
>
> **Multiplicatorul e capcana reală:** BNR publică HUF/JPY/KRW/ISK la 100 de unități. Ignorarea
> atributului dă o eroare de exact 100× — tăcută și catastrofală pe o reevaluare. Se aplică la
> parsare, deci cursul stocat e mereu pentru *o* unitate.
>
> Regula zilelor nelucrătoare: ultimul curs publicat **înainte**, cu `exact:false` ca interfața să
> arate din ce zi s-a luat. Nu se extrapolează în viitor.
>
> Deblochează importul e-Factura în valută (`anafService` refuza direct non-RON): baza și TVA-ul se
> convertesc la cursul **datei facturii**, iar articolul primește `valutaInfo` ca să rămână
> reevaluabil. Buton „ia cursul BNR" în reevaluare, cu cursul rămas editabil.
>
> **Testele nu ies pe rețea** — și asta a cerut o corecție de metodă: serverul de test e un proces
> **copil**, deci stub-ul pe `global.fetch` din procesul de test n-avea niciun efect și prima
> versiune a testului a apelat bnr.ro **real**. Acum `test/http.js` pornește un fixture HTTP local
> și îi indică serverului-copil `CONTAB_BNR_URL_ZI`, exercitând drumul real de rețea.
>
> 22 de verificări noi în `test/run.js` + 12 în `test/http.js` (mutații: multiplicator ignorat,
> extrapolare în viitor, upsert care dublează ziua — toate trei prinse).

### Descriere

Nu există niciun feed de curs în aplicație. [`src/fxreval.js`](../src/fxreval.js) cere cursul de
închidere **tastat de utilizator**, iar [`src/anafService.js`](../src/anafService.js) (linia ~250)
refuză direct importul unei e-Facturi în altă monedă: „Importul automat suportă deocamdată doar RON."
Orice client cu furnizori în EUR e blocat pe ambele capete.

### Cerințe tehnice

- Modul nou `bnr.js` în `src/`: citește cursul oficial zilnic, cu **istoric** (cursul de la data
  documentului, nu cel de azi — o factură din martie se evaluează la cursul din martie).
- Orice apel extern trece prin tiparul existent `anafFetch` (timeout + retry doar pe GET), nu prin
  `fetch` gol; indisponibilitatea feed-ului **nu** blochează înregistrarea — cade pe cursul tastat.
- Cursurile se persistă local; o zi nelucrătoare folosește ultimul curs publicat (regula BNR).
- Deblochează importul e-Factura în valută: baza în valută + cursul zilei → lei.
- Job periodic prin `safeInterval` din [`src/jobs.js`](../src/jobs.js), nu un timer nou.

### Acceptanță

- [x] Reevaluarea lunară rulează fără curs tastat manual, cu cursul corect al datei de referință.
- [x] O e-Factură în EUR se importă și produce articolul contabil în lei.
- [x] Feed-ul căzut → `503` cu mesaj explicit, nu eroare; înregistrarea manuală rămâne posibilă.
- [x] Testele nu fac apeluri externe reale — prin **fixture HTTP local**, nu prin stub pe
      `global.fetch`: serverul de test e proces copil, iar stub-ul n-ar fi ajuns la el.

---

## 5. Export fișier de plăți (SEPA pain.001) — ✅ ÎNCHIS 2026-07-28

**Estimare:** 2 zile · **Realizat:** ~2 ore · **Prioritate:** 5

> `sepa.js` (pur): validare IBAN prin **mod-97** (ISO 13616), verificarea lotului care raportează
> *toate* problemele deodată, și generatorul `pain.001.001.03`. Rută `POST /xml/pain001` +
> `GET /api/plati/propuneri`, care compune lotul din scadențarul de furnizori sau din resturile de
> plată ale statului de salarii. IBAN/BIC adăugate pe partener, angajat și firmă.
>
> **Două decizii de fond:**
> - Fișierul **nu postează nimic** în contabilitate. Plata se înregistrează la apariția în extras.
>   Contabilizarea și la generare, și la import ar dubla plata — iar un fișier generat nu e o plată:
>   banca îl poate refuza. Invariantul e testat explicit (numărul de articole nu se schimbă).
> - `SvcLvl/SEPA` **doar pentru EUR**. Schema SEPA e prin definiție în euro; o plată internă în RON
>   marcată „SEPA" e o contradicție pe care unele bănci o resping, iar altele o tratează greșit tăcut.
>
> **Ce NU s-a putut face, și e important:** ieșirea **nu e validată față de schema oficială
> ISO 20022**. XSD-ul pain.001 nu e disponibil public la o adresă stabilă (patru surse încercate,
> toate 404). Spre deosebire de e-Transport, unde XSD-ul e versionat în repo, aici verificăm doar
> structura și bine-formarea. Prin regula proiectului, „n-am putut verifica" **nu** e „e bine":
> criteriul de acceptanță „acceptat de o bancă reală" **rămâne neîndeplinit** și e singurul lucru
> care poate confirma formatul.
>
> 26 de verificări noi în `test/run.js` + 11 în `test/http.js` (mutații: mod-97 scos, SEPA pe RON,
> escapare scoasă — toate trei prinse). Testul a prins și o eroare reală de pornire: ruta era
> înregistrată în `server.js` înaintea definiției lui `S`, ceea ce ar fi doborât producția la deploy.

### Descriere

Importul de extras bancar e complet — [`src/bank.js`](../src/bank.js) parsează CSV, MT940 și
CAMT.053. Drumul de întoarcere lipsește: lotul de plăți către furnizori și salariile nete, de urcat
în internet banking. Astăzi contabilul le tastează una câte una în aplicația băncii.

### Cerințe tehnice

- Generator `pain.001` (SEPA Credit Transfer) dintr-o selecție de facturi furnizor scadente și/sau
  din restul de plată al statului de salarii.
- Escapare XML prin `esc()` din [`src/xml.js`](../src/xml.js) — denumirile de partener vin din surse
  externe (e-Factura/SPV), deci contextul de ieșire e cel din secțiunea „Escapare" din CLAUDE.md.
- Fișierul generat **nu** postează nimic în contabilitate: plata se înregistrează la confirmarea din
  extras, prin fluxul existent de reconciliere. Altfel s-ar dubla.
- Export plafonat prin limita de exporturi mari existentă (`CONTAB_RATE_EXPORT`).
- Validare împotriva schemei ISO 20022 înainte de livrare, pe modelul XSD-ului e-Transport
  versionat în repo.

### Acceptanță

- [ ] **NEÎNDEPLINIT** — fișierul generat acceptat de cel puțin o bancă reală (probă documentată).
      Nu poate fi verificat din cod: cere o încărcare reală în internet banking. **Singurul lucru
      care confirmă formatul** — până atunci, tratează exportul ca nedovedit.
- [x] IBAN invalid sau lipsă → refuz cu mesaj clar (toate problemele deodată), înainte de generare.
- [x] Generarea nu creează articole contabile (verificat prin test: numărul de articole e neschimbat).

---

## 6. Importator de migrare de la software-ul existent — ✅ FUNCȚIONAL 2026-08-13 (preset real încă în așteptare)

**Estimare:** 3–5 zile · **Realizat:** ~2 ore · **Prioritate:** 6

> `migrare.js` (pur) + `routes/migrare.js`: încarcă balanța de verificare (CSV/XLS/XLSX/DBF),
> **detectează antetul** (exporturile au 2–5 rânduri de titlu înainte de tabel), mapează coloanele
> pe heuristici RO (`SID`/`SFC`/„Sold final debitor"…), construiește **previzualizarea** și abia
> apoi, la confirmare, scrie.
>
> **Regula de aur e verificată de două ori**, în previzualizare *și* pe scriere. A doua nu e
> redundantă: între previzualizare și import, corpul cererii poate fi orice — garda trebuie să stea
> pe scriere. Harta completă se construiește înainte de a atinge baza, deci un rând invalid lasă
> refuzul curat, fără date parțiale. Mutația care scoate garda din rută e prinsă separat.
>
> **Poartă anti-drift nouă:** parsarea sumelor există acum în două implementări — `public/plan.js`
> (editorul din interfață) și `src/migrare.js` (serverul). Nu pot partaja cod (modul ES în browser
> vs CommonJS pe server), așa că `test/frontend.mjs` le compară pe un corpus de tokenuri ambigue.
> Poarta **și-a dovedit valoarea imediat**: a prins o divergență reală la prima rulare — serverul
> returna `0` la ambiguitate, frontend-ul o valoare provizorie.
>
> 30 de verificări noi în `test/run.js` + 17 în `test/http.js` + poarta din `test/frontend.mjs`.
>
> **CE NU E FĂCUT, deliberat:** niciun format specific de furnizor (SAGA/WinMentor/Ciel). Traseul
> generic acoperă orice export tabelar cu mapare asistată, dar backlogul cerea „cel puțin un format
> concret, ales după ce întrebăm un cabinet ce folosește" — iar acea întrebare nu a fost pusă. Un
> preset de furnizor se adaugă după ce există un export real și acordul cabinetului asupra
> coloanelor; nu inventăm un format comercial din presupuneri.
>
> **Mapările reutilizabile — ✅ ÎNCHIS 2026-08-13.** Ecranul folosește acum traseul serverului
> pentru previzualizarea CSV/XLS/XLSX/DBF (înainte folosea încă parserul local simplificat, deși
> API-ul avansat exista). Utilizatorul poate corecta rolul fiecărei coloane, salva maximum 20 de
> formate și refolosi unul la următorul client. Presetul păstrează **numele anteturilor**, nu
> indicii: dacă programul reordonează coloanele, ele sunt regăsite semantic; un match parțial este
> refuzat, nu aplicat aproximativ. Preseturile sunt izolate per utilizator, deci formatul unui
> contabil nu este expus colaboratorilor firmei. Dovedit pe mapare reordonată în modul, HTTP și E2E.
>
> **Pachetul auxiliar unificat — ✅ ÎNCHIS 2026-08-13.** În același ecran se pot încărca partenerii,
> mijloacele fixe și stocul inițial, împreună cu balanța previzualizată. `migrationAux.js` parsează
> și validează toate componentele înainte de orice mutație; importul repetă validarea, verifică
> perioada stocului, reconciliază fiecare sold 3xx cu pozițiile cantitativ-valorice și face o
> singură salvare. O eroare în ultimul fișier nu lasă primele componente scrise. Ținta este strict
> firma activă, suprascrierea fiecărei colecții selectate cere confirmare, iar alte firme rămân
> neatinse. Acoperit prin teste pure, HTTP și browser izolat.

### Descriere

**Cel mai bun raport valoare/efort din toată lista.** Se pot importa astăzi parteneri, produse, plan
de conturi, solduri inițiale și extras bancar — dar fiecare separat, dintr-un fișier pregătit manual.
Nu există o cale de migrare de la programul pe care cabinetul îl folosește deja. Asta e obiecția
numărul unu la schimbarea furnizorului, și e de produs, nu de tehnologie: nimeni nu retastează
soldurile a 40 de clienți.

### Cerințe tehnice

- Un flux unic „Preia o firmă din alt program": balanță de verificare + parteneri + mijloace fixe +
  stocuri, într-o singură trecere, cu previzualizare și raport de erori **înainte** de scriere.
- Parserul de sume există deja și e bun — convenția separatorului dedusă din fișier, cu întrebare la
  ambiguitate (`public/plan.js`). Se refolosește, nu se rescrie.
- Regula de aur a importului: **balanța trebuie să iasă echilibrată**, altfel importul se refuză
  întreg (tranzacțional), nu parțial.
- Cel puțin un format concret de la un furnizor real, ales după ce întrebăm un cabinet ce folosește.
  Formatele necunoscute cad pe traseul generic (CSV/XLS cu mapare de coloane asistată).
- Autorizarea trece prin `reqFirma()` — importul scrie într-o firmă explicită, niciodată în
  `firmaActiva` prin fallback.

### Acceptanță

- [x] Balanța se preia cap-coadă și soldurile de deschidere ies identice cu fișierul sursă
      (verificat prin test HTTP, pe o firmă proprie). **Pe o firmă reală, nu e încă probat.**
- [x] Un fișier corupt sau dezechilibrat nu lasă date parțiale în bază (garda e pe scriere, nu doar
      pe previzualizare; mutația care o scoate e prinsă).
- [x] Maparea de coloane se salvează per utilizator și se reutilizează la următorul client din
      același program, inclusiv când ordinea coloanelor se schimbă.

---

## D301 — decont special TVA — ✅ ÎNCHIS 2026-08-13

Tip de document propriu pentru firme neplătitoare, cu TVA nedeductibilă inclusă în cost (`446`),
profil art. 317, raport lunar, calendar/registru, D390 pentru operațiunile UE și XML D301. Cazul
4.1 este repetat în secțiunea-total 4 exact cum cere regula R32 a validatorului oficial. Referința
generată trece DUKIntegrator și intră în poarta fiscală de release.

## D311 — TVA colectată cu codul normal anulat — ✅ ÎNCHIS 2026-08-13

Profil explicit pentru anularea/reînregistrarea codului TVA, tip de operațiune cu categoriile
11/21/41/61, monografii fără conturile 4426/4427, raport lunar, calendar, registru și XML pentru
ambele scheme mutual exclusive ale formularului. Referințele inițială, rectificativă și secțiunea V
după reînregistrare trec validatorul oficial D311 J2.0.0.

## D307 — ajustări/corecții/regularizări TVA — ✅ ÎNCHIS 2026-08-13

Tip de document propriu pentru transfer de active (`A`), leasing (`L`) și ajustări după anularea
codului TVA (`C`), cu monografii pe 446, raport agregat pe tip+CUI, calendar/registru și XML
inițial/rectificativ. Referințele includ TVA negativă pe C și trec validatorul oficial D307 J1.1.0.

## D107 — beneficiarii sponsorizărilor/mecenatului/burselor private — ✅ ÎNCHIS 2026-08-13

Implementare completă pentru plătitorii de impozit pe profit: document contabil 6582, raport anual
pe beneficiar, report FIFO persistent între ani, integrare în calendar/registru și XML inițial sau
rectificativ. Referințele `D107` și `D107-rect` trec DUKIntegrator J2.0.0.

# P2 — infrastructură, pe semnal real

## 7. Offsite pe stocare obiect, criptat — ✅ ÎNCHIS 2026-07-28 (RTO nemăsurat)

**Estimare:** 1 zi · **Realizat:** ~1,5 ore · **Prioritate:** 7

> **Analiza inițială a fost incompletă aici.** Criptarea și o cale `rclone` existau deja în
> `scripts/backup.js` — dar nedocumentate, nefolosite în producție, iar `rclone` **nu e instalat pe
> server**, deci acea cale ar fi eșuat la prima folosire. O dependență externă nedeclarată, într-un
> drum care rulează doar noaptea, e o cale moartă care pare vie.
>
> **Defectul de fond, reparat:** criptarea cădea **deschis**. Dacă `openssl` eșua, arhiva pleca
> necriptată cu un simplu avertisment în log — adică exact când ceva nu era în regulă, datele
> fiscale plecau în clar. Acum e fail-closed: eșecul criptării oprește copia offsite. În plus,
> arhiva criptată se **verifică round-trip** (se descifrează și se compară amprenta) *înainte* de
> urcare — o arhivă criptată care nu se descifrează e o arhivă pierdută, iar asta s-ar afla abia
> la dezastru.
>
> `offsite.js`: semnare **AWS SigV4 nativă**, fără dependențe și fără `rclone`; merge pe orice
> S3-compatibil. Urcarea se verifică descărcând obiectul înapoi și comparând amprenta — o urcare
> care a truncat fișierul arată identic în log cu una bună.
>
> Formatul de criptare rămâne cel `openssl`, deliberat: restaurarea de dezastru trebuie să fie
> posibilă cu unelte de pe orice mașină, fără aplicație și fără Node. Un format propriu ar lega
> recuperarea de codul tocmai pierdut.
>
> 18 verificări noi. Vectorul SigV4 din teste e derivat **independent cu openssl**, nu memorat —
> prima încercare cu o valoare „știută" nu s-a potrivit, iar codul s-a dovedit corect prin
> confruntare cu a doua implementare, nu ajustat după așteptare.

### Descriere

Backup-ul zilnic funcționează și are **două** drill-uri de restaurare (graf + restaurare nativă pg) —
partea grea e făcută. Dar offsite-ul e **e-mail către o adresă Gmail**
([`scripts/backup.js`](../scripts/backup.js), cron 03:30). Merge la 0,1 MB. Se rupe la dimensiune și
trece date fiscale de client printr-o cutie poștală terță — inconsecvent cu DPA-ul comis în b72c45f.

### Cerințe tehnice

- Destinație S3-compatibilă (Backblaze B2 / Hetzner Storage Box), arhivă **criptată înainte de
  urcare**, cu retenție și versionare.
- E-mailul rămâne **notificare**, nu transport de date.
- Variabilele noi de mediu urmează prefixul `CONTAB_` existent; documentate în ghidul de rulare în
  **același commit** (poarta de documentație verifică asta).
- RTO/RPO scrise explicit în documentație, cu procedura de restaurare pas cu pas.
- Drill-ul de restaurare existent rulează pe arhiva **descărcată din offsite**, nu doar pe cea locală
  — altfel verifică ce n-a plecat nicăieri.

### Acceptanță

- [x] **ÎNDEPLINIT PARȚIAL 2026-07-29** — RTO e acum **măsurat, nu estimat**: `npm run rto-drill`
      restaurează arhiva reală într-un PostgreSQL efemer, pornește aplicația și verifică datele,
      cronometrând fiecare etapă. **~1,4 s** de la arhivă în mână la serviciu verificat (72 KB,
      4 firme / 58 articole). Rămâne neinclus, deliberat, pasul de **obținere** a arhivei — azi e
      un atașament de e-mail, deci manual; un total care l-ar înghiți tăcut ar fi ficțiune.
      Trei constatări din drill, toate confirmate pe server la aceeași dată:
      1. **drill-ul de restaurare nativă era PICAT** sub cron („no PostgreSQL user name specified"):
         `pg` deduce rolul din `process.env.USER`, pe care cron nu-l setează, iar `psql` nu are
         problema — deci defectul apărea *numai* în producție și orice probă manuală îl rata. Reparat
         (`localPgConfig` în `storePg.js`, importat de drill), cu test de regresie fără `USER` în mediu;
      2. **copia offsite pleacă NECRIPTATĂ**: `CONTAB_BACKUP_KEY` și toate `CONTAB_OFFSITE_*` sunt
         absente pe server, deci calea criptată pe stocare obiect construită la acest item **nu e
         activă** — transportul real e tot e-mailul, cu date fiscale în clar. Codul e gata; lipsește
         doar configurarea. **Criteriul de fond al itemului rămâne deci neatins în producție**;
      3. **runbook-ul descria o instalare care nu e în funcțiune** (descarcă din bucket, decriptează)
         — corectat în `docs/rulare.md`, cu avertisment despre starea reală.
- [x] Arhiva e ilizibilă fără cheie — verificat efectiv: textul nu apare în cifrat, cheia greșită
      eșuează, round-trip-ul cu cheia bună e identic.
- [x] Eșecul criptării **oprește** copia offsite (fail-closed); eșecul urcării se raportează și
      lasă `exitCode=1`, deci se vede în logul cron și în raportul zilnic.

---

## 8. Limitare de debit la nivel nginx — ✅ ÎNCHIS 2026-07-28

**Estimare:** 2 ore · **Realizat:** ~30 min · **Prioritate:** 8

> `limit_req_zone` + `limit_req burst=20 nodelay` pe căile de autentificare, 10r/min per IP.
> **Măsurat pe un val de 40 de cereri:** 8 × 401 (aplicația: parolă greșită), 13 × 429
> (anti-brute-force propriu), **19 × 503 tăiate de nginx fără să atingă Node**. Stratificarea e
> exact cea dorită: nginx aruncă surplusul, aplicația rămâne autoritatea pe reguli.
>
> Reparat pe parcurs: prima variantă limita `/api/reset-password`, **rută care nu există** — cea
> reală e `/api/reset/accept`. Un `location` care nu se potrivește dă o falsă senzație de protecție,
> deci am verificat numele față de `authRoutes.js` înainte de reload.
>
> `nginx-contab.conf` din repo driftase față de fișierul viu (certbot îl modifică direct); l-am
> resincronizat și am scris procedura în ghid, ca driftul să nu mai fie tăcut.

### Descriere

Tot throttling-ul e în Node (plafon general de API, login anti-brute-force, upload, exporturi) și e
bine făcut — dar traficul unui atacator costă oricum o tură de event loop pe un proces **singur**.
`nginx-contab.conf` nu are nicio directivă `limit_req`.

### Cerințe tehnice

- `limit_req` pe `/api/login`, `/api/register` și calea de resetare a parolei, calibrat **peste**
  plafoanele din aplicație (nginx taie abuzul, aplicația rămâne autoritatea pe reguli).
- Plafoanele din aplicație rămân neatinse — sunt apărarea corectă, nginx e doar prima plasă.
- Configurația nginx nu e în repo azi; dacă intră, intră cu tot cu notă în ghidul de rulare.

### Acceptanță

- [x] Un val de cereri pe `/api/login` primește 503 de la nginx fără să atingă Node (măsurat: 19/40).
- [x] Un utilizator normal nu vede nicio diferență — căile normale rămân neplafonate, iar burst-ul
      de 20 acoperă și o greșeală repetată de parolă.

---

## 9. Pas de build minimal pentru frontend — ⚠️ RESTRÂNS după măsurare, 2026-07-28

**Estimare:** 2–3 zile · **Realizat:** HTTP/2 (~15 min). Restul: **NEFĂCUT, deliberat.**

> **Măsurătoarea contrazice premisa itemului — și premisa era a mea.** Analiza inițială cita
> `index.html` la 162 KB și 464 KB de JS: cifre **necomprimate**. nginx are `gzip on` de mult, iar
> transferul real e:
>
> | | Pe disc | Transferat |
> |---|---|---|
> | `index.html` | 163 KB | **41 KB** |
> | `styles.css` | 62 KB | **16 KB** |
> | JS (25 fișiere) | 464 KB | **135 KB** |
> | **Total prima vizită** | | **193 KB, 27 de cereri** |
>
> 193 KB e o primă încărcare rezonabilă. Problema reală nu era dimensiunea, ci că serverul rula
> **HTTP/1.1**: 27 de cereri se serializează în valuri de câte ~6 conexiuni. Asta s-a reparat cu
> **o linie** (`http2 on`), verificat: răspunsurile vin acum pe HTTP/2, multiplexate.
>
> **Ce NU se mai face, și de ce.** Am măsurat câștigul rămas în loc să-l presupun:
> - **minificarea** JS-ului economisește **20 KB din 135 (15%)** — gzip comprimă deja bine
>   spațiile și comentariile. În schimb, comentariile din acest cod explică *de ce*, iar
>   pierderea lor face depanarea în producție mai grea decât merită 20 KB;
> - **spargerea `index.html`** ar salva ~26 KB, cu preț mare: pas de build, schimbare a ceea ce se
>   servește, și risc pe un frontend **viu** — `public/` e servit direct din working tree.
>
> ~45 KB, o singură dată (restul e din cache), contra unui pas de build care ar trebui întreținut.
> La 4 firme, nu se justifică. Aceeași critică pe care am adus-o căii `rclone` — cod care pare viu
> dar nu e folosit — s-ar aplica unui build pe care nimeni nu-l rulează.
>
> **Semnalul care redeschide itemul:** o primă încărcare peste ~400 KB comprimat, sau `index.html`
> depășind ~60 KB transferați. Atunci spargerea pe fragmente devine rentabilă.

### Descriere

[`public/index.html`](../public/index.html) e un monolit de **162 KB / 2.171 de linii**: markup-ul
tuturor taburilor pleacă la fiecare utilizator, la fiecare încărcare, plus 464 KB de JS neminificat.
Decizia „fără framework" e bună și rămâne; „fără niciun pas de build" e altceva.

### Cerințe tehnice

- Spargerea `index.html` pe taburi, încărcate la cerere — **nu** un framework, doar fragmente.
- Minificare + hash în numele fișierelor pentru cache; service worker-ul din `public/sw.js` e deja
  network-first pe shell, deci actualizările rămân instant.
- **Atenție** (memorie de proiect): `public/` e servit direct din working tree, deci orice fișier
  scris acolo e instant public. Pasul de build trebuie să scrie într-un director de ieșire, nu peste
  sursă, iar tranziția să nu lase artefacte intermediare servite.
- `test/frontend.mjs` importă module din `public/` printr-o oglindă în /tmp — pasul de build nu are
  voie să rupă acel contract.

### Acceptanță

- [x] Prima încărcare **măsurată**: 193 KB comprimat / 27 de cereri; HTTP/1.1 → HTTP/2 elimină
      serializarea cererilor. Cifrele înainte/după sunt în tabelul de mai sus.
- [x] `npm test` verde; `public/` neatins, deci aserțiunile de frontend rămân valabile.
- [x] Niciun artefact de build — **fiindcă nu există pas de build**, prin decizie măsurată.

---

## 10. Multi-instanță reală — NEÎNCEPUT, deliberat

**Prioritate:** ultima, și doar pe semnal real

Aplicația rulează pe **o singură instanță, pe o singură mașină**: pm2 în fork mode, un proces Node,
graful integral în RAM. Fencing-ul `dbEpoch` (pasul 7 din [`docs/scalare-crestere.md`](scalare-crestere.md))
**protejează** împotriva a doi scriitori, dar nu **permite** multi-instanță. Nu există failover.

Ăsta e cel mai mare risc structural al aplicației — și totuși **nu se face acum**. La 56 de articole
contabile în producție, ar rezolva o problemă pe care nu o ai, cu costul de a nu rezolva niciuna
dintre cele opt de mai sus, care sunt reale astăzi.

Pașii sunt deja scriși în ADR și rămân valabili: citiri per-cerere generalizate, apoi hidratare lazy.
**Semnalul care declanșează itemul:** `firmeLoad` sau RSS-ul urcând constant spre plafonul pm2, ori
primul client care cere disponibilitate contractuală. Nu înainte.

Tot din același motiv rămân nefăcute: normalizarea relațională suplimentară și un Dockerfile de
producție (producția rulează pe pm2 pe acest server, decizie deja consemnată).

---

## Cele trei rămase deschise — ce s-a putut avansa (2026-07-28)

Niciunul nu se poate **închide** din cod: cer o semnătură de expert, o bancă reală, respectiv
credențiale de stocare. Ce s-a făcut e să scadă cât rămâne de făcut de om.

**1. Cazuri fiscale nerevizuite → decizia devine o alegere între cifre.** La art. 40², ambele
citiri sunt acum **calculate**, nu descrise: `alternativa.cumulativ` (8.970.000 nedeductibil) și
`alternativa.max` (13.970.000) apar amândouă în rezultat, iar comutarea se face cu
`art402Interpretare`, fără modificare de cod. Cazul `PLF-05` le pune pe amândouă în fața
revizorului. **Rămâne:** semnătura, pe toate cele 24.

**2. Export de plăți nedovedit → găsit și reparat un defect care ar fi lovit la prima folosire.**
Setul de caractere SEPA (EPC) **nu permite diacritice**, iar denumirile de parteneri vin din
e-Factura, deci conțin `Ș`, `Ț`, `ă`. Generatorul le emitea ca atare: banca ori respinge fișierul,
ori stâlcește numele — și plata pleacă spre un beneficiar scris altfel decât în contract. Acum se
transliterează (`ȚARA`→`TARA`, `&`→`+`, en-dash→cratimă), cu poartă care verifică fiecare câmp de
text. **Rămâne:** proba la o bancă reală — dar un motiv probabil de respingere a dispărut.

**3. RTO nemăsurat → partea locală e acum măsurată.** Pe arhiva reală de producție: decriptare
0,063 s + dezarhivare 0,012 s = **0,075 s**, round-trip identic. Deci criptografia nu e în drumul
critic. **Rămâne:** descărcarea din offsite și timpul operatorului, care domină — și cer credențiale.

**Cinci porți întărite + un defect real de securitate — toate din aceeași clasă.**

Tiparul e mereu acelaşi: **o listă scrisă de mână care descrie realitatea la momentul scrierii și
driftează tăcut după.** Căutarea sistematică a clasei, nu a instanței, a produs:

| Poartă | Ce avea | Ce are acum |
|---|---|---|
| Perimetru fiscal | listă manuală de generatoare | **închidere tranzitivă** (21 → 28 de căi) |
| Colecții serializate | listă manuală de nume | derivată din **`store.ARRAY_COLLS`** |
| Prefixe de rută | *niciuna* | invariant pe toate rutele |
| Documente verificate | listă manuală | derivată **de pe disc** |
| Allowlist public | *niciuna* | fără orfani + fără creștere tăcută |

**Defectul de securitate (`uploadGuard` + `bootstrap`).** Un fișier **fără extensie** trecea de
*ambele* straturi de protecție: `fileFilter` scurtcircuita pe `ext &&`, iar `contentMatches` cădea
pe ramura containerelor și întorcea `true`. Multer îl salvează ca **`.pdf`**
(`path.extname(...) || '.pdf'`), deci octeți arbitrari ajungeau la extractorul PDF și la API-ul AI
ca și cum ar fi fost un PDF valid — exact ce garda există să prevină.

**Nu e o cale de XSS stocat** — fișierele se servesc cu `attachment` + `octet-stream`, iar extensia
forțată e `.pdf`. Dar e o gaură într-un strat a cărui întreagă rațiune e să reziste când calea de
servire se schimbă. Reparat fail-closed, în ambele straturi: lipsa extensiei e „necunoscut", nu
„permis".



Fiecare a fost probată cu o încălcare deliberată: perimetrul a găsit iterativ ultimele două module,
poarta de colecții a prins `res.json(db.get().cursuriBnr)`, iar cea de prefixe a prins
`POST /export/pain001`. O poartă care nu poate pica nu dovedește nimic.

**Descoperire colaterală, mai gravă decât cele trei:** poarta fiscală avea **găuri de perimetru**.
`CAI_FISCALE` lista generatoarele, dar nu și modulele care le *alimentează*: `assets.js`,
`statements.js`, `chartOfAccounts.js`, `matching.js` și încă trei lipseau. Când s-a livrat
amortizarea fiscală (P0-2), poarta a rulat **doar fiindcă același commit atingea și `reporting.js`**
— o schimbare izolată pe amortizare ar fi sărit-o complet. Perimetrul e acum **închis tranzitiv**
(21 → 28 de căi) și există un test care pică dacă un modul cerut de unul din perimetru rămâne pe
dinafară. Testul a găsit iterativ ultimele două lipsuri, nu eu.

---

## Sprintul anterior — iulie 2026, runda întâi (ÎNCHIS 5/5)

Închis integral pe 2026-07-16, într-o singură zi (estimare inițială: 10–15 zile). Detaliul complet,
cu cerințe și acceptanță per item, e în istoricul git al acestui fișier — ultima versiune a
sprintului închis e la commit `d26b94b` (`git show d26b94b:docs/backlog-sprint.md`).

1. **Refactorizare rute → servicii** (subsetul cu scrieri) — 7 servicii extrase, câte o ramură fiecare.
2. **Protecție upload: validare de conținut + rate limit** — magic bytes + plafoane per utilizator.
3. **Wizard de primă autentificare** — overlay derivat din date reale, cu „mai târziu" persistat pe cont.
4. **Loguri de business: upload + extragere AI** — audit `document.upload` + contoare AI în metrici.
5. **Documentare API / contracte** — [`docs/api.md`](api.md), fără OpenAPI (decizie explicită).

Itemii care s-au dovedit **deja implementați** la verificarea de atunci și nu trebuie să reapară la
planificare: dashboard KPI, CI/CD, rate limit pe autentificare, limite de upload, observabilitate de
infrastructură, import plan de conturi (planul RO e built-in în
[`src/chartOfAccounts.js`](../src/chartOfAccounts.js)).
