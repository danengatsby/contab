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
const auth = require('../src/auth');
const xml = require('../src/xml');
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
    ],
    documents: [{ id: 'docA', firmaId: 2, fileName: 'secret.pdf', storedName: 'nu-exista-pe-disc.pdf', uploadedAt: 'x', text: '' }],
    settings: { authSecret: 'x'.repeat(64) },
  };
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
  const r = await fetch(BASE + p, { method, headers, body });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-JSON */ }
  return { status: r.status, json, text, cookie: (r.headers.get('set-cookie') || '').split(';')[0], reqId: r.headers.get('x-request-id') };
}

async function waitUp(tries) {
  for (let i = 0; i < (tries || 40); i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (_) { /* inca porneste */ }
    await new Promise((z) => setTimeout(z, 250));
  }
  return false;
}

async function main() {
  PORT = await freePort();
  PORT2 = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  fs.writeFileSync(DBF, JSON.stringify(buildDb()));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // plafoane de upload/export mici, ca testele 429 sa nu faca zeci de cereri; conturile
    // din restul suitei raman sub ele (bucket-urile sunt per utilizator)
    env: Object.assign({}, process.env, { PORT: String(PORT), CONTAB_DB_DRIVER: process.env.CONTAB_TEST_DRIVER || 'sqlite', CONTAB_DB_FILE: DBF, CONTAB_DATA_DIR: DATA_TMP, CONTAB_JSON_MIRROR: '0', STRIPE_SECRET_KEY: '', CONTAB_RATE_UPLOAD: '8', CONTAB_RATE_EXPORT: '5', CONTAB_RATE_API: '100000', CONTAB_HIBP: '0', CONTAB_RATE_IMPORT: '7' }),
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
    eq('login cu parola gresita -> 401', (await req('POST', '/api/login', { body: { username: 'user1', password: 'nu' } })).status, 401);
    const l1 = await req('POST', '/api/login', { body: { username: 'user1', password: 'parola1' } });
    ok('login user1 reusit + cookie', l1.status === 200 && /^sid=/.test(l1.cookie));
    const c1 = l1.cookie;
    const me = await req('GET', '/api/me', { cookie: c1 });
    ok('/api/me: identitate si tip', me.json && me.json.username === 'user1' && me.json.tip === 'tester');

    // politica de parole: inscrierea respinge o parola prea scurta (respingerea nu creeaza nimic)
    const regWeak = await req('POST', '/api/register', { body: { nume: 'Firma Noua SRL', username: 'noureg', password: 'scurt' } });
    ok('register: parola prea scurta -> 400', regWeak.status === 400 && /prea scurta/i.test((regWeak.json || {}).error || ''));

    // autorizare pe firma: user1 (firma 1) nu vede documentul firmei 2
    eq('document al altei firme -> 403', (await req('GET', '/api/document/docA/file', { cookie: c1 })).status, 403);

    // filtrul de upload: HTML respins, CSV acceptat
    const fdBad = new FormData();
    fdBad.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'evil.html');
    eq('upload .html respins (400)', (await req('POST', '/api/upload-only', { cookie: c1, body: fdBad })).status, 400);
    const fdOk = new FormData();
    fdOk.append('file', new Blob(['CUI;Den\n1;X'], { type: 'text/csv' }), 'date.csv');
    eq('upload .csv acceptat', (await req('POST', '/api/upload-only', { cookie: c1, body: fdOk })).status, 200);

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

    // ── CSRF: garda de origine pe cererile mutante (aparare in adancime peste SameSite=Lax) ──
    const evil = await req('POST', '/api/login', { headers: { Origin: 'https://atacator.example' }, body: { username: 'x', password: 'y' } });
    eq('POST cu Origin strain -> 403 (CSRF)', evil.status, 403);
    const own = await req('POST', '/api/login', { headers: { Origin: BASE }, body: { username: 'x', password: 'y' } });
    eq('POST cu Origin propriu trece de garda (401 = parola, nu 403)', own.status, 401);
    eq('Referer strain e respins la fel', (await req('POST', '/api/logout', { headers: { Referer: 'https://atacator.example/pagina' } })).status, 403);
    // lipsa Origin/Referer e permisa (curl/integrari) — intreaga suita ruleaza asa; GET nu e atins
    eq('GET cu Origin strain ramane permis (nu e mutant)', (await req('GET', '/api/health', { headers: { Origin: 'https://atacator.example' } })).status, 200);

    // ── Abonament / plati (src/routes/billing.js) ──
    const plansPub = await req('GET', '/api/plans'); // public (fara sesiune)
    ok('planuri publice: lista + zile de proba', plansPub.status === 200 && Array.isArray(plansPub.json.plans) && typeof plansPub.json.trialDays === 'number');
    const subInfo = await req('GET', '/api/subscription', { cookie: c1 });
    ok('abonament: starea curenta + flag Stripe', subInfo.json && subInfo.json.current && typeof subInfo.json.stripeEnabled === 'boolean');
    eq('checkout-guest cu plan invalid -> 400', (await req('POST', '/api/checkout-guest', { body: { plan: 'inexistent' } })).status, 400);
    eq('non-admin la activarea de plan (admin) -> 403', (await req('POST', '/api/subscription/activate', { cookie: c1, body: { userId: 2, plan: 'pro' } })).status, 403);

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

    // ── TVA trimestrial: vizualizarea urmeaza perioada TVA (agrega trimestrul) ──
    await req('POST', '/api/company', { cookie: c1, body: { perioadaTva: 'T' } });
    const vjT = await req('GET', '/api/vat-journals?period=2026-06', { cookie: c1 });
    ok('vat-journals la regim T: perioada efectiva = trimestrul', vjT.json.period === '2026-Q2' && vjT.json.trimestrial === true);
    await req('POST', '/api/company', { cookie: c1, body: { perioadaTva: 'L' } });
    const vjL = await req('GET', '/api/vat-journals?period=2026-06', { cookie: c1 });
    ok('vat-journals la regim L: perioada efectiva = luna', vjL.json.period === '2026-06' && !vjL.json.trimestrial);

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
      // micro/profit -> D100/D101: firma pe profit vede D101 in decembrie
      const dregDec = (await req('GET', '/api/declarations?period=2026-12', { cookie: c1 })).json;
      const tipsDec = (dregDec.rows || []).map((x) => x.tip);
      ok('profil profit: D101 apare in decembrie', tipsDec.includes('d101') && tipsDec.includes('d100'));
      // calculul D101 (figuri semantice) disponibil via /api/d101
      const d101c = await req('GET', '/api/d101?year=2026', { cookie: c1 });
      ok('/api/d101: calcul coerent (rezultat brut + impozit + scadenta)', d101c.status === 200 && typeof d101c.json.rezultatBrut === 'number' && typeof d101c.json.impozit === 'number' && d101c.json.scadenta === '2027-03-25');
      // restaurez profilul firmei pentru restul suitei
      await req('POST', '/api/company', { cookie: c1, body: { regimImpozit: 'micro', d406Cadenta: '', intrastatObligat: false, scutiri: {} } });
      const fp2 = (await req('GET', '/api/fiscal-profile', { cookie: c1 })).json;
      ok('fiscal-profile: revenit la micro + D406 lunar (derivat)', fp2.regim === 'micro' && fp2.d406 === 'L' && fp2.intrastat === false);
      // micro: in decembrie NU apare D101
      const dregDecMicro = (await req('GET', '/api/declarations?period=2026-12', { cookie: c1 })).json;
      ok('profil micro: D101 nu apare in decembrie', !(dregDecMicro.rows || []).map((x) => x.tip).includes('d101'));
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
    await req('POST', '/api/company', { cookie: c1, body: { proRataTva: '' } });

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
      livH.list.some((x) => /Declaratia Unica/.test(x.nume)) && !livH.list.some((x) => x.nr === 12) && livH.sumar.du && typeof livH.sumar.du.total === 'number');
    ok('firma revenita pe SRL', (await req('POST', '/api/company', { cookie: c1, body: { tipEntitate: 'srl' } })).json.ok === true);
    ok('SRL: d100 revine in calendar', (await req('GET', '/api/declarations?period=2026-06', { cookie: c1 })).json.rows.some((r) => r.tip === 'd100'));

    // ── Rezumat executiv (mod simplu): agregatele noi pe dashboard ──
    const dashH = (await req('GET', '/api/dashboard', { cookie: c1 })).json;
    ok('dashboard: rezumatul executiv are agregatele numerice',
      typeof dashH.disponibilTotal === 'number' && typeof dashH.taxeDatorate === 'number' && typeof dashH.salariiDePlata === 'number');
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
    ok('admin: lista utilizatorilor cu tip', users.json && users.json.length === 9 && users.json.every((u) => u.tip));
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

    // ── Schimbare de parola OBLIGATORIE (cont cu parola implicita „admin") ──
    const laDef = await req('POST', '/api/login', { body: { username: 'defpw', password: 'admin' } });
    ok('cont cu parola implicita: login reuseste (schimbarea vine dupa)', laDef.status === 200 && laDef.cookie);
    ok('/api/me semnaleaza mustChange (migrarea a re-armat flagul)', (await req('GET', '/api/me', { cookie: laDef.cookie })).json.mustChange === true);
    const blocked = await req('GET', '/api/dashboard', { cookie: laDef.cookie });
    ok('mustChange: orice actiune e blocata (403 + flag)', blocked.status === 403 && blocked.json.mustChange === true);
    eq('mustChange: scriere blocata', (await req('POST', '/api/partners', { cookie: laDef.cookie, body: { cui: 'RO1', den: 'X' } })).status, 403);
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
    // utilizator nou, DOAR pe firma 2
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
    const nouaFirma = await req('POST', '/api/firme', { cookie: c1, body: { nume: 'A Doua Firma PFA', cui: 'RO7788', tipEntitate: 'pfa', tvaPlatitor: false } });
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

    // ── BILLING STRICT PER-FIRMA: firma noua porneste cu proba de 30 zile, apoi abonament ──
    const tfR = await req('POST', '/api/firme', { cookie: c1, body: { nume: 'Firma Proba SRL', cui: 'RO900' } });
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

    // ── GUARD SINGLE-INSTANCE: a doua instanta pe aceeasi baza refuza sa porneasca ──
    const secondExit = await new Promise((resolve) => {
      const c2p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: Object.assign({}, process.env, { PORT: String(PORT2), CONTAB_DB_DRIVER: process.env.CONTAB_TEST_DRIVER || 'sqlite', CONTAB_DB_FILE: DBF, CONTAB_DATA_DIR: DATA_TMP, CONTAB_JSON_MIRROR: '0', STRIPE_SECRET_KEY: '', CONTAB_RATE_API: '100000', CONTAB_HIBP: '0' }),
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
