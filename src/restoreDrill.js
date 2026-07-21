'use strict';

// Exercitiul de restaurare AUTOMATIZAT. backup.verifyArchive verifica STRUCTURA arhivei (db.json
// parsabil, lista de firme, instantaneu sqlite prezent). Drill-ul merge mai adanc: extrage db.json
// din arhiva completa si, in IZOLARE (fara a atinge baza vie), RULEAZA efectiv agregarea contabila
// peste graful restaurat, pe FIECARE firma, si verifica BALANTA DE VERIFICARE — egalitatea totalurilor
// (rulaj + solduri de preluare): Σdebit == Σcredit. Doua garantii peste verifyArchive:
//   1) PROCESABILITATE: daca datele restaurate sunt corupte incat agregarea arunca, drill-ul prinde
//      (per firma, cu eroarea drept motiv) — nu doar "JSON-ul se parseaza".
//   2) COERENTA: fiindca fiecare LINIE poarta debit+credit cu aceeasi suma, rulajul e echilibrat prin
//      constructie; ce poate dezechilibra totalul e o PRELUARE (openingBalances) stricata sau o suma
//      corupta (NaN) — exact semnalele pe care un backup/restore le-ar putea introduce, si pe care
//      egalitatea Σdebit==Σcredit le prinde. Ridica exercitiul manual trimestrial (MONITORING.md) la
// o verificare rulata la fiecare backup. Pur: primeste graful/arhiva, intoarce raportul; nicio
// scriere, niciun singleton (doar functiile pure din accounting peste graful brut).

const acc = require('./accounting');
const { round2 } = require('./util');

/** Vedere scoped pe o firma, construita din graful BRUT din db.json — replica minima a db.scoped
 *  pentru contabilitate (entries + openingBalances). Aceeasi regula de apartenenta ca db.scoped:
 *  articolele fara firmaId apartin firmei active (compat. cu bazele mono-firma vechi). */
function scopedView(d, fid) {
  const active = d.firmaActiva;
  return {
    firmaId: fid,
    entries: (d.entries || []).filter((e) => (e.firmaId == null ? active : e.firmaId) === fid),
    openingBalances: (d.openingBalances || {})[fid] || {},
  };
}

/** Balanta de verificare pe o vedere: Σdebit == Σcredit peste rulaj (articolele POSTATE, ciornele
 *  excluse) PLUS soldurile de preluare. Ruleaza agregarea (proba de procesabilitate) sub try/catch —
 *  o coruptie care o face sa arunce inseamna date nerestaurabile pe firma respectiva. */
function checkBalanced(view) {
  try {
    const r = acc.accumulate(acc.allLines(acc.postedEntries(view)));
    const opening = view.openingBalances || {};
    let td = 0; let tc = 0;
    for (const cod of Object.keys(r)) { td = round2(td + r[cod].d); tc = round2(tc + r[cod].c); }
    for (const cod of Object.keys(opening)) { const o = opening[cod] || {}; td = round2(td + (Number(o.d) || 0)); tc = round2(tc + (Number(o.c) || 0)); }
    const balanced = Number.isFinite(td) && Number.isFinite(tc) && round2(td) === round2(tc);
    return { balanced, totalDebit: td, totalCredit: tc, entries: view.entries.length };
  } catch (e) {
    return { balanced: false, error: e.message, entries: (view.entries || []).length };
  }
}

/** Ruleaza drill-ul pe un graf deja parsat (db.json). Verifica structura minima si coerenta
 *  contabila pe fiecare firma. @returns { ok, nrFirme, totalEntries, firme:[...], motiv } */
function drillGraph(d) {
  if (!d || !Array.isArray(d.firme)) return { ok: false, motiv: 'db.json nu contine lista de firme' };
  const firme = [];
  let totalEntries = 0; let allBalanced = true;
  for (const f of d.firme) {
    const bal = checkBalanced(scopedView(d, f.id));
    totalEntries += bal.entries;
    if (!bal.balanced) allBalanced = false;
    firme.push({ id: f.id, nume: f.nume || '', entries: bal.entries, balanced: bal.balanced, totalDebit: bal.totalDebit, totalCredit: bal.totalCredit, error: bal.error });
  }
  const rele = firme.filter((x) => !x.balanced).map((x) => (x.nume || x.id) + (x.error ? ' (' + x.error + ')' : ''));
  return {
    ok: allBalanced,
    nrFirme: firme.length,
    totalEntries,
    firme,
    motiv: allBalanced ? null : 'balanta de verificare nu se inchide la: ' + rele.join(', '),
  };
}

/** Drill pe o arhiva completa full-*.zip: extrage db.json, apoi drillGraph. */
function drillArchive(zipPath) {
  const AdmZip = require('adm-zip');
  let d;
  try {
    const zip = new AdmZip(zipPath);
    const je = zip.getEntry('db.json');
    if (!je) return { ok: false, motiv: 'db.json lipseste din arhiva' };
    d = JSON.parse(zip.readAsText(je));
  } catch (e) { return { ok: false, motiv: 'arhiva ilizibila: ' + e.message }; }
  return drillGraph(d);
}

module.exports = { drillArchive, drillGraph, scopedView, checkBalanced };
