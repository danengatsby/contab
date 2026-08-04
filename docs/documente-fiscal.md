# Documente acceptate și aliniere fiscală

## Aliniere la ghidul profesional (ediția 2026)

- **Parametri fiscali 2026** (`src/fiscal.js`, tab „Ghid”): CAS 25%, CASS 10%, impozit 10%,
  CAM 2,25%, salariu minim 4.050 (S1) / 4.325 (S2, de la 1 iulie — **comutare automată după lună**,
  `salariuMinimLa()`), sumă neimpozabilă 300/200, TVA 21%/11%, micro 1%, profit 16%,
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
  contabil la cel fiscal → impozit pe profit 16% vs. micro 1%; export PDF. Aplică **deductibilitatea
  parțială** (art. 25-28 Cod fiscal): amenzi/penalități (6581) și pierderi din creanțe (654)
  **nedeductibile 100%**, ajustări pentru deprecierea creanțelor (6814) **nedeductibile 70%**
  (deductibil 30%), iar reluarea ajustărilor (7814) **neimpozabilă 70%** (simetric). Fiecare rând
  arată baza × procent. Regulile stau într-un **singur motor** ([`src/deductibilitate.js`](../src/deductibilitate.js)),
  citit deopotrivă de acest registru și de **nota contabilă 691 = 4411** și de **D101** — cât timp
  erau două tabele, registrul și declarația depusă raportau impozite diferite pe aceleași conturi.
  Cele două câmpuri de ajustare manuală din „Închideri” sunt **suprascrieri**: lăsate goale, sumele
  se calculează din conturi; un `0` tastat înseamnă „zero, exact”.
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

## Tipuri de documente acceptate

Vânzări (mărfuri, produse, servicii, bon Z, livrare intracomunitară), cumpărări
(mărfuri, materii, utilități, servicii, combustibil, imobilizări, achiziție
intracomunitară cu taxare inversă), trezorerie (încasări/plăți casă/bancă, viramente,
comisioane), salarii (stat de plată cu CAS/CASS/impozit/CAM, plata netă), amortizare și
**notă contabilă liberă** (orice `debit = credit`, pentru orice monografie).

