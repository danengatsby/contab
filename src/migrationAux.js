'use strict';

// Migrarea auxiliara completa: parteneri + mijloace fixe + stoc initial. Modulul este PUR pana
// la `apply`: parseaza si valideaza toate fisierele inainte ca ruta sa atinga graful. Asta este
// diferenta dintre „trei importuri unul dupa altul” si o preluare atomica: o eroare in ultimul
// fisier nu lasa primele doua jumatati scrise.

const { parseCsv, isHeaderRow } = require('./csv');
const migrare = require('./migrare');
const coa = require('./chartOfAccounts');
const assets = require('./assets');
const { round2 } = require('./util');

const METHODS = new Set(assets.METHODS);
const CUI_OK = /^[A-Z]{0,3}\d{2,12}$/i;
const yes = (v) => /^(1|da|yes|true|x)$/i.test(String(v || '').trim());

function validDate(value) {
  const s = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function rowsOf(csv, extraHeader) {
  const rows = parseCsv(csv || '');
  const first = String((rows[0] && rows[0][0]) || '').trim();
  return { rows, start: rows.length && (isHeaderRow(rows[0]) || (extraHeader && extraHeader.test(first))) ? 1 : 0 };
}

function amountRoles(rows, start, indexes, forced) {
  if (forced && (forced['.'] || forced[','])) return forced;
  const tokens = [];
  for (let i = start; i < rows.length; i += 1) for (const idx of indexes) if (rows[i][idx] != null) tokens.push(rows[i][idx]);
  return migrare.sepConvention(tokens);
}

function amount(raw, roles, label, line, errors, opts) {
  const p = migrare.parseAmount(raw, roles);
  if (p.ambiguous) errors.push('rand ' + line + ': suma ambigua la ' + label + ' („' + String(raw).slice(0, 24) + '")');
  const n = round2(p.value);
  if (!Number.isFinite(n) || ((opts && opts.positive) && n <= 0) || (!(opts && opts.allowNegative) && n < 0)) {
    errors.push('rand ' + line + ': valoare invalida la ' + label);
  }
  return n;
}

/** CUI;Denumire;Adresa;Oras;Judet;Tara;Tip;IBAN;BIC */
function parsePartners(csv) {
  if (!String(csv || '').trim()) return { present: false, items: [], errors: [] };
  const { rows, start } = rowsOf(csv); const items = []; const errors = []; const seen = new Set();
  for (let i = start; i < rows.length; i += 1) {
    const r = rows[i]; const line = i + 1;
    const cui = String(r[0] || '').toUpperCase().replace(/^RO/, '').replace(/\s/g, '');
    const den = String(r[1] || '').trim();
    if (!CUI_OK.test(cui)) { errors.push('rand ' + line + ': CUI invalid'); continue; }
    if (!den) { errors.push('rand ' + line + ': denumire lipsa pentru ' + cui); continue; }
    if (seen.has(cui)) { errors.push('rand ' + line + ': CUI duplicat (' + cui + ')'); continue; }
    seen.add(cui);
    items.push({ cui, den: den.slice(0, 160), adresa: String(r[2] || '').slice(0, 240),
      oras: String(r[3] || '').slice(0, 100), judet: String(r[4] || '').slice(0, 60),
      tara: String(r[5] || 'RO').toUpperCase().slice(0, 3), tip: String(r[6] || '').toLowerCase().slice(0, 20),
      iban: String(r[7] || '').replace(/\s/g, '').toUpperCase().slice(0, 34), bic: String(r[8] || '').trim().toUpperCase().slice(0, 11) });
  }
  if (!items.length && !errors.length) errors.push('fisierul de parteneri nu contine randuri');
  return { present: true, items, errors };
}

/** NrInventar;Denumire;Cont;Cost;DataPIF;DurataLuni;Metoda;ValReziduala;Furnizor;CUI;
 *  DataAchizitie;MetodaFiscala;DurataFiscalaLuni;Computer;VehiculM1 */
function parseAssets(csv, forcedRoles) {
  if (!String(csv || '').trim()) return { present: false, items: [], errors: [] };
  // Exporturile reale folosesc atat „Nr inventar", cat si „NrInventar". Al doilea nu intra in
  // detectorul CSV generic (care cere un cuvant intreg), deci il recunoastem explicit aici.
  const { rows, start } = rowsOf(csv, /^nr\s*inventar$/i); const items = []; const errors = []; const seen = new Set();
  const roles = amountRoles(rows, start, [3, 7], forcedRoles);
  for (let i = start; i < rows.length; i += 1) {
    const r = rows[i]; const line = i + 1;
    const numarInventar = String(r[0] || '').trim().slice(0, 60);
    const denumire = String(r[1] || '').trim().slice(0, 180); const cont = String(r[2] || '').trim();
    const cost = amount(r[3], roles, 'cost', line, errors, { positive: true });
    const dataPif = String(r[4] || '').slice(0, 10); const durataLuni = Math.round(Number(r[5]) || 0);
    const metoda = String(r[6] || 'liniara').toLowerCase().trim();
    const valoareReziduala = r[7] ? amount(r[7], roles, 'valoare reziduala', line, errors) : 0;
    const computer = yes(r[13]); const vehiculM1 = yes(r[14]);
    if (!numarInventar) errors.push('rand ' + line + ': numar de inventar lipsa');
    else if (seen.has(numarInventar.toLowerCase())) errors.push('rand ' + line + ': numar de inventar duplicat (' + numarInventar + ')');
    else seen.add(numarInventar.toLowerCase());
    if (!denumire) errors.push('rand ' + line + ': denumire mijloc fix lipsa');
    if (!coa.getAccount(cont)) errors.push('rand ' + line + ': cont inexistent (' + cont + ')');
    else {
      const amortizabil = assets.esteAmortizabil(cont);
      if (!amortizabil.ok) errors.push('rand ' + line + ': ' + amortizabil.motiv);
      else if (!assets.contAmortizareValid(cont)) errors.push('rand ' + line + ': contul de amortizare lipseste pentru ' + cont);
    }
    if (!validDate(dataPif)) errors.push('rand ' + line + ': data punerii in functiune invalida');
    if (durataLuni <= 0 || durataLuni > 1200) errors.push('rand ' + line + ': durata invalida');
    if (!METHODS.has(metoda)) errors.push('rand ' + line + ': metoda invalida (' + metoda + ')');
    else {
      const motiv = assets.motivMetodaNepermisa(cont, metoda, { computer });
      if (motiv) errors.push('rand ' + line + ': ' + motiv);
    }
    if (valoareReziduala >= cost && cost > 0) errors.push('rand ' + line + ': valoarea reziduala trebuie sa fie sub cost');
    const metodaFiscala = String(r[11] || '').toLowerCase().trim();
    if (metodaFiscala && !METHODS.has(metodaFiscala)) errors.push('rand ' + line + ': metoda fiscala invalida');
    if (metodaFiscala && METHODS.has(metodaFiscala)) {
      const motiv = assets.motivMetodaNepermisa(cont, metodaFiscala, { computer });
      if (motiv) errors.push('rand ' + line + ': metoda fiscala: ' + motiv);
    }
    const durataFiscalaLuni = Math.round(Number(r[12]) || 0);
    if (r[12] && (durataFiscalaLuni <= 0 || durataFiscalaLuni > 1200)) errors.push('rand ' + line + ': durata fiscala invalida');
    if (r[10] && !validDate(r[10])) errors.push('rand ' + line + ': data achizitiei invalida');
    const cui = String(r[9] || '').toUpperCase().replace(/^RO/, '').replace(/\s/g, '').slice(0, 20);
    if (cui && !CUI_OK.test(cui)) errors.push('rand ' + line + ': CUI furnizor invalid');
    items.push({ numarInventar, denumire, cont, cost, valoareReziduala,
      dataAchizitie: validDate(r[10]) ? String(r[10]).slice(0, 10) : dataPif, dataPif, durataLuni, metoda,
      furnizor: String(r[8] || '').slice(0, 160), cui,
      ...(metodaFiscala && metodaFiscala !== metoda ? { metodaFiscala } : {}),
      ...(durataFiscalaLuni && durataFiscalaLuni !== durataLuni ? { durataFiscalaLuni } : {}),
      ...(computer ? { computer: true } : {}), ...(vehiculM1 ? { vehiculM1: true } : {}) });
  }
  if (!items.length && !errors.length) errors.push('fisierul de mijloace fixe nu contine randuri');
  return { present: true, items, errors };
}

/** Cod;Denumire;UM;Cont;Gestiune;Cantitate;PretUnitar;Valoare */
function parseStock(csv, forcedRoles) {
  if (!String(csv || '').trim()) return { present: false, items: [], errors: [] };
  const { rows, start } = rowsOf(csv); const items = []; const errors = [];
  const roles = amountRoles(rows, start, [5, 6, 7], forcedRoles); const positions = new Map(); const products = new Map();
  for (let i = start; i < rows.length; i += 1) {
    const r = rows[i]; const line = i + 1; const cod = String(r[0] || '').trim().slice(0, 80);
    const denumire = String(r[1] || '').trim().slice(0, 180); const cont = String(r[3] || '371').trim();
    const gestiune = String(r[4] || '').trim().slice(0, 60);
    if (!cod) { errors.push('rand ' + line + ': cod produs lipsa'); continue; }
    if (!denumire) errors.push('rand ' + line + ': denumire lipsa pentru ' + cod);
    if (!coa.getAccount(cont) || !/^3/.test(cont)) errors.push('rand ' + line + ': cont de stoc invalid (' + cont + ')');
    const cantitate = amount(r[5], roles, 'cantitate', line, errors, { positive: true });
    const valoare = r[7] ? amount(r[7], roles, 'valoare', line, errors, { positive: true }) : 0;
    const pret = r[6] ? amount(r[6], roles, 'pret unitar', line, errors, { positive: true }) : 0;
    const val = valoare > 0 ? valoare : round2(cantitate * pret);
    if (val <= 0) errors.push('rand ' + line + ': pretul sau valoarea lipseste pentru ' + cod);
    const pkey = cod.toLowerCase(); const prevP = products.get(pkey);
    if (prevP && (prevP.denumire !== denumire || prevP.cont !== cont || prevP.um !== String(r[2] || 'buc'))) {
      errors.push('rand ' + line + ': produsul ' + cod + ' are date contradictorii');
    } else if (!prevP) products.set(pkey, { denumire, cont, um: String(r[2] || 'buc').slice(0, 20) });
    const key = pkey + '|' + gestiune.toLowerCase();
    const prev = positions.get(key);
    if (prev) { prev.cantitate = round2(prev.cantitate + cantitate); prev.valoare = round2(prev.valoare + val); }
    else { const rec = { cod, denumire, um: String(r[2] || 'buc').slice(0, 20), cont, gestiune, cantitate, valoare: val }; positions.set(key, rec); items.push(rec); }
  }
  for (const x of items) x.pretUnitar = x.cantitate > 0 ? round2(x.valoare / x.cantitate) : 0;
  if (!items.length && !errors.length) errors.push('fisierul de stoc nu contine randuri');
  return { present: true, items, errors };
}

function openingMap(conturi) {
  const out = {}; const errors = [];
  for (const x of conturi || []) {
    const cont = String(x.cont || '').trim().replace(/\s/g, '');
    if (!cont || !/^\d/.test(cont)) { errors.push('cont invalid in balanta (' + String(x.cont || '').slice(0, 20) + ')'); continue; }
    const d = round2(Number(x.d) || 0); const c = round2(Number(x.c) || 0);
    if (d < 0 || c < 0) errors.push('sold negativ la contul ' + cont);
    const prev = out[cont] || { d: 0, c: 0 };
    out[cont] = { d: round2(prev.d + d), c: round2(prev.c + c) };
  }
  const totalD = round2(Object.values(out).reduce((s, x) => s + x.d, 0));
  const totalC = round2(Object.values(out).reduce((s, x) => s + x.c, 0));
  if (Math.abs(totalD - totalC) >= 0.005) errors.push('balanta este dezechilibrata: debit ' + totalD + ', credit ' + totalC);
  return { map: out, totalD, totalC, errors };
}

function prepare(payload, opts) {
  const p = payload || {};
  const forcedRoles = p.zecimal === ',' ? { ',': 'zecimale', '.': 'mii' }
    : (p.zecimal === '.' ? { '.': 'zecimale', ',': 'mii' } : null);
  const partners = parsePartners(p.parteneriCsv); const fixedAssets = parseAssets(p.activeCsv, forcedRoles);
  const stock = parseStock(p.stocCsv, forcedRoles); const hasOpening = Array.isArray(p.conturi) && p.conturi.length > 0;
  const opening = openingMap(hasOpening ? p.conturi : []);
  const problems = [...partners.errors, ...fixedAssets.errors, ...stock.errors, ...(hasOpening ? opening.errors : [])];
  const compareOpening = hasOpening ? opening.map : ((opts && opts.existingOpening) || {});
  if (stock.present) {
    const totals = {};
    for (const x of stock.items) totals[x.cont] = round2((totals[x.cont] || 0) + x.valoare);
    // Reconcilierea este pe UNIUNEA conturilor. Altfel un sold 301 fara nicio materie prima in
    // fisier ar fi omis din control si pachetul ar parea complet desi stocul cantitativ lipseste.
    const accounts = new Set(Object.keys(totals));
    for (const [cont, solduri] of Object.entries(compareOpening)) {
      const sold = round2((Number(solduri.d) || 0) - (Number(solduri.c) || 0));
      if (/^3/.test(cont) && Math.abs(sold) >= 0.01) accounts.add(cont);
    }
    for (const cont of accounts) {
      const value = round2(totals[cont] || 0);
      const ob = compareOpening[cont] || { d: 0, c: 0 }; const sold = round2((Number(ob.d) || 0) - (Number(ob.c) || 0));
      if (Math.abs(value - sold) >= 0.01) problems.push('stocul din contul ' + cont + ' este ' + value + ' lei, dar soldul initial este ' + sold + ' lei');
    }
  }
  const present = hasOpening || partners.present || fixedAssets.present || stock.present;
  if (!present) problems.push('Nu ai selectat nicio componenta de migrat.');
  if (stock.present && !validDate(p.data)) problems.push('Data preluarii stocului este invalida.');
  return {
    ok: problems.length === 0, problems, hasOpening, opening, partners, fixedAssets, stock,
    data: String(p.data || '').slice(0, 10),
    summary: { conturi: Object.keys(opening.map).length, parteneri: partners.items.length,
      active: fixedAssets.items.length, pozitiiStoc: stock.items.length,
      valoareStoc: round2(stock.items.reduce((s, x) => s + x.valoare, 0)) },
  };
}

/** Aplica un rezultat DEJA validat pe copii locale, apoi schimba graful dintr-o singura bucata. */
function apply(d, fid, prepared, operator) {
  let seq = Number(d.seq) || 1; const nextId = (prefix) => String(prefix || '') + seq++;
  const out = prepared.summary;
  if (prepared.hasOpening) d.openingBalances[fid] = prepared.opening.map;
  if (prepared.partners.present) {
    const map = {};
    for (const x of prepared.partners.items) map[x.cui] = Object.assign({}, x);
    d.partners[fid] = map;
  }
  if (prepared.fixedAssets.present) {
    const other = (d.assets || []).filter((x) => x.firmaId !== fid);
    d.assets = other.concat(prepared.fixedAssets.items.map((x) => Object.assign({ id: nextId('mf'), firmaId: fid, status: 'activ' }, x)));
  }
  if (prepared.stock.present) {
    d.products = (d.products || []).filter((x) => x.firmaId !== fid);
    d.gestiuni = (d.gestiuni || []).filter((x) => x.firmaId !== fid);
    d.stockMovements = (d.stockMovements || []).filter((x) => x.firmaId !== fid);
    const products = new Map(); const gestiuni = new Map();
    for (const x of prepared.stock.items) {
      const pk = x.cod.toLowerCase();
      if (!products.has(pk)) {
        products.set(pk, { id: nextId('prod'), firmaId: fid, cod: x.cod, denumire: x.denumire,
          um: x.um || 'buc', grupa: '', cont: x.cont, codNC: '', activ: true });
      }
      const gk = x.gestiune.toLowerCase();
      if (x.gestiune && !gestiuni.has(gk)) gestiuni.set(gk, { id: nextId('gest'), firmaId: fid,
        cod: x.gestiune, denumire: x.gestiune, gestionar: '', cont: x.cont });
    }
    d.products.push(...products.values()); d.gestiuni.push(...gestiuni.values());
    for (const x of prepared.stock.items) d.stockMovements.push({ id: nextId('sm'), firmaId: fid,
      data: prepared.data, tip: 'receptie', initial: true, productId: products.get(x.cod.toLowerCase()).id,
      gestiuneId: x.gestiune ? gestiuni.get(x.gestiune.toLowerCase()).id : null, gestiuneDestId: null,
      cantitate: x.cantitate, pretUnitar: x.pretUnitar, document: 'Stoc initial (migrare completa)',
      furnizor: '', operator: operator || '' });
  }
  d.seq = seq;
  return out;
}

module.exports = { validDate, parsePartners, parseAssets, parseStock, openingMap, prepare, apply };
