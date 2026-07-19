'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  SURSA UNICA, DATATA, A PARAMETRILOR FISCALI
//  Actualizarea anuala (sau la modificari legislative) se face DOAR aici — nu prin
//  vanatoare de valori prin cod. Fisierul NU contine logica, doar date; fiscal.js
//  le consuma. La orice schimbare: modifica valoarea, apoi `AN` + `DATA_ACTUALIZARE`
//  si nota din `SURSE`. Referintele legale sunt orientative (verifica textul in vigoare).
//
//  ⚠️  Cotele din `RATES` sunt SUPRASCRIABILE de utilizator (Setari → Cote fiscale);
//      valorile de aici sunt cele implicite / de referinta pentru anul `AN`.
// ─────────────────────────────────────────────────────────────────────────────

const AN = 2026;
const DATA_ACTUALIZARE = '2026-01-01';

// Cote si praguri (numerice, suprascriabile din Setari). Cheile trebuie sa ramana plate
// si numerice — applyConfig() din fiscal.js itereaza peste ele si aplica suprascrierile.
const RATES = {
  an: AN,
  // Contributii si impozit pe salarii
  cas: 25,            // % — art. 138 Cod fiscal
  cass: 10,           // % — art. 156 Cod fiscal
  impozitVenit: 10,   // % — art. 78 Cod fiscal
  cam: 2.25,          // % — art. 220^3 Cod fiscal (contributia asiguratorie de munca)
  // Salariul minim brut si sumele neimpozabile (trecerea S1 -> S2 de la 1 iulie)
  salariuMinimS1: 4050,
  salariuMinimS2: 4325,
  salariuMinimConstructii: 4582,
  neimpozabilS1: 300, // lei neimpozabili din salariul minim (S1)
  neimpozabilS2: 200, // lei neimpozabili din salariul minim (S2)
  // TVA si impozite la nivelul firmei
  plafonScutire: 10000,   // istoric (scutirile sectoriale eliminate din 2025) — pastrat pt. compat. setari
  tvaStandard: 21,        // % — Legea 141/2025 (de la 1 august 2025)
  tvaRedus: 11,           // % — Legea 141/2025
  impozitMicro: 1,        // % — art. 51 Cod fiscal
  impozitProfit: 16,      // % — art. 17 Cod fiscal
  impozitDividende: 16,   // % — Legea 141/2025 (de la 1 ianuarie 2026)
  deductibilitateTvaAutoLimitat: 50, // % — art. 298 Cod fiscal (vehicule fara uz exclusiv business)
  // Eligibilitate micro (art. 47 Cod fiscal, OUG 156/2024): plafon 100.000 EUR din 2026.
  plafonMicroEur: 100000,
  cursPlafonMicro: 5.0,   // orientativ (legal: cursul de la inchiderea exercitiului precedent)
  // Praguri Intrastat (lei/an, separat pe flux) — Ordin INS (valabile 2024-2026): peste prag,
  // firma devine obligata la declaratia statistica Intrastat pentru fluxul respectiv.
  pragIntrastatIntroduceri: 1000000, // achizitii intracomunitare (arrivals)
  pragIntrastatExpedieri: 1000000,   // livrari intracomunitare (dispatches)
};

// Deducerea personala de baza (art. 77 Cod fiscal, Legea 34/2023): procentele MAXIME la nivelul
// salariului minim, dupa numarul de persoane in intretinere (0, 1, 2, 3, 4+), plafonul „peste minim"
// si suplimentele (tineri <=26 ani; copii in invatamant).
const DEDUCERE = {
  pctMax: [20, 25, 30, 35, 45], // % din salariul minim
  plafonPesteMinim: 2000,       // lei — deducerea scade liniar la 0 pana la (SM + 2000)
  suplTineriPct: 15,            // % din SM, tineri <=26 ani sub salariul minim
  suplCopilLei: 100,            // lei/copil in invatamant (un singur parinte)
  rotunjireLei: 10,            // rotunjire finala, in favoarea angajatului
};

// PFA in sistem real (Declaratia Unica) — plafoanele CAS/CASS ca multipli de salariu minim
// (art. 148/170 Cod fiscal): CASS intre 6 SM si 60 SM; CAS de la 12 SM (baza 12), respectiv 24 SM.
const PFA = { plafonCassInf: 6, cas12: 12, cas24: 24, plafonCassSup: 60 };

// Referinte legale (trasabilitate la revizuirea anuala). Orientative — verifica textul in vigoare.
const SURSE = {
  cas: 'Art. 138 Cod fiscal (25%)',
  cass: 'Art. 156 Cod fiscal (10%)',
  impozitVenit: 'Art. 78 Cod fiscal (10%)',
  cam: 'Art. 220^3 Cod fiscal (2,25%)',
  salariuMinim: 'HG salariu minim 2026 — 4.050 lei (S1) / 4.325 lei (S2, de la 1 iulie)',
  neimpozabil: 'Art. 76 Cod fiscal — 300 lei (S1) / 200 lei (S2) neimpozabili din salariul minim',
  tva: 'Legea 141/2025 — TVA standard 21%, redus 11% (de la 1 august 2025)',
  impozitMicro: 'Art. 51 Cod fiscal (1%)',
  impozitProfit: 'Art. 17 Cod fiscal (16%)',
  impozitDividende: 'Legea 141/2025 — 16% pentru dividende distribuite de la 1 ianuarie 2026',
  plafonMicroEur: 'Art. 47 Cod fiscal, OUG 156/2024 — 100.000 EUR din 2026',
  deducerePersonala: 'Art. 77 Cod fiscal, Legea 34/2023',
  pfa: 'Art. 148 & 170 Cod fiscal — plafoane 6 / 12 / 24 / 60 salarii minime',
  concediiMedicale: 'OUG 158/2005 — CAS + impozit, fara CASS; CAM doar pe partea angajatorului',
  deductibilitateAuto: 'Art. 298 Cod fiscal — TVA deductibila 50% (vehicule fara uz exclusiv business)',
  pragIntrastat: 'Ordin INS — praguri Intrastat 1.000.000 lei/an pe flux (introduceri / expedieri), 2024-2026',
};

module.exports = { AN, DATA_ACTUALIZARE, RATES, DEDUCERE, PFA, SURSE };
