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
const cardStil = (page) => page.evaluate(() => {
  const el = document.querySelector('#usersCard');
  return el ? el.style.display : 'lipseste';
});
ok('adminul are administrarea utilizatorilor DISPONIBILA', (await cardStil(pg)) !== 'none');

const pgLim = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
ok('utilizatorul cu drepturi restranse se autentifica', await login(pgLim, 'limitat', PAROLA));
ok('...NU vede administrarea utilizatorilor (ascunsa dupa rol)', (await cardStil(pgLim)) === 'none');
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
sect('3. Autentificare in doi pasi (2FA)');
{
  const s = await apiIn(adm, '/api/2fa/setup', { method: 'POST' });
  const secret = s.body && (s.body.secret || (s.body.otpauth || '').match(/secret=([A-Z2-7]+)/i)?.[1]);
  ok('setup 2FA intoarce un secret', !!secret);
  if (secret) {
    const gresit = await apiIn(adm, '/api/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '000000' }) });
    ok('activarea cu cod GRESIT e respinsa', gresit.status >= 400);
    const en = await apiIn(adm, '/api/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: totpCode(secret) }) });
    ok('activarea cu cod corect reuseste', en.status === 200);
    // de acum, login-ul FARA cod trebuie sa ceara codul
    const p2 = await (await b.newContext()).newPage();
    ok('login fara cod 2FA NU intra', !(await login(p2, 'admin', PAROLA_ADMIN)));
    ok('...iar interfata cere codul', await p2.locator('#codeRow').isVisible().catch(() => false));
    ok('login CU cod 2FA intra', await login(p2, 'admin', PAROLA_ADMIN, totpCode(secret)));
    await p2.close();
    const dis = await apiIn(adm, '/api/2fa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: totpCode(secret) }) });
    ok('dezactivarea 2FA reuseste (cont curat pentru restul scenariilor)', dis.status === 200);
  }
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

await b.close();
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari E2E izolate trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
