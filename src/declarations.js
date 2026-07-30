'use strict';

const { postedEntries } = require('./accounting'); // ciornele nu declanseaza asteptari de declaratii/e-Factura
const fiscalProfile = require('./fiscalProfile'); // motorul de profil fiscal (sursa unica)

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
  d390: { nume: 'D390 — recapitulativă intracomunitară (VIES)' },
  d100: { nume: 'D100 — impozit micro / avans profit (trimestrial)' },
  d101: { nume: 'D101 — impozit pe profit (anual)' },
  saft: { nume: 'D406 — SAF-T' },
  intrastat: { nume: 'Intrastat — declarație statistică (INS)' },
  bilant: { nume: 'Situații financiare anuale (bilanț)' },
};
const STATUSES = ['nedepusa', 'generata', 'depusa', 'eroare', 'scutita'];

function pad2(n) { return String(n).padStart(2, '0'); }
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m = 1-12

/** Termenul de depunere pentru declaratia `tip` aferenta lunii `period` (YYYY-MM). */
function dueDate(tip, period) {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  if (tip === 'saft') {
    // D406: ultima zi calendaristica a lunii urmatoare perioadei raportate (fara gratie din 2026)
    return ny + '-' + pad2(nm) + '-' + pad2(lastDayOfMonth(ny, nm));
  }
  // Intrastat: pana pe 15 ale lunii urmatoare (termen INS)
  if (tip === 'intrastat') return ny + '-' + pad2(nm) + '-15';
  // D101 (impozit pe profit anual): 25 martie anul URMATOR anului fiscal (perioada = Y-12)
  if (tip === 'd101') return (y + 1) + '-03-25';
  // Situatiile financiare anuale: 31 MAI anul urmator, pentru societati (art. 36 alin. 1 din
  // Legea contabilitatii 82/1991 — 150 de zile de la incheierea exercitiului financiar).
  if (tip === 'bilant') return (y + 1) + '-05-31';
  // restul: 25 ale lunii urmatoare
  return ny + '-' + pad2(nm) + '-25';
}

/**
 * Declaratiile asteptate pentru o firma (vedere scoped) in luna `period`.
 * SAF-T (D406): LUNAR pentru platitorii de TVA (perioada fiscala lunara) si TRIMESTRIAL
 * pentru neplatitori / perioada trimestriala — regimul din 2025 pentru toti contribuabilii.
 * Firmele cu alt regim marcheaza lunile in plus drept „scutite" in registru.
 */
const INTRACOM_TYPES = new Set(['livrare_intracomunitara', 'achizitie_intracomunitara']);

function expectedForFirma(v, period) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return [];
  // Sursa UNICA: profilul fiscal al firmei deriva lista (nu boolean-uri citite inline aici).
  const profile = fiscalProfile.build((v || {}).company, { angajati: (v || {}).angajati });
  const hasIntracom = (per) => postedEntries(v).some((e) => INTRACOM_TYPES.has(e.tip) && String(e.period || e.data || '').slice(0, 7) === per);
  return fiscalProfile.expected(profile, period, hasIntracom)
    .map((tip) => ({ tip, nume: (TIPURI[tip] || {}).nume || tip, period, due: dueDate(tip, period) }));
}

// ── e-Factura B2B: facturi emise netrimise in SPV (termen legal: 5 zile CALENDARISTICE, OUG 89/2025) ──
const EFACT_SEND_TYPES = new Set(['factura_vanzare_marfuri', 'factura_vanzare_produse', 'factura_vanzare_servicii', 'livrare_intracomunitara', 'factura_storno_vanzare']);

/** Data + n zile lucratoare (sambata/duminica sarite). Pastrat pentru compatibilitate. */
function addBusinessDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}
/** Data + n zile CALENDARISTICE. */
function addCalendarDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Facturile B2B emise (cu CUI de partener) care NU au fost trimise in SPV, din ultimele
 * `lookbackDays` zile. `due` = data emiterii + 5 zile CALENDARISTICE (termenul legal e-Factura, OUG 89/2025).
 */
function eFacturaNetrimise(v, today, lookbackDays) {
  const t = today || new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(t) - (lookbackDays || 60) * 86400000).toISOString().slice(0, 10);
  const items = [];
  for (const e of postedEntries(v)) {
    if (!EFACT_SEND_TYPES.has(e.tip)) continue;
    if (!e.partenerCui) continue; // B2B: partener identificat prin CUI
    if (e.spv && (e.spv.index || e.spv.stare)) continue; // deja trimisa
    if (!e.data || e.data < from || e.data > t) continue;
    const due = addCalendarDays(e.data, 5);
    items.push({ entryId: e.id, document: e.document || '', partener: e.partener || '', data: e.data, due, overdue: due < t });
  }
  items.sort((a, b) => a.due.localeCompare(b.due));
  return { count: items.length, overdue: items.filter((x) => x.overdue).length, items };
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

// ─────────────────────────────────────────────────────────────────────────────
//  DECLARATII RECTIFICATIVE
//
//  Sondajul pe validatoarele oficiale (metoda „validatorul ca oracol") a aratat ca cele trei
//  declaratii NU se comporta la fel — si ca doua dintre ele nu au niciun steag in XML:
//
//    D112 — SEMNALIZATA in XML: `d_rec="1"` + `tip_rec="N"`. Regula A3b a validatorului:
//           daca d_rec=1, tip_rec nu poate fi 5. Daca d_rec=0, tip_rec nu se completeaza deloc.
//    D300 — FARA steag. Rectificarea e o redepunere a decontului pe aceeasi perioada. Singurul
//           camp inrudit e `temei`, cu lista {0, 2} (1 si 3 respinse la sondaj): temeiul legal
//           cand decontul se depune DUPA anularea rezervei verificarii ulterioare.
//    D394 — FARA steag, zero aparitii ale notiunii in tot validatorul. Rectificarea e o
//           redepunere completa.
//
//  Consecinta de proiectare: „rectificativa" e in primul rand o stare a APLICATIEI (a cata
//  depunere, de ce, ce s-a schimbat), nu un camp XML. De aceea istoricul de mai jos e tinut
//  pentru toate trei, iar XML-ul primeste steag doar unde exista.
// ─────────────────────────────────────────────────────────────────────────────

/** Tipurile care poarta un steag de rectificare in XML (restul se redepun ca atare). */
const RECT_IN_XML = { d112: true };

/**
 * Inregistreaza o depunere noua peste (firmaId, tip, period). NU suprascrie: adauga in istoric.
 * Prima depunere are ordinal 1 si nu e rectificativa; urmatoarele sunt rectificative.
 * `motiv` e obligatoriu cand perioada e inchisa — vezi garda din serviciu.
 */
function addSubmission(d, firmaId, tip, period, info, nextIdFn) {
  const rec = record(d, firmaId, tip, period, {}, nextIdFn);
  if (!rec) return null;
  rec.depuneri = Array.isArray(rec.depuneri) ? rec.depuneri : [];
  const ordinal = rec.depuneri.length + 1;
  const dep = {
    ordinal,
    rectificativa: ordinal > 1,
    ts: (info && info.ts) || new Date().toISOString(),
    motiv: String((info && info.motiv) || '').slice(0, 500),
    de: (info && info.de) || '',
    // Sumele-cheie la momentul depunerii: fara ele nu se poate arata DIFERENTA fata de depunerea
    // anterioara, iar o rectificativa fara diferenta vizibila nu se poate verifica de nimeni.
    sume: (info && info.sume) || null,
    tipRec: (info && info.tipRec != null) ? Number(info.tipRec) : null,
  };
  rec.depuneri.push(dep);
  rec.status = 'depusa';
  rec.submittedAt = dep.ts;
  rec.updatedAt = dep.ts;
  return { rec, depunere: dep };
}

/** Ultima depunere (sau null), pentru diferenta la urmatoarea rectificativa. */
function lastSubmission(rec) {
  const list = (rec && Array.isArray(rec.depuneri)) ? rec.depuneri : [];
  return list.length ? list[list.length - 1] : null;
}

/** Diferenta dintre sumele a doua depuneri, pe cheile comune (doar valorile schimbate). */
function submissionDiff(prev, curr) {
  const a = (prev && prev.sume) || {}; const b = (curr && curr.sume) || {};
  const chei = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out = [];
  for (const k of chei) {
    const va = Number(a[k]) || 0; const vb = Number(b[k]) || 0;
    if (va !== vb) out.push({ cheie: k, inainte: va, dupa: vb, delta: Math.round((vb - va) * 100) / 100 });
  }
  return out;
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
    // Acelasi reper ca la notificari: pentru o luna dinaintea existentei firmei nu exista obligatii.
    // Firma RAMANE in lista, cu zero — portofoliul e inventarul firmelor administrate, iar una care
    // dispare si reapare dupa luna aleasa ar parea pierduta.
    const dela = primaLunaUrmarita(v);
    const rows = (dela && String(period || '') < dela) ? [] : registerForFirma(d, v, period, t);
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
/**
 * Prima luna pentru care aplicatia are dreptul sa ceara declaratii de la o firma.
 *
 * Calendarul fiscal se DERIVA din profilul firmei (platitor de TVA, angajati, regim), nu din date
 * — asa si trebuie, fiindca multe declaratii se depun „pe zero". Dar fara un reper de inceput,
 * o firma creata AZI aparea imediat cu restante pentru lunile dinaintea ei: 9 restante D300/D394/
 * D406 pentru luni in care nu exista. E o acuzatie falsa, si tocmai pe ecranul care ar trebui sa
 * fie lista de lucru a utilizatorului.
 *
 * Reperul e `createdAt`. Daca firma are inregistrari mai VECHI (istoric preluat de la contabilul
 * anterior), acelea coboara reperul: acolo obligatiile sunt reale si trebuie aratate.
 * Firmele fara `createdAt` (cele dinainte de campul asta) intorc '' — comportament neschimbat,
 * ca sa nu ascundem retroactiv restante adevarate.
 */
function primaLunaUrmarita(v) {
  let min = String(((v && v.company) || {}).createdAt || '').slice(0, 7);
  if (!min) return '';
  for (const e of ((v && v.entries) || [])) {
    const p = String(e.period || e.data || '').slice(0, 7);
    if (p && p < min) min = p;
  }
  return min;
}

function notifications(d, scopedList, today, days, lookback) {
  const t = today || new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.parse(t) + (days || 7) * 86400000).toISOString().slice(0, 10);
  const curPeriod = t.slice(0, 7);
  const items = [];
  for (const v of scopedList) {
    const dela = primaLunaUrmarita(v); // '' = firma veche, fara reper -> ca inainte
    for (let i = 1; i <= (lookback || 3); i++) {
      const period = addMonths(curPeriod, -i);
      if (dela && period < dela) continue; // luna dinaintea existentei firmei: n-are obligatii aici
      for (const r of registerForFirma(d, v, period, t)) {
        if (r.status === 'depusa' || r.status === 'scutita') continue;
        if (r.overdue) {
          items.push({ kind: 'restanta', firmaId: v.firmaId, firma: (v.company || {}).nume || '', tip: r.tip, nume: r.nume, period, due: r.due, status: r.status });
        } else if (r.due >= t && r.due <= horizon) {
          items.push({ kind: 'termen', firmaId: v.firmaId, firma: (v.company || {}).nume || '', tip: r.tip, nume: r.nume, period, due: r.due, status: r.status });
        }
      }
    }
    // e-Factura B2B netrimisa in SPV: restanta cand termenul de 5 zile lucratoare e depasit
    for (const f of eFacturaNetrimise(v, t).items) {
      const nume = 'e-Factura ' + (f.document || f.entryId) + (f.partener ? ' — ' + f.partener : '');
      if (f.overdue) items.push({ kind: 'restanta', firmaId: v.firmaId, firma: (v.company || {}).nume || '', tip: 'efactura', nume, period: f.data.slice(0, 7), due: f.due, status: 'netrimisa' });
      else if (f.due <= horizon) items.push({ kind: 'termen', firmaId: v.firmaId, firma: (v.company || {}).nume || '', tip: 'efactura', nume, period: f.data.slice(0, 7), due: f.due, status: 'netrimisa' });
    }
  }
  items.sort((a, b) => (a.kind === b.kind ? a.due.localeCompare(b.due) : (a.kind === 'restanta' ? -1 : 1)));
  return { count: items.length, items };
}

module.exports = { TIPURI, STATUSES, dueDate, expectedForFirma, record, registerForFirma, portfolio, notifications, primaLunaUrmarita, addMonths, find, eFacturaNetrimise, addBusinessDays, addCalendarDays,
  addSubmission, lastSubmission, submissionDiff, RECT_IN_XML };
