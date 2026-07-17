'use strict';

// Teste pentru integrarea ANAF, fara niciun apel real:
//  1) rezilienta transportului (anafFetch): timeout, retry cu backoff pe erori tranzitorii,
//     fara retry pe POST / cand e interzis explicit — fetch e inlocuit cu un stub;
//  2) masina de stari a poll-ului SPV (anafService.pollSpv/saveRecipisa/extractInvoiceXml) —
//     functiile din src/anaf.js sunt inlocuite cu stub-uri, baza e un fisier temporar. `npm test`.

process.env.CONTAB_ANAF_TIMEOUT_MS = '100';
process.env.CONTAB_ANAF_BACKOFF_MS = '10';
process.env.CONTAB_LOG_LEVEL = 'error'; // fara zgomot de la avertismentele de reincercare
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.CONTAB_DB_DRIVER = 'sqlite'; // ca in restul suitei; calea .sqlite e derivata din CONTAB_DB_FILE
process.env.CONTAB_DB_FILE = process.env.CONTAB_DB_FILE || path.join(os.tmpdir(), 'contab-anaf-' + process.pid + '.json');

const anafMod = require('../src/anaf');
const { anafFetch } = anafMod;

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

  section('Poll SPV (src/anafService.js: pollSpv / saveRecipisa / extractInvoiceXml)');
  const AdmZip = require('adm-zip');
  const db = require('../src/db');
  const svc = require('../src/anafService');
  const d = db.get(); // json driver pe fisier temporar; creeaza baza implicita
  const f1 = d.firme[0];
  f1.anaf = { env: 'test', accessToken: '', autoPoll: false }; // configurata dar NEconectata
  const e1 = { id: 'e1', firmaId: f1.id, document: 'F-001', spv: { index: 'IDX1' } };
  d.entries.push(e1);

  // stub-urile inlocuiesc functiile modulului anaf (anafService tine referinta la modul)
  const spvCalls = { status: [], download: [] };
  let statusScript = async () => ({ stare: 'in prelucrare' });
  anafMod.status = async (cfg, idx) => { spvCalls.status.push(idx); return statusScript(idx); };
  const zipOk = new AdmZip();
  zipOk.addFile('semnatura_F-001.xml', Buffer.from('<Semnatura/>'));
  zipOk.addFile('4000000000_F-001.xml', Buffer.from('<Invoice><ID>F-001</ID></Invoice>'));
  anafMod.download = async (cfg, id) => { spvCalls.download.push(id); return zipOk.toBuffer(); };

  // neconectat: nimic de verificat, nicio cerere
  let pr = await svc.pollSpv();
  ok('neconectat: connected=false, checked=0', pr.connected === false && pr.checked === 0);
  eq('neconectat: zero apeluri de stare', spvCalls.status.length, 0);

  // conectat, dar jobul AUTO respecta optiunea autoPoll a firmei
  f1.anaf.accessToken = 'token-spv';
  pr = await svc.pollSpv({ auto: true });
  ok('auto fara autoPoll: firma e sarita', pr.checked === 0 && spvCalls.status.length === 0);

  // poll manual: factura inca in prelucrare — stare notata, nimic descarcat
  pr = await svc.pollSpv();
  ok('in prelucrare: checked=1, nimic acceptat/descarcat', pr.checked === 1 && pr.accepted === 0 && pr.downloaded === 0);
  ok('in prelucrare: starea e notata pe inregistrare', e1.spv.stare === 'in prelucrare' && !e1.spv.acceptat && !e1.spv.recipisaDocId);

  // acceptata: stare ok + idDescarcare -> recipisa descarcata si atasata ca document
  f1.anaf.autoPoll = true;
  statusScript = async () => ({ stare: 'ok', idDescarcare: 'DL7' });
  const docsBefore = d.documents.length;
  pr = await svc.pollSpv({ auto: true });
  ok('acceptata: checked/accepted/downloaded = 1', pr.checked === 1 && pr.accepted === 1 && pr.downloaded === 1);
  ok('acceptata: spv marcat (acceptat, stare ok, recipisaDocId, recipisaAt)', e1.spv.acceptat === true && e1.spv.stare === 'ok' && e1.spv.recipisaDocId && e1.spv.recipisaAt);
  eq('descarcarea a folosit idDescarcare din stareMesaj', spvCalls.download[0], 'DL7');
  const doc = d.documents.find((x) => x.id === e1.spv.recipisaDocId);
  ok('recipisa e atasata ca document al firmei', doc && doc.firmaId === f1.id && doc.fileName === 'recipisa-F-001.zip');
  const recipisaPath = path.join(db.UPLOAD_DIR, doc.storedName);
  ok('arhiva recipisei e scrisa pe disc', fs.existsSync(recipisaPath));
  eq('un singur document nou', d.documents.length, docsBefore + 1);

  // idempotenta: inregistrarile cu recipisa descarcata nu se mai verifica
  const stBefore = spvCalls.status.length;
  pr = await svc.pollSpv();
  ok('al doilea poll: nimic de verificat, nicio cerere noua', pr.checked === 0 && spvCalls.status.length === stBefore);

  // o eroare pe o factura nu opreste poll-ul celorlalte
  const e2 = { id: 'e2', firmaId: f1.id, document: 'F-002', spv: { index: 'IDX-ERR' } };
  const e3 = { id: 'e3', firmaId: f1.id, document: 'F-003', spv: { index: 'IDX3' } };
  d.entries.push(e2, e3);
  statusScript = async (idx) => { if (idx === 'IDX-ERR') throw new Error('SPV stareMesaj 500'); return { stare: 'in prelucrare' }; };
  pr = await svc.pollSpv();
  ok('eroare pe o factura: poll-ul continua (checked=2)', pr.checked === 2);
  ok('eroarea e notata pe inregistrarea ei', /stareMesaj 500/.test(e2.spv.error || ''));
  ok('urmatoarea factura e totusi verificata', e3.spv.stare === 'in prelucrare' && !e3.spv.error);

  section('Autorizare dublata la nivel de serviciu (reqEntry / reqFirma / demo)');
  const strain = { id: 950, username: 'strain', role: 'user', firme: [] };
  const aErr = async (p) => { try { await p; return null; } catch (e) { return e.status || 500; } };
  eq('inregistrarea altei firme -> 404 (identic cu inexistenta)', await aErr(svc.checkStatus(strain, 'e3')), 404);
  eq('inregistrare inexistenta -> 404', await aErr(svc.sendToSpv(strain, 'nu-exista')), 404);
  eq('recipisa pe inregistrare straina -> 404', await aErr(svc.downloadRecipisa(strain, 'e1')), 404);
  eq('demo nu configureaza SPV -> 403', await aErr(Promise.resolve().then(() => svc.setConfig({ username: 'demo' }, f1.id, { cif: '1' }))), 403);
  eq('config pe firma inexistenta -> 403', await aErr(Promise.resolve().then(() => svc.setConfig({ username: 'x' }, 9999, {}))), 403);
  eq('import e-Factura pe firma inexistenta -> 403', await aErr(Promise.resolve().then(() => svc.importEfactura(9999, { xml: '<Invoice/>' }))), 403);
  // proprietarul trece de garda si opereaza normal
  const owner = { id: 951, username: 'owner', role: 'user', firme: [f1.id] };
  statusScript = async () => ({ stare: 'in prelucrare' });
  const stOwn = await svc.checkStatus(owner, 'e3');
  ok('proprietarul verifica statusul inregistrarii lui', stOwn.spv.stare === 'in prelucrare');

  // extragerea XML-ului din arhiva SPV
  eq('extractInvoiceXml: sare peste fisierul de semnatura', svc.extractInvoiceXml(zipOk.toBuffer()), '<Invoice><ID>F-001</ID></Invoice>');
  const zipSemn = new AdmZip();
  zipSemn.addFile('semnatura_X.xml', Buffer.from('<Semnatura/>'));
  eq('extractInvoiceXml: doar semnatura -> cade inapoi pe ea', svc.extractInvoiceXml(zipSemn.toBuffer()), '<Semnatura/>');
  const zipGol = new AdmZip();
  zipGol.addFile('citeste-ma.txt', Buffer.from('nimic'));
  let exErr = null;
  try { svc.extractInvoiceXml(zipGol.toBuffer()); } catch (e) { exErr = e; }
  ok('extractInvoiceXml: fara XML -> eroare explicita', exErr && /nu contine XML/i.test(exErr.message));

  // curatenie: recipisa de test scrisa in data/uploads + baza temporara
  try { fs.unlinkSync(recipisaPath); } catch (_) { /* ignora */ }
  try { fs.unlinkSync(process.env.CONTAB_DB_FILE); } catch (_) { /* ignora */ }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari trecute, ' + fail + ' esuate.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
