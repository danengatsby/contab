'use strict';

// Service layer pentru stocuri: nomenclatoare (produse/gestiuni), miscari de stoc, postarea
// notei contabile pe miscare, preluarea stocului initial, inventarierea si stornarea ei.
// Rutele (src/routes/stocks.js) raman puncte de intrare subtiri: parseaza cererea, apeleaza
// serviciul si traduc erorile (`err.status`) in raspunsuri HTTP.
//
// Autorizare DUBLATA la nivel de serviciu: fiecare functie de scriere trece prin reqFirma()
// si cauta resursele DOAR in interiorul firmei date — un apelant viitor care ar trece un id
// strain sau o firma invalida primeste 403/404, nu acces la datele altcuiva.

const db = require('./db');
const { round2 } = require('./util');
const { parseCsv } = require('./csv');
const { parseRoNumber } = require('./extractor');
const stocks = require('./stocks');
const fiscal = require('./fiscal');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/** Garda de autorizare: firma trebuie sa fie explicita si sa existe. Fara ea, db.scoped()
 *  ar cadea pe firmaActiva globala la un fid invalid — adica pe datele altcuiva. */
function reqFirma(fid) {
  const id = Number(fid);
  if (!Number.isInteger(id) || id <= 0 || !db.getFirma(id)) fail(403, 'Firma activa invalida sau inexistenta.');
  return id;
}

// ── Nomenclator produse ──

function upsertProduct(fid, b) {
  fid = reqFirma(fid); b = b || {};
  if (!b.cod || !b.denumire) fail(400, 'Completeaza codul si denumirea produsului.');
  const d = db.get();
  const existing = (d.products || []).find((p) => p.firmaId === fid && p.cod === b.cod);
  if (existing) {
    Object.assign(existing, { denumire: b.denumire, um: b.um || existing.um, grupa: b.grupa || '', cont: b.cont || existing.cont, codNC: b.codNC || '' });
    db.save();
    return { product: existing, created: false };
  }
  const p = { id: db.nextId('prod'), firmaId: fid, cod: String(b.cod), denumire: String(b.denumire), um: b.um || 'buc', grupa: b.grupa || '', cont: b.cont || '371', codNC: b.codNC || '' };
  d.products.push(p);
  db.save();
  return { product: p, created: true };
}

/** Import produse din CSV: Cod;Denumire;UM;Cont;Grupa;CodNC (header optional). */
function importProducts(fid, csv) {
  fid = reqFirma(fid);
  const rows = parseCsv(csv || '');
  if (!rows.length) fail(400, 'CSV gol sau invalid.');
  let start = 0;
  if (/cod|denumire/i.test((rows[0][0] || '') + (rows[0][1] || ''))) start = 1;
  const d = db.get();
  let importati = 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const cod = String(r[0] || '').trim();
    if (!cod || !r[1]) continue;
    const existing = (d.products || []).find((p) => p.firmaId === fid && p.cod === cod);
    const rec = existing || { id: db.nextId('prod'), firmaId: fid, cod };
    Object.assign(rec, { denumire: r[1], um: r[2] || 'buc', cont: r[3] || '371', grupa: r[4] || '', codNC: r[5] || '' });
    if (!existing) d.products.push(rec);
    importati += 1;
  }
  db.save();
  return { importati };
}

function deleteProduct(fid, id) {
  fid = reqFirma(fid);
  const d = db.get();
  const p = (d.products || []).find((x) => x.id === id && x.firmaId === fid);
  if (!p) fail(404, 'Produs inexistent.'); // izolare multi-firma
  d.products = (d.products || []).filter((x) => x !== p);
  d.stockMovements = (d.stockMovements || []).filter((m) => m.productId !== p.id);
  db.save();
}

// ── Gestiuni (depozite) ──

function upsertGestiune(fid, b) {
  fid = reqFirma(fid); b = b || {};
  if (!b.cod || !b.denumire) fail(400, 'Completeaza codul si denumirea gestiunii.');
  const d = db.get();
  const existing = (d.gestiuni || []).find((g) => g.firmaId === fid && g.cod === b.cod);
  if (existing) {
    Object.assign(existing, { denumire: b.denumire, gestionar: b.gestionar || '', cont: b.cont || existing.cont });
    db.save();
    return { gestiune: existing, created: false };
  }
  const g = { id: db.nextId('gest'), firmaId: fid, cod: String(b.cod), denumire: String(b.denumire), gestionar: b.gestionar || '', cont: b.cont || '371' };
  d.gestiuni.push(g);
  db.save();
  return { gestiune: g, created: true };
}

function deleteGestiune(fid, id) {
  fid = reqFirma(fid);
  const d = db.get();
  const g = (d.gestiuni || []).find((x) => x.id === id && x.firmaId === fid);
  if (!g) fail(404, 'Gestiune inexistenta.'); // izolare multi-firma
  if ((d.stockMovements || []).some((m) => m.firmaId === fid && (m.gestiuneId === g.id || m.gestiuneDestId === g.id))) {
    fail(400, 'Gestiunea are miscari de stoc — sterge-le intai.');
  }
  d.gestiuni = (d.gestiuni || []).filter((x) => x !== g);
  db.save();
}

// ── Miscari de stoc ──

function addMovement(fid, operator, b) {
  fid = reqFirma(fid); b = b || {};
  if (!b.productId || !b.tip || !b.cantitate || !b.data) fail(400, 'Completeaza produsul, tipul, cantitatea si data.');
  if (!['receptie', 'iesire', 'transfer'].includes(b.tip)) fail(400, 'Tip miscare invalid.');
  const d = db.get();
  if (!(d.products || []).find((p) => p.id === b.productId && p.firmaId === fid)) fail(400, 'Produs inexistent.');
  const gOk = (id) => !id || (d.gestiuni || []).some((g) => g.id === id && g.firmaId === fid);
  if (!gOk(b.gestiuneId) || !gOk(b.gestiuneDestId)) fail(400, 'Gestiune inexistenta.');
  if (b.tip === 'transfer' && (!b.gestiuneId || !b.gestiuneDestId || b.gestiuneId === b.gestiuneDestId)) fail(400, 'Transferul cere gestiune sursa si destinatie diferite.');
  const m = {
    id: db.nextId('sm'), firmaId: fid, data: String(b.data), tip: b.tip, productId: b.productId,
    gestiuneId: b.gestiuneId || null, gestiuneDestId: b.tip === 'transfer' ? b.gestiuneDestId : null,
    cantitate: round2(Number(b.cantitate) || 0), pretUnitar: round2(Number(b.pretUnitar) || 0),
    document: b.document || '', furnizor: b.tip === 'receptie' ? (b.furnizor || '') : '', operator: operator || '',
  };
  d.stockMovements.push(m);
  db.save();
  return { movement: m };
}

function deleteMovement(fid, id) {
  fid = reqFirma(fid);
  const d = db.get();
  const m = (d.stockMovements || []).find((x) => x.id === id && x.firmaId === fid);
  if (!m) fail(404, 'Miscare inexistenta.'); // izolare multi-firma
  if (m.entryId) d.entries = d.entries.filter((e) => e.id !== m.entryId); // sterge si nota contabila legata
  d.stockMovements = (d.stockMovements || []).filter((x) => x !== m);
  db.save();
}

/** Descarcarea de gestiune: genereaza nota contabila dintr-o miscare
 *  (receptie 3xx=401, iesire 60x=3xx la CMP). */
function postMovement(fid, id) {
  fid = reqFirma(fid);
  const d = db.get();
  const v = db.scoped(fid);
  const m = v.stockMovements.find((x) => x.id === id);
  if (!m) fail(404, 'Miscare inexistenta.');
  if (m.initial) fail(400, 'Miscare de stoc initial (preluare): nu se contabilizeaza — valoarea intra in soldurile initiale ale contului de stoc, altfel s-ar dubla.');
  if (m.entryId) fail(400, 'Nota contabila este deja generata pentru aceasta miscare.');
  const p = v.products.find((x) => x.id === m.productId);
  if (!p) fail(400, 'Produs inexistent.');
  const suma = round2(stocks.movementValue(p, v.stockMovements, m.id));
  if (suma <= 0) fail(400, 'Valoare zero — nimic de inregistrat.');
  const contStoc = p.cont || '371';
  let line; let tip; let tipNume;
  if (m.tip === 'receptie') {
    line = { debit: contStoc, credit: '401', suma, explicatie: 'Receptie ' + p.denumire };
    tip = 'stoc_receptie'; tipNume = 'Receptie in gestiune';
  } else {
    line = { debit: stocks.cogsAccount(contStoc), credit: contStoc, suma, explicatie: 'Descarcare gestiune ' + p.denumire };
    tip = 'stoc_descarcare'; tipNume = 'Descarcare de gestiune';
  }
  const entry = {
    id: db.nextId('e'), firmaId: fid, data: m.data, period: String(m.data).slice(0, 7),
    tip, tipNume, partener: '', partenerCui: '', document: m.document || '', analitic: '', explicatie: line.explicatie,
    fileId: null, system: true, movementId: m.id, lines: [line],
  };
  d.entries.push(entry);
  const mm = d.stockMovements.find((x) => x.id === m.id);
  mm.entryId = entry.id;
  db.save();
  return { entry, tipNume, suma };
}

// ── Preluare stoc initial (societate cu istoric precedent) ──

const num = (s) => { const n = parseRoNumber(s); return n == null ? 0 : round2(n); };

/** Compara valoarea stocului preluat cu soldurile initiale ale conturilor de stoc (pe view scoped). */
function initialTotals(view) {
  const byCont = {};
  for (const m of view.stockMovements || []) {
    if (!m.initial) continue;
    const p = (view.products || []).find((x) => x.id === m.productId);
    const cont = (p && p.cont) || '371';
    byCont[cont] = round2((byCont[cont] || 0) + round2((Number(m.cantitate) || 0) * (Number(m.pretUnitar) || 0)));
  }
  const opening = view.openingBalances || {};
  return Object.keys(byCont).sort().map((cont) => {
    const ob = opening[cont] || { d: 0, c: 0 };
    const sold = round2((Number(ob.d) || 0) - (Number(ob.c) || 0));
    return { cont, stocInitial: byCont[cont], soldInitial: sold, diferenta: round2(byCont[cont] - sold) };
  });
}

/** CSV: Cod;Denumire;UM;Cont;Gestiune;Cantitate;PretUnitar[;Valoare] (header optional; Valoare
 *  are prioritate fata de pret). Creeaza produsele si gestiunile lipsa si inregistreaza receptii
 *  marcate `initial` la data preluarii — CMP-ul porneste de la aceste cantitati/valori.
 *  NU se genereaza note contabile: valoric, stocul preluat face parte din soldurile initiale ale
 *  conturilor de stoc (3xx), altfel s-ar dubla. Re-importul inlocuieste pozitia (produs, gestiune). */
function importInitialStock(fid, operator, b) {
  fid = reqFirma(fid); b = b || {};
  const data = String(b.data || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) fail(400, 'Alege data preluarii (data bilantului de deschidere).');
  const rows = parseCsv(b.csv || '');
  if (!rows.length) fail(400, 'CSV gol sau invalid.');
  let start = 0;
  if (/cod|denumire|cant/i.test((rows[0][0] || '') + (rows[0][1] || '') + (rows[0][5] || ''))) start = 1;
  const d = db.get();
  let importate = 0; let produseNoi = 0; let gestiuniNoi = 0; const erori = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const cod = String(r[0] || '').trim();
    if (!cod) { erori.push('rand ' + (i + 1) + ': cod produs lipsa'); continue; }
    let p = (d.products || []).find((x) => x.firmaId === fid && x.cod === cod);
    if (!p) {
      if (!r[1]) { erori.push('rand ' + (i + 1) + ': produs nou fara denumire (' + cod + ')'); continue; }
      p = { id: db.nextId('prod'), firmaId: fid, cod, denumire: String(r[1]), um: r[2] || 'buc', grupa: '', cont: r[3] || '371', codNC: '' };
      d.products.push(p); produseNoi += 1;
    }
    let gestiuneId = null;
    const gcod = String(r[4] || '').trim();
    if (gcod) {
      let g = (d.gestiuni || []).find((x) => x.firmaId === fid && x.cod === gcod);
      if (!g) { g = { id: db.nextId('gest'), firmaId: fid, cod: gcod, denumire: gcod, gestionar: '', cont: p.cont || '371' }; d.gestiuni.push(g); gestiuniNoi += 1; }
      gestiuneId = g.id;
    }
    const cant = num(r[5]);
    if (cant <= 0) { erori.push('rand ' + (i + 1) + ': cantitate invalida (' + cod + ')'); continue; }
    const valoare = num(r[7]);
    const pret = valoare > 0 ? round2(valoare / cant) : num(r[6]);
    if (pret <= 0) { erori.push('rand ' + (i + 1) + ': pret/valoare lipsa (' + cod + ')'); continue; }
    const prev = (d.stockMovements || []).find((m) => m.firmaId === fid && m.initial && m.productId === p.id && (m.gestiuneId || null) === gestiuneId);
    if (prev) Object.assign(prev, { data, cantitate: cant, pretUnitar: pret, operator });
    else d.stockMovements.push({ id: db.nextId('sm'), firmaId: fid, data, tip: 'receptie', initial: true, productId: p.id, gestiuneId, gestiuneDestId: null, cantitate: cant, pretUnitar: pret, document: 'Stoc initial (preluare)', furnizor: '', operator });
    importate += 1;
  }
  db.save();
  return { importate, produseNoi, gestiuniNoi, erori, totaluri: initialTotals(db.scoped(fid)) };
}

// ── Inventariere ──

/** Inregistreaza un inventar: liniile cu scriptic/faptic, miscarile de reglare si notele
 *  contabile (plus 3xx=758, minus 60x=3xx la CMP, imputare 4282=7588+4427). */
function createInventory(fid, operator, b) {
  fid = reqFirma(fid); b = b || {};
  if (!b.gestiuneId || !b.data || !Array.isArray(b.lines)) fail(400, 'Lipsesc gestiunea, data sau liniile.');
  const d = db.get();
  const v = db.scoped(fid);
  const g = v.gestiuni.find((x) => x.id === b.gestiuneId);
  if (!g) fail(400, 'Gestiune inexistenta.');
  const tvaRate = (fiscal.FISCAL && fiscal.FISCAL.tvaStandard) || 21;
  const doc = 'Inventar ' + g.cod + ' ' + b.data;
  const result = { plusuri: [], minusuri: [], imputari: [] };
  const inv = { id: db.nextId('inv'), firmaId: fid, gestiuneId: g.id, gestiuneCod: g.cod, gestiuneDen: g.denumire, gestionar: g.gestionar || '', operator: operator || '', data: b.data, ts: new Date().toISOString(), status: 'activ', lines: [], entryIds: [], movementIds: [], totalScriptic: 0, totalFaptic: 0, totalPlus: 0, totalMinus: 0, totalImputat: 0 };
  const addEntry = (e) => { d.entries.push(e); inv.entryIds.push(e.id); };
  const addMove = (mv) => { d.stockMovements.push(mv); inv.movementIds.push(mv.id); };
  for (const ln of b.lines) {
    const p = v.products.find((x) => x.id === ln.productId);
    if (!p) continue;
    const led = stocks.productLedger(p, v.stockMovements, b.data, b.gestiuneId); // scriptic = starea de dinainte de inventar
    const scriptic = led.stocQ; const cmp = led.cmp;
    const faptic = round2(Number(ln.faptic) || 0);
    const diff = round2(faptic - scriptic);
    const cont = p.cont || '371';
    const ivLine = { productId: p.id, cod: p.cod, denumire: p.denumire, um: p.um || 'buc', scriptic, faptic, diff, cmp, valoare: round2(Math.abs(diff) * cmp), tip: diff > 0 ? 'plus' : diff < 0 ? 'minus' : 'ok', imputat: false, tvaImputare: 0 };
    inv.totalScriptic = round2(inv.totalScriptic + led.stocV);
    inv.totalFaptic = round2(inv.totalFaptic + round2(faptic * cmp));
    inv.lines.push(ivLine);
    if (diff === 0) continue;
    if (diff > 0) {
      // plus de inventar: intrare in stoc + 3xx = 758
      const val = round2(diff * (cmp || Number(ln.pret) || 0));
      addMove({ id: db.nextId('sm'), firmaId: fid, data: b.data, tip: 'receptie', productId: p.id, gestiuneId: b.gestiuneId, gestiuneDestId: null, cantitate: diff, pretUnitar: cmp || Number(ln.pret) || 0, document: doc, operator });
      if (val > 0) addEntry({ id: db.nextId('e'), firmaId: fid, data: b.data, period: String(b.data).slice(0, 7), tip: 'inventar_plus', tipNume: 'Plus de inventar', partener: '', partenerCui: '', document: doc, analitic: '', explicatie: 'Plus inventar ' + p.denumire, fileId: null, system: true, lines: [{ debit: cont, credit: '758', suma: val, explicatie: 'Plus de inventar ' + p.cod }] });
      ivLine.valoare = val; inv.totalPlus = round2(inv.totalPlus + val);
      result.plusuri.push({ produs: p.cod, cantitate: diff, valoare: val });
    } else {
      const q = round2(-diff);
      const val = round2(q * cmp);
      addMove({ id: db.nextId('sm'), firmaId: fid, data: b.data, tip: 'iesire', productId: p.id, gestiuneId: b.gestiuneId, gestiuneDestId: null, cantitate: q, pretUnitar: 0, document: doc, operator });
      if (val > 0) addEntry({ id: db.nextId('e'), firmaId: fid, data: b.data, period: String(b.data).slice(0, 7), tip: 'inventar_minus', tipNume: 'Minus de inventar (lipsa)', partener: '', partenerCui: '', document: doc, analitic: '', explicatie: 'Lipsa inventar ' + p.denumire, fileId: null, system: true, lines: [{ debit: stocks.cogsAccount(cont), credit: cont, suma: val, explicatie: 'Lipsa la inventar ' + p.cod }] });
      // imputare gestionar: 4282 = 7588 + 4427
      if (ln.imputa && val > 0) {
        const tva = round2((val * tvaRate) / 100);
        addEntry({ id: db.nextId('e'), firmaId: fid, data: b.data, period: String(b.data).slice(0, 7), tip: 'imputare_lipsa', tipNume: 'Imputare lipsa gestionar', partener: g.gestionar || '', partenerCui: '', document: doc, analitic: '', explicatie: 'Imputare ' + p.denumire + ' catre ' + (g.gestionar || 'gestionar'), fileId: null, system: true, lines: [
          { debit: '4282', credit: '7588', suma: val, explicatie: 'Imputare lipsa ' + p.cod },
          { debit: '4282', credit: '4427', suma: tva, explicatie: 'TVA imputare lipsa ' + p.cod },
        ] });
        ivLine.imputat = true; ivLine.tvaImputare = tva; inv.totalImputat = round2(inv.totalImputat + val + tva);
        result.imputari.push({ produs: p.cod, valoare: val, tva });
      }
      ivLine.valoare = val; inv.totalMinus = round2(inv.totalMinus + val);
      result.minusuri.push({ produs: p.cod, cantitate: q, valoare: val });
    }
  }
  d.inventories.push(inv);
  db.save();
  return { inv, result };
}

/** Stornarea unui inventar: reverseaza notele contabile (storno debit<->credit) si sterge
 *  miscarile de reglare (stocul revine exact la starea de dinainte). */
function stornoInventory(fid, operator, id, dataStorno) {
  fid = reqFirma(fid);
  const d = db.get();
  const iv = (d.inventories || []).find((x) => x.id === id && x.firmaId === fid);
  if (!iv) fail(404, 'Inventar inexistent.'); // izolare multi-firma
  if (iv.status === 'stornat') fail(400, 'Inventarul este deja stornat.');
  const stornoData = String(dataStorno || new Date().toISOString().slice(0, 10));
  const docStorno = 'Storno inventar ' + iv.gestiuneCod + ' ' + iv.data;
  const stornoEntryIds = [];
  // 1) note de stornare (reversare debit<->credit, aceleasi sume)
  for (const eid of (iv.entryIds || [])) {
    const orig = d.entries.find((e) => e.id === eid);
    if (!orig) continue;
    const se = {
      id: db.nextId('e'), firmaId: iv.firmaId, data: stornoData, period: String(stornoData).slice(0, 7),
      tip: 'storno_inventar', tipNume: 'Storno ' + orig.tipNume, partener: orig.partener || '', partenerCui: '',
      document: docStorno, analitic: '', explicatie: 'Stornare ' + (orig.explicatie || orig.tipNume), fileId: null, system: true,
      lines: orig.lines.map((l) => ({ debit: l.credit, credit: l.debit, suma: l.suma, explicatie: 'Storno ' + (l.explicatie || '') })),
    };
    d.entries.push(se); stornoEntryIds.push(se.id);
  }
  // 2) sterge miscarile de reglare (readuce stocul la starea de dinainte de inventar)
  d.stockMovements = (d.stockMovements || []).filter((m) => !(iv.movementIds || []).includes(m.id));
  iv.status = 'stornat'; iv.stornoData = stornoData; iv.stornoOperator = operator || ''; iv.stornoEntryIds = stornoEntryIds;
  db.save();
  return { stornoEntries: stornoEntryIds.length, iv };
}

module.exports = {
  reqFirma, upsertProduct, importProducts, deleteProduct,
  upsertGestiune, deleteGestiune,
  addMovement, deleteMovement, postMovement,
  initialTotals, importInitialStock,
  createInventory, stornoInventory,
};
