'use strict';

// D301 — decontul special de TVA al persoanelor care NU sunt inregistrate normal in scopuri de
// TVA (art. 316). Modulul tine impreuna nomenclatorul oficial, calculul documentului si raportul
// care alimenteaza XML-ul. Asa, monografia, D390 si generatorul D301 nu pot folosi trei incadrari
// diferite pentru aceeasi achizitie.

const acc = require('./accounting');
const { round2, period: periodOf } = require('./util');

const TIP_DOCUMENT = 'achizitie_tva_speciala_d301';

// Codurile sunt exact `tip_operatie` din structura oficiala D301. Codul 5 este subtotalul 4.1
// separat de celelalte operatiuni ale sectiunii 4 si este singurul care reprezinta servicii UE.
const OPERATIUNI = Object.freeze({
  1: 'Achiziții intracomunitare de bunuri (altele decât mijloace noi și produse accizabile)',
  2: 'Achiziții intracomunitare de mijloace de transport noi',
  3: 'Achiziții intracomunitare de produse accizabile',
  4: 'Alte operațiuni cu TVA datorată de beneficiar, art. 307 alin. (2), (3), (5), (6)',
  5: 'Achiziții intracomunitare de servicii — secțiunea 4.1',
});

// Lista inchisa din XSD-ul oficial d301_20200130.xsd. HRK ramane acceptata pentru documente
// istorice, chiar daca Croatia foloseste EUR din 2023: schema o accepta si declaratia poate fi
// regenerata pentru o perioada veche.
const VALUTE = Object.freeze(['EUR', 'USD', 'AUD', 'CAD', 'CHF', 'CZK', 'DKK', 'EGP', 'GBP',
  'HUF', 'JPY', 'MDL', 'NOK', 'PLN', 'RON', 'SEK', 'TRY', 'XDR', 'BGN', 'HRK']);
const VALUTE_SET = new Set(VALUTE);

function fail(message) { throw new Error(message); }

/** Normalizeaza si valideaza campurile documentului; intoarce exact cifrele declarabile. */
function dinCampuri(d) {
  d = d || {};
  const nrDoc = String(d.document || '').trim();
  if (!nrDoc) fail('Completează numărul facturii sau al autofacturii pentru D301.');
  if (nrDoc.length > 20) fail('Numărul documentului D301 poate avea cel mult 20 de caractere.');
  const tipOperatie = Number(d.tipOperatieD301);
  if (!OPERATIUNI[tipOperatie]) fail('Alege secțiunea D301 (tipul operațiunii 1–5).');
  const tipValuta = String(d.moneda || '').trim().toUpperCase();
  if (!VALUTE_SET.has(tipValuta)) {
    fail('Valută neacceptată de schema D301: „' + (tipValuta || 'lipsă') + '”. Alege una din lista oficială.');
  }
  const valoareValuta = round2(Number(d.sumaValuta));
  const cursValutar = Math.round(Number(d.curs) * 10000) / 10000;
  const cota = Number(d.cota);
  if (!(valoareValuta > 0)) fail('Completează valoarea documentului în valută (mai mare decât zero).');
  if (!(cursValutar > 0)) fail('Completează cursul valutar folosit la exigibilitatea TVA.');
  if (!(cota > 0 && cota <= 100)) fail('Completează o cotă TVA validă pentru D301.');
  // Regula oficiala R20: baza = round(val_valuta × curs_valutar, 0). D301 declara in lei, iar
  // aceeasi baza intra in articolul contabil; nu pastram o cifra la bani care ar diferi de XML.
  const baza = Math.round(valoareValuta * cursValutar);
  const tva = Math.round((baza * cota) / 100);
  if (!(baza > 0) || !(tva > 0)) fail('Baza sau TVA-ul D301 rezultă zero; verifică valoarea, cursul și cota.');
  return { tipOperatie, tipValuta, valoareValuta, cursValutar, baza, cota, tva };
}

/** Raport lunar, exclusiv din articole POSTATE si nestornate. */
function report(view, period) {
  const rows = [];
  for (const e of acc.postedEntries(view || {})) {
    if (e.tip !== TIP_DOCUMENT || e.stornat) continue;
    const ep = String(e.period || periodOf(e.data));
    if (period && ep !== String(period)) continue;
    const m = e.d301 || {};
    const tipOperatie = Number(m.tipOperatie);
    if (!OPERATIUNI[tipOperatie]) continue; // date vechi/incomplete: validarea pre-depunere le semnaleaza separat
    rows.push({
      entryId: e.id,
      tipOperatie,
      denumireOperatie: OPERATIUNI[tipOperatie],
      nrDoc: String(e.document || '').trim(),
      dataDoc: e.data,
      tipValuta: String(m.tipValuta || '').toUpperCase(),
      valoareValuta: round2(Number(m.valoareValuta) || 0),
      cursValutar: Math.round((Number(m.cursValutar) || 0) * 10000) / 10000,
      baza: Math.round(Number(m.baza) || 0),
      tva: Math.round(Number(m.tva) || 0),
      cota: Number(m.cota) || 0,
      partener: e.partener || '',
      partenerCui: e.partenerCui || '',
    });
  }
  rows.sort((a, b) => String(a.dataDoc).localeCompare(String(b.dataDoc)) || String(a.entryId).localeCompare(String(b.entryId)));
  const sectiuni = {};
  for (let i = 1; i <= 5; i++) sectiuni[i] = { baza: 0, tva: 0, nr: 0 };
  for (const r of rows) {
    const s = sectiuni[r.tipOperatie];
    s.baza += r.baza; s.tva += r.tva; s.nr += 1;
  }
  // Sectiunea 4 este TOTALUL care cuprinde si 4.1. Validatorul cere pentru fiecare rand de tip 5
  // un rand pereche de tip 4 (R32); raportul arata acelasi total. Taxa economica ramane insa o
  // singura data in `totalTva`, calculata din documentele reale, nu din redundanta formularului.
  sectiuni[4].baza += sectiuni[5].baza;
  sectiuni[4].tva += sectiuni[5].tva;
  sectiuni[4].nr += sectiuni[5].nr;
  const totalBaza = rows.reduce((s, x) => s + x.baza, 0);
  const totalTva = rows.reduce((s, x) => s + x.tva, 0);
  const totalControl = Object.values(sectiuni).reduce((s, x) => s + x.baza + x.tva, 0);
  return {
    period: period || null,
    rows,
    sectiuni,
    totalBaza,
    totalTva,
    totalControl,
    mijlocTransportNou: rows.some((r) => r.tipOperatie === 2),
    nr: rows.length,
  };
}

module.exports = { TIP_DOCUMENT, OPERATIUNI, VALUTE, dinCampuri, report };
