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
  // Plafonul CUMULAT al avantajelor neimpozabile (art. 76 alin. (4^1)): 33% din salariul de BAZA
  // corespunzator locului de munca ocupat. Limitele individuale ale fiecarei categorii stau in
  // `BENEFICII` mai jos — asta e doar capacul comun, si e ultimul care se aplica.
  plafonBeneficiiPct: 33,
  // Cuantumurile care alimenteaza limitele individuale din `BENEFICII`. Stau AICI, in `RATES`,
  // nu ca numere fixe in tabelul de mai jos, tocmai fiindca se schimba prin ALTE acte decat Codul
  // fiscal (legea tichetelor, legea BASS, HG-ul diurnei) — deci se invechesc primele si trebuie
  // sa fie suprascriabile din Setari, fara atins codul.
  tichetMasaMaxLei: 45,          // lei/zi — Legea 201/2025 (de la nov. 2025); anterior 40,18
  castigSalarialMediuBrut: 9192, // lei — legea bugetului asigurarilor sociale pe 2026
  diurnaInternaLegala: 23,       // lei/zi — HG 714/2018, actualizata prin HG 1235/2023
  // Cursul EUR pentru plafoanele ANUALE exprimate in euro (pensii facultative, asigurari de
  // sanatate, abonamente sportive). Orientativ, ca `cursPlafonMicro`: norma cere cursul din ultima
  // zi a lunii pentru care se acorda avantajul, deci contabilul il poate suprascrie din Setari.
  cursEurBeneficii: 5.0,
  // TVA si impozite la nivelul firmei
  plafonScutire: 10000,   // istoric (scutirile sectoriale eliminate din 2025) — pastrat pt. compat. setari
  plafonScutireTvaLei: 395000, // lei — plafonul regimului special de scutire TVA (cifra de afaceri anuala);
                               // art. 310 Cod fiscal, majorat de la 300.000 la 395.000 de la 1 sept. 2025 (OG 22/2025)
  tvaStandard: 21,        // % — Legea 141/2025 (de la 1 august 2025)
  tvaRedus: 11,           // % — Legea 141/2025
  impozitMicro: 1,        // % — art. 51 alin. (1) lit. a): venituri <= pragul de mai jos SI in afara
                          // listei de coduri CAEN de la lit. b) pct. 2
  impozitMicro3: 3,       // % — art. 51 alin. (1) lit. b): peste prag SAU pe codurile CAEN listate
  pragMicro3Eur: 60000,   // EUR — pragul dintre cele doua cote (Legea 296/2023). Depasirea lui in
                          // cursul anului comuta cota de la trimestrul depasirii (art. 51 alin. 4).
  impozitProfit: 16,      // % — art. 17 Cod fiscal
  impozitDividende: 16,   // % — Legea 141/2025 (de la 1 ianuarie 2026)
  deductibilitateTvaAutoLimitat: 50, // % — art. 298 Cod fiscal (vehicule fara uz exclusiv business)
  // Art. 28 alin. (12) lit. m): amortizarea FISCALA a mijloacelor de transport de persoane cu cel
  // mult 9 scaune (categoria M1) e deductibila cel mult la acest nivel PE LUNA. E un plafon pe
  // amortizare, DISTINCT de cele doua de mai sus (TVA 50% — art. 298; cheltuieli 50% — art. 25);
  // se aplica peste ele, si se greseste tocmai fiindca seamana cu ele.
  plafonAmortizareAutoLunar: 1500, // lei/luna
  // ── Plafoane de deductibilitate la impozitul pe profit (art. 25 si 40^2 Cod fiscal) ──
  // Procentele sunt PLAFOANE, nu cote de nedeductibilitate: partea din cheltuiala care
  // depaseste plafonul devine nedeductibila. Vezi src/deductibilitate.js pentru baza de calcul
  // a fiecaruia — baza difera de la o regula la alta si acolo se greseste, nu la procent.
  protocolPct: 2,              // % — art. 25(3)(a): plafon = 2% din (profit contabil + protocol + impozit profit)
  socialPct: 5,                // % — art. 25(3)(b): plafon = 5% din fondul de salarii (cont 641)
  autoCheltuialaDeductibilPct: 50, // % — art. 25(3)(l): partea DEDUCTIBILA din cheltuielile auto
                                   // (separat de TVA-ul auto de mai sus: alt articol, poate diverge)
  sponsorizareCaPct: 0.75,     // % — art. 25(4)(i): primul plafon al creditului fiscal (din cifra de afaceri)
  sponsorizareImpozitPct: 20,  // % — art. 25(4)(i): al doilea plafon (din impozitul pe profit datorat)
  sponsorizareReportAni: 7,    // ani consecutivi de report al creditului neutilizat
  dobanziPlafonEur: 1000000,   // EUR — art. 40^2: plafonul deductibil neconditionat al costurilor excedentare
  dobanziEbitdaPct: 30,        // % — art. 40^2: peste plafon, deductibil pana la 30% din baza de calcul
  // Eligibilitate micro (art. 47 Cod fiscal, OUG 156/2024): plafon 100.000 EUR din 2026.
  plafonMicroEur: 100000,
  cursPlafonMicro: 5.0,   // orientativ (legal: cursul de la inchiderea exercitiului precedent)
  // ── Disciplina platilor in numerar (Legea 70/2015, cu modificarile din OG 16/2022) ──
  // Plafoane pe PERSOANA si pe ZI, plus soldul maxim de casierie la SFARSITUL FIECAREI ZILE
  // (art. 4 alin. 4) — nu la sfarsitul perioadei. Erau hardcodate in accounting.js.
  plafonNumerarJuridic: 5000,   // lei/persoana/zi — incasari si plati cu persoane juridice
  plafonNumerarFizic: 10000,    // lei/persoana/zi — incasari si plati cu persoane fizice
  // Art. 3 alin. (1) lit. c): platile catre persoane juridice au DOUA limite simultane —
  // 5.000 lei/persoana/zi (mai sus) SI un plafon TOTAL de 10.000 lei/zi, indiferent catre cati
  // furnizori. Se incalca independent: trei plati de 4.000 catre trei furnizori diferiti trec
  // fiecare de limita per persoana si il depasesc pe cel total. Se aplica doar PLATILOR.
  plafonNumerarTotalZi: 10000,  // lei/zi — totalul platilor in numerar catre persoane juridice
  plafonSoldCasa: 50000,        // lei — soldul de casierie admis la sfarsitul fiecarei zile
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

// ── CATEGORIILE DIN PLAFONUL DE 33% (art. 76 alin. (4^1) lit. a)-j) Cod fiscal) ───────────────
// Fiecare categorie are DOUA limite, si amandoua taie: limita ei individuala (coloana `limita`)
// si, dupa ea, plafonul comun de 33% din salariul de baza (`RATES.plafonBeneficiiPct`).
//
// `limita.tip` spune CUM se calculeaza plafonul individual — motorul (src/beneficii.js) nu are
// reguli hardcodate pe categorie, doar cele sase forme de mai jos:
//   'zi'        lei/zi x zilele relevante (lucrate, de mobilitate, de telemunca)
//   'luna'      lei/luna, fix
//   'lunaCopil' lei/luna x numarul de copii
//   'pctMinim'  % din salariul minim brut al lunii
//   'anEur'     EUR/an (x `RATES.cursEurBeneficii`), consumat cumulat pe anul in curs
//   'anLei'     lei/an, consumat cumulat pe anul in curs
//   'fara'      fara limita proprie — intra doar sub capacul de 33%
//
// ORDINEA din tablou = ordinea in care categoriile ocupa plafonul de 33%. Art. 76 alin. (4^2)
// lasa ordinea la latitudinea ANGAJATORULUI; implicita e cea din lege (a -> j), fiindca o ordine
// inventata ar schimba tacit cine ramane in plafon si cine iese din el.
//
// ⚠️  Sumele marcate „ACTUALIZEAZA ANUAL" se schimba prin alte acte decat Codul fiscal (legea
//     bugetului asigurarilor sociale, ordinele privind tichetele de masa, HG-ul diurnei) — sunt
//     cele care se invechesc primele.
const BENEFICII = [
  { id: 'mobilitate', lit: 'a', nume: 'Prestații suplimentare — clauză de mobilitate',
    temei: 'Art. 76 alin. (4^1) lit. a)',
    limita: { tip: 'zi', lei: 57.5, zile: 'mobilitate', sursaRate: 'diurnaInternaLegala', multiplu: 2.5 },
    nota: '2,5 x indemnizația legală de delegare (HG 714/2018, actualizată prin HG 1235/2023)' },
  { id: 'hrana', lit: 'b', nume: 'Contravaloarea hranei acordate de angajator',
    temei: 'Art. 76 alin. (4^1) lit. b)',
    limita: { tip: 'zi', lei: 45, zile: 'lucrate', sursaRate: 'tichetMasaMaxLei' },
    excludeTichete: true, // ultima teza a lit. b): nu se acorda celor care primesc tichete de masa
    nota: 'Valoarea maximă a unui tichet de masă/zi (Legea 201/2025)' },
  { id: 'cazare', lit: 'c', nume: 'Cazare / chirie suportată de angajator',
    temei: 'Art. 76 alin. (4^1) lit. c)',
    limita: { tip: 'pctMinim', pct: 20 },
    nota: '20% din salariul minim brut/lună/persoană' },
  { id: 'turism', lit: 'd', nume: 'Servicii turistice și/sau de tratament în concediu',
    temei: 'Art. 76 alin. (4^1) lit. d)',
    limita: { tip: 'anLei', lei: 9192, sursaRate: 'castigSalarialMediuBrut' },
    nota: 'Câștigul salarial mediu brut din legea bugetului asigurărilor sociale pe anul curent' },
  { id: 'pensii', lit: 'e', nume: 'Contribuții la fond de pensii facultative',
    temei: 'Art. 76 alin. (4^1) lit. e)',
    limita: { tip: 'anEur', eur: 400 } },
  { id: 'sanatate', lit: 'f', nume: 'Asigurare voluntară de sănătate / abonament medical',
    temei: 'Art. 76 alin. (4^1) lit. f)',
    limita: { tip: 'anEur', eur: 400 } },
  { id: 'sport', lit: 'g', nume: 'Abonament pentru facilități sportive',
    temei: 'Art. 76 alin. (4^1) lit. g)',
    limita: { tip: 'anEur', eur: 100 } },
  { id: 'telemunca', lit: 'h', nume: 'Sume pentru telemuncă (utilități la domiciliu)',
    temei: 'Art. 76 alin. (4^1) lit. h)',
    limita: { tip: 'zi', lei: 400, zile: 'telemunca', proportionalLunar: true },
    nota: '400 lei/lună, proporțional cu zilele de telemuncă din lună' },
  { id: 'educatie', lit: 'i', nume: 'Educație timpurie (creșă/grădiniță) pentru copiii angajatului',
    temei: 'Art. 76 alin. (4^1) lit. i)',
    limita: { tip: 'lunaCopil', lei: 1500 } },
  { id: 'dobanda', lit: 'j', nume: 'Diferența favorabilă de dobândă (credite/depozite)',
    temei: 'Art. 76 alin. (4^1) lit. j)',
    limita: { tip: 'fara' } },
];

// Codurile CAEN care atrag cota de 3% INDIFERENT de venituri (art. 51 alin. (1) lit. b) pct. 2,
// Legea 296/2023): IT, HoReCa, juridic, medical. Conditia priveste activitatile PRINCIPALE SAU
// SECUNDARE — aplicatia stie doar codul principal (`company.caen`), deci pentru cele secundare
// avertizeaza si lasa decizia contribuabilului. Lista nu e in RATES: `applyConfig` itereaza peste
// chei numerice, iar un tablou ar fi transformat in NaN.
const CAEN_MICRO_3 = ['5821', '6201', '6209', '5510', '5520', '5530', '5590',
  '5610', '5621', '5629', '5630', '6910', '8621', '8622', '8623', '8690'];

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
  impozitMicro: 'Art. 51 Cod fiscal — 1% pana la ' + RATES.pragMicro3Eur + ' EUR, '
    + RATES.impozitMicro3 + '% peste prag sau pe codurile CAEN de la alin. (1) lit. b) pct. 2 '
    + '(Legea 296/2023); comutarea opereaza de la trimestrul depasirii (alin. 4)',
  bazaMicro: 'Art. 53 Cod fiscal — baza NU e totalul clasei 7: se scad veniturile din provizioane, '
    + 'productia de imobilizari, variatia stocurilor, subventiile si diferentele de curs, si se adauga '
    + 'reducerile comerciale primite, plus diferenta favorabila de curs in ultimul trimestru',
  impozitProfit: 'Art. 17 Cod fiscal (16%)',
  impozitDividende: 'Legea 141/2025 — 16% pentru dividende distribuite de la 1 ianuarie 2026',
  plafonMicroEur: 'Art. 47 Cod fiscal, OUG 156/2024 — 100.000 EUR din 2026',
  plafonScutireTva: 'Art. 310 Cod fiscal, OG 22/2025 — plafon scutire TVA 395.000 lei de la 1 sept. 2025 (Directiva UE 2020/285)',
  deducerePersonala: 'Art. 77 Cod fiscal, Legea 34/2023',
  tichetMasa: 'Legea 165/2018, modificata prin Legea 201/2025 — valoarea maxima a unui tichet '
    + 'de masa 45 lei/zi (de la nov. 2025; anterior 40,18)',
  castigSalarialMediu: 'Legea bugetului asigurarilor sociale de stat pe 2026 — castig salarial '
    + 'mediu brut 9.192 lei (plafonul anual al serviciilor turistice, art. 76 alin. (4^1) lit. d)',
  diurnaInterna: 'HG 714/2018, actualizata prin HG 1235/2023 — indemnizatia de delegare 23 lei/zi '
    + 'pentru personalul institutiilor publice; plafonul neimpozabil privat e 2,5 x acest nivel',
  beneficii33: 'Art. 76 alin. (4^1) si (4^2) Cod fiscal — avantajele de la lit. a)-j) sunt '
    + 'neimpozabile CUMULAT in limita a ' + RATES.plafonBeneficiiPct + '% din salariul de baza, '
    + 'fiecare si in limita ei individuala; partea care depaseste devine venit salarial (impozit '
    + '+ CAS art. 139(1)(v) + CASS art. 157(1)(v) + CAM). Ordinea de includere in plafon o '
    + 'stabileste angajatorul (alin. 4^2); implicita aici e cea din lege',
  pfa: 'Art. 148 & 170 Cod fiscal — plafoane 6 / 12 / 24 / 60 salarii minime',
  concediiMedicale: 'OUG 158/2005 — CAS + impozit, fara CASS; CAM doar pe partea angajatorului',
  deductibilitateAuto: 'Art. 298 Cod fiscal — TVA deductibila 50% (vehicule fara uz exclusiv business)',
  protocol: 'Art. 25(3)(a) Cod fiscal — plafon 2%, baza = profit contabil + protocol + impozit pe profit',
  social: 'Art. 25(3)(b) Cod fiscal — plafon 5% din fondul de salarii',
  autoCheltuiala: 'Art. 25(3)(l) Cod fiscal — 50% din cheltuielile auto (vehicule fara uz exclusiv business)',
  amortizareAuto: 'Art. 28 alin. (12) lit. m) Cod fiscal — amortizarea fiscala a vehiculelor de '
    + 'persoane cu maxim 9 scaune (M1) e deductibila cel mult ' + RATES.plafonAmortizareAutoLunar
    + ' lei/luna; partea peste plafon e nedeductibila si NU se reporteaza',
  sponsorizare: 'Art. 25(4)(i) Cod fiscal — cheltuiala integral nedeductibila, dar CREDIT FISCAL '
    + 'min(' + RATES.sponsorizareCaPct + '% din cifra de afaceri; ' + RATES.sponsorizareImpozitPct
    + '% din impozitul pe profit), cu report ' + RATES.sponsorizareReportAni + ' ani',
  dobanziExcedentare: 'Art. 40^2 Cod fiscal — 1.000.000 EUR deductibil neconditionat, peste acesta '
    + '30% din baza (rezultat fiscal + costuri excedentare + amortizare fiscala); report NELIMITAT',
  pragIntrastat: 'Ordin INS — praguri Intrastat 1.000.000 lei/an pe flux (introduceri / expedieri), 2024-2026',
};

module.exports = { AN, DATA_ACTUALIZARE, RATES, DEDUCERE, BENEFICII, PFA, CAEN_MICRO_3, SURSE };
