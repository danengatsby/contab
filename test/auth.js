'use strict';

// Doua probe pe primitivele de autentificare:
//
//  1. breachCheck (HaveIBeenPwned) — k-anonimitate + FAIL-OPEN. Stub pe global.fetch: niciun apel
//     real catre HIBP. Invariantul critic: orice problema a serviciului extern (retea/timeout/
//     non-200) NU blocheaza autentificarea (intoarce null).
//  2. verifyUserPassword — COSTUL constant pe conturi inexistente (anti-enumerare). Se numara
//     invocarile de scryptSync, nu se cronometreaza: o aserttie pe timp ar fi instabila sub
//     incarcarea din CI, pe cand numarul de apeluri e exact marimea care produce diferenta.

const crypto = require('crypto');

// Instrumentarea se face INAINTE de require('../src/auth'), fiindca modulul promisifica
// `crypto.scrypt` la incarcare — promisify captureaza referinta de ATUNCI, iar un patch aplicat
// dupa require n-ar mai fi vazut de varianta asincrona: testul ar numara 0 apeluri si ar raporta
// verde din motivul gresit. (`scryptSync` se cauta ca proprietate la fiecare apel, deci acolo ar
// fi mers si dupa; se instrumenteaza tot aici, ca ambele sa fie tratate la fel.)
let nSync = 0; let nAsync = 0;
const scryptSyncReal = crypto.scryptSync;
const scryptReal = crypto.scrypt;
crypto.scryptSync = function (...a) { nSync += 1; return scryptSyncReal.apply(crypto, a); };
crypto.scrypt = function (...a) { nAsync += 1; return scryptReal.apply(crypto, a); };

const authlib = require('../src/auth');

let pass = 0; let fail = 0;
const ok = (name, cond) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + name); } };
const suffixOf = (pw) => crypto.createHash('sha1').update(pw).digest('hex').toUpperCase().slice(5);

(async () => {
  console.log('breachCheck (HaveIBeenPwned, k-anonimitate + fail-open)');

  // k-anonimitate: se trimite DOAR primele 5 caractere din SHA1 (verificam ce URL primeste fetch)
  let sentUrl = '';
  global.fetch = async (url) => { sentUrl = url; return { ok: true, text: async () => 'ABC:1' }; };
  await authlib.breachCheck('parola-oarecare-123');
  ok('k-anonimitate: se trimite doar prefixul de 5 caractere (range/XXXXX)', /\/range\/[0-9A-F]{5}$/.test(sentUrl));

  // parola COMPROMISA: raspunsul HIBP contine sufixul cu count > 0 -> mesaj de eroare
  const pwBad = 'password123';
  global.fetch = async () => ({ ok: true, text: async () => suffixOf(pwBad) + ':1200\r\n0000000000000000000000000000000000:1' });
  ok('parola compromisa -> mesaj de eroare', /compromise/i.test(await authlib.breachCheck(pwBad) || ''));

  // parola CURATA: sufixul nu apare in raspuns -> null (permisa)
  global.fetch = async () => ({ ok: true, text: async () => 'ABCDEF0123456789ABCDEF0123456789ABC:1' });
  ok('parola curata -> null (permisa)', (await authlib.breachCheck('o-fraza-de-parola-unica-x9!')) === null);

  // FAIL-OPEN: HIBP jos (fetch arunca) -> null, nu blocheaza auth
  global.fetch = async () => { throw new Error('network down'); };
  ok('HIBP indisponibil (fetch arunca) -> null (fail-open)', (await authlib.breachCheck('orice')) === null);

  // FAIL-OPEN: raspuns non-200 -> null
  global.fetch = async () => ({ ok: false, text: async () => '' });
  ok('HIBP non-200 -> null (fail-open)', (await authlib.breachCheck('orice')) === null);

  // ─────────── verifyUserPassword: cost constant, indiferent daca contul exista ───────────
  // Forma naiva `!u || !verifyPassword(...)` sarea peste scrypt cand contul lipsea (~0 ms fata de
  // ~30 ms), deci un 401 identic ca text spunea totusi daca numele exista. Masuram CAUZA, nu
  // simptomul: cate hash-uri se calculeaza pe fiecare ramura.
  console.log('verifyUserPassword (cost constant — anti-enumerare de conturi)');

  const PAROLA = 'parola-de-proba-2026!';
  const contReal = authlib.hashPassword(PAROLA);
  const nrApeluri = (fn) => { nSync = 0; const r = fn(); return { r, n: nSync }; };

  const corect = nrApeluri(() => authlib.verifyUserPassword(contReal, PAROLA));
  ok('cont existent + parola corecta -> true', corect.r === true);
  ok('cont existent: exact un scrypt', corect.n === 1);

  const gresit = nrApeluri(() => authlib.verifyUserPassword(contReal, 'alta-parola'));
  ok('cont existent + parola gresita -> false', gresit.r === false);
  ok('parola gresita: exact un scrypt', gresit.n === 1);

  // MIEZUL: contul inexistent trebuie sa coste la fel. Cu regresia, aici ar fi 0.
  const lipsa = nrApeluri(() => authlib.verifyUserPassword(null, PAROLA));
  ok('cont inexistent -> false', lipsa.r === false);
  ok('cont inexistent: exact un scrypt (nu 0 — altfel timpul enumera conturile)', lipsa.n === 1);
  ok('cont inexistent costa la fel ca unul existent', lipsa.n === corect.n && lipsa.n === gresit.n);

  const nedefinit = nrApeluri(() => authlib.verifyUserPassword(undefined, PAROLA));
  ok('undefined tratat ca inexistent, tot un scrypt', nedefinit.r === false && nedefinit.n === 1);

  // Cont fara credentiale (date corupte / invitatie neacceptata): nu se autentifica NICIODATA,
  // dar consuma acelasi scrypt — altfel ar fi a treia clasa de timp, distincta de primele doua.
  const fost = nrApeluri(() => authlib.verifyUserPassword({ id: 7, username: 'x' }, PAROLA));
  ok('cont fara salt/hash -> false', fost.r === false);
  ok('cont fara salt/hash: tot un scrypt', fost.n === 1);
  const doarSalt = nrApeluri(() => authlib.verifyUserPassword({ id: 8, salt: contReal.salt }, PAROLA));
  ok('cont cu salt dar fara hash -> false, tot un scrypt', doarSalt.r === false && doarSalt.n === 1);

  // ─────────── varianta ASINCRONA: aceleasi garantii, dar fara sa blocheze bucla ───────────
  // E cea folosita pe caile de cerere. Doua lucruri separate de dovedit: (a) pastreaza costul
  // constant, deci nu reintroduce oracolul pe drumul spre performanta; (b) chiar foloseste
  // primitiva ASINCRONA — un `verifyUserPasswordAsync` care ar chema pe dedesubt scryptSync ar
  // trece orice test de comportament si ar bloca bucla exact ca inainte.
  console.log('verifyUserPasswordAsync (cost constant + fara blocarea buclei)');

  const nrAsync = async (fn) => { nSync = 0; nAsync = 0; const r = await fn(); return { r, nA: nAsync, nS: nSync }; };

  const aCorect = await nrAsync(() => authlib.verifyUserPasswordAsync(contReal, PAROLA));
  ok('async: cont existent + parola corecta -> true', aCorect.r === true);
  ok('async: exact un scrypt ASINCRON', aCorect.nA === 1);
  ok('async: ZERO scrypt sincron (altfel bucla ar fi tot blocata)', aCorect.nS === 0);

  const aGresit = await nrAsync(() => authlib.verifyUserPasswordAsync(contReal, 'alta-parola'));
  ok('async: parola gresita -> false, un scrypt asincron', aGresit.r === false && aGresit.nA === 1);

  const aLipsa = await nrAsync(() => authlib.verifyUserPasswordAsync(null, PAROLA));
  ok('async: cont inexistent -> false', aLipsa.r === false);
  ok('async: cont inexistent costa un scrypt, la fel ca unul existent',
    aLipsa.nA === 1 && aLipsa.nA === aCorect.nA && aLipsa.nS === 0);

  const aFara = await nrAsync(() => authlib.verifyUserPasswordAsync({ id: 9, username: 'y' }, PAROLA));
  ok('async: cont fara salt/hash -> false, tot un scrypt', aFara.r === false && aFara.nA === 1);

  // Cele doua variante trebuie sa dea acelasi VERDICT pe aceleasi intrari — altfel una din ele
  // ar fi o poarta mai slaba, iar alegerea intre ele ar deveni o decizie de securitate.
  const cazuri = [[contReal, PAROLA, true], [contReal, 'x', false], [null, PAROLA, false],
    [undefined, PAROLA, false], [{ id: 1 }, PAROLA, false]];
  let divergente = 0;
  for (const [u, pw, asteptat] of cazuri) {
    const s = authlib.verifyUserPassword(u, pw);
    const a = await authlib.verifyUserPasswordAsync(u, pw);
    if (s !== a || s !== asteptat) divergente += 1;
  }
  ok('sincron si asincron dau acelasi verdict pe toate cazurile', divergente === 0);

  console.log((fail ? '✗ ' : '✓ ') + pass + ' verificari auth trecute, ' + fail + ' esuate.\n');
  process.exit(fail ? 1 : 0);
})();
