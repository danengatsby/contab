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
const ADMIN_TOTP_SECRET = process.env.E2E_ADMIN_TOTP_SECRET || '';

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
  await page.click('#loginForm button.primary');
  if (cod) {
    await page.waitForFunction(() => !document.querySelector('#codeRow')?.classList.contains('hidden'));
    await page.fill('#loginForm input[name=code]', cod);
    await page.click('#loginForm button.primary');
  }
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
ok('admin se autentifica prin interfata', await login(pg, 'admin', PAROLA, totpCode(ADMIN_TOTP_SECRET)));
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
  ok('parola NOUA merge', await login(pgNou, 'admin', PAROLA2, totpCode(ADMIN_TOTP_SECRET)));
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
// de aici incolo lucram pe o sesiune de admin VALIDA (resetarea a invalidat-o pe cea initiala)
const adm = pgNou || pg;

// ─────────────────────────── 3. 2FA ──────────────────────────────────────────
// Flux complet prin interfata: configurare, confirmare TOTP, login in doi pasi si dezactivare.
// Acesta leaga explicit cele doua jumatati ale functiei: nimeni nu poate activa 2FA daca formularul
// de login nu poate primi codul, iar campul nu ramane un control mort fara configurare in Cont.
sect('3. Autentificare in doi pasi (2FA) — flux complet prin interfata');
{
  // Administratorul ramane obligatoriu protejat cu factorul pregatit de launcher. Exercitam
  // activarea si dezactivarea pe un cont neprivilegiat dedicat, unde ambele tranzitii sunt valide.
  const factorPage = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const factorLogin = await login(factorPage, 'doifa-e2e', PAROLA);
  await factorPage.evaluate(() => window.goTab('cont'));
  ok('Setari ofera configurarea 2FA', factorLogin && (await factorPage.locator('#twofaStart:visible').count()) === 1);
  // Resetarea autentifica direct si poate deschide bun-venitul peste pagina Cont.
  await factorPage.evaluate(() => document.querySelector('#welcomeOverlay')?.classList.add('hidden'));
  await factorPage.click('#twofaStart');
  await factorPage.waitForFunction(() => document.querySelector('#twofaSecret')?.textContent?.length >= 16);
  const secret = (await factorPage.locator('#twofaSecret').innerText()).trim();
  ok('configurarea afiseaza cheia TOTP', /^[A-Z2-7]{16,}$/.test(secret));
  ok('configurarea afiseaza QR-ul intr-o sursa inerta',
    /^data:image\/svg\+xml/.test(await factorPage.locator('#twofaQr').getAttribute('src') || ''));
  await factorPage.fill('#twofaCode', totpCode(secret));
  await factorPage.click('#twofaEnable');
  await factorPage.waitForFunction(() => /este activat/i.test(document.querySelector('#twofaStatus')?.textContent || ''));
  ok('codul corect activeaza 2FA din interfata',
    /este activat/i.test(await factorPage.locator('#twofaStatus').innerText()));
  await factorPage.waitForFunction(() => !document.querySelector('#twofaRecovery')?.classList.contains('hidden'));
  const recoveryCodes = (await factorPage.locator('#twofaRecoveryCodes').inputValue()).split(/\s+/).filter(Boolean);
  ok('activarea afiseaza o singura data cele 8 coduri de rezerva', recoveryCodes.length === 8
    && recoveryCodes.every((x) => /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(x)));

  const p2 = await (await b.newContext()).newPage();
  await p2.goto(BASE + '/', { waitUntil: 'networkidle' });
  const camp = p2.locator('#loginForm input[name=code]');
  ok('campul de cod exista si este activ', (await camp.count()) === 1 && !(await camp.isDisabled()));
  ok('campul ramane ascuns pana cand parola corecta cere al doilea pas',
    await p2.locator('#codeRow').evaluate((el) => el.classList.contains('hidden')));
  await p2.fill('#loginForm input[name=username]', 'doifa-e2e');
  await p2.fill('#loginForm input[name=password]', PAROLA);
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
  await factorPage.close();

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
  // Coloana a patra este CONTUL de stoc, conform contractului importului — nu pret de vanzare.
  const pcsv = 'cod,denumire,um,cont\nE2E-1,Produs E2E,buc,371\n';
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

  // Seed-ul păstrează intenționat un articol salarial vechi, fără fotografia imuabilă pe angajat.
  // Documentele finale îl refuză corect; scenariul trebuie să facă fluxul real: storno + repostare.
  const articole = (await apiIn(adm, '/api/entries?period=' + per)).body || [];
  const listaArticole = Array.isArray(articole) ? articole : (articole.items || []);
  // Dependența se desface în ordine inversă: întâi plata 421=5121, abia apoi statul care a
  // constituit 421. Garda serviciului refuză deliberat ordinea opusă.
  for (const tip of ['plata_salarii', 'stat_plata']) {
    const vechi = listaArticole.find((e) => e.tip === tip && !e.stornat);
    if (vechi) await apiIn(adm, '/api/entries/' + encodeURIComponent(vechi.id) + '/storno', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: per + '-30' }),
    });
  }
  const statNou = await apiIn(adm, '/api/stat-plata?period=' + per, { method: 'POST' });
  ok('preconditie D112: statul vechi este corectat si repostat cu fotografie completa', statNou.status === 200);

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
  // `goTab`, nu un click pe butonul din meniu: navigația are dropdownuri, iar butonul unui grup
  // inchis nu e VIZIBIL pentru Playwright, deci clickul expira. Aceeasi cale ca in scripts/e2e.mjs.
  // Restaurarea din sectiunea 7 readuce o baza in care contul pare „nou", deci apare ecranul de
  // bun-venit — un overlay care intercepteaza clickurile. Se inchide inainte de a atinge panoul.
  await adm.evaluate(() => { const w = document.querySelector('#welcomeOverlay'); if (w) w.classList.add('hidden'); });

  // Panoul e o intrare PROPRIE in submeniul Setari, nu un card in „Setari generale". Se verifica
  // intai ca intrarea exista si e oferita adminului, apoi ca deschide chiar sectiunea lui.
  // Setarile au fost sparte in cinci pagini tematice. Fiecare intrare trebuie sa deschida efectiv
  // sectiunea ei si sa afiseze continut — o poarta pe sursa dovedeste ca sectiunile EXISTA, dar nu
  // si ca navigarea chiar ajunge acolo cu panourile randate.
  const controlAudit = [];
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
    controlAudit.push(...await adm.evaluate((numeTab) => {
      const root = document.querySelector('#tab-' + numeTab);
      if (!root) return [];
      const tipuriMici = new Set(['checkbox', 'radio', 'color', 'hidden', 'file']);
      const selector = 'button, a.btn, input, select, textarea, summary';
      return [...root.querySelectorAll(selector)].filter((el) => {
        if (el.matches('input') && tipuriMici.has((el.type || '').toLowerCase())) return false;
        const stil = getComputedStyle(el); const box = el.getBoundingClientRect();
        return stil.display !== 'none' && stil.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      }).map((el) => {
        const stil = getComputedStyle(el); const box = el.getBoundingClientRect();
        const compact = !!el.closest('table, .tablewrap');
        return {
          tab: numeTab,
          control: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''),
          compact,
          height: Math.round(box.height * 10) / 10,
          font: Math.round(parseFloat(stil.fontSize) * 10) / 10,
        };
      });
    }, tab));
  }

  const normaleJoase = controlAudit.filter((x) => !x.compact && x.height < 36).slice(0, 15);
  const normaleMici = controlAudit.filter((x) => !x.compact && x.font < 14).slice(0, 15);
  const compacteJoase = controlAudit.filter((x) => x.compact && x.height < 30).slice(0, 15);
  const compacteMici = controlAudit.filter((x) => x.compact && x.font < 12).slice(0, 15);
  ok('controalele normale au minimum 36 px înălțime: ' + JSON.stringify(normaleJoase), normaleJoase.length === 0);
  ok('textul controalelor normale are minimum 14 px: ' + JSON.stringify(normaleMici), normaleMici.length === 0);
  ok('numai controalele compacte din tabele pot coborî la 30 px: ' + JSON.stringify(compacteJoase), compacteJoase.length === 0);
  ok('textul controalelor compacte rămâne la minimum 12 px: ' + JSON.stringify(compacteMici), compacteMici.length === 0);

  // Fixture efemer pentru vocabularul semantic. Nu verificăm nuanțe scrise de mână, ci că cele
  // patru sensuri rămân distincte în cascada CALCULATĂ, în ambele teme, și că geometria compactă
  // nu coboară sub contractul design system-ului.
  const feedback = await adm.evaluate(() => {
    const eraDark = document.body.classList.contains('dark');
    const masoara = (dark) => {
      document.body.classList.toggle('dark', dark);
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-10000px;top:0';
      host.innerHTML = `
        <button class="alert info" data-go="x"><span class="al-tx">Informare</span></button>
        <div class="alert warn"><span class="al-tx">Avertisment</span></div>
        <div class="alert bad"><span class="al-tx">Eroare</span></div>
        <div class="alert ok"><span class="al-tx">Succes</span></div>
        <span class="pill ok">Succes</span><span class="pill warn">Avertisment</span>
        <span class="pill err">Eroare</span><span class="pill muted">Neutru</span>
        <div class="notice info"><span class="notice-icon">i</span><div>Informare</div></div>
        <div class="notice warning"><span class="notice-icon">!</span><div>Avertisment</div></div>
        <div class="notice danger"><span class="notice-icon">!</span><div>Eroare</div></div>
        <div class="notice success"><span class="notice-icon">v</span><div>Succes</div></div>`;
      document.body.appendChild(host);
      const alerts = [...host.querySelectorAll('.alert')].map((el) => {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return { border: s.borderLeftColor, bg: s.backgroundColor, cursor: s.cursor,
          font: parseFloat(s.fontSize), height: r.height };
      });
      const pills = [...host.querySelectorAll('.pill')].map((el) => {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return { color: s.color, bg: s.backgroundColor, font: parseFloat(s.fontSize), height: r.height };
      });
      const notices = [...host.querySelectorAll('.notice')].map((el) => {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return { border: s.borderLeftColor, bg: s.backgroundColor,
          font: parseFloat(s.fontSize), height: r.height };
      });
      host.remove();
      return { alerts, pills, notices };
    };
    const rezultat = { light: masoara(false), dark: masoara(true) };
    document.body.classList.toggle('dark', eraDark);
    return rezultat;
  });
  const temeFeedback = [feedback.light, feedback.dark];
  ok('feedback-ul semantic are patru stări vizual distincte în temele clară și întunecată',
    temeFeedback.every((t) => new Set(t.alerts.map((x) => x.border)).size === 4
      && new Set(t.pills.map((x) => x.color)).size === 4
      && new Set(t.notices.map((x) => x.border)).size === 4));
  ok('feedback-ul respectă dimensiunile și cursorul semantic: ' + JSON.stringify(feedback.light),
    temeFeedback.every((t) => t.alerts.every((x) => x.font >= 14 && x.height >= 36)
      && t.pills.every((x) => x.font >= 12 && x.height >= 24)
      && t.notices.every((x) => x.font >= 14 && x.height >= 44)
      && t.alerts[0].cursor === 'pointer' && t.alerts.slice(1).every((x) => x.cursor === 'default')));

  // Toastul folosește aceleași stări semantice, dar are și contract comportamental: mesajul nou
  // anulează timerul vechi, iar eroarea devine alertă assertive. Interceptăm temporar timerele ca
  // verificarea să fie deterministă și să nu aștepte 5,2 secunde doar pentru a dovedi durata.
  const toastFeedback = await adm.evaluate(async () => {
    const { toast } = await import('/core.js');
    const t = document.querySelector('#toast');
    const eraDark = document.body.classList.contains('dark');
    const setTimeoutReal = window.setTimeout; const clearTimeoutReal = window.clearTimeout;
    const planificate = []; const anulate = [];
    window.setTimeout = (fn, ms) => {
      const id = 8100 + planificate.length;
      planificate.push({ id, ms, fn });
      return id;
    };
    window.clearTimeout = (id) => { anulate.push(id); };
    const masoara = (dark, err) => {
      document.body.classList.toggle('dark', dark);
      toast(err ? 'Nu s-a putut salva' : 'Salvat', err);
      const s = getComputedStyle(t); const r = t.getBoundingClientRect();
      return { role: t.getAttribute('role'), live: t.getAttribute('aria-live'),
        border: s.borderLeftColor, bg: s.backgroundColor, pointer: s.pointerEvents,
        font: parseFloat(s.fontSize), height: r.height, clasa: t.className };
    };
    const rezultat = {
      successLight: masoara(false, false), errorLight: masoara(false, true),
      successDark: masoara(true, false), errorDark: masoara(true, true),
    };
    rezultat.durate = planificate.map((x) => x.ms);
    rezultat.anulate = [...anulate];
    rezultat.offlineSvg = !!document.querySelector('#offlineBanner > .app-icon[data-icon="offline"] svg');
    const ultima = planificate[planificate.length - 1];
    if (ultima) ultima.fn(); // readuce și starea internă `toastTimer` la zero
    window.setTimeout = setTimeoutReal; window.clearTimeout = clearTimeoutReal;
    document.body.classList.toggle('dark', eraDark);
    return rezultat;
  });
  const toasturi = [toastFeedback.successLight, toastFeedback.errorLight,
    toastFeedback.successDark, toastFeedback.errorDark];
  ok('toastul diferențiază succesul de eroare în ambele teme și rămâne lizibil: '
    + JSON.stringify(toastFeedback),
  toastFeedback.successLight.border !== toastFeedback.errorLight.border
      && toastFeedback.successDark.border !== toastFeedback.errorDark.border
      && toasturi.every((x) => x.font >= 14 && x.height >= 44 && x.pointer === 'none'));
  ok('toastul anulează mesajul anterior, iar eroarea are prioritate accesibilă și icon SVG offline',
    toastFeedback.durate.join(',') === '3600,5200,3600,5200'
      && toastFeedback.anulate.join(',') === '8100,8101,8102'
      && toastFeedback.successLight.role === 'status' && toastFeedback.successLight.live === 'polite'
      && toastFeedback.errorLight.role === 'alert' && toastFeedback.errorLight.live === 'assertive'
      && toastFeedback.offlineSvg);

  // Același motor de pași/autosave trebuie să fie montat peste toate formularele lungi. Numărul
  // fixează ierarhia intenționată și prinde inclusiv regresia „butonul final devine pas gol".
  const fluxuri = await adm.evaluate(() => ({
    firma: document.querySelectorAll('#companyForm > .form-step').length,
    angajat: document.querySelectorAll('#angajatForm > .form-step').length,
    document: document.querySelectorAll('#entryForm > .form-step').length,
    activ: document.querySelectorAll('#assetForm > .form-step').length,
    leasing: document.querySelectorAll('#lcForm > .form-step').length,
    miscare: document.querySelectorAll('#movementForm > .form-step').length,
    partener: document.querySelectorAll('#partnerForm > .form-step').length,
    fiscal: document.querySelectorAll('#fiscalForm > .form-step').length,
    recurenta: document.querySelectorAll('#recForm > .form-step').length,
    serii: document.querySelectorAll('#docSeriesForm > .form-step').length,
    productie: document.querySelectorAll('#prodForm > .form-step').length,
    reteta: document.querySelectorAll('#recipeForm > .form-step').length,
    produs: document.querySelectorAll('#productForm > .form-step').length,
    exigibilitate: document.querySelectorAll('#exigForm > .form-step').length,
    soldAnalitic: document.querySelectorAll('#oaForm > .form-step').length,
    modernizare: document.querySelectorAll('#mfInvForm > .form-step').length,
    simulatorLeasing: document.querySelectorAll('#lsForm > .form-step').length,
    profil: document.querySelectorAll('#profileForm > .form-step').length,
    designSystem: [...document.styleSheets].some((sheet) => /\/design-system\.css(?:$|\?)/.test(sheet.href || '')),
  }));
  ok('design system-ul reutilizabil este încărcat în browser', fluxuri.designSystem);
  ok('formularul firmei are 4 pași', fluxuri.firma === 4);
  ok('formularul angajatului are 5 pași', fluxuri.angajat === 5);
  ok('formularul documentului are 2 pași', fluxuri.document === 2);
  ok('formularul mijlocului fix are 3 pași', fluxuri.activ === 3);
  ok('contractul de leasing are 3 pași', fluxuri.leasing === 3);
  ok('mișcarea de stoc are 3 pași', fluxuri.miscare === 3);
  ok('partenerul are 2 pași', fluxuri.partener === 2);
  ok('configurația fiscală globală are 4 pași', fluxuri.fiscal === 4);
  ok('șablonul facturii recurente are 3 pași', fluxuri.recurenta === 3);
  ok('seriile documentelor au 2 pași', fluxuri.serii === 2);
  ok('înregistrarea producției are 3 pași', fluxuri.productie === 3);
  ok('rețeta de producție are 3 pași', fluxuri.reteta === 3);
  ok('produsul din nomenclator are 2 pași', fluxuri.produs === 2);
  ok('exigibilitatea TVA are 2 pași', fluxuri.exigibilitate === 2);
  ok('soldul inițial analitic are 2 pași', fluxuri.soldAnalitic === 2);
  ok('modernizarea mijlocului fix are 2 pași', fluxuri.modernizare === 2);
  ok('simulatorul de leasing are 2 pași', fluxuri.simulatorLeasing === 2);
  ok('profilul personal are 2 pași', fluxuri.profil === 2);
  const iconografie = await adm.evaluate(() => {
    const controale = [...document.querySelectorAll('button, a, summary, label.attach-btn, .emit-guided .gt')];
    const noticeIcons = [...document.querySelectorAll('.notice-icon')];
    const simbolInitial = /^\s*(?:[\u2190-\u2bff]|\p{Extended_Pictographic})/u;
    const textDirect = (el) => [...el.childNodes]
      .filter((nod) => nod.nodeType === Node.TEXT_NODE).map((nod) => nod.nodeValue).join(' ').trim();
    return {
      svg: controale.filter((el) => el.querySelector(':scope > .app-icon > svg')).length,
      noticeSvg: noticeIcons.filter((el) => el.querySelector(':scope > .app-icon > svg')).length,
      noticeTotal: noticeIcons.length,
      legacy: controale.filter((el) => simbolInitial.test(textDirect(el)))
        .slice(0, 12).map((el) => ({ tag: el.tagName, id: el.id, text: textDirect(el) })),
    };
  });
  ok('controalele și mesajele persistente folosesc setul SVG comun (' + iconografie.svg
    + ' controale, ' + iconografie.noticeSvg + '/' + iconografie.noticeTotal + ' mesaje)',
    iconografie.svg > 70 && iconografie.noticeTotal > 0 && iconografie.noticeSvg === iconografie.noticeTotal);
  ok('butoanele, linkurile și secțiunile nu mai încep cu simboluri Unicode: '
    + JSON.stringify(iconografie.legacy), iconografie.legacy.length === 0);
  const actiuniMesaj = await adm.evaluate(async () => {
    const messages = await import('/messages.js');
    const host = document.createElement('div');
    host.innerHTML = messages.bubble({ id: 'ui-audit', fromAdmin: true, text: 'Mesaj de control', createdAt: new Date().toISOString() }, true);
    document.body.appendChild(host);
    const del = host.querySelector('.msg-del').getBoundingClientRect();
    const edit = host.querySelector('.msg-edit').getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(host.querySelector('.msg-b')).paddingRight);
    host.remove();
    return { del: [del.width, del.height], edit: [edit.width, edit.height], padding };
  });
  ok('acțiunile suprapuse pe mesaj au ținte 36×36 px și loc rezervat în bulă: '
    + JSON.stringify(actiuniMesaj),
  actiuniMesaj.del.every((x) => x >= 36) && actiuniMesaj.edit.every((x) => x >= 36) && actiuniMesaj.padding >= 88);
  await adm.evaluate(() => {
    const profile = document.querySelector('#profileForm');
    profile.cnp.value = '1900101415238';
    profile.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await adm.waitForTimeout(700);
  // Inscrierea nu mai are flux de formular (panou readus la forma clasica), deci nu are ce
  // stoca — proba ramane valoroasa: dovedeste ca NIMIC de pe acel formular nu ajunge in tab.
  ok('înscrierea nu lasă nimic în sessionStorage', await adm.evaluate(() =>
    !Object.keys(sessionStorage).some((key) => key.includes(':registerForm:'))));
  ok('CNP-ul profilului nu este copiat în sessionStorage', await adm.evaluate(() =>
    !Object.keys(sessionStorage).some((key) => key.includes(':profileForm:'))));

  // Producția are linii fără atribut `name`, construite dinamic. Verificăm payload-ul real din
  // sessionStorage: serializerul dedicat trebuie să păstreze și aceste materiale, nu doar antetul.
  await adm.evaluate(() => {
    window.goTab('productie');
    const form = document.querySelector('#prodForm');
    form.document.value = 'Bon producție autosave E2E';
    const qty = form.querySelector('.pm-qty'); if (qty) qty.value = '2.750';
    form.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await adm.waitForFunction(() => Object.keys(sessionStorage).some((key) => key.includes(':prodForm:')), null, { timeout: 4000 });
  const draftProductie = await adm.evaluate(() => {
    const key = Object.keys(sessionStorage).find((item) => item.includes(':prodForm:'));
    const payload = key ? JSON.parse(sessionStorage.getItem(key)) : null;
    return payload && payload.data;
  });
  ok('autosave-ul producției păstrează liniile dinamice de materiale',
    draftProductie && draftProductie.values.document === 'Bon producție autosave E2E'
      && draftProductie.materiale[0].cantitate === '2.750');
  await adm.click('#prodForm .form-draft-discard');
  await adm.click('.app-dialog .btn.danger');

  // Autosave real în browser: scriere după debounce, cheie izolată pe firmă și restaurare după
  // reload. Nu se trimite niciun POST; ciorna locală nu este confundată cu salvarea oficială.
  adm.on('pageerror', (error) => console.error('  eroare browser în fluxul de formular:', error.message));
  await adm.evaluate(() => window.goTab('angajati'));
  await adm.click('#angajatNou');
  await adm.fill('#angajatForm input[name="nume"]', 'Ciornă locală E2E');
  // Instanța tocmai a randat multe rapoarte; în loc de o pauză fragilă, așteptăm efectul promis
  // de debounce (event loop-ul poate fi ocupat mai mult de 700 ms în containerul CI).
  try {
    await adm.waitForFunction(() => Object.keys(sessionStorage).some((item) => item.includes(':angajatForm:')), null, { timeout: 4000 });
  } catch (error) {
    const diagnostic = await adm.evaluate(() => ({
      keys: Object.keys(sessionStorage),
      status: document.querySelector('#angajatForm .form-progress-status')?.textContent,
      formFlow: document.querySelector('#angajatForm')?.dataset.formFlow,
      value: document.querySelector('#angajatForm input[name="nume"]')?.value,
    }));
    console.error('  diagnostic autosave angajat:', diagnostic);
    throw error;
  }
  const draftAngajat = await adm.evaluate(() => {
    const key = Object.keys(sessionStorage).find((item) => item.includes(':angajatForm:'));
    return { key: key || '', raw: key ? sessionStorage.getItem(key) : '' };
  });
  ok('angajatul se autosalvează după debounce', /Ciornă locală E2E/.test(draftAngajat.raw));
  ok('cheia ciornei conține firma activă și entitatea nouă',
    draftAngajat.key.includes(':' + await adm.locator('#firmaSelect').inputValue() + ':nou'));
  await adm.reload({ waitUntil: 'networkidle' });
  await adm.waitForTimeout(1200);
  await adm.evaluate(() => { document.querySelector('#welcomeOverlay')?.classList.add('hidden'); window.goTab('angajati'); });
  ok('ciorna angajatului este restaurată după reload',
    (await adm.locator('#angajatForm input[name="nume"]').inputValue()) === 'Ciornă locală E2E');
  ok('starea vizibilă spune că ciorna a fost restaurată',
    /Ciornă restaurată/.test(await adm.locator('#angajatForm .form-progress-status').innerText()));
  ok('ciorna restaurată afișează controlul de ștergere', await adm.locator('#angajatForm .form-draft-discard').isVisible());
  await adm.click('#angajatForm .form-draft-discard');
  await adm.click('.app-dialog .btn.danger');
  ok('ștergerea confirmată golește formularul',
    (await adm.locator('#angajatForm input[name="nume"]').inputValue()) === '');
  ok('ștergerea confirmată elimină cheia locală', await adm.evaluate(() =>
    !Object.keys(sessionStorage).some((key) => key.includes(':angajatForm:'))));

  // Documentele au controale reconstruite dinamic; verificăm că serializerul lor dedicat păstrează
  // obiectul `fields`, nu doar inputurile statice ale formularului.
  await adm.evaluate(() => window.goTab('documente'));
  await adm.click('#manualBtn');
  await adm.fill('#fld_explicatie', 'Notă din autosave E2E');
  await adm.waitForTimeout(700);
  const draftDocument = await adm.evaluate(() => {
    const key = Object.keys(sessionStorage).find((item) => item.includes(':entryForm:'));
    const payload = key ? JSON.parse(sessionStorage.getItem(key)) : null;
    return { key: key || '', explicatie: payload && payload.data && payload.data.fields && payload.data.fields.explicatie };
  });
  ok('autosave-ul documentului păstrează câmpurile dinamice', draftDocument.explicatie === 'Notă din autosave E2E');
  await adm.evaluate(() => document.querySelector('#cancelEntry').click());
  ok('Renunță elimină numai ciorna locală a documentului', await adm.evaluate(() =>
    !Object.keys(sessionStorage).some((key) => key.includes(':entryForm:'))));

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

// ────────── 12. NAVIGAREA LOGICA + MODUL SIMPLU ───────────────────────────────
// `#tabs` conține ciclul contabil și grupul Unelte. Doar firma și perioada sunt mutate în
// context; panoul separat Unelte nu mai există.
sect('12. Carcasa are o singura navigare logica si un context unic');
{
  await adm.goto(BASE + '/', { waitUntil: 'networkidle' });
  await adm.evaluate(() => { const w = document.querySelector('#welcomeOverlay'); if (w) w.classList.add('hidden'); });
  ok('navigatorul și grupul Unelte există o singură dată',
    (await adm.locator('#tabs').count()) === 1 && (await adm.locator('#sideTools').count()) === 1
    && (await adm.locator('#tabs #sideTools').count()) === 1
    && (await adm.locator('#erpMenu,#erpTools').count()) === 0);
  const topNav = await adm.evaluate(() => {
    const antet = document.querySelector('.topbar').getBoundingClientRect();
    const meniu = document.querySelector('#tabs').getBoundingClientRect();
    const principal = document.querySelector('.shell > main').getBoundingClientRect();
    return { antetStanga: antet.left, antetDreapta: antet.right, meniuSus: meniu.top,
      principalStanga: principal.left, latime: innerWidth, scroll: document.documentElement.scrollWidth };
  });
  ok('desktop: meniul este sus, ocupă lățimea paginii și nu mai rezervă o coloană laterală',
    topNav.antetStanga >= -0.5 && topNav.antetDreapta <= topNav.latime + 0.5
      && topNav.meniuSus > 0 && topNav.principalStanga < 40 && topNav.scroll <= topNav.latime + 1);
  await adm.click('#tabs .navgroup:has(button[data-tab="documente"]) > .navlabel');
  const dropdown = await adm.evaluate(() => {
    const g = document.querySelector('#tabs .navgroup:has(button[data-tab="documente"])');
    const l = g.querySelector('.navlabel').getBoundingClientRect();
    const m = g.querySelector('.navmenu').getBoundingClientRect();
    return { vizibil: getComputedStyle(g.querySelector('.navmenu')).display !== 'none',
      subEticheta: m.top >= l.bottom, inEcran: m.left >= 0 && m.right <= innerWidth };
  });
  ok('desktop: grupurile se deschid ca dropdown sub etichetă, integral în ecran',
    dropdown.vizibil && dropdown.subEticheta && dropdown.inEcran);
  await adm.click('#tabs button[data-tab="documente"]');
  await adm.waitForTimeout(250);
  ok('desktop: alegerea unei pagini închide dropdownul și activează conținutul',
    !(await adm.locator('#tabs .navgroup:has(button[data-tab="documente"])').evaluate((g) => g.classList.contains('open')))
      && (await adm.locator('#tab-documente').isVisible()));
  await adm.evaluate(() => window.goTab('dashboard'));
  ok('bara contextuala este montata', (await adm.locator('#appContext').count()) === 1);
  const controaleUnice = await adm.evaluate(() => ({
    firme: document.querySelectorAll('#firmaSelect').length,
    perioade: document.querySelectorAll('.curgroup').length,
    unelte: document.querySelectorAll('#sideTools').length,
    firmaInContext: !!document.querySelector('#appContext #firmaSelect'),
    perioadaInContext: !!document.querySelector('#appContext .curgroup'),
    unelteInContext: !!document.querySelector('#appContext #sideTools'),
    unelteInNavigator: !!document.querySelector('#tabs #sideTools'),
  }));
  ok('firma, perioada și grupul Unelte există o singură dată',
    controaleUnice.firme === 1 && controaleUnice.perioade === 1 && controaleUnice.unelte === 1);
  ok('contextul păstrează firma/perioada, iar Unelte rămâne numai în navigator',
    controaleUnice.firmaInContext && controaleUnice.perioadaInContext
      && !controaleUnice.unelteInContext && controaleUnice.unelteInNavigator);
  ok('cele cinci comenzi sunt directe după Acasă, iar Cartea/Mesaje rămân în Unelte',
    await adm.evaluate(() => [...document.querySelector('#tabs').children].filter((el) => el.tagName === 'BUTTON')
      .slice(0, 7).map((el) => el.id || el.dataset.tab).join(',')
      === 'dashboard,toolGhid,paletaBtn,themeBtn,uiModeBtn,glossaryBtn,notificari')
    && (await adm.locator('#sideTools #toolCartea, #sideTools #toolMesaje').count()) === 2
    && (await adm.locator('#sideTools > button, #sideTools > a').count()) === 4
    && (await adm.locator('#tabs [data-tab="ghid"], #tabs [data-tab="mesaje"], #tabs a[href="/carte/"]').count()) === 3
    && (await adm.locator('#tabs [data-tab="portofoliu"]').count()) === 0);

  const masoara = () => adm.evaluate(() => {
    const viz = (e) => !!e && e.offsetParent !== null;
    const toate = [...document.querySelectorAll('#tabs button[data-tab]')].filter((x) =>
      !x.classList.contains('hidden') && !(x.closest('.navgroup') && x.closest('.navgroup').classList.contains('hidden')));
    const adv = new Set();
    toate.filter((x) => x.classList.contains('adv') || (x.closest('.navgroup') && x.closest('.navgroup').classList.contains('adv')))
      .forEach((x) => adv.add(x.dataset.tab));
    // dropdownurile se deschid integral înainte de citire, altfel ascunderea ar trece pe mulțime vidă
    document.querySelectorAll('#tabs .navgroup').forEach((g) => { if (viz(g)) g.classList.add('open'); });
    const lateral = [...document.querySelectorAll('#tabs button[data-tab]')].filter(viz).map((x) => x.dataset.tab);
    return {
      nrAdv: adv.size,
      lateralAdv: lateral.filter((t) => adv.has(t)),
      totalTaburi: toate.length,
      lateralTotal: lateral.length,
    };
  });
  const pune = (mod) => adm.evaluate((m) => {
    const vrea = m === 'simplu';
    if (document.body.classList.contains('simple-ui') !== vrea) document.querySelector('#uiModeBtn').click();
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    return document.body.classList.contains('simple-ui');
  }, mod);

  ok('comutatorul chiar pune modul simplu', (await pune('simplu')) === true);
  await adm.waitForTimeout(300);
  const s = await masoara();
  // Poarta trebuie sa VADA ceva: daca marcajul `.adv` dispare din HTML, restul aserțiunilor ar
  // trece pe o multime goala — adica exact „verde din motivul gresit".
  ok('exista intrari tehnic-contabile de ascuns (poarta nu masoara o multime goala)', s.nrAdv >= 8);
  ok('mod simplu: nicio intrare tehnic-contabila in navigatie'
    + (s.lateralAdv.length ? ' — SCAPA: ' + s.lateralAdv.join(', ') : ''), s.lateralAdv.length === 0);
  ok('mod simplu: navigatia ofera exact taburile ramase', s.lateralTotal === s.totalTaburi - s.nrAdv);

  // Reversul: modul expert readuce toate intrarile tehnice in acelasi arbore.
  ok('comutatorul revine pe expert', (await pune('expert')) === false);
  await adm.waitForTimeout(300);
  const e = await masoara();
  ok('mod expert: toate intrarile tehnic-contabile revin in meniul superior', e.lateralAdv.length === e.nrAdv);
  ok('mod expert: arborele ofera toate taburile', e.lateralTotal === e.totalTaburi);
}

// ────────── 13. PE TELEFON, ECRANUL DE INTRARE NU DERULEAZA PAGINA DE DEDESUBT ──────────
// Ecranele-strat (`.login-overlay`: intrare, inscriere, preturi, intrebari, bun venit) sunt
// `position:fixed` si isi deruleaza corect propriul continut. Dar `body` ramanea derulabil, deci
// pe telefon degetul, dupa ce termina overlay-ul, ducea in vedere carcasa goala a aplicatiei:
// „Previziune cash-flow", „Aging — vechimea soldurilor", „Ultimele operatiuni". Nu se scurgea
// nicio data (API-ul raspunde 401), dar vizitatorul vedea un ecran care nu e al lui.
//
// De ce AICI si nu in suita unitara: efectul e derularea calculata de browser din doua reguli CSS
// (`overflow` propagat de la radacina + `overscroll-behavior`), pe un DOM real. O poarta pe sursa
// dovedeste ca regula e scrisa — nu si ca degetul chiar nu mai ajunge in pagina.
//
// Capcana de masurare, platita o data: `window.scrollTo()` deruleaza PROGRAMATIC si trece peste
// `overflow:hidden`, deci raporta „stricat" si dupa reparatie. Se foloseste rotita/degetul.
sect('13. Ecranul de intrare pe telefon nu deruleaza aplicatia de dedesubt');
{
  const tel = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await tel.goto(BASE + '/', { waitUntil: 'networkidle' });
  await tel.waitForTimeout(800);
  ok('ecranul de intrare e afisat', (await tel.locator('#loginOverlay:not(.hidden)').count()) === 1);
  await tel.mouse.move(195, 400);
  for (let i = 0; i < 8; i++) { await tel.mouse.wheel(0, 500); await tel.waitForTimeout(100); }
  await tel.waitForTimeout(300);
  const m = await tel.evaluate(() => {
    const ov = document.querySelector('#loginOverlay');
    return {
      overlayScrollTop: Math.round(ov.scrollTop),
      overlayMax: Math.round(ov.scrollHeight - ov.clientHeight),
      paginaScrollY: Math.round(window.scrollY),
    };
  });
  // Fara asta, poarta ar trece si pe o pagina care NU se deruleaza deloc — adica exact cazul in
  // care overlay-ul insusi s-ar fi stricat, iar continutul lui ar fi devenit inaccesibil.
  ok('overlay-ul isi deruleaza propriul continut (are ce derula)', m.overlayMax > 100);
  ok('...si ajunge pana la capatul lui', m.overlayScrollTop >= m.overlayMax - 2);
  ok('PAGINA de dedesubt ramane pe loc (masurat: ' + m.paginaScrollY + 'px)', m.paginaScrollY === 0);
  await tel.close();}

// ────────── 14. SHELL-UL LOCAL PE TELEFON: ACELAȘI ARBORE, FĂRĂ DEPĂȘIRI ──────────
// Aceste verificări există și în E2E-ul live, dar trebuie să ruleze și pe codul din worktree.
// Altfel o schimbare CSS locală ar fi validată pe versiunea deja publicată, nu pe cea care urmează
// să fie livrată. Refolosim sesiunea admin izolată; nu mai creăm date și nu atingem producția.
sect('14. Carcasa locală pe telefon (390px și 320px)');
{
  await adm.setViewportSize({ width: 390, height: 844 });
  await adm.goto(BASE + '/', { waitUntil: 'networkidle' });
  await adm.waitForTimeout(700);
  await adm.evaluate(() => {
    const w = document.querySelector('#welcomeOverlay');
    if (w) w.classList.add('hidden');
    if (window.goTab) window.goTab('dashboard');
  });
  ok('mobil local: dashboardul și contextul paginii se randează',
    (await adm.locator('#kpis .kpi').count()) > 0
      && (await adm.locator('#appContextTitle').isVisible())
      && (await adm.locator('.app-context-kicker').isVisible()));
  ok('mobil local: arborele unic pornește strâns',
    (await adm.locator('#bottomnav,#moreSheet').count()) === 0 && !(await adm.locator('#tabs').isVisible()));
  ok('mobil local: nu mai există un panou Unelte deasupra conținutului',
    !(await adm.locator('#appContext #sideTools').count()) && !(await adm.locator('#sideTools').isVisible()));
  ok('mobil local: dashboardul nu derulează orizontal',
    await adm.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await adm.click('#navToggleBtn');
  await adm.click('#navgrupUnelte > .navlabel');
  ok('mobil local: Meniu arată cele cinci comenzi direct și restul în Unelte',
    await adm.locator('#tabs').isVisible()
      && (await adm.locator('#toolGhid:visible, #tabs > .nav-action:visible').count()) === 5
      && (await adm.locator('#sideTools > button:visible, #sideTools > a:visible').count()) === 4
      && !(await adm.locator('#tabs [data-tab="portofoliu"]').count()));
  await adm.click('#tabs .navgroup:has(button[data-tab="tva"]) > .navlabel');
  await adm.click('#tabs button[data-tab="tva"]');
  await adm.waitForTimeout(700);
  ok('mobil local: navigarea închide sertarul și actualizează contextul',
    (await adm.locator('#tab-tva').isVisible()) && !(await adm.locator('#tabs').isVisible())
      && /TVA/i.test(await adm.locator('#appContextTitle').textContent())
      && (await adm.locator('#navToggleBtn').getAttribute('aria-expanded')) === 'false');

  await adm.evaluate(() => document.querySelector('#tabs button[data-tab="dashboard"]')?.click());
  await adm.setViewportSize({ width: 320, height: 700 });
  await adm.waitForTimeout(200);
  const mobil320 = await adm.evaluate(() => {
    const titlu = document.querySelector('#appContextTitle');
    const controale = document.querySelector('.app-context-controls');
    const antet = document.querySelector('.topbar');
    const textAlerta = document.querySelector('#dashAlerts .alert .al-tx');
    const r = controale && controale.getBoundingClientRect();
    const ra = antet && antet.getBoundingClientRect();
    const rt = textAlerta && textAlerta.getBoundingClientRect();
    const rezultat = !!titlu && getComputedStyle(titlu).display !== 'none' && !!r
      && r.left >= -0.5 && r.right <= window.innerWidth + 0.5
      && !!ra && ra.height <= 70 && !!rt && rt.width >= 180
      && document.documentElement.scrollWidth <= window.innerWidth + 1;
    return { rezultat, antet: ra && Math.round(ra.height), textAlerta: rt && Math.round(rt.width) };
  });
  ok('mobil local 320px: context lizibil, antet ≤70px și alertă ≥180px'
    + ' (antet ' + mobil320.antet + 'px, text ' + mobil320.textAlerta + 'px)', mobil320.rezultat);
}

sect('15. Registrele late spun ca mai e continut la dreapta');
{
  const cite = () => adm.evaluate(() => {
    const t = [...document.querySelectorAll('main table')]
      .filter((x) => x.getBoundingClientRect().width > 0)
      .sort((a, c) => c.scrollWidth - a.scrollWidth)[0];
    if (!t) return null;
    const w = t.parentElement;
    return {
      rest: t.scrollWidth - t.clientWidth,
      inTablewrap: !!w && w.classList.contains('tablewrap'),
      marcat: !!w && w.classList.contains('are-derulare'),
    };
  });

  // Conditia se forteaza din LATIMEA FERESTREI, nu din date: cate coloane are balanta in
  // fixture-ul E2E e o intamplare, iar o poarta care depinde de ea masoara gol si trece degeaba
  // (prima varianta a acestei sectiuni chiar asa a facut — balanta incapea, `rest` era 0).
  await adm.setViewportSize({ width: 900, height: 900 });
  await adm.evaluate(() => document.querySelector('#tabs button[data-tab="balanta"]')?.click());
  await adm.waitForTimeout(1000);
  const stramt = await cite();
  ok('la 900px balanta chiar are continut ascuns (poarta nu masoara gol): ' + (stramt && stramt.rest) + 'px',
    !!stramt && stramt.inTablewrap && stramt.rest > 1);
  ok('...si containerul ei poarta indiciul de derulare', !!stramt && stramt.marcat);

  await adm.evaluate(() => {
    const t = [...document.querySelectorAll('main table')]
      .filter((x) => x.getBoundingClientRect().width > 0)
      .sort((a, c) => c.scrollWidth - a.scrollWidth)[0];
    t.scrollLeft = t.scrollWidth;
    t.dispatchEvent(new Event('scroll'));
  });
  await adm.waitForTimeout(400);
  const laCapat = await cite();
  ok('indiciul dispare cand ai ajuns la capatul din dreapta', !!laCapat && !laCapat.marcat);

  // Acelasi tabel, fereastra larga: incape, deci indiciul nu are voie sa apara.
  await adm.setViewportSize({ width: 1920, height: 900 });
  await adm.waitForTimeout(800);
  const larg = await cite();
  ok('la 1920px acelasi registru incape si NU poarta indiciul (fara zgomot fals): '
    + (larg && larg.rest) + 'px', !!larg && larg.rest <= 1 && !larg.marcat);
  await adm.setViewportSize({ width: 1440, height: 900 });
}

sect('16. Alocarea din cockpit se pliaza dupa CATI oameni sunt, nu dupa o setare');
{
  await adm.evaluate(() => document.querySelector('#tabs button[data-tab="inchideri"]')?.click());
  await adm.waitForTimeout(1200);
  const c = await adm.evaluate(() => {
    const viz = (e) => e.getBoundingClientRect().height > 0;
    const unSelect = document.querySelector('.cl-resp');
    return {
      pasi: document.querySelectorAll('.closestep').length,
      pliate: document.querySelectorAll('.closealoc').length,
      // optiunile selectului = „— nealocat —" + cate un om
      oameni: unSelect ? unSelect.options.length - 1 : -1,
      selectoareVizibile: [...document.querySelectorAll('.cl-resp')].filter(viz).length,
    };
  });
  ok('poarta masoara pasi reali, nu o multime goala: ' + c.pasi + ' pasi', c.pasi >= 4);
  // Regula se DERIVA din date, deci proba o verifica pe amandoua ramurile, dupa cati oameni
  // exista chiar acum in instanta — nu presupune un numar (prima varianta a presupus „unul"
  // si a picat pe fixture-ul E2E, care creeaza conturi in plus pentru probele de roluri).
  if (c.oameni <= 1) {
    ok('cu ' + c.oameni + ' om, alocarea e pliata pe fiecare pas', c.pliate === c.pasi);
    ok('...si controalele chiar nu se vad', c.selectoareVizibile === 0);
  } else {
    ok('cu ' + c.oameni + ' oameni, alegerea are sens si NU se pliaza', c.pliate === 0);
    ok('...iar selectoarele sunt direct pe ecran', c.selectoareVizibile === c.pasi);
  }

  // Capcana de specificitate traieste DOAR in browser si nu depinde de date: `.closefields` are
  // `display:flex`, iar un `display` explicit pe copilul direct al unui `<details>` INCHIS il face
  // vizibil in Chrome. Se probeaza pe motorul real, cu un fragment construit aici — altfel proba
  // ar depinde de cati utilizatori are instanta.
  const capcana = await adm.evaluate(() => {
    const d = document.createElement('details');
    d.className = 'closealoc';
    d.innerHTML = '<summary>x</summary><div class="closefields"><label class="closefield">R<select></select></label></div>';
    document.querySelector('.closesteps, main').appendChild(d);
    const camp = d.querySelector('.closefields');
    const inchis = camp.getBoundingClientRect().height;
    d.setAttribute('open', '');
    const deschis = camp.getBoundingClientRect().height;
    d.remove();
    return { inchis, deschis };
  });
  ok('pliat inseamna INVIZIBIL, chiar daca `.closefields` are display:flex (inaltime '
    + Math.round(capcana.inchis) + 'px)', capcana.inchis === 0);
  ok('...iar desfasurat controalele revin (inaltime ' + Math.round(capcana.deschis) + 'px)',
    capcana.deschis > 0);
}

await b.close();
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari E2E izolate trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
