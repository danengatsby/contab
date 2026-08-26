'use strict';

// Cockpitul ANUAL este o vedere derivata: nu tine bife manuale care ar ramane „gata” dupa ce
// cineva modifica datele. Fiecare pas isi cauta dovada in registrele reale (inventar, articole,
// declaratii, blocarea lunilor), iar ordinea transforma primul pas restant in „deschis” si pe
// urmatoarele in „blocat”.

const acc = require('./accounting');
const assets = require('./assets');
const fiscalProfile = require('./fiscalProfile');
const temeiLegal = require('./temeiLegal');
const fiscalReview = require('./fiscalReview');
const annualInventory = require('./annualInventory');

const ORDER = ['revizie_fiscala', 'inventariere', 'evaluare', 'amortizare', 'balanta', 'perioada_13', 'impozit', 'inchidere', 'situatii', 'depunere', 'repartizare'];

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function reqYear(value) {
  const year = String(value || '');
  if (!/^[1-9]\d{3}$/.test(year)) fail(400, 'Anul trebuie sa aiba forma YYYY.');
  return year;
}
function activeEntries(view) { return acc.postedEntries(view).filter((e) => !e.stornat); }
function hasType(entries, tip, year) {
  return entries.some((e) => e.tip === tip && String(e.rezultatAn || e.period || e.data || '').slice(0, 4) === year);
}
function definition(key) {
  if (key === 'revizie_fiscala') return { key, nume: 'Revizie fiscală externă',
    descriere: 'Toate cazurile fiscale sunt aprobate criptografic de un revizor autorizat, pe manifestul codului/regulilor și configurația activă.', temei: [] };
  if (key === 'perioada_13') return { key, nume: 'Perioada tehnică 13 — ajustări anuale',
    descriere: 'Spațiu intern controlat pentru notele anuale după blocarea lunii decembrie; articolele rămân datate contabil la 31 decembrie.', temei: [] };
  const p = temeiLegal.pas(key) || { key, nume: key, descriere: '' };
  return { key, nume: p.nume, descriere: p.descriere, temei: temeiLegal.temeiul(key) };
}

function status(globalDb, view, year) {
  year = reqYear(year);
  globalDb = globalDb || {}; view = view || {};
  const entries = activeEntries(view);
  const company = view.company || {};
  const profile = fiscalProfile.profileAt(view, year, { angajati: view.angajati || [] });
  const period = year + '-12';
  const inventareFizice = (view.inventories || []).filter((x) => String(x.data || '').slice(0, 4) === year);
  const valoriInventar = (view.inventarAnual || []).filter((x) => String(x.an || x.data || '').slice(0, 4) === year);
  const inventoryMatrix = annualInventory.evaluate(view, year);
  const luniAmortizabile = [];
  const luniAmortizate = new Set(entries.filter((e) => e.tip === 'amortizare_lunara' && String(e.period || '').startsWith(year)).map((e) => e.period));
  for (let month = 1; month <= 12; month += 1) {
    const p = year + '-' + String(month).padStart(2, '0');
    if (assets.monthlyDepreciation(view.assets || [], p).total > 0) luniAmortizabile.push(p);
  }
  const luniAmortizareLipsa = luniAmortizabile.filter((p) => !luniAmortizate.has(p));
  const balanta = acc.trialBalance(view, year);
  const declaratie = (globalDb.declarations || []).find((x) => Number(x.firmaId) === Number(view.firmaId)
    && x.tip === 'bilant' && x.period === period);
  const situatiiGenerate = !!(declaratie && ['generata', 'aprobata', 'transmisa', 'depusa'].includes(declaratie.status));
  const situatiiDepuse = !!(declaratie && ['depusa', 'scutita'].includes(declaratie.status));
  const impozitPostat = hasType(entries, 'impozit_profit', year);
  const pierdereCalculata = company.pierdereFiscala && Object.prototype.hasOwnProperty.call(company.pierdereFiscala, year);
  const inchiderePostata = hasType(entries, 'inchidere_an', year)
    || !!(company.annualCloseHistory && company.annualCloseHistory[year]);
  const repartizarePostata = entries.some((e) => e.tip === 'repartizare_rezultat' && String(e.rezultatAn || '') === year);
  const review = fiscalReview.status();

  const raw = {
    revizie_fiscala: {
      done: review.ready,
      blockers: ['Revizia externă este incompletă: ' + review.approved + '/' + review.total + ' cazuri aprobate'
        + (review.invalid ? ', ' + review.invalid + ' aprobări invalidate de modificări ulterioare' : '') + '.'],
      details: { aprobate: review.approved, total: review.total, inAsteptare: review.pending, invalidate: review.invalid, setFiscal: review.fiscalYear },
    },
    inventariere: {
      done: inventoryMatrix.complete,
      blockers: inventoryMatrix.blockers.map((x) => x.label + ': ' + x.blockers.join(' ')),
      details: { inventareFizice: inventareFizice.length, valoriInventar: valoriInventar.length,
        domeniiComplete: inventoryMatrix.progress.complete, domeniiNecesare: inventoryMatrix.progress.total },
    },
    evaluare: {
      done: inventoryMatrix.complete,
      blockers: inventoryMatrix.blockers.map((x) => x.label + ': ' + x.blockers.join(' ')),
      details: { valoriEvaluate: valoriInventar.length,
        diferentaInventarContabilitate: inventoryMatrix.control.reconciliation.differenceAmount,
        noteRegularizare: inventoryMatrix.control.reconciliation.adjustmentEntryIds.length,
        aprobareValida: !!((inventoryMatrix.rows.find((x) => x.key === 'guvernanta') || {}).approvalValid) },
    },
    amortizare: luniAmortizabile.length === 0 ? { na: true, details: { motiv: 'Nu există active amortizabile în acest exercițiu.' } } : {
      done: luniAmortizareLipsa.length === 0,
      blockers: luniAmortizareLipsa.length ? ['Lipsesc amortizările pentru ' + luniAmortizareLipsa.join(', ') + '.'] : [],
      details: { luniNecesare: luniAmortizabile.length, luniInregistrate: luniAmortizabile.length - luniAmortizareLipsa.length, luniLipsa: luniAmortizareLipsa },
    },
    balanta: {
      done: !!balanta.balanced && !!company.lockedUntil && company.lockedUntil >= period,
      blockers: [].concat(balanta.balanced ? [] : ['Balanța nu respectă cele patru egalități.'])
        .concat(company.lockedUntil && company.lockedUntil >= period ? [] : ['Nu sunt blocate toate lunile exercițiului până la ' + period + '.']),
      details: { echilibrata: !!balanta.balanced, conturi: balanta.rows.length, lockedUntil: company.lockedUntil || null },
    },
    perioada_13: {
      done: !!company.lockedUntil && company.lockedUntil >= period,
      blockers: ['Perioada tehnică 13 se deschide numai după blocarea lunii decembrie.'],
      details: { perioadaTehnica: year + '-13', dataContabila: year + '-12-31',
        natura: 'spațiu tehnic intern, nu lună calendaristică' },
    },
    impozit: profile.profit ? {
      done: impozitPostat || !!pierdereCalculata,
      blockers: ['Calculul anual al impozitului pe profit nu este consemnat.'],
      details: { regim: profile.regim, articolPostat: impozitPostat, pierdereCalculata: !!pierdereCalculata },
    } : { na: true, details: { motiv: profile.pfa ? 'PFA: definitivarea se face prin Declarația Unică.' : 'Firma nu este în regim de impozit pe profit în acest exercițiu.', regim: profile.regim } },
    inchidere: {
      done: inchiderePostata,
      blockers: ['Conturile de venituri și cheltuieli nu au fost închise prin nota anuală.'],
      details: { articolPostat: inchiderePostata, liniiRamase: acc.annualClosing(view, year).lines.length },
    },
    situatii: {
      done: situatiiGenerate,
      blockers: ['Situațiile financiare nu sunt încă generate și înregistrate în registrul declarațiilor.'],
      details: { status: declaratie ? declaratie.status : 'nedepusa', artifactHash: declaratie && declaratie.artifactHash || null },
    },
    depunere: {
      done: situatiiDepuse,
      blockers: ['Bilanțul nu este marcat depus cu recipisă (sau scutit) în registrul declarațiilor.'],
      details: { status: declaratie ? declaratie.status : 'nedepusa', recipisa: declaratie && declaratie.recipisa || '' },
    },
    repartizare: {
      done: repartizarePostata,
      blockers: ['Rezultatul exercițiului nu este repartizat în anul următor pe baza aprobării situațiilor financiare.'],
      details: { articolPostat: repartizarePostata, dataMinima: String(Number(year) + 1) + '-01-01',
        hotarareAga: (entries.find((e) => e.tip === 'repartizare_rezultat' && String(e.rezultatAn || '') === year) || {}).aga || null },
    },
  };

  let precedentRestant = null;
  const steps = ORDER.map((key) => {
    const d = raw[key]; const base = definition(key);
    let stare;
    if (d.na) stare = 'nuseaplica';
    else if (d.done) stare = 'gata';
    else if (precedentRestant) stare = 'blocat';
    else stare = 'deschis';
    const out = Object.assign(base, { stare, blocaje: d.done || d.na ? [] : d.blockers, detalii: d.details || {} });
    if (!d.done && !d.na && !precedentRestant) precedentRestant = base.nume;
    else if (!d.done && !d.na && precedentRestant) out.asteapta = precedentRestant;
    return out;
  });
  const relevante = steps.filter((s) => s.stare !== 'nuseaplica');
  const gata = relevante.filter((s) => s.stare === 'gata').length;
  const blocante = relevante.filter((s) => s.stare !== 'gata');
  return {
    year, adjustmentPeriod: { period: year + '-13', accountingDate: year + '-12-31',
      open: !!company.lockedUntil && company.lockedUntil >= period, technical: true },
    review: { ready: review.ready, fiscalYear: review.fiscalYear, approved: review.approved, pending: review.pending, invalid: review.invalid, total: review.total },
    profile: { regim: profile.regim, fiscalRevisionId: profile.fiscalRevisionId || null, fiscalValidFrom: profile.fiscalValidFrom || null },
    inventoryMatrix,
    steps, progres: { gata, total: relevante.length, procent: relevante.length ? Math.round(gata * 100 / relevante.length) : 100 },
    sePoateFinaliza: blocante.length === 0,
    blocante: blocante.map((s) => ({ key: s.key, nume: s.nume, blocaje: s.blocaje })),
  };
}

module.exports = { ORDER, status, reqYear };
