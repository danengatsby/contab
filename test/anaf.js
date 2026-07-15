'use strict';

// Teste pentru rezilienta apelurilor ANAF (anafFetch): timeout, retry cu backoff pe erori
// tranzitorii, fara retry pe POST / cand e interzis explicit. fetch e inlocuit cu un stub —
// niciun apel real catre ANAF. `npm test`.

process.env.CONTAB_ANAF_TIMEOUT_MS = '100';
process.env.CONTAB_ANAF_BACKOFF_MS = '10';
process.env.CONTAB_LOG_LEVEL = 'error'; // fara zgomot de la avertismentele de reincercare

const { anafFetch } = require('../src/anaf');

// Timerul din AbortSignal.timeout e unref-uit: fara un handle activ, Node ar iesi (cod 0!)
// inainte sa expire timeout-ul din testele 'hang'. Interval-ul tine event loop-ul viu;
// process.exit de la final il opreste.
setInterval(() => {}, 1000);

let pass = 0; let fail = 0;
function eq(name, got, exp) {
  if (got === exp) { pass += 1; }
  else { fail += 1; console.error('  ✗ ' + name + ': got ' + JSON.stringify(got) + ', expected ' + JSON.stringify(exp)); }
}
function ok(name, cond) { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + name + ': condition false'); } }
function section(t) { console.log('\n' + t); }

/** Stub de fetch care raspunde dupa un scenariu: lista de 'ok' | numar de status | 'net' | 'hang'. */
function stubFetch(script) {
  const calls = { n: 0 };
  global.fetch = (url, opts) => {
    const step = script[Math.min(calls.n, script.length - 1)];
    calls.n += 1;
    if (step === 'net') return Promise.reject(new TypeError('fetch failed'));
    if (step === 'hang') {
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
      });
    }
    const status = step === 'ok' ? 200 : step;
    return Promise.resolve(new Response('body-' + calls.n, { status }));
  };
  return calls;
}

(async () => {
  section('Rezilienta ANAF (src/anaf.js: anafFetch)');

  // GET: 5xx tranzitoriu, apoi succes
  let calls = stubFetch([500, 'ok']);
  let r = await anafFetch('test GET', 'https://anaf.example/x', {});
  eq('GET: reincearca dupa 500 si reuseste', r.status, 200);
  eq('GET: exact 2 apeluri (1 initial + 1 retry)', calls.n, 2);

  // GET: 429 e tratat ca tranzitoriu
  calls = stubFetch([429, 'ok']);
  r = await anafFetch('test GET', 'https://anaf.example/x', {});
  eq('GET: reincearca dupa 429', r.status, 200);

  // GET: erorile de retea se reincearca; dupa epuizare arunca
  calls = stubFetch(['net', 'net', 'net']);
  let err = null;
  try { await anafFetch('test GET', 'https://anaf.example/x', {}); } catch (e) { err = e; }
  ok('GET: arunca dupa epuizarea reincercarilor', err !== null);
  eq('GET: 3 apeluri (1 initial + 2 retry)', calls.n, 3);
  ok('GET: eroarea pastreaza eticheta apelului', /test GET/.test(err.message));

  // GET: 4xx non-tranzitoriu NU se reincearca — raspunsul se intoarce apelantului
  calls = stubFetch([404, 'ok']);
  r = await anafFetch('test GET', 'https://anaf.example/x', {});
  eq('GET: 404 nu se reincearca (status intors)', r.status, 404);
  eq('GET: un singur apel la 404', calls.n, 1);

  // POST: eroarea de retea NU se reincearca (risc de dubla incarcare)
  calls = stubFetch(['net', 'ok']);
  err = null;
  try { await anafFetch('test POST', 'https://anaf.example/x', { method: 'POST' }); } catch (e) { err = e; }
  ok('POST: arunca fara reincercare la eroare de retea', err !== null);
  eq('POST: un singur apel', calls.n, 1);

  // POST: 5xx se intoarce apelantului fara reincercare
  calls = stubFetch([500, 'ok']);
  r = await anafFetch('test POST', 'https://anaf.example/x', { method: 'POST' });
  eq('POST: 500 intors fara reincercare', r.status, 500);
  eq('POST: un singur apel la 500', calls.n, 1);

  // retryable=false interzice reincercarea chiar si pe GET (cazul SPV /cerere)
  calls = stubFetch([500, 'ok']);
  r = await anafFetch('SPV cerere', 'https://anaf.example/cerere', {}, false);
  eq('retryable=false: 500 intors fara reincercare', r.status, 500);
  eq('retryable=false: un singur apel', calls.n, 1);

  // timeout: cererea care nu raspunde e intrerupta si mesajul e explicit
  calls = stubFetch(['hang']);
  err = null;
  try { await anafFetch('test timeout', 'https://anaf.example/x', { method: 'POST' }); } catch (e) { err = e; }
  ok('timeout: arunca dupa CONTAB_ANAF_TIMEOUT_MS', err !== null);
  ok('timeout: mesaj explicit cu durata', /niciun raspuns de la ANAF in 100 ms/.test(err.message));

  // timeout pe GET: se reincearca, apoi reuseste
  calls = stubFetch(['hang', 'ok']);
  r = await anafFetch('test timeout GET', 'https://anaf.example/x', {});
  eq('timeout GET: reincearca si reuseste', r.status, 200);
  eq('timeout GET: 2 apeluri', calls.n, 2);

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari trecute, ' + fail + ' esuate.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
