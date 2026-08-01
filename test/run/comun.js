'use strict';

// Helperii si contorul suitei SINCRONE, partajati intre `test/run.js` si partile din `test/run/`.
//
// De ce exista: `test/run.js` a ajuns la ~7.000 de linii intr-un singur domeniu plat, cu 172 de
// sectiuni si sute de legari la nivel superior. Consecinta practica nu e estetica — e ca fiecare
// ramura care adauga un test atinge acelasi loc din acelasi fisier, deci conflictele aditive la
// merge sunt garantate (s-a intamplat de mai multe ori, inclusiv la merge-ul din 2026-08-01).
//
// Spargerea se face GRADUAL si doar pe blocuri care se pot muta fara sa care stare dupa ele.
// Miezul fiscal ramane deocamdata in `test/run.js`: sectiunile lui impart fixture-uri (`v` din
// scopedSeed, inchiderea anuala derivata din el), iar mutarea lor ar cere un refactor de stare —
// exact genul de operatiune in care un test poate disparea in tacere.
//
// CONTORUL e un OBIECT, nu doua numere: `pass`/`fail` trebuie sa fie partajate intre fisiere, iar
// numerele primitive s-ar fi copiat la import, deci fiecare parte si-ar fi numarat propriile
// verificari si totalul ar fi iesit gresit — in jos, adica exact in directia care linisteste.
const path = require('path');

// Radacina DEPOZITULUI, calculata o singura data. Partile traiesc in `test/run/`, deci un
// `path.join(__dirname, '..')` din ele ar indica `test/`, nu radacina. Portile care scaneaza
// sursa ar fi citit un director gresit — si o poarta care nu gaseste fisiere TRECE, nu pica.
// De aceea calea vine de aici, nu din `__dirname`-ul fiecarei parti.
const RADACINA = path.join(__dirname, '..', '..');

const stare = { pass: 0, fail: 0 };

function eq(name, got, exp) {
  const g = typeof got === 'number' ? Math.round(got * 100) / 100 : got;
  if (g === exp) { stare.pass += 1; }
  else { stare.fail += 1; console.error('  ✗ ' + name + ': got ' + JSON.stringify(g) + ', expected ' + JSON.stringify(exp)); }
}
function ok(name, cond) { if (cond) stare.pass += 1; else { stare.fail += 1; console.error('  ✗ ' + name + ': condition false'); } }
function section(t) { console.log('\n' + t); }

/** Echilibrul etichetelor XML. ATENTIE: NU dovedeste escaparea — un `<b>x</b>` injectat dintr-o
 *  denumire de partener e perfect echilibrat. Escaparea se verifica separat (vezi CLAUDE.md). */
function wellFormed(x) {
  const s = String(x).replace(/<\?xml[^>]*\?>/, '');
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g;
  const stack = []; let m;
  while ((m = re.exec(s))) { const [, c, n, , sc] = m; if (sc) continue; if (c) { if (stack.pop() !== n) return false; } else stack.push(n); }
  return stack.length === 0;
}

module.exports = { stare, eq, ok, section, wellFormed, RADACINA };
