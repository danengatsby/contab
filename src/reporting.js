'use strict';

const { round2, period: periodOf } = require('./util');
const fiscal = require('./fiscal');
const coa = require('./chartOfAccounts');
const acc = require('./accounting');
const fiscalProfile = require('./fiscalProfile'); // regimul firmei (micro/profit) pentru livrabile
const stmt = require('./statements');
const { reconcile } = require('./reconcile');
const recurring = require('./recurring');

/** Rulajele perioadei pe cont {cod:{d,c}}. */
function periodRulaj(db, period) {
  const lines = acc.allLines(acc.postedEntries(db).filter((e) => (e.period || periodOf(e.data)) === period));
  return acc.accumulate(lines);
}

/** Recap D112 — salarii: cheltuieli, retineri si sume de virat. */
function d112(db, period) {
  const r = periodRulaj(db, period);
  const cred = (c) => (r[c] ? round2(r[c].c - r[c].d) : 0);
  const deb = (c) => (r[c] ? round2(r[c].d - r[c].c) : 0);
  const brut = deb('641');
  const cas = cred('4315');
  const cass = cred('4316');
  const impozit = cred('444');
  const cam = cred('436');
  const net = round2(brut - cas - cass - impozit);
  const totalBuget = round2(cas + cass + impozit + cam);
  return { period, brut, cas, cass, impozit, cam, net, totalBuget };
}

/** Recap D300 — decont TVA (din jurnalele de TVA). */
function d300(db, period) {
  const vj = acc.vatJournals(db, period);
  return Object.assign({ period, coteV: vj.coteV, coteC: vj.coteC }, vj.totals);
}

/** Recap D390 — declaratia recapitulativa VIES (livrari/achizitii intracomunitare de bunuri). */
function d390(db, period) {
  const INTRACOM = { livrare_intracomunitara: 'L', achizitie_intracomunitara: 'A' };
  const ent = acc.postedEntries(db).filter((e) => INTRACOM[e.tip]
    && (!period || String(e.period || periodOf(e.data)).startsWith(period)));
  const map = new Map();
  for (const e of ent) {
    const cod = INTRACOM[e.tip];
    let baza = 0;
    for (const l of e.lines) {
      if (cod === 'L' && /^70/.test(String(l.credit))) baza = round2(baza + l.suma); // livrare: venit (clasa 70)
      if (cod === 'A' && String(l.credit) === '401') baza = round2(baza + l.suma);   // achizitie: valoarea bunurilor (vs furnizor)
    }
    const cui = String(e.partenerCui || '').replace(/\s/g, '').toUpperCase();
    const key = cod + '|' + cui;
    const r = map.get(key) || { cod, cui, tara: cui.slice(0, 2), denumire: e.partener || '', baza: 0, nrop: 0 };
    r.baza = round2(r.baza + baza); r.nrop += 1;
    if (!r.denumire && e.partener) r.denumire = e.partener;
    map.set(key, r);
  }
  const rows = [...map.values()].filter((r) => r.baza !== 0).sort((a, b) => (a.cod + a.cui).localeCompare(b.cod + b.cui));
  const totalL = round2(rows.filter((r) => r.cod === 'L').reduce((s, r) => s + r.baza, 0));
  const totalA = round2(rows.filter((r) => r.cod === 'A').reduce((s, r) => s + r.baza, 0));
  return { period, rows, totalL, totalA, nr: rows.length };
}

/** Recap D205 — impozit pe venit retinut la sursa (dividende, chirii, premii), pe beneficiar. */
function d205(db, year) {
  const TIPURI = { repartizare_dividende: 'Dividende', chirie_pf: 'Chirii', premiu_pf: 'Premii' };
  const ent = acc.postedEntries(db).filter((e) => TIPURI[e.tip] && String(e.period || periodOf(e.data)).startsWith(String(year)));
  const map = new Map();
  for (const e of ent) {
    const tip = TIPURI[e.tip];
    let impozit = 0; let brut = 0;
    for (const l of e.lines) if (String(l.credit) === '446') impozit = round2(impozit + l.suma);
    if (e.tip === 'repartizare_dividende') {
      for (const l of e.lines) if (String(l.credit) === '457') brut = round2(brut + l.suma); // dividend brut
    } else {
      for (const l of e.lines) if (/^6/.test(String(l.debit))) brut = round2(brut + l.suma); // venitul brut = cheltuiala
    }
    if (impozit === 0 && brut === 0) continue;
    const cnp = String(e.partenerCui || '').replace(/\s/g, '').toUpperCase();
    const key = tip + '|' + (cnp || e.partener || '-');
    const r = map.get(key) || { tipVenit: tip, beneficiar: e.partener || '', cnp, venitBrut: 0, impozit: 0, nrInreg: 0 };
    r.venitBrut = round2(r.venitBrut + brut); r.impozit = round2(r.impozit + impozit); r.nrInreg += 1;
    if (!r.beneficiar && e.partener) r.beneficiar = e.partener;
    map.set(key, r);
  }
  const rows = [...map.values()].sort((a, b) => (a.tipVenit + a.beneficiar).localeCompare(b.tipVenit + b.beneficiar));
  return { year: String(year), rows, totalBrut: round2(rows.reduce((s, r) => s + r.venitBrut, 0)), totalImpozit: round2(rows.reduce((s, r) => s + r.impozit, 0)), nr: rows.length };
}

/** Achizitiile de la producatori agricoli PF pe baza de fila din carnetul de comercializare /
 *  borderou de achizitie (Legea 145/2014) — fara TVA, agregat pe producator; sectiune in D394. */
function achizitiiPfCarnet(db, period) {
  const ent = acc.postedEntries(db).filter((e) => e.tip === 'achizitie_produse_agricole' && (!period || String(e.period || periodOf(e.data)) === period));
  const map = new Map();
  for (const e of ent) {
    let val = 0;
    for (const l of e.lines) if (String(l.credit) === '462') val = round2(val + l.suma); // datoria fata de producator
    if (!val) continue;
    const cnp = String(e.partenerCui || '').replace(/\s/g, '').toUpperCase();
    const key = cnp || (e.partener || '-').toUpperCase();
    const r = map.get(key) || { partener: e.partener || '', cnp, nr: 0, total: 0 };
    r.nr += 1; r.total = round2(r.total + val);
    if (!r.partener && e.partener) r.partener = e.partener;
    map.set(key, r);
  }
  const rows = [...map.values()].sort((a, b) => a.partener.localeCompare(b.partener));
  return { period, rows, total: round2(rows.reduce((s, r) => s + r.total, 0)), nr: rows.length };
}

/** Intrastat (de baza) — fluxuri de bunuri intracomunitare pe tara: introduceri (achizitii) / expedieri (livrari). */
function intrastat(db, period) {
  const FLUX = { livrare_intracomunitara: 'expediere', achizitie_intracomunitara: 'introducere' };
  const ent = acc.postedEntries(db).filter((e) => FLUX[e.tip] && (!period || String(e.period || periodOf(e.data)).startsWith(period)));
  const map = new Map();
  for (const e of ent) {
    const flux = FLUX[e.tip];
    let val = 0;
    for (const l of e.lines) {
      if (flux === 'expediere' && /^70/.test(String(l.credit))) val = round2(val + l.suma);
      if (flux === 'introducere' && String(l.credit) === '401') val = round2(val + l.suma);
    }
    const it = e.intrastat || {};
    const cui = String(e.partenerCui || '').replace(/\s/g, '').toUpperCase();
    const codNC = String(it.codNC || '').trim();
    const key = flux + '|' + cui.slice(0, 2) + '|' + codNC;
    const r = map.get(key) || { flux, tara: cui.slice(0, 2), codNC, natura: it.natura || '', conditie: it.conditie || '', valoare: 0, masaNeta: 0, nrop: 0 };
    r.valoare = round2(r.valoare + val);
    r.masaNeta = round2(r.masaNeta + (Number(it.masaNeta) || 0));
    r.nrop += 1;
    if (!r.natura && it.natura) r.natura = it.natura;
    if (!r.conditie && it.conditie) r.conditie = it.conditie;
    map.set(key, r);
  }
  const rows = [...map.values()].filter((r) => r.valoare !== 0).sort((a, b) => (a.flux + a.tara + a.codNC).localeCompare(b.flux + b.tara + b.codNC));
  const totalExpedieri = round2(rows.filter((r) => r.flux === 'expediere').reduce((s, r) => s + r.valoare, 0));
  const totalIntroduceri = round2(rows.filter((r) => r.flux === 'introducere').reduce((s, r) => s + r.valoare, 0));
  const PRAG = 1000000; // praguri Intrastat RO 2024 (lei, anuale cumulate): introduceri si expedieri
  return {
    period, rows, totalExpedieri, totalIntroduceri,
    pragIntroduceri: PRAG, pragExpedieri: PRAG,
    obligatIntroduceri: totalIntroduceri >= PRAG, obligatExpedieri: totalExpedieri >= PRAG,
    fcaraCodNC: rows.filter((r) => !r.codNC).length, // randuri fara cod NC8 (de completat manual)
  };
}

/** Situatia obligatiilor de plata catre buget (solduri finale creditoare). */
function obligatii(db, period) {
  const tb = acc.trialBalance(db, period);
  // obligatiile CONSTITUITE in perioada (rulaj credit), nu soldul cumulat — ca sa reflecte luna selectata
  const sc = (c) => { const row = tb.rows.find((r) => r.cod === c); return row ? round2(row.rc) : 0; };
  const items = [
    { cont: '4423', nume: 'TVA de plata', suma: sc('4423') },
    { cont: '444', nume: 'Impozit pe veniturile din salarii', suma: sc('444') },
    { cont: '4315', nume: 'CAS (asigurari sociale)', suma: sc('4315') },
    { cont: '4316', nume: 'CASS (asigurari de sanatate)', suma: sc('4316') },
    { cont: '436', nume: 'CAM (contributia asiguratorie)', suma: sc('436') },
    { cont: '4411', nume: 'Impozit pe profit', suma: sc('4411') },
    { cont: '446', nume: 'Alte impozite/taxe (inclusiv vama)', suma: sc('446') },
  ].filter((i) => i.suma > 0);
  const total = round2(items.reduce((s, i) => s + i.suma, 0));
  return { period, items, total };
}

/** Recap D100 — impozit pe veniturile microintreprinderii (1% din venituri). */
function d100micro(db, period, cota) {
  // Impozitul micro e TRIMESTRIAL: veniturile se cumuleaza pe toate lunile trimestrului
  // din care face parte `period` (ex. 2026-06 -> aprilie + mai + iunie).
  const m = Number(String(period || '').slice(5, 7)) || 0;
  const y = String(period || '').slice(0, 4);
  const q0 = m ? m - ((m - 1) % 3) : 0;
  const luni = m ? [q0, q0 + 1, q0 + 2].map((x) => y + '-' + String(x).padStart(2, '0')) : [];
  const lines = acc.allLines(acc.postedEntries(db).filter((e) => luni.includes(String(e.period || periodOf(e.data)))));
  const r = acc.accumulate(lines);
  let venit = 0;
  for (const cod of Object.keys(r)) {
    const a = coa.getAccount(cod);
    const clasa = a ? a.clasa : Number(String(cod)[0]);
    if (clasa === 7) venit = round2(venit + (r[cod].c - r[cod].d));
  }
  const rate = cota || fiscal.FISCAL.impozitMicro || 1;
  // Semnal de eligibilitate micro (art. 47 Cod fiscal): plafonul de venituri (EUR, configurabil)
  // si conditia de salariat. Doar AVERTIZEAZA — incadrarea finala ramane la contribuabil.
  const rAn = acc.accumulate(acc.allLines(acc.postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(y))));
  let venitAn = 0;
  for (const cod of Object.keys(rAn)) {
    const a = coa.getAccount(cod);
    if ((a ? a.clasa : Number(String(cod)[0])) === 7) venitAn = round2(venitAn + (rAn[cod].c - rAn[cod].d));
  }
  const plafonLei = round2((fiscal.FISCAL.plafonMicroEur || 0) * (fiscal.FISCAL.cursPlafonMicro || 0));
  const avertismente = [];
  if (plafonLei > 0 && venitAn > plafonLei) {
    avertismente.push('Veniturile anului (' + venitAn + ' lei) DEPASESC plafonul micro de ' + fiscal.FISCAL.plafonMicroEur
      + ' EUR (~' + plafonLei + ' lei): firma iese din regimul micro si datoreaza impozit pe profit — verifica incadrarea inainte de a depune D100 pe micro.');
  } else if (plafonLei > 0 && venitAn >= round2(plafonLei * 0.8)) {
    avertismente.push('Veniturile anului (' + venitAn + ' lei) au atins ' + Math.round((venitAn / plafonLei) * 100)
      + '% din plafonul micro (~' + plafonLei + ' lei) — urmareste pragul; la depasire treci obligatoriu la impozit pe profit.');
  }
  if (!((db.angajati || []).length)) {
    avertismente.push('Firma nu are salariati inregistrati in aplicatie: conditia de salariat (norma intreaga) pentru regimul micro nu pare indeplinita — fara salariat se datoreaza impozit pe profit.');
  }
  return { period, trimestru: m ? Math.ceil(m / 3) : 0, luni, venit, cota: rate, impozit: round2((venit * rate) / 100), venitAn, plafonMicroLei: plafonLei, plafonMicroEur: fiscal.FISCAL.plafonMicroEur, avertismente };
}

/** Pro-rata TVA (art. 300): ponderea livrarilor CU drept de deducere in totalul livrarilor (anual).
 *  Clasificare aproximativa din jurnal: cu drept = vanzari taxabile (TVA > 0) + scutite cu drept
 *  (LIC/export); fara drept = vanzari cu TVA 0 care nu sunt LIC/export. Pro-rata definitiva se
 *  rotunjeste IN SUS la unitati (art. 300 alin. 9). Include si regularizarea estimata pentru
 *  achizitiile marcate „destinatie mixta" in cursul anului. */
function proRataTva(db, year) {
  const SCUTITE_CU_DREPT = new Set(['livrare_intracomunitara']);
  const y = String(year);
  let cuDrept = 0; let faraDrept = 0; let dedusaProvizoriu = 0; let nrMixte = 0;
  for (const e of acc.postedEntries(db).filter((x) => String(x.period || periodOf(x.data)).startsWith(y))) {
    let baza = 0; let tva = 0;
    for (const l of e.lines || []) {
      if (/^7/.test(String(l.credit))) baza = round2(baza + l.suma);
      if (/^7/.test(String(l.debit))) baza = round2(baza - l.suma);
      if (l.credit === '4427' || l.credit === '4428') tva = round2(tva + l.suma);
    }
    if (baza > 0) {
      if (tva > 0 || SCUTITE_CU_DREPT.has(e.tip)) cuDrept = round2(cuDrept + baza);
      else faraDrept = round2(faraDrept + baza);
    }
    if (e.proRataMixt) {
      nrMixte += 1;
      for (const l of e.lines || []) if (l.debit === '4426' || l.debit === '4428') dedusaProvizoriu = round2(dedusaProvizoriu + l.suma);
    }
  }
  const total = round2(cuDrept + faraDrept);
  const definitiva = total > 0 ? Math.min(100, Math.ceil((cuDrept / total) * 100)) : 100;
  const provizorie = Number((db.company || {}).proRataTva) || null;
  // regularizarea: TVA totala pe achizitiile mixte, redeductibila la pro-rata definitiva
  let regularizare = null;
  if (provizorie && nrMixte) {
    const tvaTotalaMixta = round2((dedusaProvizoriu * 100) / provizorie);
    regularizare = round2(round2((tvaTotalaMixta * definitiva) / 100) - dedusaProvizoriu);
  }
  return { year: y, cuDrept, faraDrept, total, definitiva, provizorie, nrMixte, dedusaProvizoriu, regularizare };
}

/** Estimarea Declaratiei Unice pentru PFA (sistem real): venitul net anual + CAS/CASS/impozit. */
function declaratiaUnica(db, year) {
  const y = String(year);
  const r = periodRulaj2(db, y);
  let venituri = 0; let cheltuieli = 0;
  for (const cod of Object.keys(r)) {
    const a = coa.getAccount(cod);
    const clasa = a ? a.clasa : Number(String(cod)[0]);
    if (clasa === 7) venituri = round2(venituri + (r[cod].c - r[cod].d));
    if (clasa === 6) cheltuieli = round2(cheltuieli + (r[cod].d - r[cod].c));
  }
  const venitNet = round2(venituri - cheltuieli);
  const sm = fiscal.salariuMinimLa(y + '-01'); // plafoanele DU: salariul minim al anului de realizare
  // Varianta pe INCASAT/PLATIT (fiscalitatea PFA in sistem real e pe incasari, nu pe facturat):
  // din registrul-jurnal de incasari si plati, doar operatiunile activitatii (fara interne/aporturi/taxe).
  const rjip = acc.registruIncasariPlati(db, y);
  const tInc = fiscal.taxePfa(rjip.venitNetIncasat, { salariuMinim: sm });
  return Object.assign({
    year: y, venituri, cheltuieli, venitNet,
    incasat: { incasari: rjip.tot.incFiscale, plati: rjip.tot.platiFiscale, venitNet: rjip.venitNetIncasat, cas: tInc.cas, cass: tInc.cass, impozit: tInc.impozit, total: tInc.total },
  }, fiscal.taxePfa(venitNet, { salariuMinim: sm }));
}

/** Registrul-inventar — soldurile finale la o data. */
function registruInventar(db, asOf) {
  const tb = acc.trialBalance(db, asOf);
  const rows = tb.rows.filter((r) => r.sfD || r.sfC).map((r) => ({ cod: r.cod, nume: r.nume, sfD: r.sfD, sfC: r.sfC }));
  return { asOf, rows, tot: { sfD: tb.tot.sfD, sfC: tb.tot.sfC } };
}

/**
 * Lista livrabilelor (oglinda borderoului de primire de la contabil), pe perioada.
 * status: ok = document final; recap = baza pentru declaratie (XML/recipisa la ANAF);
 *         regim = depinde de regimul fiscal; anaf = emis de ANAF; manual = pregatit de firma.
 */
function livrabile(db, period) {
  const L = (sectiune, nr, nume, status, links, obs) => ({ sectiune, nr, nume, status, links: links || [], obs: obs || '' });
  const p = period ? '?period=' + period : '';
  const yr = (period || '').slice(0, 4);
  const list = [
    L('A. Lunar', 1, 'Balanta de verificare', 'ok', [{ label: 'Balanta', href: '/pdf/balance' + p }]),
    L('A. Lunar', 2, 'State de plata + fluturasi de salariu', 'manual', [], 'Necesita evidenta pe fiecare angajat'),
    L('A. Lunar', 3, 'Situatia sumelor de virat (salarii nete + contributii)', 'recap', [{ label: 'Recap D112', href: '/pdf/d112' + p }]),
    L('A. Lunar', 4, 'Registre: registru-jurnal, cartea mare, jurnale TVA', 'ok', [
      { label: 'Jurnal', href: '/pdf/journal' + p }, { label: 'Cartea mare', href: '/pdf/ledger' + p }, { label: 'Jurnale TVA', href: '/pdf/vat' + p }]),
    L('A. Lunar', 5, 'D112 — contributii si impozit salarii (+ recipisa)', 'recap', [{ label: 'Recap D112', href: '/pdf/d112' + p }], 'Depunerea XML + recipisa la ANAF'),
    L('A. Lunar', 6, 'D300 — decont TVA (+ recipisa)', 'recap', [{ label: 'Recap PDF', href: '/pdf/d300' + p }, { label: 'XML ANAF', href: '/xml/d300' + p }], 'XML de validat cu DUKIntegrator; recipisa la ANAF'),
    L('A. Lunar', 7, 'D394 — declaratie informativa (+ recipisa)', 'recap', [{ label: 'XML ANAF', href: '/xml/d394' + p }, { label: 'Jurnale TVA', href: '/pdf/vat' + p }], 'XML de validat cu DUKIntegrator'),
    L('A. Lunar', 8, 'D390 VIES — operatiuni intracomunitare (+ recipisa)', 'regim', [], 'Doar daca exista operatiuni intracomunitare'),
    L('A. Lunar', 9, 'D406 SAF-T (+ recipisa)', 'regim', [], 'In functie de regim/termen'),
    L('A. Lunar', 10, 'D100 — retineri la sursa / dividende (+ recipisa)', 'regim', [], 'Daca e cazul'),
    L('A. Lunar', 11, 'Situatia sumelor de plata la ANAF', 'ok', [{ label: 'Obligatii', href: '/pdf/obligatii' + p }]),
    L('B. Trimestrial', 12, 'D100 — impozit micro 1% / avans impozit profit (+ recipisa)', 'recap', [{ label: 'Recap D100', href: '/pdf/d100' + p }, { label: 'D100 XML', href: '/xml/d100' + p }]),
    L('B. Trimestrial', 13, 'D300 / D394 / D406 — regim trimestrial (+ recipisa)', 'regim', [], 'Daca firma e pe regim trimestrial'),
    L('B. Trimestrial', 14, 'Balanta de verificare la sfarsit de trimestru', 'ok', [{ label: 'Balanta', href: '/pdf/balance' + p }]),
    L('C. Anual', 15, 'Situatii financiare: bilant + cont de profit si pierdere + note', 'ok', [
      { label: 'Bilant', href: '/pdf/bilant?period=' + yr + '-12' }, { label: 'Cont P&P', href: '/pdf/pl?year=' + yr }], 'Notele explicative se redacteaza separat'),
    L('C. Anual', 16, 'D101 — impozit pe profit (+ recipisa)', 'regim', [], 'Doar la regim de impozit pe profit'),
    L('C. Anual', 17, 'D205 / D107 — retineri la sursa / sponsorizari (+ recipisa)', 'regim', [], 'Daca e cazul'),
    L('C. Anual', 18, 'Registrul-inventar si documentele de inventariere', 'ok', [{ label: 'Registru-inventar', href: '/pdf/registru-inventar?period=' + yr + '-12' }]),
    L('C. Anual', 19, 'Proiect hotarare AGA: aprobare situatii + repartizare profit', 'manual', [], 'Document pregatit de firma'),
    L('D. La cerere', 20, 'Fisa pe platitor / situatia obligatiilor la ANAF', 'ok', [{ label: 'Obligatii', href: '/pdf/obligatii' + p }], 'Fisa oficiala se obtine din SPV'),
    L('D. La cerere', 21, 'Certificat de atestare fiscala', 'anaf', [], 'Emis de ANAF'),
    L('D. La cerere', 22, 'Balante si situatii pentru banca', 'ok', [{ label: 'Balanta', href: '/pdf/balance' + p }]),
  ];
  const sumar = { d112: d112(db, period), d300: d300(db, period), obligatii: obligatii(db, period), d100: d100micro(db, period) };
  // PFA: fara SAF-T / D100 micro / situatii financiare / D101 / AGA — in loc, Declaratia Unica anuala
  if ((db.company && db.company.tipEntitate) === 'pfa') {
    const drop = new Set([9, 12, 15, 16, 19]);
    const listPfa = list.filter((x) => !drop.has(x.nr));
    listPfa.push(L('A. Lunar', 24, 'Registrul-jurnal de incasari si plati (partida simpla)', 'ok',
      [{ label: 'Registru', href: '/pdf/registru-incasari-plati' + p }]));
    listPfa.push(L('C. Anual', 23, 'Declaratia Unica — venit net PFA + CAS/CASS/impozit (estimare)', 'recap',
      [{ label: 'PDF', href: '/pdf/declaratia-unica?year=' + yr }, { label: 'Registru incasari-plati (an)', href: '/pdf/registru-incasari-plati?period=' + yr }], 'Se depune personal, din SPV, pana la termenul legal'));
    sumar.du = declaratiaUnica(db, yr || String(new Date().getFullYear()));
    return { period, list: listPfa, sumar };
  }
  // micro/profit: D101 (nr 16) apare DOAR la regimul de impozit pe profit (micro nu depune D101)
  const prof = fiscalProfile.build(db.company);
  const listFinal = prof.profit ? list : list.filter((x) => x.nr !== 16);
  return { period, list: listFinal, sumar };
}

// Conturi de cheltuieli nedeductibile fiscal (uzual)
// Cheltuieli (partial) nedeductibile fiscal — `pct` = procentul nedeductibil (art. 25-28 Cod fiscal)
const NEDEDUCTIBILE = {
  6581: { nume: 'Despagubiri, amenzi si penalitati', pct: 100 },
  635: { nume: 'Alte impozite si taxe nedeductibile', pct: 100 },
  6814: { nume: 'Ajustari pentru deprecierea creantelor (deductibil 30%, art. 26)', pct: 70 },
  654: { nume: 'Pierderi din creante neincasabile (nedeductibil fara conditii, art. 26)', pct: 100 },
  6812: { nume: 'Provizioane pentru riscuri si cheltuieli (nedeductibile, art. 26)', pct: 100 },
};
// Venituri neimpozabile — `pct` = procentul neimpozabil (simetric cu ajustarea nedeductibila, art. 23)
const NEIMPOZABILE = {
  7814: { nume: 'Venituri din reluarea ajustarilor pentru creante (partea nedeductibila)', pct: 70 },
  7812: { nume: 'Venituri din reluarea provizioanelor nedeductibile', pct: 100 },
};

/** Registrul de evidenta fiscala: trecerea de la rezultatul contabil la cel fiscal. */
function registruFiscal(db, year, cota) {
  const pl = stmt.profitLoss(db, year);
  const r = periodRulaj2(db, year);
  const cheltNeded = [];
  let totalNeded = 0;
  for (const [cod, cfg] of Object.entries(NEDEDUCTIBILE)) {
    const baza = r[cod] ? round2(r[cod].d - r[cod].c) : 0;
    if (baza > 0) {
      const suma = round2((baza * cfg.pct) / 100);
      cheltNeded.push({ cod, nume: cfg.nume, baza, pct: cfg.pct, suma });
      totalNeded = round2(totalNeded + suma);
    }
  }
  const venituriList = [];
  let venituriNeimpozabile = 0;
  for (const [cod, cfg] of Object.entries(NEIMPOZABILE)) {
    const baza = r[cod] ? round2(r[cod].c - r[cod].d) : 0;
    if (baza > 0) {
      const suma = round2((baza * cfg.pct) / 100);
      venituriList.push({ cod, nume: cfg.nume, baza, pct: cfg.pct, suma });
      venituriNeimpozabile = round2(venituriNeimpozabile + suma);
    }
  }
  // Amortizare: contabila vs fiscala (art. 28) — in aplicatie coincid (aceeasi metoda)
  const amortContabila = r['6811'] ? round2(r['6811'].d - r['6811'].c) : 0;
  const mentiuni = [];
  if (amortContabila > 0) mentiuni.push('Art. 28: amortizarea fiscala = amortizarea contabila (' + amortContabila + ' lei), integral deductibila — nicio diferenta.');
  const rezultatContabil = pl.rezBrut;
  const rezultatFiscal = round2(rezultatContabil + totalNeded - venituriNeimpozabile);
  const rateProfit = cota || 16;
  const impozitProfit = round2((Math.max(rezultatFiscal, 0) * rateProfit) / 100);
  const impozitMicro = round2((pl.venitTotal * 1) / 100);
  return {
    year, rezultatContabil, cheltNeded, totalNeded, venituriList, venituriNeimpozabile, mentiuni,
    rezultatFiscal, rateProfit, impozitProfit, impozitMicro, venitTotal: pl.venitTotal,
  };
}

function periodRulaj2(db, year) {
  const lines = acc.allLines(acc.postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year))));
  return acc.accumulate(lines);
}

/** Note explicative la situatiile financiare, generate din date. */
/**
 * Notele explicative oficiale (OMFP 1802/2014), cu cifre auto-completate din contabilitate:
 *  N1 Situatia activelor imobilizate (brut + amortizari, miscare an), N2 Provizioane,
 *  N3 Repartizarea profitului, N4 Analiza rezultatului din exploatare, N5 Creante si datorii.
 * Sectiunile pot avea `linii` (k/v) sau `tabel` (cols + rows) — UI/PDF le randeaza generic.
 */
function notes(db, year) {
  const y = String(year);
  const Y0 = String(Number(y) - 1);
  const open = stmt.finalBalances(db, Y0 + '-12');   // solduri la inceputul exercitiului (= sfarsit an precedent)
  const close = stmt.finalBalances(db, y + '-12');    // solduri la sfarsitul exercitiului
  const ru = acc.accumulate(acc.allLines(acc.postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(y))));
  const f20 = stmt.profitLossF20(db, y);
  const f10 = stmt.balanceSheetF10(db, y + '-12');
  const r = f10.randuri;

  const st = (cod, ...p) => p.some((x) => String(cod).startsWith(x));
  const sumO = (o, pred) => round2(Object.keys(o).filter(pred).reduce((s, c) => s + o[c], 0));
  const sumRu = (pred, key) => round2(Object.keys(ru).filter(pred).reduce((s, c) => s + ((ru[c] && ru[c][key]) || 0), 0));

  // ── NOTA 1 — miscarea imobilizarilor (valoare bruta + amortizari) pe 3 categorii
  const cats = [
    { nume: 'Imobilizari necorporale', gross: (c) => st(c, '20', '233', '234'), amort: (c) => st(c, '280', '290') },
    { nume: 'Imobilizari corporale', gross: (c) => (st(c, '21', '22', '231', '232') && !st(c, '233', '234')), amort: (c) => st(c, '281', '291', '2931') },
    { nume: 'Imobilizari financiare', gross: (c) => st(c, '26', '267'), amort: (c) => st(c, '296') },
  ];
  const n1rows = cats.map((cat) => {
    const brutI = sumO(open, cat.gross); const brutF = sumO(close, cat.gross);
    const amortF = round2(-sumO(close, cat.amort));
    return {
      cat: cat.nume, brutI, intrari: sumRu(cat.gross, 'd'), iesiri: sumRu(cat.gross, 'c'),
      brutF, amortF, netF: round2(brutF - amortF),
    };
  });
  const n1tot = (k) => round2(n1rows.reduce((s, x) => s + x[k], 0));
  n1rows.push({ cat: 'TOTAL', brutI: n1tot('brutI'), intrari: n1tot('intrari'), iesiri: n1tot('iesiri'), brutF: n1tot('brutF'), amortF: n1tot('amortF'), netF: n1tot('netF'), _bold: true });

  // ── NOTA 2 — provizioane (grupa 15)
  const provI = round2(-sumO(open, (c) => st(c, '15')));
  const provF = round2(-sumO(close, (c) => st(c, '15')));
  const n2 = { soldI: provI, constituiri: sumRu((c) => st(c, '15'), 'c'), reluari: sumRu((c) => st(c, '15'), 'd'), soldF: provF };

  // ── NOTA 3 — repartizarea profitului
  const profit = f20.rezNet;
  const capitalSocial = round2(-sumO(close, (c) => st(c, '101')));
  const rezervaExist = round2(-sumO(close, (c) => st(c, '1061')));
  const rezervaPlafon = round2(Math.max(0, capitalSocial * 0.20 - rezervaExist)); // pana la 20% din capital social
  const rezervaLegala = profit > 0 ? round2(Math.min(f20.rezBrut * 0.05, rezervaPlafon)) : 0;
  const reportat = profit > 0 ? round2(profit - rezervaLegala) : 0;
  const n3linii = profit > 0
    ? [{ k: 'Profit net de repartizat', v: profit }, { k: 'Rezerva legala (5% din profit brut, max 20% capital social)', v: rezervaLegala },
      { k: 'Profit reportat / dividende', v: reportat }]
    : [{ k: 'Pierdere a exercitiului (de reportat / acoperit)', v: profit }];

  // ── NOTA 4 — analiza rezultatului din exploatare (din F20)
  const n4linii = [
    { k: '1. Cifra de afaceri neta', v: f20.cifraAfaceri },
    { k: '2. Variatia stocurilor / productia imobilizata', v: f20.venitProductie },
    { k: '3. Alte venituri din exploatare', v: f20.alteVenitExpl },
    { k: '4. Cheltuieli cu materii prime, marfuri, utilitati', v: f20.cheltMateriale },
    { k: '5. Cheltuieli cu personalul', v: f20.cheltPersonal },
    { k: '6. Ajustari de valoare (amortizari)', v: f20.amortizare },
    { k: '7. Alte cheltuieli de exploatare', v: f20.alteCheltExpl },
    { k: 'REZULTATUL DIN EXPLOATARE', v: f20.rezExpl, _bold: true },
  ];

  // ── NOTA 5 — situatia creantelor si datoriilor
  const n5 = {
    creanteTotal: r.B_creante, creanteSub1: r.B_creante, creantePeste1: 0,
    datoriiTotal: round2(r.D_datorii + r.G_datoriiLT), datoriiSub1: r.D_datorii, datorii1_5: r.G_datoriiLT, datoriiPeste5: 0,
  };

  const bs = stmt.balanceSheet(db, y + '-12');
  const pl = stmt.profitLoss(db, y);
  const rf = registruFiscal(db, y);
  const activeCirc = round2(bs.stocuri + bs.creante + bs.casa);
  const lichiditate = bs.datorii ? round2(activeCirc / bs.datorii) : null;
  const solvabilitate = bs.totalActiv ? round2((bs.capitaluri / bs.totalActiv) * 100) : null;
  const rentabilitate = pl.venitTotal ? round2((pl.rezNet / pl.venitTotal) * 100) : null;

  const sections = [
    { titlu: 'Nota 1 — Situatia activelor imobilizate', tabel: {
      cols: [
        { k: 'cat', label: 'Categorie' }, { k: 'brutI', label: 'Brut 01.01', num: true }, { k: 'intrari', label: 'Intrari', num: true },
        { k: 'iesiri', label: 'Iesiri', num: true }, { k: 'brutF', label: 'Brut 31.12', num: true }, { k: 'amortF', label: 'Amortiz. 31.12', num: true },
        { k: 'netF', label: 'Net 31.12', num: true },
      ], rows: n1rows,
    } },
    { titlu: 'Nota 2 — Provizioane', tabel: {
      cols: [{ k: 'k', label: 'Provizioane (grupa 15)' }, { k: 'soldI', label: 'Sold 01.01', num: true }, { k: 'constituiri', label: 'Constituiri', num: true }, { k: 'reluari', label: 'Reluari', num: true }, { k: 'soldF', label: 'Sold 31.12', num: true }],
      rows: [{ k: 'Total provizioane', soldI: n2.soldI, constituiri: n2.constituiri, reluari: n2.reluari, soldF: n2.soldF, _bold: true }],
    } },
    { titlu: 'Nota 3 — Repartizarea profitului', linii: n3linii },
    { titlu: 'Nota 4 — Analiza rezultatului din exploatare', linii: n4linii },
    { titlu: 'Nota 5 — Situatia creantelor si datoriilor', tabel: {
      cols: [{ k: 'k', label: 'Element' }, { k: 'total', label: 'Total', num: true }, { k: 'sub1', label: 'Sub 1 an', num: true }, { k: 'peste1', label: 'Peste 1 an', num: true }],
      rows: [
        { k: 'Creante', total: n5.creanteTotal, sub1: n5.creanteSub1, peste1: n5.creantePeste1 },
        { k: 'Datorii', total: n5.datoriiTotal, sub1: n5.datoriiSub1, peste1: round2(n5.datorii1_5 + n5.datoriiPeste5), _bold: true },
      ],
    } },
    { titlu: 'Nota 6 — Indicatori economico-financiari', linii: [
      { k: 'Lichiditate curenta (active circ. / datorii)', v: lichiditate, raw: true },
      { k: 'Solvabilitate (capitaluri / activ) %', v: solvabilitate, raw: true },
      { k: 'Rata rentabilitatii (rezultat net / venituri) %', v: rentabilitate, raw: true },
    ] },
  ];
  const principii = [
    'Continuitatea activitatii — se presupune ca firma isi continua activitatea in viitorul previzibil.',
    'Prudenta — nu se supraevalueaza activele si veniturile, nici nu se subevalueaza datoriile si cheltuielile.',
    'Independenta exercitiului — fiecare venit si cheltuiala se inregistreaza in perioada de care apartine.',
    'Permanenta metodelor — aceleasi metode de evaluare de la o perioada la alta.',
    'Evaluarea stocurilor la iesire: cost mediu ponderat / FIFO; amortizarea: metoda liniara.',
  ];
  return { year: y, bs, pl, rf, f20, f10, sections, principii, nota1: n1rows, nota2: n2, nota5: n5, lichiditate, solvabilitate, rentabilitate, capitalSocial, rezervaLegala, reportat };
}

/**
 * Buget vs realizat pe un an: pentru fiecare cont bugetat (clasa 6 cheltuieli / 7 venituri),
 * compara suma bugetata cu rulajul efectiv si calculeaza variatia si gradul de realizare.
 */
function budgetReport(db, budgets, year) {
  const ru = acc.accumulate(acc.allLines(acc.postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year)))));
  const actualOf = (cod) => {
    const a = ru[cod] || { d: 0, c: 0 };
    const cl = Number(String(cod)[0]);
    if (cl === 7) return round2(a.c - a.d); // venit = sold creditor
    return round2(a.d - a.c);               // cheltuiala (clasa 6) si rest = sold debitor
  };
  const rows = (budgets || []).map((bg) => {
    const cl = Number(String(bg.cont)[0]);
    const tip = cl === 7 ? 'venit' : (cl === 6 ? 'cheltuiala' : 'alt');
    const buget = round2(Number(bg.suma) || 0);
    const actual = actualOf(bg.cont);
    return {
      id: bg.id, cont: bg.cont, nume: coa.accountName(bg.cont), tip, buget, actual,
      variatie: round2(actual - buget),
      realizarePct: buget ? round2((actual / buget) * 100) : null,
    };
  }).sort((a, b) => String(a.cont).localeCompare(String(b.cont)));
  const sum = (k, pred) => round2(rows.filter(pred).reduce((s, r) => s + r[k], 0));
  const venit = (r) => r.tip === 'venit'; const chelt = (r) => r.tip === 'cheltuiala';
  return {
    year: String(year), rows,
    totalBugetVenit: sum('buget', venit), totalActualVenit: sum('actual', venit),
    totalBugetChelt: sum('buget', chelt), totalActualChelt: sum('actual', chelt),
    rezultatBugetat: round2(sum('buget', venit) - sum('buget', chelt)),
    rezultatActual: round2(sum('actual', venit) - sum('actual', chelt)),
  };
}

function addMonths(period, n) {
  const [y, m] = String(period).split('-').map(Number);
  const d = new Date(y, (m - 1) + n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function recurringAmount(t) {
  const f = t.fields || {};
  return round2((Number(f.baza) || 0) + (Number(f.tva) || 0)) || round2(Number(f.suma) || 0) || round2(Number(f.total) || 0);
}
function isIncomeTemplate(tip) { return /vanzare|^livrare_intra|^bon_fiscal|^aviz|factura_simplificata|incasare/.test(String(tip)); }

/**
 * Previziune de cash-flow pe un orizont de luni. Model transparent: luna 1 incaseaza soldurile deschise
 * de clienti si plateste datoriile catre furnizori; toate lunile adauga facturile recurente scadente.
 * Nu inventeaza date — proiecteaza din ce e deja cunoscut (solduri + sabloane recurente).
 */
function cashForecast(db, templates, opts) {
  opts = opts || {};
  const months = Math.min(24, Math.max(1, Number(opts.months) || 6));
  const fb = stmt.finalBalances(db, null);
  const pos = (c) => round2(fb[c] || 0);
  let cash = round2(pos('5121') + pos('5311') + pos('5124') + pos('5314'));
  const cashNow = cash;
  const rc = reconcile(db);
  const start = (opts.startPeriod && /^\d{4}-\d{2}$/.test(opts.startPeriod)) ? opts.startPeriod : new Date().toISOString().slice(0, 7);
  const rows = [];
  for (let i = 0; i < months; i++) {
    const period = addMonths(start, i);
    const opening = cash;
    const due = recurring.dueForPeriod(templates || [], period);
    let recIn = 0; let recOut = 0;
    for (const t of due) { const amt = recurringAmount(t); if (isIncomeTemplate(t.tip)) recIn = round2(recIn + amt); else recOut = round2(recOut + amt); }
    const incClienti = i === 0 ? rc.totalClienti : 0;
    const platiFurnizori = i === 0 ? rc.totalFurnizori : 0;
    const net = round2(incClienti + recIn - platiFurnizori - recOut);
    cash = round2(cash + net);
    rows.push({ period, opening, incClienti, recIn, platiFurnizori, recOut, net, closing: cash });
  }
  const minClosing = rows.length ? Math.min(...rows.map((r) => r.closing)) : cashNow;
  return {
    startPeriod: start, months, cashNow, openReceivables: rc.totalClienti, openPayables: rc.totalFurnizori,
    rows, ending: cash, minClosing: round2(minClosing), riscLichiditate: minClosing < 0,
  };
}

/** KPI pentru dashboard. */
/** Anul ultimei inregistrari (implicit anul curent) — o singura trecere, fara sortare.
 *  Folosit si direct de /api/dashboard-charts: anul implicit NU merita un dashboard() intreg. */
function latestYear(db) {
  let max = '';
  for (const e of acc.postedEntries(db)) { const p = e.period || periodOf(e.data); if (p && p > max) max = p; }
  return max ? max.slice(0, 4) : String(new Date().getFullYear());
}

function dashboard(db) {
  const year = latestYear(db);
  const rc = reconcile(db);
  const vat = acc.vatJournals(db, null).totals;
  const pl = stmt.profitLoss(db, year);
  const plPrev = stmt.profitLoss(db, String(Number(year) - 1));
  const fb = stmt.finalBalances(db, null);
  const pos = (cod) => Math.max(round2(fb[cod] || 0), 0);
  const topList = (cont) => rc.partners.filter((p) => p.cont === cont && p.sold > 0)
    .sort((a, b) => b.sold - a.sold).slice(0, 5).map((p) => ({ den: p.den, cui: p.cui, sold: p.sold }));
  // variatie procentuala an-la-an (null cand anul precedent e 0)
  const pct = (cur, prev) => (prev ? round2(((cur - prev) / Math.abs(prev)) * 100) : null);
  const yoY = {
    year: Number(year), prevYear: Number(year) - 1,
    venituri: pl.venitTotal, venituriPrev: plPrev.venitTotal, venituriDelta: pct(pl.venitTotal, plPrev.venitTotal),
    cheltuieli: pl.cheltTotal, cheltuieliPrev: plPrev.cheltTotal, cheltuieliDelta: pct(pl.cheltTotal, plPrev.cheltTotal),
    profit: pl.rezNet, profitPrev: plPrev.rezNet, profitDelta: pct(pl.rezNet, plPrev.rezNet),
    marja: pl.venitTotal ? round2((pl.rezNet / pl.venitTotal) * 100) : null,
    marjaPrev: plPrev.venitTotal ? round2((plPrev.rezNet / plPrev.venitTotal) * 100) : null,
  };
  return {
    year, yoY,
    soldClienti: rc.totalClienti,
    soldFurnizori: rc.totalFurnizori,
    tvaDePlata: vat.deplata,
    tvaDeRecuperat: vat.derecuperat,
    numerar: pos('5311'),
    banca: pos('5121'),
    venituri: pl.venitTotal,
    cheltuieli: pl.cheltTotal,
    profit: pl.rezNet,
    clientiDeschisi: rc.partners.filter((p) => p.cont === '4111' && p.sold > 0).length,
    furnizoriDeschisi: rc.partners.filter((p) => p.cont === '401' && p.sold > 0).length,
    topCreante: topList('4111'),
    topDatorii: topList('401'),
    // Rezumat executiv (modul simplu): agregate in limbaj de business.
    // neg() = soldul creditor ca numar pozitiv (datorie), pos() = soldul debitor.
    disponibilTotal: round2(pos('5121') + pos('5124') + pos('5311') + pos('5314')),
    bancaTotal: round2(pos('5121') + pos('5124')),
    casaTotal: round2(pos('5311') + pos('5314')),
    taxeDatorate: round2(['4423', '4411', '444', '4315', '4316', '436', '446', '447', '4481'].reduce((s, c) => s + Math.max(round2(-(fb[c] || 0)), 0), 0)),
    salariiDePlata: round2(['421', '425', '426', '427'].reduce((s, c) => s + Math.max(round2(-(fb[c] || 0)), 0), 0)),
  };
}

/** Serie lunara venituri/cheltuieli/profit pentru un an (pentru grafice). */
function monthlySeries(db, year) {
  // O singura trecere prin inregistrari (nu 12 filtrari repetate — conteaza la volume mari).
  // Acumularea ramane per luna, in ordinea inregistrarilor, cu round2 la fiecare pas —
  // exact rotunjirea versiunii precedente.
  const y = String(year);
  const sums = new Map(); // luna (1-12) -> { ven, chelt }
  for (let m = 1; m <= 12; m++) sums.set(m, { ven: 0, chelt: 0 });
  for (const e of acc.postedEntries(db)) {
    const p = e.period || periodOf(e.data);
    if (!p || p.slice(0, 4) !== y) continue;
    const s = sums.get(Number(p.slice(5, 7)));
    if (!s) continue;
    for (const l of acc.allLines([e])) {
      if (/^7/.test(l.credit)) s.ven = round2(s.ven + l.suma);
      if (/^7/.test(l.debit)) s.ven = round2(s.ven - l.suma);
      if (/^6/.test(l.debit)) s.chelt = round2(s.chelt + l.suma);
      if (/^6/.test(l.credit)) s.chelt = round2(s.chelt - l.suma);
    }
  }
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const s = sums.get(m);
    out.push({ period: y + '-' + String(m).padStart(2, '0'), luna: m, venituri: s.ven, cheltuieli: s.chelt, profit: round2(s.ven - s.chelt) });
  }
  return out;
}

// Raportul articolelor STORNATE: perechile (original stornat -> nota de storno), pentru control
// intern si trasabilitatea corectiilor. Filtreaza pe perioada dupa data originalului sau a stornului
// (o corectie apare daca oricare pica in perioada ceruta). period = YYYY | YYYY-MM | null (tot).
function stornoReport(db, period) {
  const ents = db.entries || [];
  const byId = new Map(ents.map((e) => [e.id, e]));
  const inPer = (p) => !period || (String(period).length === 4 ? String(p || '').startsWith(period) : String(p || '') === period);
  const total = (arr) => round2((arr || []).reduce((s, l) => s + l.suma, 0));
  const rows = [];
  for (const e of ents) {
    if (!e.stornat || !e.stornoBy) continue; // doar originalele reversate
    const sn = byId.get(e.stornoBy);
    const oPer = e.period || periodOf(e.data);
    const sPer = sn ? (sn.period || periodOf(sn.data)) : null;
    if (!(inPer(oPer) || inPer(sPer))) continue;
    rows.push({
      id: e.id, data: e.data, tip: e.tipNume, document: e.document || '', partener: e.partener || '',
      total: total(e.lines),
      stornoId: e.stornoBy, stornoData: (sn && sn.data) || e.stornoData || '', stornoTotal: sn ? total(sn.lines) : total(e.lines),
    });
  }
  rows.sort((a, b) => String(b.stornoData || '').localeCompare(String(a.stornoData || '')));
  return { period: period || null, rows, total: round2(rows.reduce((s, r) => s + r.total, 0)) };
}

// D101 — CALCULUL declaratiei anuale de impozit pe profit (figuri semantice, independente de
// versiunea schemei XML): rezultat pe exploatare/financiar, rezultat brut, profit impozabil,
// impozit. Peste accounting.profitTax (baza fiscala, pierdere reportata, impozit). Splitul
// exploatare/financiar: veniturile/cheltuielile financiare = conturile 76x/66x.
// NB: generarea XML-ului oficial D101 nu e (inca) inclusa — schema ANAF e versionata pe an
// (namespace d101:declaratie:vN), cu layout de indicatori si aritmetica specifice fiecarei
// versiuni; se adauga cand maparea pe versiunea curenta e verificata cu DUKIntegrator.
function d101(db, year, opts) {
  opts = opts || {};
  const pt = acc.profitTax(db, year, opts);
  const yearEntries = acc.postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year)));
  const r = acc.accumulate(acc.allLines(yearEntries));
  let vExpl = 0; let vFin = 0; let cExpl = 0; let cFin = 0;
  for (const cod of Object.keys(r)) {
    const c = String(cod);
    const clasa = (coa.getAccount(cod) || {}).clasa || Number(c[0]);
    if (clasa === 7) { const net = round2(r[cod].c - r[cod].d); if (/^76/.test(c)) vFin = round2(vFin + net); else vExpl = round2(vExpl + net); }
    else if (clasa === 6 && !/^(691|698)/.test(c)) { const net = round2(r[cod].d - r[cod].c); if (/^66/.test(c)) cFin = round2(cFin + net); else cExpl = round2(cExpl + net); }
  }
  const rezExploatare = round2(vExpl - cExpl);
  const rezFinanciar = round2(vFin - cFin);
  const rezultatBrut = round2(rezExploatare + rezFinanciar); // = profit contabil (venituri - cheltuieli)
  return {
    year: String(year), cota: pt.cota,
    venituriExploatare: vExpl, cheltuieliExploatare: cExpl, rezExploatare,
    venituriFinanciare: vFin, cheltuieliFinanciare: cFin, rezFinanciar,
    rezultatBrut,
    cheltuieliNedeductibile: round2(pt.cheltNedeductibile || 0),
    deduceriFiscale: round2(pt.deduceri || 0),
    pierdereReportata: round2(pt.pierdereReportata || 0),
    pierdereFolosita: round2(pt.pierdereFolosita || 0),
    profitImpozabil: round2(pt.profitImpozabil || 0),
    impozit: round2(pt.impozit || 0),
    impozitDePlata: round2(pt.impozit || 0), // fara plati anticipate/credite fiscale modelate
    scadenta: (Number(String(year).slice(0, 4)) + 1) + '-03-25',
  };
}

module.exports = { d112, d300, d390, d205, intrastat, obligatii, d100micro, d101, declaratiaUnica, proRataTva, achizitiiPfCarnet, registruInventar, livrabile, dashboard, latestYear, monthlySeries, registruFiscal, notes, budgetReport, cashForecast, stornoReport };
