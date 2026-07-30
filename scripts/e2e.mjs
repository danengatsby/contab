// Verificari end-to-end pe instanta LIVE (sau BASE_URL), cu browser real (Playwright).
// Foloseste contul demo — nu creeaza si nu sterge date reale.
//
// Rulare pe acest server (fara biblioteci de sistem pentru Chromium, prin Docker).
// Se monteaza DOAR fisierul, read-only: npm i ruleaza in containerul efemer, nu lasa
// node_modules pe host (un mount pe tot scripts/ ar scrie ~500 fisiere inapoi in repo).
//   docker run --rm -v /var/www/contab/scripts/e2e.mjs:/w/e2e.mjs:ro -w /w \
//     mcr.microsoft.com/playwright:v1.58.2-noble \
//     sh -c "npm i --no-save playwright@1.58.2 >/dev/null 2>&1 && node e2e.mjs"
// Local (cu playwright instalat):  BASE_URL=http://localhost:8080 node scripts/e2e.mjs

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'https://contabo.space';
let pass = 0; let fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name); } };

const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });

// 1. health + pagini publice
const health = await (await pg.request.get(BASE + '/api/health')).json().catch(() => ({}));
ok('/api/health raspunde ok', health.ok === true);
await pg.goto(BASE + '/prezentare.html', { waitUntil: 'networkidle' });
ok('prezentarea se incarca (hero vizibil)', await pg.locator('.hero h1').isVisible());
ok('prezentarea are link de confidentialitate', (await pg.locator('a[href="/confidentialitate.html"]').count()) > 0);

// 2. /?register=1 deschide inscrierea (fara sesiune)
await pg.goto(BASE + '/?register=1', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1200);
ok('/?register=1 deschide panoul de inscriere', await pg.locator('#registerOverlay').isVisible());

// 2b. intrebarile frecvente publice pe pagina de login
await pg.goto(BASE + '/', { waitUntil: 'networkidle' });
await pg.waitForTimeout(800);
await pg.click('#showFaqLogin');
ok('FAQ-ul public se deschide pe login', await pg.locator('#faqOverlay').isVisible());
await pg.fill('#faqSearch', 'dividende');
await pg.waitForTimeout(200);
ok('cautarea in FAQ filtreaza si deschide potrivirile', (await pg.locator('#faqList .faq-item:not(.hidden)').count()) > 0);
await pg.click('#faqClose');

// 3. demo login + aplicatie
await pg.goto(BASE + '/', { waitUntil: 'networkidle' });
await pg.evaluate(() => fetch('/api/demo-login', { method: 'POST' }));
await pg.reload({ waitUntil: 'networkidle' });
await pg.waitForTimeout(1500);
await pg.evaluate(() => { document.querySelectorAll('#welcomeOverlay').forEach((e) => e.remove()); });
ok('login demo functioneaza (badge cu tipul)', /demo/.test(await pg.locator('#userBadge').textContent()));
ok('panourile au explicatii (ⓘ injectate)', (await pg.locator('.cinfo').count()) > 50);
ok('dashboardul are banda de alerte', (await pg.locator('#dashAlerts .alert').count()) > 0);

// 3b. contrastul comenzilor utilitare din bara laterala. Poarta traieste AICI, nu in npm test:
// depinde de cascada reala + compunerea alpha, deci cere un browser. A prins o regresie reala —
// `body:not(.dark) .btn{background:#efebe1}` lua fundalul inchis al butoanelor, dar lasa
// `color:#fff` de la regula veche din u.css: alb pe crem, 1,19:1, exact pe Dictionar si pe
// comutatorul Simplu/Expert. Se verifica in AMBELE teme, fiindca doar tema luminoasa era rupta.
for (const tema of ['light', 'dark']) {
  await pg.emulateMedia({ colorScheme: tema });
  await pg.waitForTimeout(150);
  const masuri = await pg.evaluate(() => {
    const relLum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const nums = (s) => (s.match(/[\d.]+/g) || []).map(Number);
    const tb = nums(getComputedStyle(document.querySelector('.topbar')).backgroundColor).slice(0, 3);
    return ['#glossaryBtn', '#uiModeBtn', '#themeBtn', '#densityBtn', '#logoutBtn'].map((sel) => {
      const s = getComputedStyle(document.querySelector(sel));
      const fg = nums(s.color).slice(0, 3); const bgRaw = nums(s.backgroundColor);
      const a = bgRaw.length === 4 ? bgRaw[3] : 1;
      const bg = bgRaw.slice(0, 3).map((c, i) => Math.round(a * c + (1 - a) * tb[i])); // compunere peste bara
      const L1 = relLum(...fg); const L2 = relLum(...bg);
      return { sel, k: (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05) };
    });
  });
  const slab = masuri.reduce((m, x) => (x.k < m.k ? x : m));
  ok(`contrast AA pe comenzile din bara laterala (tema ${tema}; cel mai slab ${slab.sel} ${slab.k.toFixed(2)}:1)`, slab.k >= 4.5);
}
await pg.emulateMedia({ colorScheme: null });

// 3c. dictionarul contabil + modul simplu (rezumatul executiv)
await pg.click('#glossaryBtn');
ok('dictionarul contabil se deschide', await pg.locator('#glossaryModal').isVisible());
await pg.fill('#glossarySearch', 'storno');
await pg.waitForTimeout(200);
ok('cautarea in dictionar gaseste termenul', (await pg.locator('#glossaryList .gloss-item').count()) >= 1);
await pg.keyboard.press('Escape');
const wasSimple = await pg.evaluate(() => document.body.classList.contains('simple-ui'));
await pg.click('#uiModeBtn');
ok('comutatorul simplu/expert schimba modul', (await pg.evaluate(() => document.body.classList.contains('simple-ui'))) !== wasSimple);
if (!(await pg.evaluate(() => document.body.classList.contains('simple-ui')))) await pg.click('#uiModeBtn');
await pg.evaluate(() => goTab('dashboard'));
await pg.waitForTimeout(1000);
ok('rezumatul executiv e vizibil in modul simplu', await pg.locator('#rezumatCard').isVisible());

// Modul simplu a fost multa vreme doar un filtru de MENIU: ascundea intrari, dar paginile ramase
// isi pastrau tot vocabularul contabil (coloana „Formula" 6811=281, „TVA colectata (4427)",
// selectoare de cont). Poarta masoara EFECTUL, nu marcajele: cate coduri din planul de conturi
// chiar ajung pe ecran. Trebuie sa ramana ZERO in simplu — si nenul in expert, altfel ar trece
// si o regresie care ascunde totul pentru toata lumea.
const CONTURI = (await (await pg.request.get(BASE + '/api/meta')).json()).accounts.map((a) => String(a.cod));
const coduriVizibile = async (tab) => pg.evaluate(async ({ x, V }) => {
  const btn = document.querySelector(`#tabs button[data-tab="${x}"]`); if (!btn) return [];
  btn.click(); await new Promise((r) => setTimeout(r, 1800));
  const valid = new Set(V); const sec = document.querySelector('section.tab.active'); if (!sec) return [];
  const w = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT); const out = new Set(); let n;
  while ((n = w.nextNode())) {
    const p = n.parentElement;
    if (!p || !p.offsetParent) continue; // doar ce e chiar vizibil
    // cifrele din sume/date nu sunt coduri de cont: lookaround pe separatori si pe litere („D205")
    for (const m of n.nodeValue.matchAll(/(?<![\d.,\w])(\d{3,4})(?![\d.,\w])/g)) if (valid.has(m[1])) out.add(m[1]);
  }
  return [...out];
}, { x: tab, V: CONTURI });
const TABURI = ['documente', 'tva', 'stocuri'];
const strange = async () => { const s = new Set(); for (const t of TABURI) (await coduriVizibile(t)).forEach((c) => s.add(c)); return s; };
const inSimplu = await strange();
ok(`modul simplu nu arata coduri de cont (gasite: ${[...inSimplu].join(' ') || 'niciunul'})`, inSimplu.size === 0);
await pg.click('#uiModeBtn'); // -> expert
await pg.waitForTimeout(300);
const inExpert = await strange();
ok(`modul expert le arata mai departe (${inExpert.size} coduri)`, inExpert.size > 10);
if (await pg.evaluate(() => document.body.classList.contains('simple-ui'))) await pg.click('#uiModeBtn');
// restul verificarilor ruleaza in modul expert

// 4. API-uri cheie cu sesiunea demo
const notif = await (await pg.request.get(BASE + '/api/notifications')).json();
ok('notificarile raspund cu items', Array.isArray(notif.items));
const dash = await (await pg.request.get(BASE + '/api/dashboard')).json();
ok('dashboard expune e-Factura netrimise', dash.efactura && typeof dash.efactura.count === 'number');
const reg = await (await pg.request.get(BASE + '/api/declarations?period=2026-06')).json();
ok('registrul depunerilor are randuri cu termene', (reg.rows || []).every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.due)) && reg.rows.length > 0);

// 5. un tab cu date (TVA) se randeaza
await pg.evaluate(() => goTab('tva'));
await pg.waitForTimeout(1200);
ok('tab-ul TVA se randeaza (sumar decont)', /TVA/.test(await pg.locator('#tab-tva').textContent()));
ok('cardul pro-rata (art. 300) e prezent in tab-ul TVA', (await pg.locator('#proRataView').count()) === 1);

// 5b. Previzualizarea articolului contabil din formular. E singura verificare pe browser REAL a
// caii: tastare -> pauza -> POST /api/preview -> randare. Logica e pe server (composeEntry, testat
// in test/http.js); aici verificam exact ce nu poate vedea un test fara pagina — ca previzualizarea
// chiar ajunge pe ecran, ca nu pleaca o cerere la fiecare tasta, si ca schimbarea tipului NU lasa
// pe ecran articolul tipului anterior.
const previewReq = [];
pg.on('request', (r) => { if (r.url().includes('/api/preview')) previewReq.push(1); });
await pg.evaluate(() => goTab('documente'));
await pg.waitForTimeout(800);
await pg.evaluate(() => document.querySelectorAll('#welcomeOverlay,.toast,#fwWizard,.op-wizard').forEach((e) => e.remove()));
await pg.click('#manualBtn');
await pg.waitForTimeout(1000);
await pg.selectOption('#tipSelect', 'factura_vanzare_marfuri');
await pg.waitForTimeout(700);
await pg.fill('#fld_baza', '1000');
await pg.fill('#fld_tva', '210');
await pg.waitForTimeout(1500);
const prevTxt = () => pg.locator('#preview').textContent();
const pv = await prevTxt();
ok('previzualizarea arata articolul venit de la server (4111 = 707 si 4427)', /4111/.test(pv) && /707/.test(pv) && /4427/.test(pv));
ok('previzualizarea insumeaza articolul (total 1.210,00)', /1\.210,00/.test(pv));
// debounce: tastare rapida = O SINGURA cerere, nu una pe tasta (altfel plafonul de API sare)
previewReq.length = 0;
for (const v of ['1', '12', '123', '1234']) { await pg.fill('#fld_baza', v); await pg.waitForTimeout(60); }
await pg.waitForTimeout(1500);
ok('previzualizarea e debounced (4 taste rapide -> 1 cerere, nu 4)', previewReq.length === 1);
// schimbarea tipului nu lasa pe ecran articolul precedent nici macar o clipa
await pg.selectOption('#tipSelect', 'incasare_client');
const imediat = await prevTxt();
ok('la schimbarea tipului previzualizarea veche dispare imediat', !/707/.test(imediat));
await pg.waitForTimeout(1500);
await pg.fill('#fld_suma', '500');
await pg.waitForTimeout(1500);
ok('previzualizarea se recalculeaza pentru noul tip (incasare: 5121/5311 = 4111)', /4111/.test(await prevTxt()));

// 5c. Ce TRIMITE formularul. collectFields/readItems citesc din DOM, deci un test cu shim
// inert nu ar dovedi nimic — aici e singurul loc unde se poate verifica. Cererea e INTERCEPTATA
// si anulata: citim ce s-ar fi trimis, fara sa salvam nimic in firma demo.
let trimis = null;
await pg.route('**/api/entries', async (route) => {
  if (route.request().method() !== 'POST') return route.continue();
  try { trimis = JSON.parse(route.request().postData() || '{}'); } catch (_) { trimis = null; }
  await route.abort();
});
await pg.selectOption('#tipSelect', 'factura_vanzare_marfuri');
await pg.waitForTimeout(700);
await pg.fill('#fld_partener', 'Client E2E');
// doua linii: una completa, una cu denumirea goala — a doua trebuie ELIMINATA de readItems,
// altfel ar pleca spre server o pozitie fara nume, care strica baza si TVA-ul.
const ed = '#fld_items';
await pg.click(ed + ' .additem');
await pg.waitForTimeout(200);
await pg.click(ed + ' .additem');
await pg.waitForTimeout(300);
const randuri = pg.locator(ed + ' .item-row');
await randuri.nth(0).locator('.it-nume').fill('Produs A');
await randuri.nth(0).locator('.it-cant').fill('3');
await randuri.nth(0).locator('.it-pret').fill('50');
await randuri.nth(0).locator('.it-cota').fill('21');
await randuri.nth(1).locator('.it-cant').fill('9'); // fara denumire -> se elimina
await pg.waitForTimeout(1200);
await pg.click('#entryForm button[type="submit"], #entryForm .btn.primary');
await pg.waitForTimeout(1200);
ok('formularul chiar trimite o cerere de salvare', !!trimis && trimis.tip === 'factura_vanzare_marfuri');
const items = (trimis && trimis.fields && trimis.fields.items) || [];
ok('liniile fara denumire sunt eliminate inainte de trimitere (a ramas 1)', items.length === 1);
ok('linia completa pleaca cu valorile tastate', items[0] && items[0].nume === 'Produs A' && String(items[0].cantitate) === '3' && String(items[0].pret) === '50' && String(items[0].cota) === '21');
ok('campurile simple pleaca din formular', trimis && trimis.fields && trimis.fields.partener === 'Client E2E');
// bifele trebuie sa plece ca BOOLEAN (prin .checked), nu ca sirul „on" al unui input
await pg.selectOption('#tipSelect', 'factura_cumparare_marfuri');
await pg.waitForTimeout(700);
await pg.fill('#fld_data', '2026-06-15');
await pg.fill('#fld_baza', '100');
await pg.check('#fld_proRataMixt');
await pg.waitForTimeout(1000);
trimis = null;
await pg.click('#entryForm button[type="submit"], #entryForm .btn.primary');
await pg.waitForTimeout(1200);
ok('bifa pleaca drept boolean true (prin .checked), nu ca sirul „on"', trimis && trimis.fields && trimis.fields.proRataMixt === true);
// si nebifat: trebuie sa fie false, nu sir gol — altfel serverul ar primi o valoare falsy ambigua
await pg.uncheck('#fld_proRataMixt');
await pg.waitForTimeout(600);
trimis = null;
await pg.click('#entryForm button[type="submit"], #entryForm .btn.primary');
await pg.waitForTimeout(1200);
ok('bifa nebifata pleaca drept false, nu sir gol', trimis && trimis.fields && trimis.fields.proRataMixt === false);
await pg.unroute('**/api/entries');
await pg.evaluate(() => { const b = document.querySelector('#entryCancel, #formClose'); if (b) b.click(); });

// 6. trecere pe VIEWPORT MOBIL (390x844): UI-ul mobil e ACTIV (bara de jos + panoul
// „Mai mult"; sidebar-ul devine bara de sus) — fara scroll orizontal nicaieri.
const pm = await b.newPage({ viewport: { width: 390, height: 844 } });
await pm.goto(BASE + '/prezentare.html', { waitUntil: 'networkidle' });
await pm.waitForTimeout(500);
ok('mobil: prezentarea publica fara scroll orizontal', await pm.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await pm.goto(BASE + '/', { waitUntil: 'networkidle' });
await pm.evaluate(() => fetch('/api/demo-login', { method: 'POST' }));
await pm.reload({ waitUntil: 'networkidle' });
await pm.waitForTimeout(1500);
await pm.evaluate(() => { document.querySelectorAll('#welcomeOverlay').forEach((e) => e.remove()); });
ok('mobil: login demo functioneaza', /demo/.test(await pm.locator('#userBadge').textContent()));
ok('mobil: dashboardul se randeaza (continut prezent)', (await pm.locator('#kpis .kpi').count()) > 0);
ok('mobil: bara de jos vizibila, meniul desktop ascuns', (await pm.locator('#bottomnav').isVisible()) && !(await pm.locator('#tabs').isVisible()));
ok('mobil: dashboardul FARA scroll orizontal', await pm.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await pm.click('#moreBtn');
ok('mobil: panoul „Mai mult" se deschide', await pm.locator('#moreSheet .more-grid').isVisible());
await pm.click('#moreSheet .more-grid button[data-go="tva"]');
await pm.waitForTimeout(1200);
ok('mobil: navigarea din panou merge (TVA) si pagina ramane fixa', (await pm.locator('#tab-tva').isVisible()) && (await pm.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)));
await pm.close();

await b.close();
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari E2E trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
