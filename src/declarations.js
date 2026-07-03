'use strict';

// Registrul depunerilor de declaratii + termene fiscale + agregarea pe portofoliu (multi-firma).
//
// Modelul: declaratiile ASTEPTATE pentru o firma/luna sunt derivate din profilul firmei
// (platitor de TVA -> D300/D394/D406, are angajati -> D112, luna de trimestru -> D100);
// STAREA efectiva e tinuta in colectia `declarations` cu cheia (firmaId, tip, period):
//   nedepusa (implicit, fara inregistrare) -> generata (XML descarcat) -> depusa / eroare;
//   scutita = firma nu datoreaza declaratia in acea perioada (opreste atentionarile).

const TIPURI = {
  d300: { nume: 'D300 — decont TVA' },
  d394: { nume: 'D394 — declarație informativă' },
  d112: { nume: 'D112 — contribuții și impozit salarii' },
  d100: { nume: 'D100 — impozit micro / avans profit (trimestrial)' },
  saft: { nume: 'D406 — SAF-T (anual)' },
};
const STATUSES = ['nedepusa', 'generata', 'depusa', 'eroare', 'scutita'];

function pad2(n) { return String(n).padStart(2, '0'); }
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m = 1-12

/** Termenul de depunere pentru declaratia `tip` aferenta lunii `period` (YYYY-MM). */
function dueDate(tip, period) {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  if (tip === 'saft') {
    // regim anual (contribuabili mici): pana la sfarsitul lui februarie anul urmator
    return (y + 1) + '-02-' + pad2(lastDayOfMonth(y + 1, 2));
  }
  // lunare/trimestriale: 25 ale lunii urmatoare
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return ny + '-' + pad2(nm) + '-25';
}

/** Declaratiile asteptate pentru o firma (vedere scoped) in luna `period`. */
function expectedForFirma(v, period) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return [];
  const m = Number(period.slice(5, 7));
  const tips = [];
  if (v.company && v.company.tvaPlatitor) tips.push('d300', 'd394');
  if ((v.angajati || []).length) tips.push('d112');
  if ([3, 6, 9, 12].includes(m)) tips.push('d100');
  if (v.company && v.company.tvaPlatitor && m === 12) tips.push('saft');
  return tips.map((tip) => ({ tip, nume: TIPURI[tip].nume, period, due: dueDate(tip, period) }));
}

/** Gaseste inregistrarea (firmaId, tip, period) in colectia declarations. */
function find(d, firmaId, tip, period) {
  return (d.declarations || []).find((x) => x.firmaId === firmaId && x.tip === tip && x.period === period);
}

/**
 * Upsert pe (firmaId, tip, period). `patch.status='generata'` NU retrogradeaza o depunere
 * deja marcata (depusa/scutita) — descarcarea repetata a XML-ului nu strica registrul.
 */
function record(d, firmaId, tip, period, patch, nextIdFn) {
  if (!TIPURI[tip] || !/^\d{4}-\d{2}$/.test(String(period || ''))) return null;
  d.declarations = d.declarations || [];
  let rec = find(d, firmaId, tip, period);
  if (!rec) {
    rec = { id: nextIdFn('dcl'), firmaId, tip, period, status: 'nedepusa', generatedAt: null, submittedAt: null, recipisa: '', note: '' };
    d.declarations.push(rec);
  }
  const p = patch || {};
  if (p.status && STATUSES.includes(p.status)) {
    const keep = p.status === 'generata' && (rec.status === 'depusa' || rec.status === 'scutita');
    if (!keep) rec.status = p.status;
  }
  if (p.generatedAt) rec.generatedAt = p.generatedAt;
  if (p.status === 'depusa') rec.submittedAt = p.submittedAt || new Date().toISOString();
  if (p.recipisa != null) rec.recipisa = String(p.recipisa).slice(0, 100);
  if (p.note != null) rec.note = String(p.note).slice(0, 300);
  if (p.updatedBy) rec.updatedBy = p.updatedBy;
  rec.updatedAt = new Date().toISOString();
  return rec;
}

/** Registrul unei firme pe o luna: asteptate ∪ inregistrari, cu termen si restanta. */
function registerForFirma(d, v, period, today) {
  const t = today || new Date().toISOString().slice(0, 10);
  const rows = expectedForFirma(v, period).map((e) => {
    const rec = find(d, v.firmaId, e.tip, period) || {};
    const status = rec.status || 'nedepusa';
    return {
      tip: e.tip, nume: e.nume, period, due: e.due, status,
      overdue: e.due < t && status !== 'depusa' && status !== 'scutita',
      generatedAt: rec.generatedAt || null, submittedAt: rec.submittedAt || null,
      recipisa: rec.recipisa || '', note: rec.note || '',
    };
  });
  // inregistrari manuale in afara celor asteptate (ex. D100 marcat intr-o luna non-trimestriala)
  for (const rec of (d.declarations || [])) {
    if (rec.firmaId !== v.firmaId || rec.period !== period) continue;
    if (rows.some((r) => r.tip === rec.tip)) continue;
    rows.push({
      tip: rec.tip, nume: (TIPURI[rec.tip] || {}).nume || rec.tip, period, due: dueDate(rec.tip, period),
      status: rec.status, overdue: false, generatedAt: rec.generatedAt, submittedAt: rec.submittedAt,
      recipisa: rec.recipisa || '', note: rec.note || '',
    });
  }
  return rows;
}

/** Agregarea pe portofoliu: per firma + totaluri + conformitate, pe luna `period`. */
function portfolio(d, scopedList, period, today) {
  const t = today || new Date().toISOString().slice(0, 10);
  const firms = [];
  const tot = { asteptate: 0, depuse: 0, generate: 0, nedepuse: 0, erori: 0, scutite: 0, restante: 0 };
  for (const v of scopedList) {
    const rows = registerForFirma(d, v, period, t);
    const c = { asteptate: rows.length, depuse: 0, generate: 0, nedepuse: 0, erori: 0, scutite: 0, restante: 0 };
    const atentionari = [];
    for (const r of rows) {
      if (r.status === 'depusa') c.depuse += 1;
      else if (r.status === 'generata') c.generate += 1;
      else if (r.status === 'eroare') { c.erori += 1; atentionari.push(r.nume.split(' — ')[0] + ': eroare' + (r.note ? ' (' + r.note + ')' : '')); }
      else if (r.status === 'scutita') c.scutite += 1;
      else c.nedepuse += 1;
      if (r.overdue) { c.restante += 1; if (r.status !== 'eroare') atentionari.push(r.nume.split(' — ')[0] + ': termen depășit (' + r.due + ')'); }
    }
    for (const k of Object.keys(tot)) tot[k] += c[k];
    firms.push({
      firmaId: v.firmaId, nume: (v.company || {}).nume || ('Firma ' + v.firmaId), cui: (v.company || {}).cui || '',
      counts: c, atentionari, natentionari: atentionari.length,
    });
  }
  const datorate = tot.asteptate - tot.scutite;
  const conformitate = datorate > 0 ? Math.round((tot.depuse / datorate) * 100) : 100;
  firms.sort((a, b) => b.natentionari - a.natentionari || a.nume.localeCompare(b.nume));
  return { period, firms, tot, conformitate };
}

function addMonths(period, n) {
  let y = Number(period.slice(0, 4)); let m = Number(period.slice(5, 7)) + n;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return y + '-' + pad2(m);
}

/**
 * Notificari de termene pe portofoliu: restante + termene in urmatoarele `days` zile,
 * scanand ultimele `lookback` luni (declaratia lunii M are termen in M+1).
 */
function notifications(d, scopedList, today, days, lookback) {
  const t = today || new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.parse(t) + (days || 7) * 86400000).toISOString().slice(0, 10);
  const curPeriod = t.slice(0, 7);
  const items = [];
  for (const v of scopedList) {
    for (let i = 1; i <= (lookback || 3); i++) {
      const period = addMonths(curPeriod, -i);
      for (const r of registerForFirma(d, v, period, t)) {
        if (r.status === 'depusa' || r.status === 'scutita') continue;
        if (r.overdue) {
          items.push({ kind: 'restanta', firmaId: v.firmaId, firma: (v.company || {}).nume || '', tip: r.tip, nume: r.nume, period, due: r.due, status: r.status });
        } else if (r.due >= t && r.due <= horizon) {
          items.push({ kind: 'termen', firmaId: v.firmaId, firma: (v.company || {}).nume || '', tip: r.tip, nume: r.nume, period, due: r.due, status: r.status });
        }
      }
    }
  }
  items.sort((a, b) => (a.kind === b.kind ? a.due.localeCompare(b.due) : (a.kind === 'restanta' ? -1 : 1)));
  return { count: items.length, items };
}

module.exports = { TIPURI, STATUSES, dueDate, expectedForFirma, record, registerForFirma, portfolio, notifications, addMonths, find };
