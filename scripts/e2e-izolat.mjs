// ─────────────────────────────────────────────────────────────────────────────
//  Scenarii E2E care cer o instanta IZOLATA (nu se pot rula pe demo live).
//  Pornit de scripts/e2e-izolat.sh, care ridica serverul si trimite BASE_URL/E2E_*.
//
//  Ce acopera, si de ce nu putea fi pe demo:
//    roluri            — trebuie creat un cont cu drepturi restranse
//    resetare parola   — schimba parola unui cont real, cu token din email
//    2FA               — activeaza/dezactiveaza autentificarea in doi pasi
//    importuri         — scrie parteneri/produse in baza
//    erori SPV         — instanta NU are credentiale: verificam ca esecul e EXPLICIT, nu tacut
//    restaurare        — inlocuieste baza dintr-o arhiva
//    declaratii        — genereaza toate cele 10 iesiri XML si verifica plauzibilitatea
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from 'playwright';
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18777';
const PAROLA = process.env.E2E_PAROLA || 'E2E-Izolat-2026!';
const RESET = process.env.E2E_RESET || '';

let pass = 0; let fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name); } };
const sect = (t) => console.log('\n' + t);

// TOTP (RFC 6238) — calculat aici, ca sa nu montam repo-ul in container doar pentru src/totp.js
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of String(s).toUpperCase().replace(/=+$/, '')) {
    const i = A.indexOf(c); if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totpCode(secret, t = Date.now()) {
  const ctr = Math.floor(t / 1000 / 30);
  const buf = Buffer.alloc(8); buf.writeUInt32BE(Math.floor(ctr / 2 ** 32), 0); buf.writeUInt32BE(ctr >>> 0, 4);
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1e6).padStart(6, '0');
}

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();

/** Autentificare prin interfata (nu prin API) — asta e ce verificam. */
async function login(page, user, parola, cod) {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  // in pagina exista TREI campuri name=username (login, inscriere, admin) — scopam pe formular
  await page.fill('#loginForm input[name=username]', user);
  await page.fill('#loginForm input[name=password]', parola);
  if (cod) { await page.fill('#loginForm input[name=code]', cod); }
  await page.click('#loginForm button.primary');
  await page.waitForTimeout(1800);
  return page.evaluate(() => {
    const el = document.querySelector('#userBadge');
    return !!el && el.textContent.trim().length > 0;
  });
}
/** Apel de API din CONTEXTUL paginii — poarta cookie-ul si tokenul CSRF ca un client real. */
async function apiIn(page, url, opts) {
  return page.evaluate(async ([u, o]) => {
    const m = await import('/core.js');
    const r = await window.fetch(u, m.withCsrf(o || {}));
    let body = null; try { body = await r.json(); } catch (_) { body = null; }
    return { status: r.status, body };
  }, [url, opts || {}]);
}

// ─────────────────────────── 1. ROLURI SI DREPTURI ───────────────────────────
sect('1. Roluri si drepturi granulare');
ok('admin se autentifica prin interfata', await login(pg, 'admin', PAROLA));
// Ascunderea cardului se comanda prin clasa `.hidden` (app.js: classList.toggle), nu prin stil
// inline. Varianta veche citea `el.style.display`, care e '' in AMBELE cazuri — deci aserttiunea
// pozitiva („adminul vede") trecea din motivul gresit, iar cea negativa („limitatul nu vede") nu
// putea trece NICIODATA. Era rosie de mult, ascunsa in spatele blocajului de la 2FA, care oprea
// scenariul inainte de sumar. Se citeste MECANISMUL real, nu un efect al lui — si nu stilul
// calculat, care ar depinde de tabul activ.
const cardUtilizatori = (page) => page.evaluate(() => {
  const el = document.querySelector('#usersCard');
  return el ? (el.classList.contains('hidden') ? 'ascuns' : 'vizibil') : 'lipseste';
});
ok('adminul are administrarea utilizatorilor DISPONIBILA', (await cardUtilizatori(pg)) === 'vizibil');

const pgLim = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
ok('utilizatorul cu drepturi restranse se autentifica', await login(pgLim, 'limitat', PAROLA));
ok('...NU vede administrarea utilizatorilor (ascunsa dupa rol)', (await cardUtilizatori(pgLim)) === 'ascuns');
ok('...NU vede meniul de salarizare (drept faraSalarii)',
  (await pgLim.locator('button[data-tab="salarizare"]:visible').count()) === 0);
const salLim = await apiIn(pgLim, '/api/angajati');
ok('...si serverul respinge citirea salariilor (403), nu doar UI-ul ascunde', salLim.status === 403);
const usrLim = await apiIn(pgLim, '/api/users');
ok('...iar lista de utilizatori ii e interzisa (403)', usrLim.status === 403);

// ─────────────────────────── 2. RESETARE PAROLA ──────────────────────────────
sect('2. Resetare parola (link din email)');
ok('tokenul de resetare a fost emis', RESET.length > 20);
const PAROLA2 = 'E2E-Resetata-2026!';
let pgNou = null; // sesiunea de admin de DUPA resetare (cea initiala e invalidata)
if (RESET) {
  const pr = await (await b.newContext()).newPage();
  await pr.goto(BASE + '/?reset=' + RESET, { waitUntil: 'networkidle' });
  await pr.waitForTimeout(1200);
  // fluxul de resetare REESCRIE continutul lui #loginForm (authui.js startReset), nu deschide
  // un formular separat — deci selectorul e tot #loginForm.
  const vizibil = await pr.locator('#loginForm').innerText().then((t) => /Resetare parol/i.test(t)).catch(() => false);
  ok('linkul de resetare transforma formularul de login in „resetare parola"', vizibil);
  if (vizibil) {
    await pr.fill('#loginForm input[name=password]', PAROLA2);
    await pr.click('#loginForm button.primary');
    await pr.waitForTimeout(2000);
    ok('dupa resetare esti autentificat direct', await pr.evaluate(() => {
      const el = document.querySelector('#userBadge'); return !!el && el.textContent.trim().length > 0;
    }));
  }
  await pr.close();
  // ATENTIE la ordine: fiecare login esuat creste contorul anti-forta-bruta (MAX_ATTEMPTS=8),
  // iar prea multe incercari gresite blocheaza contul si fac sa pice si verificarile CORECTE.
  // Deci intai confirmam ca parola noua merge, abia apoi ca cea veche nu.
  pgNou = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  ok('parola NOUA merge', await login(pgNou, 'admin', PAROLA2));
  ok('parola VECHE nu mai merge', !(await login(await (await b.newContext()).newPage(), 'admin', PAROLA)));
  const reuse = await (await b.newContext()).newPage();
  await reuse.goto(BASE + '/?reset=' + RESET, { waitUntil: 'networkidle' });
  await reuse.waitForTimeout(1000);
  const inca = await reuse.locator('#loginForm').innerText().then((t) => /Resetare parol/i.test(t)).catch(() => false);
  ok('tokenul consumat NU mai deschide formularul de resetare', !inca);
  await reuse.fill('#loginForm input[name=password]', 'AltaParola-2026!').catch(() => {});
  await reuse.click('#loginForm button.primary').catch(() => {});
  await reuse.waitForTimeout(1200);
  ok('acelasi token NU se poate refolosi', !(await login(await (await b.newContext()).newPage(), 'admin', 'AltaParola-2026!')));
  await reuse.close();
}
const PAROLA_ADMIN = RESET ? PAROLA2 : PAROLA;
// de aici incolo lucram pe o sesiune de admin VALIDA (resetarea a invalidat-o pe cea initiala)
const adm = pgNou || pg;

// ─────────────────────────── 3. 2FA ──────────────────────────────────────────
// Flux complet prin interfata: configurare, confirmare TOTP, login in doi pasi si dezactivare.
// Acesta leaga explicit cele doua jumatati ale functiei: nimeni nu poate activa 2FA daca formularul
// de login nu poate primi codul, iar campul nu ramane un control mort fara configurare in Cont.
sect('3. Autentificare in doi pasi (2FA) — flux complet prin interfata');
{
  await adm.evaluate(() => window.goTab('cont'));
  ok('Setari ofera configurarea 2FA', (await adm.locator('#twofaStart:visible').count()) === 1);
  // Resetarea autentifica direct si poate deschide bun-venitul peste pagina Cont.
  await adm.evaluate(() => document.querySelector('#welcomeOverlay')?.classList.add('hidden'));
  await adm.click('#twofaStart');
  await adm.waitForFunction(() => document.querySelector('#twofaSecret')?.textContent?.length >= 16);
  const secret = (await adm.locator('#twofaSecret').innerText()).trim();
  ok('configurarea afiseaza cheia TOTP', /^[A-Z2-7]{16,}$/.test(secret));
  ok('configurarea afiseaza QR-ul intr-o sursa inerta',
    /^data:image\/svg\+xml/.test(await adm.locator('#twofaQr').getAttribute('src') || ''));
  await adm.fill('#twofaCode', totpCode(secret));
  await adm.click('#twofaEnable');
  await adm.waitForFunction(() => /este activat/i.test(document.querySelector('#twofaStatus')?.textContent || ''));
  ok('codul corect activeaza 2FA din interfata',
    /este activat/i.test(await adm.locator('#twofaStatus').innerText()));
  await adm.waitForFunction(() => !document.querySelector('#twofaRecovery')?.classList.contains('hidden'));
  const recoveryCodes = (await adm.locator('#twofaRecoveryCodes').inputValue()).split(/\s+/).filter(Boolean);
  ok('activarea afiseaza o singura data cele 8 coduri de rezerva', recoveryCodes.length === 8
    && recoveryCodes.every((x) => /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(x)));

  const p2 = await (await b.newContext()).newPage();
  await p2.goto(BASE + '/', { waitUntil: 'networkidle' });
  const camp = p2.locator('#loginForm input[name=code]');
  ok('campul de cod exista si este activ', (await camp.count()) === 1 && !(await camp.isDisabled()));
  ok('campul ramane ascuns pana cand parola corecta cere al doilea pas',
    await p2.locator('#codeRow').evaluate((el) => el.classList.contains('hidden')));
  await p2.fill('#loginForm input[name=username]', 'admin');
  await p2.fill('#loginForm input[name=password]', PAROLA_ADMIN);
  await p2.click('#loginForm button.primary');
  await p2.waitForFunction(() => !document.querySelector('#codeRow')?.classList.contains('hidden'));
  ok('parola corecta cere codul fara sa creeze sesiune',
    !(await p2.locator('#userBadge').innerText()).trim() && /introdu codul/i.test(await p2.locator('#loginErr').innerText()));
  await camp.fill(recoveryCodes[0]);
  await p2.click('#loginForm button.primary');
  await p2.waitForFunction(() => (document.querySelector('#userBadge')?.textContent || '').trim().length > 0);
  ok('parola si codul de rezerva autentifica utilizatorul', !!(await p2.locator('#userBadge').innerText()).trim());

  await p2.evaluate(() => document.querySelector('#welcomeOverlay')?.classList.add('hidden'));
  await p2.evaluate(() => window.goTab('cont'));
  await p2.fill('#twofaDisCode', totpCode(secret));
  await p2.click('#twofaDisable');
  await p2.waitForFunction(() => /este dezactivat/i.test(document.querySelector('#twofaStatus')?.textContent || ''));
  ok('2FA se poate dezactiva tot din interfata, cu un cod valid',
    /este dezactivat/i.test(await p2.locator('#twofaStatus').innerText()));
  await p2.close();

  // Vector fix RFC 4226/6238, ca generatorul folosit de test sa fie el insusi verificat.
  const c1t = totpCode('GEZDGNBVGY3TQOJQ', 59000);
  ok('TOTP: cod de 6 cifre pentru vectorul RFC', /^\d{6}$/.test(String(c1t)));
  ok('TOTP: acelasi moment -> acelasi cod (determinist)', totpCode('GEZDGNBVGY3TQOJQ', 59000) === c1t);
  ok('TOTP: alta fereastra de 30s -> alt cod', totpCode('GEZDGNBVGY3TQOJQ', 59000 + 60000) !== c1t);
}

// ─────────────────────────── 4. IMPORTURI ────────────────────────────────────
sect('4. Importuri (parteneri, produse, migrare completa)');
{
  const inainte = (await apiIn(adm, '/api/partners')).body || {};
  const nrInainte = Object.keys(inainte).length;
  const csv = 'cui,den,tip,adresa,oras,judet\nRO900001,IMPORT UNU SRL,ambele,Str. A 1,Iasi,IS\nRO900002,IMPORT DOI SRL,client,Str. B 2,Cluj-Napoca,CJ\n';
  const imp = await apiIn(adm, '/api/partners/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
  ok('importul de parteneri raspunde ok', imp.status === 200);
  const dupa = (await apiIn(adm, '/api/partners')).body || {};
  ok('partenerii importati chiar apar in baza', Object.keys(dupa).length >= nrInainte + 2 && !!dupa['900001']);
  // CSV stricat: trebuie sa esueze EXPLICIT, nu sa importe pe jumatate in tacere
  const rau = await apiIn(adm, '/api/partners/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: 'nu,sunt,coloane\n1,2,3\n' }) });
  // Inainte de reparatie asta importa TACIT doi parteneri de gunoi (cui='nu', den='sunt') si
  // raporta succes. E defectul pe care l-a gasit acest E2E.
  ok('CSV fara coloanele cerute -> RESPINS explicit (400)', rau.status === 400);
  ok('...cu mesaj care spune ce rand si de ce', /nu e un cod fiscal valid/i.test(String(rau.body && rau.body.error)));
  const dupaRau = (await apiIn(adm, '/api/partners')).body || {};
  ok('...si NU ramane niciun partener de gunoi in baza', !dupaRau.nu && !dupaRau['1']);
  const pcsv = 'cod,denumire,um,pretVanzare\nE2E-1,Produs E2E,buc,10\n';
  const pimp = await apiIn(adm, '/api/products/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: pcsv }) });
  ok('importul de produse raspunde ok', pimp.status === 200);
  const prod = (await apiIn(adm, '/api/products')).body || [];
  ok('produsul importat apare in lista', Array.isArray(prod) && prod.some((p) => p.cod === 'E2E-1'));

  // Fluxul REAL din ecranul de solduri: upload -> preview pe server -> salvare preset ->
  // reutilizare dupa reordonarea coloanelor. Testele HTTP dovedesc izolarea; aici dovedim ca
  // butoanele si selecturile din browser chiar leaga acel API, nu sunt controale moarte.
  await adm.evaluate(() => document.querySelector('#welcomeOverlay')?.classList.add('hidden'));
  await adm.evaluate(() => window.goTab('date'));
  const balanta = ['Cont;Denumire;Sold final debitor;Sold final creditor',
    '1012;Capital social;0;30.000,00', '371;Marfuri;25.000,00;0',
    '401;Furnizori;0;10.000,00', '5121;Banca;15.000,00;0'].join('\n');
  await adm.locator('#openFile').setInputFiles({ name: 'balanta-e2e.csv', mimeType: 'text/csv', buffer: Buffer.from(balanta) });
  await adm.waitForFunction(() => !document.querySelector('#openMapping')?.classList.contains('hidden'));
  ok('balanta incarcata afiseaza maparea detectata in interfata',
    (await adm.locator('#openMappingFields select').count()) === 6);
  ok('previzualizarea afiseaza cele patru conturi si balanta echilibrata',
    (await adm.locator('#openEditor tbody tr').count()) === 4 && /echilibrat/i.test(await adm.locator('#openTotals').innerText()));
  await adm.fill('#openPresetName', 'Format E2E reutilizabil');
  await adm.click('#openPresetSave');
  await adm.waitForFunction(() => document.querySelectorAll('#openPreset option').length >= 2);
  ok('formatul maparii se salveaza si ramane selectat',
    (await adm.locator('#openPreset').inputValue()).length > 0);
  const reordonata = ['Sold final creditor;Cont;Sold final debitor;Denumire',
    '30.000,00;1012;0;Capital social', '0;371;25.000,00;Marfuri',
    '10.000,00;401;0;Furnizori', '0;5121;15.000,00;Banca'].join('\n');
  await adm.locator('#openFile').setInputFiles({ name: 'balanta-e2e-reordonata.csv', mimeType: 'text/csv', buffer: Buffer.from(reordonata) });
  await adm.waitForFunction(() => /40[.,]000/.test(document.querySelector('#openTotals')?.textContent || ''));
  ok('presetul refolosit citeste corect un export cu coloanele reordonate',
    (await adm.locator('#openEditor tbody tr').count()) === 4 && /echilibrat/i.test(await adm.locator('#openTotals').innerText()));

  // Pachetul complet foloseste balanta deja previzualizata si trei fisiere auxiliare. Nu apasam
  // import aici fiindca firma seed contine date folosite de declaratiile de mai jos; testele HTTP
  // dovedesc scrierea si suprascrierea. Browserul dovedeste traseul fisier -> API -> rezumat.
  const parteneriMig = 'CUI;Denumire;Adresa;Oras;Judet;Tara;Tip\nRO12345674;FURNIZOR E2E MIGRARE;Str. Test 1;Iasi;IS;RO;furnizor';
  const activeMig = 'NrInventar;Denumire;Cont;Cost;DataPIF;DurataLuni;Metoda;ValReziduala\n'
    + 'INV-E2E;Laptop migrare;214;25000;2026-01-15;36;liniara;0';
  const stocMig = 'Cod;Denumire;UM;Cont;Gestiune;Cantitate;PretUnitar;Valoare\n'
    + 'MARFA-E2E;Marfa migrare;buc;371;DEP;100;250;25000';
  await adm.locator('#migrationPartnersFile').setInputFiles({ name: 'parteneri-e2e.csv', mimeType: 'text/csv', buffer: Buffer.from(parteneriMig) });
  await adm.locator('#migrationAssetsFile').setInputFiles({ name: 'active-e2e.csv', mimeType: 'text/csv', buffer: Buffer.from(activeMig) });
  await adm.locator('#migrationStockFile').setInputFiles({ name: 'stoc-e2e.csv', mimeType: 'text/csv', buffer: Buffer.from(stocMig) });
  await adm.fill('#migrationDate', '2026-01-31');
  await adm.check('#migrationIncludeBalance');
  await adm.click('#migrationCompletePreview');
  await adm.waitForFunction(() => /Pachet valid/i.test(document.querySelector('#migrationCompleteStatus')?.textContent || ''));
  ok('migrarea completa valideaza toate cele patru componente din interfata',
    /4 conturi.*1 parteneri.*1 mijloace fixe.*1 poziții/i.test(await adm.locator('#migrationCompleteSummary').innerText()));
  ok('numai un pachet valid activeaza butonul de import', !(await adm.locator('#migrationCompleteImport').isDisabled()));
}

// ─────────────────────────── 5. ERORI SPV ────────────────────────────────────
sect('5. Erori SPV (instanta fara credentiale — esecul trebuie sa fie EXPLICIT)');
{
  const cfg = await apiIn(adm, '/api/anaf/config');
  ok('configurarea SPV se poate interoga', cfg.status === 200);
  ok('...si arata clar ca NU e conectat', !!(cfg.body && (cfg.body.connected === false || cfg.body.conectat === false || !cfg.body.token)));
  const trimite = await apiIn(adm, '/api/anaf/send/1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok('trimiterea e-Facturii fara conexiune SPV -> eroare, NU succes tacut', trimite.status >= 400);
  ok('...cu mesaj care spune ce lipseste', !!(trimite.body && String(trimite.body.error || '').length > 5));
  const uit = await apiIn(adm, '/api/etransport/send/1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok('trimiterea e-Transport fara conexiune -> eroare explicita', uit.status >= 400 && !!(uit.body && uit.body.error));
}

// ─────────────────────────── 6. DECLARATII ───────────────────────────────────
sect('6. Toate declaratiile se genereaza');
{
  const per = '2026-06';
  // Firma din seed e pe regim MICRO, deci D101 (impozit pe profit) e refuzat — corect.
  // Verificam intai refuzul EXPLICIT, apoi comutam regimul ca sa acoperim si generarea.
  const refuz = await adm.evaluate(async () => (await window.fetch('/xml/d101?year=2026')).status);
  ok('D101 pe firma MICRO e refuzat explicit (400), nu tacut', refuz === 400);
  await apiIn(adm, '/api/company', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regimImpozit: 'profit' }) });

  const DECL = [
    ['D300', '/xml/d300?period=' + per, 'declaratie300'],
    ['D394', '/xml/d394?period=' + per, 'declaratie394'],
    ['D390', '/xml/d390?period=' + per, 'declaratie390'],
    ['D112', '/xml/d112?period=' + per, 'declaratie'],
    ['D100', '/xml/d100?period=' + per, 'declaratie100'],
    ['D101', '/xml/d101?year=2026', 'declaratie101'],
    ['D205', '/xml/d205?year=2025', 'declaratie205'],
    ['SAF-T', '/xml/saft?period=' + per, 'AuditFile'],
    ['e-Factura', '/xml/efactura/e2', 'Invoice'],
    ['Intrastat', '/xml/intrastat?period=' + per, 'declaratieIntrastat'],
  ];
  for (const [nume, url, semn] of DECL) {
    const r = await adm.evaluate(async (u) => {
      const res = await window.fetch(u);
      const t = await res.text();
      return { status: res.status, len: t.length, head: t.slice(0, 400) };
    }, url);
    ok(nume + ': se genereaza (200, XML cu radacina asteptata)',
      r.status === 200 && r.len > 120 && r.head.includes(semn));
  }
}

// ─────────────────────────── 7. RESTAURARE ───────────────────────────────────
sect('7. Backup si restaurare');
{
  const bk = await apiIn(adm, '/api/backup', { method: 'POST' });
  ok('backup la cerere reuseste', bk.status === 200);
  const lista = await apiIn(adm, '/api/backups');
  ok('arhiva apare in lista de backup-uri',
    lista.status === 200 && lista.body && Array.isArray(lista.body.list) && lista.body.list.length > 0);
  // marcam baza, restauram, si verificam ca marcajul a DISPARUT (restaurarea chiar a inlocuit datele)
  const marcaj = 'E2E-MARCAJ-' + Date.now();
  const cr = await apiIn(adm, '/api/partners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cui: 'RO999999', den: marcaj, tip: 'client' }) });
  ok('marcaj scris in baza inainte de restaurare', cr.status === 200);
  const inaintea = (await apiIn(adm, '/api/partners')).body || {};
  ok('marcajul e vizibil inainte de restaurare', !!inaintea['999999']);

  // Restaurarea PROPRIU-ZISA: incarcam arhiva facuta INAINTE de marcaj. Daca restaurarea chiar
  // inlocuieste baza, marcajul dispare. Fara verificarea asta, „backup ok" nu spune nimic despre
  // faptul ca datele se pot aduce inapoi — exact capcana pe care o are un backup nerejucat.
  const numeArhiva = lista.body.list[0].name;
  const rest = await adm.evaluate(async ([nume]) => {
    const m = await import('/core.js');
    const r0 = await window.fetch('/api/backup/file/' + encodeURIComponent(nume));
    if (!r0.ok) return { status: r0.status, faza: 'descarcare' };
    const blob = await r0.blob();
    const fd = new FormData();
    fd.append('file', new File([blob], nume, { type: 'application/json' }));
    const r = await window.fetch('/api/restore', m.withCsrf({ method: 'POST', body: fd }));
    let body = null; try { body = await r.json(); } catch (_) { /* */ }
    return { status: r.status, body, faza: 'restaurare' };
  }, [numeArhiva]);
  ok('restaurarea din arhiva reuseste', rest.status === 200);
  const dupaRest = (await apiIn(adm, '/api/partners')).body || {};
  ok('dupa restaurare, marcajul de dupa backup a DISPARUT (datele chiar s-au inlocuit)',
    rest.status !== 200 || !dupaRest['999999']);
  ok('...iar datele din seed sunt la locul lor', !!dupaRest['11223342']);
}

// ────────── 8. „CINE ACCESEAZA APLICATIA" (admin) ──────────────────────────
// Panoul se construieste in browser din /api/access-log. Testele HTTP dovedesc raspunsul, dar nu
// si ca tabelele chiar se randeaza si ca ADMINUL e singurul care le vede — pentru asta trebuie un
// DOM adevarat. Randurile vin din sesiunile create chiar de scenariul asta, deci exista sigur.
sect('8. Cine acceseaza aplicatia (panou de administrare)');
{
  await adm.goto(BASE + '/', { waitUntil: 'networkidle' });
  // `goTab`, nu un click pe butonul din meniu: bara laterala e un acordeon, iar butonul unui grup
  // inchis nu e VIZIBIL pentru Playwright, deci clickul expira. Aceeasi cale ca in scripts/e2e.mjs.
  // Restaurarea din sectiunea 7 readuce o baza in care contul pare „nou", deci apare ecranul de
  // bun-venit — un overlay care intercepteaza clickurile. Se inchide inainte de a atinge panoul.
  await adm.evaluate(() => { const w = document.querySelector('#welcomeOverlay'); if (w) w.classList.add('hidden'); });

  // Panoul e o intrare PROPRIE in submeniul Setari, nu un card in „Setari generale". Se verifica
  // intai ca intrarea exista si e oferita adminului, apoi ca deschide chiar sectiunea lui.
  // Setarile au fost sparte in cinci pagini tematice. Fiecare intrare trebuie sa deschida efectiv
  // sectiunea ei si sa afiseze continut — o poarta pe sursa dovedeste ca sectiunile EXISTA, dar nu
  // si ca navigarea chiar ajunge acolo cu panourile randate.
  for (const [tab, ancora] of [['setari', '#companyForm'], ['cont', '#profileForm'],
    ['acces', '#colaboratoriBox'], ['date', '#openingCard'], ['conexiuni', '#anafForm'],
    // ...si stocurile, sparte la fel: lucrul zilnic / productie / configurare
    ['stocuri', '#stocGestFilter'], ['productie', '#prodForm'], ['configstoc', '#gestiuniList'],
    // ...si cele trei panouri care nu erau situatii financiare: bugetul (control intern),
    // registrul fiscal (impozit pe profit) si SAF-T — o DECLARATIE, plecata din „Situatii" la
    // declaratii, iar de acolo in pagina ei (ancora de mai jos, la `saft`).
    ['buget', '#budgetForm'], ['regfiscal', '#fiscalView'], ['livrabile', '#livrabileList'],
    // ...si salariile, sparte in trei (statul lunii / datele angajatilor / registrul anual) plus
    // leasingul, plecat din „Mijloace fixe": e alta activitate, cu contract si scadentar.
    ['salarizare', '#spSummary'], ['angajati', '#angajatForm'], ['regsalarii', '#rsList'],
    ['mijloace', '#assetForm'], ['leasing', '#lcForm'],
    // ...si inchiderile, despartite pe RITM: pasii lunii (cockpit, TVA, valutar) fata de cei
    // anuali (impozit pe profit, 6/7 in 121, repartizarea rezultatului).
    ['inchideri', '#closeCockpit'], ['inchidere-an', '#ptPreview'],
    // ...anexele scoase de sub bilant si declaratiile despartite: SAF-T (o singura declaratie, dar
    // cea mai mare) si SPV (ce vine DE LA ANAF, nu ce pleaca).
    ['anexe', '#cashflowView'], ['saft', '#saftView'], ['spv', '#spvMesajeList']]) {
    await adm.evaluate((x) => window.goTab(x), tab);
    await adm.waitForTimeout(500);
    ok('pagina „' + tab + '" se deschide', (await adm.locator('#tab-' + tab + '.active').count()) === 1);
    ok('...si contine panoul mutat acolo (' + ancora + ')',
      (await adm.locator('#tab-' + tab + ' ' + ancora).count()) === 1);
  }

  // Formularul de angajat a plecat in pagina lui, deci „editează" din statul de plata trebuie sa
  // SARA acolo si sa completeze formularul. Fara salt ar completa un formular pe care omul nu-l
  // vede — adica butonul ar parea ca nu face nimic, fara nicio eroare care sa spuna de ce.
  const angNou = await apiIn(adm, '/api/angajati', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nume: 'Salt Formular E2E', salariuBrut: 5000 }) });
  ok('angajat de proba creat pentru saltul „editează"', angNou.status === 200 && angNou.body && angNou.body.ok);
  await adm.evaluate(() => window.goTab('salarizare'));
  await adm.waitForTimeout(900);
  // Randul angajatului CREAT AICI, nu primul din lista: baza de seed are deja angajati, iar un
  // `.first()` ar fi verificat completarea cu altcineva (si ar fi picat exact asa).
  const btnEdit = adm.locator('#angajatiList tr', { hasText: 'Salt Formular E2E' }).locator('.aedit');
  ok('statul de plata listeaza angajatul, cu butonul „editează"', (await btnEdit.count()) === 1);
  await btnEdit.click();
  await adm.waitForTimeout(600);
  ok('...iar „editează" duce in pagina „Angajați"', (await adm.locator('#tab-angajati.active').count()) === 1);
  ok('...cu formularul completat cu angajatul ales',
    (await adm.locator('#angajatForm input[name="nume"]').inputValue()) === 'Salt Formular E2E');

  // Paginarea listelor lungi. Se verifica pe JURNALUL DE AUDIT, singurul care cere de la server
  // doar pagina afisata (`?limit&offset` -> plicul din src/paginate.js): daca ar cere tot si ar
  // taia in client, testul de mai jos ar trece la fel — deci se verifica si numarul de randuri
  // primite, nu doar textul barei.
  await adm.evaluate(() => window.goTab('audit'));
  await adm.waitForTimeout(1200);
  const bara = adm.locator('#tab-audit .paginare');
  if ((await bara.count()) === 1) {
    const randuri = await adm.locator('#tab-audit table tbody tr').count();
    ok('jurnalul afiseaza o singura pagina, nu tot', randuri <= 50);
    ok('...cu rezumatul „x–y din N"', /\d+–\d+ din \d+/.test(await bara.innerText()));
    ok('pe prima pagina, „Inapoi" e blocat', (await adm.locator('#tab-audit .pg-inapoi[disabled]').count()) === 1);
    const inainte = await adm.locator('#tab-audit .pg-pozitie').innerText();
    await adm.click('#tab-audit .pg-inainte');
    await adm.waitForTimeout(1200);
    ok('„Inainte" schimba pagina', (await adm.locator('#tab-audit .pg-pozitie').innerText()) !== inainte);
    ok('...si deblocheaza „Inapoi"', (await adm.locator('#tab-audit .pg-inapoi[disabled]').count()) === 0);
  } else {
    // Instanta izolata poate avea sub o pagina de audit — atunci bara NU trebuie sa apara deloc.
    ok('sub o pagina: nicio bara de paginare', (await adm.locator('#tab-audit table tbody tr').count()) <= 50);
  }

  ok('intrarea de meniu exista in submeniul Setari',
    (await adm.locator('#tabs .navgroup .navmenu button[data-tab="accesari"]').count()) === 1);
  ok('...si e oferita adminului (nu ascunsa)', (await adm.locator('#navAccesari.hidden').count()) === 0);

  await adm.evaluate(() => window.goTab('accesari'));
  await adm.waitForTimeout(1200);
  ok('intrarea deschide sectiunea proprie', (await adm.locator('#tab-accesari.active').count()) === 1);
  ok('...iar „Setari generale" NU mai e sectiunea activa', (await adm.locator('#tab-setari.active').count()) === 0);

  const randuriSesiuni = await adm.locator('#accessSessions table tbody tr').count();
  ok('tabelul de sesiuni active are randuri', randuriSesiuni > 0);
  const textSesiuni = await adm.locator('#accessSessions').innerText().catch(() => '');
  ok('...si contine contul de admin', /admin/.test(textSesiuni));

  const randuriLogari = await adm.locator('#accessLogins table tbody tr').count();
  ok('tabelul de autentificari are randuri', randuriLogari > 0);

  // Al treilea tabel exista si e cel despre vizitatorii NEAUTENTIFICATI. Aici nu poate avea randuri:
  // instanta izolata e lovita de pe bucla locala, iar acele adrese sunt excluse deliberat. Asta e
  // tocmai proba ca filtrul functioneaza — daca ar aparea randuri, ar insemna ca numaram nginx-ul
  // si sondele proprii drept vizitatori.
  ok('tabelul de accesari ale site-ului exista', (await adm.locator('#accessVisitors').count()) === 1);
  ok('...si NU numara traficul de pe bucla locala',
    /Nicio accesare/.test(await adm.locator('#accessVisitors').innerText().catch(() => '')));
  ok('...cu data si ora afisate', /\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}/.test(await adm.locator('#accessLogins').innerText().catch(() => '')));

  // Filtrul „doar esuate" trebuie sa schimbe efectiv continutul, nu doar clasa butonului.
  await adm.click('#accessFailed');
  await adm.waitForTimeout(700);
  const dupaFiltru = await adm.locator('#accessLogins').innerText().catch(() => '');
  ok('filtrul „doar esuate" nu mai arata reusite', !/reu[sș]it[ăa]/i.test(dupaFiltru));

  // Un utilizator obisnuit NU are voie sa vada panoul — nici intrarea de meniu, nici datele.
  const pgLim2 = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await login(pgLim2, 'limitat', PAROLA);
  ok('utilizatorul limitat NU vede intrarea de meniu', (await pgLim2.locator('#navAccesari.hidden').count()) === 1);

  // ...dar pachetul Windows E pentru toata lumea: oricine isi poate rula contabilitatea pe
  // calculatorul lui. Proba se face pe contul LIMITAT, nu pe admin — pe admin ar fi trecut si
  // daca intrarea ar fi fost gresit ingradita de rol.
  ok('contul limitat VEDE intrarea „Contabo pe calculatorul tau"',
    (await pgLim2.locator('#tabs button[data-tab="pachetwin"]').count()) === 1
    && (await pgLim2.locator('#tabs button[data-tab="pachetwin"].hidden').count()) === 0);
  await pgLim2.evaluate(() => window.goTab('pachetwin'));
  await pgLim2.waitForTimeout(900);
  ok('...si pagina se deschide pentru el', (await pgLim2.locator('#tab-pachetwin.active').count()) === 1);
  // Pachetul poate lipsi pe instanta de test (nu se construieste in E2E) — atunci pagina trebuie
  // sa EXPLICE, nu sa ramana goala. Oricare din cele doua stari e corecta; „nimic" nu e.
  const areCard = (await pgLim2.locator('#pachetWinCard:not(.hidden)').count()) === 1;
  const areExplicatie = (await pgLim2.locator('#pachetWinLipsa:not(.hidden)').count()) === 1;
  ok('...si arata ori pachetul, ori de ce lipseste (niciodata gol)', areCard || areExplicatie);
  // Videoul de prezentare: acelasi tipar (fisier static + manifest), deci aceeasi cerinta — pagina
  // arata ori playerul, ori motivul. Pe instanta de test filmul nu e publicat, deci se asteapta
  // explicatia; testul nu fixeaza care din cele doua, ca sa treaca si pe o instalare cu film.
  await pgLim2.evaluate(() => window.goTab('video'));
  await pgLim2.waitForTimeout(900);
  ok('pagina „Video de prezentare" se deschide', (await pgLim2.locator('#tab-video.active').count()) === 1);
  const areFilm = (await pgLim2.locator('#videoCard:not(.hidden)').count()) === 1;
  const areMotiv = (await pgLim2.locator('#videoLipsa:not(.hidden)').count()) === 1;
  ok('...si arata ori filmul, ori de ce lipseste (niciodata gol)', areFilm || areMotiv);
  const refuz = await apiIn(pgLim2, '/api/access-log');
  ok('...iar serverul ii refuza si datele (403), nu doar UI-ul ascunde', refuz.status === 403);
  await pgLim2.close();
}

await b.close();
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari E2E izolate trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
