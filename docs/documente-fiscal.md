# Documente acceptate și aliniere fiscală

## Aliniere la ghidul profesional (ediția 2026)

- **Parametri fiscali 2026** (`src/fiscal.js`, tab „Ghid”): CAS 25%, CASS 10%, impozit 10%,
  CAM 2,25%, salariu minim 4.050 (S1) / 4.325 (S2, de la 1 iulie — **comutare automată după lună**,
  `salariuMinimLa()`), sumă neimpozabilă 300/200, TVA 21%/11%, micro 1%/3%, profit 16%,
  **dividende 16%** (Legea 141/2025, distribuiri din 2026). Cota TVA implicită este **21%**.
  **Facilitățile sectoriale IT/construcții/agro au fost eliminate** din ian. 2025 (OUG 156/2024) —
  câmpul „sector" pe angajat rămâne doar informativ, impozitarea e standard. Chiria plătită
  persoanelor fizice reține impozit 10% aplicat la **net (brut − 20% forfetar)**, art. 84 Cod fiscal.
- **Calcul automat al salariilor:** la „Stat de plata” introduci doar brutul (și opțional suma
  neimpozabilă); CAS/CASS/impozit/CAM se calculează automat (lași câmpurile goale).
- **Plan de conturi extins** la lista din ghid (secțiunea 17): 211, 231, 267, 2678, 2813, 280,
  331, 332, 106, 167, 1687, 4418, 457, 471, 472, 711, 712, 8031 etc. (108 conturi).
- **Tipuri de document din monografii:** avans încasat client (419) / avans plătit furnizor
  (409), plus **facturile de avans cu TVA** (art. 282: `4111 = 419 + 4427` la emitere,
  `409 + 4426 = 401` la primire) cu **regularizare la factura finală** (storno în roșu —
  419/409 se închid, iar jurnalul de TVA/D300 preia baza avansului și o scade la regularizare);
  construcții — lucrări în curs (332=712) și garanție de bună execuție (2678);
  HoReCa — intrare la preț de vânzare (371/378/4428) și vânzare amănunt cu descărcare;
  comerț intracomunitar — diferențe de curs (765/665); transport — combustibil cu TVA 50%,
  amortizare transport (2813), rovinietă (635=446).
- **Tab „Ghid”:** parametri fiscali, glosar de termeni și întrebări frecvente.
- **Conturi analitice pe partener** (`src/analytic.js`, tab „Analitic”): detalierea conturilor
  de terți (401, 4111, 404, 419, 409…) pe analitice per partener (401.01, 401.02…), cu
  **sold inițial, rulaje și sold final**. Soldurile inițiale pe partener se introduc în
  același tab; aplicația verifică automat că suma lor concordă cu soldul inițial sintetic.
  Export PDF.
- **Registrul de evidență fiscală** (card în „Situații financiare”): trecerea de la rezultatul
  contabil la cel fiscal → impozit pe profit 16% vs. micro (aceeași bază și cotă ca D100); export PDF. Aplică **deductibilitatea
  parțială** (art. 25-28 Cod fiscal): amenzi/penalități (6581) și pierderi din creanțe (654)
  **nedeductibile 100%**, ajustări pentru deprecierea creanțelor (6814) **nedeductibile 70%**
  (deductibil 30%), iar reluarea ajustărilor (7814) **neimpozabilă 70%** (simetric). Fiecare rând
  arată baza × procent. Regulile stau într-un **singur motor** ([`src/deductibilitate.js`](../src/deductibilitate.js)),
  citit deopotrivă de acest registru și de **nota contabilă 691 = 4411** și de **D101** — cât timp
  erau două tabele, registrul și declarația depusă raportau impozite diferite pe aceleași conturi.
  Cele două câmpuri de ajustare manuală din „Închideri” sunt **suprascrieri**: lăsate goale, sumele
  se calculează din conturi; un `0` tastat înseamnă „zero, exact”.
- **Rezerva legală e și dedusă, nu doar constituită** (art. 26(1)(a)): 5% din profitul contabil brut,
  până la 20% din capitalul **subscris și vărsat** (contul 1012, nu prefixul `101` — partea nevărsată
  nu contează). Deducerea nu se poate deriva din rulaj — rezerva se constituie prin repartizarea
  profitului (`129 = 1061`), nu printr-un cont de cheltuială — deci absența ei nu se vedea în nicio
  verificare de echilibru: firma constituia rezerva obligatoriu (art. 183 Legea 31/1990) și plătea
  16% pe ea. Se deduce **exact cât se postează** la repartizare.
- **Controlul casei — plafonul zilnic TOTAL** (`accounting.cashControl`): art. 3 alin. (1) lit. c)
  din Legea 70/2015 impune **două** limite simultane la plăți către persoane juridice — 5.000
  lei/persoană/zi **și** un total de 10.000 lei/zi. Se încalcă independent: trei plăți de 4.000 către
  furnizori diferiți respectă fiecare limita per persoană și îl depășesc pe cel total. Se aplică doar
  plăților; încasările au numai limita per persoană.
- **Lipsa neimputabilă la inventar** e marcată pe articol (bifă în `diferente_inventar`) și devine
  **nedeductibilă** la impozitul pe profit (art. 25(4)(c)). Încadrarea nu se poate citi din conturi —
  aceeași cheltuială, pe același cont, e deductibilă dacă lipsa a fost imputată sau asigurată — deci
  marcajul stă pe articol, ca la `auto50`. Eticheta câmpului de cheltuială indică `6588` pentru
  minusul neimputabil: amestecat în `607`, umflă costul mărfii vândute și strică marja.
- **Operațiuni care nu se puteau înregistra deloc, adăugate:** vânzarea unui mijloc fix
  (`461 = 7583` + TVA, cu scoaterea din evidență `281x = 21x` și valoarea rămasă pe `6583` — exista
  doar casarea); **cut-off furnizori** (`6xx = 408`, cu TVA **neexigibil** pe 4428 până la sosirea
  facturii, plus regularizarea `408 = 401` + `4426 = 4428`); **capitalul social** (subscriere
  `456 = 1011`, vărsare `5121 = 456` **și** `1011 = 1012`); reclasificarea creanțelor incerte
  (`4118 = 4111`); ajustarea TVA pentru lipsa neimputabilă (`635 = 4426`, art. 304).
  Conturile lipsă din plan au fost adăugate odată cu ele: `1011`, `1171`, `1174`, `4118`, `456`,
  `473`, `5191`, `604`, `6588`, `7583`.
- **Storno în roșu, o singură convenție** (`entriesService.stornoEntry`): nota de reversare păstrează
  conturile și **neagă suma**, ca tipurile `factura_storno_*`. Inversarea debit↔credit („în negru")
  lăsa soldurile corecte, dar dubla rulajele: o factură de 10.000 stornată raporta 10.000 pe ambele
  laturi ale contului de venit — activitate care nu a existat. Sumele negative sunt acceptate de
  validatoarele oficiale (referința `D406-storno` le verifică la fiecare rulare a porții).
- **D100 după regimul firmei** (`reporting.d100`): micro → obligația **620**; impozit pe profit →
  obligația **103** (cod bugetar 20470101), cu calculul trimestrial de la art. 41 — impozitul se
  determină **cumulat de la începutul anului**, iar pe declarație merge diferența față de
  trimestrele deja declarate. **Trimestrul IV nu se declară prin D100**: definitivarea se face prin
  D101, până pe 25 martie. Un trimestru pe pierdere duce cumulatul în jos; pe declarație merge 0
  (D100 nu primește sume negative), iar regularizarea e anuală.
- **Poziția de TVA reportată** (`accounting.vatCarryForward`): nota de închidere a lunii compensează
  soldul rămas din perioadele anterioare (**4423 = 4424**), iar decontul îl declară pe rândurile
  **35** (TVA de plată neachitată) și **38** (sumă negativă nerambursată). Ambele erau zero prin
  construcție: firma cu TVA de recuperat plătea integral TVA-ul lunii următoare, iar 4424 rămânea
  blocat ca activ — bilanțul arăta simultan creanță și datorie către același buget.
- **Impozitul micro** ([`src/impozitMicro.js`](../src/impozitMicro.js), sursă unică pentru D100 și
  pentru linia comparativă din registrul fiscal): baza e cea de la **art. 53**, nu totalul clasei 7 —
  se scad veniturile din provizioane și ajustări, producția de imobilizări, variația stocurilor de
  produse, subvențiile și diferențele de curs, se adaugă reducerile comerciale primite, iar în
  **ultimul trimestru** revine diferența favorabilă de curs cumulată pe an (art. 53 alin. 2 lit. b).
  Cota e **1% sau 3%** (art. 51): 3% peste pragul de 60.000 € **sau** pe codurile CAEN de
  IT/HoReCa/juridic/medical, indiferent de venituri; depășirea pragului comută cota **de la
  trimestrul depășirii** (alin. 4). Motivul cotei apare în raport, iar `?cota=` rămâne suprascriere.
  Ce nu se poate deduce din codul contului (despăgubirile de la asigurări stau pe 7581 împreună cu
  amenzile încasate) **rămâne în bază**, cu avertisment — o scădere ghicită ar micșora tăcut un
  impozit datorat.
- **Analitice și pe conturi non-partener** (trezorerie 5121/5311…, salarii 421): se detaliază
  după o etichetă liberă pe înregistrare (ex. „BCR”, „Ion Popescu”), nu după partener. Câmpul
  „Analitic” apare pe tipurile de trezorerie și salarii; soldul inițial analitic le acoperă pe toate.
- **Jurnal de bancă / Registru de casă** (tab „Bancă/Casă”): mișcările unui cont de trezorerie
  (5121/5311/5124/5314), cu sold curent (running balance), sold inițial și rulaje; export PDF.
- **Note explicative generate automat** (card în „Situații financiare”): 8 note derivate din
  bilanț/cont de profit și pierdere — active imobilizate, circulante, capitaluri, datorii,
  rezultat, repartizarea profitului (rezervă legală 5%), indicatori (lichiditate, solvabilitate,
  rentabilitate) și principiile contabile; export PDF.
- **Demo aliniat la exemplul integrat din ghid (secțiunea 11):** solduri inițiale (371, 5121,
  5311, 1012, 117, 401), reproducând balanța din ghid — SI 65.000, rulaje 76.392,50, SF
  84.327,50 — cu TVA de plată 840 și profit 687,50.

## Pro-rata TVA (art. 300) — regim mixt

**Procentul** se calculează pe operațiunile din **sfera TVA**, nu pe toată clasa 7: cesiunea
bunurilor de capital folosite în activitate și operațiunile financiare accesorii sunt excluse prin
art. 300 alin. (7), iar variația stocurilor, producția de imobilizări, subvențiile, reluările de
provizioane și diferențele de curs nici nu sunt operațiuni. Raportul afișează **ce a fost exclus și
de ce** — o pro-rata trebuie să poată fi apărată în fața unui inspector.

Operațiunile **scutite sau netaxate cu drept de deducere** (livrare intracomunitară, prestare
intracomunitară de servicii, livrare cu taxare inversă art. 331) intră în **numărător**, deși nu au
TVA colectat.

**Aplicarea** pe achiziții se face bifând „destinație mixtă" pe document. Bifa există pe toate
tipurile care generează TVA deductibilă, inclusiv pe cele cu **taxare inversă** (achiziții
intracomunitare de bunuri și servicii, art. 331, autofactură) — acolo taxa colectată rămâne
**integral** datorată și se reduce doar deducerea, diferența intrând în costul bunului
(art. 297 alin. (3)).

În **decont**, factura apare așa cum a fost emisă (bază și TVA integrale), iar partea nededusă
apare pe rândul **28 „taxa dedusă"**, care poate fi mai mic decât rândul 27 „taxa deductibilă".
La taxare inversă, perechea R5/R18 rămâne pe sumele integrale.

## Tipuri de documente acceptate

Vânzări (mărfuri, produse, servicii, bon Z, livrare intracomunitară de bunuri,
**prestare intracomunitară de servicii**), cumpărări (mărfuri, materii, utilități,
servicii, combustibil, imobilizări, achiziție intracomunitară de bunuri și
**de servicii**, ambele cu taxare inversă), trezorerie (încasări/plăți casă/bancă, viramente,
comisioane), salarii (stat de plată cu CAS/CASS/impozit/CAM, plata netă), amortizare și
**notă contabilă liberă** (orice `debit = credit`, pentru orice monografie).

