'use strict';

// Teste de integrare HTTP: porneste serverul pe un port de test cu o baza temporara
// (driver sqlite implicit, ca in productie de dinainte de pg; CONTAB_TEST_DRIVER=json
// pentru calea de rollback) si verifica rutele critice cap-coada: autentificare,
// autorizarea pe firma, filtrul de upload, blocarea probei expirate, registrul
// depunerilor si portofoliul. Ruleaza in `npm test`, dupa suita de module.

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const auth = require('../src/auth');
const xml = require('../src/xml');

// Driverul serverului de test se alege prin CONTAB_TEST_DRIVER, iar env-ul copilului suprascrie
// explicit CONTAB_DB_DRIVER (vezi startServer). Cine porneste suita cu CONTAB_DB_DRIVER=pg —
// varianta intuitiva, si cea scrisa gresit in CLAUDE.md pana acum — obtinea o rulare pe SQLITE
// care raporta „557 verificari trecute" si lasa impresia ca driverul de productie e verificat.
// Esec zgomotos in locul increderii false: baza pg ramanea goala, deci nimic nu semnala nimic.
if (process.env.CONTAB_DB_DRIVER && !process.env.CONTAB_TEST_DRIVER) {
  console.error('\n[test/http] CONTAB_DB_DRIVER=' + process.env.CONTAB_DB_DRIVER + ' NU are efect aici:'
    + ' suita isi porneste propriul server si alege driverul din CONTAB_TEST_DRIVER.'
    + '\n            Foloseste: CONTAB_TEST_DRIVER=' + process.env.CONTAB_DB_DRIVER + ' node test/http.js\n');
  process.exit(1);
}
const totp = require('../src/totp');

// Port EFEMER, nu unul fix: un 3891 hardcodat se ciocnea cu o instanta uitata (fals-pozitive,
// vezi CLAUDE.md) si impiedica rularea in paralel. Cerem OS-ului un port liber (bind pe 0),
// il eliberam si il pasam serverului-copil; impreuna cu DBF per-pid, suita devine paralelizabila.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
let PORT = 0;    // atribuit in main() inainte de orice cerere
let PORT2 = 0;   // a doua instanta (testul de guard single-instance)
let BASE = '';   // req()/waitUp() capteaza variabila, nu valoarea — vad reasignarea din main()
const DBF = path.join(os.tmpdir(), 'contab-http-' + process.pid + '.json');
// data/ temporar al serverului de test: backup-urile si uploads NU ating data/ real
const DATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'contab-http-data-'));

let pass = 0; let fail = 0;
function eq(name, got, exp) {
  if (got === exp) pass += 1;
  else { fail += 1; console.error('  ✗ ' + name + ': got ' + JSON.stringify(got) + ', expected ' + JSON.stringify(exp)); }
}
function ok(name, cond) { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + name); } }

// adminul de test are o parola NON-implicita: nu declanseaza schimbarea fortata (mustChange),
// ca sa exercite fluxul normal de admin. mustChange e testat separat, pe un cont dedicat.
const ADMIN_PW = 'admin-real-pw';
function buildDb() {
  const a = auth.hashPassword(ADMIN_PW);
  const u = auth.hashPassword('parola1');
  const def = auth.hashPassword('admin'); // parola implicita — migrarea trebuie sa forteze schimbarea
  return {
    firme: [
      { id: 1, nume: 'UNU SRL', cui: '11', tvaPlatitor: true },
      { id: 2, nume: 'DOI SRL', cui: '22', tvaPlatitor: true },
      // firma cu proba EXPIRATA (billing per-firma) — pentru testele „expirat"
      { id: 3, nume: 'EXPIRAT SRL', cui: '33', tvaPlatitor: true, subscription: { plan: 'trial', trialStartedAt: '2026-01-01T00:00:00Z', trialEndsAt: '2026-02-01T00:00:00Z' } },
    ],
    firmaActiva: 1,
    users: [
      { id: 1, username: 'admin', salt: a.salt, hash: a.hash, role: 'admin', firme: [] },
      { id: 2, username: 'user1', salt: u.salt, hash: u.hash, role: 'user', firme: [1], firmaActiva: 1 },
      { id: 3, username: 'expirat', salt: u.salt, hash: u.hash, role: 'user', firme: [3], firmaActiva: 3 },
      // cont cu parola IMPLICITA „admin", FARA flagul mustChange — migrarea trebuie sa-l re-armeze
      { id: 4, username: 'defpw', salt: def.salt, hash: def.hash, role: 'user', firme: [1], firmaActiva: 1 },
      // conturi pentru fluxul de resetare a parolei: token valabil / token expirat (seed-uite,
      // ca testul sa nu depinda de SMTP sau de citirea bazei serverului)
      { id: 5, username: 'resetme', email: 'resetme@example.com', salt: u.salt, hash: u.hash, role: 'user', firme: [1], firmaActiva: 1, resetToken: 'tok-resetare-valida', resetExp: Date.now() + 3600 * 1000 },
      { id: 6, username: 'resetexp', email: 'resetexp@example.com', salt: u.salt, hash: u.hash, role: 'user', firme: [1], firmaActiva: 1, resetToken: 'tok-resetare-expirata', resetExp: Date.now() - 1000 },
      // cont dedicat fluxului 2FA (setup -> enable -> login in doi pasi -> disable)
      { id: 7, username: 'doifa', salt: u.salt, hash: u.hash, role: 'user', firme: [1], firmaActiva: 1 },
      // al doilea admin: tinta interzisa pentru impersonare
      { id: 8, username: 'admin2', salt: a.salt, hash: a.hash, role: 'admin', firme: [] },
      // cont dedicat testelor de plafon upload/export (bucket-urile sunt per utilizator —
      // un cont separat nu consuma plafonul conturilor folosite de restul suitei)
      { id: 9, username: 'uploader', salt: u.salt, hash: u.hash, role: 'user', firme: [1], firmaActiva: 1 },
      // idem pentru retentia pe conversatie: POST /api/messages trece prin upload.single (atasament
      // optional), deci consuma plafonul de upload — un cont propriu tine testul independent
      { id: 10, username: 'msguser', salt: u.salt, hash: u.hash, role: 'user', firme: [1], firmaActiva: 1 },
    ],
    documents: [{ id: 'docA', firmaId: 2, fileName: 'secret.pdf', storedName: 'nu-exista-pe-disc.pdf', uploadedAt: 'x', text: '' }],
    settings: { authSecret: 'x'.repeat(64) },
  };
}

// Token-ul CSRF al fiecarei sesiuni, memorat per cookie: garda cere token la orice cerere mutanta
// care poarta o sesiune. Testele se comporta ca un client normal (il iau din /api/me si il trimit
// inapoi); cazurile care verifica INSASI garda folosesc `noCsrf: true`.
const CSRF_CACHE = new Map();
async function csrfFor(cookie) {
  if (!cookie) return '';
  if (CSRF_CACHE.has(cookie)) return CSRF_CACHE.get(cookie);
  const r = await fetch(BASE + '/api/me', { headers: { Cookie: cookie } });
  let t = '';
  try { t = (await r.json()).csrf || ''; } catch (_) { t = ''; }
  CSRF_CACHE.set(cookie, t);
  return t;
}

async function req(method, p, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers);
  let body = o.body;
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  if (o.cookie) headers.Cookie = o.cookie;
  if (o.cookie && !o.noCsrf && !headers['X-CSRF-Token'] && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const t = await csrfFor(o.cookie);
    if (t) headers['X-CSRF-Token'] = t;
  }
  const r = await fetch(BASE + p, { method, headers, body });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-JSON */ }
  // `headers` expus aditiv: unele raspunsuri se verifica pe antet (Content-Disposition,
  // X-Balance-Source), nu doar pe corp.
  return { status: r.status, json, text, headers: r.headers, cookie: (r.headers.get('set-cookie') || '').split(';')[0], reqId: r.headers.get('x-request-id') };
}

async function waitUp(tries) {
  for (let i = 0; i < (tries || 40); i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (_) { /* inca porneste */ }
    await new Promise((z) => setTimeout(z, 250));
  }
  return false;
}

/** Goleste baza pg de test inainte de rulare. Calea sqlite e izolata prin fisier temporar
 *  per-pid; pe pg toate rularile impart aceeasi baza (CONTAB_PG_URL), deci a doua rulare
 *  pornea peste datele primeia si pica cu ~24 erori — confuz, fiindca suita e corecta.
 *  TRUNCATE pe tabelele APLICATIEI (acelasi tipar ca test/store-pg.js), nu DROP SCHEMA:
 *  nu atinge nimic ce nu e al aplicatiei, daca baza indicata s-ar dovedi a fi altceva. */
async function resetPgTestDb() {
  if (process.env.CONTAB_TEST_DRIVER !== 'pg' || !process.env.CONTAB_PG_URL) return;
  const { Pool } = require('pg');
  const { ARRAY_COLLS, PROJECTIONS } = require('../src/store');
  const pool = new Pool({ connectionString: process.env.CONTAB_PG_URL });
  try {
    const tables = [...ARRAY_COLLS.map((c) => c.key.toLowerCase()), ...(PROJECTIONS || []).map((p) => p.table), 'partners', 'opening_balances', 'meta'];
    // Tabelele lipsesc la prima rulare (baza noua) — de aceea intrebam catalogul in loc sa
    // inghitim erori: un TRUNCATE esuat din alt motiv trebuie sa se vada, nu sa treaca tacut.
    const { rows } = await pool.query('SELECT tablename FROM pg_tables WHERE schemaname = current_schema()');
    const existente = new Set(rows.map((r) => r.tablename));
    for (const t of tables) if (existente.has(t)) await pool.query('TRUNCATE ' + t + ' RESTART IDENTITY CASCADE');
  } finally { await pool.end(); }
}

// Fixture BNR local: suita NU are voie sa iasa pe retea. Serverul de test e un proces COPIL,
// deci un stub pe `global.fetch` din procesul de test n-ar avea niciun efect asupra lui — greseala
// costa un apel real catre bnr.ro la fiecare `npm test`. In schimb, copilul primeste
// CONTAB_BNR_URL_ZI catre serverul de mai jos si exercita drumul REAL de retea.
const BNR_XML = '<?xml version="1.0"?><DataSet><Cube date="2026-06-15">'
  + '<Rate currency="EUR">5.1000</Rate><Rate currency="HUF" multiplier="100">1.2500</Rate></Cube></DataSet>';
let bnrHits = 0;
function startBnrFixture(port) {
  const http = require('http');
  const srv = http.createServer((rq, rs) => {
    bnrHits += 1;
    if (rq.url === '/cade') { rs.destroy(); return; }
    rs.writeHead(200, { 'Content-Type': 'application/xml' });
    rs.end(BNR_XML);
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

async function main() {
  PORT = await freePort();
  PORT2 = await freePort();
  const PORT_BNR = await freePort();
  const bnrSrv = await startBnrFixture(PORT_BNR);
  globalThis.__bnrSrv = bnrSrv;
  BASE = 'http://127.0.0.1:' + PORT;
  await resetPgTestDb();
  fs.writeFileSync(DBF, JSON.stringify(buildDb()));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // plafoane de upload/export mici, ca testele 429 sa nu faca zeci de cereri; conturile
    // din restul suitei raman sub ele (bucket-urile sunt per utilizator)
    env: Object.assign({}, process.env, { PORT: String(PORT), CONTAB_BNR_URL_ZI: 'http://127.0.0.1:' + PORT_BNR + '/zi', CONTAB_BNR_URL_AN: 'http://127.0.0.1:' + PORT_BNR + '/an{AN}', CONTAB_BNR_RETRIES: '0', CONTAB_DB_DRIVER: process.env.CONTAB_TEST_DRIVER || 'sqlite', CONTAB_DB_FILE: DBF, CONTAB_DATA_DIR: DATA_TMP, CONTAB_JSON_MIRROR: '0', STRIPE_SECRET_KEY: '', CONTAB_RATE_UPLOAD: '8', CONTAB_RATE_EXPORT: '5', CONTAB_RATE_API: '100000', CONTAB_HIBP: '0', CONTAB_DEV: '1', CONTAB_RATE_IMPORT: '7', CONTAB_MESSAGES_MAX: '5' }),
    stdio: 'ignore',
  });
  const killAll = () => { try { child.kill(); } catch (_) { /* */ } try { fs.unlinkSync(DBF); } catch (_) { /* */ } try { fs.rmSync(DATA_TMP, { recursive: true, force: true }); } catch (_) { /* */ } };
  const guard = setTimeout(() => { console.error('  ✗ timeout global teste HTTP'); killAll(); process.exit(1); }, 45000);

  try {
    ok('serverul de test porneste', await waitUp());

    // ── SAF-T generare asincrona: output BYTE-IDENTIC cu varianta sincrona (yield-urile din
    // buclele grele nu schimba continutul). Prag mic (env) ca sa se declanseze cedari reale
    // pe un dataset mic; acopera GL + facturi (sales/purchase) + plati. ──
    {
      process.env.CONTAB_SAFT_YIELD_EVERY = '5';
      delete require.cache[require.resolve('../src/saft')];
      const saft = require('../src/saft');
      const mkE = (id, tip, data, lines, extra) => Object.assign({ id, firmaId: 1, tip, tipNume: tip, data, period: data.slice(0, 7), lines }, extra || {});
      const dset = { company: { nume: 'T SRL', cui: '12345678', tvaPlatitor: true }, openingBalances: {}, partners: {}, entries: [], products: [], assets: [], stockMovements: [] };
      for (let i = 0; i < 15; i++) {
        dset.entries.push(mkE('s' + i, 'factura_vanzare_marfuri', '2026-03-10', [{ debit: '4111', credit: '707', suma: 100 + i }, { debit: '4111', credit: '4427', suma: 19 }], { partener: 'CLIENT ' + i, document: 'F' + i }));
        dset.entries.push(mkE('p' + i, 'factura_cumparare_marfuri', '2026-03-05', [{ debit: '371', credit: '401', suma: 50 + i }, { debit: '4426', credit: '401', suma: 9 }], { partener: 'FURNIZOR ' + i, document: 'A' + i }));
        dset.entries.push(mkE('inc' + i, 'incasare_client', '2026-03-20', [{ debit: '5121', credit: '4111', suma: 100 }], { partener: 'CLIENT ' + i }));
      }
      const syncOut = saft.saftXml(dset, '2026-03');
      const asyncOut = await saft.saftXmlAsync(dset, '2026-03');
      eq('SAF-T async byte-identic cu sincron (45 entries, yield la 5)', asyncOut, syncOut);
      ok('SAF-T async: XML bine-format cu GL si facturi', /<GeneralLedgerEntries>/.test(asyncOut) && /<SalesInvoices>/.test(asyncOut) && /<PurchaseInvoices>/.test(asyncOut));
    }

    // public + autentificare
    const h = await req('GET', '/api/health');
    ok('health public: ok', h.status === 200 && h.json && h.json.ok === true && typeof h.json.uptimeSec === 'number' && typeof h.json.firme === 'number');
    // health e PUBLIC: nu are voie sa scurga detalii de proces/infrastructura (fingerprinting)
    ok('health public NU expune diagnostice (nodeVersion/pid/memorie/driver/users)',
      !('nodeVersion' in h.json) && !('pid' in h.json) && !('memoryRssMb' in h.json) && !('driver' in h.json) && !('users' in h.json));
    // logging structurat: fiecare raspuns poarta un identificator de cerere (corelare eroare<->cerere)
    ok('X-Request-Id prezent pe raspuns', /^[0-9a-f]{8}$/.test(h.reqId || ''));
    // anteturi de securitate (helmet, cu CSP calibrat): paritate cu configuratia precedenta
    const hdrs = (await fetch(BASE + '/api/health')).headers;
    const csp = hdrs.get('content-security-policy') || '';
    ok('CSP: script-src self', /script-src 'self'/.test(csp));
    ok('CSP: connect-src include puntea locala', /connect-src[^;]*127\.0\.0\.1:8765/.test(csp));
    ok('CSP: frame-src self blob (vizualizator PDF)', /frame-src 'self' blob:/.test(csp));
    ok('CSP: worker-src self (service worker PWA)', /worker-src 'self'/.test(csp));

    // ── PWA: manifest + service worker + iconite servite corect ──
    const man = await fetch(BASE + '/manifest.webmanifest');
    ok('manifest: 200 cu content-type de manifest', man.status === 200 && /application\/manifest\+json/.test(man.headers.get('content-type') || ''));
    const manJson = JSON.parse(await man.text());
    ok('manifest: campuri de instalabilitate (name/start_url/display/icons)',
      manJson.name && manJson.start_url === '/' && manJson.display === 'standalone' && Array.isArray(manJson.icons) && manJson.icons.length >= 2);
    const sw = await fetch(BASE + '/sw.js');
    ok('service worker: 200 cu no-cache (revalidat, nu servit vechi)', sw.status === 200 && /no-cache/.test(sw.headers.get('cache-control') || ''));
    const swBody = await sw.text();
    ok('service worker: ocoleste datele (/api|/pdf|/xml|/csv|/efactura nu se cacheaza)', /api\|pdf\|xml\|csv\|efactura/.test(swBody) && /BYPASS/.test(swBody));
    const icon = await fetch(BASE + '/icon-192.png');
    const iconBuf = Buffer.from(await icon.arrayBuffer());
    ok('iconita 192: 200 image/png cu magic PNG', icon.status === 200 && iconBuf[0] === 0x89 && iconBuf.slice(1, 4).toString() === 'PNG');
    eq('X-Content-Type-Options nosniff', hdrs.get('x-content-type-options'), 'nosniff');
    eq('Referrer-Policy pastrat', hdrs.get('referrer-policy'), 'strict-origin-when-cross-origin');
    eq('Cross-Origin-Opener-Policy same-origin', hdrs.get('cross-origin-opener-policy'), 'same-origin');
    ok('Permissions-Policy pastrat', /camera=\(\)/.test(hdrs.get('permissions-policy') || ''));
    ok('COEP dezactivat (nu rupe iframe PDF/punte)', !hdrs.get('cross-origin-embedder-policy'));
    ok('CORP dezactivat (comportament pastrat)', !hdrs.get('cross-origin-resource-policy'));
    eq('date fara login -> 401', (await req('GET', '/api/dashboard')).status, 401);
    const pwGresit = await req('POST', '/api/login', { body: { username: 'user1', password: 'nu' } });
    eq('login cu parola gresita -> 401', pwGresit.status, 401);
    // ANTI-ENUMERARE: un nume inexistent nu are voie sa se deosebeasca de o parola gresita pe
    // NICIUN canal. Costul (scrypt ruleaza si pe contul lipsa) e masurat in test/auth.js, unde
    // se poate numara; aici se apara canalul de CONTINUT, singurul observabil din afara.
    // Aserttia e intre cele doua raspunsuri, nu fata de un text fix: asa o reformulare a
    // mesajului ramane liberă, dar o divergenta intre ramuri pica.
    const userLipsa = await req('POST', '/api/login', { body: { username: 'nimeni-pe-lume-2026', password: 'nu' } });
    eq('nume inexistent -> tot 401', userLipsa.status, pwGresit.status);
    eq('nume inexistent -> acelasi mesaj ca parola gresita (fara enumerare)',
      JSON.stringify(userLipsa.json), JSON.stringify(pwGresit.json));
    // login reusit imediat dupa: clearFails reseteaza contorul (MAX_ATTEMPTS=8), deci cele trei
    // esecuri consecutive de mai sus nu lasa IP-ul suitei blocat pentru testele urmatoare
    const l1 = await req('POST', '/api/login', { body: { username: 'user1', password: 'parola1' } });
    ok('login user1 reusit + cookie', l1.status === 200 && /^sid=/.test(l1.cookie));
    const c1 = l1.cookie;
    const me = await req('GET', '/api/me', { cookie: c1 });
    ok('/api/me: identitate si tip', me.json && me.json.username === 'user1' && me.json.tip === 'tester');

    // politica de parole: inscrierea respinge o parola prea scurta (respingerea nu creeaza nimic)
    const regWeak = await req('POST', '/api/register', { body: { nume: 'Firma Noua SRL', username: 'noureg', password: 'scurt' } });
    ok('register: parola prea scurta -> 400', regWeak.status === 400 && /prea scurta/i.test((regWeak.json || {}).error || ''));
    // Numele de utilizator: aceeasi regula pe AMBELE cai de creare. Inainte, inscrierea publica
    // verifica duplicatele insensibil la litere mari/mici, iar ruta de admin SENSIBIL si fara trim,
    // deci puteau coexista conturi care arata identic in liste si in jurnalul de audit.
    const regInv = await req('POST', '/api/register', { body: { nume: 'F SRL', username: 'a\u200bb', password: 'ParolaBunaDeTot9' } });
    ok('register: nume cu caracter invizibil -> 400', regInv.status === 400 && /invizibile|control/i.test((regInv.json || {}).error || ''));
    const regScurt = await req('POST', '/api/register', { body: { nume: 'F SRL', username: ' ab ', password: 'ParolaBunaDeTot9' } });
    ok('register: nume prea scurt dupa trim -> 400', regScurt.status === 400 && /prea scurt/i.test((regScurt.json || {}).error || ''));
    // ── FIRMA DEMO: pentru cine are portofoliul GOL ──
    // Un contabil se inscrie fara nicio firma (firmele vin de la clienti), deci pana preia primul
    // client deschide o aplicatie goala si n-are ce evalua. NU se foloseste inscrierea publica in
    // aceasta proba: are plafon de 5/ora/IP, iar alte teste din suita se bazeaza pe el.
    {
      const fsD = require('fs'); const pthD = require('path');
      fsD.writeFileSync(pthD.join(DATA_TMP, 'demo-firma.json'), JSON.stringify({ _format: 'contab-firma-v1',
        firma: { nume: 'S.C. DEMO SAMPLE S.R.L.', cui: '40123456', tvaPlatitor: true },
        entries: [], documents: [], partners: {}, openingBalances: {} }));
      const cA = (await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } })).cookie;
      await req('POST', '/api/users', { cookie: cA, body: { username: 'fara-firme', password: 'ParolaTest2026x', role: 'user', firme: [] } });
      const cF = (await req('POST', '/api/login', { body: { username: 'fara-firme', password: 'ParolaTest2026x' } })).cookie;

      eq('portofoliu gol: primeste firma demo -> 200', (await req('POST', '/api/firme/demo', { cookie: cF })).status, 200);
      const fdemo = ((await req('GET', '/api/firme', { cookie: cF })).json.firme || []).find((f) => f.demo);
      ok('firma e MARCATA demo (nu se poate confunda cu una reala)', !!fdemo);
      ok('numele spune ce e', /DEMO/i.test((fdemo || {}).nume || ''));
      // O SINGURA firma demo: altfel portofoliul s-ar umple cu dosare de exercitiu care arata ca
      // firme reale in tabloul de conformitate.
      eq('a doua cerere -> 409', (await req('POST', '/api/firme/demo', { cookie: cF })).status, 409);
      // Cine ARE deja o firma de lucru nu primeste una demo: pentru incercari exista clona [TEST].
      eq('cont cu firma proprie: refuzat -> 403', (await req('POST', '/api/firme/demo', { cookie: c1 })).status, 403);
    }


    // ── Nicio ruta de scriere nu scapa gardii de autentificare ──
    // Autentificarea e o SINGURA garda in bootstrap, deci proprietatea depinde de ORDINEA de
    // inregistrare: o ruta montata inaintea ei ar raspunde neautentificat, si nimic nu ar spune-o.
    // Enumeram rutele din sursa si le lovim fara sesiune — 401 (sau 403 de la garda CSRF) e
    // respingere; orice 2xx inseamna ca cererea a ajuns la handler.
    {
      const fsx = require('fs'); const pth = require('path');
      const root = pth.join(__dirname, '..');
      // `/api/client-error` scrie doar intr-un inel de diagnostic din RAM (nicio date de firma,
      // nicio persistenta) si trebuie sa mearga FARA sesiune: eroarea de pe ecranul de login e
      // exact cea care altfel nu se afla. Exceptia e deliberata si se vede in diff-ul testului.
      const PUBLICE = new Set(['/api/login', '/api/logout', '/api/me', '/api/forgot-password', '/api/register',
        '/api/stripe/webhook', '/api/plans', '/api/demo-login', '/api/checkout-guest', '/api/client-error']);
      const codeFiles = ['server.js', 'src/authRoutes.js', ...fsx.readdirSync(pth.join(root, 'src', 'routes')).map((f) => 'src/routes/' + f)];
      const rute = new Set();
      for (const f of codeFiles) {
        const s = fsx.readFileSync(pth.join(root, f), 'utf8');
        for (const m of s.matchAll(/app\.(post|put|patch|delete)\(\s*'([^']+)'/g)) {
          const p = m[2];
          if (PUBLICE.has(p) || p.startsWith('/api/invite/') || p.startsWith('/api/reset/')) continue;
          rute.add(m[1].toUpperCase() + ' ' + p);
        }
      }
      const scapate = [];
      for (const r of rute) {
        const [meth, p] = r.split(' ');
        const url = p.replace(/:[a-zA-Z0-9_]+/g, 'x');
        const res = await req(meth, url); // FARA cookie
        if (res.status < 400) scapate.push(r + ' -> ' + res.status);
      }
      ok('rutele de scriere enumerate din sursa (>80)', rute.size > 80);
      ok('nicio ruta de scriere nu raspunde fara sesiune'
        + (scapate.length ? ' — ' + scapate.slice(0, 5).join(' | ') : ''), scapate.length === 0);
    }

    // autorizare pe firma: user1 (firma 1) nu vede documentul firmei 2
    eq('document al altei firme -> 403', (await req('GET', '/api/document/docA/file', { cookie: c1 })).status, 403);

    // filtrul de upload: HTML respins, CSV acceptat
    const fdBad = new FormData();
    fdBad.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'evil.html');
    eq('upload .html respins (400)', (await req('POST', '/api/upload-only', { cookie: c1, body: fdBad })).status, 400);
    const fdOk = new FormData();
    fdOk.append('file', new Blob(['CUI;Den\n1;X'], { type: 'text/csv' }), 'date.csv');
    eq('upload .csv acceptat', (await req('POST', '/api/upload-only', { cookie: c1, body: fdOk })).status, 200);

    // ── Controlul calitatii extragerii: decizie, interventia operatorului, raport ──
    {
      // Cont separat pentru incarcari (ca la testul de plafon de upload): plafonul e per utilizator,
      // iar cele patru documente de aici ar fi consumat din bugetul restului suitei.
      const cUp = (await req('POST', '/api/login', { body: { username: 'uploader', password: 'parola1' } })).cookie;
      const incarca = async (nume, text) => {
        const fd = new FormData();
        fd.append('file', new Blob([text], { type: 'text/plain' }), nume);
        return req('POST', '/api/upload', { cookie: cUp, body: fd });
      };
      const u1 = await incarca('factura-alpha.txt', 'Factura ALPHA SRL nr F-777 din 2026-06-10, baza 1000, TVA 210, total 1210');
      eq('upload cu extragere: 200', u1.status, 200);
      const cal = u1.json.calitate;
      ok('raspunsul poarta scorul si decizia', !!cal && typeof cal.scor === 'number' && ['auto', 'revizuire'].includes(cal.decizie));
      ok('raspunsul poarta toate controalele, cu nume citibil',
        Array.isArray(cal.controale) && cal.controale.length >= 8 && cal.controale.every((c) => c.cod && c.nume && typeof c.ok === 'boolean'));
      // Suita ruleaza FARA cheie AI: extragerea e euristica, deci controlul de sursa/incredere pica
      // si decizia trebuie sa fie „revizuire". Regula e o conjunctie — nu se posteaza pe increderea
      // extractorului despre sine, ci pe controale verificabile.
      eq('fara AI: decizia e revizuire', cal.decizie, 'revizuire');
      ok('...cu motivele scrise, nu doar un steag', cal.motive.length > 0 && cal.motive.every((m) => typeof m === 'string' && m.length > 10));
      ok('needsReview ramane compatibil cu ce foloseste formularul', u1.json.needsReview === true);
      ok('nu s-a postat nimic automat', !u1.json.autoPostat);

      // POSTAREA AUTOMATA e o CONJUNCTIE: chiar cu optiunea pornita, controalele picate o opresc.
      ok('optiunea de postare automata se salveaza pe firma',
        (await req('POST', '/api/company', { cookie: c1, body: { autoPostDocumente: true } })).json.ok === true);
      const u2 = await incarca('factura-beta.txt', 'Factura BETA SRL nr F-778 din 2026-06-11, baza 500, TVA 105, total 605');
      ok('cu optiunea pornita dar controale picate: TOT revizuire, nimic postat',
        u2.json.calitate.decizie === 'revizuire' && !u2.json.autoPostat);
      // ...si nici macar nu s-a INCERCAT: daca postarea ar fi fost incercata si ar fi esuat din alt
      // motiv (perioada inchisa, guard fiscal), ruta ar adauga motivul „Postarea automată a fost
      // oprită". Absenta lui dovedeste ca poarta e o CONJUNCTIE, nu doar optiunea firmei.
      ok('...si postarea nici nu a fost incercata (poarta e conjunctie, nu doar optiunea)',
        !(u2.json.calitate.motive || []).some((m) => /Postarea automat/i.test(m)));
      await req('POST', '/api/company', { cookie: c1, body: { autoPostDocumente: false } });

      // INTERVENTIA se consemneaza SINGURA din diferenta extras -> salvat (nu se cere din interfata)
      const salv = await req('POST', '/api/entries', { cookie: c1, body: {
        tip: 'factura_cumparare_marfuri', fileId: u1.json.documentId,
        motivRevizuire: 'Furnizorul pune totalul in subsol; extragerea a luat subtotalul.',
        fields: { data: '2026-06-10', document: 'F-777', partener: 'ALPHA SRL', cuiPartener: 'RO4242', baza: 1000, tva: 210, cota: 21, suma: 1210 },
      } });
      eq('articolul se salveaza din document', salv.status, 200);

      const rap = (await req('GET', '/api/extract-quality?days=30', { cookie: c1 })).json;
      ok('raport: numara documentele citite si interventiile', rap.documenteCitite >= 2 && rap.interventii >= 1);
      ok('raport: rata de corectie e un procent', rap.rataCorectie >= 0 && rap.rataCorectie <= 100);
      ok('raport: furnizorul corectat apare, cu numarul de interventii',
        rap.furnizori.some((f) => f.cheie === 'ALPHA SRL' && f.interventii >= 1));
      ok('raport: formatul fisierului apare', rap.formate.some((f) => f.cheie === 'txt'));
      ok('raport: controalele picate sunt agregate', rap.peControl.length > 0 && rap.peControl[0].n >= 1 && !!rap.peControl[0].nume);
      ok('raport: campurile corectate sunt agregate', rap.peCamp.some((c) => c.camp === 'document' || c.camp === 'partener'));
      const rec = rap.recente[0];
      ok('raport: interventia recenta poarta motivul scris de operator', !!rec && /subsol/.test(rec.motiv));
      ok('raport: si diferenta camp cu camp (ce a citit vs ce s-a salvat)',
        !!rec && Array.isArray(rec.campuri) && rec.campuri.some((c) => c.camp === 'document' && c.salvat === 'F-777'));
      ok('raport: starea optiunii de postare automata e vizibila', rap.autoPostActiv === false);

      // A doua salvare din ACELASI document nu dubleaza interventia (consemnarea e idempotenta)
      const inainte = (await req('GET', '/api/extract-quality?days=30', { cookie: c1 })).json.interventii;
      await req('POST', '/api/entries', { cookie: c1, body: {
        tip: 'factura_cumparare_marfuri', fileId: u1.json.documentId,
        fields: { data: '2026-06-10', document: 'F-779', partener: 'ALPHA SRL', cuiPartener: 'RO4242', baza: 10, tva: 2.1, cota: 21, suma: 12.1 },
      } });
      eq('interventia se consemneaza o singura data per document',
        (await req('GET', '/api/extract-quality?days=30', { cookie: c1 })).json.interventii, inainte);

      // Duplicat: acelasi numar de document, acelasi partener -> controlul trebuie sa pice
      const u3 = await incarca('factura-alpha-dubla.txt', 'Factura ALPHA SRL nr F-777 din 2026-06-10, baza 1000, TVA 210, total 1210');
      const cDup = (u3.json.calitate.controale || []).find((c) => c.cod === 'duplicat');
      ok('controlul de duplicat exista si raporteaza starea', !!cDup && typeof cDup.ok === 'boolean');
    }

    // protectia de continut: extensia nu garanteaza continutul — un .pdf cu text e respins
    // si fisierul salvat de multer nu ramane pe disc
    const upDir = path.join(DATA_TMP, 'uploads');
    const nrFisiere = () => (fs.existsSync(upDir) ? fs.readdirSync(upDir).length : 0);
    const inainte = nrFisiere();
    const fdFake = new FormData();
    fdFake.append('file', new Blob(['doar text, nu e pdf'], { type: 'application/pdf' }), 'deghizat.pdf');
    const rFake = await req('POST', '/api/upload-only', { cookie: c1, body: fdFake });
    ok('pdf deghizat (continut text) -> 400 cu mesaj clar', rFake.status === 400 && /nu corespunde extensiei/.test(rFake.json.error));
    eq('fisierul deghizat nu ramane pe disc', nrFisiere(), inainte);

    // ── importul ZIP de firma: TRANZACTIONAL (staging + rollback fara urme) ──
    const AdmZipT = require('adm-zip');
    const mkZip = (bundleJson, files) => {
      const z = new AdmZipT();
      if (bundleJson != null) z.addFile('firma.json', Buffer.from(bundleJson));
      for (const [nume, cont] of files || []) z.addFile(nume, Buffer.from(cont));
      const fd = new FormData();
      fd.append('file', new Blob([z.toBuffer()], { type: 'application/zip' }), 'firma.zip');
      return fd;
    };
    const faraStaging = () => !fs.readdirSync(upDir).some((n) => n.startsWith('.import-'));
    const okBundle = JSON.stringify({ firma: { nume: 'Import SRL', cui: '111' }, entries: [], documents: [] });

    const nUp0 = nrFisiere();
    const rImp = await req('POST', '/api/firme/import-zip', { cookie: c1, body: mkZip(okBundle, [['files/a.pdf', '%PDF-fals']]) });
    ok('import valid: 200 cu firma noua', rImp.status === 200 && rImp.json.firmaId > 0 && rImp.json.files === 1);
    eq('import valid: fisierul atasat a ajuns in uploads', nrFisiere(), nUp0 + 1);
    ok('import valid: stagingul a disparut dupa commit', faraStaging());
    // firma importata primeste proba de 30 de zile (ca la creare) — fara paywall imediat
    ok('firma importata are abonament de proba (fara 402)', (await req('GET', '/api/entries', { cookie: c1 })).status === 200);
    await req('POST', '/api/firme/1/activate', { cookie: c1 });

    const nUp1 = nrFisiere();
    const rDup = await req('POST', '/api/firme/import-zip', { cookie: c1, body: mkZip(okBundle, [['files/a.pdf', 'unu'], ['files/sub/a.pdf', 'doi']]) });
    ok('nume duplicate in arhiva -> 400 cu mesaj clar', rDup.status === 400 && /de mai multe ori/.test(rDup.json.error));
    eq('duplicate: niciun fisier nu ramane pe disc', nrFisiere(), nUp1);

    const rBad = await req('POST', '/api/firme/import-zip', { cookie: c1, body: mkZip('{"x":1}', [['files/b.pdf', 'date']]) });
    ok('pachet fara obiectul firma -> 400 inainte de orice scriere', rBad.status === 400 && /obiectul firma/.test(rBad.json.error));
    eq('rollback fara urme: uploads neschimbat', nrFisiere(), nUp1);
    ok('rollback fara urme: fara directoare de staging', faraStaging());

    const rArr = await req('POST', '/api/firme/import-zip', { cookie: c1, body: mkZip(JSON.stringify({ firma: { nume: 'X' }, entries: {} }), []) });
    ok('colectie care nu e lista -> 400', rArr.status === 400 && /nu este o lista/.test(rArr.json.error));

    const rNoJ = await req('POST', '/api/firme/import-zip', { cookie: c1, body: mkZip(null, [['files/c.pdf', 'x']]) });
    ok('arhiva fara firma.json -> 400', rNoJ.status === 400 && /firma\.json/.test(rNoJ.json.error));
    // plafonul DEDICAT de importuri (CONTAB_RATE_IMPORT=7 in test): urmatoarele lovesc 429
    let impUltim;
    for (let i = 0; i < 3; i++) impUltim = await req('POST', '/api/firme/import-zip', { cookie: c1, body: mkZip(null, []) });
    eq('plafonul dedicat de importuri -> 429', impUltim.status, 429);
    // curatenie: firma importata se sterge (testele de portofoliu conteaza firmele lui c1)
    eq('firma importata se poate sterge', (await req('DELETE', '/api/firme/' + rImp.json.firmaId, { cookie: c1 })).status, 200);
    await req('POST', '/api/firme/1/activate', { cookie: c1 });
    ok('firma activa restaurata dupa testele de import', (await req('GET', '/api/meta', { cookie: c1 })).json.firmaActiva === 1);

    // plafonul de upload per utilizator (CONTAB_RATE_UPLOAD=8 in env-ul de test): al 9-lea -> 429
    const lUp = await req('POST', '/api/login', { body: { username: 'uploader', password: 'parola1' } });
    let ultimul;
    for (let i = 0; i < 9; i++) {
      const fd = new FormData();
      fd.append('file', new Blob(['a;b\n1;2'], { type: 'text/csv' }), 'plafon-' + i + '.csv');
      ultimul = await req('POST', '/api/upload-only', { cookie: lUp.cookie, body: fd });
    }
    eq('al 9-lea upload intr-o ora -> 429', ultimul.status, 429);
    ok('mesajul 429 spune cand sa revina', /Reincearca peste/.test(ultimul.json.error));


    // plafonul de export per utilizator (CONTAB_RATE_EXPORT=5): al 6-lea SAF-T -> 429
    let ultimulX;
    for (let i = 0; i < 6; i++) ultimulX = await req('GET', '/xml/saft?year=2026', { cookie: lUp.cookie });
    eq('al 6-lea export SAF-T intr-o ora -> 429', ultimulX.status, 429);

    // registrul depunerilor + portofoliu + notificari
    const reg = await req('GET', '/api/declarations?period=2026-06', { cookie: c1 });
    const d300 = reg.json && reg.json.rows.find((r) => r.tip === 'd300');
    const saft = reg.json && reg.json.rows.find((r) => r.tip === 'saft');
    ok('registru: d300 cu termen 25', d300 && d300.due === '2026-07-25');
    ok('registru: saft lunar cu termen sfarsit de luna', saft && saft.due === '2026-07-31');
    const set = await req('POST', '/api/declarations/set', { cookie: c1, body: { tip: 'd300', period: '2026-06', status: 'depusa', recipisa: 'R1' } });
    const d300v2 = set.json && set.json.rows.find((r) => r.tip === 'd300');
    ok('registru: marcare depusa cu recipisa', d300v2 && d300v2.status === 'depusa' && d300v2.recipisa === 'R1');
    eq('marcarea depusa a blocat automat luna', set.json.locked, '2026-06');
    // ── Declaratii rectificative ──────────────────────────────────────────
    // Perioada e ACUM inchisa (marcarea „depusa" de mai sus a blocat-o automat) — exact contextul
    // in care se depune o rectificativa in practica.
    const rectFaraMotiv = await req('POST', '/api/declarations/rectificativa', { cookie: c1, body: { tip: 'd300', period: '2026-06' } });
    eq('rectificativa pe perioada inchisa FARA motiv -> 400', rectFaraMotiv.status, 400);
    ok('mesajul explica ca rectificativa e permisa, dar cere motiv',
      /motiv/i.test((rectFaraMotiv.json || {}).error || ''));
    const rectOk = await req('POST', '/api/declarations/rectificativa', { cookie: c1, body: { tip: 'd300', period: '2026-06', motiv: 'factura de la furnizor primita dupa depunere' } });
    eq('rectificativa cu motiv scris -> 200', rectOk.status, 200);
    eq('e a doua depunere pe perioada', rectOk.json.depunere.ordinal, 2);
    ok('depunerea e marcata rectificativa', rectOk.json.depunere.rectificativa === true);
    ok('D300 nu poarta steag in XML (redepunere)', rectOk.json.semnalizataInXml === false);
    // Pe un tip fara depunere anterioara nu exista „rectificativa" — e o depunere normala.
    const rectFaraBaza = await req('POST', '/api/declarations/rectificativa', { cookie: c1, body: { tip: 'd390', period: '2026-06', motiv: 'oarecare' } });
    eq('rectificativa fara depunere anterioara -> 400', rectFaraBaza.status, 400);
    // Istoricul e vizibil si nu se pierde
    const ist = await req('GET', '/api/declarations/istoric?tip=d300&period=2026-06', { cookie: c1 });
    eq('istoricul are ambele depuneri', ist.json.depuneri.length, 2);
    ok('istoricul pastreaza motivul', /furnizor/.test(ist.json.depuneri[1].motiv));
    // Auditul consemneaza rectificativa (altfel corectia peste o luna raportata ar fi invizibila)
    const auditRect = await req('GET', '/api/audit', { cookie: c1 });
    const listaAudit = Array.isArray(auditRect.json) ? auditRect.json : (auditRect.json.items || []);
    ok('rectificativa apare in jurnalul de audit',
      listaAudit.some((a) => a.action === 'declaratie.rectificativa'));

    // ── Fisier de plati pain.001 ──────────────────────────────────────────
    {
      const laP = await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } });
      // Propunerile arata si randurile care NU pot intra in lot, cu motivul — nu le ascund.
      const prop = await req('GET', '/api/plati/propuneri?tip=furnizori', { cookie: laP.cookie });
      eq('propunerile de plata se pot citi', prop.status, 200);
      ok('fiecare rand spune daca e gata si de ce nu', (prop.json.randuri || []).every((r) => 'gata' in r && 'motiv' in r));
      ok('firma fara IBAN e semnalata separat', typeof prop.json.platitorGata === 'boolean');

      // Fara IBAN pe firma, generarea REFUZA cu toate problemele deodata.
      const fara = await req('POST', '/xml/pain001', { cookie: laP.cookie, body: { plati: [{ beneficiar: 'ALFA', iban: 'DE89370400440532013000', suma: 10 }] } });
      eq('generare fara IBAN-ul firmei -> 400', fara.status, 400);
      ok('raspunsul enumera problemele', Array.isArray(fara.json.probleme) && fara.json.probleme.length > 0);

      // Completam IBAN-ul firmei si generam
      await req('POST', '/api/company', { cookie: laP.cookie, body: { iban: 'RO49AAAA1B31007593840000' } });
      const rau = await req('POST', '/xml/pain001', { cookie: laP.cookie, body: { plati: [{ beneficiar: 'ALFA', iban: 'RO00GRESIT', suma: 10 }] } });
      eq('IBAN de beneficiar invalid -> 400 (nu se genereaza)', rau.status, 400);
      ok('mesajul numeste IBAN-ul invalid', /IBAN invalid/i.test((rau.json || {}).error || ''));

      const entriesInainte = (await req('GET', '/api/entries', { cookie: laP.cookie })).json;
      const nrInainte = Array.isArray(entriesInainte) ? entriesInainte.length : entriesInainte.items.length;
      const okGen = await req('POST', '/xml/pain001', { cookie: laP.cookie, body: { moneda: 'RON', execDate: '2026-08-05',
        plati: [{ beneficiar: 'ALFA DISTRIBUTIE SRL', iban: 'DE89370400440532013000', suma: 1234.56, detalii: 'Factura 77' }] } });
      // Ruta e POST in afara lui /api/ — deci merita dovedit ca garda CSRF chiar o acopera,
      // nu doar ca prefixul apare intr-un regex. `noCsrf` sare peste antet in harness.
      const faraCsrf = await req('POST', '/xml/pain001', { cookie: laP.cookie, noCsrf: true,
        body: { plati: [{ beneficiar: 'ALFA', iban: 'DE89370400440532013000', suma: 10 }] } });
      eq('POST /xml/pain001 fara token CSRF -> 403', faraCsrf.status, 403);
      eq('generare valida -> 200', okGen.status, 200);
      ok('raspunsul e XML pain.001', /pain\.001\.001\.03/.test(okGen.text || ''));
      ok('se descarca drept fisier', /attachment/.test(okGen.headers.get('content-disposition') || ''));
      // INVARIANTUL: fisierul e o intentie de plata, nu o plata. Nimic nu s-a inregistrat.
      const entriesDupa = (await req('GET', '/api/entries', { cookie: laP.cookie })).json;
      const nrDupa = Array.isArray(entriesDupa) ? entriesDupa.length : entriesDupa.items.length;
      eq('generarea NU creeaza niciun articol contabil', nrDupa, nrInainte);
    }

    // ── Curs BNR (fixture LOCAL, zero apeluri externe) ────────────────────
    {
      const laBnr = await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } });
      const hitsInainte = bnrHits;
      const ref = await req('POST', '/api/curs-bnr/refresh', { cookie: laBnr.cookie, body: {} });
      eq('refresh curs BNR (admin) -> 200', ref.status, 200);
      eq('a adaugat ziua din feed', ref.json.adaugate, 1);
      ok('cererea a ajuns la fixture-ul local, nu pe internet', bnrHits > hitsInainte);
      const c = await req('GET', '/api/curs-bnr?moneda=EUR&data=2026-06-15', { cookie: c1 });
      ok('doar valutele din fixture sunt cunoscute (nu feed-ul real)',
        c.json.valute.length === 2 && c.json.valute.join(',') === 'EUR,HUF');
      ok('cursul EUR al zilei e cel din feed', c.json.rezultat && c.json.rezultat.curs === 5.1);
      ok('cursul e marcat exact', c.json.rezultat.exact === true);
      // Zi ulterioara, fara publicare: se ia ultimul curs publicat inainte (regula BNR).
      const c2 = await req('GET', '/api/curs-bnr?moneda=EUR&data=2026-06-20', { cookie: c1 });
      ok('zi fara publicare -> ultimul curs, marcat NEexact',
        c2.json.rezultat.curs === 5.1 && c2.json.rezultat.exact === false && c2.json.rezultat.data === '2026-06-15');
      // Multiplicatorul ajunge intreg pana in API (nu doar in modul)
      const cH = await req('GET', '/api/curs-bnr?moneda=HUF&data=2026-06-15', { cookie: c1 });
      ok('HUF ajunge in API cu multiplicatorul aplicat', cH.json.rezultat.curs === 0.0125);
      // A doua reimprospatare e idempotenta: aceeasi zi, nimic adaugat
      const ref2 = await req('POST', '/api/curs-bnr/refresh', { cookie: laBnr.cookie, body: {} });
      eq('reimprospatarea repetata nu dubleaza ziua', ref2.json.adaugate, 0);
      // Un utilizator ne-admin nu poate declansa reimprospatarea
      eq('refresh curs BNR fara admin -> 403', (await req('POST', '/api/curs-bnr/refresh', { cookie: c1, body: {} })).status, 403);

      // Feed CAZUT: oprim fixture-ul. Raspunsul trebuie sa fie 503 (serviciul extern e jos, nu
      // aplicatia) si sa indrume spre cursul manual — nicio capacitate nu se pierde.
      await new Promise((resolve) => globalThis.__bnrSrv.close(resolve));
      const jos = await req('POST', '/api/curs-bnr/refresh', { cookie: laBnr.cookie, body: {} });
      eq('feed BNR cazut -> 503, nu 500', jos.status, 503);
      ok('mesajul indruma spre cursul manual', /manual/i.test((jos.json || {}).error || ''));
      const dupa = await req('GET', '/api/curs-bnr?moneda=EUR&data=2026-06-15', { cookie: c1 });
      ok('cursurile deja descarcate raman utilizabile dupa un esec de feed', dupa.json.rezultat.curs === 5.1);
    }

    // deblocam (admin) — fluxul de test completeaza intentionat date in iunie in continuare
    const laLock = await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } });
    ok('deblocarea perioadei (admin) reuseste', (await req('POST', '/api/period-lock', { cookie: laLock.cookie, body: { lockedUntil: null } })).status === 200);
    const porto = await req('GET', '/api/portfolio?period=2026-06', { cookie: c1 });
    ok('portofoliu: doar firmele utilizatorului', porto.json && porto.json.firms.length === 1 && porto.json.firms[0].firmaId === 1);
    ok('portofoliu: fiecare firma are forma juridica + starea abonamentului',
      porto.json.firms.every((f) => (f.tipEntitate === 'srl' || f.tipEntitate === 'pfa') && typeof f.tvaPlatitor === 'boolean' && f.sub && typeof f.sub.status === 'string'));
    // admin vede toate firmele in portofoliu, cu forma+abonament (firma 3 = proba expirata din buildDb)
    const laPorto = await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } });
    const portoAdmin = (await req('GET', '/api/portfolio?period=2026-06', { cookie: laPorto.cookie })).json;
    ok('portofoliu admin: firma cu proba expirata apare cu status expired', portoAdmin.firms.some((f) => f.firmaId === 3 && f.sub.status === 'expired'));
    const notif = await req('GET', '/api/notifications', { cookie: c1 });
    ok('notificari: raspund cu items', notif.json && Array.isArray(notif.json.items));

    // proba expirata: read-only, dar plata si suportul raman deschise
    const l3 = await req('POST', '/api/login', { body: { username: 'expirat', password: 'parola1' } });
    ok('login expirat: subExpirat=true', l3.json && l3.json.user && l3.json.user.subExpirat === true);
    const c3 = l3.cookie;
    eq('expirat: citirile merg (200)', (await req('GET', '/api/dashboard', { cookie: c3 })).status, 200);
    eq('expirat: scrierile blocate (402)', (await req('POST', '/api/declarations/set', { cookie: c3, body: { tip: 'd300', period: '2026-06', status: 'depusa' } })).status, 402);
    eq('expirat: PDF blocat (402)', (await req('GET', '/pdf/balance', { cookie: c3 })).status, 402);
    eq('expirat: alegerea planului merge (200)', (await req('POST', '/api/subscription/select', { cookie: c3, body: { plan: 'start' } })).status, 200);

    // ── COLABORATORI PE FIRMA (contabil <-> necontabil): partajarea firmei active ──
    {
      const colList = await req('GET', '/api/colaboratori', { cookie: c1 });
      ok('colaboratori: lista firmei active cu marcaj „eu"', colList.status === 200 && Array.isArray(colList.json.colaboratori) && colList.json.eu && colList.json.colaboratori.some((c) => c.id === colList.json.eu));
      eq('colaboratori: fără sesiune -> 401 (sub garda /api)', (await req('GET', '/api/colaboratori')).status, 401);
      // adaugare cont existent: expirat (firma 3) capata acces si la firma 1
      eq('colaboratori: adaugare cont existent -> 200', (await req('POST', '/api/colaboratori', { cookie: c1, body: { mod: 'existing', username: 'expirat' } })).status, 200);
      ok('colaboratori: expirat are acum acces la firma 1', ((await req('GET', '/api/me', { cookie: c3 })).json.firme || []).includes(1));
      // scoatere -> expirat pierde firma 1 (starea revine curata)
      eq('colaboratori: scoatere -> 200', (await req('DELETE', '/api/colaboratori/3', { cookie: c1 })).status, 200);
      ok('colaboratori: expirat a pierdut accesul la firma 1', !((await req('GET', '/api/me', { cookie: c3 })).json.firme || []).includes(1));
      // garzi: cont inexistent 404, adminul deja are acces 400
      eq('colaboratori: cont inexistent -> 404', (await req('POST', '/api/colaboratori', { cookie: c1, body: { mod: 'existing', username: 'nimeni-aici' } })).status, 404);
      eq('colaboratori: adminul deja are acces -> 400', (await req('POST', '/api/colaboratori', { cookie: c1, body: { mod: 'existing', username: 'admin2' } })).status, 400);
      // invitatie prin link + acceptare -> user NOU cu acces la firma 1 (fluxul public existent)
      const inv = await req('POST', '/api/colaboratori', { cookie: c1, body: { mod: 'invite', username: 'colabinvitat' } });
      ok('colaboratori: invitatie -> link /?invite=<token>', inv.status === 200 && /\/\?invite=[0-9a-f]{48}$/.test(inv.json.link || ''));
      const tok = (String(inv.json.link).match(/invite=([0-9a-f]+)/) || [])[1];
      const acc = await req('POST', '/api/invite/accept', { body: { token: tok, password: 'ParolaBuna2026' } });
      ok('colaboratori: acceptarea invitatiei -> user nou cu firma 1', acc.status === 200 && (acc.json.user.firme || []).includes(1));
      // curatenie: sterge userul nou (admin) ca sa nu intre in snapshotul testului de backup de mai jos
      const cAdmCol = (await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } })).cookie;
      await req('DELETE', '/api/users/' + acc.json.user.id, { cookie: cAdmCol });
    }

    // ── CSRF: garda de origine pe cererile mutante (aparare in adancime peste SameSite=Lax) ──
    const evil = await req('POST', '/api/login', { headers: { Origin: 'https://atacator.example' }, body: { username: 'x', password: 'y' } });
    eq('POST cu Origin strain -> 403 (CSRF)', evil.status, 403);
    const own = await req('POST', '/api/login', { headers: { Origin: BASE }, body: { username: 'x', password: 'y' } });
    eq('POST cu Origin propriu trece de garda (401 = parola, nu 403)', own.status, 401);
    eq('Referer strain e respins la fel', (await req('POST', '/api/logout', { headers: { Referer: 'https://atacator.example/pagina' } })).status, 403);
    eq('GET cu Origin strain ramane permis (nu e mutant)', (await req('GET', '/api/health', { headers: { Origin: 'https://atacator.example' } })).status, 200);

    // ── CSRF: TOKEN SINCRONIZATOR (lipsa Origin nu mai e o portita) ──
    // Garda veche accepta cererea cand Origin/Referer LIPSEA. Acum, o cerere care poarta o SESIUNE
    // are nevoie de token — si cand antetul lipseste, care era exact conditia exploatabila.
    const faraToken = await req('POST', '/api/entries', { cookie: c1, noCsrf: true, body: { tip: 'nota_contabila', fields: { data: '2026-06-01', explicatie: 'x', debit: '5311', credit: '5121', suma: 1 } } });
    eq('mutanta cu sesiune si FARA token -> 403', faraToken.status, 403);
    eq('...cu motiv explicit (token, nu origine)', faraToken.json && faraToken.json.csrf, 'token');
    const tokGresit = await req('POST', '/api/entries', { cookie: c1, noCsrf: true, headers: { 'X-CSRF-Token': 'a'.repeat(32) }, body: { tip: 'nota_contabila', fields: { data: '2026-06-01', explicatie: 'x', debit: '5311', credit: '5121', suma: 1 } } });
    eq('token gresit (aceeasi lungime) -> 403', tokGresit.status, 403);
    // token-ul e legat de SESIUNE, nu de utilizator: o A DOUA sesiune a ACELUIASI cont are alt
    // sessId, deci alt token — iar acela nu merge pe cookie-ul primei sesiuni.
    const l1b = await req('POST', '/api/login', { body: { username: 'user1', password: 'parola1' } });
    const altTok = (await req('GET', '/api/me', { cookie: l1b.cookie })).json.csrf;
    ok('doua sesiuni ale aceluiasi cont au token-uri DIFERITE',
      !!altTok && altTok !== (await req('GET', '/api/me', { cookie: c1 })).json.csrf);
    const tokStrain = await req('POST', '/api/entries', { cookie: c1, noCsrf: true, headers: { 'X-CSRF-Token': altTok }, body: { tip: 'nota_contabila', fields: { data: '2026-06-01', explicatie: 'x', debit: '5311', credit: '5121', suma: 1 } } });
    eq('token-ul altei SESIUNI -> 403 (legat de sesiune, nu de cont)', tokStrain.status, 403);

    // ── Cookie MORT: nu are voie sa blocheze o autentificare noua ──
    // Garda cerea token pentru orice cookie cu SEMNATURA valida, chiar daca sesiunea fusese
    // revocata. Pe pagina de login token-ul nu se poate obtine (/api/meta raspunde 401, deci nu
    // exista `user.csrf`), asa ca utilizatorul ramas cu un cookie vechi nu se mai putea autentifica
    // DELOC — nici cu parola, nici demo, nici inscriere. „Reincarca pagina" nu ajuta: dupa
    // reincarcare situatia e identica. Un cookie mort nu ofera credentiale de calarit, deci pentru
    // CSRF e echivalent cu lipsa sesiunii.
    {
      const viu = await req('POST', '/api/login', { body: { username: 'user1', password: 'parola1' } });
      await req('POST', '/api/logout', { cookie: viu.cookie }); // serverul revoca sesiunea...
      // ...dar browserul poate ramane cu cookie-ul (tab vechi, restaurare de sesiune, back/forward)
      eq('cookie mort: /api/meta raspunde 401 (deci se arata pagina de login)',
        (await req('GET', '/api/meta', { cookie: viu.cookie })).status, 401);
      const reLogin = await req('POST', '/api/login', { cookie: viu.cookie, noCsrf: true, headers: { Origin: BASE }, body: { username: 'user1', password: 'parola1' } });
      eq('cookie mort + login fara token -> merge (nu 403)', reLogin.status, 200);
      const reDemo = await req('POST', '/api/demo-login', { cookie: viu.cookie, noCsrf: true, headers: { Origin: BASE }, body: {} });
      ok('cookie mort + „Demo patron" fara token -> nu mai e respins', reDemo.status !== 403);
      // iar protectia pentru sesiunile VII ramane neatinsa (verificata si mai sus, pe c1)
      const viu2 = await req('POST', '/api/login', { body: { username: 'user1', password: 'parola1' } });
      const totBlocat = await req('POST', '/api/entries', { cookie: viu2.cookie, noCsrf: true, body: { tip: 'nota_contabila', fields: { data: '2026-06-01', explicatie: 'x', debit: '5311', credit: '5121', suma: 1 } } });
      eq('sesiune VIE fara token -> tot 403 (protectia nu s-a slabit)', totBlocat.status, 403);
    }
    // cu token-ul propriu, aceeasi cerere trece
    const cuToken = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'nota_contabila', fields: { data: '2026-06-01', explicatie: 'csrf ok', debit: '5311', credit: '5121', suma: 1 } } });
    eq('aceeasi cerere CU token propriu -> 200', cuToken.status, 200);
    // originea straina e respinsa CHIAR SI cu token valid (allowlist inainte de token)
    const tokMeu = (await req('GET', '/api/me', { cookie: c1 })).json.csrf;
    eq('Origin strain + token valid -> tot 403',
      (await req('POST', '/api/entries', { cookie: c1, noCsrf: true, headers: { Origin: 'https://atacator.example', 'X-CSRF-Token': tokMeu }, body: { tip: 'nota_contabila', fields: { data: '2026-06-01', explicatie: 'x', debit: '5311', credit: '5121', suma: 1 } } })).status, 403);
    // fara sesiune nu exista credentiale ambientale de calarit -> ruta publica ramane accesibila
    eq('POST public FARA sesiune si fara token ramane permis', (await req('POST', '/api/checkout-guest', { body: { plan: 'inexistent' } })).status, 400);

    // ── Abonament / plati (src/routes/billing.js) ──
    const plansPub = await req('GET', '/api/plans'); // public (fara sesiune)
    ok('planuri publice: lista + zile de proba', plansPub.status === 200 && Array.isArray(plansPub.json.plans) && typeof plansPub.json.trialDays === 'number');
    const subInfo = await req('GET', '/api/subscription', { cookie: c1 });
    ok('abonament: starea curenta + flag Stripe', subInfo.json && subInfo.json.current && typeof subInfo.json.stripeEnabled === 'boolean');
    eq('checkout-guest cu plan invalid -> 400', (await req('POST', '/api/checkout-guest', { body: { plan: 'inexistent' } })).status, 400);
    eq('non-admin la activarea de plan (admin) -> 403', (await req('POST', '/api/subscription/activate', { cookie: c1, body: { userId: 2, plan: 'pro' } })).status, 403);

    // ── Incasarea, suspendata cat timp furnizorul nu are identitate juridica publicata ──
    // Porti pe SURSA exista deja (test/run/porti.js), dar ele dovedesc ca garda e SCRISA, nu ca
    // raspunsul chiar se schimba: o garda pusa dupa un `return` ar fi trecut scanarea. Aici se
    // dovedeste comportamentul, pe serverul real.
    const plansM = require('../src/plans');
    if (plansM.PLATI_SUSPENDATE) {
      const cgValid = await req('POST', '/api/checkout-guest', { body: { plan: 'pro' } });
      eq('checkout-guest cu plan VALID -> 503 (incasare oprita)', cgValid.status, 503);
      ok('...cu motivul si marcajul pentru interfata', cgValid.json.platiSuspendate === true && /nu [îi]ncas[ăa]m/i.test(cgValid.json.error || ''));
      eq('subscription/checkout -> 503 (incasare oprita)', (await req('POST', '/api/subscription/checkout', { cookie: c1, body: { plan: 'pro' } })).status, 503);
      ok('/api/plans anunta suspendarea', plansPub.json.platiSuspendate === true);
      ok('/api/subscription anunta suspendarea + motivul', subInfo.json.platiSuspendate === true
        && typeof subInfo.json.motivPlatiSuspendate === 'string' && subInfo.json.motivPlatiSuspendate.length > 40);
      // Anularea NU are voie sa fie prinsa in suspendare: un client trebuie sa poata pleca oricand.
      // Fara abonament Stripe raspunsul e 400 („nimic de gestionat"), niciodata 503.
      eq('portalul de anulare NU e oprit de suspendare', (await req('POST', '/api/subscription/portal', { cookie: c1 })).status, 400);
    }

    // ── Previzualizarea articolului (POST /api/preview) ──
    // Miezul: previzualizarea din formular trebuie sa arate EXACT articolul care se va salva.
    // Pana la /api/preview, frontend-ul avea o replica proprie a regulilor si deviase tacit.
    // Aici comparam previzualizarea cu articolul salvat efectiv, pe aceleasi campuri.
    const pvFields = { data: '2026-06-11', partener: 'Client Preview SRL', cuiPartener: 'RO777', document: 'PV-1', baza: 1000, tva: 210, cota: 21, cost: 600 };
    const pv = await req('POST', '/api/preview', { cookie: c1, body: { tip: 'factura_vanzare_marfuri', fields: pvFields } });
    ok('preview: raspunde ok cu linii si total', pv.status === 200 && pv.json && pv.json.ok === true && Array.isArray(pv.json.lines));
    eq('preview: totalul e suma liniilor', pv.json.total, Math.round(pv.json.lines.reduce((s, l) => s + l.suma, 0) * 100) / 100);
    const seqBefore = (await req('GET', '/api/entries', { cookie: c1 })).json.length;
    const saved = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_marfuri', fields: pvFields } });
    const fmtLines = (ls) => ls.map((l) => l.debit + '=' + l.credit + ':' + l.suma).join(' | ');
    eq('preview = articolul salvat (aceleasi linii, aceleasi sume)', fmtLines(pv.json.lines), fmtLines(saved.json.entry.lines));
    eq('preview: acelasi nume de tip ca articolul salvat', pv.json.tipNume, saved.json.entry.tipNume);
    // Fara efecte secundare: previzualizarea NU salveaza si NU consuma un id din secventa.
    // (nextId incrementeaza `seq`; daca previzualizarea l-ar chema, numerotarea ar avea goluri.)
    const pv2 = await req('POST', '/api/preview', { cookie: c1, body: { tip: 'factura_vanzare_marfuri', fields: pvFields } });
    ok('preview: repetat, acelasi rezultat', fmtLines(pv2.json.lines) === fmtLines(pv.json.lines));
    const saved2 = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_marfuri', fields: Object.assign({}, pvFields, { document: 'PV-2' }) } });
    const idNum = (id) => Number(String(id).replace(/^e/, ''));
    eq('preview nu consuma id-uri: articolele salvate raman consecutive', idNum(saved2.json.entry.id), idNum(saved.json.entry.id) + 1);
    const seqAfter = (await req('GET', '/api/entries', { cookie: c1 })).json.length;
    eq('preview nu creeaza inregistrari (doar cele 2 salvate explicit)', seqAfter - seqBefore, 2);
    // Un articol inca incomplet NU e o eroare: e starea normala cat timp se completeaza formularul.
    const pvGol = await req('POST', '/api/preview', { cookie: c1, body: { tip: 'factura_vanzare_marfuri', fields: { data: '2026-06-11' } } });
    ok('preview fara sume: 200 cu ok=false si motiv, nu eroare HTTP', pvGol.status === 200 && pvGol.json.ok === false && /sum[aă]/i.test(pvGol.json.mesaj || ''));
    eq('preview fara tip -> 400', (await req('POST', '/api/preview', { cookie: c1, body: { fields: {} } })).status, 400);
    ok('preview cu tip inexistent: ok=false, nu 500', (await req('POST', '/api/preview', { cookie: c1, body: { tip: 'nu_exista_asa_ceva', fields: {} } })).json.ok === false);
    eq('preview fara sesiune -> 401', (await req('POST', '/api/preview', { body: { tip: 'factura_vanzare_marfuri', fields: pvFields } })).status, 401);
    // Regulile care depind de FIRMA — pe care o replica in frontend nu le putea sti. Le verificam
    // pe firma cu „TVA la incasare": TVA colectata devine neexigibila (4427 -> 4428).
    const firmaInc = await req('GET', '/api/firme', { cookie: c1 });
    const fid1 = firmaInc.json.firmaActiva;
    const setInc = await req('POST', '/api/firme/' + fid1, { cookie: c1, body: { tvaLaIncasare: true } });
    ok('firma trecuta pe TVA la incasare (pregatire)', setInc.json && setInc.json.ok && setInc.json.firma.tvaLaIncasare === true);
    const pvInc = await req('POST', '/api/preview', { cookie: c1, body: { tip: 'factura_vanzare_marfuri', fields: pvFields } });
    ok('preview reflecta TVA la incasare (4428, nu 4427)', pvInc.json.ok && pvInc.json.lines.some((l) => l.credit === '4428') && !pvInc.json.lines.some((l) => l.credit === '4427'));
    const savedInc = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_marfuri', fields: Object.assign({}, pvFields, { document: 'PV-3' }) } });
    eq('preview = salvat si sub TVA la incasare', fmtLines(pvInc.json.lines), fmtLines(savedInc.json.entry.lines));
    await req('POST', '/api/firme/' + fid1, { cookie: c1, body: { tvaLaIncasare: false } });

    // ── e-Factura: round-trip generare -> parsare -> import (fara conexiune SPV) ──
    const ubl = xml.eFacturaXml(
      { nume: 'UNU SRL', cui: 'RO11', adresa: 'Str. A', oras: 'Cluj', judet: 'RO-CJ' },
      { tip: 'factura_vanzare_marfuri', data: '2026-06-10', partener: 'CLIENT SRL', partenerCui: 'RO22', document: 'F100',
        lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] },
      {},
    );
    const parse = await req('POST', '/api/efactura/parse', { cookie: c1, body: { xml: ubl } });
    ok('efactura/parse: UBL propriu se citeste inapoi', parse.json && parse.json.ok && parse.json.invoice && parse.json.invoice.numar === 'F100');
    eq('efactura/parse: XML invalid -> 400', (await req('POST', '/api/efactura/parse', { cookie: c1, body: { xml: '<nu>e ubl</nu>' } })).status, 400);
    const imp = await req('POST', '/api/efactura/import', { cookie: c1, body: { xml: ubl, cont: '371' } });
    ok('efactura/import: creeaza inregistrare de cumparare', imp.json && imp.json.ok && imp.json.entry && imp.json.entry.tip.indexOf('cumparare') >= 0);

    // ── ANAF SPV: config + degradarea curata cand nu e conectat ──
    const acfg = await req('GET', '/api/anaf/config', { cookie: c1 });
    ok('anaf/config: forma cu connected=false', acfg.json && acfg.json.connected === false && acfg.json.configured === false);
    const fisaRol = await req('POST', '/api/anaf/fisa-rol', { cookie: c1 });
    ok('anaf/fisa-rol fara SPV -> refuz clar', fisaRol.status === 400 && /SPV|onect/i.test((fisaRol.json && fisaRol.json.error) || ''));

    // ── RO e-Transport (cod UIT): eligibile, validare, XML, izolare, garda neconectat ──
    const etNom = await req('GET', '/api/etransport/nomenclatoare', { cookie: c1 });
    ok('etransport/nomenclatoare: tip operatiune + scop', etNom.json && etNom.json.tipOperatiune && etNom.json.tipOperatiune['30'] && etNom.json.scopOperatiune['101']);
    const avizE = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'aviz_livrare', fields: { data: '2026-06-20', partener: 'Client Transport SRL', cuiPartener: 'RO4455', document: 'AVIZ-9', baza: 2000, tva: 420, cota: 21 } } });
    const avizId = avizE.json && avizE.json.entry && avizE.json.entry.id;
    ok('aviz de livrare inregistrat (pentru e-Transport)', avizE.json && avizE.json.ok && avizId);
    const etElig = await req('GET', '/api/etransport/eligible', { cookie: c1 });
    ok('etransport/eligible: avizul apare fara UIT', Array.isArray(etElig.json) && etElig.json.some((r) => r.id === avizId && r.uit === '' && r.valoare === 2000));
    // validare cu date incomplete (fara vehicul/NC/greutate/traseu) -> nu e ok, cu erori
    const etVBad = await req('POST', '/api/etransport/validate/' + avizId, { cookie: c1, body: {} });
    ok('etransport/validate: date incomplete -> erori (vehicul lipsa etc.)', etVBad.json && etVBad.json.ok === false && etVBad.json.errors.some((e) => /vehicul/i.test(e)));
    // validare cu date complete -> ok. STRADA e obligatorie in <locatie> (schema oficiala:
    // codJudet + denumireLocalitate + denumireStrada, toate `use="required"`).
    const etTdOk = { nrVehicul: 'CJ01ABC', codScopOperatiune: '101', codTarifar: '48191000', greutateNeta: 100, greutateBruta: 120,
      startJudet: 'Cluj', startLocalitate: 'Cluj-Napoca', startStrada: 'Str. Fabricii',
      finalJudet: 'Bucuresti', finalLocalitate: 'Bucuresti', finalStrada: 'Bd. Unirii' };
    const etVOk = await req('POST', '/api/etransport/validate/' + avizId, { cookie: c1, body: etTdOk });
    ok('etransport/validate: date complete -> ok', etVOk.json && etVOk.json.ok === true && etVOk.json.errors.length === 0);
    const etVFaraStrada = await req('POST', '/api/etransport/validate/' + avizId, { cookie: c1, body: Object.assign({}, etTdOk, { finalStrada: '' }) });
    ok('etransport/validate: traseu fara strada -> eroare (cerinta XSD)',
      etVFaraStrada.json && etVFaraStrada.json.ok === false && etVFaraStrada.json.errors.some((e) => /strada/i.test(e)));
    // XML: descarcare cu date de transport din query
    const etXmlRes = await req('GET', '/xml/etransport/' + avizId + '?nrVehicul=CJ01ABC&codTarifar=48191000&greutateBruta=120&startJudet=Cluj&startLocalitate=Cluj-Napoca&startStrada=Str.+Fabricii&finalJudet=Bucuresti&finalLocalitate=Bucuresti&finalStrada=Bd.+Unirii', { cookie: c1 });
    ok('xml/etransport: XML v2 bine-format cu tip operatiune si vehicul', etXmlRes.status === 200 && /xmlns="mfp:anaf:dgti:eTransport:declaratie:v2"/.test(etXmlRes.text) && /codTipOperatiune="30"/.test(etXmlRes.text) && /nrVehicul="CJ01ABC"/.test(etXmlRes.text));
    ok('xml/etransport: structura oficiala (<notificare> + <locatie>), nu <transport>',
      /<notificare\b/.test(etXmlRes.text) && !/<transport\b/.test(etXmlRes.text) && /<locatie /.test(etXmlRes.text));
    // trimitere fara conexiune SPV -> 400 cu mesaj clar (validarea nu se atinge inainte de conexiune)
    const etSend = await req('POST', '/api/etransport/send/' + avizId, { cookie: c1, body: etTdOk });
    ok('etransport/send fara SPV -> refuz clar', etSend.status === 400 && /SPV|onect/i.test((etSend.json && etSend.json.error) || ''));
    // articol neeligibil (factura de cumparare din importul e-Factura) -> 400
    const etIncomp = await req('POST', '/api/etransport/validate/' + (imp.json.entry.id), { cookie: c1, body: etTdOk });
    ok('etransport/validate: articol neeligibil (cumparare) -> 400', etIncomp.status === 400 && /neeligibil|eligibil/i.test((etIncomp.json && etIncomp.json.error) || ''));
    // izolare/inexistent: id necunoscut -> 404
    eq('etransport/status: id inexistent -> 404', (await req('POST', '/api/etransport/status/nuexista', { cookie: c1 })).status, 404);
    eq('xml/etransport: id inexistent -> 404', (await req('GET', '/xml/etransport/nuexista', { cookie: c1 })).status, 404);

    // ── Mijloace fixe: creare, plan de amortizare, inregistrarea amortizarii lunii ──
    eq('asset create fara campuri -> 400', (await req('POST', '/api/assets', { cookie: c1, body: { denumire: 'X' } })).status, 400);
    const mkAsset = await req('POST', '/api/assets', { cookie: c1, body: { denumire: 'Laptop', cont: '2131', cost: 6000, durataLuni: 24, dataPif: '2026-01-15', metoda: 'liniara' } });
    ok('asset create: mijloc fix nou', mkAsset.json && mkAsset.json.ok && mkAsset.json.asset && mkAsset.json.asset.id);
    const aid = mkAsset.json.asset.id;
    const lst = await req('GET', '/api/assets?asOf=2026-06', { cookie: c1 });
    ok('asset list: contine mijlocul creat', Array.isArray(lst.json) && lst.json.some((a) => a.id === aid));
    const sch = await req('GET', '/api/assets/' + aid + '/schedule', { cookie: c1 });
    ok('asset schedule: 24 rate liniare de 250', sch.json && sch.json.schedule.length === 24 && sch.json.schedule[0].amount === 250);
    const dep = await req('POST', '/api/assets/depreciation?period=2026-06', { cookie: c1 });
    ok('amortizare iunie: inregistrata (6811=2813)', dep.json && dep.json.ok && dep.json.result && dep.json.result.lines.length === 1);
    eq('amortizare iunie a doua oara -> 400 (deja inregistrata)', (await req('POST', '/api/assets/depreciation?period=2026-06', { cookie: c1 })).status, 400);
    ok('asset scrap: marcheaza casat', (await req('POST', '/api/assets/' + aid + '/scrap', { cookie: c1, body: {} })).json.asset.status === 'casat');
    ok('asset delete: sterge mijlocul', (await req('DELETE', '/api/assets/' + aid, { cookie: c1 })).json.ok === true);

    // ── Salarizare: angajat, stat de plata (posteaza articol), plata neta ──
    eq('angajat fara nume -> 400', (await req('POST', '/api/angajati', { cookie: c1, body: { salariuBrut: 5000 } })).status, 400);
    const mkAng = await req('POST', '/api/angajati', { cookie: c1, body: { nume: 'Ion Test', salariuBrut: 5000, functie: 'Operator' } });
    ok('angajat creat', mkAng.json && mkAng.json.ok && mkAng.json.angajat.id);
    const angId = mkAng.json.angajat.id;
    ok('lista angajati contine angajatul', (await req('GET', '/api/angajati', { cookie: c1 })).json.some((a) => a.id === angId));
    const sp = await req('GET', '/api/stat-plata?period=2026-06', { cookie: c1 });
    ok('stat de plata: CAS 25% pe 5000 = 1250', sp.json && sp.json.rows[0] && sp.json.rows[0].cas === 1250);
    eq('postare stat fara perioada -> 400', (await req('POST', '/api/stat-plata', { cookie: c1 })).status, 400);
    const post = await req('POST', '/api/stat-plata?period=2026-06', { cookie: c1 });
    ok('postare stat: articol 641=421 + retineri', post.json && post.json.ok && post.json.entry.lines.some((l) => l.debit === '641' && l.credit === '421'));
    const pay = await req('POST', '/api/stat-plata/pay?period=2026-06&cont=5121', { cookie: c1 });
    ok('plata salarii: 421 = 5121 pe restul de plata', pay.json && pay.json.ok && pay.json.entry.lines.some((l) => l.debit === '421' && l.credit === '5121'));
    ok('registru anual de salarii: cumuleaza luna postata', (await req('GET', '/api/registru-salarii?year=2026', { cookie: c1 })).json.angajati.some((a) => a.brut === 5000));
    ok('angajat sters', (await req('DELETE', '/api/angajati/' + angId, { cookie: c1 })).json.ok === true);

    // ── Stocuri: produs, gestiune, receptie, descarcare de gestiune (nota), stoc curent ──
    eq('produs fara cod -> 400', (await req('POST', '/api/products', { cookie: c1, body: { denumire: 'X' } })).status, 400);
    const mkP = await req('POST', '/api/products', { cookie: c1, body: { cod: 'P1', denumire: 'Marfa A', um: 'buc', cont: '371' } });
    ok('produs creat', mkP.json && mkP.json.ok && mkP.json.product.id);
    const pid = mkP.json.product.id;
    const mkG = await req('POST', '/api/gestiuni', { cookie: c1, body: { cod: 'G1', denumire: 'Depozit', gestionar: 'Ion' } });
    ok('gestiune creata', mkG.json && mkG.json.ok && mkG.json.gestiune.id);
    const gid = mkG.json.gestiune.id;
    const recep = await req('POST', '/api/stock-movements', { cookie: c1, body: { tip: 'receptie', productId: pid, gestiuneId: gid, cantitate: 10, pretUnitar: 5, data: '2026-06-05', document: 'NIR1' } });
    ok('receptie inregistrata', recep.json && recep.json.ok && recep.json.movement.id);
    const mid = recep.json.movement.id;
    const stoc = await req('GET', '/api/stocks?asOf=2026-06', { cookie: c1 });
    ok('stoc curent: 10 buc la CMP 5', Array.isArray(stoc.json) && stoc.json.some((s) => s.stocQ === 10 && s.cmp === 5));
    const postNota = await req('POST', '/api/stock-movements/' + mid + '/post', { cookie: c1 });
    ok('receptie postata: nota 371=401', postNota.json && postNota.json.ok && postNota.json.entry && postNota.json.entry.lines.some((l) => l.debit === '371' && l.credit === '401'));
    ok('lista miscari contine receptia', (await req('GET', '/api/stock-movements?period=2026-06', { cookie: c1 })).json.some((m) => m.id === mid));
    ok('stock-movements: fara limit e array, cu limit e plic paginat', Array.isArray((await req('GET', '/api/stock-movements', { cookie: c1 })).json)
      && Array.isArray((await req('GET', '/api/stock-movements?limit=1', { cookie: c1 })).json.items));
    const auditPg = (await req('GET', '/api/audit?limit=3', { cookie: c1 })).json;
    ok('audit: cu limit -> plic; fara limit -> array (implicit ultimele 300)', Array.isArray(auditPg.items) && typeof auditPg.total === 'number'
      && Array.isArray((await req('GET', '/api/audit', { cookie: c1 })).json));
    ok('fisa de magazie: o intrare', (await req('GET', '/api/stocks/' + pid + '/ledger', { cookie: c1 })).json.rows.length >= 1);
    ok('miscare stearsa', (await req('DELETE', '/api/stock-movements/' + mid, { cookie: c1 })).json.ok === true);

    // ── Preluare stoc initial (cantitativ-valoric, societate cu istoric) ──
    const initCsv = 'Cod;Denumire;UM;Cont;Gestiune;Cantitate;PretUnitar;Valoare\n'
      + 'P1;;;;G1;10;12,50\n'            // produs existent, pret cu virgula romaneasca
      + 'MP1;Faina;kg;301;DEPNOU;500;;1750'; // produs si gestiune noi, Valoare in loc de pret
    eq('import stoc initial fara data -> 400', (await req('POST', '/api/stocks/import-initial', { cookie: c1, body: { csv: initCsv } })).status, 400);
    const ii = await req('POST', '/api/stocks/import-initial', { cookie: c1, body: { csv: initCsv, data: '2025-12-31' } });
    ok('import stoc initial: 2 pozitii, 1 produs nou, 1 gestiune noua, fara erori',
      ii.json && ii.json.ok && ii.json.importate === 2 && ii.json.produseNoi === 1 && ii.json.gestiuniNoi === 1 && ii.json.erori.length === 0);
    const iiStoc = (await req('GET', '/api/stocks?asOf=2026-06', { cookie: c1 })).json;
    ok('stoc preluat: P1 10 buc la CMP 12.50', iiStoc.some((s) => s.product.cod === 'P1' && s.stocQ === 10 && s.cmp === 12.5));
    ok('stoc preluat: MP1 500 kg la CMP 3.50 (din Valoare)', iiStoc.some((s) => s.product.cod === 'MP1' && s.stocQ === 500 && s.cmp === 3.5));
    ok('verificare initiala: 301=1750 si 371=125, diferenta = tot (solduri initiale nesetate)',
      ii.json.totaluri.length === 2 && ii.json.totaluri[0].cont === '301' && ii.json.totaluri[0].stocInitial === 1750
      && ii.json.totaluri[1].cont === '371' && ii.json.totaluri[1].stocInitial === 125 && ii.json.totaluri[1].diferenta === 125);
    // re-importul inlocuieste pozitiile (idempotent), nu dubleaza stocul
    const ii2 = await req('POST', '/api/stocks/import-initial', { cookie: c1, body: { csv: initCsv, data: '2025-12-31' } });
    ok('re-import: tot 2 pozitii, 0 produse noi', ii2.json && ii2.json.importate === 2 && ii2.json.produseNoi === 0);
    ok('re-import: stocul NU se dubleaza', (await req('GET', '/api/stocks?asOf=2026-06', { cookie: c1 })).json.some((s) => s.product.cod === 'P1' && s.stocQ === 10));
    // miscarea de preluare nu se contabilizeaza (valoarea traieste in soldurile initiale)
    const iiMov = (await req('GET', '/api/stock-movements?period=2025-12', { cookie: c1 })).json.find((m) => m.initial && m.cod === 'P1');
    ok('miscarea de preluare e marcata initial', !!iiMov);
    eq('postarea notei pe miscarea de preluare -> 400', (await req('POST', '/api/stock-movements/' + iiMov.id + '/post', { cookie: c1 })).status, 400);
    // dupa setarea soldurilor initiale pe conturile de stoc, verificarea inchide diferentele la 0
    await req('POST', '/api/opening', { cookie: c1, body: { openingBalances: { '301': { d: 1750, c: 0 }, '371': { d: 125, c: 0 }, '1012': { d: 0, c: 1875 } } } });
    const chk = (await req('GET', '/api/stocks/initial-check', { cookie: c1 })).json;
    ok('verificare stoc initial vs solduri initiale: diferente 0', chk.totaluri.every((t) => t.diferenta === 0));

    // ── Productie / retete (BOM) ──
    eq('reteta fara nume -> 400', (await req('POST', '/api/recipes', { cookie: c1, body: { productId: 'x' } })).status, 400);
    const mkR = await req('POST', '/api/recipes', { cookie: c1, body: { nume: 'Reteta A', productId: 'pf', cantitateBaza: 10, costUnitar: 5, materiale: [{ productId: 'm1', cantitate: 20 }] } });
    ok('reteta creata', mkR.json && mkR.json.ok && mkR.json.recipe.id);
    const rid = mkR.json.recipe.id;
    ok('lista retete contine reteta', (await req('GET', '/api/recipes', { cookie: c1 })).json.some((t) => t.id === rid));
    ok('raport productie: forma corecta', Array.isArray((await req('GET', '/api/production-report?period=2026-06', { cookie: c1 })).json.rows || []));
    ok('reteta stearsa', (await req('DELETE', '/api/recipes/' + rid, { cookie: c1 })).json.ok === true);

    // ── Export CSV (text/csv cu antet) ──
    const csvJ = await req('GET', '/csv/journal?period=2026-06', { cookie: c1 });
    ok('csv/journal: 200 text/csv cu antet', csvJ.status === 200 && /Nr;Data;Document/.test(csvJ.text));
    const csvB = await req('GET', '/csv/balance?period=2026-06', { cookie: c1 });
    ok('csv/balance: 200 cu antet de balanta', csvB.status === 200 && /Cont;Denumire;SI Debit/.test(csvB.text));

    // ── Situatii & raportare (src/routes/reports.js) ──
    ok('situatii JSON: cont de profit si pierdere F20', typeof (await req('GET', '/api/statements/pl-f20?year=2026', { cookie: c1 })).json.cifraAfaceri === 'number');
    ok('situatii JSON: bilant F10 raspunde', !!(await req('GET', '/api/statements/bilant-f10?year=2026', { cookie: c1 })).json);
    for (const p of ['/pdf/situatii?year=2026', '/pdf/bilant?period=2026-12', '/pdf/pl?year=2026', '/pdf/cashflow?year=2026', '/pdf/capital?year=2026', '/pdf/note?year=2026']) {
      eq('PDF raportare ' + p + ' -> 200', (await req('GET', p, { cookie: c1 })).status, 200);
    }

    // ── Fum pe generatoarele PDF (src/pdf/*): raspuns 200 cu continut PDF real (magic %PDF) ──
    // Acopera cate un reprezentant din fiecare modul tematic al directorului src/pdf/.
    for (const p of ['/pdf/journal?period=2026-06', '/pdf/ledger?period=2026-06', '/pdf/balance?period=2026-06',
      '/pdf/cashbook?period=2026-06', '/pdf/fisa-cont?cont=4111&year=2026', '/pdf/analytic', '/pdf/aging',
      '/pdf/registru-inventar?year=2026', '/pdf/registru-fiscal?year=2026', '/pdf/obligatii?year=2026',
      '/pdf/assets?asOf=2026-12', '/pdf/doc-register']) {
      const r = await req('GET', p, { cookie: c1 });
      ok('PDF ' + p + ': 200 + magic %PDF', r.status === 200 && r.text.startsWith('%PDF'));
    }
    ok('csv/partners: 200', (await req('GET', '/csv/partners', { cookie: c1 })).status === 200);

    // ── XML declaratii: generare + marcarea "generata" in registru + validare ──
    const xd300 = await req('GET', '/xml/d300?period=2026-06', { cookie: c1 });
    ok('xml/d300: XML bine-format', xd300.status === 200 && /<declaratie300/.test(xd300.text));
    await req('GET', '/xml/d394?period=2026-06', { cookie: c1 }); // marcheaza d394 (neatins anterior)
    const regAfter = await req('GET', '/api/declarations?period=2026-06', { cookie: c1 });
    ok('descarcarea XML marcheaza declaratia "generata" in registru', regAfter.json.rows.find((r) => r.tip === 'd394').status === 'generata');
    const val = await req('GET', '/api/validate/d300?period=2026-06', { cookie: c1 });
    ok('validare pre-depunere: raspuns cu ok/errors', val.json && typeof val.json.ok === 'boolean' && Array.isArray(val.json.errors));

    // ── Reconciliere e-TVA: decontul precompletat (aici = propriul D300) <-> pozitia proprie ──
    await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_marfuri', fields: { data: '2026-06-15', partener: 'Client eTVA', cuiPartener: 'RO123', document: 'ETVA-1', baza: 1000, tva: 210, cota: 21 } } });
    const ownD300 = await req('GET', '/xml/d300?period=2026-06', { cookie: c1 });
    const etvaSelf = await req('POST', '/api/etva-precompletat?period=2026-06', { cookie: c1, body: { xml: ownD300.text } });
    ok('etva-precompletat: propriul decont vs sine -> 0 diferente, ok', etvaSelf.json && etvaSelf.json.diffCount === 0 && etvaSelf.json.ok === true);
    ok('etva-precompletat: tabel de randuri cu R17 (total colectata)', Array.isArray(etvaSelf.json.rows) && etvaSelf.json.rows.some((r) => r.rand === 'R17' && r.tva));
    const etvaTamp = ownD300.text.replace(/R9_2="(\d+)"/, (m, n) => 'R9_2="' + (Number(n) + 500) + '"');
    const etvaDiff = await req('POST', '/api/etva-precompletat?period=2026-06', { cookie: c1, body: { xml: etvaTamp } });
    ok('etva-precompletat: decont modificat -> diferente semnalate, not ok', etvaDiff.json && etvaDiff.json.diffCount >= 1 && etvaDiff.json.ok === false);
    eq('etva-precompletat: XML care nu e D300 -> 400', (await req('POST', '/api/etva-precompletat', { cookie: c1, body: { xml: '<nu/>' } })).status, 400);

    // ── D100 XML + Intrastat XML + achizitii produse agricole pe carnet (D394) ──
    const agrE = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'achizitie_produse_agricole', fields: { data: '2026-06-20', partener: 'Ion Taranu', cuiPartener: '1800101223344', document: 'Fila 12', suma: 1000, cont: '371' } } });
    ok('achizitie produse agricole pe carnet: 371=462, fara TVA', agrE.json && agrE.json.ok && agrE.json.entry.lines.some((l) => l.debit === '371' && l.credit === '462') && !agrE.json.entry.lines.some((l) => l.debit === '4426'));
    const x394pf = await req('GET', '/xml/d394?period=2026-06', { cookie: c1 });
    ok('D394 v5: fila carnet ca op1 tip N cu CNP-ul producatorului', /<op1 tip="N"/.test(x394pf.text) && /1800101223344/.test(x394pf.text));
    const x100 = await req('GET', '/xml/d100?period=2026-06', { cookie: c1 });
    ok('xml/d100: bine-format cu obligatia 620', x100.status === 200 && /<declaratie100/.test(x100.text) && /cod_oblig="620"/.test(x100.text));
    ok('descarcarea D100 XML marcheaza declaratia "generata"', (await req('GET', '/api/declarations?period=2026-06', { cookie: c1 })).json.rows.find((r) => r.tip === 'd100').status === 'generata');
    const xInt = await req('GET', '/xml/intrastat?period=2026-06', { cookie: c1 });
    ok('xml/intrastat: bine-format', xInt.status === 200 && /<declaratieIntrastat/.test(xInt.text));
    eq('validare d100 raspunde pe tipul cerut', (await req('GET', '/api/validate/d100?period=2026-06', { cookie: c1 })).json.type, 'd100');
    ok('validare d100: avertismentele de eligibilitate micro sunt incluse',
      (await req('GET', '/api/validate/d100?period=2026-06', { cookie: c1 })).json.warnings.some((w) => /salariat|plafon/i.test(w)));
    eq('validare intrastat raspunde pe tipul cerut', (await req('GET', '/api/validate/intrastat?period=2026-06', { cookie: c1 })).json.type, 'intrastat');

    // ── Chitanta tiparibila (serie CH) + logo firma ──
    const incE = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'incasare_client', fields: { data: '2026-06-21', partener: 'Client Cash', suma: 350.75, cont: '5311' } } });
    ok('incasare in numerar inregistrata (5311=4111)', incE.json && incE.json.ok);
    const chit = await req('GET', '/pdf/chitanta/' + incE.json.entry.id, { cookie: c1 });
    eq('chitanta PDF generata', chit.status, 200);
    ok('seria CH exista in seriile de documente', !!(await req('GET', '/api/doc-series', { cookie: c1 })).json.CH);
    const incB = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'incasare_client', fields: { data: '2026-06-21', partener: 'Client Banca', suma: 100, cont: '5121' } } });
    eq('chitanta pe incasare prin banca -> 400', (await req('GET', '/pdf/chitanta/' + incB.json.entry.id, { cookie: c1 })).status, 400);
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fdLogo = new FormData();
    fdLogo.append('file', new Blob([png1x1], { type: 'image/png' }), 'logo.png');
    ok('logo PNG incarcat', (await req('POST', '/api/company/logo', { cookie: c1, body: fdLogo })).json.ok === true);
    eq('logo servit', (await req('GET', '/api/company/logo', { cookie: c1 })).status, 200);
    const fdLogoBad = new FormData();
    fdLogoBad.append('file', new Blob(['nu-e-imagine'], { type: 'text/plain' }), 'logo.png');
    eq('fisier care nu e PNG/JPEG -> 400', (await req('POST', '/api/company/logo', { cookie: c1, body: fdLogoBad })).status, 400);
    ok('logo sters', (await req('DELETE', '/api/company/logo', { cookie: c1 })).json.ok === true);

    // ── Modele de factura: clasic / compact (A5) / detaliat ──
    const fvE = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_servicii', fields: { data: '2026-06-22', partener: 'Client Layout', cuiPartener: 'RO55', document: 'FL-1', baza: 1000, tva: 210, cota: 21 } } });
    ok('factura de vanzare pentru modele inregistrata', fvE.json && fvE.json.ok);
    eq('model clasic (implicit)', (await req('GET', '/pdf/factura/' + fvE.json.entry.id, { cookie: c1 })).status, 200);
    eq('model compact per tiparire (?layout=compact)', (await req('GET', '/pdf/factura/' + fvE.json.entry.id + '?layout=compact', { cookie: c1 })).status, 200);
    ok('setarea firmei pdfLayout=detaliat salvata', (await req('POST', '/api/company', { cookie: c1, body: { pdfLayout: 'detaliat' } })).json.ok === true);
    eq('model detaliat din setarea firmei', (await req('GET', '/pdf/factura/' + fvE.json.entry.id, { cookie: c1 })).status, 200);
    await req('POST', '/api/company', { cookie: c1, body: { pdfLayout: 'clasic' } });
    // ── /api/company: allowlist de profil — un utilizator al firmei NU poate injecta
    // campuri sensibile (abonament, credentiale ANAF, blocarea perioadei) prin ruta de profil
    const numeInit = (await req('GET', '/api/meta', { cookie: c1 })).json.company.nume;
    await req('POST', '/api/company', { cookie: c1, body: { subscription: { plan: 'gratis-forjat' }, anaf: { clientSecret: 'furat' }, lockedUntil: '2030-01', nume: 'Profil Nou SRL' } });
    const mDupa = (await req('GET', '/api/meta', { cookie: c1 })).json.company;
    ok('numele (profil) s-a actualizat', mDupa.nume === 'Profil Nou SRL');
    ok('abonamentul NU s-a injectat prin profil', !mDupa.subscription || mDupa.subscription.plan !== 'gratis-forjat');
    ok('credentialele ANAF NU s-au injectat prin profil', !mDupa.anaf || mDupa.anaf.clientSecret !== 'furat');
    ok('lockedUntil NU s-a setat prin profil', mDupa.lockedUntil !== '2030-01');
    await req('POST', '/api/company', { cookie: c1, body: { nume: numeInit } }); // restaureaza

    // ── Import extras bancar: legatura de decontare persistata (punctaj) + validare id-uri ──
    {
      const invR = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_servicii', fields: { data: '2026-06-24', partener: 'Client Punctaj SRL', cuiPartener: 'RO7788', document: 'PJ-1', baza: 1000, tva: 210, cota: 21 } } });
      const invId = invR.json.entry && invR.json.entry.id;
      ok('factura de decontat inregistrata', invR.json.ok && invId);
      // import incasare legata de factura (stinge) + un id STRAIN care trebuie filtrat la persistare
      const imp = await req('POST', '/api/bank/import', { cookie: c1, body: { transactions: [
        { tip: 'incasare_client', fields: { data: '2026-06-25', partener: 'Client Punctaj SRL', cuiPartener: 'RO7788', suma: 1210, cont: '5121' }, stinge: [invId, 'e-strain-9999'] },
      ] } });
      eq('import bancar cu legatura -> 1 articol creat', imp.json.created, 1);
      const plataEntry = (await req('GET', '/api/entries?firma=1', { cookie: c1 })).json.find((e) => e.tip === 'incasare_client' && e.partener === 'Client Punctaj SRL');
      ok('incasarea importata pastreaza legatura DOAR catre factura reala (id strain filtrat)',
        plataEntry && Array.isArray(plataEntry.stinge) && plataEntry.stinge.length === 1 && plataEntry.stinge[0] === invId);
      // reconcilierea onoreaza legatura: partenerul e stins complet, cu pereche marcata "legata"
      const rec = (await req('GET', '/api/reconcile', { cookie: c1 })).json;
      const pj = rec.partners.find((p) => p.den === 'Client Punctaj SRL' && p.cont === '4111');
      ok('reconciliere: partenerul punctat e stins (fara facturi deschise)', pj && pj.deschise.length === 0);
      ok('reconciliere: perechea e marcata ca legata (punctaj autoritar)', pj && pj.perechi.some((pr) => pr.tip === 'legata' && pr.facturi.some((f) => f.id === invId)));
    }

    // ── Punctaj MANUAL (POST /api/reconcile/link): leaga/dezleaga in fisa reconcilierii ──
    {
      const inv = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_servicii', fields: { data: '2026-06-26', partener: 'Client Manual SRL', cuiPartener: 'RO9001', document: 'MAN-1', baza: 1000, tva: 210, cota: 21 } } });
      const invId = inv.json.entry.id;
      // plata NElegata la creare (import fara stinge) — la reconciliere ar cadea pe euristica
      await req('POST', '/api/bank/import', { cookie: c1, body: { transactions: [{ tip: 'incasare_client', fields: { data: '2026-06-27', partener: 'Client Manual SRL', cuiPartener: 'RO9001', suma: 1210, cont: '5121' } }] } });
      const payId = (await req('GET', '/api/entries?firma=1', { cookie: c1 })).json.find((e) => e.tip === 'incasare_client' && e.partener === 'Client Manual SRL').id;
      eq('link: plata inexistenta -> 404', (await req('POST', '/api/reconcile/link', { cookie: c1, body: { paymentId: 'e-nu-exista', invoiceIds: [invId] } })).status, 404);
      // legare manuala, cu un id STRAIN care trebuie filtrat
      const lk = await req('POST', '/api/reconcile/link', { cookie: c1, body: { paymentId: payId, invoiceIds: [invId, 'strain-123'] } });
      ok('link: legare reusita, doar id-ul real pastrat', lk.json.ok && lk.json.stinge.length === 1 && lk.json.stinge[0] === invId);
      const pmL = (await req('GET', '/api/reconcile', { cookie: c1 })).json.partners.find((p) => p.den === 'Client Manual SRL' && p.cont === '4111');
      ok('link: legatura manuala onorata ca `legata` (bate euristica)', pmL && pmL.perechi.some((pr) => pr.tip === 'legata' && pr.facturi.some((f) => f.id === invId)));
      // dezlegare (lista goala) -> revine pe euristica (aici exacta, aceeasi suma)
      const ul = await req('POST', '/api/reconcile/link', { cookie: c1, body: { paymentId: payId, invoiceIds: [] } });
      ok('unlink: dezlegare reusita (stinge gol)', ul.json.ok && ul.json.stinge.length === 0);
      const pmU = (await req('GET', '/api/reconcile', { cookie: c1 })).json.partners.find((p) => p.den === 'Client Manual SRL' && p.cont === '4111');
      ok('unlink: fara legatura, nu mai e `legata` (revine pe euristica)', pmU && !pmU.perechi.some((pr) => pr.tip === 'legata'));
    }

    // ── Import CAMT.053 prin upload (/api/bank/parse): XML multipart -> tranzactii parsate ──
    {
      const camtXml = '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>'
        + '<Ntry><Amt Ccy="RON">2380.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-06-28</Dt></BookgDt>'
        + '<NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Client CAMT SRL</Nm></Dbtr></RltdPties><RmtInf><Ustrd>Incasare CAMT</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>'
        + '</Stmt></BkToCstmrStmt></Document>';
      const fdC = new FormData();
      fdC.append('file', new Blob([camtXml], { type: 'application/xml' }), 'extras.camt.xml');
      const rc = await req('POST', '/api/bank/parse', { cookie: c1, body: fdC });
      eq('CAMT upload: parsare reusita (200)', rc.status, 200);
      eq('CAMT upload: 1 tranzactie citita', rc.json.count, 1);
      ok('CAMT upload: data/sens/suma corecte', rc.json.transactions[0].data === '2026-06-28' && rc.json.transactions[0].sens === 'in' && rc.json.transactions[0].suma === 2380);
    }

    // ── TVA trimestrial: vizualizarea urmeaza perioada TVA (agrega trimestrul) ──
    await req('POST', '/api/company', { cookie: c1, body: { perioadaTva: 'T' } });
    const vjT = await req('GET', '/api/vat-journals?period=2026-06', { cookie: c1 });
    ok('vat-journals la regim T: perioada efectiva = trimestrul', vjT.json.period === '2026-Q2' && vjT.json.trimestrial === true);
    await req('POST', '/api/company', { cookie: c1, body: { perioadaTva: 'L' } });
    const vjL = await req('GET', '/api/vat-journals?period=2026-06', { cookie: c1 });
    ok('vat-journals la regim L: perioada efectiva = luna', vjL.json.period === '2026-06' && !vjL.json.trimestrial);
    // reconciliere TVA (pregatire e-TVA): pozitia perioadei + constatari (detectarea per-regula e
    // acoperita in test/run.js cu date controlate; aici verificam contractul rutei end-to-end)
    const rec = await req('GET', '/api/tva-reconciliere?period=2026-06', { cookie: c1 });
    ok('tva-reconciliere: structura coerenta (pozitie + findings + coteAnormale + netrimise)', rec.status === 200
      && typeof rec.json.colectata === 'number' && typeof rec.json.deductibila === 'number' && Array.isArray(rec.json.findings)
      && Array.isArray(rec.json.coteAnormale) && Array.isArray(rec.json.netrimise) && typeof rec.json.ok === 'boolean');

    // ── DOSAR ANUAL: arhiva imutabila (ZIP) + manifest cu amprente SHA-256 ──
    eq('dosar-anual: fara sesiune -> 401 (sub garda de auth /api)', (await req('GET', '/api/dosar-anual?year=2026')).status, 401);
    { // fetch binar direct (req() decodeaza text si ar corupe zip-ul)
      const AdmZip = require('adm-zip');
      const rz = await fetch(BASE + '/api/dosar-anual?year=2026', { headers: { Cookie: c1 } });
      ok('dosar-anual: 200 + application/zip + attachment', rz.status === 200
        && /application\/zip/.test(rz.headers.get('content-type') || '') && /attachment/.test(rz.headers.get('content-disposition') || ''));
      const buf = Buffer.from(await rz.arrayBuffer());
      const zip = new AdmZip(buf);
      const man = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
      ok('dosar-anual: manifest cu firma/an/fisiere + registre si situatii', man.an === '2026' && Array.isArray(man.fisiere) && man.fisiere.length >= 5
        && man.fisiere.some((f) => f.cale === 'registre/registru-jurnal.pdf') && man.fisiere.some((f) => /situatii\/bilant\.pdf/.test(f.cale)));
      // integritate: recalculeaza amprentele fisierelor si verifica hashDosar (tamper-evidence)
      const rec2 = zip.getEntries().filter((e) => e.entryName !== 'manifest.json' && e.entryName !== 'README.txt')
        .map((e) => e.entryName + ':' + crypto.createHash('sha256').update(e.getData()).digest('hex')).sort();
      const h = crypto.createHash('sha256').update(Buffer.from(rec2.join('\n'), 'utf8')).digest('hex');
      ok('dosar-anual: hashDosar verificabil = amprenta combinata a fisierelor', h === man.hashDosar);
      // fiecare amprenta de fisier din manifest se potriveste cu continutul real
      ok('dosar-anual: amprenta fiecarui fisier corecta', man.fisiere.every((f) => {
        const e = zip.getEntry(f.cale); return e && crypto.createHash('sha256').update(e.getData()).digest('hex') === f.sha256;
      }));
      // an garbage: sanitizat global la gol -> cade pe anul curent, nu strica ruta (200)
      const rgar = await fetch(BASE + '/api/dosar-anual?year=abcd', { headers: { Cookie: c1 } });
      ok('dosar-anual: an garbage sanitizat -> tot 200 (anul curent)', rgar.status === 200);
    }

    // ── MOTOR DE PROFIL FISCAL: sursa unica pentru declaratii/alerte/controale ──
    {
      const fp0 = await req('GET', '/api/fiscal-profile', { cookie: c1 });
      ok('fiscal-profile: profil coerent pentru firma platitoare de TVA', fp0.status === 200 && fp0.json.tvaPlatitor === true && fp0.json.perioadaTva === 'L' && fp0.json.d406 === 'L');
      // setarea campurilor de profil prin /api/company (allowlist) se reflecta in profil
      await req('POST', '/api/company', { cookie: c1, body: { regimImpozit: 'profit', d406Cadenta: 'T', intrastatObligat: true, scutiri: { d394: true } } });
      const fp1 = (await req('GET', '/api/fiscal-profile', { cookie: c1 })).json;
      ok('fiscal-profile: regim profit + D406 trimestrial reflectate', fp1.regim === 'profit' && fp1.profit === true && fp1.d406 === 'T' && fp1.intrastat === true);
      // controlul e derivat din profil: scutirea suprima D394 din declaratiile asteptate
      // (perioada 2026-09 = sfarsit de T3, fara inregistrari manuale care sa reapara in registru)
      const dreg = (await req('GET', '/api/declarations?period=2026-09', { cookie: c1 })).json;
      const tips09 = (dreg.rows || []).map((x) => x.tip);
      ok('declaratii conduse de profil: D394 scutit nu apare', tips09.length > 0 && !tips09.includes('d394'));
      ok('declaratii conduse de profil: D406 la regim trimestrial e prezent la sfarsit de T3', tips09.includes('saft'));
      // micro/profit -> D100/D101: firma pe profit vede in decembrie DOAR D101. Art. 41 alin. (1)
      // cere D100 la trimestrele I-III; trimestrul IV se definitiveaza prin declaratia anuala.
      // Aserțiunea cerea si D100 aici, adica acelasi impozit declarat de doua ori.
      const dregDec = (await req('GET', '/api/declarations?period=2026-12', { cookie: c1 })).json;
      const tipsDec = (dregDec.rows || []).map((x) => x.tip);
      ok('profil profit: in decembrie D101, fara D100 (T4 se definitiveaza anual)', tipsDec.includes('d101') && !tipsDec.includes('d100'));
      const dregT3 = (await req('GET', '/api/declarations?period=2026-09', { cookie: c1 })).json;
      ok('profil profit: D100 la trimestrul III', (dregT3.rows || []).map((x) => x.tip).includes('d100'));
      // calculul D101 (figuri semantice) disponibil via /api/d101
      const d101c = await req('GET', '/api/d101?year=2026', { cookie: c1 });
      ok('/api/d101: calcul coerent (rezultat brut + impozit + scadenta)', d101c.status === 200 && typeof d101c.json.rezultatBrut === 'number' && typeof d101c.json.impozit === 'number' && d101c.json.scadenta === '2027-03-25');
      // XML-ul D101 (schema oficiala v10) — disponibil doar in regim de profit. Generez pe 2025 ca
      // recordDecl (care marcheaza declaratia in registru) sa nu polueze verificarea micro pe 2026-12.
      const xd101 = await req('GET', '/xml/d101?year=2025', { cookie: c1 });
      ok('xml/d101: XML v10 bine-format (regim profit)', xd101.status === 200 && /<declaratie101/.test(xd101.text) && /xmlns="mfp:anaf:dgti:d101:declaratie:v10"/.test(xd101.text) && /cod_obligatie="103"/.test(xd101.text));
      // pre-validarea interna accepta d101 (nu inregistreaza nimic)
      const vd101 = await req('GET', '/api/validate/d101?year=2025', { cookie: c1 });
      ok('/api/validate/d101: bine-format, fara erori', vd101.status === 200 && vd101.json.ok === true);
      // restaurez profilul firmei pentru restul suitei
      await req('POST', '/api/company', { cookie: c1, body: { regimImpozit: 'micro', d406Cadenta: '', intrastatObligat: false, scutiri: {} } });
      const fp2 = (await req('GET', '/api/fiscal-profile', { cookie: c1 })).json;
      ok('fiscal-profile: revenit la micro + D406 lunar (derivat)', fp2.regim === 'micro' && fp2.d406 === 'L' && fp2.intrastat === false);
      // micro: in decembrie NU apare D101
      const dregDecMicro = (await req('GET', '/api/declarations?period=2026-12', { cookie: c1 })).json;
      ok('profil micro: D101 nu apare in decembrie', !(dregDecMicro.rows || []).map((x) => x.tip).includes('d101'));
      // guard de generare: firma pe micro nu depune D101 -> 400
      eq('guard: /xml/d101 la regim micro -> 400', (await req('GET', '/xml/d101?year=2026', { cookie: c1 })).status, 400);

      // ── Situatii financiare anuale (bilant) ──
      // Nomenclatoarele vin de la server (sursa unica: valorile extrase din validatorul ANAF).
      const nomB = await req('GET', '/api/bilant-nomenclator', { cookie: c1 });
      ok('/api/bilant-nomenclator: 42 de judete, 27 forme, 5 calitati',
        nomB.status === 200 && nomB.json.judete.length === 42
        && nomB.json.formeProprietate.length === 27 && nomB.json.calitati.length === 5);
      ok('nomenclatorul pastreaza codurile istorice (Calarasi 51)',
        nomB.json.judete.some((j) => j.cod === '51' && j.iso === 'RO-CL'));

      // Fara datele de antet, generarea e REFUZATA si spune ce lipseste (nu produce un formular inventat)
      const bLipsa = await req('GET', '/xml/bilant?year=2025', { cookie: c1 });
      ok('xml/bilant fara antet -> 400 cu lista campurilor lipsa',
        bLipsa.status === 400 && /forma de propriet/i.test(bLipsa.text) && /administrator/i.test(bLipsa.text));

      // Campurile de antet se salveaza prin /api/company (sunt in allowlist-ul de firma)
      const savedB = await req('POST', '/api/company', { cookie: c1, body: {
        judet: 'RO-B', adresa: 'Str. Exemplu nr. 1', caen: '1071',
        formaProprietate: '35', administrator: 'Popescu Ion', telefon: '0211234567',
        intocmitNume: 'Ionescu Maria', intocmitCalitate: '21', intocmitNr: '12345', auditStatut: '3',
      } });
      ok('/api/company accepta campurile de antet ale bilantului',
        savedB.status === 200 && savedB.json.company.formaProprietate === '35'
        && savedB.json.company.administrator === 'Popescu Ion');

      const xb = await req('GET', '/xml/bilant?year=2025&categorie=micro', { cookie: c1 });
      ok('xml/bilant (micro): S1120 bine-format, cu F10 si F20',
        xb.status === 200 && /<Bilant1120 /.test(xb.text)
        && /xmlns="mfp:anaf:dgti:s1120:declaratie:v3"/.test(xb.text)
        && /<F10 /.test(xb.text) && /<F20 /.test(xb.text));
      ok('xml/bilant: sume in lei INTREGI (validatorul respinge zecimalele)',
        !/F10_\d{4}="-?\d+\.\d/.test(xb.text));
      ok('xml/bilant: niciun atribut gol (validatorul le respinge)', !/="\s*"/.test(xb.text));
      const xb1121 = await req('GET', '/xml/bilant?year=2025&categorie=mic', { cookie: c1 });
      ok('xml/bilant (mic): S1121 cu F20 complet (88 de randuri)',
        xb1121.status === 200 && /<Bilant1121 /.test(xb1121.text)
        && (xb1121.text.match(/F20_\d{4}="/g) || []).length === 176);
      // controale de coerenta derivate din profil (al treilea pilon)
      const ctrl = (await req('GET', '/api/fiscal-controls?year=2026', { cookie: c1 })).json;
      ok('fiscal-controls: structura coerenta (byLevel + ok + findings)', ctrl.byLevel && typeof ctrl.ok === 'boolean' && Array.isArray(ctrl.findings));
      // fortez un control determinist: platitor TVA fara CAEN -> atentie
      await req('POST', '/api/company', { cookie: c1, body: { caen: '' } });
      const ctrl2 = (await req('GET', '/api/fiscal-controls?year=2026', { cookie: c1 })).json;
      ok('fiscal-controls: platitor TVA fara CAEN semnalat (atentie)', ctrl2.findings.some((f) => f.cod === 'tva-fara-caen' && f.nivel === 'atentie'));
      await req('POST', '/api/company', { cookie: c1, body: { caen: '1071' } }); // restaurez CAEN
      // GUARD de scriere: neplatitor de TVA nu poate COLECTA TVA (vanzare cu TVA) -> 400
      await req('POST', '/api/company', { cookie: c1, body: { tvaPlatitor: false } });
      const gSale = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_servicii', fields: { data: '2026-10-05', partener: 'Guard X', cuiPartener: 'RO1', document: 'G-1', baza: 1000, tva: 210, cota: 21 } } });
      eq('guard: neplatitor TVA + vanzare cu TVA -> 400', gSale.status, 400);
      // document fara TVA permis (ciorna, ca sa nu polueze balanta si sa fie stergibila)
      const gNota = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'nota_contabila', ciorna: true, fields: { data: '2026-10-05', explicatie: 'Guard fara TVA', debit: '5311', credit: '707', suma: 500 } } });
      ok('guard: neplatitor TVA + document fara TVA -> permis', gNota.status === 200 && gNota.json.ok);
      if (gNota.json.entry) await req('DELETE', '/api/entries/' + gNota.json.entry.id, { cookie: c1 }); // ciorna -> stergibila
      // guard de generare: neplatitor nu depune D300/D394
      eq('guard: /xml/d300 la neplatitor TVA -> 400', (await req('GET', '/xml/d300?period=2026-06', { cookie: c1 })).status, 400);
      eq('guard: /xml/d394 la neplatitor TVA -> 400', (await req('GET', '/xml/d394?period=2026-06', { cookie: c1 })).status, 400);
      eq('guard: /pdf/d300 la neplatitor TVA -> 400', (await req('GET', '/pdf/d300?period=2026-06', { cookie: c1 })).status, 400);
      await req('POST', '/api/company', { cookie: c1, body: { tvaPlatitor: true } }); // restaurez regimul TVA
      // dupa restaurare, D300 se genereaza din nou
      eq('dupa restaurare platitor: /xml/d300 -> 200', (await req('GET', '/xml/d300?period=2026-06', { cookie: c1 })).status, 200);
    }

    // ── Pro-rata TVA (art. 300): split automat al TVA-ului pe achizitiile mixte ──
    ok('pro-rata provizorie setata pe firma (40%)', (await req('POST', '/api/company', { cookie: c1, body: { proRataTva: 40 } })).json.ok === true);
    const prE = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_utilitati', fields: { data: '2026-06-23', partener: 'EnergoMix', cuiPartener: 'RO88', document: 'U-77', baza: 1000, tva: 210, cota: 21, proRataMixt: true } } });
    ok('achizitie mixta: TVA dedusa 40% (84), restul in cost (605 = 1126)',
      prE.json && prE.json.entry.lines.some((l) => l.debit === '4426' && l.suma === 84)
      && prE.json.entry.lines.some((l) => l.debit === '605' && l.suma === 1126));
    const prH = (await req('GET', '/api/pro-rata?year=2026', { cookie: c1 })).json;
    ok('raport pro-rata: achizitia mixta numarata si regularizarea calculata', prH.nrMixte >= 1 && prH.dedusaProvizoriu >= 84 && typeof prH.definitiva === 'number');
    // TVA-ul nededus a intrat in linia de cost, deci baza si cota facturii nu se mai pot citi din
    // linii. composeEntry le memoreaza pe articol; fara ele, raportul TVA-dedus/baza-din-linii da
    // o cota inexistenta si achizitia dispare TACIT din D300.
    ok('pro-rata: factura reala memorata pe articol (baza 1000, cota 21, TVA 210, dedus 84)',
      prE.json && prE.json.entry.tvaPartial
      && prE.json.entry.tvaPartial.baza === 1000 && prE.json.entry.tvaPartial.cota === 21
      && prE.json.entry.tvaPartial.tvaFactura === 210 && prE.json.entry.tvaPartial.tvaDedusa === 84);
    await req('POST', '/api/company', { cookie: c1, body: { proRataTva: '' } });

    // ── Cod de bun art. 331 (op11 din D394): validat la INTRODUCERE, nu la depunere ──
    // Un cod gresit ar trece pana la validatorul ANAF si ar respinge toata declaratia.
    const ti331 = (cod) => ({ tip: 'taxare_inversa_interna_achizitie', fields: Object.assign(
      { data: '2026-06-11', partener: 'Cereale SRL', cuiPartener: 'RO45678918', document: 'TI-331', baza: 5000, cota: 21 },
      cod == null ? {} : { codCategorie331: cod }) });
    const cod99 = await req('POST', '/api/entries', { cookie: c1, body: ti331(99) });
    ok('cod art. 331 inexistent in nomenclator -> refuzat, cu lista codurilor valide',
      cod99.status >= 400 && /22, 23/.test(cod99.json.error || ''));
    const cod35 = await req('POST', '/api/entries', { cookie: c1, body: ti331(35) });
    ok('cod art. 331 rezervat persoanelor fizice (35) -> refuzat si el', cod35.status >= 400);
    const cod22 = await req('POST', '/api/entries', { cookie: c1, body: ti331(22) });
    ok('cod art. 331 valid (22) -> acceptat si memorat pe articol',
      cod22.json && cod22.json.ok && cod22.json.entry.codCategorie331 === 22);
    // fara cod articolul se salveaza (se poate completa mai tarziu), dar D394 nu e depozabil
    const fara = await req('POST', '/api/entries', { cookie: c1, body: ti331(null) });
    ok('fara cod: articolul se salveaza, fara camp inventat',
      fara.json && fara.json.ok && !fara.json.entry.codCategorie331);
    const vD394 = (await req('GET', '/api/validate/d394?period=2026-06', { cookie: c1 })).json;
    ok('validarea pre-depunere D394 semnaleaza articolul fara cod de bun',
      vD394.ok === false && vD394.errors.some((e) => /TI-331/.test(e)));

    // ── Diferentierea PFA vs SRL ──
    ok('firma trecuta pe PFA', (await req('POST', '/api/company', { cookie: c1, body: { tipEntitate: 'pfa' } })).json.ok === true);
    const metaPfa = (await req('GET', '/api/meta', { cookie: c1 })).json;
    ok('PFA: dividendele dispar din tipurile de documente', !metaPfa.types.some((t) => t.id === 'repartizare_dividende'));
    ok('PFA: apar retragerea si aportul intreprinzatorului', metaPfa.types.some((t) => t.id === 'retragere_intreprinzator') && metaPfa.types.some((t) => t.id === 'aport_intreprinzator'));
    // 2026-06 pastreaza d100 deja inregistrat (istoric) — verificarea se face pe o luna fara istoric
    const declPfa = (await req('GET', '/api/declarations?period=2026-09', { cookie: c1 })).json.rows.map((r) => r.tip);
    ok('PFA: calendarul unei luni de trimestru fara istoric nu contine d100/saft', !declPfa.includes('d100') && !declPfa.includes('saft'));
    const retr = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'retragere_intreprinzator', fields: { data: '2026-06-25', suma: 500, cont: '5311' } } });
    ok('retragere intreprinzator: 455 = 5311', retr.json && retr.json.ok && retr.json.entry.lines.some((l) => l.debit === '455' && l.credit === '5311'));
    const duH = (await req('GET', '/api/declaratia-unica?year=2026', { cookie: c1 })).json;
    ok('Declaratia Unica: venit net si total taxe numerice', typeof duH.venitNet === 'number' && typeof duH.total === 'number' && duH.total >= 0);
    eq('Declaratia Unica PDF', (await req('GET', '/pdf/declaratia-unica?year=2026', { cookie: c1 })).status, 200);
    const livH = (await req('GET', '/api/livrabile?period=2026-06', { cookie: c1 })).json;
    ok('livrabile PFA: Declaratia Unica in lista, fara D100 micro',
      livH.list.some((x) => /Declarația Unică/.test(x.nume)) && !livH.list.some((x) => x.id === 12) && livH.sumar.du && typeof livH.sumar.du.total === 'number');
    ok('firma revenita pe SRL', (await req('POST', '/api/company', { cookie: c1, body: { tipEntitate: 'srl' } })).json.ok === true);
    ok('SRL: d100 revine in calendar', (await req('GET', '/api/declarations?period=2026-06', { cookie: c1 })).json.rows.some((r) => r.tip === 'd100'));

    // ── Rezumat executiv (mod simplu): agregatele noi pe dashboard ──
    const dashH = (await req('GET', '/api/dashboard', { cookie: c1 })).json;
    ok('dashboard: rezumatul executiv are agregatele numerice',
      typeof dashH.disponibilTotal === 'number' && typeof dashH.taxeDatorate === 'number' && typeof dashH.salariiDePlata === 'number');
    // Semnalul de trezorerie negativa ajunge pe ruta (forma, nu doar existenta): frontendul
    // interpoleaza `cont`/`nume`/`sold` in banda de alerte.
    ok('dashboard: semnalul conturilor de bani negative e expus pe ruta',
      Array.isArray(dashH.conturiBaniNegative)
      && dashH.conturiBaniNegative.every((x) => typeof x.cont === 'string' && typeof x.nume === 'string' && typeof x.sold === 'number'));
    // Primii pasi (onboarding): starea pasilor reflecta datele reale ale firmei
    ok('dashboard: primii pasi prezenti si bifati din date (document inregistrat)',
      dashH.primiiPasi && dashH.primiiPasi.documentInregistrat === true && typeof dashH.primiiPasi.nrInregistrari === 'number');
    ok('dashboard: pasii noi de onboarding (partener/produs) + starea wizardului',
      typeof dashH.primiiPasi.arePartener === 'boolean' && typeof dashH.primiiPasi.areProdus === 'boolean' && dashH.primiiPasi.wizardAscuns === false);
    ok('dashboard: ultimele operatiuni (max 5, cele mai noi primele, cu total)',
      Array.isArray(dashH.ultimeleOperatiuni) && dashH.ultimeleOperatiuni.length >= 1 && dashH.ultimeleOperatiuni.length <= 5
      && dashH.ultimeleOperatiuni.every((o) => o.data && o.tipNume && typeof o.suma === 'number')
      && dashH.ultimeleOperatiuni[0].data >= dashH.ultimeleOperatiuni[dashH.ultimeleOperatiuni.length - 1].data);
    ok('dashboard: stocurile valoroase (lista, posibil goala)', Array.isArray(dashH.stocuriValoroase));
    // „mai tarziu" persista PE CONT (nu in localStorage): dupa dismiss si o autentificare noua
    // (alta „sesiune de browser"), wizardul ramane ascuns
    ok('dismiss wizard: ok', (await req('POST', '/api/onboarding/dismiss', { cookie: c1 })).json.ok === true);
    ok('dupa dismiss: wizardAscuns=true', (await req('GET', '/api/dashboard', { cookie: c1 })).json.primiiPasi.wizardAscuns === true);
    const reLog = await req('POST', '/api/login', { body: { username: 'user1', password: 'parola1' } });
    ok('persistat intre sesiuni: ascuns si dupa o autentificare noua', (await req('GET', '/api/dashboard', { cookie: reLog.cookie })).json.primiiPasi.wizardAscuns === true);

    // ── Memo-ul dashboard-ului (src/cache.js): raspuns identic pe hit, invalidat de orice scriere ──
    {
      const dash = (ck) => fetch(BASE + '/api/dashboard', { headers: { Cookie: ck } });
      const r1 = await dash(c1); const j1 = await r1.json();
      const r2 = await dash(c1); const j2 = await r2.json();
      ok('dashboard: a doua cerere fara scriere e servita din memo', r2.headers.get('x-dashboard-cache') === 'hit');
      eq('dashboard: hit-ul intoarce EXACT acelasi continut', JSON.stringify(j2), JSON.stringify(j1));
      // wizardAscuns e PER UTILIZATOR: se suprapune dupa memo, deci hit-ul nu il poate imprumuta
      // de la alt cont. user1 l-a ascuns mai sus; adminul (alta firma activa, alt cont) nu.
      // (adminul e pe ACEEASI firma 1 — cazul tare: memo comun, camp per utilizator diferit)
      const laC = await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } });
      const jA = await (await dash(laC.cookie)).json();
      ok('dashboard: wizardAscuns ramane per utilizator, nu vine din memo', jA.primiiPasi.wizardAscuns === false && j2.primiiPasi.wizardAscuns === true);
      ok('dashboard: restul cifrelor sunt aceleasi pentru ambii (memo comun pe firma)', jA.venituri === j2.venituri && jA.soldClienti === j2.soldClienti);
      // izolarea pe firma: memo-ul e cheiat pe firmaId — firma 2 nu poate primi raspunsul firmei 1
      const j2f = await (await fetch(BASE + '/api/dashboard?firma=2', { headers: { Cookie: laC.cookie } })).json();
      ok('dashboard: alta firma primeste propriile cifre, nu pe ale firmei 1',
        j2f.primiiPasi.nrInregistrari !== j2.primiiPasi.nrInregistrari || j2f.venituri !== j2.venituri);
      // INVALIDARE: o scriere (articol nou) schimba cifrele, deci memo-ul nu are voie sa supravietuiasca
      const inainte = j2.primiiPasi.nrInregistrari;
      const nouM = await req('POST', '/api/entries', {
        cookie: c1,
        body: { tip: 'incasare_client', fields: { data: '2026-06-28', partener: 'Client Memo', suma: 111, cont: '5311' } },
      });
      eq('scriere de control acceptata', nouM.status, 200);
      const r3 = await dash(c1); const j3 = await r3.json();
      ok('dashboard: dupa scriere e recalculat (miss)', r3.headers.get('x-dashboard-cache') === 'miss');
      ok('dashboard: cifrele reflecta scrierea (nu raspuns invechit)', j3.primiiPasi.nrInregistrari === inainte + 1);
      ok('dashboard: reintra in memo dupa recalculare', (await dash(c1)).headers.get('x-dashboard-cache') === 'hit');
    }

    // ── Rapoarte dedicate: fisa de cont, situatie aprovizionari, situatie consumuri ──
    const fcH = await req('GET', '/api/fisa-cont?cont=4111&period=2026-06', { cookie: c1 });
    ok('fisa de cont 4111: raspuns cu miscari', fcH.json && fcH.json.cont === '4111' && Array.isArray(fcH.json.rows));
    eq('fisa de cont fara cont -> 400', (await req('GET', '/api/fisa-cont', { cookie: c1 })).status, 400);
    ok('situatie aprovizionari: forma corecta', Array.isArray((await req('GET', '/api/aprovizionari?period=2026-06', { cookie: c1 })).json.rows));
    ok('situatie consumuri: forma corecta', Array.isArray((await req('GET', '/api/consumuri?period=2026-06', { cookie: c1 })).json.rows));

    // ── Avantaje in natura la salarizare (cap-coada) ──
    const angAv = await req('POST', '/api/angajati', { cookie: c1, body: { nume: 'Avantaj Ion', salariuBrut: 5000, avantaje: 1000 } });
    const spAvH = (await req('GET', '/api/stat-plata?period=2026-06', { cookie: c1 })).json.rows.find((r) => r.nume === 'Avantaj Ion');
    ok('stat: CAS 25% pe brut+avantaje (1500) si avantajele pe rand', spAvH && spAvH.cas === 1500 && spAvH.avantaje === 1000);
    ok('D112 v7: baza CAS (A_13) include avantajele (6000)', /A_13="6000"/.test((await req('GET', '/xml/d112?period=2026-06', { cookie: c1 })).text));
    ok('angajat de test sters', (await req('DELETE', '/api/angajati/' + angAv.json.angajat.id, { cookie: c1 })).json.ok === true);

    // ── Concediu medical in stat: salariu redus + indemnizatii + postare 6458/4373 ──
    const angCm = await req('POST', '/api/angajati', { cookie: c1, body: { nume: 'CM Ion', salariuBrut: 4200, zileCM: 7, procentCM: 75, zileLucratoare: 21 } });
    const spCmH = (await req('GET', '/api/stat-plata?period=2026-08', { cookie: c1 })).json.rows.find((r) => r.nume === 'CM Ion');
    ok('stat cu CM: salariu redus 2800 + indemnizatii 750/300', spCmH && spCmH.brut === 2800 && spCmH.cmAngajator === 750 && spCmH.cmFnuass === 300);
    const postCm = await req('POST', '/api/stat-plata?period=2026-08', { cookie: c1 });
    ok('postare stat: 6458=421 (angajator) si 4373=421 (FNUASS de recuperat)',
      postCm.json.entry.lines.some((l) => l.debit === '6458' && l.credit === '421' && l.suma === 750)
      && postCm.json.entry.lines.some((l) => l.debit === '4373' && l.credit === '421' && l.suma === 300));
    // dosar de recuperare CM (FNUASS): angajatul cu CM + suma de recuperat
    const dosar = (await req('GET', '/api/dosar-cm?period=2026-08', { cookie: c1 })).json;
    ok('dosar CM: angajatul cu CM listat + total FNUASS de recuperat (300)', dosar.rows.some((r) => r.nume === 'CM Ion' && r.cmFnuass === 300) && dosar.totalFnuass === 300);
    eq('dosar CM PDF', (await req('GET', '/pdf/dosar-cm?period=2026-08', { cookie: c1 })).status, 200);
    ok('angajat CM sters', (await req('DELETE', '/api/angajati/' + angCm.json.angajat.id, { cookie: c1 })).json.ok === true);
    // F4109 — declaratie de neutilizare casa de marcat (PDF pentru o luna)
    eq('F4109 PDF cu seria data', (await req('GET', '/pdf/f4109?period=2026-08&serie=AMEF12345678', { cookie: c1 })).status, 200);
    eq('F4109 PDF fara serie (placeholder)', (await req('GET', '/pdf/f4109?period=2026-08', { cookie: c1 })).status, 200);

    // ── Norma partiala (OUG 16/2022): suprataxarea pe angajator, cap-coada ──
    const angNp = await req('POST', '/api/angajati', { cookie: c1, body: { nume: 'Partial Pop', salariuBrut: 2000, normaPartiala: true } });
    const spNpH = (await req('GET', '/api/stat-plata?period=2026-09', { cookie: c1 })).json.rows.find((r) => r.nume === 'Partial Pop');
    ok('stat: diferentele CAS/CASS pana la salariul minim, pe angajator', spNpH && spNpH.casAngajator > 0 && spNpH.cassAngajator > 0 && spNpH.net === 2000 - spNpH.cas - spNpH.cass - spNpH.impozit);
    const postNp = await req('POST', '/api/stat-plata?period=2026-09', { cookie: c1 });
    ok('postare: 6458=4315 si 6458=4316 cu diferentele angajatorului',
      postNp.json.entry.lines.some((l) => l.debit === '6458' && l.credit === '4315')
      && postNp.json.entry.lines.some((l) => l.debit === '6458' && l.credit === '4316'));
    ok('angajat norma partiala sters', (await req('DELETE', '/api/angajati/' + angNp.json.angajat.id, { cookie: c1 })).json.ok === true);

    // ── Solduri initiale: echilibrul debit=credit e impus la salvare ──
    eq('solduri initiale dezechilibrate -> 400', (await req('POST', '/api/opening', { cookie: c1, body: { openingBalances: { '5121': { d: 1000, c: 0 }, '1012': { d: 0, c: 800 } } } })).status, 400);
    ok('solduri initiale echilibrate -> ok', (await req('POST', '/api/opening', { cookie: c1, body: { openingBalances: { '5121': { d: 1000, c: 0 }, '1012': { d: 0, c: 1000 } } } })).json.ok === true);
    const og = await req('GET', '/api/opening', { cookie: c1 });
    ok('GET /api/opening: soldurile salvate (pentru editorul din Setari)', og.json && og.json['5121'] && og.json['5121'].d === 1000 && og.json['1012'].c === 1000);

    // ── Gestiunea lunilor: inchidere TVA lunara (validare + blocare + avans) ──
    await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_marfuri', fields: { data: '2025-09-10', partener: 'LunaTest', cuiPartener: 'RO7', document: 'FL9', baza: 1000, tva: 210, cota: 21 } } });
    eq('close-vat fara luna (an) respins -> 400', (await req('POST', '/api/close-vat?period=2025', { cookie: c1 })).status, 400);
    eq('close-vat cu perioada invalida respins -> 400', (await req('POST', '/api/close-vat?period=garbage', { cookie: c1 })).status, 400);
    const cv = await req('POST', '/api/close-vat?period=2025-09', { cookie: c1 });
    ok('close-vat pe luna valida: inchide TVA + blocheaza perioada', cv.json.ok && cv.json.lockedUntil === '2025-09');
    eq('inregistrare in luna inchisa (blocata) -> 400', (await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_marfuri', fields: { data: '2025-09-15', partener: 'X', baza: 100, tva: 21, cota: 21 } } })).status, 400);
    eq('inregistrare in luna urmatoare (nedublocata) merge', (await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_marfuri', fields: { data: '2025-10-05', partener: 'X', baza: 100, tva: 21, cota: 21 } } })).status, 200);
    ok('re-inchiderea aceleiasi luni e idempotenta (fara dublura)', (await req('POST', '/api/close-vat?period=2025-09', { cookie: c1 })).json.ok === true);
    const laMonth = await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } });
    await req('POST', '/api/period-lock', { cookie: laMonth.cookie, body: { lockedUntil: null } }); // deblochez pentru restul testelor

    // ── INCHIDEREA LUNARA ca flux unic (cockpit): pasi derivati, alocare, dovada, aprobare, blocare ──
    {
      const PER = '2025-11'; // luna proprie, ca sa nu depinda de restul suitei
      const mc = async (p) => (await req('GET', '/api/monthly-close?period=' + (p || PER), { cookie: c1 })).json;
      const pas = (st, k) => st.steps.find((s) => s.key === k);

      const st0 = await mc();
      eq('flux: pasii vin in ordinea ceruta', st0.steps.map((s) => s.key).join('>'), 'documente>banca>tva>declaratii>aprobare>blocare');
      ok('flux: fiecare pas are termen', st0.steps.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.due)));
      // primii patru pasi se rezolva pe alt ecran (au `tab`); aprobarea si blocarea, in cockpit
      ok('flux: pasii care se rezolva in alta parte trimit acolo',
        st0.steps.filter((s) => ['documente', 'banca', 'tva', 'declaratii'].includes(s.key)).every((s) => !!s.tab && !!s.eticheta)
        && st0.steps.filter((s) => ['aprobare', 'blocare'].includes(s.key)).every((s) => !s.tab));
      ok('flux: responsabilii posibili sunt conturile firmei', Array.isArray(st0.responsabili) && st0.responsabili.some((u) => u.username === 'user1'));
      eq('flux: perioada invalida -> 400', (await req('GET', '/api/monthly-close?period=2025', { cookie: c1 })).status, 400);

      // Alocare: responsabil (cont real) + termen + nota
      const asig = await req('POST', '/api/monthly-close/step', { cookie: c1, body: { period: PER, step: 'documente', responsabilId: 2, due: '2025-12-05', nota: 'Cer facturile de la furnizori' } });
      const pDoc = pas(asig.json, 'documente');
      ok('alocare: responsabil + termen + nota salvate', pDoc.responsabil === 'user1' && pDoc.due === '2025-12-05' && pDoc.dueImplicit === false && /facturile/.test(pDoc.nota));
      eq('alocare: responsabil fara acces la firma -> 400', (await req('POST', '/api/monthly-close/step', { cookie: c1, body: { period: PER, step: 'documente', responsabilId: 424242 } })).status, 400);
      eq('alocare: pas necunoscut -> 400', (await req('POST', '/api/monthly-close/step', { cookie: c1, body: { period: PER, step: 'inexistent' } })).status, 400);
      eq('alocare: termen malformat -> 400', (await req('POST', '/api/monthly-close/step', { cookie: c1, body: { period: PER, step: 'banca', due: '05-12-2025' } })).status, 400);
      // termenul se poate goli -> revine la cel implicit (derivat din termenul real de depunere)
      const golit = await req('POST', '/api/monthly-close/step', { cookie: c1, body: { period: PER, step: 'documente', due: '' } });
      ok('alocare: termen golit -> revine la implicit', pas(golit.json, 'documente').dueImplicit === true);

      // DOVADA VALIDARII: ruleaza generatorul real si pastreaza verdictul semnat
      const val = await req('POST', '/api/monthly-close/validate', { cookie: c1, body: { period: PER, tip: 'd300' } });
      ok('dovada: validarea ruleaza si intoarce verdict', val.status === 200 && typeof val.json.rezultat.ok === 'boolean');
      const dovada = (pas(val.json.state, 'declaratii').detalii.declaratii || []).find((x) => x.tip === 'd300');
      ok('dovada: ramane pe dosarul lunii, cu cine si cand', !!dovada && !!dovada.dovada && dovada.dovada.by === 2 && !!dovada.dovada.at);
      eq('dovada: tip de declaratie necunoscut -> 400', (await req('POST', '/api/monthly-close/validate', { cookie: c1, body: { period: PER, tip: 'dXYZ' } })).status, 400);

      // Aprobarea si inchiderea sunt REFUZATE cat timp exista pasi nerezolvati
      const stDesc = await mc();
      ok('flux: luna nu se poate inchide cu pasi deschisi', stDesc.sePoateInchide === false && stDesc.blocante.length > 0);
      const apr = await req('POST', '/api/monthly-close/approve', { cookie: c1, body: { period: PER } });
      ok('aprobare refuzata cu pasi deschisi (si spune care)', apr.status === 400 && /nerezolvați/i.test(apr.json.error));
      const inch = await req('POST', '/api/monthly-close/close', { cookie: c1, body: { period: PER } });
      ok('inchidere refuzata cu pasi deschisi', inch.status === 400 && /nu poate fi închisă/i.test(inch.json.error));

      // FORTAREA: doar admin, doar cu motiv scris
      const laF = await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } });
      // autorizarea se verifica INAINTEA continutului: un neadministrator primeste 403 chiar
      // si cu motiv bun, iar adminul primeste 400 doar pentru motivul insuficient.
      const f2 = await req('POST', '/api/monthly-close/close', { cookie: c1, body: { period: PER, force: true, motiv: 'Depuse manual pe portalul ANAF, recipisele sunt la dosar.' } });
      ok('fortare de un NEadministrator -> 403', f2.status === 403);
      const f1 = await req('POST', '/api/monthly-close/close', { cookie: laF.cookie, body: { period: PER, force: true, motiv: 'scurt' } });
      ok('fortare de admin, dar fara motiv suficient -> 400', f1.status === 400 && /motiv scris/i.test(f1.json.error));
      // pragul e exact 10 caractere (un „prea scurt" de fix 10 TRECE — verificat, ca sa nu
      // ramana o granita presupusa): sub prag se refuza, la prag se accepta.
      eq('fortare cu motiv de 9 caractere -> tot 400', (await req('POST', '/api/monthly-close/close', { cookie: laF.cookie, body: { period: PER, force: true, motiv: '123456789' } })).status, 400);
      const f3 = await req('POST', '/api/monthly-close/close', { cookie: laF.cookie, body: { period: PER, force: true, motiv: 'Depuse manual pe portalul ANAF, recipisele sunt la dosar.' } });
      ok('fortare de admin, cu motiv: reuseste si blocheaza perioada', f3.status === 200 && f3.json.fortata === true && f3.json.lockedUntil === PER);
      ok('motivul fortarii ramane pe dosarul lunii, cu pasii nerezolvati de atunci',
        /portalul ANAF/.test(f3.json.state.fortata.motiv) && f3.json.state.fortata.blocante.length > 0 && f3.json.state.fortata.username === 'admin');
      ok('dupa fortare luna e finalizata si read-only', f3.json.state.finalizata === true && f3.json.state.inchisa === true);
      eq('scrierea in luna inchisa e refuzata', (await req('POST', '/api/entries', { cookie: c1, body: { tip: 'nota_contabila', fields: { data: PER + '-10', explicatie: 'dupa inchidere', debit: '5311', credit: '5121', suma: 10 } } })).status, 400);
      eq('a doua inchidere a aceleiasi luni -> 400', (await req('POST', '/api/monthly-close/close', { cookie: laF.cookie, body: { period: PER } })).status, 400);
      // auditul consemneaza fortarea distinct de o inchidere normala
      ok('auditul consemneaza inchiderea FORTATA', (await req('GET', '/api/audit', { cookie: laF.cookie })).json.some((a) => a.action === 'inchidere.fortata' && /portalul ANAF/.test(a.detail || '')));
      await req('POST', '/api/period-lock', { cookie: laF.cookie, body: { lockedUntil: null } }); // deblochez pentru restul suitei
    }

    // ── Inchideri: ordinea impozit-profit vs inchidere anuala e irelevanta ──
    // pregatim un an cu profit: o vanzare de servicii + inregistrarea ei
    const vz = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_servicii', fields: { data: '2025-03-10', partener: 'X', cuiPartener: 'RO9', document: 'FS1', baza: 10000, tva: 2100, cota: 21 } } });
    ok('vanzare 2025 inregistrata (venit 704)', vz.json && vz.json.ok);
    // 1) inchidere anuala INTAI (691 nu exista inca)
    await req('POST', '/api/close-year?year=2025', { cookie: c1 });
    // 2) apoi impozitul pe profit -> trebuie sa inchida si 691 in 121
    const pt = await req('POST', '/api/close-profit-tax?year=2025', { cookie: c1 });
    ok('impozit pe profit dupa inchidere: articol cu 691=4411 + 121=691', pt.json && pt.json.ok);
    // verificare: in balanta anului, 691 e ZERO (inchis) si 121 exista
    const tb = await (await fetch(BASE + '/api/balance?period=2025', { headers: { Cookie: c1 } })).json();
    const r691 = tb.rows.find((r) => r.cod === '691');
    ok('691 inchis complet dupa impozit (sold final 0)', !r691 || (r691.sfD === 0 && r691.sfC === 0));
    ok('balanta 2025 se inchide dupa ambele inchideri', tb.balanced === true);
    // pas 5 (citiri SQL pt firme mari): sub prag (seed mic) -> calea RAM implicita; header de diagnostic.
    // CI ruleaza suita si cu CONTAB_SQL_READ_THRESHOLD=0 -> calea SQL, cu ACELEASI aserttii de balanta.
    {
      const bs = await fetch(BASE + '/api/balance?period=2025', { headers: { Cookie: c1 } });
      const src = bs.headers.get('x-balance-source');
      // json n-are SQL -> mereu RAM; sqlite/pg cu pragul 0 -> SQL. Continutul e identic pe ambele cai.
      const sqlCapable = process.env.CONTAB_TEST_DRIVER !== 'json';
      const forced = process.env.CONTAB_SQL_READ_THRESHOLD === '0';
      ok('balanta: sursa reflecta pragul + capabilitatea driverului', src === (forced && sqlCapable ? 'sql' : 'ram'));
      // invariante INCRUCISATE jurnal/cartea mare/balanta — valabile identic pe RAM si pe SQL
      // (rulate in CI si cu prag 0 => dovedesc echivalenta cailor pentru jurnal si ledger)
      const jj = (await req('GET', '/api/journal?period=2026-06', { cookie: c1 })).json;
      const ll = (await req('GET', '/api/ledger?period=2026-06', { cookie: c1 })).json;
      const bb = (await req('GET', '/api/balance?period=2026-06', { cookie: c1 })).json;
      ok('jurnal: total == rulajul debit al balantei (aceeasi perioada)', jj.total === bb.tot.rd && jj.total > 0);
      ok('jurnal: primul rand are nr=1 si data', jj.rows.length > 0 && jj.rows[0].nr === 1 && !!jj.rows[0].data);
      const l4111 = ll.find((a) => a.cod === '4111');
      const b4111 = bb.rows.find((r) => r.cod === '4111');
      ok('cartea mare 4111 == randul balantei 4111 (rd/rc identice)', !!l4111 && !!b4111 && l4111.rd === b4111.rd && l4111.rc === b4111.rc);
      ok('cartea mare: miscarile au data si explicatie', l4111.moves.length > 0 && l4111.moves.every((m) => !!m.data && m.explicatie !== undefined));
    }

    // admin
    const la = await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } });
    const users = await req('GET', '/api/users', { cookie: la.cookie });
    ok('admin: lista utilizatorilor cu tip', users.json && users.json.length === 11 && users.json.every((u) => u.tip));
    eq('non-admin la ruta de admin -> 403', (await req('GET', '/api/users', { cookie: c1 })).status, 403);
    // ── /api/settings: allowlist strict (fix escaladare la admin prin authSecret) ──
    eq('non-admin nu poate scrie authSecret -> 403', (await req('POST', '/api/settings', { cookie: c1, body: { authSecret: 'forjat' } })).status, 403);
    ok('authSecret RAMANE neschimbat dupa incercare', (await req('GET', '/api/me', { cookie: c1 })).status === 200);
    eq('non-admin nu poate scrie selfRegister (cheie de admin) -> 403', (await req('POST', '/api/settings', { cookie: c1, body: { selfRegister: true } })).status, 403);
    eq('cheie necunoscuta -> 403 (nu se scrie nimic)', (await req('POST', '/api/settings', { cookie: c1, body: { smtp: { host: 'x' } } })).status, 403);
    eq('non-admin nu poate comuta useAI (setare globala) -> 403', (await req('POST', '/api/settings', { cookie: c1, body: { useAI: false } })).status, 403);
    const rUseAI = await req('POST', '/api/settings', { cookie: la.cookie, body: { useAI: false } });
    ok('adminul comuta useAI, raspuns fara authSecret', rUseAI.status === 200 && rUseAI.json.settings && !('authSecret' in rUseAI.json.settings));
    eq('adminul poate scrie selfRegister', (await req('POST', '/api/settings', { cookie: la.cookie, body: { selfRegister: true } })).status, 200);

    // ── Planul de conturi e GLOBAL (partajat de toate firmele) -> scrierea e doar a adminului ──
    // Fara garda, un utilizator legat de o singura firma redenumea conturi standard pentru TOATE
    // firmele (denumirile ajung in cartea mare, balanta, PDF-uri si SAF-T). Aceeasi clasa cu
    // /api/settings de mai sus: stare globala scrisa dintr-un cont cu acces la o singura firma.
    const numeInainte = (await req('GET', '/api/meta', { cookie: c1 })).json.accounts.find((a) => a.cod === '4111').nume;
    const impStrain = await req('POST', '/api/accounts/import', { cookie: c1, body: { csv: '4111;REDENUMIT DE NON-ADMIN;4;A' } });
    eq('non-admin NU poate importa in planul de conturi global -> 403', impStrain.status, 403);
    eq('contul standard a ramas neatins dupa incercare',
      (await req('GET', '/api/meta', { cookie: c1 })).json.accounts.find((a) => a.cod === '4111').nume, numeInainte);
    const impAdmin = await req('POST', '/api/accounts/import', { cookie: la.cookie, body: { csv: '9911;Ajustari speciale de test;9;B' } });
    ok('adminul importa in continuare in planul de conturi', impAdmin.status === 200 && impAdmin.json.importati === 1);
    ok('contul importat de admin e vizibil in meta',
      !!(await req('GET', '/api/meta', { cookie: la.cookie })).json.accounts.find((a) => a.cod === '9911'));

    // ── Antetul se recunoaste dupa prima celula, nu dupa cuvinte din rand ──
    // Euristica veche cauta „cont|cod|denumire" oriunde in primele doua celule si inghitea tacit
    // primul rand REAL cand denumirea continea unul din ele. Planul romanesc e plin de asa ceva.
    const impCont = await req('POST', '/api/accounts/import', { cookie: la.cookie,
      body: { csv: '9912;Conturi curente la banci filiala;9;B\n9913;Alt cont de test;9;B' } });
    eq('primul rand nu se pierde cand denumirea contine „Conturi"', (impCont.json || {}).importati, 2);
    ok('contul cu denumirea „Conturi…" chiar a ajuns in plan',
      !!(await req('GET', '/api/meta', { cookie: la.cookie })).json.accounts.find((a) => a.cod === '9912'));
    const impAntet = await req('POST', '/api/accounts/import', { cookie: la.cookie,
      body: { csv: 'Cod;Denumire;Clasa;Tip\n9914;Cont dupa antet;9;B' } });
    eq('un antet ADEVARAT se sare in continuare', (impAntet.json || {}).importati, 1);

    // Acelasi bug, aceeasi reparatie, la importul de parteneri. Cuvintele cautate acolo sunt
    // „cui|cod|denumire", deci cazul real e o denumire care contine „cod" — „CODLEA PROD SRL".
    const impPart = await req('POST', '/api/partners/import', { cookie: c1,
      body: { csv: 'RO9001;CODLEA PROD SRL;Str. A;Bucuresti;RO-B;RO\n9002;Alt Partener SRL;Str. B;Cluj;RO-CJ;RO' } });
    eq('primul partener nu se pierde cand denumirea contine „COD"', (impPart.json || {}).importati, 2);
    ok('CUI-ul cu prefix RO e recunoscut ca date, nu ca antet',
      !!(await req('GET', '/api/partners', { cookie: c1 })).json['9001']);
    const impPartAntet = await req('POST', '/api/partners/import', { cookie: c1,
      body: { csv: 'CUI;Denumire;Adresa\n9003;Partener Dupa Antet SRL;Str. C' } });
    eq('antetul de parteneri se sare in continuare', (impPartAntet.json || {}).importati, 1);

    // ── Schimbare de parola OBLIGATORIE (cont cu parola implicita „admin") ──
    const laDef = await req('POST', '/api/login', { body: { username: 'defpw', password: 'admin' } });
    ok('cont cu parola implicita: login reuseste (schimbarea vine dupa)', laDef.status === 200 && laDef.cookie);
    ok('/api/me semnaleaza mustChange (migrarea a re-armat flagul)', (await req('GET', '/api/me', { cookie: laDef.cookie })).json.mustChange === true);
    const blocked = await req('GET', '/api/dashboard', { cookie: laDef.cookie });
    ok('mustChange: orice actiune e blocata (403 + flag)', blocked.status === 403 && blocked.json.mustChange === true);
    // De unde isi ia clientul token-ul CSRF cat timp e blocat pe ecranul de schimbare a parolei.
    // Sesiunea EXISTA, deci garda cere token la orice cerere mutanta — inclusiv la schimbarea
    // parolei. Dar /api/meta, sursa obisnuita a token-ului, e tocmai una dintre rutele blocate.
    // Frontendul il lua doar de acolo, deci ecranul nu putea trimite nimic: „Cerere respinsă
    // (token CSRF lipsă sau invalid)", fara iesire — reincarcarea ducea in aceeasi stare.
    // Testele de mai jos existau si treceau, fiindca harness-ul ia token-ul din /api/me:
    // exact ruta pe care clientul NU o folosea. Deci fixam contractul, nu doar comportamentul.
    eq('mustChange: /api/meta e blocata (nu poate fi sursa token-ului)',
      (await req('GET', '/api/meta', { cookie: laDef.cookie })).status, 403);
    const meDef = (await req('GET', '/api/me', { cookie: laDef.cookie })).json;
    ok('mustChange: /api/me ramane accesibila SI poarta token-ul CSRF',
      typeof meDef.csrf === 'string' && meDef.csrf.length === 32);
    eq('mustChange: schimbarea parolei FARA token -> 403 (deci token-ul chiar e necesar)',
      (await req('POST', '/api/change-password', { cookie: laDef.cookie, noCsrf: true, headers: { Origin: BASE }, body: { oldPassword: 'admin', newPassword: 'ParolaNoua2026x' } })).status, 403);
    eq('mustChange: scriere blocata', (await req('POST', '/api/partners', { cookie: laDef.cookie, body: { cui: 'RO1', den: 'X' } })).status, 403);
    // Garda pe parola VECHE — singurul caz care nu era acoperit pe ruta (statea doar in suita
    // sincrona, unde changePassword nu mai poate fi verificat de cand e asincron).
    eq('mustChange: parola veche gresita -> refuz', (await req('POST', '/api/change-password', { cookie: laDef.cookie, body: { oldPassword: 'nu-asta', newPassword: 'ParolaNoua2026x' } })).status, 400);
    eq('mustChange: parola noua = cea veche -> refuz', (await req('POST', '/api/change-password', { cookie: laDef.cookie, body: { oldPassword: 'admin', newPassword: 'admin' } })).status, 400);
    eq('mustChange: parola noua prea scurta -> refuz', (await req('POST', '/api/change-password', { cookie: laDef.cookie, body: { oldPassword: 'admin', newPassword: 'ab1' } })).status, 400);
    ok('mustChange: schimbarea valida reuseste', (await req('POST', '/api/change-password', { cookie: laDef.cookie, body: { oldPassword: 'admin', newPassword: 'parola-noua-2026' } })).json.ok === true);
    ok('dupa schimbare: mustChange stins', (await req('GET', '/api/me', { cookie: laDef.cookie })).json.mustChange === false);
    eq('dupa schimbare: actiunile merg (200)', (await req('GET', '/api/dashboard', { cookie: laDef.cookie })).status, 200);
    eq('parola implicita nu mai merge la login', (await req('POST', '/api/login', { body: { username: 'defpw', password: 'admin' } })).status, 401);
    ok('parola noua functioneaza la login', (await req('POST', '/api/login', { body: { username: 'defpw', password: 'parola-noua-2026' } })).status === 200);

    // ── Mesaje (suport user <-> admin): src/routes/messages.js ──
    ok('utilizatorul trimite un mesaj', (await req('POST', '/api/messages', { cookie: c1, body: { text: 'Am o intrebare despre TVA' } })).json.ok === true);
    const myThread = await req('GET', '/api/messages', { cookie: c1 });
    ok('utilizatorul isi vede conversatia cu mesajul trimis', myThread.json && myThread.json.admin === false && myThread.json.thread.some((m) => m.text === 'Am o intrebare despre TVA'));
    ok('adminul vede conversatiile cu fir neterminat', (await req('GET', '/api/messages', { cookie: la.cookie })).json.admin === true);
    ok('adminul are necitite de la utilizator', (await req('GET', '/api/messages/unread', { cookie: la.cookie })).json.unread >= 1);
    const reply = await req('POST', '/api/messages', { cookie: la.cookie, body: { userId: 2, text: 'Iti raspund imediat' } });
    ok('adminul raspunde in conversatia utilizatorului', reply.json && reply.json.ok && reply.json.message.fromAdmin === true);
    const edited = await req('PATCH', '/api/messages/' + reply.json.message.id, { cookie: la.cookie, body: { text: 'Raspuns corectat' } });
    ok('adminul isi editeaza propriul raspuns', edited.json && edited.json.message.text === 'Raspuns corectat' && edited.json.message.editedAt);
    eq('utilizatorul NU poate edita raspunsul adminului -> 403', (await req('PATCH', '/api/messages/' + reply.json.message.id, { cookie: c1, body: { text: 'hack' } })).status, 403);
    ok('adminul poate sterge un mesaj', (await req('DELETE', '/api/messages/' + reply.json.message.id, { cookie: la.cookie })).json.ok === true);
    eq('utilizatorul NU poate sterge mesaje (doar admin) -> 403', (await req('DELETE', '/api/messages/x', { cookie: c1 })).status, 403);
    const poll = await req('GET', '/api/messages/poll', { cookie: c1 });
    ok('poll consolidat raspunde cu unread + typing', poll.json && typeof poll.json.unread === 'number' && typeof poll.json.typing === 'boolean');
    ok('cautarea in conversatii (admin) raspunde', Array.isArray((await req('GET', '/api/messages/search?q=TVA', { cookie: la.cookie })).json.threads));

    // ── Retentie pe conversatie: `messages` era singura colectie vie fara plafon, iar poarta
    // statica nu o vedea (colectia iesea prin svc.inbox(), nu langa res.json). Proba e de
    // COMPORTAMENT, nu de forma: serverul de test ruleaza cu CONTAB_MESSAGES_MAX=5.
    {
      const cMsg = (await req('POST', '/api/login', { body: { username: 'msguser', password: 'parola1' } })).cookie;
      let toateTrimise = true;
      for (let i = 0; i < 8; i += 1) {
        const r = await req('POST', '/api/messages', { cookie: cMsg, body: { text: 'mesaj de retentie #' + i } });
        if (!(r.json && r.json.ok)) toateTrimise = false;
      }
      ok('cele 8 mesaje chiar au fost trimise (altfel testul de mai jos nu dovedeste nimic)', toateTrimise);
      const t = (await req('GET', '/api/messages', { cookie: cMsg })).json;
      // ATENTIE la ce dovedeste fiecare rand: `thread.length` NU discrimineaza retentia, fiindca
      // raspunsul e plafonat oricum de capList la aceeasi valoare — a trecut si cu retentia
      // scoasa, la mutatia de control. Dovada ca s-a taiat IN BAZA e `threadTotal`, care numara
      // firul real, nu felia intoarsa.
      ok('retentia taie IN BAZA, nu doar in raspuns (totalul real ramane la plafon)', t.threadTotal === 5);
      ok('...deci raspunsul nici nu are ce trunchia', t.threadTruncated === false);
      eq('firul intors e marginit', t.thread.length, 5);
      ok('...si se pastreaza cele mai RECENTE mesaje',
        t.thread[t.thread.length - 1].text === 'mesaj de retentie #7' && !t.thread.some((m) => m.text === 'mesaj de retentie #0'));
      const adm = (await req('GET', '/api/messages/thread/10', { cookie: la.cookie })).json;
      eq('adminul vede acelasi fir marginit', adm.thread.length, 5);
      ok('firul ramane ARRAY (contractul frontendului public/messages.js)', Array.isArray(adm.thread));
    }

    // ── Drepturi granulare: doar-citire + fara salarii ──
    ok('admin seteaza drepturi restrictive pe user1', (await req('POST', '/api/users/2', { cookie: la.cookie, body: { drepturi: { readonly: true, faraSalarii: true } } })).json.ok === true);
    eq('readonly: scrierea respinsa (403)', (await req('POST', '/api/partners', { cookie: c1, body: { cui: 'RO77', den: 'Blocat SRL' } })).status, 403);
    eq('readonly: citirea ramane permisa', (await req('GET', '/api/entries', { cookie: c1 })).status, 200);

    // ── /api/entries cu filtrare pe perioada (clientul cere pe ANI — plati de MB la volume mari) ──
    const eAll = (await req('GET', '/api/entries', { cookie: c1 })).json;
    const eLuna = (await req('GET', '/api/entries?period=2026-06', { cookie: c1 })).json;
    const eAn = (await req('GET', '/api/entries?period=2026', { cookie: c1 })).json;
    ok('filtrarea pe luna intoarce doar luna ceruta', eLuna.length > 0 && eLuna.every((e) => (e.period || '').startsWith('2026-06')));
    ok('filtrarea pe an cuprinde luna si e sub/egal cu totul', eAn.length >= eLuna.length && eAn.length <= eAll.length && eAn.every((e) => (e.period || '').startsWith('2026-')));
    eq('perioada straina -> lista goala', (await req('GET', '/api/entries?period=1999', { cookie: c1 })).json.length, 0);

    // ── Paginare optionala + garda OOM: ?limit -> plic { items, total, offset, limit } ──
    const bare = (await req('GET', '/api/entries', { cookie: c1 })).json;
    ok('fara limit: contract compatibil (array simplu)', Array.isArray(bare));
    const pg1 = (await req('GET', '/api/entries?limit=2', { cookie: c1 })).json;
    ok('cu limit: plic paginat (items/total/offset/limit)', Array.isArray(pg1.items) && pg1.items.length <= 2 && pg1.total === bare.length && pg1.limit === 2 && pg1.offset === 0);
    const pg2 = (await req('GET', '/api/entries?limit=2&offset=1', { cookie: c1 })).json;
    ok('offset decaleaza fereastra', pg2.offset === 1 && pg2.total === bare.length && (bare.length < 2 || pg2.items[0].id !== pg1.items[0].id));
    // aceeasi garda pe rutele de documente (galerii): array simplu fara ?limit, plic cu ?limit
    for (const p of ['/api/documents', '/api/documents/gallery', '/api/documents/emitted']) {
      ok('doc ' + p + ': fara limit -> array (compatibil)', Array.isArray((await req('GET', p, { cookie: c1 })).json));
      const dp = (await req('GET', p + '?limit=1', { cookie: c1 })).json;
      ok('doc ' + p + ': cu limit -> plic { items, total }', Array.isArray(dp.items) && typeof dp.total === 'number');
    }
    // ── Paginare UNIFORMA: inventarul rutelor care intorc colectii ──
    // Inventarul a fost facut EMPIRIC (fiecare GET /api fara parametri, lovit pe o instanta cu
    // seed): 26 de rute intorc un array la radacina. Inainte, doar 7 paginau — produsele,
    // partenerii, angajatii, stocurile si o parte din rapoarte trimiteau setul intreg.
    const COLECTII = ['/api/sessions', '/api/budgets', '/api/fx-reval/candidates', '/api/assets',
      '/api/efactura-list', '/api/compensations', '/api/analytic', '/api/recurring',
      '/api/etransport/eligible', '/api/opening-analytic', '/api/angajati', '/api/recipes',
      '/api/ledger', '/api/doc-register', '/api/products', '/api/gestiuni', '/api/inventories',
      '/api/stocks', '/api/users'];
    for (const p of COLECTII) {
      const fara = await req('GET', p, { cookie: la.cookie });
      ok('colectie ' + p + ': fara limit -> array (contract pastrat)', fara.status === 200 && Array.isArray(fara.json));
      const cu = (await req('GET', p + (p.includes('?') ? '&' : '?') + 'limit=1', { cookie: la.cookie })).json;
      ok('colectie ' + p + ': cu limit -> plic { items, total, offset, limit }',
        Array.isArray(cu.items) && cu.items.length <= 1 && typeof cu.total === 'number'
        && cu.limit === 1 && cu.offset === 0);
    }
    // /api/partners e o HARTA (cheie = CUI), nu o lista: forma implicita ramane harta
    const parteneriHarta = (await req('GET', '/api/partners', { cookie: la.cookie })).json;
    ok('partners: fara limit ramane harta (contract pastrat)',
      parteneriHarta && !Array.isArray(parteneriHarta) && typeof parteneriHarta === 'object');
    const parteneriPlic = (await req('GET', '/api/partners?limit=1', { cookie: la.cookie })).json;
    ok('partners: cu limit -> plic cu items LISTA',
      Array.isArray(parteneriPlic.items) && typeof parteneriPlic.total === 'number');
    eq('faraSalarii: si citirea salarizarii e respinsa (403)', (await req('GET', '/api/angajati', { cookie: c1 })).status, 403);
    eq('faraSalarii: D112 XML respins (403)', (await req('GET', '/xml/d112?period=2026-06', { cookie: c1 })).status, 403);
    ok('drepturile pot fi ridicate inapoi', (await req('POST', '/api/users/2', { cookie: la.cookie, body: { drepturi: { readonly: false, faraSalarii: false } } })).json.ok === true);

    // ── Concurenta: scrieri PARALELE pe starea partajata (calea async a cererilor) nu pierd date ──
    // Restul suitei trimite cererile secvential; aici fortam interleaving-ul, unde traiesc bug-urile
    // async (secventa de id-uri, save() care se calca). Perioada 2026-09 nu e blocata; c1 e read-write.
    const concBase = (await req('GET', '/api/entries?period=2026-09', { cookie: c1 })).json.length;
    const CONC = 12;
    const concPosts = await Promise.all(Array.from({ length: CONC }, (_, i) =>
      req('POST', '/api/entries', { cookie: c1, body: { tip: 'nota_contabila', fields: { data: '2026-09-15', explicatie: 'conc-' + i, debit: '5311', credit: '5121', suma: 10 + i } } })));
    ok('toate cele ' + CONC + ' scrieri concurente au reusit (200)', concPosts.every((p) => p.status === 200 && p.json && p.json.ok));
    eq('fiecare scriere a primit un id UNIC (fara coliziune de secventa)', new Set(concPosts.map((p) => p.json.entry && p.json.entry.id)).size, CONC);
    eq('toate scrierile s-au persistat (niciuna suprascrisa)', (await req('GET', '/api/entries?period=2026-09', { cookie: c1 })).json.length - concBase, CONC);
    eq('dupa ridicare: scrierea functioneaza din nou', (await req('POST', '/api/partners', { cookie: c1, body: { cui: 'RO77', den: 'Deblocat SRL' } })).status, 200);

    // ── Registrul de incasari si plati + auto-blocarea perioadei la "depusa" ──
    const ripH = (await req('GET', '/api/registru-incasari-plati?period=2026-06', { cookie: c1 })).json;
    ok('registru incasari-plati: randuri si venit net pe incasari', Array.isArray(ripH.rows) && typeof ripH.venitNetIncasat === 'number');
    eq('registru incasari-plati PDF', (await req('GET', '/pdf/registru-incasari-plati?period=2026-06', { cookie: c1 })).status, 200);
    ok('DU include varianta pe incasat/platit', typeof (await req('GET', '/api/declaratia-unica?year=2026', { cookie: c1 })).json.incasat.venitNet === 'number');
    const setDep = await req('POST', '/api/declarations/set', { cookie: c1, body: { tip: 'd300', period: '2026-01', status: 'depusa', recipisa: 'R1' } });
    eq('marcarea "depusa" blocheaza automat perioada', setDep.json.locked, '2026-01');
    eq('inregistrare in luna blocata -> respinsa (400)', (await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_servicii', fields: { data: '2026-01-10', partener: 'X', baza: 100, tva: 21, cota: 21 } } })).status, 400);
    const setDep2 = await req('POST', '/api/declarations/set', { cookie: c1, body: { tip: 'd394', period: '2026-01', status: 'depusa' } });
    ok('a doua declaratie depusa pe aceeasi luna nu re-blocheaza', setDep2.json.ok === true && setDep2.json.locked == null);

    // ── CONTRACTE DE LEASING: contractul alimenteaza factura de rata ──
    // Graficul era un calculator fara stare, deci `factura_leasing` cerea principalul si dobanda
    // introduse de mana in fiecare luna — exact cifrele pe care graficul le stia deja.
    const lc = await req('POST', '/api/leasing-contracts', { cookie: c1, body: {
      denumire: 'Autoutilitara', partener: 'Leasing SA', cui: 'RO777', document: 'CTR-42',
      principal: 50000, months: 36, dobandaAnuala: 9, metoda: 'anuitati', dataPrimeiRate: '2026-03-15', cotaTva: 21 } });
    ok('contract de leasing salvat', lc.status === 200 && lc.json.contract.id);
    const lcId = lc.json.contract.id;
    const lcSch = await req('GET', '/api/leasing-contracts/' + lcId + '/schedule', { cookie: c1 });
    eq('graficul are 36 de rate', lcSch.json.schedule.rows.length, 36);
    eq('graficul se inchide pe principal', lcSch.json.schedule.totals.principal, 50000);
    const rata = await req('GET', '/api/leasing-contracts/' + lcId + '/rata?period=2026-05', { cookie: c1 });
    eq('rata lunii cerute e a treia', rata.json.rata.luna, 3);
    ok('rata are principal, dobanda si TVA', rata.json.rata.principal > 0 && rata.json.rata.dobanda > 0 && rata.json.rata.tva > 0);
    eq('rata poarta datele locatorului, pentru completarea facturii', rata.json.contract.cui, 'RO777');
    // o luna din afara contractului e eroare EXPLICITA, nu o rata goala (ar posta articol fara continut)
    eq('luna fara rata -> 404', (await req('GET', '/api/leasing-contracts/' + lcId + '/rata?period=2030-01', { cookie: c1 })).status, 404);
    // cifrele preluate compun un articol contabil VALID (167 + 666 + 4426 = 404)
    const fl = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_leasing', fields: {
      data: '2026-05-15', partener: rata.json.contract.partener, cuiFurnizor: rata.json.contract.cui, document: 'FL-3',
      principal: rata.json.rata.principal, dobanda: rata.json.rata.dobanda, tva: rata.json.rata.tva, cota: 21 } } });
    ok('factura de rata se posteaza din cifrele graficului', fl.status === 200);
    const flLines = fl.json.entry.lines;
    eq('articolul are trei linii (principal, dobanda, TVA)', flLines.length, 3);
    ok('167 = 404 pe principal', flLines.some((l) => l.debit === '167' && l.credit === '404' && l.suma === rata.json.rata.principal));
    ok('666 = 404 pe dobanda', flLines.some((l) => l.debit === '666' && l.credit === '404' && l.suma === rata.json.rata.dobanda));
    ok('4426 = 404 pe TVA', flLines.some((l) => l.debit === '4426' && l.credit === '404' && l.suma === rata.json.rata.tva));
    // validari de intrare
    eq('contract fara denumire -> 400', (await req('POST', '/api/leasing-contracts', { cookie: c1, body: { principal: 1000, months: 12, dataPrimeiRate: '2026-01-01' } })).status, 400);
    eq('contract fara data primei rate -> 400', (await req('POST', '/api/leasing-contracts', { cookie: c1, body: { denumire: 'X', principal: 1000, months: 12 } })).status, 400);
    eq('valoare finantata zero -> 400', (await req('POST', '/api/leasing-contracts', { cookie: c1, body: { denumire: 'X', principal: 0, months: 12, dataPrimeiRate: '2026-01-01' } })).status, 400);

    // ── IZOLARE MULTI-FIRMA: utilizatorul firmei 2 nu poate citi/sterge resursele firmei 1 ──
    // resurse proaspete in firma 1
    const isoP = (await req('POST', '/api/products', { cookie: c1, body: { cod: 'ISO-1', denumire: 'Produs izolare', um: 'buc', cont: '371' } })).json.product;
    const isoG = (await req('POST', '/api/gestiuni', { cookie: c1, body: { cod: 'GIZO', denumire: 'Gestiune izolare' } })).json.gestiune;
    const isoM = (await req('POST', '/api/stock-movements', { cookie: c1, body: { tip: 'receptie', productId: isoP.id, gestiuneId: isoG.id, cantitate: 5, pretUnitar: 10, data: '2026-08-05', document: 'ISO' } })).json.movement;
    const isoA = (await req('POST', '/api/angajati', { cookie: c1, body: { nume: 'Izolat Ion', salariuBrut: 4000 } })).json.angajat;
    const isoE = (await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_servicii', fields: { data: '2026-08-06', partener: 'Iso Client', cuiPartener: 'RO99', document: 'ISO-9', baza: 500, tva: 105, cota: 21 } } })).json.entry;
    // ciorna dedicata pentru cazul pozitiv de stergere (doar ciornele se sterg; postatele = storno)
    const isoED = (await req('POST', '/api/entries', { cookie: c1, body: { tip: 'nota_contabila', ciorna: true, fields: { data: '2026-08-06', explicatie: 'Ciorna de sters', debit: '5311', credit: '5121', suma: 42 } } })).json.entry;
    const isoAs = (await req('POST', '/api/assets', { cookie: c1, body: { denumire: 'Utilaj izolare', cont: '2131', cost: 5000, durataLuni: 60, dataPif: '2026-01-15' } })).json.asset || {};
    const isoLs = (await req('POST', '/api/leasing-contracts', { cookie: c1, body: { denumire: 'Leasing izolare', principal: 50000, months: 36, dobandaAnuala: 9, dataPrimeiRate: '2026-03-15', cotaTva: 21 } })).json.contract || {};
    // utilizator nou, DOAR pe firma 2
    // ruta de admin foloseste ACEEASI regula de nume ca inscrierea publica
    const uDup = await req('POST', '/api/users', { cookie: la.cookie, body: { username: 'ADMIN', password: 'ParolaBunaDeTot9' } });
    ok('users: duplicat cu alte litere mari/mici -> 400', uDup.status === 400 && /existent/i.test((uDup.json || {}).error || ''));
    const uSpatii = await req('POST', '/api/users', { cookie: la.cookie, body: { username: '  admin  ', password: 'ParolaBunaDeTot9' } });
    ok('users: duplicat cu spatii la capete -> 400', uSpatii.status === 400 && /existent/i.test((uSpatii.json || {}).error || ''));
    const uInv = await req('POST', '/api/users', { cookie: la.cookie, body: { username: 'x\u200by', password: 'ParolaBunaDeTot9' } });
    ok('users: nume cu caracter invizibil -> 400', uInv.status === 400 && /invizibile|control/i.test((uInv.json || {}).error || ''));
    const uNorm = await req('POST', '/api/users', { cookie: la.cookie, body: { username: '  Ana   Maria  ', password: 'ParolaBunaDeTot9' } });
    ok('users: numele se stocheaza normalizat', uNorm.status === 200 && uNorm.json.user.username === 'Ana Maria');
    await req('POST', '/api/users', { cookie: la.cookie, body: { username: 'izolat', password: 'parola2', firme: [2] } });
    const c2 = (await req('POST', '/api/login', { body: { username: 'izolat', password: 'parola2' } })).cookie;
    const deny = (r) => [400, 402, 403, 404].includes(r.status);
    eq('nota contabila straina: refuzata', (await req('GET', '/pdf/note/' + isoE.id, { cookie: c2 })).status, 404);
    eq('factura PDF straina: refuzata', (await req('GET', '/pdf/factura/' + isoE.id, { cookie: c2 })).status, 404);
    eq('e-Factura straina: refuzata', (await req('GET', '/xml/efactura/' + isoE.id, { cookie: c2 })).status, 404);
    ok('stergerea inregistrarii straine: refuzata', deny(await req('DELETE', '/api/entries/' + isoE.id, { cookie: c2 })));
    ok('stergerea produsului strain: refuzata', deny(await req('DELETE', '/api/products/' + isoP.id, { cookie: c2 })));
    ok('stergerea gestiunii straine: refuzata', deny(await req('DELETE', '/api/gestiuni/' + isoG.id, { cookie: c2 })));
    ok('stergerea miscarii de stoc straine: refuzata', deny(await req('DELETE', '/api/stock-movements/' + isoM.id, { cookie: c2 })));
    ok('stergerea angajatului strain: refuzata', deny(await req('DELETE', '/api/angajati/' + isoA.id, { cookie: c2 })));
    ok('stergerea mijlocului fix strain: refuzata', deny(await req('DELETE', '/api/assets/' + isoAs.id, { cookie: c2 })));
    ok('casarea mijlocului fix strain: refuzata', deny(await req('POST', '/api/assets/' + isoAs.id + '/scrap', { cookie: c2, body: {} })));
    ok('stergerea contractului de leasing strain: refuzata', deny(await req('DELETE', '/api/leasing-contracts/' + isoLs.id, { cookie: c2 })));
    ok('graficul contractului strain: refuzat', deny(await req('GET', '/api/leasing-contracts/' + isoLs.id + '/schedule', { cookie: c2 })));
    ok('rata contractului strain: refuzata', deny(await req('GET', '/api/leasing-contracts/' + isoLs.id + '/rata?period=2026-03', { cookie: c2 })));
    ok('editarea contractului strain: refuzata', deny(await req('POST', '/api/leasing-contracts', { cookie: c2, body: { id: isoLs.id, denumire: 'Deturnat', principal: 1, months: 1, dataPrimeiRate: '2026-01-01' } })));
    ok('fisa de magazie straina: refuzata', (await req('GET', '/api/stocks/' + isoP.id + '/ledger', { cookie: c2 })).status !== 200);
    ok('fluturasul strain: refuzat', (await req('GET', '/pdf/fluturas/' + isoA.id + '?period=2026-08', { cookie: c2 })).status !== 200);
    ok('trimiterea in SPV a facturii straine: refuzata', deny(await req('POST', '/api/anaf/send/' + isoE.id, { cookie: c2 })));
    // decisiv: resursele firmei 1 sunt INTACTE dupa toate incercarile
    ok('resursele firmei 1 sunt intacte dupa sweep', (
      (await req('GET', '/api/products', { cookie: c1 })).json.some((p) => p.id === isoP.id)
      && (await req('GET', '/api/gestiuni', { cookie: c1 })).json.some((g) => g.id === isoG.id)
      && (await req('GET', '/api/angajati', { cookie: c1 })).json.some((a) => a.id === isoA.id)
      && (await req('GET', '/api/entries', { cookie: c1 })).json.some((e) => e.id === isoE.id)
      && (await req('GET', '/api/stock-movements', { cookie: c1 })).json.some((m) => m.id === isoM.id)
      && (await req('GET', '/api/assets', { cookie: c1 })).json.some((x) => x.id === isoAs.id)
      && (await req('GET', '/api/leasing-contracts', { cookie: c1 })).json.some((x) => x.id === isoLs.id && x.denumire === 'Leasing izolare')
    ));
    // un articol POSTAT nu se sterge (jurnal append-only) — corectia se face prin storno
    eq('stergerea unui articol postat -> 400 (corecteaza prin storno)', (await req('DELETE', '/api/entries/' + isoE.id, { cookie: c1 })).status, 400);
    ok('articolul postat e inca prezent dupa incercarea de stergere', (await req('GET', '/api/entries', { cookie: c1 })).json.some((e) => e.id === isoE.id));
    // proprietarul isi poate sterge propriile resurse (guard-ul nu blocheaza firma corecta);
    // pentru articole se sterge CIORNA (postatele = storno-only)
    ok('proprietarul sterge propriile resurse', (
      (await req('DELETE', '/api/entries/' + isoED.id, { cookie: c1 })).json.ok === true
      && (await req('DELETE', '/api/angajati/' + isoA.id, { cookie: c1 })).json.ok === true
      && (await req('DELETE', '/api/assets/' + isoAs.id, { cookie: c1 })).json.ok === true
      && (await req('DELETE', '/api/stock-movements/' + isoM.id, { cookie: c1 })).json.ok === true
      && (await req('DELETE', '/api/products/' + isoP.id, { cookie: c1 })).json.ok === true
      && (await req('DELETE', '/api/gestiuni/' + isoG.id, { cookie: c1 })).json.ok === true
    ));
    // auditul stergerii pastreaza inregistrarea INTREAGA (liniile debit/credit reconstructibile)
    {
      const aud = await req('GET', '/api/audit?limit=50', { cookie: c1 });
      const del = (aud.json.items || aud.json).find((a) => a.action === 'entry.delete' && a.detail.includes(String(isoED.id)));
      ok('audit entry.delete contine snapshotul complet (linii cu debit/credit)', !!del && /"lines":\[/.test(del.detail) && /"debit"/.test(del.detail));
    }

    // ── STORNO generic: corectie reversibila a oricarui articol (nu stergere distructiva) ──
    {
      const stE = (await req('POST', '/api/entries', { cookie: c1, body: { tip: 'nota_contabila', fields: { data: '2026-08-07', explicatie: 'De stornat', debit: '5311', credit: '5121', suma: 250 } } })).json.entry;
      const st = await req('POST', '/api/entries/' + stE.id + '/storno', { cookie: c1, body: { data: '2026-08-10' } });
      ok('storno reuseste si intoarce nota de reversare', st.status === 200 && st.json.ok && st.json.storno && st.json.storno.stornoOf === stE.id);
      const so = st.json.storno;
      // reversare exacta: debit<->credit, aceleasi sume
      ok('nota de storno inverseaza debit/credit cu aceleasi sume', so.lines.length === stE.lines.length
        && so.lines[0].debit === stE.lines[0].credit && so.lines[0].credit === stE.lines[0].debit && so.lines[0].suma === stE.lines[0].suma);
      ok('nota de storno e marcata system + legata (stornoOf)', so.system === true && so.stornoOf === stE.id);
      // originalul devine imutabil: nu se mai storneaza si nu se mai sterge
      eq('re-stornarea aceluiasi articol -> 400', (await req('POST', '/api/entries/' + stE.id + '/storno', { cookie: c1, body: {} })).status, 400);
      eq('stergerea unui articol deja stornat -> 400', (await req('DELETE', '/api/entries/' + stE.id, { cookie: c1 })).status, 400);
      eq('stornarea unei note de storno -> 400', (await req('POST', '/api/entries/' + so.id + '/storno', { cookie: c1, body: {} })).status, 400);
      // storno strain: refuzat (acelasi guard de firma ca la stergere)
      ok('stornarea unui articol strain: refuzata', deny(await req('POST', '/api/entries/' + stE.id + '/storno', { cookie: c2, body: {} })));
      // efect contabil net zero: original + storno se anuleaza in balanta
      const eList = (await req('GET', '/api/entries?period=2026-08', { cookie: c1 })).json;
      ok('originalul si stornul coexista (jurnal append-only, nu stergere)', eList.some((e) => e.id === stE.id) && eList.some((e) => e.id === so.id));
      // audit: evenimentul de storno e inregistrat
      const audS = await req('GET', '/api/audit?limit=50', { cookie: c1 });
      ok('audit entry.storno inregistrat', (audS.json.items || audS.json).some((a) => a.action === 'entry.storno' && a.detail.includes(String(stE.id))));
      // raportul articolelor stornate: perechea original -> nota de storno
      const srep = (await req('GET', '/api/storno-report?period=2026-08', { cookie: c1 })).json;
      const srow = srep.rows.find((r) => r.id === stE.id);
      ok('raportul de storno contine perechea original->nota', !!srow && srow.stornoId === so.id && srow.stornoData === '2026-08-10');
      // izolare pe firma: raportul altei firme nu vede stornul firmei 1
      ok('raportul de storno e izolat pe firma', !(await req('GET', '/api/storno-report?period=2026-08', { cookie: c2 })).json.rows.some((r) => r.id === stE.id));
      // export CSV al raportului
      const scsv = await req('GET', '/csv/storno-report?period=2026-08', { cookie: c1 });
      ok('CSV raport storno: 200 cu antet', scsv.status === 200 && /Data;Document;Partener;Tip;Suma/.test(scsv.text));
      // articolele cu impact pe stoc au corectie dedicata — storno generic blocat (anti-desincronizare)
      const sg = (await req('POST', '/api/gestiuni', { cookie: c1, body: { cod: 'STG', denumire: 'Storno gest' } })).json.gestiune;
      const sp = (await req('POST', '/api/products', { cookie: c1, body: { cod: 'STP', denumire: 'Storno prod', um: 'buc', cont: '371' } })).json.product;
      await req('POST', '/api/stock-movements', { cookie: c1, body: { tip: 'receptie', productId: sp.id, gestiuneId: sg.id, cantitate: 10, pretUnitar: 20, data: '2026-08-08', document: 'REC' } });
      const stocE = (await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_marfuri', fields: { data: '2026-08-09', partener: 'Stoc Client', cuiPartener: 'RO7', document: 'FS-STOC', baza: 100, tva: 21, cota: 21, stoc: [{ productId: sp.id, cantitate: 2 }] } } })).json.entry;
      ok('articolul de vanzare are miscari de stoc legate', Array.isArray(stocE.stocMovementIds) && stocE.stocMovementIds.length > 0);
      eq('storno pe articol cu miscari de stoc -> 400 (corectie prin stoc/inventar)', (await req('POST', '/api/entries/' + stocE.id + '/storno', { cookie: c1, body: {} })).status, 400);
    }

    // ── FLUX DE STARE: ciorna -> validat -> aprobat -> postat; ciorna NU intra in contabilitate ──
    {
      const per = '2026-11';
      const has5311 = (b) => (b.rows || []).some((r) => r.cod === '5311' && r.rd > 0);
      const inJournal = (j, expl) => (j.rows || []).some((r) => (r.explicatie || '').includes(expl));
      // creare ca CIORNA
      const dr = await req('POST', '/api/entries', { cookie: c1, body: { tip: 'nota_contabila', ciorna: true, fields: { data: per + '-10', explicatie: 'Ciorna flux', debit: '5311', credit: '5121', suma: 500 } } });
      const drE = dr.json.entry;
      ok('articolul creat cu ciorna:true are status=ciorna', dr.status === 200 && drE.status === 'ciorna');
      // VIZIBILA in lista, dar EXCLUSA din contabilitate
      ok('ciorna apare in lista de articole', (await req('GET', '/api/entries?period=' + per, { cookie: c1 })).json.some((e) => e.id === drE.id));
      ok('ciorna NU intra in balanta', !has5311((await req('GET', '/api/balance?period=' + per, { cookie: c1 })).json));
      ok('ciorna NU intra in registrul-jurnal', !inJournal((await req('GET', '/api/journal?period=' + per, { cookie: c1 })).json, 'Ciorna flux'));
      // storno pe ciorna -> refuzat (se sterge direct)
      eq('storno pe ciorna -> 400 (se sterge direct)', (await req('POST', '/api/entries/' + drE.id + '/storno', { cookie: c1, body: {} })).status, 400);
      // tranzitii pas cu pas
      eq('avans ciorna->validat', (await req('POST', '/api/entries/' + drE.id + '/status', { cookie: c1, body: { status: 'validat' } })).json.status, 'validat');
      ok('inca in afara contabilitatii dupa validat', !has5311((await req('GET', '/api/balance?period=' + per, { cookie: c1 })).json));
      eq('avans validat->aprobat', (await req('POST', '/api/entries/' + drE.id + '/status', { cookie: c1, body: { status: 'aprobat' } })).json.status, 'aprobat');
      eq('avans aprobat->postat', (await req('POST', '/api/entries/' + drE.id + '/status', { cookie: c1, body: { status: 'postat' } })).json.status, 'postat');
      // ACUM intra in contabilitate
      ok('dupa postare INTRA in balanta', has5311((await req('GET', '/api/balance?period=' + per, { cookie: c1 })).json));
      ok('dupa postare INTRA in registrul-jurnal', inJournal((await req('GET', '/api/journal?period=' + per, { cookie: c1 })).json, 'Ciorna flux'));
      // postat = ireversibil (corectie doar prin storno)
      eq('postat -> nu se mai retrograda (400)', (await req('POST', '/api/entries/' + drE.id + '/status', { cookie: c1, body: { status: 'ciorna' } })).status, 400);
      eq('stare invalida -> 400', (await req('POST', '/api/entries/' + drE.id + '/status', { cookie: c1, body: { status: 'xyz' } })).status, 400);
      // postarea unei ciorne intr-o luna INCHISA -> refuzata
      const dr2 = (await req('POST', '/api/entries', { cookie: c1, body: { tip: 'nota_contabila', ciorna: true, fields: { data: per + '-12', explicatie: 'Ciorna blocata', debit: '5311', credit: '5121', suma: 60 } } })).json.entry;
      await req('POST', '/api/period-lock', { cookie: la.cookie, body: { lockedUntil: per } });
      eq('postarea unei ciorne in luna inchisa -> 400', (await req('POST', '/api/entries/' + dr2.id + '/status', { cookie: c1, body: { status: 'postat' } })).status, 400);
      await req('POST', '/api/period-lock', { cookie: la.cookie, body: { lockedUntil: null } }); // deblochez pentru restul suitei
      // storno pe articol strain (flux de stare) ramane blocat de guardul de firma
      ok('schimbarea de stare a unui articol strain: refuzata', deny(await req('POST', '/api/entries/' + drE.id + '/status', { cookie: c2, body: { status: 'ciorna' } })));
      // audit: tranzitiile de stare sunt inregistrate
      const audL = await req('GET', '/api/audit?limit=80', { cookie: c1 });
      ok('audit entry.status inregistrat (postare)', (audL.json.items || audL.json).some((a) => a.action === 'entry.status' && a.detail.includes('postat')));
      // o factura CIORNA nu se emite ca e-Factura si nu apare in lista de trimis in SPV
      const dfi = (await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_servicii', ciorna: true, fields: { data: per + '-14', partener: 'Ciorna SPV', cuiPartener: 'RO123', document: 'DRAFT-1', baza: 100, tva: 21, cota: 21 } } })).json.entry;
      eq('e-Factura pentru o ciorna -> 400', (await req('GET', '/xml/efactura/' + dfi.id, { cookie: c1 })).status, 400);
      ok('ciorna de factura NU apare in lista e-Factura', !(await req('GET', '/api/efactura-list', { cookie: c1 })).json.some((x) => x.id === dfi.id));
      eq('trimiterea unei ciorne in SPV -> respinsa', (await req('POST', '/api/anaf/send/' + dfi.id, { cookie: c1 })).status >= 400 ? 400 : 200, 400);
    }

    // ── BACKUP / RESTORE round-trip: un backup nerestaurat e o speranta, nu un backup ──
    // 1) date-marker in firma 1
    await req('POST', '/api/partners', { cookie: c1, body: { cui: 'RO4242', den: 'Backup Test SRL', oras: 'Cluj' } });
    await req('POST', '/api/products', { cookie: c1, body: { cod: 'BKP-1', denumire: 'Produs backup', um: 'buc', cont: '371' } });
    await req('POST', '/api/entries', { cookie: c1, body: { tip: 'factura_vanzare_servicii', fields: { data: '2026-08-20', partener: 'Backup Test SRL', cuiPartener: 'RO4242', document: 'BKP-DOC', baza: 1234, tva: 259.14, cota: 21 } } });
    const nrEntriesF1 = (await req('GET', '/api/entries?firma=1', { cookie: c1 })).json.length;
    ok('marker inainte de backup: factura BKP-DOC exista in firma 1', (await req('GET', '/api/entries?firma=1', { cookie: c1 })).json.some((e) => e.document === 'BKP-DOC'));
    // 2) export firma 1 (pachetul de backup)
    const bundle = (await req('GET', '/api/firme/1/export', { cookie: c1 })).json;
    ok('exportul contine firma, entries si parteneri', bundle && bundle.firma && Array.isArray(bundle.entries) && bundle.partners);
    // 3) restaurare ca firma NOUA — fidelitatea copiei
    const impBkp = await req('POST', '/api/firme/import', { cookie: c1, body: bundle });
    ok('restaurare ca firma noua reusita', impBkp.json && impBkp.json.ok && impBkp.json.firmaId && !impBkp.json.replaced);
    const newFid = impBkp.json.firmaId;
    const restEntries = (await req('GET', '/api/entries?firma=' + newFid, { cookie: c1 })).json;
    ok('firma restaurata: acelasi numar de inregistrari', restEntries.length === nrEntriesF1);
    ok('firma restaurata: factura BKP-DOC prezenta cu aceeasi baza', restEntries.some((e) => e.document === 'BKP-DOC' && e.lines.some((l) => l.suma === 1234)));
    ok('firma restaurata: partenerul RO4242 recuperat', (await req('GET', '/api/partners?firma=' + newFid, { cookie: c1 })).json['4242']);
    ok('firma restaurata: produsul BKP-1 recuperat', (await req('GET', '/api/products?firma=' + newFid, { cookie: c1 })).json.some((p) => p.cod === 'BKP-1'));
    // 4) recuperare prin SUPRASCRIERE (mode=replace): simulez pierderea printr-un import PARTIAL
    // (articolele postate nu se sterg prin API — pierderea reala e coruptie/suprascriere), apoi restaurez
    await req('POST', '/api/firme/' + newFid + '/activate', { cookie: c1 });
    const partialBundle = Object.assign({}, bundle, { entries: bundle.entries.filter((e) => e.document !== 'BKP-DOC') });
    await req('POST', '/api/firme/import?mode=replace', { cookie: c1, body: partialBundle });
    ok('dupa "pierderea" datelor (suprascriere partiala): BKP-DOC lipseste', !(await req('GET', '/api/entries?firma=' + newFid, { cookie: c1 })).json.some((e) => e.document === 'BKP-DOC'));
    const restore = await req('POST', '/api/firme/import?mode=replace', { cookie: c1, body: bundle });
    ok('restaurare prin suprascriere reusita (replaced)', restore.json && restore.json.ok && restore.json.replaced);
    ok('dupa restaurare: BKP-DOC este inapoi', (await req('GET', '/api/entries?firma=' + newFid, { cookie: c1 })).json.some((e) => e.document === 'BKP-DOC'));
    await req('POST', '/api/firme/1/activate', { cookie: c1 }); // revin pe firma 1

    // ── MULTI-FIRMA pentru un user obisnuit: adauga si comuta intre firme (ca la admin) ──
    const firmeInainte = (await req('GET', '/api/firme', { cookie: c1 })).json.firme.length;
    // Firmele proprii se inscriu pe o PERSOANA identificata: fara CNP in profil, cererea e refuzata.
    const faraCnp = await req('POST', '/api/firme', { cookie: c1, body: { nume: 'A Doua Firma PFA', cui: '7777' } });
    eq('fara CNP in profil, nu poti inscrie o firma -> 400', faraCnp.status, 400);
    ok('mesajul spune ca lipseste CNP-ul', /CNP/.test(faraCnp.json.error));
    // marcaj STABIL pentru interfata (care sare la campul CNP). Textul se rescrie oricand — o
    // potrivire pe el ar pica tacut la prima reformulare, si saltul ar disparea fara sa se vada.
    eq('raspunsul poarta codul pe care il foloseste interfata', faraCnp.json.code, 'CNP_LIPSA');
    ok('starea „am CNP" ajunge la client, ca sa avertizeze INAINTE de incercare',
      (await req('GET', '/api/me', { cookie: c1 })).json.cnpSetat === false);
    eq('CNP invalid (cifra de control) e respins', (await req('POST', '/api/profile', { cookie: c1, body: { profil: { cnp: '1900101415239' } } })).status, 400);
    ok('CNP valid se salveaza', (await req('POST', '/api/profile', { cookie: c1, body: { profil: { cnp: '1900101415238' } } })).status === 200);
    ok('CNP-ul NU se intoarce intreg, nici propriului cont', (await req('GET', '/api/profile', { cookie: c1 })).json.profil.cnp === '1900101******');
    ok('...iar dupa completare, starea din /api/me se schimba', (await req('GET', '/api/me', { cookie: c1 })).json.cnpSetat === true);
    const cuiRau = await req('POST', '/api/firme', { cookie: c1, body: { nume: 'Cu CUI gresit', cui: '7778' } });
    eq('CUI cu cifra de control gresita e respins -> 400', cuiRau.status, 400);
    const nouaFirma = await req('POST', '/api/firme', { cookie: c1, body: { nume: 'A Doua Firma PFA', cui: 'RO7777', tipEntitate: 'pfa', tvaPlatitor: false } });
    ok('user obisnuit: creeaza o firma noua, devine activa', nouaFirma.json && nouaFirma.json.ok && nouaFirma.json.firmaActiva === nouaFirma.json.firma.id);
    const f2 = nouaFirma.json.firma.id;
    ok('firma noua pastreaza forma juridica si statutul TVA', nouaFirma.json.firma.tipEntitate === 'pfa' && nouaFirma.json.firma.tvaPlatitor === false);
    const lista = (await req('GET', '/api/firme', { cookie: c1 })).json;
    ok('user vede ACUM toate firmele lui (una in plus)', lista.firme.length === firmeInainte + 1 && lista.firme.some((f) => f.id === f2) && lista.firme.some((f) => f.id === 1));
    ok('meta reflecta firma activa noua', (await req('GET', '/api/meta', { cookie: c1 })).json.firmaActiva === f2);
    // datele sunt separate pe firma: partenerul creat in firma 1 NU apare in firma noua
    ok('firma noua e goala (izolare fata de firma 1)', Object.keys((await req('GET', '/api/partners?firma=' + f2, { cookie: c1 })).json).length === 0);
    // Conexiunea SPV e PER-FIRMA: configurarea pe firma noua NU se vede pe firma 1
    const spvSet = await req('POST', '/api/anaf/config', { cookie: c1, body: { cif: '7788', clientId: 'id-f2', clientSecret: 's', redirectUri: 'http://x/cb' } });
    ok('SPV: config salvat pe firma activa (noua)', spvSet.json && spvSet.json.ok && spvSet.json.configured === true);
    ok('SPV: firma noua il vede (configured)', (await req('GET', '/api/anaf/config', { cookie: c1 })).json.configured === true);
    ok('SPV: firma 1 NU il vede (izolare per-firma)', (await req('GET', '/api/anaf/config?firma=1', { cookie: c1 })).json.configured === false);
    // comuta inapoi pe firma 1 din selector (activate) — ca la admin
    ok('comutarea pe firma 1 reuseste', (await req('POST', '/api/firme/1/activate', { cookie: c1 })).json.ok === true);
    eq('dupa comutare, firma activa e 1', (await req('GET', '/api/meta', { cookie: c1 })).json.firmaActiva, 1);
    ok('firma 1 isi are inapoi partenerii ei (RO4242)', !!(await req('GET', '/api/partners', { cookie: c1 })).json['4242']);
    // NU poate activa o firma la care nu are acces (a altui user)
    ok('user NU poate activa o firma straina', (await req('POST', '/api/firme/2/activate', { cookie: c1 })).status >= 400 || (await req('GET', '/api/meta', { cookie: c1 })).json.firmaActiva !== 2);
    // isi poate STERGE o firma proprie (ca la admin), dar nu una straina
    eq('user NU poate sterge o firma straina -> 403', (await req('DELETE', '/api/firme/2', { cookie: c1 })).status, 403);
    ok('user isi sterge propria firma secundara', (await req('DELETE', '/api/firme/' + f2, { cookie: c1 })).json.ok === true);
    ok('dupa stergere, firma nu mai apare in lista lui', !(await req('GET', '/api/firme', { cookie: c1 })).json.firme.some((f) => f.id === f2));

    // ── ACCES STRICT: userii vad DOAR firmele lor, niciodata a altcuiva ──
    // ?firma= din afara listei proprii e ignorat (constrans la firma userului), nu se scurge firma 2
    const foreignView = await req('GET', '/api/meta?firma=2', { cookie: c1 });
    eq('user1: ?firma=2 (straina) e ignorat -> ramane pe firma 1', foreignView.json.firmaActiva, 1);
    ok('user1: datele raman ale firmei 1 (partenerul lui), nu ale firmei 2', !!(await req('GET', '/api/partners?firma=2', { cookie: c1 })).json['4242']);
    // un user FARA nicio firma nu vede firma globala implicita — vedere goala
    await req('POST', '/api/users', { cookie: la.cookie, body: { username: 'fara_firma', password: 'parola3', firme: [] } });
    const cNo = (await req('POST', '/api/login', { body: { username: 'fara_firma', password: 'parola3' } })).cookie;
    const noMeta = (await req('GET', '/api/meta', { cookie: cNo })).json;
    ok('user fara firme: firma activa NU e o firma reala (santinela negativa)', typeof noMeta.firmaActiva === 'number' && noMeta.firmaActiva < 1);
    eq('user fara firme: nicio inregistrare vizibila (fara scurgere globala)', (await req('GET', '/api/entries', { cookie: cNo })).json.length, 0);
    eq('user fara firme: niciun partener vizibil', Object.keys((await req('GET', '/api/partners', { cookie: cNo })).json).length, 0);
    ok('user fara firme: lista lui de firme e goala', (await req('GET', '/api/firme', { cookie: cNo })).json.firme.length === 0);

    // ── CONTUL DEMO: nu adauga si nu gestioneaza firme (doar lucreaza pe firma demo) ──
    await req('POST', '/api/users', { cookie: la.cookie, body: { username: 'demo', password: 'parola-demo', firme: [1] } });
    const cDemo = (await req('POST', '/api/demo-login', {})).cookie;
    ok('demo: vede firma lui', (await req('GET', '/api/firme', { cookie: cDemo })).json.firme.length === 1);
    eq('demo: NU poate adauga firma -> 403', (await req('POST', '/api/firme', { cookie: cDemo, body: { nume: 'Firma Demo Noua' } })).status, 403);
    eq('demo: NU poate clona firma de test -> 403', (await req('POST', '/api/firme/1/test-clone', { cookie: cDemo })).status, 403);
    eq('demo: NU poate abona firma -> 403', (await req('POST', '/api/firme/1/subscribe', { cookie: cDemo, body: { plan: 'start' } })).status, 403);
    eq('demo: NU poate sterge firma -> 403', (await req('DELETE', '/api/firme/1', { cookie: cDemo })).status, 403);
    eq('demo: NU poate restaura/importa firma -> 403', (await req('POST', '/api/firme/import', { cookie: cDemo, body: { firma: { nume: 'X' } } })).status, 403);
    // cont public partajat: datele de cont si setarile globale raman neatinse
    eq('demo: NU isi schimba parola -> 403', (await req('POST', '/api/change-password', { cookie: cDemo, body: { oldPassword: 'parola-demo', newPassword: 'alta' } })).status, 403);
    eq('demo: NU activeaza 2FA -> 403', (await req('POST', '/api/2fa/setup', { cookie: cDemo })).status, 403);
    eq('demo: NU isi schimba profilul/emailul -> 403', (await req('POST', '/api/profile', { cookie: cDemo, body: { email: 'spam@x.ro' } })).status, 403);
    eq('demo: NU modifica conexiunea SPV (setare globala) -> 403', (await req('POST', '/api/anaf/config', { cookie: cDemo, body: { clientId: 'x' } })).status, 403);
    eq('user normal: profilul ramane editabil', (await req('POST', '/api/profile', { cookie: c1, body: { notifyDeadlines: true } })).status, 200);

    // ── COLABORARE DEMO: perechea demo (patron) <-> demo-contabil, ambele opereaza pe firma ──
    await req('POST', '/api/users', { cookie: la.cookie, body: { username: 'demo-contabil', password: 'parola-democ', firme: [1] } });
    const cDemoC = (await req('POST', '/api/demo-login', { body: { as: 'contabil' } })).cookie;
    ok('demo-login as=contabil -> intra pe contul demo-contabil', (await req('GET', '/api/me', { cookie: cDemoC })).json.username === 'demo-contabil');
    eq('demo-contabil: opereaza pe firma (dashboard 200)', (await req('GET', '/api/dashboard', { cookie: cDemoC })).status, 200);
    const colDemo = (await req('GET', '/api/colaboratori', { cookie: cDemo })).json;
    ok('demo GET colaboratori: demo=true + ambele conturi listate', colDemo.demo === true && colDemo.colaboratori.some((c) => c.username === 'demo') && colDemo.colaboratori.some((c) => c.username === 'demo-contabil'));
    const dcId = (colDemo.colaboratori.find((c) => c.username === 'demo-contabil') || {}).id;
    eq('demo (patron): scoate contul pereche demo-contabil -> 200', (await req('DELETE', '/api/colaboratori/' + dcId, { cookie: cDemo })).status, 200);
    eq('demo (patron): re-adauga contul pereche -> 200', (await req('POST', '/api/colaboratori', { cookie: cDemo, body: { mod: 'existing', username: 'demo-contabil' } })).status, 200);
    eq('demo-contabil (invers): scoate patronul demo -> 200', (await req('DELETE', '/api/colaboratori/' + (await req('GET', '/api/colaboratori', { cookie: cDemoC })).json.colaboratori.find((c) => c.username === 'demo').id, { cookie: cDemoC })).status, 200);
    eq('demo-contabil (invers): re-adauga demo -> 200', (await req('POST', '/api/colaboratori', { cookie: cDemoC, body: { mod: 'existing', username: 'demo' } })).status, 200);
    eq('demo: invitatie noua blocata -> 403', (await req('POST', '/api/colaboratori', { cookie: cDemo, body: { mod: 'invite', username: 'strain-nou' } })).status, 403);
    eq('demo: adaugare cont arbitrar (non-pereche) blocata -> 403', (await req('POST', '/api/colaboratori', { cookie: cDemo, body: { mod: 'existing', username: 'admin2' } })).status, 403);

    // ── BILLING STRICT PER-FIRMA: firma noua porneste cu proba de 30 zile, apoi abonament ──
    const tfR = await req('POST', '/api/firme', { cookie: c1, body: { nume: 'Firma Proba SRL', cui: 'RO12340' } });
    ok('firma noua porneste cu abonament de proba (30 zile)', tfR.json.ok && tfR.json.firma.subscription && tfR.json.firma.subscription.plan === 'trial' && !!tfR.json.firma.subscription.trialEndsAt);
    const tf = tfR.json.firma.id;
    const tfInfo = (await req('GET', '/api/firme', { cookie: c1 })).json.firme.find((f) => f.id === tf);
    ok('firma noua: stare trial activa cu ~30 zile ramase', tfInfo._sub.status === 'trial' && tfInfo._sub.zileRamase >= 28);
    eq('scriere permisa cat timp proba e activa', (await req('POST', '/api/partners', { cookie: c1, body: { cui: 'RO901', den: 'Client Proba' } })).status, 200);
    // simulez expirarea probei prin RUTA DEDICATA de admin (updateFirma NU mai accepta subscription)
    const expR = await req('POST', '/api/firme/' + tf + '/subscription', { cookie: la.cookie, body: { subscription: { plan: 'trial', trialEndsAt: '2026-01-01T00:00:00Z' } } });
    eq('ruta de abonament (admin) reuseste', expR.status, 200);
    ok('utilizatorul firmei NU poate seta abonament prin ruta dedicata (blocat)', [402, 403].includes((await req('POST', '/api/firme/' + tf + '/subscription', { cookie: c1, body: { subscription: { plan: 'gratis' } } })).status));
    ok('abonamentul NU se poate seta prin editarea de profil (updateFirma)', (await req('POST', '/api/firme/' + tf, { cookie: c1, body: { subscription: { plan: 'gratis' } } })).json.ok && (await req('GET', '/api/firme', { cookie: c1 })).json.firme.find((f) => f.id === tf)._sub.status === 'expired');
    ok('firma cu proba expirata e blocata (status expired)', (await req('GET', '/api/firme', { cookie: c1 })).json.firme.find((f) => f.id === tf)._sub.status === 'expired');
    const blocat = await req('POST', '/api/partners', { cookie: c1, body: { cui: 'RO902', den: 'Blocat' } });
    eq('dupa expirare: scrierea pe firma e blocata (402)', blocat.status, 402);
    ok('402 semnaleaza firma pentru promptul de abonare', blocat.json && blocat.json.firmaTrialExpired === true && blocat.json.firmaId === tf && blocat.json.firmaStatus === 'expired');
    eq('dupa expirare: citirile raman libere', (await req('GET', '/api/partners', { cookie: c1 })).status, 200);

    // ── A DOUA perioada de proba, ceruta explicit dupa expirarea primei ──
    // La expirare aplicatia deschide singura ecranul de preturi, iar de acolo utilizatorul poate
    // cere inca o luna gratuita. Dupa a doua, cardul de proba ramane vizibil dar inactiv.
    const subInainte = (await req('GET', '/api/subscription', { cookie: c1 })).json;
    ok('/api/subscription poarta starea probei FIRMEI active (nu doar a contului)',
      subInainte.firma && typeof subInainte.firma.trialCount === 'number' && typeof subInainte.firma.maiPoateProba === 'boolean');
    const t2 = await req('POST', '/api/firme/' + tf + '/trial', { cookie: c1 });
    ok('a doua proba se acorda (2/2)', t2.status === 200 && t2.json.ok && t2.json.trialCount === 2);
    ok('...si deblocheaza scrierea', (await req('POST', '/api/partners', { cookie: c1, body: { cui: 'RO904', den: 'Proba2' } })).status === 200);
    eq('cat timp proba noua e activa, alta nu se poate cere',
      (await req('POST', '/api/firme/' + tf + '/trial', { cookie: c1 })).status, 400);
    // expiram si a doua -> plafonul se aplica
    await req('POST', '/api/firme/' + tf + '/subscription', { cookie: la.cookie, body: { subscription: { plan: 'trial', trialCount: 2, trialEndsAt: '2026-01-01T00:00:00Z' } } });
    const t3 = await req('POST', '/api/firme/' + tf + '/trial', { cookie: c1 });
    eq('a TREIA proba e refuzata', t3.status, 400);
    ok('...cu motivul plafonului', /perioade de probă/i.test((t3.json || {}).error || ''));
    const subDupa = (await req('GET', '/api/subscription', { cookie: c1 })).json;
    ok('starea spune ca proba nu mai e disponibila', subDupa.firma.maiPoateProba === false && subDupa.firma.trialCount === 2);
    eq('demo NU poate cere proba', (await req('POST', '/api/firme/1/trial', { cookie: cDemo })).status, 403);

    // ── CERERI DE ACCES la o firma EXISTENTA (contabil care preia firma unui client) ──
    // Doua garantii se testeaza explicit: raspunsul e IDENTIC fie ca firma exista sau nu (altfel
    // ecranul devine un mod de a afla ce firme sunt in sistem, incercand CUI-uri), si decide
    // PROPRIETARUL, nu oricine are acces (un colaborator n-are voie sa dea mai departe accesul).
    {
      const patron = await req('POST', '/api/register', { headers: { Origin: BASE }, body: { nume: 'FIRMA PATRON SRL', cui: 'RO5550005', username: 'patron-t', password: 'ParolaBuna2026' } });
      ok('patron: firma inscrisa', patron.status === 200 && patron.json.ok);
      const fidP = patron.json.firma.id;
      const contabil = await req('POST', '/api/register', { headers: { Origin: BASE }, body: { nume: 'BIROU CONTABIL SRL', cui: 'RO5550013', username: 'contabil-t', password: 'ParolaBuna2026' } });
      ok('contabil: cont propriu', contabil.status === 200);

      // raspuns IDENTIC pentru firma care exista si pentru una inventata
      const exista = await req('POST', '/api/firme/cerere-acces', { cookie: contabil.cookie, body: { cui: 'RO5550005' } });
      const nuExista = await req('POST', '/api/firme/cerere-acces', { cookie: contabil.cookie, body: { cui: 'RO9999999' } });
      ok('cerere: acelasi raspuns pentru firma reala si inexistenta (fara enumerare)',
        exista.status === 200 && nuExista.status === 200 && exista.text === nuExista.text);

      // contabilul NU are inca acces
      const inainte = (await req('GET', '/api/firme', { cookie: contabil.cookie })).json.firme.map((f) => f.id);
      ok('cerere trimisa nu da acces prin ea insasi', !inainte.includes(fidP));

      // patronul vede cererea; contabilul nu vede nimic (nu e proprietar)
      const cereriPatron = (await req('GET', '/api/firme/cereri', { cookie: patron.cookie })).json.cereri;
      ok('patronul vede cererea', cereriPatron.length === 1 && cereriPatron[0].username === 'contabil-t' && cereriPatron[0].firmaId === fidP);
      eq('contabilul nu vede cereri (nu e proprietar)', (await req('GET', '/api/firme/cereri', { cookie: contabil.cookie })).json.cereri.length, 0);

      // cine NU e proprietar nu poate decide — nici macar cel care a cerut
      eq('cel care a cerut nu-si poate aproba singur cererea',
        (await req('POST', '/api/firme/cereri/' + cereriPatron[0].id, { cookie: contabil.cookie, body: { aprob: true } })).status, 403);

      // aprobarea patronului da accesul
      const ap = await req('POST', '/api/firme/cereri/' + cereriPatron[0].id, { cookie: patron.cookie, body: { aprob: true } });
      ok('patronul aproba', ap.status === 200 && ap.json.status === 'aprobata');
      ok('dupa aprobare contabilul are firma', (await req('GET', '/api/firme', { cookie: contabil.cookie })).json.firme.some((f) => f.id === fidP));
      eq('cererea nu se mai poate decide a doua oara',
        (await req('POST', '/api/firme/cereri/' + cereriPatron[0].id, { cookie: patron.cookie, body: { aprob: true } })).status, 404);
      eq('lista patronului e goala dupa rezolvare', (await req('GET', '/api/firme/cereri', { cookie: patron.cookie })).json.cereri.length, 0);

      // Cazul care da sens cerintei „numai cu acordul patronului": contabilul are ACUM acces la
      // firma, dar tot NU poate aproba cererea altcuiva. Altfel accesul s-ar propaga singur —
      // primul invitat ar putea invita mai departe, iar patronul ar pierde controlul.
      const c3 = await req('POST', '/api/register', { headers: { Origin: BASE }, body: { nume: 'AL TREILEA SRL', cui: 'RO5550030', username: 'contabil3-t', password: 'ParolaBuna2026' } });
      await req('POST', '/api/firme/cerere-acces', { cookie: c3.cookie, body: { cui: 'RO5550005' } });
      const cerT = (await req('GET', '/api/firme/cereri', { cookie: patron.cookie })).json.cereri;
      ok('patronul vede cererea a treia', cerT.length === 1);
      eq('un COLABORATOR cu acces NU poate aproba cererea altcuiva (doar proprietarul)',
        (await req('POST', '/api/firme/cereri/' + cerT[0].id, { cookie: contabil.cookie, body: { aprob: true } })).status, 403);
      ok('...iar al treilea chiar NU a primit acces',
        !(await req('GET', '/api/firme', { cookie: c3.cookie })).json.firme.some((f) => f.id === fidP));
      await req('POST', '/api/firme/cereri/' + cerT[0].id, { cookie: patron.cookie, body: { aprob: false } }); // curatenie

      // respingerea NU da acces
      const c2 = await req('POST', '/api/register', { headers: { Origin: BASE }, body: { nume: 'ALT BIROU SRL', cui: 'RO5550021', username: 'contabil2-t', password: 'ParolaBuna2026' } });
      await req('POST', '/api/firme/cerere-acces', { cookie: c2.cookie, body: { cui: 'RO5550005' } });
      const cer2 = (await req('GET', '/api/firme/cereri', { cookie: patron.cookie })).json.cereri;
      await req('POST', '/api/firme/cereri/' + cer2[0].id, { cookie: patron.cookie, body: { aprob: false } });
      ok('respingerea nu da acces', !(await req('GET', '/api/firme', { cookie: c2.cookie })).json.firme.some((f) => f.id === fidP));

      eq('demo nu poate cere acces', (await req('POST', '/api/firme/cerere-acces', { cookie: cDemo, body: { cui: 'RO5550005' } })).status, 403);
      eq('CUI gol -> 400', (await req('POST', '/api/firme/cerere-acces', { cookie: contabil.cookie, body: { cui: '  ' } })).status, 400);

      // ── O FIRMA, O SINGURA EVIDENTA: poarta pe CUI ──
      // Fara ea, „cere acces" ramane o sugestie: cine nu vrea sa astepte aprobarea isi inregistreaza
      // firma inca o data si lucreaza pe o evidenta paralela, cu aceleasi declaratii de depus.
      const dubluReg = await req('POST', '/api/register', { headers: { Origin: BASE }, body: { nume: 'FIRMA PATRON SRL (copie)', cui: 'RO5550005', username: 'dublura-t', password: 'ParolaBuna2026' } });
      eq('inscriere cu CUI-ul unei firme existente -> 409', dubluReg.status, 409);
      ok('...si mesajul trimite spre cererea de acces', /cere acces/i.test(dubluReg.json.error));
      eq('inscriere cu CUI invalid (cifra de control) -> 400',
        (await req('POST', '/api/register', { headers: { Origin: BASE }, body: { nume: 'CU CUI RAU SRL', cui: 'RO5550006', username: 'cuirau-t', password: 'ParolaBuna2026' } })).status, 400);
      ok('inscrierea FARA CUI ramane permisa (nu rupem intrarea in aplicatie)',
        (await req('POST', '/api/register', { headers: { Origin: BASE }, body: { nume: 'FARA CUI SRL', username: 'faracui-t', password: 'ParolaBuna2026' } })).status === 200);
      // aceeasi poarta pe calea din aplicatie, nu doar la inscriere
      const dubluCreate = await req('POST', '/api/firme', { cookie: c1, body: { nume: 'COPIE PRIN APLICATIE SRL', cui: 'RO5550005' } });
      eq('inscrierea unei firme cu CUI deja folosit, din aplicatie -> 409', dubluCreate.status, 409);
      ok('...cu acelasi mesaj care trimite la cererea de acces', /cere acces/i.test(dubluCreate.json.error));
      // portita in doi pasi: firma fara CUI, apoi ii pui CUI-ul altei firme
      const fcLista = (await req('GET', '/api/firme', { cookie: (await req('POST', '/api/login', { headers: { Origin: BASE }, body: { username: 'faracui-t', password: 'ParolaBuna2026' } })).cookie })).json;
      const cFc = (await req('POST', '/api/login', { headers: { Origin: BASE }, body: { username: 'faracui-t', password: 'ParolaBuna2026' } })).cookie;
      eq('nu poti muta CUI-ul altei firme pe firma ta, dupa creare -> 409',
        (await req('POST', '/api/firme/' + fcLista.firme[0].id, { cookie: cFc, body: { cui: 'RO5550005' } })).status, 409);

      // Plafonul de inscrieri per IP (5/ora) e ATINS exact aici, de cele 5 conturi create mai sus.
      // Aserțiunea il face explicit: daca cineva mai adauga o inscriere in suita, pica AICI, cu
      // motivul la vedere, in loc sa strice tacut un test de mai jos printr-un 429 neasteptat.
      eq('a sasea inscriere de pe acelasi IP e refuzata (plafon 5/ora)',
        (await req('POST', '/api/register', { headers: { Origin: BASE }, body: { nume: 'A SASEA SRL', cui: '5550048', username: 'asasea-t', password: 'ParolaBuna2026' } })).status, 429);

      // ── ANGAJAREA UNUI CONTABIL: patron -> contabil (sensul invers) ──
      // Simetria cu cererea de acces: cine primeste cererea decide. Aici decide CONTABILUL.
      {
        // Contabilul din fluxul de mai sus a PRIMIT deja acces la firma patronului, deci nu poate fi
        // angajat pe ea. Folosesc contul caruia i s-a RESPINS cererea: n-are niciun acces.
        const cPat = patron.cookie; const cCon = c2.cookie; const cTert = contabil.cookie;
        eq('lista de contabili e goala cat timp nimeni nu s-a oferit',
          (await req('GET', '/api/firme/contabili', { cookie: cPat })).json.contabili.length, 0);
        ok('contabilul se inscrie in lista (optiune explicita)',
          (await req('POST', '/api/profile', { cookie: cCon, body: { profil: { disponibilContabil: true, numeComplet: 'Maria Contabil', oras: 'Cluj', autorizatie: '123/2020' } } })).status === 200);
        const lst = (await req('GET', '/api/firme/contabili', { cookie: cPat })).json.contabili;
        ok('patronul vede contabilul disponibil', lst.length === 1 && lst[0].nume === 'Maria Contabil' && lst[0].oras === 'Cluj');
        ok('lista NU divulga emailul, CNP-ul sau firmele contabilului',
          !('email' in lst[0]) && !('cnp' in lst[0]) && !('firme' in lst[0]));
        const conId = lst[0].id;

        // patronul cere servicii pentru firma LUI
        const cs = await req('POST', '/api/firme/servicii', { cookie: cPat, body: { firmaId: fidP, contabilId: conId, mesaj: 'Am nevoie de contabil de luna viitoare.' } });
        eq('patronul trimite cererea de servicii', cs.status, 200);
        eq('a doua cerere identica e refuzata', (await req('POST', '/api/firme/servicii', { cookie: cPat, body: { firmaId: fidP, contabilId: conId } })).status, 400);
        // pentru firma ALTCUIVA nu se poate cere
        eq('nu poti angaja un contabil pentru firma altcuiva -> 403',
          (await req('POST', '/api/firme/servicii', { cookie: cCon, body: { firmaId: 1, contabilId: conId } })).status, 403);

        const primite = (await req('GET', '/api/firme/servicii', { cookie: cCon })).json;
        ok('contabilul vede cererea primita', primite.primite.length === 1 && primite.primite[0].firmaId === fidP && /luna viitoare/.test(primite.primite[0].mesaj));
        ok('patronul isi vede cererea trimisa', (await req('GET', '/api/firme/servicii', { cookie: cPat })).json.trimise.some((r) => r.status === 'in_asteptare'));
        const srvId = primite.primite[0].id;

        // garda esentiala: PATRONUL nu poate accepta in numele contabilului (i-ar impune munca)
        eq('patronul NU poate accepta cererea in locul contabilului -> 403',
          (await req('POST', '/api/firme/servicii/' + srvId, { cookie: cPat, body: { accept: true } })).status, 403);
        eq('nici un tert nu poate raspunde -> 403',
          (await req('POST', '/api/firme/servicii/' + srvId, { cookie: cTert, body: { accept: true } })).status, 403);

        // contabilul refuza -> nu primeste acces
        const cs2 = await req('POST', '/api/firme/servicii/' + srvId, { cookie: cCon, body: { accept: false } });
        ok('contabilul refuza', cs2.status === 200 && cs2.json.status === 'refuzata');
        eq('cererea rezolvata nu se mai poate decide', (await req('POST', '/api/firme/servicii/' + srvId, { cookie: cCon, body: { accept: true } })).status, 404);

        // acceptarea da accesul — pe o firma la care contabilul NU avea acces
        // contul creat prin inscriere nu are CNP: firmele PROPRII cer o persoana identificata
        eq('fara CNP, patronul nu-si mai poate inscrie o firma -> 400',
          (await req('POST', '/api/firme', { cookie: cPat, body: { nume: 'A DOUA A PATRONULUI SRL', cui: '5550048' } })).status, 400);
        await req('POST', '/api/profile', { cookie: cPat, body: { profil: { cnp: '2900202526344' } } });
        const f2Pat = (await req('POST', '/api/firme', { cookie: cPat, body: { nume: 'A DOUA A PATRONULUI SRL', cui: '5550048' } }));
        ok('cu CNP completat, patronul isi mai inscrie o firma', f2Pat.status === 200);
        const fid2 = f2Pat.json.firma.id;
        const cs3 = await req('POST', '/api/firme/servicii', { cookie: cPat, body: { firmaId: fid2, contabilId: conId } });
        eq('cerere pe a doua firma', cs3.status, 200);
        const srv2 = (await req('GET', '/api/firme/servicii', { cookie: cCon })).json.primite[0].id;
        ok('contabilul NU avea acces inainte de acceptare',
          !(await req('GET', '/api/firme', { cookie: cCon })).json.firme.some((f) => f.id === fid2));
        ok('contabilul accepta', (await req('POST', '/api/firme/servicii/' + srv2, { cookie: cCon, body: { accept: true } })).json.status === 'acceptata');
        ok('...si abia acum are firma', (await req('GET', '/api/firme', { cookie: cCon })).json.firme.some((f) => f.id === fid2));

        // retragerea: doar cel care a trimis
        const cs4 = await req('POST', '/api/firme/servicii', { cookie: cPat, body: { firmaId: fidP, contabilId: conId } });
        eq('patronul retrimite pe prima firma', cs4.status, 200);
        eq('contabilul NU poate retrage cererea patronului -> 403',
          (await req('POST', '/api/firme/servicii/' + cs4.json.id + '/retrage', { cookie: cCon })).status, 403);
        ok('patronul o retrage', (await req('POST', '/api/firme/servicii/' + cs4.json.id + '/retrage', { cookie: cPat })).json.status === 'retrasa');
        eq('dupa retragere contabilul nu mai vede cererea', (await req('GET', '/api/firme/servicii', { cookie: cCon })).json.primite.length, 0);

        // iesirea din lista opreste cererile noi
        await req('POST', '/api/profile', { cookie: cCon, body: { profil: { disponibilContabil: false } } });
        eq('contabilul iesit din lista nu mai apare', (await req('GET', '/api/firme/contabili', { cookie: cPat })).json.contabili.length, 0);
        eq('...si nu mai poate primi cereri -> 404',
          (await req('POST', '/api/firme/servicii', { cookie: cPat, body: { firmaId: fidP, contabilId: conId } })).status, 404);
        eq('demo nu vede lista de contabili', (await req('GET', '/api/firme/contabili', { cookie: cDemo })).status, 403);
      }

      // ── CONT DE CONTABIL: inscriere FARA firma ──
      // Inscrierile de mai jos vin de pe ALTE IP-uri (X-Forwarded-For; serverul il crede doar de
      // pe loopback, adica exact cazul suitei), ca sa nu consume bugetul de 5/ora al IP-ului
      // implicit — pe care il verifica aserțiunea de mai jos. Utilizatori diferiti, retele
      // diferite: realist, nu o ocolire a plafonului. Merge si `X-Forwarded-Proto: https`, fiindca
      // odata ce cererea nu mai vine de pe loopback intra sub garda CONTAB_FORCE_HTTPS — exact
      // perechea de anteturi pe care o pune nginx in productie.
      // Patronul vine cu firma lui; contabilul vine sa tina contabilitatea altora, deci n-are ce
      // firma sa inscrie. A-l obliga sa inventeze una ar fi produs exact dublurile impotriva
      // carora e construita poarta pe CUI.
      const conNou = await req('POST', '/api/register', { headers: { Origin: BASE, 'X-Forwarded-For': '10.0.0.11', 'X-Forwarded-Proto': 'https' }, body: { tipCont: 'contabil', username: 'contabil-fara-t', password: 'ParolaBuna2026' } });
      eq('contabilul se inscrie FARA denumire de firma -> 200', conNou.status, 200);
      ok('raspunsul spune ca nu s-a creat nicio firma', conNou.json.firma === null && conNou.json.faraFirma === true);
      ok('contul chiar nu are firme', (conNou.json.user.firme || []).length === 0);
      // felul contului se stocheaza si ajunge la client: interfata ii ofera patronului formularul
      // de inscriere a unei firme proprii, iar contabilului cererea de acces
      eq('contul de contabil e marcat ca atare', conNou.json.user.tipCont, 'contabil');
      eq('...iar cel care si-a inscris firma e patron', (await req('GET', '/api/me', { cookie: patron.cookie })).json.tipCont, 'patron');
      eq('...si lista lui de firme e goala', (await req('GET', '/api/firme', { cookie: conNou.cookie })).json.firme.length, 0);
      ok('inscris CA SI CONTABIL, apare in lista pe care o vad patronii',
        (await req('GET', '/api/firme/contabili', { cookie: patron.cookie })).json.contabili.some((c) => c.username === 'contabil-fara-t'));
      // starea contului: fara firma NU inseamna proba expirata
      const meCon = (await req('GET', '/api/me', { cookie: conNou.cookie })).json;
      ok('contul fara firma e marcat `faraFirma`, nu `subExpirat`', meCon.faraFirma === true && meCon.subExpirat === false);
      const mePat = (await req('GET', '/api/me', { cookie: patron.cookie })).json;
      ok('patronul, care ARE firma, nu e marcat faraFirma', mePat.faraFirma === false);
      // /api/me e PUBLIC (isi ia singur utilizatorul din sesiune), deci `req.user` nu e pus de
      // middleware. `activeId(req)` cadea atunci pe ramura de admin si raporta abonamentul PRIMEI
      // firme din toata baza — a altcuiva. Aserțiunea fixeaza ca starea e a firmei UTILIZATORULUI.
      ok('/api/me raporteaza abonamentul firmei PROPRII, nu al primei firme din baza',
        mePat.firmaSub && mePat.firmaSub.plan === 'trial');
      ok('...iar contul fara firma nu mosteneste abonamentul altcuiva',
        meCon.firmaSub && meCon.firmaSub.status === 'none' && !meCon.firmaSub.plan);
      // bifa se poate refuza explicit la inscriere
      const conAscuns = await req('POST', '/api/register', { headers: { Origin: BASE, 'X-Forwarded-For': '10.0.0.12', 'X-Forwarded-Proto': 'https' }, body: { tipCont: 'contabil', disponibilContabil: false, username: 'contabil-ascuns-t', password: 'ParolaBuna2026' } });
      eq('al doilea cont de contabil se creeaza', conAscuns.status, 200);
      ok('cine refuza bifa NU apare in lista',
        !(await req('GET', '/api/firme/contabili', { cookie: patron.cookie })).json.contabili.some((c) => c.username === 'contabil-ascuns-t'));
      // patronul ramane obligat sa dea denumirea firmei
      eq('inscrierea de patron FARA denumire de firma e refuzata -> 400',
        (await req('POST', '/api/register', { headers: { Origin: BASE, 'X-Forwarded-For': '10.0.0.13', 'X-Forwarded-Proto': 'https' }, body: { username: 'patron-fara-nume-t', password: 'ParolaBuna2026' } })).status, 400);

    }
    // repunem firma pe expirat-cu-o-proba, ca restul testelor (abonarea) sa continue de unde erau
    await req('POST', '/api/firme/' + tf + '/subscription', { cookie: la.cookie, body: { subscription: { plan: 'trial', trialEndsAt: '2026-01-01T00:00:00Z' } } });
    // abonare pe FIRMA: activeaza abonamentul firmei pe luna curenta + deblocheaza
    const lunaCur = new Date().toISOString().slice(0, 7);
    const sub = await req('POST', '/api/firme/' + tf + '/subscribe', { cookie: c1, body: {} });
    ok('abonare: plan Start (necontabil), luna curenta', sub.json.ok && sub.json.plan === 'start' && sub.json.luna === lunaCur);
    ok('abonare: deschide plata Stripe cand e configurata, altfel activare directa', sub.json.stripe ? (typeof sub.json.url === 'string' && /stripe|checkout/.test(sub.json.url)) : (sub.json.url == null));
    const tfDupa = (await req('GET', '/api/firme', { cookie: c1 })).json.firme.find((f) => f.id === tf);
    ok('firma are abonament ACTIV (Start) + nota lunii', tfDupa._sub.status === 'active' && tfDupa.subscription.plan === 'start' && tfDupa.subscription.abonamente[lunaCur] === 'start');
    eq('dupa abonare: scrierea functioneaza din nou', (await req('POST', '/api/partners', { cookie: c1, body: { cui: 'RO903', den: 'Deblocat' } })).status, 200);
    ok('abonare respinsa pe firma straina -> 403', [403, 404].includes((await req('POST', '/api/firme/2/subscribe', { cookie: c1, body: {} })).status));
    await req('POST', '/api/firme/1/activate', { cookie: c1 }); // curatenie: revin pe firma 1

    // ── RESETARE PAROLA (token seed-uit: valabil + expirat; fara dependenta de SMTP) ──
    const TOK_OK = 'tok-resetare-valida';
    const generic1 = await req('POST', '/api/forgot-password', { body: { login: 'nu-exista-deloc' } });
    const generic2 = await req('POST', '/api/forgot-password', { body: { login: 'user1' } });
    ok('forgot: raspuns identic pentru cont inexistent si cont real (fara enumerare)', generic1.status === 200 && generic2.status === 200 && generic1.text === generic2.text);
    // rate limit (5/ora pe IP): peste plafon raspunsul ramane TOT generic — anti-enumerarea
    // se pastreaza si sub limitare (doar trimiterea de email se opreste, neobservabil din exterior)
    let genericLimited = null;
    for (let k = 0; k < 6; k++) genericLimited = await req('POST', '/api/forgot-password', { body: { login: 'user1' } });
    ok('forgot: peste plafon, raspunsul ramane generic (fara enumerare)', genericLimited.status === 200 && genericLimited.text === generic1.text);
    eq('reset: token expirat -> 404', (await req('GET', '/api/reset/tok-resetare-expirata')).status, 404);
    eq('reset: token inexistent -> 404', (await req('GET', '/api/reset/complet-gresit')).status, 404);
    const rTok = await req('GET', '/api/reset/' + TOK_OK);
    ok('reset: token valabil -> identitatea contului', rTok.status === 200 && rTok.json.username === 'resetme');
    eq('reset accept: parola slaba respinsa (400)', (await req('POST', '/api/reset/accept', { body: { token: TOK_OK, password: 'scurt' } })).status, 400);
    const lOld = await req('POST', '/api/login', { body: { username: 'resetme', password: 'parola1' } });
    ok('resetme: sesiune veche activa inainte de reset', lOld.status === 200 && (await req('GET', '/api/me', { cookie: lOld.cookie })).status === 200);
    const acc = await req('POST', '/api/reset/accept', { body: { token: TOK_OK, password: 'parola-noua-9' } });
    ok('reset accept: reusit + autentificare directa', acc.status === 200 && acc.json.ok && /^sid=/.test(acc.cookie));
    eq('reset accept: tokenul e consumat (refolosire -> 404)', (await req('POST', '/api/reset/accept', { body: { token: TOK_OK, password: 'alta-parola-9' } })).status, 404);
    eq('dupa reset: sesiunile vechi sunt deconectate', (await req('GET', '/api/me', { cookie: lOld.cookie })).status, 401);
    eq('dupa reset: parola veche nu mai merge', (await req('POST', '/api/login', { body: { username: 'resetme', password: 'parola1' } })).status, 401);
    ok('dupa reset: parola noua merge', (await req('POST', '/api/login', { body: { username: 'resetme', password: 'parola-noua-9' } })).json.ok === true);

    // ── IMPERSONARE (admin intra pe cont de user; sesiune de admin dedicata) ──
    const cImp = (await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } })).cookie;
    eq('impersonare: non-admin -> 403', (await req('POST', '/api/impersonate', { cookie: c1, body: { userId: 3 } })).status, 403);
    eq('impersonare: tinta inexistenta -> 404', (await req('POST', '/api/impersonate', { cookie: cImp, body: { userId: 999 } })).status, 404);
    eq('impersonare: propriul cont -> 400', (await req('POST', '/api/impersonate', { cookie: cImp, body: { userId: 1 } })).status, 400);
    eq('impersonare: alt admin -> 400', (await req('POST', '/api/impersonate', { cookie: cImp, body: { userId: 8 } })).status, 400);
    const impR = await req('POST', '/api/impersonate', { cookie: cImp, body: { userId: 2 } });
    ok('impersonare pornita: raspunde cu userul tinta', impR.status === 200 && impR.json.user.username === 'user1');
    const meImp = await req('GET', '/api/me', { cookie: cImp });
    ok('/api/me sub impersonare: identitatea tintei + insigna adminului real', meImp.json.username === 'user1' && meImp.json.impersonating && meImp.json.impersonating.adminName === 'admin');
    eq('sub impersonare: rutele de admin raman blocate (403)', (await req('GET', '/api/users', { cookie: cImp })).status, 403);
    eq('comutare directa pe alta tinta (adminul real detine sesiunea)', (await req('POST', '/api/impersonate', { cookie: cImp, body: { userId: 3 } })).status, 200);
    // regresie: userId 3 are firma EXPIRATA — paywall-ul (402) nu are voie sa blocheze iesirea
    const stop = await req('POST', '/api/impersonate/stop', { cookie: cImp });
    ok('oprire impersonare (chiar de pe firma expirata): revii adminul', stop.status === 200 && stop.json.user.username === 'admin');
    eq('oprire fara impersonare activa -> 400', (await req('POST', '/api/impersonate/stop', { cookie: cImp })).status, 400);
    ok('auditul de sistem consemneaza impersonarea', (await req('GET', '/api/audit/system', { cookie: cImp })).json.some((a) => a.action === 'impersonate.start'));

    // ── „Cine acceseaza aplicatia" (admin): sesiuni active + autentificari, cu IP si locatie ──
    // Testat AICI, nu in test/run.js: `raport()` e async, iar suita aceea e sincrona — o aserttiune
    // asincrona pusa acolo NU se numara si nu poate pica (verificat prin mutatie: o valoare sigur
    // gresita trecea cu „0 esuate"). Un test care nu poate pica e mai rau decat lipsa lui.
    {
      // Sesiune proprie de admin, nu una imprumutata din blocul de impersonare de mai sus:
      // testul nu trebuie sa depinda de starea in care a lasat-o alt scenariu.
      const cAdmin = (await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } })).cookie;
      eq('access-log: non-admin -> 403', (await req('GET', '/api/access-log', { cookie: c1 })).status, 403);
      eq('access-log: fara sesiune -> 401', (await req('GET', '/api/access-log')).status, 401);

      // Autentificare ESUATA, apoi una reusita, de pe acelasi client: ambele trebuie sa apara.
      await req('POST', '/api/login', { body: { username: 'admin', password: 'parola-gresita-deliberat' } });
      await req('POST', '/api/login', { body: { username: 'nu-exista-contul-asta', password: 'orice' } });

      const al = await req('GET', '/api/access-log', { cookie: cAdmin });
      eq('access-log: admin -> 200', al.status, 200);
      ok('raportul are ambele tabele', Array.isArray(al.json.sesiuni) && Array.isArray(al.json.autentificari));
      ok('sesiunile active includ adminul conectat', al.json.sesiuni.some((s) => s.username === 'admin'));
      const oSes = al.json.sesiuni.find((s) => s.username === 'admin');
      ok('...cu IP, dispozitiv si momentele accesului', 'ip' in oSes && 'dispozitiv' in oSes
        && !!oSes.creata && !!oSes.ultimaActivitate && typeof oSes.online === 'boolean');
      ok('fiecare rand poarta campul de locatie', al.json.sesiuni.every((s) => 'locatie' in s)
        && al.json.autentificari.every((s) => 'locatie' in s));

      const esecuri = al.json.autentificari.filter((x) => !x.reusita);
      ok('incercarea cu parola gresita e consemnata', esecuri.some((x) => x.username === 'admin'));
      ok('...si cea pe un cont inexistent', esecuri.some((x) => x.username === 'nu-exista-contul-asta'));
      ok('contul inexistent NU primeste userId (nu se confirma ca exista)',
        esecuri.filter((x) => x.username === 'nu-exista-contul-asta').every((x) => x.userId == null));
      ok('autentificarile reusite sunt si ele in lista', al.json.autentificari.some((x) => x.reusita));
      ok('PAROLA incercata nu apare NICAIERI in raport',
        !JSON.stringify(al.json).includes('parola-gresita-deliberat'));

      // ── Al treilea tabel: TOATE adresele care ating site-ul, nu doar cele care ajung in cont.
      // Cererile suitei vin de pe bucla locala, care e EXCLUSA deliberat (nginx + sondele proprii),
      // deci tabelul e gol aici — si asta e tocmai proba ca filtrul chiar taie. Continutul se
      // verifica prin acumulatorul injectat, unde IP-urile pot fi publice.
      ok('raportul are si tabelul de vizitatori', Array.isArray(al.json.vizitatori));
      ok('bucla locala NU ajunge in tabelul de vizitatori (altfel suita insasi l-ar umple)',
        al.json.vizitatori.every((v) => !/^(127\.|::1|10\.|192\.168\.)/.test(v.ip)));

      const visStub = {
        snapshot: () => [
          { ip: '86.124.1.1', prima: '2026-08-02T08:00:00.000Z', ultima: '2026-08-02T09:00:00.000Z', cereri: 34, pagini: 3, ultimaCale: '/prezentare.html', ua: 'Mozilla/5.0 Chrome/120', bot: false, useri: [] },
          { ip: '66.249.66.1', prima: '2026-08-02T07:00:00.000Z', ultima: '2026-08-02T07:30:00.000Z', cereri: 12, pagini: 12, ultimaCale: '/robots.txt', ua: 'Googlebot/2.1', bot: true, useri: [] },
        ],
      };
      const cuVis = await require('../src/accessService').raport(require('../src/db').get(), {
        visitors: visStub,
        geo: { lookupMany: async (ips) => new Map(ips.map((ip) => [ip, { oras: 'X', taraCod: 'RO' }])), eticheta: (g) => (g ? g.oras + ', ' + g.taraCod : '') },
      });
      eq('vizitatorii ajung in raport', cuVis.vizitatori.length, 2);
      ok('...cu numaratoarea de pagini SEPARATA de cea de cereri',
        cuVis.vizitatori[0].pagini === 3 && cuVis.vizitatori[0].cereri === 34);
      ok('...cu robotul marcat', cuVis.vizitatori.some((v) => v.bot === true));
      ok('...si cu localizare, ca celelalte tabele', cuVis.vizitatori.every((v) => v.locatie === 'X, RO'));
      eq('totalul real e raportat', cuVis.vizitatoriTotal, 2);

      const doarE = await req('GET', '/api/access-log?esuate=1', { cookie: cAdmin });
      ok('filtrul ?esuate=1 intoarce numai esecuri', doarE.json.autentificari.length > 0
        && doarE.json.autentificari.every((x) => x.reusita === false));

      // IP-ul de test e loopback, deci NU pleaca la niciun serviciu extern: locatia ramane goala.
      // Asta e si proba ca garda de adrese private chiar taie inaintea retelei — suita nu are voie
      // sa depinda de un tert ca sa treaca.
      ok('IP privat -> nicio localizare (si niciun apel extern)',
        al.json.autentificari.every((x) => x.locatie === ''));

      // Raportul insusi, cu un furnizor de geo INJECTAT: dovedeste ca localizarea chiar se lipeste
      // pe randuri si ca o cadere a furnizorului nu rupe raportul.
      const accSvc = require('../src/accessService');
      const dLive = require('../src/db').get();
      const cuGeo = await accSvc.raport(dLive, {
        geo: {
          lookupMany: async (ips) => new Map(ips.map((ip) => [ip, { oras: 'Cluj-Napoca', taraCod: 'RO' }])),
          eticheta: (g) => (g ? g.oras + ', ' + g.taraCod : ''),
        },
      });
      ok('cu geo disponibil: eticheta ajunge pe randuri',
        cuGeo.sesiuni.length > 0 && cuGeo.sesiuni.every((s) => s.locatie === 'Cluj-Napoca, RO'));
      ok('...si se raporteaza ca disponibil', cuGeo.geoDisponibil === true);

      const geoCazut = await accSvc.raport(dLive, {
        geo: { lookupMany: async () => { throw new Error('serviciu cazut'); }, eticheta: () => '' },
      });
      ok('furnizor CAZUT: raportul se intoarce oricum', Array.isArray(geoCazut.sesiuni) && geoCazut.sesiuni.length > 0);
      ok('...marcat explicit ca indisponibil, nu tacut', geoCazut.geoDisponibil === false);
    }

    // ── 2FA / TOTP: setup -> enable -> login in doi pasi -> disable (cap-coada) ──
    const c2f = (await req('POST', '/api/login', { body: { username: 'doifa', password: 'parola1' } })).cookie;
    const setup = await req('POST', '/api/2fa/setup', { cookie: c2f });
    ok('2fa setup: secret + otpauth + QR', setup.json.secret && /^otpauth:\/\/totp\//.test(setup.json.otpauth) && /<svg/.test(setup.json.qrSvg));
    const codeNow = () => totp.codeForCounter(setup.json.secret, Math.floor(Date.now() / 1000 / 30));
    eq('2fa enable: cod gresit -> 400', (await req('POST', '/api/2fa/enable', { cookie: c2f, body: { code: '000000' } })).status, 400);
    ok('2fa enable: cod corect -> activat', (await req('POST', '/api/2fa/enable', { cookie: c2f, body: { code: codeNow() } })).json.ok === true);
    const lNoCode = await req('POST', '/api/login', { body: { username: 'doifa', password: 'parola1' } });
    ok('login cu 2FA: parola corecta fara cod -> cere codul, FARA sesiune', lNoCode.status === 200 && lNoCode.json.twofa === true && !/^sid=/.test(lNoCode.cookie));
    eq('login cu 2FA: cod gresit -> 401', (await req('POST', '/api/login', { body: { username: 'doifa', password: 'parola1', code: '000000' } })).status, 401);
    const lCode = await req('POST', '/api/login', { body: { username: 'doifa', password: 'parola1', code: codeNow() } });
    ok('login cu 2FA: parola + cod -> sesiune', lCode.status === 200 && lCode.json.ok && /^sid=/.test(lCode.cookie));
    eq('2fa disable: cod gresit -> 400', (await req('POST', '/api/2fa/disable', { cookie: lCode.cookie, body: { code: '000000' } })).status, 400);
    ok('2fa disable: cod corect -> dezactivat', (await req('POST', '/api/2fa/disable', { cookie: lCode.cookie, body: { code: codeNow() } })).json.ok === true);
    ok('dupa dezactivare: login simplu functioneaza din nou', (await req('POST', '/api/login', { body: { username: 'doifa', password: 'parola1' } })).json.ok === true);

    // ── BACKUP / RESTORE COMPLET (admin, src/routes/backup.js): rutele care suprascriu TOATA baza ──
    const cAdm = la.cookie;
    eq('backup: non-admin -> 403', (await req('POST', '/api/backup', { cookie: c1 })).status, 403);
    eq('restore: non-admin -> 403', (await req('POST', '/api/restore', { cookie: c1 })).status, 403);
    eq('lista backup: non-admin -> 403', (await req('GET', '/api/backups', { cookie: c1 })).status, 403);
    // marker "inainte": intra in snapshot si trebuie sa supravietuiasca restaurarii
    await req('POST', '/api/partners', { cookie: cAdm, body: { cui: 'RO-SNAP-1', den: 'Inainte de snapshot' } });
    const bk = await req('POST', '/api/backup', { cookie: cAdm });
    ok('backup: creat, nume datat db-*.json', bk.json && bk.json.ok && /^db-.*\.json$/.test(bk.json.file));
    const bkList = await req('GET', '/api/backups', { cookie: cAdm });
    ok('backup: apare in lista + lastAt setat', bkList.json && bkList.json.lastAt && bkList.json.list.some((b) => b.name === bk.json.file));
    const auto0 = await req('POST', '/api/backups/auto', { cookie: cAdm, body: { auto: false } });
    ok('backup auto: comutat pe oprit', auto0.json.ok && (await req('GET', '/api/backups', { cookie: cAdm })).json.auto === false);
    await req('POST', '/api/backups/auto', { cookie: cAdm, body: { auto: true } }); // curatenie: la loc
    const snap = await req('GET', '/api/backup/file/' + bk.json.file, { cookie: cAdm });
    ok('backup: fisierul se descarca si e un JSON de baza valid', snap.status === 200 && (() => { try { const j = JSON.parse(snap.text); return Array.isArray(j.firme) && Array.isArray(j.users); } catch (_) { return false; } })());
    eq('backup: traversarea de cale respinsa (404)', (await req('GET', '/api/backup/file/..%2F..%2Fdb.json', { cookie: cAdm })).status, 404);
    eq('backup: nume in afara tiparului db-*.json respins (404)', (await req('GET', '/api/backup/file/evil.txt', { cookie: cAdm })).status, 404);

    // ── Drill de restaurare NATIVA PostgreSQL (la cerere) ──
    eq('drill nativ PG: non-admin -> 403', (await req('POST', '/api/pg-restore-drill', { cookie: c1 })).status, 403);
    eq('drill nativ PG: fara nicio arhiva completa -> 400 explicit',
      (await req('POST', '/api/pg-restore-drill', { cookie: cAdm })).status, 400);
    // Cu o arhiva reala prezenta: suita ruleaza pe sqlite/json, deci arhiva NU contine contab.sql
    // si drill-ul trebuie sa se SARA curat, cu motivul scris. Un pas care nu poate rula n-are voie
    // sa raporteze esec — altfel alerta zilnica ar tipa pe fiecare instalare care nu e pe pg.
    require('../src/backup').fullBackup(DBF, DATA_TMP, 3);
    const pgd = await req('POST', '/api/pg-restore-drill', { cookie: cAdm });
    eq('drill nativ PG: raspunde 200 cand exista arhiva', pgd.status, 200);
    ok('drill nativ PG: „nu se aplica" CU MOTIV (fara contab.sql pe sqlite), nu esec tacut',
      pgd.json.sarit === true && /contab\.sql/i.test(pgd.json.motiv || ''));
    ok('drill nativ PG: nu pretinde ca a reusit', pgd.json.ok === false);
    // Distinctia care conteaza: „nu se aplica" (sqlite) tace; „nu pot verifica" (exista dump, dar
    // lipseste psql / dreptul CREATEDB) NU are voie sa taca — altfel absenta verificarii ar trece
    // drept verificare trecuta, exact tiparul de monitorizare oarba de care s-a mai lovit proiectul.
    ok('drill nativ PG: pe sqlite nu e marcat „neverificabil"', !pgd.json.neverificabil);
    ok('drill nativ PG: spune pe ce arhiva a lucrat', /^full-.*\.zip$/.test(pgd.json.arhiva || ''));
    // `firmaId: null` in logAudit NU produce o intrare de sistem cand exista `req` (helperul cade
    // pe firma activa a celui autentificat) — la fel ca restul operatiunilor de backup.
    ok('drill nativ PG: consemnat in audit, cu rezultatul',
      (await req('GET', '/api/audit', { cookie: cAdm })).json.some((a) => a.action === 'backup.pg-drill' && /SARIT|OK|ESUAT/.test(a.detail || '')));

    // Lansarea de procese externe a trecut de la spawnSync la execFile (bucla nu mai asteapta
    // subprocesul — drill-ul e declansabil dintr-o ruta de admin). Drumul de mai sus se opreste
    // la „sarit" pe o arhiva sqlite, fara sa atinga psql, deci noul `run` ramanea neexercitat.
    // toolAvailable il foloseste direct si acopera AMBELE iesiri, fara sa ceara PostgreSQL.
    const drillMod = require('../src/pgRestoreDrill');
    // `node`, nu `sh`: toolAvailable ruleaza `<bin> --version` si cere cod 0, iar dash (/bin/sh
    // pe Debian) nu cunoaste --version si iese non-zero — ar fi fost un fals esec al testului.
    const tAre = drillMod.toolAvailable('node');
    ok('toolAvailable intoarce o PROMISIUNE (lansarea nu mai e sincrona)', typeof tAre.then === 'function');
    ok('toolAvailable: comanda existenta -> true', (await tAre) === true);
    ok('toolAvailable: comanda inexistenta -> false (nu arunca)',
      (await drillMod.toolAvailable('contab-comanda-inexistenta-xyz')) === false);

    // Starea cozii de persistenta + marginea fata de plafonul pm2, in /api/metrics
    const mx = (await req('GET', '/api/metrics', { cookie: cAdm })).json;
    ok('metrics: coada de persistenta e expusa cu contract complet',
      mx.persist && typeof mx.persist.pending === 'boolean' && typeof mx.persist.pendingAgeMs === 'number' && typeof mx.persist.commits === 'number');
    ok('metrics: driverul cozii e cel real', mx.persist.driver === (process.env.CONTAB_TEST_DRIVER || 'sqlite'));
    // CE COD RULEAZA. Aici se verifica INTEGRAREA (git chiar se lanseaza si raspunde); verdictul
    // pe fiecare caz e in test/run.js, pe iesiri inventate. Suita ruleaza din depozit, deci
    // `cunoscut` trebuie sa fie true — daca ar fi false, tocmai ar arata ca citirea nu merge.
    // NU se afirma `curat`: in timpul dezvoltarii arborele e normal sa fie murdar.
    // ── ERORI DIN CLIENT ── ruta PUBLICA: o eroare pe ecranul de login e exact cea care altfel
    // nu se afla. Se verifica aici capatul care conteaza: ca nu cere sesiune, ca ajunge in
    // metrici agregata, si ca nu poate fi folosita nici pentru scurgeri, nici pentru impersonare.
    const ce = (body, opts) => req('POST', '/api/client-error', Object.assign({ body }, opts || {}));
    eq('client-error: merge FARA sesiune (altfel erorile de pe login ar ramane invizibile)',
      (await ce({ msg: 'crapat pe login', sursa: 'authui.js:10:1' })).status, 204);
    await ce({ msg: 'crapat pe login', sursa: 'authui.js:10:1' });
    await ce({ msg: 'crapat pe login', sursa: 'authui.js:10:1' });
    // SCURGERE: tokenul de resetare traieste in interogare (`/?reset=<token>`)
    await ce({ msg: 'pe resetare', cale: '/?reset=TOKEN-SECRET-HTTP', sursa: 'core.js?v=TOKEN-SECRET-HTTP:1:1' });
    // IMPERSONARE: identitatea trebuie sa vina din sesiune, nu din corp
    await ce({ msg: 'pretinde ca e admin', username: 'admin' });

    const mx2 = (await req('GET', '/api/metrics', { cookie: cAdm })).json;
    const cel = (m) => (mx2.clientErrors || []).find((x) => x.msg === m);
    ok('client-error: ajunge in /api/metrics', Array.isArray(mx2.clientErrors) && !!cel('crapat pe login'));
    eq('client-error: trei raportari identice se AGREGA intr-una singura', cel('crapat pe login').n, 3);
    ok('client-error: tokenul de resetare NU ajunge in metrici',
      !/TOKEN-SECRET-HTTP/.test(JSON.stringify(mx2.clientErrors)));
    ok('client-error: username-ul din corp e ignorat (fara sesiune, lista de utilizatori ramane goala)',
      cel('pretinde ca e admin').utilizatori.length === 0
      && !/"admin"/.test(JSON.stringify(cel('pretinde ca e admin').utilizatori)));
    ok('client-error: NU intra in erorile de server (nu e caderea noastra, n-are ce cauta in alerta 5xx)',
      !(mx2.recentErrors || []).some((e) => /crapat pe login/.test(e.msg)));

    // Plafonul pe IP: peste el raspunsul ramane 204 (un 429 ar impinge clientul sa reincerce),
    // dar raportarea nu se mai inregistreaza. Se epuizeaza la final — nicio alta proba nu
    // foloseste ruta, deci nu deranjeaza restul suitei.
    for (let i = 0; i < 40; i++) await ce({ msg: 'inundatie ' + i, sursa: 'f.js:' + i });
    const mx3 = (await req('GET', '/api/metrics', { cookie: cAdm })).json;
    eq('client-error: peste plafon raspunde tot 204 (nu 429)', (await ce({ msg: 'dupa plafon' })).status, 204);
    ok('client-error: peste plafon nu se mai inregistreaza nimic',
      !(mx3.clientErrors || []).some((x) => x.msg === 'dupa plafon'));
    ok('client-error: inelul ramane plafonat chiar si sub inundatie', (mx3.clientErrors || []).length <= 25);

    ok('metrics: starea codului e expusa cu contract complet',
      mx.deploy && typeof mx.deploy.cunoscut === 'boolean' && 'curat' in mx.deploy
      && 'ramura' in mx.deploy && typeof mx.deploy.nrModificate === 'number' && Array.isArray(mx.deploy.modificate));
    ok('metrics: git chiar a raspuns (suita ruleaza dintr-un depozit)',
      mx.deploy.cunoscut === true && !!mx.deploy.ramura && !!mx.deploy.commit);
    ok('metrics: verdictul e coerent cu numarul de fisiere raportate',
      mx.deploy.curat === (mx.deploy.nrModificate === 0 && mx.deploy.peRamuraDeDeploy === true));
    ok('metrics: cand nu e curat, motivul e scris', mx.deploy.curat === true || !!mx.deploy.motiv);
    ok('metrics: marginea fata de plafonul pm2 e vizibila',
      mx.process.memoryLimitMb > 0 && mx.process.memoryWarnMb > 0 && mx.process.memoryWarnMb < mx.process.memoryLimitMb
      && typeof mx.process.memoryPctDinPlafon === 'number');
    // Lag-ul buclei — masurat pe un server REAL, care a servit deja sute de cereri. Traducerea
    // histogramei e verificata sincron in test/run.js (cu histograme inventate); aici se apara
    // integrarea: ca masura chiar ajunge in raspuns si ca valorile sunt plauzibile, nu gunoiul
    // pe care histograma il intoarce fara mostre (percentile()=511, min=2^63).
    ok('metrics: lagul buclei e expus cu contract complet',
      mx.lag && typeof mx.lag.p50Ms === 'number' && typeof mx.lag.p99Ms === 'number'
      && typeof mx.lag.maxMs === 'number' && typeof mx.lag.maxTotalMs === 'number'
      && typeof mx.lag.fereastraSec === 'number');
    ok('metrics: lagul e in milisecunde plauzibile, nu valorile-gunoi ale histogramei',
      mx.lag.p50Ms >= 0 && mx.lag.p50Ms < 1000 && mx.lag.maxMs >= 0 && mx.lag.p99Ms >= mx.lag.p50Ms);
    ok('metrics: pragul de alerta calatoreste cu masura (altfel cifra nu se poate interpreta)',
      mx.lag.pragMs > 0 && mx.lag.rezolutieMs > 0);
    // Jurnalul de audit DURABIL. Pe un server care a servit deja sute de cereri autentificate,
    // scrierile trebuie sa fi REUSIT — daca aici ar aparea esecuri, tocmai s-ar fi demonstrat
    // problema pe care contorul o face vizibila.
    ok('metrics: starea jurnalului durabil e expusa cu contract complet',
      mx.audit && typeof mx.audit.scrise === 'number' && typeof mx.audit.esecuri === 'number'
      && typeof mx.audit.esecConsecutive === 'number' && 'lastError' in mx.audit && 'lastOkAt' in mx.audit);
    ok('metrics: jurnalul chiar s-a scris in timpul suitei (nu e un contor mort)', mx.audit.scrise > 0);
    ok('metrics: fara esecuri de scriere in jurnal pe parcursul suitei',
      mx.audit.esecuri === 0 && mx.audit.esecConsecutive === 0);
    // restaurare: validarea refuza gunoiul INAINTE sa atinga baza
    const fdBadJson = new FormData();
    fdBadJson.append('file', new Blob(['nu e json'], { type: 'application/json' }), 'stricat.json');
    eq('restore: fisier ne-JSON -> 400', (await req('POST', '/api/restore', { cookie: cAdm, body: fdBadJson })).status, 400);
    const fdNotDb = new FormData();
    fdNotDb.append('file', new Blob([JSON.stringify({ altceva: 1 })], { type: 'application/json' }), 'altceva.json');
    eq('restore: JSON care nu e baza Contabo -> 400', (await req('POST', '/api/restore', { cookie: cAdm, body: fdNotDb })).status, 400);
    // partenerii sunt un obiect indexat pe CUI, nu un array
    const dens = async () => Object.values((await req('GET', '/api/partners', { cookie: cAdm })).json || {}).map((p) => p.den);
    ok('restore respins: baza e neatinsa (markerul exista)', (await dens()).includes('Inainte de snapshot'));
    // round-trip: mutatie DUPA snapshot -> restaurare -> mutatia dispare, markerul ramane
    await req('POST', '/api/partners', { cookie: cAdm, body: { cui: 'RO-DUPA-1', den: 'Dupa snapshot' } });
    ok('mutatia de dupa snapshot exista inainte de restaurare', (await dens()).includes('Dupa snapshot'));
    const fdSnap = new FormData();
    fdSnap.append('file', new Blob([snap.text], { type: 'application/json' }), 'db.json');
    const rst = await req('POST', '/api/restore', { cookie: cAdm, body: fdSnap });
    ok('restore: reusit', rst.status === 200 && rst.json && rst.json.ok);
    // sesiunea era in snapshot (users[].sessions), deci cookie-ul admin ramane valabil dupa restaurare
    ok('dupa restaurare: sesiunea din snapshot e valabila', (await req('GET', '/api/me', { cookie: cAdm })).status === 200);
    const densAfter = await dens();
    ok('dupa restaurare: starea e cea din snapshot (markerul exista)', densAfter.includes('Inainte de snapshot'));
    ok('dupa restaurare: mutatia de dupa snapshot A DISPARUT', !densAfter.includes('Dupa snapshot'));
    ok('restore: backup de siguranta creat automat inainte de inlocuire', (await req('GET', '/api/backups', { cookie: cAdm })).json.list.length >= 1);

    // ── METRICI DE PERFORMANTA (admin): duratele pe ruta se aduna din mers ──
    eq('metrici: non-admin -> 403', (await req('GET', '/api/metrics', { cookie: c1 })).status, 403);
    const met = await req('GET', '/api/metrics', { cookie: cAdm });
    ok('metrici: snapshot cu prag si rute', met.status === 200 && met.json.slowThresholdMs > 0 && Array.isArray(met.json.routes) && met.json.routes.length > 0);
    const mHealth = met.json.routes.find((r) => r.route === '/api/health');
    ok('metrici: /api/health e masurat (n, avgMs, maxMs)', mHealth && mHealth.n >= 1 && mHealth.avgMs >= 0 && mHealth.maxMs >= 0);
    ok('metrici: id-urile sunt normalizate in tipar (nicio ruta cu hex brut)', met.json.routes.every((r) => !/[0-9a-f]{16}/i.test(r.route)));
    ok('metrici: diagnosticele de proces sunt AICI (admin), nu pe health',
      met.json.process && typeof met.json.process.nodeVersion === 'string' && typeof met.json.process.memoryRssMb === 'number'
      && typeof met.json.process.driver === 'string' && typeof met.json.process.users === 'number' && met.json.process.uptimeSec >= 0);
    ok('metrici: erorile recente si joburile sunt expuse', Array.isArray(met.json.recentErrors) && met.json.jobs && typeof met.json.jobs === 'object');
    // distributia per-firma (semnalul pentru partitionare — vezi docs/scalare-crestere.md)
    ok('metrici: firmeLoad cu maxEntries + top pe firma', met.json.firmeLoad
      && typeof met.json.firmeLoad.maxEntries === 'number' && Array.isArray(met.json.firmeLoad.top)
      && met.json.firmeLoad.top.every((f) => typeof f.entries === 'number' && 'nume' in f));
    ok('metrici: contoarele extragerilor AI sunt expuse (n/fail/avgMs)',
      met.json.ai && typeof met.json.ai.n === 'number' && typeof met.json.ai.fail === 'number' && typeof met.json.ai.avgMs === 'number');
    // auditul de business: upload-urile facute mai devreme in suita au urma cu metadate
    const audit = await req('GET', '/api/audit', { cookie: cAdm });
    const upAudit = (audit.json || []).find((a) => a.action === 'document.upload');
    ok('auditul consemneaza upload-ul de document (nume + KB, fara continut)', !!upAudit && /KB\)/.test(upAudit.detail));
    // export CSV al auditului (arhiva/GDPR): antet CSV + coloane; sistemul e admin-only
    const acsv = await req('GET', '/csv/audit', { cookie: cAdm });
    ok('/csv/audit: text/csv cu antetul de coloane', acsv.status === 200 && /Data \(UTC\);Utilizator;Actiune/.test(acsv.text));
    eq('/csv/audit/system: non-admin -> 403', (await req('GET', '/csv/audit/system', { cookie: c1 })).status, 403);
    eq('/csv/audit/system: admin -> 200 CSV', (await req('GET', '/csv/audit/system', { cookie: cAdm })).status, 200);
    // exporturile XML fiscale lasa urma in audit (cine a descarcat ce); PDF/CSV nu (doar log)
    await req('GET', '/xml/d300?period=2026-06', { cookie: c1 });
    await req('GET', '/pdf/balance?period=2026-06', { cookie: c1 });
    const audit2 = (await req('GET', '/api/audit', { cookie: cAdm })).json || [];
    ok('export XML: urma export.xml cu calea si perioada', audit2.some((a) => a.action === 'export.xml' && /d300.*2026-06/.test(a.detail)));
    ok('export PDF: fara intrare in audit (doar in logul structurat)', !audit2.some((a) => a.action === 'export.xml' && /pdf/.test(a.detail)));
    // un backup proaspat isi noteaza lastAt in settings -> apare la joburi ca lastDoneAt
    // (restore-ul din sectiunea anterioara l-a sters: snapshot-ul e copiat INAINTE de setarea lui)
    await req('POST', '/api/backup', { cookie: cAdm });
    const met2 = await req('GET', '/api/metrics', { cookie: cAdm });
    ok('metrici: jobul de backup arata ultima rulare reusita (din settings)',
      met2.json.jobs.backup && typeof met2.json.jobs.backup.lastDoneAt === 'string');

    // ── Preluare firma din alt program (balanta -> solduri) ───────────────
    {
      const laM = await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } });
      const csv = ['Cont;Denumire;Sold final debitor;Sold final creditor',
        '1012;Capital social;0;30.000,00',
        '371;Marfuri;25.000,00;0',
        '401;Furnizori;0;10.000,00',
        '5121;Banca;15.000,00;0'].join('\n');
      const fd = new FormData();
      fd.append('file', new Blob([csv], { type: 'text/csv' }), 'balanta.csv');
      const pv = await req('POST', '/api/migrare/preview', { cookie: laM.cookie, body: fd });
      eq('previzualizarea balantei -> 200', pv.status, 200);
      eq('coloanele sunt mapate automat', pv.json.mapare.cont, 0);
      eq('conturile cu sold sunt preluate', pv.json.preview.conturi.length, 4);
      ok('balanta e echilibrata', pv.json.preview.echilibrata === true && pv.json.preview.totalD === 40000);
      ok('se poate importa', pv.json.preview.sePoateImporta === true);
      // Importul se face intr-o firma PROPRIE: preluarea rescrie soldurile, iar restul suitei
      // lucreaza pe firma existenta. Testeaza in acelasi timp garda de firma explicita.
      const fNoua = await req('POST', '/api/firme', { cookie: laM.cookie, body: { nume: 'PRELUATA SRL', cui: '300008' } });
      const fidNou = fNoua.json && (fNoua.json.firma ? fNoua.json.firma.id : fNoua.json.id);
      ok('firma-tinta pentru preluare a fost creata', !!fidNou);
      const obInainte = (await req('GET', '/api/opening?firma=' + fidNou, { cookie: laM.cookie })).json;
      eq('firma noua porneste fara solduri de preluare', Object.keys(obInainte || {}).length, 0);

      // Import intr-o firma INEXISTENTA -> 403 (fara fallback pe firma activa)
      eq('import in firma inexistenta -> 403',
        (await req('POST', '/api/migrare/import', { cookie: laM.cookie, body: { firmaId: 99999, conturi: [{ cont: '371', d: 1, c: 0 }] } })).status, 403);

      // REGULA DE AUR verificata pe ce se SCRIE, nu pe ce s-a previzualizat
      const dezech = await req('POST', '/api/migrare/import', { cookie: laM.cookie,
        body: { firmaId: fidNou, conturi: [{ cont: '371', d: 100, c: 0 }, { cont: '401', d: 0, c: 50 }], suprascrie: true } });
      eq('balanta dezechilibrata la import -> 400', dezech.status, 400);
      ok('mesajul spune ca refuzul e integral', /refuzat integral/i.test((dezech.json || {}).error || ''));
      // ...si nimic nu s-a scris partial
      const obDupaRefuz = (await req('GET', '/api/opening?firma=' + fidNou, { cookie: laM.cookie })).json;
      ok('refuzul nu lasa date partiale', JSON.stringify(obDupaRefuz) === JSON.stringify(obInainte));

      // Firma are deja solduri -> 409 fara `suprascrie`
      const randuriImp = pv.json.preview.conturi.map((x) => ({ cont: x.cont, d: x.d, c: x.c }));
      const imp = await req('POST', '/api/migrare/import', { cookie: laM.cookie,
        body: { firmaId: fidNou, conturi: randuriImp } });
      eq('importul echilibrat reuseste', imp.status, 200);
      eq('s-au scris cele 4 conturi', imp.json.conturi, 4);
      // A doua preluare peste solduri existente cere `suprascrie` — altfel s-ar pierde tacit date.
      eq('a doua preluare fara `suprascrie` -> 409',
        (await req('POST', '/api/migrare/import', { cookie: laM.cookie, body: { firmaId: fidNou, conturi: randuriImp } })).status, 409);
      const obDupa = (await req('GET', '/api/opening?firma=' + fidNou, { cookie: laM.cookie })).json;
      ok('soldurile preluate se regasesc', obDupa['371'] && obDupa['371'].d === 25000);
      ok('si creditul furnizorului', obDupa['401'] && obDupa['401'].c === 10000);
      // Urma in audit: o preluare de solduri schimba toata contabilitatea firmei
      const aud = (await req('GET', '/api/audit', { cookie: laM.cookie })).json;
      const lst = Array.isArray(aud) ? aud : (aud.items || []);
      ok('preluarea apare in audit', lst.some((a) => a.action === 'migrare.import'));
    }

    // ── GUARD SINGLE-INSTANCE: a doua instanta pe aceeasi baza refuza sa porneasca ──
    const secondExit = await new Promise((resolve) => {
      const c2p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: Object.assign({}, process.env, { PORT: String(PORT2), CONTAB_DB_DRIVER: process.env.CONTAB_TEST_DRIVER || 'sqlite', CONTAB_DB_FILE: DBF, CONTAB_DATA_DIR: DATA_TMP, CONTAB_JSON_MIRROR: '0', STRIPE_SECRET_KEY: '', CONTAB_RATE_API: '100000', CONTAB_HIBP: '0', CONTAB_DEV: '1' }),
        stdio: 'ignore',
      });
      const t = setTimeout(() => { try { c2p.kill(); } catch (_) { /* */ } resolve('timeout'); }, 8000);
      c2p.on('exit', (code) => { clearTimeout(t); resolve(code); });
    });
    eq('a doua instanta pe aceeasi baza iese cu cod 1', secondExit, 1);
    ok('prima instanta ramane vie dupa refuzul celei de-a doua', (await req('GET', '/api/health')).status === 200);
  } finally {
    clearTimeout(guard);
    killAll();
  }

  console.log((fail ? '✗ ' : '✓ ') + pass + ' verificari HTTP trecute, ' + fail + ' esuate.');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('teste HTTP:', e); process.exit(1); });
