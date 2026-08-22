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

const { round2, roundQty, naturalCompare } = require('./util');

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
  const candidate = sortMov(movements.filter((m) => m.productId === product.id && within(m, limit)));
  // Storno in rosu inseamna ca originalul + corectia se anuleaza EXACT. Daca am procesa corectia
  // ca iesire/recepție obisnuita, o receptie retroactiva ar schimba CMP-ul ei si perechea n-ar mai
  // da zero. Pana la data stornarii originalul ramane activ; de la data ei, ambele sunt scoase din
  // calcul, iar in lista de miscari raman pentru audit.
  const anulate = new Set(candidate.filter((m) => m.stornoOfMovementId).map((m) => m.stornoOfMovementId));
  const movs = candidate.filter((m) => !m.stornoOfMovementId && !anulate.has(m.id));
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
      luate.push({ q: roundQty(ia), cost: lot.cost });
      lot.q = roundQty(lot.q - ia);
      ramas = roundQty(ramas - ia);
      if (lot.q <= 0.0000001) s.lots.shift();
    }
    return { v, lots: luate };
  };
  const rows = [];
  for (const m of movs) {
    const c = roundQty(Number(m.cantitate) || 0);
    if (m.tip === 'receptie') {
      const g = gestKey(m); const s = ensure(g);
      const pret = round2(Number(m.pretUnitar) || 0);
      const v = round2(c * pret);
      s.qty = roundQty(s.qty + c); s.value = round2(s.value + v);
      if (c > 0) s.lots.push({ q: c, cost: pret });
      rows.push({ id: m.id, data: m.data, tip: 'receptie', gestiuneId: g, document: m.document || '', intrareQ: c, intrareV: v, iesireQ: 0, iesireV: 0, stocQ: s.qty, cmp: s.qty > 0 ? round2(s.value / s.qty) : 0, stocV: s.value });
    } else if (m.tip === 'transfer') {
      const gs = gestKey(m); const gd = gestKey(m, 'dest');
      const ss = ensure(gs); const sd = ensure(gd);
      const c2 = Math.min(c, ss.qty);
      const d = descarca(ss, c2);
      const v = d.v;
      const cmp = c2 > 0 ? round2(v / c2) : 0; // costul unitar EFECTIV al transferului
      ss.qty = roundQty(ss.qty - c2); ss.value = round2(ss.value - v);
      sd.qty = roundQty(sd.qty + c2); sd.value = round2(sd.value + v);
      // loturile trec cu costurile lor: FIFO ramane FIFO si dupa mutarea intre gestiuni
      for (const l of d.lots) if (l.q > 0) sd.lots.push({ q: l.q, cost: l.cost });
      rows.push({ id: m.id, data: m.data, tip: 'transfer', gestiuneId: gs, gestiuneDestId: gd, document: m.document || '', intrareQ: 0, intrareV: 0, iesireQ: c2, iesireV: v, transferV: v, stocQ: ss.qty, cmp, stocV: ss.value });
    } else { // iesire
      const g = gestKey(m); const s = ensure(g);
      const c2 = Math.min(c, s.qty);
      const v = descarca(s, c2).v;
      const cmp = c2 > 0 ? round2(v / c2) : 0; // costul unitar EFECTIV al iesirii (mediu la CMP, din loturi la FIFO)
      s.qty = roundQty(s.qty - c2); s.value = round2(s.value - v);
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
  for (const g of Object.values(state)) { q = roundQty(q + g.qty); v = round2(v + g.value); }
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
  const lipsuri = new Map(movementShortages(db, period).map((x) => [x.movementId, x]));
  const gname = (id) => (id ? (gById.get(id) || {}).cod || id : '');
  return sortMov((db.stockMovements || []).filter((m) => inPeriod(m, period))).map((m) => {
    const p = byId.get(m.productId) || {};
    const lipsa = lipsuri.get(m.id) || null;
    return Object.assign({}, m, {
      cod: p.cod || '', denumire: p.denumire || '', um: p.um || '',
      gestiuneCod: gname(m.gestiuneId), gestiuneDestCod: gname(m.gestiuneDestId),
      cantitateEfectiva: lipsa ? lipsa.efectiv : roundQty(Number(m.cantitate) || 0),
      lipsa: lipsa ? lipsa.lipsa : 0, stocInsuficient: !!lipsa,
    });
  });
}

/** Situatia aprovizionarilor: receptiile perioadei (fara stocul initial preluat), cu total pe furnizor. */
function situatieAprovizionari(db, period) {
  const byId = new Map((db.products || []).map((p) => [p.id, p]));
  const gById = new Map((db.gestiuni || []).map((g) => [g.id, g]));
  const movById = new Map((db.stockMovements || []).map((m) => [m.id, m]));
  // Corectia unei receptii ramane in situatia lunii de storno cu semn minus; corectia unei
  // iesiri nu se transforma artificial in „aprovizionare” doar fiindca miscarea inversa este o
  // receptie tehnica.
  const rows = sortMov((db.stockMovements || []).filter((m) => {
    if (m.initial || !inPeriod(m, period)) return false;
    const source = m.stornoOfMovementId ? movById.get(m.stornoOfMovementId) : m;
    if (!source || source.auto || source.inventoryId) return false; // productie/plus inventar ≠ aprovizionare
    return source.tip === 'receptie';
  }))
    .map((m) => {
      const original = m.stornoOfMovementId ? movById.get(m.stornoOfMovementId) : null;
      const sursa = original || m; const semn = original ? -1 : 1;
      const p = byId.get(m.productId) || {};
      return {
        data: m.data, furnizor: sursa.furnizor || '(fara furnizor)', document: m.document || '',
        cod: p.cod || '', denumire: p.denumire || '', um: p.um || 'buc',
        gestiune: (gById.get(m.gestiuneId) || {}).cod || '',
        cantitate: roundQty(semn * (Number(m.cantitate) || 0)), pretUnitar: sursa.pretUnitar,
        valoare: round2(semn * (Number(sursa.cantitate) || 0) * (Number(sursa.pretUnitar) || 0)),
        corectie: !!original,
      };
    });
  const perFurnizor = {};
  for (const r of rows) perFurnizor[r.furnizor] = round2((perFurnizor[r.furnizor] || 0) + r.valoare);
  return { period, rows, perFurnizor, total: round2(rows.reduce((s, r) => s + r.valoare, 0)) };
}

/** Situatia consumurilor: iesirile perioadei la metoda firmei, cu sursa (consum manual / vanzare / inventar)
 *  si totaluri pe contul de descarcare (601/602/603/607/608...). */
function situatieConsumuri(db, period) {
  const byId = new Map((db.products || []).map((p) => [p.id, p]));
  const gById = new Map((db.gestiuni || []).map((g) => [g.id, g]));
  const movById = new Map((db.stockMovements || []).map((m) => [m.id, m]));
  const entryById = new Map((db.entries || []).map((e) => [e.id, e]));
  const movs = sortMov((db.stockMovements || []).filter((m) => {
    if (!inPeriod(m, period)) return false;
    if (!m.stornoOfMovementId) return m.tip === 'iesire';
    return (movById.get(m.stornoOfMovementId) || {}).tip === 'iesire';
  }));
  const rows = movs.map((m) => {
    const original = m.stornoOfMovementId ? movById.get(m.stornoOfMovementId) : null;
    const sursa = original || m; const semn = original ? -1 : 1;
    const p = byId.get(m.productId) || {};
    const entry = sursa.entryId ? entryById.get(sursa.entryId) : null;
    const tipSursa = original ? 'storno'
      : sursa.inventoryId ? 'inventar'
        : entry && entry.tip === 'productie' ? 'productie'
          : sursa.auto ? 'vanzare' : 'consum';
    return {
      data: m.data, document: m.document || '', cod: p.cod || '', denumire: p.denumire || '', um: p.um || 'buc',
      gestiune: (gById.get(sursa.gestiuneId) || {}).cod || '', cantitate: roundQty(semn * (Number(m.cantitate) || 0)),
      cont: cogsAccount(p.cont || '371'),
      sursa: tipSursa,
      valoare: round2(semn * movementValue(p, db.stockMovements || [], sursa.id, metodaFirma(db))),
      corectie: !!original,
    };
  });
  const perCont = {};
  for (const r of rows) perCont[r.cont] = round2((perCont[r.cont] || 0) + r.valoare);
  return { period, metoda: metodaFirma(db).toUpperCase(), rows, perCont,
    total: round2(rows.reduce((s, r) => s + r.valoare, 0)) };
}

/** Lista de inventariere pentru o gestiune: stocul scriptic pe fiecare produs la o data. */
function inventoryList(db, gestiuneId, asOf) {
  return (db.products || []).map((p) => {
    const l = productLedger(p, db.stockMovements || [], asOf, gestiuneId, metodaFirma(db));
    return { product: p, scripticQty: l.stocQ, scripticVal: l.stocV, cmp: l.cmp };
  });
}

/** Randul simularii pentru o miscare — valoarea SI cantitatea efectiv miscata. Cantitatea conteaza:
 *  la iesire, `simulate` o plafoneaza la stocul disponibil (`Math.min`), deci ce s-a cerut si ce
 *  s-a descarcat pot sa difere fara ca vreo suma sa arate asta. */
function movementRow(product, movements, movementId, metoda, asOf) {
  const { rows } = simulate(product, movements, asOf || null, metoda);
  return rows.find((r) => r.id === movementId) || null;
}

/** Valoarea contabila a unei miscari (receptie = cant×pret; iesire = la metoda firmei). */
function movementValue(product, movements, movementId, metoda, asOf) {
  const movement = (movements || []).find((m) => m.id === movementId);
  if (movement && asOf && !within(movement, limitOf(asOf))) return 0;
  if (movement && movement.valoareContabila != null && Number.isFinite(Number(movement.valoareContabila))) {
    return round2(Number(movement.valoareContabila));
  }
  let row = movementRow(product, movements, movementId, metoda, asOf);
  // Pentru un original stornat fara valoare persistata (date istorice), refacem fotografia exact
  // pana la pozitia lui cronologica. Simularea curenta elimina deliberat perechea original+storno.
  if (!row && movement && movement.stornat) {
    const cronologic = sortMov((movements || []).filter((m) => m.productId === product.id));
    const index = cronologic.findIndex((m) => m.id === movementId);
    if (index >= 0) row = simulate(product, cronologic.slice(0, index + 1), null, metoda).rows.find((r) => r.id === movementId) || null;
  }
  if (!row) return 0;
  return row.tip === 'receptie' ? row.intrareV : row.iesireV;
}

/**
 * Miscari care au cerut mai mult decat exista in gestiunea sursa. Motorul nu permite stoc
 * negativ si plafoneaza cantitatea efectiva la disponibil; diferenta trebuie insa sa fie
 * VIZIBILA si sa blocheze inchiderea/postarea notei, altfel fisa arata cantitatea ceruta iar
 * contabilitatea descarca doar costul cantitatii gasite.
 */
function movementShortages(db, period) {
  const movements = db.stockMovements || [];
  const metoda = metodaFirma(db);
  const out = [];
  for (const product of (db.products || [])) {
    const rows = simulate(product, movements, null, metoda).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const m of movements) {
      if (m.productId !== product.id || m.tip === 'receptie') continue;
      if (m.stornat || m.stornoOfMovementId) continue; // perechea anulata nu este lipsa de stoc
      if (period && String(m.data || '').slice(0, 7) !== period) continue;
      const row = byId.get(m.id);
      const cerut = roundQty(Number(m.cantitate) || 0);
      const efectiv = roundQty(row ? row.iesireQ : 0);
      const lipsa = roundQty(cerut - efectiv);
      if (lipsa > 0) out.push({
        movementId: m.id, productId: product.id, cod: product.cod || '',
        denumire: product.denumire || product.cod || product.id,
        data: m.data, tip: m.tip, gestiuneId: m.gestiuneId || null,
        cerut, efectiv, lipsa,
      });
    }
  }
  return out.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : naturalCompare(a.movementId, b.movementId)));
}

/**
 * Detecteaza daca inserarea unor miscari retroactive ar schimba valoarea/cantitatea unei iesiri
 * deja fixate intr-o nota contabila sau intr-un inventar. Cartea mare este append-only, deci un
 * astfel de recalcul trebuie facut explicit prin storno + repostare, nu tacit in subregistru.
 */
function valuationDrift(db, newMovements) {
  const additions = Array.isArray(newMovements) ? newMovements.filter(Boolean) : [];
  if (!additions.length) return null;
  const movements = db.stockMovements || [];
  const entryById = new Map((db.entries || []).map((e) => [e.id, e]));
  const metoda = metodaFirma(db);
  const byProduct = new Map();
  for (const m of additions) {
    if (!byProduct.has(m.productId)) byProduct.set(m.productId, []);
    byProduct.get(m.productId).push(m);
  }
  for (const [productId, added] of byProduct) {
    const p = (db.products || []).find((x) => x.id === productId);
    if (!p) continue;
    const primaData = added.reduce((min, m) => !min || m.data < min ? m.data : min, '');
    const fixe = movements.filter((m) => m.productId === productId && m.tip === 'iesire'
      && m.data >= primaData && !m.stornat && !m.stornoOfMovementId
      && ((m.valoareContabila != null && Number.isFinite(Number(m.valoareContabila)))
        || (m.entryId && entryById.has(m.entryId))));
    if (!fixe.length) continue;
    const inainte = new Map(simulate(p, movements, null, metoda).rows.map((r) => [r.id, r]));
    const dupa = new Map(simulate(p, movements.concat(added), null, metoda).rows.map((r) => [r.id, r]));
    const afectata = fixe.find((m) => {
      const r0 = inainte.get(m.id); const r1 = dupa.get(m.id);
      const fix = m.valoareContabila != null && Number.isFinite(Number(m.valoareContabila))
        ? round2(Number(m.valoareContabila)) : round2(r0 ? r0.iesireV : 0);
      return !r1 || roundQty(r1.iesireQ) !== roundQty(Number(m.cantitate) || 0)
        || Math.abs(round2(r1.iesireV) - fix) >= 0.01;
    });
    if (afectata) return { movementId: afectata.id, data: afectata.data, productId };
  }
  return null;
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
      cantitate: roundQty(Number(s.cantitate) || 0), pretUnitar: 0,
      document: o.document || '', entryId: o.entryId || null, auto: true,
    });
  }
  const all = (baseMovements || []).concat(newMovements);
  const byCogs = {}; const warns = []; let total = 0;
  const lipsuri = [];
  for (const mv of newMovements) {
    const p = (products || []).find((x) => x.id === mv.productId);
    const row = movementRow(p, all, mv.id, o.metoda);
    const suma = round2(row ? row.iesireV : 0);
    mv.valoareContabila = suma;
    if (suma > 0) {
      const contStoc = p.cont || '371';
      const k = cogsAccount(contStoc) + '>' + contStoc;
      byCogs[k] = round2((byCogs[k] || 0) + suma);
      total = round2(total + suma);
    }
    // DESCARCAREA PARTIALA trebuie sa se auda. `simulate` plafoneaza iesirea la stocul disponibil
    // (`Math.min`), deci o vanzare de 50 de bucati dintr-un stoc de 10 se inregistra cu costul a
    // 10 si nicio vorba: marja iesea umflata cu costul celor 40 lipsa, iar fisa de magazie ajungea
    // la zero in loc de negativ. Avertismentul de dinainte se declansa DOAR cand nu exista nimic
    // in stoc (suma 0), adica exact cazul in care oricum se vedea ca lipseste ceva.
    const cerut = roundQty(Number(mv.cantitate) || 0);
    const descarcat = roundQty(row ? row.iesireQ : 0);
    const lipsa = roundQty(cerut - descarcat);
    if (lipsa > 0) {
      const nume = p.denumire || p.cod || mv.productId;
      lipsuri.push({ productId: mv.productId, denumire: nume, cerut, descarcat, lipsa });
      warns.push('Stoc insuficient pentru „' + nume + '": s-au descărcat ' + descarcat + ' din '
        + cerut + ' ' + (p.um || 'buc') + ' (lipsă ' + lipsa + '). Costul mărfii vândute e INCOMPLET — '
        + 'verifică recepțiile lipsă înainte de a posta, altfel marja iese umflată.');
    }
  }
  const cogsLines = Object.keys(byCogs).map((k) => {
    const [debit, credit] = k.split('>');
    const met = String(o.metoda || 'cmp').toLowerCase() === 'fifo' ? 'FIFO' : 'CMP';
    return { debit, credit, suma: byCogs[k], explicatie: 'Descărcare gestiune - cost marfă vândută (' + met + ')' };
  });
  return { newMovements, cogsLines, total, warns, lipsuri };
}

module.exports = {
  metodaFirma, productLedger, currentStock, movementsList, sortMov, cogsAccount, movementValue,
  movementRow, movementShortages, valuationDrift, simulate, inventoryList, saleCogs, situatieAprovizionari,
  situatieConsumuri };
