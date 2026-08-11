'use strict';

/**
 * Planul de conturi general (romanesc, simplificat).
 * Fiecare cont are:
 *   - cod: simbolul contului
 *   - nume: denumirea, CU DIACRITICE (vezi mai jos)
 *   - clasa: 1..8
 *   - tip: 'A' (activ), 'P' (pasiv), 'B' (bifunctional), 'C' (cheltuieli), 'V' (venituri)
 *
 * Regula soldului:
 *   A  -> creste in debit,  sold debitor
 *   P  -> creste in credit, sold creditor
 *   C  -> ca activele (debit), se inchid la 121
 *   V  -> ca pasivele (credit), se inchid la 121
 *   B  -> bifunctional (poate avea sold D sau C)
 *
 * DIACRITICE: `nume` e text catre UTILIZATOR, nu comentariu de cod — se scrie deci cu diacritice,
 * ca orice mesaj afisat (regula din CLAUDE.md; comentariile de aici raman fara). Denumirea unui
 * cont apare in balanta, cartea mare, jurnal, fisele de cont si in exporturile PDF/CSV, deci un
 * „Conturi la banci in lei" ajungea sub titluri scrise corect, in aceeasi pagina.
 * Se folosesc ș/ț cu VIRGULA dedesubt (U+0219/U+021B), nu cu sedila — ca in restul aplicatiei.
 * „de natura salariilor" / „de natura obiectelor de inventar" raman asa: acolo e genitivul lui
 * „natura", nu substantivul „natură" (care apare, corect accentuat, la 642 „avantajele în natură").
 *
 * ATENTIE la modificari: aceste denumiri NU sunt doar de afisare — intra in SAF-T (D406), in
 * <AccountDescription> (src/saft.js), deci ajung la ANAF. Orice schimbare aici trece prin poarta
 * fiscala (`sh scripts/poarta-fiscala.sh`). Diacriticele in sine sunt sigure: acelasi document
 * trimite deja text liber cu diacritice (denumirea firmei, partenerii, produsele), iar XML-ul e
 * UTF-8; verificat cu validatorul oficial la introducerea lor.
 * Cautarea unui cont se face DUPA COD (`BY_CODE`), niciodata dupa nume — deci redenumirea nu
 * poate rupe o potrivire.
 */

const ACCOUNTS = [
  // ───────────────────────── Clasa 1 — Capitaluri ─────────────────────────
  { cod: '1011', nume: 'Capital subscris nevărsat', clasa: 1, tip: 'P' },
  { cod: '1012', nume: 'Capital subscris vărsat', clasa: 1, tip: 'P' },
  { cod: '105',  nume: 'Rezerve din reevaluare', clasa: 1, tip: 'P' },
  { cod: '106',  nume: 'Rezerve', clasa: 1, tip: 'P' },
  { cod: '1061', nume: 'Rezerve legale', clasa: 1, tip: 'P' },
  { cod: '1068', nume: 'Alte rezerve', clasa: 1, tip: 'P' },
  { cod: '117',  nume: 'Rezultatul reportat', clasa: 1, tip: 'B' },
  { cod: '1171', nume: 'Rezultatul reportat reprezentând profitul nerepartizat sau pierderea neacoperită', clasa: 1, tip: 'B' },
  { cod: '1174', nume: 'Rezultatul reportat provenit din corectarea erorilor contabile', clasa: 1, tip: 'B' },
  { cod: '121',  nume: 'Profit sau pierdere', clasa: 1, tip: 'B' },
  { cod: '129',  nume: 'Repartizarea profitului', clasa: 1, tip: 'A' },
  { cod: '1621', nume: 'Credite bancare pe termen lung', clasa: 1, tip: 'P' },
  { cod: '151',  nume: 'Provizioane pentru riscuri și cheltuieli', clasa: 1, tip: 'P' },
  { cod: '167',  nume: 'Alte împrumuturi și datorii asimilate (leasing)', clasa: 1, tip: 'P' },
  { cod: '1687', nume: 'Dobânzi aferente altor împrumuturi', clasa: 1, tip: 'P' },

  // ─────────────────────── Clasa 2 — Imobilizari ──────────────────────────
  { cod: '205',  nume: 'Concesiuni, brevete, licențe', clasa: 2, tip: 'A' },
  { cod: '208',  nume: 'Alte imobilizări necorporale', clasa: 2, tip: 'A' },
  { cod: '211',  nume: 'Terenuri și amenajări de terenuri', clasa: 2, tip: 'A' },
  // Terenul si amenajarea lui se despart fiindca se AMORTIZEAZA DIFERIT: terenul nu e activ
  // amortizabil (art. 28 alin. (4) Cod fiscal), amenajarea este. Cat timp exista doar sinteticul
  // 211, regula nu are cum sa distinga intre ele — vezi NEAMORTIZABILE din src/assets.js.
  { cod: '2111', nume: 'Terenuri', clasa: 2, tip: 'A' },
  { cod: '2112', nume: 'Amenajări de terenuri', clasa: 2, tip: 'A' },
  { cod: '212',  nume: 'Construcții', clasa: 2, tip: 'A' },
  { cod: '2131', nume: 'Echipamente tehnologice (mașini, utilaje)', clasa: 2, tip: 'A' },
  { cod: '2133', nume: 'Mijloace de transport', clasa: 2, tip: 'A' },
  { cod: '214',  nume: 'Mobilier, aparatură birotică', clasa: 2, tip: 'A' },
  { cod: '231',  nume: 'Imobilizări corporale în curs de execuție', clasa: 2, tip: 'A' },
  { cod: '267',  nume: 'Creanțe imobilizate', clasa: 2, tip: 'A' },
  { cod: '2678', nume: 'Alte creanțe imobilizate (garanții)', clasa: 2, tip: 'A' },
  { cod: '280',  nume: 'Amortizări privind imobilizările necorporale', clasa: 2, tip: 'P' },
  { cod: '2801', nume: 'Amortizarea imobilizărilor necorporale', clasa: 2, tip: 'P' },
  // Amortizarile pe FELUL imobilizarii. Lipseau, desi `assets.contAmortizare` le producea prin
  // concatenare ('281' + a treia cifra): amortizarea unei cladiri se inregistra pe 2812, cont
  // inexistent in plan, deci aparea drept „(cont necunoscut)" in balanta, in fisa contului si in
  // <AccountDescription> din SAF-T — adica pleca asa la ANAF. Denumirile sunt cele din OMFP
  // 1802/2014; 2813 il acopera si pe 2131, de aceea poarta si „instalatiilor".
  { cod: '2805', nume: 'Amortizarea concesiunilor, brevetelor, licențelor', clasa: 2, tip: 'P' },
  { cod: '2808', nume: 'Amortizarea altor imobilizări necorporale', clasa: 2, tip: 'P' },
  { cod: '281',  nume: 'Amortizări privind imobilizările corporale', clasa: 2, tip: 'P' },
  { cod: '2811', nume: 'Amortizarea amenajărilor de terenuri', clasa: 2, tip: 'P' },
  { cod: '2812', nume: 'Amortizarea construcțiilor', clasa: 2, tip: 'P' },
  { cod: '2813', nume: 'Amortizarea instalațiilor și mijloacelor de transport', clasa: 2, tip: 'P' },
  { cod: '2814', nume: 'Amortizarea altor imobilizări corporale', clasa: 2, tip: 'P' },

  // ─────────────────── Clasa 3 — Stocuri si productie ─────────────────────
  { cod: '301',  nume: 'Materii prime', clasa: 3, tip: 'A' },
  { cod: '302',  nume: 'Materiale consumabile', clasa: 3, tip: 'A' },
  { cod: '3021', nume: 'Materiale auxiliare', clasa: 3, tip: 'A' },
  { cod: '3022', nume: 'Combustibili', clasa: 3, tip: 'A' },
  { cod: '303',  nume: 'Materiale de natura obiectelor de inventar', clasa: 3, tip: 'A' },
  { cod: '331',  nume: 'Produse în curs de execuție', clasa: 3, tip: 'A' },
  { cod: '332',  nume: 'Servicii în curs de execuție', clasa: 3, tip: 'A' },
  { cod: '345',  nume: 'Produse finite', clasa: 3, tip: 'A' },
  { cod: '371',  nume: 'Mărfuri', clasa: 3, tip: 'A' },
  { cod: '378',  nume: 'Diferențe de preț la mărfuri (adaos comercial)', clasa: 3, tip: 'P' },
  { cod: '381',  nume: 'Ambalaje', clasa: 3, tip: 'A' },

  // ──────────────────────── Clasa 4 — Terti ───────────────────────────────
  { cod: '401',  nume: 'Furnizori', clasa: 4, tip: 'P' },
  { cod: '404',  nume: 'Furnizori de imobilizări', clasa: 4, tip: 'P' },
  { cod: '403',  nume: 'Efecte de plătit', clasa: 4, tip: 'P' },
  { cod: '405',  nume: 'Efecte de plătit pentru imobilizări', clasa: 4, tip: 'P' },
  { cod: '408',  nume: 'Furnizori - facturi nesosite', clasa: 4, tip: 'P' },
  { cod: '409',  nume: 'Furnizori - debitori (avansuri)', clasa: 4, tip: 'A' },
  { cod: '4111', nume: 'Clienți', clasa: 4, tip: 'A' },
  { cod: '4118', nume: 'Clienți incerți sau în litigiu', clasa: 4, tip: 'A' },
  { cod: '413',  nume: 'Efecte de primit de la clienți', clasa: 4, tip: 'A' },
  { cod: '418',  nume: 'Clienți - facturi de întocmit', clasa: 4, tip: 'A' },
  { cod: '419',  nume: 'Clienți - creditori (avansuri)', clasa: 4, tip: 'P' },
  { cod: '421',  nume: 'Personal - salarii datorate', clasa: 4, tip: 'P' },
  { cod: '423',  nume: 'Personal - ajutoare materiale datorate', clasa: 4, tip: 'P' },
  { cod: '425',  nume: 'Avansuri acordate personalului', clasa: 4, tip: 'A' },
  { cod: '427',  nume: 'Rețineri din salarii datorate terților', clasa: 4, tip: 'P' },
  { cod: '4282', nume: 'Alte creanțe în legătură cu personalul', clasa: 4, tip: 'A' },
  { cod: '4315', nume: 'Contribuția de asigurări sociale (CAS)', clasa: 4, tip: 'P' },
  { cod: '4316', nume: 'Contribuția de asigurări sociale de sănătate (CASS)', clasa: 4, tip: 'P' },
  { cod: '436',  nume: 'Contribuția asiguratorie pentru muncă (CAM)', clasa: 4, tip: 'P' },
  { cod: '4373', nume: 'Contribuția pentru concedii și indemnizații / decontări FNUASS', clasa: 4, tip: 'B' },
  { cod: '4423', nume: 'TVA de plată', clasa: 4, tip: 'P' },
  { cod: '4424', nume: 'TVA de recuperat', clasa: 4, tip: 'A' },
  { cod: '4426', nume: 'TVA deductibilă', clasa: 4, tip: 'A' },
  { cod: '4427', nume: 'TVA colectată', clasa: 4, tip: 'P' },
  { cod: '4428', nume: 'TVA neexigibilă', clasa: 4, tip: 'B' },
  { cod: '444',  nume: 'Impozitul pe venituri de natura salariilor', clasa: 4, tip: 'P' },
  { cod: '446',  nume: 'Alte impozite, taxe și vărsăminte asimilate', clasa: 4, tip: 'P' },
  { cod: '445',  nume: 'Subvenții', clasa: 4, tip: 'A' },
  { cod: '4411', nume: 'Impozitul pe profit', clasa: 4, tip: 'P' },
  { cod: '4418', nume: 'Impozitul pe venitul microîntreprinderilor', clasa: 4, tip: 'P' },
  { cod: '457',  nume: 'Dividende de plată', clasa: 4, tip: 'P' },
  { cod: '455',  nume: 'Sume datorate acționarilor/asociaților', clasa: 4, tip: 'P' },
  { cod: '456',  nume: 'Decontări cu acționarii/asociații privind capitalul', clasa: 4, tip: 'B' },
  { cod: '481',  nume: 'Decontări între unitate și subunități', clasa: 4, tip: 'B' },
  { cod: '461',  nume: 'Debitori diverși', clasa: 4, tip: 'A' },
  { cod: '473',  nume: 'Decontări din operațiuni în curs de clarificare', clasa: 4, tip: 'B' },
  { cod: '462',  nume: 'Creditori diverși', clasa: 4, tip: 'P' },
  { cod: '491',  nume: 'Ajustări pentru deprecierea creanțelor - clienți', clasa: 4, tip: 'P' },
  { cod: '471',  nume: 'Cheltuieli înregistrate în avans', clasa: 4, tip: 'A' },
  { cod: '472',  nume: 'Venituri înregistrate în avans', clasa: 4, tip: 'P' },
  { cod: '475',  nume: 'Subvenții pentru investiții', clasa: 4, tip: 'P' },

  // ───────────────────────── Clasa 5 — Trezorerie ─────────────────────────
  { cod: '5112', nume: 'Cecuri de încasat', clasa: 5, tip: 'A' },
  { cod: '5113', nume: 'Efecte de încasat', clasa: 5, tip: 'A' },
  { cod: '5114', nume: 'Efecte remise spre scontare', clasa: 5, tip: 'A' },
  { cod: '5121', nume: 'Conturi la bănci în lei', clasa: 5, tip: 'A' },
  { cod: '5191', nume: 'Credite bancare pe termen scurt', clasa: 5, tip: 'P' },
  { cod: '5124', nume: 'Conturi la bănci în valută', clasa: 5, tip: 'A' },
  { cod: '541',  nume: 'Acreditive', clasa: 5, tip: 'A' },
  { cod: '5411', nume: 'Acreditive în lei', clasa: 5, tip: 'A' },
  { cod: '5412', nume: 'Acreditive în valută', clasa: 5, tip: 'A' },
  { cod: '5311', nume: 'Casa în lei', clasa: 5, tip: 'A' },
  { cod: '5314', nume: 'Casa în valută', clasa: 5, tip: 'A' },
  { cod: '5328', nume: 'Alte valori (tichete, timbre)', clasa: 5, tip: 'A' },
  { cod: '542',  nume: 'Avansuri de trezorerie', clasa: 5, tip: 'A' },
  { cod: '581',  nume: 'Viramente interne', clasa: 5, tip: 'B' },

  // ───────────────────────── Clasa 6 — Cheltuieli ─────────────────────────
  { cod: '601',  nume: 'Cheltuieli cu materiile prime', clasa: 6, tip: 'C' },
  { cod: '602',  nume: 'Cheltuieli cu materialele consumabile', clasa: 6, tip: 'C' },
  { cod: '6022', nume: 'Cheltuieli privind combustibilii', clasa: 6, tip: 'C' },
  { cod: '603',  nume: 'Cheltuieli privind materialele de natura obiectelor de inventar', clasa: 6, tip: 'C' },
  { cod: '604',  nume: 'Cheltuieli privind materialele nestocate', clasa: 6, tip: 'C' },
  { cod: '605',  nume: 'Cheltuieli privind energia și apa', clasa: 6, tip: 'C' },
  { cod: '607',  nume: 'Cheltuieli privind mărfurile', clasa: 6, tip: 'C' },
  { cod: '609',  nume: 'Reduceri comerciale primite', clasa: 6, tip: 'C' },
  { cod: '611',  nume: 'Cheltuieli cu întreținerea și reparațiile', clasa: 6, tip: 'C' },
  { cod: '612',  nume: 'Cheltuieli cu redevențele, locațiile și chiriile', clasa: 6, tip: 'C' },
  { cod: '613',  nume: 'Cheltuieli cu primele de asigurare', clasa: 6, tip: 'C' },
  { cod: '622',  nume: 'Cheltuieli privind comisioanele și onorariile', clasa: 6, tip: 'C' },
  { cod: '623',  nume: 'Cheltuieli de protocol, reclamă și publicitate', clasa: 6, tip: 'C' },
  { cod: '624',  nume: 'Cheltuieli cu transportul de bunuri și personal', clasa: 6, tip: 'C' },
  { cod: '625',  nume: 'Cheltuieli cu deplasări, detașări și transferări', clasa: 6, tip: 'C' },
  { cod: '626',  nume: 'Cheltuieli poștale și taxe de telecomunicații', clasa: 6, tip: 'C' },
  { cod: '627',  nume: 'Cheltuieli cu serviciile bancare și asimilate', clasa: 6, tip: 'C' },
  { cod: '628',  nume: 'Alte cheltuieli cu serviciile executate de terți', clasa: 6, tip: 'C' },
  { cod: '635',  nume: 'Cheltuieli cu alte impozite, taxe și vărsăminte', clasa: 6, tip: 'C' },
  { cod: '641',  nume: 'Cheltuieli cu salariile personalului', clasa: 6, tip: 'C' },
  { cod: '642',  nume: 'Cheltuieli cu avantajele în natură și tichetele acordate salariaților', clasa: 6, tip: 'C' },
  { cod: '6458', nume: 'Alte cheltuieli privind asigurările și protecția socială', clasa: 6, tip: 'C' },
  { cod: '646',  nume: 'Cheltuieli privind contribuția asiguratorie pentru muncă', clasa: 6, tip: 'C' },
  { cod: '6581', nume: 'Despăgubiri, amenzi și penalități', clasa: 6, tip: 'C' },
  { cod: '6588', nume: 'Alte cheltuieli de exploatare', clasa: 6, tip: 'C' },
  { cod: '6582', nume: 'Donații și subvenții acordate (sponsorizare, mecenat)', clasa: 6, tip: 'C' },
  { cod: '6583', nume: 'Cheltuieli privind activele cedate și alte operații de capital', clasa: 6, tip: 'C' },
  { cod: '665',  nume: 'Cheltuieli din diferențe de curs valutar', clasa: 6, tip: 'C' },
  { cod: '666',  nume: 'Cheltuieli privind dobânzile', clasa: 6, tip: 'C' },
  { cod: '667',  nume: 'Cheltuieli privind sconturile acordate', clasa: 6, tip: 'C' },
  { cod: '6811', nume: 'Cheltuieli de exploatare privind amortizarea imobilizărilor', clasa: 6, tip: 'C' },
  { cod: '6812', nume: 'Cheltuieli de exploatare privind provizioanele', clasa: 6, tip: 'C' },
  { cod: '6814', nume: 'Cheltuieli privind ajustările pentru deprecierea activelor circulante', clasa: 6, tip: 'C' },
  { cod: '654',  nume: 'Pierderi din creanțe și debitori diverși', clasa: 6, tip: 'C' },
  { cod: '655',  nume: 'Cheltuieli din reevaluarea imobilizărilor corporale', clasa: 6, tip: 'C' },
  { cod: '691',  nume: 'Cheltuieli cu impozitul pe profit', clasa: 6, tip: 'C' },
  { cod: '698',  nume: 'Cheltuieli cu impozitul pe venit (microîntreprindere)', clasa: 6, tip: 'C' },

  // ────────────────────────── Clasa 7 — Venituri ──────────────────────────
  { cod: '701',  nume: 'Venituri din vânzarea produselor finite', clasa: 7, tip: 'V' },
  { cod: '704',  nume: 'Venituri din servicii prestate', clasa: 7, tip: 'V' },
  { cod: '707',  nume: 'Venituri din vânzarea mărfurilor', clasa: 7, tip: 'V' },
  { cod: '741',  nume: 'Venituri din subvenții de exploatare', clasa: 7, tip: 'V' },
  { cod: '7584', nume: 'Venituri din subvenții pentru investiții', clasa: 7, tip: 'V' },
  { cod: '708',  nume: 'Venituri din activități diverse', clasa: 7, tip: 'V' },
  { cod: '709',  nume: 'Reduceri comerciale acordate', clasa: 7, tip: 'V' },
  { cod: '711',  nume: 'Venituri aferente costurilor stocurilor de produse', clasa: 7, tip: 'V' },
  { cod: '712',  nume: 'Venituri aferente costurilor serviciilor în curs', clasa: 7, tip: 'V' },
  { cod: '722',  nume: 'Venituri din producția de imobilizări corporale', clasa: 7, tip: 'V' },
  { cod: '755',  nume: 'Venituri din reevaluarea imobilizărilor corporale', clasa: 7, tip: 'V' },
  { cod: '7812', nume: 'Venituri din provizioane', clasa: 7, tip: 'V' },
  { cod: '758',  nume: 'Alte venituri din exploatare', clasa: 7, tip: 'V' },
  { cod: '7588', nume: 'Alte venituri din exploatare', clasa: 7, tip: 'V' },
  { cod: '7814', nume: 'Venituri din ajustări pentru deprecierea activelor circulante', clasa: 7, tip: 'V' },
  { cod: '754',  nume: 'Venituri din creanțe reactivate și debitori diverși', clasa: 7, tip: 'V' },
  { cod: '7581', nume: 'Venituri din despăgubiri, amenzi și penalități', clasa: 7, tip: 'V' },
  { cod: '7583', nume: 'Venituri din vânzarea activelor și alte operații de capital', clasa: 7, tip: 'V' },
  { cod: '765',  nume: 'Venituri din diferențe de curs valutar', clasa: 7, tip: 'V' },
  { cod: '766',  nume: 'Venituri din dobânzi', clasa: 7, tip: 'V' },
  { cod: '767',  nume: 'Venituri din sconturi obținute', clasa: 7, tip: 'V' },

  // ─────────────────── Clasa 8 — Conturi speciale ─────────────────────────
  { cod: '8031', nume: 'Imobilizări corporale luate cu chirie', clasa: 8, tip: 'B' },
  { cod: '8038', nume: 'Alte valori în afara bilanțului', clasa: 8, tip: 'B' },
];

const BY_CODE = new Map(ACCOUNTS.map((a) => [a.cod, a]));

/** Adauga/actualizeaza conturi personalizate (din importul utilizatorului). */
function addAccounts(list) {
  for (const a of (list || [])) {
    if (!a || !a.cod) continue;
    const cod = String(a.cod).trim();
    const rec = { cod, nume: a.nume || '(cont personalizat)', clasa: Number(a.clasa) || Number(cod[0]) || 0, tip: a.tip || 'B' };
    if (BY_CODE.has(cod)) Object.assign(BY_CODE.get(cod), rec);
    else { ACCOUNTS.push(rec); BY_CODE.set(cod, rec); }
  }
  ACCOUNTS.sort((a, b) => (a.cod < b.cod ? -1 : a.cod > b.cod ? 1 : 0));
  return ACCOUNTS.length;
}

function getAccount(cod) {
  return BY_CODE.get(String(cod));
}

function accountName(cod) {
  const a = BY_CODE.get(String(cod));
  return a ? a.nume : '(cont necunoscut)';
}

/** Sensul soldului unui cont: returneaza 'D' sau 'C' in functie de natura contului. */
function normalSide(cod) {
  const a = BY_CODE.get(String(cod));
  if (!a) return 'D';
  if (a.tip === 'A' || a.tip === 'C') return 'D';
  if (a.tip === 'P' || a.tip === 'V') return 'C';
  return 'B'; // bifunctional - decis dupa sold
}

const CLASS_NAMES = {
  1: 'Conturi de capitaluri',
  2: 'Conturi de imobilizari',
  3: 'Conturi de stocuri si productie in curs',
  4: 'Conturi de terti',
  5: 'Conturi de trezorerie',
  6: 'Conturi de cheltuieli',
  7: 'Conturi de venituri',
  8: 'Conturi speciale',
};

module.exports = {
  ACCOUNTS,
  addAccounts,
  getAccount,
  accountName,
  normalSide,
  CLASS_NAMES,
};
