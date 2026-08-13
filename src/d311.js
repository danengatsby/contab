'use strict';

// D311 — TVA colectata/datorata in perioada in care codul normal de TVA este anulat. Formularul
// are patru randuri economice, dar doua scheme care se EXCLUD: sectiunea IV foloseste data
// anularii, iar sectiunea V foloseste data reinregistrarii. Modulul tine incadrarea, calculul si
// raportul impreuna, ca XML-ul si monografia sa nu declare aceeasi operatiune pe randuri diferite.

const acc = require('./accounting');
const { round2, period: periodOf } = require('./util');

const TIP_DOCUMENT = 'operatiune_tva_cod_anulat_d311';

const OPERATIUNI = Object.freeze({
  11: { sectiune: 'IV', nume: 'Livrări/prestări efectuate după anularea din oficiu a codului TVA' },
  21: { sectiune: 'IV', nume: 'Achiziții pentru care firma este obligată la plata TVA după anulare' },
  41: { sectiune: 'IV', nume: 'Livrări anterioare anulării, exigibile ulterior prin TVA la încasare' },
  61: { sectiune: 'V', nume: 'Livrări din perioada codului anulat, declarate după reînregistrare' },
});

function fail(message) { throw new Error(message); }

/** Datele declarative memorate pe articol. Baza si taxa sunt sumele efective din document, nu o
 *  reconstructie ulterioara din conturi (randurile 41/61 posteaza numai taxa, ca sa nu dubleze
 *  venitul recunoscut la livrare). */
function dinCampuri(d) {
  d = d || {};
  const operatie = Number(d.tipOperatieD311);
  if (!OPERATIUNI[operatie]) fail('Alege categoria operațiunii D311.');
  const baza = round2(Number(d.baza));
  const tva = round2(Number(d.tva));
  const cota = Number(d.cota) || 0;
  if (!(baza > 0)) fail('Baza declarabilă D311 trebuie să fie mai mare decât zero.');
  if (!(tva > 0)) fail('TVA datorată prin D311 trebuie să fie mai mare decât zero.');
  if (cota && !(cota > 0 && cota <= 100)) fail('Cota TVA D311 nu este validă.');
  return { operatie, sectiune: OPERATIUNI[operatie].sectiune, baza, tva, cota };
}

/** Raport lunar exclusiv din articole postate. */
function report(view, period) {
  const rows = [];
  for (const e of acc.postedEntries(view || {})) {
    if (e.tip !== TIP_DOCUMENT || e.stornat) continue;
    const ep = String(e.period || periodOf(e.data));
    if (period && ep !== String(period)) continue;
    const m = e.d311 || {};
    const operatie = Number(m.operatie);
    if (!OPERATIUNI[operatie]) continue;
    rows.push({
      entryId: e.id,
      data: e.data,
      document: e.document || '',
      partener: e.partener || '',
      partenerCui: e.partenerCui || '',
      operatie,
      sectiune: OPERATIUNI[operatie].sectiune,
      denumire: OPERATIUNI[operatie].nume,
      baza: round2(Number(m.baza) || 0),
      tva: round2(Number(m.tva) || 0),
      cota: Number(m.cota) || 0,
    });
  }
  rows.sort((a, b) => String(a.data).localeCompare(String(b.data)) || String(a.entryId).localeCompare(String(b.entryId)));
  const totaluri = {};
  for (const cod of Object.keys(OPERATIUNI)) totaluri[cod] = { baza: 0, tva: 0, nr: 0 };
  for (const r of rows) {
    const t = totaluri[r.operatie];
    t.baza = round2(t.baza + r.baza); t.tva = round2(t.tva + r.tva); t.nr += 1;
  }
  const areIV = rows.some((r) => r.sectiune === 'IV');
  const areV = rows.some((r) => r.sectiune === 'V');
  return {
    period: period || null,
    rows,
    totaluri,
    schema: areIV && areV ? 'mixta' : (areV ? 'reinregistrare' : 'anulare'),
    totalBaza: round2(rows.reduce((s, r) => s + r.baza, 0)),
    totalTva: round2(rows.reduce((s, r) => s + r.tva, 0)),
    nr: rows.length,
  };
}

module.exports = { TIP_DOCUMENT, OPERATIUNI, dinCampuri, report };
