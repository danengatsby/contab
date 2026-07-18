'use strict';

const db = require('./db');
const { getType } = require('./documentTypes');
const { round2, period: periodOf } = require('./util');

const FID = 1; // firma demonstrativa

/** Construieste un entry dintr-un tip + campuri (acelasi mecanism ca la API). */
function make(tipId, fields, nid) {
  const type = getType(tipId);
  const f = Object.assign({}, fields);
  for (const fld of type.fields) if (fld.type === 'number') f[fld.name] = round2(parseFloat(f[fld.name]) || 0);
  const lines = type.build(f).filter((l) => l.suma > 0);
  const data = f.data;
  return {
    id: nid(), firmaId: FID, data, period: periodOf(data),
    tip: tipId, tipNume: type.nume, partener: f.partener || '', partenerCui: f.cuiPartener || '', document: f.document || '',
    analitic: f.analitic || '', explicatie: f.explicatie || '', fileId: null, system: false, lines,
  };
}

const SPEC = [
  ['factura_cumparare_marfuri', { data: '2026-06-10', partener: 'ALFA DISTRIBUTIE SRL', cuiPartener: 'RO11223344', document: 'AFD 1001', baza: 10000, tva: 2100, cota: 21 }],
  ['factura_vanzare_marfuri', { data: '2026-06-15', partener: 'BETA RETAIL SRL', cuiPartener: 'RO99887766', document: 'EXP 2001', baza: 14000, tva: 2940, cota: 21, cost: 8000 }],
  ['incasare_client', { data: '2026-06-15', partener: 'BETA RETAIL SRL', document: 'CH 17', suma: 16940, cont: '5311' }],
  ['plata_furnizor', { data: '2026-06-20', partener: 'ALFA DISTRIBUTIE SRL', document: 'OP 44', suma: 12100, cont: '5121', contFz: '401' }],
  ['stat_plata', { data: '2026-06-30', brut: 5000 }],
  ['plata_salarii', { data: '2026-06-30', suma: 2925, cont: '5121' }],
  ['amortizare', { data: '2026-06-30', suma: 200, contAmort: '281' }],
];

/** Datele exemplului integrat din ghid (firma 1), pure — fara a atinge baza de date. */
function buildSeedData(nextEntryId) {
  let i = 0;
  const nid = nextEntryId || (() => 'e' + (++i));
  return {
    firme: [{
      id: FID, nume: 'S.C. EXEMPLU PROD S.R.L.', cui: '12345674',
      regCom: 'J40/1234/2020', adresa: 'Str. Exemplu nr. 1, sector 1', oras: 'Bucuresti', judet: 'RO-B', tvaPlatitor: true,
      caen: '1071', perioadaTva: 'L', iban: 'RO49AAAA1B31007593840000', banca: 'Banca Exemplu',
    }],
    partners: {
      [FID]: {
        '99887766': { cui: '99887766', den: 'BETA RETAIL SRL', adresa: 'Bd. Clientului 5', oras: 'Cluj-Napoca', judet: 'RO-CJ', tara: 'RO' },
        '11223344': { cui: '11223344', den: 'ALFA DISTRIBUTIE SRL', adresa: 'Str. Furnizorului 10', oras: 'Timisoara', judet: 'RO-TM', tara: 'RO' },
      },
    },
    openingBalances: {
      [FID]: {
        '371': { d: 20000, c: 0 }, '5121': { d: 40000, c: 0 }, '5311': { d: 5000, c: 0 },
        '1012': { d: 0, c: 30000 }, '117': { d: 0, c: 20000 }, '401': { d: 0, c: 15000 },
      },
    },
    openingAnalytic: [
      { firmaId: FID, cont: '401', partener: 'ALFA DISTRIBUTIE SRL', cui: 'RO11223344', d: 0, c: 15000 },
    ],
    assets: [
      { id: 'mf1', firmaId: FID, denumire: 'Laptop Dell Latitude', cont: '2131', furnizor: 'ALFA DISTRIBUTIE SRL', cui: 'RO11223344', cost: 6000, valoareReziduala: 0, dataAchizitie: '2026-01-10', dataPif: '2026-01-15', durataLuni: 36, metoda: 'liniara', status: 'activ' },
      { id: 'mf2', firmaId: FID, denumire: 'Utilaj productie', cont: '2131', furnizor: 'ALFA DISTRIBUTIE SRL', cui: 'RO11223344', cost: 12000, valoareReziduala: 0, dataAchizitie: '2025-12-15', dataPif: '2025-12-20', durataLuni: 60, metoda: 'degresiva', status: 'activ' },
    ],
    gestiuni: [
      { id: 'g1', firmaId: FID, cod: 'DEP', denumire: 'Depozit central', gestionar: 'Ionescu Maria', cont: '371' },
      { id: 'g2', firmaId: FID, cod: 'MAG', denumire: 'Magazin', gestionar: 'Popa Ion', cont: '371' },
    ],
    products: [
      { id: 'prod1', firmaId: FID, cod: 'MARFA-001', denumire: 'Marfa generala', um: 'buc', grupa: 'Marfuri', cont: '371', codNC: '' },
    ],
    angajati: [
      { id: 'ang1', firmaId: FID, nume: 'Ion Popescu', cnp: '1900101415236', functie: 'Vanzator', salariuBrut: 5000, neimpozabil: 0 },
    ],
    stockMovements: [
      { id: 'sm1', firmaId: FID, data: '2026-06-10', tip: 'receptie', productId: 'prod1', gestiuneId: 'g1', cantitate: 100, pretUnitar: 100, document: 'AFD 1001', furnizor: 'ALFA DISTRIBUTIE SRL', operator: 'admin' },
      { id: 'sm2', firmaId: FID, data: '2026-06-15', tip: 'iesire', productId: 'prod1', gestiuneId: 'g1', cantitate: 80, pretUnitar: 0, document: 'EXP 2001', operator: 'admin' },
      { id: 'sm3', firmaId: FID, data: '2026-06-20', tip: 'transfer', productId: 'prod1', gestiuneId: 'g1', gestiuneDestId: 'g2', cantitate: 10, pretUnitar: 0, document: 'TR 1', operator: 'admin' },
    ],
    entries: SPEC.map(([tip, fields]) => make(tip, fields, nid)),
  };
}

/** Vedere "scoped" pentru firma 1, construita din date pure — folosita la teste (fara DB). */
function scopedSeed() {
  const data = buildSeedData();
  return {
    firmaId: FID, company: data.firme[0], entries: data.entries,
    partners: data.partners[FID], openingBalances: data.openingBalances[FID], openingAnalytic: data.openingAnalytic,
    assets: data.assets, gestiuni: data.gestiuni, products: data.products, stockMovements: data.stockMovements,
    angajati: data.angajati,
    documents: [], settings: { tvaStandard: 21 },
  };
}

/** Incarca exemplul integrat din ghid in baza de date (firma 1). */
function seed() {
  const d = db.get();
  const data = buildSeedData(() => db.nextId('e'));
  d.firme = data.firme;
  d.firmaActiva = FID;
  d.documents = [];
  d.inventories = [];
  d.payrollHistory = [];
  if (d.settings && d.settings.docSeries) delete d.settings.docSeries[FID];
  d.partners = data.partners;
  d.openingBalances = data.openingBalances;
  d.openingAnalytic = data.openingAnalytic;
  d.assets = data.assets;
  d.gestiuni = data.gestiuni;
  d.products = data.products;
  d.stockMovements = data.stockMovements;
  d.angajati = data.angajati;
  d.entries = data.entries;
  db.save();
  return { entries: d.entries.length, period: '2026-06' };
}

module.exports = { seed, buildSeedData, scopedSeed };
