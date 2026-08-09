'use strict';

// Paginare OPTIONALA + plafon de siguranta contra OOM pentru rutele care intorc colectii vii
// din memorie (entries, stock-movements, audit). Graful bazei sta in RAM prin design, deci un
// raspuns nemarginit (colectie mare serializata integral in JSON) ar putea aloca zeci de MB si,
// sub concurenta, sa duca la OOM. Doua regimuri:
//
//  - FARA ?limit: raspuns compatibil (array simplu), dar PLAFONAT la `max` (implicit
//    CONTAB_MAX_ROWS=20000). Peste plafon se intorc ultimele `max` (cele mai recente), cu antetul
//    X-Rows-Truncated=<total> si un avertisment in log — trunchierea e VIZIBILA, nu tacuta, ca
//    sa stim cand un client chiar are nevoie de paginare in UI (semnal real, nu presupunere).
//  - CU ?limit: plic { items, total, offset, limit } — pentru clientii care pagineaza explicit.
//    limit e prins in [1, max]; offset >= 0.

const log = require('./log');
const metrics = require('./metrics');
const ABS_MAX = Number(process.env.CONTAB_MAX_ROWS || 20000);

// ── ZGOMOTUL DE TRUNCHIERE ───────────────────────────────────────────────────────────────────
// O lista peste plafon nu e un EVENIMENT, e o STARE, si de obicei una care tine luni de zile:
// `access:vizitatori` a stat permanent peste 500, deci fiecare deschidere a paginii de
// administrare scria o linie in contab-error.log. Consecinta nu e cosmetica — e pierdere de
// semnal: eroarea reala a garzii de deploy (2026-08-08) statea ingropata intre zeci de linii
// „lista plafonata".
//
// Tiparul e cel de la audit-watch: se avertizeaza la INTRAREA in stare, apoi cel mult o data pe
// fereastra cat timp starea persista, si se RE-ARMEAZA cand lista scade sub plafon — o revenire
// trebuie sa se vada imediat, nu peste o ora. Contorul din metrics creste la FIECARE trunchiere:
// throttle-ul ramane doar pe consola, altfel remediul zgomotului ar deveni tacere.
const TRUNC_WARN_MS = Number(process.env.CONTAB_TRUNC_WARN_MS) || 3600 * 1000;
const trunchiat = new Map(); // eticheta -> momentul ultimei avertizari; absenta = re-armat

/** Trunchiere: numara mereu, avertizeaza rar. Intoarce true daca s-a si scris in jurnal. */
function semnaleazaTrunchiere(label, total, cap, req) {
  const k = String(label || '(fara eticheta)');
  metrics.truncation(k, total, cap);
  const acum = Date.now();
  const ultima = trunchiat.get(k);
  if (ultima != null && acum - ultima < TRUNC_WARN_MS) return false;
  trunchiat.set(k, acum);
  if (log.warn) log.warn('lista plafonata (garda OOM)', log.ctx(req || null, { label: k, total, cap }));
  return true;
}

/** Lista a revenit sub plafon: urmatoarea trunchiere avertizeaza din nou, fara sa astepte fereastra. */
function rearmeazaTrunchiere(label) { trunchiat.delete(String(label || '(fara eticheta)')); }

/** Doar pentru teste: uita starea de avertizare (nu si contoarele din metrics). */
function _resetTrunchieri() { trunchiat.clear(); }

/** Trimite o lista cu paginare optionala si plafon de siguranta. `list` e deja in ordinea dorita. */
function sendList(req, res, list, opts = {}) {
  const max = opts.max || ABS_MAX;
  const total = list.length;
  const rawLimit = req.query ? req.query.limit : undefined;
  if (rawLimit != null && rawLimit !== '') {
    const limit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 0), max);
    const offset = Math.max(0, parseInt((req.query || {}).offset, 10) || 0);
    return res.json({ items: list.slice(offset, offset + limit), total, offset, limit });
  }
  const eticheta = opts.label || (req.path || '');
  if (total > max) {
    semnaleazaTrunchiere(eticheta, total, max, req);
    res.setHeader('X-Rows-Truncated', String(total)); // semnalul PER RASPUNS ramane neatins
    return res.json(list.slice(-max)); // ultimele `max` = cele mai recente
  }
  rearmeazaTrunchiere(eticheta);
  return res.json(list);
}

/**
 * Varianta pentru colectiile expuse ca OBIECT-harta (ex. `/api/partners`, cheie = CUI). Nu se pot
 * pagina ca o lista fara sa schimbe forma raspunsului, deci:
 *  - FARA ?limit: harta, ca pana acum (compatibil), plafonata la `max` chei cu X-Rows-Truncated;
 *  - CU ?limit: plic { items, total, offset, limit } unde `items` e o LISTA ordonata dupa cheie.
 *    O harta PARTIALA ar fi ambigua — clientul n-ar putea distinge „lipseste" de „nu exista".
 * Trunchierea e acceptabila aici fiindca harta alimenteaza o listare, nu o cautare punctuala
 * (partenerul de editat se ia din randul deja afisat).
 */
function sendMap(req, res, map, opts = {}) {
  const max = opts.max || ABS_MAX;
  const src = map || {};
  const keys = Object.keys(src);
  const total = keys.length;
  const rawLimit = req.query ? req.query.limit : undefined;
  if (rawLimit != null && rawLimit !== '') {
    const limit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 0), max);
    const offset = Math.max(0, parseInt((req.query || {}).offset, 10) || 0);
    const ord = keys.slice().sort();
    return res.json({ items: ord.slice(offset, offset + limit).map((k) => src[k]), total, offset, limit });
  }
  const eticheta = (opts.label || (req.path || '')) + ' (harta)';
  if (total > max) {
    semnaleazaTrunchiere(eticheta, total, max, req);
    res.setHeader('X-Rows-Truncated', String(total));
    const out = {};
    for (const k of keys.slice(0, max)) out[k] = src[k];
    return res.json(out);
  }
  rearmeazaTrunchiere(eticheta);
  return res.json(src);
}

/**
 * Plafon PUR (fara raspuns HTTP) pentru colectiile vii care ajung INTR-UN CAMP al raspunsului,
 * nu direct in `res.json` — ex. firul de mesaje din `{ admin, thread }`. Acolo `sendList` nu se
 * poate folosi: ar trimite el raspunsul si ar pierde restul campurilor.
 *
 * Intoarce ULTIMELE `max` elemente (cele mai recente — ce vrea un fir de conversatie), plus
 * totalul real si semnalul de trunchiere. Trunchierea se si LOGHEAZA: unii apelanti folosesc doar
 * `.items` (proiectii interne), iar principiul e ca o taiere sa nu fie niciodata TACUTA — altfel
 * n-am sti cand un client chiar are nevoie de paginare in UI.
 *
 * DIN CE CAPAT SE TAIE — `opts.pastreaza`:
 *  - implicit `'coada'`: lista e append-ordered (audit, firul de mesaje), deci noul e la SFARSIT
 *    si se pastreaza ultimele `max`;
 *  - `'cap'`: lista vine DEJA sortata cu cele mai noi la INCEPUT (vizitatorii si sesiunile din
 *    accessService, sortate descrescator dupa ultima activitate) — acolo `slice(-max)` pastra exact
 *    randurile GRESITE: cele mai vechi, ascunzandu-le pe cele recente. Un jurnal de acces care
 *    ascunde activitatea recenta e inversul scopului lui. Conventia nu se mai ghiceste din forma
 *    listei: apelantul o declara.
 */
function capList(list, max, label, opts) {
  const src = Array.isArray(list) ? list : [];
  // `max` se COERCITEAZA la un numar pozitiv (0/null/undefined = plafonul implicit, conventie
  // folosita de majoritatea apelantilor). Nu e pedanterie: un apel cu argumentele decalate —
  // `capList(lista, { label: 'x' })` — lasa `cap` obiect, iar `total <= cap` compara cu NaN, deci
  // e mereu fals: garda OOM se DEZARMA tacut si fiecare apel raporta o trunchiere inexistenta.
  const n = Number(max);
  const cap = Number.isFinite(n) && n > 0 ? n : ABS_MAX;
  const total = src.length;
  // Re-armarea sta pe calea de iesire TIMPURIE, nu dupa: daca lista scade sub plafon, urmatoarea
  // trunchiere trebuie sa se vada imediat. Fara asta, o revenire ar fi tacuta pana la fereastra.
  if (total <= cap) { rearmeazaTrunchiere(label); return { items: src, total, truncated: false }; }
  semnaleazaTrunchiere(label, total, cap, null);
  const dinCap = !!(opts && opts.pastreaza === 'cap');
  return { items: dinCap ? src.slice(0, cap) : src.slice(-cap), total, truncated: true };
}

module.exports = { sendList, sendMap, capList, ABS_MAX, TRUNC_WARN_MS, _resetTrunchieri };
