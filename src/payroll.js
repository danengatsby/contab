'use strict';

// Statul de plata: calcul salarial per angajat (CAS 25%, CASS 10%, impozit 10%, CAM 2,25%)
// folosind parametrii fiscali curenti. Reutilizeaza fiscal.payroll().

const { round2 } = require('./util');
const fiscal = require('./fiscal');

/** Statul de plata pentru o lista de angajati: randuri per angajat + totaluri.
 *  `spor` se adauga la brut (impozabil); `avans` (425) si `retineri` (terti -> 427) se scad din net.
 *  `period` (YYYY-MM, optional) alege salariul minim S1/S2 pentru deducerea personala.
 *  `history` (payrollHistory, optional) da media ultimelor 6 luni pentru baza concediului medical. */
function statePlata(angajati, period, history) {
  const rows = [];
  const t = { brut: 0, neimpozabil: 0, deducere: 0, tichete: 0, avantaje: 0, spor: 0, cas: 0, cass: 0, impozit: 0, cam: 0, net: 0, avans: 0, retineri: 0, restPlata: 0, costTotal: 0, cmAngajator: 0, cmFnuass: 0, indemnizatieCM: 0 };
  for (const a of angajati || []) {
    const spor = round2(Number(a.spor) || 0);
    const brut = round2((Number(a.salariuBrut) || 0) + spor);
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
    let salariuPlata = brut; let cmA = 0; let cmF = 0; let mediaCM = 0;
    if (zcm > 0) {
      const past = [];
      for (const h of (history || [])) {
        if (period && String(h.period) >= String(period)) continue;
        const r = (h.rows || []).find((x) => (x.angajatId || x.id) === a.id || (a.cnp && x.cnp === a.cnp));
        if (r && Number(r.brut) > 0) past.push({ period: h.period, brut: Number(r.brut) });
      }
      past.sort((x, y) => (x.period < y.period ? 1 : -1));
      const last6 = past.slice(0, 6);
      const media = last6.length ? round2(last6.reduce((s, x) => s + x.brut, 0) / last6.length) : brut;
      mediaCM = Math.min(media, round2(12 * fiscal.salariuMinimLa(period)));
      const zilnica = round2((mediaCM / zlm) * (procentCM / 100));
      const zileAng = Math.min(5, zcm);
      cmA = round2(zilnica * zileAng);
      cmF = round2(zilnica * (zcm - zileAng));
      salariuPlata = round2((brut * (zlm - zcm)) / zlm);
    }
    const p = fiscal.payroll(salariuPlata, deducere, { tichete, avantaje, sector, cmAngajator: cmA, cmFnuass: cmF });
    const restPlata = round2(p.net - avans - retineri);
    rows.push({
      id: a.id, nume: a.nume || '', cnp: a.cnp || '', functie: a.functie || '', persoane: a.persoane != null ? Number(a.persoane) : null, sub26: !!a.sub26, copii: Number(a.copii) || 0,
      brut: salariuPlata, salariuBaza: brut, spor, neimpozabil, deducere: dp, tichete, avantaje, sector, scutire: p.scutImpozit || p.scutCass, overPlafon: p.overPlafon,
      zileCM: zcm, procentCM: zcm ? procentCM : 0, mediaCM, cmAngajator: cmA, cmFnuass: cmF, indemnizatieCM: round2(cmA + cmF),
      cas: p.cas, cass: p.cass, impozit: p.impozit, cam: p.cam, net: p.net, avans, retineri, restPlata, costTotal: p.costTotal,
    });
    t.deducere = round2(t.deducere + dp); t.tichete = round2((t.tichete || 0) + tichete); t.avantaje = round2(t.avantaje + avantaje);
    t.cmAngajator = round2(t.cmAngajator + cmA); t.cmFnuass = round2(t.cmFnuass + cmF); t.indemnizatieCM = round2(t.indemnizatieCM + cmA + cmF);
    t.brut = round2(t.brut + salariuPlata); t.neimpozabil = round2(t.neimpozabil + neimpozabil); t.spor = round2(t.spor + spor);
    t.cas = round2(t.cas + p.cas); t.cass = round2(t.cass + p.cass); t.impozit = round2(t.impozit + p.impozit);
    t.cam = round2(t.cam + p.cam); t.net = round2(t.net + p.net); t.costTotal = round2(t.costTotal + p.costTotal);
    t.avans = round2(t.avans + avans); t.retineri = round2(t.retineri + retineri); t.restPlata = round2(t.restPlata + restPlata);
  }
  t.totalBuget = round2(t.cas + t.cass + t.impozit + t.cam);
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

module.exports = { statePlata, registruSalarii };
