'use strict';

const { round2, period: periodOf } = require('./util');
const fiscal = require('./fiscal');
// Nomenclatorul tarilor UE (D390) se ia din config, nu din `fiscal`: `fiscal.FISCAL` expune cotele
// suprascriabile din Setari, iar lista de tari nu e o cota — nu are ce cauta acolo.
const fiscalCfg = require('./fiscalConfig');
const bnr = require('./bnr'); // cursul oficial pentru plafoanele exprimate in euro
const coa = require('./chartOfAccounts');
const acc = require('./accounting');
const deduct = require('./deductibilitate');
const micro = require('./impozitMicro'); // baza art. 53 + cota art. 51 (sursa unica: D100 si registrul fiscal)
const assets = require('./assets');
const fiscalProfile = require('./fiscalProfile'); // regimul firmei (micro/profit) pentru livrabile
// Termenele, dintr-o singura sursa. `declarations.js` importa doar accounting + fiscalProfile,
// deci nu se inchide niciun ciclu.
const decl = require('./declarations');
const stmt = require('./statements');
const { reconcile } = require('./reconcile');
const recurring = require('./recurring');
const CONT_SPONSORIZARE = '6582'; // art. 25(4)(i) — cheltuiala de sponsorizare
// Maparea cota->rand D300 si perimetrul e-Factura. xml.js nu importa nimic din lantul de
// raportare (importa doar util + documentTypes), deci nu se inchide niciun ciclu — verificat.
const xml = require('./xml');

/** Rulajele perioadei pe cont {cod:{d,c}}, FARA inchiderile 6/7 -> 121 (vezi `resultLines`).
 *  Alimenteaza recapitulativul D112, care citeste 641: nota de inchidere anuala (121 = 641) e
 *  datata 31 decembrie, deci cadea exact in luna raportata si anula rulajul contului. Salariile
 *  lui decembrie ieseau cu brut 0 si un net NEGATIV, fiindca retinerile (clasa 4) raman intacte —
 *  singura luna din an in care recapitulativul minte, si tocmai cea in care se face inchiderea. */
function periodRulaj(db, period) {
  const lines = acc.resultLines(acc.postedEntries(db).filter((e) => (e.period || periodOf(e.data)) === period));
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
  // `vj.totals.scutite` (bazele fara TVA, pe categorie) intra in plic prin Object.assign —
  // d300Rows le mapeaza pe randurile proprii (R1 intracomunitar, R13 taxare inversa).
  // `vj.totals` aduce in plic si `scutite` (baze fara TVA, pe categorie), si `autolichidari`
  // (perechile colectata/deductibila ale taxarii inverse) — d300Rows le mapeaza pe randurile lor.
  // `report` = pozitia de TVA ramasa din perioadele anterioare (randurile 35 si 38 din decont).
  return Object.assign({ period, coteV: vj.coteV, coteC: vj.coteC, scutiteRows: vj.scutite,
    report: acc.vatCarryForward(db, period) }, vj.totals);
}

// Cote de TVA acceptate (RO, curente + istorice recente): 21/11/9 curente, 19/5 istorice, 0 scutit.
const COTE_TVA_VALIDE = new Set([0, 5, 9, 11, 19, 21]);
// Tipurile care se EMIT in SPV (RO e-Factura) — trebuie sa se regaseasca in decontul precompletat.
// Sursa unica: `xml.isSendable`, derivat din `eFactura: 'da'` de pe definitia tipului. Era o copie
// de mana a listei din xml.js; a treia copie statea in declarations.js. Trei liste ale aceluiasi
// lucru, actualizate de trei ori sau — cum s-a si intamplat — de zero ori.

/**
 * Reconciliere TVA — pregatire pentru decontul precompletat e-TVA. Confrunta pozitia TVA a perioadei
 * (jurnale = D300) cu sursele pe care ANAF le vede si prinde exact ce ar produce o discrepanta la
 * notificarea de conformare:
 *   - COTE NECONFORME: randuri de jurnal cu TVA/baza in afara cotelor valide (eroare de inregistrare);
 *   - e-FACTURA EMISE NETRIMISE: vanzari cu TVA in perioada care nu au plecat in SPV — ANAF le vede
 *     prin RO e-Factura si le include in decontul precompletat, dar D300-ul tau nu le-ar reflecta.
 * Intoarce pozitia (colectata/deductibila/net), defalcarea pe cote si constatarile { nivel, cod, mesaj }.
 */
function tvaReconciliation(db, period) {
  const vj = acc.vatJournals(db, period);
  const t = vj.totals;
  const findings = [];

  // 1) Cote neconforme (taxarea inversa are TVA autolichidata pe aceeasi baza -> exclusa)
  const coteAnormale = [];
  for (const [tip, rows] of [['vanzare', vj.vanzari], ['cumparare', vj.cumparari]]) {
    for (const r of rows) {
      if (r.taxareInversa || r.tva === 0) continue;
      // cota de pe rand = cea a FACTURII; recalculata din tva/baza, o achizitie cu TVA partial
      // deductibil (auto 50%, pro-rata) ar da 10% si ar fi raportata fals ca „cota neconforma".
      const cota = r.baza > 0 ? (r.cota || Math.round((r.tva / r.baza) * 100)) : -1; // baza 0 cu TVA > 0 = anormal
      if (!COTE_TVA_VALIDE.has(cota)) coteAnormale.push({ tip, document: r.document || '', partener: r.partener || '', baza: r.baza, tva: r.tva, cota });
    }
  }
  if (coteAnormale.length) findings.push({ nivel: 'atentie', cod: 'tva-cota-neconforma',
    mesaj: coteAnormale.length + ' înregistrare/înregistrări cu cotă TVA neconformă (nu se potrivește 21/11/9/5/0%) — verifică; ANAF le compară cu e-Factura.' });

  // 2) e-Factura emise cu TVA, netrimise in SPV, in perioada
  const netrimise = [];
  for (const e of acc.postedEntries(db)) {
    if (!xml.isSendable(e) || !acc.inPeriod(e, period)) continue;
    if (e.spv && (e.spv.index || e.spv.stare)) continue; // deja trimisa
    // Acelasi criteriu ca la restantele e-Factura: un beneficiar din alt stat nu produce o factura
    // pe care ANAF s-o vada in decontul precompletat. B2C-ul, in schimb, se raporteaza din 2025.
    if (xml.perimetruEFactura(e.partenerCui, (db.partners || {})[String(e.partenerCui || '').replace(/^ro/i, '')]) === 'strain') continue;
    const areTva = (e.lines || []).some((l) => String(l.credit) === '4427' && Number(l.suma) > 0);
    if (!areTva) continue;
    netrimise.push({ entryId: e.id, document: e.document || '', partener: e.partener || '', data: e.data });
  }
  if (netrimise.length) findings.push({ nivel: 'atentie', cod: 'efactura-netrimisa',
    mesaj: netrimise.length + ' factură/facturi emise cu TVA NEtrimise în SPV — ANAF le include în decontul precompletat; trimite-le ca D300 să se potrivească.' });

  // 3) Cote care nu au rand in schema D300 v12 — sume care NU pot intra in decont. Tipic: achizitii
  // la 9% (cota exista la livrari, dar v12 nu are rand de achizitii pentru ea) sau date vechi la
  // 19%/5%. Inainte se emiteau pe randuri istorice si ANAF respingea toata declaratia.
  const faraRand = xml.d300CoteFaraRand({ coteV: vj.coteV, coteC: vj.coteC });
  if (faraRand.length) findings.push({ nivel: 'eroare', cod: 'tva-cota-fara-rand',
    mesaj: faraRand.map((c) => `${c.sens} la ${c.cota}% (bază ${c.baza} lei, TVA ${c.tva} lei)`).join('; ')
      + ' — cotă fără rând în schema D300 v12, suma NU intră în decont. Verifică încadrarea; declarația ar fi respinsă dacă am emite-o oricum.' });

  return {
    period,
    colectata: t.colectata, deductibila: t.deductibila, deplata: t.deplata, derecuperat: t.derecuperat,
    coteV: vj.coteV, coteC: vj.coteC,
    coteAnormale, netrimise, faraRand,
    findings,
    ok: findings.every((f) => f.nivel !== 'eroare'),
  };
}

// Codurile de operatiune din D390 si semnificatia lor. Literele NU sunt ghicite: enumul acceptat
// e sondat la validatorul oficial (toate sase trec, 'X' e respins cu „valoarea nu se afla in
// lista"), iar legarea lor de campurile din rezumat e scrisa in regulile validatorului insusi —
// `bazaX ('@0@') = Suma(baza pt. tip = X)`, cate una pentru fiecare litera. Semantica (care litera
// e bunuri si care servicii) vine din instructiunile OPANAF, vezi `SURSE.d390` din fiscalConfig.
//
//   L = livrari intracomunitare de bunuri        A = achizitii intracomunitare de bunuri
//   P = prestari intracomunitare de servicii     S = achizitii intracomunitare de servicii
//   T = livrari in operatiuni triunghiulare      R = livrari in regimul special pentru agricultori
//
// T si R raman neacoperite (nu exista tipuri de document pentru ele) si de aceea ies pe zero din
// generator — dar ies dintr-o suma peste zero randuri, nu dintr-un literal „0" scris in XML.
const D390_CODURI = ['L', 'T', 'A', 'P', 'S', 'R'];
const D390_VANZARI = new Set(['L', 'T', 'P', 'R']); // baza se citeste din venituri (clasa 70)
/** Codurile pe SERVICII — singurele pentru care Irlanda de Nord (XI) nu e tara UE valida. */
const D390_SERVICII = new Set(['P', 'S']);

/**
 * Recap D390 — declaratia recapitulativa VIES: livrari/achizitii intracomunitare de BUNURI
 * (L/A) si prestari/achizitii intracomunitare de SERVICII (P/S), art. 325 Cod fiscal.
 *
 * Serviciile lipseau cu totul, desi sunt operatiunea cea mai frecventa din declaratie: orice firma
 * care plateste reclama, gazduire sau licente unui prestator din UE le are lunar.
 *
 * UE vs. non-UE se DERIVA din prefixul codului de TVA al partenerului, nu se bifeaza. Doua motive:
 * prefixul e oricum obligatoriu in declaratie (`codO` + `tara`), deci daca lipseste operatiunea nu
 * se poate declara oricum; si asa se incadreaza corect si articolele inregistrate INAINTE de
 * existenta codurilor de servicii, fara migrare. Ce nu trece de derivare NU dispare tacit: iese in
 * `avertismente`, pe care validarea pre-depunere le arata contabilului.
 */
function d390(db, period) {
  const INTRACOM = {
    livrare_intracomunitara: 'L',
    achizitie_intracomunitara: 'A',
    prestare_servicii_intracomunitara: 'P',
    achizitie_servicii_intracomunitara: 'S',
  };
  // AUTOFACTURA (art. 320) se declara ca operatiunea pe care o documenteaza: bunuri -> A,
  // servicii -> S. Din conturi nu se poate deduce care e (si taxarea inversa interna, si serviciile
  // din afara dau acelasi 4426 = 4427), de aceea natura vine din marcajul pus pe articol la
  // inregistrare (`naturaAutofactura`) — vezi composeEntry. Fara asta, autofactura ar fi lipsit din
  // D390 tocmai in cazul in care legea a cerut-o ca sa NU lipseasca.
  const NATURA = { intracom: 'A', servicii: 'S' }; // 'intern331' -> null (art. 331 e intern)
  const codDe = (e) => (e.tip === 'autofactura_achizitie'
    ? (NATURA[e.naturaAutofactura] || null)
    : (INTRACOM[e.tip] || null));
  const ent = acc.postedEntries(db).filter((e) => codDe(e)
    && (!period || String(e.period || periodOf(e.data)).startsWith(period)));
  const map = new Map();
  const avertismente = [];
  for (const e of ent) {
    const cod = codDe(e);
    let baza = 0;
    for (const l of e.lines) {
      // Vanzari (livrare/prestare): baza e VENITUL (clasa 70).
      if (D390_VANZARI.has(cod) && /^70/.test(String(l.credit))) baza = round2(baza + l.suma);
      // Achizitii: valoarea din linia catre FURNIZOR. La autofactura datoria sta pe 408 (factura
      // chiar nu a sosit), nu pe 401 — o ancora doar pe 401 ar fi citit baza 0 si ar fi raportat
      // operatiunea cu suma zero, ceea ce e mai rau decat s-o omita.
      if (!D390_VANZARI.has(cod) && (String(l.credit) === '401' || String(l.credit) === '408')) baza = round2(baza + l.suma);
    }
    const cui = String(e.partenerCui || '').replace(/[\s-]/g, '').toUpperCase();
    const tara = cui.slice(0, 2);
    // Irlanda de Nord (XI) e stat membru DOAR pentru bunuri (Protocolul pentru Irlanda/Irlanda de
    // Nord acopera bunurile, nu serviciile) — de aceea lista difera dupa cod, nu e una singura.
    const listaUE = D390_SERVICII.has(cod) ? fiscalCfg.TARI_UE : fiscalCfg.TARI_UE_BUNURI;
    if (tara === 'RO' || !listaUE.includes(tara)) {
      // Nedeclarabil: fie chiar nu e o operatiune intracomunitara (prestator din afara UE — taxare
      // inversa da, D390 nu), fie codul de TVA al partenerului lipseste ori e gresit. Din date nu
      // se poate distinge intre cele doua, si nici nu trebuie: amandoua cer ochiul contabilului.
      if (baza !== 0) {
        avertismente.push({ cod, entryId: e.id, data: e.data, partener: e.partener || '',
          cui, tara: tara || '', baza: round2(baza) });
      }
      continue;
    }
    const key = cod + '|' + cui;
    const r = map.get(key) || { cod, cui, tara, denumire: e.partener || '', baza: 0, nrop: 0 };
    r.baza = round2(r.baza + baza); r.nrop += 1;
    if (!r.denumire && e.partener) r.denumire = e.partener;
    map.set(key, r);
  }
  const rows = [...map.values()].filter((r) => r.baza !== 0).sort((a, b) => (a.cod + a.cui).localeCompare(b.cod + b.cui));
  // Totalurile pe fiecare cod, ca sa nu mai existe un `totalL`/`totalA` scris de mana pentru doua
  // litere si un literal „0" in XML pentru celelalte patru.
  const totaluri = {};
  for (const c of D390_CODURI) {
    totaluri[c] = round2(rows.filter((r) => r.cod === c).reduce((s, r) => s + r.baza, 0));
  }
  return { period, rows, totaluri, avertismente,
    totalL: totaluri.L, totalA: totaluri.A, // pastrate: le citesc panourile si testele existente
    total: round2(D390_CODURI.reduce((s, c) => s + totaluri[c], 0)), nr: rows.length };
}

/** Recap D205 — impozit pe venit retinut la sursa (dividende, chirii, premii), pe beneficiar. */
function d205(db, year) {
  const TIPURI = { repartizare_dividende: 'Dividende', chirie_pf: 'Chirii', premiu_pf: 'Premii' };
  // Felul venitului decide BAZA impozabila, care nu e brutul (art. 84 la chirii, art. 110 alin. (4)
  // la premii). Se calculeaza per ARTICOL, nu pe totalul beneficiarului: suma neimpozabila de 600
  // de lei se acorda pentru FIECARE premiu, deci scazuta o singura data din cumulat ar declara o
  // baza prea mare la cine a primit mai multe premii.
  const FEL = { repartizare_dividende: 'dividende', chirie_pf: 'chirii', premiu_pf: 'premii' };
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
    const baza = fiscal.retinereLaSursa(FEL[e.tip], brut).baza;
    const cnp = String(e.partenerCui || '').replace(/\s/g, '').toUpperCase();
    const key = tip + '|' + (cnp || e.partener || '-');
    const r = map.get(key) || { tipVenit: tip, beneficiar: e.partener || '', cnp, venitBrut: 0, bazaImpozabila: 0, impozit: 0, nrInreg: 0 };
    r.venitBrut = round2(r.venitBrut + brut); r.bazaImpozabila = round2(r.bazaImpozabila + baza);
    r.impozit = round2(r.impozit + impozit); r.nrInreg += 1;
    if (!r.beneficiar && e.partener) r.beneficiar = e.partener;
    map.set(key, r);
  }
  const rows = [...map.values()].sort((a, b) => (a.tipVenit + a.beneficiar).localeCompare(b.tipVenit + b.beneficiar));
  return { year: String(year), rows,
    totalBrut: round2(rows.reduce((s, r) => s + r.venitBrut, 0)),
    totalBaza: round2(rows.reduce((s, r) => s + r.bazaImpozabila, 0)),
    totalImpozit: round2(rows.reduce((s, r) => s + r.impozit, 0)), nr: rows.length };
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

/** Recap D100 — impozitul pe veniturile microintreprinderii. Baza (art. 53) si cota (art. 51) vin
 *  din `src/impozitMicro.js`; aici raman doar decuparea trimestrului si semnalele de eligibilitate.
 *  `cota` transmis explicit ramane suprascriere (contract istoric al rutei si al PDF-ului). */
function d100micro(db, period, cota, opts) {
  // Impozitul micro e TRIMESTRIAL: veniturile se cumuleaza pe toate lunile trimestrului
  // din care face parte `period` (ex. 2026-06 -> aprilie + mai + iunie).
  const m = Number(String(period || '').slice(5, 7)) || 0;
  const y = String(period || '').slice(0, 4);
  const q0 = m ? m - ((m - 1) % 3) : 0;
  const luni = m ? [q0, q0 + 1, q0 + 2].map((x) => y + '-' + String(x).padStart(2, '0')) : [];
  const lines = acc.resultLines(acc.postedEntries(db).filter((e) => luni.includes(String(e.period || periodOf(e.data)))));
  const r = acc.accumulate(lines);
  // Semnal de eligibilitate micro (art. 47 Cod fiscal): plafonul de venituri (EUR, configurabil)
  // si conditia de salariat. Doar AVERTIZEAZA — incadrarea finala ramane la contribuabil.
  const rAn = acc.accumulate(acc.resultLines(acc.postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(y))));
  let venitAn = 0;
  for (const cod of Object.keys(rAn)) {
    const a = coa.getAccount(cod);
    if ((a ? a.clasa : Number(String(cod)[0])) === 7) venitAn = round2(venitAn + (rAn[cod].c - rAn[cod].d));
  }
  // Baza art. 53 a trimestrului. Ultimul trimestru (T4) reintroduce diferenta favorabila de curs
  // cumulata pe an, deci primeste si rulajul anual.
  const trimestru = m ? Math.ceil(m / 3) : 0;
  const bz = micro.baza(r, { ultimulTrimestru: trimestru === 4, rulajAn: rAn });
  const venit = bz.baza;
  // Cota, pe veniturile cumulate PANA LA FINALUL trimestrului raportat: art. 51 alin. (4) comuta
  // de la trimestrul depasirii, nu de la anul urmator, deci contorul nu poate fi nici cel al
  // trimestrului singur, nici cel al anului intreg (care ar include luni viitoare).
  const pana = m ? y + '-' + String(q0 + 2).padStart(2, '0') : y + '-12';
  const rCum = acc.accumulate(acc.resultLines(acc.postedEntries(db)
    .filter((e) => { const p = String(e.period || periodOf(e.data)); return p.startsWith(y) && p <= pana; })));
  const venitCumulatLei = micro.baza(rCum, {}).baza;
  // Cursul plafonului vine de la BNR, din ultima zi a exercitiului precedent — nu din valoarea
  // rotunda de configurare. La 5,0 in loc de ~5,08, plafonul de 100.000 EUR iese 500.000 in loc de
  // ~508.000, iar o firma cu 505.000 lei era declarata gresit iesita din regimul micro.
  const cursP = bnr.cursPlafonMicro(db.cursuriBnr, Number(y), fiscal.FISCAL.cursPlafonMicro);
  const ct = micro.cotaAplicabila({ venitCumulatLei, curs: cursP.curs,
    caen: (db.company || {}).caen }, fiscal.FISCAL);
  const rate = cota || ct.cota;
  const plafonLei = round2((fiscal.FISCAL.plafonMicroEur || 0) * (cursP.curs || 0));
  const avertismente = [];
  // Un plafon calculat pe o valoare implicita nu are voie sa arate la fel cu unul calculat pe
  // cursul oficial: incadrarea in regimul micro se decide pe el. Semnalam insa doar cand cursul
  // chiar POATE schimba raspunsul — adica in preajma plafonului. La 10% din plafon, diferenta
  // dintre 5,0 si 5,08 nu intereseaza pe nimeni, iar un avertisment care apare mereu nu mai e citit.
  if (cursP.sursa !== 'bnr' && plafonLei > 0 && venitAn > round2(plafonLei * 0.9)) {
    avertismente.push('Plafonul micro e calculat cu cursul ORIENTATIV din setari (' + cursP.curs
      + ' lei/EUR), fiindca nu exista curs BNR pentru 31 decembrie ' + (Number(y) - 1)
      + '. Adu cursurile BNR (Setari -> Curs valutar) inainte de a decide incadrarea.');
  }
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
  // Motivul cotei si notele bazei ajung in avertismente doar cand spun ceva ce nu se vede din
  // cifre: cota comutata pe 3% e o schimbare pe care contabilul trebuie s-o observe, nu s-o afle
  // din suma finala. Suprascrierea manuala tace despre motiv — nu mai e al motorului.
  if (!cota && ct.cota !== (fiscal.FISCAL.impozitMicro || 1)) avertismente.push(ct.motiv);
  for (const a of ct.avertismente) avertismente.push(a);
  for (const n of bz.note) avertismente.push(n);
  // SPONSORIZAREA la micro (art. 56^1): se SCADE din impozitul trimestrial, in limita a 20% din el.
  // Pana acum aplicatia n-o scadea deloc, deci firmele micro declarau un impozit mai mare decat cel
  // datorat, iar D177 vedea intreg plafonul ca redirectionabil (`sumaAnt` era mereu 0) — cele doua
  // erori se ascundeau una pe alta si pareau coerente impreuna.
  // Partea nefolosita NU se pierde: se reporteaza (art. 56^1 alin. (3)), dar reportul cere o
  // evidenta pe trimestre pe care aplicatia inca n-o tine — deci aici se scade doar sponsorizarea
  // TRIMESTRULUI, iar restul apare in `sponsorizareNefolosita`, ca sa fie vizibil, nu pierdut tacit.
  const impozitBrut = round2((venit * rate) / 100);
  // Reportul art. 56^1 alin. (3) se DERIVA, nu se stocheaza: un pas inainte peste trimestrele
  // anterioare da exact ce a ramas nefolosit si inca valabil. Fara stocare nu e nevoie nici de
  // migrare, nici de hook la postare — si dispare capcana in care o simpla PREVIZUALIZARE ar
  // consuma plafon. `faraReport` opreste pasul inainte cand suntem deja in interiorul lui.
  const reportIn = (opts && opts.faraReport) ? [] : reportMicroLaInceputul(db, period);
  const sponsTrim = round2(acc.postedEntries(db)
    .filter((e) => luni.includes(String(e.period || periodOf(e.data))))
    .reduce((sx, e) => sx + (e.lines || [])
      .filter((l) => String(l.debit || '').startsWith(CONT_SPONSORIZARE))
      .reduce((sy, l) => sy + (Number(l.suma) || 0), 0), 0));
  const plafonSpons = round2((impozitBrut * (Number(fiscal.FISCAL.sponsorizareImpozitPct) || 0)) / 100);
  // Consum FIFO: „in ordinea inregistrarii" (alin. (3)) — deci reportul VECHI intai, sponsorizarea
  // trimestrului la urma. Ordinea inversa ar lasa sa expire tocmai ce era pe cale sa expire.
  const cons = consumaVintage(reportIn.concat([{ trimestru: period, suma: sponsTrim }]), plafonSpons);
  const sponsDedusa = cons.folosit;
  const dinReport = round2(cons.folosit - (cons.detaliu.filter((x) => x.trimestru === period)
    .reduce((sx, x) => sx + x.folosit, 0)));
  return { period, trimestru, luni, venit, cota: rate,
    impozitBrut, sponsorizareTrimestru: sponsTrim, plafonSponsorizare: plafonSpons,
    sponsorizareDedusa: sponsDedusa, sponsorizareDinReport: dinReport,
    sponsorizareReportIn: reportIn, sponsorizareReportOut: cons.ramase,
    sponsorizareExpirata: cons.expirate,
    // ce ramane NEFOLOSIT din trimestrul curent (restul pleaca in report, nu se pierde)
    sponsorizareNefolosita: round2(sponsTrim - (cons.detaliu.filter((x) => x.trimestru === period)
      .reduce((sx, x) => sx + x.folosit, 0))),
    impozit: round2(impozitBrut - sponsDedusa),
    venitAn, plafonMicroLei: plafonLei, plafonMicroEur: fiscal.FISCAL.plafonMicroEur, avertismente,
    // Desfasurarea bazei (art. 53) si a cotei (art. 51), pentru raport si pentru revizie.
    venitClasa7: bz.venitClasa7, scaderi: bz.scaderi, totalScaderi: bz.totalScaderi,
    adaugari: bz.adaugari, totalAdaugari: bz.totalAdaugari,
    cotaMotiv: cota ? 'Cotă impusă manual (' + rate + '%).' : ct.motiv, cotaPrin: cota ? 'manual' : ct.prin,
    pragMicro3Lei: ct.pragLei, venitCumulatLei };
}

// Nomenclatorul de obligatii D100 (atributele `cod_oblig` + `cod_bugetar` ale sectiunii <obligatie>).
// Perechile NU sunt ghicite: `20A031800` era deja verificat pentru micro, iar cea de impozit pe
// profit a fost SONDATA pe validatorul oficial — la `cod_bugetar="20A010100"` (candidatul evident,
// singurul cod de impozit pe profit din constant pool-ul validatorului) raspunde
// „R14a: cod bugetar trebuie sa fie = 20470101 pt. acest cod_oblig". Codul 101 nici nu exista in
// lista. `103` = impozit pe profit datorat de PJ romane — acelasi cod pe care il foloseste deja
// generatorul D101, care valideaza oficial.
const D100_OBLIG = {
  micro: { cod: '620', bugetar: '20A031800', nume: 'Impozit pe veniturile microîntreprinderilor' },
  profit: { cod: '103', bugetar: '20470101', nume: 'Impozit pe profit' },
};

/**
 * Recap D100 pentru platitorii de IMPOZIT PE PROFIT (art. 41): impozitul se declara TRIMESTRIAL,
 * calculat CUMULAT de la inceputul anului, iar pe declaratie merge diferenta fata de ce s-a
 * declarat deja in trimestrele anterioare.
 *
 * Doua lucruri pe care le rateaza usor o implementare naiva:
 *  - trimestrul se calculeaza pe pozitia CUMULATA, nu pe rulajul lui: cheltuielile cu plafon
 *    (protocol, sponsorizare) au baze anuale, iar pierderea unui trimestru compenseaza profitul
 *    altuia. De aceea se scade impozitul cumulat al trimestrului precedent, nu se calculeaza
 *    izolat trimestrul;
 *  - TRIMESTRUL IV NU SE DECLARA aici. Art. 41 alin. (1) cere D100 doar pentru trimestrele I-III;
 *    definitivarea anului se face prin D101, pana pe 25 martie. O firma care ar depune D100 pe T4
 *    si-ar declara impozitul de doua ori.
 *
 * Diferenta poate iesi NEGATIVA (trimestru pe pierdere dupa unul profitabil). Pe declaratie merge
 * zero — D100 nu primeste sume negative si nu exista rambursare trimestriala; regularizarea e
 * anuala. Suma bruta ramane in `diferenta`, ca sa se vada de ce.
 */
function d100profit(db, period, opts) {
  opts = opts || {};
  const m = Number(String(period || '').slice(5, 7)) || 0;
  const y = String(period || '').slice(0, 4);
  const trimestru = m ? Math.ceil(m / 3) : 0;
  const ultimaLuna = (t) => y + '-' + String(t * 3).padStart(2, '0');
  const company = db.company || {};
  // Optiunile de calcul, aceleasi ca la inchiderea anuala, dar taiate la finalul trimestrului.
  const optiuni = (panaLa) => Object.assign({
    cota: fiscal.FISCAL.impozitProfit,
    plafoane: fiscal.FISCAL,
    pierdereReportata: Number((company.pierdereFiscala || {})[Number(y) - 1]) || 0,
    cheltAuto: cheltuieliAuto(db, y, panaLa),
    cheltLipsaNeimputabila: cheltuieliLipsaNeimputabila(db, y, panaLa),
    amortizare: assets.depreciationDifference(db.assets || [], y,
      rulajContPanaLa(db, y, '6811', panaLa), panaLa),
    cursEur: Number(company.cursEur) || 0,
    sponsorizareReport: company.sponsorizareReport || [],
    panaLa,
  }, opts.profitTaxOptions || {});
  const cumulat = acc.profitTax(db, y, optiuni(ultimaLuna(trimestru)));
  const anterior = trimestru > 1 ? acc.profitTax(db, y, optiuni(ultimaLuna(trimestru - 1))) : null;
  const impozitAnterior = anterior ? anterior.impozit : 0;
  const diferenta = round2(cumulat.impozit - impozitAnterior);
  const avertismente = [];

  // ── SISTEMUL ANUAL CU PLATI ANTICIPATE (art. 41 alin. (2)) ────────────────
  // Optiune comunicata pana pe 31 ianuarie, obligatorie cel putin 2 ani fiscali. Cand e activa,
  // pe D100 NU merge impozitul real al trimestrului, ci PLATA ANTICIPATA — alta suma, alt calendar
  // si (in cazul standard) inca un trimestru de declarat. Restul functiei ramane neatins: pozitia
  // reala se calculeaza in continuare, fiindca e singurul mod in care contabilul poate vedea cat
  // de departe sunt anticipatele de realitate inainte de regularizarea din D101.
  const profil = opts.profile || null;
  const anticipat = !!(profil && profil.profitAnticipat);
  let rezultatAnticipat = null;
  if (anticipat) rezultatAnticipat = platiAnticipate(db, y, trimestru, profil, cumulat, anterior, avertismente);

  if (trimestru === 4 && !anticipat) {
    avertismente.push('Trimestrul IV nu se declară prin D100: art. 41 alin. (1) cere declarația '
      + 'trimestrială doar pentru trimestrele I-III, iar definitivarea anului se face prin D101, '
      + 'până pe 25 martie. Depunerea unui D100 pe trimestrul IV ar declara impozitul de două ori.');
  }
  if (diferenta < 0 && !anticipat) {
    avertismente.push('Impozitul cumulat a SCĂZUT față de trimestrul precedent (' + cumulat.impozit
      + ' lei față de ' + impozitAnterior + ' lei): trimestrul e pe pierdere. Pe declarație merge 0 — '
      + 'D100 nu primește sume negative, iar regularizarea se face anual, prin D101.');
  }
  const seDeclaraTrimestrial = trimestru >= 1 && trimestru <= 3;
  return { period, trimestru, y,
    impozitCumulat: cumulat.impozit, impozitAnterior, diferenta,
    // Suma care merge pe declaratie: plata anticipata la sistemul anual, diferenta reala altfel.
    impozit: anticipat ? (rezultatAnticipat.plata != null ? rezultatAnticipat.plata : 0) : Math.max(0, diferenta),
    // Cand plata anticipata nu se poate calcula, suma de mai sus e 0 doar ca sa nu fie `null`
    // intr-un camp numeric — dar declaratia NU are voie sa plece. `blocat` poarta refuzul.
    blocat: !!(rezultatAnticipat && rezultatAnticipat.blocat),
    profitImpozabil: cumulat.profitImpozabil, profitContabil: cumulat.profitContabil,
    cheltNedeductibile: cumulat.cheltNedeductibile, deduceri: cumulat.deduceri, cota: cumulat.cota,
    sistem: anticipat ? 'anual' : 'trimestrial',
    anticipat: rezultatAnticipat,
    // Termenul, dintr-o singura sursa (`declarations.dueDate`). Generatorul XML il primeste gata
    // calculat: altfel l-ar deduce a doua oara si ar putea diverge — iar `nr_evid` il CODIFICA,
    // deci divergenta ar produce doua date diferite in acelasi rand de declaratie.
    scadenta: decl.dueDate('d100', period, profil),
    seDeclara: anticipat ? rezultatAnticipat.seDeclara : seDeclaraTrimestrial,
    codOblig: D100_OBLIG.profit.cod, codBugetar: D100_OBLIG.profit.bugetar,
    avertismente };
}

/**
 * Plata anticipata a unui trimestru, la sistemul anual (art. 41).
 *
 * DOUA formule, si alegerea intre ele schimba si suma, si calendarul:
 *
 *  (A) REGULA GENERALA, alin. (8): o patrime din impozitul pe profit datorat pentru anul
 *      precedent, ACTUALIZAT cu indicele preturilor de consum estimat la elaborarea bugetului
 *      initial al anului. Se declara TOATE PATRU trimestrele; trimestrul IV are termen 25
 *      DECEMBRIE, nu 25 ianuarie.
 *
 *  (B) EXCEPTIA, alin. (7): firmele care in anul precedent au fost nou-infiintate, au inregistrat
 *      pierdere fiscala, n-au datorat impozit pe profit anual sau au fost platitoare de impozit pe
 *      veniturile microintreprinderilor platesc cota aplicata PROFITULUI CONTABIL AL PERIOADEI —
 *      adica al trimestrului, nu cumulat — si doar pentru trimestrele I-III.
 *
 * INDICELE NU SE INVENTEAZA. Se publica prin ordin al ministrului finantelor, o data pe an, si nu
 * se poate deduce din datele firmei. Cand lipseste, functia NU cade inapoi pe „fara actualizare"
 * (ar produce o plata mai mica decat cea legala, tacut): intoarce `plata: null` si un mesaj care
 * spune ce lipseste si de unde se ia. Aceeasi regula ca la poarta fiscala — „n-am putut calcula"
 * nu are voie sa semene cu „iese zero".
 */
function platiAnticipate(db, y, trimestru, profil, cumulat, anterior, avertismente) {
  const company = db.company || {};
  const anPrec = Number(y) - 1;

  // Ramura (B): profitul CONTABIL al trimestrului, nu cel cumulat.
  if (profil.anticipatProfitContabil) {
    const contabilTrim = round2(cumulat.profitContabil - (anterior ? anterior.profitContabil : 0));
    const plata = contabilTrim > 0 ? round2(contabilTrim * cumulat.cota / 100) : 0;
    if (trimestru === 4) {
      avertismente.push('Trimestrul IV nu se declară: în regimul art. 41 alin. (7) — firmă '
        + 'nou-înființată, cu pierdere fiscală, fără impozit datorat sau microîntreprindere în anul '
        + 'precedent — plățile anticipate se fac „pentru trimestrele I-III", iar anul se '
        + 'definitivează prin D101.');
    }
    if (contabilTrim <= 0) {
      avertismente.push('Trimestrul e pe pierdere contabilă (' + contabilTrim + ' lei): plata '
        + 'anticipată e 0. Regularizarea se face anual, prin D101.');
    }
    return {
      regula: 'art. 41 alin. (7) — cota aplicată profitului contabil al trimestrului',
      profitContabilTrimestru: contabilTrim, cota: cumulat.cota,
      plata, blocat: false, seDeclara: trimestru >= 1 && trimestru <= 3,
    };
  }

  // Ramura (A): o patrime din impozitul anului precedent, actualizat cu IPC.
  // Impozitul anului precedent se ia din ce a declarat firma (`impozitProfitAn`, scris la
  // inchiderea anuala); daca lipseste — firma abia migrata, primul an in aplicatie — se
  // recalculeaza din date. Daca nici asa nu exista date pe anul precedent, se spune.
  const declarat = Number((company.impozitProfitAn || {})[anPrec]);
  let impozitAnPrecedent = Number.isFinite(declarat) ? round2(declarat) : null;
  let sursaBaza = 'declarat la închiderea anului';
  if (impozitAnPrecedent == null) {
    const arePerioade = acc.postedEntries(db).some((e) => String(e.period || '').startsWith(String(anPrec)));
    if (arePerioade) {
      impozitAnPrecedent = round2(acc.profitTax(db, String(anPrec), {
        cota: fiscal.FISCAL.impozitProfit, plafoane: fiscal.FISCAL,
      }).impozit);
      sursaBaza = 'recalculat din înregistrările anului ' + anPrec;
    }
  }
  const ipcPct = Number((company.ipcAnticipate || {})[y]);
  const areIpc = Number.isFinite(ipcPct);

  if (impozitAnPrecedent == null) {
    avertismente.push('Nu se poate calcula plata anticipată: lipsește impozitul pe profit datorat '
      + 'pentru ' + anPrec + '. Completează-l în „Firma mea" (sau înregistrează anul ' + anPrec
      + ' în aplicație). Art. 41 alin. (8) cere o pătrime din impozitul anului precedent.');
  }
  if (!areIpc) {
    avertismente.push('Nu se poate calcula plata anticipată: lipsește indicele prețurilor de consum '
      + 'pentru ' + y + '. Se publică prin ordin al ministrului finanțelor, odată cu bugetul '
      + 'inițial al anului, și se completează în „Firma mea". Fără el, plata ar ieși neactualizată, '
      + 'adică mai mică decât cea legală.');
  }
  const indexat = (impozitAnPrecedent != null && areIpc)
    ? round2(impozitAnPrecedent * (1 + ipcPct / 100)) : null;
  const plata = indexat != null ? round2(indexat / 4) : null;
  // „N-am putut calcula" NU are voie sa arate ca „nu datorez nimic". Fara baza sau fara indice,
  // o declaratie cu 0 ar fi o declaratie FALSA depusa la ANAF, nu o omisiune — si ar trece
  // neobservata, fiindca zero e o suma perfect plauzibila. De aceea cazul se marcheaza si
  // generarea XML se opreste (vezi ruta /xml/d100), la fel ca la D177 cu sume incoerente.
  const blocat = plata == null;

  // Bifa alin. (7) se CONFRUNTA cu datele: pierderea fiscala a anului precedent e singura dintre
  // cele patru situatii pe care aplicatia o poate citi sigur. Daca firma declara ca aplica regula
  // generala, dar anul trecut a iesit pe pierdere, una din doua e gresita — si diferenta nu e
  // cosmetica, sunt alta formula si alt calendar.
  const pierderePrec = Number((company.pierdereFiscala || {})[anPrec]) || 0;
  if (pierderePrec > 0) {
    avertismente.push('În ' + anPrec + ' firma a înregistrat pierdere fiscală (' + pierderePrec
      + ' lei), dar plata anticipată se calculează după regula generală. Art. 41 alin. (7) cere, '
      + 'pentru firmele cu pierdere fiscală în anul precedent, cota aplicată profitului contabil al '
      + 'trimestrului — bifează asta în „Firma mea" dacă e cazul.');
  }

  return {
    regula: 'art. 41 alin. (8) — o pătrime din impozitul anului precedent, actualizat cu IPC',
    anPrecedent: anPrec, impozitAnPrecedent, sursaBaza, ipcPct: areIpc ? ipcPct : null,
    impozitIndexat: indexat, plata, blocat,
    // Toate patru trimestrele se declara; al patrulea are termen 25 decembrie (alin. (8)).
    seDeclara: trimestru >= 1 && trimestru <= 4,
  };
}

/** Rulajul net debitor al unui cont intr-un an, taiat optional la finalul unei luni. */
function rulajContPanaLa(db, year, cont, panaLa) {
  const limita = panaLa ? String(panaLa).slice(0, 7) : null;
  const lines = acc.resultLines(acc.postedEntries(db).filter((e) => {
    const p = String(e.period || periodOf(e.data));
    return p.startsWith(String(year)) && (!limita || p <= limita);
  }));
  const a = acc.accumulate(lines)[cont];
  return a ? round2(a.d - a.c) : 0;
}

/** D100 pentru firma, dupa REGIMUL ei: micro (impozit pe venituri) sau profit (art. 41).
 *  Ruta si validarea pre-depunere trec amandoua pe aici — altfel o firma pe impozit pe profit
 *  descarca o declaratie de microintreprindere, cu alt cod de obligatie si alta suma. */
function d100(db, period, opts) {
  const profil = fiscalProfile.build((db || {}).company || {});
  // Profilul se paseaza mai departe: la impozitul pe profit el decide SISTEMUL (trimestrial sau
  // anual cu plati anticipate, art. 41), deci si suma care merge pe declaratie, si daca
  // trimestrul IV se declara. Fara el, d100profit ar calcula mereu varianta trimestriala.
  if (profil.profit) return d100profit(db, period, Object.assign({}, opts, { profile: profil }));
  return Object.assign(d100micro(db, period, (opts || {}).cota),
    { codOblig: D100_OBLIG.micro.cod, codBugetar: D100_OBLIG.micro.bugetar, seDeclara: true });
}

// Operatiunile SCUTITE SAU NETAXATE care pastreaza dreptul de deducere. Nu se pot recunoaste dupa
// „are TVA colectat", fiindca tocmai asta le lipseste: livrarea intracomunitara e scutita (art. 294
// alin. (2)), serviciile intracomunitare sunt neimpozabile in Romania (locul prestarii e la
// beneficiar, art. 278 alin. (2)), iar la art. 331 taxa o datoreaza cumparatorul. Toate trei dau
// drept de deducere deplin (art. 297 alin. (4)) si toate trei cadeau la „fara drept".
const PRORATA_CU_DREPT = new Set([
  'livrare_intracomunitara', 'prestare_servicii_intracomunitara', 'taxare_inversa_interna_livrare',
]);

/**
 * Ce rol are un cont de venit in calculul pro-ratei.
 *
 * Numitorul pro-ratei NU e „tot ce trece prin clasa 7". Art. 300 alin. (7) scoate din calcul
 * cesiunea bunurilor de capital folosite in activitate si operatiunile financiare/imobiliare
 * accesorii, iar restul conturilor de clasa 7 nici nu sunt operatiuni in sfera TVA: variatia
 * stocurilor, productia de imobilizari, subventiile, reluarile de provizioane, diferentele de curs.
 * Numarate ca „fara drept", toate acestea coborau pro-rata — adica firma deducea MAI PUTIN decat
 * avea dreptul. Masurat pe un caz real: 70% in loc de 80%.
 *
 * Limita, scrisa aici ca sa nu fie descoperita ca surpriza: o operatiune taxabila inregistrata pe
 * 7588 („alte venituri din exploatare") iese din calcul. Nu o ghicim inapoi — apare in `excluse`,
 * cu suma si motiv, ca sa poata fi vazuta si contestata de contabil.
 */
function rolContProRata(cod) {
  const c = String(cod || '');
  // 709 („reduceri comerciale acordate") e RECTIFICATIV, dar se trateaza la fel: contul sta pe
  // DEBIT, iar formula `baza + semn x suma` il scade deja. O negatie in plus il facea sa ADUNE.
  if (/^70/.test(c)) return 'operatiune';                    // vanzari de bunuri si servicii (inclusiv 709)
  if (/^7583/.test(c)) return 'exclus:bunuri de capital cedate (art. 300 alin. (7) lit. a)';
  if (/^74/.test(c)) return 'exclus:subventii (in afara sferei TVA)';
  if (/^76/.test(c)) return 'exclus:operatiuni financiare (art. 300 alin. (7) lit. d, daca sunt accesorii)';
  if (/^78/.test(c)) return 'exclus:reluari de provizioane si ajustari (nu sunt operatiuni)';
  if (/^7[12]/.test(c)) return 'exclus:variatia stocurilor / productia de imobilizari';
  if (/^7/.test(c)) return 'exclus:alte venituri, in afara sferei';
  return null;
}

/** Pro-rata TVA (art. 300): ponderea operatiunilor CU drept de deducere in totalul operatiunilor
 *  din sfera TVA (anual). Pro-rata definitiva se rotunjeste IN SUS la unitati (alin. (9)).
 *  Include si regularizarea estimata pentru achizitiile marcate „destinatie mixta" in cursul anului.
 *  `excluse` = ce a fost scos din calcul si de ce — cifra trebuie sa poata fi aparata in fata unui
 *  inspector, deci nu are voie sa fie o cutie neagra. */
function proRataTva(db, year) {
  const y = String(year);
  let cuDrept = 0; let faraDrept = 0; let dedusaProvizoriu = 0; let nrMixte = 0;
  const excluse = {};
  for (const e of acc.postedEntries(db).filter((x) => String(x.period || periodOf(x.data)).startsWith(y))) {
    let baza = 0; let atinsTva = false;
    for (const l of e.lines || []) {
      for (const [cont, semn] of [[l.credit, 1], [l.debit, -1]]) {
        const rol = rolContProRata(cont);
        if (!rol) continue;
        if (rol === 'operatiune') baza = round2(baza + semn * l.suma);
        else if (semn === 1) { // veniturile excluse se raporteaza, nu dispar tacit
          const motiv = rol.slice('exclus:'.length);
          excluse[motiv] = round2((excluse[motiv] || 0) + l.suma);
        }
      }
      // TVA colectat pe ORICARE parte: la nota de credit contul 4427 sta pe DEBIT, iar o conditie
      // doar pe credit ar fi trimis stornarea unei vanzari taxabile la „fara drept" — adica ar fi
      // scazut din galeata gresita.
      if (['4427', '4428'].includes(String(l.credit)) || ['4427', '4428'].includes(String(l.debit))) atinsTva = true;
    }
    // `!== 0`, nu `> 0`: articolele cu baza NEGATIVA sunt notele de credit si reducerile acordate.
    // Sarite, o reducere nu scadea niciodata baza, iar pro-rata ramanea calculata pe cifra bruta.
    if (baza !== 0) {
      if (atinsTva || PRORATA_CU_DREPT.has(e.tip)) cuDrept = round2(cuDrept + baza);
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
  const excluseRows = Object.entries(excluse)
    .filter(([, suma]) => suma !== 0)
    .map(([motiv, suma]) => ({ motiv, suma }))
    .sort((a, b) => b.suma - a.suma);
  return { year: y, cuDrept, faraDrept, total, definitiva, provizorie, nrMixte, dedusaProvizoriu,
    regularizare, excluse: excluseRows, totalExclus: round2(excluseRows.reduce((s, r) => s + r.suma, 0)) };
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
  // `id` = identitatea randului (stabila, dupa ea se filtreaza ce nu se aplica firmei).
  // `nr` = POZITIA afisata, calculata la final de `finalizeaza`. Cat timp erau acelasi lucru,
  // filtrarea lasa goluri vizibile: la micro numerotarea sarea 15 -> 17, la PFA lipseau 9, 12,
  // 15, 16 si 19, iar ultimele doua randuri (23, 24) apareau dupa sectiunea „D. La cerere".
  const L = (sectiune, id, nume, status, links, obs) => ({ sectiune, id, nume, status, links: links || [], obs: obs || '' });
  const p = period ? '?period=' + period : '';
  const yr = (period || '').slice(0, 4);
  const list = [
    L('A. Lunar', 1, 'Balanță de verificare', 'ok', [{ label: 'Balanta', href: '/pdf/balance' + p }]),
    L('A. Lunar', 2, 'State de plată + fluturași de salariu', 'manual', [], 'Necesită evidența pe fiecare angajat'),
    L('A. Lunar', 3, 'Situația sumelor de virat (salarii nete + contribuții)', 'recap', [{ label: 'Recap D112', href: '/pdf/d112' + p }]),
    L('A. Lunar', 4, 'Registre: registru-jurnal, cartea mare, jurnale TVA', 'ok', [
      { label: 'Jurnal', href: '/pdf/journal' + p }, { label: 'Cartea mare', href: '/pdf/ledger' + p }, { label: 'Jurnale TVA', href: '/pdf/vat' + p }]),
    L('A. Lunar', 5, 'D112 — contribuții și impozit salarii (+ recipisă)', 'recap', [{ label: 'Recap D112', href: '/pdf/d112' + p }], 'Depunerea XML + recipisă la ANAF'),
    L('A. Lunar', 6, 'D300 — decont TVA (+ recipisă)', 'recap', [{ label: 'Recap PDF', href: '/pdf/d300' + p }, { label: 'XML ANAF', href: '/xml/d300' + p }], 'XML de validat cu DUKIntegrator; recipisă la ANAF'),
    L('A. Lunar', 7, 'D394 — declarație informativă (+ recipisă)', 'recap', [{ label: 'XML ANAF', href: '/xml/d394' + p }, { label: 'Jurnale TVA', href: '/pdf/vat' + p }], 'XML de validat cu DUKIntegrator'),
    L('A. Lunar', 8, 'D390 VIES — operațiuni intracomunitare (+ recipisă)', 'regim', [], 'Doar dacă există operațiuni intracomunitare'),
    L('A. Lunar', 9, 'D406 SAF-T (+ recipisă)', 'regim', [], 'În funcție de regim/termen'),
    L('A. Lunar', 10, 'D100 — rețineri la sursă / dividende (+ recipisă)', 'regim', [], 'Dacă e cazul'),
    L('A. Lunar', 11, 'Situația sumelor de plată la ANAF', 'ok', [{ label: 'Obligații', href: '/pdf/obligatii' + p }]),
    L('B. Trimestrial', 12, 'D100 — impozit micro 1% / avans impozit profit (+ recipisă)', 'recap', [{ label: 'Recap D100', href: '/pdf/d100' + p }, { label: 'D100 XML', href: '/xml/d100' + p }]),
    L('B. Trimestrial', 13, 'D300 / D394 / D406 — regim trimestrial (+ recipisă)', 'regim', [], 'Dacă firma e pe regim trimestrial'),
    L('B. Trimestrial', 14, 'Balanță de verificare la sfârșit de trimestru', 'ok', [{ label: 'Balanta', href: '/pdf/balance' + p }]),
    L('C. Anual', 15, 'Situații financiare: bilanț + cont de profit și pierdere + note', 'ok', [
      { label: 'Bilanț', href: '/pdf/bilant?period=' + yr + '-12' }, { label: 'Cont P&P', href: '/pdf/pl?year=' + yr }], 'Notele explicative se redactează separat'),
    L('C. Anual', 16, 'D101 — impozit pe profit (+ recipisă)', 'regim', [], 'Doar la regimul de impozit pe profit'),
    L('C. Anual', 17, 'D205 / D107 — rețineri la sursă / sponsorizări (+ recipisă)', 'regim', [], 'Dacă e cazul'),
    L('C. Anual', 18, 'Registrul-inventar și documentele de inventariere', 'ok', [{ label: 'Registru-inventar', href: '/pdf/registru-inventar?period=' + yr + '-12' }]),
    L('C. Anual', 19, 'Proiect hotărâre AGA: aprobare situații + repartizare profit', 'manual', [], 'Document pregătit de firmă'),
    L('D. La cerere', 20, 'Fișa pe plătitor / situația obligațiilor la ANAF', 'ok', [{ label: 'Obligații', href: '/pdf/obligatii' + p }], 'Fișa oficială se obține din SPV'),
    L('D. La cerere', 21, 'Certificat de atestare fiscală', 'anaf', [], 'Emis de ANAF'),
    L('D. La cerere', 22, 'Balanțe și situații pentru bancă', 'ok', [{ label: 'Balanta', href: '/pdf/balance' + p }]),
  ];
  const sumar = { d112: d112(db, period), d300: d300(db, period), obligatii: obligatii(db, period), d100: d100micro(db, period) };
  // PFA: fara SAF-T / D100 micro / situatii financiare / D101 / AGA — in loc, Declaratia Unica anuala
  if ((db.company && db.company.tipEntitate) === 'pfa') {
    const drop = new Set([9, 12, 15, 16, 19]);
    const listPfa = list.filter((x) => !drop.has(x.id));
    listPfa.push(L('A. Lunar', 24, 'Registrul-jurnal de încasări și plăți (partidă simplă)', 'ok',
      [{ label: 'Registru', href: '/pdf/registru-incasari-plati' + p }]));
    listPfa.push(L('C. Anual', 23, 'Declarația Unică — venit net PFA + CAS/CASS/impozit (estimare)', 'recap',
      [{ label: 'PDF', href: '/pdf/declaratia-unica?year=' + yr }, { label: 'Registru încasări-plăți (an)', href: '/pdf/registru-incasari-plati?period=' + yr }], 'Se depune personal, din SPV, până la termenul legal'));
    sumar.du = declaratiaUnica(db, yr || String(new Date().getFullYear()));
    return { period, list: finalizeaza(listPfa), sumar };
  }
  // micro/profit: D101 (id 16) apare DOAR la regimul de impozit pe profit (micro nu depune D101)
  const prof = fiscalProfile.build(db.company);
  const listFinal = prof.profit ? list : list.filter((x) => x.id !== 16);
  return { period, list: finalizeaza(listFinal), sumar };
}

// Ordinea sectiunilor + numerotarea afisata, dupa filtrare. Sortarea e stabila explicit (indexul
// ca departajare), fiindca la PFA randurile adaugate la final apartin unor sectiuni anterioare.
const SECTIUNI = ['A. Lunar', 'B. Trimestrial', 'C. Anual', 'D. La cerere'];
function finalizeaza(list) {
  return list
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (SECTIUNI.indexOf(a.x.sectiune) - SECTIUNI.indexOf(b.x.sectiune)) || (a.i - b.i))
    .map(({ x }, i) => Object.assign({}, x, { nr: i + 1 }));
}

// Conturile de trezorerie (banii firmei) — SURSA UNICA a listei. monthlyClose.js o ia de aici
// (importa deja `reporting`); invers n-ar merge, ar inchide un ciclu de import.
const CONTURI_TREZORERIE = ['5121', '5124', '5311', '5314'];

// Conturi de cheltuieli nedeductibile fiscal (uzual)
// Cheltuieli (partial) nedeductibile fiscal — `pct` = procentul nedeductibil (art. 25-28 Cod fiscal)
// Tabelele NEDEDUCTIBILE / NEIMPOZABILE au fost MUTATE in `src/deductibilitate.js` (`FIXE`,
// respectiv `NEIMPOZABILE`). Cat timp traiau aici, le citea doar registrul de evidenta fiscala,
// iar `accounting.profitTax` — cel care posteaza 691 = 4411 si alimenteaza D101 — nu le vedea
// deloc: acelasi an dadea doua impozite diferite, iar registrul contrazicea declaratia depusa.

/** Baza cheltuielilor auto cu deductibilitate limitata (art. 25(3)(l)): liniile de cheltuiala din
 *  articolele marcate `auto50`. Marcajul se pastreaza pe articol tocmai pentru acest calcul —
 *  la finalul anului nu mai exista formularul din care s-a bifat. */
function cheltuieliAuto(db, year, panaLa) {
  const limita = panaLa ? String(panaLa).slice(0, 7) : null; // cumulare pana la finalul unui trimestru
  let s = 0;
  for (const e of acc.postedEntries(db)) {
    if (!e.auto50) continue;
    const p = String(e.period || periodOf(e.data));
    if (!p.startsWith(String(year))) continue;
    if (limita && p > limita) continue;
    for (const l of (e.lines || [])) {
      const cod = String(l.debit || '');
      if (/^6/.test(cod) && !/^(691|698)/.test(cod)) s = round2(s + (Number(l.suma) || 0));
    }
  }
  return round2(s);
}

/** Baza cheltuielilor cu lipsurile NEIMPUTABILE din gestiune (art. 25(4)(c)): liniile de
 *  cheltuiala din articolele marcate `lipsaNeimputabila`. Ca la `cheltuieliAuto`, marcajul sta pe
 *  articol fiindca incadrarea nu se poate deduce din conturi: aceeasi cheltuiala, pe acelasi cont,
 *  e deductibila daca lipsa a fost imputata sau acoperita de asigurare. */
function cheltuieliLipsaNeimputabila(db, year, panaLa) {
  const limita = panaLa ? String(panaLa).slice(0, 7) : null;
  let s = 0;
  for (const e of acc.postedEntries(db)) {
    if (!e.lipsaNeimputabila) continue;
    const p = String(e.period || periodOf(e.data));
    if (!p.startsWith(String(year))) continue;
    if (limita && p > limita) continue;
    for (const l of (e.lines || [])) {
      const cod = String(l.debit || '');
      if (/^6/.test(cod) && !/^(691|698)/.test(cod)) s = round2(s + (Number(l.suma) || 0));
    }
  }
  return round2(s);
}

/** Registrul de evidenta fiscala: trecerea de la rezultatul contabil la cel fiscal. */
function registruFiscal(db, year, cota, opts) {
  opts = opts || {};
  const pl = stmt.profitLoss(db, year);
  const r = periodRulaj2(db, year);
  // Procentele fixe pe cont vin din `deductibilitate.js`, nu dintr-o tabela locala. Se calculeaza
  // NECONDITIONAT de `opts.plafoane`: registrul se cere si fara cotele configurate (dosarul anual
  // il genereaza asa), iar amenzile raman nedeductibile indiferent de ce plafoane a dat apelantul.
  // Forma randului ramane cea istorica ({cod, nume, baza, pct, suma}) — o citesc PDF-ul si tabelul
  // din interfata; traducerea sta aici, ca motorul sa aiba un singur vocabular.
  const fixeRez = deduct.fixe(r);
  const cheltNeded = fixeRez.randuri.map((x) => ({ cod: x.cont, nume: x.regula, baza: x.cheltuit, pct: x.pct, suma: x.nedeductibil }));
  const totalNeded = fixeRez.total;
  const neimpRez = deduct.neimpozabile(r);
  const venituriList = neimpRez.randuri.map((x) => ({ cod: x.cont, nume: x.regula, baza: x.realizat, pct: x.pct, suma: x.neimpozabil }));
  const venituriNeimpozabile = neimpRez.total;
  // Amortizare: contabila (rulajul REAL al contului 6811) vs fiscala (planul fiscal al fiecarui
  // mijloc fix). Nu mai e o ipoteza: daca planurile difera, diferenta devine ajustare.
  const amortContabila = r['6811'] ? round2(r['6811'].d - r['6811'].c) : 0;
  const amortDif = assets.depreciationDifference(db.assets || [], year, amortContabila);
  const mentiuni = [];
  if (amortContabila > 0 || amortDif.fiscala > 0) {
    mentiuni.push(amortDif.areDiferenta
      ? 'Art. 28: amortizare contabila ' + amortDif.contabila + ' lei vs fiscala ' + amortDif.fiscala
        + ' lei — diferenta de ' + Math.abs(amortDif.diferenta) + ' lei '
        + (amortDif.diferenta > 0 ? 'e nedeductibila' : 'e deducere suplimentara') + ' in acest exercitiu.'
      : 'Art. 28: amortizarea fiscala = amortizarea contabila (' + amortContabila + ' lei), integral deductibila — nicio diferenta.');
  }
  const rezultatContabil = pl.rezBrut;
  // Ajustarile CU PLAFON (art. 25/40^2). `ajustari` intoarce ACUM si procentele fixe in `randuri`
  // (le calculeaza tot el, pentru `profitTax`), deci aici se ia strict subsetul cu plafon —
  // `totalNedeductibil` le-ar numara pe cele fixe a doua oara, peste `totalNeded` de mai sus.
  // Baza art. 40^2 nu se mai transmite: motorul o deriva singur, identic, din profitul contabil.
  const plafoane = opts.plafoane || null;
  const dedRez = plafoane ? deduct.ajustari({
    rulaj: r, profitContabil: rezultatContabil,
    cheltAuto: cheltuieliAuto(db, year),
    cheltLipsaNeimputabila: cheltuieliLipsaNeimputabila(db, year),
    cheltImpozitProfit: r['691'] ? round2(r['691'].d - r['691'].c) : 0,
    amortizare: amortDif,
    amortizareFiscala: amortDif.fiscala, // baza art. 40^2 foloseste amortizarea FISCALA
    cursEur: opts.cursEur,
  }, plafoane) : { randuriPlafon: [], totalPlafon: 0, sponsorizareCheltuita: 0 };
  const totalPlafoane = dedRez.totalPlafon;
  const rezultatFiscal = round2(rezultatContabil + totalNeded + totalPlafoane - venituriNeimpozabile);
  const rateProfit = cota || 16;
  const impozitProfit = round2((Math.max(rezultatFiscal, 0) * rateProfit) / 100);
  // Linia comparativa „cat ar fi iesit pe micro". Trecea `pl.venitTotal` (toata clasa 7) printr-o
  // cota scrisa `* 1` in cod — deci nici baza art. 53, nici cota art. 51, si nici macar cota din
  // configuratie. Aceeasi sursa ca D100, altfel registrul si declaratia dau doua cifre.
  const bzMicro = micro.baza(r, { ultimulTrimestru: true, rulajAn: r });
  const ctMicro = micro.cotaAplicabila({ venitCumulatLei: bzMicro.baza,
    curs: bnr.cursPlafonMicro(db.cursuriBnr, Number(year), fiscal.FISCAL.cursPlafonMicro).curs,
    caen: (db.company || {}).caen }, fiscal.FISCAL);
  const impozitMicro = round2((bzMicro.baza * ctMicro.cota) / 100);
  return {
    year, rezultatContabil, cheltNeded, totalNeded, venituriList, venituriNeimpozabile, mentiuni,
    rezultatFiscal, rateProfit, impozitProfit, impozitMicro, venitTotal: pl.venitTotal,
    rateMicro: ctMicro.cota, bazaMicro: bzMicro.baza, // cota nu mai e mereu 1%, deci se si afiseaza
    // Aditiv: randurile cu plafon si totalul lor, separate de procentele fixe.
    ajustariPlafon: dedRez.randuriPlafon, totalPlafoane,
  };
}

// Rulajul anului pentru rapoartele FISCALE (registrul de evidenta fiscala, Declaratia Unica):
// fara inchiderile 6/7 -> 121, altfel dupa inchiderea anuala baza fiscala iese zero.
function periodRulaj2(db, year) {
  const lines = acc.resultLines(acc.postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year))));
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
  // REGULA rezervei legale (5% din brut, plafon 20% din capitalul social) vine dintr-o sursa
  // unica — aceeasi care genereaza articolele contabile la repartizare. Inainte era rescrisa aici,
  // iar repartizarea o ignora complet: nota anunta o rezerva pe care nicio nota contabila nu o
  // constituia. BAZA ramane insa diferita, si e corect asa: nota descrie repartizarea PROPUSA a
  // rezultatului din contul de profit si pierdere (se poate citi si inainte de inchiderea anuala),
  // pe cand articolul repartizeaza soldul EFECTIV al lui 121 (exista doar dupa inchidere). Cand
  // anul e inchis, cele doua coincid.
  const rezInfo = acc.legalReserve(db, year);
  const capitalSocial = rezInfo.capitalSocial;
  const rezervaLegala = profit > 0 ? round2(Math.min(rezInfo.rezerva, profit)) : 0;
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
  // Conturile bugetate sunt exact clasele 6 si 7, deci `resultLines`: cu inchiderea anuala inclusa,
  // realizatul fiecarui rand devenea zero si tot bugetul aparea neconsumat (vezi `resultLines`).
  const ru = acc.accumulate(acc.resultLines(acc.postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year)))));
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
 * DOCUMENTE LIPSA: furnizorii care apareau lunar dar nu au niciun document in luna ceruta.
 * Euristica (deliberat simpla, explicabila contabilului): un furnizor de la care s-au inregistrat
 * cumparari in cel putin 2 din ultimele 3 luni, dar nimic in luna curenta, e probabil o factura
 * neajunsa inca la contabilitate. `countThis`/`avgPrev` dau contextul (cate documente fata de media
 * lunilor precedente), ca „0 lipsuri" pe o luna aproape goala sa nu para o luna in regula.
 *
 * Folosita de /api/missing-docs SI de primul pas al inchiderii lunare (src/monthlyClose.js) —
 * o singura implementare a regulii, ca ecranul si cockpitul sa nu spuna lucruri diferite.
 */
function missingDocs(v, period) {
  const ym = /^\d{4}-\d{2}$/.test(String(period || '')) ? String(period) : new Date().toISOString().slice(0, 7);
  const per = (e) => e.period || periodOf(e.data);
  const purchases = (v.entries || []).filter((e) => /cumparare/.test(e.tip) && e.partener);
  const prev = [1, 2, 3].map((k) => addMonths(ym, -k));
  const seen = {}; const lastSeen = {};
  purchases.forEach((e) => {
    const m = per(e);
    if (!lastSeen[e.partener] || m > lastSeen[e.partener]) lastSeen[e.partener] = m;
    if (prev.includes(m)) { (seen[e.partener] = seen[e.partener] || new Set()).add(m); }
  });
  const thisSet = new Set(purchases.filter((e) => per(e) === ym).map((e) => e.partener));
  const missing = Object.keys(seen).filter((p) => seen[p].size >= 2 && !thisSet.has(p))
    .map((p) => ({ partener: p, luniPrezent: seen[p].size, ultimaLuna: lastSeen[p] }))
    .sort((a, b) => b.luniPrezent - a.luniPrezent);
  const countThis = thisSet.size ? purchases.filter((e) => per(e) === ym).length : 0;
  const avgPrev = Math.round((prev.reduce((acc, m) => acc + purchases.filter((e) => per(e) === m).length, 0) / 3) * 10) / 10;
  return { period: ym, countThis, avgPrev, missing };
}

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
  // Soldurile de trezorerie se raporteaza NET, cu semn. Varianta veche le clampa la zero
  // (`Math.max(sold, 0)`), ceea ce ascundea exact anomalia care trebuie aratata: un sold creditor
  // pe un cont de bani nu e „zero lei", ci un semn ca lipsesc incasari din evidenta. Clamparea
  // supraevalua „Bani disponibili" cu exact valoarea soldului negativ si contrazicea previziunea
  // de cash-flow si bilantul de pe aceleasi ecrane, care au raportat dintotdeauna netul.
  const net = (cod) => round2(fb[cod] || 0);
  const sumNet = (coduri) => round2(coduri.reduce((s, c) => s + net(c), 0));
  // Conturile de bani cu sold creditor la zi — sursa alertei de pe dashboard. Complementar
  // lui acc.cashControl(), care verifica soldul INTRA-luna (momentele in care casa trece prin
  // negativ) si traieste in fluxul de inchidere lunara; aici conteaza pozitia FINALA, fiindca ea
  // e cea care intra in „Bani disponibili".
  const conturiBaniNegative = CONTURI_TREZORERIE.filter((c) => net(c) < -0.005)
    .map((c) => ({ cont: c, nume: coa.accountName(c), sold: net(c) }));
  // Partenerii cu sold deschis pe un sens, AGREGAT pe partener: acelasi partener poate avea acum
  // mai multe conturi de acelasi sens (401 si 404), iar o lista pe cont l-ar numara de doua ori —
  // si in „Top datorii", si in „N furnizori de plata" de sub cifra.
  const deschisiPe = (sens) => {
    const byKey = new Map();
    for (const p of rc.partners) {
      if (p.sens !== sens || p.sold <= 0) continue;
      const k = p.cui || p.den;
      const cur = byKey.get(k) || { den: p.den, cui: p.cui, sold: 0 };
      if (p.den && /[a-z]/i.test(p.den)) cur.den = p.den;
      cur.sold = round2(cur.sold + p.sold);
      byKey.set(k, cur);
    }
    return [...byKey.values()].sort((a, b) => b.sold - a.sold);
  };
  const creanteDeschise = deschisiPe('creanta');
  const datoriiDeschise = deschisiPe('datorie');
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
    numerar: net('5311'),
    banca: net('5121'),
    venituri: pl.venitTotal,
    cheltuieli: pl.cheltTotal,
    profit: pl.rezNet,
    clientiDeschisi: creanteDeschise.length,
    furnizoriDeschisi: datoriiDeschise.length,
    topCreante: creanteDeschise.slice(0, 5),
    topDatorii: datoriiDeschise.slice(0, 5),
    // Rezumat executiv (modul simplu): agregate in limbaj de business.
    // Trezoreria e NETA (vezi net() mai sus); datoriile raman soldul creditor ca numar pozitiv.
    disponibilTotal: sumNet(CONTURI_TREZORERIE),
    bancaTotal: sumNet(['5121', '5124']),
    casaTotal: sumNet(['5311', '5314']),
    conturiBaniNegative,
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
    for (const l of acc.resultLines([e])) { // fara inchiderile 6/7 -> 121: ar goli luna decembrie
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
/**
 * D177 — cererea de REDIRECTIONARE a impozitului catre beneficiari (sponsorizari).
 *
 * Nu e o declaratie de plata: `totalPlata_A` e 0 (confirmat cu validatorul oficial). E cererea
 * prin care partea NEUTILIZATA a creditului fiscal de sponsorizare se directioneaza efectiv catre
 * entitatile beneficiare. Aplicatia calcula deja plafoanele (art. 25(4)(i): min(0,75% din cifra de
 * afaceri; 20% din impozit) — vezi `deductibilitate.credit`) si tinea reportul pe ani, dar
 * formularul prin care redirectionarea se face nu putea fi depus.
 *
 * `sumaMax` = plafonul anului; `sumaAnt` = cat s-a folosit deja ca CREDIT in declaratia de impozit
 * (acolo suma reduce impozitul direct, deci nu se mai poate redirectiona); `sumaRest` = diferenta,
 * adica exact ce se poate cere aici.
 *
 * Beneficiarii se DERIVA din articolele de sponsorizare ale anului (cont 6582), grupati pe
 * partener — cine a primit sponsorizare e deja in contabilitate, nu trebuie retastat. Datele pe
 * care registrul nu le are (contract, IBAN, e-mail) se completeaza din nomenclatorul de parteneri
 * sau din cerere; `lipsa` le enumera, iar ruta refuza generarea cat timp lipsesc — un IBAN gresit
 * trimite banii altcuiva.
 */
// Reportul sponsorizarii la micro (art. 56^1 alin. (3)): 28 de trimestre, consum in ordinea
// inregistrarii. Acelasi mecanism ca la pierderea fiscala (`accounting.consumaPierderi`), dar cu
// unitatea de timp TRIMESTRU — de aceea nu se refoloseste functia, se refoloseste TIPARUL.
const REPORT_SPONS_TRIMESTRE = 28;

/** Numarul absolut de trimestre al unei perioade 'YYYY-MM' (pentru diferente si expirare). */
function indexTrimestru(period) {
  const y = Number(String(period).slice(0, 4));
  const m = Number(String(period).slice(5, 7));
  return y * 4 + Math.ceil(m / 3) - 1;
}

/** Consuma vintage-urile in limita `plafon`, FIFO, scotand din joc ce a expirat fata de ULTIMUL. */
function consumaVintage(vintage, plafon) {
  const lista = (vintage || []).filter((x) => round2(x.suma) > 0)
    .sort((a, b) => indexTrimestru(a.trimestru) - indexTrimestru(b.trimestru));
  if (!lista.length) return { folosit: 0, detaliu: [], ramase: [], expirate: [] };
  const acum = indexTrimestru(lista[lista.length - 1].trimestru);
  const expirate = lista.filter((x) => acum - indexTrimestru(x.trimestru) >= REPORT_SPONS_TRIMESTRE);
  const valabile = lista.filter((x) => acum - indexTrimestru(x.trimestru) < REPORT_SPONS_TRIMESTRE);
  let ramas = Math.max(0, round2(plafon));
  const detaliu = valabile.map((x) => {
    const folosit = round2(Math.min(round2(x.suma), ramas));
    ramas = round2(ramas - folosit);
    return { trimestru: x.trimestru, disponibil: round2(x.suma), folosit, ramas: round2(x.suma - folosit) };
  });
  return {
    folosit: round2(detaliu.reduce((s, x) => s + x.folosit, 0)),
    detaliu,
    ramase: detaliu.filter((x) => x.ramas > 0).map((x) => ({ trimestru: x.trimestru, suma: x.ramas })),
    expirate,
  };
}

/** Pas INAINTE peste trimestrele anterioare: ce report intra in `period`. Fara stocare. */
function reportMicroLaInceputul(db, period) {
  const idx = indexTrimestru(period);
  let vintage = [];
  for (let k = REPORT_SPONS_TRIMESTRE; k >= 1; k--) {
    const i = idx - k;
    const an = Math.floor(i / 4);
    const luna = ((i % 4) + 1) * 3;
    const p = an + '-' + String(luna).padStart(2, '0');
    const t = d100micro(db, p, null, { faraReport: true });
    if (!t.impozitBrut && !t.sponsorizareTrimestru) continue; // trimestru fara activitate
    const c = consumaVintage(vintage.concat([{ trimestru: p, suma: t.sponsorizareTrimestru }]), t.plafonSponsorizare);
    vintage = c.ramase;
  }
  return vintage;
}

/** Cele patru trimestre micro ale unui an (sursa unica pentru plafonul si deducerea art. 56^1). */
function trimestreMicro(db, year) {
  return [3, 6, 9, 12].map((m) => d100micro(db, String(year) + '-' + String(m).padStart(2, '0')));
}

function d177(db, year, opts) {
  const o = opts || {};
  // Plafonul se calculeaza DIFERIT dupa regim, si asta era limita lasata explicit la prima
  // livrare: la impozitul pe profit e min(0,75% din cifra de afaceri; 20% din impozit)
  // (art. 25(4)(i)); la MICRO nu exista limita pe cifra de afaceri — e doar 20% din impozitul pe
  // veniturile microintreprinderilor (art. 56^1). Aplicat plafonul de profit unei firme micro,
  // cifra iesea din alta lege.
  const micro = fiscalProfile.build((db && db.company) || {}, { angajati: (db && db.angajati) || [] }).micro;
  let plafon; let folosit; let regim;
  if (micro) {
    regim = 'micro';
    // impozitul micro al ANULUI = suma celor patru trimestre
    const impozitAn = round2(trimestreMicro(db, year).reduce((sx, t) => sx + (t.impozitBrut || 0), 0));
    plafon = round2((impozitAn * (Number(fiscal.FISCAL.sponsorizareImpozitPct) || 0)) / 100);
    // Cat s-a SCAZUT deja efectiv din impozitul trimestrial (art. 56^1) — acum se stie, fiindca
    // `d100micro` calculeaza deducerea. Restul e ce se mai poate redirectiona prin D177.
    folosit = round2(trimestreMicro(db, year).reduce((sx, t) => sx + t.sponsorizareDedusa, 0));
  } else {
    regim = 'profit';
    const pt = acc.profitTax(db, year, o.profitTax || {});
    const cr = pt.sponsorizare || {};
    plafon = round2(Number(cr.plafon) || 0);
    folosit = round2(Number(cr.folosit) || 0);
  }
  const rest = round2(Math.max(0, plafon - folosit));

  // Beneficiarii, din rulajul contului de sponsorizare al anului, pe partener.
  const anStr = String(year);
  const peBeneficiar = new Map();
  for (const e of acc.postedEntries(db)) {
    if (!String(e.period || periodOf(e.data)).startsWith(anStr)) continue;
    const suma = round2((e.lines || [])
      .filter((l) => String(l.debit || '').startsWith(CONT_SPONSORIZARE))
      .reduce((s, l) => s + (Number(l.suma) || 0), 0));
    if (suma <= 0) continue;
    const cui = String(e.partenerCui || '').replace(/^ro/i, '').replace(/[^0-9]/g, '');
    const cheie = cui || ('fara-cui:' + (e.partener || e.id));
    const b = peBeneficiar.get(cheie) || { cui, den: e.partener || '', suma: 0, documente: [] };
    b.suma = round2(b.suma + suma);
    if (e.document) b.documente.push(e.document);
    peBeneficiar.set(cheie, b);
  }

  const parteneri = (db && db.partners) || {};
  const beneficiari = [...peBeneficiar.values()].map((b) => {
    const p = parteneri[b.cui] || {};
    const lipsa = [];
    if (!b.cui) lipsa.push('CUI');
    if (!b.den) lipsa.push('denumirea');
    if (!p.adresa) lipsa.push('adresa');
    if (!p.iban) lipsa.push('IBAN-ul');
    return {
      cui: b.cui, den: b.den || p.den || '', adresa: p.adresa || '', iban: p.iban || '',
      telefon: p.telefon || '', email: p.email || '',
      contract: b.documente.join(', '), suma: b.suma, lipsa,
    };
  }).sort((a, b) => b.suma - a.suma);

  return {
    year: anStr, regim,
    // `tipPlatitor` nu se mai deduce din regimul firmei: validatorul accepta o SINGURA valoare
    // ("1") in v1 — sondate toate variantele. Il pune generatorul, nu raportul.
    sumaMax: plafon, sumaAnt: folosit, sumaRest: rest,
    beneficiari,
    total: round2(beneficiari.reduce((s, b) => s + b.suma, 0)),
    // Validatorul ANAF NU verifica aceasta corelatie (probat: un `sumaB` de 10.000 pe un
    // `sumaRest` de 3.000 trece fara o vorba), dar legea o impune — nu poti redirectiona mai mult
    // decat ti-a ramas. Deci o prinde aplicatia, ca la IBAN.
    depaseste: round2(beneficiari.reduce((s, b) => s + b.suma, 0)) > rest,
    lipsa: beneficiari.filter((b) => b.lipsa.length).map((b) => (b.den || b.cui) + ': ' + b.lipsa.join(', ')),
  };
}

function d101(db, year, opts) {
  opts = opts || {};
  // `rezultatFiscal` = instantaneul salvat de inchidere pe articolul 691 = 4411. Cand exista,
  // declaratia il REFOLOSESTE in loc sa recalculeze: pierderile reportate au fost deja consumate
  // de inchidere, deci aceleasi reguli pe starea de acum ar da alta cifra decat cea inregistrata.
  // Vezi src/profitTaxOptions.js pentru de ce nu ajunge sa transmitem doar aceleasi optiuni.
  const pt = opts.rezultatFiscal || acc.profitTax(db, year, opts);
  const yearEntries = acc.postedEntries(db).filter((e) => String(e.period || periodOf(e.data)).startsWith(String(year)));
  // FARA inchiderile 6/7 -> 121, ca in `profitTax` (vezi `resultLines`). Altfel D101 se contrazicea
  // singur dupa inchiderea anuala: P1/P2/P3 (venituri, cheltuieli, rezultat brut) cadeau la zero,
  // in timp ce profitul impozabil si impozitul — calculate de `profitTax`, care filtra corect —
  // ramaneau la valoarea lor. Declaratia raporta „rezultat brut 0, impozit 11.164".
  const r = acc.accumulate(acc.resultLines(yearEntries));
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
  // Defalcarea nedeductibilelor pe randurile D101 se face DOAR cand ele au fost calculate din
  // reguli (motorul de plafoane a rulat). Daca apelantul a tastat `cheltNedeductibile`, nu avem
  // din ce sa derivam repartizarea si ramane totul la P33, ca pana acum.
  const manual = opts.cheltNedeductibile != null && opts.cheltNedeductibile !== '';
  const mapD101 = (!manual && pt.ajustari && pt.ajustari.length) ? deduct.mapareD101(pt.ajustari) : null;
  return {
    year: String(year), cota: pt.cota,
    venituriExploatare: vExpl, cheltuieliExploatare: cExpl, rezExploatare,
    venituriFinanciare: vFin, cheltuieliFinanciare: cFin, rezFinanciar,
    rezultatBrut,
    cheltuieliNedeductibile: round2(mapD101 ? mapD101.totalNedeductibil : (pt.cheltNedeductibile || 0)),
    deduceriFiscale: round2(pt.deduceri || 0), // ramane P15; P11 vine separat, din mapare
    // Defalcarea pe randurile formularului (P23..P33) + deducerile perechi (P11). Absenta cand
    // nedeductibilele au fost TASTATE manual: atunci nu exista reguli din care sa se derive
    // repartizarea, iar o defalcare inventata ar fi mai rea decat totalul cinstit la „alte".
    d101Nedeductibile: mapD101 ? mapD101.nedeductibile : null,
    d101Deduceri: mapD101 ? mapD101.deduceri : null,
    pierdereReportata: round2(pt.pierdereReportata || 0),
    pierdereFolosita: round2(pt.pierdereFolosita || 0),
    profitImpozabil: round2(pt.profitImpozabil || 0),
    impozit: round2(pt.impozitBrut != null ? pt.impozitBrut : (pt.impozit || 0)), // P41, INAINTE de credit
    // Creditul de sponsorizare (P43). Plafonul din D101 e round((P41-P42)*20%) — regula V5 a
    // validatorului, dovedita prin sondaj; P42 (credit fiscal extern) nu e modelat, deci e 0.
    sponsorizareCredit: pt.sponsorizare ? round2(pt.sponsorizare.folosit) : 0,
    impozitDePlata: round2(pt.impozit || 0), // P52 — dupa scaderea sponsorizarii
    scadenta: (Number(String(year).slice(0, 4)) + 1) + '-03-25',
  };
}

module.exports = { d177, consumaVintage, indexTrimestru, reportMicroLaInceputul, cheltuieliLipsaNeimputabila, d112, d300, d390, D390_CODURI, d205, intrastat, obligatii, d100, d100micro, d100profit, D100_OBLIG, d101, declaratiaUnica, proRataTva, achizitiiPfCarnet, registruInventar, livrabile, dashboard, missingDocs, latestYear, monthlySeries, registruFiscal, notes, budgetReport, cashForecast, stornoReport, tvaReconciliation, cheltuieliAuto, CONTURI_TREZORERIE };
