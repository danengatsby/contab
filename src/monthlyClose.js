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
const openItems = require('./openItems');
const bankStatements = require('./bankStatements');
const stocks = require('./stocks');
const assets = require('./assets');
const annualInventory = require('./annualInventory');
const fxreval = require('./fxreval');
const { period: periodOf, plural, fmtDate } = require('./util');
// Temeiul legal al fiecarui pas — sursa UNICA (src/temeiLegal.js), aceeasi din care citesc si
// inchiderea anului si ghidul. Cheile pasilor de mai jos coincid cu cele din faza „lunar";
// o poarta din suita refuza un pas fara temei, ca sa nu apara unul „mut" la o adaugare viitoare.
const temeiLegal = require('./temeiLegal');
const crypto = require('crypto');

// Pasii, in ordinea fluxului. `tab`/`eticheta` duc utilizatorul exact la ecranul care rezolva pasul.
const STEPS = [
  { key: 'documente', nume: 'Documente complete', tab: 'intrate', eticheta: 'Vezi documentele lunii',
    descriere: 'Toate documentele lunii sunt înregistrate și postate (fără ciorne, fără furnizori lipsă).' },
  { key: 'banca', nume: 'Extras bancar și punctaj', tab: 'reconciliere', eticheta: 'Verifică extrasul',
    descriere: 'Încasările și plățile lunii sunt înregistrate și punctate cu facturile.' },
  { key: 'amortizare_lunara', nume: 'Amortizarea lunii', tab: 'mijloace', eticheta: 'Deschide mijloacele fixe',
    descriere: 'Amortizarea activelor eligibile este calculată și postată pentru luna curentă.' },
  { key: 'reevaluare_valutara', nume: 'Reevaluarea valutară', tab: 'inchideri', eticheta: 'Reevaluează soldurile în valută',
    descriere: 'Soldurile monetare în valută sunt reevaluate la cursul de închidere al lunii.' },
  { key: 'ajustari_inventar', nume: 'Inventariere și ajustări', tab: 'inchidere-an', eticheta: 'Deschide inventarierea',
    descriere: 'În decembrie, inventarierea și valorile de inventar sunt consemnate înainte de blocarea lunii.' },
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
const DEFAULT_OFFSET_DAYS = {
  documente: -15, banca: -10, amortizare_lunara: -9, reevaluare_valutara: -8,
  ajustari_inventar: -7, tva: -5, declaratii: 0, aprobare: 0, blocare: 0,
};

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

/** JSON canonic: ordinea cheilor nu schimba amprenta, ordinea listelor (cronologia) da. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = canonical(value[key]);
  }
  return out;
}
function sha(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/**
 * Amprenta continutului contabil/fiscal disponibil pana la luna ceruta. Exclude campurile pur
 * operationale (abonament, credentiale SPV, blocarea perioadei, timpii/actorii articolelor), dar
 * include cifrele, statutul postarii, configurarea fiscala, tertii si subregistrele care pot
 * schimba declaratiile sau controalele de inchidere.
 */
function periodFingerprint(v, period) {
  const panaLa = (x, field) => {
    const raw = x && x[field || 'data'];
    return !raw || String(raw).slice(0, 7) <= period;
  };
  const company = Object.assign({}, v.company || {});
  for (const k of ['lockedUntil', 'subscription', 'pendingPlan', 'anaf', 'billing', 'trialEndsAt', 'plan', 'logo']) delete company[k];
  const entries = (v.entries || []).filter((e) => panaLa(e)).map((e) => {
    const x = Object.assign({}, e);
    for (const k of ['createdAt', 'createdBy', 'createdByName', 'validatedAt', 'validatedBy',
      'approvedAt', 'approvedBy', 'postedAt', 'postedBy', 'statusHistory',
      'stornat', 'stornoBy', 'stornoData']) delete x[k];
    return x;
  });
  return sha({
    period, company, entries,
    angajati: v.angajati || [],
    payrollHistory: (v.payrollHistory || []).filter((x) => !x.period || x.period <= period),
    products: v.products || [], gestiuni: v.gestiuni || [],
    stockMovements: (v.stockMovements || []).filter((x) => panaLa(x)),
    inventories: (v.inventories || []).filter((x) => panaLa(x)),
    inventarAnual: (v.inventarAnual || []).filter((x) => String(x.an || x.data || '').slice(0, 4) <= period.slice(0, 4)),
    assets: (v.assets || []).filter((x) => panaLa(x, 'dataPif')),
    partners: v.partners || {}, openingBalances: v.openingBalances || {},
    openingAnalytic: v.openingAnalytic || [],
    cursuriBnr: (v.cursuriBnr || []).filter((x) => !x.data || String(x.data).slice(0, 7) <= period),
  });
}

/** Amprenta aprobarii = continutul perioadei + starea depunerilor asumate. */
function approvalFingerprint(d, v, period, sourceHash) {
  const depuneri = (d.declarations || []).filter((x) => x.firmaId === v.firmaId && x.period === period)
    .map((x) => ({
      tip: x.tip, status: x.status, recipisa: x.recipisa || '', artifactHash: x.artifactHash || '',
      depuneri: (x.depuneri || []).map((p) => ({ ordinal: p.ordinal, rectificativa: !!p.rectificativa,
        sume: p.sume || null, tipRec: p.tipRec, recipisa: p.recipisa || '', artifactHash: p.artifactHash || '' })),
    })).sort((a, b) => String(a.tip).localeCompare(String(b.tip), 'ro'));
  const rec = findRecord(d, v.firmaId, period);
  const validari = Object.entries((rec && rec.validari) || {}).map(([tip, x]) => ({
    tip, ok: !!x.ok, errors: Number(x.errors) || 0, contentHash: x.contentHash || '', sourceHash: x.sourceHash || '',
  })).sort((a, b) => a.tip.localeCompare(b.tip, 'ro'));
  return sha({ sourceHash: sourceHash || periodFingerprint(v, period), depuneri, validari });
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
  // Miscarea manuala de stoc este document primar, dar numai receptia/iesirea POSTATA are
  // corespondent in cartea mare. Transferul este intern si nu cere nota financiara; stocul initial
  // traieste in soldurile de deschidere. O legatura catre un articol stornat/orfan nu valoreaza
  // drept postare.
  const entryById = new Map((v.entries || []).map((e) => [e.id, e]));
  const miscariInventarContabilizate = new Set();
  for (const iv of (v.inventories || [])) {
    for (const id of (iv.movementIds || [])) miscariInventarContabilizate.add(id);
    for (const id of (iv.stornoMovementIds || [])) miscariInventarContabilizate.add(id);
  }
  const miscariNepostate = (v.stockMovements || []).filter((m) => inLuna(m) && !m.initial && !m.stornat
    && !m.stornoOfMovementId && m.tip !== 'transfer')
    .filter((m) => {
      if (miscariInventarContabilizate.has(m.id)) return false;
      const e = m.entryId ? entryById.get(m.entryId) : null;
      return !e || !acc.isPosted(e) || !!e.stornat;
    });
  detalii.miscariStocNepostate = miscariNepostate.length;
  if (miscariNepostate.length) {
    blocaje.push(plural(miscariNepostate.length, 'mișcare de stoc necontabilizată', 'mișcări de stoc necontabilizate')
      + ' — postează notele de recepție/ieșire înainte de închidere.');
  }
  const lipsuriStoc = stocks.movementShortages(v, period);
  detalii.lipsuriStoc = lipsuriStoc;
  if (lipsuriStoc.length) {
    blocaje.push(plural(lipsuriStoc.length, 'mișcare cu stoc insuficient', 'mișcări cu stoc insuficient')
      + ': ' + lipsuriStoc.slice(0, 3).map((x) => x.denumire + ' (lipsă ' + x.lipsa + ')').join(', ')
      + (lipsuriStoc.length > 3 ? ' ș.a.' : '') + ' — înregistrează recepțiile lipsă.');
  }
  const md = rep.missingDocs(v, period);
  detalii.documenteLipsa = md.missing.length;
  detalii.countThis = md.countThis;
  detalii.avgPrev = md.avgPrev;
  if (md.missing.length) {
    blocaje.push(md.missing.length + ' furnizor(i) obișnuiți fără document în lună: '
      + md.missing.slice(0, 3).map((m) => m.partener).join(', ') + (md.missing.length > 3 ? ' ș.a.' : '') + '.');
  }
  // e-Factura: facturile lunii netrimise in SPV (termen legal 5 zile lucratoare, OUG 89/2025)
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
  const oiControl = openItems.ledgerReconciliation(v, period);
  detalii.registruDocumenteDeschise = { ok: oiControl.ok, diferenta: oiControl.difference,
    problemeAlocare: (oiControl.problems || []).length, problems: oiControl.problems || [] };
  if (!oiControl.ok) blocaje.push('Registrul documentelor deschise nu reconciliază cu soldurile conturilor de terți'
    + (oiControl.difference ? ' — diferență ' + oiControl.difference + ' lei' : '')
    + ((oiControl.problems || []).length ? ' — ' + oiControl.problems.length + ' problemă(e) de alocare document–plată' : '') + '.');
  const bankControl = bankStatements.periodControl(v, period);
  detalii.extraseBancare = { obligatoriu: bankControl.required, extrase: bankControl.statementCount,
    diferenta: bankControl.difference, articoleNelegate: bankControl.unlinkedEntries.length,
    diferenteContinuitate: bankControl.continuity.length };
  if (bankControl.required && bankControl.missingStatement) blocaje.push('Există mișcări pe 5121/5124, dar nu este importat niciun extras bancar pentru lună.');
  if (bankControl.required && bankControl.statements.some((s) => s.metadataMissing.length)) blocaje.push('Există extras bancar fără IBAN, monedă, sold inițial sau sold final.');
  if (bankControl.required && bankControl.statements.some((s) => !s.arithmeticOk)) blocaje.push('Sold inițial + mișcări nu este egal cu soldul final pentru toate extrasele lunii.');
  if (bankControl.required && bankControl.statements.some((s) => (s.integrityProblems || []).length)) blocaje.push('Există tranzacții bancare cu dată în afara extrasului, monedă diferită sau interval invalid.');
  if (bankControl.required && bankControl.statements.some((s) => s.unresolved || s.orphaned)) blocaje.push('Există tranzacții bancare propuse/punctate sau fără articol contabil dovedit.');
  if (bankControl.required && bankControl.unlinkedEntries.length) blocaje.push(bankControl.unlinkedEntries.length + ' articol(e) pe 5121/5124 nu sunt legate de o tranzacție din extras.');
  if (bankControl.required && bankControl.continuity.length) blocaje.push('Soldul final al unui extras nu coincide cu soldul inițial al următorului extras pentru același IBAN și aceeași monedă.');
  // Sold de casa negativ: imposibil fizic, deci o eroare de inregistrare (lipseste o incasare).
  const negative = acc.cashControl(v, '5311', period).negative || [];
  detalii.casaNegativa = negative.length;
  if (negative.length) blocaje.push('Soldul casei devine NEGATIV în ' + negative.length + ' moment(e) ale lunii — lipsește o încasare sau o sumă e greșită.');
  if (!miscari.length) detalii.faraMiscari = true; // semnalat ca info in UI, nu ca blocaj
  return { blocaje, detalii };
}

/** Amortizarea: daca planul lunii are sume, trebuie sa existe exact nota singleton a perioadei. */
function checkAmortizare(v, period) {
  const plan = assets.monthlyDepreciation(v.assets || [], period);
  if (!plan.lines.length) {
    return { nuSeAplica: true, motiv: 'Nu există active amortizabile în această lună.', blocaje: [],
      detalii: { active: 0, total: 0 } };
  }
  const note = acc.postedEntries(v).filter((e) => !e.stornat && e.tip === 'amortizare_lunara'
    && (e.period || periodOf(e.data)) === period);
  const blocaje = [];
  if (!note.length) blocaje.push('Amortizarea lunii nu este postată — înregistrează nota din registrul mijloacelor fixe.');
  if (note.length > 1) blocaje.push('Există ' + note.length + ' note de amortizare pentru aceeași lună — stornează dublura înainte de închidere.');
  return { blocaje, detalii: { active: plan.lines.length, total: plan.total, notePostate: note.length } };
}

/** Reevaluarea: este obligatorie numai cand exista solduri monetare in valuta la sfarsitul lunii. */
function checkReevaluare(v, period, rec, sourceHash) {
  const candidati = fxreval.candidates(v, period);
  if (!candidati.length) {
    return { nuSeAplica: true, motiv: 'Nu există solduri monetare în valută la sfârșitul lunii.',
      blocaje: [], detalii: { conturi: 0 } };
  }
  const note = acc.postedEntries(v).filter((e) => !e.stornat && e.tip === 'reevaluare_valutara'
    && (e.period || periodOf(e.data)) === period);
  const dovada = rec && rec.operationalEvidence && rec.operationalEvidence.reevaluare_valutara;
  const dovadaActuala = !!(dovada && dovada.sourceHash === sourceHash);
  const blocaje = [];
  if (!note.length && !dovadaActuala) blocaje.push('Există ' + plural(candidati.length, 'sold monetar în valută', 'solduri monetare în valută')
    + ' — reevaluează-le la cursul de închidere înainte de blocare.');
  if (note.length > 1) blocaje.push('Există ' + note.length + ' note de reevaluare pentru aceeași lună — stornează dublura.');
  return { blocaje, detalii: { conturi: candidati.length, notePostate: note.length,
    diferentaZeroConfirmata: dovadaActuala, dovada: dovadaActuala ? dovada : null,
    candidati: candidati.map((x) => ({ cont: x.cont, moneda: x.moneda })) } };
}

/** Inventarierea generala este anuala: intra explicit in fluxul lunii decembrie, nu in toate lunile. */
function checkAjustariInventar(v, period) {
  if (!String(period).endsWith('-12')) {
    return { nuSeAplica: true, motiv: 'Inventarierea generală este control anual și se verifică în decembrie.',
      blocaje: [], detalii: {} };
  }
  const year = period.slice(0, 4);
  const inventare = (v.inventories || []).filter((x) => String(x.data || '').slice(0, 4) === year);
  const valori = (v.inventarAnual || []).filter((x) => String(x.an || x.data || '').slice(0, 4) === year);
  const matrix = annualInventory.evaluate(v, year);
  const blocaje = matrix.blockers.map((x) => x.label + ': ' + x.blockers.join(' '));
  return { blocaje, detalii: { inventareFizice: inventare.length, valoriInventar: valori.length,
    domeniiComplete: matrix.progress.complete, domeniiNecesare: matrix.progress.total } };
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
    ? 'Au apărut operațiuni cu TVA după regularizare (mai sunt ' + Math.abs(rest.diff) + ' lei nerepartizați) — reia regularizarea TVA a lunii.'
    : 'Nota de regularizare TVA a lunii nu e postată — apasă „Regularizează TVA-ul lunii".');
  return { blocaje, detalii };
}

/** 4. Declaratii: fiecare asteptata trebuie depusa/scutita SI cu dovada de validare fara erori. */
function checkDeclaratii(d, v, period, rec, today, sourceHash) {
  const blocaje = []; const detalii = {};
  // Declaratiile de definitivare ANUALA nu tin blocata luna decembrie: ele se genereaza si se
  // depun dupa deschiderea fluxului anual/perioadei tehnice 13. Cockpitul anual le urmareste.
  const anuale = new Set(['d101', 'd107', 'd205', 'bilant']);
  const rows = decl.registerForFirma(d, v, period, today).filter((r) => !anuale.has(r.tip));
  const validari = (rec && rec.validari) || {};
  const lista = rows.map((r) => {
    const dovada = validari[r.tip] || null;
    const actuala = !!(dovada && dovada.sourceHash && dovada.sourceHash === sourceHash);
    return {
      tip: r.tip, nume: r.nume, due: r.due, status: r.status, overdue: r.overdue,
      dovada: dovada ? { at: dovada.at, by: dovada.by, username: dovada.username || '',
        ok: !!dovada.ok, errors: dovada.errors || 0, warnings: dovada.warnings || 0,
        contentHash: dovada.contentHash || null, actuala, invechita: !actuala } : null,
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
    else if (!r.dovada.actuala) blocaje.push(r.nume.split(' — ')[0]
      + ': dovada validării nu mai corespunde datelor curente — validează din nou.');
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
  const sourceHash = periodFingerprint(v, period);
  const profile = fiscalProfile.profileAt(v, period, { angajati: v.angajati });
  const expected = decl.expectedForFirma(v, period);
  const ancora = anchorDue(expected, period);
  const userName = (id) => {
    const u = (o.users || []).find((x) => x.id === Number(id));
    return u ? u.username : null;
  };

  const semnale = {
    documente: checkDocumente(v, period, today),
    banca: checkBanca(v, period),
    amortizare_lunara: checkAmortizare(v, period),
    reevaluare_valutara: checkReevaluare(v, period, rec, sourceHash),
    ajustari_inventar: checkAjustariInventar(v, period),
    tva: checkTva(v, period, profile),
    declaratii: checkDeclaratii(d, v, period, rec, today, sourceHash),
  };

  // Aprobarea si blocarea nu au semnal in date, ci inregistrare proprie.
  const aprobare = (rec && rec.aprobare) || null;
  const aprobareHash = approvalFingerprint(d, v, period, sourceHash);
  // Dosarele deja inchise inainte de introducerea amprentei raman documente istorice valide;
  // o aprobare VECHE pe o luna inca deschisa trebuie insa refacuta pe continutul curent.
  const aprobareLegacyFinala = !!(aprobare && !aprobare.contentHash && rec && rec.closedAt);
  const aprobareValida = !!(aprobare && (aprobareLegacyFinala || aprobare.contentHash === aprobareHash));
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
      stare = aprobareValida ? 'gata' : 'deschis';
      if (!aprobare) blocaje = ['Luna nu e aprobată încă.'];
      else if (!aprobareValida) blocaje = ['Datele s-au schimbat după aprobare — luna trebuie reaprobată.'];
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
    // `inchisa` poate proveni si din blocarea administrativa explicita; `finalizata` inseamna ca
    // luna a trecut prin dosarul cockpitului (aprobare + ultima actiune de blocare).
    finalizata: !!(blocata && rec && rec.closedAt),
    inchidere: (rec && rec.closedAt) ? { at: rec.closedAt, by: rec.closedBy, username: rec.closedByName || userName(rec.closedBy) || '' } : null,
    lockedUntil: lockedUntil || null,
    aprobare: aprobare ? Object.assign({}, aprobare, {
      responsabil: userName(aprobare.by) || aprobare.username || null,
      valida: aprobareValida, invechita: !aprobareValida, legacyFinala: aprobareLegacyFinala,
    }) : null,
    aprobareValida,
    fortata: (rec && rec.fortata) || null,
    ancoraTermen: ancora,
  };
}

module.exports = {
  STEPS, STEP_KEYS, status, findRecord, anchorDue, shiftDays, DEFAULT_OFFSET_DAYS,
  periodFingerprint, approvalFingerprint,
};
