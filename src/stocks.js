'use strict';

// Gestiune cantitativ-valorica a stocurilor pe GESTIUNI (depozite), separat per (produs × gestiune).
// Miscari: receptie (intrare), iesire (consum/vanzare) si transfer intre gestiuni.
//
// DOUA METODE DE EVALUARE la iesire, ambele permise de OMFP 1802/2014 pct. 289:
//   'cmp'  — cost mediu ponderat (implicit, comportamentul istoric);
//   'fifo' — primul intrat, primul iesit: iesirile se descarca din LOTURILE cele mai vechi.
// Metoda vine din firma (`metodaEvaluareStoc`) si e SINGURA diferenta de comportament — restul
// motorului (rotunjiri, transferuri, descarcarea integrala) e comun, ca sa nu existe doua
// implementari care pot drifta una fata de alta.
//
// La FIFO starea tine, pe langa {qty,value}, o COADA de loturi [{q,cost}] in ordinea intrarii.
// Invariantul verificat in teste: suma loturilor == qty si suma (q x cost) == value, dupa
// FIECARE miscare. Transferul muta loturile cu costurile lor (nu le omogenizeaza la un cost
// mediu) — altfel FIFO s-ar transforma tacit in CMP la prima mutare intre gestiuni.

const { round2, naturalCompare } = require('./util');

const DEFAULT_GEST = '(fara gestiune)';

/** Metoda de evaluare a iesirilor, din profilul firmei. Implicit CMP (comportamentul istoric):
 *  o firma existenta nu-si schimba evaluarea pentru ca am adaugat noi o optiune. */
function metodaFirma(db) {
  const m = String(((db || {}).company || {}).metodaEvaluareStoc || 'cmp').toLowerCase();
  return m === 'fifo' ? 'fifo' : 'cmp';
}
function gestKey(m, role) { return (role === 'dest' ? m.gestiuneDestId : m.gestiuneId) || DEFAULT_GEST; }
function inPeriod(m, period) { return !period || String(m.data || '').slice(0, 7) === period; }

/** Contul de cheltuiala la iesirea din gestiune (descarcarea de gestiune). */
function cogsAccount(contStoc) {
  const c = String(contStoc || '371');
  if (c === '371') return '607'; // marfuri
  if (c === '301') return '601'; // materii prime
  if (/^302/.test(c)) return '602'; // materiale consumabile
  if (c === '303') return '603'; // obiecte de inventar
  if (c === '381') return '608'; // ambalaje
  if (c === '345') return '711'; // produse finite -> variatia stocurilor
  return '607';
}

function sortMov(list) {
  return [...list].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : naturalCompare(a.id, b.id)));
}

function limitOf(asOf) {
  if (!asOf) return null;
  const s = String(asOf);
  return s.length === 7 ? { v: s, m: true } : { v: s.slice(0, 10), m: false };
}
function within(m, limit) {
  if (!limit) return true;
  return limit.m ? String(m.data).slice(0, 7) <= limit.v : m.data <= limit.v;
}

/**
 * Simuleaza miscarile unui produs pe toate gestiunile (cronologic), mentinand {qty,value} per gestiune.
 * Returneaza randurile (cu gestiunea atinsa) si starea finala per gestiune.
 */
function simulate(product, movements, asOf, metoda) {
  const fifo = String(metoda || 'cmp').toLowerCase() === 'fifo';
  const limit = limitOf(asOf);
  const movs = sortMov(movements.filter((m) => m.productId === product.id && within(m, limit)));
  const state = {}; // gestiuneId -> { qty, value, lots: [{q, cost}] }
  const ensure = (g) => (state[g] = state[g] || { qty: 0, value: 0, lots: [] });

  /** Descarca `c2` bucati din stare si intoarce { v, lots } — valoarea iesita si loturile consumate
   *  (loturile trebuie pastrate pentru transfer, ca destinatia sa primeasca aceleasi costuri).
   *  La descarcarea INTREGULUI stoc se ia valoarea reziduala intreaga: qty=0 <=> value=0 exact,
   *  fara ban fantoma din rotunjire. Regula e comuna ambelor metode. */
  const descarca = (s, c2) => {
    if (c2 >= s.qty) { // integral
      const lots = s.lots.slice(); const v = round2(s.value);
      s.lots = []; return { v, lots };
    }
    if (!fifo) { // CMP: cost unitar mediu
      const cmp = s.qty > 0 ? round2(s.value / s.qty) : 0;
      return { v: round2(c2 * cmp), lots: [{ q: c2, cost: cmp }] };
    }
    // FIFO: se consuma din fata cozii
    let ramas = c2; let v = 0; const luate = [];
    while (ramas > 0.0000001 && s.lots.length) {
      const lot = s.lots[0];
      const ia = Math.min(lot.q, ramas);
      v = round2(v + ia * lot.cost);
      luate.push({ q: round2(ia), cost: lot.cost });
      lot.q = round2(lot.q - ia);
      ramas = round2(ramas - ia);
      if (lot.q <= 0.0000001) s.lots.shift();
    }
    return { v, lots: luate };
  };
  const rows = [];
  for (const m of movs) {
    const c = round2(Number(m.cantitate) || 0);
    if (m.tip === 'receptie') {
      const g = gestKey(m); const s = ensure(g);
      const pret = round2(Number(m.pretUnitar) || 0);
      const v = round2(c * pret);
      s.qty = round2(s.qty + c); s.value = round2(s.value + v);
      if (c > 0) s.lots.push({ q: c, cost: pret });
      rows.push({ id: m.id, data: m.data, tip: 'receptie', gestiuneId: g, document: m.document || '', intrareQ: c, intrareV: v, iesireQ: 0, iesireV: 0, stocQ: s.qty, cmp: s.qty > 0 ? round2(s.value / s.qty) : 0, stocV: s.value });
    } else if (m.tip === 'transfer') {
      const gs = gestKey(m); const gd = gestKey(m, 'dest');
      const ss = ensure(gs); const sd = ensure(gd);
      const c2 = Math.min(c, ss.qty);
      const d = descarca(ss, c2);
      const v = d.v;
      const cmp = c2 > 0 ? round2(v / c2) : 0; // costul unitar EFECTIV al transferului
      ss.qty = round2(ss.qty - c2); ss.value = round2(ss.value - v);
      sd.qty = round2(sd.qty + c2); sd.value = round2(sd.value + v);
      // loturile trec cu costurile lor: FIFO ramane FIFO si dupa mutarea intre gestiuni
      for (const l of d.lots) if (l.q > 0) sd.lots.push({ q: l.q, cost: l.cost });
      rows.push({ id: m.id, data: m.data, tip: 'transfer', gestiuneId: gs, gestiuneDestId: gd, document: m.document || '', intrareQ: 0, intrareV: 0, iesireQ: c2, iesireV: v, transferV: v, stocQ: ss.qty, cmp, stocV: ss.value });
    } else { // iesire
      const g = gestKey(m); const s = ensure(g);
      const c2 = Math.min(c, s.qty);
      const v = descarca(s, c2).v;
      const cmp = c2 > 0 ? round2(v / c2) : 0; // costul unitar EFECTIV al iesirii (mediu la CMP, din loturi la FIFO)
      s.qty = round2(s.qty - c2); s.value = round2(s.value - v);
      rows.push({ id: m.id, data: m.data, tip: 'iesire', gestiuneId: g, document: m.document || '', intrareQ: 0, intrareV: 0, iesireQ: c2, iesireV: v, stocQ: s.qty, cmp, stocV: round2(s.value) });
    }
  }
  return { rows, state };
}

/** Fisa de magazie pentru un produs (optional filtrata pe o gestiune). */
function productLedger(product, movements, asOf, gestiuneId, metoda) {
  const { rows, state } = simulate(product, movements, asOf, metoda);
  // pentru transfer, randul apare la ambele gestiuni implicate
  const visible = gestiuneId
    ? rows.filter((r) => r.gestiuneId === gestiuneId || r.gestiuneDestId === gestiuneId).map((r) => {
      if (r.tip === 'transfer' && r.gestiuneDestId === gestiuneId) {
        return { id: r.id, data: r.data, tip: 'transfer-in', gestiuneId, document: r.document, intrareQ: r.iesireQ, intrareV: r.transferV, iesireQ: 0, iesireV: 0, stocQ: null, cmp: r.cmp, stocV: null };
      }
      return r;
    })
    : rows;
  if (gestiuneId) {
    const s = state[gestiuneId] || { qty: 0, value: 0 };
    return { product, gestiuneId, rows: visible, stocQ: s.qty, stocV: round2(s.value), cmp: s.qty > 0 ? round2(s.value / s.qty) : 0 };
  }
  // fara filtru: total pe produs (toate gestiunile)
  let q = 0; let v = 0;
  for (const g of Object.values(state)) { q = round2(q + g.qty); v = round2(v + g.value); }
  return { product, rows: visible, stocQ: q, stocV: round2(v), cmp: q > 0 ? round2(v / q) : 0, state };
}

/** Stocul curent pe (produs × gestiune) la o data. */
function currentStock(db, asOf, gestiuneId) {
  const movements = db.stockMovements || [];
  const gById = new Map((db.gestiuni || []).map((g) => [g.id, g]));
  const out = [];
  for (const p of (db.products || [])) {
    const { state } = simulate(p, movements, asOf, metodaFirma(db));
    for (const [gid, s] of Object.entries(state)) {
      if (gestiuneId && gid !== gestiuneId) continue;
      if (s.qty === 0 && s.value === 0) continue;
      const g = gById.get(gid) || { id: gid, cod: gid, denumire: gid === DEFAULT_GEST ? DEFAULT_GEST : gid };
      out.push({ product: p, gestiune: g, stocQ: s.qty, stocV: round2(s.value), cmp: s.qty > 0 ? round2(s.value / s.qty) : 0 });
    }
  }
  return out;
}

/** Miscarile dintr-o perioada (sau toate), cu denumirea produsului si a gestiunilor. */
function movementsList(db, period) {
  const byId = new Map((db.products || []).map((p) => [p.id, p]));
  const gById = new Map((db.gestiuni || []).map((g) => [g.id, g]));
  const gname = (id) => (id ? (gById.get(id) || {}).cod || id : '');
  return sortMov((db.stockMovements || []).filter((m) => inPeriod(m, period))).map((m) => {
    const p = byId.get(m.productId) || {};
    return Object.assign({}, m, { cod: p.cod || '', denumire: p.denumire || '', um: p.um || '', gestiuneCod: gname(m.gestiuneId), gestiuneDestCod: gname(m.gestiuneDestId) });
  });
}

/** Situatia aprovizionarilor: receptiile perioadei (fara stocul initial preluat), cu total pe furnizor. */
function situatieAprovizionari(db, period) {
  const byId = new Map((db.products || []).map((p) => [p.id, p]));
  const gById = new Map((db.gestiuni || []).map((g) => [g.id, g]));
  const rows = sortMov((db.stockMovements || []).filter((m) => m.tip === 'receptie' && !m.initial && inPeriod(m, period)))
    .map((m) => {
      const p = byId.get(m.productId) || {};
      return {
        data: m.data, furnizor: m.furnizor || '(fara furnizor)', document: m.document || '',
        cod: p.cod || '', denumire: p.denumire || '', um: p.um || 'buc',
        gestiune: (gById.get(m.gestiuneId) || {}).cod || '', cantitate: m.cantitate, pretUnitar: m.pretUnitar,
        valoare: round2((Number(m.cantitate) || 0) * (Number(m.pretUnitar) || 0)),
      };
    });
  const perFurnizor = {};
  for (const r of rows) perFurnizor[r.furnizor] = round2((perFurnizor[r.furnizor] || 0) + r.valoare);
  return { period, rows, perFurnizor, total: round2(rows.reduce((s, r) => s + r.valoare, 0)) };
}

/** Situatia consumurilor: iesirile perioadei la CMP, cu sursa (consum manual / vanzare / inventar)
 *  si totaluri pe contul de descarcare (601/602/603/607/608...). */
function situatieConsumuri(db, period) {
  const byId = new Map((db.products || []).map((p) => [p.id, p]));
  const gById = new Map((db.gestiuni || []).map((g) => [g.id, g]));
  const movs = sortMov((db.stockMovements || []).filter((m) => m.tip === 'iesire' && inPeriod(m, period)));
  const rows = movs.map((m) => {
    const p = byId.get(m.productId) || {};
    return {
      data: m.data, document: m.document || '', cod: p.cod || '', denumire: p.denumire || '', um: p.um || 'buc',
      gestiune: (gById.get(m.gestiuneId) || {}).cod || '', cantitate: m.cantitate,
      cont: cogsAccount(p.cont || '371'),
      sursa: m.auto ? 'vanzare' : (/inventar/i.test(m.document || '') ? 'inventar' : 'consum'),
      valoare: round2(movementValue(p, db.stockMovements || [], m.id)),
    };
  });
  const perCont = {};
  for (const r of rows) perCont[r.cont] = round2((perCont[r.cont] || 0) + r.valoare);
  return { period, rows, perCont, total: round2(rows.reduce((s, r) => s + r.valoare, 0)) };
}

/** Lista de inventariere pentru o gestiune: stocul scriptic pe fiecare produs la o data. */
function inventoryList(db, gestiuneId, asOf) {
  return (db.products || []).map((p) => {
    const l = productLedger(p, db.stockMovements || [], asOf, gestiuneId, metodaFirma(db));
    return { product: p, scripticQty: l.stocQ, scripticVal: l.stocV, cmp: l.cmp };
  });
}

/** Valoarea contabila a unei miscari (receptie = cant×pret; iesire = la metoda firmei). */
function movementValue(product, movements, movementId, metoda) {
  const { rows } = simulate(product, movements, null, metoda);
  const row = rows.find((r) => r.id === movementId);
  if (!row) return 0;
  return row.tip === 'receptie' ? row.intrareV : row.iesireV;
}

/**
 * Descarcarea de gestiune pentru o vanzare: din liniile {productId, gestiuneId, cantitate}
 * genereaza miscari de IESIRE si calculeaza costul marfii vandute la metoda firmei (`opts.metoda`),
 * grupat pe contul de
 * descarcare (ex. 607=371). Functie PURA — nu salveaza nimic; rezultatul e aplicat de ruta.
 * @returns {{ newMovements, cogsLines, total, warns }}
 */
function saleCogs(products, baseMovements, stocLines, opts) {
  const o = opts || {};
  const lines = (Array.isArray(stocLines) ? stocLines : []).filter((s) => s && s.productId && Number(s.cantitate) > 0);
  const newMovements = [];
  for (const s of lines) {
    const p = (products || []).find((x) => x.id === s.productId);
    if (!p) throw new Error('Produs inexistent in stoc: ' + (s.productId || '?'));
    newMovements.push({
      id: o.nextId ? o.nextId() : 'sm-tmp-' + (newMovements.length + 1),
      firmaId: o.fid, data: o.data, tip: 'iesire',
      productId: p.id, gestiuneId: s.gestiuneId || null, gestiuneDestId: null,
      cantitate: round2(Number(s.cantitate) || 0), pretUnitar: 0,
      document: o.document || '', entryId: o.entryId || null, auto: true,
    });
  }
  const all = (baseMovements || []).concat(newMovements);
  const byCogs = {}; const warns = []; let total = 0;
  for (const mv of newMovements) {
    const p = (products || []).find((x) => x.id === mv.productId);
    const suma = round2(movementValue(p, all, mv.id, o.metoda));
    if (suma > 0) {
      const contStoc = p.cont || '371';
      const k = cogsAccount(contStoc) + '>' + contStoc;
      byCogs[k] = round2((byCogs[k] || 0) + suma);
      total = round2(total + suma);
    } else {
      warns.push('Stoc insuficient pentru „' + (p.denumire || p.cod || mv.productId) + '" — descarcare 0.');
    }
  }
  const cogsLines = Object.keys(byCogs).map((k) => {
    const [debit, credit] = k.split('>');
    const met = String(o.metoda || 'cmp').toLowerCase() === 'fifo' ? 'FIFO' : 'CMP';
    return { debit, credit, suma: byCogs[k], explicatie: 'Descarcare gestiune - cost marfa vanduta (' + met + ')' };
  });
  return { newMovements, cogsLines, total, warns };
}

module.exports = {
  metodaFirma, productLedger, currentStock, movementsList, sortMov, cogsAccount, movementValue, simulate, inventoryList, saleCogs, situatieAprovizionari, situatieConsumuri };
