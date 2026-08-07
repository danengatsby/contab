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

section('Bara de sus pe telefon: nu are voie să crească la loc');
{
  // Măsurat înainte: 340px din 844 (40% din ecran) înainte de orice conținut, fiindcă cele șase
  // utilitare stăteau într-o grilă 2x3 mereu deschisă. Azi: 113px (13%). Câștigul e fragil —
  // se pierde la PRIMUL buton nou pus direct în bară, iar defectul e invizibil pe desktop, unde
  // bara e sidebar vertical și mai încape orice. Deci poarta: în `.topbar`, în afara `.side-tools`
  // și a meniului, au voie să stea doar comenzile din listă. Un buton nou merge în `.side-tools`.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const cap = html.indexOf('<header class="topbar">');
  const meniu = html.indexOf('<nav class="tabs"', cap);
  ok('poarta chiar găsește bara de sus', cap >= 0 && meniu > cap);
  const bara = html.slice(cap, meniu).replace(/<div class="side-tools"[\s\S]*?<\/div>/, ' ');
  ok('poarta chiar a scos uneltele din perimetru', !bara.includes('id="glossaryBtn"'));
  const PERMISE = new Set(['prevMonth', 'nextMonth', 'toolsBtn', 'logoutBtn']);
  const inBara = [...bara.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  const intruse = inBara.filter((id) => !PERMISE.has(id));
  ok('nimic nou permanent în bara de telefon'
    + (intruse.length ? ' — MUTĂ-LE ÎN .side-tools: ' + intruse.join(', ') : ''), intruse.length === 0);
  ok('poarta chiar vede butoane (nu o listă goală)', inBara.length >= 3);

  // Uneltele strânse trebuie să rămână AJUNGIBILE: butonul care le desfășoară există și le arată.
  ok('butonul „⋯ Unelte" există', html.includes('id="toolsBtn"'));
  ok('...și declară ce comandă', /id="toolsBtn"[^>]*aria-controls="sideTools"/.test(html));
  ok('...iar containerul lui există cu acel id', html.includes('id="sideTools"'));
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  ok('pe desktop butonul nu există vizual', /#toolsBtn\{display:none\}/.test(css));
  ok('pe telefon uneltele pornesc strânse', /\.topbar \.side-tools\{order:6;display:none/.test(css));
  ok('...și se desfășoară pe clasa comutată din JS', /\.topbar\.tools-open \.side-tools\{display:grid\}/.test(css));
  const js = fs.readFileSync(path.join(PUB, 'simplemode.js'), 'utf8');
  ok('comutatorul chiar pune clasa aceea', /classList\.toggle\('tools-open'\)/.test(js));
  // Panoul trebuie să se închidă după alegerea unei unelte — altfel rămâne deschis peste pagina
  // pe care tocmai ai cerut-o, adică exact ecranul pentru care ai apăsat.
  ok('panoul se închide la alegerea unei unelte', /#sideTools[\s\S]{0,220}remove\('tools-open'\)/.test(js));
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
  ok('poarta chiar vede textul vizibil', vizibilInSimplu.includes('Ce vrei să faci?'));

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

section('Declarații: insigna de stare și sensul provizionului');
ok('starea „depusă" își arată eticheta', livrabile.declBadge('depusa', false).includes('Depusă'));
ok('starea „eroare" își arată eticheta', livrabile.declBadge('eroare', false).includes('Eroare'));
// o stare necunoscuta NU trebuie sa lase insigna goala: cade pe „nedepusă" (cel mai prudent)
ok('starea necunoscută cade pe „Nedepusă", nu pe gol', livrabile.declBadge('inventata', false).includes('Nedepusă'));
ok('starea lipsă cade tot pe „Nedepusă"', livrabile.declBadge(undefined, false).includes('Nedepusă'));
ok('restanța e marcată separat de stare', livrabile.declBadge('nedepusa', true).includes('restanță'));
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
ok('numărul de rânduri cu diferențe apare în insignă', etvaHtml.includes('1 rând(uri) cu diferențe'));
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

  const hBlocat = inchidere.stepHtml(pasBlocat, resp);
  ok('pasul blocat spune CE îl ține', hBlocat.includes('Așteaptă pasul anterior'));
  ok('numele pasului care blochează e escapat', hBlocat.includes('&lt;b&gt;complete&lt;/b&gt;'));

  // Antetul: progres, verdict, aprobare, forțare (cu motivul scris de om)
  const stBaza = { period: '2026-06', progres: { gata: 3, total: 6, procent: 50 }, sePoateInchide: false, inchisa: false, ancoraTermen: '2026-07-25', aprobare: null, fortata: null, steps: [] };
  const hHead = inchidere.closeHeaderHtml(stBaza);
  ok('bara de progres reflectă procentul', hHead.includes('width:50%'));
  ok('verdictul spune câți pași au rămas', hHead.includes('3 pas'));
  const hGataHead = inchidere.closeHeaderHtml(Object.assign({}, stBaza, { sePoateInchide: true, progres: { gata: 5, total: 5, procent: 100 } }));
  ok('când totul e gata, verdictul o spune', hGataHead.includes('se poate închide'));
  const hForced = inchidere.closeHeaderHtml(Object.assign({}, stBaza, {
    fortata: { motiv: 'depus <b>manual</b> pe portal', username: 'ad<min', at: '2026-07-20T08:00:00Z', blocante: ['D<300'] },
  }));
  ok('forțarea e afișată vizibil, cu motivul', hForced.includes('warnbox') && hForced.includes('forțată'));
  ok('motivul forțării e escapat', hForced.includes('&lt;b&gt;manual&lt;/b&gt;') && !hForced.includes('<b>manual'));
  ok('numele celui care a forțat e escapat', hForced.includes('ad&lt;min'));
  ok('pașii nerezolvați la forțare sunt escapați', hForced.includes('D&lt;300'));
  const hAprob = inchidere.closeHeaderHtml(Object.assign({}, stBaza, { aprobare: { username: 'ma<ria', at: '2026-07-20T08:00:00Z', nota: 'ok <b>' } }));
  ok('aprobarea arată cine și când, escapat', hAprob.includes('ma&lt;ria') && hAprob.includes('ok &lt;b&gt;'));

  // Tabelul dovezilor de validare
  const stDecl = {
    steps: [{ key: 'declaratii', detalii: { declaratii: [
      { tip: 'd300', nume: 'D300 — decont TVA', due: '2026-07-25', status: 'depusa', overdue: false, dovada: { at: '2026-07-20T09:30:00Z', username: 'ma<ria', ok: true, errors: 0, warnings: 1 } },
      { tip: 'd394', nume: 'D394 — <b>info</b>', due: '2026-07-25', status: 'generata', overdue: true, dovada: { at: '2026-07-20T09:31:00Z', username: 'x', ok: false, errors: 2, warnings: 0 } },
      { tip: 'saft', nume: 'D406 — SAF-T', due: '2026-07-31', status: 'nedepusa', overdue: false, dovada: null },
    ] } }],
  };
  const hProof = inchidere.proofsHtml(stDecl, [{ tip: 'd300' }, { tip: 'd394' }]);
  eq('starea se afișează în scriere românească, nu valoarea internă', inchidere.statusLabel('nedepusa'), 'nedepusă');
  eq('statusul necunoscut nu se pierde', inchidere.statusLabel('altceva'), 'altceva');
  eq('statusul lipsă dă liniuță', inchidere.statusLabel(undefined), '—');
  ok('tabelul folosește eticheta, nu valoarea brută', hProof.includes('nedepusă') && !hProof.includes('>nedepusa<'));
  ok('dovada fără erori se vede ca atare', hProof.includes('fără erori'));
  ok('dovada cu erori arată numărul', hProof.includes('2 eroare/erori'));
  ok('declarația nevalidată e marcată', hProof.includes('nevalidată'));
  ok('butonul de validare apare doar pentru tipurile validabile', (hProof.match(/cl-val/g) || []).length === 2);
  ok('numele declarației e escapat', hProof.includes('D394 — &lt;b&gt;info&lt;/b&gt;'));
  ok('numele validatorului e escapat', hProof.includes('ma&lt;ria'));
  eq('fără declarații așteptate: mesaj, nu tabel gol', inchidere.proofsHtml({ steps: [] }, []).includes('<table>'), false);
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
  ok('postarea automată se anunță ca atare, cu articolul creat', hAuto.includes('postat automat') && hAuto.includes('e42'));
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

  // Fără înscriere publică activă, niciun plan nu primește buton — nici proba.
  const inchis = cta({ id: 'trial', trial: true }, false);
  ok('înscriere dezactivată -> text, nu buton', inchis.fel === 'text' && /autentifică/i.test(inchis.text));

  // A DOUA implementare: public/prezentare.js e script simplu (nu modul), deci nu poate importa
  // regula — o are dublată. Poarta verifică să nu divergă: acolo planurile plătite trebuie sa aibă
  // `disabled`, iar proba un link activ.
  const prez = fs.readFileSync(path.join(PUB, 'prezentare.js'), 'utf8');
  ok('prezentare.js: planurile plătite au buton dezactivat',
    /p\.trial[\s\S]{0,400}?<button class="btn" disabled/.test(prez));
  ok('prezentare.js: proba rămâne link activ către înscriere',
    /p\.trial[\s\S]{0,120}?<a class="btn solid" href="\/\?register=1"/.test(prez));
  ok('prezentare.js: nu mai există „Alege <plan> →" pe planurile plătite', !/Alege '\s*\+\s*H\(p\.nume\)/.test(prez));

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

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
