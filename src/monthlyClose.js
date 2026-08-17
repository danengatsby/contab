'use strict';

// INCHIDEREA LUNARA ca FLUX UNIC — motorul (pur, fara scrieri).
//
// Aplicatia avea deja toate piesele (documente lipsa, punctaj bancar, regularizare TVA, registrul
// declaratiilor, validarea pre-depunere, blocarea perioadei), dar raspandite pe sase ecrane. Aici
// se compune ORDINEA lor si se raspunde la singura intrebare a contabilului la final de luna:
// „ce mai am de facut ca sa pot inchide?".
//
// Principiul de baza: STAREA fiecarui pas se DERIVA din date, nu se bifeaza de mana. O bifa manuala
// ar putea ramane adevarata dupa ce datele se schimba (o factura noua inregistrata dupa punctaj,
// o declaratie retrasa) — iar un flux de inchidere care minte e mai rau decat lipsa lui. Se
// persista DOAR ce nu se poate deduce: responsabilul, termenul, nota, dovada validarii, aprobarea
// si eventuala fortare (cu motiv). Vezi src/monthlyCloseService.js pentru scrieri.
//
// Vocabularul starilor unui pas:
//   gata       — nimic de facut (derivat din date sau, la aprobare, din inregistrarea explicita)
//   deschis    — e randul lui, dar mai are ceva de rezolvat (`blocaje` spune exact ce)
//   blocat     — asteapta un pas anterior (`blocatDe` spune care) — nu se lucreaza inca la el
//   nuseaplica — pasul nu are obiect pentru firma asta (ex. TVA la o firma neplatitoare)

const acc = require('./accounting');
const rep = require('./reporting');
const decl = require('./declarations');
const fiscalProfile = require('./fiscalProfile');
const { reconcile } = require('./reconcile');
const { period: periodOf, plural, fmtDate } = require('./util');
// Temeiul legal al fiecarui pas — sursa UNICA (src/temeiLegal.js), aceeasi din care citesc si
// inchiderea anului si ghidul. Cheile pasilor de mai jos coincid cu cele din faza „lunar";
// o poarta din suita refuza un pas fara temei, ca sa nu apara unul „mut" la o adaugare viitoare.
const temeiLegal = require('./temeiLegal');

// Pasii, in ordinea fluxului. `tab`/`eticheta` duc utilizatorul exact la ecranul care rezolva pasul.
const STEPS = [
  { key: 'documente', nume: 'Documente complete', tab: 'intrate', eticheta: 'Vezi documentele lunii',
    descriere: 'Toate documentele lunii sunt înregistrate și postate (fără ciorne, fără furnizori lipsă).' },
  { key: 'banca', nume: 'Extras bancar și punctaj', tab: 'reconciliere', eticheta: 'Verifică extrasul',
    descriere: 'Încasările și plățile lunii sunt înregistrate și punctate cu facturile.' },
  { key: 'tva', nume: 'TVA regularizat', tab: 'tva', eticheta: 'Deschide decontul de TVA',
    descriere: 'Nota de regularizare TVA a lunii e postată și acoperă toate operațiunile.' },
  { key: 'declaratii', nume: 'Declarații validate și depuse', tab: 'livrabile', eticheta: 'Deschide declarațiile',
    descriere: 'Fiecare declarație așteptată e validată fără erori și marcată depusă (sau scutită).' },
  // Ultimii doi pasi se rezolva din bara de actiuni a cockpitului, nu pe alt ecran -> fara `tab`.
  { key: 'aprobare', nume: 'Aprobare', tab: null, eticheta: null,
    descriere: 'Cineva își asumă explicit că luna e corectă și poate fi raportată.' },
  { key: 'blocare', nume: 'Perioada blocată', tab: null, eticheta: null,
    descriere: 'Luna devine read-only; corecțiile ulterioare se fac doar prin storno într-o lună deschisă.' },
];
const STEP_KEYS = STEPS.map((s) => s.key);

// Termenele implicite: ancora e termenul REAL de depunere al lunii (cel mai devreme dintre
// declaratiile asteptate, altfel 25 ale lunii urmatoare), iar pasii dinainte primesc un decalaj
// inapoi. Asa termenul nu e o cifra inventata, ci se muta singur cand se schimba termenele fiscale.
const DEFAULT_OFFSET_DAYS = { documente: -15, banca: -10, tva: -5, declaratii: 0, aprobare: 0, blocare: 0 };

function shiftDays(iso, n) {
  const d = new Date(String(iso) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Ancora de termen a lunii: cel mai devreme termen de depunere asteptat (fallback: 25 ale lunii urmatoare). */
function anchorDue(expected, period) {
  const dues = (expected || []).map((e) => e.due).filter(Boolean).sort();
  return dues.length ? dues[0] : decl.dueDate('d300', period);
}

/** Inregistrarea persistata a lunii (poate lipsi — totul are valori implicite). */
function findRecord(d, firmaId, period) {
  return (d.closings || []).find((c) => c.firmaId === firmaId && c.period === period) || null;
}

// ── Semnalele fiecarui pas (fiecare intoarce `blocaje` = motivele pentru care pasul NU e gata) ──

/** 1. Documente: ciorne nepostate, furnizori recurenti fara document, e-Facturi netrimise. */
function checkDocumente(v, period, today) {
  const blocaje = []; const detalii = {};
  const inLuna = (e) => (e.period || periodOf(e.data)) === period;
  const ciorne = (v.entries || []).filter((e) => inLuna(e) && e.status && e.status !== 'postat');
  detalii.ciorne = ciorne.length;
  if (ciorne.length) {
    blocaje.push(ciorne.length + (ciorne.length === 1 ? ' articol în ciornă' : ' articole în ciornă')
      + ' — postează-le sau șterge-le (ciornele nu intră în contabilitate).');
  }
  const md = rep.missingDocs(v, period);
  detalii.documenteLipsa = md.missing.length;
  detalii.countThis = md.countThis;
  detalii.avgPrev = md.avgPrev;
  if (md.missing.length) {
    blocaje.push(md.missing.length + ' furnizor(i) obișnuiți fără document în lună: '
      + md.missing.slice(0, 3).map((m) => m.partener).join(', ') + (md.missing.length > 3 ? ' ș.a.' : '') + '.');
  }
  // e-Factura: facturile lunii netrimise in SPV (termen legal 5 zile calendaristice, OUG 89/2025)
  const ef = decl.eFacturaNetrimise(v, today, 400).items.filter((f) => String(f.data).slice(0, 7) === period);
  detalii.efacturaNetrimise = ef.length;
  if (ef.length) blocaje.push(plural(ef.length, 'factură emisă', 'facturi emise') + ' în lună, fără trimitere în SPV (e-Factura).');
  return { blocaje, detalii };
}

/** 2. Banca: decontari nepunctate din luna + sold de casa negativ. */
function checkBanca(v, period) {
  const blocaje = []; const detalii = {};
  const CONTURI_TREZORERIE = rep.CONTURI_TREZORERIE;
  const inLuna = (e) => (e.period || periodOf(e.data)) === period;
  const miscari = acc.postedEntries(v).filter((e) => inLuna(e)
    && (e.lines || []).some((l) => CONTURI_TREZORERIE.includes(String(l.debit)) || CONTURI_TREZORERIE.includes(String(l.credit))));
  detalii.miscariTrezorerie = miscari.length;
  // Punctajul: decontarile lunii care nu sting complet o factura (reconcile marcheaza `matched`).
  const idsLuna = new Set(miscari.map((e) => e.id));
  let nepunctate = 0;
  for (const p of reconcile(v).partners) {
    for (const it of p.items) {
      const eFactura = p.sens === 'creanta' ? it.debit > 0 : it.credit > 0;
      if (eFactura || it.matched || !idsLuna.has(it.entryId)) continue;
      nepunctate += 1;
    }
  }
  detalii.nepunctate = nepunctate;
  if (nepunctate) blocaje.push(nepunctate + ' încasare/plată din lună nepunctată cu o factură — verifică extrasul.');
  // Sold de casa negativ: imposibil fizic, deci o eroare de inregistrare (lipseste o incasare).
  const negative = acc.cashControl(v, '5311', period).negative || [];
  detalii.casaNegativa = negative.length;
  if (negative.length) blocaje.push('Soldul casei devine NEGATIV în ' + negative.length + ' moment(e) ale lunii — lipsește o încasare sau o sumă e greșită.');
  if (!miscari.length) detalii.faraMiscari = true; // semnalat ca info in UI, nu ca blocaj
  return { blocaje, detalii };
}

/** 3. TVA: nota de regularizare a lunii, si sa nu fi ramas TVA neregularizat dupa ea. */
function checkTva(v, period, profile) {
  if (!profile.tvaPlatitor) return { nuSeAplica: true, motiv: 'Firma nu e plătitoare de TVA.', blocaje: [], detalii: {} };
  const blocaje = []; const detalii = {};
  const nota = (v.entries || []).find((e) => e.tip === 'inchidere_tva' && (e.period || periodOf(e.data)) === period);
  detalii.notaPostata = !!nota;
  // vatClosing recalculeaza din rulajul CURENT al lunii: cate linii ar mai avea de produs acum.
  // Zero linii inseamna ca nu a mai ramas nimic de regularizat — fie s-a facut nota, fie luna
  // n-a avut deloc TVA. Verificarea prinde si cazul real in care o factura e inregistrata DUPA
  // regularizare: nota exista, dar a ramas TVA nerepartizat, deci pasul nu mai e gata.
  const rest = acc.vatClosing(v, period);
  detalii.restNeregularizat = rest.lines.length ? Math.abs(rest.diff) : 0;
  if (!rest.lines.length) {
    // Nimic de regularizat. Fara nota inseamna o luna fara operatiuni de TVA — a cere o nota goala
    // ar fi un blocaj inventat; pasul e gata, dar spunem de ce.
    if (!nota) detalii.faraOperatiuniTva = true;
    return { blocaje, detalii };
  }
  blocaje.push(nota
    ? 'Au apărut operațiuni cu TVA după regularizare (mai sunt ' + Math.abs(rest.diff) + ' lei nerepartizați) — reia închiderea de TVA a lunii.'
    : 'Nota de regularizare TVA a lunii nu e postată — apasă „Închide TVA-ul lunii".');
  return { blocaje, detalii };
}

/** 4. Declaratii: fiecare asteptata trebuie depusa/scutita SI cu dovada de validare fara erori. */
function checkDeclaratii(d, v, period, rec, today) {
  const blocaje = []; const detalii = {};
  const rows = decl.registerForFirma(d, v, period, today);
  const validari = (rec && rec.validari) || {};
  const lista = rows.map((r) => {
    const dovada = validari[r.tip] || null;
    return {
      tip: r.tip, nume: r.nume, due: r.due, status: r.status, overdue: r.overdue,
      dovada: dovada ? { at: dovada.at, by: dovada.by, ok: !!dovada.ok, errors: dovada.errors || 0, warnings: dovada.warnings || 0 } : null,
    };
  });
  detalii.declaratii = lista;
  detalii.asteptate = lista.length;
  for (const r of lista) {
    if (r.status === 'scutita') continue;
    if (r.status !== 'depusa') {
      blocaje.push(r.nume.split(' — ')[0] + ': ' + (r.status === 'eroare' ? 'depunere cu EROARE' : 'nedepusă')
        + (r.overdue ? ' (termen depășit ' + fmtDate(r.due) + ')' : ' (termen ' + fmtDate(r.due) + ')') + '.');
      continue;
    }
    // Depusa, dar fara dovada de validare (sau cu erori la ultima validare) — fluxul cere dovada.
    if (!r.dovada) blocaje.push(r.nume.split(' — ')[0] + ': depusă, dar fără dovadă de validare — rulează validarea.');
    else if (!r.dovada.ok) blocaje.push(r.nume.split(' — ')[0] + ': ultima validare a găsit ' + r.dovada.errors + ' eroare/erori.');
  }
  if (!lista.length) return { nuSeAplica: true, motiv: 'Nicio declarație așteptată pentru luna asta.', blocaje: [], detalii };
  return { blocaje, detalii };
}

/**
 * Starea completa a inchiderii lunii: pasii cu stare, blocaje, responsabil si termen.
 * `d` = baza bruta (declaratii + inregistrarea lunii), `v` = vederea scoped a firmei.
 * `opts.users` = [{id, username}] pentru afisarea numelui responsabilului; `opts.today` pt. teste.
 */
function status(d, v, period, opts) {
  const o = opts || {};
  const today = o.today || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) {
    const e = new Error('Perioada trebuie să fie o lună (YYYY-MM).');
    e.status = 400;
    throw e;
  }
  const firmaId = v.firmaId;
  const rec = findRecord(d, firmaId, period);
  const profile = fiscalProfile.build(v.company || {}, { angajati: v.angajati });
  const expected = decl.expectedForFirma(v, period);
  const ancora = anchorDue(expected, period);
  const userName = (id) => {
    const u = (o.users || []).find((x) => x.id === Number(id));
    return u ? u.username : null;
  };

  const semnale = {
    documente: checkDocumente(v, period, today),
    banca: checkBanca(v, period),
    tva: checkTva(v, period, profile),
    declaratii: checkDeclaratii(d, v, period, rec, today),
  };

  // Aprobarea si blocarea nu au semnal in date, ci inregistrare proprie.
  const aprobare = (rec && rec.aprobare) || null;
  const lockedUntil = (v.company || {}).lockedUntil || '';
  const blocata = !!lockedUntil && lockedUntil >= period;

  const steps = [];
  let precedentGata = true; // pasul curent e „blocat" cat timp unul dinaintea lui nu e gata
  let primulNegata = null;
  for (const def of STEPS) {
    const s = semnale[def.key] || {};
    const cfg = ((rec && rec.steps) || {})[def.key] || {};
    let stare; let blocaje = s.blocaje || [];
    if (s.nuSeAplica) {
      stare = 'nuseaplica';
    } else if (def.key === 'aprobare') {
      stare = aprobare ? 'gata' : 'deschis';
      if (!aprobare) blocaje = ['Luna nu e aprobată încă.'];
    } else if (def.key === 'blocare') {
      stare = blocata ? 'gata' : 'deschis';
      if (!blocata) blocaje = ['Perioada e încă deschisă (editabilă).'];
    } else {
      stare = blocaje.length ? 'deschis' : 'gata';
    }
    if (stare !== 'gata' && stare !== 'nuseaplica' && !precedentGata) stare = 'blocat';
    const due = cfg.due || shiftDays(ancora, DEFAULT_OFFSET_DAYS[def.key] || 0);
    steps.push({
      key: def.key, nume: def.nume, descriere: def.descriere, tab: def.tab, eticheta: def.eticheta,
      temei: temeiLegal.temeiul(def.key),
      stare,
      motiv: s.motiv || null,                                  // de ce nu se aplica
      blocaje: stare === 'gata' || stare === 'nuseaplica' ? [] : blocaje,
      blocatDe: stare === 'blocat' ? primulNegata : null,       // MOTIVUL blocajului: pasul care il tine
      responsabilId: cfg.responsabilId != null ? cfg.responsabilId : null,
      responsabil: cfg.responsabilId != null ? userName(cfg.responsabilId) : null,
      due,
      dueImplicit: !cfg.due,
      overdue: stare !== 'gata' && stare !== 'nuseaplica' && due < today,
      nota: cfg.nota || '',
      detalii: s.detalii || {},
    });
    if (stare !== 'gata' && stare !== 'nuseaplica') {
      if (!primulNegata) primulNegata = def.nume;
      precedentGata = false;
    }
  }

  const pasiDeLucru = steps.filter((s) => s.stare !== 'nuseaplica');
  const gataCount = pasiDeLucru.filter((s) => s.stare === 'gata').length;
  // „Se poate inchide" = tot ce e INAINTEA blocarii e gata (blocarea e chiar actiunea de facut).
  const inainteDeBlocare = steps.filter((s) => s.key !== 'blocare' && s.stare !== 'nuseaplica');
  const blocante = inainteDeBlocare.filter((s) => s.stare !== 'gata');
  return {
    period,
    steps,
    progres: { gata: gataCount, total: pasiDeLucru.length, procent: pasiDeLucru.length ? Math.round((gataCount / pasiDeLucru.length) * 100) : 100 },
    sePoateInchide: blocante.length === 0,
    blocante: blocante.map((s) => ({ key: s.key, nume: s.nume, blocaje: s.blocaje })),
    inchisa: blocata,
    // Blocata NU inseamna neaparat „inchisa prin flux": marcarea unei declaratii ca DEPUSA
    // blocheaza deja perioada automat (ruta /api/declarations/set, comportament mai vechi).
    // `finalizata` = luna a trecut si prin dosarul de inchidere (aprobare + consemnare).
    finalizata: !!(blocata && rec && rec.closedAt),
    inchidere: (rec && rec.closedAt) ? { at: rec.closedAt, by: rec.closedBy, username: rec.closedByName || userName(rec.closedBy) || '' } : null,
    lockedUntil: lockedUntil || null,
    aprobare: aprobare ? Object.assign({}, aprobare, { responsabil: userName(aprobare.by) || aprobare.username || null }) : null,
    fortata: (rec && rec.fortata) || null,
    ancoraTermen: ancora,
  };
}

module.exports = { STEPS, STEP_KEYS, status, findRecord, anchorDue, shiftDays, DEFAULT_OFFSET_DAYS };
