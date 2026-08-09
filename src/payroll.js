'use strict';

// Statul de plata: calcul salarial per angajat (CAS 25%, CASS 10%, impozit 10%, CAM 2,25%)
// folosind parametrii fiscali curenti. Reutilizeaza fiscal.payroll().

const { round2 } = require('./util');
const fiscal = require('./fiscal');
const ben = require('./beneficii'); // plafonul de 33% (art. 76 alin. (4^1)) — doar consumul anual

/** Media bruturilor unui angajat din ultimele `luni` state postate (payrollHistory), inainte de `period`. */
function mediaIstoric(a, history, period, luni) {
  const past = [];
  for (const h of (history || [])) {
    if (period && String(h.period) >= String(period)) continue;
    const r = (h.rows || []).find((x) => (x.angajatId || x.id) === a.id || (a.cnp && x.cnp === a.cnp));
    if (r && Number(r.brut) > 0) past.push({ period: h.period, brut: Number(r.brut) });
  }
  past.sort((x, y) => (x.period < y.period ? 1 : -1));
  const lastN = past.slice(0, luni);
  return lastN.length ? round2(lastN.reduce((s, x) => s + x.brut, 0) / lastN.length) : 0;
}

/** Statul de plata pentru o lista de angajati: randuri per angajat + totaluri.
 *  `spor` se adauga la brut (impozabil); `avans` (425) si `retineri` (terti -> 427) se scad din net.
 *  `period` (YYYY-MM, optional) alege salariul minim S1/S2 pentru deducerea personala.
 *  `history` (payrollHistory, optional) da media ultimelor 6 luni pentru baza concediului medical. */
/**
 * Zilele LUCRATOARE cuprinse in primele `n` zile CALENDARISTICE ale concediului medical.
 *
 * OUG 158/2005 art. 12 lit. A pune in sarcina angajatorului „prima zi pana in a 5-a zi de
 * incapacitate" — zile CALENDARISTICE de incapacitate, nu zile lucratoare de concediu. Indemnizatia
 * se cuvine insa doar pentru zilele lucratoare din interval. Cele doua numaratori difera ori de
 * cate ori intervalul prinde un weekend: un concediu care incepe JOI are in primele 5 zile
 * calendaristice doar 3 zile lucratoare (joi, vineri, luni), deci angajatorul suporta 3, nu 5.
 *
 * Formula veche, `min(5, zileCM)`, numara 5 zile lucratoare — adica MAXIMUL posibil. Rezultatul:
 * cost mutat sistematic de la FNUASS la firma si o suma recuperabila subdeclarata in D112.
 *
 * Sarbatorile legale NU sunt luate in calcul (aplicatia nu tine un calendar de sarbatori); efectul
 * merge in aceeasi directie ca inainte — cel mult supraevalueaza partea angajatorului, niciodata
 * invers. Se poate corecta ridicand numarul de zile lucratoare al lunii.
 */
function zileLucratoareInPrimele(dataStart, n) {
  const zi = String(dataStart || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(zi)) return null;
  const d = new Date(zi + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  let lucratoare = 0;
  for (let i = 0; i < n; i += 1) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) lucratoare += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return lucratoare;
}

function statePlata(angajati, period, history) {
  const rows = [];
  const t = { brut: 0, neimpozabil: 0, neimpozabilMinim: 0, deducere: 0, tichete: 0, avantaje: 0,
    beneficiiAcordate: 0, beneficiiNeimpozabile: 0, beneficiiImpozabile: 0, spor: 0, cas: 0, cass: 0, impozit: 0, cam: 0, net: 0, avans: 0, retineri: 0, restPlata: 0, costTotal: 0, cmAngajator: 0, cmFnuass: 0, indemnizatieCM: 0, indemnizatieCO: 0, casAngajator: 0, cassAngajator: 0 };
  for (const a of angajati || []) {
    const spor = round2(Number(a.spor) || 0);
    const brut = round2((Number(a.salariuBrut) || 0) + spor);
    // `a.neimpozabil` = alte venituri neimpozabile, introduse de contabil (asa e si eticheta din
    // formular: „Venit neimpozabil suplimentar"). Facilitatea din salariul minim NU se ia de aici:
    // se DERIVA mai jos, fiindca depinde de salariu si de luna, iar un cuantum stocat ar ramane
    // adevarat dupa ce salariul creste.
    const neimpozabil = round2(Number(a.neimpozabil) || 0);
    // Deducerea personala se calculeaza cand angajatul are datele (persoane in intretinere / <=26 ani / copii);
    // altfel se pastreaza comportamentul anterior (doar suma neimpozabila manuala).
    const hasDP = a.persoane != null || a.sub26 || a.copii;
    const dp = hasDP ? fiscal.deducerePersonala(brut, a.persoane, { salariuMinim: fiscal.salariuMinimLa(period), sub26: a.sub26, copii: a.copii }).total : 0;
    const deducere = round2(dp + neimpozabil); // total scazut din baza de impozit
    const tichete = round2(Number(a.tichete) || 0);
    const avantaje = round2(Number(a.avantaje) || 0); // avantaje in natura impozabile (auto, chirie...)
    const sector = a.sector || 'normal';
    const avans = round2(Number(a.avans) || 0);
    const retineri = round2(Number(a.retineri) || 0);
    // Concediu medical (OUG 158/2005, simplificat): baza = media bruturilor din ultimele 6 luni
    // postate (fallback: brutul curent), plafonata la 12 salarii minime; primele 5 zile lucratoare
    // le suporta angajatorul, restul FNUASS; salariul se reduce proportional cu zilele de CM.
    const zlm = Math.max(1, Math.round(Number(a.zileLucratoare) || 21));
    const zcm = Math.max(0, Math.min(Math.round(Number(a.zileCM) || 0), zlm));
    const procentCM = Number(a.procentCM) || 75;
    let cmA = 0; let cmF = 0; let mediaCM = 0; let cmAprox = false; let zileAngajator = 0;
    if (zcm > 0) {
      const media = mediaIstoric(a, history, period, 6) || brut;
      mediaCM = Math.min(media, round2(12 * fiscal.salariuMinimLa(period)));
      const zilnica = round2((mediaCM / zlm) * (procentCM / 100));
      // Plafonul zilelor suportate de angajator se citeste din DATA de inceput a concediului
      // (zile calendaristice), nu din numarul de zile lucratoare. Fara data, ramane vechea
      // aproximare — dar articolul o SEMNALEAZA (`cmAproximat`), ca sa nu treaca drept exact.
      const capAng = zileLucratoareInPrimele(a.dataInceputCM, 5);
      cmAprox = capAng == null;
      const zileAng = Math.min(capAng == null ? 5 : capAng, zcm);
      cmA = round2(zilnica * zileAng);
      cmF = round2(zilnica * (zcm - zileAng));
      zileAngajator = zileAng;
    }
    // Concediu de odihna: indemnizatia = media zilnica a bruturilor din ultimele 3 luni postate
    // (fallback: brutul curent) x zilele de CO; salariul se reduce proportional. Indemnizatia CO
    // se impoziteaza integral, ca salariul (CAS + CASS + impozit + CAM).
    const zco = Math.max(0, Math.min(Math.round(Number(a.zileCO) || 0), zlm - zcm));
    let indemnizatieCO = 0; let mediaCO = 0;
    if (zco > 0) {
      mediaCO = mediaIstoric(a, history, period, 3) || brut;
      indemnizatieCO = round2((mediaCO / zlm) * zco);
    }
    const salariuZileLucrate = (zcm || zco) ? round2((brut * (zlm - zcm - zco)) / zlm) : brut;
    const brutTaxabil = round2(salariuZileLucrate + indemnizatieCO);
    // Norma partiala (OUG 16/2022): contributii cel putin la nivelul salariului minim, diferenta
    // in sarcina angajatorului; exceptii legale (elevi/studenti, pensionari, ucenici, dizabilitate,
    // cumul de norma intreaga la alt angajator) — bifate pe angajat.
    const bazaMinima = (a.normaPartiala && !a.scutitNormaPartiala) ? fiscal.salariuMinimLa(period) : 0;
    // Suma neimpozabila din salariul minim (art. 76): derivata din salariul de BAZA contractual
    // (`a.salariuBrut`, fara spor) si din brutul efectiv al lunii. Nu e o deducere — iese din toate
    // bazele, deci se trimite separat de `deducere`.
    const nm = fiscal.neimpozabilMinim(brutTaxabil, round2(Number(a.salariuBrut) || 0), period);
    // Avantajele din plafonul de 33% (art. 76 alin. (4^1)). Plafonul se calculeaza pe salariul de
    // BAZA contractual (`a.salariuBrut`, fara spor si fara reducerea pentru zilele de concediu) —
    // vezi nota din src/beneficii.js. Plafoanele ANUALE (turism, pensii, sanatate, sport) au nevoie
    // de cat s-a acordat deja anul asta, deci se citesc din acelasi `history` din care vine si
    // baza concediului medical. `ordineBeneficii` sta pe angajat, nu ca parametru al functiei:
    // asa calculeaza IDENTIC toate cele noua puncte care cheama statePlata (stat, PDF, D112,
    // plati), fara sa depinda de cine si-a amintit sa transmita optiunea.
    const bnf = fiscal.beneficii({
      salariuBaza: round2(Number(a.salariuBrut) || 0),
      acordate: a.beneficii || {},
      zile: {
        lucratoare: zlm,
        lucrate: Math.max(0, zlm - zcm - zco),
        mobilitate: a.zileMobilitate != null ? Math.max(0, Math.round(Number(a.zileMobilitate) || 0)) : Math.max(0, zlm - zcm - zco),
        telemunca: Math.max(0, Math.round(Number(a.zileTelemunca) || 0)),
      },
      copii: Number(a.copiiCresa) || 0,
      tichete,
      salariuMinim: fiscal.salariuMinimLa(period),
      consumAnual: ben.consumAnual(history, a.id, period),
      ordine: a.ordineBeneficii,
    });
    const p = fiscal.payroll(brutTaxabil, deducere, { tichete, avantaje, sector, cmAngajator: cmA, cmFnuass: cmF, bazaMinima, neimpozabilMinim: nm.suma, beneficiiImpozabile: bnf.totalImpozabil });
    const restPlata = round2(p.net - avans - retineri);
    rows.push({
      id: a.id, nume: a.nume || '', cnp: a.cnp || '', functie: a.functie || '', persoane: a.persoane != null ? Number(a.persoane) : null, sub26: !!a.sub26, copii: Number(a.copii) || 0,
      brut: brutTaxabil, salariuBaza: brut, salariuZileLucrate, spor, neimpozabil, deducere: dp,
      neimpozabilMinim: nm.suma, neimpozabilMinimMotiv: nm.motiv, tichete, avantaje, sector, scutire: p.scutImpozit || p.scutCass, overPlafon: p.overPlafon,
      // Art. 76 alin. (4^1): detaliul pe categorii ramane pe rand — statul de plata trebuie sa
      // poata arata din ce plafon a iesit fiecare leu impozitat, nu doar totalul.
      beneficii: bnf.randuri, beneficiiPlafon: bnf.plafon, beneficiiAcordate: bnf.totalAcordat,
      beneficiiNeimpozabile: bnf.totalNeimpozabil, beneficiiImpozabile: bnf.totalImpozabil,
      beneficiiRamas: bnf.ramas, beneficiiDepasit: bnf.depasit,
      // numaratorile de care depind limitele — formularul le reciteste de aici la „editeaza"
      zileTelemunca: Math.max(0, Math.round(Number(a.zileTelemunca) || 0)),
      zileMobilitate: a.zileMobilitate != null ? Math.max(0, Math.round(Number(a.zileMobilitate) || 0)) : null,
      copiiCresa: Math.max(0, Math.round(Number(a.copiiCresa) || 0)),
      zileCM: zcm, procentCM: zcm ? procentCM : 0, mediaCM, cmAngajator: cmA, cmFnuass: cmF, indemnizatieCM: round2(cmA + cmF),
      dataInceputCM: a.dataInceputCM || '', zileCMAngajator: zileAngajator, cmAproximat: cmAprox,
      zileCO: zco, mediaCO, indemnizatieCO,
      normaPartiala: !!(a.normaPartiala && !a.scutitNormaPartiala), casAngajator: p.casAngajator, cassAngajator: p.cassAngajator,
      cas: p.cas, cass: p.cass, impozit: p.impozit, cam: p.cam, net: p.net, avans, retineri, restPlata, costTotal: p.costTotal,
    });
    t.deducere = round2(t.deducere + dp); t.tichete = round2((t.tichete || 0) + tichete); t.avantaje = round2(t.avantaje + avantaje);
    t.beneficiiAcordate = round2(t.beneficiiAcordate + bnf.totalAcordat);
    t.beneficiiNeimpozabile = round2(t.beneficiiNeimpozabile + bnf.totalNeimpozabil);
    t.beneficiiImpozabile = round2(t.beneficiiImpozabile + bnf.totalImpozabil);
    t.cmAngajator = round2(t.cmAngajator + cmA); t.cmFnuass = round2(t.cmFnuass + cmF); t.indemnizatieCM = round2(t.indemnizatieCM + cmA + cmF);
    t.indemnizatieCO = round2(t.indemnizatieCO + indemnizatieCO);
    t.casAngajator = round2(t.casAngajator + p.casAngajator); t.cassAngajator = round2(t.cassAngajator + p.cassAngajator);
    t.brut = round2(t.brut + brutTaxabil); t.neimpozabil = round2(t.neimpozabil + neimpozabil); t.spor = round2(t.spor + spor);
    t.neimpozabilMinim = round2((t.neimpozabilMinim || 0) + nm.suma);
    t.cas = round2(t.cas + p.cas); t.cass = round2(t.cass + p.cass); t.impozit = round2(t.impozit + p.impozit);
    t.cam = round2(t.cam + p.cam); t.net = round2(t.net + p.net); t.costTotal = round2(t.costTotal + p.costTotal);
    t.avans = round2(t.avans + avans); t.retineri = round2(t.retineri + retineri); t.restPlata = round2(t.restPlata + restPlata);
  }
  t.totalBuget = round2(t.cas + t.cass + t.impozit + t.cam + t.casAngajator + t.cassAngajator);
  return { rows, totals: t };
}

/** Registrul anual de salarii: cumuleaza instantaneele lunare per angajat pentru un an. */
function registruSalarii(history, year) {
  const snaps = (history || []).filter((h) => String(h.period).startsWith(String(year)));
  const byEmp = new Map();
  for (const h of snaps) {
    for (const r of (h.rows || [])) {
      const key = r.angajatId || r.cnp || r.nume;
      if (!byEmp.has(key)) byEmp.set(key, { angajatId: key, nume: r.nume, cnp: r.cnp || '', brut: 0, cas: 0, cass: 0, impozit: 0, net: 0, luni: 0 });
      const e = byEmp.get(key);
      e.brut = round2(e.brut + (r.brut || 0)); e.cas = round2(e.cas + (r.cas || 0)); e.cass = round2(e.cass + (r.cass || 0));
      e.impozit = round2(e.impozit + (r.impozit || 0)); e.net = round2(e.net + (r.net || 0)); e.luni += 1;
    }
  }
  const angajati = [...byEmp.values()].sort((a, b) => a.nume.localeCompare(b.nume));
  const t = { brut: 0, cas: 0, cass: 0, impozit: 0, net: 0 };
  for (const e of angajati) for (const k of Object.keys(t)) t[k] = round2(t[k] + e[k]);
  return { year: String(year), angajati, totals: t, nrLuni: new Set(snaps.map((h) => h.period)).size };
}

module.exports = { statePlata, registruSalarii, zileLucratoareInPrimele };
