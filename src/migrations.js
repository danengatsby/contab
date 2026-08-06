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
  {
    v: 3,
    desc: 'backfill `ownerId` pe firmele existente (proprietarul aproba cererile de acces)',
    up(d) {
      // Accesul se tinea DOAR ca lista `user.firme`, in care toti membrii sunt egali — deci nu
      // exista pe cine intreba cand cineva cere acces la o firma. Proprietarul e cel care a
      // creat-o; pentru firmele de dinainte de camp il deducem din membri.
      //
      // Regula: daca firma are EXACT UN membru non-admin, el e proprietarul (cazul obisnuit —
      // cineva si-a inscris firma). Daca are mai multi, luam pe cel cu id-ul cel mai mic, adica
      // primul cont creat: el a inscris firma, ceilalti au fost adaugati dupa. Daca n-are niciun
      // membru (firma facuta de admin), NU inventam un proprietar — raman cererile pe seama
      // adminului, care are oricum acces la tot.
      let n = 0;
      for (const f of d.firme || []) {
        if (f.ownerId) continue;
        const membri = (d.users || []).filter((u) => u.role !== 'admin' && Array.isArray(u.firme) && u.firme.includes(f.id));
        if (!membri.length) continue;
        f.ownerId = membri.reduce((min, u) => (u.id < min.id ? u : min)).id;
        n += 1;
      }
      return n;
    },
  },
  {
    v: 4,
    desc: 'backfill `tipCont` pe conturi (patron = detine cel putin o firma; restul, contabil)',
    up(d) {
      // Felul contului se alege acum la inscriere, dar conturile de dinainte nu-l au. Se deduce
      // din realitate, nu se ghiceste: cine e proprietarul unei firme e patron; cine nu e, are
      // acces la firmele altora, deci e contabil. Adminul nu intra in clasificare.
      const proprietari = new Set((d.firme || []).map((f) => f.ownerId).filter((x) => x != null));
      let n = 0;
      for (const u of d.users || []) {
        if (u.role === 'admin' || u.tipCont) continue;
        u.tipCont = proprietari.has(u.id) ? 'patron' : 'contabil';
        n += 1;
      }
      return n;
    },
  },
  {
    v: 5,
    desc: 'pierderea fiscala capata VECHIME: harta an -> total cumulat devine lista de vintage-uri',
    up(d) {
      // Art. 31: pierderea se recupereaza in 5 ani (din 2024) sau 7 (inainte), deci termenul se
      // masoara pe VECHIMEA fiecarei pierderi. Vechea forma — `pierdereFiscala[an] = total cumulat`
      // — nu avea varsta, deci nimic nu putea expira.
      //
      // Conversia unui CUMULAT in vintage-uri e imposibila exact: totalul nu spune din ce ani
      // provine. Alegerea deliberata e sa dateze intreaga suma la CEL MAI VECHI an inregistrat.
      // Directia conteaza: asa pierderea expira mai DEVREME decat ar putea in realitate, deci
      // impozitul poate iesi mai mare, niciodata mai mic — iar rezultatul e VIZIBIL in registrul
      // fiscal (`pierderiDetaliu`), unde contabilul il poate corecta. Datarea la anul cel mai
      // RECENT ar fi facut invers: ar fi prelungit tacit pierderi care poate expirasera deja.
      let n = 0;
      for (const f of d.firme || []) {
        if (Array.isArray(f.pierderiFiscale)) continue;   // deja migrata
        const harta = f.pierdereFiscala;
        if (!harta || typeof harta !== 'object') continue;
        const ani = Object.keys(harta).map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
        if (!ani.length) continue;
        const ultimul = ani[ani.length - 1];             // totalul cel mai recent = soldul curent
        const suma = Math.round((Number(harta[ultimul]) || 0) * 100) / 100;
        f.pierderiFiscale = suma > 0 ? [{ an: ani[0], suma, aproximat: true }] : [];
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
