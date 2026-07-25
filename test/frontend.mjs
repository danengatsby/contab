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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
await import(path.join(ROOT, 'test', 'dom-shim.mjs'));
const core = await import(path.join(mirror, 'core.js'));
const periods = await import(path.join(mirror, 'periods.js'));
const entries = await import(path.join(mirror, 'entries.js'));
const plan = await import(path.join(mirror, 'plan.js'));
const dashboard = await import(path.join(mirror, 'dashboard.js'));

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
const utilRound2 = (await import(path.join(ROOT, 'src', 'util.js'))).default.round2;
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

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
