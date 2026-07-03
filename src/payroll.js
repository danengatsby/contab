'use strict';

// Statul de plata: calcul salarial per angajat (CAS 25%, CASS 10%, impozit 10%, CAM 2,25%)
// folosind parametrii fiscali curenti. Reutilizeaza fiscal.payroll().

const { round2 } = require('./util');
const fiscal = require('./fiscal');

/** Statul de plata pentru o lista de angajati: randuri per angajat + totaluri.
 *  `spor` se adauga la brut (impozabil); `avans` (425) si `retineri` (terti -> 427) se scad din net. */
function statePlata(angajati) {
  const rows = [];
  const t = { brut: 0, neimpozabil: 0, deducere: 0, tichete: 0, spor: 0, cas: 0, cass: 0, impozit: 0, cam: 0, net: 0, avans: 0, retineri: 0, restPlata: 0, costTotal: 0 };
  for (const a of angajati || []) {
    const spor = round2(Number(a.spor) || 0);
    const brut = round2((Number(a.salariuBrut) || 0) + spor);
    const neimpozabil = round2(Number(a.neimpozabil) || 0);
    // Deducerea personala se calculeaza cand angajatul are datele (persoane in intretinere / <=26 ani / copii);
    // altfel se pastreaza comportamentul anterior (doar suma neimpozabila manuala).
    const hasDP = a.persoane != null || a.sub26 || a.copii;
    const dp = hasDP ? fiscal.deducerePersonala(brut, a.persoane, { salariuMinim: fiscal.FISCAL.salariuMinimS1, sub26: a.sub26, copii: a.copii }).total : 0;
    const deducere = round2(dp + neimpozabil); // total scazut din baza de impozit
    const tichete = round2(Number(a.tichete) || 0);
    const sector = a.sector || 'normal';
    const avans = round2(Number(a.avans) || 0);
    const retineri = round2(Number(a.retineri) || 0);
    const p = fiscal.payroll(brut, deducere, { tichete, sector });
    const restPlata = round2(p.net - avans - retineri);
    rows.push({
      id: a.id, nume: a.nume || '', cnp: a.cnp || '', functie: a.functie || '', persoane: a.persoane != null ? Number(a.persoane) : null, sub26: !!a.sub26, copii: Number(a.copii) || 0,
      brut, spor, neimpozabil, deducere: dp, tichete, sector, scutire: p.scutImpozit || p.scutCass, overPlafon: p.overPlafon,
      cas: p.cas, cass: p.cass, impozit: p.impozit, cam: p.cam, net: p.net, avans, retineri, restPlata, costTotal: p.costTotal,
    });
    t.deducere = round2(t.deducere + dp); t.tichete = round2((t.tichete || 0) + tichete);
    t.brut = round2(t.brut + brut); t.neimpozabil = round2(t.neimpozabil + neimpozabil); t.spor = round2(t.spor + spor);
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
