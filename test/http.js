'use strict';

// Teste de integrare HTTP: porneste serverul pe un port de test cu o baza temporara
// (driver JSON, fara oglinda) si verifica rutele critice cap-coada: autentificare,
// autorizarea pe firma, filtrul de upload, blocarea probei expirate, registrul
// depunerilor si portofoliul. Ruleaza in `npm test`, dupa suita de module.

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const auth = require('../src/auth');
const xml = require('../src/xml');

const PORT = 3891;
const BASE = 'http://127.0.0.1:' + PORT;
const DBF = path.join(os.tmpdir(), 'contab-http-' + process.pid + '.json');

let pass = 0; let fail = 0;
function eq(name, got, exp) {
  if (got === exp) pass += 1;
  else { fail += 1; console.error('  ✗ ' + name + ': got ' + JSON.stringify(got) + ', expected ' + JSON.stringify(exp)); }
}
function ok(name, cond) { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + name); } }

function buildDb() {
  const a = auth.hashPassword('admin');
  const u = auth.hashPassword('parola1');
  return {
    firme: [
      { id: 1, nume: 'UNU SRL', cui: '11', tvaPlatitor: true },
      { id: 2, nume: 'DOI SRL', cui: '22', tvaPlatitor: true },
    ],
    firmaActiva: 1,
    users: [
      { id: 1, username: 'admin', salt: a.salt, hash: a.hash, role: 'admin', firme: [] },
      { id: 2, username: 'user1', salt: u.salt, hash: u.hash, role: 'user', firme: [1], firmaActiva: 1 },
      { id: 3, username: 'expirat', salt: u.salt, hash: u.hash, role: 'user', firme: [2], firmaActiva: 2,
        subscription: { plan: 'trial', status: 'trial', trialStartedAt: '2026-01-01', trialEndsAt: '2026-01-31' } },
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
  return { status: r.status, json, text, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

async function waitUp(tries) {
  for (let i = 0; i < (tries || 40); i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (_) { /* inca porneste */ }
    await new Promise((z) => setTimeout(z, 250));
  }
  return false;
}

async function main() {
  fs.writeFileSync(DBF, JSON.stringify(buildDb()));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), CONTAB_DB_DRIVER: 'json', CONTAB_DB_FILE: DBF, CONTAB_JSON_MIRROR: '0' }),
    stdio: 'ignore',
  });
  const killAll = () => { try { child.kill(); } catch (_) { /* */ } try { fs.unlinkSync(DBF); } catch (_) { /* */ } };
  const guard = setTimeout(() => { console.error('  ✗ timeout global teste HTTP'); killAll(); process.exit(1); }, 45000);

  try {
    ok('serverul de test porneste', await waitUp());

    // public + autentificare
    const h = await req('GET', '/api/health');
    ok('health public: ok', h.status === 200 && h.json && h.json.ok === true);
    eq('date fara login -> 401', (await req('GET', '/api/dashboard')).status, 401);
    eq('login cu parola gresita -> 401', (await req('POST', '/api/login', { body: { username: 'user1', password: 'nu' } })).status, 401);
    const l1 = await req('POST', '/api/login', { body: { username: 'user1', password: 'parola1' } });
    ok('login user1 reusit + cookie', l1.status === 200 && /^sid=/.test(l1.cookie));
    const c1 = l1.cookie;
    const me = await req('GET', '/api/me', { cookie: c1 });
    ok('/api/me: identitate si tip', me.json && me.json.username === 'user1' && me.json.tip === 'tester');

    // autorizare pe firma: user1 (firma 1) nu vede documentul firmei 2
    eq('document al altei firme -> 403', (await req('GET', '/api/document/docA/file', { cookie: c1 })).status, 403);

    // filtrul de upload: HTML respins, CSV acceptat
    const fdBad = new FormData();
    fdBad.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'evil.html');
    eq('upload .html respins (400)', (await req('POST', '/api/upload-only', { cookie: c1, body: fdBad })).status, 400);
    const fdOk = new FormData();
    fdOk.append('file', new Blob(['CUI;Den\n1;X'], { type: 'text/csv' }), 'date.csv');
    eq('upload .csv acceptat', (await req('POST', '/api/upload-only', { cookie: c1, body: fdOk })).status, 200);

    // registrul depunerilor + portofoliu + notificari
    const reg = await req('GET', '/api/declarations?period=2026-06', { cookie: c1 });
    const d300 = reg.json && reg.json.rows.find((r) => r.tip === 'd300');
    const saft = reg.json && reg.json.rows.find((r) => r.tip === 'saft');
    ok('registru: d300 cu termen 25', d300 && d300.due === '2026-07-25');
    ok('registru: saft lunar cu termen sfarsit de luna', saft && saft.due === '2026-07-31');
    const set = await req('POST', '/api/declarations/set', { cookie: c1, body: { tip: 'd300', period: '2026-06', status: 'depusa', recipisa: 'R1' } });
    const d300v2 = set.json && set.json.rows.find((r) => r.tip === 'd300');
    ok('registru: marcare depusa cu recipisa', d300v2 && d300v2.status === 'depusa' && d300v2.recipisa === 'R1');
    const porto = await req('GET', '/api/portfolio?period=2026-06', { cookie: c1 });
    ok('portofoliu: doar firmele utilizatorului', porto.json && porto.json.firms.length === 1 && porto.json.firms[0].firmaId === 1);
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

    // admin
    const la = await req('POST', '/api/login', { body: { username: 'admin', password: 'admin' } });
    const users = await req('GET', '/api/users', { cookie: la.cookie });
    ok('admin: lista utilizatorilor cu tip', users.json && users.json.length === 3 && users.json.every((u) => u.tip));
    eq('non-admin la ruta de admin -> 403', (await req('GET', '/api/users', { cookie: c1 })).status, 403);
  } finally {
    clearTimeout(guard);
    killAll();
  }

  console.log((fail ? '✗ ' : '✓ ') + pass + ' verificari HTTP trecute, ' + fail + ' esuate.');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('teste HTTP:', e); process.exit(1); });
