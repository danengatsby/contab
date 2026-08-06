'use strict';

// CE COD RULEAZA DE FAPT — starea git a directorului din care porneste procesul.
//
// De ce exista: `/var/www/contab` este SI instalarea de productie. Nu se face checkout dintr-un
// artefact construit altundeva — procesul citeste fisierele direct din arborele de lucru. Doua
// consecinte, ambele tacute pana acum:
//
//   1. RESTARTUL E UN DEPLOY. Orice modificare necomisa din `src/` ajunge in productie la
//      urmatoarea pornire, oricare ar fi motivul ei: `pm2 restart` de rutina, plafonul de memorie
//      atins, un reboot. Pe aceasta instalare pm2 a numarat deja zeci de restarturi, deci nu e
//      un scenariu teoretic.
//   2. `public/` E PUBLICAT INSTANT. Fisierele statice se servesc din arborele de lucru, deci un
//      fisier salvat acolo e live imediat, fara restart si fara commit.
//
// Garda NU blocheaza pornirea, deliberat. Un server de contabilitate care refuza sa porneasca
// fiindca arborele e murdar ar fi exact opusul a ce vrei intr-o urgenta, cand tocmai ai pus o
// corectie pe disc si ai nevoie de proces sus. Semnaleaza, nu opreste.

const { execFile } = require('child_process');
const path = require('path');

// Ramura din care se face deploy. Nu e configurabila printr-o variabila de mediu: e o conventie
// a proiectului (vezi CLAUDE.md, „merge in `main`"), iar un knob ar permite exact devierea pe care
// garda o cauta.
const RAMURA_DEPLOY = 'main';

// Cat timp e valabila o citire. Arborele se poate schimba SUB proces (vezi `public/`), deci starea
// nu se citeste o singura data la pornire; dar nici la fiecare cerere — git costa un subproces.
const TTL_MS = 60 * 1000;

/**
 * Verdictul, PUR — separat de rularea lui git ca sa poata fi verificat sincron, pe iesiri
 * inventate (tiparul lui persistVerdict / lagValues). Toate cele trei intrari pot lipsi.
 *
 * @param ramura     iesirea lui `git rev-parse --abbrev-ref HEAD`, sau null/'' daca n-a mers
 * @param porcelain  iesirea lui `git status --porcelain`: '' = arbore CURAT, `null` = comanda
 *                   N-A PUTUT RULA. Distinctia e esenta acestei functii — vezi mai jos.
 * @param commit     sha scurt, informativ
 * @returns { cunoscut, curat, peRamuraDeDeploy, ramura, commit, nrModificate, modificate[], motiv }
 */
function verdict(ramura, porcelain, commit) {
  // FARA git (deploy dintr-o arhiva, .git sters) nu stim nimic — si asta NU e „curat".
  // Aceeasi distinctie ca la drill-ul de restaurare: „nu pot verifica" nu e „e bine".
  if (!ramura) {
    return {
      cunoscut: false, curat: null, peRamuraDeDeploy: null, ramura: null, commit: null,
      nrModificate: 0, modificate: [], motiv: 'starea git nu se poate citi (nu e un depozit git?)',
    };
  }
  // `git status` A ESUAT (nu a intors sir): ramura si commitul se citesc din fisiere si merg
  // in continuare, dar despre fisierele necomise nu stim NIMIC — si asta nu e „curat".
  //
  // Nu e ipotetic: pe aceasta instalare `.git/index` a ajuns root:600 dupa niste comenzi git
  // rulate ca root, iar procesul (utilizatorul `contab`) primea „Permission denied" la
  // `git status`. Ramura si commitul se citeau corect, deci pornirea raporta senin
  // „main@... (arbore curat)" cu doua fisiere necomise pe disc — exact garda de deploy,
  // dezarmata tacit, fara niciun semn. Aceeasi regula ca la poarta fiscala si la drill-ul de
  // restaurare: „n-am putut verifica" nu e „e bine".
  if (porcelain == null) {
    return {
      cunoscut: false, curat: null, peRamuraDeDeploy: ramura === RAMURA_DEPLOY,
      ramura, commit: commit || null, nrModificate: 0, modificate: [],
      motiv: 'starea fisierelor necomise nu se poate citi (`git status` a esuat — verifica '
        + 'drepturile pe .git pentru utilizatorul care ruleaza procesul)',
    };
  }
  const modificate = String(porcelain || '')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/\s+/g, ' '));
  const peRamuraDeDeploy = ramura === RAMURA_DEPLOY;
  const curat = modificate.length === 0 && peRamuraDeDeploy;
  const motive = [];
  if (!peRamuraDeDeploy) motive.push('HEAD e pe „' + ramura + '", nu pe „' + RAMURA_DEPLOY + '"');
  if (modificate.length) motive.push(modificate.length + ' fisier(e) necomise');
  return {
    cunoscut: true,
    curat,
    peRamuraDeDeploy,
    ramura,
    commit: commit || null,
    nrModificate: modificate.length,
    // lista se pastreaza plafonata: intr-un arbore foarte murdar nu vrem un raspuns imens
    modificate: modificate.slice(0, 20),
    motiv: curat ? null : motive.join('; '),
  };
}

/** Ruleaza o comanda git si intoarce stdout trunchiat, sau **null** la orice esec. NU arunca.
 *  `null`, nu `''`: un esec si o iesire goala inseamna lucruri OPUSE la `git status` — gol =
 *  arbore curat, esec = habar n-avem. Confundate, garda de deploy se dezarmeaza singura. */
function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd].concat(args), { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout || '').trim()));
  });
}

let cache = null;
let cacheAt = 0;
let inZbor = null;

/** Citeste starea (async, cu memo pe TTL). `force` ocoleste memo-ul. */
async function read(opts) {
  const o = opts || {};
  const cwd = o.cwd || path.join(__dirname, '..');
  if (!o.force && cache && Date.now() - cacheAt < TTL_MS) return cache;
  if (inZbor) return inZbor; // doua cereri simultane nu lanseaza doua git-uri
  inZbor = (async () => {
    const [ramura, porcelain, commit] = await Promise.all([
      git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      git(['status', '--porcelain'], cwd),
      git(['rev-parse', '--short', 'HEAD'], cwd),
    ]);
    const v = verdict(ramura, porcelain, commit);
    cache = v; cacheAt = Date.now();
    return v;
  })();
  try { return await inZbor; } finally { inZbor = null; }
}

/** Ultima stare citita, fara sa lanseze git (pentru cai sincrone). Null daca n-a fost citita. */
function last() { return cache; }

/** Doar pentru teste. */
function _resetCache() { cache = null; cacheAt = 0; }

/** Textul de avertizare pentru pornire/log. Null cand nu e nimic de spus. */
function avertisment(v) {
  if (!v || v.curat) return null;
  if (!v.cunoscut) return 'Starea codului nu se poate verifica: ' + v.motiv;
  return 'Rulezi cod care NU e cel din „' + RAMURA_DEPLOY + '": ' + v.motiv
    + '. Un restart (inclusiv unul automat) publica exact ce e pe disc acum'
    + (v.nrModificate ? ' — ' + v.modificate.slice(0, 8).join(', ') : '') + '.';
}

module.exports = { verdict, read, last, avertisment, RAMURA_DEPLOY, TTL_MS, _resetCache };
