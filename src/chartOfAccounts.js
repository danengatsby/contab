'use strict';

/**
 * Planul de conturi general (romanesc, simplificat).
 * Fiecare cont are:
 *   - cod: simbolul contului
 *   - nume: denumirea
 *   - clasa: 1..8
 *   - tip: 'A' (activ), 'P' (pasiv), 'B' (bifunctional), 'C' (cheltuieli), 'V' (venituri)
 *
 * Regula soldului:
 *   A  -> creste in debit,  sold debitor
 *   P  -> creste in credit, sold creditor
 *   C  -> ca activele (debit), se inchid la 121
 *   V  -> ca pasivele (credit), se inchid la 121
 *   B  -> bifunctional (poate avea sold D sau C)
 */

const ACCOUNTS = [
  // ───────────────────────── Clasa 1 — Capitaluri ─────────────────────────
  { cod: '1012', nume: 'Capital subscris varsat', clasa: 1, tip: 'P' },
  { cod: '105',  nume: 'Rezerve din reevaluare', clasa: 1, tip: 'P' },
  { cod: '106',  nume: 'Rezerve', clasa: 1, tip: 'P' },
  { cod: '1061', nume: 'Rezerve legale', clasa: 1, tip: 'P' },
  { cod: '1068', nume: 'Alte rezerve', clasa: 1, tip: 'P' },
  { cod: '117',  nume: 'Rezultatul reportat', clasa: 1, tip: 'B' },
  { cod: '121',  nume: 'Profit sau pierdere', clasa: 1, tip: 'B' },
  { cod: '129',  nume: 'Repartizarea profitului', clasa: 1, tip: 'A' },
  { cod: '1621', nume: 'Credite bancare pe termen lung', clasa: 1, tip: 'P' },
  { cod: '151',  nume: 'Provizioane pentru riscuri si cheltuieli', clasa: 1, tip: 'P' },
  { cod: '167',  nume: 'Alte imprumuturi si datorii asimilate (leasing)', clasa: 1, tip: 'P' },
  { cod: '1687', nume: 'Dobanzi aferente altor imprumuturi', clasa: 1, tip: 'P' },

  // ─────────────────────── Clasa 2 — Imobilizari ──────────────────────────
  { cod: '205',  nume: 'Concesiuni, brevete, licente', clasa: 2, tip: 'A' },
  { cod: '208',  nume: 'Alte imobilizari necorporale', clasa: 2, tip: 'A' },
  { cod: '211',  nume: 'Terenuri si amenajari de terenuri', clasa: 2, tip: 'A' },
  { cod: '212',  nume: 'Constructii', clasa: 2, tip: 'A' },
  { cod: '2131', nume: 'Echipamente tehnologice (masini, utilaje)', clasa: 2, tip: 'A' },
  { cod: '2133', nume: 'Mijloace de transport', clasa: 2, tip: 'A' },
  { cod: '214',  nume: 'Mobilier, aparatura birotica', clasa: 2, tip: 'A' },
  { cod: '231',  nume: 'Imobilizari corporale in curs de executie', clasa: 2, tip: 'A' },
  { cod: '267',  nume: 'Creante imobilizate', clasa: 2, tip: 'A' },
  { cod: '2678', nume: 'Alte creante imobilizate (garantii)', clasa: 2, tip: 'A' },
  { cod: '280',  nume: 'Amortizari privind imobilizarile necorporale', clasa: 2, tip: 'P' },
  { cod: '2801', nume: 'Amortizarea imobilizarilor necorporale', clasa: 2, tip: 'P' },
  { cod: '281',  nume: 'Amortizari privind imobilizarile corporale', clasa: 2, tip: 'P' },
  { cod: '2813', nume: 'Amortizarea mijloacelor de transport', clasa: 2, tip: 'P' },

  // ─────────────────── Clasa 3 — Stocuri si productie ─────────────────────
  { cod: '301',  nume: 'Materii prime', clasa: 3, tip: 'A' },
  { cod: '302',  nume: 'Materiale consumabile', clasa: 3, tip: 'A' },
  { cod: '3021', nume: 'Materiale auxiliare', clasa: 3, tip: 'A' },
  { cod: '3022', nume: 'Combustibili', clasa: 3, tip: 'A' },
  { cod: '303',  nume: 'Materiale de natura obiectelor de inventar', clasa: 3, tip: 'A' },
  { cod: '331',  nume: 'Produse in curs de executie', clasa: 3, tip: 'A' },
  { cod: '332',  nume: 'Servicii in curs de executie', clasa: 3, tip: 'A' },
  { cod: '345',  nume: 'Produse finite', clasa: 3, tip: 'A' },
  { cod: '371',  nume: 'Marfuri', clasa: 3, tip: 'A' },
  { cod: '378',  nume: 'Diferente de pret la marfuri (adaos comercial)', clasa: 3, tip: 'P' },
  { cod: '381',  nume: 'Ambalaje', clasa: 3, tip: 'A' },

  // ──────────────────────── Clasa 4 — Terti ───────────────────────────────
  { cod: '401',  nume: 'Furnizori', clasa: 4, tip: 'P' },
  { cod: '404',  nume: 'Furnizori de imobilizari', clasa: 4, tip: 'P' },
  { cod: '403',  nume: 'Efecte de platit', clasa: 4, tip: 'P' },
  { cod: '405',  nume: 'Efecte de platit pentru imobilizari', clasa: 4, tip: 'P' },
  { cod: '408',  nume: 'Furnizori - facturi nesosite', clasa: 4, tip: 'P' },
  { cod: '409',  nume: 'Furnizori - debitori (avansuri)', clasa: 4, tip: 'A' },
  { cod: '4111', nume: 'Clienti', clasa: 4, tip: 'A' },
  { cod: '413',  nume: 'Efecte de primit de la clienti', clasa: 4, tip: 'A' },
  { cod: '418',  nume: 'Clienti - facturi de intocmit', clasa: 4, tip: 'A' },
  { cod: '419',  nume: 'Clienti - creditori (avansuri)', clasa: 4, tip: 'P' },
  { cod: '421',  nume: 'Personal - salarii datorate', clasa: 4, tip: 'P' },
  { cod: '423',  nume: 'Personal - ajutoare materiale datorate', clasa: 4, tip: 'P' },
  { cod: '425',  nume: 'Avansuri acordate personalului', clasa: 4, tip: 'A' },
  { cod: '427',  nume: 'Retineri din salarii datorate tertilor', clasa: 4, tip: 'P' },
  { cod: '4282', nume: 'Alte creante in legatura cu personalul', clasa: 4, tip: 'A' },
  { cod: '4315', nume: 'Contributia de asigurari sociale (CAS)', clasa: 4, tip: 'P' },
  { cod: '4316', nume: 'Contributia de asigurari sociale de sanatate (CASS)', clasa: 4, tip: 'P' },
  { cod: '436',  nume: 'Contributia asiguratorie pentru munca (CAM)', clasa: 4, tip: 'P' },
  { cod: '4373', nume: 'Contributia pentru concedii si indemnizatii / decontari FNUASS', clasa: 4, tip: 'B' },
  { cod: '4423', nume: 'TVA de plata', clasa: 4, tip: 'P' },
  { cod: '4424', nume: 'TVA de recuperat', clasa: 4, tip: 'A' },
  { cod: '4426', nume: 'TVA deductibila', clasa: 4, tip: 'A' },
  { cod: '4427', nume: 'TVA colectata', clasa: 4, tip: 'P' },
  { cod: '4428', nume: 'TVA neexigibila', clasa: 4, tip: 'B' },
  { cod: '444',  nume: 'Impozitul pe venituri de natura salariilor', clasa: 4, tip: 'P' },
  { cod: '446',  nume: 'Alte impozite, taxe si varsaminte asimilate', clasa: 4, tip: 'P' },
  { cod: '445',  nume: 'Subventii', clasa: 4, tip: 'A' },
  { cod: '4411', nume: 'Impozitul pe profit', clasa: 4, tip: 'P' },
  { cod: '4418', nume: 'Impozitul pe venitul microintreprinderilor', clasa: 4, tip: 'P' },
  { cod: '457',  nume: 'Dividende de plata', clasa: 4, tip: 'P' },
  { cod: '455',  nume: 'Sume datorate actionarilor/asociatilor', clasa: 4, tip: 'P' },
  { cod: '481',  nume: 'Decontari intre unitate si subunitati', clasa: 4, tip: 'B' },
  { cod: '461',  nume: 'Debitori diversi', clasa: 4, tip: 'A' },
  { cod: '462',  nume: 'Creditori diversi', clasa: 4, tip: 'P' },
  { cod: '491',  nume: 'Ajustari pentru deprecierea creantelor - clienti', clasa: 4, tip: 'P' },
  { cod: '471',  nume: 'Cheltuieli inregistrate in avans', clasa: 4, tip: 'A' },
  { cod: '472',  nume: 'Venituri inregistrate in avans', clasa: 4, tip: 'P' },
  { cod: '475',  nume: 'Subventii pentru investitii', clasa: 4, tip: 'P' },

  // ───────────────────────── Clasa 5 — Trezorerie ─────────────────────────
  { cod: '5112', nume: 'Cecuri de incasat', clasa: 5, tip: 'A' },
  { cod: '5113', nume: 'Efecte de incasat', clasa: 5, tip: 'A' },
  { cod: '5114', nume: 'Efecte remise spre scontare', clasa: 5, tip: 'A' },
  { cod: '5121', nume: 'Conturi la banci in lei', clasa: 5, tip: 'A' },
  { cod: '5124', nume: 'Conturi la banci in valuta', clasa: 5, tip: 'A' },
  { cod: '541',  nume: 'Acreditive', clasa: 5, tip: 'A' },
  { cod: '5411', nume: 'Acreditive in lei', clasa: 5, tip: 'A' },
  { cod: '5412', nume: 'Acreditive in valuta', clasa: 5, tip: 'A' },
  { cod: '581',  nume: 'Viramente interne', clasa: 5, tip: 'B' },
  { cod: '5311', nume: 'Casa in lei', clasa: 5, tip: 'A' },
  { cod: '5314', nume: 'Casa in valuta', clasa: 5, tip: 'A' },
  { cod: '5328', nume: 'Alte valori (tichete, timbre)', clasa: 5, tip: 'A' },
  { cod: '542',  nume: 'Avansuri de trezorerie', clasa: 5, tip: 'A' },
  { cod: '581',  nume: 'Viramente interne', clasa: 5, tip: 'B' },

  // ───────────────────────── Clasa 6 — Cheltuieli ─────────────────────────
  { cod: '601',  nume: 'Cheltuieli cu materiile prime', clasa: 6, tip: 'C' },
  { cod: '602',  nume: 'Cheltuieli cu materialele consumabile', clasa: 6, tip: 'C' },
  { cod: '6022', nume: 'Cheltuieli privind combustibilii', clasa: 6, tip: 'C' },
  { cod: '603',  nume: 'Cheltuieli privind materialele de natura obiectelor de inventar', clasa: 6, tip: 'C' },
  { cod: '605',  nume: 'Cheltuieli privind energia si apa', clasa: 6, tip: 'C' },
  { cod: '607',  nume: 'Cheltuieli privind marfurile', clasa: 6, tip: 'C' },
  { cod: '609',  nume: 'Reduceri comerciale primite', clasa: 6, tip: 'C' },
  { cod: '611',  nume: 'Cheltuieli cu intretinerea si reparatiile', clasa: 6, tip: 'C' },
  { cod: '612',  nume: 'Cheltuieli cu redeventele, locatiile si chiriile', clasa: 6, tip: 'C' },
  { cod: '613',  nume: 'Cheltuieli cu primele de asigurare', clasa: 6, tip: 'C' },
  { cod: '622',  nume: 'Cheltuieli privind comisioanele si onorariile', clasa: 6, tip: 'C' },
  { cod: '623',  nume: 'Cheltuieli de protocol, reclama si publicitate', clasa: 6, tip: 'C' },
  { cod: '624',  nume: 'Cheltuieli cu transportul de bunuri si personal', clasa: 6, tip: 'C' },
  { cod: '625',  nume: 'Cheltuieli cu deplasari, detasari si transferari', clasa: 6, tip: 'C' },
  { cod: '626',  nume: 'Cheltuieli postale si taxe de telecomunicatii', clasa: 6, tip: 'C' },
  { cod: '627',  nume: 'Cheltuieli cu serviciile bancare si asimilate', clasa: 6, tip: 'C' },
  { cod: '628',  nume: 'Alte cheltuieli cu serviciile executate de terti', clasa: 6, tip: 'C' },
  { cod: '635',  nume: 'Cheltuieli cu alte impozite, taxe si varsaminte', clasa: 6, tip: 'C' },
  { cod: '641',  nume: 'Cheltuieli cu salariile personalului', clasa: 6, tip: 'C' },
  { cod: '642',  nume: 'Cheltuieli cu avantajele in natura si tichetele acordate salariatilor', clasa: 6, tip: 'C' },
  { cod: '6458', nume: 'Alte cheltuieli privind asigurarile si protectia sociala', clasa: 6, tip: 'C' },
  { cod: '646',  nume: 'Cheltuieli privind contributia asiguratorie pentru munca', clasa: 6, tip: 'C' },
  { cod: '6581', nume: 'Despagubiri, amenzi si penalitati', clasa: 6, tip: 'C' },
  { cod: '6582', nume: 'Donatii si subventii acordate (sponsorizare, mecenat)', clasa: 6, tip: 'C' },
  { cod: '6583', nume: 'Cheltuieli privind activele cedate si alte operatii de capital', clasa: 6, tip: 'C' },
  { cod: '665',  nume: 'Cheltuieli din diferente de curs valutar', clasa: 6, tip: 'C' },
  { cod: '666',  nume: 'Cheltuieli privind dobanzile', clasa: 6, tip: 'C' },
  { cod: '667',  nume: 'Cheltuieli privind sconturile acordate', clasa: 6, tip: 'C' },
  { cod: '6811', nume: 'Cheltuieli de exploatare privind amortizarea imobilizarilor', clasa: 6, tip: 'C' },
  { cod: '6812', nume: 'Cheltuieli de exploatare privind provizioanele', clasa: 6, tip: 'C' },
  { cod: '6814', nume: 'Cheltuieli privind ajustarile pentru deprecierea activelor circulante', clasa: 6, tip: 'C' },
  { cod: '654',  nume: 'Pierderi din creante si debitori diversi', clasa: 6, tip: 'C' },
  { cod: '655',  nume: 'Cheltuieli din reevaluarea imobilizarilor corporale', clasa: 6, tip: 'C' },
  { cod: '691',  nume: 'Cheltuieli cu impozitul pe profit', clasa: 6, tip: 'C' },
  { cod: '698',  nume: 'Cheltuieli cu impozitul pe venit (microintreprindere)', clasa: 6, tip: 'C' },

  // ────────────────────────── Clasa 7 — Venituri ──────────────────────────
  { cod: '701',  nume: 'Venituri din vanzarea produselor finite', clasa: 7, tip: 'V' },
  { cod: '704',  nume: 'Venituri din servicii prestate', clasa: 7, tip: 'V' },
  { cod: '707',  nume: 'Venituri din vanzarea marfurilor', clasa: 7, tip: 'V' },
  { cod: '741',  nume: 'Venituri din subventii de exploatare', clasa: 7, tip: 'V' },
  { cod: '7584', nume: 'Venituri din subventii pentru investitii', clasa: 7, tip: 'V' },
  { cod: '708',  nume: 'Venituri din activitati diverse', clasa: 7, tip: 'V' },
  { cod: '709',  nume: 'Reduceri comerciale acordate', clasa: 7, tip: 'V' },
  { cod: '711',  nume: 'Venituri aferente costurilor stocurilor de produse', clasa: 7, tip: 'V' },
  { cod: '712',  nume: 'Venituri aferente costurilor serviciilor in curs', clasa: 7, tip: 'V' },
  { cod: '722',  nume: 'Venituri din productia de imobilizari corporale', clasa: 7, tip: 'V' },
  { cod: '755',  nume: 'Venituri din reevaluarea imobilizarilor corporale', clasa: 7, tip: 'V' },
  { cod: '7812', nume: 'Venituri din provizioane', clasa: 7, tip: 'V' },
  { cod: '758',  nume: 'Alte venituri din exploatare', clasa: 7, tip: 'V' },
  { cod: '7588', nume: 'Alte venituri din exploatare', clasa: 7, tip: 'V' },
  { cod: '7814', nume: 'Venituri din ajustari pentru deprecierea activelor circulante', clasa: 7, tip: 'V' },
  { cod: '754',  nume: 'Venituri din creante reactivate si debitori diversi', clasa: 7, tip: 'V' },
  { cod: '7581', nume: 'Venituri din despagubiri, amenzi si penalitati', clasa: 7, tip: 'V' },
  { cod: '765',  nume: 'Venituri din diferente de curs valutar', clasa: 7, tip: 'V' },
  { cod: '766',  nume: 'Venituri din dobanzi', clasa: 7, tip: 'V' },
  { cod: '767',  nume: 'Venituri din sconturi obtinute', clasa: 7, tip: 'V' },

  // ─────────────────── Clasa 8 — Conturi speciale ─────────────────────────
  { cod: '8031', nume: 'Imobilizari corporale luate cu chirie', clasa: 8, tip: 'B' },
  { cod: '8038', nume: 'Alte valori in afara bilantului', clasa: 8, tip: 'B' },
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
