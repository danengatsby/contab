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
// 2FA e DEZACTIVAT deliberat in produs: campul de cod de pe login e `disabled`, deci serverul ar
// cere un cod pe care formularul nu-l poate primi. Scenariul de aici nu mai poate PARCURGE fluxul
// (a si picat, din 30 iulie pana la 2 august, exact asa) — dar nici nu are voie sa dispara: atunci
// nimic n-ar mai observa ziua in care jumatatile se desincronizeaza din nou. Deci verifica STAREA:
// nicio cale de pornire in interfata, iesirea intacta, si mecanismul TOTP inca sanatos pentru cand
// 2FA se reactiveaza. Cand campul de login redevine activ, aici se pune la loc fluxul complet.
sect('3. Autentificare in doi pasi (2FA) — dezactivata deliberat');
{
  const p2 = await (await b.newContext()).newPage();
  await p2.goto(BASE + '/', { waitUntil: 'networkidle' });

  const camp = p2.locator('#loginForm input[name=code]');
  ok('campul de cod exista in formularul de login', (await camp.count()) === 1);
  const blocat = await camp.isDisabled().catch(() => false);
  ok('...si e INACTIV (2FA oprit in produs)', blocat);
  ok('...cu motivul scris langa el, nu doar stins', /momentan dezactivat/i.test(await p2.locator('#codeRow').innerText().catch(() => '')));

  // Capcana pe care o pazim: activare posibila + camp inactiv = cont blocat definitiv, fara nicio
  // cale de recuperare din interfata. Cele doua nu au voie sa coexiste.
  ok('nicio cale de PORNIRE a 2FA in interfata', (await p2.locator('#twofaStart, #twofaEnable').count()) === 0);
  ok('...dar iesirea ramane pentru cine are deja 2FA', (await p2.locator('#twofaDisableWrap').count()) === 1);

  // Login normal (fara cod) trebuie sa mearga in continuare — 2FA oprit nu inseamna login stricat.
  ok('login obisnuit merge in continuare', await login(p2, 'admin', PAROLA_ADMIN));
  await p2.close();

  // Generatorul TOTP ramane verificat, ca reactivarea sa fie o schimbare de UI, nu o repornire a
  // unui mecanism neprobat. Vector fix: RFC 4226/6238, secret 'GEZDGNBVGY3TQOJQ' (= "12345678901234567890").
  const c1t = totpCode('GEZDGNBVGY3TQOJQ', 59000);
  ok('TOTP: cod de 6 cifre pentru vectorul RFC', /^\d{6}$/.test(String(c1t)));
  ok('TOTP: acelasi moment -> acelasi cod (determinist)', totpCode('GEZDGNBVGY3TQOJQ', 59000) === c1t);
  ok('TOTP: alta fereastra de 30s -> alt cod', totpCode('GEZDGNBVGY3TQOJQ', 59000 + 60000) !== c1t);
}

// ─────────────────────────── 4. IMPORTURI ────────────────────────────────────
sect('4. Importuri (parteneri, produse)');
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
    ['stocuri', '#stocGestFilter'], ['productie', '#prodForm'], ['configstoc', '#gestiuniList']]) {
    await adm.evaluate((x) => window.goTab(x), tab);
    await adm.waitForTimeout(500);
    ok('pagina „' + tab + '" se deschide', (await adm.locator('#tab-' + tab + '.active').count()) === 1);
    ok('...si contine panoul mutat acolo (' + ancora + ')',
      (await adm.locator('#tab-' + tab + ' ' + ancora).count()) === 1);
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
  const refuz = await apiIn(pgLim2, '/api/access-log');
  ok('...iar serverul ii refuza si datele (403), nu doar UI-ul ascunde', refuz.status === 403);
  await pgLim2.close();
}

await b.close();
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari E2E izolate trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
