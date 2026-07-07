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
      // firma cu proba EXPIRATA (billing per-firma) — pentru testele „expirat"
      { id: 3, nume: 'EXPIRAT SRL', cui: '33', tvaPlatitor: true, subscription: { plan: 'trial', trialStartedAt: '2026-01-01T00:00:00Z', trialEndsAt: '2026-02-01T00:00:00Z' } },
    ],
    firmaActiva: 1,
    users: [
      { id: 1, username: 'admin', salt: a.salt, hash: a.hash, role: 'admin', firme: [] },
      { id: 2, username: 'user1', salt: u.salt, hash: u.hash, role: 'user', firme: [1], firmaActiva: 1 },
      { id: 3, username: 'expirat', salt: u.salt, hash: u.hash, role: 'user', firme: [3], firmaActiva: 3 },
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
    env: Object.assign({}, process.env, { PORT: String(PORT), CONTAB_DB_DRIVER: 'json', CONTAB_DB_FILE: DBF, CONTAB_JSON_MIRROR: '0', STRIPE_SECRET_KEY: '' }),
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
    eq('marcarea depusa a blocat automat luna', set.json.locked, '2026-06');
    // deblocam (admin) — fluxul de test completeaza intentionat date in iunie in continuare
    const laLock = await req('POST', '/api/login', { body: { username: 'admin', password: 'admin' } });
    ok('deblocarea perioadei (admin) reuseste', (await req('POST', '/api/period-lock', { cookie: laLock.cookie, body: { lockedUntil: null } })).status === 200);
    const porto = await req('GET', '/api/portfolio?period=2026-06', { cookie: c1 });
    ok('portofoliu: doar firmele utilizatorului', porto.json && porto.json.firms.length === 1 && porto.json.firms[0].firmaId === 1);
    ok('portofoliu: fiecare firma are forma juridica + starea abonamentului',
      porto.json.firms.every((f) => (f.tipEntitate === 'srl' || f.tipEntitate === 'pfa') && typeof f.tvaPlatitor === 'boolean' && f.sub && typeof f.sub.status === 'string'));
    // admin vede toate firmele in portofoliu, cu forma+abonament (firma 3 = proba expirata din buildDb)
    const laPorto = await req('POST', '/api/login', { body: { username: 'admin', password: 'admin' } });
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
    ok('D394: sectiunea achizitii_pf_carnet cu CNP-ul producatorului', /achizitii_pf_carnet/.test(x394pf.text) && /1800101223344/.test(x394pf.text));
    const x100 = await req('GET', '/xml/d100?period=2026-06', { cookie: c1 });
    ok('xml/d100: bine-format cu obligatia 620', x100.status === 200 && /<declaratie100/.test(x100.text) && /cod="620"/.test(x100.text));
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
    ok('D112: baza_cas include avantajele (6000)', /baza_cas="6000\.00"/.test((await req('GET', '/xml/d112?period=2026-06', { cookie: c1 })).text));
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
    const laMonth = await req('POST', '/api/login', { body: { username: 'admin', password: 'admin' } });
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

    // admin
    const la = await req('POST', '/api/login', { body: { username: 'admin', password: 'admin' } });
    const users = await req('GET', '/api/users', { cookie: la.cookie });
    ok('admin: lista utilizatorilor cu tip', users.json && users.json.length === 3 && users.json.every((u) => u.tip));
    eq('non-admin la ruta de admin -> 403', (await req('GET', '/api/users', { cookie: c1 })).status, 403);

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
    eq('faraSalarii: si citirea salarizarii e respinsa (403)', (await req('GET', '/api/angajati', { cookie: c1 })).status, 403);
    eq('faraSalarii: D112 XML respins (403)', (await req('GET', '/xml/d112?period=2026-06', { cookie: c1 })).status, 403);
    ok('drepturile pot fi ridicate inapoi', (await req('POST', '/api/users/2', { cookie: la.cookie, body: { drepturi: { readonly: false, faraSalarii: false } } })).json.ok === true);
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
    // proprietarul isi poate sterge propriile resurse (guard-ul nu blocheaza firma corecta)
    ok('proprietarul sterge propriile resurse', (
      (await req('DELETE', '/api/entries/' + isoE.id, { cookie: c1 })).json.ok === true
      && (await req('DELETE', '/api/angajati/' + isoA.id, { cookie: c1 })).json.ok === true
      && (await req('DELETE', '/api/assets/' + isoAs.id, { cookie: c1 })).json.ok === true
      && (await req('DELETE', '/api/stock-movements/' + isoM.id, { cookie: c1 })).json.ok === true
      && (await req('DELETE', '/api/products/' + isoP.id, { cookie: c1 })).json.ok === true
      && (await req('DELETE', '/api/gestiuni/' + isoG.id, { cookie: c1 })).json.ok === true
    ));

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
    // 4) recuperare prin SUPRASCRIERE (mode=replace): simulez pierderea, apoi restaurez
    const bkpInNew = restEntries.find((e) => e.document === 'BKP-DOC');
    await req('POST', '/api/firme/' + newFid + '/activate', { cookie: c1 });
    await req('DELETE', '/api/entries/' + bkpInNew.id, { cookie: c1 });
    ok('dupa "pierderea" datelor: BKP-DOC lipseste', !(await req('GET', '/api/entries?firma=' + newFid, { cookie: c1 })).json.some((e) => e.document === 'BKP-DOC'));
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
    // simulez expirarea probei (trecutul lui trialEndsAt din subscription, prin update-ul firmei)
    await req('POST', '/api/firme/' + tf, { cookie: c1, body: { subscription: { plan: 'trial', trialEndsAt: '2026-01-01T00:00:00Z' } } });
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

    // ── GUARD SINGLE-INSTANCE: a doua instanta pe aceeasi baza refuza sa porneasca ──
    const secondExit = await new Promise((resolve) => {
      const c2p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: Object.assign({}, process.env, { PORT: String(PORT + 1), CONTAB_DB_DRIVER: 'json', CONTAB_DB_FILE: DBF, CONTAB_JSON_MIRROR: '0', STRIPE_SECRET_KEY: '' }),
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
