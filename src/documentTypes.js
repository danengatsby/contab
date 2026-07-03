'use strict';

const { round2 } = require('./util');
const fiscal = require('./fiscal');

/**
 * Tipuri de documente primare si "traducerea" lor in articole contabile.
 *
 * Fiecare tip are:
 *   - id, nume
 *   - grup (pentru gruparea in UI)
 *   - fields: campurile pe care le confirma utilizatorul (pre-completate de extractor)
 *   - build(d): primeste valorile campurilor si returneaza liniile contabile
 *               [{ debit, credit, suma, explicatie }]
 *
 * Tipuri de camp:
 *   number  -> input numeric
 *   text    -> input text
 *   date    -> input data
 *   select  -> lista (options: [{value,label}])
 *   account -> selector de cont din planul de conturi
 */

function L(debit, credit, suma, explicatie) {
  return { debit: String(debit), credit: String(credit), suma: round2(suma), explicatie };
}

const F = {
  data: { name: 'data', label: 'Data document', type: 'date', required: true },
  partener: { name: 'partener', label: 'Partener (client/furnizor)', type: 'text' },
  document: { name: 'document', label: 'Serie/numar document', type: 'text' },
  baza: { name: 'baza', label: 'Valoarea fara TVA', type: 'number', required: true },
  tva: { name: 'tva', label: 'TVA (lei)', type: 'number', default: 0 },
  cota: { name: 'cota', label: 'Cota TVA (%)', type: 'number', default: fiscal.FISCAL.tvaStandard },
  suma: { name: 'suma', label: 'Suma (lei)', type: 'number', required: true },
  explicatie: { name: 'explicatie', label: 'Explicatie', type: 'text' },
  cuiPartener: { name: 'cuiPartener', label: 'CUI client (pentru e-Factura)', type: 'text' },
  cuiFurnizor: { name: 'cuiPartener', label: 'CUI furnizor (pentru D394)', type: 'text' },
  analiticBanca: { name: 'analitic', label: 'Analitic bancă/casă (ex. BCR, ING)', type: 'text' },
  analiticAngajat: { name: 'analitic', label: 'Analitic angajat (ex. Ion Popescu)', type: 'text' },
  items: { name: 'items', label: 'Linii factura (optional, pentru e-Factura)', type: 'items' },
  stoc: { name: 'stoc', label: 'Descarcare din stoc (produs + gestiune + cantitate) — cost la CMP, automat', type: 'stoc' },
  auto50: { name: 'auto50', label: 'Deductibilitate auto 50% (vehicul fara uz exclusiv): 50% din TVA devine nedeductibil si intra in cost', type: 'checkbox' },
  // Intrastat (doar pentru operatiuni intracomunitare de bunuri)
  codNC: { name: 'codNC', label: 'Cod NC8 (Intrastat)', type: 'text' },
  masaNeta: { name: 'masaNeta', label: 'Masa neta kg (Intrastat)', type: 'number', default: 0 },
  naturaTranz: { name: 'naturaTranz', label: 'Natura tranzactiei (Intrastat)', type: 'text', default: '11' },
  conditieLivrare: { name: 'conditieLivrare', label: 'Conditie de livrare (Intrastat, ex. EXW)', type: 'text' },
};

const TROZ = [
  { value: '5311', label: '5311 Casa in lei' },
  { value: '5121', label: '5121 Banca in lei' },
];

const TVAL = [
  { value: '4111', label: '4111 Clienti (creanta in valuta)' },
  { value: '401', label: '401 Furnizori (datorie in valuta)' },
  { value: '5124', label: '5124 Banca in valuta' },
  { value: '5314', label: '5314 Casa in valuta' },
];

const TYPES = [
  // ─────────────────────────── VANZARI ───────────────────────────
  {
    id: 'factura_vanzare_marfuri',
    nume: 'Factura vanzare marfuri',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota, F.stoc,
      { name: 'cost', label: 'Cost marfa vanduta — manual (doar daca NU folosesti descarcarea din stoc)', type: 'number', default: 0 }, F.items],
    build: (d) => {
      const lines = [
        L('4111', '707', d.baza, 'Venituri din vanzarea marfurilor'),
      ];
      if (d.tva > 0) lines.push(L('4111', '4427', d.tva, 'TVA colectata'));
      if (d.cost > 0) lines.push(L('607', '371', d.cost, 'Descarcare gestiune - cost marfa vanduta'));
      return lines;
    },
  },
  {
    id: 'factura_vanzare_produse',
    nume: 'Factura vanzare produse finite',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota, F.items],
    build: (d) => {
      const lines = [L('4111', '701', d.baza, 'Venituri din vanzarea produselor finite')];
      if (d.tva > 0) lines.push(L('4111', '4427', d.tva, 'TVA colectata'));
      return lines;
    },
  },
  {
    id: 'factura_vanzare_servicii',
    nume: 'Factura prestari servicii (emisa)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota, F.items],
    build: (d) => {
      const lines = [L('4111', '704', d.baza, 'Venituri din servicii prestate')];
      if (d.tva > 0) lines.push(L('4111', '4427', d.tva, 'TVA colectata'));
      return lines;
    },
  },
  {
    id: 'bon_fiscal_z',
    nume: 'Raport Z / vanzare cu amanuntul (numerar)',
    grup: 'Vanzari',
    fields: [F.data, F.document, F.baza, F.tva, F.cota,
      { name: 'incasare', label: 'Incasata in', type: 'select', options: TROZ, default: '5311' }],
    build: (d) => {
      const lines = [L(d.incasare || '5311', '707', d.baza, 'Vanzare cu amanuntul')];
      if (d.tva > 0) lines.push(L(d.incasare || '5311', '4427', d.tva, 'TVA colectata aferenta'));
      return lines;
    },
  },

  // ─────────────────────────── CUMPARARI ──────────────────────────
  {
    id: 'factura_cumparare_marfuri',
    nume: 'Factura cumparare marfuri',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('371', '401', d.baza, 'Cumparare marfuri (intrare in stoc)')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibila'));
      return lines;
    },
  },
  {
    id: 'factura_cumparare_materii',
    nume: 'Factura cumparare materii prime/materiale',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota,
      { name: 'contStoc', label: 'Cont stoc', type: 'account', default: '301' }],
    build: (d) => {
      const lines = [L(d.contStoc || '301', '401', d.baza, 'Cumparare materii/materiale')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibila'));
      return lines;
    },
  },
  {
    id: 'factura_utilitati',
    nume: 'Factura utilitati (energie, apa)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('605', '401', d.baza, 'Cheltuieli cu energia si apa')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibila'));
      return lines;
    },
  },
  {
    id: 'factura_servicii_primita',
    nume: 'Factura servicii primita (chirie, telecom, onorarii...)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.auto50,
      { name: 'contChelt', label: 'Cont cheltuiala', type: 'account', default: '628' }],
    build: (d) => {
      const lines = [L(d.contChelt || '628', '401', d.baza, 'Cheltuieli cu servicii primite')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibila'));
      return lines;
    },
  },
  {
    id: 'factura_combustibil',
    nume: 'Factura/bon combustibil (cu CUI)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.auto50],
    build: (d) => {
      const lines = [L('6022', '401', d.baza, 'Cheltuieli privind combustibilii')];
      if (d.tva > 0) lines.push(L('4426', '401', d.tva, 'TVA deductibila'));
      return lines;
    },
  },
  {
    id: 'factura_imobilizare',
    nume: 'Factura achizitie imobilizare (mijloc fix)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota, F.auto50,
      { name: 'contImob', label: 'Cont imobilizare', type: 'account', default: '2131' }],
    build: (d) => {
      const lines = [L(d.contImob || '2131', '404', d.baza, 'Achizitie imobilizare')];
      if (d.tva > 0) lines.push(L('4426', '404', d.tva, 'TVA deductibila'));
      return lines;
    },
  },
  {
    id: 'achizitie_intracomunitara',
    nume: 'Achizitie intracomunitara bunuri (taxare inversa)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.cota,
      { name: 'contStoc', label: 'Cont stoc/cheltuiala', type: 'account', default: '371' },
      F.codNC, F.masaNeta, F.naturaTranz, F.conditieLivrare],
    build: (d) => {
      const tva = round2((Number(d.baza) * Number(d.cota || fiscal.FISCAL.tvaStandard)) / 100);
      return [
        L(d.contStoc || '371', '401', d.baza, 'Achizitie intracomunitara (baza)'),
        L('4426', '4427', tva, 'Taxare inversa - TVA deductibila si colectata'),
      ];
    },
  },
  {
    id: 'livrare_intracomunitara',
    nume: 'Livrare intracomunitara bunuri (scutita)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza,
      F.codNC, F.masaNeta, F.naturaTranz, F.conditieLivrare],
    build: (d) => [L('4111', '707', d.baza, 'Livrare intracomunitara (scutita cu drept de deducere)')],
  },
  {
    id: 'taxare_inversa_interna_achizitie',
    nume: 'Achizitie cu taxare inversa interna (art. 331 — cereale, lemn, deseuri, constructii...)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.cota,
      { name: 'contStoc', label: 'Cont stoc/cheltuiala/imobilizare', type: 'account', default: '371' }],
    build: (d) => {
      const tva = round2((Number(d.baza) * Number(d.cota || fiscal.FISCAL.tvaStandard)) / 100);
      return [
        L(d.contStoc || '371', '401', d.baza, 'Achizitie cu taxare inversa interna (baza)'),
        L('4426', '4427', tva, 'Taxare inversa interna - TVA deductibila si colectata'),
      ];
    },
  },
  {
    id: 'taxare_inversa_interna_livrare',
    nume: 'Livrare cu taxare inversa interna (factura emisa fara TVA)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza,
      { name: 'contVenit', label: 'Cont venit', type: 'account', default: '707' }],
    build: (d) => [L('4111', d.contVenit || '707', d.baza, 'Livrare cu taxare inversa interna (fara TVA - mentiune pe factura)')],
  },
  {
    id: 'reducere_comerciala_acordata',
    nume: 'Reducere comerciala acordata clientului (ulterioara facturarii)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('709', '4111', d.baza, 'Reducere comerciala acordata')];
      if (d.tva > 0) lines.push(L('4427', '4111', d.tva, 'TVA aferenta reducerii (storno colectata)'));
      return lines;
    },
  },
  {
    id: 'reducere_comerciala_primita',
    nume: 'Reducere comerciala primita de la furnizor (ulterioara facturarii)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('401', '609', d.baza, 'Reducere comerciala primita')];
      if (d.tva > 0) lines.push(L('401', '4426', d.tva, 'TVA aferenta reducerii (storno deductibila)'));
      return lines;
    },
  },
  {
    id: 'scont_acordat',
    nume: 'Scont de decontare acordat (client care plateste in avans)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.document, F.suma],
    build: (d) => [L('667', '4111', d.suma, 'Scont de decontare acordat')],
  },
  {
    id: 'scont_primit',
    nume: 'Scont de decontare obtinut (plata in avans catre furnizor)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.document, F.suma],
    build: (d) => [L('401', '767', d.suma, 'Scont de decontare obtinut')],
  },

  // ─────────────────────────── TREZORERIE ─────────────────────────
  {
    id: 'incasare_client',
    nume: 'Incasare de la client (chitanta / extras)',
    grup: 'Trezorerie',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasata in', type: 'select', options: TROZ, default: '5121' }, F.analiticBanca],
    build: (d) => [L(d.cont || '5121', '4111', d.suma, 'Incasare de la client')],
  },
  {
    id: 'plata_furnizor',
    nume: 'Plata catre furnizor (chitanta / extras / OP)',
    grup: 'Trezorerie',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platita din', type: 'select', options: TROZ, default: '5121' },
      { name: 'contFz', label: 'Cont furnizor', type: 'account', default: '401' }, F.analiticBanca],
    build: (d) => [L(d.contFz || '401', d.cont || '5121', d.suma, 'Plata catre furnizor')],
  },
  {
    id: 'depunere_numerar',
    nume: 'Depunere numerar la banca',
    grup: 'Trezorerie',
    fields: [F.data, F.document, F.suma],
    build: (d) => [
      L('581', '5311', d.suma, 'Ridicare numerar din casa - viramente interne'),
      L('5121', '581', d.suma, 'Depunere numerar in banca'),
    ],
  },
  {
    id: 'ridicare_numerar',
    nume: 'Ridicare numerar din banca',
    grup: 'Trezorerie',
    fields: [F.data, F.document, F.suma],
    build: (d) => [
      L('581', '5121', d.suma, 'Ridicare numerar din banca - viramente interne'),
      L('5311', '581', d.suma, 'Intrare numerar in casa'),
    ],
  },
  {
    id: 'comision_bancar',
    nume: 'Comision bancar (extras)',
    grup: 'Trezorerie',
    fields: [F.data, F.document, F.suma, F.analiticBanca],
    build: (d) => [L('627', '5121', d.suma, 'Cheltuieli cu serviciile bancare')],
  },

  // ─────────────────────────── SALARII ────────────────────────────
  {
    id: 'stat_plata',
    nume: 'Stat de plata salarii (calcul automat din brut)',
    grup: 'Salarii',
    fields: [
      F.data,
      { name: 'brut', label: 'Total salarii brute', type: 'number', required: true },
      { name: 'neimpozabil', label: 'Suma neimpozabila (ex. salariu minim)', type: 'number', default: 0 },
      { name: 'cas', label: 'CAS 25% (gol = auto)', type: 'number', default: 0 },
      { name: 'cass', label: 'CASS 10% (gol = auto)', type: 'number', default: 0 },
      { name: 'impozit', label: 'Impozit 10% (gol = auto)', type: 'number', default: 0 },
      { name: 'cam', label: 'CAM 2,25% (gol = auto)', type: 'number', default: 0 },
      F.analiticAngajat,
    ],
    build: (d) => {
      let { cas, cass, impozit, cam } = d;
      // daca toate contributiile sunt 0, se calculeaza automat din brut (cotele 2026)
      if (d.brut > 0 && !cas && !cass && !impozit && !cam) {
        const p = fiscal.payroll(d.brut, d.neimpozabil);
        cas = p.cas; cass = p.cass; impozit = p.impozit; cam = p.cam;
      }
      const lines = [L('641', '421', d.brut, 'Salarii brute datorate')];
      if (cas > 0) lines.push(L('421', '4315', cas, 'Retinere CAS 25%'));
      if (cass > 0) lines.push(L('421', '4316', cass, 'Retinere CASS 10%'));
      if (impozit > 0) lines.push(L('421', '444', impozit, 'Retinere impozit pe salarii 10%'));
      if (cam > 0) lines.push(L('646', '436', cam, 'CAM 2,25% (angajator)'));
      return lines;
    },
  },
  {
    id: 'plata_salarii',
    nume: 'Plata salarii nete',
    grup: 'Salarii',
    fields: [F.data, F.suma,
      { name: 'cont', label: 'Platita din', type: 'select', options: TROZ, default: '5121' }, F.analiticAngajat],
    build: (d) => [L('421', d.cont || '5121', d.suma, 'Plata salarii nete')],
  },
  {
    id: 'tichete_masa',
    nume: 'Tichete de masa acordate salariatilor',
    grup: 'Salarii',
    fields: [F.data, F.suma, F.analiticAngajat],
    build: (d) => [L('642', '5328', d.suma, 'Tichete de masa acordate')],
  },
  {
    id: 'concediu_medical_angajator',
    nume: 'Concediu medical - indemnizatie suportata de angajator (primele 5 zile)',
    grup: 'Salarii',
    fields: [F.data, F.suma, F.analiticAngajat],
    build: (d) => [L('6458', '423', d.suma, 'Indemnizatie concediu medical (angajator)')],
  },
  {
    id: 'concediu_medical_fnuass',
    nume: 'Concediu medical - indemnizatie suportata de FNUASS (de recuperat)',
    grup: 'Salarii',
    fields: [F.data, F.suma, F.analiticAngajat],
    build: (d) => [L('4373', '423', d.suma, 'Indemnizatie concediu medical (FNUASS - de recuperat)')],
  },
  {
    id: 'recuperare_fnuass',
    nume: 'Incasare indemnizatii concedii medicale de la FNUASS',
    grup: 'Salarii',
    fields: [F.data, F.suma,
      { name: 'cont', label: 'Incasata in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '4373', d.suma, 'Recuperare indemnizatii de la FNUASS')],
  },

  // ─────────────────────────── DIVERSE ────────────────────────────
  {
    id: 'amortizare',
    nume: 'Amortizare lunara mijloace fixe',
    grup: 'Diverse',
    fields: [F.data, F.suma,
      { name: 'contAmort', label: 'Cont amortizare', type: 'account', default: '281' }],
    build: (d) => [L('6811', d.contAmort || '281', d.suma, 'Amortizare lunara')],
  },
  {
    id: 'factura_storno_vanzare',
    nume: 'Factura storno/corectie emisa (in rosu)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'refFactura', label: 'Factura stornata (referinta)', type: 'text' },
      F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('4111', '707', -d.baza, 'Storno venit (in rosu)')];
      if (d.tva > 0) lines.push(L('4111', '4427', -d.tva, 'Storno TVA colectata'));
      return lines;
    },
  },
  {
    id: 'factura_storno_cumparare',
    nume: 'Factura storno/corectie primita (in rosu)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota,
      { name: 'contStoc', label: 'Cont stornat (stoc/cheltuiala)', type: 'account', default: '371' }],
    build: (d) => {
      const lines = [L(d.contStoc || '371', '401', -d.baza, 'Storno achizitie (in rosu)')];
      if (d.tva > 0) lines.push(L('4426', '401', -d.tva, 'Storno TVA deductibila'));
      return lines;
    },
  },
  {
    id: 'bon_consum',
    nume: 'Bon de consum (iesire materiale din stoc)',
    grup: 'Stocuri',
    fields: [F.data, F.document, F.suma,
      { name: 'contChelt', label: 'Cont cheltuiala', type: 'account', default: '601' },
      { name: 'contStoc', label: 'Cont stoc', type: 'account', default: '301' }],
    build: (d) => [L(d.contChelt || '601', d.contStoc || '301', d.suma, 'Consum din stoc (bon de consum)')],
  },
  {
    id: 'acordare_avans',
    nume: 'Acordare avans de trezorerie (catre angajat)',
    grup: 'Trezorerie',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Acordat din', type: 'select', options: TROZ, default: '5311' }],
    build: (d) => [L('542', d.cont || '5311', d.suma, 'Avans de trezorerie acordat')],
  },
  {
    id: 'decont_deplasare',
    nume: 'Decont cheltuieli deplasare/delegatie',
    grup: 'Diverse',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'contChelt', label: 'Cont cheltuiala', type: 'account', default: '625' },
      { name: 'cont', label: 'Acoperit din', type: 'select',
        options: [{ value: '542', label: '542 Avans de trezorerie' }, { value: '5311', label: '5311 Casa' }, { value: '5121', label: '5121 Banca' }], default: '542' }],
    build: (d) => [L(d.contChelt || '625', d.cont || '542', d.suma, 'Decont cheltuieli deplasare')],
  },
  {
    id: 'dobanda_bancara',
    nume: 'Dobanda bancara (extras)',
    grup: 'Trezorerie',
    fields: [F.data, F.document, F.suma, F.analiticBanca],
    build: (d) => [L('666', '5121', d.suma, 'Cheltuieli privind dobanzile')],
  },
  {
    id: 'import_vamal',
    nume: 'Import bunuri din afara UE (DVI)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document,
      { name: 'valoareBunuri', label: 'Valoarea in vama a bunurilor (lei)', type: 'number', required: true },
      { name: 'taxeVamale', label: 'Taxe vamale (lei)', type: 'number', default: 0 },
      { name: 'cota', label: 'Cota TVA in vama (%)', type: 'number', default: 21 },
      { name: 'contBun', label: 'Cont bunuri (stoc/imobilizare)', type: 'account', default: '371' }],
    build: (d) => {
      const baza = round2(d.valoareBunuri + (d.taxeVamale || 0));
      const tva = round2((baza * (Number(d.cota) || 21)) / 100);
      const lines = [L(d.contBun || '371', '401', d.valoareBunuri, 'Import - valoarea bunurilor')];
      if (d.taxeVamale > 0) lines.push(L(d.contBun || '371', '446', d.taxeVamale, 'Taxe vamale (in costul bunurilor)'));
      lines.push(L('4426', '446', tva, 'TVA in vama (deductibila)'));
      return lines;
    },
  },
  {
    id: 'diferente_inventar',
    nume: 'Diferente la inventariere (plus / minus)',
    grup: 'Stocuri',
    fields: [F.data, F.document, F.suma,
      { name: 'sens', label: 'Tip diferenta', type: 'select',
        options: [{ value: 'minus', label: 'Minus / lipsa la inventar' }, { value: 'plus', label: 'Plus la inventar' }], default: 'minus' },
      { name: 'contStoc', label: 'Cont stoc', type: 'account', default: '371' },
      { name: 'contChelt', label: 'Cont cheltuiala (clasa 6)', type: 'account', default: '607' }],
    build: (d) => {
      if (d.sens === 'plus') return [L(d.contStoc || '371', d.contChelt || '607', d.suma, 'Plus la inventar (diminuare cheltuieli)')];
      return [L(d.contChelt || '607', d.contStoc || '371', d.suma, 'Minus / lipsa la inventar')];
    },
  },
  {
    id: 'imputare_lipsa',
    nume: 'Imputare lipsa la inventar (catre gestionar)',
    grup: 'Stocuri',
    fields: [F.data, F.partener, F.document,
      { name: 'valoareImputata', label: 'Valoare imputata (fara TVA)', type: 'number', required: true },
      { name: 'cota', label: 'Cota TVA (%)', type: 'number', default: 21 },
      { name: 'contCreanta', label: 'Cont creanta', type: 'select',
        options: [{ value: '4282', label: '4282 Alte creante personal' }, { value: '461', label: '461 Debitori diversi' }], default: '4282' }],
    build: (d) => {
      const tva = round2((d.valoareImputata * (Number(d.cota) || 21)) / 100);
      const o = [L(d.contCreanta || '4282', '7588', d.valoareImputata, 'Imputare lipsa la inventar - venit')];
      if (tva > 0) o.push(L(d.contCreanta || '4282', '4427', tva, 'TVA aferenta imputarii'));
      return o;
    },
  },
  {
    id: 'plata_taxe',
    nume: 'Plata taxe/impozite/TVA catre buget (sau vama)',
    grup: 'Trezorerie',
    fields: [F.data, F.document, F.suma,
      { name: 'contTaxa', label: 'Cont datorie (446, 4423, 444, 436, 4411...)', type: 'account', default: '446' },
      { name: 'cont', label: 'Platita din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.contTaxa || '446', d.cont || '5121', d.suma, 'Plata taxe/impozite catre buget')],
  },
  {
    id: 'casare_mijloc_fix',
    nume: 'Casare / scoatere din uz mijloc fix',
    grup: 'Diverse',
    fields: [F.data, F.document,
      { name: 'contImob', label: 'Cont imobilizare', type: 'account', default: '2131' },
      { name: 'valoare', label: 'Valoare de intrare', type: 'number', required: true },
      { name: 'amortizare', label: 'Amortizare cumulata', type: 'number', default: 0 },
      { name: 'contAmort', label: 'Cont amortizare', type: 'account', default: '281' }],
    build: (d) => {
      const ramas = round2(d.valoare - (d.amortizare || 0));
      const lines = [];
      if (d.amortizare > 0) lines.push(L(d.contAmort || '281', d.contImob || '2131', d.amortizare, 'Scaderea amortizarii cumulate'));
      if (ramas > 0) lines.push(L('6583', d.contImob || '2131', ramas, 'Valoarea ramasa neamortizata'));
      return lines;
    },
  },
  {
    id: 'avans_incasat_client',
    nume: 'Avans incasat de la client (419)',
    grup: 'Trezorerie',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasat in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '419', d.suma, 'Avans incasat de la client')],
  },
  {
    id: 'avans_platit_furnizor',
    nume: 'Avans platit catre furnizor (409)',
    grup: 'Trezorerie',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L('409', d.cont || '5121', d.suma, 'Avans platit catre furnizor')],
  },
  // ─────────────────── CONSTRUCTII ───────────────────
  {
    id: 'lucrari_in_curs',
    nume: 'Lucrari/servicii in curs de executie (332)',
    grup: 'Constructii',
    fields: [F.data, F.document, F.suma,
      { name: 'sens', label: 'Operatiune', type: 'select',
        options: [{ value: 'inreg', label: 'Inregistrare lucrari in curs (332=712)' }, { value: 'reluare', label: 'Reluare la facturare (712=332)' }], default: 'inreg' }],
    build: (d) => d.sens === 'reluare'
      ? [L('712', '332', d.suma, 'Reluarea lucrarilor in curs la facturare')]
      : [L('332', '712', d.suma, 'Lucrari in curs de executie')],
  },
  {
    id: 'garantie_retinuta',
    nume: 'Garantie de buna executie retinuta de beneficiar (2678)',
    grup: 'Constructii',
    fields: [F.data, F.partener, F.document, F.suma],
    build: (d) => [L('2678', '4111', d.suma, 'Garantie de buna executie retinuta')],
  },
  {
    id: 'garantie_restituita',
    nume: 'Restituire garantie de buna executie',
    grup: 'Constructii',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasata in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '2678', d.suma, 'Restituire garantie de buna executie')],
  },
  // ─────────────────── HoReCa (pret de vanzare cu amanuntul) ───────────────────
  {
    id: 'horeca_intrare',
    nume: 'HoReCa: intrare marfa la pret de vanzare (371/378/4428)',
    grup: 'HoReCa',
    fields: [F.data, F.partener, F.document,
      { name: 'cost', label: 'Cost achizitie (fara TVA)', type: 'number', required: true },
      { name: 'tvaDed', label: 'TVA deductibila la achizitie', type: 'number', default: 0 },
      { name: 'adaos', label: 'Adaos comercial', type: 'number', default: 0 },
      { name: 'cotaVanzare', label: 'Cota TVA la vanzare (%)', type: 'number', default: fiscal.FISCAL.tvaRedus }],
    build: (d) => {
      const lines = [L('371', '401', d.cost, 'Intrare marfa la cost')];
      if (d.tvaDed > 0) lines.push(L('4426', '401', d.tvaDed, 'TVA deductibila'));
      if (d.adaos > 0) lines.push(L('371', '378', d.adaos, 'Adaos comercial'));
      const tvaNeexig = round2(((d.cost + d.adaos) * Number(d.cotaVanzare || fiscal.FISCAL.tvaRedus)) / 100);
      if (tvaNeexig > 0) lines.push(L('371', '4428', tvaNeexig, 'TVA neexigibila (pret de vanzare)'));
      return lines;
    },
  },
  {
    id: 'horeca_vanzare',
    nume: 'HoReCa: vanzare amanunt + descarcare gestiune',
    grup: 'HoReCa',
    fields: [F.data, F.document,
      { name: 'numerar', label: 'Incasare numerar (cu TVA)', type: 'number', default: 0 },
      { name: 'card', label: 'Incasare card (cu TVA)', type: 'number', default: 0 },
      { name: 'cota', label: 'Cota TVA (%)', type: 'number', default: fiscal.FISCAL.tvaRedus },
      { name: 'cost', label: 'Cost marfa vanduta', type: 'number', default: 0 },
      { name: 'adaos', label: 'Adaos aferent vanzarii', type: 'number', default: 0 }],
    build: (d) => {
      const lines = [];
      if (d.numerar > 0) lines.push(L('5311', '707', d.numerar, 'Incasare numerar'));
      if (d.card > 0) lines.push(L('5121', '707', d.card, 'Incasare card'));
      const totalInc = round2(d.numerar + d.card);
      const cota = Number(d.cota || fiscal.FISCAL.tvaRedus);
      const tvaColectata = round2((totalInc * cota) / (100 + cota));
      if (tvaColectata > 0) lines.push(L('4428', '4427', tvaColectata, 'TVA colectata (din neexigibila)'));
      if (d.cost > 0) lines.push(L('607', '371', d.cost, 'Descarcare gestiune - cost'));
      if (d.adaos > 0) lines.push(L('378', '371', d.adaos, 'Descarcare gestiune - adaos'));
      return lines;
    },
  },
  // ─────────────────── COMERT INTRACOMUNITAR / VALUTA ───────────────────
  {
    id: 'diferenta_curs',
    nume: 'Diferenta de curs valutar (favorabila / nefavorabila)',
    grup: 'Cumparari',
    fields: [F.data, F.document, F.suma,
      { name: 'sens', label: 'Tip diferenta', type: 'select',
        options: [{ value: 'favorabila', label: 'Favorabila (venit 765)' }, { value: 'nefavorabila', label: 'Nefavorabila (cheltuiala 665)' }], default: 'favorabila' },
      { name: 'contTert', label: 'Cont trezorerie/tert', type: 'account', default: '5124' }],
    build: (d) => d.sens === 'nefavorabila'
      ? [L('665', d.contTert || '401', d.suma, 'Diferenta de curs nefavorabila')]
      : [L(d.contTert || '5124', '765', d.suma, 'Diferenta de curs favorabila')],
  },
  {
    id: 'incasare_numerar_valuta',
    nume: 'Incasare numerar in valuta (casa 5314)',
    grup: 'Trezorerie',
    fields: [F.data, F.document,
      { name: 'moneda', label: 'Moneda (EUR, USD...)', type: 'text', default: 'EUR', required: true },
      { name: 'sumaValuta', label: 'Suma in valuta', type: 'number', required: true },
      { name: 'curs', label: 'Curs valutar (lei/valuta)', type: 'number', required: true },
      { name: 'contraparte', label: 'Provine din contul', type: 'select',
        options: [{ value: '4111', label: '4111 Clienti' }, { value: '461', label: '461 Debitori diversi' }, { value: '5124', label: '5124 Banca in valuta' }, { value: '455', label: '455 Asociati / actionari' }], default: '4111' },
      F.explicatie],
    build: (d) => [L('5314', d.contraparte || '4111', round2((Number(d.sumaValuta) || 0) * (Number(d.curs) || 0)), 'Incasare numerar in valuta ' + (d.moneda || ''))],
  },
  {
    id: 'plata_numerar_valuta',
    nume: 'Plata numerar in valuta (casa 5314)',
    grup: 'Trezorerie',
    fields: [F.data, F.document,
      { name: 'moneda', label: 'Moneda (EUR, USD...)', type: 'text', default: 'EUR', required: true },
      { name: 'sumaValuta', label: 'Suma in valuta', type: 'number', required: true },
      { name: 'curs', label: 'Curs valutar (lei/valuta)', type: 'number', required: true },
      { name: 'contraparte', label: 'Se plateste catre contul', type: 'select',
        options: [{ value: '401', label: '401 Furnizori' }, { value: '462', label: '462 Creditori diversi' }, { value: '542', label: '542 Avansuri de trezorerie' }, { value: '455', label: '455 Asociati / actionari' }], default: '401' },
      F.explicatie],
    build: (d) => [L(d.contraparte || '401', '5314', round2((Number(d.sumaValuta) || 0) * (Number(d.curs) || 0)), 'Plata numerar in valuta ' + (d.moneda || ''))],
  },
  // ─────────────────── TRANSPORT ───────────────────
  {
    id: 'combustibil_50',
    nume: 'Combustibil cu TVA deductibila 50% (vehicul limitat)',
    grup: 'Cumparari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.cota],
    build: (d) => {
      const tvaTotal = round2((d.baza * Number(d.cota || fiscal.FISCAL.tvaStandard)) / 100);
      const tvaDed = round2(tvaTotal * fiscal.FISCAL.deductibilitateTvaAutoLimitat / 100);
      const tvaNed = round2(tvaTotal - tvaDed);
      const lines = [L('6022', '401', d.baza, 'Cheltuieli combustibili')];
      if (tvaDed > 0) lines.push(L('4426', '401', tvaDed, 'TVA deductibila 50%'));
      if (tvaNed > 0) lines.push(L('6022', '401', tvaNed, 'TVA nedeductibila 50% (in cheltuiala)'));
      return lines;
    },
  },
  {
    id: 'taxe_drum',
    nume: 'Rovinieta / taxe de drum (635)',
    grup: 'Diverse',
    fields: [F.data, F.document, F.suma],
    build: (d) => [L('635', '446', d.suma, 'Rovinieta / taxe de drum')],
  },
  {
    id: 'nota_contabila',
    nume: 'Nota contabila libera (debit = credit)',
    grup: 'Diverse',
    fields: [F.data, F.explicatie,
      { name: 'debit', label: 'Cont debitor', type: 'account', required: true },
      { name: 'credit', label: 'Cont creditor', type: 'account', required: true },
      F.suma],
    build: (d) => [L(d.debit, d.credit, d.suma, d.explicatie || 'Nota contabila')],
  },

  // ───────────────────── TVA LA INCASARE (regim special, 4428) ─────────────────────
  {
    id: 'factura_vanzare_incasare',
    nume: 'Factura vanzare (TVA la incasare)',
    grup: 'TVA la incasare',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota,
      { name: 'contVenit', label: 'Cont de venit', type: 'account', default: '707' }],
    build: (d) => {
      const lines = [L('4111', d.contVenit || '707', d.baza, 'Venituri (factura emisa)')];
      if (d.tva > 0) lines.push(L('4111', '4428', d.tva, 'TVA neexigibila (la incasare)'));
      return lines;
    },
  },
  {
    id: 'factura_cumparare_incasare',
    nume: 'Factura cumparare (TVA la incasare)',
    grup: 'TVA la incasare',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota,
      { name: 'contCheltStoc', label: 'Cont cheltuiala/stoc', type: 'account', default: '371' }],
    build: (d) => {
      const lines = [L(d.contCheltStoc || '371', '401', d.baza, 'Achizitie (factura primita)')];
      if (d.tva > 0) lines.push(L('4428', '401', d.tva, 'TVA neexigibila deductibila (la plata)'));
      return lines;
    },
  },
  {
    id: 'exigibilitate_tva_colectata',
    nume: 'Exigibilitate TVA colectata (la incasare factura)',
    grup: 'TVA la incasare',
    fields: [F.data, F.partener, F.document, { name: 'tva', label: 'TVA devenita exigibila', type: 'number', required: true }],
    build: (d) => [L('4428', '4427', d.tva, 'TVA colectata devenita exigibila la incasare')],
  },
  {
    id: 'exigibilitate_tva_deductibila',
    nume: 'Exigibilitate TVA deductibila (la plata factura)',
    grup: 'TVA la incasare',
    fields: [F.data, F.partener, F.document, { name: 'tva', label: 'TVA devenita exigibila', type: 'number', required: true }],
    build: (d) => [L('4426', '4428', d.tva, 'TVA deductibila devenita exigibila la plata')],
  },

  // ───────────────────────── LEASING FINANCIAR ─────────────────────────
  {
    id: 'leasing_intrare',
    nume: 'Intrare imobilizare in leasing financiar',
    grup: 'Leasing',
    fields: [F.data, F.partener, F.document,
      { name: 'contImob', label: 'Cont imobilizare (2131/2133...)', type: 'account', default: '2133' },
      { name: 'valoare', label: 'Valoarea finantata (fara TVA)', type: 'number', required: true }],
    build: (d) => [L(d.contImob || '2133', '167', d.valoare, 'Imobilizare in leasing financiar + datorie')],
  },
  {
    id: 'factura_leasing',
    nume: 'Factura rata de leasing (principal + dobanda + TVA)',
    grup: 'Leasing',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document,
      { name: 'principal', label: 'Principal (rata capital, 167)', type: 'number', required: true },
      { name: 'dobanda', label: 'Dobanda (666)', type: 'number', default: 0 },
      F.tva, F.cota],
    build: (d) => {
      const lines = [L('167', '404', d.principal, 'Rata de capital leasing')];
      if (d.dobanda > 0) lines.push(L('666', '404', d.dobanda, 'Dobanda leasing'));
      if (d.tva > 0) lines.push(L('4426', '404', d.tva, 'TVA deductibila aferenta ratei'));
      return lines;
    },
  },
  {
    id: 'plata_leasing',
    nume: 'Plata rata de leasing',
    grup: 'Leasing',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L('404', d.cont || '5121', d.suma, 'Plata rata de leasing')],
  },

  // ───────────────────── IMOBILIZARI IN CURS (231) ─────────────────────
  {
    id: 'imobilizare_in_curs',
    nume: 'Imobilizare in curs - achizitie (231 = 404)',
    grup: 'Imobilizari',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('231', '404', d.baza, 'Imobilizare corporala in curs de executie')];
      if (d.tva > 0) lines.push(L('4426', '404', d.tva, 'TVA deductibila'));
      return lines;
    },
  },
  {
    id: 'imobilizare_in_curs_productie',
    nume: 'Imobilizare in curs - productie proprie (231 = 722)',
    grup: 'Imobilizari',
    fields: [F.data, F.document, { name: 'valoare', label: 'Cost productie (fara TVA)', type: 'number', required: true }],
    build: (d) => [L('231', '722', d.valoare, 'Productie de imobilizari in regie proprie')],
  },
  {
    id: 'punere_in_functiune',
    nume: 'Punere in functiune (21x = 231)',
    grup: 'Imobilizari',
    fields: [F.data, F.document,
      { name: 'contImob', label: 'Cont imobilizare (2131/212...)', type: 'account', default: '2131' },
      { name: 'valoare', label: 'Valoarea de intrare', type: 'number', required: true }],
    build: (d) => [L(d.contImob || '2131', '231', d.valoare, 'Receptie si punere in functiune')],
  },
  {
    id: 'reevaluare_plus',
    nume: 'Reevaluare imobilizare - plus de valoare (21x = 105)',
    grup: 'Imobilizari',
    fields: [F.data, F.document,
      { name: 'contImob', label: 'Cont imobilizare', type: 'account', default: '212' },
      { name: 'valoare', label: 'Plus de valoare (lei)', type: 'number', required: true }],
    build: (d) => [L(d.contImob || '212', '105', d.valoare, 'Plus din reevaluare (rezerva)')],
  },
  {
    id: 'reevaluare_minus',
    nume: 'Reevaluare imobilizare - minus de valoare',
    grup: 'Imobilizari',
    fields: [F.data, F.document,
      { name: 'contImob', label: 'Cont imobilizare', type: 'account', default: '212' },
      { name: 'dinRezerva', label: 'Acoperit din rezerva 105 (lei)', type: 'number', default: 0 },
      { name: 'peCheltuiala', label: 'Pe cheltuiala 655 (lei)', type: 'number', default: 0 }],
    build: (d) => {
      const lines = [];
      if (d.dinRezerva > 0) lines.push(L('105', d.contImob || '212', d.dinRezerva, 'Minus din reevaluare (din rezerva)'));
      if (d.peCheltuiala > 0) lines.push(L('655', d.contImob || '212', d.peCheltuiala, 'Minus din reevaluare (cheltuiala)'));
      return lines;
    },
  },

  // ───────────────────── VALUTA / DIFERENTE DE CURS ─────────────────────
  {
    id: 'factura_vanzare_valuta',
    nume: 'Factura vanzare in valuta (export/intracom)',
    grup: 'Valuta',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'valuta', label: 'Suma in valuta', type: 'number', required: true },
      { name: 'curs', label: 'Curs valutar (lei/valuta)', type: 'number', required: true },
      { name: 'contVenit', label: 'Cont de venit', type: 'account', default: '707' }],
    build: (d) => [L('4111', d.contVenit || '707', round2((Number(d.valuta) || 0) * (Number(d.curs) || 0)), 'Factura in valuta (scutita de TVA)')],
  },
  {
    id: 'diferenta_curs_favorabila',
    nume: 'Diferenta de curs favorabila (castig, 765)',
    grup: 'Valuta',
    fields: [F.data, F.partener, F.document,
      { name: 'cont', label: 'Cont in valuta (4111/401/5124...)', type: 'select', options: TVAL, default: '4111' },
      { name: 'suma', label: 'Diferenta favorabila (lei)', type: 'number', required: true }],
    build: (d) => [L(d.cont || '4111', '765', d.suma, 'Diferenta de curs valutar favorabila')],
  },
  {
    id: 'diferenta_curs_nefavorabila',
    nume: 'Diferenta de curs nefavorabila (pierdere, 665)',
    grup: 'Valuta',
    fields: [F.data, F.partener, F.document,
      { name: 'cont', label: 'Cont in valuta (4111/401/5124...)', type: 'select', options: TVAL, default: '401' },
      { name: 'suma', label: 'Diferenta nefavorabila (lei)', type: 'number', required: true }],
    build: (d) => [L('665', d.cont || '401', d.suma, 'Diferenta de curs valutar nefavorabila')],
  },

  // ───────────────────── PROVIZIOANE (151) ─────────────────────
  {
    id: 'provizion_constituire',
    nume: 'Constituire provizion pentru riscuri si cheltuieli (6812 = 151)',
    grup: 'Provizioane',
    fields: [F.data, F.document, F.explicatie, { name: 'suma', label: 'Suma provizionului', type: 'number', required: true }],
    build: (d) => [L('6812', '151', d.suma, d.explicatie || 'Constituire provizion pentru riscuri si cheltuieli')],
  },
  {
    id: 'provizion_reluare',
    nume: 'Reluare/anulare provizion (151 = 7812)',
    grup: 'Provizioane',
    fields: [F.data, F.document, F.explicatie, { name: 'suma', label: 'Suma reluata', type: 'number', required: true }],
    build: (d) => [L('151', '7812', d.suma, d.explicatie || 'Reluare provizion devenit fara obiect')],
  },

  // ───────────────────── ASOCIATI / DECONTARI INTRAGRUP ─────────────────────
  {
    id: 'imprumut_asociat',
    nume: 'Imprumut primit de la asociat (5xx = 455)',
    grup: 'Asociati / Grup',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasat in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '455', d.suma, 'Imprumut de la asociat (cont curent)')],
  },
  {
    id: 'restituire_asociat',
    nume: 'Restituire imprumut catre asociat (455 = 5xx)',
    grup: 'Asociati / Grup',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L('455', d.cont || '5121', d.suma, 'Restituire imprumut catre asociat')],
  },
  {
    id: 'dobanda_asociat',
    nume: 'Dobanda datorata asociatului (666 = 4558/455)',
    grup: 'Asociati / Grup',
    fields: [F.data, F.partener, F.document, { name: 'suma', label: 'Dobanda (lei)', type: 'number', required: true }],
    build: (d) => [L('666', '455', d.suma, 'Dobanda aferenta imprumutului de la asociat')],
  },
  {
    id: 'decontare_intragrup',
    nume: 'Decontare intre unitate si subunitati (481)',
    grup: 'Asociati / Grup',
    fields: [F.data, F.partener, F.document, F.explicatie,
      { name: 'sens', label: 'Sens', type: 'select', options: [{ value: 'creanta', label: 'Creanta (481 debitor)' }, { value: 'datorie', label: 'Datorie (481 creditor)' }], default: 'creanta' },
      { name: 'cont', label: 'Cont corespondent (5121/...)', type: 'account', default: '5121' }, F.suma],
    build: (d) => (d.sens === 'datorie'
      ? [L(d.cont || '5121', '481', d.suma, 'Decontare intragrup - incasare')]
      : [L('481', d.cont || '5121', d.suma, 'Decontare intragrup - plata')]),
  },

  // ───────────────────── DIVIDENDE ─────────────────────
  {
    id: 'repartizare_dividende',
    nume: 'Repartizare profit la dividende (117 = 457) + impozit',
    grup: 'Dividende',
    fields: [F.data, F.document,
      { name: 'brut', label: 'Dividende brute', type: 'number', required: true },
      { name: 'cota', label: 'Cota impozit dividende (%)', type: 'number', default: fiscal.FISCAL.impozitDividende },
      { name: 'contSursa', label: 'Sursa (117 reportat / 121 curent)', type: 'select', options: [{ value: '117', label: '117 Rezultat reportat' }, { value: '121', label: '121 Profit curent' }], default: '117' }],
    build: (d) => {
      const impozit = round2((Number(d.brut) || 0) * (Number(d.cota) || 0) / 100);
      const lines = [L(d.contSursa || '117', '457', d.brut, 'Repartizare profit la dividende')];
      if (impozit > 0) lines.push(L('457', '446', impozit, 'Impozit pe dividende retinut la sursa'));
      return lines;
    },
  },
  {
    id: 'plata_dividende',
    nume: 'Plata dividende nete (457 = 5xx)',
    grup: 'Dividende',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L('457', d.cont || '5121', d.suma, 'Plata dividende nete')],
  },

  // ───────────────────── SUBVENTII ─────────────────────
  {
    id: 'subventie_exploatare',
    nume: 'Subventie de exploatare - de incasat (445 = 741)',
    grup: 'Subventii',
    fields: [F.data, F.partener, F.document, { name: 'suma', label: 'Suma subventiei', type: 'number', required: true }],
    build: (d) => [L('445', '741', d.suma, 'Subventie de exploatare cuvenita')],
  },
  {
    id: 'subventie_investitii',
    nume: 'Subventie pentru investitii - de incasat (445 = 475)',
    grup: 'Subventii',
    fields: [F.data, F.partener, F.document, { name: 'suma', label: 'Suma subventiei', type: 'number', required: true }],
    build: (d) => [L('445', '475', d.suma, 'Subventie pentru investitii (venit in avans)')],
  },
  {
    id: 'incasare_subventie',
    nume: 'Incasare subventie (5xx = 445)',
    grup: 'Subventii',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasat in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '445', d.suma, 'Incasare subventie')],
  },
  {
    id: 'venit_subventie_investitii',
    nume: 'Recunoastere venit subventie investitii (475 = 7584)',
    grup: 'Subventii',
    fields: [F.data, F.document, { name: 'suma', label: 'Cota-parte (de obicei = amortizarea lunii)', type: 'number', required: true }],
    build: (d) => [L('475', '7584', d.suma, 'Venit din subventie pentru investitii (esalonat)')],
  },

  // ───────────────────── CHELTUIELI / VENITURI IN AVANS (471/472) ─────────────────────
  {
    id: 'cheltuiala_in_avans',
    nume: 'Cheltuiala in avans - inregistrare (471 = 401/5xx)',
    grup: 'Regularizari',
    fields: [F.data, F.partener, F.document, F.explicatie,
      { name: 'cont', label: 'Contrapartida', type: 'select', options: [{ value: '401', label: '401 Furnizori' }, { value: '5121', label: '5121 Banca' }, { value: '5311', label: '5311 Casa' }], default: '401' },
      { name: 'suma', label: 'Suma totala platita in avans', type: 'number', required: true }],
    build: (d) => [L('471', d.cont || '401', d.suma, d.explicatie || 'Cheltuiala inregistrata in avans')],
  },
  {
    id: 'recunoastere_cheltuiala_avans',
    nume: 'Recunoastere cheltuiala din avans (6xx = 471)',
    grup: 'Regularizari',
    fields: [F.data, F.document, F.explicatie,
      { name: 'contChelt', label: 'Cont de cheltuiala (6xx)', type: 'account', default: '613' },
      { name: 'suma', label: 'Cota-parte a perioadei', type: 'number', required: true }],
    build: (d) => [L(d.contChelt || '613', '471', d.suma, d.explicatie || 'Cota de cheltuiala din avans')],
  },
  {
    id: 'venit_in_avans',
    nume: 'Venit in avans - inregistrare (4111/5xx = 472)',
    grup: 'Regularizari',
    fields: [F.data, F.partener, F.document, F.explicatie,
      { name: 'cont', label: 'Contrapartida', type: 'select', options: [{ value: '4111', label: '4111 Clienti' }, { value: '5121', label: '5121 Banca' }, { value: '5311', label: '5311 Casa' }], default: '4111' },
      { name: 'suma', label: 'Suma totala incasata in avans', type: 'number', required: true }],
    build: (d) => [L(d.cont || '4111', '472', d.suma, d.explicatie || 'Venit inregistrat in avans')],
  },
  {
    id: 'recunoastere_venit_avans',
    nume: 'Recunoastere venit din avans (472 = 7xx)',
    grup: 'Regularizari',
    fields: [F.data, F.document, F.explicatie,
      { name: 'contVenit', label: 'Cont de venit (7xx)', type: 'account', default: '704' },
      { name: 'suma', label: 'Cota-parte a perioadei', type: 'number', required: true }],
    build: (d) => [L('472', d.contVenit || '704', d.suma, d.explicatie || 'Cota de venit din avans')],
  },

  // ───────────────── EFECTE DE COMERT SI ACREDITIVE ─────────────────
  {
    id: 'efect_primit_client',
    nume: 'Efect de primit de la client (bilet la ordin / cambie acceptata)',
    grup: 'Efecte de comert',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.suma],
    build: (d) => [L('413', '4111', d.suma, 'Acceptare efect de comert de la client (413 = 4111)')],
  },
  {
    id: 'incasare_efect_client',
    nume: 'Incasare efect de comert la scadenta',
    grup: 'Efecte de comert',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Incasat in', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L(d.cont || '5121', '413', d.suma, 'Incasare efect de comert la scadenta')],
  },
  {
    id: 'scontare_efect',
    nume: 'Scontare efect la banca (incasare inainte de scadenta)',
    grup: 'Efecte de comert',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'scont', label: 'Taxa de scont + comision bancar (lei)', type: 'number', default: 0 }],
    build: (d) => {
      const net = round2((d.suma || 0) - (d.scont || 0));
      const lines = [];
      if (net > 0) lines.push(L('5121', '413', net, 'Suma neta incasata din scontarea efectului'));
      if (d.scont > 0) lines.push(L('627', '413', d.scont, 'Taxa de scont si comisioane bancare'));
      return lines;
    },
  },
  {
    id: 'efect_platit_furnizor',
    nume: 'Efect de platit catre furnizor (bilet la ordin emis / cambie acceptata)',
    grup: 'Efecte de comert',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.suma],
    build: (d) => [L('401', '403', d.suma, 'Acceptare efect de plata catre furnizor (401 = 403)')],
  },
  {
    id: 'plata_efect_furnizor',
    nume: 'Plata efect de comert la scadenta',
    grup: 'Efecte de comert',
    fields: [F.data, F.partener, F.document, F.suma,
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => [L('403', d.cont || '5121', d.suma, 'Plata efect de comert la scadenta')],
  },
  {
    id: 'deschidere_acreditiv',
    nume: 'Deschidere acreditiv (blocare fonduri la banca)',
    grup: 'Acreditive',
    fields: [F.data, F.partener, F.document, F.suma],
    build: (d) => [L('541', '5121', d.suma, 'Deschidere acreditiv (541 = 5121)')],
  },
  {
    id: 'plata_din_acreditiv',
    nume: 'Plata furnizor din acreditiv',
    grup: 'Acreditive',
    fields: [F.data, F.partener, F.cuiFurnizor, F.document, F.suma],
    build: (d) => [L('401', '541', d.suma, 'Plata furnizor din acreditiv (401 = 541)')],
  },
  {
    id: 'inchidere_acreditiv',
    nume: 'Inchidere acreditiv (restituire sold neutilizat)',
    grup: 'Acreditive',
    fields: [F.data, F.document, F.suma],
    build: (d) => [L('5121', '541', d.suma, 'Restituire sold acreditiv neutilizat (5121 = 541)')],
  },

  // ───────────── IMPOZIT RETINUT LA SURSA (pentru D205) ─────────────
  {
    id: 'chirie_pf',
    nume: 'Chirie platita unei persoane fizice (impozit retinut la sursa, D205)',
    grup: 'Retineri la sursa',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'baza', label: 'Chirie bruta (lei)', type: 'number', required: true },
      { name: 'cota', label: 'Cota impozit (%)', type: 'number', default: 10 },
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5121' }],
    build: (d) => {
      const impozit = round2((d.baza || 0) * (d.cota || 10) / 100);
      const net = round2((d.baza || 0) - impozit);
      const lines = [];
      if (net > 0) lines.push(L('612', d.cont || '5121', net, 'Chirie platita persoanei fizice (net)'));
      if (impozit > 0) lines.push(L('612', '446', impozit, 'Impozit pe chirie retinut la sursa'));
      return lines;
    },
  },
  {
    id: 'premiu_pf',
    nume: 'Premiu acordat unei persoane fizice (impozit retinut la sursa, D205)',
    grup: 'Retineri la sursa',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'baza', label: 'Premiu brut (lei)', type: 'number', required: true },
      { name: 'cota', label: 'Cota impozit (%)', type: 'number', default: 10 },
      { name: 'cont', label: 'Platit din', type: 'select', options: TROZ, default: '5311' }],
    build: (d) => {
      const impozit = round2((d.baza || 0) * (d.cota || 10) / 100);
      const net = round2((d.baza || 0) - impozit);
      const lines = [];
      if (net > 0) lines.push(L('623', d.cont || '5311', net, 'Premiu acordat persoanei fizice (net)'));
      if (impozit > 0) lines.push(L('623', '446', impozit, 'Impozit pe premii retinut la sursa'));
      return lines;
    },
  },

  // ───────────── AVIZE SI FACTURI SIMPLIFICATE ─────────────
  {
    id: 'aviz_livrare',
    nume: 'Aviz de insotire a marfii (livrare neînfacturata)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.stoc],
    build: (d) => [L('418', '707', d.baza, 'Livrare pe aviz - clienti, facturi de intocmit (418 = 707)')],
  },
  {
    id: 'facturare_aviz',
    nume: 'Facturare ulterioara aviz (transforma avizul in factura)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document,
      { name: 'refFactura', label: 'Aviz facturat (referinta)', type: 'text' },
      F.baza, F.tva, F.cota],
    build: (d) => {
      const lines = [L('4111', '418', d.baza, 'Facturare aviz - creanta ferma (4111 = 418)')];
      if (d.tva > 0) lines.push(L('4111', '4427', d.tva, 'TVA colectata la facturarea avizului'));
      return lines;
    },
  },
  {
    id: 'factura_simplificata',
    nume: 'Factura simplificata (art. 319 Cod fiscal, sub 100 EUR)',
    grup: 'Vanzari',
    fields: [F.data, F.partener, F.cuiPartener, F.document, F.baza, F.tva, F.cota,
      { name: 'cont', label: 'Incasata in / pe credit (4111)', type: 'select', options: [{ value: '4111', label: '4111 Clienti (pe credit)' }, { value: '5311', label: '5311 Casa in lei' }, { value: '5121', label: '5121 Banca in lei' }], default: '5311' },
      F.stoc],
    build: (d) => {
      const cont = d.cont || '5311';
      const lines = [L(cont, '707', d.baza, 'Vanzare pe factura simplificata')];
      if (d.tva > 0) lines.push(L(cont, '4427', d.tva, 'TVA colectata (factura simplificata)'));
      return lines;
    },
  },
];

const BY_ID = new Map(TYPES.map((t) => [t.id, t]));

function getType(id) {
  return BY_ID.get(id);
}

/** Versiune "slim" pentru frontend (fara functia build). */
function typesForClient() {
  return TYPES.map((t) => ({ id: t.id, nume: t.nume, grup: t.grup, fields: t.fields }));
}

module.exports = { TYPES, getType, typesForClient };
