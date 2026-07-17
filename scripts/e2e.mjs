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

// 3b. dictionarul contabil + modul simplu (rezumatul executiv)
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
await pg.click('#uiModeBtn'); // inapoi la modul expert pentru restul verificarilor

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

await b.close();
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari E2E trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
