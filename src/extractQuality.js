'use strict';

// CONTROLUL CALITATII EXTRAGERII — bateria de verificari deterministe aplicata unui document citit
// automat. Modulul nu autorizeaza automatizarea; politica separata din extractRiskPolicy decide.
//
// De ce o baterie explicita si nu doar „increderea" raportata de model: increderea e o parere a
// extractorului despre sine. Ea nu stie daca partenerul exista in nomenclator, daca documentul e
// deja inregistrat, daca data cade intr-o luna inchisa sau daca sumele se aduna. Fiecare control
// de aici e o intrebare VERIFICABILA pe datele firmei, cu raspuns da/nu si un motiv in cuvinte.
//
// Regula produsului, deliberat asimetrica: orice control determinist BLOCANT picat obliga politica
// de risc sa se abtina. Chiar daca toate trec, automatizarea nu este autorizata pana cand
// extractorul nu este calibrat separat pe rezultate reale revizuite.
//
// Scorurile (cel tehnic si cel auto-raportat de AI) NU decid nimic. Scorul AI este semnal
// informativ si cheie de calibrare, niciodata dovada fiscala sau control blocant.

const { round2, period: periodOf } = require('./util');
const extractCheck = require('./extractCheck');

// Fiecare control: greutatea conteaza DOAR in scor. `blocant` decide postarea automata.
const CONTROALE = [
  { cod: 'sursa', nume: 'Sursa extragerii (informativ)', greutate: 10, blocant: false },
  { cod: 'incredere', nume: 'Încredere AI (informativ)', greutate: 15, blocant: false },
  { cod: 'aritmetica', nume: 'Bază + TVA = total', greutate: 20, blocant: true },
  { cod: 'cota', nume: 'Cotă TVA validă', greutate: 10, blocant: true },
  { cod: 'data', nume: 'Dată utilizabilă', greutate: 10, blocant: true },
  { cod: 'document', nume: 'Număr de document', greutate: 5, blocant: true },
  { cod: 'partener', nume: 'Partener cunoscut', greutate: 10, blocant: true },
  { cod: 'tip', nume: 'Tip de document determinat', greutate: 10, blocant: true },
  { cod: 'duplicat', nume: 'Fără duplicat', greutate: 10, blocant: true },
];
const COD_CONTROALE = CONTROALE.map((c) => c.cod);

// Prag exclusiv DIAGNOSTIC. Poate produce un avertisment, dar nu poate autoriza sau opri singur
// automatizarea; extractRiskPolicy foloseste performanta observata a benzii, nu acest numar.
const MIN_INCREDERE = 85;

function num(x) { return x == null || x === '' ? null : Number(x); }
function areValoare(x) { return x != null && x !== '' && Number.isFinite(Number(x)); }
// Numarul documentului, normalizat AGRESIV pentru cautarea de duplicate: „F-900", „F 900" si
// „f/900" sunt acelasi document scris altfel. Consecinta unei potriviri e doar REVIZUIREA
// (nu respingerea), deci pragul de suspiciune poate fi generos.
function normDoc(s) { return String(s == null ? '' : s).replace(/[^a-z0-9]/gi, '').toUpperCase(); }
function normCui(s) { return String(s == null ? '' : s).replace(/^ro/i, '').replace(/\D/g, ''); }

/**
 * Documentul e deja inregistrat? Compara (partener SAU CUI) + numarul documentului, iar la egalitate
 * si suma. Duplicatele sunt cazul cel mai scump al postarii automate: o factura inregistrata de doua
 * ori umfla cheltuiala si TVA-ul deductibil, si se descopera tarziu, la reconciliere.
 */
function gasesteDuplicat(v, fields, _tip) {
  const doc = normDoc(fields.document);
  if (!doc) return null;
  const cui = normCui(fields.cuiPartener || fields.cui);
  const partener = String(fields.partener || '').trim().toUpperCase();
  for (const e of (v.entries || [])) {
    if (normDoc(e.document) !== doc) continue;
    const eCui = normCui(e.partenerCui);
    const ePart = String(e.partener || '').trim().toUpperCase();
    const acelasiPartener = (cui && eCui && cui === eCui) || (partener && ePart && partener === ePart);
    if (!acelasiPartener) continue;
    // acelasi document, acelasi partener: duplicat, indiferent de tip (o factura nu se re-inregistreaza)
    return { id: e.id, data: e.data, tip: e.tip, document: e.document };
  }
  return null;
}

/**
 * Ruleaza bateria de controale.
 * @param {Object} extras - { fields, suggestedType, source: 'ai'|'heuristic', incredere, fileName }
 * @param {Object} ctx    - { v (vedere scoped), firma, azi, minIncredere }
 * @returns { scor, verdictDeterminist: 'trecut'|'respins', controale:[...], motive:[...] }
 */
function evalueaza(extras, ctx) {
  const e = extras || {};
  const c = ctx || {};
  const v = c.v || { entries: [], partners: {} };
  const firma = c.firma || {};
  const azi = c.azi || new Date().toISOString().slice(0, 10);
  const minIncredere = c.minIncredere != null ? Number(c.minIncredere) : MIN_INCREDERE;
  const f = e.fields || {};
  const rez = {};
  const pune = (cod, ok, motiv) => { rez[cod] = { ok: !!ok, motiv: ok ? null : motiv }; };

  // 1) SURSA este diagnostic aici. Politica separata decide daca o sursa are voie sa pregateasca
  //    o ciorna; in versiunea curenta, regulile locale raman intotdeauna la revizuire.
  pune('sursa', e.source === 'ai', e.source === 'heuristic'
    ? 'Citit cu reguli locale (fără AI) — precizia e mai mică pe formate necunoscute.'
    : 'Sursa extragerii e necunoscută.');

  // 2) INCREDEREA raportata de extractor (doar calea AI o produce).
  if (e.source !== 'ai') pune('incredere', false, 'Fără scor de încredere (extragere fără AI).');
  else if (!areValoare(e.incredere)) pune('incredere', false, 'Extractorul nu a raportat un scor de încredere.');
  else pune('incredere', Number(e.incredere) >= minIncredere,
    'Încredere ' + Math.round(Number(e.incredere)) + '% sub pragul diagnostic de ' + minIncredere
      + '%. Numărul nu autorizează automatizarea.');

  // 3) ARITMETICA + 4) COTA — reconcilierea existenta e sursa unica a acestor doua verdicte.
  const chk = extractCheck.reconcile(f, { incredere: e.incredere, standardCota: c.standardCota, minConfidence: minIncredere });
  const avSume = (chk.warnings || []).filter((w) => /nu se potrivesc|Sumele/i.test(w));
  const avCota = (chk.warnings || []).filter((w) => /cot[ăa]/i.test(w));
  pune('aritmetica', avSume.length === 0, avSume[0] || 'Sumele nu se verifică.');
  const cota = num(chk.fields.cota);
  const areTva = areValoare(chk.fields.tva) && Number(chk.fields.tva) > 0;
  if (avCota.length) pune('cota', false, avCota[0]);
  else if (areTva && !(cota > 0)) pune('cota', false, 'Documentul are TVA, dar cota lipsește.');
  else pune('cota', true);

  // 5) DATA: prezenta, valida, nu in viitor, nu intr-o perioada inchisa (ar fi respinsa oricum).
  const data = String(f.data || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) pune('data', false, 'Data documentului lipsește sau nu e o dată validă.');
  else if (data > azi) pune('data', false, 'Data documentului (' + data + ') e în viitor.');
  else if (firma.lockedUntil && periodOf(data) <= firma.lockedUntil) {
    pune('data', false, 'Data cade în perioada închisă (' + periodOf(data) + ' ≤ ' + firma.lockedUntil + ').');
  } else pune('data', true);

  // 6) NUMARUL documentului — fara el nu se poate detecta duplicatul si nu e trasabil.
  pune('document', !!String(f.document || '').trim(), 'Numărul documentului lipsește.');

  // 7) PARTENER CUNOSCUT. Un furnizor deja in nomenclator inseamna un format vazut si acceptat
  //    inainte; unul nou e exact cazul in care extragerea greseste mai des.
  const cui = normCui(f.cuiPartener || f.cui);
  const parteneri = v.partners || {};
  const cunoscut = cui ? Object.keys(parteneri).some((k) => normCui(k) === cui) : false;
  if (!String(f.partener || '').trim()) pune('partener', false, 'Partenerul nu a fost identificat.');
  else if (!cui) pune('partener', false, 'Partenerul „' + f.partener + '" nu are CUI extras.');
  else if (!cunoscut) pune('partener', false, 'Partenerul „' + f.partener + '" (CUI ' + cui + ') e nou — prima înregistrare se verifică.');
  else pune('partener', true);

  // 8) TIPUL: `nota_contabila` e valoarea de rezerva a extractorului — nu o incadrare.
  const tip = String(e.suggestedType || '');
  pune('tip', !!tip && tip !== 'nota_contabila',
    tip === 'nota_contabila' ? 'Tipul documentului nu a putut fi determinat (a rămas nota contabilă).' : 'Tipul documentului lipsește.');

  // 9) DUPLICAT.
  const dup = gasesteDuplicat(v, Object.assign({}, f, { cuiPartener: f.cuiPartener || f.cui }), tip);
  pune('duplicat', !dup, dup ? 'Documentul „' + dup.document + '" e deja înregistrat (' + dup.id + ', ' + dup.data + ').' : null);

  const controale = CONTROALE.map((def) => Object.assign({ cod: def.cod, nume: def.nume, blocant: def.blocant }, rez[def.cod] || { ok: false, motiv: 'necontrolat' }));
  const total = CONTROALE.reduce((s, x) => s + x.greutate, 0);
  const castigat = CONTROALE.reduce((s, x) => s + ((rez[x.cod] || {}).ok ? x.greutate : 0), 0);
  const picate = controale.filter((x) => !x.ok && x.blocant);
  return {
    scor: Math.round((castigat / total) * 100),
    verdictDeterminist: picate.length === 0 ? 'trecut' : 'respins',
    controale,
    motive: picate.map((x) => x.motiv).filter(Boolean),
    fields: chk.fields,          // campurile dupa completarea golurilor derivabile
    avertismente: chk.warnings,  // avertismentele aritmetice, pentru formular
  };
}

// ── Ce a schimbat operatorul fata de ce s-a extras ──
// Campurile comparate: cele care descriu documentul. `stoc`/`items` sunt structuri de lucru
// (linii de descarcare), nu date citite din document — o diferenta acolo nu spune nimic despre
// calitatea extragerii.
const CAMPURI_COMPARATE = ['data', 'document', 'partener', 'cuiPartener', 'baza', 'tva', 'cota', 'suma', 'brut'];

function egale(a, b) {
  if (a == null || a === '') return b == null || b === '';
  if (typeof a === 'number' || typeof b === 'number' || (!Number.isNaN(Number(a)) && !Number.isNaN(Number(b)) && String(a).trim() !== '' && String(b).trim() !== '')) {
    return round2(Number(a)) === round2(Number(b));
  }
  return String(a).trim() === String(b).trim();
}

/**
 * Diferenta dintre ce a extras masina si ce a salvat omul.
 * @returns { campuri:[{camp, extras, salvat}], tipSchimbat:boolean, nrModificari }
 */
function diferente(extras, salvat, tipExtras, tipSalvat) {
  const a = extras || {}; const b = salvat || {};
  const campuri = [];
  for (const k of CAMPURI_COMPARATE) {
    if (!(k in a) && !(k in b)) continue;
    if (!egale(a[k], b[k])) campuri.push({ camp: k, extras: a[k] == null ? '' : a[k], salvat: b[k] == null ? '' : b[k] });
  }
  const tipSchimbat = !!tipExtras && !!tipSalvat && tipExtras !== tipSalvat;
  return { campuri, tipSchimbat, nrModificari: campuri.length + (tipSchimbat ? 1 : 0) };
}

/** Extensia fisierului, normalizata — „formatul" din raportul pe furnizori/formate. */
function formatFisier(fileName) {
  const m = String(fileName || '').match(/\.([a-z0-9]{1,6})$/i);
  return m ? m[1].toLowerCase() : 'necunoscut';
}

/**
 * Agregarea interventiilor: care furnizori si care formate produc erori, si care control pica.
 * Intoarce liste sortate descrescator dupa numarul de interventii — asta e intrebarea operationala
 * („pe cine merita sa-l repari"), nu o medie generala.
 */
function raport(interventii) {
  const list = interventii || [];
  // `implicit` = eticheta pentru grupa fara valoare. Nu e mereu „—": la model, lipsa INSEAMNA
  // ceva anume (documentul a fost citit cu reguli locale), iar o liniuta ar ascunde exact asta.
  const grupeaza = (cheie, implicit) => {
    const m = new Map();
    for (const i of list) {
      const k = cheie(i) || implicit || '—';
      const g = m.get(k) || { cheie: k, interventii: 0, documente: 0, campuri: 0, controale: {} };
      g.interventii += 1;
      g.documente += 1;
      g.campuri += (i.diff && i.diff.nrModificari) || 0;
      for (const c of (i.controalePicate || [])) g.controale[c] = (g.controale[c] || 0) + 1;
      m.set(k, g);
    }
    return [...m.values()]
      .map((g) => Object.assign(g, { controaleTop: Object.entries(g.controale).sort((a, b) => b[1] - a[1]).map(([cod, n]) => ({ cod, n })) }))
      .sort((a, b) => b.interventii - a.interventii || String(a.cheie).localeCompare(String(b.cheie)));
  };
  const peControl = {};
  for (const i of list) for (const c of (i.controalePicate || [])) peControl[c] = (peControl[c] || 0) + 1;
  const peCamp = {};
  for (const i of list) for (const c of ((i.diff || {}).campuri || [])) peCamp[c.camp] = (peCamp[c.camp] || 0) + 1;
  return {
    total: list.length,
    furnizori: grupeaza((i) => i.partener),
    formate: grupeaza((i) => i.format),
    surse: grupeaza((i) => i.source),
    // Corectiile taiate pe EXTRACTORUL care a citit documentul — semnalul de calitate cel mai
    // direct: „de cand am schimbat modelul, se corecteaza mai des?". Numele NU e `modele`: ruta
    // pune acolo defalcarea documentelor CITITE, iar `Object.assign` peste raport ar fi
    // suprascris-o tacit pe una dintre ele.
    corectiiPeModel: grupeaza((i) => i.model, 'reguli locale'),
    peControl: Object.entries(peControl).sort((a, b) => b[1] - a[1]).map(([cod, n]) => ({ cod, nume: (CONTROALE.find((x) => x.cod === cod) || {}).nume || cod, n })),
    peCamp: Object.entries(peCamp).sort((a, b) => b[1] - a[1]).map(([camp, n]) => ({ camp, n })),
  };
}

module.exports = { CONTROALE, COD_CONTROALE, MIN_INCREDERE, evalueaza, diferente, formatFisier, raport, gasesteDuplicat, CAMPURI_COMPARATE };
