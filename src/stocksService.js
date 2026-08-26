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
const { round2, roundQty, validIsoDate } = require('./util');
const { parseCsv, isHeaderRow } = require('./csv');
const { parseRoNumber } = require('./extractor');
const stocks = require('./stocks');
const fiscal = require('./fiscal');
const coa = require('./chartOfAccounts');

// Contul ales de UTILIZATOR pe un produs sau pe o gestiune ajunge in articolele de descarcare
// (`cogsAccount(p.cont)`), deci intr-o balanta si in SAF-T. Nu era validat nicaieri: un „317"
// tastat in loc de „371" trecea tacut si producea un cont orfan. `db.pushEntry` il opreste azi la
// postare, dar mesajul de acolo vorbeste despre un articol, nu despre produsul care l-a cauzat —
// iar defectul ar iesi la iveala abia luni mai tarziu. Se opreste deci la SURSA, unde greseala
// tocmai s-a facut si se poate corecta dintr-o tastare.
function ceruteContValid(cont, ce) {
  const c = String(cont || '').trim();
  if (!c || coa.getAccount(c)) return c;
  fail(400, 'Cont inexistent în planul de conturi: ' + c + ' (' + ce + ').');
  return c;
}

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

function reqDate(value, label) {
  const data = String(value || '');
  if (!validIsoDate(data)) {
    fail(400, (label || 'Data') + ' trebuie sa fie o data calendaristica valida (YYYY-MM-DD).');
  }
  return data;
}

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
  ceruteContValid(b.cont, 'contul de stoc al produsului');
  const existing = (d.products || []).find((p) => p.firmaId === fid && p.cod === b.cod);
  if (existing) {
    const contNou = b.cont || existing.cont || '371';
    if (contNou !== (existing.cont || '371')
      && (d.stockMovements || []).some((m) => m.firmaId === fid && m.productId === existing.id)) {
      fail(409, 'Contul produsului nu se poate schimba dupa prima miscare de stoc; ar rescrie retroactiv rapoartele si SAF-T.');
    }
    Object.assign(existing, { denumire: b.denumire, um: b.um || existing.um, grupa: b.grupa || '', cont: b.cont || existing.cont, codNC: b.codNC || '' });
    db.save();
    return { product: existing, created: false };
  }
  const p = { id: db.nextId('prod'), firmaId: fid, cod: String(b.cod), denumire: String(b.denumire), um: b.um || 'buc', grupa: b.grupa || '', cont: b.cont || '371', codNC: b.codNC || '', activ: true };
  d.products.push(p);
  db.save();
  return { product: p, created: true };
}

/** Import produse din CSV: Cod;Denumire;UM;Cont;Grupa;CodNC (header optional). */
function importProducts(fid, csv) {
  fid = reqFirma(fid);
  const rows = parseCsv(csv || '');
  if (!rows.length) fail(400, 'CSV gol sau invalid.');
  const start = isHeaderRow(rows[0]) ? 1 : 0;
  const d = db.get();
  const plans = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i]; const cod = String(r[0] || '').trim();
    if (!cod || !r[1]) continue;
    const cont = String(r[3] || '371').trim();
    ceruteContValid(cont, 'contul produsului ' + cod + ' din import');
    const existing = (d.products || []).find((p) => p.firmaId === fid && p.cod === cod);
    if (existing && cont !== (existing.cont || '371')
      && (d.stockMovements || []).some((m) => m.firmaId === fid && m.productId === existing.id)) {
      fail(409, 'Importul ar schimba contul produsului ' + cod + ' dupa prima miscare de stoc.');
    }
    plans.push({ r, cod, cont, existing });
  }
  let importati = 0;
  for (const plan of plans) {
    const { r, cod, cont } = plan;
    const existing = (d.products || []).find((p) => p.firmaId === fid && p.cod === cod);
    const rec = existing || { id: db.nextId('prod'), firmaId: fid, cod, activ: true };
    Object.assign(rec, { denumire: r[1], um: r[2] || 'buc', cont, grupa: r[4] || '', codNC: r[5] || '' });
    if (!existing) d.products.push(rec);
    importati += 1;
  }
  db.save();
  return { importati };
}

/** Sterge un produs — DOAR daca n-a avut nicio miscare de stoc (produs creat din greseala).
 *  Cu miscari, stergerea ar sterge fisa de magazie dar ar lasa notele contabile (cartea mare)
 *  fara acoperire -> divergenta. Un produs folosit se DEZACTIVEAZA (setProductActive), pastrand
 *  istoricul intact; corectiile de valoare se fac prin storno. */
function deleteProduct(fid, id) {
  fid = reqFirma(fid);
  const d = db.get();
  const p = (d.products || []).find((x) => x.id === id && x.firmaId === fid);
  if (!p) fail(404, 'Produs inexistent.'); // izolare multi-firma
  if ((d.stockMovements || []).some((m) => m.firmaId === fid && m.productId === p.id)) {
    fail(400, 'Produsul are miscari de stoc — nu se poate sterge (ar lasa notele contabile fara acoperire). Dezactiveaza-l in schimb (istoricul ramane, dar nu mai primeste miscari noi).');
  }
  d.products = (d.products || []).filter((x) => x !== p);
  db.save();
}

/** Dezactiveaza/reactiveaza un produs. Cel inactiv ramane in listari si rapoarte (istoricul e
 *  intact), dar nu mai poate primi miscari de stoc noi — echivalentul soft-delete corect contabil. */
function setProductActive(fid, id, activ) {
  fid = reqFirma(fid);
  const d = db.get();
  const p = (d.products || []).find((x) => x.id === id && x.firmaId === fid);
  if (!p) fail(404, 'Produs inexistent.');
  p.activ = activ !== false; // implicit reactivare; false = dezactivare
  db.save();
  return { product: p };
}

// ── Gestiuni (depozite) ──

function upsertGestiune(fid, b) {
  fid = reqFirma(fid); b = b || {};
  if (!b.cod || !b.denumire) fail(400, 'Completeaza codul si denumirea gestiunii.');
  const d = db.get();
  ceruteContValid(b.cont, 'contul de stoc al gestiunii');
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
  if (!b.productId || !b.tip || b.cantitate == null || !b.data) fail(400, 'Completeaza produsul, tipul, cantitatea si data.');
  if (!['receptie', 'iesire', 'transfer'].includes(b.tip)) fail(400, 'Tip miscare invalid.');
  const cantitate = Number(b.cantitate);
  if (!Number.isFinite(cantitate) || cantitate <= 0) fail(400, 'Cantitatea trebuie sa fie un numar strict pozitiv.');
  const data = reqDate(b.data, 'Data miscarii');
  const pretUnitar = Number(b.pretUnitar);
  if (b.tip === 'receptie' && (!Number.isFinite(pretUnitar) || pretUnitar <= 0)) {
    fail(400, 'Receptia cere un pret unitar strict pozitiv; o cantitate fara valoare ar denatura stocul contabil.');
  }
  const d = db.get();
  const prodMv = (d.products || []).find((p) => p.id === b.productId && p.firmaId === fid);
  if (!prodMv) fail(400, 'Produs inexistent.');
  if (prodMv.activ === false) fail(400, 'Produsul este dezactivat — reactiveaza-l inainte de a inregistra miscari noi.');
  const gOk = (id) => !id || (d.gestiuni || []).some((g) => g.id === id && g.firmaId === fid);
  if (!gOk(b.gestiuneId) || !gOk(b.gestiuneDestId)) fail(400, 'Gestiune inexistenta.');
  if (b.tip === 'transfer' && (!b.gestiuneId || !b.gestiuneDestId || b.gestiuneId === b.gestiuneDestId)) fail(400, 'Transferul cere gestiune sursa si destinatie diferite.');
  db.assertPeriodOpen(fid, data, 'Miscarea de stoc'); // perioada inchisa -> refuz
  const m = {
    id: db.nextId('sm'), firmaId: fid, data, tip: b.tip, productId: b.productId,
    gestiuneId: b.gestiuneId || null, gestiuneDestId: b.tip === 'transfer' ? b.gestiuneDestId : null,
    cantitate: roundQty(cantitate), pretUnitar: b.tip === 'receptie' ? round2(pretUnitar) : 0,
    document: b.document || '', furnizor: b.tip === 'receptie' ? (b.furnizor || '') : '', operator: operator || '',
  };
  // O miscare retroactiva poate recalcula CMP/FIFO-ul unei iesiri deja contabilizate. Cartea
  // mare nu se rescrie retroactiv, deci refuzam operatia si cerem corectarea documentelor in
  // ordine (storno + repostare), in loc sa lasam subregistrul de stoc sa diverga de nota fixa.
  const afectata = stocks.valuationDrift(db.scoped(fid), [m]);
  if (afectata) fail(409, 'Miscarea ar recalcula iesirea deja contabilizata ' + afectata.movementId
    + ' (' + afectata.data + '). Storneaza documentele afectate, inregistreaza miscarea lipsa si posteaza-le din nou in ordine cronologica.');
  d.stockMovements.push(m);
  const lipsa = stocks.movementShortages(db.scoped(fid)).find((x) => x.movementId === m.id) || null;
  db.save();
  return { movement: m, lipsa };
}

function deleteMovement(fid, id) {
  fid = reqFirma(fid);
  const d = db.get();
  const m = (d.stockMovements || []).find((x) => x.id === id && x.firmaId === fid);
  if (!m) fail(404, 'Miscare inexistenta.'); // izolare multi-firma
  if (m.stornat) fail(400, 'Miscarea este deja stornata si ramane in fisa pentru audit.');
  if (m.stornoOfMovementId) fail(400, 'Miscarea este o corectie si ramane in fisa pentru audit; nu se sterge separat de original.');
  db.assertPeriodOpen(fid, m.data, 'Stergerea miscarii de stoc'); // nu rupe o luna inchisa (nici nota legata)
  if (m.entryId) fail(400, 'Miscarea are nota contabila postata — foloseste stornarea, nu stergerea.');
  d.stockMovements = (d.stockMovements || []).filter((x) => x !== m);
  db.save();
}

/**
 * Corectia append-only a unei miscari/grup: miscari inverse +, daca exista, nota in rosu.
 * Originalele raman in fisa si jurnal, legate de corectie. Pentru o receptie deja consumata,
 * stornarea este refuzata pana exista din nou cantitatea in gestiune (nu inventam stoc negativ).
 */
function stornoMovement(fid, operator, id, dataStorno) {
  fid = reqFirma(fid);
  const d = db.get(); const v = db.scoped(fid);
  const m = (d.stockMovements || []).find((x) => x.id === id && x.firmaId === fid);
  if (!m) fail(404, 'Miscare inexistenta.');
  if (m.initial) fail(400, 'Stocul initial se corecteaza prin refacerea preluarii si a soldurilor de deschidere.');
  if (m.stornoOfMovementId) fail(400, 'O miscare de storno nu se storneaza din nou; corectia se face pe documentul original.');
  if (m.stornat) fail(400, 'Miscarea este deja stornata (corectia ' + (m.stornoMovementId || '') + ').');
  const data = reqDate(dataStorno || new Date().toISOString().slice(0, 10), 'Data stornarii');
  db.assertPeriodOpen(fid, data, 'Stornarea miscarii de stoc');
  const originalEntry = m.entryId ? d.entries.find((e) => e.id === m.entryId && e.firmaId === fid) : null;
  if (m.entryId && (!originalEntry || originalEntry.stornat)) fail(409, 'Nota contabila legata lipseste sau este deja stornata.');
  // O factura/productie poate avea mai multe miscari sub aceeasi nota. Corectia trebuie sa le
  // neutralizeze pe TOATE odata; stornarea unei singure linii ar anula nota intreaga, dar ar lasa
  // restul cantitatilor active in fisa.
  const originale = originalEntry
    ? (d.stockMovements || []).filter((x) => x.firmaId === fid && x.entryId === originalEntry.id && !x.stornoOfMovementId)
    : [m];
  if (!originale.length || originale.some((x) => x.stornat)) fail(409, 'Legaturile documentului de stoc sunt incomplete sau deja stornate.');
  const dataMax = originale.reduce((max, x) => x.data > max ? x.data : max, '');
  if (data < dataMax) fail(400, 'Data stornarii nu poate fi anterioara miscarii originale (' + dataMax + ').');
  const metoda = stocks.metodaFirma(v);
  const reverses = originale.map((orig) => {
    const p = v.products.find((x) => x.id === orig.productId);
    if (!p) fail(409, 'Produsul miscarii ' + orig.id + ' nu mai exista.');
    const rand = stocks.movementRow(p, v.stockMovements, orig.id, metoda);
    const efectiv = roundQty(orig.tip === 'receptie' ? (rand && rand.intrareQ) : (rand && rand.iesireQ));
    const valoare = round2(orig.tip === 'receptie' ? (rand && rand.intrareV) : (rand && rand.iesireV));
    if (!(efectiv > 0)) fail(409, 'Miscarea ' + orig.id + ' nu are cantitate efectiva de stornat.');
    return {
      id: db.nextId('sm'), firmaId: fid, data, productId: orig.productId,
      tip: orig.tip === 'receptie' ? 'iesire' : orig.tip === 'iesire' ? 'receptie' : 'transfer',
      gestiuneId: orig.tip === 'transfer' ? orig.gestiuneDestId : orig.gestiuneId,
      gestiuneDestId: orig.tip === 'transfer' ? orig.gestiuneId : null,
      cantitate: efectiv, pretUnitar: orig.tip === 'iesire' ? round2(valoare / efectiv) : 0,
      valoareContabila: valoare,
      document: 'Storno ' + (orig.document || orig.id), furnizor: '', operator: operator || '',
      stornoOfMovementId: orig.id, system: true,
    };
  });
  const lipsuriInainte = new Map(stocks.movementShortages(v).map((x) => [x.movementId, x.lipsa]));
  const marcajeVechi = originale.map((x) => ({ stornat: x.stornat, stornoMovementId: x.stornoMovementId }));
  // Marcajele sunt puse temporar numai in memoria obiectului pentru proba pura; se restaureaza
  // inaintea oricarei iesiri. Perechea dispare din simulare si vedem daca miscarile ulterioare
  // ramase ar consuma stoc inexistent.
  for (let i = 0; i < originale.length; i++) {
    originale[i].stornat = true; originale[i].stornoMovementId = reverses[i].id;
  }
  const proba = Object.assign({}, v, { stockMovements: v.stockMovements.concat(reverses) });
  const lipsaNoua = stocks.movementShortages(proba).find((x) => x.lipsa > (lipsuriInainte.get(x.movementId) || 0));
  for (let i = 0; i < originale.length; i++) {
    if (marcajeVechi[i].stornat === undefined) delete originale[i].stornat;
    else originale[i].stornat = marcajeVechi[i].stornat;
    if (marcajeVechi[i].stornoMovementId === undefined) delete originale[i].stornoMovementId;
    else originale[i].stornoMovementId = marcajeVechi[i].stornoMovementId;
  }
  if (lipsaNoua) fail(409, 'Stornarea ar lasa fara stoc miscarea ' + lipsaNoua.movementId + ': lipsesc '
    + lipsaNoua.lipsa + ' din produsul „' + lipsaNoua.denumire + '”. Corecteaza mai intai miscarile ulterioare.');

  let se = null;
  if (originalEntry) {
    se = {
      id: db.nextId('e'), firmaId: fid, data, period: data.slice(0, 7), tip: 'storno',
      tipNume: 'Storno ' + (originalEntry.tipNume || originalEntry.tip),
      partener: originalEntry.partener || '', partenerCui: originalEntry.partenerCui || '',
      document: 'Storno ' + (originalEntry.document || originalEntry.id), analitic: originalEntry.analitic || '',
      explicatie: 'Stornare miscare de stoc: ' + (originalEntry.explicatie || originalEntry.tipNume || originalEntry.tip),
      fileId: null, system: true, stornoOf: originalEntry.id,
      stocMovementIds: reverses.map((x) => x.id),
      lines: (originalEntry.lines || []).map((l) => ({ debit: l.debit, credit: l.credit,
        suma: round2(-l.suma), explicatie: 'Storno ' + (l.explicatie || '') })),
    };
    if (reverses.length === 1) { se.movementId = reverses[0].id; se.stocMovementId = reverses[0].id; }
    for (const reverse of reverses) reverse.entryId = se.id;
    db.pushEntry(se, { context: 'stornare miscare de stoc' });
    originalEntry.stornat = true; originalEntry.stornoBy = se.id; originalEntry.stornoData = data;
  }
  for (let i = 0; i < originale.length; i++) {
    const orig = originale[i]; const reverse = reverses[i];
    d.stockMovements.push(reverse);
    orig.stornat = true; orig.stornoMovementId = reverse.id; orig.stornoEntryId = se ? se.id : null;
    orig.stornoData = data; orig.valoareContabila = reverse.valoareContabila;
  }
  db.save();
  return { original: m, movement: reverses.find((x) => x.stornoOfMovementId === m.id), movements: reverses, entry: se };
}

/** Descarcarea de gestiune: genereaza nota contabila dintr-o miscare
 *  (receptie 3xx=401, iesire 60x=3xx la metoda configurata: CMP/FIFO). */
function postMovement(fid, id) {
  fid = reqFirma(fid);
  const d = db.get();
  const v = db.scoped(fid);
  const m = v.stockMovements.find((x) => x.id === id);
  if (!m) fail(404, 'Miscare inexistenta.');
  if (m.stornat || m.stornoOfMovementId) fail(400, 'O miscare stornata/de corectie nu se posteaza separat. Foloseste documentul original si legatura sa de storno.');
  if (m.initial) fail(400, 'Miscare de stoc initial (preluare): nu se contabilizeaza — valoarea intra in soldurile initiale ale contului de stoc, altfel s-ar dubla.');
  if (m.tip === 'transfer') fail(400, 'Transferul intre gestiuni este o miscare interna si nu genereaza nota in contabilitatea financiara.');
  if (m.entryId) fail(400, 'Nota contabila este deja generata pentru aceasta miscare.');
  db.assertPeriodOpen(fid, m.data, 'Postarea miscarii de stoc');
  const p = v.products.find((x) => x.id === m.productId);
  if (!p) fail(400, 'Produs inexistent.');
  const metoda = stocks.metodaFirma(v);
  const rand = stocks.movementRow(p, v.stockMovements, m.id, metoda);
  const cerut = roundQty(Number(m.cantitate) || 0);
  const efectiv = roundQty(rand ? rand.iesireQ : 0);
  if (m.tip === 'iesire' && efectiv < cerut) {
    fail(409, 'Stoc insuficient: miscarea cere ' + cerut + ', dar numai ' + efectiv
      + ' poate fi descarcat. Inregistreaza receptia lipsa inainte de nota contabila.');
  }
  const suma = round2(stocks.movementValue(p, v.stockMovements, m.id, metoda));
  if (suma <= 0) fail(400, 'Valoare zero — nimic de inregistrat.');
  const contStoc = p.cont || '371';
  let line; let tip; let tipNume;
  if (m.tip === 'receptie') {
    line = { debit: contStoc, credit: '401', suma, explicatie: 'Recepție ' + p.denumire };
    tip = 'stoc_receptie'; tipNume = 'Receptie in gestiune';
  } else {
    line = { debit: stocks.cogsAccount(contStoc), credit: contStoc, suma, explicatie: 'Descărcare gestiune ' + p.denumire };
    tip = 'stoc_descarcare'; tipNume = 'Descarcare de gestiune';
  }
  const entry = {
    id: db.nextId('e'), firmaId: fid, data: m.data, period: String(m.data).slice(0, 7),
    tip, tipNume, partener: '', partenerCui: '', document: m.document || '', analitic: '', explicatie: line.explicatie,
    fileId: null, system: true,
    // `movementId` ramane pentru compatibilitatea exporturilor existente; numele canonic este
    // `stocMovementId`, acelasi pe care il verifica garda de storno generic.
    movementId: m.id, stocMovementId: m.id, lines: [line],
  };
  db.pushEntry(entry, { context: 'miscare de stoc' });
  const mm = d.stockMovements.find((x) => x.id === m.id);
  mm.entryId = entry.id; mm.valoareContabila = suma;
  db.save();
  return { entry, tipNume, suma };
}

// ── Preluare stoc initial (societate cu istoric precedent) ──

const num = (s) => { const n = parseRoNumber(s); return n == null ? 0 : round2(n); };
const qtyNum = (s) => { const n = parseRoNumber(s); return n == null ? 0 : roundQty(n); };

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
  const data = reqDate(b.data, 'Data preluarii stocului initial');
  db.assertPeriodOpen(fid, data, 'Preluarea stocului initial');
  const rows = parseCsv(b.csv || '');
  if (!rows.length) fail(400, 'CSV gol sau invalid.');
  const start = isHeaderRow(rows[0]) ? 1 : 0;
  const d = db.get();
  const vInainte = db.scoped(fid);
  const entryById = new Map((vInainte.entries || []).map((e) => [e.id, e]));
  if ((vInainte.stockMovements || []).some((m) => m.tip === 'iesire' && !m.stornat && !m.stornoOfMovementId
    && ((m.valoareContabila != null && Number.isFinite(Number(m.valoareContabila)))
      || (m.entryId && entryById.has(m.entryId))))) {
    fail(409, 'Stocul initial nu se mai importa dupa o iesire contabilizata; ar recalcula retroactiv costurile.');
  }
  let importate = 0; let produseNoi = 0; let gestiuniNoi = 0; const erori = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const cod = String(r[0] || '').trim();
    if (!cod) { erori.push('rand ' + (i + 1) + ': cod produs lipsa'); continue; }
    const cant = qtyNum(r[5]);
    if (cant <= 0) { erori.push('rand ' + (i + 1) + ': cantitate invalida (' + cod + ')'); continue; }
    const valoare = num(r[7]);
    const pret = valoare > 0 ? round2(valoare / cant) : num(r[6]);
    if (pret <= 0) { erori.push('rand ' + (i + 1) + ': pret/valoare lipsa (' + cod + ')'); continue; }
    const contCerut = String(r[3] || '371').trim();
    if (!coa.getAccount(contCerut)) { erori.push('rand ' + (i + 1) + ': cont inexistent (' + contCerut + ')'); continue; }
    let p = (d.products || []).find((x) => x.firmaId === fid && x.cod === cod);
    if (!p) {
      if (!r[1]) { erori.push('rand ' + (i + 1) + ': produs nou fara denumire (' + cod + ')'); continue; }
      p = { id: db.nextId('prod'), firmaId: fid, cod, denumire: String(r[1]), um: r[2] || 'buc', grupa: '', cont: r[3] || '371', codNC: '' };
      d.products.push(p); produseNoi += 1;
    }
    if (!coa.getAccount(p.cont || '371')) { erori.push('rand ' + (i + 1) + ': contul produsului este inexistent (' + p.cont + ')'); continue; }
    let gestiuneId = null;
    const gcod = String(r[4] || '').trim();
    if (gcod) {
      let g = (d.gestiuni || []).find((x) => x.firmaId === fid && x.cod === gcod);
      if (!g) { g = { id: db.nextId('gest'), firmaId: fid, cod: gcod, denumire: gcod, gestionar: '', cont: p.cont || '371' }; d.gestiuni.push(g); gestiuniNoi += 1; }
      gestiuneId = g.id;
    }
    const prev = (d.stockMovements || []).find((m) => m.firmaId === fid && m.initial && m.productId === p.id && (m.gestiuneId || null) === gestiuneId);
    if (prev) Object.assign(prev, { data, cantitate: cant, pretUnitar: pret, operator });
    else d.stockMovements.push({ id: db.nextId('sm'), firmaId: fid, data, tip: 'receptie', initial: true, productId: p.id, gestiuneId, gestiuneDestId: null, cantitate: cant, pretUnitar: pret, document: 'Stoc initial (preluare)', furnizor: '', operator });
    importate += 1;
  }
  db.save();
  return { importate, produseNoi, gestiuniNoi, erori, totaluri: initialTotals(db.scoped(fid)) };
}

// ── Serii de documente (NIR/BC/AVIZ/CH) + numerotare ──

/** Seriile per firma, cu valorile implicite create la prima folosire (migrare in-loc pentru CH). */
function ensureDocSeries(d, fid) {
  d.settings.docSeries = d.settings.docSeries || {};
  if (!d.settings.docSeries[fid]) d.settings.docSeries[fid] = { NIR: { serie: 'NIR', next: 1 }, BC: { serie: 'BC', next: 1 }, AVIZ: { serie: 'AVZ', next: 1 } };
  const s = d.settings.docSeries[fid];
  if (!s.CH) s.CH = { serie: 'CH', next: 1 }; // chitante (serie adaugata ulterior — migrare in-loc)
  return s;
}

function docSeries(fid) {
  fid = reqFirma(fid);
  return ensureDocSeries(db.get(), fid);
}

function updateDocSeries(fid, b) {
  fid = reqFirma(fid); b = b || {};
  const d = db.get();
  const s = ensureDocSeries(d, fid);
  for (const t of ['NIR', 'BC', 'AVIZ', 'CH']) {
    if (b[t]) {
      if (b[t].serie != null) s[t].serie = String(b[t].serie).slice(0, 10);
      if (b[t].next != null && Number(b[t].next) > 0) s[t].next = Math.floor(Number(b[t].next));
    }
  }
  db.save();
  return { series: s };
}

/** Atribuie (sau reutilizeaza) numarul de document pentru un grup de miscari — un grup
 *  numerotat o data pastreaza numarul la retiparire. */
function assignDocNumber(fid, type, movs) {
  fid = reqFirma(fid);
  const d = db.get();
  const existing = movs.map((m) => m.docNr && m.docNr[type]).find(Boolean);
  if (existing) return existing;
  const s = ensureDocSeries(d, fid)[type];
  const nr = s.serie + '-' + String(s.next).padStart(5, '0');
  s.next += 1;
  for (const m of movs) { m.docNr = m.docNr || {}; m.docNr[type] = nr; }
  db.save();
  return nr;
}

/** Registrul documentelor de stoc emise (numerotate): NIR / bon de consum / aviz. Citire pura pe view. */
function buildDocRegister(v) {
  const byProd = new Map(v.products.map((p) => [p.id, p]));
  const gById = new Map(v.gestiuni.map((g) => [g.id, g]));
  const TYPE_LABEL = { NIR: 'NIR (receptie)', BC: 'Bon de consum', AVIZ: 'Aviz insotire' };
  const groups = new Map();
  for (const m of v.stockMovements) {
    if (!m.docNr) continue;
    const p = byProd.get(m.productId) || {};
    const val = m.tip === 'receptie' ? Math.round(m.cantitate * m.pretUnitar * 100) / 100 : Math.round(stocks.movementValue(p, v.stockMovements, m.id) * 100) / 100;
    for (const [type, nr] of Object.entries(m.docNr)) {
      const key = type + '|' + nr;
      if (!groups.has(key)) {
        const g = gById.get(m.gestiuneId);
        groups.set(key, { type, tip: TYPE_LABEL[type] || type, serieNr: nr, data: m.data, gestiune: g ? g.cod : '', document: m.document || '', operator: m.operator || '', valoare: 0, nrLinii: 0 });
      }
      const grp = groups.get(key);
      grp.valoare = Math.round((grp.valoare + val) * 100) / 100;
      grp.nrLinii += 1;
      if (m.data < grp.data) grp.data = m.data;
    }
  }
  return [...groups.values()].sort((a, b) => (a.type === b.type ? (a.serieNr < b.serieNr ? -1 : 1) : a.type < b.type ? -1 : 1));
}

// ── Inventariere ──

/** Inregistreaza un inventar: liniile cu scriptic/faptic, miscarile de reglare si notele
 *  contabile (plus 3xx=758, minus 60x=3xx la CMP/FIFO, imputare 4282=7588+4427). */
function createInventory(fid, operator, b) {
  fid = reqFirma(fid); b = b || {};
  if (!b.gestiuneId || !b.data || !Array.isArray(b.lines) || !b.lines.length) fail(400, 'Lipsesc gestiunea, data sau liniile.');
  const d = db.get();
  const v = db.scoped(fid);
  const g = v.gestiuni.find((x) => x.id === b.gestiuneId);
  if (!g) fail(400, 'Gestiune inexistenta.');
  const data = reqDate(b.data, 'Data inventarului');
  const tvaRate = fiscal.rulesAt(data).rates.tvaStandard;
  db.assertPeriodOpen(fid, data, 'Inventarierea'); // reglarile de stoc + notele nu ating o luna inchisa
  const doc = 'Inventar ' + g.cod + ' ' + data;
  const result = { plusuri: [], minusuri: [], imputari: [] };
  // Prevalidam TOATE liniile inainte de prima scriere. Altfel o eroare pe linia 10 lasa in
  // memorie miscarile/notelor primelor noua, care pot ajunge pe disc la urmatorul save.
  const seen = new Set();
  const plans = b.lines.map((ln, index) => {
    if (!ln || !ln.productId) fail(400, 'Linia ' + (index + 1) + ': produs lipsa.');
    if (seen.has(ln.productId)) fail(400, 'Produsul apare de doua ori in acelasi inventar; pastreaza o singura linie per produs.');
    seen.add(ln.productId);
    const p = v.products.find((x) => x.id === ln.productId);
    if (!p) fail(400, 'Linia ' + (index + 1) + ': produs inexistent.');
    ceruteContValid(p.cont || '371', 'contul de stoc al produsului ' + (p.cod || p.id));
    const faptic = Number(ln.faptic);
    if (!Number.isFinite(faptic) || faptic < 0) fail(400, 'Linia ' + (index + 1) + ': stocul faptic trebuie sa fie un numar pozitiv sau zero.');
    const led = stocks.productLedger(p, v.stockMovements, data, b.gestiuneId, stocks.metodaFirma(v));
    const scriptic = led.stocQ; const cmp = led.cmp; const diff = roundQty(faptic - scriptic);
    const pretPlus = cmp || Number(ln.pret) || 0;
    if (diff > 0 && (!Number.isFinite(pretPlus) || pretPlus <= 0)) {
      fail(400, 'Linia ' + (index + 1) + ': plusul de inventar pentru „' + (p.denumire || p.cod)
        + '” cere un cost unitar pozitiv.');
    }
    return { ln, p, faptic: roundQty(faptic), led, scriptic, cmp, diff, pretPlus };
  });
  const inv = { id: db.nextId('inv'), firmaId: fid, gestiuneId: g.id, gestiuneCod: g.cod, gestiuneDen: g.denumire, gestionar: g.gestionar || '', operator: operator || '', data, ts: new Date().toISOString(), status: 'activ', lines: [], entryIds: [], movementIds: [], totalScriptic: 0, totalFaptic: 0, totalPlus: 0, totalMinus: 0, totalImputat: 0 };
  const metoda = stocks.metodaFirma(v);
  for (const plan of plans) {
    if (plan.diff === 0) continue;
    plan.movement = {
      id: db.nextId('sm'), firmaId: fid, data, productId: plan.p.id, gestiuneId: b.gestiuneId,
      gestiuneDestId: null, tip: plan.diff > 0 ? 'receptie' : 'iesire',
      cantitate: roundQty(Math.abs(plan.diff)), pretUnitar: plan.diff > 0 ? plan.pretPlus : 0,
      document: doc, operator, inventoryId: inv.id,
    };
    if (plan.diff > 0) plan.valoare = round2(plan.diff * plan.pretPlus);
    else {
      const row = stocks.movementRow(plan.p, v.stockMovements.concat([plan.movement]), plan.movement.id, metoda);
      const efectiv = roundQty(row ? row.iesireQ : 0);
      if (efectiv !== plan.movement.cantitate) fail(409, 'Stoc insuficient pentru minusul de inventar la „'
        + (plan.p.denumire || plan.p.cod) + '”.');
      plan.valoare = round2(row ? row.iesireV : 0);
    }
    plan.movement.valoareContabila = plan.valoare;
  }
  const drift = stocks.valuationDrift(v, plans.map((p) => p.movement).filter(Boolean));
  if (drift) fail(409, 'Inventarul retroactiv ar recalcula iesirea deja postata ' + drift.movementId
    + ' (' + drift.data + '). Storneaza si reia documentele de stoc in ordine cronologica.');
  const addEntry = (e) => { db.pushEntry(e, { context: 'diferente de inventar' }); inv.entryIds.push(e.id); };
  const addMove = (mv) => { mv.inventoryId = inv.id; d.stockMovements.push(mv); inv.movementIds.push(mv.id); };
  for (const plan of plans) {
    const { ln, p, led, scriptic, cmp, faptic, diff, pretPlus } = plan;
    const cont = p.cont || '371';
    const ivLine = { productId: p.id, cod: p.cod, denumire: p.denumire, um: p.um || 'buc', scriptic, faptic, diff, cmp, valoare: round2(Math.abs(diff) * cmp), tip: diff > 0 ? 'plus' : diff < 0 ? 'minus' : 'ok', imputat: false, tvaImputare: 0 };
    inv.totalScriptic = round2(inv.totalScriptic + led.stocV);
    const valoareFaptica = diff > 0 ? round2(led.stocV + diff * pretPlus) : round2(faptic * cmp);
    inv.totalFaptic = round2(inv.totalFaptic + valoareFaptica);
    inv.lines.push(ivLine);
    if (diff === 0) continue;
    if (diff > 0) {
      // plus de inventar: intrare in stoc + 3xx = 758
      const val = plan.valoare;
      addMove(plan.movement);
      if (val > 0) addEntry({ id: db.nextId('e'), firmaId: fid, data, period: data.slice(0, 7), tip: 'inventar_plus', tipNume: 'Plus de inventar', partener: '', partenerCui: '', document: doc, analitic: '', explicatie: 'Plus inventar ' + p.denumire, fileId: null, system: true, lines: [{ debit: cont, credit: '758', suma: val, explicatie: 'Plus de inventar ' + p.cod }] });
      ivLine.valoare = val; inv.totalPlus = round2(inv.totalPlus + val);
      result.plusuri.push({ produs: p.cod, cantitate: diff, valoare: val });
    } else {
      const q = roundQty(-diff);
      const val = plan.valoare;
      addMove(plan.movement);
      if (val > 0) addEntry({ id: db.nextId('e'), firmaId: fid, data, period: data.slice(0, 7), tip: 'inventar_minus', tipNume: 'Minus de inventar (lipsa)', partener: '', partenerCui: '', document: doc, analitic: '', explicatie: 'Lipsă inventar ' + p.denumire, fileId: null, system: true, lines: [{ debit: stocks.cogsAccount(cont), credit: cont, suma: val, explicatie: 'Lipsă la inventar ' + p.cod }] });
      // imputare gestionar: 4282 = 7588 + 4427
      if (ln.imputa && val > 0) {
        const tva = round2((val * tvaRate) / 100);
        addEntry({ id: db.nextId('e'), firmaId: fid, data, period: data.slice(0, 7), tip: 'imputare_lipsa', tipNume: 'Imputare lipsa gestionar', partener: g.gestionar || '', partenerCui: '', document: doc, analitic: '', explicatie: 'Imputare ' + p.denumire + ' catre ' + (g.gestionar || 'gestionar'), fileId: null, system: true, lines: [
          { debit: '4282', credit: '7588', suma: val, explicatie: 'Imputare lipsă ' + p.cod },
          { debit: '4282', credit: '4427', suma: tva, explicatie: 'TVA imputare lipsă ' + p.cod },
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

/** Stornarea append-only a unui inventar: note in rosu + miscari inverse legate de originale. */
function stornoInventory(fid, operator, id, dataStorno) {
  fid = reqFirma(fid);
  const d = db.get();
  const iv = (d.inventories || []).find((x) => x.id === id && x.firmaId === fid);
  if (!iv) fail(404, 'Inventar inexistent.'); // izolare multi-firma
  if (iv.status === 'stornat') fail(400, 'Inventarul este deja stornat.');
  const stornoData = reqDate(dataStorno || new Date().toISOString().slice(0, 10), 'Data stornarii inventarului');
  if (stornoData < iv.data) fail(400, 'Data stornarii nu poate fi anterioara inventarului (' + iv.data + ').');
  db.assertPeriodOpen(fid, stornoData, 'Stornarea inventarului'); // stornul intra intr-o perioada deschisa
  const docStorno = 'Storno inventar ' + iv.gestiuneCod + ' ' + iv.data;
  const stornoEntryIds = []; const stornoMovementIds = [];
  const v = db.scoped(fid); const metoda = stocks.metodaFirma(v);
  const originaleMv = (iv.movementIds || []).map((mid) => (d.stockMovements || []).find((m) => m.id === mid && m.firmaId === fid)).filter(Boolean);
  if (originaleMv.length !== (iv.movementIds || []).length) fail(409, 'Inventarul are legaturi de stoc incomplete si nu poate fi stornat automat.');
  const originaleEntries = (iv.entryIds || []).map((eid) => d.entries.find((e) => e.id === eid && e.firmaId === fid)).filter(Boolean);
  if (originaleEntries.length !== (iv.entryIds || []).length || originaleEntries.some((e) => e.stornat)) {
    fail(409, 'Inventarul are note contabile lipsa/deja stornate si nu poate fi stornat din nou.');
  }
  const reversari = originaleMv.map((m) => {
    const p = v.products.find((x) => x.id === m.productId);
    if (!p) fail(409, 'Produsul miscarii de inventar ' + m.id + ' nu mai exista.');
    const row = stocks.movementRow(p, v.stockMovements, m.id, metoda);
    const q = roundQty(m.tip === 'receptie' ? (row && row.intrareQ) : (row && row.iesireQ));
    const val = round2(m.tip === 'receptie' ? (row && row.intrareV) : (row && row.iesireV));
    if (!(q > 0)) fail(409, 'Miscarea de inventar ' + m.id + ' nu mai are cantitate efectiva de stornat.');
    return {
      id: db.nextId('sm'), firmaId: fid, data: stornoData, productId: m.productId,
      tip: m.tip === 'receptie' ? 'iesire' : 'receptie', gestiuneId: m.gestiuneId,
      gestiuneDestId: null, cantitate: q, pretUnitar: m.tip === 'iesire' ? round2(val / q) : 0,
      valoareContabila: val,
      document: docStorno, furnizor: '', operator: operator || '', system: true,
      inventoryId: iv.id, stornoOfMovementId: m.id,
    };
  });
  // Eliminarea plusurilor/minusurilor originale nu poate face imposibile miscari ulterioare.
  const lipsuriInainte = new Map(stocks.movementShortages(v).map((x) => [x.movementId, x.lipsa]));
  const marcajeVechi = originaleMv.map((m) => ({ stornat: m.stornat, stornoMovementId: m.stornoMovementId }));
  for (let i = 0; i < originaleMv.length; i++) {
    originaleMv[i].stornat = true; originaleMv[i].stornoMovementId = reversari[i].id;
  }
  const proba = Object.assign({}, v, { stockMovements: v.stockMovements.concat(reversari) });
  const lipsaNoua = stocks.movementShortages(proba).find((x) => x.lipsa > (lipsuriInainte.get(x.movementId) || 0));
  for (let i = 0; i < originaleMv.length; i++) {
    if (marcajeVechi[i].stornat === undefined) delete originaleMv[i].stornat;
    else originaleMv[i].stornat = marcajeVechi[i].stornat;
    if (marcajeVechi[i].stornoMovementId === undefined) delete originaleMv[i].stornoMovementId;
    else originaleMv[i].stornoMovementId = marcajeVechi[i].stornoMovementId;
  }
  if (lipsaNoua) fail(409, 'Stornarea inventarului ar lasa fara stoc miscarea ' + lipsaNoua.movementId
    + ' (' + lipsaNoua.denumire + ', lipsa ' + lipsaNoua.lipsa + '). Corecteaza mai intai miscarile ulterioare.');

  // 1) note de stornare IN ROSU: aceleasi conturi, sume negate.
  for (const orig of originaleEntries) {
    const se = {
      id: db.nextId('e'), firmaId: iv.firmaId, data: stornoData, period: String(stornoData).slice(0, 7),
      tip: 'storno_inventar', tipNume: 'Storno ' + orig.tipNume, partener: orig.partener || '', partenerCui: '',
      document: docStorno, analitic: '', explicatie: 'Stornare ' + (orig.explicatie || orig.tipNume), fileId: null, system: true,
      stornoOf: orig.id,
      lines: orig.lines.map((l) => ({ debit: l.debit, credit: l.credit, suma: round2(-l.suma), explicatie: 'Storno ' + (l.explicatie || '') })),
    };
    db.pushEntry(se, { context: 'stornare document de stoc' }); stornoEntryIds.push(se.id);
    orig.stornat = true; orig.stornoBy = se.id; orig.stornoData = stornoData;
  }
  // 2) pastreaza originalele si adauga miscarile inverse; motorul neutralizeaza fiecare pereche.
  for (let i = 0; i < originaleMv.length; i++) {
    originaleMv[i].stornat = true; originaleMv[i].stornoMovementId = reversari[i].id;
    originaleMv[i].stornoData = stornoData; originaleMv[i].valoareContabila = reversari[i].valoareContabila;
    d.stockMovements.push(reversari[i]); stornoMovementIds.push(reversari[i].id);
  }
  iv.status = 'stornat'; iv.stornoData = stornoData; iv.stornoOperator = operator || '';
  iv.stornoEntryIds = stornoEntryIds; iv.stornoMovementIds = stornoMovementIds;
  db.save();
  return { stornoEntries: stornoEntryIds.length, stornoMovements: stornoMovementIds.length, iv };
}

module.exports = {
  reqFirma, upsertProduct, importProducts, deleteProduct, setProductActive,
  upsertGestiune, deleteGestiune,
  addMovement, deleteMovement, postMovement, stornoMovement,
  initialTotals, importInitialStock,
  createInventory, stornoInventory,
  ensureDocSeries, docSeries, updateDocSeries, assignDocNumber, buildDocRegister,
};
