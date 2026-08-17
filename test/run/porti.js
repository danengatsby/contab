'use strict';

// PORTI SI INFRASTRUCTURA — sectiuni care verifica CODUL, nu cifrele: allowlist-ul public,
// prefixele pazite, paginarea, escaparea, CSP/PWA, plafoanele si documentatia care nu are voie sa
// contrazica configuratia reala. Sunt primele mutate din `test/run.js` fiindca nu impart niciun
// fixture cu miezul fiscal: citesc sursa de pe disc si afirma pe ea.
//
// Radacina depozitului se ia din `comun.js`, NU din `__dirname`: fisierul asta sta cu un nivel mai
// jos, deci `path.join(__dirname, '..')` ar fi indicat `test/`. O poarta care scaneaza un director
// gresit nu gaseste nimic — si TRECE. De aceea mai multe porti de aici isi verifica si perimetrul
// („perimetrul se citeste din src/", „rutele enumerate din sursa (>80)"): sunt aparatoarea
// impotriva exact acestei greseli.

const { eq, ok, section, RADACINA } = require('./comun');

section('Secrete obligatorii la pornire (src/secretsGuard.js)');
{
  const g = require('../../src/secretsGuard');
  const bun = { CONTAB_AUTH_SECRET: 'a'.repeat(64), CONTAB_SECRETS_KEY: 'b'.repeat(64) };
  eq('mediu complet -> nicio problema', g.problems(bun).length, 0);
  eq('mediu gol -> ambele semnalate', g.problems({}).length, 2);
  ok('lipsa CONTAB_AUTH_SECRET spune DE CE (forjarea sesiunilor din backup)',
    /forja sesiuni/i.test(g.problems({ CONTAB_SECRETS_KEY: 'b'.repeat(64) })[0]));
  ok('lipsa CONTAB_SECRETS_KEY spune ca necriptarea e TACUTA',
    /tacut/i.test(g.problems({ CONTAB_AUTH_SECRET: 'a'.repeat(64) })[0]));
  // formatul conteaza, nu doar prezenta
  eq('secret de semnare prea scurt e respins', g.problems(Object.assign({}, bun, { CONTAB_AUTH_SECRET: 'scurt' })).length, 1);
  eq('cheia de criptare non-hex e respinsa', g.problems(Object.assign({}, bun, { CONTAB_SECRETS_KEY: 'x'.repeat(64) })).length, 1);
  eq('cheia de criptare de alta lungime e respinsa', g.problems(Object.assign({}, bun, { CONTAB_SECRETS_KEY: 'ab' })).length, 1);
  ok('64 hex cu litere mari e acceptat', g.problems(Object.assign({}, bun, { CONTAB_SECRETS_KEY: 'AB'.repeat(32) })).length === 0);

  // Comportamentul la pornire, cu io injectat (fara process.exit real)
  g._reset(); // garda e idempotenta pe proces; testele o reseteaza intre cazuri
  const rec = () => { const o = { erori: [], jurnal: [], cod: null }; return Object.assign(o, { error: (m) => o.erori.push(m), log: (m) => o.jurnal.push(m), exit: (c) => { o.cod = c; } }); };
  let io = rec(); const okRes = g.assertSecrets(bun, io);
  ok('cu secrete: porneste, fara zgomot', okRes.ok && io.cod === null && io.erori.length === 0);
  g._reset(); io = rec(); const fail = g.assertSecrets({}, io);
  ok('fara secrete: REFUZA pornirea (exit 1)', fail.ok === false && io.cod === 1 && io.erori.length === 1);
  ok('mesajul de refuz spune si cum se genereaza cheile', /randomBytes\(32\)/.test(io.erori[0]));
  ok('...si avertizeaza ca schimbarea invalideaza sesiunile', /invalideaza toate/i.test(io.erori[0]));
  g._reset(); io = rec(); const dev = g.assertSecrets({ CONTAB_DEV: '1' }, io);
  ok('CONTAB_DEV=1: porneste, dar AVERTIZEAZA la fiecare pornire', dev.ok && dev.dev === true && io.cod === null && io.jurnal.length >= 1);
  ok('avertismentul spune explicit ca nu e pentru productie', /NU folosi asa in productie/i.test(io.jurnal[0]));
  // CONTAB_DEV nu e o valoare adevarata oarecare: doar '1'
  g._reset(); io = rec(); g.assertSecrets({ CONTAB_DEV: 'true' }, io);
  eq('CONTAB_DEV=true NU e acceptat ca dezvoltare (doar „1")', io.cod, 1);
}

section('CSRF: token sincronizator + allowlist de origine (src/csrf.js)');
{
  const csrf = require('../../src/csrf');
  const SEC = 'secret-de-test';
  const tok = csrf.tokenFor('sess-1', SEC);
  ok('token derivat, nu stocat: acelasi de fiecare data', tok === csrf.tokenFor('sess-1', SEC) && tok.length === 32);
  ok('alta sesiune -> alt token', csrf.tokenFor('sess-2', SEC) !== tok);
  ok('alt secret -> alt token (rotirea secretului invalideaza)', csrf.tokenFor('sess-1', 'alt') !== tok);
  eq('fara sesiune nu emitem token slab', csrf.tokenFor('', SEC), '');
  eq('fara secret nu emitem token slab', csrf.tokenFor('s', ''), '');

  const ok200 = (h, sess) => csrf.check({ headers: h, sessId: sess, secret: SEC }).ok;
  // 1. origine straina: respinsa CHIAR SI cu token valid — allowlist inainte de token
  const strain = csrf.check({ headers: { host: 'a.ro', origin: 'https://rau.example', 'x-csrf-token': tok }, sessId: 'sess-1', secret: SEC });
  ok('origine straina respinsa chiar cu token valid', !strain.ok && strain.reason === 'origin');
  ok('Referer strain e tratat la fel ca Origin',
    !csrf.check({ headers: { host: 'a.ro', referer: 'https://rau.example/p' }, sessId: 'sess-1', secret: SEC }).ok);
  // 2. LIPSA antetului nu mai e portita: cu sesiune, token-ul e obligatoriu
  ok('fara Origin si FARA token, dar cu sesiune -> respins', !ok200({ host: 'a.ro' }, 'sess-1'));
  const fp = csrf.check({ headers: { host: 'a.ro' }, sessId: 'sess-1', secret: SEC });
  eq('...motivul e „token", nu „origin"', fp.reason, 'token');
  ok('fara Origin dar CU token propriu -> acceptat', ok200({ host: 'a.ro', 'x-csrf-token': tok }, 'sess-1'));
  ok('token al altei sesiuni -> respins', !ok200({ host: 'a.ro', 'x-csrf-token': csrf.tokenFor('sess-2', SEC) }, 'sess-1'));
  // 3. fara sesiune nu exista credentiale ambientale de calarit
  ok('fara sesiune, fara token -> acceptat (login/inregistrare/webhook)', ok200({ host: 'a.ro' }, null));
  ok('origine proprie + sesiune + token -> acceptat', ok200({ host: 'a.ro', origin: 'https://a.ro', 'x-csrf-token': tok }, 'sess-1'));

  // allowlist configurabila (proxy / alt domeniu al aplicatiei)
  ok('gazda din CONTAB_CSRF_ORIGINS e acceptata',
    csrf.check({ headers: { host: 'intern:8080', origin: 'https://app.exemplu.ro', 'x-csrf-token': tok }, sessId: 'sess-1', secret: SEC, extraOrigins: 'https://app.exemplu.ro' }).ok);
  ok('...si numai ea (alta ramane straina)',
    !csrf.check({ headers: { host: 'intern:8080', origin: 'https://alta.ro' }, sessId: 'sess-1', secret: SEC, extraOrigins: 'https://app.exemplu.ro' }).ok);
  ok('allowedHosts normalizeaza si o gazda fara schema', csrf.allowedHosts('a.ro', 'b.ro').has('b.ro'));
  eq('sourceHost intoarce null cand antetul lipseste', csrf.sourceHost({}), null);
  eq('sourceHost intoarce null pe URL nevalid', csrf.sourceHost({ origin: 'nu-e-url' }), null);
  // comparatie in timp constant: lungimi diferite nu arunca
  ok('comparatia nu arunca pe lungimi diferite', csrf.safeEqual('abc', 'abcd') === false);
  ok('comparatia respinge sirul gol', csrf.safeEqual('', '') === false);
}

section('Upload: lipsa extensiei e „necunoscut", nu „permis"');
{
  const ug = require('../../src/uploadGuard');
  const HTML = Buffer.from('<html><script>alert(1)</script></html>');
  // Cele doua straturi aveau ACEEASI gaura: `fileFilter` scurtcircuita pe `ext &&`, iar
  // `contentMatches` cadea pe ramura containerelor. Iar multer salveaza fisierul fara extensie
  // ca `.pdf` (`extname(...) || '.pdf'`), deci octetii ajungeau la extractorul PDF si la API-ul
  // AI ca si cum ar fi fost un PDF valid.
  ok('extensie goala + continut arbitrar -> RESPINS', ug.contentMatches('', HTML) === false);
  ok('extensie goala + octeti NUL -> RESPINS', ug.contentMatches('', Buffer.from([0, 1, 2])) === false);
  // ...fara sa strice cazurile legitime
  ok('.pdf cu antet PDF -> acceptat', ug.contentMatches('.pdf', Buffer.from('%PDF-1.7')) === true);
  ok('.pdf cu continut HTML -> respins (neschimbat)', ug.contentMatches('.pdf', HTML) === false);
  ok('containerele raman pe validarea parserului lor', ug.contentMatches('.zip', Buffer.from('PK\x03\x04')) === true);
  ok('.xlsx ramane acceptat', ug.contentMatches('.xlsx', Buffer.from('PK\x03\x04')) === true);
  ok('textul fara NUL ramane acceptat', ug.contentMatches('.csv', Buffer.from('a;b;c')) === true);
  ok('textul CU NUL ramane respins', ug.contentMatches('.csv', Buffer.from([0x61, 0x00, 0x62])) === false);

  // Filtrul de extensii din bootstrap nu mai are scurtcircuitul pe extensie goala.
  const fsx = require('fs'); const pth = require('path');
  const boot = fsx.readFileSync(pth.join(RADACINA, 'src', 'bootstrap.js'), 'utf8');
  ok('fileFilter nu mai foloseste `ext &&` (care lasa sa treaca lipsa extensiei)',
    !/if \(ext && !UPLOAD_EXT_OK\.has\(ext\)\)/.test(boot));
  ok('fileFilter cere apartenenta la allowlist, neconditionat',
    /if \(!UPLOAD_EXT_OK\.has\(ext\)\)/.test(boot));
}

section('Poarta: allowlist-ul public (PUBLIC_PATHS) — fara orfani, fara crestere tacuta');
{
  const fsx = require('fs'); const pth = require('path');
  const root = RADACINA;
  const boot = fsx.readFileSync(pth.join(root, 'src', 'bootstrap.js'), 'utf8');
  const brut = (boot.match(/PUBLIC_PATHS = new Set\(\[([^\]]*)\]/s) || [undefined, ''])[1];
  const publice = brut.split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  ok('PUBLIC_PATHS se poate citi din bootstrap', publice.length > 5);

  // Toate rutele inregistrate, ca sa putem cere ca fiecare cale publica sa EXISTE.
  const fisiere = ['server.js', 'src/authRoutes.js']
    .concat(fsx.readdirSync(pth.join(root, 'src', 'routes')).filter((f) => f.endsWith('.js')).map((f) => 'src/routes/' + f));
  const rute = new Set();
  for (const f of fisiere) {
    for (const m of fsx.readFileSync(pth.join(root, f), 'utf8').matchAll(/app\.(get|post|delete|patch|put)\(\s*['"`](\/[^'"`]*)['"`]/g)) rute.add(m[2]);
  }
  // ORFANII sunt periculosi in ambele sensuri: o cale redenumita lasa ruta reala PROTEJATA (se
  // strica fluxul public) si, mai rau, lasa in allowlist o cale libera — care devine o gaura in
  // ziua in care cineva inregistreaza o ruta acolo, fara sa stie ca e deja publica.
  const orfani = publice.filter((p) => !rute.has(p));
  ok('nicio cale publica orfana (toate corespund unei rute reale)'
    + (orfani.length ? ' — ' + orfani.join(', ') : ''), orfani.length === 0);

  // Cresterea allowlist-ului trebuie sa fie o DECIZIE, nu un accident: lista asteptata e scrisa
  // aici, deci orice adaugare apare in diff-ul testului si trece prin review. Acelasi tipar ca la
  // numarul de joburi periodice.
  // `/api/client-error` e public DELIBERAT: cea mai costisitoare eroare de client e cea de pe
  // ecranul de LOGIN — daca ruta ar cere sesiune, exact acel caz ar ramane invizibil, adica
  // tocmai gaura pe care o astupa. Abuzul e marginit prin plafon pe IP + taiere + agregare.
  // `/api/registru-anaf` e public DELIBERAT, din acelasi tipar: cel mai scump loc in care se
  // tasteaza de mana datele unei firme e formularul de INSCRIERE, unde omul inca n-are cont. O
  // ruta autentificata n-ar putea ajuta exact acolo. Datele sunt publice prin natura lor
  // (registrul ANAF raspunde oricui, fara autentificare), iar abuzul e marginit prin plafon pe
  // IP (CONTAB_RATE_CUI), memo in anafRegistru si un raspuns redus la campurile de formular.
  const ASTEPTAT = ['/api/health', '/api/login', '/api/logout', '/api/me', '/api/forgot-password',
    '/api/register', '/api/stripe/webhook', '/api/plans', '/api/demo-login', '/api/checkout-guest',
    '/api/client-error', '/api/registru-anaf'];
  const inPlus = publice.filter((p) => !ASTEPTAT.includes(p));
  const lipsa = ASTEPTAT.filter((p) => !publice.includes(p));
  ok('allowlist-ul public e exact cel revizuit (o adaugare cere actualizarea testului)'
    + (inPlus.length ? ' — IN PLUS: ' + inPlus.join(', ') : '') + (lipsa.length ? ' — LIPSA: ' + lipsa.join(', ') : ''),
    inPlus.length === 0 && lipsa.length === 0);

  // Prefixele care sar peste autentificare (invitatii, resetare) sunt tot allowlist — si tot
  // trebuie sa fie exact cele doua stiute.
  const prefixe = [...boot.matchAll(/req\.path\.startsWith\('(\/api\/[a-z-]+\/)'\)/g)].map((m) => m[1]).sort();
  eq('doar doua prefixe publice (invitatie + resetare)', prefixe.join(','), '/api/invite/,/api/reset/');
}

section('Poarta: verificarea parolei costa la fel si cand contul NU exista (anti-enumerare)');
{
  const fsx = require('fs'); const pth = require('path');
  const root = RADACINA;
  // Perimetrul se DERIVA din sursa (tot src/, recursiv), nu e o lista scrisa de mana care sa
  // drifteze cand apare un modul nou de autentificare.
  const fisiere = [];
  (function walk(dir) {
    for (const f of fsx.readdirSync(dir).sort()) {
      const p = pth.join(dir, f);
      if (fsx.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) fisiere.push(p);
    }
  })(pth.join(root, 'src'));
  ok('perimetrul se citeste din src/', fisiere.length > 50);

  // DEFECTUL pe care il prinde poarta: `!u || ... verifyPassword(pw, u.salt, u.hash)`. Operatorul
  // || scurtcircuiteaza, deci pe contul inexistent scrypt nu mai ruleaza — raspunsul vine in ~0 ms
  // fata de ~30 ms, si un 401 identic ca text spune totusi daca numele exista. Forma corecta pe
  // caile publice e authlib.verifyUserPassword(user|null, parola), care hash-uieste intotdeauna.
  //
  // Se scaneaza pe FEREASTRA din jurul apelului, nu pe linie: conditia poate fi rupta pe mai multe
  // randuri, si o ancora pe linie ar sari exact peste forma desfasurata (vezi punctul orb al
  // porctilor de escapare din CLAUDE.md).
  const GARDA = /!\s*[A-Za-z_$][\w$]*\s*\|\|/;   // semnatura `!u ||` / `!user ||`
  // Comentariile se scot INAINTE de scanare — altfel poarta se autodenunta pe documentatia care
  // citeaza tocmai forma interzisa (s-a si intamplat la prima rulare). Se inlocuiesc cu acelasi
  // numar de linii noi, ca indicii si numerele de linie raportate sa ramana cele reale.
  const faraComentarii = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/^([ \t]*)\/\/.*$/gm, (c) => c.replace(/[^\n]/g, ' '));
  const vinovati = [];
  for (const f of fisiere) {
    const src = faraComentarii(fsx.readFileSync(f, 'utf8'));
    // `(Async)?` e esential: fara el poarta ar fi devenit oarba exact cand calea de login a trecut
    // pe scrypt asincron — `!u || !verifyPasswordAsync(...)` e aceeasi regresie, alt nume.
    for (const m of src.matchAll(/(?<!User)verifyPassword(Async)?\s*\(/g)) {
      const inainte = src.slice(Math.max(0, m.index - 220), m.index).replace(/\s+/g, ' ');
      // DECLARATIILE nu sunt apeluri: `function verifyPasswordAsync(...)` prindea in fereastra
      // corpul functiei DINAINTE (care contine legitim `if (!salt || !hash) return false`) si
      // raporta src/auth.js ca vinovat. Defectul era latent si in P2 — a iesit la iveala abia
      // cand a aparut a doua declaratie.
      if (/\bfunction\s+$/.test(inainte)) continue;
      if (GARDA.test(inainte)) vinovati.push(pth.relative(root, f) + ':' + (src.slice(0, m.index).split('\n').length));
    }
  }
  ok('niciun verifyPassword() in spatele unui scurtcircuit pe existenta contului'
    + (vinovati.length ? ' — ' + vinovati.join(', ') : ''), vinovati.length === 0);

  // Poarta de mai sus e NEGATIVA: ar trece si daca cineva ar sterge verificarea cu totul. Deci
  // se cere si prezenta formei corecte exact acolo unde conteaza — pe ruta publica de login.
  const authR = fsx.readFileSync(pth.join(root, 'src', 'authRoutes.js'), 'utf8');
  ok('/api/login foloseste authlib.verifyUserPassword(Async)', /verifyUserPassword(Async)?\s*\(/.test(authR));
  ok('src/authRoutes.js nu mai cheama verifyPassword direct', !/(?<!User)verifyPassword(Async)?\s*\(/.test(faraComentarii(authR)));
  const exp = fsx.readFileSync(pth.join(root, 'src', 'auth.js'), 'utf8').match(/module\.exports\s*=\s*\{[\s\S]*?\}/)[0];
  ok('ambele variante sunt exportate din src/auth.js',
    /verifyUserPassword\b/.test(exp) && /verifyUserPasswordAsync\b/.test(exp));
}

section('Poarta: niciun scrypt SINCRON pe o cale de cerere (bucla de evenimente)');
{
  const fsx = require('fs'); const pth = require('path');
  const root = RADACINA;
  const faraComentarii = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/^([ \t]*)\/\/.*$/gm, (c) => c.replace(/[^\n]/g, ' '));

  // scrypt costa ~30 ms de CPU. Sincron, acelea sunt 30 ms in care procesul — unul singur — nu
  // serveste NICIO alta cerere. Pe o cale de cerere se foloseste varianta asincrona (threadpool);
  // formele sincrone raman legitime DOAR la pornire/migrare (src/db.js), unde nu exista cereri
  // de blocat si unde un await ar contamina un `load()` sincron.
  //
  // Perimetrul se DERIVA: tot ce inregistreaza rute (src/routes/*, authRoutes) plus serviciile
  // chemate din ele — nu o lista fixa, ca un modul de rute nou sa intre singur sub poarta.
  const caiDeCerere = ['src/authRoutes.js']
    .concat(fsx.readdirSync(pth.join(root, 'src', 'routes')).filter((f) => f.endsWith('.js')).map((f) => 'src/routes/' + f))
    .concat(fsx.readdirSync(pth.join(root, 'src')).filter((f) => /Service\.js$/.test(f)).map((f) => 'src/' + f));
  ok('perimetrul acopera rutele si serviciile', caiDeCerere.length > 30);

  const SINCRON = /(?<!Async)\b(hashPassword|verifyPassword|verifyUserPassword)\s*\(/;
  const vinovati = caiDeCerere.filter((f) => SINCRON.test(faraComentarii(fsx.readFileSync(pth.join(root, f), 'utf8'))));
  ok('niciun hash/verify sincron pe caile de cerere' + (vinovati.length ? ' — ' + vinovati.join(', ') : ''),
    vinovati.length === 0);

  // Poarta de mai sus e NEGATIVA — ar trece si pe un cod care nu mai hash-uieste nimic. Deci se
  // cere si prezenta formelor asincrone acolo unde stim ca se lucreaza cu parole.
  const auth = fsx.readFileSync(pth.join(root, 'src', 'authRoutes.js'), 'utf8');
  ok('authRoutes chiar hash-uieste, asincron', /hashPasswordAsync\s*\(/.test(auth));
  const acc = fsx.readFileSync(pth.join(root, 'src', 'accountService.js'), 'utf8');
  ok('schimbarea parolei e asincrona pe ambele hash-uri (verificare + calcul)',
    /verifyPasswordAsync\s*\(/.test(acc) && /hashPasswordAsync\s*\(/.test(acc));

  // src/db.js ARE voie sa foloseasca forma sincrona (pornire) — poarta nu trebuie sa fie atat de
  // larga incat sa-l prinda, altfel presiunea ar fi sa facem `load()` asincron fara motiv.
  ok('db.js (pornire) ramane in afara perimetrului', !caiDeCerere.includes('src/db.js'));
}

section('Poarta: nicio comanda externa SINCRONA pe o cale de cerere');
{
  const fsx = require('fs'); const pth = require('path');
  const root = RADACINA;
  const rd = (f) => fsx.readFileSync(pth.join(root, f), 'utf8');
  const faraComentarii = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/^([ \t]*)\/\/.*$/gm, (c) => c.replace(/[^\n]/g, ' '));
  const SYNC_EXEC = /\b(spawnSync|execSync|execFileSync)\s*\(/g;

  // Perimetrul se DERIVA: tot ce inregistreaza rute + serviciile chemate din ele.
  const caiDeCerere = ['src/authRoutes.js']
    .concat(fsx.readdirSync(pth.join(root, 'src', 'routes')).filter((f) => f.endsWith('.js')).map((f) => 'src/routes/' + f))
    .concat(fsx.readdirSync(pth.join(root, 'src')).filter((f) => /Service\.js$/.test(f)).map((f) => 'src/' + f));
  const textCereri = caiDeCerere.map((f) => faraComentarii(rd(f))).join('\n');

  // 1. Direct: nicio comanda sincrona chiar in fisierele de rute/servicii.
  const directe = caiDeCerere.filter((f) => { SYNC_EXEC.lastIndex = 0; return SYNC_EXEC.test(faraComentarii(rd(f))); });
  ok('nicio comanda externa sincrona direct pe o cale de cerere' + (directe.length ? ' — ' + directe.join(', ') : ''),
    directe.length === 0);

  /** Numele functiei de nivel superior care CONTINE offsetul dat (stilul modulelor din src/). */
  const functiaCare = (src, offset) => {
    const inainte = src.slice(0, offset);
    const m = [...inainte.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)].pop();
    return m ? m[1] : '(nivel superior)';
  };

  // 2. Tranzitiv, UN nivel: modulele cerute din caile de cerere. Un asemenea modul are voie sa
  //    contina exec sincron DOAR daca functia care il poarta nu e numita pe nicio cale de cerere.
  //    Asa `src/backup.js` ramane legitim (spawnSync-ul lui pg_dump traieste in `fullBackup`, care
  //    ruleaza EXCLUSIV din scripts/backup.js, adica din cron, unde nu blocheaza nicio cerere),
  //    iar `src/pgRestoreDrill.js` NU ar mai fi: `runPgDrill` e chemat din /api/pg-restore-drill.
  //    Regula e conditionata si isi poarta dovada — nu o lista de exceptii scrisa de mana.
  const ceruteDinRute = new Set();
  for (const f of caiDeCerere) {
    for (const m of faraComentarii(rd(f)).matchAll(/require\(\s*['"]\.\.?\/([\w/]+)['"]\s*\)/g)) {
      const cale = 'src/' + m[1].replace(/^\.\//, '') + '.js';
      if (fsx.existsSync(pth.join(root, cale))) ceruteDinRute.add(cale);
    }
  }
  ok('perimetrul tranzitiv e nevid (modulele cerute din rute)', ceruteDinRute.size > 10);

  const expuse = [];
  for (const mod of ceruteDinRute) {
    const src = faraComentarii(rd(mod));
    SYNC_EXEC.lastIndex = 0;
    for (const m of src.matchAll(SYNC_EXEC)) {
      const fn = functiaCare(src, m.index);
      // e chemata functia asta de pe o cale de cerere?
      if (new RegExp('\\b' + fn + '\\s*\\(').test(textCereri)) expuse.push(mod + ':' + fn + '()');
    }
  }
  ok('nicio functie cu comanda sincrona nu e chemata de pe o cale de cerere'
    + (expuse.length ? ' — ' + [...new Set(expuse)].join(', ') : ''), expuse.length === 0);

  // Poarta de mai sus e NEGATIVA — ar trece si daca drill-ul n-ar mai rula deloc. Deci se cere si
  // forma corecta acolo unde stim ca se lanseaza procese: drill-ul nativ ruleaza ASINCRON.
  const drill = rd('src/pgRestoreDrill.js');
  ok('drill-ul nativ PG chiar lanseaza psql, asincron', /execFile\s*\(/.test(drill) && !/spawnSync\s*\(/.test(faraComentarii(drill)));
  ok('rejucarea dump-ului si crearea bazei temporare sunt asteptate',
    /await\s+run\s*\(\s*'psql'/.test(drill) && /await\s+toolAvailable\s*\(/.test(drill));
  // Stergerea bazei temporare TREBUIE asteptata de cand `run` e asincron: altfel drill-ul se
  // intoarce inaintea ei, iar sub cron procesul poate iesi lasand baze orfane.
  ok('baza temporara se sterge ASTEPTAT (fara baze orfane)', /await\s+dropDb\s*\(\)/.test(drill));
}

section('Poarta: deducerea personala nu atarna de un camp uitat');
{
  const fsd = require('fs'); const pd = require('path');
  const html = fsd.readFileSync(pd.join(RADACINA, 'public', 'index.html'), 'utf8');
  const inp = (html.match(/<input[^>]*name="persoane"[^>]*>/) || [''])[0];
  ok('campul „Persoane in intretinere" exista', !!inp);
  // MIEZUL: `placeholder` e text GRI — arata completat, se trimite GOL. Cu poarta veche
  // (`hasDP = a.persoane != null`) golul insemna „fara deducere", deci 516 lei/an supraimpozitare
  // per angajat, invizibil. Campul trebuie sa aiba o VALOARE, nu doar un indiciu.
  ok('...si are `value`, nu doar `placeholder`' + (inp && !/\bvalue=/.test(inp) ? ' — ARE DOAR placeholder' : ''),
    /\bvalue=/.test(inp));
  // Singurul caz legal fara deducere (al doilea loc de munca) se declara EXPLICIT, si e bifat
  // implicit fiindca functia de baza e cazul obisnuit.
  const fb = (html.match(/<input[^>]*name="functieBaza"[^>]*>/) || [''])[0];
  ok('exista bifa „Functia de baza"', !!fb);
  ok('...bifata implicit (cazul obisnuit)', /\bchecked\b/.test(fb));
  // Formularul chiar trimite campul mai departe, altfel bifa ar fi decor.
  const sal = fsd.readFileSync(pd.join(RADACINA, 'public', 'salarizare.js'), 'utf8');
  ok('formularul trimite functieBaza la salvare', /functieBaza:\s*f\.functieBaza/.test(sal));
  ok('...si o reincarca la editare', /f\.functieBaza\.checked\s*=/.test(sal));
  const svc = fsd.readFileSync(pd.join(RADACINA, 'src', 'payrollService.js'), 'utf8');
  ok('serviciul o persista, cu implicit ADEVARAT pentru inregistrarile vechi',
    /functieBaza:\s*b\.functieBaza === undefined \? true/.test(svc));
}

section('Poarta: ghidul se DERIVA din aplicatie, nu se scrie de mana');
{
  const fsg = require('fs'); const pg2 = require('path');
  const ghid = fsg.readFileSync(pg2.join(RADACINA, 'public', 'ghid.js'), 'utf8');
  const html = fsg.readFileSync(pg2.join(RADACINA, 'public', 'index.html'), 'utf8');
  const appjs = fsg.readFileSync(pg2.join(RADACINA, 'public', 'app.js'), 'utf8');

  // Structura pe care o umple ghidul trebuie sa existe in pagina...
  ok('pagina are bara de cuprins a ghidului', /id="ghidMenu"/.test(html));
  ok('...panoul de prezentare', /id="ghidPagina"/.test(html));
  ok('...si pagina de pornire', /id="ghidAcasa"/.test(html));
  ok('ghidul e pornit din app.js', /import \{ initGhid \}/.test(appjs) && /initGhid\(\)/.test(appjs));

  // ...IAR MIEZUL: ghidul nu are voie sa contina o LISTA de taburi. Daca ar avea, ar drifta la
  // prima pagina noua din aplicatie si nimeni n-ar afla — un ghid se citeste rar. Singura
  // mentiune permisa a unui `data-tab` e SELECTORUL prin care sunt citite din DOM.
  const numeTaburi = [...new Set([...html.matchAll(/data-tab="([a-z-]+)"/g)].map((m) => m[1]))];
  const citate = numeTaburi.filter((t) => new RegExp("['\"`]" + t + "['\"`]").test(ghid));
  ok('ghidul NU numeste niciun tab' + (citate.length ? ' — GASITE: ' + citate.join(', ') : ''),
    citate.length === 0);
  ok('poarta chiar are ce cauta (taburi gasite in pagina)', numeTaburi.length > 30);
  ok('ghidul citeste structura din DOM (nu dintr-o lista proprie)',
    /\.navgroup/.test(ghid) && /navmenu button\[data-tab\]/.test(ghid));
  ok('explicatiile se CLONEAZA, nu se re-serializeaza ca marcaj', /cloneNode\(true\)/.test(ghid));
  ok('ghidul nu construieste HTML din siruri (fara innerHTML cu interpolare)',
    !/innerHTML\s*=\s*[`'"][^`'"]*\$\{/.test(ghid));
}

section('Poarta: pagina publica de prezentare nu-si contrazice produsul');
{
  const fsx = require('fs'); const pth = require('path');
  const pag = fsx.readFileSync(pth.join(RADACINA, 'public', 'prezentare.html'), 'utf8');

  // Pagina de vanzare afirma CIFRE despre produs. Netinute in frau, ele drifteaza in tacere si in
  // directia proasta: la scrierea acestei porti spunea „~100 tipuri" (erau 107), „7 declaratii"
  // (erau 10) si „582 de verificari" cand suita trecuse de 4.300 — adica isi SUBEVALUA produsul
  // de sapte ori. Nimic nu confrunta pagina cu realitatea, spre deosebire de docs/.
  const nrTipuri = Object.keys(require('../../src/documentTypes').TYPES).length;
  const statTipuri = Number((pag.match(/<b>(\d+)<\/b> tipuri de operatiuni|<b>(\d+)<\/b> tipuri de opera\u021biuni/) || [])
    .slice(1).find(Boolean));
  eq('numarul de tipuri de operatiuni din pagina = cel real', statTipuri, nrTipuri);

  // Declaratiile: catalogul registrului este acum complet, inclusiv D205. Nu mai adaugam D205
  // separat: asta ar dubla-o exact dupa integrarea generatorului in calendar.
  const nrDecl = Object.keys(require('../../src/declarations').TIPURI).length;
  const statDecl = Number((pag.match(/<b>(\d+)<\/b> declara\u021bii/) || [])[1]);
  eq('numarul de declaratii din pagina = cel real', statDecl, nrDecl);

  // Fiecare declaratie NUMITA in pagina trebuie sa existe ca generator — altfel pagina vinde ceva
  // ce nu se livreaza. Se verifica pe numele scurte, nu pe descrieri.
  const numite = [...new Set([...pag.matchAll(/\bD(100|101|112|205|300|301|307|311|390|394|406)\b/g)].map((m) => m[1]))];
  const xmlSrc = fsx.readFileSync(pth.join(RADACINA, 'src', 'xml.js'), 'utf8')
    + fsx.readFileSync(pth.join(RADACINA, 'src', 'saft.js'), 'utf8');
  const fara = numite.filter((d) => !new RegExp('d' + d + 'Xml|D406|saftXml', 'i').test(xmlSrc));
  ok('fiecare declaratie numita in pagina are generator' + (fara.length ? ' — LIPSA: D' + fara.join(', D') : ''),
    fara.length === 0);
  ok('pagina chiar numeste declaratii (poarta nu scaneaza in gol)', numite.length >= 6);

  // NUMERE CARE DRIFTEAZA GARANTAT: cate verificari are suita nu are ce cauta intr-o pagina de
  // marketing — creste la fiecare test nou. Aceeasi regula ca la docs/ (vezi CLAUDE.md).
  // Regexul tolereaza MARCAJ intre cifra si text: forma reala din pagina era
  // `<b>582</b> de verificari automate`, iar o ancora care cerea cifra lipita de cuvant nu o
  // prindea — verificat prin mutatie, poarta trecea senina peste exact driftul pe care il vaneaza.
  ok('pagina NU fixeaza numarul de verificari al suitei (drifteaza garantat)',
    !/\d[\s\S]{0,24}verific\u0103ri automate/.test(pag));

  // Afirmatia cea mai puternica a produsului lipsea cu desavarsire din pagina de vanzare:
  // DUKIntegrator aparea O SINGURA data, si doar ca obligatie a UTILIZATORULUI. Poarta cere ca
  // pagina sa spuna si ce garanteaza PRODUSUL — altfel argumentul se pierde iar la o rescriere.
  ok('pagina prezinta poarta fiscala ca promisiune a produsului, nu doar ca sarcina a ta',
    /valideaz\u0103|valida/i.test(pag) && /versiune[\s\S]{0,200}DUKIntegrator|DUKIntegrator[\s\S]{0,200}versiune/i.test(pag));
}

section('Poarta: textele nu numesc formulare de bilant pe care nu le depunem');
{
  const fsx = require('fs'); const pth = require('path');

  // DE CE EXISTA: interfata si pagina de prezentare au etichetat ani la rand situatia fluxurilor
  // de trezorerie drept „F30" si situatia modificarilor capitalurilor proprii drept „F40", si
  // spuneau despre ele ca sunt „celelalte formulare din setul anual depus la ANAF". Ambele
  // afirmatii sunt false, si a doua e cea periculoasa: in setul ANAF F30 = Date informative si
  // F40 = Situatia activelor imobilizate, iar in schemele pe care le depune aplicatia
  // (s1120/s1121/s1122) elementele F30 si F40 NU EXISTA — validatorul oficial le respinge exact
  // ca pe un `<F99/>` inventat (sondat 2026-08-06, docs/validare-oficiala.md). Un contabil citea
  // eticheta si intelegea ca depune un set complet.
  //
  // PERIMETRUL SE DERIVA din generator, nu se scrie aici: lista de coduri permise e cea pe care
  // `bilantXml` chiar o emite. Daca maine se adauga un formular in schema, poarta il accepta
  // singura; daca se scoate unul, poarta incepe sa ceara scoaterea lui din texte.
  const xmlSrc = fsx.readFileSync(pth.join(RADACINA, 'src', 'xml.js'), 'utf8');
  const emise = [...new Set([...xmlSrc.matchAll(/<(F\d\d)\b/g)].map((m) => m[1]))].sort();
  ok('poarta chiar a gasit formularele emise (nu scaneaza in gol)', emise.length >= 2 && emise.includes('F10'));

  // Textele CATRE UTILIZATOR. Comentariile se scot inainte de scanare: acolo codurile trebuie sa
  // poata fi numite, tocmai ca sa se explice de ce nu au voie in alta parte.
  const faraComentarii = (s, html) => (html ? s.replace(/<!--[\s\S]*?-->/g, ' ') : s)
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const fisiere = ['public/index.html', 'public/prezentare.html', 'public/acoperire.html', 'public/rapoarte.js'];
  const gasite = [];
  let totalCitit = 0;
  for (const rel of fisiere) {
    const p = pth.join(RADACINA, rel);
    if (!fsx.existsSync(p)) continue;
    const brut = fsx.readFileSync(p, 'utf8');
    totalCitit += brut.length;
    const txt = faraComentarii(brut, rel.endsWith('.html'));
    for (const m of txt.matchAll(/\bF(\d\d)\b/g)) {
      const cod = 'F' + m[2 - 1];
      if (!emise.includes(cod)) gasite.push(rel + ' → ' + cod);
    }
  }
  ok('poarta chiar a citit fisierele (nu trece pe lista goala)', totalCitit > 50000);
  ok('niciun text catre utilizator nu numeste un formular de bilant neemis'
    + (gasite.length ? ' — GASIT: ' + [...new Set(gasite)].join(', ') : ''),
    gasite.length === 0);
}

section('Poarta: materialele publicate nu divergo de sursa lor');
{
  const fsx = require('fs'); const pth = require('path');
  const MAT = pth.join(RADACINA, 'public', 'materiale');
  const SRC = pth.join(RADACINA, 'marketing');

  // `public/materiale/` sunt COPII servite public ale materialelor din `marketing/`. Doua copii
  // ale aceluiasi fisier drifteaza garantat: la rescrierea textului comercial, cea publicata a
  // ramas o versiune in urma pana am copiat-o manual. Poarta face copierea obligatorie, nu optionala.
  const identic = (a, b) => fsx.existsSync(a) && fsx.existsSync(b) && fsx.readFileSync(a).equals(fsx.readFileSync(b));

  // In DISTRIBUTIE (pachetul portabil) `marketing/` nu se livreaza: sunt 98 MB de capturi si text
  // comercial intern, iar destinatarul n-are cu ce compara copiile publicate. Fara tratare, poarta
  // crapa cu ENOENT la `readdirSync`, deci `npm test` pica, deci `prestart` pica, deci aplicatia
  // NU PORNESTE pe masina clientului — s-a intamplat exact asa la prima proba a pachetului.
  //
  // Sarirea atarna de un semnal POZITIV scris de impachetator, nu de simpla absenta a directorului.
  // Diferenta e toata poanta: pe depozit, un `marketing/` sters din greseala trebuie sa PICE poarta,
  // nu s-o dezarmeze. Si nu se sare in tacere — se spune, si se dovedeste ca sarirea e justificata.
  const distributie = fsx.existsSync(pth.join(RADACINA, '.distributie-portabila'));
  if (distributie) {
    console.log('  ○ SARIT: distributie portabila — sursele din marketing/ nu se livreaza.');
    ok('sarirea e justificata: marketing/ chiar lipseste din distributie', !fsx.existsSync(SRC));
  } else {
    ok('folderul publicat exista', fsx.existsSync(MAT));
    ok('sursele de marketing exista (fara ele poarta n-ar avea ce compara)', fsx.existsSync(SRC));
    ok('descrierea publicata e identica cu sursa din marketing/',
      identic(pth.join(SRC, 'descriere.txt'), pth.join(MAT, 'descriere.txt')));

    // Fiecare captură PNG/JPG din marketing/capturi/ trebuie să aibă geamănul ei publicat, bit cu bit.
    const dirCap = pth.join(SRC, 'capturi');
    const capturi = fsx.existsSync(dirCap) ? fsx.readdirSync(dirCap).filter((f) => /\.(?:png|jpe?g)$/i.test(f)) : [];
    ok('exista capturi de verificat (poarta nu scaneaza in gol)', capturi.length >= 3);
    const divergente = capturi.filter((f) => !identic(pth.join(dirCap, f), pth.join(MAT, f)));
    ok('fiecare captura publicata e identica cu originalul' + (divergente.length ? ' — DIFERITE: ' + divergente.join(', ') : ''),
      divergente.length === 0);

    // Egalitatea celor două copii nu dovedește că imaginile sunt NOI: ambele puteau rămâne
    // identic de vechi după o schimbare de UI. Generatorul scrie de aceea un manifest cu
    // amprenta exactă a surselor vizuale și versiunea shell-ului PWA.
    const manifestSrc = pth.join(dirCap, 'capturi-manifest.json');
    const manifestPub = pth.join(MAT, 'capturi-manifest.json');
    ok('capturile au manifest anti-drift publicat în ambele directoare',
      fsx.existsSync(manifestSrc) && identic(manifestSrc, manifestPub));
    let manifest = null;
    try { manifest = JSON.parse(fsx.readFileSync(manifestSrc, 'utf8')); } catch (_) { /* raportat mai jos */ }
    ok('manifestul capturilor este JSON valid, schema 1', !!manifest && manifest.schema === 1);
    const obligatorii = ['index.html', 'styles.css', 'u.css', 'erp.css', 'design-system.css', 'erp.js',
      'dashboard.js', 'docflow.js', 'livrabile.js', 'rapoarte.js', 'sw.js'];
    ok('amprenta acoperă shell-ul, design system-ul și ecranele fotografiate',
      !!manifest && obligatorii.every((f) => (manifest.sources || []).includes(f)));
    let amprenta = '';
    if (manifest && Array.isArray(manifest.sources)) {
      const hash = require('crypto').createHash('sha256');
      let complet = true;
      for (const rel of manifest.sources) {
        const sursa = pth.join(RADACINA, 'public', rel);
        if (typeof rel !== 'string' || rel.includes('..') || !fsx.existsSync(sursa)) { complet = false; break; }
        hash.update(rel); hash.update('\0'); hash.update(fsx.readFileSync(sursa)); hash.update('\0');
      }
      if (complet) amprenta = hash.digest('hex');
    }
    ok('capturile provin din sursele UI curente, nu dintr-o versiune veche',
      !!manifest && amprenta === manifest.sourceFingerprint);
    const sw = fsx.readFileSync(pth.join(RADACINA, 'public', 'sw.js'), 'utf8');
    const cacheCurent = (sw.match(/const CACHE = ['"]([^'"]+)/) || [])[1] || '';
    ok('manifestul poartă aceeași versiune PWA ca aplicația', !!manifest && manifest.uiCache === cacheCurent);
    ok('manifestul enumeră exact toate imaginile publicate', !!manifest
      && JSON.stringify([...(manifest.captures || [])].sort()) === JSON.stringify([...capturi].sort()));
    const pngCorecte = capturi.filter((f) => f.endsWith('.png')).every((f) => {
      const b = fsx.readFileSync(pth.join(dirCap, f));
      return b.length > 24 && b.readUInt32BE(16) === 2880 && b.readUInt32BE(20) === 1800;
    });
    ok('PNG-urile păstrează viewportul 1440×900 la 2×', pngCorecte);
    ok('fixture-ul publicat rămâne realist: 7 firme, 70–90% conformitate, zero restanțe',
      !!manifest && manifest.portfolio && manifest.portfolio.firms === 7
        && manifest.portfolio.conformity >= 70 && manifest.portfolio.conformity <= 90
        && manifest.portfolio.overdue === 0);
  }

  // Materialele NU au voie sa concureze paginile reale in cautari: sunt acelasi text, la alta
  // adresa. Fara excludere, `/materiale/descriere.txt` poate ajunge deasupra paginii de prezentare.
  const robots = pth.join(RADACINA, 'public', 'robots.txt');
  ok('robots.txt exista', fsx.existsSync(robots));
  ok('robots.txt exclude materialele din indexare',
    fsx.existsSync(robots) && /Disallow:\s*\/materiale\//.test(fsx.readFileSync(robots, 'utf8')));
}

section('Poarta: nicio ruta in afara prefixelor pazite (/api /pdf /xml /csv /efactura)');
{
  const fsx = require('fs'); const pth = require('path');
  const root = RADACINA;
  // Garda CSRF si cerinta de sesiune se aplica pe PREFIX (src/bootstrap.js:
  // /^\/(api|pdf|xml|csv|efactura)/). O ruta inregistrata in afara lor — `/export/...`,
  // `/download/...` — ar ocoli TACIT si CSRF-ul, si autentificarea. Lectia e consemnata in
  // memoria proiectului dupa un incident; aici devine invariant verificat, nu obicei.
  const PREFIXE = new Set(['api', 'pdf', 'xml', 'csv', 'efactura']);
  const fisiere = ['server.js', 'src/authRoutes.js']
    .concat(fsx.readdirSync(pth.join(root, 'src', 'routes')).filter((f) => f.endsWith('.js')).map((f) => 'src/routes/' + f));
  const straine = [];
  let total = 0;
  for (const f of fisiere) {
    const txt = fsx.readFileSync(pth.join(root, f), 'utf8');
    for (const m of txt.matchAll(/app\.(get|post|delete|patch|put)\(\s*['"`](\/[^'"`]*)['"`]/g)) {
      total += 1;
      const pref = m[2].split('/')[1] || '';
      if (!PREFIXE.has(pref)) straine.push(f.split('/').pop() + ': ' + m[1].toUpperCase() + ' ' + m[2]);
    }
  }
  ok('poarta vede rutele aplicatiei', total > 100);
  ok('nicio ruta in afara prefixelor pazite'
    + (straine.length ? ' — ' + straine.slice(0, 5).join(' | ') : ''), straine.length === 0);
  // poarta trebuie sa POATA pica
  ok('poarta chiar detecteaza un prefix nepazit', !PREFIXE.has('/export/date'.split('/')[1]));
  ok('si accepta unul pazit', PREFIXE.has('/xml/pain001'.split('/')[1]));
  // Azi toate cele 340 de rute se inregistreaza cu ghilimele simple, deci un regex care cere
  // apostroful nu rata nimic — dar tacerea ar fi fost totala daca cineva scria `app.get("/x")`:
  // ruta ar fi devenit invizibila DEODATA pentru poarta de prefixe si pentru cea de allowlist.
  const RX_RUTA = /app\.(get|post|delete|patch|put)\(\s*['"`](\/[^'"`]*)['"`]/g;
  ok('extragerea rutelor nu depinde de stilul de ghilimele',
    [...'app.get("/export/date", h); app.post(`/api/x`, h);'.matchAll(RX_RUTA)].length === 2);
}

section('Poarta: fiecare ruta care intoarce o colectie trece prin sendList/sendMap');
{
  const fsx = require('fs'); const pth = require('path');
  const root = RADACINA;
  // De ce o poarta si nu doar teste pe rutele de azi: graful bazei sta in RAM prin design, deci o
  // colectie serializata integral poate aloca zeci de MB si, sub concurenta, poate duce la OOM.
  // O ruta NOUA care intoarce direct `res.json(colectie)` reintroduce exact riscul — tacut.
  const files = ['server.js', 'src/authRoutes.js']
    .concat(fsx.readdirSync(pth.join(root, 'src', 'routes')).filter((f) => f.endsWith('.js')).map((f) => 'src/routes/' + f));
  // Expresii care denota o COLECTIE vie (nu un obiect singular). Lista NU se scrie de mana:
  // se DERIVA din store.ARRAY_COLLS, sursa autoritara. O lista scrisa de mana driftează la fiecare
  // colectie noua — exact ce s-a intamplat cu `cursuriBnr`, adaugata pentru cursul BNR si absenta
  // din poarta pana la aceasta verificare. Poarta trebuie sa afle singura de colectiile noi.
  const { ARRAY_COLLS } = require('../../src/store');
  const numeColectii = ARRAY_COLLS.map((c) => c.key).concat(['partners', 'openingAnalytic']);
  // ANCORAT la inceputul argumentului: `res.json(S(req).entries)` e o colectie serializata direct,
  // dar `res.json(registruSalarii(S(req).payrollHistory, ...))` e un AGREGAT — colectia doar intra
  // intr-o functie. Fara ancora, poarta ar raporta fals si ar fi dezactivata de primul care o vede.
  const COLECTIE = new RegExp('^\\s*(?:S\\(req\\)|db\\.get\\(\\))\\.(' + numeColectii.join('|') + ')\\b');
  ok('poarta isi ia colectiile din ARRAY_COLLS, nu dintr-o lista scrisa de mana',
    numeColectii.includes('cursuriBnr') && numeColectii.includes('entries') && numeColectii.length > 12);
  const scapate = [];
  for (const f of files) {
    const s = fsx.readFileSync(pth.join(root, f), 'utf8');
    for (const m of s.matchAll(/res\.json\(([^;]{0,160})/g)) {
      if (COLECTIE.test(m[1])) scapate.push(f.split('/').pop() + ': res.json(' + m[1].slice(0, 46).replace(/\s+/g, ' ') + '…');
    }
  }
  ok('nicio colectie nu se serializeaza direct cu res.json'
    + (scapate.length ? ' — ' + scapate.slice(0, 3).join(' | ') : ''), scapate.length === 0);
  ok('poarta chiar detecteaza o colectie scapata', COLECTIE.test("S(req).products)"));
  ok('poarta NU raporteaza un agregat care doar primeste colectia',
    !COLECTIE.test("registruSalarii(S(req).payrollHistory, req.query.year)"));
  ok('poarta nu se declanseaza pe un obiect singular', !COLECTIE.test("res.json(S(req).company)"));

  // ── Al DOILEA strat: colectiile care ies prin SERVICE LAYER ──────────────────────────────────
  // Poarta de mai sus e ancorata pe `res.json(S(req).X)` — ancora e necesara (fara ea, orice
  // agregat care primeste colectia ar fi fals-pozitiv si poarta ar fi dezactivata de primul care
  // o vede). Dar exact din cauza ancorei era OARBA la ruta care intoarce rezultatul unui
  // serviciu: `/api/messages` -> svc.inbox() -> messages.thread(d.messages, uid) trecea neatins,
  // nemarginit. Colectia nu mai apare langa `res.json`, deci prima poarta nu avea ce vedea.
  //
  // Aici se verifica CEALALTA capat: in servicii, o colectie vie folosita ca VALOARE intr-un
  // `return` trebuie sa treaca printr-un plafon (capList/sendList). Exceptiile sunt structurale,
  // nu scrise de mana: `.length` e un agregat numeric, iar `X[...]` e un element singular.
  // Ce NU e o colectie care scapa: metodele de Array care intorc un SCALAR sau un element unic
  // (`d.entries.some(...)` din anafService e un boolean per rand, nu jurnalul intors clientului),
  // plus indexarea `X[...]`. Nu e o lista de exceptii scrisa de mana pentru acest proiect, ci o
  // proprietate a limbajului — de-aia nu drifteaza cand apare un serviciu nou.
  const SCALAR = 'length|some|every|find|findIndex|findLast|includes|indexOf|reduce|join';
  const COLECTIE_VAL = new RegExp('\\b(?:d|db\\.get\\(\\))\\.(' + numeColectii.join('|') + ')\\b'
    + '(?!\\s*\\.(?:' + SCALAR + ')\\b)(?!\\s*\\[)');
  // predicatul EXACT al portii, folosit si de scanare si de auto-verificari: nu se rederiveaza
  const nemarginit = (expr) => COLECTIE_VAL.test(expr) && !/capList|sendList/.test(expr);
  const servicii = fsx.readdirSync(pth.join(root, 'src')).filter((f) => f.endsWith('Service.js'));
  const nemarginite = [];
  for (const f of servicii) {
    const s = fsx.readFileSync(pth.join(root, 'src', f), 'utf8');
    for (const m of s.matchAll(/return\s+([^;]{0,300});/g)) {
      if (nemarginit(m[1])) nemarginite.push(f + ': return ' + m[1].trim().slice(0, 50).replace(/\s+/g, ' ') + '…');
    }
  }
  ok('serviciile isi plafoneaza colectiile vii inainte de a le intoarce'
    + (nemarginite.length ? ' — ' + nemarginite.slice(0, 3).join(' | ') : ''), nemarginite.length === 0);
  ok('poarta pe servicii scaneaza servicii reale, nu o lista goala', servicii.length >= 8);
  ok('poarta pe servicii prinde forma care a scapat (colectie printr-un helper)',
    nemarginit('{ thread: messages.thread(d.messages, uid) }'));
  ok('...si se stinge cand aceeasi expresie trece prin capList',
    !nemarginit('{ thread: capList(messages.thread(d.messages, uid), MAX).items }'));
  ok('...NU se declanseaza pe un numar derivat din colectie',
    !nemarginit('{ removed: n - d.entries.length }'));
  ok('...nici pe un predicat care intoarce boolean per rand',
    !nemarginit('msgs.map((m) => ({ importat: d.entries.some((e) => e.id === m.id) }))'));
  ok('...nici pe un element singular luat prin cheie',
    !nemarginit('{ partner: d.partners[fid][key] }'));
}

section('PWA: manifest + service worker (instalabilitate + siguranta cache)');
{
  const fsx = require('fs'); const pth = require('path');
  const pub = pth.join(RADACINA, 'public');
  const man = JSON.parse(fsx.readFileSync(pth.join(pub, 'manifest.webmanifest'), 'utf8'));
  ok('manifest: name + short_name', !!man.name && !!man.short_name);
  eq('manifest: start_url = /', man.start_url, '/');
  eq('manifest: display standalone (instalabil)', man.display, 'standalone');
  ok('manifest: are icoana 192 si 512', man.icons.some((i) => i.sizes === '192x192') && man.icons.some((i) => i.sizes === '512x512'));
  ok('manifest: are o icoana maskable', man.icons.some((i) => i.purpose === 'maskable'));
  ok('manifest: theme/background din brand', man.theme_color === '#2f2e2a' && man.background_color === '#f0ede4');
  // iconitele referite exista si sunt PNG-uri reale
  for (const ic of man.icons) {
    const f = pth.join(pub, ic.src.replace(/^\//, ''));
    ok('iconita exista: ' + ic.src, fsx.existsSync(f));
    const head = fsx.readFileSync(f).subarray(0, 4);
    ok('iconita e PNG valid: ' + ic.src, head[0] === 0x89 && head.subarray(1, 4).toString() === 'PNG');
  }
  const sw = fsx.readFileSync(pth.join(pub, 'sw.js'), 'utf8');
  ok('SW: are handler de fetch (cerinta de instalabilitate)', /addEventListener\('fetch'/.test(sw));
  ok('SW: doar GET', /req\.method !== 'GET'/.test(sw));
  ok('SW: ocoleste datele de utilizator (/api|/pdf|/xml|/csv|/efactura)', /api\|pdf\|xml\|csv\|efactura/.test(sw));
  ok('SW: doar same-origin', /url\.origin !== self\.location\.origin/.test(sw));
  ok('SW: cache versionat (activate sterge ce e vechi)', /contab-shell-v\d/.test(sw));
  // index.html leaga manifestul + theme-color
  const idx = fsx.readFileSync(pth.join(pub, 'index.html'), 'utf8');
  ok('index.html: <link rel="manifest">', /rel="manifest"[^>]*manifest\.webmanifest/.test(idx));
  ok('index.html: meta theme-color', /name="theme-color"/.test(idx));
  // inregistrarea SW e in core.js, in context sigur
  const core = fsx.readFileSync(pth.join(pub, 'core.js'), 'utf8');
  ok('core.js: inregistreaza sw.js', /serviceWorker'?\s* in navigator/.test(core) && /register\('\/sw\.js'/.test(core));
  ok('core.js: doar in context sigur (https/localhost)', /https:|localhost|127\.0\.0\.1/.test(core.split('serviceWorker')[1] || ''));
}

section('Plafon general de API (uploadGuard.generalLimit)');
{
  const ug = require('../../src/uploadGuard');
  const mk = (uid, ip) => ({ user: uid != null ? { id: uid } : null, ip: ip || '203.0.113.1' });
  const run = (mw, req) => { let out = null; const res = { status(c) { out = c; return this; }, json() { return this; } }; let passed = false; mw(req, res, () => { passed = true; }); return passed ? 'next' : out; };
  const lim = ug.generalLimit(3, 60 * 1000);
  eq('sub plafon: cererile trec (3/3)', [run(lim, mk(501)), run(lim, mk(501)), run(lim, mk(501))].join(','), 'next,next,next');
  eq('peste plafon: 429', run(lim, mk(501)), 429);
  eq('alt utilizator nu e afectat', run(lim, mk(502)), 'next');
  eq('anonimii sunt plafonati per IP', [run(lim, mk(null, '198.51.100.1')), run(lim, mk(null, '198.51.100.1')), run(lim, mk(null, '198.51.100.1')), run(lim, mk(null, '198.51.100.1'))].pop(), 429);
  eq('alt IP anonim nu e afectat', run(lim, mk(null, '198.51.100.2')), 'next');
  eq('plafon 0 = dezactivat', run(ug.generalLimit(0, 60000), mk(501)), 'next');
  ug.pruneRateBuckets(Date.now() + 61 * 1000); // igiena: bucket-urile de test dispar
  eq('dupa expirarea ferestrei, contorul porneste de la zero', run(lim, mk(501)), 'next');
}

section('CSP: style-src FARA unsafe-inline (poarta zero)');
{
  // styleSrc e doar 'self' (src/bootstrap.js): orice element <style> sau atribut style= din
  // markup ar fi BLOCAT de browser. Poarta tine suprafata la zero: stilurile statice merg in
  // u.css/styles.css (data-u sau clase), cele dinamice prin data-style + CSSOM (core.js).
  // setAttribute('style') e si el blocat de CSP — foloseste el.style.prop / el.style.cssText.
  const fsx = require('fs'); const pth = require('path');
  const pub = pth.join(RADACINA, 'public');
  const files = fsx.readdirSync(pub);
  const count = (ext, re) => files.filter((f) => f.endsWith(ext))
    .map((f) => (fsx.readFileSync(pth.join(pub, f), 'utf8').match(re) || []).length)
    .reduce((a, b) => a + b, 0);
  eq('zero elemente <style> in paginile HTML', count('.html', /<style[\s>]/g), 0);
  // Ghilimelele nu se presupun: `style='...'` sau `style=\`...\`` ar fi la fel de inline, dar un
  // regex care cere doar `"` le-ar rata TACIT. Azi sunt zero din fiecare fel (masurat) — poarta
  // trebuie sa ramana adevarata si daca maine cineva scrie altfel.
  eq('zero atribute style= in HTML (data-u/data-style permise)', count('.html', /(?<!data-)style\s*=\s*["'`]/g), 0);
  eq('zero atribute style= in template-urile JS', count('.js', /(?<!data-)style\s*=\s*\\?["'`]/g), 0);
  eq('zero setAttribute(style) in JS (blocat de CSP; foloseste el.style)', count('.js', /setAttribute\((['"])style\1/g), 0);
  ok('CSP: styleSrc nu mai contine unsafe-inline', !/styleSrc[^\]]*unsafe-inline/.test(fsx.readFileSync(pth.join(RADACINA, 'src', 'bootstrap.js'), 'utf8')));
  // Contra-probe pe MECANISM, nu pe fisiere vii: public/ e servit direct din working tree, deci
  // o mutatie de proba acolo ar fi PUBLICA cat dureaza. Verificam ca regexul chiar prinde toate
  // cele trei feluri de ghilimele si ca `data-style` ramane permis.
  const RX_STYLE = /(?<!data-)style\s*=\s*["'`]/g;
  const cate = (s) => (s.match(RX_STYLE) || []).length;
  eq('poarta prinde style= indiferent de ghilimele', cate('<i style="a"><b style=\'b\'><u style=`c`>'), 3);
  eq('data-style ramane permis (calea CSSOM)', cate('<i data-style="color:red">'), 0);

  // ── `.hidden` nu are voie sa fie ANULAT de un utilitar `data-u` ──────────────
  // `.hidden{display:none}` (styles.css) si `[data-u="uNN"]{display:...}` (u.css) au ACEEASI
  // specificitate (0,1,0), iar u.css se incarca AL DOILEA — deci utilitarul castiga si elementul
  // ramane vizibil desi markup-ul zice `class="hidden"`. Exact asa a stat casuta „Tine minte acest
  // dispozitiv" pe ecranul de autentificare: ascunsa in HTML, vizibila pe ecran, aratata tuturor
  // desi apartinea unui flux 2FA care era oprit atunci. E a treia oara cand aceeasi capcana de
  // specificitate musca aici (vezi si `:not(.hidden)` din styles.css si `#tabs`), deci de data
  // asta ramane o poarta, nu o lectie.
  const uDisplay = new Set([...fsx.readFileSync(pth.join(pub, 'u.css'), 'utf8')
    .matchAll(/\[data-u="(u\d+)"\]\{[^}]*display:/g)].map((m) => m[1]));
  ok('u.css chiar are utilitare care seteaza display (altfel poarta e goala)', uDisplay.size > 0);
  const anulate = [];
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const html = fsx.readFileSync(pth.join(pub, f), 'utf8');
    for (const m of html.matchAll(/<[^>]*\bclass="[^"]*\bhidden\b[^"]*"[^>]*>/g)) {
      const du = /data-u="(u\d+)"/.exec(m[0]);
      if (du && uDisplay.has(du.group ? du.group(1) : du[1])) anulate.push(f + ': ' + m[0].slice(0, 80));
    }
  }
  eq('niciun element .hidden nu e facut vizibil de un utilitar data-u', anulate.join(' | '), '');
}

section('Docs: documentatia nu contrazice configuratia reala (fara drift)');
{
  const fsd = require('fs'); const pd = require('path');
  const root = RADACINA;
  const rd = (p) => fsd.readFileSync(pd.join(root, p), 'utf8');

  // Documentele „vii" (descriu starea CURENTA a produsului) — acestea trebuie sa fie adevarate azi.
  // ADR-urile (docs/scalare-crestere.md) si backlogul sunt INTENTIONAT istorice: consemneaza
  // masuratori si decizii la data lor, deci nu intra in poarta de actualitate.
  const DOCS_VII = ['docs/rulare.md', 'docs/api.md', 'docs/arhitectura.md', 'docs/flux-de-lucru.md',
    'docs/documente-fiscal.md', 'docs/guvernanta-fiscala.md', 'docs/validare-oficiala.md',
    'scripts/MONITORING.md', 'CLAUDE.md', 'README.md'];
  // TOATE_DOCS nu se mai scrie de mana: se DERIVA. Un document nou din docs/ era pana acum in
  // afara oricarei verificari — si asa a driftat `dosar-revizie-fiscala.md`, care sustinea „17
  // cazuri" cand corpusul avea 22, si cita „~1.200 aserttiuni". DOCS_VII (setul STRICT, al
  // documentelor care descriu prezentul) ramane explicit, fiindca „viu vs istoric" e o judecata;
  // dar ACOPERIREA DE BAZA — caile citate exista, `npm run` exista, variabilele exista — se
  // aplica automat oricarui document.
  const docsPeDisc = fsd.readdirSync(pd.join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f);
  const ALTE_DOCS = ['README.md', 'STRIPE-SETUP.md', 'schemas/eTransport/README.md']
    .filter((f) => fsd.existsSync(pd.join(root, f)));
  const TOATE_DOCS = [...new Set(DOCS_VII.concat(docsPeDisc, ALTE_DOCS))];
  ok('acoperirea documentelor e derivata din disc, nu scrisa de mana',
    TOATE_DOCS.includes('docs/dosar-revizie-fiscala.md') && TOATE_DOCS.length >= docsPeDisc.length);

  // tot codul, o singura data (verificarea variabilelor de mediu cauta in el)
  const codFisiere = [];
  (function scan(dir) {
    for (const f of fsd.readdirSync(dir)) {
      if (['node_modules', '.git', 'data', 'logs'].includes(f)) continue;
      const full = pd.join(dir, f);
      if (fsd.statSync(full).isDirectory()) scan(full);
      else if (/\.(js|mjs|sh|yml|json)$/.test(f)) codFisiere.push(full);
    }
  })(root);
  const cod = codFisiere.map((f) => fsd.readFileSync(f, 'utf8')).join('\n');

  // 1) Fiecare `npm run X` din documentatie exista in package.json
  const scripturi = new Set(Object.keys(JSON.parse(rd('package.json')).scripts || {}));
  const npmLipsa = [];
  for (const doc of TOATE_DOCS) {
    for (const m of rd(doc).matchAll(/npm run ([a-z0-9:-]+)/g)) if (!scripturi.has(m[1])) npmLipsa.push(doc + ': npm run ' + m[1]);
  }
  ok('fiecare `npm run` din documentatie exista in package.json' + (npmLipsa.length ? ' — ' + npmLipsa.join(', ') : ''), npmLipsa.length === 0);

  // 2) Fiecare cale de fisier citata in documentatie exista. Prinde exact driftul de refactorizare:
  //    `src/pdf.js` a devenit directorul `src/pdf/`, iar documentul a ramas in urma.
  // Cateva cai sunt citate TOCMAI fiindca nu exista (si nu trebuie sa existe) — un contrafactual,
  // nu o referinta. Lista e scurta si fiecare intrare isi poarta motivul; daca se lungeste, semnul
  // e ca documentatia a inceput sa vorbeasca despre fisiere imaginare.
  const CAI_INTENTIONAT_ABSENTE = new Map([
    ['public/package.json', 'CLAUDE.md explica de ce NU exista: ar ajunge servit static clientilor'],
  ]);
  const caiLipsa = [];
  for (const doc of TOATE_DOCS) {
    for (const m of rd(doc).matchAll(/\b((?:src|scripts|test|docs|public)\/[\w./-]+\.(?:json|mjs|js|sh|md|html|css))\b/g)) {
      if (CAI_INTENTIONAT_ABSENTE.has(m[1])) continue;
      if (!fsd.existsSync(pd.join(root, m[1]))) caiLipsa.push(doc + ': ' + m[1]);
    }
  }
  ok('fiecare fisier citat in documentatie exista' + (caiLipsa.length ? ' — ' + [...new Set(caiLipsa)].join(', ') : ''), caiLipsa.length === 0);

  // 3) Fiecare variabila CONTAB_* documentata exista in cod (prinde knob-urile redenumite/scoase)
  const envLipsa = [];
  for (const doc of TOATE_DOCS) {
    for (const m of rd(doc).matchAll(/\bCONTAB_[A-Z0-9_]+/g)) if (!cod.includes(m[0])) envLipsa.push(doc + ': ' + m[0]);
  }
  ok('fiecare variabila CONTAB_* documentata exista in cod' + (envLipsa.length ? ' — ' + [...new Set(envLipsa)].join(', ') : ''), envLipsa.length === 0);

  // 3b) …si DIRECTIA INVERSA: fiecare variabila CITITA din mediu e si explicata undeva.
  // Poarta de mai sus prinde doar knob-urile documentate care au disparut din cod. Cealalta
  // directie driftează tacut: masurat inainte de aceasta verificare, 10 din 65 de variabile nu
  // erau explicate NICAIERI — printre ele `CONTAB_SKIP_LOCK` (dezactiveaza garda single-instance)
  // si pragurile de alerta ale cozii de persistenta. Un knob nedocumentat exista doar pentru cine
  // l-a scris.
  // „Explicata" = in documentatia centrala SAU intr-o linie de COMENTARIU (cineva a scris o
  // propozitie despre ea, fie si in antetul scriptului care o detine) — nu doar folosita.
  const fisiereCod = [];
  const strange = (dir) => {
    for (const f of fsd.readdirSync(pd.join(root, dir), { withFileTypes: true })) {
      const rel = dir + '/' + f.name;
      if (f.isDirectory()) { if (!/node_modules|^\.git|^data/.test(f.name)) strange(rel); continue; }
      if (/\.(js|mjs|sh)$/.test(f.name)) fisiereCod.push(rel);
    }
  };
  for (const d of ['src', 'scripts', 'test']) strange(d);
  fisiereCod.push('server.js', 'ecosystem.config.js');
  const citite = new Set(); const explicate = new Set();
  for (const f of fisiereCod) {
    const p = pd.join(root, f);
    if (!fsd.existsSync(p)) continue;
    const c = fsd.readFileSync(p, 'utf8');
    for (const m of c.matchAll(/process\.env\.(CONTAB_[A-Z0-9_]+)/g)) citite.add(m[1]);
    for (const m of c.matchAll(/\$\{?(CONTAB_[A-Z0-9_]+)/g)) citite.add(m[1]);
    for (const ln of c.split('\n')) {
      const s = ln.trim();
      if (s.startsWith('#') || s.startsWith('//') || s.startsWith('*')) {
        for (const m of ln.matchAll(/\b(CONTAB_[A-Z0-9_]+)/g)) explicate.add(m[1]);
      }
    }
  }
  // `.env.example` E documentatia canonica a variabilelor de mediu, chiar daca nu e un .md —
  // fara el poarta ar cere ca fiecare knob sa fie explicat si intr-un ghid, ceea ce ar impinge
  // spre duplicare, nu spre claritate.
  const docText = TOATE_DOCS.map(rd).join('\n') + '\n' + rd('.env.example');
  const orfane = [...citite].filter((v) => !explicate.has(v) && !docText.includes(v)).sort();
  ok('fiecare variabila CONTAB_* citita din mediu e explicata undeva'
    + (orfane.length ? ' — NEEXPLICATE: ' + orfane.join(', ') : ''), orfane.length === 0);
  ok('poarta chiar vede variabilele din mediu (nu scaneaza o lista goala)', citite.size > 40);

  // 4) Versiunile de Node din documente = matricea CI + minimul din `engines`.
  //    „CI ruleaza pe Node 18 si 20" a supravietuit trecerii CI-ului pe 22/24 exact fiindca nimic
  //    nu compara cele doua fisiere.
  const ci = rd('.github/workflows/ci.yml');
  const majoreCI = new Set([...ci.matchAll(/node-version:\s*\[?([^\]\n]+)\]?/g)]
    .flatMap((m) => m[1].split(',').map((x) => x.replace(/['"\s]/g, '').split('.')[0]))
    .filter((x) => /^\d+$/.test(x)));
  const minEngine = String(JSON.parse(rd('package.json')).engines.node).replace(/[^\d.]/g, '').split('.')[0];
  majoreCI.add(minEngine);
  const nodeStrain = (text, permise) => [...text.matchAll(/Node[\s≥>=]*(\d{2})(?:\.\d+)?/g)]
    .filter((m) => !permise.has(m[1])).map((m) => m[0].trim());
  const nodeGresit = [];
  for (const doc of DOCS_VII) for (const g of nodeStrain(rd(doc), majoreCI)) nodeGresit.push(doc + ': „' + g + '"');
  ok('versiunile de Node din documente sunt cele din CI/engines (' + [...majoreCI].sort().join(', ') + ')'
    + (nodeGresit.length ? ' — ' + [...new Set(nodeGresit)].join(', ') : ''), nodeGresit.length === 0);

  // 4b) Mai ascutit: PROPOZITIA care vorbeste despre CI trebuie sa listeze EXACT matricea. Regula
  //     de mai sus accepta si minimul din `engines`, deci ar lasa sa treaca „CI ruleaza pe Node 22"
  //     cand matricea e 22+24. Aici comparam multimile.
  const fraze = rd('docs/rulare.md').split(/\n\s*\n/).filter((f) => /\bCI\b/.test(f) && /Node/.test(f));
  const cereriCI = [];
  for (const f of fraze) {
    const numere = new Set([...f.matchAll(/\b(\d{2})\b/g)].map((m) => m[1]).filter((n) => Number(n) >= 18 && Number(n) <= 40));
    if (!numere.size) continue;
    const lipsa = [...majoreCI].filter((v) => v !== minEngine && !numere.has(v));
    const inPlus = [...numere].filter((v) => !majoreCI.has(v));
    if (lipsa.length || inPlus.length) cereriCI.push('lipsesc: [' + lipsa.join(',') + '], in plus: [' + inPlus.join(',') + ']');
  }
  ok('fraza despre CI din docs/rulare.md listeaza exact matricea din ci.yml'
    + (cereriCI.length ? ' — ' + cereriCI.join(' | ') : ''), cereriCI.length === 0);

  // 4c) Probele pe driverul de PRODUCTIE se declara O SINGURA DATA: in scripts/test-pg.sh, pe
  //     care il cheama si CI si dezvoltatorul. Inainte, CI le avea inlantuite ca pasi proprii,
  //     iar reteta locala statea scrisa de mana in CLAUDE.md — doua liste care puteau (si chiar
  //     au) drifta. Daca cineva re-inlantuie pasii in ci.yml, jobul redevine o a doua lista.
  // ancorat pe `run:`, nu oriunde in fisier: altfel o simpla MENTIUNE intr-un comentariu tine
  // aserttia verde dupa ce pasul real a fost inlocuit (prins printr-o mutatie care a trecut asa)
  ok('CI cheama `npm run test-pg`, nu isi rescrie propriii pasi pe pg', /run:\s*npm run test-pg/.test(ci));
  // Doar JOBUL test-postgres, nu tot fisierul: pragul SQL 0 apare legitim si in jobul pe sqlite
  // (dovada de echivalenta SQL == RAM acolo), iar o verificare pe tot ci.yml l-ar raporta gresit.
  const jobPg = (ci.match(/^ {2}test-postgres:[\s\S]*?(?=^ {2}\w[\w-]*:|Z)/m) || [''])[0];
  ok('poarta chiar izoleaza jobul test-postgres', jobPg.includes('postgres:16') && jobPg.length > 200);
  ok('...iar jobul nu mai are pasi pe pg inlantuiti direct (ar fi a doua lista)',
    !/run:\s*node test\//.test(jobPg));
  const tpg = rd('scripts/test-pg.sh');
  ok('scriptul chiar ruleaza cele trei probe',
    /test\/store-pg\.js/.test(tpg) && /CONTAB_TEST_DRIVER=pg/.test(tpg) && /CONTAB_SQL_READ_THRESHOLD=0/.test(tpg));
  ok('scriptul distinge NEVERIFICAT (docker lipsa) de teste picate', /exit 2/.test(tpg));

  // 5) Portul implicit din documente = cel din cod. Doua valori diferite in acelasi document
  //    (3000 la pornire, 8080 la „deschide in browser") sunt semnul clasic de doc netestat.
  const portReal = (rd('src/lifecycle.js').match(/process\.env\.PORT\s*\|\|\s*(\d+)/) || [])[1];
  ok('portul implicit se poate citi din cod', !!portReal);
  const portGresit = [];
  for (const doc of TOATE_DOCS) {
    // doar URL-urile APLICATIEI: `postgres://...@localhost:55432` e alt serviciu, nu o contrazicere
    for (const m of rd(doc).matchAll(/https?:\/\/localhost:(\d{2,5})/g)) if (m[1] !== portReal) portGresit.push(doc + ': localhost:' + m[1]);
  }
  ok('adresele „localhost:PORT" din documente folosesc portul implicit real (' + portReal + ')'
    + (portGresit.length ? ' — ' + [...new Set(portGresit)].join(', ') : ''), portGresit.length === 0);

  // 6) NUMERELE DE VERIFICARI din documentatia VIE. Regula era doar pe docs/rulare.md si a lasat
  //    sa drifteze exact ce trebuia sa prinda: „18 verificari cap-coada" in arhitectura.md (erau
  //    36) si „~1.200 aserttiuni" in guvernanta-fiscala.md (erau 1948). Acum, in ORICE document viu,
  //    o cifra langa „verificari/aserttiuni" trebuie sa fie ori VERIFICATA aici, ori sa nu existe.
  //    (ADR-urile si backlogul raman in afara: acolo cifra e o masuratoare datata, nu o descriere
  //    a prezentului.)
  const nrOk = (fisier) => (rd(fisier).match(/^\s*ok\(/gm) || []).length;
  // Afirmatii numerice ACCEPTATE, fiindca sunt confruntate cu realitatea la fiecare rulare.
  const AFIRMATII = [
    { doc: 'docs/arhitectura.md', rx: /(\d+) verific[ăa]ri cap-coad[ăa]/,
      real: () => nrOk('scripts/e2e.mjs'), ce: 'apeluri ok() in scripts/e2e.mjs' },
    { doc: 'docs/arhitectura.md', rx: /(\d+) verific[ăa]ri pe instan[țt][ăa] izolat[ăa]/,
      real: () => nrOk('scripts/e2e-izolat.mjs'), ce: 'apeluri ok() in scripts/e2e-izolat.mjs' },
  ];
  const afirmGresite = [];
  for (const a of AFIRMATII) {
    const m = rd(a.doc).match(a.rx);
    if (!m) { afirmGresite.push(a.doc + ': afirmatia despre „' + a.ce + '" a disparut din document'); continue; }
    const real = a.real();
    if (Number(m[1]) !== real) afirmGresite.push(a.doc + ': scrie ' + m[1] + ', real ' + real + ' (' + a.ce + ')');
  }
  ok('afirmatiile numerice din documente sunt cele reale'
    + (afirmGresite.length ? ' — ' + afirmGresite.join(' | ') : ''), afirmGresite.length === 0);

  // Citate istorice: cifra descrie un incident din trecut, nu prezentul. Fiecare isi poarta motivul.
  const CIFRE_ISTORICE = new Map([
    ['CLAUDE.md', /557 verific[ăa]ri trecute/],  // incidentul CONTAB_TEST_DRIVER: suita rula pe alt driver
  ]);
  const cifreLibere = [];
  for (const doc of DOCS_VII) {
    const text = rd(doc);
    for (const m of text.matchAll(/[~\d][\d.,]*\s*(?:de\s+)?(?:verific[ăa]ri|aser[țt]iuni)/gi)) {
      const bucata = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
      if (AFIRMATII.some((a) => a.doc === doc && a.rx.test(bucata))) continue;   // verificata mai sus
      const ist = CIFRE_ISTORICE.get(doc);
      if (ist && ist.test(bucata)) continue;                                      // citat istoric (se cauta in CONTEXT)
      cifreLibere.push(doc + ': „' + m[0].trim() + '"');
    }
  }
  ok('nicio cifra de verificari NEVERIFICATA in documentatia vie'
    + (cifreLibere.length ? ' — ' + cifreLibere.join(', ') : ''), cifreLibere.length === 0);

  // 6b) DOCUMENTATIA FISCALA ca artefact de release: fiecare declaratie pe care codul o GENEREAZA
  //     trebuie sa apara in jurnalul de conformitate. Altfel se poate livra o iesire fiscala noua
  //     fara nicio dovada de validare — si nimeni n-ar observa lipsa.
  const rutePeXml = [...rd('src/routes/declarationsXml.js').matchAll(/app\.get\('\/xml\/([a-z0-9]+)/g)]
    .map((m) => m[1].toUpperCase()).filter((t) => /^D\d+$/.test(t) || t === 'SAFT');
  ok('se pot citi declaratiile generate din rute', rutePeXml.length >= 6);
  const jurnal = rd('docs/validare-oficiala.md');
  const nedovedite = [...new Set(rutePeXml)].filter((t) => !jurnal.includes(t === 'SAFT' ? 'SAF-T' : t));
  ok('fiecare declaratie generata apare in jurnalul de validare oficiala'
    + (nedovedite.length ? ' — LIPSESC: ' + nedovedite.join(', ') : ''), nedovedite.length === 0);

  // 7) Numele grupurilor din meniu (public/index.html) apar in ghidul de rulare. Verificarea e
  //    COD -> DOC, deci prinde si redenumirea, si grupul nou nedocumentat. Exact driftul care a
  //    trecut neobservat: documentul descria categorii („Operational", „Registre", „Nomenclatoare")
  //    care nu mai existau in interfata de ani.
  const html = rd('public/index.html');
  const grupuri = [...html.matchAll(/class="navlabel"[^>]*>([^<]+)/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim()).filter(Boolean);
  ok('meniul are grupuri de citit din index.html', grupuri.length >= 5);
  const rulare = rd('docs/rulare.md');
  const grupuriNedocumentate = grupuri.filter((g) => !rulare.includes(g));
  ok('fiecare grup din meniu apare in docs/rulare.md'
    + (grupuriNedocumentate.length ? ' — ' + grupuriNedocumentate.join(', ') : ''), grupuriNedocumentate.length === 0);

  // Poarta trebuie sa POATA pica: verificam detectoarele pe intrari construite anume.
  ok('detectorul de cai chiar prinde un fisier inexistent',
    !fsd.existsSync(pd.join(root, 'src/nu-exista-acest-fisier.js')));
  // allowlist-ul nu are voie sa acopere fisiere care AU aparut intre timp (altfel ar ascunde drift)
  const allowlistInutil = [...CAI_INTENTIONAT_ABSENTE.keys()].filter((f) => fsd.existsSync(pd.join(root, f)));
  ok('lista de cai „intentionat absente" nu contine fisiere care exista'
    + (allowlistInutil.length ? ' — ' + allowlistInutil.join(', ') : ''), allowlistInutil.length === 0);
  // Detectorul se verifica pe intrari construite, NU fixand matricea CI: daca maine se adauga
  // legitim Node 20, poarta nu trebuie sa cada dintr-un test despre ea insasi.
  ok('detectorul de Node prinde o versiune din afara matricei',
    nodeStrain('rulează pe Node 18 și 20', majoreCI).length === 1);
  ok('detectorul de Node accepta o versiune din matrice',
    nodeStrain('cere Node ' + [...majoreCI][0], majoreCI).length === 0);
  ok('detectorul de port compara cu valoarea din cod', portReal === '8080');
  ok('detectorul de meniu ar prinde un grup redenumit', !rulare.includes('🧭 Grup Care Nu Exista'));
}

section('Docs API: rutele documentate exista in cod (fara drift)');
{
  const fsx = require('fs'); const pth = require('path');
  const root = RADACINA;
  const norm = (m, p) => m.toUpperCase() + ' ' + p.replace(/\?.*$/, '').replace(/:[a-zA-Z0-9_]+|\{[a-zA-Z0-9_]+\}/g, ':_').replace(/\/$/, '');
  // rutele DOCUMENTATE in docs/api.md: `METHOD /path`
  const apiMd = fsx.readFileSync(pth.join(root, 'docs', 'api.md'), 'utf8');
  const documented = new Set();
  for (const m of apiMd.matchAll(/`(GET|POST|PUT|DELETE)\s+(\/[a-zA-Z0-9/_:{}?=.&-]+)`/g)) {
    const r = norm(m[1], m[2]);
    // docs foloseste forma prescurtata `DELETE /:id` relativa la ruta precedenta (ex. dupa
    // `GET/POST /api/products`) — nu e o ruta de sine statatoare, deci o sarim.
    if (/ \/:_$/.test(r)) continue;
    documented.add(r);
  }
  // rutele INREGISTRATE in cod: app.method('/path'
  const codeFiles = ['server.js', 'src/authRoutes.js', ...fsx.readdirSync(pth.join(root, 'src', 'routes')).map((f) => 'src/routes/' + f)];
  const registered = new Set();
  for (const f of codeFiles) {
    const s = fsx.readFileSync(pth.join(root, f), 'utf8');
    for (const m of s.matchAll(/app\.(get|post|put|delete)\('(\/[a-zA-Z0-9/_:.-]+)'/g)) registered.add(norm(m[1], m[2]));
  }
  ok('docs/api.md are rute documentate (grep-abile)', documented.size > 50);
  const drifted = [...documented].filter((r) => !registered.has(r));
  ok('fiecare ruta documentata exista in cod (drift = ' + drifted.length + ')' + (drifted.length ? ': ' + drifted.slice(0, 5).join(', ') : ''), drifted.length === 0);

  // ── Poartă: orice rută de SCRIERE arată o formă de autorizare ──
  // Lectia din `/api/accounts/import` (merge d117de9): ruta scria planul de conturi GLOBAL fara
  // requireAdmin si fara scoping, iar un utilizator legat de o singura firma redenumea conturi
  // pentru toate. Autentificarea e garantata central (o singura garda in bootstrap), dar
  // AUTORIZAREA e per-ruta — deci se poate uita, si atunci nimic nu semnaleaza.
  // Dovada acceptata: scoping pe firma (activeId/S(req)/reqFirma/canAccess/firmaId), garda de
  // admin, sau predarea lui req.user unui serviciu care autorizeaza el (tiparul reqEntry).
  const AUTZ = /\bactiveId\(|\bS\(req\)|\breqFirma\b|\bcanAccess\(|\bfirmaId\b|\breq\.user\b|\brequireAdmin\b|\bdemoContLock\b/;
  // Exceptii REVIZUITE, fiecare cu motivul ei. O ruta noua care ajunge aici trebuie justificata
  // explicit — asta e rostul portii, nu sa fie ocolita.
  const FARA_AUTZ_OK = new Map([
    ['POST /api/efactura/parse', 'fara persistenta: converteste XML-ul primit in campuri, nu scrie nimic'],
    ['POST /api/xlsx-to-csv', 'fara persistenta: conversie de format pentru fluxurile de import'],
    ['POST /api/checkout-guest', 'PUBLICA prin proiectare (vizitator neautentificat, inainte de cont)'],
    ['POST /api/production', 'autorizata in helperul doProduction (activeId + S(req)), nu in corpul rutei'],
  ]);
  const neautorizate = [];
  for (const f of codeFiles) {
    const s = fsx.readFileSync(pth.join(root, f), 'utf8');
    for (const m of s.matchAll(/app\.(post|put|patch|delete)\(\s*'([^']+)'([\s\S]{0,900}?)(?=\n {2}app\.|\n\};|$)/g)) {
      const cheie = m[1].toUpperCase() + ' ' + m[2];
      if (AUTZ.test(m[3]) || FARA_AUTZ_OK.has(cheie)) continue;
      neautorizate.push(cheie + '  (' + f + ')');
    }
  }
  ok('fiecare ruta de scriere arata o autorizare (sau e pe lista revizuita)'
    + (neautorizate.length ? ' — ' + neautorizate.slice(0, 5).join(' | ') : ''), neautorizate.length === 0);
  // poarta trebuie sa POATA pica
  ok('poarta de autorizare chiar detecteaza o ruta fara garda',
    !AUTZ.test("(req, res) => run(res, () => { const r = svc.importAccounts((req.body || {}).csv); return r; })"));
  ok('poarta accepta scoping pe firma', AUTZ.test("(req, res) => res.json(svc.list(activeId(req)))"));
  ok('poarta accepta garda de admin', AUTZ.test("requireAdmin, (req, res) => res.json(svc.all())"));
}

section('Documente juridice: fara placeholdere si cu identitate consecventa');
{
  const fsx = require('fs'); const pth = require('path');
  const root = RADACINA;
  const PAGINI = ['termeni.html', 'confidentialitate.html', 'dpa.html'];
  for (const f of PAGINI) ok('pagina juridica exista: ' + f, fsx.existsSync(pth.join(root, 'public', f)));

  // Placeholderele de forma [DENUMIREA OPERATORULUI] / [CUI] sunt cea mai vizibila forma de
  // „nefinalizat" pe un site care vinde. Ele NU au voie sa ajunga in productie — iar singurul mod
  // de a fi sigur nu e sa-ti amintesti, ci sa pice suita.
  const PH = /\[[A-ZĂÂÎȘȚ][A-ZĂÂÎȘȚ .0-9-]{2,}\]/g;
  const gasite = [];
  for (const f of PAGINI) {
    const txt = fsx.readFileSync(pth.join(root, 'public', f), 'utf8');
    for (const m of (txt.match(PH) || [])) gasite.push(f + ': ' + m);
  }
  ok('niciun placeholder nefinalizat in documentele juridice'
    + (gasite.length ? ' — ' + gasite.slice(0, 4).join(' | ') : ''), gasite.length === 0);
  // poarta trebuie sa POATA pica
  ok('poarta chiar detecteaza un placeholder', PH.test('operat de [DENUMIREA OPERATORULUI], cu'));

  // Identitatea juridica apare in doua documente; daca se schimba intr-unul si se uita in celalalt,
  // ai doua adevaruri diferite pe acelasi site. Comparam CUI-ul si denumirea intre pagini.
  const idOf = (f) => {
    const txt = fsx.readFileSync(pth.join(root, 'public', f), 'utf8');
    // Ancora e FRAZA legala, nu cuvantul „CUI" (care apare si in alte contexte) — dar si FORMA
    // valorii: fara ea, `cod de identificare fiscală) vor fi publicate … <b>contact@…</b>` din
    // textul care ANUNTA identitatea era citit drept identitate publicata. O ancora care prinde
    // orice <b> de dupa fraza raporteaza o adresa de e-mail ca fiind un CUI.
    const cui = (txt.match(/cod de identificare fiscal[ăa][^<]*<b>\s*((?:RO\s*)?\d[\d\s]*)<\/b>/i) || [])[1] || null;
    return cui ? cui.replace(/\s/g, '') : null;
  };
  const cuiT = idOf('termeni.html'); const cuiD = idOf('dpa.html');
  const termeniTxt = fsx.readFileSync(pth.join(root, 'public', 'termeni.html'), 'utf8');

  // Datele de identificare FICTIVE nu au voie sa se intoarca, in nicio pagina. Au stat luni intregi
  // in productie („EXEMPLU SOFT S.R.L.", J40/1234/2020, RO12345678) fara ca nimic sa le semnaleze,
  // fiindca poarta veche cerea doar ca un CUI sa EXISTE — nu ca el sa fie real.
  const FICTIVE = [/EXEMPLU SOFT/i, /J40\/1234\/2020/, /RO12345678/, /Str\.\s*X\s*nr\./i];
  const cuFictive = [];
  for (const f of PAGINI) {
    const txt = fsx.readFileSync(pth.join(root, 'public', f), 'utf8');
    for (const rx of FICTIVE) if (rx.test(txt)) cuFictive.push(f + ': ' + rx.source);
  }
  ok('nicio identitate fictiva in documentele juridice'
    + (cuFictive.length ? ' — ' + cuFictive.slice(0, 4).join(' | ') : ''), cuFictive.length === 0);

  // IMPLICATIA care chiar apara: se pot incasa bani DOAR daca exista o parte contractanta
  // identificata. Invers nu se cere — cat timp incasarea e oprita, absenta identitatii e starea
  // corecta, nu un gol. Poarta se muta singura odata cu PLATI_SUSPENDATE, deci ziua in care cineva
  // porneste incasarea fara sa completeze identitatea e ziua in care suita pica.
  const plansMod = require('../../src/plans');
  if (plansMod.PLATI_SUSPENDATE) {
    ok('incasare oprita -> nicio identitate provizorie afisata', !cuiT && !cuiD);
    ok('...iar documentele spun de ce', /[îi]n curs de [îi]nfiin[țt]are/i.test(termeniTxt));
    // `\s+`, nu spatiu: fraza e rupta pe doua randuri in HTML, iar o poarta care cere exact un
    // spatiu pica la prima reasezare a textului — adica din motivul gresit.
    ok('...si ca nu se incaseaza nimic', /nu se\s+[îi]ncaseaz[ăa]\s+nicio\s+sum[ăa]/i.test(termeniTxt));
  } else {
    ok('incasare pornita -> CUI in ambele documente', !!cuiT && !!cuiD);
    ok('incasare pornita -> numar de ordine in Registrul Comertului', /J\d+\/\d+\/\d{4}/.test(termeniTxt));
  }
  // RAMURA CARE NU A RULAT NICIODATA. Cat timp incasarea e oprita, `else`-ul de mai sus e cod
  // mort — iar el e exact codul care va conta in ziua comutarii. Aici se executa amandoua
  // ramurile pe predicate PURE, deci se stie ACUM ce va cere poarta atunci, nu se afla atunci.
  {
    const cerinte = (cui1, cui2, txt) => ({
      cuiInAmbele: !!cui1 && !!cui2,
      numarRegistru: /J\d+\/\d+\/\d{4}/.test(txt),
      faraFrazaDeSuspendare: !/[îi]n curs de [îi]nfiin[țt]are/i.test(txt),
    });
    // (a) starea de AZI, verificata explicit ca fiind cea de „incasare oprita"
    const azi = cerinte(cuiT, cuiD, termeniTxt);
    ok('azi: incasarea e oprita, deci identitatea lipseste in mod CORECT',
      plansMod.PLATI_SUSPENDATE && !azi.cuiInAmbele && !azi.faraFrazaDeSuspendare);
    // (b) ce ar cere poarta daca s-ar comuta ACUM, fara sa se completeze identitatea: trebuie sa
    //     REFUZE. Daca predicatul ar trece pe textul actual, poarta ar fi decorativa.
    ok('daca s-ar porni incasarea pe textele de azi, poarta ar pica', !azi.cuiInAmbele || !azi.numarRegistru);
    // (c) si trebuie sa TREACA pe un text complet — altfel poarta ar bloca si comutarea corecta.
    const textComplet = 'S.C. EXEMPLU S.R.L., J40/9999/2026, cod de identificare fiscală) <b>RO99999999</b>';
    const complet = cerinte('RO99999999', 'RO99999999', textComplet);
    ok('...si ar trece pe un text complet (CUI in ambele + numar de ordine + fara „in curs")',
      complet.cuiInAmbele && complet.numarRegistru && complet.faraFrazaDeSuspendare);
  }

  ok('CUI identic in termeni si DPA' + (cuiT && cuiD && cuiT !== cuiD ? ' — ' + cuiT + ' vs ' + cuiD : ''),
    !cuiT || !cuiD || cuiT === cuiD);

  // DPA-ul trebuie sa acopere subiectele fara de care nu e un acord art. 28, ci un text frumos.
  const dpa = fsx.readFileSync(pth.join(root, 'public', 'dpa.html'), 'utf8');
  for (const [ce, rx] of [
    ['subimputerniciti', /sub[iî]mputernicit/i],
    ['instructiuni documentate', /instruc[țt]iunilor tale documentate/i],
    ['notificarea incidentelor', /[îi]nc[ăa]lcare a securit[ăa][țt]ii/i],
    ['stergere la incetare', /Anexa 3/],
    ['transferuri internationale', /clauze contractuale standard/i],
    ['CNP tratat explicit', /CNP/],
  ]) ok('DPA acopera: ' + ce, rx.test(dpa));

  // Furnizorii chiar folositi de cod trebuie sa fie DECLARATI (altfel lista e o fictiune).
  const conf = fsx.readFileSync(pth.join(root, 'public', 'confidentialitate.html'), 'utf8');
  const aiSrc = fsx.readFileSync(pth.join(root, 'src', 'aiExtractor.js'), 'utf8');
  if (/'openai'/.test(aiSrc)) {
    ok('OpenAI e folosit in cod, deci declarat in politica', /OpenAI/i.test(conf));
    ok('...si in anexa de subimputerniciti', /OpenAI/i.test(dpa));
  }
  if (/anthropic/i.test(aiSrc)) ok('Anthropic declarat in politica', /Anthropic/i.test(conf));
  const authSrc = fsx.readFileSync(pth.join(root, 'src', 'auth.js'), 'utf8');
  if (/pwnedpasswords/.test(authSrc)) ok('verificarea parolelor la HIBP e declarata', /Pwned/i.test(conf));

  // Localizarea IP-urilor trimite adrese ale utilizatorilor unui TERT, deci e subimputernicit.
  // Poarta se ancoreaza pe GAZDA din cod, nu pe un nume scris de mana: daca maine se schimba
  // furnizorul, declaratia trebuie sa se schimbe odata cu el, altfel anexa devine o fictiune —
  // exact esecul pe care restul acestei sectiuni il previne pentru ceilalti furnizori.
  const geoSrc = fsx.readFileSync(pth.join(root, 'src', 'geoip.js'), 'utf8');
  const gazdaGeo = (geoSrc.match(/https:\/\/([a-z0-9.-]+)\//i) || [])[1] || '';
  ok('modulul de geolocalizare numeste o gazda concreta', !!gazdaGeo);
  const folositGeo = fsx.readdirSync(pth.join(root, 'src'))
    .some((f) => f.endsWith('.js') && f !== 'geoip.js'
      && /require\(['"]\.\/geoip['"]\)/.test(fsx.readFileSync(pth.join(root, 'src', f), 'utf8')));
  if (folositGeo && gazdaGeo) {
    ok('furnizorul de geolocalizare (' + gazdaGeo + ') e declarat in politica', conf.includes(gazdaGeo));
    ok('...si in anexa de subimputerniciti din DPA', dpa.includes(gazdaGeo));
    ok('...cu mentiunea ca pleaca DOAR adresa IP', /doar[^.<]{0,20}adres[ăa]\s+IP/i.test(conf) || /doar[^.<]{0,20}o adres[ăa] IP/i.test(dpa));
  }

  // Un DPA pe care nimeni nu l-a acceptat nu e opozabil: ecranul de inscriere trebuie sa-l numeasca.
  const idx = fsx.readFileSync(pth.join(root, 'public', 'index.html'), 'utf8');
  const accept = (idx.match(/Prin crearea contului accep[țt]i[^<]*(?:<[^>]+>[^<]*)*?<\/p>/) || [''])[0];
  ok('acceptarea la inscriere mentioneaza si DPA-ul', /dpa\.html/.test(accept));
}

section('2FA: login si Setari spun acelasi lucru (fara auto-blocare)');
{
  const fsx = require('fs'); const pth = require('path');
  const root = RADACINA;
  const idx = fsx.readFileSync(pth.join(root, 'public', 'index.html'), 'utf8');
  const setari = fsx.readFileSync(pth.join(root, 'public', 'settings.js'), 'utf8');

  // Cele doua jumatati ale lui 2FA au driftat deja o data, si consecinta era maxima: campul de cod
  // de pe login a fost dezactivat (decizie deliberata), dar butonul de activare din Setari a ramas.
  // Cine si-ar fi pornit 2FA nu s-ar mai fi putut autentifica NICIODATA — nu exista ruta de admin
  // care sa stearga 2FA de pe alt cont, deci recuperarea cerea editarea directa a bazei.
  // Poarta leaga starile in AMBELE sensuri: nici activare fara camp, nici camp fara activare.
  const campLogin = (idx.match(/<label id="codeRow"[\s\S]*?<\/label>/) || [''])[0];
  ok('campul de cod 2FA de pe login exista in formular', /name="code"/.test(campLogin));
  const loginBlocat = /\bdisabled\b/.test(campLogin);

  const arePornire = /id="twofaStart"/.test(idx) || /id="twofaEnable"/.test(idx);
  const cheamaPornire = /\/api\/2fa\/(setup|enable)/.test(setari);

  if (loginBlocat) {
    ok('login blocat -> niciun buton de pornire 2FA in interfata', !arePornire);
    ok('login blocat -> Setari nu mai cheama /api/2fa/setup|enable', !cheamaPornire);
    ok('...dar iesirea ramane (cine are 2FA si-l poate opri)', /id="twofaDisableWrap"/.test(idx) && /\/api\/2fa\/disable/.test(setari));
    ok('...si utilizatorului i se spune de ce', /momentan indisponibil/i.test(idx));

    // Nicio pagina SI NICIUN MODUL nu are voie sa mai RECOMANDE pornirea 2FA cat timp ea blocheaza
    // contul. Prima forma a acestei porti citea doar `index.html` si trecea — in timp ce
    // `authui.js` inca afisa, dupa schimbarea parolei, „Îți recomandăm să activezi și 2FA din
    // Setări" si derula pana la butonul disparut. Adica poarta era verde exact peste indemnul care
    // ducea la blocarea contului. Perimetrul se DERIVA din directorul public/, nu e o lista scrisa
    // de mana — a doua lectie a aceleiasi greseli.
    const RECOMANDA = /recomand[ăa]m[^.<]{0,40}activezi[^.<]{0,40}2FA/i;
    const cuIndemn = [];
    for (const f of fsx.readdirSync(pth.join(root, 'public'))) {
      if (!/\.(js|html)$/.test(f)) continue;
      if (RECOMANDA.test(fsx.readFileSync(pth.join(root, 'public', f), 'utf8'))) cuIndemn.push(f);
    }
    ok('nicio recomandare de a porni 2FA, in niciun fisier din public/'
      + (cuIndemn.length ? ' — ' + cuIndemn.join(', ') : ''), cuIndemn.length === 0);
    ok('poarta chiar prinde indemnul', RECOMANDA.test('Parolă schimbată. Îți recomandăm să activezi și 2FA din Setări.'));

    // Un ascultator ramas pe un id disparut nu arunca (`if (t)`), dar deruleaza catre nimic; iar
    // unul NEgardat ar rupe tot modulul la import. Nici scrollIntoView catre butonul scos.
    const jsPublic = fsx.readdirSync(pth.join(root, 'public')).filter((f) => f.endsWith('.js'));
    const orfane = jsPublic.filter((f) => /#twofaStart|#twofaEnable/.test(fsx.readFileSync(pth.join(root, 'public', f), 'utf8')));
    ok('niciun modul nu mai cauta butoanele de pornire 2FA'
      + (orfane.length ? ' — ' + orfane.join(', ') : ''), orfane.length === 0);
  } else {
    ok('login functional -> butonul de pornire 2FA exista', arePornire);
    ok('login functional -> Setari cheama /api/2fa/setup|enable', cheamaPornire);
  }

  // Poarta trebuie sa POATA pica: pe forma veche a campului (fara `disabled`) verdictul se inverseaza.
  ok('poarta chiar distinge cele doua stari', /\bdisabled\b/.test('<input name="code" disabled />')
    && !/\bdisabled\b/.test('<input name="code" inputmode="numeric" />'));
}

section('Poarta: fiecare intrare de meniu are sectiune, si fiecare sectiune are intrare');
{
  const fsx = require('fs'); const pth = require('path');
  const html = fsx.readFileSync(pth.join(RADACINA, 'public', 'index.html'), 'utf8');
  // Spargerea paginii Setari in cinci a mutat 19 panouri intre sectiuni. Modul de esec al unei
  // astfel de operatii nu e o eroare, ci o TACERE: o intrare de meniu care nu mai deschide nimic
  // (sectiune redenumita) sau o sectiune orfana pe care n-o mai poate ajunge nimeni (intrare
  // uitata). Ambele arata perfect pana cand cineva da clic.
  const meniu = [...new Set([...html.matchAll(/<button[^>]*data-tab="([^"]+)"/g)].map((m) => m[1]))];
  const sectiuni = [...new Set([...html.matchAll(/<section id="tab-([^"]+)"/g)].map((m) => m[1]))];
  ok('poarta chiar vede meniul (nu o lista goala)', meniu.length > 20);
  ok('poarta chiar vede sectiunile', sectiuni.length > 20);
  const faraSectiune = meniu.filter((t) => !sectiuni.includes(t));
  ok('nicio intrare de meniu fara sectiune'
    + (faraSectiune.length ? ' — DUC NICAIERI: ' + faraSectiune.join(', ') : ''), faraSectiune.length === 0);
  // O sectiune fara intrare de meniu NU e automat orfana: la unele se ajunge doar programatic
  // (`tab-abonament` se deschide din bannerul de plata si din butoanele de plan, deliberat — nu-si
  // are locul in meniul permanent). Orfana e cea la care nu duce NIMIC: nici meniu, nici `goTab`.
  const js = fsx.readdirSync(pth.join(RADACINA, 'public'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fsx.readFileSync(pth.join(RADACINA, 'public', f), 'utf8')).join('\n');
  const navigate = new Set([...js.matchAll(/goTab\(\s*'([a-z-]+)'/g)].map((m) => m[1])
    .concat([...js.matchAll(/go:\s*'([a-z-]+)'/g)].map((m) => m[1])));
  const orfane = sectiuni.filter((t) => !meniu.includes(t) && !navigate.has(t));
  ok('nicio sectiune la care sa nu duca nimic'
    + (orfane.length ? ' — ORFANE: ' + orfane.join(', ') : ''), orfane.length === 0);
  ok('poarta chiar vede navigarile programatice', navigate.size > 3);

  // Al doilea capat: scurtaturile care navigheaza din HTML (`data-go`) — de pe Acasa si din
  // fluxurile ghidate. Ancora de mai sus se uita doar la `data-tab`
  // si la `goTab(...)` din JS, deci era oarba exact aici — iar defectul e tacut: `goTab` pe un nume
  // inexistent deselecteaza tot si nu activeaza nimic, adica ecran GOL.
  const destinatiiHtml = [...new Set([...html.matchAll(/data-go="([a-z-]+)"/g)].map((m) => m[1]))];
  ok('poarta vede butoanele care navigheaza din HTML', destinatiiHtml.length > 5);
  const dusNicaieri = destinatiiHtml.filter((t) => !sectiuni.includes(t));
  ok('niciun buton `data-go` nu duce intr-un ecran gol'
    + (dusNicaieri.length ? ' — FARA SECTIUNE: ' + dusNicaieri.join(', ') : ''), dusNicaieri.length === 0);
  // Pe mobil se refoloseste arborele #tabs; o bara/panou paralel ar reintroduce driftul de mai sus.
  ok('mobilul nu reintroduce o a doua lista de destinatii',
    !/bottomnav|moreSheet|moreBtn|data-tabs=/.test(html));

  // Meniul nu are voie sa promita ce pagina nu contine. Cazul real: intrarea „Declaratii ANAF
  // (D112, SAF-T)" numea SAF-T de luni de zile, in timp ce panoul lui statea in „Situatii
  // financiare", sub Rapoarte. Nimic nu semnala — eticheta si continutul nu se intalneau nicaieri.
  const eticheta = (tab) => {
    const m = html.match(new RegExp('<button data-tab="' + tab + '"[^>]*>([\\s\\S]*?)</button>'));
    return m ? m[1].replace(/<[^>]+>/g, ' ') : '';
  };
  const corpSectiune = (tab) => {
    const i = html.indexOf('<section id="tab-' + tab + '"');
    if (i < 0) return '';
    const j = html.indexOf('<section id="tab-', i + 10);
    return html.slice(i, j < 0 ? html.length : j);
  };
  // Ancora e CAPACITATEA (un link/control care chiar face lucrul), nu cuvantul. Prima forma cerea
  // doar ca numele sa apara undeva in sectiune — si trecea pe o simpla mentiune in textul
  // explicativ: „declaratiile (D112, D300, SAF-T…) sunt ciorne". Adica poarta ar fi ramas verde
  // exact in situatia pe care trebuia s-o prinda.
  // Ancora e ID-ul controlului, nu href-ul: adresele se pun din JS (`$('#saftXml').href = …`),
  // deci in HTML nu exista niciun `/xml/saft` de cautat. Id-ul dovedeste ca butonul care FACE
  // lucrul e chiar in sectiunea care il promite.
  const PROMISIUNI = [
    ['saft', 'SAF-T', 'id="saftXml"'],
    // D300 nu are buton propriu in HTML: liniile de descarcare se randeaza in `#livrabileList`,
    // deci ancora e chiar lista din care se ia fiecare declaratie promisa in eticheta.
    ['livrabile', 'D300', 'id="livrabileList"'],
    ['tva', 'D300', 'id="d300Xml"'],
    ['situatii', 'bilanț', 'id="bilantPdf"'],
  ];
  for (const [tab, promis, ancora] of PROMISIUNI) {
    const et = eticheta(tab);
    if (!et || !new RegExp(promis, 'i').test(et)) continue;   // eticheta nu-l promite -> nimic de cerut
    ok('„' + promis + '" promis in meniu la „' + tab + '" chiar e FUNCTIONAL in pagina (' + ancora + ')',
      corpSectiune(tab).includes(ancora));
  }
  ok('poarta chiar citeste etichetele de meniu', /SAF-T/i.test(eticheta('saft')));
  ok('poarta nu se multumeste cu o mentiune in text',
    !corpSectiune('situatii').includes('id="saftXml"') && /SAF-T|D406/i.test(corpSectiune('livrabile')));

  // TURUL trebuie sa acopere fiecare grup din meniu. Un grup nou fara pas in tur nu produce
  // nicio eroare — turul pur si simplu nu-l pomeneste, iar omul caruia i se explica aplicatia
  // afla despre el abia din intamplare. Exact ce se intamplase: „Salarii" si „Mijloace fixe"
  // erau lipite intr-un pas despre Stocuri, iar „Setari" era descris ca un singur ecran dupa ce
  // devenise noua. Submeniurile NU se verifica aici: turul le citeste din DOM la rulare, deci
  // nu pot drifta prin constructie.
  const grupuriMeniu = [...html.matchAll(/class="navlabel"[^>]*>([^<]+)/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim()).filter(Boolean);
  const app0 = fsx.readFileSync(pth.join(RADACINA, 'public', 'app.js'), 'utf8');
  const turBloc = (app0.match(/const TOUR = \[[\s\S]*?\n\];/) || [''])[0];
  ok('turul exista si are pasi', turBloc.length > 200);
  const grupuriTur = [...turBloc.matchAll(/group:\s*'([^']+)'/g)].map((m) => m[1]);
  ok('turul chiar enumera grupuri', grupuriTur.length >= 5);
  const nedescrise = grupuriMeniu.filter((g) => !grupuriTur.some((t) => g.indexOf(t) >= 0));
  ok('fiecare grup din meniu are pas in tur'
    + (nedescrise.length ? ' — FARA PAS: ' + nedescrise.join(', ') : ''), nedescrise.length === 0);
  // ...si invers: un pas care tinteste un grup disparut ar evidentia in gol.
  const tinteMoarte = grupuriTur.filter((t) => !grupuriMeniu.some((g) => g.indexOf(t) >= 0));
  ok('niciun pas de tur nu tinteste un grup inexistent'
    + (tinteMoarte.length ? ' — ' + tinteMoarte.join(', ') : ''), tinteMoarte.length === 0);

  // ORDINEA MENIULUI trebuie sa urmeze CICLUL CONTABIL, nu invers. Ciclul nu e o parere: `CYCLE`
  // din public/app.js îl declară și îl expune ca metadată în bara contextuală, fără o a doua
  // navigație desenată în capul paginilor.
  // Meniul il contrazicea pe fata: „Declaratii ANAF" (ultimul pas) statea in al treilea grup, cu
  // doua grupuri INAINTEA registrelor si a inchiderii din care se calculeaza. Nimic nu semnala —
  // ambele erau corecte separat. Se verifica pozitia in meniu, nu apartenenta la vreun grup: gruparea
  // se poate schimba oricand, ordinea pasilor nu.
  const navBloc = html.slice(html.indexOf('id="tabs"'), html.indexOf('</nav>', html.indexOf('id="tabs"')));
  // Sursa ordinii e acum secventa lunii (`PASII_LUNII`, oglinda lui `monthlyClose.STEPS`), nu o a
  // doua lista scrisa de mana. Se verifica doar pasii care AU ecran propriu — aprobarea si blocarea
  // se rezolva in cockpit, deci nu au pozitie in meniu.
  const ciclu = [...(app0.match(/const PASII_LUNII = \[[\s\S]*?\n\];/) || [''])[0]
    .matchAll(/tab: '([a-z-]+)'/g)].map((m) => m[1]);
  ok('poarta vede secventa lunii declarata in cod', ciclu.length >= 4);
  const pozitie = (t) => navBloc.indexOf('data-tab="' + t + '"');
  const inMeniu = ciclu.filter((t) => pozitie(t) >= 0);
  ok('pasii lunii se regasesc in meniu', inMeniu.length >= 4);
  const inversate = inMeniu.filter((t, i) => i > 0 && pozitie(t) < pozitie(inMeniu[i - 1]));
  ok('ordinea meniului urmeaza ciclul contabil'
    + (inversate.length ? ' — INVERSATE fata de pasul dinainte: ' + inversate.join(', ') : ''), inversate.length === 0);
  // Poarta trebuie sa POATA pica: pe o lista intoarsa, verdictul se inverseaza.
  const intors = [...inMeniu].reverse();
  ok('detectorul chiar prinde o ordine gresita',
    intors.filter((t, i) => i > 0 && pozitie(t) < pozitie(intors[i - 1])).length > 0);

  // Fiecare tab pe care `onTab` il trateaza explicit trebuie sa existe ca sectiune — altfel
  // randarea se leaga de un ecran care nu mai e acolo.
  const app = fsx.readFileSync(pth.join(RADACINA, 'public', 'app.js'), 'utf8');
  const tratate = [...new Set([...app.matchAll(/\bt === '([a-z-]+)'/g)].map((m) => m[1]))];
  ok('poarta vede taburile tratate in onTab', tratate.length > 5);
  const tratateFaraSectiune = tratate.filter((t) => !sectiuni.includes(t));
  ok('fiecare tab tratat in onTab are sectiune'
    + (tratateFaraSectiune.length ? ' — ' + tratateFaraSectiune.join(', ') : ''), tratateFaraSectiune.length === 0);
}

section('Poarta: fiecare generator PDF chemat din rute exista in src/pdf/index.js');
{
  // `src/pdf/index.js` reexporta EXPLICIT, nume cu nume. Un generator adaugat intr-un modul tematic
  // dar uitat aici exista in cod si NU exista pentru rute: `pdf.xPdf` e `undefined`, deci ruta cade
  // cu 500 la prima cerere reala. Nimic nu se plange la pornire, iar testele de modul nu vad gaura —
  // exact ce s-a intamplat cu `d394Pdf`/`saftPdf`, prins abia de fumul HTTP.
  //
  // Directia conteaza: se verifica ce CHEAMA rutele, nu ce exporta modulele. Invers ar semnala si
  // bucatile refolosite intre module (`facturaCompactPdf`, ales de `facturaPdf` dupa layout), care
  // n-au ce cauta in index — o poarta cu fals-pozitive ajunge sa fie slabita, nu respectata.
  const fsx = require('fs'); const pth = require('path');
  const index = fsx.readFileSync(pth.join(RADACINA, 'src', 'pdf', 'index.js'), 'utf8');
  const dirRute = pth.join(RADACINA, 'src', 'routes');
  const chemate = new Set();
  for (const f of fsx.readdirSync(dirRute).filter((x) => x.endsWith('.js'))) {
    const src = fsx.readFileSync(pth.join(dirRute, f), 'utf8');
    for (const m of src.matchAll(/\bpdf\.([a-zA-Z]\w*)\s*\(/g)) chemate.add(m[1]);
  }
  ok('poarta vede generatoare chemate din rute', chemate.size > 10);
  const lipsa = [...chemate].filter((n) => !new RegExp('\\b' + n + '\\s*:').test(index));
  ok('fiecare generator chemat din rute e reexportat de index'
    + (lipsa.length ? ' — LIPSESC: ' + lipsa.join(', ') : ''), lipsa.length === 0);
}

section('Poarta: fiecare colectie din graf are linie in ARRAY_COLLS (altfel dispare la restart)');
{
  // Modul de esec pe care il previne: o colectie noua adaugata in `db.js` dar UITATA in
  // `store.ARRAY_COLLS` traieste doar in RAM. Totul pare sa mearga — se scrie, se citeste, testele
  // trec — pana la primul restart, cand datele dispar TACUT. Nimic nu semnaleaza, fiindca nu exista
  // eroare: pur si simplu nu s-a persistat niciodata nimic.
  const dbx2 = require('../../src/db');
  const storex = require('../../src/store');
  const graf = dbx2.get();
  const arrays = Object.keys(graf).filter((k) => Array.isArray(graf[k]));
  const declarate = new Set(storex.ARRAY_COLLS.map((c) => c.key));
  ok('poarta chiar vede colectii (nu un graf gol)', arrays.length > 15);
  const uitate = arrays.filter((k) => !declarate.has(k));
  ok('nicio colectie fara linie in ARRAY_COLLS'
    + (uitate.length ? ' — UITATE: ' + uitate.join(', ') : ''), uitate.length === 0);
  // ...si invers: o linie in ARRAY_COLLS fara colectie in graf ar persista un tabel mort
  const fantome = [...declarate].filter((k) => !arrays.includes(k));
  ok('nicio linie ARRAY_COLLS fara colectie in graf'
    + (fantome.length ? ' — FANTOME: ' + fantome.join(', ') : ''), fantome.length === 0);
}

section('Incasare: nicio plata fara parte contractanta identificata');
{
  const fsx = require('fs'); const pth = require('path');
  const plansMod = require('../../src/plans');
  const bil = fsx.readFileSync(pth.join(RADACINA, 'src', 'routes', 'billing.js'), 'utf8');

  ok('suspendarea e o decizie de COD, nu o variabila de mediu', typeof plansMod.PLATI_SUSPENDATE === 'boolean'
    && !/process\.env\.[A-Z_]*PLAT/i.test(fsx.readFileSync(pth.join(RADACINA, 'src', 'plans.js'), 'utf8')));

  // Cele doua rute care chiar iau bani trebuie sa treaca prin garda. Ancora e corpul rutei, nu
  // fisierul: o garda declarata dar necheamata ar fi trecut o verificare pe fisier.
  for (const ruta of ['/api/checkout-guest', '/api/subscription/checkout']) {
    const corp = (bil.match(new RegExp("app\\.post\\('" + ruta.replace(/\//g, '\\/') + "'[\\s\\S]*?\\n  \\}\\);")) || [''])[0];
    ok('ruta exista in sursa: ' + ruta, corp.length > 0);
    ok(ruta + ' trece prin garda de suspendare', /platiOprite\(res\)/.test(corp));
  }

  // A treia cale de plata NU e o ruta, ci serviciul din spatele butonului de abonare al firmei —
  // singura folosita efectiv de interfata. A fost gasita abia dupa ce primele doua erau pazite,
  // deci poarta o numeste explicit: altfel „platile sunt oprite" ar fi adevarat despre rutele
  // enumerate si fals despre casa.
  const fsvc = fsx.readFileSync(pth.join(RADACINA, 'src', 'firmeService.js'), 'utf8');
  const corpAbonare = (fsvc.match(/async function subscribeFirma[\s\S]*?\n\}/) || [''])[0];
  ok('subscribeFirma exista in sursa', corpAbonare.length > 0);
  ok('abonarea firmei nu deschide Stripe cat timp platile sunt suspendate',
    /PLATI_SUSPENDATE\)\s*fail\(503/.test(corpAbonare));
  ok('...dar garda sta pe ramura CU plata, nu pe activarea manuala',
    corpAbonare.indexOf('PLATI_SUSPENDATE') > corpAbonare.indexOf('billing.configured()'));

  // Ce NU are voie sa fie oprit: anularea (un client trebuie sa poata pleca oricand) si webhook-ul
  // (un abonament deja platit trebuie onorat chiar daca vanzarea e inchisa intre timp).
  for (const ruta of ['/api/subscription/portal', '/api/stripe/webhook']) {
    const corp = (bil.match(new RegExp("app\\.post\\('" + ruta.replace(/\//g, '\\/') + "'[\\s\\S]*?\\n  \\}\\);")) || [''])[0];
    ok('ruta exista in sursa: ' + ruta, corp.length > 0);
    ok(ruta + ' NU e oprita de suspendare', !/platiOprite\(res\)/.test(corp));
  }

  ok('motivul suspendarii e un text pentru om, nu un cod', typeof plansMod.MOTIV_PLATI_SUSPENDATE === 'string'
    && plansMod.MOTIV_PLATI_SUSPENDATE.length > 40);
}


section('Poarta: butoanele de mișcări de bani trimit tipuri de document care există');
{
  const fsx = require('fs'); const pth = require('path');
  const html = fsx.readFileSync(pth.join(RADACINA, 'public', 'index.html'), 'utf8');
  // Butoanele din registrul Banca/Casa deschid formularul unic pe un tip anume (`data-tip`).
  // `renderFields` face `META.types.find(...)` si apoi `tip.fields.forEach` — deci un `data-tip`
  // gresit nu da un buton inert, ci o EXCEPTIE la clic, cu formularul pe jumatate deschis.
  // Legatura e intre HTML si `src/documentTypes/`, adica exact genul de pereche pe care n-o
  // verifica nici testele de frontend (nu vad serverul), nici cele HTTP (nu vad pagina).
  const tipuriDinPagina = [...new Set([...html.matchAll(/class="[^"]*\bcbact\b[^"]*"[^>]*data-tip="([^"]+)"/g)].map((m) => m[1]))];
  ok('poarta chiar vede butoanele de bani (nu o lista goala)', tipuriDinPagina.length >= 4);
  const { getType } = require(pth.join(RADACINA, 'src', 'documentTypes'));
  const necunoscute = tipuriDinPagina.filter((t) => !getType(t));
  ok('fiecare buton de mișcare de bani are tip real'
    + (necunoscute.length ? ' — INEXISTENTE: ' + necunoscute.join(', ') : ''), necunoscute.length === 0);
  // ...si chiar tipuri de TREZORERIE: un `factura_cumparare_marfuri` pus din greseala aici ar trece
  // de poarta de mai sus, dar ar aseza o factura in registrul de casa — buton plauzibil, rezultat
  // gresit. Grupul vine din definitia tipului, nu dintr-o lista scrisa aici de mana.
  const straine = tipuriDinPagina.filter((t) => getType(t) && getType(t).grup !== 'Trezorerie');
  ok('butoanele deschid doar mișcări de trezorerie'
    + (straine.length ? ' — STRAINE: ' + straine.join(', ') : ''), straine.length === 0);
  ok('cele două mișcări de bază sunt acolo',
    tipuriDinPagina.includes('incasare_client') && tipuriDinPagina.includes('plata_furnizor'));
  // Poarta trebuie sa POATA pica: pe un tip inexistent si pe unul din alt grup, verdictul se schimba.
  ok('poarta chiar distinge cazurile', !getType('tip_inexistent_xyz') && getType('factura_cumparare_marfuri').grup !== 'Trezorerie');
}

section('Poarta: fiecare link de descărcare din registrul depunerilor indică o rută REALĂ');
{
  const fsx = require('fs'); const pth = require('path');
  const decl = require(pth.join(RADACINA, 'src', 'declarations'));
  // Registrul depunerilor e lista de sarcini a firmei, iar de la #4 fiecare rand poarta si
  // fisierul de descarcat. Un link mort ACOLO e mai rau decat lipsa lui: omul crede ca a
  // descarcat declaratia si nu a descarcat nimic. Caile nu se pot verifica prin citire — se
  // confrunta cu `app.get`-urile inregistrate efectiv in src/.
  const rute = new Set();
  const dir = pth.join(RADACINA, 'src');
  const walk = (p) => fsx.readdirSync(p, { withFileTypes: true }).forEach((e) => {
    const full = pth.join(p, e.name);
    if (e.isDirectory()) return walk(full);
    if (!e.name.endsWith('.js')) return;
    const src = fsx.readFileSync(full, 'utf8');
    for (const m of src.matchAll(/app\.get\('(\/(?:pdf|xml)\/[a-z0-9-]+)'/g)) rute.add(m[1]);
  });
  walk(dir);
  ok('poarta chiar vede rutele de descărcare', rute.size > 20);
  const tipuri = Object.keys(decl.TIPURI);
  ok('poarta chiar vede tipurile de declarații', tipuri.length >= 8);
  const moarte = [];
  const faraLink = [];
  for (const tip of tipuri) {
    const links = decl.descarcari(tip, '2026-05');
    if (!links.length) { faraLink.push(tip); continue; }
    for (const l of links) {
      const cale = l.href.split('?')[0];
      if (!rute.has(cale)) moarte.push(tip + ' → ' + cale);
      // Fara parametru de perioada, ruta ar intoarce declaratia lunii CURENTE sub numele altei
      // luni — cel mai urat mod de a gresi: fisierul exista, se descarca, si e altceva.
      ok(tip + ': linkul „' + l.label + '" poartă perioada', /[?&](period|year)=/.test(l.href));
    }
  }
  ok('niciun link mort' + (moarte.length ? ' — RUTE INEXISTENTE: ' + moarte.join(', ') : ''), moarte.length === 0);
  ok('fiecare declarație generabilă are de unde fi descărcată'
    + (faraLink.length ? ' — FARA LINK: ' + faraLink.join(', ') : ''), faraLink.length === 0);
  // Parametrul difera pe tip (D101 si XML-ul de bilant iau `year`, restul `period`); o inversare
  // ar da 400 sau perioada gresita, tacut.
  ok('D101 cere anul, nu luna', decl.descarcari('d101', '2026-12')[0].href.includes('year=2026'));
  ok('D300 cere luna', decl.descarcari('d300', '2026-05')[0].href.includes('period=2026-05'));
  // Poarta trebuie sa POATA pica: o cale inventata nu se regaseste printre rutele reale.
  ok('poarta chiar distinge o rută inexistentă', !rute.has('/xml/d999'));
}

section('Poarta: scenariul video nu poate rămâne în urma vocii din film');
{
  const fsx = require('fs'); const pth = require('path');
  const { execFileSync } = require('child_process');
  // Documentul isi declara singur regula — „se genereaza … nu se scriu de mana, altfel drifteaza
  // la prima replica schimbata" — dar generatorul NU exista si capitolul era scris de mana. Adica
  // deriva impotriva careia se avertiza, cu avertismentul ca dovada ca cineva stia. Acum exista
  // generatorul, iar poarta il ruleaza in modul `--check`: daca cineva schimba o replica din
  // naratiune si uita documentul, filmul si scenariul ar spune lucruri diferite despre acelasi
  // produs — si nimeni n-ar afla, fiindca scenariul se citeste rar.
  const scene = JSON.parse(fsx.readFileSync(pth.join(RADACINA, 'scripts', 'naratiune-video.json'), 'utf8'));
  const durate = JSON.parse(fsx.readFileSync(pth.join(RADACINA, 'scripts', 'naratiune-durate.json'), 'utf8'));
  ok('naratiunea are scene', scene.length >= 20);
  ok('fiecare scena are id si text', scene.every((s) => s.id && s.text && s.text.length > 20));
  ok('id-urile sunt unice', new Set(scene.map((s) => s.id)).size === scene.length);
  // Durata e MASURATA din WAV-ul generat, nu estimata: pe ea se aseaza sunetul la montaj, deci o
  // scena fara durata ar decala tot filmul de la ea incolo.
  const faraDurata = scene.filter((s) => !durate.some((d) => d.id === s.id && d.durata > 0));
  ok('fiecare scena are durata masurata' + (faraDurata.length ? ' — LIPSESC: ' + faraDurata.map((s) => s.id).join(', ') : ''), faraDurata.length === 0);

  let iesire = 0;
  try { execFileSync('node', [pth.join(RADACINA, 'scripts', 'genereaza-scenariu.js'), '--check'], { stdio: 'pipe' }); }
  catch (e) { iesire = e.status || 1; }
  ok('scenariul din docs/ e regenerat din naratiune (ruleaza `node scripts/genereaza-scenariu.js`)', iesire === 0);
}

section('Poarta: pagina filmului nu-si scrie durata de mana');
{
  const fsx = require('fs'); const pth = require('path');
  // Filmul se reface, manifestul se rescrie singur la publicare — dar pagina isi tinea durata
  // hardcodata, in TREI locuri. Dupa refacere anunta „Durata 10:27" pentru un film de 13:20:
  // vizitatorul citea o cifra si vedea alta in player. Sursa unica e manifestul.
  const html = fsx.readFileSync(pth.join(RADACINA, 'public', 'video.html'), 'utf8');
  const js = fsx.readFileSync(pth.join(RADACINA, 'public', 'video.js'), 'utf8');
  const faraComentarii = html.replace(/<!--[\s\S]*?-->/g, ' ');
  ok('poarta chiar citeste pagina', faraComentarii.includes('video-player'));
  const durate = faraComentarii.match(/\b\d{1,2}:\d{2}\b/g) || [];
  ok('nicio durata scrisa de mana in pagina' + (durate.length ? ' — GASITE: ' + durate.join(', ') : ''), durate.length === 0);
  ok('pagina are locul in care se pune durata', /id="videoMeta"/.test(html));
  ok('...si scriptul care o aduce din manifest', /src="\/video\.js"/.test(html));
  ok('scriptul chiar citeste manifestul', /descarcari\/video\.json/.test(js));
  // Scriptul TREBUIE sa fie fisier separat: CSP-ul are `script-src 'self'`, deci unul inline ar fi
  // blocat TACUT — pagina s-ar incarca, doar cifra ar lipsi, si nimeni n-ar sti de ce.
  ok('scriptul nu e inline (CSP: script-src self)', !/<script(?![^>]*\bsrc=)/.test(faraComentarii));
  // Fara manifest, pagina nu are voie sa inventeze o durata.
  ok('fara manifest, ramane doar linkul de descarcare', /catch[\s\S]{0,120}innerHTML = link/.test(js));
}

section('Poarta: fiecare document care emite factura raspunde daca merge in e-Factura');
{
  // Perimetrul e-Factura era o lista de patru id-uri scrisa de mana in `src/xml.js` (copiata inca
  // de doua ori). Consecinta: opt tipuri care emit facturi nu puteau fi trimise in SPV deloc, desi
  // raportarea B2B e obligatorie din 1 iulie 2024, cu sanctiune de 15% din valoarea facturii.
  // Nimeni nu se duce sa actualizeze o lista dintr-un generator XML cand adauga un tip de document
  // — deci poarta cere DECIZIA pe definitia tipului, unde o vede cine scrie tipul.
  //
  // DOUA straturi, fiindca niciunul singur nu ajunge (acelasi tipar ca la poarta de paginare):
  //   (1) STRUCTURAL — orice tip a carui `build()` produce semnatura contabila a unei facturi
  //       catre client. Prinde tipuri din orice grup (vanzarea de mijloc fix e in „Imobilizari"),
  //       dar are un punct orb: facturile care nu ating direct un cont de venit (`facturare_aviz`
  //       descarca 418, factura simplificata se incaseaza pe loc din 5311).
  //   (2) PE GRUP — tot ce sta in grupul „Vanzari" trebuie sa raspunda, indiferent de conturi.
  //       Acopera exact punctul orb al primului.
  const T = require('../../src/documentTypes');
  const xmlMod = require('../../src/xml');
  const PROBA = { baza: 1000, tva: 210, cota: 21, suma: 1000, valoare: 1000, pret: 1000,
    cantitate: 10, curs: 5, sumaValuta: 200, numerar: 1000, valoareVanzare: 1000 };
  const CREANTA = /^(411|418|461)/;   // conturile pe care sta creanta fata de client
  const VENIT = (c) => /^7/.test(c) || c === '4427';

  ok('poarta chiar vede tipurile', T.TYPES.length > 100);
  const structurale = [];
  for (const t of T.TYPES) {
    let lines = [];
    try { lines = t.build(PROBA) || []; } catch (e) { lines = []; }
    const factura = lines.some((l) => CREANTA.test(String(l.debit)) && VENIT(String(l.credit)));
    const nota = lines.some((l) => CREANTA.test(String(l.credit)) && VENIT(String(l.debit)));
    if (factura || nota) structurale.push(t);
  }
  ok('stratul structural chiar prinde ceva (>=8 tipuri)', structurale.length >= 8);
  const fara1 = structurale.filter((t) => t.eFactura !== 'da' && t.eFactura !== 'nu').map((t) => t.id);
  eq('structural: fiecare document cu semnatura de factura are raspuns' + (fara1.length ? ' — LIPSA: ' + fara1.join(', ') : ''), fara1.length, 0);

  const vanzari = T.TYPES.filter((t) => t.grup === 'Vanzari');
  ok('stratul pe grup chiar prinde ceva (>=10 tipuri in „Vanzari")', vanzari.length >= 10);
  const fara2 = vanzari.filter((t) => t.eFactura !== 'da' && t.eFactura !== 'nu').map((t) => t.id);
  eq('grup: fiecare tip din „Vanzari" are raspuns' + (fara2.length ? ' — LIPSA: ' + fara2.join(', ') : ''), fara2.length, 0);

  // Al doilea strat trebuie sa acopere ceva ce primul nu vede — altfel e doar zgomot si poate fi
  // sters din greseala fara sa se observe nimic.
  const doarPeGrup = vanzari.filter((t) => !structurale.includes(t)).map((t) => t.id);
  ok('stratul pe grup chiar adauga acoperire (' + doarPeGrup.length + ' tipuri)', doarPeGrup.length > 0);

  // Nicio lista de id-uri de facturi scrisa de mana nu are voie sa reapara in modulele consumatoare:
  // asa au aparut cele trei copii care driftau.
  const fs2 = require('fs'); const p2 = require('path');
  for (const f of ['src/declarations.js', 'src/reporting.js']) {
    const src = fs2.readFileSync(p2.join(RADACINA, f), 'utf8');
    ok(f + ': fara lista proprie de tipuri de factura', !/'factura_vanzare_marfuri'/.test(src));
  }
  // ...si perimetrul chiar se deriva din steag, nu dintr-un Set literal.
  const srcXml = fs2.readFileSync(p2.join(RADACINA, 'src', 'xml.js'), 'utf8');
  ok('src/xml.js deriva perimetrul din `eFactura`', /eFactura === 'da'/.test(srcXml));
  eq('perimetrul derivat = tipurile marcate „da"',
    xmlMod.SALES_TYPES.size, T.TYPES.filter((t) => t.eFactura === 'da').length);
}

section('Poarta: niciun al doilea fisier cu secrete in radacina proiectului');
{
  // De ce exista. `.env.bak-prepg` a stat sase saptamani in radacina, cu chei Stripe, Anthropic
  // si Resend IDENTICE cu cele vii. Nu a fost expus — nu a fost comis niciodata, avea mod 600 si
  // nu exista nicio copie pe server — dar prima arhiva portabila construita din radacina l-a
  // inclus, fiindca excluderea era `.env`, nu `.env.*`. Am prins-o inainte de publicare; a doua
  // oara poate sa nu se intample asa.
  //
  // Regula pe care o apara poarta: secretele VII stau intr-un singur fisier, `.env`. Orice al
  // doilea fisier din radacina care contine o cheie reala e o copie uitata, iar o copie uitata e
  // exact ce mătură urmatoarea impachetare.
  //
  // Se scaneaza DIRECTORUL, nu ce urmareste git: fisierul problema era gitignorat, deci o poarta
  // pe fisierele urmarite nu l-ar fi vazut niciodata.
  const fsS = require('fs');
  const pS = require('path');
  // Prefix PLUS un corp realist: `sk_live_...` din documentatie nu e o cheie, iar o poarta care
  // se aprinde la exemple din README e o poarta pe care o dezactiveaza cineva peste o luna.
  const CHEIE = /(sk_live_[A-Za-z0-9]{16,}|sk-ant-api[A-Za-z0-9_-]{20,}|whsec_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{24,})/;
  const PERMIS = new Set(['.env']); // singurul loc in care secretele vii au voie sa stea
  const gasite = [];
  for (const nume of fsS.readdirSync(RADACINA)) {
    if (PERMIS.has(nume)) continue;
    const cale = pS.join(RADACINA, nume);
    let st; try { st = fsS.statSync(cale); } catch (e) { continue; }
    if (!st.isFile() || st.size > 512 * 1024) continue;
    let text; try { text = fsS.readFileSync(cale, 'utf8'); } catch (e) { continue; }
    if (CHEIE.test(text)) gasite.push(nume); // se raporteaza NUMELE, niciodata continutul
  }
  eq('radacina nu are un al doilea fisier cu chei reale', gasite.join(', '), '');
  // Poarta trebuie sa MUSTE: tiparul recunoaste o cheie reala, dar lasa exemplele in pace.
  ok('tiparul prinde o cheie Stripe reala', CHEIE.test('STRIPE_SECRET_KEY=sk_live_' + 'a'.repeat(24)));
  ok('tiparul prinde o cheie Resend reala', CHEIE.test('RESEND_API_KEY=re_' + 'b'.repeat(30)));
  ok('...dar NU se aprinde la exemplul din documentatie', !CHEIE.test('ia cheile `sk_live_...` din Stripe'));
  ok('...si nici la placeholderul din interfata', !CHEIE.test('ANTHROPIC_API_KEY=sk-ant-... npm start'));
}

section('Poarta: orice articol contabil intra prin `db.pushEntry` (planul de conturi)');
{
  const fsE = require('fs'); const pE = require('path');
  // DEFECTUL pe care il inchide poarta: `composeEntry` (server.js) refuza liniile cu conturi din
  // afara planului, dar pazea o SINGURA cale. 21 de locuri impingeau direct in `d.entries`, deci
  // o ocoleau. Amortizarea lunara a scris asa, ani la rand, pe conturi inexistente (2812, 2814,
  // 2805…), care apareau drept „(cont necunoscut)" in balanta si plecau in <AccountDescription>
  // din SAF-T, la ANAF. O garda pe care o poti ocoli fara sa observe nimeni nu e o garda.
  //
  // Perimetrul se DERIVA din sursa (tot src/, recursiv): o cale noua de scriere intra singura in
  // verificare, fara ca cineva sa-si aminteasca sa actualizeze o lista.
  const fisiere = [];
  (function walk(dir) {
    for (const f of fsE.readdirSync(dir).sort()) {
      const p = pE.join(dir, f);
      if (fsE.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) fisiere.push(p);
    }
  })(pE.join(RADACINA, 'src'));
  ok('perimetrul se citeste din src/', fisiere.length > 50);

  // `src/db.js` e SINGURUL fisier care are voie sa impinga: acolo sta punctul unic.
  const PERMIS = pE.join(RADACINA, 'src', 'db.js');
  const faraComentarii = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const vinovate = [];
  for (const f of fisiere) {
    if (f === PERMIS) continue;
    const text = faraComentarii(fsE.readFileSync(f, 'utf8'));
    if (/entries\s*\.\s*push\s*\(/.test(text)) vinovate.push(pE.relative(RADACINA, f));
  }
  eq('nicio cale nu ocoleste punctul unic', vinovate.join(', '), '');

  // Poarta trebuie sa MUSTE: tiparul recunoaste formele reale, dar nu se aprinde pe altceva.
  const T = /entries\s*\.\s*push\s*\(/;
  ok('tiparul prinde forma directa', T.test('d.entries.push(entry);'));
  ok('tiparul prinde si forma cu db.get()', T.test('db.get().entries.push(entry);'));
  ok('tiparul prinde si forma cu spatii', T.test('d.entries . push ( entry )'));
  ok('...dar nu se aprinde pe `pushEntry`', !T.test('db.pushEntry(entry);'));
  ok('...si nici pe alte colectii', !T.test('d.documents.push(doc); lines.push(l);'));

  // Punctul unic chiar VERIFICA — altfel poarta ar garanta doar o convenție de scriere.
  const dbE = require('../../src/db');
  eq('articol curat: niciun cont necunoscut',
    dbE.conturiNecunoscute({ lines: [{ debit: '6811', credit: '281' }] }).join(','), '');
  eq('articol cu cont inventat: raportat pe nume',
    dbE.conturiNecunoscute({ lines: [{ debit: '6811', credit: '2819' }] }).join(','), '2819');
  eq('ambele laturi se verifica, nu doar debitul',
    dbE.conturiNecunoscute({ lines: [{ debit: '9999', credit: '8888' }] }).sort().join(','), '8888,9999');
  eq('acelasi cont gresit pe mai multe linii se raporteaza o data',
    dbE.conturiNecunoscute({ lines: [{ debit: '7777', credit: '5121' }, { debit: '7777', credit: '5121' }] }).join(','), '7777');
  eq('articol fara linii nu e o eroare', dbE.conturiNecunoscute({}).length, 0);

  // ...si chiar REFUZA. Fara aserțiunea asta, poarta de mai sus dovedea doar CONVENTIA („toata
  // lumea cheama pushEntry"), nu si efectul ei: golirea verificarii din `pushEntry` trecea suita
  // verde, fiindca `conturiNecunoscute` e o functie pura, testata separat. Doua mecanisme care se
  // masaza reciproc — exact tiparul pe care proiectul l-a mai intalnit. Aruncarea se intampla
  // INAINTE de `get()`, deci proba nu are nevoie de baza incarcata si nu scrie nimic.
  let aruncat = null;
  try { dbE.pushEntry({ lines: [{ debit: '6811', credit: '2819', suma: 10 }] }, { context: 'proba' }); }
  catch (e) { aruncat = e; }
  ok('pushEntry REFUZA un cont din afara planului', !!aruncat);
  eq('...cu status 400 (eroare de business, nu 500)', aruncat && aruncat.status, 400);
  ok('...numind contul vinovat', aruncat && /2819/.test(aruncat.message));
  ok('...si contextul, ca sa se stie de unde vine articolul', aruncat && /proba/.test(aruncat.message));
}

section('Poarta: fiecare pas din ciclul contabil isi poarta temeiul legal');
{
  const tl = require('../../src/temeiLegal');
  const mc = require('../../src/monthlyClose');

  // Fiecare pas are cel putin o trimitere, iar trimiterea e completa: act cunoscut + articol.
  // Un pas „mut" ar aparea in interfata cu un „Temei legal:" gol — mai rau decat lipsa lui.
  const fara = tl.CICLU.filter((p) => !Array.isArray(p.temei) || !p.temei.length).map((p) => p.key);
  eq('niciun pas fara temei legal', fara.join(',') || '(niciunul)', '(niciunul)');
  const acteNecunoscute = tl.CICLU.flatMap((p) => p.temei.map((x) => x.act)).filter((a) => !tl.ACTE[a]);
  eq('nicio trimitere la un act nedeclarat', [...new Set(acteNecunoscute)].join(',') || '(niciunul)', '(niciunul)');
  const faraArticol = tl.CICLU.flatMap((p) => p.temei.filter((x) => !x.articol).map(() => p.key));
  eq('nicio trimitere fara articol', faraArticol.join(',') || '(niciunul)', '(niciunul)');
  const faraCe = tl.CICLU.filter((p) => p.temei.some((x) => !x.ce || x.ce.length < 20)).map((p) => p.key);
  eq('fiecare trimitere spune si CE prevede, nu doar numarul', faraCe.join(',') || '(niciunul)', '(niciunul)');
  const faze = [...new Set(tl.CICLU.map((p) => p.faza))].filter((f) => !tl.FAZE.includes(f));
  eq('nicio faza inventata', faze.join(',') || '(niciuna)', '(niciuna)');
  ok('cheile pasilor sunt unice', new Set(tl.CICLU.map((p) => p.key)).size === tl.CICLU.length);

  // LEGATURA cu cockpitul: cheile pasilor lunari trebuie sa fie EXACT cele din motorul de
  // inchidere. Daca cineva adauga un pas in cockpit, poarta il cere si aici — altfel pasul nou ar
  // aparea fara temei, tacut.
  const lunarTemei = tl.ciclu('lunar').map((p) => p.key).sort().join(',');
  const lunarMotor = mc.STEPS.map((s) => s.key).sort().join(',');
  eq('pasii lunari din temei = pasii din cockpit', lunarTemei, lunarMotor);

  // Formatarea pentru interfata
  // Aserțiunile citesc DEFENSIV: cand cheia nu mai exista, `temeiul` intoarce [], iar un
  // `tva[0].actTitlu` ar arunca — poarta ar crapa in loc sa PICE, si mesajul s-ar pierde.
  const tva = tl.temeiul('tva');
  eq('pasul TVA are trimiterile lui', tva.length, 2);
  ok('temeiul se formateaza gata de afisat', /Cod fiscal, art\. 32/.test((tva[0] || {}).eticheta || ''));
  ok('...cu titlul complet al actului disponibil', /Legea nr\. 227\/2015/.test((tva[0] || {}).actTitlu || ''));
  eq('un pas inexistent nu arunca, intoarce lista goala', tl.temeiul('nuexista').length, 0);
  ok('actul fara articol precis nu produce virgula in coada',
    tl.temeiul('facturare').every((x) => !/,\s*$/.test(x.eticheta)));

  // LEGATURA CU INTERFATA: fiecare `data-pas` din index.html trebuie sa existe in ciclu. Un slot
  // cu o cheie gresita nu arunca nicio eroare — ramane pur si simplu GOL, deci ecranul pare fara
  // temei si nimeni nu afla de ce. Poarta se uita in ambele directii: chei inexistente (slot mut)
  // si pasi din faza `lunar`/`anual` ramasi fara niciun ecran care sa-i arate.
  {
    const fsT = require('fs'); const pT = require('path');
    const html = fsT.readFileSync(pT.join(RADACINA, 'public', 'index.html'), 'utf8');
    const sloturi = [...html.matchAll(/class="temei-slot" data-pas="([^"]+)"/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
    ok('interfata chiar are sloturi de temei', sloturi.length >= 10);
    const necunoscute = [...new Set(sloturi.filter((k) => !tl.pas(k)))];
    eq('niciun slot nu trimite la un pas inexistent', necunoscute.join(',') || '(niciunul)', '(niciunul)');
    // pasii cockpitului nu au slot in HTML (se randeaza din date), deci se scot din cerinta
    const inCockpit = new Set(mc.STEPS.map((s) => s.key));
    const aratati = new Set(sloturi);
    const nearatati = tl.CICLU
      .filter((p) => !aratati.has(p.key) && !inCockpit.has(p.key))
      .map((p) => p.key);
    eq('fiecare pas ajunge pe un ecran (sau in cockpit)', nearatati.join(',') || '(niciunul)', '(niciunul)');
  }

  // REGULA DE REDACTARE: aici NU stau termene si NU stau cote — au sursele lor (declarations,
  // fiscalConfig). O cifra copiata aici ar deveni a doua sursa de adevar si s-ar invechi tacut.
  const textTot = JSON.stringify(tl.CICLU);
  ok('temeiurile nu contin termene de depunere', !/25 (ale|a) lunii/i.test(textTot));
  ok('...si nici cote procentuale', !/\d+\s*%/.test(textTot));
}


section('Poarta: niciun `require` relativ care nu rezolva (defectul tacut al mutarii de fisier)');
{
  // DE CE. `src/pdf/helpers.js` a mostenit din monolitul `src/pdf.js` linia `require('./db')`.
  // In monolit, fratele ei chiar era `src/db.js`; in `src/pdf/`, aceeasi cale arata spre
  // `src/pdf/db` — inexistent. `require` a inceput sa arunce MODULE_NOT_FOUND, un `catch` de
  // langa el l-a inghitit, iar functia a raspuns `null` linistit: 26 de zile in care logo-ul
  // incarcat de utilizator n-a mai aparut pe NICIUN PDF si pe nicio factura, fara o linie in log.
  //
  // Clasa de defecte e generala, nu tine de PDF-uri: la orice mutare de fisier, o cale relativa
  // isi schimba intelesul FARA sa se schimbe textul ei. Cand `require`-ul e cerut la RULARE
  // (inauntrul unei functii, ca aici) si e invelit in `try/catch`, esecul nu se vede nici la
  // pornire, nici in teste — codul „merge", doar ca nu mai face nimic.
  //
  // Poarta e ieftina si totala: fiecare `require('./x')` / `require('../x')` din `src/` trebuie
  // sa indice un fisier sau un director care EXISTA. Nu se uita la `try/catch` (l-ar putea ocoli
  // oricine), ci la calea insasi.
  const fsR = require('fs'); const pR = require('path');
  const fisiere = [];
  (function scan(dir) {
    for (const nume of fsR.readdirSync(dir)) {
      const p = pR.join(dir, nume);
      if (fsR.statSync(p).isDirectory()) scan(p);
      else if (nume.endsWith('.js')) fisiere.push(p);
    }
  }(pR.join(RADACINA, 'src')));

  // Perimetrul se afirma: o poarta care scaneaza un director gresit nu gaseste nimic si TRECE.
  ok('poarta chiar vede modulele din src/ (>100 fisiere)', fisiere.length > 100);

  const rupte = [];
  let nrCai = 0;
  for (const f of fisiere) {
    const src = fsR.readFileSync(f, 'utf8');
    const linii = src.split('\n');
    for (let i = 0; i < linii.length; i += 1) {
      for (const m of linii[i].matchAll(/require\('(\.[^']*)'\)/g)) {
        nrCai += 1;
        const tinta = pR.resolve(pR.dirname(f), m[1]);
        const exista = fsR.existsSync(tinta) || fsR.existsSync(tinta + '.js') || fsR.existsSync(tinta + '.json');
        if (!exista) rupte.push(pR.relative(RADACINA, f) + ':' + (i + 1) + " require('" + m[1] + "')");
      }
    }
  }
  ok('poarta chiar gaseste cai relative de verificat (>200)', nrCai > 200);
  eq('nicio cale relativa din src/ nu e rupta', rupte.join(' | ') || '(niciuna)', '(niciuna)');
}


section('Poarta: configul nginx din depozit isi pastreaza blocurile care nu se vad cand se strica');
{
  // DE CE. Infrastructura de productie a trait in afara depozitului: doua blocuri `location`
  // adaugate direct pe server nu erau in `nginx-contab.conf`, desi ANTETUL acelui fisier avertiza
  // ca cele doua pot drifta. Un avertisment scris nu e un mecanism — driftul s-a produs exact
  // acolo unde avertismentul spunea ca se poate produce.
  //
  // Driftul fata de fisierul VIU se verifica separat (`npm run nginx-drift`), fiindca cere acces
  // la /etc/nginx si nu exista in CI. Poarta de AICI verifica altceva, si merge oriunde: ca in
  // copia din depozit n-au disparut directivele a caror lipsa NU se vede la urmatoarea cerere.
  //
  // Cea mai importanta: `^~` pe `/.well-known/`. Cu prefix simplu (`location /.well-known/`),
  // regexul `~ /\.` de mai jos ar castiga si ar inchide conexiunea cu 444 pe provocarea ACME.
  // Sub autentificatorul `nginx` nu s-ar vedea (isi insereaza un `location =`, potrivire exacta,
  // care bate orice), dar sub `webroot`/`standalone` ar taia reinnoirea — iar asta se afla peste
  // doua luni, cand expira certificatul si cade tot site-ul.
  const fsN = require('fs'); const pN = require('path');
  const conf = fsN.readFileSync(pN.join(RADACINA, 'nginx-contab.conf'), 'utf8');
  const directive = conf.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));

  ok('poarta chiar citeste un config, nu un fisier gol', directive.length > 30);
  ok('exceptia ACME exista (plasa de reinnoire a certificatului)', /location\s+\^~\s+\/\.well-known\//.test(conf));
  ok('...cu `^~`, nu prefix simplu (altfel regexul pe puncte o inghite)', !/location\s+\/\.well-known\/\s*\{/.test(conf));
  ok('caile cu punct raman inchise cu 444 (zgomotul scanerelor)', /location\s+~\s+\/\\\.\s*\{/.test(conf) && /return\s+444/.test(conf));
  ok('exceptia ACME e DEASUPRA regulii pe puncte (lizibilitate; `^~` castiga oricum)',
    conf.indexOf('/.well-known/') < conf.indexOf('return 444'));

  // Node nu are voie sa fie expus public: nginx e singurul punct de intrare, iar aplicatia asculta
  // pe 127.0.0.1 (src/lifecycle.js). Un `proxy_pass` catre alta adresa ar muta acel contract.
  const tinte = [...conf.matchAll(/proxy_pass\s+(\S+);/g)].map((m) => m[1]);
  // Trei blocuri, nu „macar unul": autentificare (plafonat), ACME (exceptat) si catch-all.
  // Numarul E aserttia — disparitia oricaruia dintre ele trebuie sa se vada, nu doar a ultimului.
  ok('cele trei blocuri de proxy sunt toate acolo (auth, ACME, catch-all)', tinte.length >= 3);
  ok('toate trimit la aplicatia locala (Node nu se expune direct)', tinte.every((t) => t === 'http://127.0.0.1:8080'));

  // Plafonul pe caile de autentificare: prima plasa, inaintea event loop-ului. Rutele numite aici
  // trebuie sa EXISTE in aplicatie — altfel plafonul pazeste o cale moarta si nimeni nu afla.
  const zona = conf.match(/limit_req_zone[^;]+zone=(\w+):/);
  ok('zona de plafon pe autentificare e declarata', !!zona);
  ok('...si chiar folosita intr-un `limit_req`', !!zona && conf.includes('limit_req zone=' + zona[1]));
  const caiAuth = (conf.match(/location\s+~\s+\^\/api\/\(([^)]+)\)/) || [])[1];
  ok('plafonul numeste caile de autentificare', !!caiAuth);
  if (caiAuth) {
    const rute = caiAuth.split('|').map((s) => s.trim());
    const srcAuth = fsN.readFileSync(pN.join(RADACINA, 'src', 'authRoutes.js'), 'utf8');
    const lipsa = rute.filter((r) => !srcAuth.includes("'/api/" + r.split('/')[0]));
    eq('fiecare cale plafonata exista in aplicatie', lipsa.join(',') || '(niciuna)', '(niciuna)');
  }

  // Corpul cererii: upload-urile de documente primare depasesc implicitul nginx de 1m. Daca
  // dispare, upload-ul cade cu 413 la nginx, INAINTE de orice mesaj al aplicatiei.
  const corp = conf.match(/client_max_body_size\s+(\d+)m/);
  ok('plafonul de corp e setat peste implicitul nginx de 1m', !!corp && Number(corp[1]) > 1);
  // ...si peste plafonul propriu de fisier al aplicatiei (20 MB, src/bootstrap.js), altfel nginx
  // ar taia inaintea garzii care stie sa explice de ce.
  ok('...si peste plafonul de fisier al aplicatiei (20 MB)', !!corp && Number(corp[1]) >= 20);
}

section('Cartea: declaratiile pe care aplicatia le genereaza sunt SI in text');
{
  // Cartea („Contabilitatea, in ordinea in care se intampla") descrie ciclul contabil pe care il
  // implementeaza aplicatia. Cele doua se pot desincroniza tacut, si chiar s-au desincronizat:
  // masurat 2026-08-14, sase declaratii adaugate in ultimele doua saptamani (D301, D307, D311,
  // D107, D710, D177) nu aparusera NICIODATA in text, desi capitolul 37 se numeste chiar
  // „Declaratiile si termenele lor". O carte care omite o obligatie fiscala nu e doar incompleta —
  // e gresita, fiindca tocmai lista e ce cauta cititorul acolo.
  //
  // Poarta se DERIVA din registrul aplicatiei (`declarations.TIPURI`), nu dintr-o a doua lista
  // scrisa de mana: o declaratie noua intra automat in perimetru, fara ca cineva sa-si aminteasca.
  const fsC = require('fs'); const pC = require('path');
  const dir = pC.join(RADACINA, 'scripts');
  const capitole = fsC.readdirSync(dir).filter((f) => /^cuprins-carte-cap.*\.json$/.test(f));
  ok('capitolele cartii exista pe disc', capitole.length > 20);
  const text = capitole.map((f) => fsC.readFileSync(pC.join(dir, f), 'utf8')).join('\n');
  ok('textul cartii chiar a fost citit', text.length > 100000);

  const TIPURI = require('../../src/declarations').TIPURI;
  // `saft` se numeste D406 in text (numele oficial); restul poarta chiar cheia, cu majuscule.
  const numeInCarte = { saft: 'D406', bilant: 'Situații financiare', intrastat: 'Intrastat' };
  const lipsa = [];
  for (const cheie of Object.keys(TIPURI)) {
    const nume = numeInCarte[cheie] || cheie.toUpperCase();
    if (!text.includes(nume)) lipsa.push(cheie + ' (cautat „' + nume + '")');
  }
  eq('fiecare declaratie din TIPURI e numita in carte', lipsa.join(', '), '');

  // Corectarea unei declaratii depuse e o obligatie in sine, cu doua mecanisme DIFERITE. Lipsea
  // amandoua: nici rectificativa, nici D710 nu erau explicate, desi aplicatia le genereaza.
  ok('cartea explica declaratia rectificativa', /rectificativ/i.test(text));
  ok('cartea explica D710 (corectia obligatiilor de plata)', text.includes('D710'));
  ok('...si spune ca nu sunt interschimbabile', /nu sunt interschimbabile/i.test(text));

  // Obligatiile ELECTRONICE erau pomenite in treacat (3 / 2 / 1 mentiuni la 2026-08-14), desi
  // e-Factura e obligatorie de doi ani. Poarta nu cere sa fie POMENITE — asta trece si cu o
  // enumerare — ci ca faptul care se greseste cel mai des sa fie SCRIS. Fiecare rand de mai jos
  // corespunde unei capcane reale, luata din codul aplicatiei (validat fata de schemele oficiale).
  const scrieDespre = [
    ['e-Factura: originalul e fisierul sigilat, nu PDF-ul', /sigilat de ANAF|sigiliul aplicat/],
    ['e-Factura: termenul e in zile CALENDARISTICE', /cinci zile calendaristice/],
    ['e-Factura B2C: cele treisprezece zerouri', /treisprezece zerouri/],
    ['e-Factura: „urcata" nu inseamna „acceptata"', /nu e o factură trimisă|nu e nici acceptată/],
    ['e-Transport: codul se ia INAINTE de plecare', /înainte de punerea în mișcare|înainte ca marfa/],
    ['Intrastat: e la INS, nu la ANAF', /Institutul Național de Statistică/],
    ['Intrastat: pragul se calculeaza pe fiecare SENS', /pe fiecare sens/],
  ];
  for (const [ce, re] of scrieDespre) ok('cartea explica — ' + ce, re.test(text));
}
