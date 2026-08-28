// Verificari end-to-end pe instanta LIVE (sau BASE_URL), cu browser real (Playwright).
// Foloseste contul demo — nu creeaza si nu sterge date reale.
//
// Rulare pe acest server (fara biblioteci de sistem pentru Chromium, prin Docker).
// Se monteaza DOAR fisierul, read-only: npm i ruleaza in containerul efemer, nu lasa
// node_modules pe host (un mount pe tot scripts/ ar scrie ~500 fisiere inapoi in repo).
//   docker run --rm -v /var/www/contab/scripts/e2e.mjs:/w/e2e.mjs:ro -w /w \
//     mcr.microsoft.com/playwright:v1.58.2-noble \
//     sh -c "npm i --no-save playwright@1.58.2 >/dev/null 2>&1 && node e2e.mjs"
// Comanda unica (browser local sau fallback Docker): npm run e2e

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'https://contabo.space';
let pass = 0; let fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name); } };

const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });

// Selectorul vizibil este comboboxul căutabil; #tipSelect rămâne doar contractul canonic ascuns.
// Scenariile aleg prin controlul folosit de om, ca testele să nu poată trece ocolind ergonomia.
async function chooseOperation(id) {
  await pg.click('#operationTypeSearch');
  await pg.fill('#operationTypeSearch', id);
  const option = pg.locator(`.operation-type-option[data-type-id="${id}"]`).first();
  await option.click();
}

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
ok('înscriere: TVA nu este preselectat, emailul este obligatoriu și listarea contabilului este opt-in',
  (await pg.locator('#registerForm [name="tvaPlatitor"]:checked').count()) === 0
  && await pg.locator('#registerForm [name="email"]').getAttribute('required') !== null
  && !(await pg.locator('#registerForm [name="disponibilContabil"]').isChecked()));
ok('înscriere: județul se alege după nume', await pg.locator('#registerForm select[name="judet"] option').count() === 43);

// 2b. intrebarile frecvente publice pe pagina de login
await pg.goto(BASE + '/', { waitUntil: 'networkidle' });
await pg.waitForTimeout(800);
ok('titlul panoului public păstrează contrastul alb', await pg.evaluate(() =>
  getComputedStyle(document.querySelector('#loginOverlay .ah-title')).color === 'rgb(255, 255, 255)'));
await pg.locator('#loginOverlay .language-switch').selectOption('en');
ok('selectorul RO/EN traduce autentificarea și setează limba documentului',
  (await pg.locator('#loginOverlay .auth-title').textContent()).trim() === 'Sign in to your account'
  && await pg.getAttribute('html', 'lang') === 'en');
await pg.reload({ waitUntil: 'networkidle' });
ok('limba engleză rămâne memorată după reîncărcare',
  await pg.locator('#loginOverlay .language-switch').inputValue() === 'en'
  && (await pg.locator('#loginOverlay .auth-title').textContent()).trim() === 'Sign in to your account');
await pg.click('#forgotLink');
ok('selectorul de limbă rămâne disponibil și când formularul de login este înlocuit',
  await pg.locator('#loginOverlay .language-switch').isVisible()
  && /Password recovery/.test(await pg.locator('#loginForm').textContent()));
await pg.reload({ waitUntil: 'networkidle' });
await pg.locator('#loginOverlay .language-switch').selectOption('ro');
ok('revenirea la română restaurează textele-sursă',
  (await pg.locator('#loginOverlay .auth-title').textContent()).trim() === 'Intră în contul tău'
  && await pg.getAttribute('html', 'lang') === 'ro');
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
const dashboardCompact = await pg.evaluate(() => {
  const tab = document.querySelector('#tab-dashboard');
  const panouri = [...document.querySelectorAll('#dashboardSecondary details[data-dashboard-panel]')];
  return { height: tab.scrollHeight, alerts: document.querySelectorAll('#dashAlerts .alert').length,
    kpis: document.querySelectorAll('#rezumatKpis .kpi').length, panels: panouri.length,
    kpiColumns: getComputedStyle(document.querySelector('#rezumatKpis')).gridTemplateColumns.split(' ').length,
    allClosed: panouri.every((p) => !p.open) };
});
ok(`dashboardul compact are sarcinile, 4 indicatori și analizele strânse (${dashboardCompact.height}px)`,
  dashboardCompact.alerts > 0 && dashboardCompact.kpis === 4 && dashboardCompact.panels === 4
    && dashboardCompact.kpiColumns === 4 && dashboardCompact.allClosed && dashboardCompact.height < 2100);
await pg.click('#dashTrendsPanel > summary');
await pg.waitForTimeout(150);
await pg.reload({ waitUntil: 'networkidle' });
await pg.waitForTimeout(900);
await pg.evaluate(() => { document.querySelectorAll('#welcomeOverlay').forEach((e) => e.remove()); });
const panouDashboardMemorat = await pg.locator('#dashTrendsPanel').evaluate((p) => p.open);
if (panouDashboardMemorat) await pg.click('#dashTrendsPanel > summary');
const carcasaDesktop = await pg.evaluate(() => {
  const antet = document.querySelector('.topbar').getBoundingClientRect();
  const meniu = document.querySelector('#tabs').getBoundingClientRect();
  const principal = document.querySelector('.shell > main').getBoundingClientRect();
  const context = document.querySelector('#appContext').getBoundingClientRect();
  return { antet: Math.round(antet.height), meniu: Math.round(meniu.width), meniuSus: Math.round(meniu.top),
    principal: Math.round(principal.left), context: Math.round(context.height), scroll: document.documentElement.scrollWidth };
});
ok('desktop: antet ≤64px, context compact și meniu lateral de 260px',
  carcasaDesktop.antet <= 64 && carcasaDesktop.context <= 64 && carcasaDesktop.meniu === 260
    && carcasaDesktop.meniuSus === 64 && carcasaDesktop.principal === 260
    && carcasaDesktop.scroll <= 1441 && panouDashboardMemorat);
await pg.click('#navToggleBtn');
await pg.waitForTimeout(260);
ok('desktop: meniul lateral se restrânge la 72px și mărește zona de lucru', await pg.evaluate(() =>
  Math.round(document.querySelector('#tabs').getBoundingClientRect().width) === 72
    && Math.round(document.querySelector('.shell > main').getBoundingClientRect().left) === 72
    && document.querySelector('#navToggleBtn').getAttribute('aria-expanded') === 'false'));
await pg.click('#navToggleBtn');
await pg.waitForTimeout(260);
await pg.locator('#tabs > .nav-language .language-switch').selectOption('en');
ok('selectorul din navigator traduce shell-ul autentificat și lunile calendaristice', await pg.evaluate(() => {
  const nav = document.querySelector('#tabs');
  const period = document.querySelector('#currentPeriod');
  return document.documentElement.lang === 'en'
    && nav.querySelector('[data-tab="dashboard"]').textContent.trim() === 'Home'
    && nav.querySelector('#toolGhid').textContent.trim() === 'Guide'
    && document.querySelector('#navToggleBtn .nav-toggle-label').textContent.trim() === 'Collapse'
    && document.querySelector('#dashboardSecondary .dashboard-secondary-head h3').textContent.trim() === 'Secondary analyses'
    && document.querySelector('#appContextTitle').textContent.trim() === 'Home'
    && /January|February|March|April|May|June|July|August|September|October|November|December/.test(period.textContent);
}));
await pg.evaluate(() => goTab('documente'));
await pg.waitForTimeout(350);
ok('localizarea urmărește și conținutul paginilor create dinamic',
  /Record a received document/.test(await pg.locator('#tab-documente').textContent())
  && (await pg.locator('#appContextTitle').textContent()).trim() === 'Add received document');
await pg.evaluate(() => goTab('dashboard'));
await pg.waitForTimeout(250);
await pg.locator('#tabs > .nav-language .language-switch').selectOption('ro');
ok('selectorul din navigator revine complet la română', await pg.evaluate(() =>
  document.documentElement.lang === 'ro'
  && document.querySelector('#tabs [data-tab="dashboard"]').textContent.trim() === 'Acasă'
  && document.querySelector('#navToggleBtn .nav-toggle-label').textContent.trim() === 'Restrânge'
  && document.querySelector('#dashboardSecondary .dashboard-secondary-head h3').textContent.trim() === 'Analize secundare'
  && document.querySelector('#toolGhid').textContent.trim() === 'Ghid'));
await pg.click('#currentPeriod');
ok('perioada globală se alege din controlul unic și persistent',
  await pg.locator('#globalPeriodPanel').isVisible()
  && /^\d{4}-\d{2}$/.test(await pg.locator('#globalPeriodInput').inputValue())
  && await pg.locator('#currentPeriod').getAttribute('aria-expanded') === 'true');
await pg.keyboard.press('Escape');
ok('selectorul perioadei globale se închide cu Escape', !(await pg.locator('#globalPeriodPanel').isVisible()));
ok('alertele au o singură pictogramă semantică, fără dublare după destinație', await pg.evaluate(() =>
  [...document.querySelectorAll('#dashAlerts .alert')].every((el) =>
    !el.querySelector(':scope > .app-icon') && !!el.querySelector(':scope > .al-ic .app-icon'))));
ok('desktop: panoul Unelte a dispărut, iar Portofoliu nu mai este în navigator',
  !(await pg.locator('#appContext #sideTools').count())
  && !(await pg.locator('#tabs [data-tab="portofoliu"]').count()));
ok('desktop: Ghid, Caută, Temă, Expert și Dicționar urmează direct după Acasă', await pg.evaluate(() => {
  const ids = [...document.querySelector('#tabs').children].filter((el) => el.tagName === 'BUTTON')
    .slice(0, 7).map((el) => el.id || el.dataset.tab);
  return ids.join(',') === 'dashboard,toolGhid,paletaBtn,themeBtn,uiModeBtn,glossaryBtn,notificari'
    && ['toolGhid', 'paletaBtn', 'themeBtn', 'uiModeBtn', 'glossaryBtn']
      .every((id) => document.querySelector('#' + id).offsetParent !== null)
    && document.querySelectorAll('#sideTools > button, #sideTools > a').length === 4;
}));
await pg.click('#toolGhid');
ok('Ghid din navigator deschide pagina și actualizează titlul',
  await pg.locator('#tab-ghid').isVisible() && (await pg.locator('#appContextTitle').textContent()).trim() === 'Ghid');
await pg.click('#navgrupUnelte > .navlabel');
await pg.click('#toolMesaje');
ok('Mesaje din navigator deschide pagina și păstrează badge-ul',
  await pg.locator('#tab-mesaje').isVisible() && (await pg.locator('#toolMesaje #msgBadge').count()) === 1);
await pg.evaluate(() => goTab('dashboard'));
await pg.click('#qaWizard');
ok('selectorul ghidat nu arată „Înapoi” la primul nivel', !(await pg.locator('#opwBack').isVisible()));
await pg.click('#opwClose');
const clickTool = async (selector) => {
  if (!(await pg.locator(selector).isVisible())) await pg.click('#navgrupUnelte > .navlabel');
  await pg.click(selector);
};

// 3b. contrastul comenzilor utilitare directe și din acordeon. Poarta traieste AICI, nu in npm test:
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
    // Butoanele se DERIVA din DOM, nu dintr-o lista scrisa de mana: altfel fiecare comanda noua
    // adaugata in meniu (cautarea, turul) ar fi ramas neacoperita tacit, iar poarta ar fi raportat
    // verde pentru un set tot mai mic din ce se vede pe ecran.
    const sels = [...document.querySelectorAll('#toolGhid, #tabs > .nav-action, #sideTools > button, #sideTools > a'), document.querySelector('#logoutBtn')]
      .filter(Boolean).map((el) => '#' + el.id).filter((x) => x !== '#');
    return sels.map((sel) => {
      const s = getComputedStyle(document.querySelector(sel));
      const fg = nums(s.color).slice(0, 3); const bgRaw = nums(s.backgroundColor);
      const a = bgRaw.length === 4 ? bgRaw[3] : 1;
      const bg = bgRaw.slice(0, 3).map((c, i) => Math.round(a * c + (1 - a) * tb[i])); // compunere peste bara
      const L1 = relLum(...fg); const L2 = relLum(...bg);
      return { sel, k: (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05) };
    });
  });
  const slab = masuri.reduce((m, x) => (x.k < m.k ? x : m));
  ok(`contrast AA pe comenzile din shell (tema ${tema}; cel mai slab ${slab.sel} ${slab.k.toFixed(2)}:1)`, slab.k >= 4.5);
}
await pg.emulateMedia({ colorScheme: null });

// 3bb. cautarea globala (Ctrl+K): gaseste un partener si DUCE la ecranul lui
await pg.keyboard.press('Control+k');
await pg.waitForTimeout(500);
ok('Ctrl+K deschide cautarea globala', await pg.locator('#paletaModal').isVisible());
await pg.fill('#paletaSearch', 'alfa');
await pg.waitForTimeout(700);
ok('cautarea globala gaseste partenerul', (await pg.locator('#paletaList .pal-item').count()) > 0);
await pg.keyboard.press('Escape');
ok('Escape inchide cautarea globala', !(await pg.locator('#paletaModal').isVisible()));

// 3c. dictionarul contabil + modul simplu (rezumatul executiv)
await clickTool('#glossaryBtn');
ok('dictionarul contabil se deschide', await pg.locator('#glossaryModal').isVisible());
await pg.fill('#glossarySearch', 'storno');
await pg.waitForTimeout(200);
ok('cautarea in dictionar gaseste termenul', (await pg.locator('#glossaryList .gloss-item').count()) >= 1);
await pg.keyboard.press('Escape');
const wasSimple = await pg.evaluate(() => document.body.classList.contains('simple-ui'));
await clickTool('#uiModeBtn');
ok('comutatorul simplu/expert schimba modul', (await pg.evaluate(() => document.body.classList.contains('simple-ui'))) !== wasSimple);
if (!(await pg.evaluate(() => document.body.classList.contains('simple-ui')))) await clickTool('#uiModeBtn');
await pg.evaluate(() => goTab('dashboard'));
await pg.waitForTimeout(1000);
ok('rezumatul executiv e vizibil in modul simplu', await pg.locator('#rezumatCard').isVisible());
await pg.evaluate(() => goTab('documente'));
await pg.click('#documentWorkbenchMore > summary');
await pg.click('#manualBtn');
await pg.click('#operationTypeSearch');
ok('selectorul de operațiuni deschide recomandările și toate cele 137 de tipuri grupate după scop',
  await pg.locator('#operationTypeResults').isVisible()
  && (await pg.locator('#operationTypeResults .operation-type-section').count()) >= 2
  && (await pg.locator('#operationTypeResults .operation-type-all .operation-type-option').count())
    === (await pg.locator('#tipSelect option').count())
  && (await pg.locator('#tipSelect option').count()) >= 130
  && (await pg.locator('#operationTypeResults .operation-purpose-heading').count()) > 10);
await pg.fill('#operationTypeSearch', 'vânzări clienți');
ok('căutarea ignoră diacriticele și găsește după scop',
  (await pg.locator('#operationTypeResults .operation-type-option').count()) > 0
  && (await pg.locator('#operationTypeResults .operation-purpose-group').count()) === 1);
await pg.fill('#operationTypeSearch', 'factura_servicii_primita');
await pg.locator('.operation-type-option[data-type-id="factura_servicii_primita"]').first()
  .locator('..').locator('.operation-type-star').click();
await pg.keyboard.press('Escape');
await pg.click('#operationTypeSearch');
ok('operațiunea marcată apare în Favorite', await pg.evaluate(() =>
  [...document.querySelectorAll('#operationTypeResults .operation-type-section')].some((section) =>
    /Favorite/.test(section.querySelector('h4')?.textContent || '')
      && !!section.querySelector('[data-type-id="factura_servicii_primita"]'))));
await pg.fill('#operationTypeSearch', 'factura_servicii_primita');
await pg.keyboard.press('ArrowDown');
await pg.keyboard.press('Enter');
ok('selectorul se poate opera din tastatură și sincronizează tipul canonic',
  await pg.locator('#tipSelect').inputValue() === 'factura_servicii_primita');
await pg.waitForTimeout(300);
ok('modul simplu ascunde selectorul de cont și pliază situațiile fiscale rare',
  !(await pg.locator('#fld_contChelt').isVisible())
  && await pg.locator('#dynFields .special-fields').isVisible()
  && !(await pg.locator('#dynFields .special-fields').getAttribute('open')));
await pg.evaluate(() => document.querySelector('#cancelEntry')?.click());
await pg.evaluate(() => goTab('dashboard'));

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
// `intrate` e in lista DELIBERAT: pe „documente" jurnalul lunii sta acum intr-o sectiune pliata,
// deci coloana „Formula" nu mai e vizibila acolo si poarta ar fi trecut degeaba. Pe „intrate"
// aceleasi randuri se randeaza desfasurat, deci coloana ramane acoperita.
const TABURI = ['documente', 'intrate', 'tva', 'stocuri'];
const strange = async () => { const s = new Set(); for (const t of TABURI) (await coduriVizibile(t)).forEach((c) => s.add(c)); return s; };
const inSimplu = await strange();
ok(`modul simplu nu arata coduri de cont (gasite: ${[...inSimplu].join(' ') || 'niciunul'})`, inSimplu.size === 0);
await clickTool('#uiModeBtn'); // -> expert
await pg.waitForTimeout(300);
const inExpert = await strange();
// Volumul datelor din firma demo variaza dupa reset/importuri, deci „peste 10" masura seed-ul,
// nu modul UI. Contractul real: simplu elimina toate codurile, iar expertul le readuce efectiv.
ok(`modul expert readuce codurile (${inExpert.size}: ${[...inExpert].join(' ') || 'niciunul'})`,
  inExpert.size > 0 && inExpert.size > inSimplu.size);
if (await pg.evaluate(() => document.body.classList.contains('simple-ui'))) await clickTool('#uiModeBtn');
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
const perioadaGlobalaInainte = (await pg.locator('#currentPeriod').textContent()).trim();
const overrideTva = pg.locator('#tab-tva .period-override');
ok('TVA și balanța nu repetă perioada; excepția locală este închisă și etichetată explicit',
  await overrideTva.count() === 1
  && (await overrideTva.locator('summary').textContent()).trim() === 'Suprascrie perioada'
  && !(await overrideTva.locator('#tvaLuna').isVisible())
  && await pg.locator('#tab-balanta .period-override').count() === 1
  && await pg.locator('select.luna-req').count() === 0);
await overrideTva.locator('summary').click();
await pg.selectOption('#tvaLuna', '');
await pg.waitForTimeout(500);
ok('suprascrierea TVA rămâne locală și arată perioada activă',
  (await pg.locator('#currentPeriod').textContent()).trim() === perioadaGlobalaInainte
  && await overrideTva.getAttribute('data-period-override-active') === 'true'
  && /toate lunile/.test(await overrideTva.locator('summary').textContent()));
await overrideTva.locator('.period-override-reset').click();
await pg.waitForTimeout(500);
ok('revenirea din suprascriere restaurează perioada globală',
  await overrideTva.getAttribute('data-period-override-active') === 'false'
  && (await pg.locator('#tvaLuna').inputValue()) === (await pg.locator('#globalPeriodInput').inputValue()).slice(5)
  && (await pg.locator('#currentPeriod').textContent()).trim() === perioadaGlobalaInainte);

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
ok('workbench-ul pornește în Încarcă, iar opțiunile rare sunt pliate', await pg.evaluate(() => {
  const wb = document.querySelector('#documentWorkbench');
  const more = document.querySelector('#documentWorkbenchMore');
  return wb?.dataset.step === 'upload' && !more?.open
    && document.querySelector('[data-workbench-step="upload"]')?.getAttribute('aria-current') === 'step'
    && !document.querySelector('#manualBtn')?.offsetParent;
}));
await pg.click('#documentWorkbenchMore > summary');
const aiOption = pg.locator('#documentWorkbenchMore .workbench-option').filter({ hasText: 'Prelucrare AI' });
await aiOption.locator(':scope > summary').click();
ok('consimțământul AI există o singură dată și apare numai în meniul secundar',
  (await pg.locator('#documentAiToggle').count()) === 1 && await pg.locator('#documentAiToggle').isVisible());
let uploadMultipart = '';
await pg.route('**/api/upload', async (route) => {
  uploadMultipart = (route.request().postDataBuffer() || Buffer.alloc(0)).toString('utf8');
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    documentId: 'e2e-ai-choice', fileName: 'optiune-ai.pdf', suggestedType: 'nota_contabila', fields: {}, cuis: [],
    source: 'heuristic', aiDecision: { mode: 'deny', transmitted: false }, needsReview: true,
    calitate: { scor: 0, decizie: 'revizuire', controale: [], motive: ['test browser'] },
  }) });
});
await pg.evaluate(() => { const x = document.querySelector('#documentAiToggle'); x.checked = false; });
await pg.locator('#file').setInputFiles({ name: 'optiune-ai.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') });
await pg.waitForFunction(() => /reguli locale/i.test(document.querySelector('#uploadStatus')?.textContent || ''));
await pg.unroute('**/api/upload');
ok('browserul trimite alegerea per document in multipart, nu o lasa doar in UI',
  /name="aiMode"\r?\n\r?\ndeny/.test(uploadMultipart));
ok('după upload, workbench-ul intră în Verifică și păstrează verdictul extracției la vedere', await pg.evaluate(() =>
  document.querySelector('#documentWorkbench')?.dataset.step === 'verify'
    && /reguli locale/i.test(document.querySelector('#workbenchReviewStatus')?.textContent || '')
    && document.querySelector('#workbenchReviewStatus')?.offsetParent));
ok('navigația ciclului nu este duplicată în conținut', (await pg.locator('.cyclemap,.cyclestep,.cyclearrow').count()) === 0);
ok('pagina de introducere este clasificată compact în bara contextuală',
  /înregistrare/i.test(await pg.locator('.app-context-kicker').textContent()));
await pg.evaluate(() => document.querySelector('#cancelEntry')?.click());
await pg.click('#documentWorkbenchMore > summary');
await pg.click('#manualBtn');
await pg.waitForTimeout(1000);
ok('introducerea manuală intră în Verifică și închide opțiunile secundare', await pg.evaluate(() =>
  document.querySelector('#documentWorkbench')?.dataset.step === 'verify'
    && !document.querySelector('#documentWorkbenchMore')?.open
    && document.querySelector('[data-workbench-step="verify"]')?.getAttribute('aria-current') === 'step'
    && document.querySelector('#postEntry')?.textContent.trim() === 'Postează documentul'));
ok('formularul manual folosește lățimea completă, nu o coloană îngustă în dreapta', await pg.evaluate(() => {
  const grid = document.querySelector('#tab-documente .grid2.pas12');
  return grid && getComputedStyle(grid).gridTemplateColumns.split(' ').length === 1;
}));
await chooseOperation('factura_vanzare_marfuri');
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
await chooseOperation('incasare_client');
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
  // Păstrăm cererea suficient de mult în zbor ca să verificăm starea vizibilă „Postează".
  await new Promise((resolve) => setTimeout(resolve, 250));
  await route.abort();
});
await chooseOperation('factura_vanzare_marfuri');
await pg.waitForTimeout(700);
await pg.fill('#fld_partener', 'Client E2E');
// Tipul anterior (`incasare_client`) nu are campul `baza`; schimbarea corect reseteaza acest camp.
// Fara completarea lui, validarea HTML `required` opreste submit-ul inainte de listener — testul
// ar interpreta protectia browserului drept lipsa unei cereri.
await pg.fill('#fld_baza', '150');
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
// Formularul este acum ghidat: datele stau în primul pas, salvarea în al doilea. Selectorul vechi
// „orice .primary" apăsa doar Continuă și pretindea apoi că submit-ul nu funcționează.
await pg.click('#entryForm > .form-step:first-of-type .form-step-actions .btn.primary');
await pg.click('#entryForm button[type="submit"]');
await pg.waitForFunction(() => document.querySelector('#documentWorkbench')?.dataset.step === 'post');
ok('în timpul trimiterii, workbench-ul marchează explicit etapa Postează',
  await pg.locator('[data-workbench-step="post"]').getAttribute('aria-current') === 'step');
await pg.waitForTimeout(1200);
ok('formularul chiar trimite o cerere de salvare', !!trimis && trimis.tip === 'factura_vanzare_marfuri');
const items = (trimis && trimis.fields && trimis.fields.items) || [];
ok('liniile fara denumire sunt eliminate inainte de trimitere (a ramas 1)', items.length === 1);
ok('linia completa pleaca cu valorile tastate', items[0] && items[0].nume === 'Produs A' && String(items[0].cantitate) === '3' && String(items[0].pret) === '50' && String(items[0].cota) === '21');
ok('campurile simple pleaca din formular', trimis && trimis.fields && trimis.fields.partener === 'Client E2E');
// bifele trebuie sa plece ca BOOLEAN (prin .checked), nu ca sirul „on" al unui input
await pg.click('#entryForm > .form-step:first-of-type > summary');
await chooseOperation('factura_cumparare_marfuri');
await pg.waitForTimeout(700);
await pg.fill('#fld_data', '2026-06-15');
await pg.fill('#fld_baza', '100');
await pg.check('#fld_proRataMixt');
await pg.waitForTimeout(1000);
trimis = null;
await pg.click('#entryForm > .form-step:first-of-type .form-step-actions .btn.primary');
await pg.click('#entryForm button[type="submit"]');
await pg.waitForTimeout(1200);
ok('bifa pleaca drept boolean true (prin .checked), nu ca sirul „on"', trimis && trimis.fields && trimis.fields.proRataMixt === true);
// si nebifat: trebuie sa fie false, nu sir gol — altfel serverul ar primi o valoare falsy ambigua
await pg.click('#entryForm > .form-step:first-of-type > summary');
await pg.uncheck('#fld_proRataMixt');
await pg.waitForTimeout(600);
trimis = null;
await pg.click('#entryForm > .form-step:first-of-type .form-step-actions .btn.primary');
await pg.click('#entryForm button[type="submit"]');
await pg.waitForTimeout(1200);
ok('bifa nebifata pleaca drept false, nu sir gol', trimis && trimis.fields && trimis.fields.proRataMixt === false);
await pg.unroute('**/api/entries');
await pg.evaluate(() => document.querySelector('#cancelEntry')?.click());

// 6. trecere pe VIEWPORT MOBIL (390x844): același arbore #tabs devine sertar,
// fără o a doua navigație sau o ierarhie mobilă separată — și fără scroll orizontal.
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
const dashboardMobil = await pm.evaluate(() => ({
  height: document.querySelector('#tab-dashboard').scrollHeight,
  kpiColumns: getComputedStyle(document.querySelector('#rezumatKpis')).gridTemplateColumns.split(' ').length,
  actionColumns: getComputedStyle(document.querySelector('#quickActionsCard .quickacts-primary')).gridTemplateColumns.split(' ').length,
}));
ok(`mobil: dashboardul compact și contextul se randează (${dashboardMobil.height}px)`, (await pm.locator('#kpis .kpi').count()) > 0
  && (await pm.locator('#appContextTitle').isVisible()) && /Acasă/i.test(await pm.locator('#appContextTitle').textContent())
  && (await pm.locator('.app-context-kicker').isVisible())
  && dashboardMobil.kpiColumns === 2 && dashboardMobil.actionColumns === 2 && dashboardMobil.height < 2400);
ok('mobil: există o singură navigație, strânsă inițial', (await pm.locator('#bottomnav,#moreSheet').count()) === 0 && !(await pm.locator('#tabs').isVisible()));
ok('mobil: dashboardul FARA scroll orizontal', await pm.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
ok('mobil: nu mai există un panou Unelte în afara navigatorului',
  !(await pm.locator('#appContext #sideTools').count()) && !(await pm.locator('#sideTools').isVisible()));
await pm.click('#navToggleBtn');
ok('mobil: butonul Meniu deschide arborele desktop real', await pm.locator('#tabs').isVisible());
await pm.click('#navgrupUnelte > .navlabel');
ok('mobil: cele cinci comenzi sunt directe, iar restul rămân în Unelte, fără Portofoliu',
  (await pm.locator('#toolGhid:visible, #tabs > .nav-action:visible').count()) === 5
  && (await pm.locator('#sideTools > button:visible, #sideTools > a:visible').count()) === 4
  && !(await pm.locator('#tabs [data-tab="portofoliu"]').count()));
await pm.click('#tabs .navgroup:has(button[data-tab="tva"]) > .navlabel');
await pm.click('#tabs button[data-tab="tva"]');
await pm.waitForTimeout(1200);
ok('mobil: navigarea din același arbore merge, închide sertarul și pagina rămâne fixă',
  (await pm.locator('#tab-tva').isVisible()) && !(await pm.locator('#tabs').isVisible())
  && /TVA/i.test(await pm.locator('#appContextTitle').textContent())
  && (await pm.locator('#navToggleBtn').getAttribute('aria-expanded')) === 'false'
  && (await pm.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)));
await pm.evaluate(() => document.querySelector('#tabs button[data-tab="dashboard"]')?.click());
await pm.waitForTimeout(150);
await pm.setViewportSize({ width: 320, height: 700 });
await pm.waitForTimeout(150);
const mobil320 = await pm.evaluate(() => {
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
  return { rezultat, antet: ra && ra.height, textAlerta: rt && rt.width,
    contextStanga: r && r.left, contextDreapta: r && r.right, scroll: document.documentElement.scrollWidth };
});
ok(`mobil 320px: contextul rămâne lizibil și în interiorul ecranului (antet ${mobil320.antet}px, text ${mobil320.textAlerta}px)`, mobil320.rezultat);
await pm.close();

await b.close();
console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari E2E trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
