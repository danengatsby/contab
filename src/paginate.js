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
const ABS_MAX = Number(process.env.CONTAB_MAX_ROWS || 20000);

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
  if (total > max) {
    if (log.warn) log.warn('lista plafonata (garda OOM)', log.ctx(req, { label: opts.label || (req.path || ''), total, cap: max }));
    res.setHeader('X-Rows-Truncated', String(total));
    return res.json(list.slice(-max)); // ultimele `max` = cele mai recente
  }
  return res.json(list);
}

module.exports = { sendList, ABS_MAX };
