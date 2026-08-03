'use strict';

// Modul de productie: dintr-o comanda { produs finit + cantitate + cost, materiale consumate }
// genereaza miscarile de stoc (consum materiale la CMP + receptie produs finit la cost) si
// articolul contabil: consum 6xx = 3xx (la CMP) + obtinere produse finite 345 = 711.
// Functie pura — nu salveaza; rezultatul e aplicat de ruta.

const { round2 } = require('./util');
const { cogsAccount, movementValue } = require('./stocks');

/**
 * @param order { productId, gestiuneId, cantitate, costUnitar, materiale: [{productId, gestiuneId, cantitate}] }
 * @returns { newMovements, lines, costMateriale, valoareObtinuta, warns }
 */
function buildProduction(products, baseMovements, order, opts) {
  const o = opts || {};
  const find = (id) => (products || []).find((x) => x.id === id);
  const newMovements = []; const lines = []; const warns = [];

  // 1) consum materiale (iesire din stoc, la cost mediu ponderat)
  for (const mat of (order.materiale || [])) {
    const p = find(mat.productId);
    if (!p || !(Number(mat.cantitate) > 0)) continue;
    newMovements.push({
      id: o.nextId ? o.nextId('sm') : 'sm-' + (newMovements.length + 1), firmaId: o.fid, data: o.data, tip: 'iesire',
      productId: p.id, gestiuneId: mat.gestiuneId || null, gestiuneDestId: null,
      cantitate: round2(Number(mat.cantitate) || 0), pretUnitar: 0, document: o.document || '', entryId: o.entryId || null, auto: true,
    });
  }
  const consumMovs = newMovements.slice();
  const all = (baseMovements || []).concat(newMovements);
  const byConsum = {}; let costMateriale = 0;
  for (const mv of consumMovs) {
    const p = find(mv.productId);
    const val = round2(movementValue(p, all, mv.id));
    if (val > 0) {
      const cont = p.cont || '301';
      const k = cogsAccount(cont) + '>' + cont;
      byConsum[k] = round2((byConsum[k] || 0) + val);
      costMateriale = round2(costMateriale + val);
    } else {
      warns.push('Stoc insuficient pentru materialul „' + (p.denumire || p.cod || mv.productId) + '" — consum 0.');
    }
  }
  for (const k of Object.keys(byConsum)) {
    const [debit, credit] = k.split('>');
    lines.push({ debit, credit, suma: byConsum[k], explicatie: 'Consum materiale în producție (CMP)' });
  }

  // 2) obtinere produs finit (receptie in stoc, la costul de productie) + 345 = 711
  const fp = find(order.productId);
  if (!fp) throw new Error('Produsul finit este inexistent in nomenclator.');
  const qty = round2(Number(order.cantitate) || 0);
  if (qty <= 0) throw new Error('Cantitatea de produs finit trebuie sa fie > 0.');
  // COSTUL DE PRODUCTIE (OMFP 1802/2014): materiale directe + manopera + regie de productie.
  // Cand nu e dat, se deriva din consumul EFECTIV de materiale — nu se lasa 0.
  //
  // Cu 0, iesea o operatiune care doar distruge valoare, tacut: materialele se consumau
  // (601 = 301), dar articolul `345 = 711` nu se mai emitea deloc (era conditionat de
  // `valoare > 0`), deci consumul ramanea pe cheltuieli fara produsul care sa-l justifice —
  // pierdere artificiala. Mai rau, receptia intra in stoc la pretul 0 si tragea in jos CMP-ul
  // produsului finit pentru totdeauna, contaminand costul tuturor iesirilor urmatoare.
  let costUnitar = round2(Number(order.costUnitar) || 0);
  let costDerivat = false;
  if (costUnitar <= 0) {
    costUnitar = round2(costMateriale / qty);
    costDerivat = costUnitar > 0;
    if (costDerivat) {
      warns.push('Costul unitar nu a fost dat: s-a folosit costul materialelor consumate ('
        + costUnitar + ' lei/unitate). Adauga manopera si regia de productie daca exista.');
    } else {
      warns.push('Costul unitar este 0 si nu s-au consumat materiale: produsul finit intra in stoc la valoare zero.');
    }
  }
  const valoare = round2(qty * costUnitar);
  // Sub costul materialelor, productia ar „pierde" valoare fara explicatie contabila. Nu se
  // blocheaza (exista rebuturi si produse secundare care justifica diferenta), dar se spune.
  if (!costDerivat && costMateriale > 0 && valoare < costMateriale) {
    warns.push('Valoarea produselor obtinute (' + valoare + ' lei) este sub costul materialelor consumate ('
      + costMateriale + ' lei) — diferenta ramane pe cheltuieli. Verifica costul unitar.');
  }
  newMovements.push({
    id: o.nextId ? o.nextId('sm') : 'sm-' + (newMovements.length + 1), firmaId: o.fid, data: o.data, tip: 'receptie',
    productId: fp.id, gestiuneId: order.gestiuneId || null, gestiuneDestId: null,
    cantitate: qty, pretUnitar: costUnitar, document: o.document || '', entryId: o.entryId || null, auto: true,
  });
  if (valoare > 0) lines.push({ debit: (fp.cont || '345'), credit: '711', suma: valoare, explicatie: 'Obținere produse finite la cost de producție' });

  return { newMovements, lines, costMateriale, valoareObtinuta: valoare, warns };
}

/**
 * Dezvolta o reteta/BOM intr-o comanda de productie pentru o cantitate data.
 * Materialele din reteta sunt definite pentru `cantitateBaza` unitati de produs finit;
 * la productie se scaleaza proportional cu factorul = cantitate / cantitateBaza.
 * @returns order pentru buildProduction: { productId, gestiuneId, cantitate, costUnitar, materiale }
 */
function expandRecipe(recipe, cantitate, costUnitar) {
  const baza = Number(recipe.cantitateBaza) > 0 ? Number(recipe.cantitateBaza) : 1;
  const qty = Number(cantitate) > 0 ? Number(cantitate) : baza;
  const factor = qty / baza;
  return {
    productId: recipe.productId,
    gestiuneId: recipe.gestiuneId || null,
    cantitate: round2(qty),
    costUnitar: round2(costUnitar != null && costUnitar !== '' ? Number(costUnitar) : (Number(recipe.costUnitar) || 0)),
    materiale: (recipe.materiale || []).map((m) => ({
      productId: m.productId, gestiuneId: m.gestiuneId || null, cantitate: round2((Number(m.cantitate) || 0) * factor),
    })),
  };
}

/** Situatia productiei pe o perioada: receptiile de produse finite (cont 345) generate din productie. */
function productionReport(db, period) {
  const byId = new Map((db.products || []).map((p) => [p.id, p]));
  const inP = (m) => !period || String(m.data || '').slice(0, 7) === period;
  const rows = (db.stockMovements || [])
    .filter((m) => m.tip === 'receptie' && m.auto && inP(m) && /^34/.test(String((byId.get(m.productId) || {}).cont || '')))
    .map((m) => {
      const p = byId.get(m.productId) || {};
      return { data: m.data, cod: p.cod || '', denumire: p.denumire || '', um: p.um || '', cantitate: round2(m.cantitate), cost: round2(m.pretUnitar), valoare: round2(m.cantitate * m.pretUnitar), document: m.document || '' };
    })
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  return { period, rows, totalValoare: round2(rows.reduce((s, r) => s + r.valoare, 0)), totalCantitate: round2(rows.reduce((s, r) => s + r.cantitate, 0)) };
}

module.exports = { buildProduction, expandRecipe, productionReport };
