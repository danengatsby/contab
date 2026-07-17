'use strict';

// Verificarea de compromitere a parolei (authlib.breachCheck, HaveIBeenPwned) — k-anonimitate +
// FAIL-OPEN. Stub pe global.fetch: niciun apel real catre HIBP. Invariantul critic: orice
// problema a serviciului extern (retea/timeout/non-200) NU blocheaza autentificarea (intoarce null).

const crypto = require('crypto');
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

  console.log((fail ? '✗ ' : '✓ ') + pass + ' verificari breachCheck trecute, ' + fail + ' esuate.\n');
  process.exit(fail ? 1 : 0);
})();
