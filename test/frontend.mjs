// Teste unitare pentru LOGICA PURA din public/*.js — rulate in Node, fara browser si fara jsdom
// (fidel filozofiei zero-dependinte a proiectului). Acopera stratul care pana acum nu avea niciun
// test: ~5400 de linii de frontend vanilla.
//
// CE testam: functii pure si construirea de HTML (siruri) — escapare, formatarea sumelor,
// aritmetica lunilor, clasificarea documentelor, parsarea sumelor in format romanesc.
// CE NU testam: randarea in pagina, evenimentele, layout-ul — acolo raspunde `npm run e2e`
// (Playwright pe aplicatia vie). Un test care „nu vede" pagina nu trebuie sa pretinda ca o vede.
//
// De ce oglinda din /tmp: package.json de la radacina e "commonjs", deci Node ar refuza
// `import` din public/*.js, desi in browser sunt module ES (<script type="module">). Aceeasi
// problema o rezolva scripts/check-syntax.js prin --input-type=module; aici avem nevoie si de
// rezolvarea importurilor relative (./core.js), deci copiem fisierele intr-un director marcat
// {"type":"module"}. Copie VERBATIM — testam exact codul livrat, nu o varianta rescrisa.
// Alternativa (un public/package.json) ar fi ajuns servit static clientilor; public/ ramane curat.

import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tplScan from './tpl-scan.js';

const { templates } = tplScan;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUB = path.join(ROOT, 'public');

const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'contab-frontend-'));
process.on('exit', () => { try { fs.rmSync(mirror, { recursive: true, force: true }); } catch (e) { /* ignora */ } });
fs.writeFileSync(path.join(mirror, 'package.json'), '{"type":"module"}\n');
for (const f of fs.readdirSync(PUB)) {
  if (f.endsWith('.js') && fs.statSync(path.join(PUB, f)).isFile()) fs.copyFileSync(path.join(PUB, f), path.join(mirror, f));
}

// Shim-ul DOM se importa INAINTEA oricarui modul din public/ (globalii trebuie sa existe la
// evaluarea lui core.js). `await import` secvential garanteaza ordinea, spre deosebire de
// declaratiile `import` care sunt ridicate toate sus.
//
// `import()` primeste un URL `file://`, nu o cale de sistem: pe Windows o cale absoluta incepe cu
// `C:\`, iar incarcatorul ESM o citeste ca pe o schema de protocol necunoscuta si refuza tot
// fisierul („ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'c:'"). Pe Linux calea absoluta
// incepe cu `/` si trece din intamplare, deci defectul se vedea doar pe Windows — adica exact
// acolo unde ruleaza pachetul livrat clientilor.
const imp = (...p) => import(pathToFileURL(path.join(...p)).href);
await imp(ROOT, 'test', 'dom-shim.mjs');
const core = await imp(mirror, 'core.js');
const periods = await imp(mirror, 'periods.js');
const entries = await imp(mirror, 'entries.js');
const plan = await imp(mirror, 'plan.js');
const pag = await imp(mirror, 'paginare.js');
const dashboard = await imp(mirror, 'dashboard.js');
const rapoarte = await imp(mirror, 'rapoarte.js');
const livrabile = await imp(mirror, 'livrabile.js');
const messages = await imp(mirror, 'messages.js');
const etransport = await imp(mirror, 'etransport.js');
const app = await imp(mirror, 'app.js');
const stocuri = await imp(mirror, 'stocuri.js');
const bank = await imp(mirror, 'bank.js');
const viewer = await imp(mirror, 'viewer.js');
const partners = await imp(mirror, 'partners.js');
const inchidere = await imp(mirror, 'inchidere.js');
const docflow = await imp(mirror, 'docflow.js');
const admin = await imp(mirror, 'admin.js');
const ghid = await imp(mirror, 'ghid.js');
const formflow = await imp(mirror, 'formflow.js');

let pass = 0; let fail = 0;
function eq(name, got, exp) {
  const g = typeof got === 'number' ? Math.round(got * 100) / 100 : got;
  if (g === exp) { pass += 1; }
  else { fail += 1; console.error('  ✗ ' + name + ': got ' + JSON.stringify(g) + ', expected ' + JSON.stringify(exp)); }
}
function ok(name, cond) { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + name + ': condition false'); } }
function section(t) { console.log('\n' + t); }

// META are mereu forma completa: accName citeste META.accounts, iar un setMeta partial
// ar arunca TypeError in teste fara legatura cu ce verifica ele.
const setMeta = (types, accounts) => core.setMeta({ types: types || [], accounts: accounts || [], company: {}, periods: [] });

section('Nucleu: escaparea HTML (al doilea strat de aparare dupa CSP)');
eq('H escapeaza <', core.H('<script>'), '&lt;script&gt;');
eq('H escapeaza ghilimelele duble', core.H('a"b'), 'a&quot;b');
eq('H escapeaza apostroful', core.H("a'b"), 'a&#39;b');
eq('H escapeaza ampersandul', core.H('a&b'), 'a&amp;b');
eq('H pe null da sir gol', core.H(null), '');
eq('H pe undefined da sir gol', core.H(undefined), '');
eq('H converteste numerele', core.H(5), '5');
// Ordinea conteaza: & se escapeaza PRIMUL, altfel &lt; ar deveni &amp;lt;
eq('H nu dubleaza escaparea ampersandului', core.H('<'), '&lt;');
ok('H neutralizeaza iesirea dintr-un atribut', !core.H('" onerror="alert(1)').includes('"'));
// escMsg e varianta usoara (doar & < >): SIGURA in text, NESIGURA in atribute — de aceea
// exista escAttr. Testul fixeaza distinctia, ca sa nu fie folosite gresit una in locul alteia.
eq('escMsg lasa ghilimelele neatinse (doar pentru text)', core.escMsg('a"b'), 'a"b');
eq('escAttr escapeaza ghilimelele duble', core.escAttr('a"b'), 'a&quot;b');
eq('escAttr escapeaza si <', core.escAttr('<a "x">'), '&lt;a &quot;x&quot;&gt;');

section('Nucleu: formatarea si rotunjirea sumelor');
eq('fmt in format romanesc (punct la mii, virgula la zecimale)', core.fmt(1234.5), '1.234,50');
eq('fmt forteaza doua zecimale', core.fmt(0), '0,00');
eq('fmt pe milioane', core.fmt(1000000), '1.000.000,00');
eq('fmt pe negativ', core.fmt(-12.345), '-12,35');
eq('fmt pe null da zero (nu NaN)', core.fmt(null), '0,00');
eq('fmt pe text nenumeric da zero (nu NaN)', core.fmt('abc'), '0,00');
eq('round2 taie eroarea de virgula mobila', core.round2(0.1 + 0.2), 0.3);
eq('round2 rotunjeste in sus la jumatate', core.round2(1.005), 1.01);
// Paritatea cu backend-ul: aceeasi suma rotunjita in doua locuri trebuie sa dea acelasi ban.
// O divergenta aici inseamna totaluri care difera intre ecran si documentul generat de server.
const utilRound2 = (await imp(ROOT, 'src', 'util.js')).default.round2;
for (const v of [0.1 + 0.2, 1.005, 2.675, -1.005, 1234.567, 0]) {
  eq('round2 identic cu src/util.js pe ' + v, core.round2(v), utilRound2(v));
}

section('Nucleu: starea globala si helperii derivati');
setMeta([], [{ cod: '401', nume: 'Furnizori' }]);
eq('accName gaseste contul', core.accName('401'), 'Furnizori');
eq('accName accepta cod numeric', core.accName(401), 'Furnizori');
eq('accName pe cont inexistent da sir gol (nu undefined)', core.accName('999'), '');
core.setUser({ username: 'demo' });
ok('isDemo pentru contul demo', core.isDemo() === true);
core.setUser({ username: 'demo-contabil' });
ok('isDemo pentru demo-contabil', core.isDemo() === true);
core.setUser({ username: 'ana' });
ok('isDemo fals pentru un utilizator real', core.isDemo() === false);
core.setUser({});
ok('isDemo fals pentru utilizator fara nume', core.isDemo() === false);

section('Nucleu: cotele fiscale vin de la server, nu din frontend');
// Un procent scris de mana in frontend supravietuieste modificarii de cota si incepe sa minta:
// fie pune o valoare gresita intr-un formular (devine DATA), fie eticheteaza gresit un numar
// corect calculat pe server. Toate cotele afisate/implicite trec prin META.fiscal.
core.setMeta({ types: [], accounts: [], company: {}, periods: [], fiscal: { tvaStandard: 21, tvaRedus: 11, cas: 25, cass: 10, cam: 2.25, impozitVenit: 10 } });
eq('cota vine din META.fiscal', core.fiscalRate('tvaStandard', 19), 21);
eq('cheie necunoscuta cade pe implicit', core.fiscalRate('inexistenta', 7), 7);
eq('procentul se scrie romaneste (virgula zecimala)', core.fiscalPct('cam', 2.25), '2,25%');
eq('procent intreg', core.fiscalPct('cas', 25), '25%');
eq('textul explicativ primeste cota curenta', core.fiscalText('CAS {cas|25} din brut'), 'CAS 25% din brut');
eq('textul cu mai multe cote', core.fiscalText('{cas|25} + {cass|10}'), '25% + 10%');
eq('textul fara token ramane neatins', core.fiscalText('fara cote aici'), 'fara cote aici');
// META neincarcat (prima randare, inainte de /api/meta) -> se foloseste plasa din cod
core.setMeta({ types: [], accounts: [], company: {}, periods: [] });
eq('fara META.fiscal se foloseste implicitul', core.fiscalRate('tvaStandard', 21), 21);
eq('fara META.fiscal textul foloseste implicitul din token', core.fiscalText('CAM {cam|2.25}'), 'CAM 2,25%');
// o cota SCHIMBATA pe server trebuie sa se vada imediat in frontend, fara modificari de cod
core.setMeta({ types: [], accounts: [], company: {}, periods: [], fiscal: { tvaStandard: 23, cas: 26 } });
eq('o cota noua de pe server se vede in frontend', core.fiscalRate('tvaStandard', 21), 23);
eq('o cota noua se vede si in etichete', core.fiscalText('CAS {cas|25}'), 'CAS 26%');

section('Perioade: aritmetica lunilor de lucru');
eq('luna urmatoare trece anul (Decembrie -> Ianuarie)', periods.nextMonth('2026-12'), '2027-01');
eq('luna precedenta trece anul (Ianuarie -> Decembrie)', periods.prevMonth('2026-01'), '2025-12');
eq('luna urmatoare in interiorul anului', periods.nextMonth('2026-07'), '2026-08');
eq('luna precedenta in interiorul anului', periods.prevMonth('2026-07'), '2026-06');
eq('luna pastreaza doua cifre (padStart)', periods.nextMonth('2026-08'), '2026-09');
eq('februarie in an bisect nu deraiaza', periods.nextMonth('2024-02'), '2024-03');
// dus-intors pe toate lunile: prev(next(m)) === m, prinde derapajele de fus orar/zi din luna
for (let mo = 1; mo <= 12; mo += 1) {
  const m = '2026-' + String(mo).padStart(2, '0');
  eq('prev(next(' + m + ')) revine la ' + m, periods.prevMonth(periods.nextMonth(m)), m);
}
eq('lunaLabel in romana', periods.lunaLabel('2026-07'), 'Iulie 2026');
eq('lunaLabel pe ianuarie', periods.lunaLabel('2026-01'), 'Ianuarie 2026');
eq('lunaLabel pe decembrie', periods.lunaLabel('2026-12'), 'Decembrie 2026');
eq('LUNI are 12 luni', periods.LUNI.length, 12);
// luna de lucru e persistata in localStorage; o valoare invalida NU trebuie sa strice ecranul
periods.setWorkMonth('2026-03');
eq('workMonth citeste luna salvata', periods.workMonth(), '2026-03');
periods.setWorkMonth('stricat');
ok('workMonth cade pe luna curenta cand valoarea salvata e invalida', /^\d{4}-\d{2}$/.test(periods.workMonth()));
periods.setWorkMonth('2026-03');

section('Perioada globală și suprascrierile locale');
{
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(PUB, 'periods.js'), 'utf8');
  const css = fs.readFileSync(path.join(PUB, 'erp.css'), 'utf8');
  ok('bara persistentă are un singur selector global de lună',
    /id="currentPeriod"[^>]*aria-haspopup="dialog"/.test(html)
    && (html.match(/id="globalPeriodInput"/g) || []).length === 1);
  ok('ecranele lunare nu mai au selectori lună/an obligatorii duplicați',
    !/luna-req/.test(html)
    && !/id="(?:vc|livrabile|saft|portofoliu|mf|sp|stoc)(?:Luna|An)"/.test(html));
  ok('rapoartele locale sunt decorate explicit ca suprascrieri închise implicit',
    /\$\$\('select\.luna'\)\.forEach\(setupPairOverride\)/.test(js)
    && /Suprascrie perioada/.test(js)
    && /\.period-override > summary/.test(css));
  const localHandler = js.slice(js.indexOf('function onPeriodChange'), js.indexOf('function fillPeriods'));
  ok('schimbarea unui filtru local nu mai rescrie perioada globală',
    /addEventListener\('change', fn\)/.test(localHandler)
    && !/setWorkMonth|applyWorkMonth/.test(localHandler));
  ok('revenirea din excepție sincronizează din nou controlul cu perioada globală',
    /function resetPeriodOverride/.test(js)
    && /syncOverrideToGlobal\(box\)/.test(js)
    && /Folosește perioada globală/.test(js));
}

section('Inregistrari: clasificarea intrare/iesire');
setMeta([{ id: 'x_custom', grup: 'Vanzari' }, { id: 'y_custom', grup: 'Cumparari' }, { id: 'z_custom', grup: 'Trezorerie' }]);
eq('grupul Vanzari din META da iesire', entries.entryDir('x_custom'), 'out');
eq('grupul Cumparari din META da intrare', entries.entryDir('y_custom'), 'in');
eq('alt grup nu e nici intrare nici iesire', entries.entryDir('z_custom'), 'other');
// fara META (prima randare, inainte de /api/meta) clasificarea cade pe tiparele din id
setMeta([]);
eq('factura de vanzare e iesire si fara META', entries.entryDir('factura_vanzare_marfuri'), 'out');
eq('factura de cumparare e intrare si fara META', entries.entryDir('factura_cumparare'), 'in');
eq('livrarea intracomunitara e iesire', entries.entryDir('livrare_intracomunitara'), 'out');
eq('bonul fiscal e iesire', entries.entryDir('bon_fiscal'), 'out');
eq('avizul de livrare nu e clasificat ca vanzare', entries.entryDir('aviz_livrare'), 'other');
eq('tip necunoscut nu deraiaza', entries.entryDir('ceva_nou'), 'other');

section('Inregistrari: insigna de stare');
ok('ciorna e marcata ca ciorna', entries.entryStateBadge({ status: 'ciorna' }).includes('>ciornă<'));
ok('lipsa starii inseamna postat (compatibilitate cu articolele vechi)', entries.entryStateBadge({}).includes('st-postat'));
ok('articolul stornat isi anunta starea', entries.entryStateBadge({ stornat: true, stornoBy: 7 }).includes('stornat'));
ok('nota de storno e marcata distinct', entries.entryStateBadge({ stornoOf: 12 }).includes('storno'));
// stornat/stornoOf au prioritate asupra status: un articol stornat nu se mai afiseaza „ciorna"
ok('stornarea invinge starea din flux', entries.entryStateBadge({ status: 'ciorna', stornat: true, stornoBy: 3 }).includes('st-stornat'));
// campurile venite din date trec prin H
ok('stornoBy e escapat in atributul title', entries.entryStateBadge({ stornat: true, stornoBy: '<x>' }).includes('&lt;x&gt;'));
ok('stornoBy escapat nu lasa < brut', !entries.entryStateBadge({ stornat: true, stornoBy: '<x>' }).includes('<x>'));
// Poarta frontend <-> backend: fiecare stare acceptata de server trebuie sa aiba eticheta in
// frontend. Daca cineva adauga o stare in ENTRY_STATES fara sa completeze STATE_LABEL, insigna
// ar afisa identificatorul brut (nescapat) — testul cade aici, nu in productie.
const svcSrc = fs.readFileSync(path.join(ROOT, 'src', 'entriesService.js'), 'utf8');
const statesM = svcSrc.match(/const ENTRY_STATES = \[([^\]]+)\]/);
ok('ENTRY_STATES e gasit in src/entriesService.js', !!statesM);
const serverStates = statesM ? statesM[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')) : [];
eq('serverul accepta 4 stari', serverStates.length, 4);
const KNOWN_LABELS = new Set(['ciornă', 'validat', 'aprobat', 'postat']);
for (const st of serverStates) {
  const html = entries.entryStateBadge({ status: st });
  const label = (html.match(/>([^<]+)<\/span>/) || [])[1];
  ok('starea „' + st + '" are eticheta in frontend', KNOWN_LABELS.has(label));
  ok('starea „' + st + '" primeste clasa st-' + st, html.includes('class="st st-' + st + '"'));
}

section('Inregistrari: celula e-Transport');
eq('tipurile neeligibile nu primesc celula', entries.etranspCell({ tip: 'factura_vanzare_servicii' }), '');
const cellBtn = entries.etranspCell({ tip: 'aviz_livrare', id: 7, data: '2026-07-01', intrastat: { codNC: '8703' } });
ok('tipul eligibil fara UIT primeste butonul de declarare', cellBtn.includes('class="linkbtn ettrans"'));
ok('butonul poarta id-ul pentru prefill', cellBtn.includes('data-id="7"'));
ok('butonul poarta codul NC pentru prefill', cellBtn.includes('data-nc="8703"'));
const cellUit = entries.etranspCell({ tip: 'aviz_livrare', etransport: { uit: 'ABC123' } });
ok('cu UIT obtinut se afiseaza codul, nu butonul', cellUit.includes('UIT ABC123') && !cellUit.includes('ettrans'));
// Codul NC vine din datele documentului: o ghilimea nescapata ar sparge atributul si ar
// permite injectarea de atribute noi (onerror=…) — CSP e ultima plasa, nu prima.
const cellEvil = entries.etranspCell({ tip: 'aviz_livrare', id: 1, data: '2026-07-01', intrastat: { codNC: '" onerror="alert(1)' } });
ok('codul NC ostil nu poate iesi din atribut', cellEvil.includes('data-nc="&quot; onerror=&quot;alert(1)"'));
ok('UIT-ul este escapat', entries.etranspCell({ tip: 'aviz_livrare', etransport: { uit: '<b>' } }).includes('&lt;b&gt;'));
// Aliniere cu ELIGIBLE_TYPES din src/etransport.js: divergenta ar oferi butonul acolo unde
// serverul refuza declararea (sau invers, l-ar ascunde pe transporturi declarabile).
const etrSrc = fs.readFileSync(path.join(ROOT, 'src', 'etransport.js'), 'utf8');
const eligM = etrSrc.match(/ELIGIBLE_TYPES = new Set\(\[([^\]]+)\]/);
ok('ELIGIBLE_TYPES e gasit in src/etransport.js', !!eligM);
if (eligM) {
  const serverTypes = eligM[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  const missing = serverTypes.filter((t) => entries.etranspCell({ tip: t, id: 1, data: '2026-07-01' }) === '');
  ok('frontend-ul ofera e-Transport pentru toate tipurile eligibile pe server'
    + (missing.length ? ' (lipsesc: ' + missing.join(', ') + ')' : ''), missing.length === 0);
}

section('Plan de conturi: denumirile importate se escapeaza');
// Planul se poate extinde prin CSV (/api/accounts/import), deci `nume` NU e o constanta interna.
// Poarta generala de mai jos nu prinde acest caz: `nume`/`cod` sunt prea generice ca sa intre in
// RISKY_FIELD fara zgomot (vezi comentariul ei). De aceea sinkul se verifica aici, direct.
const planOtrava = [{ cod: '9999', nume: '<img src=x onerror=alert(1)>PWNED', clasa: 9, tip: 'B' }];
const planHtml = plan.planRowsHtml(planOtrava, '');
ok('denumirea de cont nu iese ca marcaj', !planHtml.includes('<img'));
ok('denumirea apare escapata', planHtml.includes('&lt;img src=x onerror=alert(1)&gt;PWNED'));
ok('codul de cont e si el escapat', !plan.planRowsHtml([{ cod: '<b>7</b>', nume: 'x', clasa: 1, tip: 'A' }], '').includes('<b>'));
ok('tipul contului e escapat', !plan.planRowsHtml([{ cod: '1', nume: 'x', clasa: 1, tip: '<s>A</s>' }], '').includes('<s>'));
eq('filtrul se aplica in continuare pe cod', plan.planRowsHtml(planOtrava, '9999').includes('9999'), true);
eq('filtrul care nu se potriveste da tabel gol', plan.planRowsHtml(planOtrava, 'zzz'), '');
ok('filtrul cauta si in denumire', plan.planRowsHtml(planOtrava, 'pwned').includes('9999'));

section('Plan de conturi: parsarea sumelor in format romanesc');
eq('format RO complet (punct la mii, virgula la zecimale)', plan.nrRo('1.234,56'), 1234.56);
eq('format RO cu mai multe grupe', plan.nrRo('1.234.567,89'), 1234567.89);
eq('format EN (virgula la mii, punct la zecimale)', plan.nrRo('1,234.56'), 1234.56);
eq('doar virgula zecimala', plan.nrRo('1234,56'), 1234.56);
eq('doar punct zecimal', plan.nrRo('1234.56'), 1234.56);
eq('spatiile sunt ignorate', plan.nrRo('1 234,56'), 1234.56);
eq('sufixul lei este ignorat', plan.nrRo('12 lei'), 12);
eq('sufixul RON este ignorat', plan.nrRo('100 RON'), 100);
eq('negativele se pastreaza', plan.nrRo('-5,5'), -5.5);
eq('sirul gol da zero', plan.nrRo(''), 0);
eq('textul nenumeric da zero (nu NaN)', plan.nrRo('abc'), 0);
eq('null da zero', plan.nrRo(null), 0);
eq('rezultatul e rotunjit la ban', plan.nrRo('5,678'), 5.68);
// Separatori de mii repetati: formatul RO uzual pentru sume mari, fara zecimale.
// Inainte de reparatie acestea dadeau 0 — suma disparea tacit din balanta de deschidere.
eq('mii cu grupe multiple (RO)', plan.nrRo('1.234.567'), 1234567);
eq('mii cu grupe multiple (EN)', plan.nrRo('1,234,567'), 1234567);
eq('grupele de mii pastreaza si zecimalele', plan.nrRo('1.234.567,89'), 1234567.89);
// Zero intreg si partea intreaga lunga NU pot fi grupe de mii -> zecimale, fara intrebare
eq('„0,500" e jumatate de leu, nu 500', plan.nrRo('0,500'), 0.5);
eq('„1234,567" nu e o grupare valida de mii -> zecimale', plan.nrRo('1234,567'), 1234.57);

section('Plan de conturi: valorile ambigue nu se ghicesc');
// Miezul reparatiei: un separator unic urmat de EXACT 3 cifre nu poate fi decis singur.
// Parserul raporteaza ambiguitatea in loc sa aleaga (UI-ul intreaba — vezi askSeparator).
ok('„1.234" e raportat ca ambiguu', plan.parseAmount('1.234').ambiguous === true);
ok('„1,234" e raportat ca ambiguu', plan.parseAmount('1,234').ambiguous === true);
ok('„10.000" e raportat ca ambiguu', plan.parseAmount('10.000').ambiguous === true);
ok('„1.234,56" NU e ambiguu (ambii separatori prezenti)', plan.parseAmount('1.234,56').ambiguous === false);
ok('„1234,56" NU e ambiguu (doua zecimale)', plan.parseAmount('1234,56').ambiguous === false);
ok('„1.234.567" NU e ambiguu (separator repetat)', plan.parseAmount('1.234.567').ambiguous === false);
ok('un numar fara separator NU e ambiguu', plan.parseAmount('1234').ambiguous === false);
ok('sirul gol NU e ambiguu', plan.parseAmount('').ambiguous === false);
// Odata lamurit rolul separatorului, aceeasi valoare se citeste in ambele feluri
eq('ambiguu rezolvat ca mii', plan.nrRo('1.234', { '.': 'mii' }), 1234);
eq('ambiguu rezolvat ca zecimale', plan.nrRo('1.234', { '.': 'zecimale' }), 1.23);
eq('rolul se aplica pe separatorul corect', plan.nrRo('1,234', { ',': 'mii' }), 1234);
ok('cu rol dat, valoarea nu mai e ambigua', plan.parseAmount('1.234', { '.': 'mii' }).ambiguous === false);

section('Plan de conturi: deducerea conventiei din fisier');
// O singura linie care se citeste singur lamureste tot fisierul — asa evitam sa intrebam degeaba.
eq('„1.234,56" arata ca punctul separa miile', plan.sepConvention(['1.234,56'])['.'], 'mii');
eq('„1.234,56" arata ca virgula e zecimala', plan.sepConvention(['1.234,56'])[','], 'zecimale');
eq('„12,5" arata ca virgula e zecimala', plan.sepConvention(['12,5'])[','], 'zecimale');
eq('„1.234.567" arata ca punctul separa miile', plan.sepConvention(['1.234.567'])['.'], 'mii');
eq('tokenurile ambigue nu deduc nimic', plan.sepConvention(['1.234', '2.500'])['.'], null);
eq('fara tokenuri nu se deduce nimic', plan.sepConvention([])['.'], null);
// dovezi contradictorii pe acelasi separator: nu ghicim, raspunde omul
eq('dovezi contradictorii anuleaza deducerea', plan.sepConvention(['1.234,56', '12.5'])['.'], null);

section('Plan de conturi: importul balantei (linii -> randuri)');
const LINES_CLAR = ['Cont;Denumire;SoldDebit;SoldCredit', '5121;Banca;1.234,56;0', '401;Furnizori;0;2.500,00'];
const clar = plan.openingRowsFrom(LINES_CLAR, plan.sepConvention(['1.234,56', '0', '0', '2.500,00']));
eq('antetul este sarit', clar.rows.length, 2);
eq('nicio ambiguitate pe un fisier clar', clar.ambig.length, 0);
eq('soldul debitor este citit corect', clar.rows[0].d, 1234.56);
eq('contul este pastrat', clar.rows[0].cont, '5121');
eq('soldul creditor este citit corect', clar.rows[1].c, 2500);
// acelasi fisier, dar fara nicio zecimala care sa lamureasca separatorul -> import BLOCAT
const LINES_AMBIG = ['Cont;Denumire;SoldDebit;SoldCredit', '5121;Banca;10.000;0', '401;Furnizori;0;10.000'];
const amb = plan.openingRowsFrom(LINES_AMBIG, plan.sepConvention(['10.000', '0', '0', '10.000']));
ok('fisierul fara dovezi raporteaza ambiguitatea', amb.ambig.length > 0);
eq('valoarea ambigua e raportata asa cum a fost scrisa', amb.ambig[0], '10.000');
// cu raspunsul omului, aceleasi linii se importa cu valoarea corecta
const rezolvat = plan.openingRowsFrom(LINES_AMBIG, { '.': 'mii', ',': 'zecimale' });
eq('dupa confirmare nu mai ramane nimic ambiguu', rezolvat.ambig.length, 0);
eq('„10.000" devine zece mii', rezolvat.rows[0].d, 10000);
// randurile fara solduri nu intra in editor
const golite = plan.openingRowsFrom(['5121;Banca;0;0', '401;Furnizori;0;100'], {});
eq('randurile cu ambele solduri zero sunt sarite', golite.rows.length, 1);
// Raspunsul omului: separatorii au roluri COMPLEMENTARE, deci un raspuns ii lamureste pe amandoi
eq('raspuns „mii" pe punct face virgula zecimala', plan.mergeRoles({}, '.', 'mii')[','], 'zecimale');
eq('raspuns „zecimale" pe punct face virgula separator de mii', plan.mergeRoles({}, '.', 'zecimale')[','], 'mii');
eq('raspunsul se aplica separatorului intrebat', plan.mergeRoles({}, ',', 'mii')[','], 'mii');
// ce a stabilit deja fisierul NU se rescrie cu raspunsul omului
eq('deducerea din fisier are prioritate', plan.mergeRoles({ '.': 'mii' }, ',', 'mii')['.'], 'mii');

section('Dashboard: tendinta lunara');
eq('serie goala nu are tendinta', dashboard.trendOf([], 'venituri'), null);
eq('o singura luna nu are tendinta', dashboard.trendOf([{ venituri: 10 }], 'venituri'), null);
eq('crestere de 50%', dashboard.trendOf([{ venituri: 100 }, { venituri: 150 }], 'venituri'), 50);
eq('scadere de 50%', dashboard.trendOf([{ venituri: 100 }, { venituri: 50 }], 'venituri'), -50);
// impartirea la zero ar da Infinity si ar afisa „▲ Infinity%" — se intoarce null
eq('luna precedenta zero nu da Infinity', dashboard.trendOf([{ venituri: 0, cheltuieli: 1 }, { venituri: 150 }], 'venituri'), null);
// baza negativa: procentul se raporteaza la modul, ca semnul sa vina din diferenta
eq('baza negativa foloseste modulul', dashboard.trendOf([{ venituri: -100 }, { venituri: -50 }], 'venituri'), 50);
eq('profitul se calculeaza ca venituri - cheltuieli', dashboard.trendOf([{ venituri: 100, cheltuieli: 50 }, { venituri: 200, cheltuieli: 50 }], 'profit'), 200);
// lunile fara nicio miscare sunt sarite: altfel o luna goala ar arata ca o prabusire de -100%
eq('lunile complet goale sunt ignorate', dashboard.trendOf([{ venituri: 100 }, { venituri: 0, cheltuieli: 0 }, { venituri: 150 }], 'venituri'), 50);

section('Dashboard: culoarea KPI spune ceva despre VALOARE, nu despre tipul cardului');
// Regresia care se apara aici: clasele erau fixate pe card, deci „Sold clienti 0,00" iesea verde
// („bine" despre „n-ai ce incasa"), iar un disponibil bancar negativ — pe care aplicatia il
// semnaleaza ca eroare in banda de alerte — iesea neutru. Contrastul dintre cele doua e miezul.
eq('trezorerie pozitiva ramane neutra', dashboard.tonTrezorerie(1500), 'blue');
eq('trezorerie zero e neutra, nu o eroare', dashboard.tonTrezorerie(0), 'blue');
eq('trezorerie NEGATIVA e semnalata', dashboard.tonTrezorerie(-60819), 'red');
// „-0" vine din scaderi in virgula mobila si NU e sub zero: nu are voie sa alarmeze
eq('minus zero nu alarmeaza', dashboard.tonTrezorerie(-0), 'blue');
// valorile vin din JSON, deci pot sosi ca sir; comparatia trebuie sa fie numerica, nu lexicala
eq('sir negativ e tratat numeric', dashboard.tonTrezorerie('-12.5'), 'red');
eq('sir pozitiv e tratat numeric', dashboard.tonTrezorerie('12.5'), 'blue');
// niciodata verde: nu exista „bine" pe un sold de trezorerie, doar „normal" si „gresit"
ok('trezoreria nu afirma niciodata „bine"', ![-1, 0, 1, 1e9].some((v) => dashboard.tonTrezorerie(v) === 'green'));

// Soldurile de terti sunt FAPTE: nicio culoare evaluativa pe ele, in niciuna dintre cele doua
// vederi (KPI-urile din modul expert si dalele „Situatia firmei" din modul simplu).
const dashSrc = fs.readFileSync(path.join(PUB, 'dashboard.js'), 'utf8');
const cardLinie = (eticheta) => (dashSrc.split('\n').find((l) => l.includes(eticheta)) || '');
for (const et of ['Sold clienți (4111)', 'Sold furnizori (401)', 'De încasat de la clienți', 'De plătit către furnizori', 'Obligații: stat & salarii']) {
  const l = cardLinie(et);
  ok('„' + et + '" nu e colorat evaluativ', l !== '' && !/'green'|'red'/.test(l));
}

section('Dashboard: un cont în minus nu are voie să se ascundă într-un total pozitiv');
{
  // Cazul REAL de pe contul demo, cel care a dat numele acestei secțiuni: banca era la −60.819 și
  // casa la +117.046, deci „Bani disponibili" arăta 56.227,00 albastru și senin — la trei
  // centimetri sub o alertă care striga chiar acel sold negativ. Aceeași cifră, două afirmații
  // contrare, pe același ecran. Compensarea e corectă aritmetic și dezinformantă vizual.
  const d = dashboard.dalaDisponibil(-60819, 117046, 56227);
  eq('componenta negativă schimbă tonul, deși totalul e pozitiv', d.ton, 'red');
  ok('...și e numită ca atare, nu doar colorată', d.sub.includes('un cont e în minus'));
  ok('...cu avertismentul că totalul minte prin compensare', d.sub.includes('mai puțini bani decât arată totalul'));
  ok('cifra negativă e evidențiată, nu doar scrisă', d.sub.includes('<b data-u="u33">-60.819,00</b>'));
  ok('...iar cifra pozitivă rămâne neevidențiată', d.sub.includes('casă 117.046,00'));

  // Fără nimic în minus, dala rămâne exact cum era: neutră, cu detalierea simplă.
  const ok2 = dashboard.dalaDisponibil(1000, 500, 1500);
  eq('totul pozitiv rămâne neutru', ok2.ton, 'blue');
  ok('...fără avertisment inventat', !ok2.sub.includes('în minus'));
  eq('...și cu detalierea de dinainte', ok2.sub, 'bancă 1.000,00 · casă 500,00');

  // Zero nu e sub zero: aceeași regulă ca la `tonTrezorerie`, ca cele două să nu divergă.
  eq('zero nu alarmează', dashboard.dalaDisponibil(0, 0, 0).ton, 'blue');
  eq('minus zero nu alarmează', dashboard.dalaDisponibil(-0, 0, -0).ton, 'blue');
  // Totalul negativ rămâne semnalat chiar dacă ambele componente sunt „doar" mici.
  eq('total negativ e semnalat și fără componentă negativă', dashboard.dalaDisponibil(0, 0, -5).ton, 'red');
  // Ambele în minus: pluralul contează, e chiar rândul pe care omul îl citește ca pe un diagnostic.
  ok('două conturi în minus se spun la plural', dashboard.dalaDisponibil(-10, -20, -30).sub.includes('două conturi sunt în minus'));
  // Valorile vin din JSON, deci pot sosi ca șir — comparația trebuie să fie numerică.
  eq('șir negativ e tratat numeric', dashboard.dalaDisponibil('-12.5', '100', '87.5').ton, 'red');
}

section('Dashboard: firma fără nicio înregistrare nu primește un ecran de zerouri');
{
  // Măsurat pe un cont nou: 11 din 11 carduri randau doar `0,00`, liniuțe sau „fără date".
  // Condiția e strict „zero înregistrări", nu „puține": la prima înregistrare panourile revin.
  ok('firma goală ascunde panourile', dashboard.tabloulEGol({ nrInregistrari: 0 }) === true);
  ok('o singură înregistrare le aduce înapoi', dashboard.tabloulEGol({ nrInregistrari: 1 }) === false);
  ok('firma cu istoric nu e atinsă', dashboard.tabloulEGol({ nrInregistrari: 22000 }) === false);
  // Numărul vine prin JSON: comparația trebuie să fie numerică, nu lexicală („0" e tot zero).
  ok('zero sosit ca șir e tot zero', dashboard.tabloulEGol({ nrInregistrari: '0' }) === true);
  ok('...iar un șir nenul nu e zero', dashboard.tabloulEGol({ nrInregistrari: '3' }) === false);
  // „Nu știu" NU e „gol": pe un răspuns vechi sau tăiat, ascunderea ar șterge de pe ecran cifre
  // reale ale unei firme cu activitate. Aceeași regulă ca la garda de deploy și la drill-uri.
  ok('lipsa datelor nu ascunde nimic', dashboard.tabloulEGol(undefined) === false);
  ok('...nici obiectul fără câmpul așteptat', dashboard.tabloulEGol({}) === false);
  ok('...nici null', dashboard.tabloulEGol(null) === false);

  // Poarta pe SELECTORI: `querySelector` întoarce `null` la un id redenumit, deci ascunderea ar
  // înceta TĂCUT — cardul ar reapărea pe ecranul firmei goale fără ca vreun test să pice.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const lista = dashboard.PANOURI_ANALITICE;
  ok('lista de panouri nu e goală', Array.isArray(lista) && lista.length >= 8);
  for (const sel of lista) {
    ok('„' + sel + '" e un id existent în index.html', /^#[A-Za-z][\w-]*$/.test(sel)
      && html.includes('id="' + sel.slice(1) + '"'));
  }
  ok('randul explicativ există în pagină', html.includes('id="dashGolCard"'));
  // Reversul, la fel de important: dacă lucrurile ACȚIONABILE ar intra în listă, ecranul firmei
  // goale ar rămâne complet gol — adică exact defectul reparat, cu semnul schimbat.
  for (const pastrat of ['#primiiPasiCard', '#deFacutCard', '#dashGolCard']) {
    ok('„' + pastrat + '" rămâne pe ecran', !lista.includes(pastrat));
  }
  // Panourile scumpe nu se mai cer de la server când n-au ce arăta.
  ok('previziunea nu se mai cere pe firma goală', /if \(!gol\) renderForecast\(\)/.test(dashSrc));
  ok('graficele nu se mai desenează pe firma goală', /if \(gol\) return;\s*\n\s*if \(c\) renderDashboardCharts/.test(dashSrc));
}

section('Dashboard: primul ecran rămâne scurt, iar analizele se personalizează');
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const inceput = html.indexOf('<div class="dashboard-primary"');
  const sfarsit = html.indexOf('<!-- Ce se vede in locul panourilor', inceput);
  const primaZona = html.slice(inceput, sfarsit);
  ok('prima zonă conține numai ce e acționabil și cei patru indicatori', inceput > 0 && sfarsit > inceput
    && primaZona.includes('id="deFacutCard"') && primaZona.includes('id="rezumatKpis"')
    && primaZona.includes('id="quickActionsCard"') && !primaZona.includes('id="yoyCard"')
    && !primaZona.includes('id="forecastCard"') && !primaZona.includes('id="openItemsView"'));
  const rezumat = (dashSrc.match(/async function renderRezumat[\s\S]*?box\.innerHTML\s*=([\s\S]*?)\n\s*\$\$\('#rezumatKpis/) || [])[1] || '';
  eq('rezumatul de lucru randează exact patru indicatori', (rezumat.match(/tile\('/g) || []).length, 4);
  const actiuni = (primaZona.match(/<div class="quickacts quickacts-primary">([\s\S]*?)<\/div>/) || [])[1] || '';
  eq('sunt patru acțiuni frecvente directe', (actiuni.match(/<button\b/g) || []).length, 4);
  eq('analizele secundare sunt grupate în patru panouri native',
    (html.match(/<details class="dashboard-analysis[^>]*data-dashboard-panel=/g) || []).length, 4);
  ok('panourile pornesc strânse și conținutul nu poate forța afișarea',
    !/<details class="dashboard-analysis[^>]*\sopen(?:\s|>)/.test(html)
      && /\.dashboard-analysis:not\(\[open\]\)>\.dashboard-analysis-body\{display:none!important\}/.test(css));
  ok('alegerea panourilor este memorată per utilizator',
    /contabo:dashboard-panels:v1/.test(dashSrc) && /USER\.id \|\| USER\.username/.test(dashSrc)
      && /localStorage\.setItem\(cheieCurenta\(\), JSON\.stringify\(stare\)\)/.test(dashSrc));
  ok('mobilul păstrează KPI-urile și acțiunile într-o grilă 2×2',
    /#quickActionsCard \.quickacts\{grid-template-columns:1fr 1fr/.test(css)
      && /\.dashboard-primary #rezumatKpis\{grid-template-columns:1fr 1fr\}/.test(css));
}

section('Poartă: `display:…!important` nu are voie să bată `.hidden`');
{
  // A PATRA oară aceeași capcană, de fiecare dată găsită prin efectul ei, nu prin regulă:
  //   1. `.login-box label` — un câmp ascuns din JS rămânea vizibil;
  //   2. `#tabs>button[data-tab]` — „Portofoliu" apărea și la conturile cu o singură firmă;
  //   3. `.simple-ui .simple-only` — „Situația firmei" arăta patru dale de 0,00 pe firma goală;
  //   4. `#tabs .navmenu button` — „Cine accesează aplicația" se vedea la orice utilizator.
  // Primele trei au fost reparate una câte una, fiecare cu propriul comentariu care spunea
  // „aceeași capcană ca mai sus". Un comentariu nu e un mecanism. Poarta se DERIVĂ din sursă:
  // orice regulă care FACE VIZIBIL ceva cu `!important` trebuie să se retragă în fața lui
  // `.hidden`. Regulile care ascund (`display:none!important`) nu intră — ele sunt de acord.
  // Verificarea traversează toate cele trei straturi CSS livrate. După consolidare, regulile
  // vizibile ale navigației sunt în erp.css, nu în styles.css; principiul rămâne comun.
  const css = ['styles.css', 'erp.css', 'design-system.css']
    .map((f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')).join('\n');
  const faraComentarii = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const vinovate = [];
  let vazute = 0;
  for (const m of faraComentarii.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decl = /display\s*:\s*([^;}!]+)!important/.exec(m[2]);
    if (!decl) continue;
    if (decl[1].trim() === 'none') continue; // ascunde: nu poate contrazice `.hidden`
    vazute += 1;
    const sel = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (sel.some((s) => !s.includes(':not(.hidden)'))) vinovate.push(sel.join(', ').slice(0, 70));
  }
  ok('poarta chiar vede reguli (nu o listă goală)', vazute >= 5);
  ok('nicio regulă nu forțează vizibilitatea peste `.hidden`'
    + (vinovate.length ? ' — ADAUGĂ `:not(.hidden)` la: ' + vinovate.join(' | ') : ''), vinovate.length === 0);
  // Și reversul: poarta trebuie să PICE dacă cineva scoate garda. Se dovedește pe un exemplu
  // sintetic, nu prin mutarea fișierului real — altfel „trece" ar putea însemna „n-a citit nimic".
  const fals = '.x .y{display:block!important}';
  const prinde = [...fals.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .some((m) => /display\s*:\s*([^;}!]+)!important/.test(m[2]) && !m[1].includes(':not(.hidden)'));
  ok('...iar poarta chiar prinde o regulă nepăzită', prinde === true);
}

section('Declarații: eticheta spune UNDE ești față de termen, nu doar „Nedepusă"');
{
  // „Nedepusă" e adevărat, dar nu spune nimic: orice declarație e nedepusă până e depusă.
  // Informația utilă e alta — mai ai timp, e momentul, sau ai întârziat.
  const s = (st, u) => livrabile.declStareAfisata(st, u);
  eq('termen departe: etichetă neutră', s('nedepusa', 'in-pregatire').t, 'În pregătire');
  eq('termen aproape: „De depus"', s('nedepusa', 'termen').t, 'De depus');
  eq('termen trecut: „Restanță"', s('nedepusa', 'restanta').t, 'Restanță');
  // Culoarea e parte din afirmație, nu decor: neutru ≠ avertisment ≠ alarmă. Fără asta, cele trei
  // stări ar avea nume diferite și același ton — adică exact defectul reparat, mai discret.
  const culori = ['in-pregatire', 'termen', 'restanta'].map((u) => s('nedepusa', u).c);
  eq('cele trei stări au trei tonuri distincte', new Set(culori).size, 3);
  ok('„în pregătire" NU folosește tonul de avertizare', s('nedepusa', 'in-pregatire').c !== s('nedepusa', 'termen').c);

  // Starea SALVATĂ bate derivarea: „Depusă" rămâne „Depusă".
  eq('starea salvată rămâne vizibilă', s('depusa', 'gata').t, 'Depusă');
  eq('...și „Scutită" la fel', s('scutita', 'gata').t, 'Scutită');
  eq('aprobarea documentului are stare distinctă de transmitere', s('aprobata', 'termen').t, 'Aprobată');
  // „Generată" (XML descărcat, nedepus la ANAF) își păstrează eticheta, dar restanța se adaugă.
  eq('„Generată" rămâne generată', s('generata', 'restanta').t, 'Generată');
  ok('...cu marcajul de restanță alături', s('generata', 'restanta').restanta === true);
  ok('...iar când nu e restanță, fără marcaj', !s('generata', 'in-pregatire').restanta);

  // Fiecare stare derivată își explică singură înțelesul — altfel „În pregătire" pe un rând care
  // în selector arată „Nedepusă" ar părea două sisteme de stări.
  ok('starea derivată poartă o explicație', s('nedepusa', 'in-pregatire').titlu.includes('nedepusă'));
  ok('restanța explică ce s-a întâmplat', /trecut/i.test(s('nedepusa', 'restanta').titlu));
  // Apel fără urgență (ecrane care n-o au): comportamentul de dinainte, fără excepție.
  eq('fără urgență se cade pe starea salvată', s('nedepusa', undefined).t, 'Nedepusă');
}

section('Primii pași: pasul 1 SPUNE ce lipsește, nu doar rămâne nebifat');
{
  // Pasul stătea nebifat pe un ecran („Firma mea") cu ~40 de câmpuri, fără să spună care.
  // Lista vine de la server (derivată în src/dateFirma.js) — nu se reface aici, ca să nu existe
  // două definiții care driftează la primul câmp adăugat într-un generator.
  const d = dashboard.descriereDateFirma([
    { camp: 'caen', eticheta: 'Cod CAEN', deCe: 'D300, D394 și D112 îl cer; fără el pleacă „0000"' },
    { camp: 'judet', eticheta: 'Județul', deCe: 'e-Factura cere codul județului' },
  ]);
  ok('numește câmpurile care lipsesc', d.includes('Cod CAEN') && d.includes('Județul'));
  ok('...și spune de ce contează primul', d.includes('D300'));
  // Motivul e al PRIMULUI câmp, nu al tuturor: patru explicații una sub alta ar fi un paragraf
  // pe un rând de checklist.
  ok('nu înșiră toate motivele', !d.includes('e-Factura cere codul județului'));

  // Firma completă: descrierea rămâne cea generală, fără „mai lipsește".
  ok('firma completă primește descrierea normală', !dashboard.descriereDateFirma([]).includes('Mai lipsește'));
  ok('lipsa listei nu aruncă', typeof dashboard.descriereDateFirma(undefined) === 'string');

  // Textul intră într-un ȘABLON HTML (`stepsHtml`), alături de descrieri care sunt literali
  // scriși de noi. Un câmp venit prin API n-are voie să fie singurul neescapat din șirul acela.
  const rau = dashboard.descriereDateFirma([{ camp: 'x', eticheta: '<img src=x onerror=alert(1)>', deCe: 'y' }]);
  ok('eticheta venită prin API e escapată', !rau.includes('<img') && rau.includes('&lt;img'));}

section('Banda de sus nu contrazice checklistul de dedesubt');
{
  // „Totul pare în regulă" e adevărat despre URGENȚE și fals despre firmă: cât timp checklistul
  // de dedesubt cere cinci lucruri, mesajul îl contrazice la citire. Cele două afirmații stăteau
  // la trei centimetri una de alta, pe același ecran, despre aceeași firmă.
  const proaspata = { nrInregistrari: 0, firmaCompletata: false, arePartener: false,
    documentInregistrat: false, facturaEmisa: false };
  const m = dashboard.mesajFaraAlerte(proaspata, false);
  ok('firma la început NU primește „totul e în regulă"', !/Totul pare în regulă/.test(m.txt));
  ok('...ci spune că nu e nicio urgență, dar pornirea nu e gata', /Nicio urgență/.test(m.txt) && /nu e pornită complet/.test(m.txt));
  ok('...și CÂȚI pași au rămas', /<b>5<\/b> pași/.test(m.txt));
  // Numărul vine din aceeași sursă din care se bifează pașii — altfel ar apărea o a treia
  // definiție a lui „gata", exact defectul reparat, cu un pas lateral.
  const doiFacuti = Object.assign({}, proaspata, { firmaCompletata: true, arePartener: true });
  ok('numărul urmează bifele reale', /<b>3<\/b> pași/.test(dashboard.mesajFaraAlerte(doiFacuti, false).txt));
  ok('singularul e corect la un singur pas rămas',
    / <b>1<\/b> pas\b/.test(dashboard.mesajFaraAlerte(
      { nrInregistrari: 4, firmaCompletata: true, arePartener: true, documentInregistrat: true, facturaEmisa: false }, false).txt));
  // Toți pașii făcuți, dar checklistul încă pe ecran (sub 5 înregistrări): nu mai e nimic de spus
  // despre pornire, deci revine mesajul obișnuit. Cazul e real și e singurul în care checklistul
  // e vizibil FĂRĂ ca banda să vorbească despre pași.
  ok('toți pașii făcuți -> mesajul obișnuit, deși checklistul e încă pe ecran',
    /Totul pare în regulă/.test(dashboard.mesajFaraAlerte(
      { nrInregistrari: 4, firmaCompletata: true, arePartener: true, documentInregistrat: true, facturaEmisa: true }, false).txt));

  // Firma cu activitate: mesajul de dinainte, neatins.
  const asezata = { nrInregistrari: 12, firmaCompletata: true, arePartener: true,
    documentInregistrat: true, facturaEmisa: true };
  ok('firma așezată primește mesajul de dinainte', /Totul pare în regulă/.test(dashboard.mesajFaraAlerte(asezata, false).txt));
  // Contul fără nicio firmă are bannerul lui; aici n-are ce checklist să contrazică.
  ok('contul fără firmă nu primește îndemn despre o firmă inexistentă',
    /Totul pare în regulă/.test(dashboard.mesajFaraAlerte(proaspata, true).txt));
  ok('lipsa datelor nu inventează un îndemn', /Totul pare în regulă/.test(dashboard.mesajFaraAlerte(null, false).txt));

  // Banda și checklistul trebuie să răspundă la ACEEAȘI întrebare — de aceea condiția e o
  // funcție, nu două ieșiri devreme îngropate în randare.
  eq('checklistul e vizibil exact când firma e la început', dashboard.checklistVizibil(proaspata, false), true);
  eq('...și ascuns pentru firma așezată', dashboard.checklistVizibil(asezata, false), false);
  eq('...și pentru contul fără firmă', dashboard.checklistVizibil(proaspata, true), false);
  // Cele două condiții nu au voie să se despartă: mesajul „mai ai N pași" apare DOAR când
  // checklistul care-i dă numărul e chiar pe ecran.
  // Implicație, nu echivalență: banda poate tăcea despre pași cu checklistul pe ecran (toți pașii
  // făcuți), dar nu poate vorbi despre ei cu checklistul ascuns — atunci ar trimite la o listă
  // care nu se vede.
  const totiFacuti = { nrInregistrari: 4, firmaCompletata: true, arePartener: true, documentInregistrat: true, facturaEmisa: true };
  for (const [p, ff] of [[proaspata, false], [asezata, false], [proaspata, true], [null, false], [totiFacuti, false]]) {
    const spuneP = /Nicio urgență/.test(dashboard.mesajFaraAlerte(p, ff).txt);
    ok('banda nu trimite la un checklist ascuns', !spuneP || dashboard.checklistVizibil(p, ff));
  }
  // Randarea trebuie să folosească un ton NECLICABIL. Componenta pune cursorul de acțiune numai
  // când există `data-go`/`data-notif`, iar varianta informativă își fixează explicit starea.
  eq('tonul e cel neclicabil, dedicat', dashboard.mesajFaraAlerte(proaspata, false).ton, 'start');
  const dsCss = fs.readFileSync(path.join(ROOT, 'public', 'design-system.css'), 'utf8');
  ok('...și tonul acela chiar nu arată clicabil',
    /body\.erp \.alert\.start,[\s\S]{0,80}body\.erp \.alert\.ok\s*\{\s*cursor:\s*default/.test(dsCss));
}
section('Dashboard: „De făcut acum" — termenele, sus pe Acasă');
{
  // `azi` e fixat: altfel vechimea restanței ar depinde de ziua în care rulează suita.
  const AZI = '2026-08-07';
  const it = (o) => Object.assign({ kind: 'restanta', firmaId: 1, firma: 'ALFA SRL', tip: 'D300', nume: 'D300 — decont TVA', period: '2026-05', due: '2026-06-25', status: 'nedepusa' }, o);

  const unul = dashboard.deFacutHtml([it({})], AZI);
  ok('rândul spune ce declarație e', unul.includes('D300 — decont TVA'));
  ok('vechimea restanței e în cuvinte, nu doar o dată', unul.includes('restanță de 43 zile'));
  ok('termenul depășit rămâne vizibil', unul.includes('2026-06-25'));
  ok('luna la care se referă e acolo', unul.includes('luna 2026-05'));
  ok('restanța e marcată ca gravă', unul.includes('class="alert bad"'));
  ok('rândul poartă acțiunea care o rezolvă', unul.includes('Deschide declarația →'));

  // Un termen VIITOR nu e restanță: nici tonul, nici cuvintele nu au voie să fie aceleași.
  const viitor = dashboard.deFacutHtml([it({ kind: 'termen', due: '2026-09-25' })], AZI);
  ok('termenul apropiat e avertisment, nu restanță', viitor.includes('class="alert warn"') && !viitor.includes('alert bad'));
  ok('...și nu spune „restanță"', !viitor.includes('restanță'));

  // Singular/plural: „restanță de 1 zile" e neîngrijit exact pe rândul care sperie cel mai tare.
  ok('o singură zi se scrie la singular', dashboard.deFacutHtml([it({ due: '2026-08-06' })], AZI).includes('restanță de 1 zi<'));

  // e-Factura merge în ALT ecran decât declarațiile — eticheta butonului vine din `notifAct`,
  // nu dintr-o constantă rescrisă aici (altfel cele două ecrane ar drifta).
  ok('e-Factura netrimisă trimite în SPV, nu la declarații',
    dashboard.deFacutHtml([it({ tip: 'efactura', nume: 'e-Factura EXP 2001' })], AZI).includes('Trimite în SPV →'));

  // Numele firmei: zgomot pentru un patron cu o firmă, necesar pentru un contabil cu portofoliu.
  ok('cu o singură firmă, numele ei nu se repetă pe fiecare rând', !unul.includes('ALFA SRL'));
  const douaFirme = dashboard.deFacutHtml([it({}), it({ firmaId: 2, firma: 'BETA SRL' })], AZI);
  ok('cu mai multe firme, fiecare rând spune a cui e', douaFirme.includes('ALFA SRL') && douaFirme.includes('BETA SRL'));

  // Plafonul: ecranul de sus arată primele câteva, restul se văd din „Vezi toate".
  const multe = dashboard.deFacutHtml(Array.from({ length: 9 }, (_, i) => it({ nume: 'D' + i })), AZI);
  eq('cel mult cinci rânduri sus pe Acasă', (multe.match(/class="alert /g) || []).length, 5);
  ok('...și sunt primele, adică cele mai urgente', multe.includes('>D0<') && !multe.includes('>D5<'));

  // Datele externe ajung aici: numele partenerului din e-Factura intră în `nume`, iar denumirea
  // firmei o scrie utilizatorul. Poarta generală de escapare scanează sursa; asta verifică IEȘIREA.
  const rau = dashboard.deFacutHtml([it({ nume: 'e-Factura <img src=x onerror=alert(1)>', firmaId: 1 }),
    it({ firmaId: 2, firma: '<script>alert(2)</script>' })], AZI);
  ok('numele declarației e escapat', rau.includes('&lt;img') && !rau.includes('<img'));
  ok('numele firmei e escapat', rau.includes('&lt;script&gt;') && !rau.includes('<script>'));

  eq('fără termene nu se randează niciun rând', dashboard.deFacutHtml([], AZI), '');
  eq('lipsa listei nu aruncă', dashboard.deFacutHtml(undefined, AZI), '');
}

section('Pașii numerotați vin în pereche: nu există „pasul 2" fără „pasul 1"');
{
  // „Emite factură" începea cu „2 · Verifică și salvează", iar cardul din stânga nu purta niciun
  // număr — deci ecranul începea cu pasul doi și nu spunea niciodată care e primul. Pe tabul
  // „Documente" perechea era corectă, deci defectul era o desperechere, nu o convenție lipsă.
  // Poarta e pe TOATĂ pagina: oriunde apare un „N ·", numerele lui trebuie să înceapă de la 1 și
  // să fie consecutive în secțiunea lor.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const sectiuni = html.split(/<section id="tab-/).slice(1);
  ok('poarta chiar vede secțiunile', sectiuni.length > 20);
  let cuPasi = 0;
  for (const s of sectiuni) {
    const nume = s.slice(0, s.indexOf('"'));
    const nr = [...s.matchAll(/<h[1-4][^>]*>\s*(\d+)\s*·/g)].map((m) => Number(m[1]));
    if (!nr.length) continue;
    cuPasi += 1;
    const sortate = [...nr].sort((a, b) => a - b);
    ok('tab-' + nume + ': pașii încep de la 1 (are ' + nr.join(',') + ')', sortate[0] === 1);
    ok('tab-' + nume + ': pașii sunt consecutivi', sortate.every((v, i) => v === i + 1));
  }
  // Workbench-ul de documente folosește acum o listă semantică de progres, nu titluri „N ·";
  // ecranul de emitere păstrează convenția cu titluri, deci mulțimea nu are voie să fie goală.
  ok('poarta chiar a găsit ecrane cu pași numerotați', cuPasi >= 1);
  // Poarta trebuie să POATĂ pica: forma veche (doar „2 ·", fără „1 ·") o încalcă.
  const fals = [...'<h2>2 · Verifică</h2>'.matchAll(/<h[1-4][^>]*>\s*(\d+)\s*·/g)].map((m) => Number(m[1]));
  ok('poarta chiar respinge un „pasul 2" singur', fals.length === 1 && fals[0] !== 1);
}

section('Adaugă document este un workbench unic: Încarcă → Verifică → Postează');
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(PUB, 'docflow.js'), 'utf8');
  const inceput = html.indexOf('<section id="tab-documente"');
  const sfarsit = html.indexOf('<section id="tab-emite"', inceput);
  const ecran = html.slice(inceput, sfarsit);
  eq('există un singur workbench de documente', (ecran.match(/id="documentWorkbench"/g) || []).length, 1);
  const pasi = [...ecran.matchAll(/data-workbench-step="(upload|verify|post)"/g)].map((m) => m[1]);
  eq('workbench-ul expune exact ordinea Încarcă → Verifică → Postează', pasi.join(' → '), 'upload → verify → post');
  ok('doar încărcarea este vizibilă inițial', /id="documentWorkbench"[^>]*data-step="upload"/.test(ecran)
    && /id="documentReviewPane"[^>]*class="[^"]*hidden/.test(ecran));

  const pragSecundar = ecran.indexOf('<details id="documentWorkbenchMore"');
  const principal = ecran.slice(0, pragSecundar);
  const secundar = ecran.slice(pragSecundar);
  ok('meniul secundar este pliat implicit', /<details id="documentWorkbenchMore"/.test(secundar)
    && !/<details id="documentWorkbenchMore"[^>]*\bopen\b/.test(secundar));
  for (const id of ['manualBtn', 'documentAiToggle', 'scannerBtn', 'bankFile', 'inboxRefresh', 'efImportFile']) {
    ok('#' + id + ' este numai în zona secundară', !principal.includes('id="' + id + '"') && secundar.includes('id="' + id + '"'));
  }
  ok('zona principală păstrează doar uploadul și formularul unic de verificare',
    principal.includes('id="drop"') && principal.includes('id="formHostDoc"') && principal.includes('id="entryForm"'));
  ok('starea workbench-ului este legată de deschidere, postare, anulare și schimbarea firmei',
    /setDocumentWorkbenchStep\('verify'\)/.test(js) && /setDocumentWorkbenchStep\('post'\)/.test(js)
    && (js.match(/setDocumentWorkbenchStep\('upload'\)/g) || []).length >= 3
    && /contab:company-context/.test(js));
  ok('layout-ul workbench-ului se adaptează explicit pe mobil',
    /@media\(max-width:680px\)[\s\S]*\.workbench-options\{grid-template-columns:1fr/.test(css));
}

section('Selector operațiuni: căutare, recomandări, recente, favorite și scop');
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(PUB, 'docflow.js'), 'utf8');
  const catalog = (await imp(ROOT, 'src', 'documentTypes', 'index.js')).default.TYPES;

  ok('catalogul mare chiar este în perimetrul controlului', catalog.length >= 137);
  eq('normalizarea caută la fel cu și fără diacritice',
    docflow.normalizeOperationQuery('  Încasări / PLĂȚI  '), 'incasari plati');
  const dupaNume = docflow.filterOperationTypes(catalog, 'factura servicii primita');
  ok('căutarea găsește după denumirea operațiunii', dupaNume.some((type) => type.id === 'factura_servicii_primita'));
  const dupaScop = docflow.filterOperationTypes(catalog, 'vanzari clienti');
  ok('căutarea găsește și după scop, nu numai după denumire',
    dupaScop.some((type) => type.id === 'factura_vanzare_marfuri'));
  const grupuri = docflow.groupOperationTypes(catalog);
  eq('gruparea nu pierde operațiuni', grupuri.reduce((sum, group) => sum + group.types.length, 0), catalog.length);
  ok('grupul tehnic este prezentat ca scop pentru utilizator',
    grupuri.some((group) => group.key === 'Vanzari' && group.label === 'Vânzări și clienți'));

  ok('controlul accesibil păstrează un singur select canonic și expune comboboxul căutabil',
    (html.match(/id="tipSelect"/g) || []).length === 1
      && /id="operationTypeSearch"[^>]*role="combobox"/.test(html)
      && /aria-controls="operationTypeResults"/.test(html));
  ok('recomandările, favoritele și recentele sunt funcții reale, nu doar etichete',
    /OPERATION_RECOMMENDATIONS/.test(js) && /toggleFavoriteOperation/.test(js)
      && /rememberOperationType\(payload\.tip\)/.test(js) && /OPERATION_RECENT_LIMIT = 6/.test(js));
  ok('rezultatele complete și cele filtrate folosesc aceeași grupare după scop',
    (js.match(/operationGroupedSection\(/g) || []).length >= 3 && /groupOperationTypes\(types\)/.test(js));
  ok('lista lungă are limită de înălțime și derulare proprie inclusiv pe mobil',
    /\.operation-type-results\{[^}]*max-height:[^}]*overflow:auto/.test(css)
      && /@media\(max-width:680px\)[\s\S]*\.operation-type-results\{max-height:48vh/.test(css));
}

section('Pagina nu derulează pe orizontală: convenția tabelelor ține la orice lățime');
{
  // Convenția repo-ului („tabelele late derulează în propriul container, pagina rămâne fixă") era
  // scrisă DOAR în blocul `@media(max-width:700px)`. Pe desktop nu o apăra nimic, iar celulele sunt
  // `white-space:nowrap` GLOBAL — deci un singur `<td>` cu o frază lungă lățea tabelul, cardul,
  // grila și pagina. Măsurat pe producție: +822px pe „Declarații", +39px pe „Situații". Poarta ține
  // regulile în afara oricărui `@media`, fiindcă acolo au fost ascunse ultima dată.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  // Taie tot ce e în interiorul blocurilor @media, ca să rămână doar regulile necondiționate.
  const faraMedia = (() => {
    let out = ''; let i = 0;
    while (i < css.length) {
      const m = css.indexOf('@media', i);
      if (m < 0) { out += css.slice(i); break; }
      out += css.slice(i, m);
      let j = css.indexOf('{', m); let adanc = 0;
      for (; j < css.length; j += 1) {
        if (css[j] === '{') adanc += 1;
        else if (css[j] === '}') { adanc -= 1; if (adanc === 0) { j += 1; break; } }
      }
      i = j;
    }
    return out;
  })();
  ok('poarta chiar a scos blocurile @media', faraMedia.length < css.length && !faraMedia.includes('@media'));
  ok('tabelele derulează în ele însele, la orice lățime', /\.tab table\{display:block;overflow-x:auto;max-width:100%\}/.test(faraMedia));
  ok('itemele de grilă se pot strânge sub conținut', /\.grid2>\*,\.grid3>\*\{min-width:0\}/.test(faraMedia));
  // Celulele sunt nowrap — de aceea regula de mai sus e necesară, nu decorativă. Dacă cineva scoate
  // `nowrap`, poarta rămâne validă, dar comentariul care o explică ar deveni fals: se semnalează.
  ok('celulele chiar sunt `nowrap` (motivul pentru care regula e necesară)', /th,td\{[^}]*white-space:nowrap/.test(faraMedia));
  // Bula de ajutor de pe ultimul card al unei grile se ancorează la dreapta, ca să nu iasă din ecran.
  ok('bula de ajutor din ultima coloană nu mai iese din ecran', /\.grid2>\*:last-child h3 \.cinfo \.cpop/.test(css));

  // A doua cauză, la lățimi de tabletă: bara de unelte a unui ecran (titlu + selectoare + butoane)
  // nu se rupea decât sub 700px. Indiferent de carcasa din jur, o bară care nu se rupe depășește
  // garantat la o lățime suficient de mică.
  ok('bara de unelte se rupe pe rând nou la orice lățime', /\.toolbar\{display:flex;flex-wrap:wrap/.test(faraMedia));

  // A treia: bulele de ajutor stau și în mijlocul formularelor, unde nicio regulă STRUCTURALĂ nu le
  // poate prinde (ancorarea de mai sus acoperă doar ultima coloană a unei grile). Coloana de
  // conținut le taie, ca o decorațiune absolută să nu poată împinge pagina.
  // `clip`, NU `hidden`: `hidden` ar face din `main` un container de derulare și ar schimba
  // comportamentul elementelor sticky. Layout-ul autentificat are un singur proprietar, erp.css.
  const erpCss = fs.readFileSync(path.join(ROOT, 'public', 'erp.css'), 'utf8');
  ok('coloana de conținut taie decorațiunile care ar împinge pagina',
    /body\.erp \.shell > main\s*\{[^}]*overflow-x:\s*clip/.test(erpCss));
  ok('...cu `clip`, nu `hidden` (altfel elementele sticky s-ar rupe)',
    !/body\.erp \.shell > main\s*\{[^}]*overflow-x:\s*hidden/.test(erpCss));
}

section('Accesibilitate: contrast, tabele derulabile și controale cu pictogramă');
{
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const erp = fs.readFileSync(path.join(PUB, 'erp.js'), 'utf8');
  const hex = (n) => {
    const v = n.replace('#', '');
    const rgb = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
    return rgb.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  };
  const contrast = (a, b) => {
    const la = hex(a); const lb = hex(b);
    const ya = 0.2126 * la[0] + 0.7152 * la[1] + 0.0722 * la[2];
    const yb = 0.2126 * lb[0] + 0.7152 * lb[1] + 0.0722 * lb[2];
    return (Math.max(ya, yb) + 0.05) / (Math.min(ya, yb) + 0.05);
  };
  const vars = css.match(/:root\s*\{[\s\S]*?\}/)[0];
  const color = (name) => vars.match(new RegExp('--' + name + ':\\s*(#[0-9a-f]{6})', 'i'))[1];
  ok('tokenul muted trece WCAG AA pe toate suprafețele temei',
    ['bg', 'card', 'soft', 'soft2', 'line'].every((fundal) => contrast(color('muted'), color(fundal)) >= 4.5)
      && !/\.zero\{[^}]*opacity:/.test(css));
  ok('numai containerul care chiar derulează intră în ordinea de tab',
    /function areContinutOrizontalAscuns\(/.test(erp)
      && /setAttribute\('tabindex', '0'\)/.test(erp)
      && /removeAttribute\('tabindex'\)/.test(erp)
      && /container === wrap/.test(erp)
      && /attributeFilter: \['class', 'data-mobile-columns'\]/.test(erp));
  ok('focusul containerului derulabil rămâne vizibil în interiorul zonei cu overflow',
    /\.scroll-focus:focus-visible\{outline:3px solid #1769aa;outline-offset:-3px/.test(css));
  ok('regiunea derulabilă primește un nume și păstrează semantica nativă a tabelului',
    /Folosește tastele săgeată pentru detalii/.test(erp)
      && /nod !== tabel && !nod\.hasAttribute\('role'\)/.test(erp));
  ok('controalele numai cu pictogramă primesc o etichetă explicită după conversia SVG',
    /function eticheteazaControlPictograma\(/.test(erp)
      && /nod\.setAttribute\('aria-label', trad\(eticheta\)\)/.test(erp)
      && /eticheteazaControlPictograma\(nod, simbol, nume\)/.test(erp));
}

section('Scanerul local: oprit înseamnă ascuns, nu gri');
{
  // Butonul „🖨️ Scanează (scaner local)" stătea `disabled` în cardul PRINCIPAL de încărcare, iar
  // sub el un panou de configurare `.inactiv` explica pe larg cum se instalează o punte care
  // oricum nu putea fi pornită. Un buton gri pe care apeși și nu se întâmplă nimic citește a
  // DEFECT, nu a funcție indisponibilă — și stătea exact acolo unde omul caută ce să facă.
  //
  // Poarta leagă cele două jumătăți în AMBELE sensuri, pe modelul celei de la 2FA: o jumătate
  // reactivată fără cealaltă e chiar felul în care se ajunge înapoi la UI mort.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const src = fs.readFileSync(path.join(PUB, 'docflow.js'), 'utf8');
  const buton = (html.match(/<button id="scannerBtn"[^>]*>/) || [''])[0];
  ok('poarta chiar găsește butonul de scanare', buton !== '');
  const oprit = /\bdisabled\b/.test(buton);
  ok('panoul de configurare a scanerului există în pagină', html.includes('id="scanSetup"'));

  // Invariantul care ține INDIFERENT de stare, și tocmai de aceea e cel bun: ascunderea se derivă
  // din `disabled`-ul butonului, nu dintr-un `hidden` scris de mână în HTML. Așa cele două jumătăți
  // nu POT drifta — pornirea și oprirea rămân o singură editare, un singur atribut. O poartă care
  // ar cere sincronizare manuală ar fi doar un al doilea loc de ținut minte.
  ok('ascunderea e condiționată de chiar `disabled`-ul butonului', /#scannerBtn'\)\.disabled/.test(src));
  ok('...și ascunde rândul butonului', /scannerBtn'\)\.closest\('\.row'\)[\s\S]{0,80}add\('hidden'\)/.test(src));
  ok('...și panoul de configurare odată cu el', /#scanSetup'\)[\s\S]{0,60}add\('hidden'\)/.test(src));
  ok('panoul nu e marcat inactiv din HTML (starea vine dintr-un singur loc)', !/id="scanSetup"[^>]*\binactiv\b/.test(html));

  // A treia jumătate: pagina de ajutor din „Conexiuni" descrie starea funcției. Ea a spus o dată
  // „butonul … este dezactivat" — adevărat cât timp butonul era gri, fals de când e ascuns, deci
  // trimitea omul să caute ceva ce nu mai apare. Acum trebuie să urmeze starea reală.
  // Comentariile HTML se scot ÎNAINTE de scanare: poarta e despre ce citește utilizatorul, nu
  // despre ce scrie în sursă. Prima formă a picat pe propriul ei comentariu explicativ — o poartă
  // care se autodeclanșează e la fel de inutilă ca una care nu se declanșează niciodată.
  const faraComentarii = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const ajutor = (faraComentarii.match(/<div class="card howto">\s*<h2>🖨️[\s\S]*?<h3>/) || [''])[0];
  ok('poarta chiar găsește pagina de ajutor a scanerului', ajutor !== '');
  ok('poarta chiar ignoră comentariile', !faraComentarii.includes('poarta din'));
  if (oprit) {
    ok('oprit → utilizatorului i se spune de ce, dacă ajunge la buton', /momentan indisponibil/i.test(buton));
    ok('oprit → ajutorul anunță că e oprită', /indisponibil/i.test(ajutor));
  } else {
    ok('pornit → titlul butonului nu mai spune că e indisponibil', !/indisponibil/i.test(buton));
    ok('pornit → ajutorul nu mai anunță indisponibilitate', !/indisponibil/i.test(ajutor));
  }
  // Poarta trebuie să POATĂ distinge cele două stări, altfel ramura de mai sus e decorativă.
  ok('poarta chiar distinge butonul oprit de cel pornit',
    /\bdisabled\b/.test('<button id="scannerBtn" class="btn" disabled>') && !/\bdisabled\b/.test('<button id="scannerBtn" class="btn">'));
}

section('Uneltele globale: în navigatorul unic, fără panou separat');
{
  // Cele mai folosite cinci utilitare stau direct după Acasă; restul rămân în grupul Unelte.
  // Același arbore devine sertar pe mobil; bara contextuală rămâne strict pentru pagină,
  // firmă și perioadă.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const cap = html.indexOf('<header class="topbar">');
  const meniu = html.indexOf('<nav class="tabs"', cap);
  ok('poarta chiar găsește bara de sus', cap >= 0 && meniu > cap);
  const navigator = html.slice(meniu, html.indexOf('</nav>', meniu));
  const dupaAcasa = (navigator.match(/data-tab="dashboard"[^>]*>[\s\S]*?<\/button>([\s\S]*?)<button data-tab="notificari"/) || ['', ''])[1];
  const iduriDirecte = [...dupaAcasa.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  eq('după Acasă urmează exact Ghid, Caută, Temă, Expert și Dicționar', iduriDirecte.join(','),
    'toolGhid,paletaBtn,themeBtn,uiModeBtn,glossaryBtn');
  ok('cele patru comenzi fără pagină sunt acțiuni directe ale navigatorului',
    (dupaAcasa.match(/class="nav-action"/g) || []).length === 4);
  const unelte = (navigator.match(/<div class="navgroup" id="navgrupUnelte">[\s\S]*?<div class="navmenu" id="sideTools">([\s\S]*?)<\/div>\s*<\/div>/) || ['', ''])[1];
  ok('Unelte este un grup al navigatorului principal', unelte !== '' && /\ud83e\uddf0 Unelte/.test(navigator));
  const iduriUnelte = [...unelte.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  eq('Cartea, Mesaje, Densitate și Tur rămân în dropdownul Unelte', iduriUnelte.join(','),
    'toolMesaje,densityBtn,tourBtn');
  ok('Cartea este în același dropdown și rămâne legătură în filă nouă',
    /id="toolCartea"[^>]*target="_blank"[^>]*rel="noopener"/.test(unelte));
  ok('Ghid este direct, iar Cartea și Mesaje rămân în submeniul navigatorului',
    /data-tab="ghid"/.test(dupaAcasa) && /data-tab="mesaje"/.test(unelte) && /href="\/carte\/"/.test(unelte));
  ok('Portofoliu a dispărut numai din navigator',
    !/data-tab="portofoliu"/.test(navigator) && html.includes('id="tab-portofoliu"'));
  ok('vechiul panou și butoanele lui intermediare au dispărut',
    !/<nav class="side-tools"/.test(html) && !/id="(?:toolsBtn|moreToolsBtn)"/.test(html));

  const bara = html.slice(cap, meniu);
  const PERMISE = new Set(['prevMonth', 'currentPeriod', 'nextMonth', 'globalPeriodCurrent', 'navToggleBtn', 'logoutBtn', 'imperStop']);
  const inBara = [...bara.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  const intruse = inBara.filter((id) => !PERMISE.has(id));
  ok('primul rând al antetului păstrează doar navigarea, ieșirea și revenirea din impersonare'
    + (intruse.length ? ' — NEAȘTEPTATE: ' + intruse.join(', ') : ''), intruse.length === 0);
  ok('poarta chiar vede butoane (nu o listă goală)', inBara.length >= 3);

  // Navigația nu se rescrie pentru telefon: același #tabs se deschide ca sertar.
  ok('butonul „Meniu" comandă arborele real', /id="navToggleBtn"[^>]*aria-controls="tabs"/.test(html));
  ok('sertarul mobil se deschide numai pe clasa de stare a barei', /\.topbar\.nav-open #tabs/.test(fs.readFileSync(path.join(PUB, 'erp.css'), 'utf8')));
  ok('navigația mobilă paralelă a fost eliminată', !/bottomnav|moreSheet|moreBtn|data-tabs=/.test(html));
  const erpCssMobil = fs.readFileSync(path.join(PUB, 'erp.css'), 'utf8');
  ok('titlul și etapa paginii rămân vizibile pe telefon',
    !/body\.erp \.app-context-title\s*\{\s*display:\s*none/.test(erpCssMobil)
    && /body\.erp #appContextTitle\s*\{\s*font-size:\s*17px/.test(erpCssMobil));
  ok('la 320px firma și perioada se așază pe rânduri lizibile',
    /@media \(max-width: 360px\)[\s\S]{0,260}\.app-context-controls\s*\{\s*grid-template-columns:\s*minmax\(0,1fr\)/.test(erpCssMobil));
  ok('ieșirea rămâne accesibilă direct în bara mobilă',
    /@media \(max-width: 700px\)[\s\S]*body\.erp \.topbar #logoutBtn\s*\{\s*order:\s*3;\s*width:\s*auto/.test(erpCssMobil));

  // Bara contextuală nu mai preia uneltele; ele rămân în navigator, o singură dată.
  const erp = fs.readFileSync(path.join(PUB, 'erp.js'), 'utf8');
  ok('antetul contextual nu mută și nu clonează grupul Unelte',
    !/appendChild\(unelte\)|#appContext #sideTools|cloneNode/.test(erp));
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  ok('dropdownul stilizează atât butoanele, cât și legătura Cărții',
    /#tabs \.navmenu button:not\(\.hidden\),\s*\nbody\.erp #tabs \.navmenu a\.navlink:not\(\.hidden\)/.test(erpCssMobil));
  ok('acțiunile directe au același stil desktop și mobil ca destinațiile',
    /#tabs > button\.nav-action:not\(\.hidden\)/.test(erpCssMobil)
      && /\.topbar\.nav-open #tabs > button\.nav-action:not\(\.hidden\)/.test(erpCssMobil));
  ok('pe mobil alegerea unei acțiuni directe închide sertarul',
    /button\[data-tab\], button\.nav-action, a\.navlink/.test(erp));
  ok('panoul Unelte nu mai are reguli CSS desktop sau mobil',
    !/side-tools|tools-open|more-tools-btn/.test(erpCssMobil + css));
  const js = fs.readFileSync(path.join(PUB, 'simplemode.js'), 'utf8');
  ok('modul simplu și shell-ul nu dublează logica meniului mobil', !/tools-open|inchideUnelte|#toolsBtn/.test(js + erp));
  const app = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  ok('navigarea logică are un singur selector pentru toate destinațiile',
    /NAV_TAB_SELECTOR = '#tabs button\[data-tab\]'/.test(app));
  ok('titlul, perioada și căutarea citesc exclusiv navigatorul unic',
    !/#tabs button\[data-tab\][^'"\n]*, #sideTools/.test(erp + app
      + fs.readFileSync(path.join(PUB, 'periods.js'), 'utf8')
      + fs.readFileSync(path.join(PUB, 'paleta.js'), 'utf8')));
}

section('Carcasa aplicației: o singură navigație și context unic');
{
  // #sideTools este un submeniu din #tabs, fără destinații duplicate. Bara contextuală
  // mută doar controalele reale pentru firmă/perioadă; nu le clonează și nu generează altele.
  const erp = fs.readFileSync(path.join(PUB, 'erp.js'), 'utf8');
  ok('nu se mai construiește un meniu superior duplicat', !/construiesteMeniu|id\s*=\s*['"]erpMenu/.test(erp));
  ok('nu se mai construiește un ribbon duplicat', !/construiesteUnelte|id\s*=\s*['"]erpTools/.test(erp));
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  const erpCssTop = fs.readFileSync(path.join(PUB, 'erp.css'), 'utf8');
  ok('desktopul rezervă o singură coloană laterală pliabilă',
    /--app-sidebar-open:\s*260px/.test(erpCssTop)
      && /--app-sidebar-closed:\s*72px/.test(erpCssTop)
      && /body\.erp\.sidebar-collapsed\s*\{\s*--app-sidebar-w:/.test(erpCssTop));
  ok('antetul este plafonat la 64px, iar arborele unic este vertical și fix',
    /--app-header-h:\s*64px/.test(erpCssTop)
      && /body\.erp \.topbar\s*\{[^}]*max-height:\s*var\(--app-header-h\)/.test(erpCssTop)
      && /body\.erp \.topbar #tabs\s*\{[^}]*position:\s*fixed[^}]*flex-direction:\s*column/.test(erpCssTop));
  ok('submeniurile desktop sunt acordeoane în navigatorul lateral',
    /body\.erp #tabs \.navmenu\s*\{[^}]*position:\s*static\s*!important/.test(erpCssTop)
      && /#tabs \.navgroup\.open > \.navmenu:not\(\.hidden\)\s*\{\s*display:\s*block\s*!important/.test(erpCssTop));
  ok('telefonul readuce același meniu în sertar vertical',
    /\.topbar\.nav-open #tabs\s*\{[^}]*flex-direction:\s*column/.test(erpCssTop)
      && /\.topbar\.nav-open #tabs \.navmenu\s*\{[^}]*position:\s*static\s*!important/.test(erpCssTop));
  const eticheteMeniu = [...html.matchAll(/<button[^>]*data-tab="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)]
    .map((m) => ({ tab: m[1], text: m[2].replace(/<[^>]+>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() }));
  const faraNume = eticheteMeniu.filter((x) => !/\p{L}/u.test(x.text));
  ok('fiecare destinație din meniu are etichetă textuală, nu doar pictogramă sau badge'
    + (faraNume.length ? ' — ' + faraNume.map((x) => x.tab).join(', ') : ''), faraNume.length === 0);
  ok('desktopul și mobilul folosesc același arbore #tabs', /id="navToggleBtn"[^>]*aria-controls="tabs"/.test(html)
    && /function monteazaNavigatiaMobila\(/.test(erp));
  ok('nu mai există cod pentru bara mobilă și panoul ei paralel', !/bottomnav|moreSheet|updateBottomNav|closeMore/.test(html + app + erp));
  ok('ciclul contabil nu mai injectează o a doua navigație', !/cyclemap|cyclestep|cyclearrow/.test(html + app));
  // Clasificarea ecranului e o singura metadata (`data-kicker`), pusa intr-un singur loc din
  // app.js si derivata din pasii inchiderii; erp.js doar o afiseaza.
  ok('clasificarea ecranului e metadata pe butoanele navigației reale', /dataset\.kicker = text/.test(app)
    && /marcheazaHartaLunii\(\)/.test(app));
  ok('pașii lunii, înregistrarea și consultarea sunt numite distinct',
    /Închiderea lunii · pasul/.test(app) && /'Înregistrare'/.test(app) && /'Consultare'/.test(app));
  ok('bara contextuală afișează clasificarea fără să creeze destinații', /dataset\.kicker/.test(erp)
    && /contab:cycle-ready/.test(erp));
  // Registrele late: erp.js marcheaza containerul, CSS-ul pune umbra. Efectul pe DOM real
  // (apare, dispare la capat, lipseste cand tabelul incape) se dovedeste in E2E, sectiunea 15 —
  // o poarta pe sursa singura ar spune doar ca s-a scris codul, nu ca se si vede.
  ok('registrele late sunt marcate cand au continut ascuns',
    /function areDerulareOrizontala\(/.test(erp) && /marcheazaTabeleDerulabile\(\)/.test(erp));
  ok('...iar marcajul tine cont si de cat s-a derulat deja',
    /scrollLeft \+ t\.clientWidth < t\.scrollWidth/.test(erp));
  const dsIndiciu = fs.readFileSync(path.join(PUB, 'design-system.css'), 'utf8');
  ok('indiciul de derulare are regula proprie, pe containerul care NU deruleaza',
    /\.tablewrap\.are-derulare::after/.test(dsIndiciu) && /\.tablewrap \{ position: relative/.test(dsIndiciu));
  ok('bara contextuală este construită explicit', /function construiesteContext\(/.test(erp) && /bar\.id = 'appContext'/.test(erp));
  ok('selectorul firmei este mutat în componenta de căutare, nu clonat',
    /selectorWrap\.appendChild\(firma\)/.test(erp)
      && /firmaWrap\.appendChild\(construiesteSelectorFirma\(firma\)\)/.test(erp) && !/cloneNode/.test(erp));
  ok('selectorul perioadei este mutat, nu clonat', /perioadaWrap\.appendChild\(perioada\)/.test(erp));
  ok('firma nu mai este repetată sub logo', !/id=["']companyName["']/.test(html)
    && !/\$\('#companyName'\)/.test(app));
  ok('selectorul unic are căutare după denumire și CUI, inclusiv fără diacritice',
    /function construiesteSelectorFirma\(firma\)/.test(erp)
      && /opt\.dataset\.companyName/.test(erp) && /opt\.dataset\.companyCui/.test(erp)
      && /normalize\('NFD'\)/.test(erp) && /companyPickerSearchButton/.test(erp));
  ok('alegerea din căutare folosește același eveniment de schimbare și aceeași activare persistentă',
    /firma\.dispatchEvent\(new Event\('change'/.test(erp)
      && /api\('\/api\/firme\/' \+ id \+ '\/activate'/.test(app));
  ok('pictogramele aplicației sunt un singur set SVG', /var ICONS = \{/.test(erp) && /<svg viewBox=/.test(erp));
  ok('setul SVG acoperă și controalele, linkurile și secțiunile extensibile',
    /'button', 'a', 'summary', 'label\.attach-btn', '\.emit-guided \.gt'/.test(erp));
  ok('o componentă cu pictogramă semantică proprie nu primește încă una din destinație',
    /querySelector\(':scope > \.ic, :scope > \.al-ic/.test(erp));
  ok('un simbol este scos din text numai după găsirea unui SVG echivalent',
    /if \(simbol\) return SYMBOL_ICONS\[simbol\] \|\| ''/.test(erp)
      && /if \(!nume\) \{[\s\S]{0,180}return;\s*\}[\s\S]{0,100}info\.nod\.nodeValue/.test(erp));
  ok('pictograma își păstrează identitatea și poate fi actualizată la schimbarea etichetei',
    /s\.dataset\.icon = name/.test(erp) && /existent\.dataset\.icon !== nume/.test(erp));

  // Modul simplu are acum un singur loc de protejat: arborele lateral real, în proprietarul
  // shell-ului. styles.css poate ascunde generic `.adv`, dar nu mai definește navigația.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const erpCss = fs.readFileSync(path.join(ROOT, 'public', 'erp.css'), 'utf8');
  ok('grupurile marcate se ascund și peste specificitatea barei laterale',
    /body\.erp\.simple-ui #tabs \.navgroup\.adv\s*\{\s*display:\s*none\s*!important/.test(erpCss));
  ok('...și intrările marcate individual, din grupuri nemarcate',
    /body\.erp\.simple-ui #tabs \.navmenu button\.adv\s*\{\s*display:\s*none\s*!important/.test(erpCss));
  const shellVechi = [
    /(^|[},])\s*\.shell\s*\{/m,
    /(^|[},])\s*\.topbar(?:\s|[.{:#>])/m,
    /(^|[},])\s*#tabs(?:\s|[.{:#>])/m,
    /(^|[},])\s*\.tabs(?:\s|[.{:#>])/m,
    /(^|[},])\s*\.nav(?:group|menu|hint)(?:\s|[.{:#>])/m,
    /(^|[},])\s*\.(?:firma-select|curgroup|curperiod|curnav|userbadge)(?:\s|[.{:#>])/m,
    /(^|[},])\s*main\s*\{/m
  ];
  ok('styles.css nu mai redefinește carcasa autentificată', shellVechi.every((re) => !re.test(css)));
  // Eticheta e „NUME (CUI)" + marcajul de abonament: depaseste latimea la orice nume realist,
  // iar un `select` nativ marginit taie BRUT — pe capturi iesea o paranteza suspendata.
  const regulaFirma = (erpCss.match(/body\.erp \.app-context \.firma-select \{[^}]*\}/) || [''])[0]
    .replace(/\/\*[\s\S]*?\*\//g, ''); // comentariile din regulă conțin ele însele „width"
  ok('selectorul de firmă taie cu puncte de suspensie, nu brut',
    /text-overflow:\s*ellipsis/.test(regulaFirma));
  const latime = (regulaFirma.match(/(?:^|[;{])\s*width:\s*(\d+)px/) || [])[1];
  const latimeMax = (regulaFirma.match(/max-width:\s*(\d+)px/) || [])[1];
  ok('lățimea selectorului nu se contrazice cu propriul plafon',
    !!latime && !!latimeMax && Number(latime) <= Number(latimeMax));
  ok('regulile responsive ale carcasei au un singur proprietar',
    /@media \(max-width: 700px\)[\s\S]*body\.erp \.topbar/.test(erpCss)
      && !/@media\s*\(max-width:\s*700px\)[\s\S]{0,900}(?:\.topbar|\.shell|#tabs)/.test(css));
}

section('Design system și fluxuri reutilizabile pentru formularele lungi');
{
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const flowSrc = fs.readFileSync(path.join(PUB, 'formflow.js'), 'utf8');
  const authSrc = fs.readFileSync(path.join(PUB, 'authui.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  const erpCss = fs.readFileSync(path.join(PUB, 'erp.css'), 'utf8');
  const dsCss = fs.readFileSync(path.join(PUB, 'design-system.css'), 'utf8');
  ok('pictograma contextuală își păstrează dimensiunea shell-ului compact', /\.app-context-icon\s*\{[\s\S]{0,180}display: inline-grid/.test(dsCss)
    && !/\.app-icon,\s*\nbody\.erp \.app-context-icon\s*\{/.test(dsCss)
    && /\.app-context-icon\s*\{[\s\S]{0,120}width: 36px/.test(erpCss));
  ok('alertele își mută acțiunea sub mesaj la 320px',
    /@media \(max-width: 360px\)[\s\S]{0,520}\.alert > \.al-cta\s*\{\s*grid-column:\s*2/.test(dsCss));
  const formBlock = (id) => {
    const start = html.indexOf('id="' + id + '"');
    const end = html.indexOf('</form>', start);
    return start >= 0 && end >= 0 ? html.slice(start, end) : '';
  };
  const stepCount = (id) => 1 + (formBlock(id).match(/\bsect-form\b/g) || []).length;

  eq('firma are patru pași logici', stepCount('companyForm'), 4);
  const blocFirma = formBlock('companyForm');
  const inceputAvansat = blocFirma.indexOf('Configurare avansată pentru contabil');
  const bazaFirma = blocFirma.slice(0, inceputAvansat);
  const avansatFirma = blocFirma.slice(inceputAvansat, blocFirma.indexOf('Situații financiare anuale', inceputAvansat));
  ok('primul pas al firmei este traseul scurt CUI → confirmare → două întrebări',
    inceputAvansat > 0
      && ['data-quick-step="1"', 'data-quick-step="2"', 'data-quick-step="3"', 'id="companyQuickSave"']
        .every((text) => bazaFirma.includes(text))
      && bazaFirma.indexOf('name="cui"') < bazaFirma.indexOf('name="nume"')
      && /<select name="tvaPlatitor">[\s\S]*value="false"[\s\S]*value="true"/.test(bazaFirma));
  ok('regimurile TVA rare stau numai în configurarea avansată pentru contabil',
    ['tvaLaIncasare', 'tvaArt317', 'tvaCodAnulat', 'dataAnulareTva', 'proRataTva', 'd406Cadenta']
      .every((name) => avansatFirma.includes('name="' + name + '"'))
      && !bazaFirma.includes('name="tvaLaIncasare"')
      && !bazaFirma.includes('name="tvaCodAnulat"'));
  ok('salvarea de bază validează identitatea și revine la Acasă, fără a forța pasul avansat',
    /function campuriFirmaBazaLipsa\(/.test(appSrc)
      && /e\.submitter\.id === 'companyQuickSave'/.test(appSrc)
      && /if \(quick\)[\s\S]{0,260}goTab\('dashboard'\)/.test(appSrc)
      && /#companyForm > \.form-step\[data-step-index="0"\][^{]*\.form-step-actions\s*\{\s*display:\s*none/.test(dsCss));
  ok('progresul configurării firmei măsoară traseul de bază, nu datele contabile opționale',
    /progressFields:\s*\(form\)\s*=>\s*\['nume',[\s\S]{0,360}\['regimImpozit'\][\s\S]{0,80}\.map/.test(appSrc)
      && !/progressFields:\s*\(form\)\s*=>[\s\S]{0,500}'categorieRaportare'/.test(appSrc));
  ok('alegerea TVA din formularul firmei este explicită și ajunge ca boolean la API',
    /function firmaPlatitoareTva\([\s\S]{0,180}value\) === 'true'/.test(appSrc)
      && /tvaPlatitor:\s*firmaPlatitoareTva\(f\)/.test(appSrc)
      && !/f\.tvaPlatitor\.checked/.test(appSrc));
  eq('angajatul are cinci pași logici, fără pas gol pentru buton', stepCount('angajatForm'), 5);
  eq('documentul separă datele de verificare/salvare', stepCount('entryForm'), 2);
  eq('mijlocul fix are identificare, amortizare și punere în funcțiune', stepCount('assetForm'), 3);
  eq('contractul de leasing are contract, finanțare și costuri', stepCount('lcForm'), 3);
  eq('mișcarea de stoc separă operațiunea, gestiunile și cantitatea', stepCount('movementForm'), 3);
  eq('partenerul separă identificarea de adresa documentelor', stepCount('partnerForm'), 2);
  eq('configurația fiscală separă metadatele, contribuțiile, taxele, plafoanele și salariile', stepCount('fiscalForm'), 5);
  eq('factura recurentă separă partenerul, valoarea și calendarul', stepCount('recForm'), 3);
  eq('seriile separă recepția/consumul de livrare/încasare', stepCount('docSeriesForm'), 2);
  eq('producția separă produsul, costul și materialele', stepCount('prodForm'), 3);
  eq('rețeta separă produsul, baza de cost și materialele', stepCount('recipeForm'), 3);
  eq('produsul separă identificarea de clasificarea în stoc', stepCount('productForm'), 2);
  eq('exigibilitatea separă operațiunea de referința documentului', stepCount('exigForm'), 2);
  eq('soldul analitic separă partenerul de valorile de deschidere', stepCount('oaForm'), 2);
  eq('modernizarea separă valoarea de documentarea investiției', stepCount('mfInvForm'), 2);
  eq('simulatorul separă finanțarea de dobândă și metodă', stepCount('lsForm'), 2);
  eq('profilul separă identificarea de datele profesionale și personale', stepCount('profileForm'), 2);

  for (const [file, formId] of [['app.js', 'companyForm'], ['salarizare.js', 'angajatForm'],
    ['docflow.js', 'entryForm'], ['mijloace.js', 'assetForm'], ['mijloace.js', 'lcForm'],
    ['stocuri.js', 'movementForm'], ['partners.js', 'partnerForm'], ['settings.js', 'fiscalForm'],
    ['docflow.js', 'recForm'], ['stocuri.js', 'docSeriesForm'], ['stocuri.js', 'prodForm'],
    ['stocuri.js', 'recipeForm'], ['stocuri.js', 'productForm']]) {
    const src = fs.readFileSync(path.join(PUB, file), 'utf8');
    ok(file + ' înregistrează ' + formId + ' în componenta comună',
      new RegExp("registerFormFlow\\(\\{[\\s\\S]{0,220}form: '#" + formId + "'").test(src));
  }
  for (const [file, formId] of [['rapoarte.js', 'exigForm'], ['livrabile.js', 'oaForm'],
    ['mijloace.js', 'mfInvForm'], ['mijloace.js', 'lsForm']]) {
    const src = fs.readFileSync(path.join(PUB, file), 'utf8');
    ok(file + ' înregistrează ' + formId + ' în componenta comună',
      new RegExp("registerFormFlow\\(\\{[\\s\\S]{0,220}form: '#" + formId + "'").test(src));
  }

  eq('cheia ciornei izolează formularul, firma, utilizatorul și entitatea',
    formflow.draftStorageKey('angajatForm', 17, 'angajat:a-1', 'u-3'),
    'contab:form-draft:v1:angajatForm:17:u-3:angajat%3Aa-1');
  // sessionStorage supravietuieste delogarii (logout = reload, nu inchiderea tabului): fara
  // utilizator in cheie, ciorna lui A s-ar restaura lui B pe aceeasi statie si aceeasi firma.
  ok('doi utilizatori pe aceeași firmă și același formular NU împart ciorna',
    formflow.draftStorageKey('angajatForm', 17, 'nou', 'u-3')
      !== formflow.draftStorageKey('angajatForm', 17, 'nou', 'u-4'));
  eq('utilizatorul lipsă are propriul segment, nu unul absent',
    formflow.draftStorageKey('angajatForm', 17, 'nou'),
    'contab:form-draft:v1:angajatForm:17:anonim:nou');
  sessionStorage.setItem(formflow.draftStorageKey('angajatForm', 17, 'nou', 'u-3'), '{"version":1}');
  sessionStorage.setItem('contab:altceva', 'pastreaza-ma');
  eq('delogarea șterge ciornele de formular', formflow.clearFormFlowDrafts(), 1);
  eq('...și numai pe ele', sessionStorage.getItem('contab:altceva'), 'pastreaza-ma');
  ok('parola nu ajunge niciodată în ciornă (autosave-ul e pornit implicit)',
    /'file', 'submit', 'button', 'reset', 'password'/.test(flowSrc));
  ok('delogarea golește ciornele înainte de reîncărcare',
    /clearFormFlowDrafts\(\);[\s\S]{0,120}location\.reload\(\)/.test(authSrc));
  ok('ciornele se leagă de contul curent la pornire',
    /setFormFlowUser\(META\.user && META\.user\.id\)/.test(appSrc));
  eq('progresul rotunjește procentul din câmpurile completate', formflow.completionPercent([true, true, false]), 67);
  eq('formular fără câmpuri are progres zero', formflow.completionPercent([]), 0);
  ok('identitatea formularului citește atributul, imună la un control `name="id"`',
    /getAttribute\('id'\)/.test(flowSrc) && !/draftStorageKey\(form\.id/.test(flowSrc));
  ok('autosave-ul este local pe tab, nu un API mascat', /sessionStorage\.setItem/.test(flowSrc)
    && !/\b(?:fetch|api)\s*\(/.test(flowSrc));
  ok('componenta expune explicit ciclul flush / loaded / saved / discard',
    ['formFlowFlush', 'formFlowLoaded', 'formFlowSaved', 'formFlowDiscard'].every((name) => flowSrc.includes('function ' + name)));
  ok('ciorna are control vizibil de ștergere și confirmare în dialog propriu',
    /form-draft-discard/.test(flowSrc) && /confirmAction/.test(flowSrc) && !/\bconfirm\s*\(/.test(flowSrc));
  ok('pașii semnalizează distinct completarea și erorile',
    /form-step-state/.test(flowSrc) && /has-error/.test(flowSrc)
      && /\.form-step\.has-error/.test(dsCss) && /\.form-step-state\.is-error/.test(dsCss));
  ok('pașii fără `required` folosesc câmpurile urmărite pentru starea „Complet”',
    /const tracked = new Set\(controls\)/.test(flowSrc)
      && /const completionControls = required\.length \? required : followed/.test(flowSrc));
  ok('componenta poate păstra pașii fără a stoca local formularele sensibile',
    /const autosaveEnabled = config\.autosave !== false/.test(flowSrc)
      && /if \(!autosaveEnabled\) return false/.test(flowSrc));
  const mijloaceSrc = fs.readFileSync(path.join(PUB, 'mijloace.js'), 'utf8');
  ok('editarea leasingului schimbă explicit ciorna de la „nou” la contractul ales',
    /formFlowFlush\(f\)[\s\S]{0,400}formFlowLoaded\(f, 'contract:' \+ c\.id\)/.test(mijloaceSrc)
      && /formFlowSaved\(f\)/.test(mijloaceSrc));
  const stocuriSrc = fs.readFileSync(path.join(PUB, 'stocuri.js'), 'utf8');
  ok('reîncărcarea opțiunilor de stoc finalizează și restaurează ciorna',
    /formFlowFlush\(\$\('#movementForm'\)\)/.test(stocuriSrc)
      && /gestiuneDestId\.innerHTML[\s\S]{0,180}formFlowLoaded\(mf, 'nou'\)/.test(stocuriSrc));
  ok('transferul cere destinație și după restaurarea ciornei',
    /gestiuneDestId\.required = isTransfer/.test(stocuriSrc)
      && /formflow:restored/.test(stocuriSrc));
  const partnersSrc = fs.readFileSync(path.join(PUB, 'partners.js'), 'utf8');
  ok('partenerii au ciorne distincte pentru creare și editare',
    /formFlowFlush\(f\)[\s\S]{0,300}formFlowLoaded\(f, 'partener:' \+ p\.cui\)/.test(partnersSrc)
      && /formFlowLoaded\(f, 'nou'/.test(partnersSrc));
  const settingsSrc = fs.readFileSync(path.join(PUB, 'settings.js'), 'utf8');
  ok('configurația fiscală are ciornă globală, independentă de firma activă',
    /form: '#fiscalForm'[\s\S]{0,180}companyKey: \(\) => 'global'/.test(settingsSrc)
      && /formFlowFlush\(f\)/.test(settingsSrc) && /formFlowSaved\(f\)/.test(settingsSrc));
  ok('profilul cu CNP folosește pașii, dar are autosave-ul local dezactivat',
    /form: '#profileForm'[\s\S]{0,180}autosave: false/.test(settingsSrc));
  // Panoul de inscriere a fost readus DELIBERAT la forma dinaintea design system-ului (cerere
  // 2026-08-17): fara pasi, fara bara de progres. Poarta de mai jos pazeste tocmai intoarcerea —
  // daca cineva ii reataseaza fluxul de formular, parola ar reintra in perimetrul autosave-ului.
  const authuiSrc = fs.readFileSync(path.join(PUB, 'authui.js'), 'utf8');
  ok('înscrierea publică NU trece prin fluxul de formular (formă clasică, cerută explicit)',
    !/registerFormFlow\(\{[\s\S]{0,220}form: '#registerForm'/.test(authuiSrc));
  // Blocul se EXTRAGE, nu se potrivește lacom: un `sect-form` pus la începutul formularului e la
  // mii de caractere de `</form>`, deci o ancoră „marcator lângă închidere" trece degeaba.
  const startReg = html.indexOf('id="registerForm"');
  const blocReg = startReg < 0 ? '' : html.slice(startReg, html.indexOf('</form>', startReg));
  ok('...iar formularul de înscriere nu poartă marcatori de pas',
    startReg > 0 && !blocReg.includes('sect-form'));
  ok('înscrierea cere explicit TVA Da/Nu, fără răspuns implicit',
    (blocReg.match(/name="tvaPlatitor"/g) || []).length === 2
      && !/name="tvaPlatitor"[^>]*checked/.test(blocReg));
  ok('emailul de recuperare este obligatoriu și listarea contabilului este opt-in',
    /name="email"[^>]*required/.test(blocReg)
      && !/name="disponibilContabil"[^>]*checked/.test(blocReg));
  const avertTest = 'Folosește doar date fictive în etapa de test.';
  ok('avertismentul despre date fictive apare înainte de login, înainte de înscriere și în aplicație',
    (html.match(new RegExp(avertTest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length >= 3
      && /data-test-stage-warning="login"/.test(html)
      && /data-test-stage-warning="register"/.test(blocReg)
      && /data-test-stage-warning="app"/.test(html));
  ok('zonele care cer documente și date salariale repetă avertismentul la locul introducerii',
    /data-test-stage-warning="upload"[\s\S]{0,420}id="drop"/.test(html)
      && /data-test-stage-warning="employee"[\s\S]{0,520}id="angajatForm"/.test(html));
  const prezentareSrc = fs.readFileSync(path.join(PUB, 'prezentare.html'), 'utf8');
  const prezentareJsSrc = fs.readFileSync(path.join(PUB, 'prezentare.js'), 'utf8');
  ok('pagina publică avertizează înainte de CTA și demo-ul nu mai promite date reale',
    prezentareSrc.indexOf(avertTest) > 0
      && prezentareSrc.indexOf(avertTest) < prezentareSrc.indexOf('class="hero"')
      && /Vezi demo cu date fictive/.test(prezentareSrc)
      && /Vezi demo cu date fictive/.test(prezentareJsSrc)
      && !/Vezi demo cu date reale/.test(prezentareSrc + prezentareJsSrc));
  ok('județul este ales după nume, nu introdus ca un cod RO-*',
    /<select name="judet">/.test(blocReg) && /value="RO-B">București/.test(blocReg));
  ok('șablonul recurent păstrează ciorna la rerandare și o elimină după salvare',
    /formFlowFlush\(form\)[\s\S]{0,380}formFlowLoaded\(form, 'nou'\)/.test(fs.readFileSync(path.join(PUB, 'docflow.js'), 'utf8'))
      && /formFlowSaved\(f\); f\.reset\(\)/.test(fs.readFileSync(path.join(PUB, 'docflow.js'), 'utf8')));
  ok('seriile restaurează ciorna peste valorile serverului și o elimină după salvare',
    /formFlowFlush\(f\)[\s\S]{0,420}formFlowLoaded\(f, 'config:serii'\)/.test(stocuriSrc)
      && /formFlowSaved\(f\); toast\('Serii salvate'\)/.test(stocuriSrc));
  ok('producția serializează și restaurează liniile dinamice de materiale',
    /function productionDraft\(form\)[\s\S]{0,700}materiale:/.test(stocuriSrc)
      && /serialize: productionDraft/.test(stocuriSrc) && /restore: restoreProductionDraft/.test(stocuriSrc));
  ok('rețetele au ciorne distincte pentru creare și fiecare entitate editată',
    /function openRecipeForm\([\s\S]{0,1200}formFlowFlush\(f\)[\s\S]{0,1200}formFlowLoaded\(f, 'reteta:' \+ recipe\.id/.test(stocuriSrc)
      && /serialize: recipeDraft/.test(stocuriSrc) && /restore: restoreRecipeDraft/.test(stocuriSrc));
  ok('schimbarea firmei golește formularele de producție înainte de restaurarea noii firme',
    /contab:company-context[\s\S]{0,320}resetProductForm\(\{ restoreDraft: false \}\)[\s\S]{0,200}resetProductionForm\(\{ restoreDraft: false \}\)[\s\S]{0,200}recipeResetForm\(\{ restoreDraft: false \}\)/.test(stocuriSrc));
  ok('modernizările au ciorne distincte pentru fiecare mijloc fix',
    /formFlowFlush\(f\)[\s\S]{0,220}formFlowLoaded\(f, 'activ:' \+ id/.test(mijloaceSrc)
      && /formFlowSaved\(f\)/.test(mijloaceSrc));
  ok('simulatorul de leasing are ciornă globală și nu o confundă cu o salvare pe server',
    /form: '#lsForm'[\s\S]{0,180}companyKey: \(\) => 'global'/.test(mijloaceSrc)
      && /formFlowFlush\(e\.target\)/.test(mijloaceSrc));

  const erpLink = html.indexOf('href="/erp.css"');
  const dsLink = html.indexOf('href="/design-system.css"');
  ok('design system-ul este încărcat după layout-ul ERP', erpLink >= 0 && dsLink > erpLink);
  ok('tokenurile și componentele reutilizabile au o singură sursă CSS',
    /--ds-control-h/.test(dsCss) && /body\.erp \.form-progress/.test(dsCss)
      && /body\.erp \.app-dialog/.test(dsCss) && /body\.erp \.context-help/.test(dsCss));
  ok('design system-ul fixează separat controalele normale și cele compacte din tabele',
    /--ds-control-min-h:\s*36px/.test(dsCss) && /--ds-control-compact-h:\s*30px/.test(dsCss)
      && /body\.erp \.tab table button/.test(dsCss) && /body\.erp \.tab \.tablewrap \.linkbtn/.test(dsCss));
  ok('pe touch toate cele trei densități urcă la ținta ergonomică de 44px',
    /--ds-touch-target:\s*44px/.test(dsCss)
      && /@media \(any-pointer: coarse\), \(hover: none\)[\s\S]*--ds-control-h: var\(--ds-touch-target\)[\s\S]*--ds-control-min-h: var\(--ds-touch-target\)[\s\S]*--ds-control-compact-h: var\(--ds-touch-target\)/.test(dsCss));
  ok('acțiunile din tabele și controalele numai cu pictogramă au 44px pe ambele axe',
    /body\.erp button\[aria-label\][\s\S]{0,150}min-width: var\(--ds-touch-target\)/.test(dsCss)
      && /body\.erp \.tab table button,[\s\S]{0,240}padding: 8px 10px/.test(dsCss));
  ok('carcasa ridică la 44px perioada și acordeoanele navigatorului pe touch',
    /@media \(any-pointer: coarse\), \(hover: none\)[\s\S]*body\.erp #tabs \.navlabel:not\(\.hidden\)[\s\S]*min-height: 44px/.test(erpCss)
      && /body\.erp \.app-context \.curnav,[\s\S]{0,180}height: 44px/.test(erpCss));
  ok('antetul touch folosește plafonul de 64px și mută sertarul la aceeași margine',
    /max-width: 700px\) and \(any-pointer: coarse\)[\s\S]*body\.erp \.topbar \{ height: 64px;[^}]*padding-block: 10px/.test(erpCss)
      && /body\.erp \.topbar\.nav-open #tabs \{ inset: 64px auto 0 0/.test(erpCss));
  ok('textul de 12 px este rezervat acțiunilor compacte, nu butoanelor normale',
    /--ds-control-font:\s*14px/.test(dsCss) && /--ds-control-compact-font:\s*12px/.test(dsCss)
      && /body\.erp \.btn\.small[^}]*var\(--ds-control-font\)/.test(dsCss));
  ok('layout-ul ERP nu mai duplică stilurile componentelor',
    !/body\.erp \.form-progress/.test(erpCss) && !/body\.erp \.app-dialog/.test(erpCss)
      && !/body\.erp \.context-help/.test(erpCss));
  const legacyCss = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectoriLegacy = [...legacyCss.matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()));
  const redefinesteFeedback = selectoriLegacy.filter((s) =>
    /^(?:body(?:\.[\w-]+)*\s+)?\.(?:alert|badge|pill)(?:$|[.:[\s>])/.test(s));
  ok('alertele, badge-urile și pastilele au o singură sursă CSS',
    redefinesteFeedback.length === 0
      && /--ds-status-warning/.test(dsCss)
      && /body\.erp \.alert\s*\{/.test(dsCss)
      && /body\.erp \.badge,\s*\nbody\.erp \.pill\s*\{/.test(dsCss));
  const surseUi = [html, ...fs.readdirSync(PUB).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(PUB, f), 'utf8'))].join('\n');
  const redefinesteNotice = selectoriLegacy.filter((s) =>
    /^(?:body(?:\.[\w-]+)*\s+)?\.(?:notice|warnbox|sub-banner|missingbox|imper-banner)(?:$|[.:[\s>])/.test(s));
  ok('mesajele persistente folosesc o singură componentă semantică în patru stări',
    redefinesteNotice.length === 0
      && !/\b(?:warnbox|sub-banner|missingbox)\b/.test(surseUi)
      && /body\.erp \.notice\.info\s*\{/.test(dsCss)
      && /body\.erp \.notice\.success\s*\{/.test(dsCss)
      && /body\.erp \.notice\.warning\s*\{/.test(dsCss)
      && /body\.erp \.notice\.danger\s*\{/.test(dsCss));
  const redefinesteFeedbackActiuni = selectoriLegacy.filter((s) =>
    /^(?:body(?:\.[\w-]+)*\s+)?(?:\.(?:status|toast|offline-banner)|#loadbar)(?:$|[.:[\s>])/.test(s));
  ok('toastul, stările inline, conexiunea și încărcarea au o singură sursă CSS',
    redefinesteFeedbackActiuni.length === 0
      && /body\.erp \.status\s*\{/.test(dsCss)
      && /body\.erp \.toast\.is-error\s*\{/.test(dsCss)
      && /body\.erp \.offline-banner\s*\{/.test(dsCss)
      && /body\.erp #loadbar\s*\{/.test(dsCss));
  const coreFeedbackSrc = fs.readFileSync(path.join(PUB, 'core.js'), 'utf8');
  ok('toasturile consecutive își anulează timerul și schimbă prioritatea accesibilă pentru erori',
    /if \(toastTimer\) clearTimeout\(toastTimer\)/.test(coreFeedbackSrc)
      && /isError \? 'alert' : 'status'/.test(coreFeedbackSrc)
      && /isError \? 'assertive' : 'polite'/.test(coreFeedbackSrc)
      && /isError \? 5200 : 3600/.test(coreFeedbackSrc));
}

section('Acțiuni importante: fără dialogurile native ale browserului');
{
  const fisiere = fs.readdirSync(PUB).filter((f) => f.endsWith('.js'));
  const native = [];
  for (const f of fisiere) {
    const src = fs.readFileSync(path.join(PUB, f), 'utf8');
    if (/\b(?:alert|confirm|prompt)\s*\(/.test(src)) native.push(f);
  }
  ok('niciun modul frontend nu mai apelează alert/confirm/prompt' + (native.length ? ': ' + native.join(', ') : ''), native.length === 0);
  const coreSrc = fs.readFileSync(path.join(PUB, 'core.js'), 'utf8');
  ok('dialogul propriu expune confirmare, introducere și informare', /export const confirmAction/.test(coreSrc) && /export const promptAction/.test(coreSrc) && /export const alertAction/.test(coreSrc));
  ok('dialogul propriu validează câmpurile obligatorii', /o\.required[\s\S]{0,180}Completează câmpul/.test(coreSrc));
}

section('Completare după CUI: nu suprascrie niciodată ce a tastat omul');
{
  // Regula întregii funcții. Un formular care îți șterge sub degete ce ai scris e mai rău decât
  // unul care nu te ajută deloc — mai ales aici, unde registrul poate avea sediul vechi de ani,
  // iar omul poate ști mai bine (denumirea comercială față de cea din registru).
  const HARTA = { nume: 'denumire', regCom: 'nrRegCom', adresa: 'adresa', oras: 'localitate', judet: 'judet' };
  const REG = { gasit: true, cui: '99887760', denumire: 'PARTENER TEST SRL', nrRegCom: 'J40/1/2020',
    adresa: 'Str. Test 1', localitate: 'Cluj-Napoca', judet: 'RO-CJ', caen: '4711', tvaPlatitor: true };

  const gol = core.campuriDeCompletat(REG, HARTA, { nume: '', regCom: '', adresa: '', oras: '', judet: '' });
  eq('formular gol: se completează tot ce are registrul', Object.keys(gol.patch).sort().join(','), 'adresa,judet,nume,oras,regCom');
  eq('...și se raportează ca atare', gol.completate.length, 5);
  eq('...fără nimic „diferit"', gol.diferite.length, 0);

  // Spațiile nu sunt conținut: un câmp cu " " e tot gol, altfel omul rămâne cu un formular
  // necompletat și fără explicație.
  eq('un câmp cu spații e tot gol', core.campuriDeCompletat(REG, { nume: 'denumire' }, { nume: '   ' }).completate.join(), 'nume');

  const scris = core.campuriDeCompletat(REG, HARTA,
    { nume: 'DENUMIREA MEA SRL', regCom: '', adresa: 'Str. Test 1', oras: '', judet: '' });
  ok('câmpul deja scris NU se atinge', !('nume' in scris.patch));
  ok('...dar se SPUNE că diferă de registru', scris.diferite.includes('nume'));
  ok('...iar cele goale se completează în continuare', scris.patch.regCom === 'J40/1/2020' && scris.patch.oras === 'Cluj-Napoca');
  // O valoare identică scrisă altfel (spații, majuscule) NU e o diferență de raportat: altfel
  // fiecare căutare ar acuza omul că are alte date decât registrul, degeaba.
  const lafel = core.campuriDeCompletat(REG, { adresa: 'adresa' }, { adresa: '  str.   TEST 1 ' });
  eq('aceeași valoare scrisă altfel nu e „diferită"', lafel.diferite.length, 0);

  // Registrul omite secțiuni întregi pentru unele forme de organizare — câmpul lipsă nu are ce
  // completa și nu are voie să șteargă nimic.
  const partial = core.campuriDeCompletat({ gasit: true, denumire: 'MINIM SRL' }, HARTA, { nume: '', adresa: '' });
  eq('câmpurile absente din registru se sar', Object.keys(partial.patch).join(), 'nume');

  // „Negăsit" și „nu s-a căutat" nu completează nimic. Cazul se dă cu un răspuns care POARTĂ
  // câmpuri, nu cu unul gol: un `{gasit:false}` fără date ar trece și dacă garda `gasit` ar fi
  // ștearsă din cod — adică testul ar fi verde din motivul greșit, exact ce s-a și întâmplat la
  // prima scriere. Forma de aici e reală: ruta întoarce `{gasit:false, cui}`, iar `cautaCui`
  // întoarce `{gasit:false, eroare}` când serviciul cade.
  const negasitCuDate = core.campuriDeCompletat(
    { gasit: false, cui: '40000000', denumire: 'NU EXISTĂ SRL', adresa: 'Str. Fantomă 1' }, HARTA, { nume: '', adresa: '' });
  eq('CUI negăsit nu completează, oricâte câmpuri ar purta răspunsul', Object.keys(negasitCuDate.patch).length, 0);
  eq('...și nici nu raportează completări', negasitCuDate.completate.length, 0);
  eq('răspuns absent nu schimbă nimic', Object.keys(core.campuriDeCompletat(null, HARTA, { nume: '' }).patch).length, 0);

  // Semnalele care schimbă o DECIZIE contabilă, nu doar conținutul unui câmp. Se dau chiar dacă
  // niciun câmp nu s-a completat — valoarea lor nu depinde de cât de gol era formularul.
  const inactiv = core.campuriDeCompletat(Object.assign({}, REG, { inactiv: true }), HARTA,
    { nume: 'X', regCom: 'X', adresa: 'X', oras: 'X', judet: 'X' });
  eq('nimic completat, dar avertismentul rămâne', inactiv.patch.nume === undefined && inactiv.avertismente.length, 1);
  ok('...și citează temeiul (art. 11 — nedeductibilitate)', /art\. 11/.test(inactiv.avertismente[0]));
  ok('TVA la încasare se semnalează separat, cu temeiul lui',
    core.campuriDeCompletat(Object.assign({}, REG, { tvaLaIncasare: true }), HARTA, {}).avertismente.some((a) => /297/.test(a)));
  ok('firma curată nu produce niciun avertisment', core.campuriDeCompletat(REG, HARTA, {}).avertismente.length === 0);

  // Mesajul de după completare se CITEȘTE, deci înșiră etichetele câmpurilor, nu numele lor
  // tehnice. Prima versiune tipărea „completat din registrul ANAF: den, adresa, oras, judet" —
  // `den` nu înseamnă nimic pentru cine completează formularul.
  eq('eticheta se curăță de lămuririle din paranteze', core.curataEticheta('Județ (cod, ex: RO-CJ)', 'judet'), 'Județ');
  eq('...și de marcajul de câmp obligatoriu', core.curataEticheta('Denumire firmă * ', 'nume'), 'Denumire firmă');
  eq('...și de spațiile din interior', core.curataEticheta('  Adresă   (stradă) ', 'adresa'), 'Adresă');
  // Un câmp fără `<label>` nu are voie să rămână fără nume în mesaj: cade pe numele tehnic,
  // adică exact comportamentul de dinainte, nu pe un șir gol.
  eq('fără etichetă se cade pe numele câmpului', core.curataEticheta('', 'den'), 'den');
  eq('...la fel dacă eticheta era doar decor', core.curataEticheta('( ) *', 'oras'), 'oras');
  eq('lipsa completă nu aruncă', core.curataEticheta(null, 'judet'), 'judet');
  // Poarta pe efect: mesajul nu are voie să mai conțină numele tehnice ale câmpurilor.
  const coreSrc = fs.readFileSync(path.join(PUB, 'core.js'), 'utf8');
  ok('mesajul înșiră etichete, nu numele câmpurilor', /listeaza\(r\.completate\)/.test(coreSrc) && !/r\.completate\.join/.test(coreSrc));
  ok('...și la fel pentru câmpurile care diferă', /listeaza\(r\.diferite\)/.test(coreSrc) && !/r\.diferite\.join/.test(coreSrc));

  // Poartă pe cele TREI locuri de apel: constatarea era că același CUI se tastează de mână în trei
  // formulare. Dacă unul rămâne nelegat, reparația e făcută pe două treimi — și nu s-ar vedea.
  const surse = { 'authui.js': 'înscrierea firmei', 'app.js': 'Firma mea', 'partners.js': 'formularul de partener' };
  for (const [f, unde] of Object.entries(surse)) {
    const src = fs.readFileSync(path.join(PUB, f), 'utf8');
    ok('completarea după CUI e legată în ' + unde + ' (' + f + ')', /legaCompletareCui\(/.test(src));
  }
}

section('Bulele de ajutor ⓘ chiar au unde să se prindă (fiecare titlu explicat există)');
{
  // `addPanelInfo()` din app.js leagă fiecare explicație din `panel-info.js` de un titlu din
  // pagină, potrivind pe TEXT: `.card h2`, `.card h3`, `section .toolbar h2` și `.card > summary`.
  // Potrivirea pe text e fragilă prin construcție — o redenumire sau mutarea titlului într-un alt
  // element rupe legătura TĂCUT: explicația rămâne în tabel, bula dispare de pe ecran și nimic
  // nu pică. Exact riscul luat aici, unde un panou a devenit `<details class="card">` și titlul
  // a trecut din `<h2>` în `<summary>`.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const src = fs.readFileSync(path.join(PUB, 'panel-info.js'), 'utf8');
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9ăâîșşțţ]/g, '');
  // Titlurile din pagină, pe aceleași patru ancore ca în app.js.
  const ancore = [];
  for (const m of html.matchAll(/<(h2|h3|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)) ancore.push(norm(m[2].replace(/<[^>]*>/g, ' ')));
  ok('poarta chiar vede titluri în pagină', ancore.length > 40);
  // Cheile explicate: primul element al fiecărei perechi din tabel.
  const chei = [...src.matchAll(/\n\s*\['([^']+)',/g)].map((m) => norm(m[1]));
  ok('poarta chiar vede explicații (nu o listă goală)', chei.length > 40);
  const orfane = chei.filter((k) => !ancore.some((a) => a.startsWith(k)));
  ok('fiecare explicație are un titlu de care să se prindă'
    + (orfane.length ? ' — ORFANE (' + orfane.length + '): ' + orfane.slice(0, 5).join(' | ') : ''),
    orfane.length === 0);
  // Cazul concret reparat aici: panoul de șabloane e strâns, dar titlul lui rămâne o ancoră validă.
  ok('șablonul de email e un panou care se STRÂNGE', /<details class="card" id="emailTplBox">/.test(html));
  ok('...strâns implicit (fără `open`)', !/<details class="card" id="emailTplBox"[^>]*\bopen\b/.test(html));
  ok('...cu titlul într-un `summary`, ancora recunoscută de addPanelInfo',
    /<details class="card" id="emailTplBox">\s*<summary[^>]*>📧 Șabloane email/.test(html));
}

section('Ecranele „1 · alege / 2 · verifică": formularul are lățime de lucru');
{
  // Formularul e UNIC în aplicație și se MUTĂ între gazde (docflow.js). Până la alegerea unui tip,
  // coloana a doua nu conține nimic — își rezerva jumătate de ecran ca să anunțe că e goală.
  // Măsurat pe 1440×900: pasul 2 ocupa 605px lățime; acum, până la alegere, ecranul e pe o
  // coloană, iar pasul 2 e o bandă de 93px. După alegere, formularul rămâne tot pe lățime completă:
  // selectoarele de partener și situațiile speciale nu mai sunt strivite în coloana din dreapta.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  ok('fluxul alege/verifică rămâne pe o coloană și cu formularul deschis',
    /\.grid2\.pas12\{grid-template-columns:1fr\}/.test(css));
  // Regula se sprijină pe UN singur `#entryForm` mutat între gazde. Dacă ar apărea al doilea,
  // selecția `:has()` ar fi adevărată în ambele ecrane deodată.
  eq('există exact un formular de înregistrare în pagină', (html.match(/id="entryForm"/g) || []).length, 1);

  // Perimetrul se DERIVĂ din tabelul de gazde al lui docflow.js, nu dintr-o listă scrisă aici:
  // un ecran nou cu același tipar ar rămâne altfel cu jumătatea goală, tăcut.
  const flow = fs.readFileSync(path.join(PUB, 'docflow.js'), 'utf8');
  const gazde = [...flow.matchAll(/host:\s*'#(\w+)'/g)].map((m) => m[1]);
  ok('poarta chiar citește gazdele din docflow.js', gazde.length >= 3);
  const fara = [];
  for (const g of gazde) {
    const i = html.indexOf('id="' + g + '"');
    if (i < 0) { fara.push(g + ' (gazdă inexistentă în pagină)'); continue; }
    // Cel mai apropiat înveliș `grid2` DINAINTEA gazdei; dacă gazda nu stă într-unul (cazul
    // `formHostCash`), ecranul nu are coloană rezervată și nu e în perimetru.
    const j = html.lastIndexOf('<div class="grid2', i);
    if (j < 0) continue;
    const antet = html.slice(j, html.indexOf('>', j));
    if (!/\bpas12\b/.test(antet)) fara.push(g);
  }
  ok('fiecare gazdă aflată într-un înveliș pe două coloane e marcată `pas12`'
    + (fara.length ? ' — FĂRĂ: ' + fara.join(', ') : ''), fara.length === 0);
  ok('...și chiar există astfel de învelișuri (nu o mulțime goală)', /class="grid2 pas12"/.test(html));

  // Textul nu mai poate spune „în stânga": poziția pasului 1 se schimbă (deasupra până la
  // alegere, în stânga după). Un îndemn fals despre unde să te uiți e mai rău decât niciunul.
  for (const [id, eticheta] of [['tab-emite', 'Emite factură'], ['tab-documente', 'Adaugă document primit']]) {
    const i = html.indexOf('id="' + id + '"');
    const sfarsit = html.indexOf('<section id=', i + 10);
    const ecran = html.slice(i, sfarsit > 0 ? sfarsit : undefined);
    ok('„' + eticheta + '" nu mai trimite la o poziție care se schimbă', !/(în|din) stânga/.test(ecran));
  }
}

section('Ecranele-strat opresc derularea paginii de dedesubt');
{
  // Strat rapid, pe sursă: dovedește că regulile EXISTĂ. Efectul (degetul chiar nu mai ajunge în
  // pagină) se dovedește în `scripts/e2e-izolat.mjs`, secțiunea 13, pe DOM adevărat — două
  // straturi, ca la restul porților.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  ok('pagina se blochează cât timp un ecran-strat e deschis',
    /html:has\(\.login-overlay:not\(\.hidden\)\)[\s\S]{0,80}\{overflow:hidden\}/.test(css));
  ok('...pe rădăcină ȘI pe body (propagarea overflow-ului diferă între motoare)',
    /body:has\(\.login-overlay:not\(\.hidden\)\)/.test(css));
  // `:not(.hidden)` e miezul regulii: fără el, pagina ar rămâne blocată DUPĂ autentificare —
  // cele șase ecrane-strat există mereu în DOM, doar ascunse.
  ok('regula se uită la ecranele VIZIBILE, nu la simpla lor existență',
    !/html:has\(\.login-overlay\)\s*[,{]/.test(css));
  // Derularea se oprește în overlay: altfel, la capătul lui, gestul continuă în pagină.
  ok('overlay-ul nu propagă derularea mai departe', /\.login-overlay\{[^}]*overscroll-behavior:contain/.test(css));
  // Toate cele șase straturi poartă clasa pe care se sprijină regula — un ecran nou care ar uita-o
  // ar reintroduce defectul tăcut, pe altă ușă.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const straturi = [...html.matchAll(/<div id="(\w+Overlay)" class="([^"]*)"/g)];
  ok('poarta chiar vede ecrane-strat (nu o listă goală)', straturi.length >= 5);
  const faraClasa = straturi.filter((m) => !/\blogin-overlay\b/.test(m[2])).map((m) => m[1]);
  ok('fiecare ecran-strat poartă clasa `login-overlay`'
    + (faraClasa.length ? ' — FĂRĂ: ' + faraClasa.join(', ') : ''), faraClasa.length === 0);
}

section('Logo lipsă: 204 e un răspuns „ok", deci nu poate fi tratat ca succes');
{
  // Capcana schimbării: „firma nu are logo" a devenit 204 tocmai ca să nu mai apară ca eroare în
  // consolă — dar 204 e 2xx, deci `r.ok` e ADEVĂRAT. Un `if (r.ok)` lăsat neatins ar fi construit
  // un obiect-imagine dintr-un corp GOL, adică exact pictograma de imagine ruptă pe care
  // schimbarea voia s-o evite: zgomotul din consolă schimbat într-un defect vizibil.
  const src = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  ok('citirea logo-ului cere CORP, nu doar succes', /r\.ok && r\.status !== 204/.test(src));
  ok('...și decizia de afișare folosește chiar acel rezultat', /if \(areLogo\)/.test(src));
  ok('nu mai există un `if (r.ok)` gol pe calea logo-ului',
    !/const r = await fetch\('\/api\/company\/logo[\s\S]{0,400}?if \(r\.ok\) \{/.test(src));
}
section('Modul simplu filtrează LIMBAJUL, nu doar meniul');
{
  // Constatarea reparată aici: `.simple-ui` ascundea 9 taburi și 28 de elemente, dar ecranele pe
  // care aterizai rămâneau identice — pe TVA, o casetă de 288px despre „taxare inversă intra-UE pe
  // rânduri dedicate" și „DUKIntegrator / XSD ANAF", adică o treime din primul ecran de telefon
  // înaintea oricărei cifre. Perechea e mereu aceeași: `.adv` pentru textul de breaslă,
  // `.simple-only` / `.simple-only-inline` pentru același lucru spus pe înțelesul tuturor.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

  // Fără regula CSS, `.simple-only-inline` e text care se vede în AMBELE moduri: nu dispare nimic,
  // ci apar două formulări una după alta. Eșecul e vizual, deci exact genul care scapă.
  ok('.simple-only-inline e ascunsă implicit', /\.simple-only-inline\{display:none\}/.test(css));
  ok('...și apare în modul simplu, ca inline (nu block, ar rupe fraza)', /\.simple-ui \.simple-only-inline\{display:inline\}/.test(css));

  // Termenii care NU au ce căuta în fața unui necontabil trebuie să stea într-un element `.adv`.
  // Scanarea e pe TEXT: fiecare termen apare undeva în pagină, dar niciodată în afara unui `.adv`
  // sau a unui tab deja ascuns în modul simplu.
  const TABURI_ADV = new Set(['jurnal', 'carte', 'balanta', 'storno', 'inchideri', 'inchidere-an', 'anexe', 'plan', 'audit']);
  // Secțiunile ascunse integral în modul simplu: ce scrie acolo nu ajunge la un necontabil.
  const sectiuniVizibile = html.split(/<section id="tab-/).slice(1)
    .filter((s) => !TABURI_ADV.has(s.slice(0, s.indexOf('"'))));
  // Elimină conținutul marcat `.adv` — ce rămâne e exact ce vede un necontabil.
  const vizibilInSimplu = sectiuniVizibile.join('\n')
    .replace(/<(\w+)[^>]*class="[^"]*\badv\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g, ' ');
  for (const termen of ['DUKIntegrator', 'XSD ANAF', 'taxare inversă intra-UE', 'exigibilitate automată', 'art. 300']) {
    ok('„' + termen + '" nu ajunge la un necontabil', !vizibilInSimplu.includes(termen));
    ok('...dar rămâne pentru contabil', html.includes(termen));
  }
  // Poarta trebuie să POATĂ pica: un termen chiar prezent în afara oricărui `.adv` e găsit.
  ok('poarta chiar vede textul vizibil', vizibilInSimplu.includes('Acțiuni frecvente'));

  // Etichetele de stare din „Declarații ANAF": „recap (→ ANAF)" nu spune nimic unui patron, și
  // tocmai el se uită în listă ca să afle ce are de făcut luna asta.
  const eticheta = livrabile.statusLabel('recap');
  ok('starea tehnică rămâne, marcată .adv', eticheta.includes('class="adv"') && eticheta.includes('recap (→ ANAF)'));
  ok('...dublată de una pe înțelesul tuturor', eticheta.includes('class="simple-only-inline"') && eticheta.includes('se depune la ANAF'));
  // O stare necunoscută nu are voie să lase eticheta goală în vreunul dintre moduri.
  ok('o stare necunoscută cade pe ceva lizibil', livrabile.statusLabel('inexistent').includes('simple-only-inline'));
  // Poarta pe SURSĂ: o stare nouă adăugată fără `ts` ar arăta gol în modul simplu, iar în expert
  // n-ar avea cum să se vadă — defect tăcut exact în modul pe care îl apără această secțiune.
  const srcLivr = fs.readFileSync(path.join(PUB, 'livrabile.js'), 'utf8');
  const bloc = (srcLivr.match(/const STATUS = \{[\s\S]*?\n\};/) || [''])[0];
  ok('poarta chiar vede tabelul de stări', bloc.includes('recap:'));
  const stari = [...bloc.matchAll(/^\s{2}(\w+): \{([^}]*)\}/gm)];
  ok('fiecare stare are și eticheta pe înțelesul tuturor', stari.length >= 5 && stari.every((m) => /\bts:\s*'/.test(m[2])));

  // Punctul ORB al porții de mai sus, găsit la verificarea în browser: scanarea de mai sus citește
  // `index.html`, dar jargonul mai intră în pagină și pe altă ușă — textul venit de la SERVER.
  // `obs` din lista de livrabile (src/reporting.js) purta chiar „XML de validat cu DUKIntegrator"
  // și se randa în modul simplu, sub un titlu de declarație, fără ca nimic din HTML să-l trădeze.
  // Deci a doua ancoră, pe locul de RANDARE: nota tehnică a rândului trăiește într-un `.adv`.
  const randObs = (srcLivr.split('\n').find((l) => l.includes('it.obs ?')) || '');
  ok('poarta chiar vede randarea notei tehnice', randObs !== '');
  ok('nota tehnică a livrabilului se randează în .adv', /class="[^"]*\badv\b/.test(randObs));
  // Textul incriminat chiar există pe server — altfel poarta ar apăra un caz imaginar.
  const rep = fs.readFileSync(path.join(ROOT, 'src', 'reporting.js'), 'utf8');
  ok('...iar server-ul chiar trimite jargon în acel câmp', /'XML de validat cu DUKIntegrator[^']*'/.test(rep));
}

section('Balanță: diagnosticul dezechilibrului');
// Cand balanta nu se inchide, mesajul spune CARE dintre cele patru egalitati e stricata si
// trimite contabilul spre cauza. O clasificare gresita il pune sa caute in locul nepotrivit.
const echilibrata = { siD: 100, siC: 100, rd: 50, rc: 50, tsD: 150, tsC: 150, sfD: 20, sfC: 20 };
eq('balanța echilibrată nu raportează nicio egalitate stricată', rapoarte.balanceEquations(echilibrata).length, 0);
const doarSolduri = Object.assign({}, echilibrata, { siD: 130, tsD: 180 });
const eqSolduri = rapoarte.balanceEquations(doarSolduri);
ok('soldurile inițiale dezechilibrate sunt identificate ca atare', eqSolduri.some((x) => x.nume === 'Sold inițial'));
eq('diferența raportată e debit − credit', eqSolduri.find((x) => x.nume === 'Sold inițial').dif, 30);
// cazul care declanseaza indrumarea „verifica soldurile initiale": doar rulajele stricate NU o da
const doarRulaje = Object.assign({}, echilibrata, { rd: 70, tsD: 170 });
ok('rulajele stricate nu sunt confundate cu soldurile inițiale', !rapoarte.balanceEquations(doarRulaje).some((x) => x.nume === 'Sold inițial'));
ok('rulajele stricate sunt totuși raportate', rapoarte.balanceEquations(doarRulaje).some((x) => x.nume === 'Rulaje'));
eq('se raportează toate egalitățile stricate, nu doar prima', rapoarte.balanceEquations({ siD: 1, siC: 2, rd: 3, rc: 4, tsD: 5, tsC: 6, sfD: 7, sfC: 8 }).length, 4);
// campuri lipsa: 0, nu NaN — altfel s-ar afisa „diferență NaN" si ar parea un dezechilibru
eq('câmpurile lipsă nu inventează un dezechilibru', rapoarte.balanceEquations({}).length, 0);
eq('diferența e rotunjită la ban', rapoarte.balanceEquations({ siD: 0.1, siC: 0.2 })[0].dif, -0.1);

section('Balanță: totalurile rândurilor vizibile');
// La filtrarea „doar mișcări", totalul general nu mai corespunde cu ce se vede pe ecran.
const randuri = [
  { cod: '371', siD: 100, siC: 0, rd: 10, rc: 0, tsD: 110, tsC: 0, sfD: 110, sfC: 0 },
  { cod: '401', siD: 0, siC: 50, rd: 0, rc: 5, tsD: 0, tsC: 55, sfD: 0, sfC: 55 },
];
const tot = rapoarte.balanceTotals(randuri);
eq('totalul debit însumează rândurile vizibile', tot.siD, 100);
eq('totalul credit însumează rândurile vizibile', tot.siC, 50);
eq('totalul rulajelor', tot.rd, 10);
eq('lista goală dă zerouri, nu undefined', rapoarte.balanceTotals([]).siD, 0);
eq('cheile lipsă din rânduri contează ca 0', rapoarte.balanceTotals([{ cod: 'x' }]).rd, 0);
// Suma in virgula mobila se rotunjeste: 1,1 + 2,2 = 3,3000000000000003 fara rotunjire.
// ATENTIE: se verifica prin `ok`, nu prin `eq` — helperul `eq` rotunjeste el insusi numerele
// inainte de comparatie, deci ar trece si daca rotunjirea din cod ar lipsi (verificat prin mutatie).
ok('totalul e rotunjit la ban (fara reziduu de virgulă mobilă)', rapoarte.balanceTotals([{ siD: 1.1 }, { siD: 2.2 }]).siD === 3.3);

section('Balanță: coloanele utile pe mobil');
eq('soldul final este grupa implicită', rapoarte.balanceMobileGroup(), 'sf');
eq('o valoare necunoscută cade prudent pe sold final', rapoarte.balanceMobileGroup('inventat'), 'sf');
eq('opțiunea toate coloanele este acceptată', rapoarte.balanceMobileGroup('all'), 'all');
{
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
  const src = fs.readFileSync(path.join(PUB, 'rapoarte.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(PUB, 'i18n.js'), 'utf8');
  ok('selectorul pornește explicit pe Sold final', /id="balantaMobileColumns"[\s\S]*?<option value="sf" selected>Sold final/.test(html));
  ok('selectorul oferă toate cele patru grupe și vederea completă',
    ['sf', 'ru', 'si', 'su', 'all'].every((v) => html.includes(`<option value="${v}"`)));
  ok('mesajul de glisare este legat accesibil de selector',
    /aria-describedby="balantaSwipeHint"/.test(html) && /id="balantaSwipeHint"[^>]*>[\s\S]*Glisează pentru detalii/.test(html));
  ok('rendererul marchează fiecare familie de valori',
    ['account', 'name', 'si', 'ru', 'su', 'sf'].every((g) => src.includes(`bal-col-${g}`)));
  ok('primele două coloane sunt sticky pe mobil',
    /#balantaView \.bal-col-account\{position:sticky;left:0/.test(css)
      && /#balantaView \.bal-col-name\{position:sticky;left:64px/.test(css));
  ok('grupele nealese sunt ascunse numai în pragul mobil',
    /@media\(max-width:700px\)\{[\s\S]*data-mobile-columns="sf"[\s\S]*\.bal-col-su[\s\S]*display:none/.test(css));
  ok('noile controale rămân traduse în interfața engleză',
    ['Coloane afișate', 'Sold final (implicit)', 'Total sume', 'Toate coloanele', 'Glisează pentru detalii']
      .every((label) => i18n.includes(`'${label}':`)));
}

section('Declarații: insigna de stare și sensul provizionului');
// Al doilea argument nu mai e un boolean „overdue", ci URGENȚA derivată din termen (vezi
// `urgentaTermen` în src/declarations.js) — de aceea insigna poate spune trei lucruri, nu două.
ok('starea „depusă" își arată eticheta', livrabile.declBadge('depusa', 'gata').includes('Depusă'));
ok('starea „eroare" își arată eticheta', livrabile.declBadge('eroare', 'in-pregatire').includes('Eroare'));
// o stare necunoscuta NU trebuie sa lase insigna goala: cade pe „nedepusă" (cel mai prudent)
ok('starea necunoscută cade pe „Nedepusă", nu pe gol', livrabile.declBadge('inventata', 'in-pregatire').includes('Nedepusă'));
ok('starea lipsă cu urgență necunoscută cade tot pe „Nedepusă"', livrabile.declBadge(undefined, undefined).includes('Nedepusă'));
ok('restanța e marcată separat de stare', livrabile.declBadge('generata', 'restanta').includes('restanță'));
// ...iar pe o declarație fără stare salvată, restanța devine chiar eticheta: „⏰ restanță" lipit
// de „Nedepusă" spunea de două ori același lucru și lăsa cuvântul important la coadă.
ok('restanța fără stare salvată devine eticheta', livrabile.declBadge('nedepusa', 'restanta').includes('Restanță'));
ok('fără restanță nu apare marcajul', !livrabile.declBadge('nedepusa', false).includes('restanță'));
// Poarta frontend <-> server: fiecare stare acceptata de server are eticheta in frontend.
// Altfel registrul ar afisa „Nedepusă" pentru o declaratie de fapt depusa — exact invers.
const declSrc = fs.readFileSync(path.join(ROOT, 'src', 'declarations.js'), 'utf8');
const stM = declSrc.match(/const STATUSES = \[([^\]]+)\]/);
ok('STATUSES e gasit in src/declarations.js', !!stM);
const serverDecl = stM ? stM[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')) : [];
ok('serverul declara cel putin 5 stari', serverDecl.length >= 5);
const fallbackHtml = livrabile.declBadge('__inexistenta__', false);
for (const st of serverDecl) {
  ok('starea „' + st + '" are eticheta proprie in frontend', st === 'nedepusa' || livrabile.declBadge(st, false) !== fallbackHtml);
}
const timelineHtml = livrabile.renderDossierTimeline([
  { id: 'profile:1', kind: 'fiscal-profile', eventType: 'profile.changed',
    occurredAt: '2026-07-02T10:30:00.000Z', effectiveAt: '2026-07-01', validTo: null,
    revisionId: 'fpr-2', note: 'trecere la profit', appliesToPeriod: true, usedByDossier: true,
    uses: [{ kind: 'submission', ordinal: 2 }],
    changes: [{ field: 'regimImpozit', before: 'micro', after: 'profit' }] },
  { id: 'state:9', kind: 'filing', eventType: 'submission.amended', occurredAt: '2026-07-03T11:00:00.000Z',
    sequence: 9, from: 'depusa', to: 'depusa', actor: { username: 'ana' }, ordinal: 2,
    rectificativa: true, reason: 'factură primită târziu', submissionHash: 'a'.repeat(64),
    eventHash: 'b'.repeat(64), receiptReferences: ['R-2'], receiptHashes: ['c'.repeat(64)] },
]);
ok('cronologia UI arată schimbarea de profil și separă data efectivă',
  timelineHtml.includes('Schimbare de profil fiscal') && timelineHtml.includes('Efectiv:')
    && timelineHtml.includes('02.07.2026 · 10:30 UTC') && timelineHtml.includes('01.07.2026'));
ok('cronologia UI arată rectificativa cu ordinal, motiv și recipisă',
  timelineHtml.includes('Rectificativă arhivată') && timelineHtml.includes('#2 · rectificativă')
    && timelineHtml.includes('factură primită târziu') && timelineHtml.includes('R-2'));
ok('cronologia UI afișează dovezile scurt, păstrând hash-ul complet în title',
  timelineHtml.includes('aaaaaaaaaaaa…') && timelineHtml.includes('title="' + 'a'.repeat(64) + '"'));
const timelineProfilePos = timelineHtml.indexOf('Schimbare de profil fiscal');
const timelineRectPos = timelineHtml.indexOf('Rectificativă arhivată');
ok('interfața păstrează ordinea serverului, de la vechi la nou', timelineProfilePos >= 0 && timelineProfilePos < timelineRectPos);
const livrabileSrc = fs.readFileSync(path.join(PUB, 'livrabile.js'), 'utf8');
ok('dosarul și cronologia nu sunt ascunse în modul simplificat',
  /<th>Dosar \/ cronologie<\/th>/.test(livrabileSrc) && !/<th class="adv">Dosar \/ cronologie<\/th>/.test(livrabileSrc));
// Sensul articolului de provizion se inverseaza dupa semn — o inversare arata articolul invers.
eq('provizion de constituit (mai e nevoie)', livrabile.provizionDirectie(500), '6814 = 491');
eq('provizion de reluat (existentul e prea mare)', livrabile.provizionDirectie(-500), '491 = 7814, reluare');
eq('la zero se afișează constituirea (fără sumă de înregistrat)', livrabile.provizionDirectie(0), '6814 = 491');

section('e-TVA: comparația cu decontul precompletat ANAF');
// Conventia de semn e scrisa in interfata: „Δ = ANAF − tu (pozitiv: ANAF vede mai mult)".
// O inversare de semn ar trimite contabilul sa corecteze in directia gresita.
const etva = {
  ok: false, diffCount: 1, meta: { period: '2026-06' },
  findings: [{ nivel: 'atentie', mesaj: 'Diferență la rândul 9' }],
  rows: [
    { rand: '9', eticheta: 'Livrări taxabile', match: false, baza: { propriu: 1000, anaf: 1200, delta: 200, match: false }, tva: { propriu: 210, anaf: 252, delta: 42, match: false } },
    { rand: '10', eticheta: 'Achiziții', match: true, baza: { propriu: 500, anaf: 500, delta: 0, match: true }, tva: null },
  ],
};
const etvaHtml = rapoarte.renderEtvaResult(etva);
ok('delta pozitivă e prefixată cu + (ANAF vede mai mult)', etvaHtml.includes('+200,00'));
ok('delta zero se afișează ca liniuță, nu ca 0,00', etvaHtml.includes('>—<'));
ok('rândul cu diferențe e marcat vizual', etvaHtml.includes('etva-diff-row'));
ok('numărul de rânduri cu diferențe apare în insignă, la singular', etvaHtml.includes('1 rând cu diferențe'));
ok('perioada comparată e afișată', etvaHtml.includes('2026-06'));
ok('observațiile ANAF sunt listate', etvaHtml.includes('Diferență la rândul 9'));
ok('coloanele lipsă (tva null) nu strică tabelul', etvaHtml.includes('<td></td><td></td><td></td>'));
ok('rezultatul concordant arată insigna „concordant"', rapoarte.renderEtvaResult({ ok: true, rows: [], meta: {} }).includes('concordant'));
// Datele vin dintr-un fisier ANAF, deci sunt EXTERNE: trec prin H inainte de innerHTML
const etvaOstil = rapoarte.renderEtvaResult({ ok: false, diffCount: 0, meta: { period: '<img src=x>' }, findings: [{ nivel: 'info', mesaj: '<b>x</b>' }], rows: [{ rand: '"><script>', eticheta: '<i>y</i>', match: true, baza: null, tva: null }] });
ok('eticheta din fișierul ANAF e escapată', !etvaOstil.includes('<i>y</i>') && etvaOstil.includes('&lt;i&gt;'));
ok('numărul de rând ostil nu poate închide un atribut', !etvaOstil.includes('"><script>'));
ok('perioada din meta e escapată', !etvaOstil.includes('<img src=x>'));
ok('mesajul observației e escapat', !etvaOstil.includes('<b>x</b>'));

section('Impozit pe profit: ajustările manuale sunt suprascrieri, nu implicite');
// REGRESIE. Câmpurile porneau cu value="0", deci fiecare cerere trimitea
// `cheltNedeductibile=0&deduceri=0`. Pe server un 0 explicit înseamnă „zero, exact", deci ștergea
// tot ce calculase motorul de ajustări — inclusiv plafoanele art. 25/40². Câmpul gol trebuie să
// NU ajungă în cerere; distincția „gol" vs „zero" e tot defectul.
eq('câmpuri goale: niciun parametru trimis', rapoarte.ptParams('', '', '').length, 0);
eq('câmpuri absente (undefined/null): tot niciunul', rapoarte.ptParams(undefined, null, undefined).length, 0);
eq('doar spații albe înseamnă tot gol', rapoarte.ptParams('  ', '', '').length, 0);
// ...dar un zero TASTAT e o intenție și trebuie să plece pe fir.
ok('zero tastat se trimite (suprascriere explicită)', rapoarte.ptParams('0', '', '').includes('cheltNedeductibile=0'));
ok('valorile completate se trimit toate trei', rapoarte.ptParams('100', '50', '25').join('&')
  === 'cheltNedeductibile=100&deduceri=50&pierdereReportata=25');
ok('un câmp completat nu le trimite și pe celelalte', rapoarte.ptParams('', '50', '').join('&') === 'deduceri=50');

section('Mesagerie: randarea firului de chat');
// Continutul vine de la ALT UTILIZATOR (suport patron <-> contabil <-> administrator) si e citit
// de administrator. Escaparea e stratul care nu trebuie sa cada primul, chiar daca CSP prinde
// executia (script-src 'self', fara unsafe-inline).
eq('dimensiune sub 1 KB in octeti', messages.fmtSize(512), '512 B');
// granitele, nu doar puncte din mijlocul intervalelor: un prag mutat (1024 -> 1000) trece
// neobservat daca testezi doar 512 si 1024 (verificat prin mutatie)
eq('ultimul octet inainte de KB', messages.fmtSize(1023), '1023 B');
eq('exact 1 KB', messages.fmtSize(1024), '1 KB');
eq('ultimul KB inainte de MB', messages.fmtSize(1048575), '1024 KB');
eq('pragul spre MB', messages.fmtSize(1048576), '1.0 MB');
eq('zero e afisat, nu ascuns', messages.fmtSize(0), '0 B');
eq('valoare invalida nu da NaN', messages.fmtSize('abc'), '0 B');
ok('fara atasament nu se randeaza nimic', messages.attachHtml({ id: 'm1' }) === '');
const imgAtt = messages.attachHtml({ id: 'm1', attachment: { name: 'poza.png', mime: 'image/png', size: 2048 } });
ok('imaginile se randeaza inline (thumbnail)', imgAtt.includes('<img') && imgAtt.includes('msg-img'));
const pdfAtt = messages.attachHtml({ id: 'm2', attachment: { name: 'raport.pdf', mime: 'application/pdf', size: 1048576 } });
ok('restul devin buton de descarcare, nu <img>', pdfAtt.includes('filechip') && !pdfAtt.includes('<img'));
ok('butonul de descarcare arata dimensiunea', pdfAtt.includes('1.0 MB'));
// REGRESIE: numele fisierului vine din req.file.originalname si NU e sanitizat pe server. In
// atribut trebuie escapat cu escAttr — escMsg (folosit inainte aici) nu atinge ghilimelele, deci
// un nume ca `x" onerror="…` inchidea atributul alt si adauga altele noi.
const attEvil = messages.attachHtml({ id: 'm3', attachment: { name: 'x" onerror="alert(1)', mime: 'image/png', size: 10 } });
ok('numele de fișier ostil nu poate închide atributul alt', attEvil.includes('alt="x&quot; onerror=&quot;alert(1)"'));
ok('numele ostil nu lasă ghilimele brute în markup', !/alt="x" /.test(attEvil));
const bub = { id: 'm9', fromAdmin: false, text: 'salut <b>x</b>\nrand nou', author: 'Ion & Co', createdAt: '2026-07-01T10:00:00Z' };
const bubUser = messages.bubble(bub, false);
ok('textul mesajului e escapat', bubUser.includes('&lt;b&gt;') && !bubUser.includes('<b>x</b>'));
ok('rândurile noi devin <br>', bubUser.includes('<br>'));
ok('numele autorului e escapat', bubUser.includes('Ion &amp; Co'));
ok('mesajul propriu e pe partea „mine"', bubUser.includes('msg mine'));
ok('autorul își poate edita mesajul', bubUser.includes('msg-edit'));
ok('utilizatorul nu poate șterge mesaje', !bubUser.includes('msg-del'));
const bubAdmin = messages.bubble(bub, true);
ok('pentru admin, mesajul utilizatorului e pe partea cealaltă', bubAdmin.includes('msg other'));
ok('adminul poate șterge mesaje', bubAdmin.includes('msg-del'));
ok('adminul NU poate edita mesajul altuia', !bubAdmin.includes('msg-edit'));
const messageDsCss = fs.readFileSync(path.join(PUB, 'design-system.css'), 'utf8');
ok('editarea și ștergerea mesajului au ținte pătrate de minimum 36 px',
  /body\.erp \.msg-del,[\s\S]{0,100}body\.erp \.msg-edit[\s\S]{0,260}width: var\(--ds-control-min-h\)[\s\S]{0,100}height: var\(--ds-control-min-h\)/.test(messageDsCss));
ok('acțiunile mesajului rămân vizibile pe touch și rezervă loc în bulă',
  /opacity: \.72/.test(messageDsCss) && /@media \(hover: hover\)/.test(messageDsCss)
    && /\.msg-b:has\(\.msg-del \+ \.msg-edit\)/.test(messageDsCss));
// textul reintra intr-un ATRIBUT la editare (data-text) — acolo e nevoie de escAttr
ok('textul dus în atributul de editare e escapat pentru atribut', messages.bubble({ id: 'm', fromAdmin: false, text: 'a"b', createdAt: '' }, false).includes('data-text="a&quot;b"'));
ok('confirmarea de citire apare pe mesajul propriu', messages.bubble({ id: 'm', fromAdmin: false, text: 'x', createdAt: '', readByAdmin: true }, false).includes('citit'));
ok('mesajul editat e marcat ca atare', messages.bubble({ id: 'm', fromAdmin: false, text: 'x', createdAt: '', editedAt: '2026-07-01' }, false).includes('editat'));

section('e-Transport: tipul de operațiune propus');
// Codul ajunge intr-o declaratie catre ANAF: un cod gresit inseamna o declaratie gresita.
eq('livrarea intracomunitară', etransport.defaultTip('livrare_intracomunitara'), '20');
eq('achiziția intracomunitară', etransport.defaultTip('achizitie_intracomunitara'), '10');
eq('importul vamal', etransport.defaultTip('import_vamal'), '40');
eq('restul sunt transport național', etransport.defaultTip('aviz_livrare'), '30');
eq('tip necunoscut cade tot pe transport național', etransport.defaultTip('ceva_nou'), '30');
// Poarta frontend <-> server: codurile propuse trebuie sa existe in nomenclatorul serverului SI
// sa insemne ce trebuie. O inversare 10<->20 ar trece o verificare „codul exista", dar nu si asta.
const etrSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'etransport.js'), 'utf8');
const tipM = etrSrc2.match(/const TIP_OPERATIUNE = \{([^}]+)\}/);
ok('TIP_OPERATIUNE e gasit in src/etransport.js', !!tipM);
const nomen = {};
for (const m of (tipM ? tipM[1] : '').matchAll(/(\d+):\s*'([^']+)'/g)) nomen[m[1]] = m[2];
ok('nomenclatorul serverului are coduri', Object.keys(nomen).length >= 4);
for (const t of ['livrare_intracomunitara', 'achizitie_intracomunitara', 'import_vamal', 'aviz_livrare']) {
  ok('codul propus pentru „' + t + '" exista in nomenclatorul serverului', !!nomen[etransport.defaultTip(t)]);
}
ok('codul livrării IC înseamnă chiar livrare intracomunitară', /Livrare intracomunitara/i.test(nomen[etransport.defaultTip('livrare_intracomunitara')] || ''));
ok('codul achiziției IC înseamnă chiar achiziție intracomunitară', /Achizitie intracomunitara/i.test(nomen[etransport.defaultTip('achizitie_intracomunitara')] || ''));
ok('codul importului înseamnă chiar import', /Import/i.test(nomen[etransport.defaultTip('import_vamal')] || ''));
ok('codul implicit înseamnă transport național', /national/i.test(nomen[etransport.defaultTip('altceva')] || ''));

section('Abonament, stocuri, bancă, parteneri, vizualizator XML');
// Eticheta de abonament din selectorul de firme — primul lucru pe care il vede utilizatorul
// despre starea platii. O stare gresit etichetata inseamna fie panica degeaba, fie o firma
// care expira fara ca nimeni sa observe.
eq('proba arata zilele ramase', app.subTag({ _sub: { status: 'trial', zileRamase: 5 } }), ' 🎁 probă 5z');
eq('proba expirata e marcata', app.subTag({ _sub: { status: 'expired' } }), ' 🎁 expirată');
eq('lipsa abonamentului e marcata', app.subTag({ _sub: { status: 'none' } }), ' ⚠ fără abonament');
eq('abonamentul activ nu adauga nimic', app.subTag({ _sub: { status: 'active' } }), '');
eq('firma fara informatie de abonament nu arunca', app.subTag({}), '');
eq('argument lipsa nu arunca', app.subTag(undefined), '');

// Miscarile de stoc: transferul e singurul care trebuie sa arate AMBELE gestiuni.
eq('receptia', stocuri.tipLbl({ tip: 'receptie' }), 'recepție');
eq('transferul arata sursa si destinatia', stocuri.tipLbl({ tip: 'transfer', gestiuneCod: 'DEP1', gestiuneDestCod: 'MAG' }), 'transfer DEP1→MAG');
eq('iesirea', stocuri.tipLbl({ tip: 'iesire' }), 'ieșire');
eq('tip necunoscut e tratat ca iesire', stocuri.tipLbl({ tip: 'altceva' }), 'ieșire');
eq('obiect gol nu arunca', stocuri.tipLbl({}), 'ieșire');

// Pragul la preluarea stocului: sub un ban e rotunjire, de la un ban in sus stocul
// cantitativ-valoric NU bate cu contabilitatea. Se verifica exact granita.
ok('diferenta de exact un ban e semnificativa', stocuri.stocDiferentaSemnificativa(0.01) === true);
ok('diferenta sub un ban e doar rotunjire', stocuri.stocDiferentaSemnificativa(0.009) === false);
ok('zero nu e o diferenta', stocuri.stocDiferentaSemnificativa(0) === false);
ok('diferenta negativa conteaza la fel', stocuri.stocDiferentaSemnificativa(-0.01) === true);
ok('diferenta mare e semnificativa', stocuri.stocDiferentaSemnificativa(-5000) === true);
ok('valoare nenumerica nu semnaleaza fals', stocuri.stocDiferentaSemnificativa('abc') === false);
ok('null nu arunca', stocuri.stocDiferentaSemnificativa(null) === false);

// Potrivirea liniei de extras bancar cu facturile pe care le stinge.
ok('fara potrivire se arata liniuta', bank.matchCell({}).includes('—'));
ok('potrivirea „fara" e tot liniuta', bank.matchCell({ potrivire: { tip: 'fara' } }).includes('—'));
ok('lista goala de facturi nu inventeaza o potrivire', bank.matchCell({ potrivire: { tip: 'exacta', facturi: [] } }).includes('—'));
ok('potrivirea exacta arata documentul', bank.matchCell({ potrivire: { tip: 'exacta', facturi: [{ doc: 'F100' }] } }).includes('F100'));
const agreg = bank.matchCell({ potrivire: { tip: 'agregata', facturi: [{ doc: 'F1' }, { doc: 'F2' }] } });
ok('potrivirea agregata spune CATE facturi stinge', agreg.includes('2 facturi'));
ok('potrivirea agregata le si enumera', agreg.includes('F1, F2'));
ok('potrivirea partiala e marcata ca avertisment', bank.matchCell({ potrivire: { tip: 'partiala', facturi: [{ doc: 'F3' }] } }).includes('pill warn'));
ok('factura fara numar are text de rezerva', bank.matchCell({ potrivire: { tip: 'exacta', facturi: [{}] } }).includes('fără nr.'));
// numarul de document e tastat de utilizator si vine si din extrasul bancar
ok('numarul de document e escapat', bank.matchCell({ potrivire: { tip: 'exacta', facturi: [{ doc: '<b>x</b>' }] } }).includes('&lt;b&gt;'));

// Insigna de tip partener.
ok('clientul isi are insigna', partners.tipBadge('client').includes('Client'));
ok('furnizorul isi are insigna', partners.tipBadge('furnizor').includes('Furnizor'));
ok('„ambele" isi are insigna', partners.tipBadge('ambele').includes('Ambele'));
ok('tipul necunoscut da liniuta, nu insigna goala', partners.tipBadge('inventat').includes('—'));
ok('tipul lipsa da liniuta', partners.tipBadge(undefined).includes('—'));

// Insigna de stare ANAF: ordinea e cea a GRAVITATII fiscale, nu a campurilor din raspuns.
ok('neverificat nu se preface a fi in regula', partners.anafBadge(null).includes('—'));
ok('neverificat spune ce lipseste', /neverificat/i.test(partners.anafBadge(null)));
ok('inactivul e semnalat, cu temeiul', (() => {
  const b = partners.anafBadge({ verificatLa: '2026-08-06', gasit: true, inactiv: true, dataInactivare: '2025-03-01' });
  return b.includes('inactiv') && /art\. 11/.test(b);
})());
ok('inactivul BATE orice alta mentiune (e cea care taie deducerea)', (() => {
  // partener inactiv DAR platitor de TVA si pe e-Factura: insigna nu are voie sa arate „✓"
  const b = partners.anafBadge({ verificatLa: '2026-08-06', gasit: true, inactiv: true, tvaPlatitor: true, eFactura: true });
  return b.includes('inactiv') && !b.includes('✓');
})());
ok('CUI inexistent -> insigna proprie', partners.anafBadge({ verificatLa: 'x', gasit: false }).includes('inexistent'));
ok('TVA la incasare la furnizor e semnalat', partners.anafBadge({ verificatLa: 'x', gasit: true, tvaPlatitor: true, tvaLaIncasare: true }).includes('TVA la încasare'));
ok('neinregistratul in scopuri de TVA e semnalat', partners.anafBadge({ verificatLa: 'x', gasit: true, tvaPlatitor: false }).includes('fără TVA'));
ok('partenerul curat da bifa', partners.anafBadge({ verificatLa: 'x', gasit: true, tvaPlatitor: true }).includes('✓'));
// Datele vin de la ANAF, deci sunt EXTERNE: ajung intr-un atribut `title`, unde ghilimelele conteaza.
ok('starea de inregistrare e escapata in atribut', (() => {
  const b = partners.anafBadge({ verificatLa: 'x', gasit: true, radiat: true, stareInregistrare: 'RADIERE" onmouseover="alert(1)' });
  return !b.includes('onmouseover="alert') && b.includes('&quot;');
})());
ok('data inactivarii e escapata in atribut', !partners.anafBadge({ verificatLa: 'x', gasit: true, inactiv: true, dataInactivare: '"><img src=x>' }).includes('<img'));

// Sumarul verificarii: constatarile care schimba un rezultat fiscal stau primele.
ok('sumarul pune inactivii pe primul loc, cu temeiul', (() => {
  const h = partners.sumarAnaf({ data: '2026-08-06', sumar: { total: 10, inactivi: 2, tvaLaIncasare: 3 } });
  return h.indexOf('inactiv') < h.indexOf('TVA la încasare') && /art\. 11/.test(h);
})());
ok('fara probleme, sumarul o spune explicit', partners.sumarAnaf({ data: '2026-08-06', sumar: { total: 5 } }).includes('Niciun partener cu probleme'));
ok('sumarul nu cade pe raspuns gol', typeof partners.sumarAnaf({}) === 'string');

// Vizualizatorul de XML: titlul declaratiei si indentarea.
eq('titlul pentru D300', viewer.xmlTitle('/xml/d300?period=2026-06'), 'D300 — Decont TVA (XML ANAF)');
eq('titlul pentru D307', viewer.xmlTitle('/xml/d307?period=2026-06'), 'D307 — Ajustări TVA (XML ANAF)');
eq('titlul pentru D107', viewer.xmlTitle('/xml/d107?year=2026'), 'D107 — Beneficiarii sponsorizărilor (XML ANAF)');
eq('titlul pentru SAF-T', viewer.xmlTitle('/xml/saft?year=2026'), 'SAF-T / D406 (XML ANAF)');
eq('declaratie necunoscuta primeste titlu generic', viewer.xmlTitle('/xml/altceva'), 'XML ANAF');
eq('adresa lipsa nu arunca', viewer.xmlTitle(undefined), 'XML ANAF');
const pretty = viewer.prettyXml('<a><b><c>x</c></b><d/></a>');
eq('prettyXml indenteaza pe niveluri', pretty.split('\n')[2], '    <c>x</c>');
ok('prettyXml pastreaza eticheta auto-inchisa fara sa indenteze in plus', pretty.includes('\n  <d/>'));
ok('prettyXml inchide la nivelul de pornire', pretty.split('\n').pop() === '</a>');
eq('prettyXml pe un sir care nu e XML il intoarce neatins', viewer.prettyXml('nu sunt xml'), 'nu sunt xml');

section('Cockpit de închidere lunară: compunerea pașilor (public/inchidere.js)');
// Modulul nu decide nimic — randează starea primită de la server. Aici verificăm exact atât:
// că starea ajunge corect pe ecran ȘI că tot ce vine din date (nume de partener în motivul
// blocajului, motivul forțării scris de admin, numele utilizatorului) e escapat.
{
  const pasGata = { key: 'banca', nume: 'Extras bancar', descriere: 'd', tab: 'reconciliere', eticheta: 'Verifică', stare: 'gata', blocaje: [], blocatDe: null, responsabilId: null, due: '2026-07-15', dueImplicit: true, overdue: false, nota: '' };
  const pasDeschis = Object.assign({}, pasGata, { key: 'documente', nume: 'Documente', stare: 'deschis', blocaje: ['2 furnizori fără document: <b>ACME</b> SRL'], overdue: true, dueImplicit: false, responsabilId: 7 });
  const pasBlocat = Object.assign({}, pasGata, { key: 'tva', stare: 'blocat', blocaje: ['x'], blocatDe: 'Documente <b>complete</b>' });
  const resp = [{ id: 7, username: 'maria<script>' }];

  const hGata = inchidere.stepHtml(pasGata, resp);
  ok('pasul gata poartă clasa de stare', hGata.includes('is-gata'));
  ok('pasul gata NU mai arată butonul de acțiune', !hGata.includes('cl-go'));
  ok('termenul implicit e marcat ca atare', hGata.includes('implicit'));

  const hDeschis = inchidere.stepHtml(pasDeschis, resp);
  ok('pasul deschis arată butonul către ecranul care îl rezolvă', hDeschis.includes('cl-go') && hDeschis.includes('data-tab="reconciliere"'));
  ok('motivul blocajului apare în listă', hDeschis.includes('closeblock') && hDeschis.includes('furnizori'));
  ok('termenul depășit e marcat', hDeschis.includes('depășit'));
  ok('responsabilul alocat e selectat', hDeschis.includes('value="7" selected'));
  ok('„nealocat" rămâne o opțiune validă', hDeschis.includes('— nealocat —'));
  // ESCAPARE: numele partenerului ajunge în blocaj din documentele primite; username-ul din cont
  ok('motivul blocajului e escapat', hDeschis.includes('&lt;b&gt;ACME&lt;/b&gt;') && !hDeschis.includes('<b>ACME'));
  ok('numele utilizatorului e escapat în select', hDeschis.includes('maria&lt;script&gt;') && !hDeschis.includes('maria<script>'));

  // ALOCAREA SE PLIAZA cand nu e nimeni intre cine sa alegi (contabilul care lucreaza singur).
  // Invariantul care conteaza NU e „se pliaza", ci „nu se ascunde nimic din ce trebuie vazut":
  // termenul efectiv si marcajul „depasit" raman in rezumat, si pliate.
  eq('cu un singur om, alocarea se pliaza', inchidere.alocareaSePliaza(resp), true);
  eq('fara niciun om, la fel', inchidere.alocareaSePliaza([]), true);
  eq('lista lipsa nu arunca', inchidere.alocareaSePliaza(null), true);
  eq('cu doi oameni, alegerea are sens si ramane desfasurata',
    inchidere.alocareaSePliaza([{ id: 1, username: 'a' }, { id: 2, username: 'b' }]), false);

  ok('pliat: exista rezumatul cu actiunea „Alocă"', hDeschis.includes('closealoc') && hDeschis.includes('Alocă'));
  ok('pliat: TERMENUL efectiv ramane vizibil, in conventia romaneasca', hDeschis.includes('Termen 15.07.2026'));
  ok('pliat: „depășit" ramane vizibil in rezumat, nu doar in campul ascuns',
    /closealoc-rez[^>]*is-overdue[^>]*>[^<]*depășit/.test(hDeschis));
  ok('pliat: responsabilul ales se vede in rezumat, escapat',
    hDeschis.includes('responsabil: maria&lt;script&gt;') && !hDeschis.includes('responsabil: maria<script>'));
  const hDoi = inchidere.stepHtml(pasDeschis, [{ id: 7, username: 'maria' }, { id: 8, username: 'ion' }]);
  ok('cu doi oameni, campurile sunt direct pe ecran, fara pliere',
    !hDoi.includes('closealoc') && hDoi.includes('cl-resp') && hDoi.includes('cl-due'));
  const faraTermen = inchidere.stepHtml(Object.assign({}, pasGata, { due: '' }), resp);
  ok('pasul fara termen o spune, in loc sa lase rezumatul gol', faraTermen.includes('Fără termen'));

  const hBlocat = inchidere.stepHtml(pasBlocat, resp);
  ok('pasul blocat spune CE îl ține', hBlocat.includes('Așteaptă pasul anterior'));
  ok('numele pasului care blochează e escapat', hBlocat.includes('&lt;b&gt;complete&lt;/b&gt;'));

  // Antetul: progres, verdict, aprobare, forțare (cu motivul scris de om)
  const stBaza = { period: '2026-06', progres: { gata: 3, total: 6, procent: 50 }, sePoateInchide: false, inchisa: false, ancoraTermen: '2026-07-25', aprobare: null, fortata: null, steps: [] };
  const hHead = inchidere.closeHeaderHtml(stBaza);
  ok('bara de progres reflectă procentul', hHead.includes('width:50%'));
  // „3 pași" NU contine „3 pas": al treilea caracter e ș (U+0219), nu s. Vechea formulare
  // „3 pas(i)" il continea, deci ancora scurta trecea din intamplare.
  ok('verdictul spune câți pași au rămas, cu plural corect', hHead.includes('3 pași de rezolvat'));
  const hUnu = inchidere.closeHeaderHtml(Object.assign({}, stBaza, { progres: { gata: 5, total: 6, procent: 83 } }));
  ok('...si la un singur pas foloseste singularul', hUnu.includes('1 pas de rezolvat'));
  ok('termenul lunii apare in conventia romaneasca', hHead.includes('25.07.2026') && !hHead.includes('2026-07-25'));
  const hGataHead = inchidere.closeHeaderHtml(Object.assign({}, stBaza, { sePoateInchide: true, progres: { gata: 5, total: 5, procent: 100 } }));
  ok('când totul e gata, verdictul o spune', hGataHead.includes('se poate închide'));
  const hForced = inchidere.closeHeaderHtml(Object.assign({}, stBaza, {
    fortata: { motiv: 'depus <b>manual</b> pe portal', username: 'ad<min', at: '2026-07-20T08:00:00Z', blocante: ['D<300'] },
  }));
  ok('forțarea e afișată vizibil, cu motivul', hForced.includes('notice warning') && hForced.includes('forțată'));
  ok('motivul forțării e escapat', hForced.includes('&lt;b&gt;manual&lt;/b&gt;') && !hForced.includes('<b>manual'));
  ok('numele celui care a forțat e escapat', hForced.includes('ad&lt;min'));
  ok('pașii nerezolvați la forțare sunt escapați', hForced.includes('D&lt;300'));
  const hAprob = inchidere.closeHeaderHtml(Object.assign({}, stBaza, { aprobare: { username: 'ma<ria', at: '2026-07-20T08:00:00Z', nota: 'ok <b>' } }));
  ok('aprobarea arată cine și când, escapat', hAprob.includes('ma&lt;ria') && hAprob.includes('ok &lt;b&gt;'));
  const hAprobVeche = inchidere.closeHeaderHtml(Object.assign({}, stBaza, { aprobare: { username: 'maria', at: '2026-07-20T08:00:00Z', invechita: true } }));
  ok('aprobarea invechita spune explicit ca datele s-au schimbat', hAprobVeche.includes('nu mai este valabilă') && hAprobVeche.includes('Reaprobă'));

  // Tabelul dovezilor de validare
  const stDecl = {
    steps: [{ key: 'declaratii', detalii: { declaratii: [
      { tip: 'd300', nume: 'D300 — decont TVA', due: '2026-07-25', status: 'depusa', overdue: false, dovada: { at: '2026-07-20T09:30:00Z', username: 'ma<ria', ok: true, errors: 0, warnings: 1 } },
      { tip: 'd394', nume: 'D394 — <b>info</b>', due: '2026-07-25', status: 'generata', overdue: true, dovada: { at: '2026-07-20T09:31:00Z', username: 'x', ok: false, errors: 2, warnings: 0 } },
      { tip: 'saft', nume: 'D406 — SAF-T', due: '2026-07-31', status: 'nedepusa', overdue: false, dovada: null },
      { tip: 'd112', nume: 'D112 — salarii', due: '2026-07-25', status: 'depusa', overdue: false, dovada: { at: '2026-07-20T09:32:00Z', username: 'x', ok: true, errors: 0, warnings: 0, invechita: true } },
    ] } }],
  };
  const hProof = inchidere.proofsHtml(stDecl, [{ tip: 'd300' }, { tip: 'd394' }]);
  eq('starea se afișează în scriere românească, nu valoarea internă', inchidere.statusLabel('nedepusa'), 'nedepusă');
  eq('cockpitul recunoaște starea nouă de document aprobat', inchidere.statusLabel('aprobata'), 'aprobată');
  eq('statusul necunoscut nu se pierde', inchidere.statusLabel('altceva'), 'altceva');
  eq('statusul lipsă dă liniuță', inchidere.statusLabel(undefined), '—');
  ok('tabelul folosește eticheta, nu valoarea brută', hProof.includes('nedepusă') && !hProof.includes('>nedepusa<'));
  ok('dovada fără erori se vede ca atare', hProof.includes('fără erori'));
  ok('dovada cu erori arată numărul', hProof.includes('2 eroare/erori'));
  ok('dovada invechita cere revalidare dupa schimbarea datelor', hProof.includes('învechită') && hProof.includes('validează din nou'));
  ok('declarația nevalidată e marcată', hProof.includes('nevalidată'));
  ok('butonul de validare apare doar pentru tipurile validabile', (hProof.match(/cl-val/g) || []).length === 2);
  ok('numele declarației e escapat', hProof.includes('D394 — &lt;b&gt;info&lt;/b&gt;'));
  ok('numele validatorului e escapat', hProof.includes('ma&lt;ria'));
  eq('fără declarații așteptate: mesaj, nu tabel gol', inchidere.proofsHtml({ steps: [] }, []).includes('<table>'), false);
}

section('Dosar anual persistent: istoric versionat și integritate vizibilă (entries.js)');
{
  const history = entries.annualArchiveVersionsHtml({ closed: true, versions: [
    { version: 1, createdAt: '2027-05-01T10:15:00.000Z', createdByName: 'maria', reason: 'Sigilarea inițială',
      bytes: 1536, zipSha256: 'a'.repeat(64), verified: true },
    { version: 2, createdAt: '2027-05-02T11:30:00.000Z', createdByName: '<admin>', reason: 'Rectificare <b>aprobată</b>',
      bytes: 2097152, zipSha256: 'b'.repeat(64), verified: false, verificationError: 'semnătură <invalidă>' },
  ] }, '2026');
  ok('toate versiunile persistente apar în istoric', history.includes('v1') && history.includes('v2'));
  ok('versiunea nouă este afișată prima', history.indexOf('v2') < history.indexOf('v1'));
  ok('fiecare versiune verificată are descărcare explicită', history.includes('/api/dosar-anual?year=2026&amp;version=1'));
  ok('versiunea coruptă nu poate fi descărcată', history.includes('Descărcare blocată') && !history.includes('version=2'));
  ok('amprenta SHA-256 completă rămâne vizibilă', history.includes('a'.repeat(64)) && history.includes('b'.repeat(64)));
  ok('autorul, motivul și eroarea de integritate sunt escapate', history.includes('&lt;admin&gt;')
    && history.includes('Rectificare &lt;b&gt;aprobată&lt;/b&gt;') && history.includes('semnătură &lt;invalidă&gt;'));
  const emptyOpen = entries.annualArchiveVersionsHtml({ closed: false, versions: [] }, '2026');
  ok('anul deschis explică de ce nu poate fi sigilat', emptyOpen.includes('este încă deschis') && emptyOpen.includes('Nicio versiune sigilată'));
}

section('Calitatea citirii automate: verdictul și raportul (docflow.js / entries.js)');
{
  // Verdictul de pe ecranul de încărcare — serverul decide, ecranul doar explică.
  const cal = {
    scor: 62, decizie: 'revizuire',
    controale: [
      { cod: 'aritmetica', nume: 'Bază + TVA = total', ok: true, motiv: null },
      { cod: 'partener', nume: 'Partener cunoscut', ok: false, motiv: 'Partenerul „<b>ACME</b> SRL" e nou — prima înregistrare se verifică.' },
      { cod: 'duplicat', nume: 'Fără duplicat', ok: false, motiv: 'Documentul „F-1" e deja înregistrat (e9).' },
    ],
  };
  const h = docflow.calitateHtml(cal);
  ok('verdictul spune că cere revizuire', h.includes('cere revizuire'));
  ok('arată scorul și câte controale au trecut', h.includes('62%') && h.includes('1/3'));
  ok('listează DOAR controalele picate, cu motivul lor', h.includes('Partener cunoscut') && h.includes('Fără duplicat') && !h.includes('Bază + TVA'));
  // numele furnizorului vine din document (sursă externă) și ajunge în motiv
  ok('motivul e escapat', h.includes('&lt;b&gt;ACME&lt;/b&gt;') && !h.includes('<b>ACME'));

  const hAuto = docflow.calitateHtml({ scor: 100, controale: [] }, { entryId: 'e42' });
  ok('ciorna automată se anunță ca atare, cu articolul creat', hAuto.includes('ciornă propusă automat') && hAuto.includes('e42'));
  eq('fără verdict nu randează nimic', docflow.calitateHtml(null), '');
}

section('Gazda formularului unic de înregistrare (docflow.js)');
{
  // Formularul de înregistrare e UNUL singur în aplicație, mutat între taburi. Dacă `host` nu e
  // recunoscut, cade pe „documente" — adică formularul se deschide pe ALT tab decât cel la care
  // se uită omul, fără nicio eroare. Defectul e tăcut prin construcție, deci se prinde doar aici.
  eq('Emite factură își are gazda ei', docflow.formHostSelector('emite'), '#formHostEmite');
  eq('Bancă/Casă își are gazda ei', docflow.formHostSelector('cashbook'), '#formHostCash');
  eq('Adaugă document primit', docflow.formHostSelector('documente'), '#formHostDoc');
  eq('fără host specificat: tabul documentelor', docflow.formHostSelector(undefined), '#formHostDoc');
  // Cele trei gazde trebuie să fie DISTINCTE: o greșeală de copy-paste în tabel (două intrări cu
  // același selector) ar face ca butoanele de pe Bani să deschidă formularul pe tabul documentelor.
  const gazde = ['documente', 'emite', 'cashbook'].map(docflow.formHostSelector);
  eq('fiecare tab are gazda lui, nu una comună', new Set(gazde).size, 3);
  // Gazdele și textele de așteptare trebuie să EXISTE în pagină — altfel `mountForm` nu are unde
  // muta formularul și butonul nu face nimic vizibil.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  gazde.forEach((sel) => ok('gazda ' + sel + ' există în index.html', html.includes('id="' + sel.slice(1) + '"')));
  ['noDoc', 'noDocEmit', 'noDocCash'].forEach((id) => ok('textul de așteptare #' + id + ' există', html.includes('id="' + id + '"')));

  // Raportul pe furnizori / formate / controale
  const raport = {
    documenteCitite: 12, scorMediu: 71, postateAutomat: 3, rataCorectie: 40, autoPostActiv: false,
    furnizori: [{ cheie: '<b>ALPHA</b> SRL', interventii: 4, campuri: 6, controaleTop: [{ cod: 'cota', n: 3 }, { cod: 'partener', n: 1 }] }],
    formate: [{ cheie: 'pdf', interventii: 3, campuri: 4, controaleTop: [] }],
    peControl: [{ cod: 'cota', nume: 'Cotă TVA validă', n: 3 }],
    peCamp: [{ camp: 'cota', n: 3 }],
    recente: [{ fileName: 'f<1>.pdf', format: 'pdf', partener: 'ALPHA', campuri: [{ camp: 'cota' }], motiv: 'cotă <i>greșită</i>', tipExtras: 'a', tipSalvat: 'a' }],
    modele: [
      { model: 'claude-sonnet-5', documente: 8, incredereMedie: 74, postateAutomat: 1 },
      { model: null, documente: 4, incredereMedie: null, postateAutomat: 0 },
    ],
    corectiiPeModel: [{ cheie: 'claude-sonnet-5', interventii: 3, campuri: 5, controaleTop: [{ cod: 'cota', n: 2 }] }],
  };
  const hr = entries.calitateRaportHtml(raport);
  ok('raportul arată KPI-urile', hr.includes('12') && hr.includes('71%') && hr.includes('40%'));
  ok('spune dacă postarea automată e pornită sau nu', hr.includes('oprită'));
  ok('are tabelul pe furnizori, cu ce pică cel mai des', hr.includes('Furnizori care cer corecții') && hr.includes('cota ×3'));
  ok('are tabelul pe formate', hr.includes('Formate care cer corecții') && hr.includes('pdf'));
  ok('are tabelul de controale, cu numele lizibil', hr.includes('Cotă TVA validă'));
  ok('are ultimele corecții, cu motivul operatorului', hr.includes('Ultimele corecții') && hr.includes('gre'));
  // furnizorul, numele fișierului și motivul vin din date externe / de la operator
  ok('numele furnizorului e escapat', hr.includes('&lt;b&gt;ALPHA&lt;/b&gt;') && !hr.includes('<b>ALPHA'));
  ok('numele fișierului e escapat', hr.includes('f&lt;1&gt;.pdf'));
  ok('motivul scris de operator e escapat', hr.includes('&lt;i&gt;greșită&lt;/i&gt;'));
  // CINE a citit documentele: increderea e o auto-raportare, iar scala ei difera de la un model la
  // altul. Fara randarea asta, o schimbare de model ar aparea ca „nu mai trece nimic de controale",
  // fara nicio urma a cauzei — defalcarea exista in API de la merge-ul ce5483f, dar nu se vedea.
  ok('arată cine a citit documentele, cu modelul pe linie', hr.includes('Cine a citit documentele') && hr.includes('claude-sonnet-5'));
  ok('extragerea fără AI se numește în cuvinte, nu ca „null"', hr.includes('reguli locale') && !hr.includes('>null<'));
  // atentie la substring: `!hr.includes('0%')` trecea drept fals fiindca „40%" (rata de corecție)
  // îl conține. Verificarea corectă e pe CELULA randată, nu pe o bucată de text din tot raportul.
  ok('încrederea medie lipsă se arată ca „—", nu ca 0%',
    hr.includes('74%') && hr.includes('<td class="num">—</td>'));
  ok('spune că scala încrederii diferă între modele (altfel numărul induce în eroare)', /scala ei difer|scala .* difer/i.test(hr));
  ok('are tabelul de corecții pe extractor, în aceeași formă ca pe furnizori/formate',
    hr.includes('Corecții pe extractor') && hr.includes('cota ×2'));
  ok('fără documente citite: mesaj, nu tabele goale',
    entries.calitateRaportHtml({ documenteCitite: 0 }).includes('Niciun document'));
  eq('raport lipsă nu randează nimic', entries.calitateRaportHtml(null), '');
}

section('Factura de leasing: selectorul pastreaza legatura numai dupa preluarea ratei');
{
  const picker = (loadedContract, loadedPeriod, selectedContract, selectedPeriod) => ({
    dataset: { loadedContract, loadedPeriod },
    querySelector: (sel) => sel === '.lp-contract' ? { value: selectedContract } : { value: selectedPeriod },
  });
  eq('contractul si luna confirmate sunt serializate in formular',
    JSON.stringify(docflow.readLeasing(picker('lsg7', '2026-05', 'lsg7', '2026-05'))),
    JSON.stringify({ contractId: 'lsg7', period: '2026-05' }));
  eq('schimbarea lunii invalideaza legatura pana la o noua preluare',
    docflow.readLeasing(picker('lsg7', '2026-05', 'lsg7', '2026-06')), null);
  eq('simpla alegere, fara preluare, nu pretinde o rata legata',
    docflow.readLeasing(picker('', '', 'lsg7', '2026-05')), null);
  const flowSrc = fs.readFileSync(path.join(PUB, 'docflow.js'), 'utf8');
  ok('preluarea ratei completeaza campul real de CUI al furnizorului', /set\('cuiPartener',\s*r\.contract\.cui\)/.test(flowSrc));
}

section('Luna de lucru nu trece în viitor (public/periods.js)');
{
  const { capMonth, currentMonth } = await imp(mirror, 'periods.js');
  const acum = currentMonth();
  ok('luna curenta e in forma AAAA-LL', /^\d{4}-(0[1-9]|1[0-2])$/.test(acum));
  // luna curenta se calculeaza LOCAL, nu prin toISOString(): in UTC+2/+3, in primele ore ale zilei
  // de 1 ale lunii, UTC e inca luna trecuta — ca plafon, asta ar bloca utilizatorul in luna veche
  const d = new Date();
  eq('luna curenta e cea locala, nu cea UTC', acum, d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
  const plus = (n) => { const x = new Date(); x.setDate(1); x.setMonth(x.getMonth() + n); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0'); };
  eq('luna urmatoare e plafonata la cea curenta', capMonth(plus(1)), acum);
  eq('o luna mult in viitor e plafonata la fel', capMonth(plus(14)), acum);
  eq('luna curenta trece neatinsa', capMonth(acum), acum);
  eq('lunile din trecut trec neatinse', capMonth(plus(-1)), plus(-1));
  eq('si cele mult din trecut', capMonth('2019-03'), '2019-03');
  // comparatia e pe SIR: forma AAAA-LL o face corecta si peste hotarul de an
  ok('decembrie vs ianuarie: ordinea pe sir e cea cronologica', '2026-12' < '2027-01');
}

section('Trecerea la luna următoare doar prin închidere (public/periods.js)');
{
  const { esteInchisa, poateInainte } = await imp(mirror, 'periods.js');
  // `lu` si `acum` se dau explicit, ca testul sa nu depinda de ceasul masinii
  ok('luna dinaintea plafonului e inchisa', esteInchisa('2026-03', '2026-05'));
  ok('chiar luna plafonului e inchisa (<=)', esteInchisa('2026-05', '2026-05'));
  ok('luna de dupa plafon e deschisa', !esteInchisa('2026-06', '2026-05'));
  ok('fara nicio luna inchisa, nimic nu e inchis', !esteInchisa('2026-01', ''));

  // inaintarea cere ca luna CURENTA de lucru sa fie inchisa
  const v1 = poateInainte('2026-05', '2026-05', '2026-09');
  ok('din luna inchisa se poate inainta', v1.ok);
  const v2 = poateInainte('2026-06', '2026-05', '2026-09');
  ok('dintr-o luna NEinchisa nu se poate inainta', !v2.ok);
  eq('...iar motivul e „neinchisa" (ca sageata sa poata explica)', v2.motiv, 'neinchisa');
  // plafonul de viitor ramane si el, si are PRIORITATE (mesajul corect e „esti pe luna curenta")
  const v3 = poateInainte('2026-09', '2026-12', '2026-09');
  ok('nu se inainteaza in viitor nici daca luna e inchisa', !v3.ok);
  eq('...cu motivul „viitor", nu „neinchisa"', v3.motiv, 'viitor');
  // mersul inainte prin luni deja inchise, pana la frontiera
  ok('se poate merge din aprilie in mai (ambele inchise)', poateInainte('2026-04', '2026-06', '2026-09').ok);
  ok('dar nu mai departe de ultima luna inchisa', !poateInainte('2026-07', '2026-06', '2026-09').ok);
}

section('Căutare globală (Ctrl+K): filtrarea și ordonarea rezultatelor');
{
  const { cauta, fold } = await imp(mirror, 'paleta.js');
  eq('fold scoate diacriticele (căutarea nu depinde de ele)', fold('Găsești ȘI Țară'), 'gasesti si tara');
  const surse = {
    parteneri: [
      { fel: 'partener', text: 'ALFA DISTRIBUTIE SRL', sub: 'CUI 11223344', tab: 'parteneri' },
      { fel: 'partener', text: 'BETA RETAIL SRL', sub: 'CUI 99887766', tab: 'parteneri' },
    ],
    inregistrari: [
      { fel: 'doc', text: 'EXP 2605', sub: '2026-07-15 · BETA RETAIL SRL · Factura vanzare', tab: 'iesite', period: '2026-07' },
    ],
  };
  // destinatiile se citesc din DOM; shim-ul nu are meniu, deci aici raman doar sursele date
  const r1 = cauta('alfa', surse);
  ok('gaseste partenerul dupa denumire', r1.length === 1 && r1[0].text === 'ALFA DISTRIBUTIE SRL');
  const r2 = cauta('EXP 2605', surse);
  ok('gaseste documentul dupa numar', r2.length === 1 && r2[0].tab === 'iesite');
  ok('documentul isi poarta luna (lista se filtreaza pe luna de lucru)', r2[0].period === '2026-07');
  // „beta" e la INCEPUTUL denumirii partenerului, dar doar in mijlocul descrierii documentului:
  // potrivirea de la inceput trebuie sa iasa prima, altfel rezultatul evident ajunge al doilea
  const r3 = cauta('beta', surse);
  ok('potrivirea de la inceput e prima', r3.length === 2 && r3[0].text === 'BETA RETAIL SRL');
  ok('cautarea ignora diacriticele si majusculele', cauta('AlFa', surse).length === 1);
  eq('fara text nu se listeaza parteneri/documente', cauta('   ', surse).length, 0);
  eq('un cuvant fara potrivire da zero rezultate', cauta('zzz-inexistent', surse).length, 0);
}

section('Poartă: fiecare modul din public/ se încarcă fără să arunce');
// La deploy, HTML-ul si modulele JS nu se schimba atomic in cache-ul tuturor browserelor. Un
// client a incarcat settings.js nou peste index.html vechi, fara controalele de pornire 2FA, iar
// un addEventListener direct pe null a oprit intreg modulul. Reproducem exact fereastra de rollout:
// DOM-ul vechi nu are id-urile noi, dar restul paginii ramane disponibil.
{
  const queryReal = globalThis.document.querySelector;
  const iduriNoi2FA = new Set(['#twofaStart', '#twofaSetup', '#twofaQr', '#twofaSecret', '#twofaCode', '#twofaEnable', '#twofaCancel',
    '#twofaRecoveryManage', '#twofaRegenCode', '#twofaRegenerate', '#twofaRecovery', '#twofaRecoveryCodes', '#twofaRecoveryCopy', '#twofaRecoveryDownload', '#twofaRecoveryDone']);
  globalThis.document.querySelector = (sel) => (iduriNoi2FA.has(sel) ? null : queryReal.call(globalThis.document, sel));
  let err = null;
  try {
    const settingsVechiHtml = await import(pathToFileURL(path.join(mirror, 'settings.js')).href + '?html-vechi=1');
    settingsVechiHtml.render2FA();
  } catch (e) { err = e; }
  finally { globalThis.document.querySelector = queryReal; }
  ok('settings.js nou tolereaza HTML-ul vechi ramas in cache' + (err ? ' — ' + err.message : ''), !err);
}
// Testele de mai sus importa doar modulele pe care le verifica (9 din ~24). Un import lipsa in
// restul (ex. folosirea lui `H` fara sa fie importat) NU se vede: `node --check` valideaza
// sintaxa, nu rezolvarea numelor, iar eroarea apare abia in browser, la randare. S-a intamplat:
// o reparatie de escapare in mijloace.js a introdus `H is not defined`, prins doar in Playwright.
// Aici incarcam TOATE modulele — ieftin si prinde clasa asta imediat.
const moduleErrs = [];
let incarcate = 0;
for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith('.js') && x !== 'sw.js')) {
  try { await imp(mirror, f); incarcate += 1; } catch (e) { moduleErrs.push(f + ': ' + e.message.slice(0, 60)); }
}
ok('toate modulele din public/ se importa (' + incarcate + ')' + (moduleErrs.length ? ' — ' + moduleErrs.join(' | ') : ''), moduleErrs.length === 0);
ok('s-au incarcat efectiv modulele asteptate', incarcate >= 20);
// Numele importate din core.js trebuie sa existe la RULARE, nu doar sa fie scrise: verificam ca
// fiecare modul care foloseste `${fn(...)}` chiar are functia in domeniu (import sau definitie).
const lipsaImport = [];
for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(PUB, f), 'utf8');
  for (const fn of ['H', 'escAttr', 'escMsg', 'fmt', 'fiscalPct', 'fiscalText', 'accName']) {
    if (!new RegExp('\\$\\{' + fn + '\\(').test(src)) continue;
    const importat = new RegExp('^import \\{[^}]*\\b' + fn + '\\b', 'm').test(src);
    const definit = new RegExp('^(const|function|let|export (const|function)) ' + fn + '\\b', 'm').test(src);
    if (!importat && !definit) lipsaImport.push(f + ' foloseste ' + fn);
  }
}
ok('fiecare functie folosita in sabloane e importata sau definita' + (lipsaImport.length ? ' — ' + lipsaImport.join(', ') : ''), lipsaImport.length === 0);

section('Poartă: datele de proveniență externă nu ajung neescapate în HTML');
// Scanare pe SURSA din public/ (acelasi tipar ca poarta pe docs/api.md din test/run.js).
// Modelul de amenintare e cel declarat in public/core.js: „date de provenienta externa —
// parteneri din e-Factura/SPV, extrase bancare, denumiri, explicatii". Un camp din lista de mai
// jos interpolat direct in HTML, fara escapare, e o regresie: a existat deja (numele
// partenerului din documentele lipsa, mesajele SPV, explicatiile din jurnal, numele firmei).
//
// `nume`/`cod` SUNT acum in lista, desi sunt generice. Comentariul de dinainte le excludea ca
// „prea raspandite ca sa fie distinse de constante interne" — masurat, insa, dupa escaparea
// sinkurilor reale au mai ramas doar 11 locuri, toate constante interne (planuri de abonament,
// tipuri de documente, etichete de declaratii). Le-am escapat si pe acelea: escaparea unei
// constante nu costa nimic, iar poarta devine ABSOLUTA — fara lista de exceptii care sa se
// invecheasca. Motivul pentru care nu mai puteau fi ignorate: denumirile de conturi vin din
// planul de conturi, care se extinde prin import CSV (vezi [[plan-conturi-stare-globala]]).
const RISKY_FIELD = /\b(partener|denumire|explicatie|descriere|author|username|fileName|detalii|mesaj|firma|adresa|nume|cod)\b/i;
const ESC_FN = /\b(H|escMsg|escAttr|esc|e|fmt|encodeURIComponent|Number)\(/;
// Interpolarile FRUNZA se iau acum PE TEMPLATE, nu pe linie (test/tpl-scan.js). Ancora veche
// („linia contine <tag / innerHTML") sarea liniile de continuare ale template-urilor pe mai
// multe randuri — forma normala aici: masurat, 69 din 1030 de interpolari (6%) nu erau vazute
// deloc. Niciuna nu purta un camp riscant, deci gaura era goala; o tinea disciplina, nu poarta.
// Scoate apelurile de escapare CU TOT cu argumentul (paranteze echilibrate): ce ramane pe urma
// e exact ce ajunge neescapat in pagina, indiferent cum a fost compusa expresia.
function stripEsc(expr) {
  let s = expr;
  for (let p = 0; p < 12; p += 1) {
    const m = s.match(ESC_FN);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    let depth = 0; let end = -1;
    for (let i = open; i < s.length; i += 1) {
      if (s[i] === '(') depth += 1;
      else if (s[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) break;
    s = s.slice(0, m.index) + ' ' + s.slice(end + 1);
  }
  return s;
}
const dropCond = (s) => { const q = s.indexOf('?'); return q >= 0 ? s.slice(q + 1) : s; }; // conditia nu se afiseaza
// textul afisat nu e o referinta de date: „abonează firma acum" contine „firma" fara sa citeasca nimic
const stripLit = (s) => s.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
// CHEILE de obiect sunt nume pe care le-am scris NOI, nu date pe care le citim: in
// `Object.assign({ nume: 'TOTAL CAPITALURI PROPRII' }, eq.total)` cuvantul „nume" e o eticheta
// interna, nu un camp extern. Ancorat pe `{` sau `,` ca sa nu prinda `p.nume : ''` dintr-un
// ternar — acolo `nume` chiar e o citire de date si trebuie sa ramana raportabil.
// (Falsul pozitiv a aparut abia dupa trecerea la scanarea pe template: statea pe o linie de
// continuare, adica exact in unghiul mort al ancorei vechi.)
const stripKeys = (s) => s.replace(/([{,]\s*)[A-Za-z_$][\w$]*\s*:/g, '$1');
// expresiile FRUNZA dintr-un fragment de sursa (folosit de contra-probe si de portile 3 si 4)
const leaves = (src) => templates(src)
  .flatMap((t) => t.interps.filter((it) => !it.expr.includes('${')).map((it) => it.expr.trim()));

const TAG_HTML = /[<][a-zA-Z/]/;
const neescapate = [];
const inAtribut = [];
for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(PUB, f), 'utf8');
  src.split('\n').forEach((ln, i) => {
    // a doua poarta, EXACTA: escMsg nu escapeaza ghilimelele, deci intr-un atribut permite
    // adaugarea de atribute noi. Exact bug-ul din mesagerie (numele fisierului atasat).
    for (const m of ln.matchAll(/[a-zA-Z-]+="\$\{\s*escMsg\(/g)) inAtribut.push(f + ':' + (i + 1) + ' ' + m[0]);
  });
  // Un template intra la verificare daca poarta markup SAU daca e dat direct unui sink de HTML
  // fara sa contina vreun tag: `el.innerHTML = ${x}` injecteaza la fel de bine fara `<` in sablon.
  const sink = (t) => TAG_HTML.test(t.text)
    || /innerHTML|insertAdjacentHTML/.test((src.split('\n')[t.line - 1] || ''));
  for (const t of templates(src)) {
    if (!sink(t)) continue;
    for (const it of t.interps) {
      if (it.expr.includes('${')) continue; // nu e frunza
      const e = it.expr.trim();
      if (!e || !RISKY_FIELD.test(e)) continue;
      if (RISKY_FIELD.test(stripKeys(stripLit(dropCond(stripEsc(e)))))) neescapate.push(f + ':' + it.line + '  ${' + e.slice(0, 60) + '}');
    }
  }
}
ok('niciun camp de provenienta externa interpolat fara escapare'
  + (neescapate.length ? ' — ' + neescapate.slice(0, 4).join(' | ') : ''), neescapate.length === 0);

// A treia poarta, PE SURSA in loc de pe numele campului: accName() citeste META.accounts, iar
// planul de conturi se extinde prin import CSV — deci intoarce text de provenienta externa, sub
// un nume (`nume`) prea generic pentru RISKY_FIELD. Aici nu ghicim dupa nume, ci dupa FUNCTIA
// apelata: orice accName() interpolat in HTML trebuie sa fie invelit intr-o escapare.
const accNeescapat = [];
for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(PUB, f), 'utf8');
  const linii = src.split('\n');
  for (const t of templates(src)) {
    if (!TAG_HTML.test(t.text) && !/innerHTML|insertAdjacentHTML/.test(linii[t.line - 1] || '')) continue;
    for (const it of t.interps) {
      if (it.expr.includes('${')) continue;
      const e = it.expr.trim();
      if (e && /\baccName\(/.test(stripEsc(e))) accNeescapat.push(f + ':' + it.line + '  ${' + e.slice(0, 60) + '}');
    }
  }
}
ok('accName() nu ajunge niciodata neescapat in HTML'
  + (accNeescapat.length ? ' — ' + accNeescapat.join(' | ') : ''), accNeescapat.length === 0);

// A patra poarta, tot pe PROVENIENTA: renderEfactura (public/viewer.js) construieste HTML
// EXCLUSIV din XML-ul unei facturi primite prin SPV — adica din date scrise de furnizor, cea
// mai putin de incredere sursa din aplicatie. Acolo regula nu e „campurile riscante se
// escapeaza", ci „TOT se escapeaza": orice interpolare care nu e literal sau formatare numerica
// e o scapare. Asa au fost gasite `cbc:Percent` si `cbc:DocumentCurrencyCode`, neescapate intre
// vecini escapati — nume de campuri pe care nicio lista de „campuri riscante" nu le-ar fi avut.
const viewerSrc = fs.readFileSync(path.join(PUB, 'viewer.js'), 'utf8').split('\n');
const efStart = viewerSrc.findIndex((l) => /function renderEfactura/.test(l));
const efNeescapate = [];
if (efStart >= 0) {
  let efEnd = viewerSrc.length;
  for (let i = efStart + 1; i < viewerSrc.length; i += 1) {
    if (/^function |^const \w+ = \(/.test(viewerSrc[i])) { efEnd = i; break; }
  }
  // se scaneaza FRAGMENTUL functiei ca text, nu linie cu linie: altfel interpolarile din
  // template-urile pe mai multe randuri (majoritatea aici) raman nevazute
  const efSrc = viewerSrc.slice(efStart, efEnd).join('\n');
  for (const t of templates(efSrc)) {
    if (!TAG_HTML.test(t.text)) continue;
    for (const it of t.interps) {
      if (it.expr.includes('${')) continue;
      const e = it.expr.trim();
      // `=>` marcheaza o expresie CONTAINER (lines.map(...)): frunzele ei sunt intoarse separat
      // si verificate pe cont propriu, deci containerul nu spune nimic.
      if (!e || /=>/.test(e)) continue;
      // conditia unui ternar nu se afiseaza (dropCond), sumele trec prin money() -> Number()
      const rest = stripKeys(stripLit(dropCond(stripEsc(e.replace(/\bmoney\([^)]*\)/g, ' ')))));
      if (/[A-Za-z_$][\w$]*/.test(rest)) efNeescapate.push('viewer.js:' + (efStart + it.line) + '  ${' + e.slice(0, 50) + '}');
    }
  }
}
ok('randarea e-Facturii escapeaza TOT (date de la furnizor)'
  + (efNeescapate.length ? ' — ' + efNeescapate.join(' | ') : ''), efNeescapate.length === 0);
ok('poarta e-Factura chiar detecteaza un camp neescapat',
  /[A-Za-z_$][\w$]*/.test(stripLit(stripEsc("l.cota ? l.cota + '%' : '—'"))));
ok('poarta accName chiar detecteaza cazul neescapat',
  /\baccName\(/.test(stripEsc('`<td>${accName(r.cont)}</td>`')));
ok('poarta accName accepta cazul escapat',
  !/\baccName\(/.test(stripEsc('`<td>${H(accName(r.cont))}</td>`')));
ok('escMsg nu e folosit in atribute (nu escapeaza ghilimelele)'
  + (inAtribut.length ? ' — ' + inAtribut.join(' | ') : ''), inAtribut.length === 0);
// poarta trebuie sa POATA pica: verificam pe o linie construita anume
const scapa = (src) => leaves(src).some((e) => RISKY_FIELD.test(stripKeys(stripLit(dropCond(stripEsc(e))))));
ok('poarta chiar detecteaza o interpolare neescapata', scapa('x.innerHTML = `<td>${r.explicatie}</td>`'));
ok('poarta nu raporteaza o interpolare escapata', !scapa('x.innerHTML = `<td>${H(r.explicatie)}</td>`'));
ok('poarta nu se incurca in escapare compusa', !scapa("x.innerHTML = `<td>${o.partener ? ' · ' + H(o.partener) : ''}</td>`"));
// contra-proba pe MECANISMUL nou: interpolarea sta pe o linie fara niciun tag, in interiorul
// unui template pe mai multe randuri — forma pe care ancora veche o sarea complet
ok('poarta vede interpolarile de pe liniile de continuare (ancora veche le sarea)',
  scapa(['x.innerHTML = `<table>', '  <td>${r.explicatie}</td>', '</table>`;'].join('\n')));
ok('...si le accepta cand sunt escapate',
  !scapa(['x.innerHTML = `<table>', '  <td>${H(r.explicatie)}</td>', '</table>`;'].join('\n')));
// cheia de obiect nu e o citire de date, dar un camp cu acelasi nume ramane raportabil
ok('cheia de obiect literal nu e confundata cu un camp extern',
  !scapa("x.innerHTML = `<td>${er(Object.assign({ nume: 'TOTAL' }, eq.total))}</td>`"));
ok('...dar o citire reala cu acelasi nume tot e prinsa',
  scapa('x.innerHTML = `<td>${p.nume}</td>`'));

// ── Poarta anti-drift: parsarea sumelor exista in DOUA implementari ────────
// `public/plan.js` (editorul de solduri din interfata) si `src/migrare.js` (preluarea din alt
// program). Nu pot partaja cod — unul e modul ES in browser, celalalt CommonJS pe server — dar
// NU au voie sa difere: un separator interpretat altfel intr-un loc costa un factor de 1000 exact
// pe soldurile de deschidere. Daca driftează, poarta asta pica.
{
  const { createRequire } = await import('node:module');
  const requireCjs = createRequire(import.meta.url);
  const mig = requireCjs(path.join(ROOT, 'src', 'migrare.js'));
  const CORPUS = ['1.234', '1.234,56', '1,234.56', '12.345.678', '0,50', '0.50', '1234', '-1.234,56',
    '12,5', '1.234.567', '999', '1.000', '10.000,00', '', 'abc', '1 234,56', '1.234 lei'];
  const dif = [];
  for (const t of CORPUS) {
    // acelasi rol de separator pe ambele parti, si cazul „fara conventie" (ambiguu)
    for (const roles of [null, { '.': 'mii', ',': 'zecimale' }, { '.': 'zecimale', ',': 'mii' }]) {
      const a = plan.parseAmount(t, roles);
      const b = mig.parseAmount(t, roles);
      if (a.value !== b.value || !!a.ambiguous !== !!b.ambiguous) {
        dif.push(t + ' [' + JSON.stringify(roles) + ']: frontend=' + JSON.stringify(a) + ' server=' + JSON.stringify(b));
      }
    }
    // si deductia conventiei dintr-un singur token
    const ra = plan.sepConvention([t]); const rb = mig.sepConvention([t]);
    if (JSON.stringify(ra) !== JSON.stringify(rb)) dif.push('sepConvention(' + t + '): ' + JSON.stringify(ra) + ' vs ' + JSON.stringify(rb));
  }
  ok('parsarea sumelor e IDENTICA in public/plan.js si src/migrare.js'
    + (dif.length ? ' — ' + dif.slice(0, 3).join(' | ') : ''), dif.length === 0);
  // poarta trebuie sa POATA pica: doua rezultate diferite pe acelasi token sunt detectate
  ok('poarta chiar detecteaza o divergenta',
    plan.parseAmount('1.234', { '.': 'mii' }).value !== plan.parseAmount('1.234', { '.': 'zecimale' }).value);
}

section('Administrare: cine e patronul si cine e contabilul unei firme');
{
  const users = [
    { id: 1, username: 'admin', role: 'admin', firme: [7, 8] },
    { id: 2, username: 'patron', role: 'user', firme: [7] },
    { id: 3, username: 'contabil', role: 'user', firme: [7, 8] },
    { id: 4, username: 'strain', role: 'user', firme: [8] },
  ];
  const f7 = { id: 7, nume: 'ALFA', ownerId: 2 };
  const faraPatron = { id: 9, nume: 'VECHE', ownerId: undefined };

  ok('proprietarul firmei e patron', admin.rolPeFirma(users[1], f7) === 'patron');
  ok('cine doar are acces e contabil', admin.rolPeFirma(users[2], f7) === 'contabil');
  ok('pe o firma fara proprietar nimeni nu e patron', admin.rolPeFirma(users[1], faraPatron) === 'contabil');

  const c7 = admin.contabiliiFirmei(users, f7).map((u) => u.username);
  ok('contabilii firmei = cei cu acces, fara proprietar', c7.join(',') === 'contabil');
  ok('patronul nu apare si ca propriul contabil', !c7.includes('patron'));
  ok('adminul nu e listat drept contabil', !c7.includes('admin'));
  ok('cine nu are acces la firma nu apare', !c7.includes('strain'));
  ok('firma fara membri nu inventeaza contabili', admin.contabiliiFirmei(users, faraPatron).length === 0);
}

section('Administrare: lista de contabili si cererile de servicii');
{
  const firme = [{ id: 3, nume: 'ALFA <SRL>' }];
  const c = {
    id: 9, username: 'ionel', nume: 'Ion "Contabil" Popescu', oras: 'Cluj', telefon: '0712',
    autorizatie: '12/2020', descriere: 'salarizare <b>rapida</b> & declaratii',
  };
  const html = admin.randContabil(c, firme);
  ok('numele extern e escapat in text', html.includes('Ion &quot;Contabil&quot; Popescu') && !html.includes('Ion "Contabil"'));
  ok('descrierea externa nu poate injecta markup', html.includes('&lt;b&gt;rapida&lt;/b&gt;') && !html.includes('<b>rapida'));
  ok('denumirea firmei din <option> e escapata', html.includes('ALFA &lt;SRL&gt;'));
  ok('id-urile ajung in atribute data- pentru butonul de cerere', html.includes('data-id="9"'));
  ok('autorizatia declarata se arata ca pastila', /CECCAR 12\/2020/.test(html));

  const fara = admin.randContabil(c, []);
  ok('fara firme proprii nu se ofera butonul de cerere, ci explicatia', !fara.includes('srv-cere') && /firm[ăa] proprie/i.test(fara));
  ok('...si nici selectorul de firma', !fara.includes('srv-firma'));

  ok('starile cererii au etichete romanesti', admin.STARE_SRV.in_asteptare === 'în așteptare'
    && admin.STARE_SRV.acceptata === 'acceptată' && admin.STARE_SRV.refuzata === 'refuzată' && admin.STARE_SRV.retrasa === 'retrasă');
}


section('Raportarea erorilor din client (core.js: pachetEroare / trebuieRaportata)');
{
  // Evenimentul `error` poarta exceptia in `.error`; `unhandledrejection` o poarta in `.reason`.
  // Ambele forme trebuie sa produca acelasi pachet — altfel jumatate din erori ar pleca fara mesaj.
  const err = new Error('a crapat ceva');
  err.stack = 'Error: a crapat ceva\n    la f (https://x/app.js:10:5)';
  const dinError = core.pachetEroare({ type: 'error', error: err, filename: 'https://x/app.js', lineno: 10, colno: 5 });
  ok('eveniment `error`: mesajul se extrage din .error', dinError.msg === 'a crapat ceva');
  ok('eveniment `error`: sursa e fisier:linie:coloana', dinError.sursa === 'https://x/app.js:10:5');
  ok('eveniment `error`: tipul e „eroare"', dinError.tip === 'eroare');
  ok('eveniment `error`: stiva se preia', /app\.js:10:5/.test(dinError.stack));

  const dinPromisiune = core.pachetEroare({ type: 'unhandledrejection', reason: err });
  ok('respingere de promisiune: mesajul se extrage din .reason', dinPromisiune.msg === 'a crapat ceva');
  ok('respingere de promisiune: tipul e „promisiune"', dinPromisiune.tip === 'promisiune');
  ok('respingere de promisiune: fara filename, sursa ramane goala (nu „undefined:0:0")', dinPromisiune.sursa === '');

  // O respingere cu un sir simplu (`Promise.reject('gata')`) nu are .message — fara ramura asta
  // ar fi ajuns „eroare necunoscuta" si n-am fi stiut niciodata ce s-a intamplat.
  ok('respingere cu sir simplu: sirul devine mesaj', core.pachetEroare({ type: 'unhandledrejection', reason: 'gata' }).msg === 'gata');
  ok('eveniment fara nimic util: mesaj de rezerva, nu gol', core.pachetEroare({}).msg === 'eroare necunoscuta');
  ok('mesajul se taie la 200 inca din client', core.pachetEroare({ message: 'M'.repeat(600) }).msg.length === 200);

  // SECURITATE: din client pleaca DOAR pathname. `location.href` ar fi trimis si interogarea, iar
  // pagina de resetare are tokenul acolo. Serverul taie a doua oara (clientul nu e de incredere),
  // dar prima aparare trebuie sa fie aici — altfel tokenul ar circula prin retea degeaba.
  ok('calea raportata e doar pathname (fara interogare)', !/\?/.test(core.pachetEroare({}).cale));
  ok('interogarea se taie si din filename', core.pachetEroare({ filename: 'https://x/app.js?v=SECRET' }).sursa === 'https://x/app.js:0:0');

  // PLAFON: o bucla de randare poate arunca mii de exceptii pe secunda. Fara plafon si fara
  // deduplicare i-am trimite pe toate — raportorul ar deveni el problema.
  const vazute = new Set();
  const p = core.pachetEroare({ message: 'aceeasi', filename: 'a.js', lineno: 1, colno: 1 });
  ok('prima aparitie se raporteaza', core.trebuieRaportata(p, 0, vazute) === true);
  vazute.add(p.msg + '|' + p.sursa);
  ok('a doua oara aceeasi eroare NU se mai trimite', core.trebuieRaportata(p, 1, vazute) === false);
  const altul = core.pachetEroare({ message: 'alta', filename: 'b.js', lineno: 2, colno: 2 });
  ok('o eroare DIFERITA trece', core.trebuieRaportata(altul, 1, vazute) === true);
  ok('peste plafonul pe pagina nu mai pleaca nimic', core.trebuieRaportata(altul, 5, new Set()) === false);
}


section('Înscriere: din afara aplicației se alege DOAR proba gratuită');
{
  // Regula de produs: planurile plătite se afișează cu preț și funcții (omul trebuie să știe ce
  // urmează), dar NU se pot alege la înscriere — se cumpără din aplicație, după probă, când omul
  // a văzut deja produsul.
  const authui = await imp(mirror, 'authui.js').catch(() => null);
  ok('authui.js se încarcă', !!authui);
  const cta = authui && authui.ctaPlanPublic;
  ok('decizia e o funcție pură, exportată', typeof cta === 'function');

  const proba = cta({ id: 'trial', nume: 'Probă gratuită', trial: true }, true);
  ok('proba gratuită are buton ACTIV', proba.fel === 'buton' && proba.activ === true);
  ok('...cu textul de pornire', /proba gratuită/i.test(proba.text));

  for (const id of ['start', 'pro']) {
    const d = cta({ id, nume: id }, true);
    ok(id + ': control de tip buton, dar INACTIV', d.fel === 'buton' && d.activ === false);
    ok(id + ': textul spune UNDE se alege, nu doar că nu se poate', /după probă/i.test(d.text));
    ok(id + ': explicația completă e în titlu (tooltip)', /aplicaţie|aplicație/i.test(d.titlu || ''));
  }
  const suspendat = cta({ id: 'start', nume: 'Start' }, true, true);
  ok('plăți suspendate: cardul spune direct că planul este indisponibil',
    suspendat.activ === false && /indisponibil/i.test(suspendat.text));

  // Fără înscriere publică activă, niciun plan nu primește buton — nici proba.
  const inchis = cta({ id: 'trial', trial: true }, false);
  ok('înscriere dezactivată -> text, nu buton', inchis.fel === 'text' && /autentifică/i.test(inchis.text));

  // A DOUA implementare: public/prezentare.js e script simplu (nu modul), deci nu poate importa
  // regula — o are dublată. Poarta verifică să nu divergă: acolo planurile plătite trebuie sa aibă
  // `disabled`, iar proba un link activ.
  const prez = fs.readFileSync(path.join(PUB, 'prezentare.js'), 'utf8');
  const appPricing = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  ok('prezentare.js: planurile plătite au buton dezactivat',
    /p\.trial[\s\S]{0,650}?<button class="btn" disabled/.test(prez));
  ok('prezentare.js: suspendarea plăților este explicată în panoul de prețuri',
    /data\.platiSuspendate[\s\S]{0,260}Plățile sunt oprite momentan/.test(prez));
  ok('prezentare.js: proba rămâne link activ către înscriere',
    /p\.trial[\s\S]{0,120}?<a class="btn solid" href="\/\?register=1"/.test(prez));
  ok('prezentare.js: nu mai există „Alege <plan> →" pe planurile plătite', !/Alege '\s*\+\s*H\(p\.nume\)/.test(prez));
  ok('toate cele trei grile afișează moneda și unitatea ca lei/lună/firmă, fără spații ambigue',
    [prez, fs.readFileSync(path.join(PUB, 'authui.js'), 'utf8'), appPricing]
      .every((src) => /H\(p\.moneda \+ '\/' \+ p\.perioada\)/.test(src)));

  // Mecanismul de „alege plan platit la inscriere, plateste dupa" a fost SCOS, nu ascuns: lasat in
  // cod ar fi fost o cale moarta care pare vie (vezi lectia din src/saft.js).
  const au = fs.readFileSync(path.join(PUB, 'authui.js'), 'utf8');
  ok('mecanismul de plată imediat după înscriere e scos din cod', !/pendingPaidPlan/.test(au));
}
section('Paginare (public/paginare.js) — calculul poziției');
{
  const S = pag.stare;

  // Cazul obișnuit.
  const a = S(893, 0, 50);
  eq('pagina 1 din 18', a.pagina + '/' + a.pagini, '1/18');
  eq('intervalul afișat', a.deLa + '–' + a.panaLa, '1–50');
  ok('pe prima pagină, „înapoi" e blocat', a.prima === true && a.ultima === false);
  const b = S(893, 850, 50);
  eq('ultima pagină e parțială', b.deLa + '–' + b.panaLa, '851–893');
  ok('pe ultima pagină, „înainte" e blocat', b.ultima === true);

  // NORMALIZAREA poziției. Fără ea, o pagină golită (după o ștergere sau după un filtru mai
  // strict) ar lăsa un tabel gol PESTE date care există — un bug care arată exact ca „nu am date".
  const c = S(12, 500, 50);
  eq('offset dincolo de sfârșit -> ultima pagină', c.offset, 0);
  eq('...cu intervalul corect', c.deLa + '–' + c.panaLa, '1–12');
  const d = S(120, 500, 50);
  eq('offset mult peste total -> ultima pagină reală', d.offset, 100);
  eq('...adică pagina 3 din 3', d.pagina + '/' + d.pagini, '3/3');
  const e = S(893, 37, 50);
  eq('offset nealiniat se aliniază la marginea paginii', e.offset, 0);
  const f = S(893, 137, 50);
  eq('...și pentru o pagină din mijloc', f.offset, 100);

  // Margini.
  eq('zero rânduri -> o pagină, interval gol', S(0, 0, 50).pagini + '/' + S(0, 0, 50).deLa, '1/0');
  ok('zero rânduri: și prima, și ultima', S(0, 0, 50).prima === true && S(0, 0, 50).ultima === true);
  eq('limit invalid cade pe implicit', S(100, 0, 0).limit, pag.MARIME_IMPLICITA);
  eq('offset negativ devine 0', S(100, -20, 50).offset, 0);
  eq('total exact cât o pagină -> o singură pagină', S(50, 0, 50).pagini, 1);
  eq('total cu unul peste -> două pagini', S(51, 0, 50).pagini, 2);

  // Controalele apar când există MAI MULT DE O PAGINĂ, raportat la limita chiar folosită.
  ok('30 de rânduri la 50/pagină: paginarea nu e necesară', S(30, 0, 50).necesara === false);
  ok('...iar bara nici nu se randează', pag.controaleHtml(S(30, 0, 50), 'x', 'rânduri') === '');
  ok('893 de rânduri: paginarea e necesară', S(893, 0, 50).necesara === true);
  // Regresia care a costat: cartea mare merge pe 10 conturi. Cu regula veche („mai mult decât cea
  // mai mică mărime standard, 50") lista era tăiată la 10 din 19 și bara NU apărea — nouă conturi
  // inaccesibile, fără niciun semn că există.
  ok('19 elemente la 10/pagină: paginarea E necesară', S(19, 0, 10).necesara === true);
  ok('...și bara chiar se randează', pag.controaleHtml(S(19, 0, 10), 'carte', 'conturi') !== '');
  ok('...cu mărimea nestandard prezentă în listă, ca opțiune selectată',
    pag.controaleHtml(S(19, 0, 10), 'carte', 'conturi').includes('value="10" selected'));
  ok('exact o pagină plină: fără controale', S(10, 0, 10).necesara === false);

  // Rezumatul.
  eq('rezumat pe mai multe pagini', pag.rezumat(S(893, 50, 50), 'acțiuni'), '51–100 din 893 acțiuni');
  eq('rezumat cand incape tot', pag.rezumat(S(12, 0, 50), 'conturi'), '12 conturi');
  eq('rezumat gol', pag.rezumat(S(0, 0, 50), 'conturi'), 'niciun rând');

  // HTML-ul: butoanele se dezactivează la capete, iar identificatorul e escapat.
  const h1 = pag.controaleHtml(S(893, 0, 50), 'audit', 'acțiuni');
  ok('prima pagină: „Prima" și „Înapoi" sunt disabled',
    /pg-prim" disabled/.test(h1) && /pg-inapoi" disabled/.test(h1));
  ok('...dar „Înainte" nu', /pg-inainte" (?!disabled)/.test(h1) || !/pg-inainte" disabled/.test(h1));
  const h2 = pag.controaleHtml(S(893, 850, 50), 'audit', 'acțiuni');
  ok('ultima pagină: „Înainte" și „Ultima" sunt disabled',
    /pg-inainte" disabled/.test(h2) && /pg-ultim" disabled/.test(h2));
  ok('mărimile de pagină apar ca opțiuni', pag.MARIMI.every((m) => h1.includes('value="' + m + '"')));
  ok('mărimea curentă e selectată', h1.includes('value="50" selected'));
  ok('identificatorul barei e escapat', !pag.controaleHtml(S(893, 0, 50), '"><img src=x>', 'r').includes('<img'));
}

section('Ghid: modelul se DERIVA din meniul aplicatiei (public/ghid.js)');
{
  // Pictograma se desparte de text ca in erp.js — de asta atarna si eticheta din meniu, si cea
  // de pe celula de cuprins.
  eq('emoji + text se despart', JSON.stringify(ghid.despartePictograma('📥 Documente & facturi')),
    JSON.stringify({ ic: '📥', txt: 'Documente & facturi' }));
  eq('fara emoji -> doar text', JSON.stringify(ghid.despartePictograma('Setări')),
    JSON.stringify({ ic: '', txt: 'Setări' }));
  eq('sir gol nu arunca', JSON.stringify(ghid.despartePictograma('')), JSON.stringify({ ic: '', txt: '' }));

  // `textCurat` scoate bulele de ajutor injectate de panel-info.js. Fara el, eticheta butonului
  // ieșea „Deschide «Solduri conturi (balanța de verificare)iBalanța de verificare cu cele…»" —
  // defect REAL, prins pe captura, nu de teste.
  const falsNod = (txt, copii) => ({
    cloneNode: () => falsNod(txt, copii),
    querySelectorAll: (sel) => (copii || []).filter((c) => sel.includes(c.cls)),
    get textContent() { return txt; },
  });
  const cuBula = falsNod('Solduri conturi  i Balanța de verificare cu…',
    [{ cls: 'cinfo', remove() { /* scos din clona */ } }]);
  ok('textCurat normalizeaza spatiile', ghid.textCurat(cuBula).indexOf('  ') === -1);
  eq('textCurat pe nod lipsa -> sir gol', ghid.textCurat(null), '');

  // Modelul: grup -> submeniuri, citit din structura de navigare.
  const btn = (tab, et) => ({ getAttribute: (a) => (a === 'data-tab' ? tab : null), textContent: et });
  const grup = (lbl, itemi) => ({
    querySelector: (sel) => (sel === '.navlabel' ? { textContent: lbl } : null),
    querySelectorAll: () => itemi,
  });
  const tabs = {
    querySelectorAll: () => [
      grup('📒 Registre contabile', [btn('jurnal', 'Toate operațiunile (jurnal)'), btn('balanta', 'Solduri conturi (balanță)')]),
      grup('🔒 Închideri', [btn('inchideri', 'Închiderea lunii')]),
      grup('Gol', []), // grup fara intrari: nu are ce cauta in cuprins
    ],
  };
  const m = ghid.modelGhid(tabs);
  eq('grupurile cu intrari intra in model, cele goale nu', m.length, 2);
  eq('numele grupului, fara pictograma', m[0].nume, 'Registre contabile');
  eq('pictograma grupului se pastreaza', m[0].ic, '📒');
  eq('submeniurile pastreaza tabul tinta', m[0].itemi.map((i) => i.tab).join(','), 'jurnal,balanta');
  eq('...si eticheta lor', m[0].itemi[1].eticheta, 'Solduri conturi (balanță)');
  ok('container lipsa nu arunca', Array.isArray(ghid.modelGhid(null)) && ghid.modelGhid(null).length === 0);

  // Regresie reala: familia `.em-*` era stilata in erp.css pe vremea barei de meniu din carcasa.
  // Trecerea la o singura navigatie a scos regulile, dar ghidul a ramas singurul consumator —
  // iar fara `display: none` fiecare lista derulanta sta deschisa si cuprinsul se scurge ca un
  // perete de text. Modelul era corect, deci NICIO poarta pe model n-avea cum s-o vada.
  // Comentariile se scot ÎNAINTE de orice potrivire: nota care explică regula conține ea însăși
  // „.em-pop { display: none }", deci poarta trecea citind explicația, nu declarația (prins prin
  // mutație — a treia oară în această sesiune când o ancoră se hrănește din propriul text).
  const cssGhid = ['design-system.css', 'erp.css', 'styles.css']
    .map((f) => fs.readFileSync(path.join(PUB, f), 'utf8')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // Atributul poate purta MAI MULTE clase (`el('div', 'card ghid-pagina')`); un regex care se
  // oprește la primul cuvânt ar fi ratat exact `.ghid-pagina`, deci se despart pe spații.
  const claseGhid = [...fs.readFileSync(path.join(PUB, 'ghid.js'), 'utf8')
    .matchAll(/el\('[a-z]+',\s*'([a-z0-9 -]+)'/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  // Potrivirea cere GRANIȚĂ de selector: `includes('.ghid-cel-d')` e adevărat și pentru
  // `.ghid-cel-dXX`, deci poarta ar fi trecut cu regula redenumită — prins prin mutație.
  const areRegula = (c) => new RegExp('\\.' + c.replace(/[-]/g, '\\-') + '(?![a-zA-Z0-9_-])').test(cssGhid);
  const fara = [...new Set(claseGhid.filter((c) => !areRegula(c)))];
  ok('fiecare clasă pe care o produce ghid.js are reguli în CSS' +
    (fara.length ? ' — LIPSESC: ' + fara.join(', ') : ''),
    claseGhid.length > 0 && fara.length === 0);
  ok('listele derulante ale cuprinsului pornesc ÎNCHISE',
    /\.em-pop\s*\{[^}]*display:\s*none/.test(cssGhid));
  ok('...și se deschid pe clasa de stare pusă de ghid.js',
    /\.em-item\.open\s*>\s*\.em-pop\s*\{[^}]*display:\s*block/.test(cssGhid)
      && /classList\.add\('open'\)/.test(fs.readFileSync(path.join(PUB, 'ghid.js'), 'utf8')));
}

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
