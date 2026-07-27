'use strict';

// Memo PER FIRMA pentru raspunsurile scumpe (agregari care trec prin tot graful firmei —
// dashboard-ul e primul si singurul care depaseste pragul de 500 ms, vezi docs/scalare-crestere.md).
//
// Invalidarea are un SINGUR punct de adevar: revizia globala de scriere (`db.dataRev()`), care
// avanseaza la fiecare `db.save()`/restaurare. Deci orice scriere, de oriunde, invalideaza tot
// ce e cachetat — corect PRIN CONSTRUCTIE, fara a inventaria caile de scriere (o cale uitata ar
// insemna cifre contabile invechite afisate ca fiind curente; nu e un risc pe care sa-l acceptam
// in schimbul unei rate de hit mai bune). Invalidarea e globala, cache-ul e per firma: firma
// mare recalculeaza doar cand cineva scrie, nu la fiecare cerere.
//
// A doua dimensiune de validitate e ZIUA: unele agregate depind de „azi" (termenul de 5 zile
// pentru e-Factura), deci o valoare calculata ieri nu mai e valabila azi, chiar fara nicio scriere.
//
// Valoarea intoarsa e PARTAJATA intre cereri — apelantul NU are voie sa o mute; daca are nevoie
// de campuri per utilizator, le suprapune pe o copie (vezi routes/dashboard.js).

const db = require('./db');

const MAX_ENTRIES = 64; // plafon de memorie: cate firme x raport tinem simultan (LRU)
const store = new Map(); // "nume|firmaId" -> { rev, day, value }
let hits = 0;
let misses = 0;

function today() { return new Date().toISOString().slice(0, 10); }

/**
 * Intoarce `{ value, hit }`: valoarea cachetata daca e inca valabila (aceeasi revizie de
 * scriere si aceeasi zi), altfel rezultatul lui `compute()`, memorat.
 * `hit` e expus ca sa poata fi pus intr-un antet de diagnostic (X-*-Cache), ca la X-*-Source.
 */
function memo(name, firmaId, compute) {
  const key = name + '|' + firmaId;
  const rev = db.dataRev();
  const day = today();
  const cur = store.get(key);
  if (cur && cur.rev === rev && cur.day === day) {
    store.delete(key); store.set(key, cur); // LRU: reimprospatarea ordinii la citire
    hits += 1;
    return { value: cur.value, hit: true };
  }
  misses += 1;
  const value = compute();
  store.delete(key); store.set(key, { rev, day, value });
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
  return { value, hit: false };
}

/** Golire explicita (teste; nu e necesara in productie — revizia face invalidarea). */
function clear() { store.clear(); }

/** Stare pentru /api/metrics: cat de mult ajuta cache-ul (rata de hit) si cat ocupa. */
function stats() {
  const total = hits + misses;
  return { entries: store.size, hits, misses, hitRate: total ? Math.round((hits / total) * 100) / 100 : null };
}

module.exports = { memo, clear, stats, MAX_ENTRIES };
