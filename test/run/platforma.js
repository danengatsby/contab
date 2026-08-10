'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  PLATFORMA — a treia parte desprinsa din test/run.js (dupa `porti.js` si `servicii.js`).
//
//  Ce intra aici: sectiunile care NU ating miezul fiscal si nu impart fixture-uri cu el —
//  igiena fisierelor, jurnalul de audit durabil, criptarea secretelor, garda anti zip-bomb,
//  restaurabilitatea arhivei, jurnalizarea, politica de parole, handlerul global de erori,
//  bannerul de pornire, rotatia backup-urilor si deduplicarea webhook-ului Stripe.
//
//  De ce, si de ce ASA. `test/run.js` ajunsese la 6.856 de linii — mai mult decat orice modul
//  de productie si de patru ori cat cel mai mare dintre ele. Spargerea continua pe aceeasi
//  regula ca la partile precedente, iar INVARIANTUL e acelasi si se verifica de fiecare data:
//  aceeasi lista de sectiuni, in ACEEASI ORDINE, si acelasi numar de verificari.
//
//  De aici decurge forma fisierului: doua functii, nu una. Sectiunile mutate nu erau alaturate
//  in original — un grup la inceput (dupa SAF-T) si altul spre final (dupa e-Factura) — iar
//  `run.js` le cheama pe fiecare PE POZITIA EI. Un singur bloc ar fi schimbat ordinea, adica
//  exact ce apara invariantul.
//
//  Capcanele deja platite la mutarile precedente, ca sa nu se repete:
//    - caile relative urca un nivel (`../../src/`) — asta esueaza ZGOMOTOS, deci se vede;
//    - `RADACINA` ar indica `test/`, iar o poarta care scaneaza directorul
//      gresit TRECE. De aceea radacina vine din `comun.js` (`RADACINA`);
//    - contorul din `comun.js` e un OBIECT partajat: numere primitive s-ar fi copiat la import
//      si totalul ar fi iesit mai mic.
// ─────────────────────────────────────────────────────────────────────────────

const { eq, ok, section, RADACINA } = require('./comun');

// Dependintele pe care blocurile mutate le luau din scopul lui `run.js`. Se cer AICI, nu se
// primesc ca parametri: `require` intoarce aceeasi instanta (Node o pastreaza in cache), deci
// `db` vede exact aceeasi stare ca in restul suitei — nu o copie. Un parametru ar fi sugerat,
// fals, ca se poate injecta alta baza.
const path = require('path');
const os = require('os');
const fs = require('fs');
const db = require('../../src/db');
const fiscal = require('../../src/fiscal');
const { getType } = require('../../src/documentTypes');

/** Primul grup: igiena fisierelor, sesiune, audit durabil, secrete, zip, backup. */
function platformaFisiere() {
  section('uploadsHygiene — staging orfan + raport de fisiere nereferentiate');
  {
    const uh = require('../../src/uploadsHygiene');
    const fsH = require('fs'); const osH = require('os'); const pathH = require('path');
    const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'uph-'));
    fsH.mkdirSync(pathH.join(dir, '.import-vechi'));
    fsH.writeFileSync(pathH.join(dir, '.import-vechi', 'f.bin'), 'x');
    fsH.mkdirSync(pathH.join(dir, '.import-proaspat'));
    fsH.writeFileSync(pathH.join(dir, 'doc1.pdf'), 'a');
    fsH.writeFileSync(pathH.join(dir, 'orfan.pdf'), 'b');
    // "vechi" = mtime impins in trecut
    const vechi = new Date(Date.now() - 48 * 3600 * 1000);
    fsH.utimesSync(pathH.join(dir, '.import-vechi'), vechi, vechi);
    eq('staging-ul vechi e sters, cel proaspat ramane', uh.sweepStaging(dir), 1);
    ok('directorul proaspat a supravietuit', fsH.existsSync(pathH.join(dir, '.import-proaspat')));
    const rap = uh.orphanReport({ documents: [{ storedName: 'doc1.pdf' }], firme: [], messages: [] }, dir);
    eq('raport: 1 orfan din 2 fisiere (staging-ul nu se numara)', rap.orfane + '/' + rap.total, '1/2');
    fsH.rmSync(dir, { recursive: true, force: true });
  }

  section('sesiune: token FARA sessId respins (fix escaladare prin secret compromis)');
  {
    const session = require('../../src/session');
    const authlibS = require('../../src/auth');
    const dS = db.get();
    const secret = process.env.CONTAB_AUTH_SECRET || dS.settings.authSecret;
    const uid = dS.users[0].id;
    // token forjat sessionless {uid} — semnat CORECT, dar fara sessId
    const fara = authlibS.sign({ uid, exp: Date.now() + 3600000 }, secret);
    const reqFara = { headers: { cookie: 'sid=' + fara } };
    eq('token valid dar FARA sessId -> neautentificat', session.currentUser(reqFara), null);
    // token cu sessId inexistent -> tot respins (sesiune revocata)
    const inv = authlibS.sign({ uid, sessId: 'nu-exista', exp: Date.now() + 3600000 }, secret);
    eq('token cu sessId inexistent -> neautentificat', session.currentUser({ headers: { cookie: 'sid=' + inv } }), null);
  }

  section('auditLog — jurnal DURABIL append-only pe disc');
  {
    const auditLog = require('../../src/auditLog');
    const fsA = require('fs'); const pathA = require('path'); const osA = require('os');
    const prevAuditDir = process.env.CONTAB_AUDIT_DIR;
    process.env.CONTAB_AUDIT_DIR = fsA.mkdtempSync(pathA.join(osA.tmpdir(), 'audit-test-')); // izolat de data/ real
    const rec1 = { id: 1, ts: '2026-07-15T10:00:00.000Z', username: 'u', action: 'test.a', detail: 'x' };
    const rec2 = { id: 2, ts: '2026-07-15T10:01:00.000Z', username: 'u', action: 'test.b', detail: 'y' };
    const rec3 = { id: 3, ts: '2026-08-01T09:00:00.000Z', username: 'v', action: 'test.c', detail: 'z' };
    auditLog.append(rec1); auditLog.append(rec2); auditLog.append(rec3);
    const dir = auditLog.auditDir();
    const iul = pathA.join(dir, 'audit-2026-07.ndjson');
    const aug = pathA.join(dir, 'audit-2026-08.ndjson');
    ok('fisier lunar creat (rotatie pe luna)', fsA.existsSync(iul) && fsA.existsSync(aug));
    const linii = fsA.readFileSync(iul, 'utf8').trim().split('\n');
    eq('append-only: ambele evenimente ale lunii, in ordine', linii.length, 2);
    eq('linia e NDJSON valid, reconstructibila', JSON.parse(linii[0]).action, 'test.a');
    ok('listFiles le vede pe amandoua, noile primele', (() => { const f = auditLog.listFiles(); return f[0] === 'audit-2026-08.ndjson' && f.includes('audit-2026-07.ndjson'); })());
    fsA.rmSync(process.env.CONTAB_AUDIT_DIR, { recursive: true, force: true }); // curatenie (dir izolat)

    // ── ESECUL nu mai are voie sa fie TACUT ──
    // append e best-effort (nu rupe cererea) si avertizeaza o singura data pana la urmatorul succes
    // (nu inunda logul). Corecte separat, tacere completa impreuna: o permisiune stricata dadea o
    // linie in log si apoi nimic. Si nu e o tacere oarecare — plafonul CONTAB_AUDIT_MAX din baza vie
    // e justificat TOCMAI de existenta probei pe disc.
    //
    // Defectul se provoaca prin ENOTDIR (director cerut SUB un fisier), nu prin chmod: chmod nu
    // opreste procesul care ruleaza ca root, deci proba ar fi trecut din motivul gresit exact pe
    // masinile pe care ruleaza aplicatia.
    const metricsA = require('../../src/metrics');
    const inainte = metricsA.auditSnapshot();
    const fisierNuDirector = pathA.join(osA.tmpdir(), 'audit-nu-e-director-' + process.pid);
    fsA.writeFileSync(fisierNuDirector, 'sunt un fisier, nu un director');
    process.env.CONTAB_AUDIT_DIR = pathA.join(fisierNuDirector, 'audit');

    const sonda = auditLog.probeWritable();
    ok('sonda vede ca jurnalul NU se poate scrie', sonda.ok === false && /ENOTDIR|not a directory/i.test(sonda.motiv || ''));
    auditLog.append({ id: 9, ts: '2026-08-01T10:00:00.000Z', username: 'u', action: 'test.esec', detail: '' });
    const dupaEsec = metricsA.auditSnapshot();
    eq('esecul e CONTORIZAT, nu doar logat', dupaEsec.esecuri, inainte.esecuri + 1);
    ok('ultima eroare e retinuta, pentru diagnostic', !!dupaEsec.lastError && !!dupaEsec.lastErrorAt);
    eq('scrierile reusite NU cresc pe esec', dupaEsec.scrise, inainte.scrise);

    // Throttle-ul e pentru CONSOLA, nu pentru contor: al doilea esec consecutiv (care nu mai
    // produce nicio linie in log) trebuie totusi sa se vada in cifre.
    auditLog.append({ id: 10, ts: '2026-08-01T10:01:00.000Z', username: 'u', action: 'test.esec2', detail: '' });
    const dupaAlDoilea = metricsA.auditSnapshot();
    eq('al doilea esec (fara linie noua in log) se contorizeaza si el', dupaAlDoilea.esecuri, inainte.esecuri + 2);
    eq('esecurile consecutive se numara', dupaAlDoilea.esecConsecutive, 2);

    // Revenirea: dupa un succes, sonda si contorul de consecutive se sting.
    process.env.CONTAB_AUDIT_DIR = fsA.mkdtempSync(pathA.join(osA.tmpdir(), 'audit-ok-'));
    ok('sonda confirma revenirea', auditLog.probeWritable().ok === true);
    auditLog.append({ id: 11, ts: '2026-08-01T10:02:00.000Z', username: 'u', action: 'test.ok', detail: '' });
    const dupaRevenire = metricsA.auditSnapshot();
    eq('scrierea reusita se contorizeaza', dupaRevenire.scrise, inainte.scrise + 1);
    eq('esecurile consecutive se reseteaza la succes', dupaRevenire.esecConsecutive, 0);
    ok('totalul de esecuri NU se pierde (ramane pentru raport)', dupaRevenire.esecuri === inainte.esecuri + 2);

    // Sonda verifica FISIERUL lunii curente cand exista, nu doar directorul: esecul real de pe
    // aceasta instalare a fost EACCES pe `open` al fisierului, cu directorul perfect scriibil.
    ok('sonda tinteste fisierul lunii curente, nu doar directorul',
      /audit-\d{4}-\d{2}\.ndjson$/.test(auditLog.fileFor()));

    fsA.rmSync(process.env.CONTAB_AUDIT_DIR, { recursive: true, force: true });
    fsA.unlinkSync(fisierNuDirector);
    if (prevAuditDir === undefined) delete process.env.CONTAB_AUDIT_DIR; else process.env.CONTAB_AUDIT_DIR = prevAuditDir;
  }

  section('secretbox — criptarea secretelor cu cheie externa');
  const sbox = require('../../src/secretbox');
  {
    const K = 'CONTAB_SECRETS_KEY';
    const veche = process.env[K];
    delete process.env[K];
    eq('fara cheie: seal e passthrough', sbox.seal('parola'), 'parola');
    process.env[K] = 'a'.repeat(64);
    const sigilat = sbox.seal('parola-smtp');
    ok('cu cheie: sigilat (enc:v1:...)', sbox.isSealed(sigilat) && sigilat !== 'parola-smtp');
    eq('open intoarce textul original', sbox.open(sigilat), 'parola-smtp');
    eq('valorile in clar trec neatinse prin open', sbox.open('text-vechi'), 'text-vechi');
    eq('sigilarea e idempotenta (nu dubleaza)', sbox.seal(sigilat), sigilat);
    // rotatie: cheia veche ramane acceptata prin CONTAB_SECRETS_KEY_OLD
    process.env.CONTAB_SECRETS_KEY_OLD = process.env[K];
    process.env[K] = 'b'.repeat(64);
    eq('rotatie: secretul sigilat cu cheia veche se deschide', sbox.open(sigilat), 'parola-smtp');
    ok('re-sigilarea foloseste cheia noua', sbox.open(sbox.seal('nou')) === 'nou');
    delete process.env.CONTAB_SECRETS_KEY_OLD;
    ok('fara nicio cheie potrivita: eroare clara, nu text gresit', (() => {
      process.env[K] = 'c'.repeat(64);
      try { sbox.open(sigilat); return false; } catch (e) { return /CONTAB_SECRETS_KEY/.test(e.message); }
    })());
    if (veche === undefined) delete process.env[K]; else process.env[K] = veche;
  }

  section('zipGuard — garda anti zip-bomb la importuri');
  const zipGuard = require('../../src/zipGuard');
  const AdmZipT = require('adm-zip');
  const zOk = new AdmZipT();
  zOk.addFile('firma.json', Buffer.from('{}'));
  ok('arhiva legitima trece garda', !!zipGuard.openGuarded(zOk.toBuffer()).zip);
  const zBomb = new AdmZipT();
  zBomb.addFile('bomb.bin', Buffer.alloc(2 * 1024 * 1024, 0)); // 2MB de zerouri -> raport urias
  ok('zip-bomb (raport de compresie) respins cu 400', (() => {
    try { zipGuard.openGuarded(zBomb.toBuffer(), { maxRatio: 50 }); return false; }
    catch (e) { return e.status === 400 && /suspect/.test(e.message); }
  })());
  const zMany = new AdmZipT();
  for (let i = 0; i < 20; i++) zMany.addFile('f' + i + '.txt', Buffer.from('x'));
  ok('prea multe intrari respins cu 400', (() => {
    try { zipGuard.openGuarded(zMany.toBuffer(), { maxEntries: 10 }); return false; }
    catch (e) { return e.status === 400 && /prea multe/.test(e.message); }
  })());
  ok('fisier peste limita per-intrare respins', (() => {
    try { zipGuard.openGuarded(zBomb.toBuffer(), { maxEntrySize: 1024, maxRatio: 1e9 }); return false; }
    catch (e) { return e.status === 400 && /prea mare/.test(e.message); }
  })());
  ok('buffer corupt respins cu 400 (nu crapa)', (() => {
    try { zipGuard.openGuarded(Buffer.from('nu-e-zip')); return false; }
    catch (e) { return e.status === 400; }
  })());

  section('backup: verificarea restaurabilitatii arhivei');
  const bkp = require('../../src/backup');
  const fsBk = require('fs');
  const zGood = new AdmZipT();
  zGood.addFile('db.json', Buffer.from(JSON.stringify({ firme: [{ id: 1 }], entries: [] })));
  zGood.addFile('contab.sqlite', Buffer.from('sqlite-fals'));
  const tmpZ = path.join(os.tmpdir(), 'bkp-test-' + process.pid + '.zip');
  fsBk.writeFileSync(tmpZ, zGood.toBuffer());
  const vOkB = bkp.verifyArchive(tmpZ);
  ok('arhiva valida: ok cu firmele numarate', vOkB.ok === true && vOkB.firme === 1 && vOkB.sqlite === true);
  const zNoDb = new AdmZipT(); zNoDb.addFile('altceva.txt', Buffer.from('x'));
  fsBk.writeFileSync(tmpZ, zNoDb.toBuffer());
  ok('arhiva fara db.json: respinsa cu motiv', bkp.verifyArchive(tmpZ).ok === false && /db\.json/.test(bkp.verifyArchive(tmpZ).motiv));
  fsBk.writeFileSync(tmpZ, Buffer.from('nu-e-zip'));
  ok('fisier corupt: respins fara crash', bkp.verifyArchive(tmpZ).ok === false);
  fsBk.unlinkSync(tmpZ);

}

/**
 * Al doilea grup: jurnalizare, parole, erori, pornire, rotatia backup-urilor, webhook.
 *
 * `appJs` se PRIMESTE, nu se recalculeaza aici: e concatenarea celor unsprezece module de
 * interfata, construita in `run.js` pentru portile de escapare, iar sectiunea despre viteozator
 * o foloseste ca sa verifice ca `app.js` chiar a delegat vizualizatorul. Recalculata local, lista
 * celor unsprezece nume ar fi existat in doua locuri — si ar fi driftat la primul modul nou.
 */
function platformaProces(ctx) {
  const appJs = (ctx || {}).appJs || '';
  section('Logging structurat (src/log.js)');
  const logger = require('../../src/log');
  ok('log expune info/warn/error/debug + ctx', ['info', 'warn', 'error', 'debug', 'ctx'].every((k) => typeof logger[k] === 'function'));
  const lctx = logger.ctx({ reqId: 'ab12cd34', method: 'POST', originalUrl: '/api/entries', user: { id: 9, username: 'gigel' } }, { status: 500 });
  eq('ctx: reqId din cerere', lctx.reqId, 'ab12cd34');
  eq('ctx: userId din req.user', lctx.userId, 9);
  eq('ctx: username din req.user', lctx.user, 'gigel');
  eq('ctx: ruta', lctx.url, '/api/entries');
  eq('ctx: extra (status) pastrat', lctx.status, 500);
  ok('ctx fara cerere: nu arunca', typeof logger.ctx(null, { job: 'x' }) === 'object');

  section('Config fiscal centralizat & datat (src/fiscalConfig.js)');
  const fconf = require('../../src/fiscalConfig');
  // documentTypes e un director de module: poarta negativa scaneaza toate fisierele lui
  const dtDir = path.join(RADACINA, 'src', 'documentTypes');
  const dtFisiere = fs.readdirSync(dtDir).filter((f) => f.endsWith('.js'));
  // Aparatoarea mutarii: un scanner indreptat catre un director gresit nu gaseste nimic si
  // TRECE. Aici a fost cat pe ce: calea se construia din numele directorului fisierului,
  // care dupa mutare indica `test/`, nu radacina.
  ok('perimetrul scanat chiar exista (documentTypes)', dtFisiere.length > 5);
  const dtSrc = dtFisiere
    .map((f) => require('fs').readFileSync(require('path').join(dtDir, f), 'utf8')).join('\n');
  ok('fiscalConfig are AN si DATA_ACTUALIZARE', typeof fconf.AN === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(fconf.DATA_ACTUALIZARE));
  eq('FISCAL provine din fiscalConfig.RATES (sursa unica) — cas', fiscal.FISCAL.cas, fconf.RATES.cas);
  eq('FISCAL provine din fiscalConfig.RATES — tvaStandard', fiscal.FISCAL.tvaStandard, fconf.RATES.tvaStandard);
  eq('anul FISCAL == fiscalConfig.AN', fiscal.FISCAL.an, fconf.AN);
  // bug reparat: taxePfa fara salariuMinim explicit nu mai da NaN (folosea FISCAL.salariuMinim inexistent)
  const pfaCfg = fiscal.taxePfa(120000, { period: '2026-03' });
  ok('taxePfa fara salariuMinim explicit: valori finite (nu NaN)', Number.isFinite(pfaCfg.cas) && Number.isFinite(pfaCfg.cass) && Number.isFinite(pfaCfg.impozit));
  eq('taxePfa: salariul minim implicit = S1 (martie)', pfaCfg.salariuMinim, fconf.RATES.salariuMinimS1);
  // tipul „import vamal" isi ia cota TVA din config, nu dintr-un 21 hardcodat
  const vam = getType('import_vamal');
  eq('import vamal: cota TVA implicita = tvaStandard', (vam.fields.find((f) => f.name === 'cota') || {}).default, fiscal.FISCAL.tvaStandard);
  // poarta negativa: TVA-ul standard nu mai e hardcodat ca 21 in documentTypes
  ok('documentTypes: fara cota TVA hardcodata (default: 21 / || 21)', !/default: 21\b/.test(dtSrc) && !/\|\| 21\)/.test(dtSrc));
  // ...si generalizarea ei: NICIO cota din fiscalConfig nu are voie sa apara ca numar scris de mana.
  // Varianta de mai sus era ancorata pe valoarea 21, deci vedea doar TVA-ul standard: masurat, doua
  // cote de impozit pe venit (art. 78) stateau hardcodate ca `default: 10` si `d.cota || 10`, adica
  // exact tiparul pe care poarta il prinde pentru 21. Lista de cote se DERIVA din fiscalConfig, deci
  // nu drifteaza cand se adauga una noua sau se schimba o valoare.
  {
    const valori = new Set(Object.keys(fconf.RATES)
      .filter((k) => /^(tva|impozit|cas|cass|cam|protocol|social|auto|sponsorizare|dobanzi)/i.test(k))
      .map((k) => Number(fconf.RATES[k]))
      .filter((v) => Number.isFinite(v) && v > 0 && v <= 100 && Number.isInteger(v)));
    const hard = [];
    for (const f of require('fs').readdirSync(dtDir).filter((x) => x.endsWith('.js'))) {
      const src = require('fs').readFileSync(require('path').join(dtDir, f), 'utf8');
      src.split('\n').forEach((ln, i) => {
        // Linia trebuie sa fie DESPRE o cota. Fara conditia asta, regula raporta
        // `const durata = Number(d.durata) || 5` (ani de ajustare la bunuri de capital, art. 305)
        // doar fiindca 5 coincide cu cota redusa de TVA — un numar nu e o cota prin valoarea lui,
        // ci prin ce denumeste.
        if (!/\b(cota|pct|procent|rate)\b/i.test(ln)) return;
        // pozitiile in care un numar chiar E o cota: valoarea implicita a campului sau rezerva din `||`
        for (const m of ln.matchAll(/(?:default:\s*|\|\|\s*)(\d{1,2})\b/g)) {
          if (valori.has(Number(m[1]))) hard.push(f + ':' + (i + 1) + ' → ' + ln.trim().slice(0, 70));
        }
      });
    }
    ok('documentTypes: nicio cota din fiscalConfig scrisa de mana'
      + (hard.length ? ' — ' + hard.slice(0, 3).join(' | ') : ''), hard.length === 0);
    ok('poarta isi ia cotele din fiscalConfig, nu dintr-o lista scrisa de mana',
      valori.has(Number(fconf.RATES.tvaStandard)) && valori.has(Number(fconf.RATES.impozitVenit)) && valori.size >= 4);
  }

  section('Modularizare frontend: vizualizator documente (Etapa 8, public/viewer.js)');
  const viewerJs = fs.readFileSync(path.join(RADACINA, 'public', 'viewer.js'), 'utf8');
  ok('viewer.js importa $ si toast din core.js', /import \{[^}]*\btoast\b[^}]*\} from '\.\/core\.js'/.test(viewerJs));
  ok('viewer.js contine functiile vizualizatorului', /function openViewer\b/.test(viewerJs) && /function renderEfactura\b/.test(viewerJs) && /function openXmlViewer\b/.test(viewerJs));
  ok('viewer.js intercepteaza click-urile pe link-uri (/pdf, /csv, /xml)', /addEventListener\('click'/.test(viewerJs) && /efactura/.test(viewerJs) && /openXmlViewer\(/.test(viewerJs));
  ok('app.js importa viewer.js (efect secundar)', /import '\.\/viewer\.js'/.test(appJs));
  ok('app.js NU mai defineste vizualizatorul (mutat in viewer.js)', !/function openViewer\b/.test(appJs) && !/function renderEfactura\b/.test(appJs));

  section('Politica de parole (validatePassword)');
  const authlib = require('../../src/auth');
  ok('parola de 8+ caractere e acceptata', authlib.validatePassword('parolabuna1') === null);
  ok('parola prea scurta e respinsa', /prea scurta/i.test(authlib.validatePassword('scurt1') || ''));
  ok('parola comuna „password" e respinsa', /prea comuna/i.test(authlib.validatePassword('password') || ''));
  ok('parola implicita „admin" e respinsa (prea scurta sau comuna)', authlib.validatePassword('admin') !== null);
  ok('parola = utilizator e respinsa', /identica cu numele/i.test(authlib.validatePassword('gigelgigel', { username: 'gigelgigel' }) || ''));
  ok('parola diferita de utilizator trece', authlib.validatePassword('altaparola9', { username: 'gigel' }) === null);

  section('Nume de utilizator: normalizare si regula unica de duplicat');
  // Numele apare in listele de utilizatori, in jurnalul de audit si in portofoliu. Nu era validat
  // pe caractere nicaieri, iar cele DOUA cai de creare aveau reguli diferite: inscrierea publica
  // verifica duplicatele insensibil la litere mari/mici, iar calea de admin SENSIBIL si fara trim —
  // deci putea lasa sa coexiste „ana", „Ana" si „ana ", conturi care arata identic pe ecran.
  eq('spatiile de la capete se scot', authlib.normalizeUsername('  ana  '), 'ana');
  eq('sirurile de spatii interioare se strang', authlib.normalizeUsername('a  n   a'), 'a n a');
  eq('null nu arunca', authlib.normalizeUsername(null), '');
  ok('numele obisnuit e acceptat', authlib.validateUsername('gigel') === null);
  ok('numele cu spatiu simplu e acceptat', authlib.validateUsername('Ana Maria') === null);
  ok('diacriticele romanesti sunt acceptate', authlib.validateUsername('Ștefan Ioniță') === null);
  ok('numele prea scurt e respins', /prea scurt/i.test(authlib.validateUsername('ab') || ''));
  ok('numele prea lung e respins', /prea lung/i.test(authlib.validateUsername('x'.repeat(70)) || ''));
  // caractere care fac doua nume sa arate IDENTIC pe ecran fara sa fie egale
  ok('zero-width space e respins', authlib.validateUsername('an​a') !== null);
  ok('marcajul bidirectional (RLO) e respins', authlib.validateUsername('an‮a') !== null);
  ok('caracterul NUL e respins', authlib.validateUsername('an a') !== null);
  // BOM si TAB sunt in clasa \s a JS, deci normalizarea ii transforma intr-un spatiu VIZIBIL
  // inainte de verificare — mascarea dispare oricum, doar pe alta cale decat respingerea.
  eq('BOM-ul devine spatiu vizibil, nu ramane invizibil', authlib.normalizeUsername('an\ufeffa'), 'an a');
  eq('TAB-ul devine spatiu vizibil', authlib.normalizeUsername('an\ta'), 'an a');
  // duplicatele: aceeasi regula, indiferent de calea de creare
  const uLista = [{ username: 'admin' }, { username: 'Ana Maria' }];
  ok('duplicat exact', authlib.usernameTaken(uLista, 'admin'));
  ok('duplicat cu litere mari', authlib.usernameTaken(uLista, 'ADMIN'));
  ok('duplicat cu spatii la capete', authlib.usernameTaken(uLista, '  admin '));
  ok('duplicat cu spatii interioare in plus', authlib.usernameTaken(uLista, 'Ana  Maria'));
  ok('un nume nou nu e duplicat', !authlib.usernameTaken(uLista, 'altcineva'));
  ok('lista goala nu arunca', !authlib.usernameTaken(null, 'oricine'));
  // regula se aplica DOAR la creare: un nume deja existent care n-ar mai trece azi ramane valid
  ok('un nume vechi invalid azi e totusi gasit ca duplicat', authlib.usernameTaken([{ username: 'ab' }], 'ab'));

  section('Handlerul global de erori (src/serverErrors.js)');
  // Ultimul modul din src/ ramas fara nicio verificare. E plasa de siguranta: decide ce vede
  // CLIENTUL cand ceva crapa. O regresie aici scurge mesaje interne (interogari, cai de fisier,
  // stack) catre oricine trimite o cerere care esueaza — si se observa greu, fiindca aplicatia
  // „merge" mai departe.
  const serverErrors = require('../../src/serverErrors');
  let errHandler = null;
  serverErrors.installErrorHandler({ use: (fn) => { errHandler = fn; } });
  ok('handlerul se inregistreaza ca middleware de erori (4 argumente)', typeof errHandler === 'function' && errHandler.length === 4);
  const fakeRes = () => {
    const r = { code: 0, body: null, headersSent: false };
    r.status = (c) => { r.code = c; return r; };
    r.json = (bd) => { r.body = bd; return r; };
    return r;
  };
  const fakeReq = (x) => Object.assign({ method: 'GET', originalUrl: '/api/ceva', reqId: 'abc12345' }, x || {});
  // logarea 5xx scrie pe stderr; o tacem doar pe durata acestor verificari, ca sa nu polueze suita
  const errPrev = console.error; const writePrev = process.stderr.write.bind(process.stderr);
  console.error = () => {}; process.stderr.write = () => true;
  const r500 = fakeRes();
  const eIntern = new Error('SELECT parola FROM users WHERE id=1 a esuat la /var/www/contab/data/db.json');
  errHandler(eIntern, fakeReq(), r500, () => {});
  const r400 = fakeRes();
  errHandler(Object.assign(new Error('Completeaza cel putin o suma.'), { status: 400 }), fakeReq(), r400, () => {});
  const rCode = fakeRes();
  errHandler(Object.assign(new Error('Interzis.'), { statusCode: 403 }), fakeReq(), rCode, () => {});
  let nextPrimit = null;
  const rSent = fakeRes(); rSent.headersSent = true;
  errHandler(eIntern, fakeReq(), rSent, (e) => { nextPrimit = e; });
  console.error = errPrev; process.stderr.write = writePrev;

  const body500 = JSON.stringify(r500.body || {});
  eq('eroarea fara status devine 500', r500.code, 500);
  ok('5xx NU scurge mesajul intern catre client', !body500.includes('SELECT') && !body500.includes('parola'));
  ok('5xx NU scurge cai de fisier de pe server', !body500.includes('/var/www'));
  ok('5xx NU trimite stack-ul', !body500.includes(' at ') && !body500.includes('.js:'));
  ok('5xx da un mesaj generic, util utilizatorului', /eroare interna/i.test((r500.body || {}).error || ''));
  eq('5xx include reqId, ca eroarea sa poata fi corelata cu logul', (r500.body || {}).reqId, 'abc12345');
  // 4xx sunt erori de BUSINESS: mesajul e scris pentru utilizator si trebuie sa ajunga la el
  eq('4xx pastreaza statusul', r400.code, 400);
  eq('4xx pastreaza mesajul de business', (r400.body || {}).error, 'Completeaza cel putin o suma.');
  ok('4xx NU include reqId (nu e un incident de server)', (r400.body || {}).reqId === undefined);
  eq('statusCode e onorat, nu doar status', rCode.code, 403);
  eq('4xx prin statusCode isi pastreaza mesajul', (rCode.body || {}).error, 'Interzis.');
  // daca raspunsul a plecat deja (ex. un export in flux), handlerul nu mai scrie peste el
  ok('cu antetele deja trimise, eroarea urca la Express', nextPrimit === eIntern);
  eq('cu antetele deja trimise nu se scrie un al doilea raspuns', rSent.code, 0);

  section('Banner de pornire: adresele afisate (src/lifecycle.js)');
  // Banner-ul enumera interfetele publice; daca o face si cand serverul e legat la loopback,
  // spune ceva NEADEVARAT — un „Retea: http://<ip-public>:8080" care nu raspunde (endpointul
  // public e nginx). Cine citeste logul trage concluzii gresite despre ce e expus.
  const { bannerUrls } = require('../../src/lifecycle');
  const ifTest = { eth0: [{ family: 'IPv4', address: '203.0.113.7', internal: false }], lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] };
  const bLoop = bannerUrls('127.0.0.1', 8080, ifTest);
  eq('legat la loopback: doar adresa locala', bLoop.length, 1);
  ok('legat la loopback NU se anunta interfata publica', !bLoop.join(' ').includes('203.0.113.7'));
  ok('adresa locala e mereu afisata', bLoop[0].includes('http://localhost:8080'));
  eq('„localhost" e tratat tot ca loopback', bannerUrls('localhost', 8080, ifTest).length, 1);
  eq('IPv6 loopback e tratat la fel', bannerUrls('::1', 8080, ifTest).length, 1);
  // legat pe toate interfetele: atunci anuntul e corect si util
  const bAll = bannerUrls('0.0.0.0', 8080, ifTest);
  eq('legat pe toate interfetele: local + retea', bAll.length, 2);
  ok('se anunta interfata publica reala', bAll.join(' ').includes('http://203.0.113.7:8080'));
  ok('interfetele interne nu se anunta ca „retea"', !bAll.slice(1).join(' ').includes('127.0.0.1'));
  eq('fara interfete nu arunca', bannerUrls('0.0.0.0', 8080, null).length, 1);

  section('Igiena data/: rotatia backup-urilor ad-hoc (src/backup.js)');
  const backupMod = require('../../src/backup');
  const fsB = require('fs'); const osB = require('os'); const pathB = require('path');
  const tmpB = fsB.mkdtempSync(pathB.join(osB.tmpdir(), 'contab-bak-'));
  // 12 backup-uri ad-hoc + 2 fisiere de migrare (de pastrat)
  for (let k = 0; k < 12; k++) { const f = pathB.join(tmpB, 'db.json.bak-op' + k); fsB.writeFileSync(f, 'x'); const t = Date.now() - (12 - k) * 1000; fsB.utimesSync(f, t / 1000, t / 1000); }
  fsB.writeFileSync(pathB.join(tmpB, 'db.pre-pg.json'), 'x');
  fsB.writeFileSync(pathB.join(tmpB, 'db.pre-sqlite.json'), 'x');
  const rB = backupMod.pruneStrayBackups(tmpB, 10);
  eq('rotatie: sterge peste ultimele 10', rB.removed, 2);
  eq('rotatie: pastreaza 10', fsB.readdirSync(tmpB).filter((f) => /^db\.json\.bak-/.test(f)).length, 10);
  ok('rotatie: NU atinge db.pre-*.json (migrare)', fsB.existsSync(pathB.join(tmpB, 'db.pre-pg.json')) && fsB.existsSync(pathB.join(tmpB, 'db.pre-sqlite.json')));
  ok('rotatie: pastreaza cele mai NOI', fsB.existsSync(pathB.join(tmpB, 'db.json.bak-op11')) && !fsB.existsSync(pathB.join(tmpB, 'db.json.bak-op0')));
  try { fsB.rmSync(tmpB, { recursive: true, force: true }); } catch (_) { /* ignora */ }

  section('Stripe webhook: deduplicare pe event.id (src/billing.js)');
  const billingMod = require('../../src/billing');
  const stgs = {};
  ok('eveniment nou: nevazut', !billingMod.seenEvent(stgs, 'evt_1'));
  billingMod.rememberEvent(stgs, 'evt_1');
  ok('dupa procesare: vazut (livrarea dubla se sare)', billingMod.seenEvent(stgs, 'evt_1'));
  ok('alt eveniment: nevazut', !billingMod.seenEvent(stgs, 'evt_2'));
  billingMod.rememberEvent(stgs, null);
  ok('id lipsa: nu crapa si nu se inregistreaza', !stgs.stripeEventIds.null && Object.keys(stgs.stripeEventIds).length === 1);
  ok('seenEvent tolereaza settings gol/necunoscut', !billingMod.seenEvent({}, 'evt_1') && !billingMod.seenEvent(null, 'evt_1'));
  // rotatia istoricului: peste MAX_SEEN_EVENTS se taie cele mai VECHI (ordinea inserarii)
  const stgs2 = {};
  for (let k = 0; k < billingMod.MAX_SEEN_EVENTS + 10; k++) billingMod.rememberEvent(stgs2, 'evt_' + k);
  eq('rotatie: istoricul e plafonat', Object.keys(stgs2.stripeEventIds).length, billingMod.MAX_SEEN_EVENTS);
  ok('rotatie: cele mai vechi au iesit', !billingMod.seenEvent(stgs2, 'evt_0') && !billingMod.seenEvent(stgs2, 'evt_9'));
  ok('rotatie: cele mai noi raman', billingMod.seenEvent(stgs2, 'evt_10') && billingMod.seenEvent(stgs2, 'evt_' + (billingMod.MAX_SEEN_EVENTS + 9)));

}

module.exports = { platformaFisiere, platformaProces };
