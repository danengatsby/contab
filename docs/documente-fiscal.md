# Documente acceptate și aliniere fiscală

## Aliniere la ghidul profesional (ediția 2026)

- **Parametri fiscali 2026** (`src/fiscal.js`, tab „Ghid”): CAS 25%, CASS 10%, impozit 10%,
  CAM 2,25%, salariu minim 4.050 (S1) / 4.325 (S2, de la 1 iulie — **comutare automată după lună**,
  `salariuMinimLa()`), sumă neimpozabilă 300/200, TVA 21%/11%, micro 1%/3%, profit 16%,
  **dividende 16%** (Legea 141/2025, distribuiri din 2026). Cota TVA implicită este **21%**.
  **Facilitățile sectoriale IT/construcții/agro au fost eliminate** din ian. 2025 (OUG 156/2024) —
  câmpul „sector" pe angajat rămâne doar informativ, impozitarea e standard. Chiria plătită
  persoanelor fizice reține impozit 10% aplicat la **net (brut − 20% forfetar)**, art. 84 Cod fiscal;
  premiile au **600 lei neimpozabili pentru fiecare premiu** (art. 110 alin. (4)) — un premiu sub
  plafon nu se impozitează deloc. Regula stă într-un **singur loc** (`fiscal.retinereLaSursa`),
  citit atât de tipul de document, cât și de D205: cât timp erau două calcule, declarația raporta
  altă bază decât cea pe care se reținuse. Monografia trece prin **462** („creditori diverși"),
  deci cheltuiala se recunoaște **când e datorată**, nu la plată — contul de plată are și opțiunea
  „neplătită încă", care lasă soldul pe 462.
- **Concediul medical — primele 5 zile sunt CALENDARISTICE** (OUG 158/2005 art. 12), nu lucrătoare:
  indemnizația se cuvine doar pentru zilele lucrătoare din ele, iar cele două numărători diferă ori
  de câte ori intervalul prinde un weekend. Un concediu început **joi** are 3 zile lucrătoare în
  primele 5 calendaristice, nu 5 — formula veche muta sistematic cost de la FNUASS la firmă. Se
  cere **data începerii**; fără ea rămâne vechea aproximare, dar rândul e marcat ca aproximat.
  Sărbătorile legale nu sunt luate în calcul (nu există calendar de sărbători) — efectul merge în
  aceeași direcție, cel mult supraevaluează partea angajatorului.
- **Plafoanele în EURO se convertesc la cursul BNR**, nu la o valoare rotundă din setări: plafonul
  micro folosește cursul de la **31 decembrie al anului precedent** (ultimul publicat înainte, dacă
  ziua cade în weekend — chiar regula legală). La 5,0 în loc de ~5,08, plafonul de 100.000 EUR ieșea
  500.000 în loc de ~508.000 lei, iar o firmă cu 505.000 lei era declarată greșit ieșită din regim.
  Când cursul BNR lipsește se folosește valoarea din setări, **cu avertisment** — dar numai în
  preajma plafonului, unde alegerea chiar poate schimba încadrarea.
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
- **TVA specială D301 pentru neplătitori:** tipul `achizitie_tva_speciala_d301` cere explicit
  secțiunea oficială 1–5, valuta, cursul și cota. Baza intră în cost/stoc/imobilizare contra 401,
  iar TVA-ul nedeductibil intră în același cost contra 446. Profilul firmei păstrează separat codul
  special art. 317; acesta nu transformă firma în plătitoare normală de TVA. XML-ul D301 și D390
  sunt generate din același marcaj, iar referința D301 trece DUKIntegrator.
- **Tab „Ghid”:** parametri fiscali, glosar de termeni și întrebări frecvente.
- **Conturi analitice pe partener** (`src/analytic.js`, tab „Analitic”): detalierea conturilor
  de terți (401, 4111, 404, 419, 409…) pe analitice per partener (401.01, 401.02…), cu
  **sold inițial, rulaje și sold final**. Soldurile inițiale pe partener se introduc în
  același tab; aplicația verifică automat că suma lor concordă cu soldul inițial sintetic.
  Export PDF.
- **Registrul de evidență fiscală** (card în „Situații financiare”): trecerea de la rezultatul
  contabil la cel fiscal → impozit pe profit 16% vs. micro (aceeași bază și cotă ca D100); export PDF. Aplică **deductibilitatea
  parțială** (art. 25-28 Cod fiscal): amenzi/penalități (6581) și pierderi din creanțe (654)
  **nedeductibile 100%**. Fiecare rând arată baza × procent.

  **Ajustările pentru deprecierea creanțelor (6814) NU sunt un procent fix pe cont** — și tocmai
  aici a fost defectul: regula veche acorda 30% deducere pe *tot* contul, deși art. 26 alin. (1)
  lit. c) o dă numai creanțelor care îndeplinesc **cumulativ** trei condiții — peste **270 de zile**
  de la scadență, negarantate de altă persoană, datorate de o persoană neafiliată. Cum ajustarea
  contabilă se înregistrează mult mai devreme (aplicația o propune de la 90 de zile, ca judecată de
  depreciere), procentul orb deducea și acolo unde nu exista drept: **impozit subdeclarat**, vizibil
  abia la control. Astăzi partea deductibilă se calculează din **baza eligibilă**, marcată pe articol
  (`bazaArt26`, ca `auto50` și `lipsaNeimputabila`) — încadrarea nu se poate citi din conturi,
  fiindcă același cont poartă și ajustări care se califică, și ajustări care nu. **Lipsa marcajului
  dă bază zero, deci nedeductibilitate integrală**: „nu știu” nu cade în „se deduce”.

  Marcajul se pune printr-o **confirmare explicită** la înregistrare, nu automat: aplicația nu ține
  scadența creanțelor, deci măsoară vechimea de la *data documentului* și poate doar să propună
  candidați — o creanță de 280 de zile de la factură poate avea 250 de la scadență. Cele două
  condiții pe care aplicația le ține minte stau pe partener (`afiliat`, `creanteGarantate`) și scot
  partenerul din candidați, cu motivul afișat pe rând.

  Reluarea (7814) **oglindește proporția nedeductibilă a ajustării anului**, nu un procent fix; fără
  nicio ajustare înregistrată e integral neimpozabilă — altfel s-ar impozita o sumă care n-a fost
  niciodată scăzută. *Limită cunoscută:* proporția e cea a anului curent, deci o reluare din alt an
  decât cel al constituirii se oglindește cu proporția anului reluării.

  Regulile stau într-un **singur motor** ([`src/deductibilitate.js`](../src/deductibilitate.js)),
  citit deopotrivă de acest registru și de **nota contabilă 691 = 4411** și de **D101** — cât timp
  erau două tabele, registrul și declarația depusă raportau impozite diferite pe aceleași conturi.
  Cele două câmpuri de ajustare manuală din „Închideri” sunt **suprascrieri**: lăsate goale, sumele
  se calculează din conturi; un `0` tastat înseamnă „zero, exact”.
- **Provizioanele nu sunt toate nedeductibile.** Art. 26 alin. (1) lit. b) face deductibile
  provizioanele pentru **garanții de bună execuție acordate clienților**. Regula veche trata tot
  contul 6812 ca nedeductibil, deci o firmă de construcții — profilul căruia aplicația îi dedică un
  grup întreg de documente, cu garanții reținute și restituite — plătea impozit în plus: pe un
  provizion de 30.000 lei, **4.800 lei** la cota de 16%. Ca la 6814, încadrarea se citește din
  **contrapartidă**, nu din contul de cheltuială: `1512` = garanții (deductibil), restul 151x = nu.
  Planul a primit 1511–1518; implicitul monografiei generice e **1518** („Alte provizioane"), adică
  prudent — o alegere neatentă nu produce o deducere nemeritată.
  **Simetria merge în ambele sensuri** (art. 23 lit. d): reluarea unui provizion nedeductibil nu e
  venit impozabil, dar reluarea unuia **deductibil este**. Tratate la fel, provizionul de garanții
  ar fi dedus la constituire și niciodată impozitat la reluare — o deducere definitivă dintr-o
  operațiune care se anulează singură.
  *Limită neverificată automat, scrisă în nota rândului:* deducerea se acordă pentru bunurile
  livrate și lucrările executate **în cursul trimestrului**, deci cuantumul depinde de livrările
  perioadei. Nu se poate deriva din conturi, așa că nu se plafonează automat — un plafon inventat ar
  arăta ca o cifră verificată.
- **Ajustările pentru depreciere** (39x stocuri, 29x imobilizări) — urmarea contabilă a
  **inventarierii**. Când valoarea de inventar e sub cea contabilă, minusul nu se scoate din cont:
  se înregistrează o ajustare, reversibilă, care lasă valoarea de intrare neatinsă. Lipseau complet
  — nici conturi, nici monografii — deși `bilant.js`, `reporting.js`, `statements.js` și
  `impozitMicro.js` le scădeau deja pe prefix, adică rânduri care nu se puteau completa niciodată.
  Contul de ajustare se **derivă** din contul activului ([`src/ajustari.js`](../src/ajustari.js)),
  hartă explicită — aceeași sursă și pentru monografie, și pentru propunerea din registrul-inventar.
  Fiscal: **integral nedeductibile** (art. 26 alin. (1) le enumeră limitativ și nu le cuprinde), cu
  simetricul la reluare (venit neimpozabil, art. 23 lit. d).
  **Atenție la 6814:** e comun creanțelor *și* stocurilor, dar cele două se deduc diferit (30% din
  baza eligibilă, respectiv deloc). Separarea se face după **contrapartida** liniei (49x vs 39x), nu
  după rulajul contului — altfel reluarea unei ajustări de stoc, niciodată dedusă, ar fi impozitată.
- **Reziduul de rotunjire din bilanț nu mai e tăcut.** Formularul se raportează în lei întregi, iar
  după rotunjirea a zeci de rânduri identitatea F10_64 poate să nu mai țină exact; diferența se
  mută în rezultatul reportat, ca la orice întocmire de situații anuale. Mecanismul e necesar —
  fără el formularul e respins — dar n-avea **nici prag, nici glas**: înghițea la fel de tăcut și
  doi lei de rotunjire, și o eroare de mapare de sute de mii. Consecința e perfidă: un cont mapat
  greșit **nu produce niciodată un bilanț dezechilibrat** (plasa îl reechilibrează), ci un
  *rezultat reportat* greșit, pe care nu-l confruntă nimeni cu nimic. Astăzi reziduul se măsoară și
  se raportează (`bilant.verificaRezidual`, prag **100 lei** — generos față de rotunjire, strâns
  față de o eroare de mapare, care se măsoară mereu în sute); peste prag, `situatii()` întoarce un
  avertisment și generarea XML îl scrie în jurnalul de audit. **Nu blochează depunerea** — formularul
  tornă și e acceptat de ANAF; e o verificare a contabilului, fiindcă validatorul n-are cum s-o facă.
  Reziduul stă pe rezultat ca proprietate **neenumerabilă**, deci nu poate ajunge din greșeală
  într-un câmp de formular sau în XML-ul depus.
- **Registrul-inventar** (formular 14-1-2) are cele patru coloane cerute: element, valoare
  contabilă, **valoare de inventar**, **diferențe din evaluare** + cauze. Valoarea de inventar se
  introduce pe cont (colecția `inventarAnual`); restul se derivă. Elementele fără valoare introdusă
  rămân **neevaluate** (`null`), nu „evaluate la zero" — al doilea ar propune scoaterea din evidență
  a întregului sold. Deprecierile propun articolul de ajustare, cu contul luat din aceeași hartă.
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

## Livrări fără TVA colectat — unde intră în decont

| Operațiune | Tip de document | D300 | D390 | Pro-rata |
|---|---|---|---|---|
| Livrare intracomunitară de bunuri | `livrare_intracomunitara` | rd. 1 | cod L | numărător |
| Prestare intracomunitară de servicii | `prestare_servicii_intracomunitara` | rd. 3 | cod P | numărător |
| Livrare triunghiulară (art. 268 alin. (8)) | `livrare_triunghiulara` | rd. 3 | cod T | numărător |
| Livrare cu taxare inversă internă (art. 331) | `taxare_inversa_interna_livrare` | rd. 13 | — | numărător |
| **Export în afara UE** (art. 294 alin. (1)) | `export_extracomunitar` | **rd. 14** | — | numărător |

Toate au **drept de deducere**, deci ridică pro-rata, nu o coboară. Înregistrate ca vânzări cu cota
0 — singura variantă înainte de a exista tipurile proprii — cădeau la „fără drept" **și** lipseau
din decont: două greșeli care se compun.

**Achiziția** din operațiunea triunghiulară (`achizitie_triunghiulara`) nu produce taxare inversă:
măsura de simplificare o face neimpozabilă în România, deci un `4426 = 4427` ar colecta și ar deduce
o taxă nedatorată.

## Regimul special al marjei de profit (art. 312)

Pentru bunuri second-hand, opere de artă, obiecte de colecție și antichități cumpărate de la cine nu
a putut factura cu TVA. Baza impozabilă e **marja** (preț de vânzare − preț de cumpărare), iar TVA-ul
e **inclus** în ea: se extrage cu `cotă/(100+cotă)`, nu se adaugă peste. O marjă negativă dă bază
zero, nu creanță la buget. Achiziția nu deduce TVA — e chiar condiția regimului.

Registrul cerut de art. 312 alin. (13) se derivă din articole: `GET /api/registru-marja`.

**Limită cunoscută:** vânzările în regim de marjă **nu se generează ca e-Factura**. Factura nu are
voie să înscrie TVA separat (art. 312 alin. (11)), iar generatorul UBL exact asta ar face. Decizia e
scrisă explicit pe tip, cu motiv.

## Tipuri de documente acceptate

Vânzări (mărfuri, produse, servicii, bon Z, livrare intracomunitară de bunuri,
**prestare intracomunitară de servicii**), cumpărări (mărfuri, materii, utilități,
servicii, combustibil, imobilizări, achiziție intracomunitară de bunuri și
**de servicii**, ambele cu taxare inversă), trezorerie (încasări/plăți casă/bancă, viramente,
comisioane), salarii (stat de plată cu CAS/CASS/impozit/CAM, plata netă), amortizare și
**notă contabilă liberă** (orice `debit = credit`, pentru orice monografie).
