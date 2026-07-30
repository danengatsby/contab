'use strict';

// Migrari DB VERSIONATE — pasi ordonati, numerotati, aplicati o singura data si urmariti prin
// `db.schemaVersion`. Ruleaza DUPA `migrate()` din db.js (normalizarea idempotenta de baza =
// "pasul 0", compatibilitatea cu formele vechi). Diferenta fata de migrate(): migrate() ruleaza
// INTEGRAL la fiecare load (idempotent prin re-rulare); aici fiecare pas ruleaza O SINGURA DATA
// (idempotent prin VERSIUNE) si lasa urma in log.
//
// Reguli pentru autorii de migrari:
//  - `v` strict crescator; nu reordona/renumerota pasii deja livrati (schemaVersion din bazele
//    reale se bazeaza pe ei).
//  - `up(d)` muteaza graful in loc si trebuie sa fie IDEMPOTENT si DATA-DRIVEN (sigur si daca
//    ruleaza pe date deja in forma noua sau pe o baza goala): schemaVersion absent e tratat ca 0,
//    deci pe o baza veche se aplica toti pasii in ordine, iar pe una noua sunt no-op-uri.
//  - `up(d)` poate intoarce numarul de inregistrari atinse (pentru urma din log); 0/undefined =
//    nu s-a schimbat nimic, deci nu se logheaza (dar versiunea tot avanseaza).

const log = require('./log');
const { period: periodOf } = require('./util');

const MIGRATIONS = [
  {
    v: 1,
    desc: 'backfill camp `period` pe articolele contabile (derivat din data)',
    up(d) {
      let n = 0;
      for (const e of d.entries || []) {
        if (!e.period && e.data) { e.period = periodOf(e.data); n += 1; }
      }
      return n;
    },
  },
  {
    v: 2,
    desc: 'backfill `createdAt` pe firmele existente (podeaua calendarului fiscal)',
    up(d) {
      // Calendarul fiscal nu cere declaratii pentru luni dinaintea existentei firmei
      // (declarations.primaLunaUrmarita), dar reperul se pune doar la firmele CREATE dupa
      // introducerea campului. Firmele dinainte ramaneau fara reper, deci continuau sa arate
      // restante pentru luni in care nu existau — exact simptomul pentru care s-a facut podeaua.
      //
      // Reper folosit, in ordine: momentul probei (`trialStartedAt`, data reala a crearii pentru
      // firmele inscrise), apoi `since`. Ambele sunt momente in care firma SIGUR exista deja.
      //
      // De ce e sigur si cand reperul e mai TARZIU decat infiintarea reala: podeaua coboara singura
      // la luna celei mai vechi inregistrari, deci o firma cu istoric preluat isi pastreaza
      // restantele adevarate. Se ascund doar cele ale firmelor care n-au NICIO inregistrare —
      // acolo unde aplicatia oricum n-are pe ce sa se sprijine, iar prima inregistrare adaugata
      // coboara imediat podeaua.
      let n = 0;
      for (const f of d.firme || []) {
        if (f.createdAt) continue;
        const s = f.subscription || {};
        const reper = s.trialStartedAt || s.since || '';
        if (!reper) continue; // fara niciun semnal: lasam firma pe comportamentul vechi
        f.createdAt = reper;
        n += 1;
      }
      return n;
    },
  },
];

const LATEST = MIGRATIONS.reduce((m, x) => Math.max(m, x.v), 0);

/**
 * Aplica pasii de migrare cu v > schemaVersion, in ordine, o singura data. Muteaza `d` in loc
 * si actualizeaza `d.schemaVersion`. Forward-only: nu coboara niciodata versiunea (protejeaza o
 * baza mai noua deschisa cu un cod mai vechi).
 * @returns {Array<{v:number, changed:number}>} pasii aplicati (pentru teste/diagnostic)
 */
function runMigrations(d, opts = {}) {
  const logger = opts.log || log;
  // robust la schemaVersion absent/string (unele drivere pot intoarce meta ca text): -> intreg sau 0
  const parsed = parseInt(d.schemaVersion, 10);
  const start = Number.isInteger(parsed) ? parsed : 0;
  let from = start;
  const applied = [];
  for (const m of MIGRATIONS) {
    if (m.v <= from) continue;
    const changed = m.up(d) || 0;
    applied.push({ v: m.v, changed });
    from = m.v;
    if (changed && logger && logger.info) logger.info('migrare DB aplicata', { v: m.v, desc: m.desc, changed });
  }
  d.schemaVersion = Math.max(from, LATEST, start); // forward-only
  return applied;
}

module.exports = { runMigrations, MIGRATIONS, LATEST };
