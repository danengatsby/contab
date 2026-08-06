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

  section('Reconciliere e-Factura primite: serviciu (inbox SPV live stubuit <-> jurnal)');
  f1.cui = '12345678'; f1.anaf = { env: 'test', accessToken: 'tok', cif: '12345678' };
  // cumparari in jurnalul firmei: una importata din SPV (msgId), una manuala de la acelasi furnizor,
  // una de la un furnizor fara facturi in SPV
  d.entries.push(
    { id: 'ci1', firmaId: f1.id, partenerCui: 'RO55500011', partener: 'FURNIZOR SPV SRL', document: 'F1', lines: [{ debit: '371', credit: '401', suma: 1000 }, { debit: '4426', credit: '401', suma: 190 }], spvImport: { msgId: 'sm1' } },
    { id: 'ci2', firmaId: f1.id, partenerCui: '55500011', partener: 'FURNIZOR SPV SRL', document: 'F2', lines: [{ debit: '371', credit: '401', suma: 500 }] },
    { id: 'ci3', firmaId: f1.id, partenerCui: 'RO77700022', partener: 'FARA SPV SRL', document: 'M1', lines: [{ debit: '371', credit: '401', suma: 800 }] },
  );
  // stub pe lista de mesaje SPV (facturi primite): 2 de la furnizorul SPV, 1 de la unul neinregistrat
  anafMod.listMessages = async () => ([
    { id: 'sm1', data_creare: '20260601', cif_emitent: '55500011' }, // deja importata (potrivire exacta pe msgId)
    { id: 'sm2', data_creare: '20260602', cif_emitent: '55500011' }, // ne-importata -> absorbita de cumpararea manuala
    { id: 'sm3', data_creare: '20260603', cif_emitent: '99900033' }, // neinregistrata (fara cumparare de la 99900033)
  ]);
  const eirR = await svc.einvoiceReconciliation(f1.id, 60);
  eq('reconciliere serviciu: 1 factura SPV neinregistrata', eirR.lipsaInJurnal, 1);
  eq('reconciliere serviciu: neinregistrata e sm3 (CIF 99900033)', eirR.neinregistrate[0].msgId + '|' + eirR.neinregistrate[0].cif, 'sm3|99900033');
  ok('reconciliere serviciu: furnizorul SPV e reconciliat (import exact + count)', eirR.furnizori.find((f) => f.cif === '55500011') && eirR.furnizori.find((f) => f.cif === '55500011').lipsa === 0);
  ok('reconciliere serviciu: cumpararea de la 77700022 apare fara corespondent SPV', eirR.faraSpv.some((x) => x.cif === '77700022'));

  // ── Canalul de alerta (src/resend.js) ──
  // Toata plasa de siguranta — arhiva nerestaurabila, drill esuat, fereastra de 5xx, veghea pe
  // memorie — se sprijina pe un singur email. Copia din scripts/backup.js NU verifica raspunsul:
  // un 401 (cheie revocata) sau 403 (domeniu neverificat) trecea drept succes, iar alerta disparea
  // exact cand contai pe ea. sendResend ARUNCA, ca apelantul sa nu confunde „am cerut trimiterea"
  // cu „a plecat".
  section('Alerte: sendResend verifica raspunsul (nu doar il cere)');
  {
    const { sendResend } = require('../src/resend');
    const msg = { from: 'a@x', to: 'b@y', subject: 's', text: 't' };
    const stub = (ok, status, body) => { global.fetch = async () => ({ ok, status, text: async () => body }); };
    const aAruncat = async (fn) => { try { await fn(); return false; } catch (_) { return true; } };

    stub(false, 401, '{"message":"API key is invalid"}');
    ok('401 (cheie revocata) -> arunca', await aAruncat(() => sendResend('k', msg)));
    stub(false, 403, '{"message":"domain not verified"}');
    ok('403 (domeniu neverificat) -> arunca', await aAruncat(() => sendResend('k', msg)));
    stub(true, 200, '{"ok":true}');
    ok('200 fara `id` (contract schimbat) -> arunca', await aAruncat(() => sendResend('k', msg)));
    ok('fara cheie -> arunca', await aAruncat(() => sendResend('', msg)));
    stub(true, 200, '{"id":"abc-123"}');
    ok('200 cu `id` -> trece', !(await aAruncat(() => sendResend('k', msg))));
  }

  // ── Registrul public de contribuabili (verificarea partenerilor) ──────────────
  section('Registru ANAF: verificarea partenerilor (fara apel real)');
  {
    const registru = require('../src/anafRegistru');
    /** Raspuns servit de stub; `corp` poate fi sir (HTML) sau obiect (JSON). */
    const stubReg = (corp, status) => {
      const cereri = [];
      global.fetch = (url, opts) => {
        cereri.push(JSON.parse(opts.body));
        const text = typeof corp === 'string' ? corp : JSON.stringify(corp);
        return Promise.resolve({ ok: (status || 200) < 400, status: status || 200, text: () => Promise.resolve(text) });
      };
      return cereri;
    };
    const gasit = (cui, extra) => Object.assign({
      date_generale: { cui, denumire: 'TEST SRL', adresa: 'Str. Test 1', nrRegCom: 'J40/1/2020', cod_CAEN: '4711', statusRO_e_Factura: true, stare_inregistrare: 'INREGISTRAT' },
      inregistrare_scop_Tva: { scpTVA: true, perioade_TVA: [{ data_inceput_ScpTVA: '2020-01-01' }] },
      inregistrare_RTVAI: { statusTvaIncasare: false },
      stare_inactiv: { statusInactivi: false },
      inregistrare_SplitTVA: { statusSplitTVA: false },
      adresa_sediu_social: { scod_JudetAuto: 'B', sdenumire_Localitate: 'Bucuresti' },
    }, extra || {});

    const cereri = stubReg({ found: [gasit(12345674)], notFound: [999] });
    const r1 = await registru.verifica(['RO12345674', '999']);
    eq('CUI-ul pleaca numeric, fara prefixul RO', cereri[0][0].cui, 12345674);
    ok('cererea poarta si data (starea e „la o data")', /^\d{4}-\d{2}-\d{2}$/.test(cereri[0][0].data));
    eq('gasitul e indexat pe CUI ca sir', Object.keys(r1.gasiti).join(), '12345674');
    eq('negasitele se intorc ca atare', r1.negasite.join(), '999');
    eq('campurile contabile sunt extrase', [r1.gasiti['12345674'].tvaPlatitor, r1.gasiti['12345674'].inactiv, r1.gasiti['12345674'].eFactura].join(), 'true,false,true');
    eq('judetul vine din sediul social', r1.gasiti['12345674'].judet, 'B');

    // Duplicatele nu irosesc din plafonul de 500 pe apel (acelasi CUI cu si fara RO).
    const c2 = stubReg({ found: [], notFound: [] });
    await registru.verifica(['RO12345674', '12345674', ' 12345674 ']);
    eq('CUI-urile duplicate se interogheaza o singura data', c2[0].length, 1);

    // Capcana reala a serviciului: cererea respinsa vine ca HTML cu status 200.
    stubReg('<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>');
    let mesaj = '';
    try { await registru.verifica(['12345674']); } catch (e) { mesaj = e.message; }
    ok('raspunsul HTML nu ajunge la JSON.parse, ci da o eroare explicita', /nu.*JSON|altceva decat JSON/i.test(mesaj));
    ok('mesajul e curatat de etichete HTML', !/</.test(mesaj));

    // Starea „radiat" se citeste din TEXTUL starii, nu dintr-un camp boolean.
    stubReg({ found: [gasit(111, { date_generale: { cui: 111, denumire: 'X', stare_inregistrare: 'RADIERE din data 29.06.2006' } })], notFound: [] });
    const r3 = await registru.verifica(['111']);
    eq('radierea se deduce din starea de inregistrare', r3.gasiti['111'].radiat, true);

    // Sectiunile lipsa nu arunca — serviciul le omite pentru unele forme de organizare.
    stubReg({ found: [{ date_generale: { cui: 222, denumire: 'MINIM SRL' } }], notFound: [] });
    const r4 = await registru.verifica(['222']);
    eq('inregistrarea minima se normalizeaza fara exceptie', r4.gasiti['222'].denumire + '|' + r4.gasiti['222'].tvaPlatitor, 'MINIM SRL|false');

    // Loturile: peste 500 de CUI-uri se sparg in cereri succesive.
    const c5 = stubReg({ found: [], notFound: [] });
    const multe = Array.from({ length: registru.MAX_LOT + 3 }, (_, i) => String(1000000 + i));
    const r5 = await registru.verifica(multe);
    eq('peste plafon se trimit doua loturi', r5.loturi, 2);
    eq('primul lot e plin la limita serviciului', c5[0].length, registru.MAX_LOT);
    eq('al doilea poarta restul', c5[1].length, 3);
  }

  // curatenie: recipisa de test scrisa in data/uploads + baza temporara
  try { fs.unlinkSync(recipisaPath); } catch (_) { /* ignora */ }
  try { fs.unlinkSync(process.env.CONTAB_DB_FILE); } catch (_) { /* ignora */ }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari trecute, ' + fail + ' esuate.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
