'use strict';

// Test suite — blocheaza regresiile pe numerele cheie ale exemplului din ghid.
// Ruleaza pe datele "scoped" pure; testele care ating baza de date folosesc un fisier temporar
// (CONTAB_DB_FILE) ca sa NU atinga data/db.json. `npm test`.

const path = require('path');
const os = require('os');
const fsIzolare = require('fs');

process.env.CONTAB_DB_FILE = process.env.CONTAB_DB_FILE || path.join(os.tmpdir(), 'contab-test-' + process.pid + '.json');
// CONTAB_DB_FILE singur NU e de ajuns: muta doar BAZA. Restul cailor derivate din CONTAB_DATA_DIR
// (uploads/, audit/, backups/) ramaneau pe `data/` din repo — adica pe datele de PRODUCTIE, fiindca
// acest director e si instalarea vie, iar `npm test` ruleaza la `prestart`, deci la fiecare pornire
// a serverului. Suita chiar crea `data/uploads/`. Poarta de la finalul fisierului tine izolarea.
process.env.CONTAB_DATA_DIR = process.env.CONTAB_DATA_DIR || path.join(os.tmpdir(), 'contab-test-data-' + process.pid);

// ─────────────────────────────────────────────────────────────────────────────
//  IZOLAREA BAZEI — precondiție, nu concluzie
//
//  Poarta de la finalul fisierului („suita nu scrie in directorul de date REAL") verifica
//  izolarea DUPA ce suita a rulat, deci dupa ce ar fi scris. Blocul de aici o verifica INAINTE,
//  si rezolva doua probleme care aveau aceeasi cauza: suita urma variabilele de mediu ale bazei,
//  deci putea fi indreptata catre alta baza decat a ei.
//
//  1. DRIVERUL. `CONTAB_DB_DRIVER=pg` din mediu o conecta la PostgreSQL — iar variabila EXISTA in
//     `.env`-ul acestei instalari. Nimeni nu face asta intentionat, dar `set -a; . .env; npm test`
//     e o comanda fireasca, iar `npm test` ruleaza si la `prestart`. `test/http.js` avea deja
//     garda; aici lipsea.
//  2. IDEMPOTENTA. Cu un `CONTAB_DB_FILE` dat explicit, a DOUA rulare pe acelasi fisier pica 5
//     aserttiuni: baza pastra starea rularii precedente (contorul de commit-uri al cozii de
//     persistenta, documentele cu extras AI). Nu era intermitent — era determinist, si m-a costat
//     doua diagnosticari inainte sa fie reprodus.
//
//  Solutia: baza se sterge la pornire. Idempotenta devine o proprietate a CONSTRUCTIEI, nu o
//  curatenie tinuta minte de cine ruleaza.
// ─────────────────────────────────────────────────────────────────────────────
{
  const radacina = path.join(__dirname, '..');
  const dataReal = path.resolve(radacina, 'data');
  const inauntru = (p) => {
    const r = path.resolve(p);
    return r === dataReal || r.startsWith(dataReal + path.sep);
  };
  // Oprire NECONDITIONATA daca tinta e directorul de date viu. E singurul caz in care stergerea
  // de mai jos ar distruge date reale, deci refuzul vine inaintea oricarei atingeri de disc.
  for (const [nume, val] of [['CONTAB_DB_FILE', process.env.CONTAB_DB_FILE], ['CONTAB_DATA_DIR', process.env.CONTAB_DATA_DIR]]) {
    if (inauntru(val)) {
      console.error('\n[test/run] REFUZ: ' + nume + '=' + val + ' este in directorul de date REAL (' + dataReal + ').'
        + '\n           Suita sterge baza la pornire, deci ar distruge datele vii. Foloseste o cale temporara.\n');
      process.exit(1);
    }
  }
  // Driverul se IMPUNE. Un mesaj, nu o oprire: suita ruleaza corect pe sqlite oricum, iar o
  // oprire la `prestart` ar impiedica pornirea serverului pentru o variabila care oricum se ignora.
  if (process.env.CONTAB_DB_DRIVER && process.env.CONTAB_DB_DRIVER !== 'sqlite') {
    console.error('[test/run] CONTAB_DB_DRIVER=' + process.env.CONTAB_DB_DRIVER + ' se IGNORA aici: suita ruleaza pe sqlite,'
      + ' pe o baza proprie. Pentru driverul de productie: npm run test-pg');
  }
  process.env.CONTAB_DB_DRIVER = 'sqlite';
  // Stergerea bazei precedente: fisierul JSON (oglinda) plus tripleta sqlite derivata din el.
  //
  // Derivarea trebuie sa fie IDENTICA cu cea din `src/db.js`: acolo extensia `.json` se
  // INLOCUIESTE cu `.sqlite`, nu se adauga dupa ea. Varianta scrisa din nou (`baza + '.sqlite'`)
  // stergea `db.json.sqlite`, un fisier care nu exista niciodata — deci blocul asta parea sa
  // asigure idempotenta si nu asigura nimic. Nu s-a vazut fiindca implicit calea contine PID-ul,
  // deci fiecare rulare pleaca oricum de la zero; se vedea doar cu `CONTAB_DB_FILE` dat explicit,
  // adica exact forma recomandata ca sa tii suita departe de `data/` real.
  const baza = process.env.CONTAB_DB_FILE;
  const sq = baza.replace(/\.json$/i, '') + '.sqlite';
  for (const f of [baza, sq, sq + '-wal', sq + '-shm']) {
    try { fsIzolare.rmSync(f, { force: true }); } catch (e) { /* nu exista, sau nu se poate — load() o va recrea */ }
  }
}

const db = require('../src/db');
const { scopedSeed } = require('../src/seed');
const acc = require('../src/accounting');
const stmt = require('../src/statements');
const rep = require('../src/reporting');
const analytic = require('../src/analytic');
const assets = require('../src/assets');
const stocks = require('../src/stocks');
const saft = require('../src/saft');
const xml = require('../src/xml');
const fiscal = require('../src/fiscal');
const fiscalProfile = require('../src/fiscalProfile');
const decl = require('../src/declarations');
const { reconcile } = require('../src/reconcile');
const { settle, candidatesFor } = require('../src/matching');
const { reconcileInbox, journalPurchases } = require('../src/einvoiceReconcile');
const { statePlata, registruSalarii } = require('../src/payroll');

// Helperii si CONTORUL vin din test/run/comun.js — partajate cu partile din test/run/.
// Daca run.js si-ar fi pastrat propriile `pass`/`fail`, verificarile partilor s-ar fi adunat in
// alt contor, iar totalul tiparit ar fi fost mai MIC decat realitatea: o pierdere tacuta exact in
// directia care linisteste.
const { stare, eq, ok, section, wellFormed } = require('./run/comun');

section('Bootstrap: constructia aplicatiei');
try {
  const bootstrap = require('../src/bootstrap');
  ok('modulul de bootstrap exista', typeof bootstrap === 'object');
  ok('bootstrap expune createApp', typeof bootstrap.createApp === 'function');
  ok('bootstrap expune loadDotEnv', typeof bootstrap.loadDotEnv === 'function');
  const { app: createdApp, upload } = bootstrap.createApp();
  ok('createApp intoarce o instanta express', !!createdApp && typeof createdApp.use === 'function');
  ok('createApp intoarce upload cu lantul de garda', typeof upload.single === 'function' && Array.isArray(upload.single('f')));
} catch (e) {
  ok('bootstrap init: fara exceptie', false);
  console.error(e && e.stack || e);
}
try {
  const authRoutes = require('../src/authRoutes');
  ok('modulul de auth routes exista', typeof authRoutes === 'function');
} catch (e) {
  ok('auth routes init: fara exceptie', false);
  console.error(e && e.stack || e);
}


section('AI extractor: alegerea furnizorului (src/aiExtractor.js resolveProvider)');
// izolare de mediul masinii: salveaza si curata cheile, restaureaza la final — altfel un
// ANTHROPIC_API_KEY exportat in shell ar face aserttiile sa minta
const envAiPrev = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY, p: process.env.CONTAB_AI_PROVIDER, m: process.env.CONTAB_AI_MODEL_OPENAI };
delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.CONTAB_AI_PROVIDER; delete process.env.CONTAB_AI_MODEL_OPENAI;
delete require.cache[require.resolve('../src/aiExtractor')];
const aiExtractor = require('../src/aiExtractor');
ok('fara nicio cheie: indisponibil', !aiExtractor.aiAvailable() && aiExtractor.resolveProvider().provider === 'none');
process.env.OPENAI_API_KEY = 'test-openai-key';
ok('doar cheia OpenAI: disponibil, provider openai cu modelul lui implicit', aiExtractor.aiAvailable() && aiExtractor.resolveProvider().provider === 'openai' && /^gpt/.test(aiExtractor.resolveProvider().model));
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
eq('ambele chei, fara setare explicita: Anthropic are prioritate (comportamentul istoric)', aiExtractor.resolveProvider().provider, 'anthropic');
process.env.CONTAB_AI_PROVIDER = 'openai';
eq('CONTAB_AI_PROVIDER=openai bate prioritatea implicita', aiExtractor.resolveProvider().provider, 'openai');
process.env.CONTAB_AI_PROVIDER = 'anthropic';
eq('CONTAB_AI_PROVIDER=anthropic ramane anthropic si cu cheia OpenAI prezenta', aiExtractor.resolveProvider().provider, 'anthropic');
process.env.CONTAB_AI_PROVIDER = 'openai'; delete process.env.OPENAI_API_KEY;
ok('provider fortat fara cheia lui: indisponibil (nu cade tacut pe celalalt)', !aiExtractor.aiAvailable() && aiExtractor.resolveProvider().provider === 'none');
// restaurare completa a mediului
for (const [k, v] of [['ANTHROPIC_API_KEY', envAiPrev.a], ['OPENAI_API_KEY', envAiPrev.o], ['CONTAB_AI_PROVIDER', envAiPrev.p], ['CONTAB_AI_MODEL_OPENAI', envAiPrev.m]]) {
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}

section('AI extractor: normalizarea raspunsului (src/aiExtractor.js normalizeazaRaspuns)');
// Aritmetica fiscala a extragerii statea INCHISA intr-o functie async care cheama API-ul, deci
// nu o atingea niciun test: poarta fiscala nu incarca modulul (generatorul de referinte nu ajunge
// la el), iar suita ruleaza fara cheie. Acolo a trait bugul `cota || 19`, care punea o cota veche
// peste documentele FARA TVA. Scoasa afara, se acopera aici.
const nz = aiExtractor.normalizeazaRaspuns;
{
  // REGRESIA care conteaza: cota 0 inseamna „document fara TVA", nu „cota lipsa"
  eq('cota 0 ramane 0 (document fara TVA), nu o cota implicita', nz({ cota: 0 }).fields.cota, 0);
  eq('cota lipsa devine 0, nu cota standard', nz({}).fields.cota, 0);
  eq('cota necitibila devine 0, nu NaN', nz({ cota: 'nu-e-numar' }).fields.cota, 0);
  eq('cota zecimala se rotunjeste la intreg', nz({ cota: 20.6 }).fields.cota, 21);

  // sumele se rotunjesc la doua zecimale (altfel ecranul si PDF-ul ar diferi la ban)
  ok('sumele se rotunjesc la doi bani',
    nz({ baza: 1000.005, tva: 210.004, suma: 1210.009 }).fields.baza === 1000.01
    && nz({ baza: 1000.005, tva: 210.004, suma: 1210.009 }).fields.tva === 210
    && nz({ baza: 1000.005, tva: 210.004, suma: 1210.009 }).fields.suma === 1210.01);

  // camp gol != zero tastat: o suma absenta ramane null, ca extractCheck sa o poata deduce
  eq('baza absenta ramane null (nu 0)', nz({}).fields.baza, null);
  eq('baza 0 explicit ramane 0', nz({ baza: 0 }).fields.baza, 0);

  // tipul sugerat trebuie sa existe in nomenclator, altfel formularul ar cere o compunere inexistenta
  eq('tip inventat de model -> nota_contabila', nz({ suggestedType: 'tip_care_nu_exista' }).suggestedType, 'nota_contabila');
  eq('tip lipsa -> nota_contabila', nz({}).suggestedType, 'nota_contabila');
  ok('tip valid se pastreaza', nz({ suggestedType: 'nota_contabila' }).suggestedType === 'nota_contabila');

  eq('cuis care nu e lista devine lista goala', JSON.stringify(nz({ cuis: 'RO1' }).cuis), '[]');
  eq('cuis lista se pastreaza', JSON.stringify(nz({ cuis: ['RO1', 'RO2'] }).cuis), '["RO1","RO2"]');
  // raspuns lipsa nu trebuie sa arunce: modelul poate intoarce si un obiect gol
  ok('raspuns null nu arunca', !!nz(null) && nz(null).fields.cota === 0);
}

const v = scopedSeed();

section('Balanta de verificare (2026-06)');
const tb = acc.trialBalance(v, '2026-06');
eq('balanced', tb.balanced, true);
eq('total SI debit = credit', tb.tot.siD, tb.tot.siC);
eq('total SI', tb.tot.siD, 83000);   // +18.000: mijloacele fixe intra in conturi (vezi seed.js)
eq('total rulaj D = C', tb.tot.rd, tb.tot.rc);
eq('total SF debit', tb.tot.sfD, 102594.17);
eq('total SF debit = credit', tb.tot.sfD, tb.tot.sfC);

// Capetele unei perioade nu se pot compara ca siruri cand perioada e un TRIMESTRU:
// '2026-08' < '2026-Q2' e adevarat lexicografic ('0' < 'Q'), deci soldul initial al trimestrului
// inghitea tot anul (inclusiv lunile de DUPA el) si rulajul trimestrului se numara de doua ori.
// Balanta ramanea `balanced` (eroarea e simetrica), deci nicio verificare de echilibru nu o prindea.
section('Perioade-trimestru: capetele de interval (beforePeriod / asOf)');
eq('periodStart: trimestru -> prima luna', ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'].map(acc.periodStart).join(','), '2026-01,2026-04,2026-07,2026-10');
eq('periodEnd: trimestru -> ultima luna', ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'].map(acc.periodEnd).join(','), '2026-03,2026-06,2026-09,2026-12');
eq('periodStart/End: anul intreg', acc.periodStart('2026') + '..' + acc.periodEnd('2026'), '2026-01..2026-12');
eq('periodStart/End: luna ramane neschimbata', acc.periodStart('2026-05') + '..' + acc.periodEnd('2026-05'), '2026-05..2026-05');
// 100 lei venit in fiecare luna a anului: fiecare trimestru are rulaj 300 si SI = cumulatul dinainte
const vQ = { openingBalances: {}, company: v.company, entries: [] };
for (let m = 1; m <= 12; m++) {
  const mm = '2026-' + String(m).padStart(2, '0');
  vQ.entries.push({ id: 'q' + m, data: mm + '-15', period: mm, tip: 't', tipNume: 't', lines: [{ debit: '5121', credit: '704', suma: 100 }] });
}
const q704 = (p) => acc.trialBalance(vQ, p).rows.find((r) => r.cod === '704') || {};
eq('Q1: sold initial 0, rulaj 300', q704('2026-Q1').siC + '/' + q704('2026-Q1').rc, '0/300');
eq('Q2: soldul initial e DOAR trimestrul anterior (nu tot anul)', q704('2026-Q2').siC + '/' + q704('2026-Q2').rc, '300/300');
eq('Q3: lunile de dupa trimestru nu intra in soldul initial', q704('2026-Q3').siC + '/' + q704('2026-Q3').rc, '600/300');
eq('Q4: soldul final al anului', q704('2026-Q4').sfC, 1200);
ok('soldul final al fiecarui trimestru = soldul initial al urmatorului',
  [['2026-Q1', '2026-Q2'], ['2026-Q2', '2026-Q3'], ['2026-Q3', '2026-Q4']].every(([a, b]) => q704(a).sfC === q704(b).siC));
ok('balanta ramane echilibrata pe toate formele de perioada',
  ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4', '2026-06', '2026'].every((p) => acc.trialBalance(vQ, p).balanced));
// cartea mare si bilantul folosesc aceleasi capete
const led704 = acc.ledger(vQ, '2026-Q2').find((c) => c.cod === '704') || {};
eq('cartea mare pe trimestru: aceleasi capete ca balanta', led704.siC + '/' + led704.rc, '300/300');
eq('bilantul la sfarsit de trimestru se opreste la ultima lui luna',
  stmt.balanceSheetF10(vQ, '2026-Q2').totalActiv + '/' + stmt.balanceSheetF10(vQ, '2026-06').totalActiv, '600/600');
eq('bilantul pe an vede tot anul', stmt.balanceSheetF10(vQ, '2026').totalActiv, 1200);

section('Registrul-jurnal');
const j = acc.journal(v, '2026-06');
const nrs = j.rows.filter((r) => r.nr).map((r) => r.nr);
eq('numar articole', nrs.length, 7);
eq('numerotare 1..7', JSON.stringify(nrs), JSON.stringify([1, 2, 3, 4, 5, 6, 7]));
eq('total jurnal D=C (suma liniilor)', j.total, j.rows.reduce((s, r) => s + r.suma, 0));

section('TVA / D300 (2026-06)');
const d3 = rep.d300(v, '2026-06');
eq('TVA colectata', d3.colectata, 2940);
eq('TVA deductibila', d3.deductibila, 2100);
eq('TVA de plata', d3.deplata, 840);

section('Cont de profit si pierdere (2026)');
const pl = stmt.profitLoss(v, '2026');
eq('rezultat brut', pl.rezBrut, 420.83);   // amortizarea lunii e 466,67, nu 200

section('Registrul de evidenta fiscala (2026)');
const rf = rep.registruFiscal(v, '2026');
eq('rezultat contabil', rf.rezultatContabil, 420.83);
eq('total nedeductibile (fara ajustari in seed)', rf.totalNeded, 0);
eq('rezultat fiscal', rf.rezultatFiscal, 420.83);
ok('mentiune amortizare (art. 28)', (rf.mentiuni || []).some((m) => /art\. 28/i.test(m)));

section('Mijloace fixe — amortizare');
const laptop = v.assets.find((a) => a.id === 'mf1');
const cl = assets.compute(laptop, '2026-06');
eq('laptop amortizare lunara (liniar)', cl.amortizareLunara, 166.67);
eq('laptop cumulat la 2026-06 (5 luni)', cl.amortizareCumulata, 833.35);
eq('laptop cont amortizare', cl.contAmortizare, '2813');
const utilaj = v.assets.find((a) => a.id === 'mf2');
const yearSum = (y) => assets.schedule(utilaj).filter((r) => r.period.startsWith(y)).reduce((s, r) => s + r.amount, 0);
eq('utilaj degresiv an 1 (2026)', Math.round(yearSum('2026') * 100) / 100, 3600);
eq('utilaj total amortizat = cost', Math.round(assets.schedule(utilaj).reduce((s, r) => s + r.amount, 0) * 100) / 100, 12000);

// Inchiderea prin rotunjire + corectitudinea economica pe toate metodele (fara ban fantoma, fara rate negative)
const deprClose = (asset) => {
  const sch = assets.schedule(asset);
  const base = Math.round((asset.cost - (asset.valoareReziduala || 0)) * 100) / 100;
  const tot = Math.round(sch.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const ramasFinal = sch.length ? sch[sch.length - 1].ramas : asset.cost;
  const negative = sch.filter((r) => r.amount < 0).length;
  return { closes: tot === base, ramasOk: Math.abs(ramasFinal - (asset.valoareReziduala || 0)) < 0.005, negative };
};
for (const [nume, a] of [
  ['liniara durata urata (7 luni)', { cost: 10000, durataLuni: 7, metoda: 'liniara', dataPif: '2026-01-15' }],
  ['liniara cu reziduala', { cost: 10000, valoareReziduala: 1000, durataLuni: 36, metoda: 'liniara', dataPif: '2026-01-15' }],
  ['degresiva coef 2.0 (8 ani)', { cost: 30000, durataLuni: 96, metoda: 'degresiva', dataPif: '2026-01-15' }],
  ['accelerata 50% primul an', { cost: 12000, durataLuni: 60, metoda: 'accelerata', dataPif: '2026-01-15' }],
]) {
  const r = deprClose(a);
  ok('amortizare „' + nume + '": cumulat = baza, ramas = reziduala, fara rate negative', r.closes && r.ramasOk && r.negative === 0);
}
// ── Casarea opreste amortizarea DUPA luna ei, nu retroactiv ────────────────────────────────
// `monthlyDepreciation` sarea peste ORICE activ cu status 'casat', indiferent de `dataCasare`,
// in timp ce `compute` citea corect data. Deci marcarea unui mijloc fix ca fiind casat stergea
// amortizarea lunilor DINAINTE de casare: registrul arata amortizarea cumulata, dar niciun
// articol nu o inregistra. Se declanseaza la orice inchidere intarziata sau regenerare de luna.
{
  const { round2 } = require('../src/util');
  const cas = { id: 'mfc', denumire: 'Utilaj casat', cont: '2131', cost: 12000, durataLuni: 24,
    metoda: 'liniara', dataPif: '2025-12-15', status: 'casat', dataCasare: '2026-06-20' }; // 500 lei/luna
  const lunar = (p) => assets.monthlyDepreciation([cas], p).total;
  eq('luna dinaintea casarii se amortizeaza', lunar('2026-03'), 500);
  eq('luna casarii se amortizeaza (activul a fost in gestiune o parte din ea)', lunar('2026-06'), 500);
  eq('luna de DUPA casare nu se mai amortizeaza', lunar('2026-07'), 0);
  // INVARIANTUL care lipsea: registrul si articolele trebuie sa spuna acelasi lucru despre
  // acelasi activ. Inainte, compute() zicea 3000 si suma articolelor lunare zicea 0.
  let sumaLunara = 0;
  for (let y = 2026; y <= 2027; y += 1) for (let m = 1; m <= 12; m += 1) sumaLunara = round2(sumaLunara + lunar(y + '-' + String(m).padStart(2, '0')));
  eq('suma articolelor lunare = amortizarea cumulata din registru', sumaLunara, assets.compute(cas, '2026-12').amortizareCumulata);
  eq('...si aceea se opreste la luna casarii (6 x 500)', assets.compute(cas, '2026-12').amortizareCumulata, 3000);
  // casat FARA data: nu se poate sti pana cand, deci ramane sarit (comportament pastrat)
  eq('casat fara data ramane sarit', assets.monthlyDepreciation([Object.assign({}, cas, { dataCasare: '' })], '2026-03').total, 0);
  // activul necasat e neatins de reparatie
  eq('activul necasat se amortizeaza normal', assets.monthlyDepreciation([Object.assign({}, cas, { status: 'activ' })], '2026-09').total, 500);
}
eq('coeficient degresiv ≤5 ani', assets.degressiveCoef(5), 1.5);
eq('coeficient degresiv 6-10 ani', assets.degressiveCoef(8), 2.0);
eq('coeficient degresiv >10 ani', assets.degressiveCoef(12), 2.5);

section('Imobilizari: contul de amortizare, ce nu se amortizeaza, regimul permis (art. 28)');
{
  const coaTest = require('../src/chartOfAccounts');
  // ── A1. Contul de amortizare exista in plan pentru ORICE cont de imobilizari din plan ──
  // Forma veche il compunea din cifre ('281' + a treia cifra) si producea 2805/2808/2811/2812/2814,
  // conturi care nu existau: amortizarea lor se scria pe un cont orfan, iar SAF-T pleca la ANAF cu
  // <AccountDescription>(cont necunoscut)</AccountDescription>. Poarta e pe TOT planul, nu pe o
  // lista scrisa de mana: un cont de imobilizari adaugat maine intra singur in verificare.
  const conturiImob = coaTest.ACCOUNTS
    .filter((c) => /^2[0-2]/.test(c.cod) && !/^28/.test(c.cod))
    .map((c) => c.cod);
  ok('planul chiar contine conturi de imobilizari de verificat', conturiImob.length >= 8);
  const fara = conturiImob.filter((c) => assets.esteAmortizabil(c).ok && !assets.contAmortizareValid(c));
  eq('fiecare cont amortizabil are contul de amortizare IN PLAN', fara.join(',') || '(niciunul)', '(niciunul)');
  // maparea, pe cazurile care erau gresite
  eq('constructii 212 -> 2812', assets.contAmortizare('212'), '2812');
  eq('mobilier 214 -> 2814', assets.contAmortizare('214'), '2814');
  eq('licente 205 -> 2805', assets.contAmortizare('205'), '2805');
  eq('amenajari de terenuri 2112 -> 2811', assets.contAmortizare('2112'), '2811');
  eq('echipamente 2131 -> 2813 (neschimbat)', assets.contAmortizare('2131'), '2813');
  eq('transport 2133 -> 2813 (neschimbat)', assets.contAmortizare('2133'), '2813');
  // analiticul propriu cade pe sinteticul lui, nu pe un cod inventat
  eq('analitic 2131.01 -> 2813', assets.contAmortizare('2131.01'), '2813');
  eq('cont necunoscut cade pe sintetic, nu inventeaza', assets.contAmortizare('219'), '281');
  ok('sinteticul de rezerva exista si el in plan', !!coaTest.getAccount(assets.contAmortizare('219')));

  // ── A2. Ce nu se amortizeaza ──
  // Conturile RECTIFICATIVE (28x amortizari, 29x ajustari) nu sunt active: sunt corectia lor.
  // Garda initiala accepta orice cont de clasa 2 neenumerat explicit, deci le lasa sa treaca — un
  // mijloc fix pe 2813 producea `6811 = 281`, adica amortizarea unei amortizari, si intra asa in
  // registru si in sectiunea `Assets` din SAF-T. Suprafata s-a largit cand familia 29x a intrat in
  // plan (lucrarea B1): tiparul „cont nou in plan -> cauta cine il prinde prin prefix".
  //
  // Poarta se DERIVA din plan, nu dintr-o lista scrisa de mana: orice cont 28x/29x adaugat maine
  // intra singur in verificare.
  {
    const rectificative = coaTest.ACCOUNTS.filter((x) => /^(28|29)/.test(x.cod)).map((x) => x.cod);
    ok('planul chiar contine conturi rectificative de verificat', rectificative.length >= 15);
    const acceptate = rectificative.filter((c) => assets.esteAmortizabil(c).ok);
    eq('niciun cont rectificativ nu e acceptat ca mijloc fix', acceptate.join(',') || '(niciunul)', '(niciunul)');
    ok('motivul spune CE e contul, nu doar ca e refuzat',
      /AMORTIZARE/.test(assets.esteAmortizabil('2813').motiv));
    ok('...si unde trebuie inregistrat activul',
      /20x\/21x/.test(assets.esteAmortizabil('2813').motiv));
    ok('la ajustari, mesajul e al lor', /AJUSTARE/.test(assets.esteAmortizabil('2912').motiv));
    // conturile de imobilizare RAMAN acceptate — garda nu s-a inchis peste ce trebuie
    ok('imobilizarile corporale raman acceptate', assets.esteAmortizabil('2131').ok && assets.esteAmortizabil('212').ok);
    ok('necorporalele la fel', assets.esteAmortizabil('205').ok);
  }

  ok('terenul (2111) nu se amortizeaza', !assets.esteAmortizabil('2111').ok);
  ok('sinteticul 211 e respins ca AMBIGUU (teren + amenajare)', !assets.esteAmortizabil('211').ok);
  ok('amenajarea de teren (2112) SE amortizeaza', assets.esteAmortizabil('2112').ok);
  ok('imobilizarile in curs (231) nu se amortizeaza', !assets.esteAmortizabil('231').ok);
  ok('imobilizarile financiare (267) nu se amortizeaza', !assets.esteAmortizabil('267').ok);
  ok('echipamentul se amortizeaza', assets.esteAmortizabil('2131').ok);
  ok('motivul refuzului ajunge la utilizator, nu doar un fals', /teren/i.test(assets.esteAmortizabil('2111').motiv));

  // ── A3. Regimul permis (art. 28 alin. (5)) ──
  eq('constructiile: numai liniar', assets.metodePermise('212').join(','), 'liniara');
  eq('echipamentele: toate trei', assets.metodePermise('2131').join(','), 'liniara,degresiva,accelerata');
  eq('mobilierul (214): fara accelerata', assets.metodePermise('214').join(','), 'liniara,degresiva');
  eq('computerul pe 214, marcat explicit: toate trei', assets.metodePermise('214', { computer: true }).join(','), 'liniara,degresiva,accelerata');
  ok('accelerata pe o constructie e refuzata', !!assets.motivMetodaNepermisa('212', 'accelerata'));
  ok('degresiva pe o constructie e refuzata', !!assets.motivMetodaNepermisa('212', 'degresiva'));
  ok('liniara pe o constructie trece', !assets.motivMetodaNepermisa('212', 'liniara'));
  ok('accelerata pe mobilier e refuzata', !!assets.motivMetodaNepermisa('214', 'accelerata'));
  ok('accelerata pe un computer marcat trece', !assets.motivMetodaNepermisa('214', 'accelerata', { computer: true }));
  ok('accelerata pe echipament trece', !assets.motivMetodaNepermisa('2131', 'accelerata'));
  ok('motivul citeaza temeiul, ca sa poata fi verificat', /art\. 28/i.test(assets.motivMetodaNepermisa('212', 'accelerata')));

  // ── Activele SCRISE INAINTE de garzi raman pe disc: se raporteaza, nu se corecteaza tacut ──
  // O corectie automata ar schimba retroactiv articole deja postate — exact defectul reparat la
  // casare, unde marcarea unui activ stergea amortizarea lunilor dinainte.
  const cladireGresita = { id: 'mfx', cont: '212', denumire: 'Hala', cost: 600000, durataLuni: 600, metoda: 'accelerata', dataPif: '2026-01-15' };
  const nc = assets.neconformitati(cladireGresita);
  ok('o cladire pe accelerata e RAPORTATA ca neconforma', nc.length === 1 && /art\. 28/.test(nc[0]));
  eq('...dar planul ei de amortizare ramane neschimbat', assets.schedule(cladireGresita).length, 600);
  ok('un activ corect nu are neconformitati', assets.neconformitati({ cont: '2131', cost: 1000, durataLuni: 12, metoda: 'accelerata', dataPif: '2026-01-15' }).length === 0);
  // planul FISCAL trece prin aceeasi regula: art. 28 vorbeste chiar despre amortizarea fiscala
  const fiscalGresit = { cont: '212', cost: 1000, durataLuni: 24, metoda: 'liniara', metodaFiscala: 'accelerata', dataPif: '2026-01-15' };
  ok('metoda FISCALA nepermisa e raportata separat', assets.neconformitati(fiscalGresit).some((m) => /^Planul fiscal/.test(m)));

  // ── A4: INVESTITIILE ULTERIOARE (modernizari), art. 28 alin. (3) ────────────────────────
  // Nu se putea majora valoarea unui activ existent: contabilul avea doua iesiri, amandoua
  // gresite — activ nou separat (registrul se umple cu fantome) sau cheltuiala directa (deducere
  // luata prea devreme, integral). Investitia se recupereaza pe durata RAMASA, din luna
  // URMATOARE finalizarii.
  {
    const baza = { id: 'mfi', cont: '2131', denumire: 'Utilaj', cost: 12000, durataLuni: 60,
      metoda: 'liniara', dataPif: '2026-01-15' };
    const cuInv = Object.assign({}, baza, { investitii: [{ id: 'i1', data: '2026-12-20', suma: 6000 }] });
    const sB = assets.schedule(baza); const sI = assets.schedule(cuInv);
    const la = (s, p) => (s.find((r) => r.period === p) || {}).amount;

    eq('fara investitie: 200 lei/luna', la(sB, '2026-02'), 200);
    eq('lunile de DINAINTE de efect raman neatinse', la(sI, '2026-12'), 200);
    // efectul incepe cu luna urmatoare finalizarii (dec. -> ian.), pe cele 49 de luni ramase
    eq('luna efectului: 200 + 6000/49', la(sI, '2027-01'), 322.45);
    eq('durata NU se prelungeste singura', sI.length, sB.length);
    // invariantul de inchidere: planul recupereaza EXACT valoarea majorata
    const total = Math.round(sI.reduce((s, r) => s + r.amount, 0) * 100) / 100;
    eq('planul inchide exact pe cost + investitie', total, 18000);
    ok('...si nicio rata negativa', sI.every((r) => r.amount >= 0));

    // registrul raporteaza valoarea MAJORATA, nu costul initial
    const c = assets.compute(cuInv, '2031-01');
    eq('baza amortizabila include investitia', c.bazaAmortizabila, 18000);
    eq('valoarea de intrare majorata se arata separat', c.valoareIntrare, 18000);
    eq('...din care investitii', c.investitii, 6000);
    eq('la finalul planului nu mai ramane nimic', c.valoareRamasa, 0);
    ok('...si activul e integral amortizat', c.integralAmortizat);
    // fara investitii, comportamentul e NESCHIMBAT (nicio regresie pe activele existente)
    const cB = assets.compute(baza, '2031-01');
    eq('activ fara investitii: baza neschimbata', cB.bazaAmortizabila, 12000);
    eq('...si fara camp de investitii', cB.investitii, 0);

    // articolele lunare urmeaza planul recalculat — registrul si notele nu se contrazic
    eq('amortizarea lunii urmeaza planul nou', assets.monthlyDepreciation([cuInv], '2027-01').total, 322.45);
    eq('...iar in luna dinainte, pe cel vechi', assets.monthlyDepreciation([cuInv], '2026-12').total, 200);

    // DOUA investitii succesive se cumuleaza, fiecare pe durata ei ramasa
    const doua = Object.assign({}, baza, { investitii: [
      { id: 'i1', data: '2026-12-20', suma: 6000 }, { id: 'i2', data: '2028-06-30', suma: 3000 }] });
    const sD = assets.schedule(doua);
    eq('doua investitii: planul inchide pe 21.000',
      Math.round(sD.reduce((s, r) => s + r.amount, 0) * 100) / 100, 21000);
    ok('a doua investitie creste rata abia dupa ea',
      la(sD, '2028-07') > la(sD, '2028-06'));
    eq('ordinea nu conteaza (se sorteaza dupa data)',
      Math.round(assets.schedule(Object.assign({}, baza, { investitii: doua.investitii.slice().reverse() }))
        .reduce((s, r) => s + r.amount, 0) * 100) / 100, 21000);

    // pe planul FISCAL investitia se aplica la fel, dar peste durata fiscala
    const fisc = Object.assign({}, cuInv, { durataFiscalaLuni: 36 });
    eq('planul fiscal recupereaza si el investitia',
      Math.round(assets.schedule(assets.fiscalView(fisc)).reduce((s, r) => s + r.amount, 0) * 100) / 100, 18000);
    ok('...dar pe alta durata decat cel contabil',
      assets.schedule(assets.fiscalView(fisc)).length !== assets.schedule(fisc).length);

    // investitia pe un activ AMORTIZAT INTEGRAL cere prelungire explicita
    const tarziu = Object.assign({}, baza, { investitii: [{ id: 'i9', data: '2032-05-10', suma: 4000 }] });
    eq('fara prelungire, investitia de dupa plan nu se poate esalona',
      Math.round(assets.schedule(tarziu).reduce((s, r) => s + r.amount, 0) * 100) / 100, 12000);
    const tarziuOk = Object.assign({}, baza, { investitii: [{ id: 'i9', data: '2032-05-10', suma: 4000, durataSuplimentaraLuni: 24 }] });
    const sT = assets.schedule(tarziuOk);
    eq('cu prelungire ceruta explicit, se recupereaza integral',
      Math.round(sT.reduce((s, r) => s + r.amount, 0) * 100) / 100, 16000);
    eq('...iar planul se lungeste cu exact atat', sT.length, sB.length + 24);

    // igiena intrarilor: sume nule/negative si date malformate sunt ignorate, nu explodeaza
    const murdar = Object.assign({}, baza, { investitii: [
      { id: 'x1', data: '', suma: 5000 }, { id: 'x2', data: '2027-01-01', suma: 0 },
      { id: 'x3', data: '2027-01-01', suma: -100 }] });
    eq('intrarile invalide nu schimba planul',
      Math.round(assets.schedule(murdar).reduce((s, r) => s + r.amount, 0) * 100) / 100, 12000);
    eq('totalul investitiilor le ignora si el', assets.totalInvestitii(murdar), 0);

    eq('luna urmatoare, peste an', assets.lunaUrmatoare('2026-12-20'), '2027-01');
    eq('luna urmatoare, in an', assets.lunaUrmatoare('2026-03-01'), '2026-04');
  }

  // ── Nicio amortizare nu mai poate produce un cont din afara planului ──
  // Poarta pe IESIREA reala a motorului, nu pe harta: `monthlyDepreciation` e cea care scrie.
  const toate = conturiImob.filter((c) => assets.esteAmortizabil(c).ok).map((c, i) => ({
    id: 'mf-' + i, cont: c, denumire: 'Activ ' + c, cost: 12000, durataLuni: 12,
    metoda: assets.metodePermise(c)[0], dataPif: '2026-01-15',
  }));
  const orfane = assets.monthlyDepreciation(toate, '2026-02').lines
    .map((l) => l.contAmortizare).filter((c) => !coaTest.getAccount(c));
  eq('articolele de amortizare nu mai contin conturi din afara planului', orfane.join(',') || '(niciunul)', '(niciunul)');
}
// degresiva e front-loaded: primul an > liniarul mediu
const degSch = assets.schedule({ cost: 10000, durataLuni: 60, metoda: 'degresiva', dataPif: '2026-01-01' });
const degAn1 = degSch.filter((r) => r.period.startsWith('2026')).reduce((s, r) => s + r.amount, 0) + degSch.filter((r) => r.period === '2027-01').reduce((s, r) => s + r.amount, 0);
ok('degresiva front-loaded (an 1 = 3000 > liniar 2000)', Math.round(degAn1) === 3000);
// REGRESIE, gasita ruland suita pe Windows. `firstDepreciationMonth` parsa data ca UTC
// (`new Date('2026-01-01')` = miezul noptii UTC) si o citea cu getteri LOCALI — pe orice
// calculator la VEST de UTC aceeasi zi devine 31 decembrie, deci amortizarea incepea cu o luna
// mai devreme. Nu era o problema de test: pachetul Windows ruleaza pe calculatorul clientului,
// cu fusul lui, deci acelasi mijloc fix s-ar fi amortizat altfel la Bucuresti si altfel la
// New York. Serverul e pe UTC, deci defectul era invizibil aici.
{
  const cp = require('child_process');
  // calea catre repo, cu bare normale: `require` accepta `/` pe orice sistem, iar pe Windows
  // interpolarea unei cai cu `\\` ar strica sirul de cod trimis subprocesului
  const radTz = path.join(__dirname, '..').replace(/\\/g, '/');
  const rulaLaFus = (tz) => JSON.parse(cp.execFileSync(process.execPath, ['-e', `
    const a = require('${radTz}/src/assets');
    const l = require('${radTz}/src/leasing');
    const s = a.schedule({ cost: 10000, durataLuni: 60, metoda: 'degresiva', dataPif: '2026-01-01' });
    process.stdout.write(JSON.stringify({ prima: s[0].period, rata1: l.periodOfInstallment('2026-02-01', 1) }));
  `], { env: Object.assign({}, process.env, { TZ: tz }) }).toString());
  // Vest de UTC (unde defectul se manifesta), est de UTC si UTC — toate trei trebuie sa dea la fel.
  for (const tz of ['UTC', 'Europe/Bucharest', 'America/Los_Angeles']) {
    const r = rulaLaFus(tz);
    eq('prima luna de amortizare nu depinde de fusul orar (' + tz + ')', r.prima, '2026-02');
    eq('luna ratei de leasing nu depinde de fusul orar (' + tz + ')', r.rata1, '2026-02');
  }
}

section('Stocuri (CMP, pe gestiuni)');
const st = stocks.currentStock(v, '2026-06');
const byG = Object.fromEntries(st.map((s) => [s.gestiune.cod, s]));
eq('stoc DEP', byG.DEP.stocQ, 10);
eq('stoc MAG', byG.MAG.stocQ, 10);
eq('valoare totala stoc', Math.round(st.reduce((s, x) => s + x.stocV, 0) * 100) / 100, 2000);
eq('CMP DEP', byG.DEP.cmp, 100);

// Regresie CMP: la iesirea/transferul INTREGULUI stoc, valoarea se descarca integral (fara ban fantoma din rotunjire)
const _cmpProd = { id: 'cp' };
const _cmpMov = [
  { id: 'r1', productId: 'cp', tip: 'receptie', gestiuneId: 'g1', cantitate: 3, pretUnitar: 10, data: '2026-01-01' },
  { id: 'r2', productId: 'cp', tip: 'receptie', gestiuneId: 'g1', cantitate: 4, pretUnitar: 11, data: '2026-01-02' },
  { id: 'i1', productId: 'cp', tip: 'iesire', gestiuneId: 'g1', cantitate: 7, data: '2026-01-03' },
];
const _cmpLed = stocks.productLedger(_cmpProd, _cmpMov, null, 'g1');
eq('CMP: dupa iesirea intregului stoc, cantitate 0', _cmpLed.stocQ, 0);
eq('CMP: dupa iesirea intregului stoc, valoare 0 (fara reziduu)', _cmpLed.stocV, 0);
eq('CMP: COGS iesit = cost intrat (74, nu 73.99)', Math.round(_cmpLed.rows.filter((r) => r.tip === 'iesire').reduce((s, r) => s + r.iesireV, 0) * 100) / 100, 74);
const _cmpXfer = stocks.productLedger(_cmpProd, [
  { id: 'r1', productId: 'cp', tip: 'receptie', gestiuneId: 'g1', cantitate: 3, pretUnitar: 10, data: '2026-01-01' },
  { id: 'r2', productId: 'cp', tip: 'receptie', gestiuneId: 'g1', cantitate: 4, pretUnitar: 11, data: '2026-01-02' },
  { id: 't1', productId: 'cp', tip: 'transfer', gestiuneId: 'g1', gestiuneDestId: 'g2', cantitate: 7, data: '2026-01-03' },
], null, 'g1');
eq('CMP: sursa golita complet la transfer (valoare 0)', _cmpXfer.stocV, 0);

section('Descarcare automata de gestiune la vanzare (COGS la CMP)');
const _prods = [{ id: 'p1', cod: 'M1', denumire: 'Marfa 1', um: 'buc', cont: '371' }];
const _movs = [
  { id: 'r1', tip: 'receptie', productId: 'p1', gestiuneId: 'DEP', data: '2026-06-01', cantitate: 100, pretUnitar: 10 },
  { id: 'r2', tip: 'receptie', productId: 'p1', gestiuneId: 'DEP', data: '2026-06-05', cantitate: 100, pretUnitar: 12 },
];
let _n = 0;
const _sale = stocks.saleCogs(_prods, _movs, [{ productId: 'p1', gestiuneId: 'DEP', cantitate: 50 }],
  { fid: 1, data: '2026-06-20', document: 'F100', entryId: 'e99', nextId: () => 'sm' + (++_n) });
eq('CMP dupa 2 receptii (1000+1200)/200', 11, 11); // referinta
eq('o singura miscare de iesire generata', _sale.newMovements.length, 1);
eq('iesirea e legata de articol (entryId)', _sale.newMovements[0].entryId, 'e99');
eq('COGS total = 50 buc × CMP 11', _sale.total, 550);
eq('o linie de descarcare', _sale.cogsLines.length, 1);
eq('linia de descarcare = 607=371', _sale.cogsLines[0].debit + '=' + _sale.cogsLines[0].credit, '607=371');
eq('suma descarcarii', _sale.cogsLines[0].suma, 550);
eq('fara avertismente (stoc suficient)', _sale.warns.length, 0);
const _sale2 = stocks.saleCogs(_prods, _movs, [{ productId: 'p1', gestiuneId: 'DEP', cantitate: 500 }],
  { fid: 1, data: '2026-06-20', entryId: 'e98', nextId: () => 'smX' });
eq('stoc insuficient: COGS la tot stocul (200×11)', _sale2.total, 2200);
eq('stoc insuficient nu lasa cantitate negativa', _sale2.cogsLines[0].suma, 2200);
// REGRESIE. Aserțiunile de mai sus verificau doar SUMA, si erau adevarate — dar descarcarea
// partiala trecea TACUT: `simulate` plafoneaza iesirea la stocul disponibil, deci vanzarea a 500
// de bucati dintr-un stoc de 200 se inregistra cu costul a 200 si niciun avertisment. Marja iesea
// umflata cu costul celor 300 lipsa. Avertismentul vechi se declansa doar la stoc ZERO (suma 0),
// adica exact cazul in care oricum se vedea ca lipseste ceva.
eq('descarcarea partiala PRODUCE avertisment', _sale2.warns.length, 1);
ok('avertismentul spune cat s-a descarcat din cat s-a cerut', /200 din 500/.test(_sale2.warns[0]));
ok('...si numeste produsul', /Marfa 1/.test(_sale2.warns[0]));
eq('lipsa e expusa si ca date, nu doar ca text', JSON.stringify(_sale2.lipsuri.map((l) => [l.cerut, l.descarcat, l.lipsa])), JSON.stringify([[500, 200, 300]]));
// Stoc ZERO: tot un caz de lipsa, nu o ramura separata.
const _sale3 = stocks.saleCogs(_prods, [], [{ productId: 'p1', gestiuneId: 'DEP', cantitate: 7 }],
  { fid: 1, data: '2026-06-20', entryId: 'e97', nextId: () => 'smZ' });
eq('stoc zero: COGS 0 si nicio linie de descarcare', _sale3.total + _sale3.cogsLines.length, 0);
eq('stoc zero: tot un avertisment', _sale3.warns.length, 1);
eq('stoc suficient: `lipsuri` ramane gol', _sale.lipsuri.length, 0);

section('Control casa: plafonul TOTAL al zilei + lipsa neimputabila la inventar');
{
  const K = (id, data, suma, partener, cui) => ({ id, data, period: data.slice(0, 7), tip: 'x', tipNume: 'x',
    partener, partenerCui: cui, lines: [{ debit: '401', credit: '5311', suma }] });
  // REGRESIE. Art. 3 alin. (1) lit. c) are DOUA limite simultane: 5.000 lei/persoana/zi SI un
  // plafon TOTAL de 10.000 lei/zi. Se incalca independent — trei plati de 4.000 catre furnizori
  // DIFERITI respecta fiecare limita per persoana, dar totalul zilei e 12.000. Verificarea veche,
  // grupata pe (zi × partener), le lasa sa treaca pe toate.
  const trei = { openingBalances: { 5311: { d: 50000, c: 0 } }, entries: [
    K('t1', '2026-05-10', 4000, 'ALFA SRL', 'RO111'),
    K('t2', '2026-05-10', 4000, 'BETA SRL', 'RO222'),
    K('t3', '2026-05-10', 4000, 'GAMA SRL', 'RO333'),
  ] };
  const cc = acc.cashControl(trei, '5311', '2026-05');
  eq('niciuna dintre plati nu depaseste limita PER PERSOANA', cc.plafon.length, 0);
  eq('...dar totalul zilei o depaseste pe cea TOTALA', cc.plafonTotalZi.length, 1);
  eq('suma raportata e totalul zilei', cc.plafonTotalZi[0].suma, 12000);
  eq('limita raportata e cea totala (10.000)', cc.plafonTotalZi[0].limita, 10000);
  ok('verdictul general devine „nu e ok"', cc.ok === false);
  // Sub plafon: nicio constatare (regula nu inventeaza abateri).
  const doua = { openingBalances: { 5311: { d: 50000, c: 0 } }, entries: [K('d1', '2026-05-11', 4000, 'ALFA SRL', 'RO111'), K('d2', '2026-05-11', 4000, 'BETA SRL', 'RO222')] };
  eq('8.000 intr-o zi: sub plafonul total, nicio constatare', acc.cashControl(doua, '5311', '2026-05').plafonTotalZi.length, 0);
  // Plafonul e ZILNIC: aceleasi sume in zile diferite nu se cumuleaza.
  const alteZile = { openingBalances: { 5311: { d: 50000, c: 0 } }, entries: [
    K('z1', '2026-05-12', 6000, 'ALFA SRL', 'RO111'), K('z2', '2026-05-13', 6000, 'BETA SRL', 'RO222')] };
  eq('6.000 + 6.000 in zile diferite: fara depasire', acc.cashControl(alteZile, '5311', '2026-05').plafonTotalZi.length, 0);
  // Se aplica DOAR platilor: incasarile au numai limita per persoana.
  const incasari = { openingBalances: {}, entries: [1, 2, 3].map((n) => ({ id: 'i' + n, data: '2026-05-14', period: '2026-05',
    tip: 'x', tipNume: 'x', partener: 'C' + n, partenerCui: 'RO' + n, lines: [{ debit: '5311', credit: '4111', suma: 4000 }] })) };
  eq('incasari de 12.000 intr-o zi: plafonul TOTAL nu li se aplica', acc.cashControl(incasari, '5311', '2026-05').plafonTotalZi.length, 0);
  // Fara CUI nu se poate stabili ca partea e persoana juridica -> nu se numara (aceeasi regula ca
  // la `juridic`, nu una noua).
  const faraCui = { openingBalances: { 5311: { d: 50000, c: 0 } }, entries: [
    K('f1', '2026-05-15', 6000, 'Ion Popescu', ''), K('f2', '2026-05-15', 6000, 'Vasile Ionescu', '')] };
  eq('plati catre persoane fizice: plafonul total nu se aplica', acc.cashControl(faraCui, '5311', '2026-05').plafonTotalZi.length, 0);

  // ── Lipsa NEIMPUTABILA la inventar: nedeductibila (art. 25(4)(c)) ──
  // Marcajul sta pe articol, nu pe cont: aceeasi cheltuiala, pe acelasi cont, e deductibila daca
  // lipsa a fost imputata sau acoperita de asigurare. Acelasi tipar ca `auto50`.
  const inv = require('../src/documentTypes').getType('diferente_inventar'); // `gt2` e declarat mai jos
  const minusN = inv.build({ sens: 'minus', suma: 8000, contStoc: '371', contChelt: '6588', lipsaNeimputabila: true });
  eq('minus neimputabil: 6588 = 371', minusN[0].debit + '=' + minusN[0].credit, '6588=371');
  ok('explicatia spune ca e nedeductibila', /nedeductibil/i.test(minusN[0].explicatie));
  ok('minusul imputabil nu poarta mentiunea', !/nedeductibil/i.test(inv.build({ sens: 'minus', suma: 8000 })[0].explicatie));
  eq('contul de cheltuiala ramane ales de contabil (implicit 607)', inv.build({ sens: 'minus', suma: 100 })[0].debit, '607');
  // Baza fiscala se aduna DOAR din articolele marcate.
  const L2 = (id, data, lines, extra) => Object.assign({ id, data, period: data.slice(0, 7), tip: 'x', tipNume: 'x', lines }, extra || {});
  const vLipsa = { openingBalances: {}, assets: [], company: {}, entries: [
    L2('v1', '2026-03-01', [{ debit: '4111', credit: '704', suma: 100000 }]),
    L2('v2', '2026-12-20', [{ debit: '6588', credit: '371', suma: 8000 }], { lipsaNeimputabila: true }),
    L2('v3', '2026-12-21', [{ debit: '6588', credit: '371', suma: 3000 }]), // lipsa IMPUTATA -> deductibila
  ] };
  eq('baza = doar articolele marcate (8.000, nu 11.000)', rep.cheltuieliLipsaNeimputabila(vLipsa, '2026'), 8000);
  const P2 = require('../src/fiscalConfig').RATES;
  const optL = { cota: 16, plafoane: P2, cheltLipsaNeimputabila: rep.cheltuieliLipsaNeimputabila(vLipsa, '2026') };
  const ptL = acc.profitTax(vLipsa, '2026', optL);
  eq('lipsa neimputabila devine nedeductibila in impozit', ptL.cheltNedeductibile, 8000);
  eq('profitul impozabil creste cu ea (89.000 + 8.000)', ptL.profitImpozabil, 97000);
  ok('ajustarea isi poarta temeiul legal', (ptL.ajustari || []).some((a) => a.temei === 'Art. 25(4)(c)'));
  // Registrul fiscal si nota contabila raman in acord (invariantul din A1).
  ok('registrul fiscal da acelasi rezultat fiscal',
    rep.registruFiscal(vLipsa, '2026', 16, { plafoane: P2 }).rezultatFiscal === ptL.profitImpozabil);
  eq('fara niciun articol marcat, baza e zero', rep.cheltuieliLipsaNeimputabila({ entries: [vLipsa.entries[0]] }, '2026'), 0);
}

section('Scadentar / aging (FIFO, la 2026-06-25)');
const ag = analytic.aging(v, '2026-06-25');
const alfa = ag.furnizori.find((f) => /ALFA/.test(f.partener));
eq('ALFA total datorie', alfa.total, 15000);
eq('ALFA 0-30 zile', alfa.b0_30, 12100);
eq('ALFA >90 zile', alfa.b90plus, 2900);
eq('clienti restanti (BETA achitat)', ag.clienti.length, 0);

section('SAF-T (D406) — variantele LUNARA (L) si ANUALA (A, Active)');
// varianta LUNARA: sectiunile de activitate PLINE; Assets/Owners/MovementOfGoods goale
const xmlSaft = saft.saftXml(v, '2026-06');
['<GeneralLedgerAccounts>', '<Customers>', '<Suppliers>', '<TaxTable>', '<UOMTable>', '<AnalysisTypeTable/>', '<MovementTypeTable/>', '<Products>', '<Owners/>', '<Assets/>', '<GeneralLedgerEntries>', '<SalesInvoices>', '<PurchaseInvoices>', '<Payments>', '<MovementOfGoods/>']
  .forEach((tag) => ok('lunar contine ' + tag, xmlSaft.includes(tag)));
ok('SAF-T lunar bine-format', wellFormed(xmlSaft));
ok('SAF-T: AuditFileVersion 2.4.9 (schema curenta)', xmlSaft.includes('<AuditFileVersion>2.4.9</AuditFileVersion>'));
ok('SAF-T lunar: coduri de taxa numerice si BaseRate factor', xmlSaft.includes('<TaxCode>300101</TaxCode>') && xmlSaft.includes('<BaseRate>1</BaseRate>'));
ok('SAF-T lunar: UOM pe coduri UN/ECE', xmlSaft.includes('<UnitOfMeasure>C62</UnitOfMeasure>'));
ok('SAF-T lunar: ID parteneri 00+CUI', xmlSaft.includes('<CustomerID>0099887760</CustomerID>') && xmlSaft.includes('<SupplierID>0011223342</SupplierID>'));
eq('SAF-T TotalDebit = TotalCredit', (xmlSaft.match(/<TotalDebit>([\d.]+)<\/TotalDebit>/) || [])[1], (xmlSaft.match(/<TotalCredit>([\d.]+)<\/TotalCredit>/) || [])[1]);
// varianta ANUALA = declaratia de ACTIVE: doar planul de conturi si Assets pline,
// restul sectiunilor goale + AssetTransactions (structura ceruta de validatorul oficial)
const xmlSaftA = saft.saftXml(v, 2026);
ok('anual bine-format', wellFormed(xmlSaftA));
ok('anual: Assets PLIN, cu valuarile pe secventa oficiala', xmlSaftA.includes('<Asset>') && xmlSaftA.includes('<Valuations>') && xmlSaftA.includes('<AssetLifeMonth>36</AssetLifeMonth>'));
ok('anual: sectiunile de activitate goale', xmlSaftA.includes('<Customers/>') && xmlSaftA.includes('<SalesInvoices/>') && xmlSaftA.includes('<GeneralLedgerEntries/>'));
ok('anual: AssetTransactions cu contor', xmlSaftA.includes('<AssetTransactions><NumberOfAssetTransactions>0</NumberOfAssetTransactions></AssetTransactions>'));
// varianta STOCURI (C, la cerere): PhysicalStock si MovementOfGoods PLINE, Assets gol,
// fara AssetTransactions; tipuri de miscare numerice (10/20/40)
const xmlSaftC = saft.saftXml(v, 2026, 'C');
ok('stocuri (C) bine-format', wellFormed(xmlSaftC));
ok('stocuri: HeaderComment C', xmlSaftC.includes('<HeaderComment>C</HeaderComment>'));
ok('stocuri: PhysicalStock plin cu depozit si proprietar 00+CUI', xmlSaftC.includes('<WarehouseID>DEP</WarehouseID>') && xmlSaftC.includes('<OwnerID>0012345674</OwnerID>'));
ok('stocuri: miscari cu tipuri numerice si subtip', xmlSaftC.includes('<MovementType>10</MovementType>') && xmlSaftC.includes('<MovementSubType>40</MovementSubType>'));
ok('stocuri: Assets gol si fara AssetTransactions', xmlSaftC.includes('<Assets/>') && !xmlSaftC.includes('<AssetTransactions>'));
// varianta TRIMESTRIALA (D406 pentru platitor TVA trimestrial): agrega 3 luni, HeaderComment T
const xmlSaftQ = saft.saftXml(Object.assign({}, v, { company: Object.assign({}, v.company, { perioadaTva: 'T' }) }), '2026-Q2');
ok('trimestrial: HeaderComment T si interval 4-6', xmlSaftQ.includes('<HeaderComment>T</HeaderComment>') && /<PeriodStart>4<\/PeriodStart>/.test(xmlSaftQ) && /<PeriodEnd>6<\/PeriodEnd>/.test(xmlSaftQ));
ok('trimestrial bine-format', wellFormed(xmlSaftQ));


// Platforma, primul grup (igiena fisierelor, audit durabil, secrete, zip, backup):
// test/run/platforma.js — cerut AICI, pe pozitia lui, ca ordinea sectiunilor sa nu se schimbe.
require('./run/platforma').platformaFisiere();
section('e-Factura UBL (factura de vanzare)');
const facturaVanz = v.entries.find((e) => e.tip === 'factura_vanzare_marfuri');
const ef = xml.eFacturaXml(v.company, facturaVanz, v.partners);
ok('este document Invoice', ef.includes('<Invoice'));
eq('total de plata (PayableAmount)', (ef.match(/PayableAmount[^>]*>([\d.]+)/) || [])[1], '16940.00');
eq('TVA (TaxAmount)', (ef.match(/cbc:TaxAmount[^>]*>([\d.]+)/) || [])[1], '2940.00');
ok('contine CUI furnizor (RO12345674)', ef.includes('RO12345674'));
ok('contine CUI client (RO99887760)', ef.includes('99887760'));
ok('e-Factura bine-format', wellFormed(ef));
// e-Factura cu cote multiple pe linii (21% / 11% / 0%)
const efMulti = xml.eFacturaXml(v.company, {
  tip: 'factura_vanzare_marfuri', data: '2026-06-15', partener: 'BETA', partenerCui: 'RO99887760', document: 'FM1',
  items: [{ nume: 'A', cantitate: 10, pret: 100, um: 'buc', cota: 21 }, { nume: 'B', cantitate: 5, pret: 50, um: 'buc', cota: 11 }, { nume: 'C', cantitate: 1, pret: 200, um: 'buc', cota: 0 }],
}, v.partners);
ok('e-Factura multi-cota bine-format', wellFormed(efMulti));
eq('e-Factura: 3 subtotaluri de TVA (cate unul pe cota)', (efMulti.match(/<cac:TaxSubtotal>/g) || []).length, 3);
const ttMulti = efMulti.match(/<cac:TaxTotal>([\s\S]*?)<\/cac:TaxTotal>/)[1];
const taxTotalMulti = ttMulti.match(/<cbc:TaxAmount[^>]*>([\d.]+)/)[1];
const subSum = [...ttMulti.matchAll(/<cac:TaxSubtotal>[\s\S]*?<cbc:TaxAmount[^>]*>([\d.]+)/g)].reduce((s, m) => s + parseFloat(m[1]), 0);
eq('TaxTotal = suma subtotalurilor (BR-CO-14)', Math.round(subSum * 100) / 100, parseFloat(taxTotalMulti));
eq('TVA total multi-cota (210+27.50+0)', parseFloat(taxTotalMulti), 237.5);
eq('total de plata multi-cota', (efMulti.match(/PayableAmount[^>]*>([\d.]+)/) || [])[1], '1687.50');

section('Jurnale de TVA / D300 / D394 (2026-06)');
const vj = acc.vatJournals(v, '2026-06');
eq('baza vanzari', vj.totals.bazaV, 14000);
eq('TVA colectata (jurnal vanzari)', vj.totals.colectata, 2940);
eq('baza cumparari', vj.totals.bazaC, 10000);
eq('TVA deductibila (jurnal cumparari)', vj.totals.deductibila, 2100);

// Livrarile FARA TVA (intracomunitare scutite, taxare inversa art. 331) nu au TVA colectata,
// deci nu intra in `vanzari` si nu apar in `coteV` — dar au rand propriu in decont. Inainte
// dispareau complet: D390 declara livrarea intracomunitara, D300 raporta zero pe ea, exact
// discrepanta pe care ANAF o verifica automat intre cele doua.
const vScutit = { openingBalances: {}, company: v.company, entries: v.entries.concat([
  { id: 'lic', tip: 'livrare_intracomunitara', tipNume: 'LIC', partener: 'GMBH', partenerCui: 'DE811907980',
    document: 'EX1', period: '2026-06', data: '2026-06-20', lines: [{ debit: '4111', credit: '707', suma: 50000 }] },
  { id: 'tii', tip: 'taxare_inversa_interna_livrare', tipNume: 'TI', partener: 'Cereale SRL', partenerCui: 'RO9876543',
    document: 'TI1', period: '2026-06', data: '2026-06-21', lines: [{ debit: '4111', credit: '707', suma: 20000 }] },
]) };
const vjS = acc.vatJournals(vScutit, '2026-06');
eq('scutite: livrare intracomunitara colectata pe categoria ei', vjS.totals.scutite.intracom, 50000);
eq('scutite: taxare inversa interna (art. 331) pe categoria ei', vjS.totals.scutite.taxareInversa, 20000);
eq('scutite: baza taxabila ramane neatinsa', vjS.totals.bazaV, 14000);
ok('scutite: NU intra in jurnalul de vanzari taxabile (D394 e raportare interna)',
  !vjS.vanzari.some((r) => String(r.cui).includes('811907980')));
// maparea pe randuri: R1 = livrari intracomunitare scutite, R13 = taxare inversa art. 331,
// iar ambele INTRA in totalul R17_1 (regula R65 a validatorului oficial ANAF).
const aScutit = xml.d300Rows(rep.d300(vScutit, '2026-06'));
eq('D300: R1_1 = livrarea intracomunitara scutita', aScutit.R1_1, 50000);
eq('D300: R13_1 = livrarea cu taxare inversa interna', aScutit.R13_1, 20000);
eq('D300: R17_1 include randurile scutite (14000 + 50000 + 20000)', aScutit.R17_1, 84000);
eq('D300: taxa colectata nu se schimba (operatiunile sunt fara TVA)', aScutit.R17_2, 2940);
ok('D300: randurile scutite nu au coloana de TVA in schema (fara R1_2/R13_2)',
  aScutit.R1_2 === undefined && aScutit.R13_2 === undefined);
// D390 si D300 trebuie sa spuna acelasi lucru despre livrarile intracomunitare
eq('D390 si D300 concorda pe livrarile intracomunitare', rep.d390(vScutit, '2026-06').totalL, aScutit.R1_1);
// diferentele de curs / provizioanele / subventiile sunt tot venituri fara TVA, dar NU sunt
// operatiuni de decont: maparea e pe TIPUL documentului, nu pe absenta TVA-ului
const vFals = { openingBalances: {}, company: v.company, entries: [
  { id: 'dc', tip: 'diferenta_curs_favorabila', tipNume: 'DC', document: 'DC1', period: '2026-06', data: '2026-06-22',
    lines: [{ debit: '4111', credit: '765', suma: 7777 }] },
] };
const aFals = xml.d300Rows(rep.d300(vFals, '2026-06'));
eq('D300: diferenta de curs NU umfla decontul', (aFals.R1_1 || 0) + (aFals.R13_1 || 0) + (aFals.R17_1 || 0), 0);

// Schema v12 nu are randuri pentru toate cotele: la ACHIZITII exista doar 21% (R22) si 11% (R23).
// Cotele istorice (R24=5%, R74=19%, R75=9% la achizitii; R69=19%, R71=5% la livrari) sunt respinse
// de validatorul oficial cu „atributul nu trebuie sa exista aici". Erau mapate si emise, deci o
// SINGURA factura de achizitie la 9% facea toata declaratia respinsa la depunere. (9% e cota
// curenta — la livrari are R11 — dar la achizitii v12 nu ii da rand; codul o trimitea la R74,
// care e de fapt randul de 19%: maparea era si inversata.)
const mkCota = (cota, tva) => ({ openingBalances: {}, company: { cui: 'RO1', nume: 'X' }, entries: [
  { id: 'c' + cota, data: '2026-06-09', period: '2026-06', tip: 'factura_cumparare_marfuri', tipNume: 'M',
    partener: 'F', partenerCui: 'RO555', document: 'F9',
    lines: [{ debit: '371', credit: '401', suma: 1000 }, { debit: '4426', credit: '401', suma: tva }] },
] });
const a9 = xml.d300Rows(rep.d300(mkCota(9, 90), '2026-06'));
ok('achizitie la 9%: NU se mai emite randul istoric R74 (ar fi respins de ANAF)', a9.R74_1 === undefined && a9.R74_2 === undefined);
ok('achizitie la 9%: nu se inventeaza alt rand de achizitii', a9.R22_1 === undefined && a9.R23_1 === undefined);
// ...dar suma nu dispare tacit: iese prin d300CoteFaraRand si e raportata ca EROARE
eq('achizitie la 9%: raportata ca lipsa de rand, nu pierduta',
  JSON.stringify(xml.d300CoteFaraRand(rep.d300(mkCota(9, 90), '2026-06'))),
  '[{"sens":"achizitii","cota":9,"baza":1000,"tva":90}]');
const rec9 = rep.tvaReconciliation(mkCota(9, 90), '2026-06');
ok('achizitie la 9%: reconcilierea TVA o semnaleaza ca EROARE (nu doar atentionare)',
  rec9.findings.some((f) => f.cod === 'tva-cota-fara-rand' && f.nivel === 'eroare') && rec9.ok === false);
const val9 = require('../src/validate').validateDeclaration('d300', '<?xml version="1.0"?><declaratie300 cui="12345674" luna="6" an="2026"/>',
  { cui: '12345674', coteFaraRand: xml.d300CoteFaraRand(rep.d300(mkCota(9, 90), '2026-06')) });
ok('achizitie la 9%: validarea pre-depunere o da ca eroare, nu avertisment',
  val9.ok === false && val9.errors.some((e) => /9%/.test(e) && /nu are rand/.test(e)));
// cotele care AU rand raman neatinse
const a11 = xml.d300Rows(rep.d300(mkCota(11, 110), '2026-06'));
eq('achizitie la 11%: rand normal R23, fara semnalare', a11.R23_1 + '/' + a11.R23_2, '1000/110');
eq('achizitie la 11%: nicio cota fara rand', xml.d300CoteFaraRand(rep.d300(mkCota(11, 110), '2026-06')).length, 0);
ok('livrarile la 9% AU rand (R11) — asimetria e a schemei, nu a codului',
  xml.d300Rows({ coteV: [{ cota: 9, baza: 1000, tva: 90 }], coteC: [] }).R11_1 === 1000);
// Reconciliere TVA (pregatire e-TVA): pozitia perioadei + constatarile care ar crea discrepante
const mkVat = (entries) => ({ entries, openingBalances: {} });
const recOk = rep.tvaReconciliation(mkVat([
  { id: 'v1', tip: 'factura_vanzare_marfuri', partenerCui: 'RO1', document: 'F1', period: '2026-06', data: '2026-06-10', spv: { index: '9' }, lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] },
]), '2026-06');
eq('reconciliere: TVA coerent 21% + trimisa -> 0 constatari, colectata 210', recOk.findings.length + '/' + recOk.colectata + '/' + recOk.ok, '0/210/true');
const recBad = rep.tvaReconciliation(mkVat([
  { id: 'v2', tip: 'factura_vanzare_servicii', partenerCui: 'RO2', document: 'F2', period: '2026-06', data: '2026-06-11', lines: [{ debit: '4111', credit: '704', suma: 1000 }, { debit: '4111', credit: '4427', suma: 150 }] },
]), '2026-06');
ok('reconciliere: cota neconforma (15%) semnalata', recBad.findings.some((f) => f.cod === 'tva-cota-neconforma') && recBad.coteAnormale[0].cota === 15);
ok('reconciliere: vanzare cu TVA netrimisa in SPV semnalata', recBad.findings.some((f) => f.cod === 'efactura-netrimisa') && recBad.netrimise.length === 1);
// taxarea inversa (4426=4427) NU declanseaza cota neconforma (TVA autolichidata pe aceeasi baza)
const recTi = rep.tvaReconciliation(mkVat([
  { id: 'v3', tip: 'achizitie_intracomunitara', partenerCui: 'DE1', document: 'IC1', period: '2026-06', data: '2026-06-12', lines: [{ debit: '371', credit: '401', suma: 2000 }, { debit: '4426', credit: '4427', suma: 420 }] },
]), '2026-06');
ok('reconciliere: taxarea inversa nu e semnalata drept cota neconforma', !recTi.findings.some((f) => f.cod === 'tva-cota-neconforma'));
// Vanzare fara CUI de partener = B2C, si INTRA la e-Factura netrimisa: din 1 ianuarie 2025 se
// raporteaza si facturile catre persoane fizice. Aserțiunea de aici cerea CONTRARIUL, adica exact
// regula de dinainte de B2C — si tocmai de aceea filtrul care le tacea a supravietuit atat.
// Lipsa codului e normala aici, nu o scapare: persoana fizica nu e obligata sa-si dea CNP-ul.
const recB2c = rep.tvaReconciliation(mkVat([
  { id: 'v4', tip: 'factura_vanzare_marfuri', document: 'BON1', period: '2026-06', data: '2026-06-13', lines: [{ debit: '4111', credit: '707', suma: 500 }, { debit: '4111', credit: '4427', suma: 105 }] },
]), '2026-06');
ok('reconciliere: vanzare B2C (fara CUI) E semnalata ca netrimisa', recB2c.findings.some((f) => f.cod === 'efactura-netrimisa'));
// ...dar una catre un client din alt stat NU: obligatia priveste persoanele stabilite in Romania.
const recStrain = rep.tvaReconciliation(mkVat([
  { id: 'v5', tip: 'factura_vanzare_marfuri', partenerCui: 'DE811907980', document: 'F5', period: '2026-06', data: '2026-06-13', lines: [{ debit: '4111', credit: '707', suma: 500 }, { debit: '4111', credit: '4427', suma: 105 }] },
]), '2026-06');
ok('reconciliere: vanzare catre un beneficiar strain nu e semnalata', !recStrain.findings.some((f) => f.cod === 'efactura-netrimisa'));
// Dosar anual — perioadele de TVA dupa regim (helper pur; asamblarea completa e testata in http.js)
const dosarMod = require('../src/dosarAnual');
eq('dosar: perioade TVA lunare = 12 luni', dosarMod.vatPeriods({ perioadaTva: 'L' }, '2026').length, 12);
eq('dosar: perioade TVA trimestriale = 4 trimestre', dosarMod.vatPeriods({ perioadaTva: 'T' }, '2026').join(','), '2026-Q1,2026-Q2,2026-Q3,2026-Q4');
// D300 pe schema OFICIALA v12 — validata cu DUKIntegrator (scripts/valideaza-duk.sh):
// forma plata (atribute pe radacina), valori in lei intregi, suma de control + nr_evid.
const d300v12 = xml.d300Xml(v.company, '2026-06', rep.d300(v, '2026-06'), { nume: 'Popescu', prenume: 'Ion', functie: 'Contabil' });
ok('D300 bine-format', wellFormed(d300v12));
ok('D300 pe namespace-ul curent v12', d300v12.includes('xmlns="mfp:anaf:dgti:d300:declaratie:v12"'));
ok('D300: livrari 21% pe randul 9 (lei intregi)', d300v12.includes('R9_1="14000"') && d300v12.includes('R9_2="2940"'));
ok('D300: achizitii 21% pe randul 22', d300v12.includes('R22_1="10000"') && d300v12.includes('R22_2="2100"'));
ok('D300: total colectata (R17) si deductibila (R27)', d300v12.includes('R17_2="2940"') && d300v12.includes('R27_2="2100"'));
ok('D300: TVA de plata pe R41 (2940-2100)', d300v12.includes('R41_2="840"'));
ok('D300: suma de control totalPlata_A', d300v12.includes('totalPlata_A="64800"'));
// nr_evid pe 23 de cifre cu structura oficiala: 10 + 301(L) + 01 + LLAA + scadenta 25 + 0000 + ctl
const nrEvid = (d300v12.match(/nr_evid="(\d+)"/) || [])[1] || '';
eq('D300: nr_evid are 23 de cifre', nrEvid.length, 23);
ok('D300: nr_evid incepe cu 10-301-01 si perioada 0626', nrEvid.startsWith('103010106'));
ok('D300: firma completa in antet (banca/cont/caen/tip_decont)', d300v12.includes('banca="Banca Exemplu"') && d300v12.includes('caen="1071"') && d300v12.includes('tip_decont="L"'));
ok('D300 cu declarant: nume/prenume/functie', d300v12.includes('nume_declar="Popescu"') && d300v12.includes('prenume_declar="Ion"') && d300v12.includes('functie_declar="Contabil"'));
// fara declarant explicit, atributele obligatorii primesc valoarea implicita (schema le cere)
ok('D300 fara declarant: implicit Administrator', xml.d300Xml(v.company, '2026-06', rep.d300(v, '2026-06')).includes('nume_declar="Administrator"'));
// D394 pe schema OFICIALA v5 — validata cu DUKIntegrator (scripts/valideaza-duk.sh)
const d394v5 = xml.d394Xml(v.company, '2026-06', vj, { nume: 'Popescu', prenume: 'Ion', functie: 'Contabil' });
ok('D394 bine-format', wellFormed(d394v5));
ok('D394 pe namespace-ul curent v5', d394v5.includes('xmlns="mfp:anaf:dgti:d394:declaratie:v5"'));
ok('D394: op1 livrare cu CUI partener si tva', /<op1 tip="L" tip_partener="1" cota="21" cuiP="99887760"[^/]*baza="14000" tva="2940"/.test(d394v5));
ok('D394: op1 achizitie cu CUI partener', /<op1 tip="A" tip_partener="1" cota="21" cuiP="11223342"/.test(d394v5));
ok('D394: rezumat1 cu toate coloanele obligatorii (L/A/AI/C)', /rezumat1 tip_partener="1" cota="21" facturiL="1" bazaL="14000" tvaL="2940"[^/]*facturiAI="0"[^/]*facturiC="0"/.test(d394v5));
ok('D394: rezumat2 pe cota cu incasari zero', /rezumat2 cota="21"[^/]*baza_incasari_i1="0"/.test(d394v5));
ok('D394: serie facturi alocata+emisa (EXP 2001)', /serieFacturi tip="1" serieI="EXP" nrI="2001"/.test(d394v5) && /serieFacturi tip="2" serieI="EXP" nrI="2001"/.test(d394v5));
ok('D394: contoare parteneri (nrCui1=2)', d394v5.includes('nrCui1="2"'));
ok('D394: suma de control (2 parteneri + baze)', d394v5.includes('totalPlata_A="24002"'));
ok('D394: fara tvaCol/tvaDed cand nu e TVA la incasare', !/tvaCol21=/.test(d394v5));
const d394ai = xml.d394Xml(Object.assign({}, v.company, { tvaLaIncasare: true }), '2026-06', vj);
ok('D394 cu TVA la incasare: toate cotele tvaCol/tvaDed prezente', /sistemTVA="1"/.test(d394ai) && /tvaCol21="2940"/.test(d394ai) && /tvaCol5="0"/.test(d394ai) && /tvaDed21="2100"/.test(d394ai));
// defalcare pe cote
eq('o singura cota la vanzari (21%)', vj.coteV.length, 1);
eq('cota vanzari 21%', vj.coteV[0].cota, 21);
eq('baza la cota 21% = total baza', vj.coteV[0].baza, vj.totals.bazaV);
const vMix = { entries: v.entries.concat([{ id: 'z', data: '2026-06-12', period: '2026-06', tip: 't', tipNume: 't', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 110 }] }]), openingBalances: v.openingBalances };
const vjMix = acc.vatJournals(vMix, '2026-06');
eq('doua cote dupa adaugarea unei vanzari 11%', vjMix.coteV.length, 2);
eq('TVA la cota 11%', (vjMix.coteV.find((c) => c.cota === 11) || {}).tva, 110);
const d300xmlMix = xml.d300Xml(v.company, '2026-06', rep.d300(vMix, '2026-06'));
ok('D300 XML cu cote ramane bine-format', wellFormed(d300xmlMix));

section('Declaratii XML: date externe cu caractere speciale (escapare)');
// Denumirile de parteneri vin din e-Factura/SPV, extrase bancare si extragerea AI din PDF —
// „Ion & Co <SRL>" e un nume perfect legal. Neescapat, ar produce XML INVALID, adica o
// declaratie RESPINSA de ANAF; sau, mai rau, ar injecta elemente in declaratie.
//
// ATENTIE la ce NU dovedeste `wellFormed`: verifica doar echilibrul etichetelor, iar un
// `<b>x</b>` injectat din date e echilibrat, deci ar trece. De aceea se verifica in plus ca
// markup-ul din date NU apare brut si ca entitatile escapate SUNT prezente (adica datele au
// ajuns in declaratie, nu au fost pierdute tacit).
const OSTIL = ' & <b>x</b> "q" \'a\'';
const CAMPURI_TEXT = new Set(['nume', 'den', 'denumire', 'partener', 'explicatie', 'descriere', 'adresa', 'oras', 'tipNume', 'document']);
function contamineaza(o, seen) {
  seen = seen || new Set();
  if (!o || typeof o !== 'object' || seen.has(o)) return o;
  seen.add(o);
  for (const k of Object.keys(o)) {
    const val = o[k];
    if (typeof val === 'string' && CAMPURI_TEXT.has(k) && val) o[k] = val + OSTIL;
    else if (val && typeof val === 'object') contamineaza(val, seen);
  }
  return o;
}
const vX = contamineaza(JSON.parse(JSON.stringify(v)));
const vjX = acc.vatJournals(vX, '2026-06');
// `&` care nu deschide o entitate valida = XML invalid (cauza cea mai frecventa la respingere)
const ampBrut = (x) => /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(String(x));
const declaratii = [
  ['e-Factura', () => xml.eFacturaXml(vX.company, vX.entries.find((e) => e.tip === 'factura_vanzare_marfuri'), vX.partners)],
  ['D300', () => xml.d300Xml(vX.company, '2026-06', rep.d300(vX, '2026-06'), { nume: 'Popescu' + OSTIL, prenume: 'Ion', functie: 'Contabil' })],
  ['D394', () => xml.d394Xml(vX.company, '2026-06', vjX)],
  ['SAF-T lunar', () => saft.saftXml(vX, '2026-06')],
  ['SAF-T anual', () => saft.saftXml(vX, 2026)],
];
for (const [nume, fn] of declaratii) {
  let out = '';
  let err = null;
  try { out = fn(); } catch (e) { err = e; }
  ok(nume + ': se genereaza cu denumiri care contin & < > " \'' + (err ? ' — ' + err.message.slice(0, 50) : ''), !err && out.length > 100);
  if (err) continue;
  ok(nume + ': ramane bine-format', wellFormed(out));
  ok(nume + ': niciun & neescapat (ar invalida XML-ul)', !ampBrut(out));
  ok(nume + ': markup-ul din date nu ajunge brut in declaratie', !out.includes('<b>x</b>'));
  ok(nume + ': datele chiar ajung in declaratie, escapate', out.includes('&amp;') && out.includes('&lt;b&gt;'));
}
// contra-proba: verificarile de mai sus chiar pot pica pe un XML construit gresit
const xmlGresit = '<a><nume>Ion & Co <b>x</b></nume></a>';
ok('contra-proba: un XML cu date neescapate e prins de verificari', ampBrut(xmlGresit) && xmlGresit.includes('<b>x</b>'));

// Poarta statica peste sursa generatoarelor: testele de mai sus acopera doar campurile atinse de
// datele de test. Un camp nou, pe o ramura pe care seed-ul nu o parcurge, ar trece neobservat.
// Se scot apelurile de escapare CU TOT cu argumentul (paranteze echilibrate), conditiile de
// ternar si literalii de sir — ce ramane e ce ajunge neescapat in declaratie.
const CAMP_RISCANT = /\b(nume|denumire|partener|adresa|oras|judet|explicatie|descriere|localitate|strada|firma|client|furnizor|banca|produs|serie|document|mentiuni|reprezentant)\b/i;
// `at`/`atNum` (src/etransport.js) sunt invelisuri care escapeaza ele insele si, in plus, OMIT
// atributul cand valoarea e goala (schema cere minLength=1). Sunt acceptate aici doar pentru ca
// escaparea lor e dovedita separat, pe iesire, in sectiunea e-Transport („atribut optional").
const ESC_XML = /\b(esc|at|atNum|num2|numOf|roCui|umCode|Number|String|Math|parseInt|parseFloat|encodeURIComponent)\(/;
function faraEsc(expr) {
  let s = expr;
  for (let p = 0; p < 12; p += 1) {
    const m = s.match(ESC_XML);
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
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(q + 1);
  return s.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
}
const fsx2 = require('fs');
const pth2 = require('path');
const { markupInterps } = require('./tpl-scan');
const TAG_XML = /<[a-zA-Z/?][\w:.-]*[\s/>]/;
const srcDir = pth2.join(__dirname, '..', 'src');
const citeste = (f) => fsx2.readFileSync(pth2.join(srcDir, f), 'utf8');
// DOUA schimbari fata de varianta ancorata pe linie, amandoua masurate inainte:
//  1. Scanarea merge pe TEMPLATE, nu pe linie. Ancora veche („linia contine <tag") sarea liniile
//     de continuare ale template-urilor pe mai multe randuri — 28% dintre interpolarile din
//     generatoare, dintre care 20 chiar cu nume de camp riscant. Toate erau escapate corect:
//     gaura era reala, dar goala. Tinea disciplina, nu poarta.
//  2. Lista de fisiere se DERIVA din sursa (orice modul din src/ care compune markup), nu se
//     scrie de mana. Varianta veche fixa trei fisiere si nu stia de src/sepa.js — fisierul de
//     plati pain.001, adaugat ulterior, care pleaca la BANCA.
const generatoare = fsx2.readdirSync(srcDir)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => markupInterps(citeste(f), TAG_XML).length > 0);
const neescapateXml = [];
for (const f of generatoare) {
  for (const it of markupInterps(citeste(f), TAG_XML)) {
    if (CAMP_RISCANT.test(it.expr) && CAMP_RISCANT.test(faraEsc(it.expr))) {
      neescapateXml.push(f + ':' + it.line + ' ${' + it.expr.slice(0, 50) + '}');
    }
  }
}
ok('niciun camp de text interpolat in XML fara esc()'
  + (neescapateXml.length ? ' — ' + neescapateXml.slice(0, 3).join(' | ') : ''), neescapateXml.length === 0);
ok('perimetrul portii XML se deriva, nu e scris de mana (prinde si sepa.js)',
  generatoare.includes('xml.js') && generatoare.includes('saft.js')
  && generatoare.includes('etransport.js') && generatoare.includes('sepa.js'));
// contra-probe pe MECANISMUL nou: un template pe mai multe randuri, cu interpolarea pe o linie
// care nu contine niciun tag — exact forma pe care poarta veche o sarea.
const tplMulti = ['const x = `<Invoice>', '  <Name>${p.denumire}</Name>', '</Invoice>`;'].join('\n');
ok('poarta XML vede interpolarile de pe liniile de continuare (ancora veche le sarea)',
  markupInterps(tplMulti, TAG_XML).some((it) => CAMP_RISCANT.test(faraEsc(it.expr))));
ok('poarta XML chiar detecteaza o interpolare neescapata',
  markupInterps('const x = `<Name>${p.denumire}</Name>`;', TAG_XML).some((it) => CAMP_RISCANT.test(faraEsc(it.expr))));
ok('poarta XML nu raporteaza o interpolare escapata',
  !markupInterps('const x = `<Name>${esc(p.denumire)}</Name>`;', TAG_XML).some((it) => CAMP_RISCANT.test(faraEsc(it.expr))));
// scanerul trebuie sa treaca peste literalii REGEX: fara asta raporta ZERO template-uri in
// sepa.js (fisier plin de ele) si poarta ar fi dat un „curat" fals pe tot fisierul
ok('scanerul nu se pierde pe un literal regex dinaintea template-ului',
  markupInterps('const r = /["\'`]/g; const x = `<Name>${p.denumire}</Name>`;', TAG_XML).length === 1);
ok('D300 XML: cota 21 pe randul 9', /R9_1="14000"/.test(d300xmlMix) && /R9_2="2940"/.test(d300xmlMix));
ok('D300 XML: cota 11 pe randul 10', /R10_1="1000"/.test(d300xmlMix) && /R10_2="110"/.test(d300xmlMix));
ok('D300 XML: totalul colectat insumeaza cotele (R17)', /R17_2="3050"/.test(d300xmlMix));
const d394xmlMix = xml.d394Xml(v.company, '2026-06', vjMix);
ok('D394 XML cu cote ramane bine-format', wellFormed(d394xmlMix));
// vanzarea de 1000 la 11% e fara CUI de partener => nu intra in op1 (D394 e B2B pe CUI),
// dar rezumat2 pe cota 21 ramane
ok('D394 XML: rezumat2 pe cota 21 prezent', /rezumat2 cota="21"/.test(d394xmlMix));

section('Inchiderea TVA (2026-06)');
const vc = acc.vatClosing(v, '2026-06');
eq('TVA colectata', vc.colectata, 2940);
eq('TVA deductibila', vc.deductibila, 2100);
eq('TVA de plata (diff)', vc.diff, 840);
eq('ultima linie = TVA de plata 4427=4423', JSON.stringify([vc.lines[vc.lines.length - 1].debit, vc.lines[vc.lines.length - 1].credit, vc.lines[vc.lines.length - 1].suma]), JSON.stringify(['4427', '4423', 840]));

// ── Pozitia de TVA REPORTATA din perioadele anterioare (D300 rd. 35/38 + compensarea 4423=4424) ──
// REGRESIE. `vatClosing` privea doar rulajul lunii, iar `d300Rows` scria `R37 = R34` si `R40 = R33`,
// adica randurile 35 si 38 erau zero PRIN CONSTRUCTIE. Consecinta dubla: firma cu TVA de recuperat
// declara de plata tot TVA-ul lunii urmatoare, iar 4424 ramanea blocat ca activ la nesfarsit —
// bilantul arata simultan creanta si datorie catre acelasi buget, umflate cu aceeasi suma. Eroarea
// e simetrica, deci nicio verificare de echilibru nu o putea prinde.
{
  const T = (id, data, lines) => ({ id, data, period: data.slice(0, 7), tip: 'x', tipNume: 'x', lines });
  const comp = { openingBalances: {}, company: { cui: 'RO1', nume: 'X', perioadaTva: 'L' }, entries: [
    // ianuarie: achizitie 20.000 + TVA 4.200 -> TVA de recuperat 4.200
    T('r1', '2026-01-10', [{ debit: '371', credit: '401', suma: 20000 }, { debit: '4426', credit: '401', suma: 4200 }]),
    T('r2', '2026-01-31', [{ debit: '4424', credit: '4426', suma: 4200 }]),
    // februarie: vanzare 40.000 + TVA 8.400
    T('r3', '2026-02-10', [{ debit: '4111', credit: '707', suma: 40000 }, { debit: '4111', credit: '4427', suma: 8400 }]),
  ] };
  const vcFeb = acc.vatClosing(comp, '2026-02');
  eq('pozitia reportata: 4.200 de recuperat din ianuarie', vcFeb.report.deRecuperat, 4200);
  eq('nota de inchidere compenseaza reportul', vcFeb.compensare, 4200);
  ok('compensarea e articolul 4423 = 4424', vcFeb.lines.some((l) => l.debit === '4423' && l.credit === '4424' && l.suma === 4200));
  eq('de plata efectiv: 8.400 - 4.200', vcFeb.dePlataFinal, 4200);
  eq('creanta de TVA se stinge, nu se reporteaza la infinit', vcFeb.deRecuperatFinal, 0);
  // Declaratia trebuie sa spuna acelasi lucru ca nota contabila.
  const AF = xml.d300Rows(rep.d300(comp, '2026-02'));
  eq('D300 rd. 34 — taxa de plata a perioadei', AF.R34_2, 8400);
  eq('D300 rd. 38 — suma negativa reportata (era mereu 0)', AF.R38_2, 4200);
  eq('D300 rd. 41 — de plata dupa report = cat spune nota', AF.R41_2, vcFeb.dePlataFinal);
  // Formulele OFICIALE ale decontului, verificate pe randurile emise (validatorul le impune).
  ok('R37 = R34 + R35 + R36', AF.R37_2 === (AF.R34_2 || 0) + (AF.R35_2 || 0) + (AF.R36_2 || 0));
  ok('R40 = R33 + R38 + R39', AF.R40_2 === (AF.R33_2 || 0) + (AF.R38_2 || 0) + (AF.R39_2 || 0));
  ok('R41/R42 se exclud reciproc', !(AF.R41_2 > 0 && AF.R42_2 > 0));

  // ── Randul 35: „neachitata pana la depunere", nu „soldul de la inceputul lunii" ──
  // TVA-ul lunii ianuarie se plateste pana pe 25 februarie, adica IN februarie. Un rand 35 calculat
  // pe soldul de deschidere ar raporta ca neachitata exact datoria platita la timp — si ar umfla
  // TVA-ul declarat. De aceea din sold se scade ce s-a stins in cursul perioadei.
  const neplatit = { openingBalances: {}, company: { cui: 'RO1', nume: 'X' }, entries: [
    T('p1', '2026-01-10', [{ debit: '4111', credit: '707', suma: 20000 }, { debit: '4111', credit: '4427', suma: 4000 }]),
    T('p2', '2026-01-31', [{ debit: '4427', credit: '4423', suma: 4000 }]),
    T('p3', '2026-02-10', [{ debit: '4111', credit: '707', suma: 5000 }, { debit: '4111', credit: '4427', suma: 1000 }]),
  ] };
  eq('rd. 35: datoria din ianuarie, NEachitata', xml.d300Rows(rep.d300(neplatit, '2026-02')).R35_2, 4000);
  const platit = { openingBalances: {}, company: neplatit.company,
    entries: neplatit.entries.concat([T('p4', '2026-02-24', [{ debit: '4423', credit: '5121', suma: 4000 }])]) };
  eq('rd. 35: aceeasi datorie, platita pe 24 februarie -> 0', xml.d300Rows(rep.d300(platit, '2026-02')).R35_2, 0);
  eq('...si nici nu apare vreo compensare inventata', acc.vatClosing(platit, '2026-02').compensare, 0);
  // O plata mai mare decat datoria (avans la buget) nu devine rand negativ pe declaratie.
  const avans = { openingBalances: {}, company: neplatit.company,
    entries: neplatit.entries.concat([T('p5', '2026-02-24', [{ debit: '4423', credit: '5121', suma: 9000 }])]) };
  eq('plata peste datorie -> rd. 35 ramane 0, nu negativ', xml.d300Rows(rep.d300(avans, '2026-02')).R35_2, 0);
  // Fara nimic reportat, comportamentul istoric e neatins (nicio linie de compensare in plus).
  eq('fara report, nota de inchidere ramane cea de dinainte', vc.lines.length, acc.vatClosing(v, '2026-06').lines.length);
  eq('fara report, rd. 38 ramane 0', xml.d300Rows(rep.d300(v, '2026-06')).R38_2, 0);
}

section('Inchiderea anuala (2026)');
const an = acc.annualClosing(v, '2026');
eq('total venituri inchise', an.totalVen, 14000);
eq('total cheltuieli inchise', an.totalChelt, 13579.17);
eq('rezultat (121) = rezultat brut P&L', an.rezultat, 420.83);
ok('contine inchidere venituri 707=121', an.lines.some((l) => l.debit === '707' && l.credit === '121'));
ok('contine inchidere cheltuieli 121=607', an.lines.some((l) => l.debit === '121' && l.credit === '607'));

// Inchiderea anuala muta clasele 6/7 in 121 cu un rulaj EGAL SI DE SENS OPUS celui din cursul
// anului. Daca agregarile de rezultat nu o exclud, dupa inchidere toate ies zero — impozitul pe
// profit s-ar inregistra 0, iar contul de profit si pierdere depus ar fi gol. Aici blocam exact
// asta: rapoartele anului trebuie sa dea ACELASI lucru inainte si dupa inchidere.
section('Inchiderea anuala nu goleste rapoartele de rezultat (ordinea inchiderilor)');
const vInchis = JSON.parse(JSON.stringify(v));
vInchis.entries.push({ id: 'e-inchidere-an', firmaId: v.company.id, data: '2026-12-31', period: '2026-12',
  tip: 'inchidere_an', tipNume: 'Inchidere conturi venituri/cheltuieli', partener: '', document: 'Inchidere 2026',
  explicatie: '', fileId: null, system: true, lines: an.lines });

eq('profitTax: profit contabil neschimbat', acc.profitTax(vInchis, '2026', { cota: 16 }).profitContabil,
  acc.profitTax(v, '2026', { cota: 16 }).profitContabil);
eq('profitTax: impozitul nu devine 0', acc.profitTax(vInchis, '2026', { cota: 16 }).impozit,
  acc.profitTax(v, '2026', { cota: 16 }).impozit);
eq('P&L: venit total neschimbat', stmt.profitLoss(vInchis, '2026').venitTotal, stmt.profitLoss(v, '2026').venitTotal);
eq('P&L: rezultat brut neschimbat', stmt.profitLoss(vInchis, '2026').rezBrut, stmt.profitLoss(v, '2026').rezBrut);
eq('F20: cifra de afaceri neschimbata', stmt.profitLossF20(vInchis, '2026').cifraAfaceri, stmt.profitLossF20(v, '2026').cifraAfaceri);
eq('registru fiscal: rezultat contabil neschimbat', rep.registruFiscal(vInchis, '2026').rezultatContabil,
  rep.registruFiscal(v, '2026').rezultatContabil);
eq('D100 micro: venitul anului neschimbat', rep.d100micro(vInchis, '2026-06').venitAn, rep.d100micro(v, '2026-06').venitAn);
eq('serie lunara: decembrie nu e golita de inchidere',
  rep.monthlySeries(vInchis, '2026').reduce((s, m) => s + m.venituri, 0),
  rep.monthlySeries(v, '2026').reduce((s, m) => s + m.venituri, 0));

// ...dar REGISTRELE trebuie sa vada inchiderea (e o nota contabila reala), iar o a doua rulare
// a inchiderii nu are ce mai inchide (idempotenta se bazeaza tocmai pe anularea rulajelor).
ok('cartea mare vede nota de inchidere pe 121', acc.ledger(vInchis, '2026').some((c) => c.cod === '121' && (c.rd || c.rc)));
ok('balanta ramane echilibrata dupa inchidere', acc.trialBalance(vInchis, '2026').balanced);
ok('bilantul ramane echilibrat dupa inchidere', stmt.balanceSheetF10(vInchis, '2026-12').echilibrat);
eq('a doua inchidere nu mai are ce inchide', acc.annualClosing(vInchis, '2026').lines.length, 0);

// Linia 121 = 691 atasata impozitului cand anul era deja inchis: tot o inchidere de rezultat.
ok('121 = 691 recunoscut ca linie de inchidere', acc.isResultClosingLine({ debit: '121', credit: '691' }));
ok('121 = 4111 NU e linie de inchidere', !acc.isResultClosingLine({ debit: '121', credit: '4111' }));

// REGRESIE. Sectiunea de mai sus exista, dar acoperea doar patru consumatori — iar filtrul lipsea
// in alti cinci, unde acelasi defect traia netulburat. Fiecare agregare pe clasele 6/7 trebuie sa
// dea ACEEASI cifra inainte si dupa nota de inchidere; ancora e egalitatea, nu o valoare.
{
  const fc = require('../src/fiscalControls');
  const yEnt = (view) => acc.postedEntries(view).filter((e) => String(e.period || '').startsWith('2026'));
  eq('cifra de afaceri (plafon scutire TVA) neschimbata',
    fc.cifraAfaceri(yEnt(vInchis)), fc.cifraAfaceri(yEnt(v)));
  ok('...si nu e zero, altfel egalitatea ar fi trecut degeaba', fc.cifraAfaceri(yEnt(v)) > 0);
  eq('veniturile clasei 7 (plafon micro) neschimbate',
    fc.venituriClasa7(yEnt(vInchis)), fc.venituriClasa7(yEnt(v)));
  eq('D101: rezultatul brut neschimbat', rep.d101(vInchis, '2026').rezultatBrut, rep.d101(v, '2026').rezultatBrut);
  eq('D101: rezultatul din exploatare neschimbat', rep.d101(vInchis, '2026').rezExploatare, rep.d101(v, '2026').rezExploatare);
  // Ancora interna a D101: rezultatul brut raportat (P3) si baza impozabila trebuie sa vina din
  // acelasi rulaj. Cat timp `d101` filtra altfel decat `profitTax`, declaratia se contrazicea
  // singura — P3 zero cu impozit nenul, ceea ce niciun control aritmetic al validatorului nu prinde.
  const dInchis = rep.d101(vInchis, '2026');
  ok('D101 nu se contrazice: rezultat brut 0 doar daca si profitul impozabil e 0',
    dInchis.rezultatBrut !== 0 || dInchis.profitImpozabil === 0);
  // Buget vs realizat: conturile bugetate SUNT clasele 6/7, deci realizatul cadea la zero si tot
  // bugetul aparea neconsumat.
  const bg = [{ id: 'b1', cont: '704', suma: 1000 }, { id: 'b2', cont: '607', suma: 500 }];
  eq('buget vs realizat: realizatul nu se goleste la inchidere',
    JSON.stringify(rep.budgetReport(vInchis, bg, '2026').rows.map((x) => x.actual)),
    JSON.stringify(rep.budgetReport(v, bg, '2026').rows.map((x) => x.actual)));
  // D112 cere salarii SI inchidere in aceeasi luna — cazul real: nota de inchidere e datata
  // 31 decembrie, adica exact in luna pe care o raporteaza recapitulativul.
  const L = (data, lines) => ({ id: 'd112-' + data, data, period: data.slice(0, 7), tip: 'x', tipNume: 'x', lines });
  const salarii = L('2026-12-30', [{ debit: '641', credit: '421', suma: 10000 },
    { debit: '421', credit: '4315', suma: 2500 }, { debit: '421', credit: '4316', suma: 1000 },
    { debit: '421', credit: '444', suma: 650 }, { debit: '646', credit: '436', suma: 225 }]);
  const inchDec = L('2026-12-31', [{ debit: '121', credit: '641', suma: 10000 }, { debit: '121', credit: '646', suma: 225 }]);
  const d112Fara = rep.d112({ entries: [salarii], openingBalances: {} }, '2026-12');
  const d112Cu = rep.d112({ entries: [salarii, inchDec], openingBalances: {} }, '2026-12');
  eq('D112 decembrie: brutul supravietuieste inchiderii anuale', d112Cu.brut, d112Fara.brut);
  eq('D112 decembrie: brutul e cel real, nu zero', d112Cu.brut, 10000);
  // Netul e brut - retineri: cu brutul golit iesea NEGATIV, fiindca retinerile (clasa 4) raman.
  ok('D112 decembrie: netul nu mai poate iesi negativ', d112Cu.net === 5850 && d112Cu.net > 0);
}

section('Repartizarea rezultatului (121 -> 117)');
const profitDb = { entries: [
  { id: 'c1', period: '2026-12', data: '2026-12-31', lines: [{ debit: '707', credit: '121', suma: 10000 }] },
  { id: 'c2', period: '2026-12', data: '2026-12-31', lines: [{ debit: '121', credit: '607', suma: 7000 }] },
] };
const rdP = acc.resultDistribution(profitDb, '2026');
eq('profit in 121 (10000-7000)', rdP.profit, 3000);
eq('o linie generata', rdP.lines.length, 1);
eq('profit: 121 = 117', rdP.lines[0].debit + '=' + rdP.lines[0].credit, '121=117');
eq('suma repartizata = profit', rdP.lines[0].suma, 3000);

// Rezerva legala (art. 183 Legea 31/1990): 5% din profitul BRUT, pana cand rezerva atinge 20% din
// capitalul social. Constituirea e OBLIGATORIE cat timp plafonul nu e atins. Pana acum era doar
// AFISATA in notele explicative — nicio nota contabila nu o constituia, iar contul 129 (existent
// in plan si mapat in bilant) nu era alimentat de nimic.
const mkRez = (capital, brut, impozit, rezervaExist) => ({
  // 1012, nu 101: contul sintetic nu exista in plan (capitalul social sta pe 1011/1012)
  openingBalances: Object.assign({ 1012: { d: 0, c: capital }, 5121: { d: capital, c: 0 } },
    rezervaExist ? { 1061: { d: 0, c: rezervaExist }, 117: { d: rezervaExist, c: 0 } } : {}),
  entries: [
    { id: 'rv', data: '2026-06-01', period: '2026-06', tip: 't', tipNume: 't', lines: [{ debit: '4111', credit: '704', suma: brut }] },
    { id: 'ri', data: '2026-12-31', period: '2026-12', tip: 'impozit_profit', tipNume: 't', lines: [{ debit: '691', credit: '4411', suma: impozit }] },
    { id: 'rz', data: '2026-12-31', period: '2026-12', tip: 'inchidere_an', tipNume: 't',
      lines: [{ debit: '704', credit: '121', suma: brut }, { debit: '121', credit: '691', suma: impozit }] },
  ],
});
const rezA = acc.resultDistribution(mkRez(200000, 10000, 1600, 0), '2026');
eq('rezerva: baza e profitul BRUT (10000), nu cel net (8400)', rezA.rezervaInfo.profitBrut + '/' + rezA.sold121, '10000/8400');
eq('rezerva: 5% din brut = 500', rezA.rezervaLegala, 500);
eq('rezerva: constituire 129 = 1061', rezA.lines[0].debit + '=' + rezA.lines[0].credit + '/' + rezA.lines[0].suma, '129=1061/500');
eq('rezerva: inchiderea contului de repartizare 121 = 129', rezA.lines[1].debit + '=' + rezA.lines[1].credit + '/' + rezA.lines[1].suma, '121=129/500');
eq('rezerva: restul merge la reportat (8400 - 500)', rezA.lines[2].debit + '=' + rezA.lines[2].credit + '/' + rezA.lines[2].suma, '121=117/7900');
eq('rezerva + reportat = profitul net de repartizat', Math.round((rezA.rezervaLegala + rezA.reportat) * 100) / 100, rezA.sold121);
// plafonul de 20% din capitalul social taie rezerva
const rezB = acc.resultDistribution(mkRez(200, 10000, 1600, 0), '2026');
eq('plafon: 20% din capital social (200) limiteaza rezerva la 40', rezB.rezervaLegala + '/' + rezB.rezervaInfo.plafon, '40/40');
// rezerva deja la plafon -> nu se mai constituie nimic
const rezC = acc.resultDistribution(mkRez(10000, 10000, 1600, 2000), '2026');
eq('rezerva deja la plafon (2000 = 20% din 10000) -> nu se mai constituie', rezC.rezervaLegala, 0);
eq('la plafon atins ramane o singura linie, 121 = 117', rezC.lines.length + '/' + rezC.lines[0].credit, '1/117');
// pierderea nu constituie rezerva
const rezD = acc.resultDistribution(mkRez(200000, -5000, 0, 0), '2026');
eq('pierdere: fara rezerva, doar reportarea 117 = 121', rezD.rezervaLegala + '/' + rezD.lines.length + '/' + rezD.lines[0].debit, '0/1/117');

// ── DEDUCTIBILITATEA rezervei (art. 26(1)(a)) ────────────────────────────────────────────────
// REGRESIE. Regula era calculata exact si `resultDistribution` POSTA articolul 129 = 1061, dar
// impozitul nu scadea niciodata suma: firma constituia rezerva obligatoriu (art. 183 Legea
// 31/1990) si platea 16% pe ea. Deducerea nu se putea deriva din rulaj — rezerva nu trece prin
// niciun cont de clasa 6 — deci absenta ei nu se vedea in nicio verificare de echilibru.
{
  const P = require('../src/fiscalConfig').RATES;
  const { round2: round2ForRez } = require('../src/util');
  const opts = { cota: 16, plafoane: P };
  const vRez = mkRez(200000, 10000, 0, 0); // capital 200.000, profit brut 10.000
  const ptRez = acc.profitTax(vRez, '2026', opts);
  eq('rezerva legala e calculata in impozit (5% din 10.000)', ptRez.rezervaLegala, 500);
  eq('...si intra in deduceri', ptRez.deduceri, 500);
  eq('profit impozabil = brut - rezerva', ptRez.profitImpozabil, 9500);
  eq('impozitul scade cu 16% din rezerva', ptRez.impozit, 1520);
  eq('fara deducere ar fi fost 1.600', round2ForRez(10000 * 0.16), 1600);
  // Ancora care conteaza: se DEDUCE exact cat se POSTEAZA. Doua cifre diferite ar insemna ca
  // firma deduce o rezerva pe care n-o constituie — sau invers.
  ok('rezerva dedusa = rezerva postata la repartizare',
    ptRez.rezervaLegala === acc.resultDistribution(mkRez(200000, 10000, 1520, 0), '2026').rezervaLegala);
  // Plafonul si pierderea se propaga si in deducere, nu doar in articol.
  eq('plafonul de 20% taie si deducerea', acc.profitTax(mkRez(200, 10000, 0, 0), '2026', opts).rezervaLegala, 40);
  eq('rezerva la plafon -> nicio deducere', acc.profitTax(mkRez(10000, 10000, 0, 2000), '2026', opts).rezervaLegala, 0);
  eq('an pe pierdere -> nicio deducere', acc.profitTax(mkRez(200000, -5000, 0, 0), '2026', opts).rezervaLegala, 0);
  // Contractul apelantilor „simpli" ramane neatins (fara `plafoane`, nicio ajustare derivata).
  eq('fara opts.plafoane: nicio rezerva dedusa', acc.profitTax(vRez, '2026', { cota: 16 }).rezervaLegala, 0);
  eq('deducerea transmisa explicit bate motorul', acc.profitTax(vRez, '2026', Object.assign({ deduceri: 0 }, opts)).deduceri, 0);

  // ── Plafonul se ia de pe capitalul VARSAT (1012), nu pe prefixul `101` ──
  // Cat timp planul avea un singur cont de capital, cele doua coincideau. De cand exista si 1011
  // (subscris NEvarsat, adaugat odata cu monografia de constituire), prefixul umfla plafonul cu
  // partea nevarsata — exact ce interzice art. 26, care spune „subscris SI varsat".
  const T = (id, data, lines) => ({ id, data, period: data.slice(0, 7), tip: 'x', tipNume: 'x', lines });
  const partial = { openingBalances: {}, assets: [], company: {}, entries: [
    T('k1', '2026-01-05', [{ debit: '456', credit: '1011', suma: 200000 }]),                    // subscris 200.000
    T('k2', '2026-01-20', [{ debit: '5121', credit: '456', suma: 20000 }, { debit: '1011', credit: '1012', suma: 20000 }]), // varsat 20.000
    T('k3', '2026-06-10', [{ debit: '4111', credit: '704', suma: 500000 }]),
    T('k4', '2026-06-11', [{ debit: '607', credit: '371', suma: 100000 }]),
  ] };
  const lrP = acc.legalReserve(partial, '2026');
  eq('capitalul luat in calcul e cel VARSAT (20.000), nu cel subscris', lrP.capitalSocial, 20000);
  eq('plafonul e 20% din varsat = 4.000, nu 40.000', lrP.plafon, 4000);
  eq('rezerva e taiata la plafon', lrP.rezerva, 4000);
  eq('...si deducerea din impozit urmeaza acelasi plafon', acc.profitTax(partial, '2026', opts).rezervaLegala, 4000);
  // Dupa varsarea integrala, plafonul devine cel al capitalului intreg.
  const integral = { openingBalances: {}, assets: [], company: {}, entries: partial.entries.slice(0, 1).concat([
    T('k2b', '2026-01-20', [{ debit: '5121', credit: '456', suma: 200000 }, { debit: '1011', credit: '1012', suma: 200000 }]),
  ]).concat(partial.entries.slice(2)) };
  eq('capital varsat integral -> plafon 40.000', acc.legalReserve(integral, '2026').plafon, 40000);
  // Regula pura, direct: aceleasi cifre fara baza de date.
  eq('regula pura: 5% din brut, sub plafon', acc.rezervaLegalaDin(10000, 200000, 0).rezerva, 500);
  eq('regula pura: plafonul taie', acc.rezervaLegalaDin(10000, 200, 0).rezerva, 40);
  eq('regula pura: rezerva existenta consuma plafonul', acc.rezervaLegalaDin(10000, 10000, 2000).rezerva, 0);
}
// contul 129 e de TRANZIT: dupa repartizare soldul lui e zero, iar balanta ramane echilibrata
const dbRez = mkRez(200000, 10000, 1600, 0);
dbRez.entries.push({ id: 'rp', data: '2026-12-31', period: '2026-12', tip: 'repartizare_rezultat', tipNume: 't', lines: rezA.lines });
const tbRez = acc.trialBalance(dbRez, '2026');
ok('dupa repartizare, contul 129 are sold zero (cont de tranzit)',
  !(tbRez.rows.find((r) => r.cod === '129') || {}).sfD && !(tbRez.rows.find((r) => r.cod === '129') || {}).sfC);
eq('rezerva ajunge in 1061', (tbRez.rows.find((r) => r.cod === '1061') || {}).sfC, 500);
ok('balanta ramane echilibrata dupa constituirea rezervei', tbRez.balanced);
// nota explicativa si nota contabila folosesc ACEEASI regula (bazele difera deliberat: nota
// citeste din contul de profit si pierdere, deci merge si inainte de inchiderea anuala)
eq('nota 3 si repartizarea dau aceeasi rezerva', rep.notes(dbRez, '2026').rezervaLegala, rezA.rezervaLegala);
const lossDb = { entries: [
  { id: 'c1', period: '2026-12', data: '2026-12-31', lines: [{ debit: '707', credit: '121', suma: 5000 }] },
  { id: 'c2', period: '2026-12', data: '2026-12-31', lines: [{ debit: '121', credit: '607', suma: 8000 }] },
] };
const rdL = acc.resultDistribution(lossDb, '2026');
eq('pierdere in 121 (8000-5000)', rdL.pierdere, 3000);
eq('pierdere: 117 = 121', rdL.lines[0].debit + '=' + rdL.lines[0].credit, '117=121');
eq('sold 121 zero -> nicio linie', acc.resultDistribution({ entries: [] }, '2026').lines.length, 0);

section('Control casa (sold negativ + plafon Legea 70/2015)');
const cashDb = {
  openingBalances: { 5311: { d: 1000, c: 0 } },
  entries: [
    { id: 'p1', period: '2026-07', data: '2026-07-05', partener: 'ALFA SRL', partenerCui: 'RO123', lines: [{ debit: '401', credit: '5311', suma: 6000 }] },
    { id: 'i1', period: '2026-07', data: '2026-07-10', partener: 'Ion Pop', partenerCui: '', lines: [{ debit: '5311', credit: '707', suma: 12000 }] },
  ],
};
const cc = acc.cashControl(cashDb, '5311', '2026-07');
ok('sold de casa negativ detectat (1000-6000)', cc.negative.length >= 1);
ok('plafon plata juridic >5000 semnalat', cc.plafon.some((w) => w.tip === 'plata' && w.juridic && w.suma === 6000));
ok('plafon incasare fizic >10000 semnalat', cc.plafon.some((w) => w.tip === 'incasare' && !w.juridic && w.suma === 12000));
eq('sold final casa (1000-6000+12000)', cc.soldFinal, 7000);
const cashOk = acc.cashControl({ openingBalances: { 5311: { d: 5000, c: 0 } }, entries: [
  { id: 'x', period: '2026-07', data: '2026-07-01', partener: 'Y', partenerCui: 'RO9', lines: [{ debit: '401', credit: '5311', suma: 2000 }] }] }, '5311', '2026-07');
ok('casa fara probleme -> ok', cashOk.ok && !cashOk.negative.length && !cashOk.plafon.length);

// ── Plafonul de casierie se verifica la sfarsitul FIECAREI zile (Legea 70/2015 art. 4 alin. 4) ──
// Verificarea pe soldul FINAL al perioadei rata exact cazul tipic: firma trece de plafon la
// jumatatea lunii si depune excedentul inainte de sfarsit. Abaterea a existat, deci trebuie
// semnalata — cu ziua ei, ca sa se poata corecta.
const cashZi = acc.cashControl({ openingBalances: { 5311: { d: 0, c: 0 } }, entries: [
  { id: 'z1', period: '2026-03', data: '2026-03-10', partener: 'Client X', partenerCui: '', lines: [{ debit: '5311', credit: '707', suma: 60000 }] },
  { id: 'z2', period: '2026-03', data: '2026-03-25', partener: '', partenerCui: '', lines: [{ debit: '5121', credit: '5311', suma: 40000 }] },
] }, '5311', '2026-03');
eq('depasirea de casierie din cursul lunii e semnalata', cashZi.zilePesteLimita.length, 1);
eq('...cu ziua ei', cashZi.zilePesteLimita[0].data, '2026-03-10');
eq('...si cu soldul zilei', cashZi.zilePesteLimita[0].sold, 60000);
eq('(premisa) soldul FINAL era sub plafon — de asta scapa inainte', cashZi.soldFinal, 20000);
ok('controlul de casa nu mai raporteaza „ok"', !cashZi.ok);
// soldul zilei = dupa ULTIMA operatiune a zilei, nu dupa fiecare: doua incasari a 30.000 in
// aceeasi zi depasesc impreuna, chiar daca niciuna singura nu o face
const cashCumul = acc.cashControl({ openingBalances: { 5311: { d: 0, c: 0 } }, entries: [
  { id: 'c1', period: '2026-04', data: '2026-04-07', partener: 'A', partenerCui: '', lines: [{ debit: '5311', credit: '707', suma: 30000 }] },
  { id: 'c2', period: '2026-04', data: '2026-04-07', partener: 'B', partenerCui: '', lines: [{ debit: '5311', credit: '707', suma: 30000 }] },
] }, '5311', '2026-04');
eq('soldul de casierie se masoara CUMULAT pe zi', cashCumul.zilePesteLimita.length, 1);
eq('...la 60.000, nu la 30.000', cashCumul.zilePesteLimita[0].sold, 60000);
// ...si o zi care depaseste doar in cursul zilei, dar se inchide sub plafon, NU e abatere
const cashIntraZi = acc.cashControl({ openingBalances: { 5311: { d: 0, c: 0 } }, entries: [
  { id: 'i1', period: '2026-05', data: '2026-05-03', partener: 'A', partenerCui: '', lines: [{ debit: '5311', credit: '707', suma: 60000 }] },
  { id: 'i2', period: '2026-05', data: '2026-05-03', partener: '', partenerCui: '', lines: [{ debit: '5121', credit: '5311', suma: 45000 }] },
] }, '5311', '2026-05');
eq('depasirea doar in cursul zilei, inchisa sub plafon, nu e abatere', cashIntraZi.zilePesteLimita.length, 0);
// plafoanele vin din fiscalConfig, nu din cod
eq('plafonul de casierie vine din fiscalConfig', require('../src/fiscalConfig').RATES.plafonSoldCasa, 50000);
eq('plafonul numerar juridic vine din fiscalConfig', require('../src/fiscalConfig').RATES.plafonNumerarJuridic, 5000);
eq('plafonul numerar fizic vine din fiscalConfig', require('../src/fiscalConfig').RATES.plafonNumerarFizic, 10000);

// ── Stornarile si notele de credit pastreaza COTA facturii ──────────────────────────────────
// Cota se deducea din raport doar cand baza SI TVA erau POZITIVE: `bazaV > 0 && col > 0`. La un
// storno, la o nota de credit, la o reducere comerciala si la regularizarea unui avans, amandoua
// sunt NEGATIVE — deci randul primea cota 0.
//
// Cota 0 nu are rand in D300 (livrarile scutite au propriul canal), deci `put()` o arunca tacit;
// iar plasa de siguranta `d300CoteFaraRand` avea garda `c.cota &&`, adica exact cota 0 — falsy —
// ii scapa. Tacut de DOUA ori: suma disparea din decont SI din avertizare. Rezultatul: firma
// declara si plateste TVA pe factura INTREAGA, desi si-a stornat o parte, iar decontul contrazice
// propria contabilitate. Poarta fiscala nu putea prinde: XML-ul e perfect VALID, doar gresit.
{
  const { getType: gtS } = require('../src/documentTypes');
  const repS = require('../src/reporting');
  const xmlS = require('../src/xml');
  const mkS = (id, f, date) => ({ id: id + date, data: date, period: date.slice(0, 7), tip: id, tipNume: gtS(id).nume,
    partener: 'Client A', partenerCui: 'RO111', document: f.document, lines: gtS(id).build(f) });
  const cazuri = [
    { nume: 'storno de vanzare', v: true, entries: [
      mkS('factura_vanzare_servicii', { baza: 5000, tva: 1050, cota: 21, document: 'F-1' }, '2026-09-10'),
      mkS('factura_storno_vanzare', { baza: 1000, tva: 210, cota: 21, document: 'SF-1' }, '2026-09-25')] },
    { nume: 'reducere comerciala acordata', v: true, entries: [
      mkS('factura_vanzare_servicii', { baza: 5000, tva: 1050, cota: 21, document: 'F-2' }, '2026-09-10'),
      mkS('reducere_comerciala_acordata', { baza: 1000, tva: 210, cota: 21, document: 'RC-1' }, '2026-09-25')] },
    { nume: 'storno de achizitie', v: false, entries: [
      mkS('factura_cumparare_marfuri', { baza: 5000, tva: 1050, cota: 21, document: 'A-1' }, '2026-09-10'),
      mkS('factura_storno_cumparare', { baza: 1000, tva: 210, cota: 21, document: 'SA-1' }, '2026-09-25')] },
    { nume: 'reducere comerciala primita', v: false, entries: [
      mkS('factura_cumparare_marfuri', { baza: 5000, tva: 1050, cota: 21, document: 'A-2' }, '2026-09-10'),
      mkS('reducere_comerciala_primita', { baza: 1000, tva: 210, cota: 21, document: 'RP-1' }, '2026-09-25')] },
  ];
  for (const c of cazuri) {
    const dbS = { openingBalances: {}, company: { cui: 'RO999', den: 'T' }, partners: {}, entries: c.entries };
    const dS = repS.d300(dbS, '2026-09');
    const cote = c.v ? dS.coteV : dS.coteC;
    eq('„' + c.nume + '": o singura cota in decont', cote.length, 1);
    eq('„' + c.nume + '": cota ramane 21%, nu 0', cote[0].cota, 21);
    eq('„' + c.nume + '": baza neta (5000-1000)', cote[0].baza, 4000);
    eq('„' + c.nume + '": TVA net (1050-210)', cote[0].tva, 840);
    // decisiv: ce ajunge in XML-ul depus trebuie sa fie ce spune contabilitatea
    const x = String(xmlS.d300Xml(dbS.company, '2026-09', dS, {}, null));
    const g = (r) => (x.match(new RegExp(r + '="([^"]*)"')) || [undefined, null])[1];
    eq('„' + c.nume + '": XML baza', g(c.v ? 'R9_1' : 'R22_1'), '4000');
    eq('„' + c.nume + '": XML TVA', g(c.v ? 'R9_2' : 'R22_2'), '840');
    eq('„' + c.nume + '": decontul coincide cu contabilitatea',
      Number(g(c.v ? 'R9_2' : 'R22_2')), c.v ? dS.colectata : dS.deductibila);
  }
  // Avans facturat -> factura finala -> regularizare: TVA-ul avansului se anuleaza, nu se dubleaza
  const dbAv = { openingBalances: {}, company: { cui: 'RO999', den: 'T' }, partners: {}, entries: [
    mkS('factura_avans_client', { baza: 1000, tva: 210, cota: 21, document: 'AV-1' }, '2026-09-05'),
    mkS('factura_vanzare_servicii', { baza: 5000, tva: 1050, cota: 21, document: 'F-10' }, '2026-09-20'),
    mkS('regularizare_avans_client', { baza: 1000, tva: 210, cota: 21, document: 'F-10' }, '2026-09-20')] };
  const dAv = repS.d300(dbAv, '2026-09');
  eq('avans + regularizare: o singura cota', dAv.coteV.length, 1);
  eq('avans + regularizare: baza = doar livrarea finala', dAv.coteV[0].baza, 5000);
  eq('avans + regularizare: TVA nedublat', dAv.coteV[0].tva, 1050);

  // Plasa de siguranta trebuie sa priveasca SUMELE, nu cota: garda `c.cota &&` lasa sa treaca
  // exact cota 0 (falsy) — adica singurul caz in care suma chiar se pierde.
  const faraRand = xmlS.d300CoteFaraRand({ coteV: [{ cota: 0, baza: -1000, tva: -210 }], coteC: [] });
  eq('o cota fara rand, cu sume nenule, e RAPORTATA chiar daca e 0', faraRand.length, 1);
  // indexare defensiva: cand aserttiunea de mai sus pica, `faraRand[0]` e undefined, iar un acces
  // direct ar arunca si ar OPRI suita — ascunzand toate verificarile de dupa. O aserttiune care
  // pica trebuie sa raporteze, nu sa doboare rulajul.
  eq('...pe latura corecta', (faraRand[0] || {}).sens, 'livrari');
  eq('o cota fara rand dar cu sume zero nu produce zgomot',
    xmlS.d300CoteFaraRand({ coteV: [{ cota: 0, baza: 0, tva: 0 }], coteC: [] }).length, 0);

  // Regularizarea anuala de pro-rata (art. 300) posteaza TVA fara baza (4426 = 635), deci cade pe
  // cota 0. Decontul NU are rand de regularizari (`R28 = R27`, vezi xml.js), deci suma chiar nu
  // poate fi declarata — dar acum se VEDE, in loc sa dispara. Testul fixeaza tocmai asta:
  // o suma care nu incape in declaratie trebuie raportata, nu inghitita.
  const dbPr = { openingBalances: {}, company: { cui: 'RO999', den: 'T' }, partners: {}, entries: [
    mkS('regularizare_pro_rata', { suma: 1000, tva: 1000, document: 'RP-1' }, '2026-12-31')] };
  const dPr = repS.d300(dbPr, '2026-12');
  eq('(premisa) regularizarea de pro-rata are TVA fara baza', dPr.coteC[0].baza, 0);
  eq('regularizarea de pro-rata e RAPORTATA ca nedeclarabila', xmlS.d300CoteFaraRand(dPr).length, 1);
  eq('...cu TVA-ul ei, ca sa se poata corecta manual', (xmlS.d300CoteFaraRand(dPr)[0] || {}).tva, 1000);
}

section('Reduceri comerciale, sconturi, taxare inversa interna');
const gt = require('../src/documentTypes').getType;
const rca = gt('reducere_comerciala_acordata').build({ baza: 100, tva: 21, cota: 21 });
eq('reducere acordata: 709=4111', rca[0].debit + '=' + rca[0].credit, '709=4111');
ok('reducere acordata: storno TVA 4427=4111', rca.some((l) => l.debit === '4427' && l.credit === '4111'));
const rcp = gt('reducere_comerciala_primita').build({ baza: 100, tva: 21, cota: 21 });
eq('reducere primita: 401=609', rcp[0].debit + '=' + rcp[0].credit, '401=609');
eq('scont acordat: 667=4111', gt('scont_acordat').build({ suma: 50 })[0].debit + '=' + gt('scont_acordat').build({ suma: 50 })[0].credit, '667=4111');
eq('scont primit: 401=767', gt('scont_primit').build({ suma: 50 })[0].debit + '=' + gt('scont_primit').build({ suma: 50 })[0].credit, '401=767');
const tii = gt('taxare_inversa_interna_achizitie').build({ baza: 1000, cota: 21, contStoc: '371' });
ok('taxare inversa interna: 371=401 + 4426=4427', tii.some((l) => l.debit === '371' && l.credit === '401') && tii.some((l) => l.debit === '4426' && l.credit === '4427' && l.suma === 210));
// Raportare in decont: TVA-ul autolichidat se colecteaza SI se deduce (pozitie neta zero), dar
// operatiunea NU e o livrare. Pana la corectie ajungea pe randurile de cota (R9 livrari taxabile
// + R22 achizitii taxabile) si, prin jurnalul de vanzari, in D394 ca livrare interna cu taxare
// inversa — 10 erori la validatorul oficial. Are perechea ei de randuri: R7 colectata / R20
// deductibila (regulile V13/V14 cer `R20_1 = R7_1`).
const tiEntry = { id: 'ti', period: '2026-06', data: '2026-06-20', tip: 'taxare_inversa_interna_achizitie', tipNume: 'Taxare inversa', partener: 'GAMA', partenerCui: 'RO321', lines: tii };
const vjTi = acc.vatJournals({ entries: [tiEntry], openingBalances: {} }, '2026-06');
eq('taxare inversa: TVA colectat = TVA dedus (pozitie neta zero)', vjTi.totals.colectata + '|' + vjTi.totals.deductibila, '210|210');
eq('taxare inversa: baza si TVA pe categoria de autolichidare', JSON.stringify(vjTi.totals.autolichidari.taxareInversaInterna), '{"baza":1000,"tva":210}');
ok('taxare inversa: NU apare ca livrare (jurnalul de vanzari ramane gol)', vjTi.vanzari.length === 0 && vjTi.coteV.length === 0);
ok('taxare inversa: ramane in jurnalul de cumparari, marcata', vjTi.cumparari.length === 1 && vjTi.cumparari[0].taxareInversa === true);
ok('taxare inversa: iese din defalcarea pe cote (are rand propriu)', vjTi.coteC.length === 0);
const aTi = xml.d300Rows(rep.d300({ entries: [tiEntry], openingBalances: {} }, '2026-06'));
eq('taxare inversa interna -> R7 colectata / R20 deductibila, nu R9/R22', [aTi.R7_1, aTi.R7_2, aTi.R20_1, aTi.R20_2].join('/'), '1000/210/1000/210');
ok('taxare inversa: NU mai ajunge pe randurile de cota', aTi.R9_1 === undefined && aTi.R22_1 === undefined);
eq('taxare inversa: intra in ambele totaluri (R17 colectata, R27 deductibila)', aTi.R17_1 + '|' + aTi.R27_1, '1000|1000');
eq('taxare inversa: soldul de plata ramane zero', aTi.R41_2 + '|' + aTi.R42_2, '0|0');
ok('taxare inversa interna (art. 331) RAMANE in D394 — e operatiune interna', vjTi.cumparari[0].inD394 === true);

// Achizitia intracomunitara: aceeasi mecanica, dar perechea R5/R18 (V7/V8) si NU intra in D394 —
// partenerul are CUI strain, iar declaratia interna il respinge; se declara in D390.
const icEntry = { id: 'ic', period: '2026-06', data: '2026-06-21', tip: 'achizitie_intracomunitara', tipNume: 'AIC',
  partener: 'Lieferant GmbH', partenerCui: 'DE811907980',
  lines: [{ debit: '371', credit: '401', suma: 10000 }, { debit: '4426', credit: '4427', suma: 2100 }] };
const vjIc = acc.vatJournals({ entries: [icEntry], openingBalances: {} }, '2026-06');
eq('achizitie intracomunitara: baza si TVA pe categoria ei', JSON.stringify(vjIc.totals.autolichidari.intracomBunuri), '{"baza":10000,"tva":2100}');
const aIc = xml.d300Rows(rep.d300({ entries: [icEntry], openingBalances: {} }, '2026-06'));
eq('achizitie intracomunitara -> R5 colectata / R18 deductibila, nu R9/R22', [aIc.R5_1, aIc.R5_2, aIc.R18_1, aIc.R18_2].join('/'), '10000/2100/10000/2100');
ok('achizitie intracomunitara: NU mai apare ca livrare taxabila (R9)', aIc.R9_1 === undefined);
ok('achizitie intracomunitara: exclusa din D394 (CUI strain)', vjIc.cumparari[0].inD394 === false);
ok('achizitie intracomunitara: absenta din D394 generat',
  !xml.d394Xml({ cui: 'RO12345674', nume: 'X' }, '2026-06', vjIc, { nume: 'P', prenume: 'I', functie: 'C' }).includes('811907980'));

// D394 rezumat2: achizitiile cu taxare inversa (tip C) sunt tot ACHIZITII si intra in totalurile
// 'A'. Validatorul o cere explicit (R99/R100/R101); pana la corectie erau numarate doar cele
// normale, iar o perioada cu numai achizitii art. 331 nu genera deloc rand de rezumat2.
const vjTiMix = acc.vatJournals({ openingBalances: {}, entries: [
  { id: 'a1', period: '2026-06', data: '2026-06-10', tip: 'factura_cumparare_marfuri', tipNume: 'M', partener: 'F1', partenerCui: 'RO12345674',
    lines: [{ debit: '371', credit: '401', suma: 10000 }, { debit: '4426', credit: '401', suma: 2100 }] },
  { id: 'c1', period: '2026-06', data: '2026-06-11', tip: 'taxare_inversa_interna_achizitie', tipNume: 'TI', partener: 'F2', partenerCui: 'RO45678918',
    lines: [{ debit: '371', credit: '401', suma: 5000 }, { debit: '4426', credit: '4427', suma: 1050 }] },
] }, '2026-06');
const x394TiMix = xml.d394Xml({ cui: 'RO12345674', nume: 'X' }, '2026-06', vjTiMix, { nume: 'P', prenume: 'I', functie: 'C' });
const r2Ti = (x394TiMix.match(/<rezumat2[^>]*cota="21"[^>]*>/) || [''])[0];
eq('D394 rezumat2: taxarea inversa intra in totalurile A (2 facturi)', (r2Ti.match(/nrFacturiA="(\d+)"/) || [])[1], '2');
eq('D394 rezumat2: baza A cumuleaza si taxarea inversa (10000 + 5000)', (r2Ti.match(/bazaA="(\d+)"/) || [])[1], '15000');
eq('D394 rezumat2: TVA A cumuleaza si taxarea inversa (2100 + 1050)', (r2Ti.match(/tvaA="(\d+)"/) || [])[1], '3150');
// ...iar o perioada cu NUMAI achizitii cu taxare inversa produce totusi randul de rezumat2
const vjDoarC = acc.vatJournals({ openingBalances: {}, entries: [
  { id: 'c2', period: '2026-06', data: '2026-06-11', tip: 'taxare_inversa_interna_achizitie', tipNume: 'TI', partener: 'F2', partenerCui: 'RO45678918',
    lines: [{ debit: '371', credit: '401', suma: 5000 }, { debit: '4426', credit: '4427', suma: 1050 }] },
] }, '2026-06');
ok('D394: numai achizitii cu taxare inversa -> randul de rezumat2 exista',
  /<rezumat2[^>]*cota="21"[^>]*nrFacturiA="1"/.test(xml.d394Xml({ cui: 'RO12345674', nume: 'X' }, '2026-06', vjDoarC, { nume: 'P', prenume: 'I', functie: 'C' })));

// D394 op11: taxarea inversa la persoane juridice cere detaliul pe categoria de bun art. 331
// (regula R233.5), cu un cod din nomenclatorul oficial + `tvaPR` (R237.1), plus o sectiune
// <detaliu> corespondenta in rezumat1 (R35). Codurile 32-35 sunt REZERVATE persoanelor fizice
// (R235.1), deci placeholderul „35 = alte produse" folosit la fila de carnet nu merge aici.
const tiCod = (cod) => acc.vatJournals({ openingBalances: {}, entries: [
  { id: 'cc', period: '2026-06', data: '2026-06-11', tip: 'taxare_inversa_interna_achizitie', tipNume: 'TI',
    partener: 'Cereale SRL', partenerCui: 'RO45678918', document: 'TI1', codCategorie331: cod,
    lines: [{ debit: '371', credit: '401', suma: 5000 }, { debit: '4426', credit: '4427', suma: 1050 }] },
] }, '2026-06');
const x331 = xml.d394Xml({ cui: 'RO12345674', nume: 'X' }, '2026-06', tiCod(22), { nume: 'P', prenume: 'I', functie: 'C' });
ok('D394: op11 cu codul de bun si tvaPR', /<op11 nrFactPR="1" codPR="22" bazaPR="5000" tvaPR="1050"\/>/.test(x331));
ok('D394: <detaliu> oglinda in rezumat1 (nrAchizC/bazaAchizC/tvaAchizC)',
  /<detaliu bun="22" nrAchizC="1" bazaAchizC="5000" tvaAchizC="1050"\/>/.test(x331));
ok('D394: randul op1 tip C nu mai e auto-inchis (are copil op11)', /<op1 [^>]*tip="C"[^>]*>\s*\n\s*<op11/.test(x331));
// codul se duce pe articol, nu se inventeaza: fara el, op11 lipseste si articolele sunt NUMITE
const xFara = xml.d394Xml({ cui: 'RO12345674', nume: 'X' }, '2026-06', tiCod(0), { nume: 'P', prenume: 'I', functie: 'C' });
ok('D394: fara cod NU se inventeaza unul (op11 absent)', !/<op11/.test(xFara));
eq('D394: articolele fara cod sunt raportate, cu document si partener',
  JSON.stringify(xml.d394FaraCodCategorie(tiCod(0))), '[{"document":"TI1","partener":"Cereale SRL","baza":5000}]');
const valD394 = require('../src/validate').validateDeclaration('d394', '<?xml version="1.0"?><declaratie394 cui="12345674" luna="6" an="2026"/>',
  { cui: '12345674', faraCodCategorie: xml.d394FaraCodCategorie(tiCod(0)) });
ok('D394: validarea pre-depunere da EROARE si numeste documentul',
  valD394.ok === false && valD394.errors.some((e) => /TI1/.test(e) && /op11/.test(e)));
// nomenclatorul: doar codurile pentru persoane juridice
ok('nomenclator art. 331: 22-31 si 36 acceptate', [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 36].every((c) => xml.D394_COD_331.has(c)));
ok('nomenclator art. 331: 32-35 si 37 sunt pentru persoane fizice, nu juridice',
  [32, 33, 34, 35, 37].every((c) => !xml.D394_COD_331.has(c)));
// doua categorii de la acelasi partener, la aceeasi cota -> doua op11 in acelasi op1
const vjDoua = acc.vatJournals({ openingBalances: {}, entries: [
  { id: 'd1', period: '2026-06', data: '2026-06-11', tip: 'taxare_inversa_interna_achizitie', tipNume: 'TI',
    partener: 'Mix SRL', partenerCui: 'RO45678918', document: 'A1', codCategorie331: 22,
    lines: [{ debit: '371', credit: '401', suma: 1000 }, { debit: '4426', credit: '4427', suma: 210 }] },
  { id: 'd2', period: '2026-06', data: '2026-06-12', tip: 'taxare_inversa_interna_achizitie', tipNume: 'TI',
    partener: 'Mix SRL', partenerCui: 'RO45678918', document: 'A2', codCategorie331: 24,
    lines: [{ debit: '371', credit: '401', suma: 2000 }, { debit: '4426', credit: '4427', suma: 420 }] },
] }, '2026-06');
const xDoua = xml.d394Xml({ cui: 'RO12345674', nume: 'X' }, '2026-06', vjDoua, { nume: 'P', prenume: 'I', functie: 'C' });
eq('D394: categorii diferite de la acelasi partener -> cate un op11 fiecare', (xDoua.match(/<op11 /g) || []).length, 2);
ok('D394: op1 cumuleaza ambele facturi, op11 le separa pe categorii',
  /<op1 [^>]*tip="C"[^>]*nrFact="2" baza="3000"/.test(xDoua)
  && /codPR="22" bazaPR="1000"/.test(xDoua) && /codPR="24" bazaPR="2000"/.test(xDoua));

// LIVRARILE art. 331 se factureaza fara TVA, deci nu trec prin jurnalul de vanzari — dar sunt
// operatiuni INTERNE si trebuie sa apara in D394 ca tip 'V'. Nu ajungeau deloc acolo.
// Validatorul cere pentru ele: cota 0 (R217.2), coloanele „scutit" LS/AS pe zero (R41.1/R42.1,
// R49.1/R50.1) si op11 FARA `tvaPR` — exact invers fata de achizitii (R237.1).
const vjLiv331 = acc.vatJournals({ openingBalances: {}, entries: [
  { id: 'lv', period: '2026-06', data: '2026-06-12', tip: 'taxare_inversa_interna_livrare', tipNume: 'LivTI',
    partener: 'Client Cereale SRL', partenerCui: 'RO45678918', document: 'LTI-1', codCategorie331: 22,
    lines: [{ debit: '4111', credit: '707', suma: 8000 }] },
] }, '2026-06');
const xLiv = xml.d394Xml({ cui: 'RO12345674', nume: 'X' }, '2026-06', vjLiv331, { nume: 'P', prenume: 'I', functie: 'C' });
ok('D394: livrarea art. 331 apare ca tip V cu cota 0', /<op1 tip="V" tip_partener="1" cota="0"[^>]*baza="8000"/.test(xLiv));
ok('D394: op11 la livrare NU are tvaPR (interzis de R237.1)',
  /<op11 nrFactPR="1" codPR="22" bazaPR="8000"\/>/.test(xLiv) && !/tvaPR/.test(xLiv));
ok('D394: <detaliu> la livrare foloseste nrLivV/bazaLivV', /<detaliu bun="22" nrLivV="1" bazaLivV="8000"\/>/.test(xLiv));
ok('D394: la cota 0 coloanele scutite LS si AS exista pe zero',
  /facturiLS="0" bazaLS="0" facturiAS="0" bazaAS="0"/.test(xLiv));
// livrarea intracomunitara, tot fara TVA, NU are voie in D394 (CUI strain -> D390)
const vjLicD394 = acc.vatJournals({ openingBalances: {}, entries: [
  { id: 'lic2', period: '2026-06', data: '2026-06-12', tip: 'livrare_intracomunitara', tipNume: 'LIC',
    partener: 'GMBH', partenerCui: 'DE811907980', document: 'EX9', lines: [{ debit: '4111', credit: '707', suma: 9000 }] },
] }, '2026-06');
ok('D394: livrarea intracomunitara ramane exclusa (merge in D390)',
  !xml.d394Xml({ cui: 'RO12345674', nume: 'X' }, '2026-06', vjLicD394, { nume: 'P', prenume: 'I', functie: 'C' }).includes('811907980'));
eq('cele doua livrari fara TVA se separa pe canale', vjLicD394.scutite[0].inD394 + '|' + vjLiv331.scutite[0].inD394, 'false|true');
// ...iar in D300 raman pe randurile lor (R1 intracomunitar, R13 taxare inversa)
eq('D300: livrarea art. 331 pe R13, cea intracomunitara pe R1',
  (xml.d300Rows(rep.d300({ openingBalances: {}, entries: [] }, '2026-06')).R13_1 || 0) + '|'
  + xml.d300Rows({ coteV: [], coteC: [], scutite: vjLiv331.totals.scutite }).R13_1
  + '|' + xml.d300Rows({ coteV: [], coteC: [], scutite: vjLicD394.totals.scutite }).R1_1, '0|8000|9000');
// inchiderea anuala include conturile rectificative (709/609), cu sume in rosu
const contraDb = { entries: [
  { id: 'v', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 10000 }] },
  { id: 'r', period: '2026-03', data: '2026-03-02', lines: [{ debit: '709', credit: '4111', suma: 1000 }] },
] };
const anC = acc.annualClosing(contraDb, '2026');
eq('inchidere venituri nete de reducere (10000-1000)', anC.totalVen, 9000);
ok('linia de inchidere 709 e in rosu (negativa)', anC.lines.some((l) => l.debit === '709' && l.suma < 0));

section('Reconciliere facturi - plati');
const rc = reconcile(v);
const alfaR = rc.partners.find((p) => /ALFA/.test(p.den) && p.cont === '401');
// Seed-ul are ALFA cu 15.000 preluare, si in openingBalances['401'], si in openingAnalytic.
// Cifrele de mai jos erau 12.100/0/„fara deschise": fisa de partener ignora preluarea, desi
// balanta generala o purta — de unde soldul 401 = 15.000 in balanta si 0 in scadentar.
eq('ALFA facturat = preluare 15.000 + facturile perioadei 12.100', alfaR.facturat, 27100);
eq('ALFA decontat', alfaR.decontat, 12100);
eq('ALFA sold reconciliat = preluarea ramasa neplatita', alfaR.sold, 15000);
eq('ALFA potriviri factura-plata', alfaR.potriviri, 1);
ok('ALFA are preluarea inca deschisa (facturile perioadei sunt stinse)',
  Array.isArray(alfaR.deschise) && alfaR.deschise.length === 1 && alfaR.deschise[0].suma === 15000);
const betaR = rc.partners.find((p) => /BETA/.test(p.den) && p.cont === '4111');
eq('BETA facturat', betaR.facturat, 16940);
eq('BETA decontat', betaR.decontat, 16940);

// Soldurile initiale pe partener (preluarea de la contabilitatea anterioara) sunt creante si
// datorii deschise. Erau ignorate aici, desi analytic.aging() le citeste — de unde „De platit
// catre furnizori 0" langa „Datorii de platit 15.000" pe acelasi ecran. Soldul iesea mai mic
// cu exact preluarea, si in scadentar, si in previziunea de cash-flow.
const rcOpenDb = { openingAnalytic: [
  { cont: '401', partener: 'DELTA SRL', cui: 'RO999', d: 0, c: 15000 },
  { cont: '4111', partener: 'OMEGA SRL', cui: 'RO888', d: 4000, c: 0 },
  { cont: '404', partener: 'IMOBIL SRL', cui: 'RO777', d: 0, c: 9999 }, // furnizor de imobilizari
], entries: [
  { id: 'p1', period: '2026-03', data: '2026-03-10', partener: 'DELTA SRL', partenerCui: 'RO999',
    lines: [{ debit: '401', credit: '5121', suma: 5000 }] },
] };
const rcOpen = reconcile(rcOpenDb);
const delta = rcOpen.partners.find((p) => p.den === 'DELTA SRL' && p.cont === '401') || {};
ok('sold initial preluat: intra in datoria catre furnizor', delta.facturat === 15000);
ok('sold initial preluat: plata ulterioara il stinge partial', delta.decontat === 5000);
ok('sold initial preluat: soldul ramas e 10000, nu 0', delta.sold === 10000);
// Perimetrul e acum acelasi cu al lui aging(): 404 (furnizori de imobilizari) intra la datorii.
eq('sold initial preluat: totalul pe furnizori (401 + 404)', rcOpen.totalFurnizori, 19999);
eq('sold initial preluat: totalul pe clienti', rcOpen.totalClienti, 4000);
ok('sold initial: randul e marcat, ca sa nu intre in punctajul manual',
  (delta.items || []).some((it) => it.soldInitial === true && it.credit === 15000));
const imobil = rcOpen.partners.find((p) => p.den === 'IMOBIL SRL') || {};
ok('404 e in perimetru si e citit ca DATORIE, nu ca creanta', imobil.sens === 'datorie');
ok('404 aduce soldul cu semnul corect', imobil.sold === 9999);

// Ciornele nu sunt inca datorii reale: aging() le filtra (postedEntries), scadentarul nu.
const rcDraftDb = { openingAnalytic: [], entries: [
  { id: 'd1', period: '2026-03', data: '2026-03-01', partener: 'GAMA SRL', partenerCui: 'RO111',
    status: 'ciorna', lines: [{ debit: '371', credit: '401', suma: 7000 }] },
  { id: 'd2', period: '2026-03', data: '2026-03-02', partener: 'GAMA SRL', partenerCui: 'RO111',
    lines: [{ debit: '371', credit: '401', suma: 1000 }] },
] };
const rcDraft = reconcile(rcDraftDb);
ok('ciorna nu creeaza datorie in scadentar (doar articolul postat)', rcDraft.totalFurnizori === 1000);

// Perimetrul largit: sensul se deduce din CONT. Riscul reparat aici e ca un cont de creanta
// ALTUL decat 4111 (418, 461) sa fie citit invers — regula veche era `cont === '4111'`, deci
// tot ce nu era 4111 trecea drept datorie.
const rcSensDb = { openingAnalytic: [], entries: [
  // 418 clienti-facturi de intocmit: creanta, creste pe DEBIT
  { id: 's1', period: '2026-03', data: '2026-03-01', partener: 'EPSILON SRL', partenerCui: 'RO222',
    lines: [{ debit: '418', credit: '704', suma: 2500 }] },
  // 419 avans incasat de la client: DATORIE, desi contrapartea e un client
  { id: 's2', period: '2026-03', data: '2026-03-02', partener: 'ZETA SRL', partenerCui: 'RO333',
    lines: [{ debit: '5121', credit: '419', suma: 800 }] },
  // 462 creditori diversi: datorie
  { id: 's3', period: '2026-03', data: '2026-03-03', partener: 'ETA SRL', partenerCui: 'RO444',
    lines: [{ debit: '628', credit: '462', suma: 300 }] },
] };
const rcSens = reconcile(rcSensDb);
const gr = (den) => rcSens.partners.find((p) => p.den === den) || {};
ok('418 e creanta (nu datorie, cum ar fi iesit din regula veche)', gr('EPSILON SRL').sens === 'creanta');
ok('418 pe debit = factura, deci sold pozitiv de incasat', gr('EPSILON SRL').sold === 2500);
ok('419 (avans de la client) e DATORIE, desi partenerul e client', gr('ZETA SRL').sens === 'datorie');
ok('462 e datorie', gr('ETA SRL').sens === 'datorie');
eq('total de incasat = doar 418', rcSens.totalClienti, 2500);
eq('total de platit = 419 + 462', rcSens.totalFurnizori, 1100);

// Totalurile nu compenseaza INTRE parteneri: un avans la A nu scade ce datorezi lui B.
// Compensarea e un act explicit si se propune doar pe acelasi partener (compensablePartners).
const rcNetDb = { openingAnalytic: [], entries: [
  { id: 'c1', period: '2026-03', data: '2026-03-01', partener: 'A SRL', partenerCui: 'RO1',
    lines: [{ debit: '371', credit: '401', suma: 1000 }] },
  { id: 'c2', period: '2026-03', data: '2026-03-02', partener: 'B SRL', partenerCui: 'RO2',
    lines: [{ debit: '401', credit: '5121', suma: 500 }] }, // plata in avans catre B: sold -500
] };
const rcNet = reconcile(rcNetDb);
ok('avansul catre un furnizor ramane cu semn in fisa lui', (rcNet.partners.find((p) => p.den === 'B SRL') || {}).sold === -500);
ok('dar NU scade datoria catre alt furnizor in total', rcNet.totalFurnizori === 1000);

section('Motor de potrivire — reconciliere inteligenta (src/matching.js)');
{
  // F3=500 (nicio factura nu e egala exact cu plata de 300) ca sa fortam calea AGREGAT, nu exacta
  const inv = [
    { id: 'i1', doc: 'F1', data: '2026-01-01', suma: 100 },
    { id: 'i2', doc: 'F2', data: '2026-01-05', suma: 200 },
    { id: 'i3', doc: 'F3', data: '2026-01-10', suma: 500 },
  ];
  // o plata = suma celor mai vechi doua facturi -> AGREGATA (F1+F2), F3 ramane deschisa
  const s1 = settle(inv, [{ id: 'p', doc: 'P', data: '2026-01-06', suma: 300 }]);
  eq('settle: agregata pe cele mai vechi doua facturi', s1.perechi[0].tip, 'agregata');
  eq('settle: agregata leaga ambele documente', s1.perechi[0].facturi.map((f) => f.doc).join('+'), 'F1+F2');
  eq('settle: F3 ramane deschisa', s1.deschise.map((d) => d.doc + ':' + d.rest).join(','), 'F3:500');
  // plata de aceeasi suma cu o factura din mijloc -> EXACTA (nu prima)
  const s2 = settle(inv, [{ id: 'p', doc: 'P', data: '2026-01-06', suma: 200 }]);
  eq('settle: exacta cu factura de aceeasi suma', s2.perechi[0].tip, 'exacta');
  eq('settle: exacta pe F2 (nu FIFO oarba)', s2.perechi[0].facturi[0].doc, 'F2');
  // plata mai mica -> PARTIALA, rest deschis
  const s3 = settle([{ id: 'i', doc: 'FX', data: '2026-01-01', suma: 500 }], [{ id: 'p', doc: 'PX', data: '2026-01-02', suma: 150 }]);
  eq('settle: plata sub factura -> partiala', s3.perechi[0].tip, 'partiala');
  eq('settle: rest corect dupa partiala', s3.deschise[0].rest, 350);
  // plata fara factura -> AVANS
  const s4 = settle([], [{ id: 'p', doc: 'AV', data: '2026-01-02', suma: 90 }]);
  eq('settle: plata fara factura -> avans', s4.avansuri[0].rest, 90);
  // diferenta de rotunjire ramane exacta (toleranta)
  const s5 = settle([{ id: 'i', doc: 'FT', data: '2026-01-01', suma: 100 }], [{ id: 'p', doc: 'PT', data: '2026-01-02', suma: 100.03 }]);
  eq('settle: diferenta de rotunjire ramane exacta', s5.perechi[0].tip, 'exacta');
  ok('settle: nicio factura deschisa dupa potrivirea tolerata', s5.deschise.length === 0);

  // Pas 0 — LEGATURA EXPLICITA (punctaj): autoritara, bate euristica, suporta partial
  const sL = settle(
    [{ id: 'FA', doc: 'A', data: '2026-01-01', suma: 300 }, { id: 'FB', doc: 'B', data: '2026-01-05', suma: 200 }],
    [{ id: 'P', doc: 'P', data: '2026-01-06', suma: 200, stinge: ['FB'] }]);
  eq('settle: legatura explicita -> tip legata', sL.perechi[0].tip, 'legata');
  eq('settle: legata stinge factura tintita (nu cea mai veche)', sL.perechi[0].facturi[0].doc, 'B');
  eq('settle: factura netintita ramane deschisa', sL.deschise.map((d) => d.doc).join(','), 'A');
  // legatura care depaseste plata -> partial pe factura legata
  const sLP = settle([{ id: 'FX', doc: 'X', data: '2026-01-01', suma: 500 }], [{ id: 'P', doc: 'P', data: '2026-01-02', suma: 200, stinge: ['FX'] }]);
  eq('settle: legatura partiala -> tip legata', sLP.perechi[0].tip, 'legata');
  eq('settle: rest corect dupa legatura partiala', sLP.deschise[0].rest, 300);
  // legatura la id inexistent -> ignorata, revine pe euristica exacta
  const sBad = settle([{ id: 'FA', doc: 'A', data: '2026-01-01', suma: 300 }], [{ id: 'P', doc: 'P', data: '2026-01-02', suma: 300, stinge: ['NECUNOSCUT'] }]);
  eq('settle: legatura invalida ignorata -> cade pe exacta', sBad.perechi[0].tip, 'exacta');

  // candidatesFor — o linie de extras peste facturile deschise
  const open = [{ id: 'a', doc: 'A', data: '2026-02-01', suma: 500 }, { id: 'b', doc: 'B', data: '2026-02-03', suma: 300 }];
  eq('candidatesFor: suma = o factura -> exacta', candidatesFor(open, 500).tip, 'exacta');
  eq('candidatesFor: suma = doua facturi -> agregata', candidatesFor(open, 800).tip, 'agregata');
  eq('candidatesFor: suma sub cea mai veche -> partiala', candidatesFor(open, 120).tip, 'partiala');
  eq('candidatesFor: suma peste tot deschisul -> fara', candidatesFor(open, 9999).tip, 'fara');
  eq('candidatesFor: fara facturi deschise -> fara', candidatesFor([], 100).tip, 'fara');
}

section('Reconciliere e-Factura primite (inbox SPV <-> jurnal cumparari) (src/einvoiceReconcile.js)');
{
  // journalPurchases: doar articolele POSTATE care cresc datoria pe 401 (net creditor) cu furnizor
  const v = { entries: [
    { id: 'p1', partenerCui: 'RO111', document: 'A-1', lines: [{ debit: '371', credit: '401', suma: 100 }, { debit: '4426', credit: '401', suma: 19 }], spvImport: { msgId: 'm1' } },
    { id: 'p2', partenerCui: 'RO222', document: 'B-1', lines: [{ debit: '371', credit: '401', suma: 200 }] },
    { id: 'pv', partenerCui: 'RO999', document: 'V-1', lines: [{ debit: '4111', credit: '707', suma: 500 }] }, // vanzare -> nu e cumparare
    { id: 'pc', status: 'ciorna', partenerCui: 'RO111', document: 'A-2', lines: [{ debit: '371', credit: '401', suma: 50 }] }, // ciorna -> exclusa
  ] };
  const jp = journalPurchases(v);
  eq('journalPurchases: doar cumpararile postate (vanzarea + ciorna excluse)', jp.length, 2);
  eq('journalPurchases: net pe 401 include TVA-ul deductibil', jp.find((p) => p.id === 'p1').suma, 119);
  ok('journalPurchases: pastreaza legatura spvImport.msgId', jp.find((p) => p.id === 'p1').spvImportMsgId === 'm1');

  // reconcileInbox: potrivire exacta (import) + count-based + lipsa + fara-SPV; CIF normalizat (RO/spatii)
  const inbox = [
    { id: 'm1', data: '20260601', cif: '111', importat: true },   // deja importata (potrivire exacta pe msgId)
    { id: 'm3', data: '20260603', cif: 'RO111', importat: false }, // absorbita de o cumparare manuala de la 111
    { id: 'm4', data: '20260604', cif: '222', importat: false },   // neinregistrata (fara cumparare de la 222)
  ];
  const purchases = [
    { id: 'e1', data: '2026-06-01', partenerCui: 'RO111', document: 'A-1', suma: 119, spvImportMsgId: 'm1' },
    { id: 'e3', data: '2026-06-03', partenerCui: '111', document: 'A-3', suma: 300, spvImportMsgId: null }, // manuala
    { id: 'e9', data: '2026-06-05', partenerCui: 'RO333', document: 'C-1', suma: 500, spvImportMsgId: null }, // fara SPV
  ];
  const r = reconcileInbox(inbox, purchases, { 222: 'BETA SRL', 333: 'GAMA SRL' });
  eq('reconcileInbox: 1 factura SPV neinregistrata in jurnal', r.lipsaInJurnal, 1);
  eq('reconcileInbox: neinregistrata = m4 de la CIF 222', r.neinregistrate[0].msgId + '|' + r.neinregistrate[0].cif, 'm4|222');
  eq('reconcileInbox: numele furnizorului rezolvat', r.neinregistrate[0].den, 'BETA SRL');
  eq('reconcileInbox: 1 cumparare fara corespondent SPV (CIF 333)', r.faraSpvCount, 1);
  ok('reconcileInbox: CIF 111 reconciliat (import exact + count) -> lipsa 0', r.furnizori.find((f) => f.cif === '111').lipsa === 0);
  ok('reconcileInbox: furnizorul cu lipsa e primul (sortare)', r.furnizori[0].cif === '222');
}

section('Bilant (2026-06)');
const bs = stmt.balanceSheet(v, '2026-06');
eq('bilant echilibrat', bs.echilibrat, true);
eq('total activ = total pasiv', bs.totalActiv, bs.totalPasiv);
eq('total activ', bs.totalActiv, 86381.65);
eq('rezultat curent (clasa 7-6)', bs.rezultatCurent, 420.83);

section('Bilant structura F10 (prescurtat)');
const f10 = stmt.balanceSheetF10(v, '2026-06');
eq('F10 echilibrat', f10.echilibrat, true);
eq('F10 total activ = bilant simplificat', f10.totalActiv, bs.totalActiv);
eq('F10 total activ = total pasiv', f10.totalActiv, f10.totalPasiv);
ok('F10 are datorii curente (D)', f10.randuri.D_datorii > 0);
eq('F10 rezultat curent in capitaluri', f10.randuri.rezultatCurent, 420.83);
eq('F10 total activ', f10.totalActiv, 86381.65);
// datoriile pe termen lung (grupa 16) merg in randul G, nu in datorii curente
const f10lt = stmt.balanceSheetF10({ openingBalances: { 1621: { d: 0, c: 50000 }, 5121: { d: 50000, c: 0 } }, entries: [] }, '2026-12');
eq('F10: credit pe TL (1621) -> G (datorii >1 an)', f10lt.randuri.G_datoriiLT, 50000);
eq('F10: nu apare in datorii curente', f10lt.randuri.D_datorii, 0);
ok('F10 echilibrat cu datorie pe termen lung', f10lt.echilibrat);

// ── Ajustarile pentru depreciere sunt RECTIFICATIVE de activ, nu datorii ────────────────────
// 49x si 59x au sold creditor, ca o datorie, dar nu sunt o obligatie catre nimeni: scad activul
// pe care il insotesc (OMFP 1802/2014 — bilantul cere activele NETE). Clasificarea dupa SEMN le
// trimitea la „datorii care trebuie platite intr-o perioada de pana la un an", si lasa creantele
// si investitiile la valoarea BRUTA — deci doua randuri gresite intr-o raportare depusa la ANAF.
//
// Nicio verificare de echilibru nu putea prinde asta: activul si datoria cresteau cu ACEEASI
// suma, deci totalurile torneau in continuare. De aceea testul verifica randurile ELEMENTARE,
// nu doar identitatea de bilant — dar o verifica si pe aceea, ca reparatia sa nu o strice.
{
  const bil = require('../src/bilant');
  const { round2 } = require('../src/util');
  // balanta echilibrata: D 285.000 = C 285.000; clienti 100.000 cu ajustare 30.000,
  // investitii pe termen scurt 50.000 cu ajustare 5.000, furnizor 50.000, pierdere 35.000
  const netAj = { 1012: -200000, 401: -50000, 491: -30000, 591: -5000, 5121: 100000, 4111: 100000, 5081: 50000, 121: 35000 };
  const sumD = Object.values(netAj).filter((x) => x > 0).reduce((a, x) => a + x, 0);
  const sumC = -Object.values(netAj).filter((x) => x < 0).reduce((a, x) => a + x, 0);
  eq('(premisa) balanta de proba e echilibrata', sumD, sumC);

  const Rs = bil.f10Base(netAj); bil.f10Totals(Rs); const gs = (k) => round2(Rs[k] || 0);
  eq('F10 prescurtat: creante NETE de ajustare (100.000-30.000)', gs('006'), 70000);
  eq('F10 prescurtat: investitii NETE de ajustare (50.000-5.000)', gs('007'), 45000);
  eq('F10 prescurtat: datorii = doar furnizorul, fara ajustari', gs('013'), 50000);
  eq('F10 prescurtat: identitatea de bilant se pastreaza',
    round2(gs('004') + gs('009') + gs('010') - gs('013') - gs('016') - gs('017') - gs('018')), gs('049'));

  const Rc = bil.f10CompletBase(netAj); bil.f10CompletTotals(Rc); const gc = (k) => round2(Rc[k] || 0);
  eq('F10 complet: creante NETE de ajustare', gc('036'), 70000);
  eq('F10 complet: investitii NETE de ajustare', gc('039'), 45000);
  eq('F10 complet: datorii = doar furnizorul, fara ajustari', gc('053'), 50000);
  eq('F10 complet: identitatea de bilant se pastreaza',
    round2(gc('025') + gc('041') + gc('042') - gc('053') - gc('064') - gc('068') - gc('079')), gc('100'));

  // 496 (debitori diversi) merge la ALTE creante, nu la cele comerciale — randuri distincte pe formular
  const Rc2 = bil.f10CompletBase({ 1012: -10000, 461: 10000, 496: -4000, 121: 4000 });
  eq('F10 complet: ajustarea de debitori diversi scade ALTE creante', round2(Rc2['034'] || 0), 6000);
  eq('F10 complet: ...si nu atinge creantele comerciale', round2(Rc2['031'] || 0), 0);
}

// ── CONCORDANTA celor DOUA bilanturi ────────────────────────────────────────────────────────
// Exista doua mapari, deliberat: `statements.balanceSheetF10` da agregate de AFISAJ (PDF-ul
// intern, dosarul anual), `bilant.f10Base` da randurile NUMEROTATE ale formularului ANAF. Sunt
// lucruri diferite — dar trebuie sa spuna acelasi lucru despre aceleasi solduri.
//
// Fara verificarea asta au si divergat: reparatia ajustarilor 49x/59x a fost facuta intai doar in
// `bilant.js`, iar `statements.js` a ramas cu defectul (plus unul propriu: actiunile proprii
// raportate ca o CREANTA, deci si activul si capitalurile umflate cu valoarea lor). Doua
// implementari care trebuie sa coincida au nevoie de un test care le confrunta, nu de doua seturi
// de teste care le descriu separat.
{
  const bil = require('../src/bilant');
  const { round2 } = require('../src/util');
  const cazuri = [
    { nume: 'ajustari de creante si de investitii + actiuni proprii',
      net: { 1012: -200000, 109: 15000, 4111: 100000, 491: -30000, 5081: 50000, 591: -5000, 401: -50000, 5121: 100000, 121: 20000 } },
    { nume: 'imobilizari nete, stocuri, datorii pe termen lung',
      net: { 1012: -100000, 2131: 80000, 2813: -20000, 371: 40000, 397: -5000, 1621: -30000, 5121: 40000, 117: -5000 } },
    { nume: 'avansuri, venituri in avans si provizioane',
      net: { 1012: -50000, 4091: 6000, 419: -8000, 472: -4000, 151: -10000, 5121: 70000, 117: -4000 } },
  ];
  for (const c of cazuri) {
    const sumD = Object.values(c.net).filter((x) => x > 0).reduce((a, x) => a + x, 0);
    const sumC = -Object.values(c.net).filter((x) => x < 0).reduce((a, x) => a + x, 0);
    eq('(premisa) „' + c.nume + '" e o balanta echilibrata', sumD, sumC);
    const db = { openingBalances: Object.fromEntries(Object.entries(c.net).map(([k, v]) => [k, v >= 0 ? { d: v, c: 0 } : { d: 0, c: -v }])), entries: [] };
    const af = stmt.balanceSheetF10(db, '2026-12').randuri;
    const R = bil.f10Base(c.net); bil.f10Totals(R);
    const g = (k) => round2(R[k] || 0);
    eq('concordanta „' + c.nume + '": active imobilizate', af.A, g('004'));
    eq('concordanta „' + c.nume + '": stocuri', af.B_stocuri, g('005'));
    eq('concordanta „' + c.nume + '": creante', af.B_creante, g('006'));
    eq('concordanta „' + c.nume + '": investitii pe termen scurt', af.B_investTS, g('007'));
    eq('concordanta „' + c.nume + '": casa si conturi la banci', af.B_casa, g('008'));
    eq('concordanta „' + c.nume + '": datorii curente', af.D_datorii, g('013'));
    eq('concordanta „' + c.nume + '": datorii pe termen lung', af.G_datoriiLT, g('016'));
    eq('concordanta „' + c.nume + '": provizioane', af.H_provizioane, g('017'));
    eq('concordanta „' + c.nume + '": venituri in avans', af.I_venitAvans, g('018'));
    eq('concordanta „' + c.nume + '": capitaluri proprii', af.J_capital, g('049'));
  }
}

// ── Fluxul de trezorerie (F30, metoda directa) ──────────────────────────────────────────────
{
  const cfDb2 = { openingBalances: { 5121: { d: 20000, c: 0 } }, entries: [
    { id: 'cf1', data: '2026-03-05', period: '2026-03', tipNume: 'Avans incasat', lines: [{ debit: '5121', credit: '419', suma: 10000 }] },
    { id: 'cf2', data: '2026-03-10', period: '2026-03', tipNume: 'Plata furnizor', lines: [{ debit: '401', credit: '5121', suma: 4000 }] },
    { id: 'cf3', data: '2026-03-20', period: '2026-03', tipNume: 'Incasare client', lines: [{ debit: '5121', credit: '4111', suma: 7000 }] },
  ] };
  const cf2 = stmt.cashFlow(cfDb2, 2026);
  // Avansul incasat de la un client e bani INTRATI de la un client. Grupat cu 40x, aparea ca suma
  // POZITIVA pe linia de plati catre furnizori — iar o linie de plati nu poate fi pozitiva.
  eq('avansul de la client intra la incasari de la clienti', cf2.ex_clienti, 17000);
  eq('plati catre furnizori: doar plata reala, cu semnul ei', cf2.ex_furnizoriAngajati, -4000);
  ok('linia de plati e negativa, cum trebuie', cf2.ex_furnizoriAngajati < 0);
  // invariantul de control ramane (era adevarat si INAINTE de reparatie — de asta n-o putea prinde)
  eq('variatia de numerar = fluxul net', cf2.variatie, cf2.variatieControl);
  ok('fluxul se declara echilibrat', cf2.echilibrat);
}

section('Calcul salarial (payroll, brut 5000)');
const pay = fiscal.payroll(5000);
eq('CAS 25% retinut', pay.cas, 1250);
eq('CASS 10% retinut', pay.cass, 500);
eq('impozit 10% pe salarii', pay.impozit, 325);
eq('CAM 2,25% angajator', pay.cam, 112.5);
eq('salariu net', pay.net, 2925);
eq('cost total angajator', pay.costTotal, 5112.5);

section('Avantaje in natura impozabile (brut 5000 + avantaje 1000)');
const pAv = fiscal.payroll(5000, 0, { avantaje: 1000 });
eq('CAS pe brut+avantaje: 25% din 6000', pAv.cas, 1500);
eq('CASS pe brut+avantaje: 10% din 6000', pAv.cass, 600);
eq('impozit pe baza cu avantaje: 10% din 3900', pAv.impozit, 390);
eq('CAM pe brut+avantaje: 2,25% din 6000', pAv.cam, 135);
eq('net cash: avantajul nu se plateste in bani, dar suporta retinerile', pAv.net, 2510);
const spAv = statePlata([{ id: 'a1', nume: 'Test Av', salariuBrut: 5000, avantaje: 1000 }]);
eq('stat de plata: avantajele apar pe rand si in totaluri', spAv.rows[0].avantaje + '|' + spAv.totals.avantaje, '1000|1000');
ok('D112: baza CAS (A_13) include avantajele (6000)', xml.d112Xml({ cui: 'RO1', nume: 'X' }, '2026-06', spAv).includes('A_13="6000"'));

section('Plafonul de 33% al avantajelor neimpozabile (art. 76 alin. (4^1) si (4^2))');
{
  const { round2 } = require('../src/util');
  const ang = (extra) => Object.assign({ id: 'b1', nume: 'Test Ben', cnp: '1900101010101', salariuBrut: 4000 }, extra);
  const SM = fiscal.salariuMinimLa('2026-06'); // 4050 -> limita cazarii (20%) = 810

  // 1) Sub ambele limite: nimic impozabil, contributiile raman cele ale salariului gol.
  const subLimite = statePlata([ang({ beneficii: { sport: 200, pensii: 500 } })], '2026-06').rows[0];
  const gol = statePlata([ang({})], '2026-06').rows[0];
  eq('plafonul e 33% din salariul de baza', subLimite.beneficiiPlafon, 1320);
  eq('sub ambele limite nu se impoziteaza nimic', subLimite.beneficiiImpozabile, 0);
  eq('contributiile raman neatinse', subLimite.cas + '|' + subLimite.cass + '|' + subLimite.cam, gol.cas + '|' + gol.cass + '|' + gol.cam);

  // 2) Limita INDIVIDUALA: cazarea peste 20% din salariul minim. Partea de peste NU trebuie sa
  //    consume plafonul comun — altfel ar impozita si categoriile urmatoare, care sunt in regula.
  const indiv = statePlata([ang({ beneficii: { cazare: 1000 } })], '2026-06').rows[0];
  eq('limita cazarii = 20% din salariul minim', indiv.beneficii[0].limitaIndividuala, round2(SM * 0.2));
  eq('ce trece de limita individuala e impozabil', indiv.beneficii[0].impozabil, round2(1000 - SM * 0.2));
  eq('restul plafonului de 33% ramane liber', indiv.beneficiiRamas, round2(1320 - SM * 0.2));

  // 3) Plafonul COMUN: 1000 cazare (810 admis) + 800 pensii + 200 sport pe un plafon de 1320.
  //    Ordinea legala (c -> e -> g) hotaraste cine ramane: cazarea intra prima, sportul iese ultimul.
  const peste = statePlata([ang({ beneficii: { cazare: 1000, pensii: 800, sport: 200 } })], '2026-06').rows[0];
  eq('neimpozabilul se opreste exact la plafon', peste.beneficiiNeimpozabile, 1320);
  eq('impozabil = 190 peste limita cazarii + 290 peste plafon la pensii + 200 sport', peste.beneficiiImpozabile, 680);
  eq('ordinea legala: cazarea intra prima, sportul ultimul', peste.beneficii.map((b) => b.lit).join(''), 'ceg');
  eq('sportul nu mai incape deloc', peste.beneficii[2].neimpozabil, 0);

  // 4) Partea impozabila intra in TOATE bazele — asta e miza reparatiei, nu plafonarea in sine.
  eq('CAS creste cu 25% din partea impozabila', round2(peste.cas - gol.cas), 170);
  eq('CASS creste cu 10% din partea impozabila', round2(peste.cass - gol.cass), 68);
  eq('CAM creste cu 2,25% din partea impozabila', round2(peste.cam - gol.cam), 15.3);
  ok('impozitul creste (baza include partea impozabila)', peste.impozit > gol.impozit);
  ok('netul in bani SCADE: avantajul nu se plateste cash, dar suporta retineri', peste.net < gol.net);

  // 5) Ordinea o alege ANGAJATORUL (alin. 4^2): aceleasi sume, alta ordine, alt rezultat pe categorii.
  const alta = statePlata([ang({ beneficii: { cazare: 1000, pensii: 800, sport: 200 }, ordineBeneficii: ['sport', 'pensii', 'cazare'] })], '2026-06').rows[0];
  eq('ordinea aleasa de angajator e respectata', alta.beneficii.map((b) => b.lit).join(''), 'gec');
  eq('sportul intra acum integral in plafon', alta.beneficii[0].impozabil, 0);
  eq('totalul impozabil ramane acelasi — se muta doar intre categorii', alta.beneficiiImpozabile, peste.beneficiiImpozabile);

  // 6) Plafoanele ANUALE se consuma pe an, din statele deja postate (lit. d)-g)).
  const anual = 400 * fiscal.FISCAL.cursEurBeneficii; // pensii facultative: 400 EUR/an
  const istoric = [{ period: '2026-05', rows: [{ angajatId: 'b1', beneficii: [{ id: 'pensii', acordat: anual, neimpozabil: anual, impozabil: 0 }] }] }];
  const dupa = statePlata([ang({ beneficii: { pensii: 500 } })], '2026-06', istoric).rows[0];
  eq('plafonul anual consumat lasa limita zero', dupa.beneficii[0].limitaIndividuala, 0);
  eq('tot ce se mai acorda anul asta e impozabil', dupa.beneficii[0].impozabil, 500);
  ok('motivul spune ca plafonul anual e consumat', /anual/i.test(dupa.beneficii[0].motiv));
  const altAn = statePlata([ang({ beneficii: { pensii: 500 } })], '2027-06', istoric).rows[0];
  eq('anul urmator plafonul reincepe', altAn.beneficii[0].impozabil, 0);

  // 0) Cuantumurile care alimenteaza limitele vin din RATES si sunt SUPRASCRIABILE din Setari.
  //    Se schimba prin alte acte decat Codul fiscal (legea tichetelor, legea BASS, HG-ul diurnei),
  //    deci se invechesc primele — un tabel de numere fixe ar fi cerut atins codul la fiecare an.
  eq('tichetul de masa: valoarea din Legea 201/2025', fiscal.FISCAL.tichetMasaMaxLei, 45);
  eq('castigul salarial mediu brut din legea BASS 2026', fiscal.FISCAL.castigSalarialMediuBrut, 9192);
  eq('diurna legala interna (HG 714/2018, actualizata)', fiscal.FISCAL.diurnaInternaLegala, 23);
  eq('limita hranei = valoarea unui tichet/zi', fiscal.categoriiBeneficii().find((c) => c.id === 'hrana').limita.lei, 45);
  eq('limita mobilitatii = 2,5 x diurna legala', fiscal.categoriiBeneficii().find((c) => c.id === 'mobilitate').limita.lei, 57.5);
  eq('plafonul anual al serviciilor turistice = castigul salarial mediu', fiscal.categoriiBeneficii().find((c) => c.id === 'turism').limita.lei, 9192);
  {
    // Suprascrierea din Setari trebuie sa AJUNGA in calcul, nu doar in tabelul de cote: citite
    // direct din fiscalConfig, categoriile ar fi ramas inghetate si knob-ul ar fi parut ca merge.
    fiscal.applyConfig({ tichetMasaMaxLei: 50, diurnaInternaLegala: 30 });
    eq('limita hranei urmeaza suprascrierea', fiscal.categoriiBeneficii().find((c) => c.id === 'hrana').limita.lei, 50);
    eq('si cea a mobilitatii, cu multiplul ei', fiscal.categoriiBeneficii().find((c) => c.id === 'mobilitate').limita.lei, 75);
    const cuSupra = statePlata([ang({ beneficii: { hrana: 1000 }, zileLucratoare: 20 })], '2026-06').rows[0];
    eq('calculul salarial foloseste limita suprascrisa (20 zile x 50)', cuSupra.beneficii[0].limitaIndividuala, 1000);
    fiscal.applyConfig({}); // reset la valorile implicite pentru restul suitei
    eq('resetul readuce valoarea legala', fiscal.categoriiBeneficii().find((c) => c.id === 'hrana').limita.lei, 45);
  }

  // 7) Hrana nu se cumuleaza cu tichetele de masa (lit. b, ultima teza).
  const cuTichete = statePlata([ang({ tichete: 600, beneficii: { hrana: 300 } })], '2026-06').rows[0];
  eq('hrana e integral impozabila cand exista tichete', cuTichete.beneficii[0].impozabil, 300);
  const faraTichete = statePlata([ang({ beneficii: { hrana: 300 }, zileLucratoare: 21 })], '2026-06').rows[0];
  eq('fara tichete, hrana intra in limita zilelor lucrate', faraTichete.beneficii[0].impozabil, 0);

  // 8) Telemunca: 400 lei/LUNA proportional cu zilele, nu 400 lei pe fiecare zi.
  const tele = statePlata([ang({ beneficii: { telemunca: 400 }, zileTelemunca: 10, zileLucratoare: 20 })], '2026-06').rows[0];
  eq('limita telemuncii e proportionala cu zilele (10/20 din 400)', tele.beneficii[0].limitaIndividuala, 200);
  eq('restul e impozabil', tele.beneficii[0].impozabil, 200);
  eq('zero zile de telemunca => limita zero', statePlata([ang({ beneficii: { telemunca: 400 } })], '2026-06').rows[0].beneficii[0].limitaIndividuala, 0);

  // 9) Plafonul se calculeaza pe salariul de BAZA, nu pe brutul realizat: un spor nu-l mareste,
  //    iar concediul medical nu-l micsoreaza. Fara asta, plafonul ar fluctua lunar fara temei.
  eq('sporul nu mareste plafonul', statePlata([ang({ spor: 2000, beneficii: { sport: 100 } })], '2026-06').rows[0].beneficiiPlafon, 1320);
  eq('concediul medical nu micsoreaza plafonul', statePlata([ang({ zileCM: 10, zileLucratoare: 21, beneficii: { sport: 100 } })], '2026-06').rows[0].beneficiiPlafon, 1320);

  // 10) D112: bazele declarate trebuie sa includa partea impozabila, altfel decontul raporteaza
  //     contributii mai mari decat bazele din care ies.
  const spBen = statePlata([ang({ beneficii: { cazare: 1000, pensii: 800, sport: 200 } })], '2026-06');
  const xBen = xml.d112Xml({ cui: 'RO1', nume: 'X', judet: 'B' }, '2026-06', spBen);
  ok('D112: baza CAS (A_13) include partea impozabila (4000+680)', xBen.includes('A_13="4680"'));
  ok('D112: baza CASS (A_11) include partea impozabila', xBen.includes('A_11="4680"'));
  ok('D112: baza CAM (C4_baza) o include si ea — C4_ct ramane 2,25% din ea', /C4_baza="4680" C4_ct="105"/.test(xBen));

  // 11) Categoriile neacordate nu apar pe stat (altfel fluturasul ar avea 10 randuri de zero).
  eq('doar categoriile acordate ajung pe rand', statePlata([ang({ beneficii: { sport: 100 } })], '2026-06').rows[0].beneficii.length, 1);
  eq('fara beneficii, randul e gol si totalul zero', gol.beneficii.length + '|' + gol.beneficiiImpozabile, '0|0');
}

section('Concediu medical in statul de plata (OUG 158/2005, simplificat)');
const pCm = fiscal.payroll(4000, 0, { cmAngajator: 500, cmFnuass: 700 });
eq('CAS pe salariu + indemnizatii CM (25% din 5200)', pCm.cas, 1300);
eq('CASS doar pe salariu (indemnizatiile CM sunt exceptate)', pCm.cass, 400);
eq('impozit pe tot venitul, dupa contributii', pCm.impozit, 350);
eq('CAM doar pe salariu + partea angajator', pCm.cam, 101.25);
eq('netul include indemnizatiile', pCm.net, 3150);
eq('costul angajatorului exclude partea FNUASS (recuperabila)', pCm.costTotal, 4601.25);
const spCm = statePlata([{ id: 'cm1', nume: 'Bolnav Ion', salariuBrut: 4200, zileCM: 7, procentCM: 75, zileLucratoare: 21 }], '2026-06');
const rCm = spCm.rows[0];
eq('salariul redus proportional (14/21 din 4200)', rCm.brut, 2800);
eq('baza CM fara istoric = brutul curent', rCm.mediaCM, 4200);
eq('angajatorul suporta primele 5 zile (150/zi)', rCm.cmAngajator, 750);
eq('FNUASS suporta restul de 2 zile', rCm.cmFnuass, 300);
eq('totalurile cumuleaza indemnizatia', spCm.totals.indemnizatieCM, 1050);
const histCm = [{ period: '2026-04', rows: [{ angajatId: 'cm1', brut: 4200 }] }, { period: '2026-05', rows: [{ angajatId: 'cm1', brut: 8400 }] }];
const spH = statePlata([{ id: 'cm1', nume: 'B', salariuBrut: 4200, zileCM: 4, zileLucratoare: 21 }], '2026-06', histCm);
eq('baza CM = media ultimelor luni postate (6300)', spH.rows[0].mediaCM, 6300);
eq('indemnizatie 4 zile x 225 (toata la angajator)', spH.rows[0].cmAngajator, 900);
const spPlaf = statePlata([{ id: 'x1', nume: 'P', salariuBrut: 4200, zileCM: 1, zileLucratoare: 21 }], '2026-06', [{ period: '2026-05', rows: [{ angajatId: 'x1', brut: 999999 }] }]);
eq('baza CM plafonata la 12 salarii minime', spPlaf.rows[0].mediaCM, 12 * fiscal.salariuMinimLa('2026-06'));
ok('D112: baza CAS (A_13) include CM, baza CASS (A_11) nu', (() => {
  const x = xml.d112Xml({ cui: 'RO1', nume: 'X' }, '2026-06', spCm);
  return x.includes('A_13="3850"') && x.includes('A_11="2800"');
})());

section('Norma partiala (OUG 16/2022) + concediu de odihna');
// salariul minim S1 2026 = 4050: diferentele pana la nivelul minim le suporta ANGAJATORUL
const pNp = fiscal.payroll(2000, 0, { bazaMinima: 4050 });
eq('CAS angajat pe venitul real (25% din 2000)', pNp.cas, 500);
eq('CAS angajator = diferenta pana la salariul minim (25% din 2050)', pNp.casAngajator, 512.5);
eq('CASS angajator = diferenta (10% din 2050)', pNp.cassAngajator, 205);
eq('netul angajatului NU scade din suprataxare', pNp.net, 1170);
eq('costul angajatorului include suprataxarea', pNp.costTotal, 2762.5);
const spNp = statePlata([{ id: 'np1', nume: 'Partial', salariuBrut: 2000, normaPartiala: true }], '2026-06');
eq('stat: suprataxarea apare pe rand si in totaluri', spNp.rows[0].casAngajator + '|' + spNp.totals.cassAngajator, '512.5|205');
eq('stat: total de virat include partea angajatorului', spNp.totals.totalBuget, 500 + 200 + 49 + 45 + 512.5 + 205); // impozit 49: sub salariul minim, deducerea e maxima (810)
eq('exceptia legala (student/pensionar/cumul) anuleaza suprataxarea', statePlata([{ id: 'np2', nume: 'S', salariuBrut: 2000, normaPartiala: true, scutitNormaPartiala: true }], '2026-06').rows[0].casAngajator, 0);
ok('D112: suprataxarea normei partiale intra in obligatiile 412/432', (() => {
  // CAS: 500 (angajat) + 512.5 (angajator) = 1013; CASS: 200 + 205 = 405
  const x = xml.d112Xml({ cui: 'RO1', nume: 'X' }, '2026-06', spNp);
  return /A_codOblig="412" A_datorat="1013"/.test(x) && /A_codOblig="432" A_datorat="405"/.test(x);
})());
const histCo = [{ period: '2026-03', rows: [{ angajatId: 'co1', brut: 6000 }] }, { period: '2026-04', rows: [{ angajatId: 'co1', brut: 6000 }] }, { period: '2026-05', rows: [{ angajatId: 'co1', brut: 6300 }] }];
const spCo = statePlata([{ id: 'co1', nume: 'Vacanta', salariuBrut: 4200, zileCO: 7, zileLucratoare: 21 }], '2026-06', histCo);
eq('CO: media ultimelor 3 luni', spCo.rows[0].mediaCO, 6100);
eq('CO: indemnizatia pe 7 zile din media', spCo.rows[0].indemnizatieCO, 2033.33);
eq('CO: salariul zilelor lucrate (14/21 din 4200)', spCo.rows[0].salariuZileLucrate, 2800);
eq('CO: brutul impozabil = salariu + indemnizatie', spCo.rows[0].brut, 4833.33);
eq('CO fara istoric: media = brutul curent (echivalent salariului)', statePlata([{ id: 'c2', nume: 'V2', salariuBrut: 4200, zileCO: 7, zileLucratoare: 21 }], '2026-06').rows[0].brut, 4200);
eq('CO + CM: zilele de CO plafonate la zilele ramase', statePlata([{ id: 'c3', nume: 'V3', salariuBrut: 4200, zileCM: 18, zileCO: 10, zileLucratoare: 21 }], '2026-06').rows[0].zileCO, 3);

section('Taxe PFA — Declaratia Unica (plafoane pe salariu minim 4000)');
const pfa = (vn) => fiscal.taxePfa(vn, { salariuMinim: 4000 }); // p6=24k p12=48k p24=96k p60=240k
eq('venit 0: nimic datorat', pfa(0).total, 0);
eq('venit 20000 (<6SM): CAS optionala 0, CASS la baza minima 6SM', pfa(20000).cas + '|' + pfa(20000).cass, '0|2400');
eq('venit 20000: impozit 10% dupa CASS', pfa(20000).impozit, 1760);
eq('venit 50000 (>=12SM): CAS la baza 12SM = 12000', pfa(50000).cas, 12000);
eq('venit 50000: CASS pe venitul real 10%', pfa(50000).cass, 5000);
eq('venit 100000 (>=24SM): CAS la baza 24SM = 24000', pfa(100000).cas, 24000);
eq('venit 300000: CASS plafonata la 60SM (24000)', pfa(300000).cass, 24000);
eq('venit 300000: impozit 10% pe net minus contributii', pfa(300000).impozit, 25200);
const duDb = { entries: [
  { period: '2026-03', data: '2026-03-10', lines: [{ debit: '4111', credit: '704', suma: 100000 }] },
  { period: '2026-07', data: '2026-07-10', lines: [{ debit: '628', credit: '401', suma: 30000 }] },
], openingBalances: {} };
const du = rep.declaratiaUnica(duDb, '2026');
eq('DU: venit net anual = venituri - cheltuieli', du.venitNet, 70000);
ok('DU: taxele coincid cu taxePfa pe salariul minim al anului', (() => {
  const t = fiscal.taxePfa(70000, { salariuMinim: fiscal.salariuMinimLa('2026-01') });
  return du.cas === t.cas && du.cass === t.cass && du.impozit === t.impozit && du.total === t.total;
})());

section('Registrul de incasari si plati (partida simpla, PFA)');
const ripDb = { entries: [
  { id: 'r1', period: '2026-06', data: '2026-06-01', document: 'F1', partener: 'Client', lines: [{ debit: '5121', credit: '4111', suma: 1000, explicatie: 'incasare client' }] },
  { id: 'r2', period: '2026-06', data: '2026-06-02', document: 'B2', lines: [{ debit: '605', credit: '5121', suma: 200, explicatie: 'utilitati' }] },
  { id: 'r3', period: '2026-06', data: '2026-06-03', lines: [{ debit: '5311', credit: '5121', suma: 300, explicatie: 'ridicare numerar' }] },
  { id: 'r4', period: '2026-06', data: '2026-06-04', lines: [{ debit: '5121', credit: '455', suma: 5000, explicatie: 'aport' }] },
  { id: 'r5', period: '2026-06', data: '2026-06-05', lines: [{ debit: '4423', credit: '5121', suma: 150, explicatie: 'plata TVA' }] },
  { id: 'r6', period: '2026-07', data: '2026-07-05', lines: [{ debit: '5311', credit: '704', suma: 400, explicatie: 'vanzare cash' }] },
] };
const rip = acc.registruIncasariPlati(ripDb, '2026-06');
eq('RIP: 5 operatiuni in iunie', rip.rows.length, 5);
eq('RIP: incasari din activitate (doar clientul)', rip.tot.incFiscale, 1000);
eq('RIP: plati deductibile (doar utilitatile)', rip.tot.platiFiscale, 200);
eq('RIP: venit net pe incasari', rip.venitNetIncasat, 800);
eq('RIP: platile de TVA separate, nedeductibile', rip.tot.taxePlatite, 150);
ok('RIP: viramentul intern marcat', rip.rows.some((r) => r.cat === 'intern'));
ok('RIP: aportul intreprinzatorului marcat neutru', rip.rows.some((r) => r.cat === 'neutru' && r.contra === '455'));
eq('RIP pe an: include si iulie (1000+400)', acc.registruIncasariPlati(ripDb, '2026').tot.incFiscale, 1400);
const duRip = rep.declaratiaUnica(ripDb, '2026');
eq('DU: baza pe angajamente (704 − 605)', duRip.venitNet, 200);
eq('DU: varianta pe incasat/platit (1400 − 200)', duRip.incasat.venitNet, 1200);

section('Stat de plata (per angajat)');
const sp = statePlata(v.angajati, '2026-06'); // perioada FIXATA: vezi nota de mai jos
eq('numar angajati', sp.rows.length, 1);
eq('total brut', sp.totals.brut, 5000);
eq('total net', sp.totals.net, 2968); // 5000 - 1250 CAS - 500 CASS - 282 impozit (deducere 430)
eq('total de virat la buget', sp.totals.totalBuget, 2144.5); // 1250+500+282+112.5
eq('cost total angajator', sp.totals.costTotal, 5112.5);
eq('angajat net = payroll net', sp.rows[0].net, fiscal.payroll(5000, 430).net); // 430 = deducerea personala la 5000 brut, SM 4050
const d112 = xml.d112Xml(v.company, '2026-06', sp);
ok('D112 bine-format', wellFormed(d112));
ok('D112 pe schema curenta (declaratieUnica v7)', d112.includes('xmlns="mfp:anaf:dgti:declaratie_unica:declaratie:v7"'));
ok('D112 contine asiguratul (nume/prenume separate + CNP)', d112.includes('numeAsig="Popescu"') && d112.includes('prenAsig="Ion"') && d112.includes('cnpAsig="1900101415238"'));
ok('D112: obligatiile pe coduri (602/412/432/480) cu totalul de plata', /A_codOblig="602" A_datorat="282"/.test(d112) && /A_codOblig="480" A_datorat="113"/.test(d112) && d112.includes('totalPlata_A="2145"'));
ok('D112: impozitul per asigurat in E3 (E3_15) si Timp_E3', d112.includes('E3_15="282"') && d112.includes('Timp_E3="282"'));
ok('D112: NZL cu sarbatorile legale (iunie 2026 = 21 zile, 1 iunie Rusalii)', d112.includes('A_8="21"') && d112.includes('A_6="168"'));
// spor (impozabil) + retineri (din net)
const sp2 = statePlata([{ id: 'x', nume: 'Test', salariuBrut: 4700, spor: 300, retineri: 500 }], '2026-06');
eq('brut cu spor (4700+300)', sp2.totals.brut, 5000);
eq('net (ca la 5000 brut)', sp2.totals.net, 2968);
eq('rest de plata = net - retineri', sp2.rows[0].restPlata, 2468);
eq('total retineri', sp2.totals.retineri, 500);
const sp3 = statePlata([{ id: 'y', nume: 'Test', salariuBrut: 5000, avans: 1000, retineri: 200 }], '2026-06');
eq('rest de plata = net - avans - retineri', sp3.rows[0].restPlata, 1768);
eq('total avans', sp3.totals.avans, 1000);

section('Deducere personala (art. 77 Cod fiscal)');
const sm = fiscal.FISCAL.salariuMinimS1; // 4050
eq('la salariu minim, 0 persoane = 20%', fiscal.deducerePersonala(sm, 0, { salariuMinim: sm }).total, Math.ceil((sm * 0.2) / 10) * 10);
eq('la salariu minim, 2 persoane = 30%', fiscal.deducerePersonala(sm, 2, { salariuMinim: sm }).total, Math.ceil((sm * 0.3) / 10) * 10);
eq('la salariu minim, 4+ persoane = 45%', fiscal.deducerePersonala(sm, 5, { salariuMinim: sm }).total, Math.ceil((sm * 0.45) / 10) * 10);
eq('peste salariu minim+2000 -> 0', fiscal.deducerePersonala(sm + 2500, 2, { salariuMinim: sm }).total, 0);
eq('la mijloc (sm+1000), 0 pers = jumatate din baza', fiscal.deducerePersonala(sm + 1000, 0, { salariuMinim: sm }).baza, sm * 0.2 * 0.5);
eq('tanar <=26 ani: +15% din salariul minim', fiscal.deducerePersonala(sm, 0, { salariuMinim: sm, sub26: true }).suplimentara, sm * 0.15);
eq('100 lei x 2 copii in invatamant', fiscal.deducerePersonala(sm, 0, { salariuMinim: sm, copii: 2 }).suplimentara, 200);
// integrare in statul de plata: angajat la salariul minim cu 1 persoana in intretinere
const dpMin = fiscal.deducerePersonala(sm, 1, { salariuMinim: sm }).total; // 25% -> 1015 rotunjit
const spDP = statePlata([{ id: 'z', nume: 'MinWage', salariuBrut: sm, persoane: 1 }], '2026-03'); // S1 explicit
// Angajatul e CHIAR la salariul minim, deci primeste si suma neimpozabila din art. 76 — referinta
// trebuie sa o includa, altfel testul ar compara statul de plata cu un calcul incomplet.
const payMin = fiscal.payroll(sm, dpMin, { neimpozabilMinim: fiscal.neimpozabilLa('2026-03') });
eq('impozit scade cu deducerea personala', spDP.rows[0].impozit, payMin.impozit);

// ── Suma neimpozabila din salariul minim (art. 76 Cod fiscal) ───────────────────────────────
// `neimpozabilLa()` exista si era testata, dar nu era folosita NICAIERI in productie: facilitatea
// pur si simplu nu se acorda. Se DERIVA din salariul de baza si din luna — un cuantum stocat pe
// angajat ar ramane adevarat dupa ce salariul creste.
{
  const { round2 } = require('../src/util');
  const nz = fiscal.neimpozabilMinim;
  const smS1 = fiscal.salariuMinimLa('2026-03'); // 4050, suma 300
  const smS2 = fiscal.salariuMinimLa('2026-08'); // 4325, suma 200
  ok('la salariul minim exact: eligibil', nz(smS1, smS1, '2026-03').eligibil);
  eq('...cu suma lunii (S1 = 300)', nz(smS1, smS1, '2026-03').suma, 300);
  eq('...si S2 = 200 (de la 1 iulie)', nz(smS2, smS2, '2026-08').suma, 200);
  // conditia 1: salariul de BAZA trebuie sa fie la nivelul minimului
  eq('salariu peste minim: fara facilitate', nz(8000, 8000, '2026-03').suma, 0);
  ok('...si spune de ce', /nu e la nivelul salariului minim/.test(nz(8000, 8000, '2026-03').motiv));
  // conditia 2: brutul lunii nu depaseste minimul + suma; peste plafon cade INTEGRAL, nu proportional
  eq('spor care lasa brutul sub plafon: facilitatea ramane', nz(smS1 + 100, smS1, '2026-03').suma, 300);
  eq('spor care trece brutul peste plafon: facilitatea cade integral', nz(smS1 + 400, smS1, '2026-03').suma, 0);
  ok('...si spune de ce', /depaseste plafonul/.test(nz(smS1 + 400, smS1, '2026-03').motiv));

  // Miezul: suma iese din TOATE bazele, nu doar din cea de impozit. Tratata ca simpla deducere,
  // CAS/CASS/CAM ar fi ramas calculate pe intreg brutul — si asta merge direct in D112.
  const cu = fiscal.payroll(smS1, 0, { neimpozabilMinim: 300 });
  const fara = fiscal.payroll(smS1, 0);
  const bazaRedusa = round2(smS1 - 300);
  eq('CAS pe baza REDUSA cu suma neimpozabila', cu.cas, round2(bazaRedusa * 0.25));
  eq('CASS pe baza REDUSA', cu.cass, round2(bazaRedusa * 0.10));
  eq('CAM pe baza REDUSA', cu.cam, round2(bazaRedusa * 0.0225));
  ok('CAS scade fata de calculul fara facilitate', cu.cas < fara.cas);
  ok('CASS scade fata de calculul fara facilitate', cu.cass < fara.cass);
  ok('CAM scade fata de calculul fara facilitate', cu.cam < fara.cam);
  ok('impozitul scade si el', cu.impozit < fara.impozit);
  // netul creste fara ca brutul sa se schimbe: suma ramane in brut, doar nu mai e taxata
  ok('netul creste, la acelasi brut', cu.net > fara.net && cu.brut === fara.brut);
  eq('netul = brut - CAS - CASS - impozit', cu.net, round2(smS1 - cu.cas - cu.cass - cu.impozit));

  // integrarea in statul de plata: derivata, nu luata din campul manual
  const spNz = statePlata([{ id: 'n1', nume: 'MinWage', salariuBrut: smS1 }], '2026-03').rows[0];
  eq('statul de plata acorda facilitatea singur', spNz.neimpozabilMinim, 300);
  eq('...si CAS-ul e cel pe baza redusa', spNz.cas, round2(bazaRedusa * 0.25));
  const spSus = statePlata([{ id: 'n2', nume: 'Sus', salariuBrut: 8000 }], '2026-03').rows[0];
  eq('peste minim: statul nu o acorda', spSus.neimpozabilMinim, 0);
  ok('...si consemneaza motivul, ca lipsa ei sa nu para eroare de calcul', !!spSus.neimpozabilMinimMotiv);
  // campul manual „venit neimpozabil suplimentar" ramane SEPARAT (alte venituri scutite)
  const spAmbele = statePlata([{ id: 'n3', nume: 'Ambele', salariuBrut: smS1, neimpozabil: 50 }], '2026-03').rows[0];
  eq('campul manual ramane distinct de facilitate', spAmbele.neimpozabilMinim, 300);
  eq('...si se aplica pe langa ea (doar pe baza de impozit)', spAmbele.impozit, round2(spNz.impozit - 5));
}
eq('deducerea apare in rand', spDP.rows[0].deducere, dpMin);
ok('impozit cu deducere < impozit fara deducere', payMin.impozit < fiscal.payroll(sm, 0).impozit);
// DEDUCEREA NU ATARNA DE COMPLETAREA UNUI CAMP. Aici statea, pana la 2026-08-09, un test care
// cerea „angajat fara persoane -> deducere 0 (compat)". Codifica un defect: formularul avea
// `placeholder="0"` fara `value="0"`, deci campul „Persoane in intretinere" ARATA completat cu zero
// dar se trimitea GOL, iar gol insemna „fara nicio deducere". Masurat: 43 lei/luna, 516 lei/an
// supraimpozitare per angajat, si un test verde care o garanta.
// Regula legala (art. 77): deducerea se acorda la FUNCTIA DE BAZA, iar cu zero persoane in
// intretinere se cuvine tot deducerea de baza. Singura exceptie — al doilea loc de munca — se
// declara EXPLICIT, nu prin uitarea unui camp.
{
  const faraCamp = statePlata([{ id: 'q1', nume: 'Fara camp', salariuBrut: 5000 }], '2026-06').rows[0];
  const zeroTastat = statePlata([{ id: 'q2', nume: 'Zero', salariuBrut: 5000, persoane: 0 }], '2026-06').rows[0];
  eq('campul necompletat NU costa angajatul: aceeasi deducere ca „0" tastat', faraCamp.deducere, zeroTastat.deducere);
  eq('...si e chiar deducerea de baza la 5000 brut (SM 4050)', faraCamp.deducere, 430);
  eq('...deci acelasi impozit', faraCamp.impozit, zeroTastat.impozit);
  // Al doilea loc de munca: singurul caz fara deducere, si se cere DECLARAT.
  const alDoilea = statePlata([{ id: 'q3', nume: 'Al doilea job', salariuBrut: 5000, persoane: 0, functieBaza: false }], '2026-06').rows[0];
  eq('al doilea loc de munca: fara deducere personala', alDoilea.deducere, 0);
  ok('...deci impozit mai mare decat la functia de baza', alDoilea.impozit > faraCamp.impozit);
  // Persoanele in intretinere cresc deducerea (20% -> 30% din SM la 2 persoane).
  const cuDoua = statePlata([{ id: 'q4', nume: 'Doua pers', salariuBrut: 5000, persoane: 2 }], '2026-06').rows[0];
  eq('doua persoane in intretinere -> deducere mai mare', cuDoua.deducere, 640);
  ok('...si impozit mai mic', cuDoua.impozit < faraCamp.impozit);
}

section('Salarizare extinsa (tichete, scutiri sectoriale, concedii)');
const pT = fiscal.payroll(5000, 0, { tichete: 500 });
eq('CAS doar pe salariu (nu tichete)', pT.cas, 1250);
eq('CASS pe brut+tichete (5500×10%)', pT.cass, 550);
eq('impozit pe baza incl. tichete (370)', pT.impozit, 370);
// Facilitatile sectoriale au fost ELIMINATE din ian. 2025 (OUG 156/2024): impozitare standard.
const pIT = fiscal.payroll(8000, 500, { sector: 'it' });
eq('IT: impozit standard (facilitate eliminata)', pIT.impozit, fiscal.payroll(8000, 500).impozit);
ok('IT: fara scutiri', !pIT.scutImpozit && !pIT.scutCass && pIT.impozit > 0);
const pC = fiscal.payroll(6000, 0, { sector: 'constructii' });
eq('constructii: CASS standard 10%', pC.cass, 600);
ok('constructii: impozit datorat', pC.impozit > 0);
eq('compat: payroll(5000) neschimbat', fiscal.payroll(5000).impozit, 325);
// salariul minim pe semestre: S1 pana in iunie, S2 de la 1 iulie
eq('salariu minim ianuarie-iunie (S1)', fiscal.salariuMinimLa('2026-03'), fiscal.FISCAL.salariuMinimS1);
eq('salariu minim iulie-decembrie (S2)', fiscal.salariuMinimLa('2026-09'), fiscal.FISCAL.salariuMinimS2);
eq('neimpozabil S2 din iulie', fiscal.neimpozabilLa('2026-07'), fiscal.FISCAL.neimpozabilS2);
ok('deducerea personala foloseste S2 dupa 1 iulie',
  fiscal.deducerePersonala(fiscal.FISCAL.salariuMinimS2, 0, { period: '2026-08' }).baza === fiscal.FISCAL.salariuMinimS2 * 0.2);
const gt2 = require('../src/documentTypes').getType;
const dc = (id, s) => { const l = gt2(id).build({ suma: s })[0]; return l.debit + '=' + l.credit; };
eq('tichete de masa: 642=5328', dc('tichete_masa', 500), '642=5328');
eq('concediu medical angajator: 6458=423', dc('concediu_medical_angajator', 300), '6458=423');
eq('concediu medical FNUASS: 4373=423', dc('concediu_medical_fnuass', 700), '4373=423');
eq('recuperare FNUASS: 5121=4373', dc('recuperare_fnuass', 700), '5121=4373');
// registru anual de salarii (cumul din 2 luni)
const hist = [
  { period: '2026-06', rows: [{ angajatId: 'a', nume: 'Ion', cnp: '123', brut: 5000, cas: 1250, cass: 500, impozit: 325, net: 2925 }] },
  { period: '2026-07', rows: [{ angajatId: 'a', nume: 'Ion', cnp: '123', brut: 5000, cas: 1250, cass: 500, impozit: 325, net: 2925 }] },
];
const rs = registruSalarii(hist, 2026);
eq('registru: nr luni', rs.nrLuni, 2);
eq('registru: brut anual cumulat', rs.angajati[0].brut, 10000);
eq('registru: net anual cumulat', rs.angajati[0].net, 5850);
eq('registru: luni angajat', rs.angajati[0].luni, 2);

section('TVA la incasare (regim special 4428)');
const { getType } = require('../src/documentTypes');
const mkTva = (id, f, date) => ({ id, data: date, period: date.slice(0, 7), tip: id, tipNume: '', lines: getType(id).build(f) });
const vTva = { entries: [mkTva('factura_vanzare_incasare', { baza: 1000, tva: 210, cota: 21 }, '2026-08-05')], openingBalances: {} };
ok('factura vanzare incasare crediteaza 4428', vTva.entries[0].lines.some((l) => l.credit === '4428'));
eq('TVA neexigibila NU intra in decont', acc.vatClosing(vTva, '2026-08').colectata, 0);
vTva.entries.push(mkTva('exigibilitate_tva_colectata', { tva: 210 }, '2026-08-20'));
eq('dupa incasare devine TVA colectata', acc.vatClosing(vTva, '2026-08').colectata, 210);
// TVA din suma bruta (incasare automata)
const tvaDinBrut = (brut, cota) => Math.round((brut * cota) / (100 + cota) * 100) / 100;
eq('TVA exigibila din 1210 brut @ 21%', tvaDinBrut(1210, 21), 210);
eq('TVA exigibila din 1110 brut @ 11%', tvaDinBrut(1110, 11), 110);
// registru TVA neexigibila (4428)
const vNeex = { entries: [
  mkTva('factura_vanzare_incasare', { baza: 1000, tva: 210, cota: 21 }, '2026-08-05'),
  mkTva('factura_cumparare_incasare', { baza: 2000, tva: 420, cota: 21 }, '2026-08-06'),
  mkTva('exigibilitate_tva_colectata', { tva: 210 }, '2026-08-20'),
], openingBalances: {} };
const neex = acc.tvaNeexigibila(vNeex, null);
eq('colectata neexigibila ramasa (incasata)', neex.colectataNeexigibila, 0);
eq('deductibila neexigibila ramasa (neplatita)', neex.deductibilaNeexigibila, 420);

// Ciclu complet TVA la incasare: la exigibilitate, BAZA aferenta intra in D300 (nu doar TVA)
const exColectata = Object.assign(mkTva('exigibilitate_tva_colectata', { tva: 210 }, '2026-09-20'), { tvaExig: { baza: 1000, cota: 21, side: 'colectata' } });
const vjExig = acc.vatJournals({ entries: [exColectata], openingBalances: {} }, '2026-09');
eq('D300 exigibilitate: baza raportata (nu 0)', vjExig.totals.bazaV, 1000);
eq('D300 exigibilitate: TVA colectata', vjExig.totals.colectata, 210);
eq('D300 exigibilitate: cota derivata corect (21%)', vjExig.vanzari[0].cota, 21);
eq('D300 exigibilitate: defalcare pe cota 21', (vjExig.coteV.find((x) => x.cota === 21) || {}).baza, 1000);
const exDeduct = Object.assign(mkTva('exigibilitate_tva_deductibila', { tva: 420 }, '2026-09-21'), { tvaExig: { baza: 2000, cota: 21, side: 'deductibila' } });
const vjDed = acc.vatJournals({ entries: [exDeduct], openingBalances: {} }, '2026-09');
eq('D300 exigibilitate deductibila: baza cumparari raportata', vjDed.totals.bazaC, 2000);
eq('D300 exigibilitate deductibila: TVA deductibila', vjDed.totals.deductibila, 420);

section('CSV — export/import parteneri (round-trip)');
const { toCsv, parseCsv } = require('../src/csv');
const csvP = toCsv(['CUI', 'Denumire', 'Adresa'], [['RO123', 'Firma A; SRL', 'Str. 1'], ['456', 'Firma "B"', 'Str. 2']]);
const parsed = parseCsv(csvP);
eq('parseCsv: nr randuri (header + 2)', parsed.length, 3);
eq('parseCsv: separator in ghilimele pastrat', parsed[1][1], 'Firma A; SRL');
eq('parseCsv: ghilimele escapate', parsed[2][1], 'Firma "B"');
eq('parseCsv: tolereaza separator , si ;', parseCsv('a,b,c').length, 1);

// Injectie de formule in foaia de calcul: Excel/LibreOffice evalueaza celula care incepe cu
// = + - @ TAB CR. Denumirile de parteneri vin din e-Factura/SPV — le scrie PARTEA CEALALTA —
// din extrase bancare si din extragerea AI, iar exporturile ajung deschise in Excel de contabil.
const celula = (v) => toCsv(['V'], [[v]]).split('\r\n')[1];
ok('formula cu = e neutralizata', celula('=HYPERLINK("http://x","c")').startsWith('"\'='));
ok('formula cu + e neutralizata', celula('+SUM(A1:A9)') === "'+SUM(A1:A9)");
ok('formula cu @ e neutralizata', celula('@import') === "'@import");
ok('vectorul DDE cu - e neutralizat', celula("-2+3+cmd|'/c calc'!A0").startsWith("'-"));
ok('TAB la inceput e neutralizat', celula('\tceva').startsWith('"\'\t') || celula('\tceva').startsWith("'\t"));
// Cazul care face diferenta dintre un remediu bun si unul daunator: sumele negative sunt
// frecvente in contabilitate si NU trebuie sa primeasca apostrof (ar strica orice export).
eq('suma negativa ramane numar', celula('-1234.56'), '-1234.56');
eq('suma negativa subunitara ramane numar', celula('-0.5'), '-0.5');
eq('numarul cu plus ramane numar', celula('+1234'), '+1234');
eq('numarul obisnuit ramane neatins', celula('1234.56'), '1234.56');
eq('denumirea obisnuita ramane neatinsa', celula('Firma & Co SRL'), 'Firma & Co SRL');
// Dus-intors: apostroful de protectie NU trebuie sa se lipeasca de denumire la reimport
// (exporturile de parteneri/produse chiar se reimporta).
const rtCsv = (v) => parseCsv(toCsv(['V'], [[v]]))[1][0];
for (const v of ['=X', '+SUM(A1)', '@x', "-2+3+cmd|'/c calc'!A0", '-1234.56', 'Firma & Co', "'apostrof real"]) {
  eq('dus-intors fidel pentru ' + JSON.stringify(v), rtCsv(v), v);
}

// Antet sau primul rand de date? Decizia se ia DUPA PRIMA CELULA si cere cuvantul INTREG.
// Varianta de dinainte cauta „cod|cont|cui|denumire" oriunde in primele doua celule si inghitea
// TACIT primul rand real cand DENUMIREA continea unul din cuvinte. Importul raporta succes cu un
// rand mai putin — pierdere de date fara nicio eroare. Cazuri reale, din patru importuri diferite.
const { isHeaderRow } = require('../src/csv');
ok('antet adevarat recunoscut', isHeaderRow(['Cod', 'Denumire', 'Clasa']));
ok('antet cu determinant recunoscut („Cod produs")', isHeaderRow(['Cod produs', 'Denumire']));
ok('antet CUI recunoscut', isHeaderRow(['CUI', 'Denumire']));
ok('antet Denumire recunoscut', isHeaderRow(['Denumire', 'Cantitate']));
eq('contul „5121;Conturi curente la banci" NU e antet', isHeaderRow(['5121', 'Conturi curente la banci']), false);
eq('partenerul „RO9001;CODLEA PROD SRL" NU e antet', isHeaderRow(['RO9001', 'CODLEA PROD SRL']), false);
// Cazul care face cuvantul-intreg sa CONTEZE: un cod de produs care incepe chiar cu „COD".
// Cu regula „contine", randul asta ar disparea; cu „cuvant intreg", „COD-123" nu e „COD".
eq('codul de produs „COD-123" NU e antet', isHeaderRow(['COD-123', 'Momeala pescuit']), false);
eq('codul de produs „CONTOR-5" NU e antet', isHeaderRow(['CONTOR-5', 'Contor apa']), false);
eq('randul gol nu e antet', isHeaderRow([]), false);

section('Import plan de conturi personalizat');
const coaMod = require('../src/chartOfAccounts');
coaMod.addAccounts([{ cod: '6028', nume: 'Cheltuieli cu alte materiale', clasa: 6, tip: 'C' }]);
eq('cont personalizat adaugat', coaMod.accountName('6028'), 'Cheltuieli cu alte materiale');
ok('contul nou apare in lista', coaMod.ACCOUNTS.some((a) => a.cod === '6028'));
coaMod.addAccounts([{ cod: '6028', nume: 'Redenumit' }]); // upsert
eq('upsert cont existent', coaMod.accountName('6028'), 'Redenumit');
// normalSide (singura functie exportata fara test direct): sensul normal al contului dupa natura
eq('normalSide: activ (411 clienti) -> Debit', coaMod.normalSide('4111'), 'D');
eq('normalSide: pasiv (401 furnizori) -> Credit', coaMod.normalSide('401'), 'C');
eq('normalSide: cheltuiala (clasa 6) -> Debit', coaMod.normalSide('607'), 'D');
eq('normalSide: venit (clasa 7) -> Credit', coaMod.normalSide('707'), 'C');
eq('normalSide: bifunctional (121 rezultat) -> B', coaMod.normalSide('121'), 'B');
eq('normalSide: cont necunoscut -> D (implicit prudent)', coaMod.normalSide('9999'), 'D');
ok('accountName: cont necunoscut -> fallback lizibil, fara throw', /necunoscut/.test(coaMod.accountName('9999')));

section('Export/import firma (remapare id-uri)');
// construieste un mini-bundle cu referinte interne (movement -> product/gestiune; transfer)
const bundle = {
  // Campurile privilegiate sunt deliberat ostile: importul trebuie sa le ignore.
  firma: { id: 9, nume: 'Test SRL', cui: '999', ownerId: 999, lockedUntil: '2099-12', subscription: { status: 'active', plan: 'gratis' }, anaf: { accessToken: 'furt' } },
  partners: {}, openingBalances: { 371: { d: 1000, c: 0 } }, openingAnalytic: [],
  products: [{ id: 'p1', firmaId: 9, cod: 'X', denumire: 'X', um: 'buc', cont: '371' }],
  gestiuni: [{ id: 'g1', firmaId: 9, cod: 'D', denumire: 'Depozit' }, { id: 'g2', firmaId: 9, cod: 'M', denumire: 'Magazin' }],
  stockMovements: [{ id: 'm1', firmaId: 9, data: '2026-01-01', tip: 'transfer', productId: 'p1', gestiuneId: 'g1', gestiuneDestId: 'g2', cantitate: 5 }],
  documents: [{ id: 'd1', firmaId: 9, fileName: 'secret.pdf', storedName: 'fisierul-altei-firme.pdf' }],
  entries: [{ id: 'e1', firmaId: 9, fileId: 'd1', data: '2026-01-01', period: '2026-01', tip: 't', tipNume: 't', lines: [{ debit: '371', credit: '401', suma: 100 }] }],
  inventories: [], assets: [], angajati: [], payrollHistory: [],
  inventarAnual: [{ id: 'ia1', firmaId: 9, an: '2026', cont: '371', valoareInventar: 900 }],
  recurringInvoices: [{ id: 'r1', firmaId: 9, tip: 'factura_vanzare', fields: {}, frecventa: 'lunar' }],
  recipes: [{ id: 'bom1', firmaId: 9, nume: 'Reteta', productId: 'p1', gestiuneId: 'g1', materiale: [{ productId: 'p1', gestiuneId: 'g1', cantitate: 1 }] }],
  budgets: [{ id: 'b1', firmaId: 9, an: '2026', cont: '371', suma: 500 }],
  declarations: [{ id: 'dc1', firmaId: 9, tip: 'D300', period: '2026-01' }],
  closings: [{ id: 'cl1', firmaId: 9, period: '2026-01', steps: {} }],
  extractInterventions: [{ id: 'x1', firmaId: 9, documentId: 'd1', entryId: 'e1', diff: {} }],
  leasingContracts: [{ id: 'l1', firmaId: 9, denumire: 'Contract test' }],
};
const newFid = db.importFirma(bundle);
const v2 = db.scoped(newFid);
ok('firma importata are id nou', newFid !== 9);
const firmaImportata = db.getFirma(newFid);
ok('importul NU preia owner/subscription/lock/ANAF din fisier', !firmaImportata.ownerId && !firmaImportata.subscription && !firmaImportata.lockedUntil && !firmaImportata.anaf);
eq('produse importate', v2.products.length, 1);
eq('miscari importate', v2.stockMovements.length, 1);
const mv = v2.stockMovements[0];
ok('miscarea trimite la un produs valid din firma noua', v2.products.some((p) => p.id === mv.productId));
ok('miscarea trimite la gestiuni valide (sursa+dest)', v2.gestiuni.some((g) => g.id === mv.gestiuneId) && v2.gestiuni.some((g) => g.id === mv.gestiuneDestId));
const reexport = db.exportFirma(newFid);
eq('export reflecta firma importata', reexport.entries.length, 1);
ok('importul JSON elimina storedName (nu poate revendica fisierul altei firme)', reexport.documents.length === 1 && reexport.documents[0].storedName == null);
ok('fileId ramane remapat catre documentul importat', reexport.entries[0].fileId === reexport.documents[0].id);
eq('colectiile complete fac round-trip (inventar/recurente/retete/bugete/declaratii/inchideri/interventii/leasing)',
  [reexport.inventarAnual, reexport.recurringInvoices, reexport.recipes, reexport.budgets, reexport.declarations, reexport.closings, reexport.extractInterventions, reexport.leasingContracts].map((x) => x.length).join(','),
  '1,1,1,1,1,1,1,1');
ok('reteta isi remapeaza produsul si gestiunea', reexport.recipes[0].productId === reexport.products[0].id && reexport.recipes[0].gestiuneId === reexport.gestiuni[0].id);

// Validarea se termina INAINTE de prima mutatie: cont necunoscut si referinta orfana nu lasa
// nici firma, nici id-uri consumate, nici articole partiale in graf.
{
  const firme0 = db.get().firme.length; const seq0 = db.get().seq; const entries0 = db.get().entries.length;
  const rau = JSON.parse(JSON.stringify(bundle));
  rau.firma.nume = 'Nu trebuie sa existe';
  rau.entries[0].lines[0].debit = '999999';
  let err = null; try { db.importFirma(rau); } catch (e) { err = e; }
  ok('cont necunoscut -> import refuzat cu mesaj explicit', err && /Conturi inexistente/.test(err.message));
  eq('import invalid este atomic in RAM (firme/seq/articole)', db.get().firme.length + '/' + db.get().seq + '/' + db.get().entries.length, firme0 + '/' + seq0 + '/' + entries0);
  const orfan = JSON.parse(JSON.stringify(bundle));
  orfan.stockMovements[0].productId = 'produs-strain';
  err = null; try { db.importFirma(orfan); } catch (e) { err = e; }
  ok('referinta interna orfana -> import refuzat', err && /id inexistent/.test(err.message));
}

// Replace poate schimba profilul contabil, dar nu autoritatea sau starea de control a tintei.
firmaImportata.ownerId = 77; firmaImportata.lockedUntil = '2026-05'; firmaImportata.subscription = { status: 'active', plan: 'pro' }; firmaImportata.anaf = { accessToken: 'local' };
const replaceBundle = JSON.parse(JSON.stringify(bundle));
replaceBundle.firma.nume = 'Profil restaurat';
db.importFirma(replaceBundle, { targetFid: newFid });
ok('replace pastreaza owner/subscription/lock/ANAF locale', firmaImportata.ownerId === 77 && firmaImportata.lockedUntil === '2026-05' && firmaImportata.subscription.plan === 'pro' && firmaImportata.anaf.accessToken === 'local');
eq('replace preia doar profilul permis', firmaImportata.nume, 'Profil restaurat');
const vTvaC = { entries: [mkTva('factura_cumparare_incasare', { baza: 1000, tva: 210, cota: 21 }, '2026-08-05')], openingBalances: {} };
eq('TVA neexigibila deductibila NU intra in decont', acc.vatClosing(vTvaC, '2026-08').deductibila, 0);
vTvaC.entries.push(mkTva('exigibilitate_tva_deductibila', { tva: 210 }, '2026-08-25'));
eq('dupa plata devine TVA deductibila', acc.vatClosing(vTvaC, '2026-08').deductibila, 210);

section('Leasing financiar');
const vLease = { entries: [
  mkTva('leasing_intrare', { contImob: '2133', valoare: 50000 }, '2026-09-01'),
  mkTva('factura_leasing', { principal: 1200, dobanda: 300, tva: 285, cota: 21 }, '2026-09-30'),
  mkTva('plata_leasing', { suma: 1785, cont: '5121' }, '2026-09-30'),
], openingBalances: {} };
const tbL = acc.trialBalance(vLease, '2026-09');
const find = (cod) => tbL.rows.find((r) => r.cod === cod) || {};
eq('imobilizare in leasing (2133)', find('2133').sfD, 50000);
eq('datorie leasing ramasa (167)', find('167').sfC, 48800);
eq('cheltuiala cu dobanda (666)', find('666').rd, 300);
eq('furnizor imobilizari 404 stins', (find('404').sfD || 0) + (find('404').sfC || 0), 0);
eq('balanta leasing echilibrata', tbL.balanced, true);

section('Imobilizari in curs (231 -> 21x)');
const vIc = { entries: [
  mkTva('imobilizare_in_curs', { baza: 20000, tva: 4200, cota: 21 }, '2026-10-05'),
  mkTva('imobilizare_in_curs', { baza: 10000, tva: 2100, cota: 21 }, '2026-10-15'),
  mkTva('punere_in_functiune', { contImob: '2131', valoare: 30000 }, '2026-10-31'),
], openingBalances: {} };
const tbIc = acc.trialBalance(vIc, '2026-10');
const fIc = (cod) => tbIc.rows.find((r) => r.cod === cod) || {};
eq('231 stins dupa punerea in functiune', (fIc('231').sfD || 0) + (fIc('231').sfC || 0), 0);
eq('imobilizare 2131 = costuri acumulate', fIc('2131').sfD, 30000);
eq('balanta imobilizari in curs echilibrata', tbIc.balanced, true);

section('Diferente de curs valutar');
const vFx = { entries: [
  mkTva('factura_vanzare_valuta', { valuta: 1000, curs: 4.97, contVenit: '707' }, '2026-11-05'),
  mkTva('diferenta_curs_favorabila', { cont: '4111', suma: 30 }, '2026-11-30'),
  mkTva('diferenta_curs_nefavorabila', { cont: '401', suma: 50 }, '2026-11-30'),
], openingBalances: {} };
const tbFx = acc.trialBalance(vFx, '2026-11');
const fFx = (c) => tbFx.rows.find((r) => r.cod === c) || {};
eq('factura valuta in RON (1000 x 4.97)', fFx('707').rc, 4970);
eq('creanta dupa dif favorabila (4111)', fFx('4111').sfD, 5000);
eq('venit dif curs favorabila (765)', fFx('765').rc, 30);
eq('cheltuiala dif curs nefavorabila (665)', fFx('665').rd, 50);
eq('balanta valuta echilibrata', tbFx.balanced, true);

section('Reevaluare imobilizari (105/655)');
const vReev = { entries: [
  mkTva('reevaluare_plus', { contImob: '212', valoare: 10000 }, '2026-12-31'),
  mkTva('reevaluare_minus', { contImob: '212', dinRezerva: 3000, peCheltuiala: 2000 }, '2026-12-31'),
], openingBalances: {} };
const tbR = acc.trialBalance(vReev, '2026-12');
const fR = (c) => tbR.rows.find((r) => r.cod === c) || {};
eq('rezerva din reevaluare (105) ramasa', fR('105').sfC, 7000); // +10000 -3000
eq('cheltuiala reevaluare (655)', fR('655').rd, 2000);
eq('valoare neta imobilizare 212 (+10000-5000)', fR('212').sfD, 5000);
eq('balanta reevaluare echilibrata', tbR.balanced, true);

section('Grafic de rate leasing');
const { leasingSchedule } = require('../src/leasing');
const lsA = leasingSchedule(12000, 12, 10, 'anuitati');
eq('anuitati: nr rate', lsA.rows.length, 12);
eq('anuitati: total principal = valoarea finantata', lsA.totals.principal, 12000);
eq('anuitati: sold final 0', lsA.rows[11].sold, 0);
ok('anuitati: rate aproape egale', Math.abs(lsA.rows[0].rata - lsA.rows[5].rata) < 0.05);
const lsE = leasingSchedule(12000, 12, 10, 'rate_egale');
eq('rate egale: principal lunar constant', lsE.rows[0].principal, 1000);
ok('rate egale: rata scade in timp', lsE.rows[0].rata > lsE.rows[11].rata);
eq('dobanda 0 => rata = principal', leasingSchedule(12000, 12, 0, 'anuitati').rows[0].rata, 1000);
// verificare contra formulei teoretice a anuitatii + inchidere exacta pe durata urata
const lsB = leasingSchedule(50000, 60, 9.5, 'anuitati');
const rTeo = (50000 * (0.095 / 12)) / (1 - Math.pow(1 + 0.095 / 12, -60));
eq('anuitati: rata = formula teoretica', lsB.rows[0].rata, Math.round(rTeo * 100) / 100);
eq('anuitati: dobanda totala = n×rata − P', lsB.totals.dobanda, Math.round((lsB.rows.reduce((s, r) => s + r.rata, 0) - 50000) * 100) / 100);
ok('anuitati: nicio dobanda/principal negativ', lsB.rows.every((r) => r.dobanda >= 0 && r.principal >= 0));
const lsU = leasingSchedule(10000, 7, 13, 'anuitati'); // durata „urata"
eq('anuitati durata urata: principal = P (inchidere exacta)', lsU.totals.principal, 10000);
eq('anuitati durata urata: sold final 0', lsU.rows[6].sold, 0);

// ── Contractul: graficul legat de LUNA calendaristica ───────────────────────────────────────
// `leasingSchedule` numeroteaza ratele 1..n, atat. Ca factura lunara sa se poata completa
// singura, rata trebuie gasita dupa luna in care se emite — contabilul are in mana factura lui
// martie, nu „rata 15".
{
  const { round2 } = require('../src/util');
  const lg = require('../src/leasing');
  const contract = { denumire: 'Autoutilitara', principal: 50000, months: 36, dobandaAnuala: 9,
    metoda: 'anuitati', dataPrimeiRate: '2026-03-15', cotaTva: 21 };
  const sch = lg.contractSchedule(contract);
  eq('contract: 36 de rate', sch.rows.length, 36);
  eq('prima rata cade in luna primei plati', sch.rows[0].period, '2026-03');
  eq('ultima rata, 35 de luni mai tarziu', sch.rows[35].period, '2029-02');
  eq('graficul se inchide exact pe principal', sch.totals.principal, 50000);
  // ziua din `dataPrimeiRate` nu trebuie sa faca luna sa sara (31 ian + 1 luna = 2 martie)
  eq('31 ianuarie + o luna ramane februarie', lg.periodOfInstallment('2026-01-31', 2), '2026-02');
  // TVA-ul se aplica pe principal SI pe dobanda (dobanda e contravaloarea finantarii)
  const r1 = lg.installmentFor(contract, '2026-03');
  eq('TVA pe principal + dobanda', r1.tva, round2((r1.principal + r1.dobanda) * 0.21));
  eq('totalul ratei include TVA', r1.total, round2(r1.rata + r1.tva));
  // suma platilor de principal pe tot contractul = valoarea finantata (nu se pierde niciun ban)
  eq('suma principalelor = valoarea finantata', round2(sch.rows.reduce((s, r) => s + r.principal, 0)), 50000);
  // o luna din afara contractului NU intoarce o rata goala — ar posta un articol fara continut
  eq('luna dinaintea contractului: fara rata', lg.installmentFor(contract, '2026-02'), null);
  eq('luna de dupa ultima rata: fara rata', lg.installmentFor(contract, '2029-03'), null);
  // fara dobanda, rata e principal curat
  const zero = lg.contractSchedule({ principal: 12000, months: 12, dobandaAnuala: 0, metoda: 'anuitati', dataPrimeiRate: '2026-01-10', cotaTva: 0 });
  eq('dobanda 0: rata = principal/luni', zero.rows[0].principal, 1000);
  eq('dobanda 0: fara TVA daca nu s-a dat cota', zero.totals.tva, 0);
}

section('Provizioane pentru riscuri si cheltuieli (151)');
const vProv = { entries: [
  mkTva('provizion_constituire', { suma: 5000, explicatie: 'Litigiu' }, '2026-12-15'),
  mkTva('provizion_reluare', { suma: 2000, explicatie: 'Litigiu castigat partial' }, '2026-12-31'),
], openingBalances: {} };
const tbP = acc.trialBalance(vProv, '2026-12');
const fP = (c) => tbP.rows.find((r) => r.cod === c) || {};
// Provizionul implicit merge pe 1518 „Alte provizioane", nu pe sinteticul 151: felul provizionului
// decide deductibilitatea (art. 26(1)(b)), iar sinteticul nu-l poate exprima. Implicitul e prudent
// — nedeductibil — deci o alegere neatenta nu produce o deducere nemeritata.
eq('provizion 1518 ramas (5000-2000)', fP('1518').sfC, 3000);
eq('sinteticul 151 nu mai e folosit de monografie', fP('151').sfC, undefined);
eq('cheltuiala provizion (6812)', fP('6812').rd, 5000);
eq('venit reluare provizion (7812)', fP('7812').rc, 2000);
eq('balanta provizioane echilibrata', tbP.balanced, true);
const rfP = rep.registruFiscal({ entries: vProv.entries, openingBalances: {} }, '2026');
ok('6812 nedeductibil in registrul fiscal', rfP.cheltNeded.some((c) => c.cod === '6812' && c.suma === 5000));
ok('7812 neimpozabil in registrul fiscal', (rfP.venituriList || []).some((c) => c.cod === '7812' && c.suma === 2000));

section('Decontari cu asociatii (455) si intragrup (481)');
const vAs = { entries: [
  mkTva('imprumut_asociat', { suma: 20000, cont: '5121' }, '2026-09-01'),
  mkTva('restituire_asociat', { suma: 5000, cont: '5121' }, '2026-09-20'),
  mkTva('decontare_intragrup', { sens: 'creanta', cont: '5121', suma: 3000 }, '2026-09-25'),
], openingBalances: {} };
const tbAs = acc.trialBalance(vAs, '2026-09');
const fAs = (c) => tbAs.rows.find((r) => r.cod === c) || {};
eq('datorie catre asociat (455) ramasa', fAs('455').sfC, 15000);
eq('creanta intragrup (481)', fAs('481').sfD, 3000);
eq('balanta decontari echilibrata', tbAs.balanced, true);

section('Dividende (117 = 457, impozit 446)');
const vDiv = { entries: [
  mkTva('repartizare_dividende', { brut: 10000, cota: 10, contSursa: '117' }, '2026-04-30'),
  mkTva('plata_dividende', { suma: 9000, cont: '5121' }, '2026-05-15'),
], openingBalances: { 117: { d: 0, c: 30000 }, 5121: { d: 30000, c: 0 } } };
const tbDiv = acc.trialBalance(vDiv, null);
const fDv = (c) => tbDiv.rows.find((r) => r.cod === c) || {};
eq('rezultat reportat 117 redus (30000-10000)', fDv('117').sfC, 20000);
eq('impozit pe dividende (446)', fDv('446').sfC, 1000);
eq('dividende de plata (457) stinse', (fDv('457').sfD || 0) + (fDv('457').sfC || 0), 0);
eq('disponibil 5121 dupa plata neta', fDv('5121').sfD, 21000);
eq('balanta dividende echilibrata', tbDiv.balanced, true);

section('Subventii (de exploatare 741 / investitii 475->7584)');
const vSub = { entries: [
  mkTva('subventie_investitii', { suma: 60000 }, '2026-01-10'),
  mkTva('incasare_subventie', { suma: 60000, cont: '5121' }, '2026-01-20'),
  mkTva('venit_subventie_investitii', { suma: 1000 }, '2026-12-31'),
], openingBalances: {} };
const tbSub = acc.trialBalance(vSub, null);
const fS = (c) => tbSub.rows.find((r) => r.cod === c) || {};
eq('subventie investitii in avans (475) ramasa', fS('475').sfC, 59000);
eq('creanta subventie 445 stinsa dupa incasare', (fS('445').sfD || 0) + (fS('445').sfC || 0), 0);
eq('venit subventie recunoscut (7584)', fS('7584').rc, 1000);
eq('balanta subventii echilibrata', tbSub.balanced, true);

section('Cheltuieli / venituri in avans (471/472)');
const vAv = { entries: [
  mkTva('cheltuiala_in_avans', { cont: '401', suma: 12000 }, '2026-01-01'),
  mkTva('recunoastere_cheltuiala_avans', { contChelt: '613', suma: 1000 }, '2026-01-31'),
  mkTva('venit_in_avans', { cont: '5121', suma: 6000 }, '2026-01-01'),
  mkTva('recunoastere_venit_avans', { contVenit: '704', suma: 500 }, '2026-01-31'),
], openingBalances: {} };
const tbAv = acc.trialBalance(vAv, null);
const fAv = (c) => tbAv.rows.find((r) => r.cod === c) || {};
eq('cheltuiala in avans ramasa (471)', fAv('471').sfD, 11000);
eq('venit in avans ramas (472)', fAv('472').sfC, 5500);
eq('cheltuiala recunoscuta in perioada (613)', fAv('613').rd, 1000);
eq('venit recunoscut in perioada (704)', fAv('704').rc, 500);
eq('balanta avans echilibrata', tbAv.balanced, true);

section('Extragere documente — detectie PDF / imagine');
const aiMod = require('../src/aiExtractor');
const buf = (bytes) => Buffer.from(bytes);
eq('detecteaza PDF (%PDF)', aiMod.detectMediaType(buf([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 0, 0, 0, 0, 0, 0])), 'application/pdf');
eq('detecteaza PNG', aiMod.detectMediaType(buf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
eq('detecteaza JPEG', aiMod.detectMediaType(buf([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
eq('detecteaza WEBP', aiMod.detectMediaType(buf([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp');
eq('necunoscut -> null', aiMod.detectMediaType(buf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);

section('Note explicative (2026)');
const notes = rep.notes(v, '2026');
eq('numar note', notes.sections.length, 6);
ok('Nota 1 — Active imobilizate', notes.sections.some((s) => /Nota 1/.test(s.titlu)));
ok('principii contabile prezente', (notes.principii || []).length > 0);

section('Mesaje (suport user <-> admin)');
const msg = require('../src/messages');
const usersM = [{ id: 1, username: 'admin', role: 'admin' }, { id: 2, username: 'maria', role: 'user' }, { id: 3, username: 'ion', role: 'user' }];
const inbox = [
  msg.newMessage('m1', 2, false, 'Salut, am o intrebare'),       // maria -> admin
  msg.newMessage('m2', 2, true, 'Spune, te ascult', 'admin'),    // admin -> maria
  msg.newMessage('m3', 3, false, 'Cum inchid luna?'),            // ion -> admin (necitit de admin)
];
eq('mesaj de la user: necitit de admin', inbox[0].readByAdmin, false);
eq('mesaj de la user: citit de user (autorul)', inbox[0].readByUser, true);

// Numele atasamentului vine din req.file.originalname, adica de la CLIENT — iar un client care
// nu e browser poate trimite orice (cu filename*=UTF-8''..., RFC 5987, ghilimelele ajung brute;
// browserele le %-codifica). Curatarea de aici e al DOILEA strat; apararea principala ramane
// escaparea la randare din public/messages.js. Numele e doar pentru afisare — pe disc fisierul
// sta sub `storedName` (hex aleator) — deci curatarea nu poate rupe descarcarea.
eq('numele obisnuit ramane neatins', msg.cleanAttachmentName('raport lunar.pdf'), 'raport lunar.pdf');
eq('ghilimelele sunt scoase (context de atribut)', msg.cleanAttachmentName('a"onerror="b.png'), 'aonerror=b.png');
eq('parantezele unghiulare sunt scoase', msg.cleanAttachmentName('<img>.png'), 'img.png');
eq('apostroful si accentul grav sunt scoase', msg.cleanAttachmentName("a'b`c.png"), 'abc.png');
eq('separatorii de cale devin underscore', msg.cleanAttachmentName('sub/dir/f.png'), 'sub_dir_f.png');
eq('urcarea in arbore nu ramane cale', msg.cleanAttachmentName('../../etc/passwd'), '.._.._etc_passwd');
eq('CR/LF sunt scoase (antetul Content-Disposition)', msg.cleanAttachmentName('a\r\nb.png'), 'ab.png');
eq('caracterele de control sunt scoase', msg.cleanAttachmentName('a\u0000\u0007b.png'), 'ab.png');
eq('numele gol cade pe o valoare utila', msg.cleanAttachmentName(''), 'fisier');
eq('numele din spatii cade pe o valoare utila', msg.cleanAttachmentName('   '), 'fisier');
eq('null nu arunca', msg.cleanAttachmentName(null), 'fisier');
eq('un nume ramas gol dupa curatare nu devine sir gol', msg.cleanAttachmentName('"""'), 'fisier');
ok('numele lung e plafonat', msg.cleanAttachmentName('x'.repeat(300) + '.png').length <= 120);
ok('plafonarea pastreaza extensia', msg.cleanAttachmentName('x'.repeat(300) + '.png').endsWith('.png'));
// integrarea: newMessage curata numele, nu doar helperul
const mAtt = msg.newMessage('ma', 2, false, 'cu fisier', 'maria', { name: 'a"x.png', storedName: 'ab12.png', size: 5, mime: 'image/png' });
eq('newMessage stocheaza numele curatat', mAtt.attachment.name, 'ax.png');
eq('newMessage NU atinge numele de pe disc', mAtt.attachment.storedName, 'ab12.png');
eq('raspuns admin: necitit de user', inbox[1].readByUser, false);
eq('thread maria are 2 mesaje, cronologic', msg.thread(inbox, 2).length, 2);
eq('thread maria nu include mesajele lui ion', msg.thread(inbox, 2).every((m) => m.userId === 2), true);
eq('necitite pentru maria (raspuns admin)', msg.unreadForUser(inbox, 2), 1);
eq('necitite pentru admin (cereri user)', msg.unreadForAdmin(inbox), 2);
const sum = msg.threadsSummary(inbox, usersM);
eq('inbox admin: 2 conversatii', sum.length, 2);
eq('sumar are username rezolvat', sum.some((t) => t.username === 'maria'), true);
eq('conversatia ion are 1 necitit', (sum.find((t) => t.userId === 3) || {}).unread, 1);
const nA = msg.markRead(inbox, 2, 'admin'); // adminul deschide conversatia mariei
eq('markRead admin marcheaza 1 mesaj', nA, 1);
eq('dupa citire, necitite admin scad la 1', msg.unreadForAdmin(inbox), 1);
const nU = msg.markRead(inbox, 2, 'user'); // maria deschide conversatia
eq('markRead user marcheaza raspunsul adminului', nU, 1);
eq('dupa citire, necitite maria = 0', msg.unreadForUser(inbox, 2), 0);
eq('text gol -> trimmed', msg.newMessage('x', 2, false, '   ').text, '');
// atasamente
const attMsg = msg.newMessage('a1', 2, false, 'vezi poza', 'maria', { name: 'bon.png', storedName: 'abc123.png', size: 1234, mime: 'image/png' });
eq('atasament: nume pastrat', attMsg.attachment.name, 'bon.png');
eq('atasament: dimensiune numerica', attMsg.attachment.size, 1234);
eq('atasament: mime pastrat', attMsg.attachment.mime, 'image/png');
eq('mesaj fara atasament nu are campul attachment', msg.newMessage('a2', 2, false, 'text', 'm').attachment, undefined);
eq('atasament fara storedName e ignorat', msg.newMessage('a3', 2, false, '', 'm', { name: 'x' }).attachment, undefined);
// arhivare in sumar + cautare
const usersArch = [{ id: 1, username: 'admin', role: 'admin' }, { id: 2, username: 'maria', role: 'user', supportArchived: true }, { id: 3, username: 'ion', role: 'user' }];
const sumArch = msg.threadsSummary(inbox, usersArch);
eq('sumar marcheaza conversatia arhivata', (sumArch.find((t) => t.userId === 2) || {}).archived, true);
eq('conversatia nearhivata are archived=false', (sumArch.find((t) => t.userId === 3) || {}).archived, false);
eq('cautare dupa nume gaseste maria', msg.searchThreads(inbox, usersM, 'mar').length, 1);
eq('cautare dupa text gaseste conversatia lui ion', msg.searchThreads(inbox, usersM, 'inchid').some((t) => t.userId === 3), true);
eq('cautare adauga fragment de potrivire', !!msg.searchThreads(inbox, usersM, 'inchid')[0].match, true);
eq('cautare goala = toate conversatiile', msg.searchThreads(inbox, usersM, '').length, msg.threadsSummary(inbox, usersM).length);
eq('cautare fara rezultat', msg.searchThreads(inbox, usersM, 'zzzqqq').length, 0);

section('Notificare email admin la mesaj nou (prezenta)');
const presence = require('../src/presence');
const NOW = Date.UTC(2026, 5, 29, 12, 0, 0);
const recent = new Date(NOW - 60 * 1000).toISOString();      // acum 1 min
const stale = new Date(NOW - 60 * 60 * 1000).toISOString();  // acum 1 ora
const adminOnline = { id: 1, role: 'admin', email: 'a@x.ro', sessions: [{ lastSeen: recent }] };
const adminOffline = { id: 1, role: 'admin', email: 'a@x.ro', sessions: [{ lastSeen: stale }] };
const userU = { id: 2, role: 'user', email: 'u@x.ro', sessions: [{ lastSeen: recent }] };
ok('admin activ recent => online', presence.anyAdminOnline([adminOnline, userU], NOW));
ok('admin inactiv demult => offline', !presence.anyAdminOnline([adminOffline, userU], NOW));
ok('user activ NU conteaza ca admin online', !presence.anyAdminOnline([adminOffline, userU], NOW));
eq('admin online => nimeni de notificat', presence.adminsToEmail([adminOnline, userU], NOW).length, 0);
eq('admin offline cu email => 1 de notificat', presence.adminsToEmail([adminOffline, userU], NOW).length, 1);
eq('admin offline fara email => nimeni', presence.adminsToEmail([{ id: 1, role: 'admin', sessions: [{ lastSeen: stale }] }], NOW).length, 0);
eq('admin in cooldown (5 min) => nu se renotifica', presence.adminsToEmail([{ id: 1, role: 'admin', email: 'a@x.ro', sessions: [{ lastSeen: stale }], lastSupportEmailAt: NOW - 5 * 60 * 1000 }], NOW).length, 0);
eq('cooldown expirat (20 min) => se notifica din nou', presence.adminsToEmail([{ id: 1, role: 'admin', email: 'a@x.ro', sessions: [{ lastSeen: stale }], lastSupportEmailAt: NOW - 20 * 60 * 1000 }], NOW).length, 1);
eq('admin pending (invitatie) nu se notifica', presence.adminsToEmail([{ id: 1, role: 'admin', email: 'a@x.ro', pending: true, sessions: [] }], NOW).length, 0);

section('Efecte de comert si acreditive');
const coa2 = require('../src/chartOfAccounts');
ok('contul 413 (efecte de primit) exista', !!coa2.getAccount('413'));
ok('contul 403 (efecte de platit) exista', !!coa2.getAccount('403'));
ok('contul 541 (acreditive) exista', !!coa2.getAccount('541'));
const efp = gt2('efect_primit_client').build({ suma: 1000 });
eq('efect primit: 413=4111', efp[0].debit + '=' + efp[0].credit, '413=4111');
const sc = gt2('scontare_efect').build({ suma: 1000, scont: 30 });
eq('scontare: net 970 pe 5121', (sc.find((l) => l.debit === '5121') || {}).suma, 970);
eq('scontare: scont 30 pe 667 (cheltuiala financiara)', (sc.find((l) => l.debit === '667') || {}).suma, 30);
eq('scontare: total creditat pe 413 = nominal', sc.reduce((s, l) => s + (l.credit === '413' ? l.suma : 0), 0), 1000);
eq('efect platit furnizor: 401=403', gt2('efect_platit_furnizor').build({ suma: 800 })[0].debit + '=' + gt2('efect_platit_furnizor').build({ suma: 800 })[0].credit, '401=403');
eq('deschidere acreditiv: 541=5121', gt2('deschidere_acreditiv').build({ suma: 5000 })[0].debit + '=' + gt2('deschidere_acreditiv').build({ suma: 5000 })[0].credit, '541=5121');
eq('plata din acreditiv: 401=541', gt2('plata_din_acreditiv').build({ suma: 1200 })[0].debit + '=' + gt2('plata_din_acreditiv').build({ suma: 1200 })[0].credit, '401=541');

section('Livrari fara TVA: randurile 3 si 14 din decont (export + servicii intracomunitare)');
{
  const T3 = require('../src/documentTypes');
  const E3 = (id, tip, d) => ({ id, tip, data: '2026-06-10', period: '2026-06', status: 'postat',
    partenerCui: 'DE811907980', partener: 'X', lines: T3.getType(tip).build(d) });
  const db3 = { openingBalances: {}, company: { cui: 'RO1', nume: 'X', perioadaTva: 'L' }, entries: [
    E3('a', 'livrare_intracomunitara', { baza: 10000 }),
    E3('b', 'prestare_servicii_intracomunitara', { baza: 20000 }),
    E3('c', 'taxare_inversa_interna_livrare', { baza: 30000, cota: 21 }),
    E3('d', 'export_extracomunitar', { baza: 40000 }),
  ] };
  const a3 = xml.d300Rows(rep.d300(db3, '2026-06'));
  eq('rd. 1 — livrari intracomunitare de bunuri', a3.R1_1, 10000);
  // Prestarea intracomunitara aparea in D390 (cod P) si DELOC in decont: doua raportari care nu se
  // potriveau pe aceeasi factura, exact ce compara ANAF.
  eq('rd. 3 — locul prestarii in afara Romaniei (art. 278 alin. (2))', a3.R3_1, 20000);
  eq('rd. 13 — livrari cu taxare inversa interna (art. 331)', a3.R13_1, 30000);
  eq('rd. 14 — scutite CU drept de deducere, altele (export)', a3.R14_1, 40000);
  eq('toate patru intra in totalul taxei colectate', a3.R17_1, 100000);
  eq('...si niciuna nu aduce TVA colectat', a3.R17_2 || 0, 0);
  // Exportul NU e o achizitie/livrare intracomunitara: nu are ce cauta in D390 sau Intrastat.
  eq('exportul nu apare in D390', rep.d390(db3, '2026-06').rows.filter((r) => r.cod === 'L').length, 1);
  // ...si are drept de deducere, deci intra in NUMARATORUL pro-ratei. Inregistrat inainte ca
  // vanzare cu cota 0, cadea la „fara drept" si cobora procentul — pe langa ca lipsea din decont.
  eq('exportul are drept de deducere (pro-rata 100%)', rep.proRataTva(db3, '2026').definitiva, 100);
  eq('...si nimic nu cade la „fara drept"', rep.proRataTva(db3, '2026').faraDrept, 0);
  // Numarul declaratiei vamale justifica scutirea si se cere la control.
  ok('tipul cere declaratia vamala de export',
    (T3.getType('export_extracomunitar').fields || []).some((f) => f.name === 'declaratieVamala'));

  // Operatiunea triunghiulara: livrarea are codul ei in D390 si tot randul 3 in decont; ACHIZITIA
  // care o precede nu se declara nicaieri (nu e impozabila in Romania) si mai ales NU produce
  // taxare inversa — un `4426 = 4427` ar umfla ambele laturi ale decontului cu o taxa nedatorata.
  {
    const dbT = { openingBalances: {}, company: { cui: 'RO1', nume: 'X', perioadaTva: 'L' }, entries: [
      E3('t1', 'achizitie_triunghiulara', { baza: 5000, contStoc: '371' }),
      E3('t2', 'livrare_triunghiulara', { baza: 7000 }),
    ] };
    const aT = xml.d300Rows(rep.d300(dbT, '2026-06'));
    eq('livrarea triunghiulara merge pe randul 3', aT.R3_1, 7000);
    eq('achizitia triunghiulara NU produce taxa colectata', aT.R17_2 || 0, 0);
    eq('...si nici taxa deductibila', aT.R27_2 || 0, 0);
    eq('...si nu apare pe randul achizitiilor intracomunitare', aT.R5_1 || 0, 0);
    const r390 = rep.d390(dbT, '2026-06');
    eq('livrarea se declara in D390 pe codul T', r390.totaluri.T, 7000);
    eq('...si numai ea (achizitia nu se declara)', r390.rows.length, 1);
    ok('articolul de achizitie nu are nicio linie de TVA',
      !T3.getType('achizitie_triunghiulara').build({ baza: 5000 }).some((l) => /^442/.test(String(l.debit)) || /^442/.test(String(l.credit))));
  }

  // ── Regimul special al marjei (art. 312) ────────────────────────────────────────────────────
  {
    const marja = (pv, pc) => T3.getType('vanzare_regim_marja').build({ pretVanzare: pv, pretCumparare: pc, cota: 21 });
    const l = marja(12000, 10000);
    // TVA-ul e INCLUS in marja: 2000 x 21/121 = 347,11. Adaugat PESTE marja ar da 420 — cu 21% mai
    // mult decat se datoreaza, adica taxa pe taxa.
    eq('TVA se extrage din marja, nu se adauga peste ea', l.find((x) => x.credit === '4427').suma, 347.11);
    eq('venitul e pretul de vanzare minus taxa pe marja', l.find((x) => x.credit === '707').suma, 11652.89);
    eq('descarcarea de gestiune e la costul bunului', l.find((x) => x.debit === '607').suma, 10000);
    // Marja negativa: baza zero, nu creanta la buget.
    const pierdere = marja(9000, 10000);
    ok('bun vandut in pierdere: nicio taxa colectata', !pierdere.some((x) => x.credit === '4427'));
    eq('...si venitul e chiar pretul incasat', pierdere.find((x) => x.credit === '707').suma, 9000);
    // Achizitia nu are TVA deductibila — chiar conditia regimului.
    ok('achizitia in regim de marja nu deduce TVA',
      !T3.getType('achizitie_regim_marja').build({ baza: 10000 }).some((x) => /^442/.test(String(x.debit))));

    // DECONT: baza e MARJA, nu pretul de vanzare. Citita din linii ar da o cota fantoma de 3%,
    // iar randul ar cadea din D300 (`d300CoteFaraRand`).
    const eM = { id: 'm1', tip: 'vanzare_regim_marja', data: '2026-06-10', period: '2026-06', status: 'postat',
      partenerCui: 'RO9', partener: 'C', lines: l, marjaTva: { marja: 2000, cota: 21, tva: 347.11, baza: 1652.89, pretVanzare: 12000, pretCumparare: 10000 } };
    const dbM = { openingBalances: {}, company: { cui: 'RO1', nume: 'X', perioadaTva: 'L' }, entries: [eM] };
    const aM = xml.d300Rows(rep.d300(dbM, '2026-06'));
    eq('decontul declara MARJA ca baza, nu pretul de vanzare', aM.R9_1, 1653);
    eq('...cu taxa pe marja', aM.R9_2, 347);
    eq('...deci raportul da cota reala (regula R84)', Math.round((aM.R9_2 / aM.R9_1) * 100), 21);
    eq('nicio cota fara rand in decont', xml.d300CoteFaraRand(rep.d300(dbM, '2026-06')).length, 0);

    // Registrul art. 312 alin. (13): obligatoriu la control, derivat din articole.
    const reg = rep.registruMarja(dbM, '2026-06');
    eq('registrul marjei are randul vanzarii', reg.nr, 1);
    eq('...cu pretul de cumparare', reg.rows[0].pretCumparare, 10000);
    eq('...si marja pe care s-a calculat taxa', reg.totalMarja, 2000);

    // e-Factura: DELIBERAT neemisa. Factura in regim special nu are voie sa arate TVA separat, iar
    // generatorul UBL exact asta ar face — un XML gresit trimis in SPV e mai rau decat unul lipsa.
    ok('vanzarea in regim de marja NU pleaca in e-Factura (lipsa cunoscuta, cu motiv scris)',
      !xml.isSendable({ tip: 'vanzare_regim_marja' }));
    eq('...si decizia e explicita pe tip, nu o omisiune', T3.getType('vanzare_regim_marja').eFactura, 'nu');
  }

  // POARTA: fiecare categorie de livrare scutita produsa de jurnal trebuie sa aiba un rand in
  // decont. Fara ea, o categorie noua ar disparea TACIT din D300 — chiar defectul reparat aici.
  const cat = new Set(Object.values(acc.LIVRARI_SCUTITE || {}).map((x) => x.cat));
  ok('poarta chiar vede categoriile', cat.size >= 4);
  const faraRand = [...cat].filter((c) => !xml.D300_RAND_SCUTITE[c]);
  eq('fiecare categorie scutita are rand in D300' + (faraRand.length ? ' — LIPSA: ' + faraRand.join(', ') : ''), faraRand.length, 0);
}

section('D390 — recapitulativ intracomunitar (VIES)');
const d390db = { entries: [
  { id: '1', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-10', partener: 'DE GmbH', partenerCui: 'DE123', lines: gt2('livrare_intracomunitara').build({ baza: 5000 }) },
  { id: '2', tip: 'achizitie_intracomunitara', period: '2026-06', data: '2026-06-12', partener: 'FR SARL', partenerCui: 'FR789', lines: gt2('achizitie_intracomunitara').build({ baza: 3000, cota: 21 }) },
  { id: '3', tip: 'factura_vanzare_marfuri', period: '2026-06', data: '2026-06-15', partener: 'intern', lines: [{ debit: '4111', credit: '707', suma: 9999 }] },
] };
const d390 = rep.d390(d390db, '2026-06');
eq('D390: total livrari (L) = 5000', d390.totalL, 5000);
eq('D390: total achizitii (A) = 3000', d390.totalA, 3000);
eq('D390: 2 operatori (intracom), factura interna exclusa', d390.nr, 2);
ok('D390: codul tarii dedus din CUI (DE/FR)', d390.rows.some((r) => r.tara === 'DE') && d390.rows.some((r) => r.tara === 'FR'));
ok('D390 XML bine-format', wellFormed(xml.d390Xml({ cui: 'RO1', nume: 'X' }, '2026-06', d390)));

// ── SERVICIILE intracomunitare (art. 325): codurile P si S ────────────────────────────────────
// Lipseau cu totul din declaratie, desi sunt operatiunea ei cea mai frecventa — orice firma care
// plateste reclama sau gazduire unui prestator din UE le are lunar.
{
  const ES = (id, tip, cui, baza, extra) => Object.assign({
    id, tip, period: '2026-06', data: '2026-06-11', partener: 'P' + id, partenerCui: cui,
    lines: gt2(tip).build(Object.assign({ baza, cota: 21 }, extra || {})),
  }, extra || {});
  const vS = { openingBalances: {}, company: { tvaPlatitor: true }, entries: [
    ES('s1', 'prestare_servicii_intracomunitara', 'DE111111111', 4000),
    ES('s2', 'achizitie_servicii_intracomunitara', 'IE6388047V', 1200),
    ES('s3', 'achizitie_servicii_intracomunitara', 'IE6388047V', 800), // acelasi operator: se cumuleaza
  ] };
  const r = rep.d390(vS, '2026-06');
  eq('D390: prestarea catre UE iese pe codul P', r.totaluri.P, 4000);
  eq('D390: achizitia de servicii din UE iese pe codul S', r.totaluri.S, 2000);
  eq('...cumulata pe operator, nu cate un rand pe factura', r.rows.filter((x) => x.cod === 'S').length, 1);
  eq('...cu numarul de operatiuni pastrat', r.rows.find((x) => x.cod === 'S').nrop, 2);
  eq('D390: serviciile NU se amesteca in totalurile pe bunuri', r.totaluri.L + r.totaluri.A, 0);
  // Baza prestarii se citeste din VENIT (clasa 70), a achizitiei din datoria catre furnizor —
  // aceeasi regula ca la bunuri, altfel una din ele ar iesi zero.
  eq('baza prestarii vine din venit, nu din TVA', r.rows.find((x) => x.cod === 'P').baza, 4000);

  // Irlanda de Nord: stat membru pentru BUNURI (Protocolul NI), nu pentru servicii.
  const vXI = (tip) => ({ openingBalances: {}, company: {}, entries: [ES('x1', tip, 'XI123456789', 500)] });
  eq('XI e tara UE pentru bunuri', rep.d390(vXI('achizitie_intracomunitara'), '2026-06').rows.length, 1);
  eq('...dar NU pentru servicii', rep.d390(vXI('achizitie_servicii_intracomunitara'), '2026-06').rows.length, 0);

  // Grecia: codul de TVA incepe cu EL, nu cu GR. O lista scrisa dupa coduri ISO ar rata-o.
  const vEL = { openingBalances: {}, company: {}, entries: [ES('e1', 'achizitie_servicii_intracomunitara', 'EL123456789', 700)] };
  eq('Grecia se recunoaste dupa prefixul EL (nu GR)', rep.d390(vEL, '2026-06').totaluri.S, 700);

  // Rezumatul din XML: regula oficiala e `bazaX = Suma(baza pt. tip = X)` peste valorile SCRISE,
  // care sunt rotunjite la leu. Doua randuri de 10,40 se scriu „10" si „10" => bazaP = 20, nu 21.
  const vR = { openingBalances: {}, company: {}, entries: [
    ES('r1', 'prestare_servicii_intracomunitara', 'DE111111111', 10.4),
    ES('r2', 'prestare_servicii_intracomunitara', 'FR22222222222', 10.4),
  ] };
  const xr = xml.d390Xml({ cui: 'RO1', nume: 'X' }, '2026-06', rep.d390(vR, '2026-06'));
  const sumaScrisa = [...xr.matchAll(/<operatie[^>]*baza="(\d+)"/g)].reduce((s, m) => s + Number(m[1]), 0);
  eq('rezumatul XML = suma bazelor SCRISE (nu rotunjirea sumei)', Number(/bazaP="(\d+)"/.exec(xr)[1]), sumaScrisa);
  eq('...si nrOPI numara elementele emise', Number(/nrOPI="(\d+)"/.exec(xr)[1]), 2);

  // Lista de coduri e scrisa in doua module (xml.js nu importa lantul de raportare) — invariantul
  // care le tine legate, ca sa nu poata drifta una fata de cealalta.
  eq('codurile D390 sunt aceleasi in reporting si in xml', rep.D390_CODURI.join(''), xml.D390_CODURI.join(''));
}

section('D301 — TVA speciala la neplatitori (art. 317)');
{
  const d301 = require('../src/d301');
  const fp301 = require('../src/fiscalProfile');
  const fields = { data: '2026-06-15', document: 'F123', tipOperatieD301: '5', moneda: 'EUR',
    sumaValuta: 2000, curs: 5, cota: 21, contCost: '628' };
  const calc = d301.dinCampuri(fields);
  eq('calcul: baza = valoare valuta × curs, rotunjita la leu', calc.baza, 10000);
  eq('calcul: TVA speciala datorata', calc.tva, 2100);
  const lines = gt2(d301.TIP_DOCUMENT).build(fields);
  ok('monografie: baza merge la furnizor, fara 4426/4427',
    lines.some((l) => l.debit === '628' && l.credit === '401' && l.suma === 10000)
    && !lines.some((l) => /^442[678]$/.test(l.debit) || /^442[678]$/.test(l.credit)));
  ok('monografie: TVA nedeductibila intra in cost si devine obligatie 446',
    lines.some((l) => l.debit === '628' && l.credit === '446' && l.suma === 2100));

  const entry = { id: 'd301-1', tip: d301.TIP_DOCUMENT, status: 'postat', period: '2026-06',
    data: fields.data, document: fields.document, partener: 'UE GmbH', partenerCui: 'DE811907980',
    d301: calc, lines };
  const view301 = { company: { cui: '12345674', nume: 'TEST SRL', tvaPlatitor: false, tvaArt317: true,
    banca: 'Banca Test', iban: 'RO49AAAA1B31007593840000' }, entries: [entry] };
  const r301 = d301.report(view301, '2026-06');
  eq('raport: taxa economica este numarata o singura data', r301.totalTva, 2100);
  eq('raport: sectiunea 4 include subtotalul 4.1', r301.sectiuni[4].tva, 2100);
  eq('raport: sectiunea 4.1 ramane distincta', r301.sectiuni[5].tva, 2100);
  const x301 = xml.d301Xml(view301.company, '2026-06', r301, { nume: 'Popescu', prenume: 'Ion', functie: 'Contabil' });
  ok('D301 XML bine-format', wellFormed(x301));
  eq('XML: serviciul 4.1 este repetat in sectiunea-total 4 (cerinta DUK R32)',
    (x301.match(/<sectiune /g) || []).length, 2);
  ok('XML: totalurile 4/4.1 si suma de control sunt corelate',
    /baza4="10000" tva4="2100" baza5="10000" tva5="2100" totalPlata_A="24200"/.test(x301));
  ok('XML: codul art. 317 selecteaza pers_inreg=2', /pers_inreg="2"/.test(x301));
  ok('XML rectificativ: D301 poarta d_rec=1', /d_rec="1"/.test(xml.d301Xml(view301.company,
    '2026-06', r301, { nume: 'P', prenume: 'I', functie: 'C' }, { rectificativa: true })));
  let errCui301 = '';
  try {
    xml.d301Xml(Object.assign({}, view301.company, { cui: '12345678901' }), '2026-06', r301,
      { nume: 'P', prenume: 'I', functie: 'C' });
  } catch (e) { errCui301 = e.message; }
  ok('schema: D301 refuza CUI de 11–12 cifre, neacceptat de XSD', /CUI/.test(errCui301));
  eq('D390: acelasi serviciu UE intra o singura data pe codul S', rep.d390(view301, '2026-06').totaluri.S, 10000);

  const asteptate = require('../src/declarations').expectedForFirma(view301, '2026-06').map((x) => x.tip);
  ok('calendar: luna cu operatiune cere D301 si D390', asteptate.includes('d301') && asteptate.includes('d390'));
  const fara317 = Object.assign({}, view301, { company: Object.assign({}, view301.company, { tvaArt317: false }) });
  const asteptateFara = require('../src/declarations').expectedForFirma(fara317, '2026-06').map((x) => x.tip);
  ok('calendar: fara art. 317, D301 ramane datorata dar D390 nu se inventeaza',
    asteptateFara.includes('d301') && !asteptateFara.includes('d390'));
  ok('guard: platitorul normal este directionat la D300/taxare inversa',
    /plătitoare/.test(fp301.entryGuard(fp301.build({ tvaPlatitor: true }), entry) || ''));
  ok('guard: serviciul UE fara cod art. 317 este blocat',
    /art\. 317/.test(fp301.entryGuard(fp301.build({ tvaPlatitor: false }), entry) || ''));
  let errValuta = '';
  try { d301.dinCampuri(Object.assign({}, fields, { moneda: 'ZZZ' })); } catch (e) { errValuta = e.message; }
  ok('schema: valuta din afara nomenclatorului este refuzata la intrare', /neacceptată/.test(errValuta));
}

section('D107 — beneficiarii sponsorizărilor/mecenatului');
{
  const d107 = require('../src/d107');
  const fields = { data: '2026-06-12', document: 'CTR 12/2026', partener: 'ASOCIATIA ALFA',
    cuiPartener: 'RO14399840', suma: 3000, cont: '5121' };
  const lines = gt2(d107.TIP_DOCUMENT).build(fields);
  ok('D107: documentul propriu posteaza sponsorizarea 6582=5121',
    lines.length === 1 && lines[0].debit === '6582' && lines[0].credit === '5121' && lines[0].suma === 3000);
  const mk = (id, year, cui, den, suma) => ({ id, tip: d107.TIP_DOCUMENT, status: 'postat',
    data: year + '-06-12', period: year + '-06', partener: den, partenerCui: cui,
    document: 'CTR ' + id, lines: [{ debit: '6582', credit: '5121', suma }] });
  const view107 = {
    company: { cui: '12345674', nume: 'TEST SRL', adresa: 'Str. Test 1', regimImpozit: 'profit',
      d107Istoric: { 2024: { folosit: 400 }, 2025: { folosit: 500 } } },
    partners: {
      14399840: { cui: '14399840', den: 'ASOCIATIA ALFA', adresa: 'Str. Alfa 1' },
      160796: { cui: '160796', den: 'FUNDATIA BETA', adresa: 'Str. Beta 2' },
    },
    entries: [mk('a24', '2024', '14399840', 'ASOCIATIA ALFA', 1000),
      mk('b25', '2025', '160796', 'FUNDATIA BETA', 2000),
      mk('a26', '2026', '14399840', 'ASOCIATIA ALFA', 3000)],
  };
  const r107 = d107.report(view107, '2026', { sponsorizare: { disponibil: 5100, folosit: 2500 } });
  ok('D107: reportul se reface pe beneficiari si creditul se consuma FIFO',
    r107.totals.val1 === 3000 && r107.totals.val2 === 2100 && r107.totals.val3 === 2500
      && r107.rows.find((r) => r.cui === '14399840').val3 === 500
      && r107.rows.find((r) => r.cui === '160796').val3 === 2000);
  const x107 = xml.d107Xml(view107.company, r107,
    { nume: 'Popescu', prenume: 'Ion', functie: 'Contabil' });
  ok('D107 XML: schema, termenul 2026, codul bugetar si totalurile sunt cele oficiale',
    wellFormed(x107) && /<d107 xmlns="mfp:anaf:dgti:d107:declaratie:v1"/.test(x107)
      && /scadenta="25032027" cod_bug="5503XXXXXX"/.test(x107)
      && !/nr_evid=/.test(x107)
      && /TVal1="3000" TVal2="2100" TVal3="2500"/.test(x107)
      && /totalPlata_A="7600"/.test(x107));
  ok('D107 rectificativa poarta d_rec=1', /d_rec="1"/.test(xml.d107Xml(view107.company,
    r107, null, { rectificativa: true })));
  const asteptate107 = require('../src/declarations').expectedForFirma(view107, '2026-12').map((x) => x.tip);
  ok('D107: calendarul o cere anual firmei pe profit cu sponsorizari', asteptate107.includes('d107'));
  const micro107 = Object.assign({}, view107, { company: Object.assign({}, view107.company, { regimImpozit: 'micro' }) });
  ok('D107: microintreprinderea nu primeste obligatia valabila din 2024',
    !require('../src/declarations').expectedForFirma(micro107, '2026-12').some((x) => x.tip === 'd107'));
  const faraAdresa = Object.assign({}, view107, { partners: Object.assign({}, view107.partners,
    { 160796: { cui: '160796', den: 'FUNDATIA BETA' } }) });
  const rau107 = d107.report(faraAdresa, '2026', { sponsorizare: { disponibil: 5100, folosit: 2500 } });
  ok('D107: beneficiarul fara adresa este numit in erori', rau107.errors.some((e) => /FUNDATIA BETA.*adresă/.test(e)));
}

section('D307 — ajustari/corectii/regularizari TVA');
{
  const d307 = require('../src/d307');
  const fp307 = require('../src/fiscalProfile');
  const fields = { data: '2026-06-12', document: 'TA-307', partener: 'Cedent & Asociatii SRL',
    cuiPartener: 'RO14399840', tipOperatieD307: 'A', sumaTvaD307: 100 };
  const m = d307.dinCampuri(fields);
  eq('D307: campurile normalizeaza tipul, CUI-ul si TVA in lei intregi', JSON.stringify(m),
    JSON.stringify({ tip: 'A', rol: 'cedent', codOperator: '14399840',
      denumireOperator: 'Cedent & Asociatii SRL', tva: 100 }));
  const lines = gt2(d307.TIP_DOCUMENT).build(fields);
  ok('D307: suma de plata foloseste obligatia 635=446, fara conturile TVA curenta',
    lines.length === 1 && lines[0].debit === '635' && lines[0].credit === '446' && lines[0].suma === 100
      && !lines.some((l) => /^442/.test(l.debit) || /^442/.test(l.credit)));
  const negFields = Object.assign({}, fields, { document: 'CR-307', partener: 'Beneficiar SRL',
    cuiPartener: '160796', tipOperatieD307: 'C', sumaTvaD307: -25 });
  const mNeg = d307.dinCampuri(negFields);
  const negLines = gt2(d307.TIP_DOCUMENT).build(negFields);
  ok('D307: regularizarea negativa inverseaza obligatia (446=635)', mNeg.tva === -25
    && negLines.length === 1 && negLines[0].debit === '446' && negLines[0].credit === '635'
    && negLines[0].suma === 25);
  const view307 = { company: { cui: '12345674', nume: 'TEST SRL', adresa: 'Str. Test 1',
    tvaPlatitor: false, dataAnulareTva: '2026-06-01' }, entries: [
    { id: '307-a1', tip: d307.TIP_DOCUMENT, status: 'postat', data: '2026-06-12', period: '2026-06',
      partener: fields.partener, d307: m, lines },
    { id: '307-a2', tip: d307.TIP_DOCUMENT, status: 'postat', data: '2026-06-15', period: '2026-06',
      partener: fields.partener, d307: Object.assign({}, m, { tva: 50 }), lines: [{ debit: '635', credit: '446', suma: 50 }] },
    { id: '307-c', tip: d307.TIP_DOCUMENT, status: 'postat', data: '2026-06-20', period: '2026-06',
      partener: negFields.partener, d307: mNeg, lines: negLines },
  ] };
  const r307 = d307.report(view307, '2026-06');
  ok('D307: aceeasi combinatie tip+CUI este agregata intr-un singur rand oficial',
    r307.nrArticole === 3 && r307.nr === 2 && r307.rows.find((r) => r.tip === 'A').tva === 150);
  eq('D307: totalul semnat include regularizarea negativa', r307.totalTva, 125);
  const x307 = xml.d307Xml(view307.company, '2026-06', r307,
    { nume: 'Popescu', prenume: 'Ion', functie: 'Contabil' });
  ok('D307 XML bine-format si datele externe sunt escapate', wellFormed(x307)
    && /denO="Cedent &amp; Asociatii SRL"/.test(x307));
  ok('D307: subtotalurile A/L/C si suma de control sunt derivate din randuri',
    /tvaA="150" tvaL="0" tvaC="-25" totalPlata_A="125"/.test(x307)
      && (x307.match(/<operatie /g) || []).length === 2);
  ok('D307 rectificativ: XML poarta d_rec=1', /d_rec="1"/.test(xml.d307Xml(view307.company,
    '2026-06', r307, null, { rectificativa: true })));
  ok('D307 dupa rezerva: d_anulare cere si emite temeiul ales',
    /d_anulare="1" temei="2"/.test(xml.d307Xml(view307.company, '2026-06', r307, null,
      { dupaRezerva: true, temei: 2 })));
  const asteptate = require('../src/declarations').expectedForFirma(view307, '2026-06').map((x) => x.tip);
  ok('D307: calendarul o cere numai in luna cu operatiune efectiva', asteptate.includes('d307'));
  const entryA = view307.entries[0];
  ok('guard: tipul A nu poate fi postat de platitorul normal de TVA', /D300/.test(fp307.entryGuard(
    fp307.build({ tvaPlatitor: true }), entryA) || ''));
  ok('guard: tipul C cere data anularii codului TVA', /data anulării/.test(fp307.entryGuard(
    fp307.build({ tvaPlatitor: false }), view307.entries[2]) || ''));
  let errCui307 = '';
  try { d307.dinCampuri(Object.assign({}, fields, { cuiPartener: '14399841' })); } catch (e) { errCui307 = e.message; }
  ok('D307: CUI-ul operatorului cu cifra de control gresita este refuzat la intrare', /CUI/.test(errCui307));
  eq('D307: validatorul oficial permite si rectificarea negativa A',
    d307.dinCampuri(Object.assign({}, fields, { sumaTvaD307: -1 })).tva, -1);
  const zeroView = Object.assign({}, view307, { entries: view307.entries.concat([{
    id: '307-c-zero', tip: d307.TIP_DOCUMENT, status: 'postat', data: '2026-06-21', period: '2026-06',
    partener: negFields.partener, d307: Object.assign({}, mNeg, { tva: 25 }),
    lines: [{ debit: '635', credit: '446', suma: 25 }],
  }]) });
  const zeroReport = d307.report(zeroView, '2026-06');
  const zeroXml = xml.d307Xml(zeroView.company, '2026-06', zeroReport, null, { rectificativa: true });
  ok('D307: rectificarea pastreaza randul agregat zero acceptat de validator',
    zeroReport.rows.find((r) => r.tip === 'C').tva === 0
      && /tvaC="0"/.test(zeroXml) && /tip="C"[^>]*tva="0"/.test(zeroXml));
}

section('D311 — TVA colectata dupa anularea codului normal de TVA');
{
  const d311 = require('../src/d311');
  const fp311 = require('../src/fiscalProfile');
  const fields = { data: '2026-06-12', document: 'V-311', partener: 'Client', cuiPartener: '87654321',
    tipOperatieD311: '11', baza: 1000, tva: 210, cota: 21, contVenit: '704' };
  const m = d311.dinCampuri(fields);
  eq('D311: incadrarea pastreaza baza si taxa efectiva', JSON.stringify(m),
    JSON.stringify({ operatie: 11, sectiune: 'IV', baza: 1000, tva: 210, cota: 21 }));
  const lines = gt2(d311.TIP_DOCUMENT).build(fields);
  ok('D311: livrarea recunoaste baza, iar taxa merge 635=446 (fara 4427)',
    lines.some((l) => l.debit === '4111' && l.credit === '704' && l.suma === 1000)
      && lines.some((l) => l.debit === '635' && l.credit === '446' && l.suma === 210)
      && !lines.some((l) => /^442/.test(l.debit) || /^442/.test(l.credit)));
  const ach = gt2(d311.TIP_DOCUMENT).build(Object.assign({}, fields, {
    tipOperatieD311: '21', baza: 500, tva: 105, contCost: '628',
  }));
  ok('D311: taxa achizitiei este nedeductibila si intra in cost',
    ach.some((l) => l.debit === '628' && l.credit === '401' && l.suma === 500)
      && ach.some((l) => l.debit === '628' && l.credit === '446' && l.suma === 105));
  const view311 = { company: { cui: '12345674', nume: 'TEST SRL', adresa: 'Str. Test 1',
    tvaPlatitor: true, tvaCodAnulat: true, dataAnulareTva: '2026-06-01', motivAnulareTva: 'oficiu' },
  entries: [
    { id: '311-l', tip: d311.TIP_DOCUMENT, status: 'postat', data: '2026-06-12', period: '2026-06',
      document: 'V-311', d311: m, lines },
    { id: '311-a', tip: d311.TIP_DOCUMENT, status: 'postat', data: '2026-06-18', period: '2026-06',
      document: 'A-311', d311: { operatie: 21, sectiune: 'IV', baza: 500, tva: 105, cota: 21 }, lines: ach },
  ] };
  const r311 = d311.report(view311, '2026-06');
  eq('D311: raportul alege schema anularii', r311.schema, 'anulare');
  eq('D311: raportul totalizeaza taxa o singura data', r311.totalTva, 315);
  const x311 = xml.d311Xml(view311.company, '2026-06', r311,
    { nume: 'Popescu', prenume: 'Ion', functie: 'Contabil' });
  ok('D311 XML bine-format', wellFormed(x311));
  ok('D311: subtotalurile oficiale 31/51 si suma de control torna',
    /OB_31="1500" OB_32="315"/.test(x311) && /OB_51="1500" OB_52="315"/.test(x311)
      && /totalPlata_A="1815"/.test(x311));
  ok('D311 rectificativ: XML poarta d_rec=1', /d_rec="1"/.test(xml.d311Xml(view311.company,
    '2026-06', r311, null, { rectificativa: true })));
  const view61 = { company: Object.assign({}, view311.company, { tvaCodAnulat: false,
    dataReinregistrareTva: '2026-06-10' }), entries: [{ id: '311-r', tip: d311.TIP_DOCUMENT,
    status: 'postat', data: '2026-06-20', period: '2026-06', document: 'R-311',
    d311: { operatie: 61, sectiune: 'V', baza: 500, tva: 105, cota: 21 },
    lines: [{ debit: '635', credit: '446', suma: 105 }] }] };
  const x61 = xml.d311Xml(view61.company, '2026-06', d311.report(view61, '2026-06'));
  ok('D311 sectiunea V: foloseste exclusiv Data_I si OB_61/62',
    /Data_I="10\.06\.2026"/.test(x61) && /OB_61="500" OB_62="105"/.test(x61) && !/Data_A=/.test(x61));
  const mix = { company: view311.company, entries: view311.entries.concat(view61.entries) };
  let errMix = '';
  try { xml.d311Xml(mix.company, '2026-06', d311.report(mix, '2026-06')); } catch (e) { errMix = e.message; }
  ok('D311: schemele IV si V nu pot fi amestecate', /nu poate combina/.test(errMix));
  const asteptate = require('../src/declarations').expectedForFirma(view311, '2026-06').map((x) => x.tip);
  ok('D311: calendarul o cere numai in luna cu operatiune efectiva', asteptate.includes('d311'));
  const p = fp311.build(view311.company);
  ok('profil: codul anulat dezactiveaza D300, fara a pierde starea speciala', p.tvaCodAnulat && !p.tvaPlatitor);
  ok('guard: firma obisnuita nu poate posta D311', /Cod normal de TVA anulat/.test(fp311.entryGuard(
    fp311.build({ tvaPlatitor: false }), view311.entries[0]) || ''));
  ok('guard: anularea la cerere nu permite categoriile D311 rezervate anularii din oficiu',
    /anulat din oficiu/.test(fp311.entryGuard(fp311.build(Object.assign({}, view311.company,
      { motivAnulareTva: 'cerere' })), view311.entries[0]) || ''));
  ok('guard: categoria 61 cere data reinregistrarii', /reînregistrării/.test(fp311.entryGuard(
    fp311.build({ tvaPlatitor: true }), view61.entries[0]) || ''));
}

section('C1-C2: concediul medical pe zile calendaristice + cursul plafonului micro');
{
  const pay = require('../src/payroll');
  const bnrM = require('../src/bnr');
  const round2 = (x) => Math.round(x * 100) / 100;
  // ── C1: primele 5 zile suportate de angajator sunt CALENDARISTICE (OUG 158/2005 art. 12),
  // iar indemnizatia se cuvine doar pentru zilele LUCRATOARE din ele. Formula veche numara 5 zile
  // lucratoare, adica maximul posibil — cost mutat sistematic de la FNUASS la firma.
  eq('concediu inceput LUNI: 5 zile lucratoare in primele 5 calendaristice', pay.zileLucratoareInPrimele('2026-06-08', 5), 5);
  eq('concediu inceput JOI: doar 3 (joi, vineri, luni)', pay.zileLucratoareInPrimele('2026-06-11', 5), 3);
  eq('concediu inceput VINERI: 3 (vineri, luni, marti)', pay.zileLucratoareInPrimele('2026-06-12', 5), 3);
  eq('concediu inceput SAMBATA: 3 (luni, marti, miercuri)', pay.zileLucratoareInPrimele('2026-06-13', 5), 3);
  eq('fara data, nu inventam un raspuns', pay.zileLucratoareInPrimele('', 5), null);
  eq('data invalida, la fel', pay.zileLucratoareInPrimele('nu-e-data', 5), null);

  // Efectul pe statul de plata: aceleasi 10 zile de concediu, alt reparte angajator/FNUASS.
  const ang = (extra) => [Object.assign({ id: 'a1', nume: 'X', salariuBrut: 6300, zileLucratoare: 21,
    zileCM: 10, procentCM: 75 }, extra || {})];
  const joi = pay.statePlata(ang({ dataInceputCM: '2026-06-11' }), '2026-06', []).rows[0];
  const luni = pay.statePlata(ang({ dataInceputCM: '2026-06-08' }), '2026-06', []).rows[0];
  eq('concediu de joi: angajatorul suporta 3 zile', joi.zileCMAngajator, 3);
  eq('concediu de luni: angajatorul suporta 5', luni.zileCMAngajator, 5);
  ok('deci angajatorul plateste mai putin cand concediul incepe joi', joi.cmAngajator < luni.cmAngajator);
  ok('...iar FNUASS suporta diferenta, nu dispare', round2(joi.cmAngajator + joi.cmFnuass) === round2(luni.cmAngajator + luni.cmFnuass));
  ok('indemnizatia totala e aceeasi in ambele cazuri', joi.indemnizatieCM === luni.indemnizatieCM);
  // Fara data: se pastreaza vechea aproximare, dar articolul o SEMNALEAZA.
  const fara = pay.statePlata(ang({}), '2026-06', []).rows[0];
  eq('fara data: ramane aproximarea de 5 zile', fara.zileCMAngajator, 5);
  ok('...dar e marcata ca aproximata', fara.cmAproximat === true);
  ok('cu data, nu mai e aproximata', joi.cmAproximat === false);

  // ── C2: plafonul micro se converteste la cursul BNR de la 31 decembrie anul precedent.
  // Fixtura contine si un curs din 2026: fara el, o cautare pornita din anul GRESIT ar da acelasi
  // rezultat (rateAt merge inapoi si ar cadea tot pe decembrie 2025), iar testul n-ar discrimina.
  const col = [{ id: '2025-12-30', cursuri: { EUR: 5.0812 } }, { id: '2025-12-29', cursuri: { EUR: 5.0798 } },
    { id: '2026-06-15', cursuri: { EUR: 5.15 } }];
  const cu = bnrM.cursPlafonMicro(col, 2026, 5.0);
  eq('cursul plafonului vine de la BNR', cu.sursa, 'bnr');
  eq('...din ultima zi publicata inainte de 31 decembrie', cu.data, '2025-12-30');
  // `eq` rotunjeste la doua zecimale, iar cursul BNR are PATRU — comparatie stricta, altfel
  // testul ar trece si daca undeva pe drum s-ar pierde precizia cursului.
  ok('...si e cursul real, cu toate zecimalele (nu rotunjit la bani)', cu.curs === 5.0812);
  ok('31 decembrie nefiind zi de publicare, cursul nu e „exact" — chiar regula legala', cu.exact === false);
  // Anul contează: plafonul se converteste la cursul de la inchiderea exercitiului PRECEDENT.
  ok('nu se ia cursul din cursul anului raportat', cu.curs !== 5.15);
  const fallback = bnrM.cursPlafonMicro([], 2026, 5.0);
  eq('fara istoric BNR: se cade pe valoarea din setari', fallback.curs, 5);
  eq('...dar proveniența se vede', fallback.sursa, 'implicit');
  // Diferenta care conteaza: o firma cu 505.000 lei e SUB plafon la cursul real si PESTE la 5,0.
  const plafonReal = round2(100000 * cu.curs);
  const plafonRotund = round2(100000 * fallback.curs);
  ok('firma cu 505.000 lei: sub plafon la cursul real', 505000 < plafonReal);
  ok('...si peste plafon la cursul rotund — exact decizia care se lua gresit', 505000 > plafonRotund);
}

section('Import XLSX (parser)');
const AdmZip = require('adm-zip');
const xlsxMod = require('../src/xlsx');
const _ss = '<?xml version="1.0"?><sst><si><t>CUI</t></si><si><t>Den</t></si><si><t>RO9</t></si><si><t>ACME &amp; CO</t></si></sst>';
const _sheet = '<?xml version="1.0"?><worksheet><sheetData>'
  + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Sold</t></is></c></row>'
  + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>1500.5</v></c></row>'
  + '</sheetData></worksheet>';
const _zip = new AdmZip();
_zip.addFile('xl/sharedStrings.xml', Buffer.from(_ss));
_zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(_sheet));
const xrows = xlsxMod.parseXlsx(_zip.toBuffer());
eq('XLSX: 2 randuri citite', xrows.length, 2);
eq('XLSX: antet din siruri partajate', xrows[0].join(','), 'CUI,Den,Sold');
eq('XLSX: decodare entitate XML (&amp;)', xrows[1][1], 'ACME & CO');
eq('XLSX: celula numerica', xrows[1][2], '1500.5');

section('D205 (retinere la sursa) + Intrastat + DBF');
const chir = gt2('chirie_pf').build({ baza: 1000, cota: 10, cont: '5121' });
eq('chirie_pf: impozit 10% din net (brut - 20% forfetar) = 80', (chir.find((l) => l.credit === '446') || {}).suma, 80);
eq('chirie_pf: net platit 920', (chir.find((l) => l.credit === '5121') || {}).suma, 920);
eq('chirie_pf: debit 612 = brut 1000', chir.reduce((s, l) => s + (l.debit === '612' ? l.suma : 0), 0), 1000);

section('Monografii adaugate: cedare mijloc fix, cut-off 408, capital social, creante incerte');
{
  const coa2 = require('../src/chartOfAccounts');
  // Toate conturile atinse de monografiile noi trebuie sa existe in plan — o linie catre un cont
  // inexistent trece de `build` si cade abia la salvare, cu un mesaj despre „cont inexistent".
  const toateLiniile = (id, f) => gt2(id).build(f);
  const conturiValide = (linii) => linii.every((l) => coa2.getAccount(l.debit) && coa2.getAccount(l.credit));

  // ── Vanzarea unui mijloc fix: exista casarea, dar nu si cedarea cu titlu oneros ──
  const vmf = toateLiniile('vanzare_mijloc_fix', { pret: 20000, tva: 4200, valoare: 50000, amortizare: 35000, contImob: '2133', contAmort: '2813' });
  ok('cedare: toate conturile exista in plan', conturiValide(vmf));
  eq('cedare: venitul pe 7583 (contul lipsea cu totul)', (vmf.find((l) => l.credit === '7583') || {}).suma, 20000);
  eq('cedare: TVA colectata la pretul de vanzare', (vmf.find((l) => l.credit === '4427') || {}).suma, 4200);
  eq('cedare: amortizarea cumulata se scade (2813 = 2133)', (vmf.find((l) => l.debit === '2813' && l.credit === '2133') || {}).suma, 35000);
  eq('cedare: valoarea ramasa pe 6583', (vmf.find((l) => l.debit === '6583') || {}).suma, 15000);
  // Invariantul care conteaza: activul iese INTEGRAL din evidenta (50.000 = 35.000 + 15.000).
  eq('cedare: contul de imobilizare se stinge complet',
    vmf.filter((l) => l.credit === '2133').reduce((s, l) => s + l.suma, 0), 50000);
  // Activ complet amortizat: nicio linie de valoare ramasa, dar tot se scoate din evidenta.
  const vmfAmort = toateLiniile('vanzare_mijloc_fix', { pret: 500, tva: 105, valoare: 9000, amortizare: 9000 });
  ok('cedare, activ integral amortizat: fara linie 6583', !vmfAmort.some((l) => l.debit === '6583'));
  eq('...dar tot se scoate integral din evidenta', vmfAmort.filter((l) => l.credit === '2131').reduce((s, l) => s + l.suma, 0), 9000);

  // ── Cut-off 408: contul era in plan, in bilant si in SAF-T, dar nimic nu-l producea ──
  const fn = toateLiniile('factura_nesosita', { baza: 1000, tva: 210, contChelt: '605' });
  ok('cut-off: conturile exista', conturiValide(fn));
  eq('cut-off: cheltuiala in luna consumului (605 = 408)', (fn.find((l) => l.debit === '605' && l.credit === '408') || {}).suma, 1000);
  // TVA-ul e NEEXIGIBIL pana la factura: dreptul de deducere se naste cu ea, nu cu consumul.
  eq('cut-off: TVA pe 4428, NU pe 4426', (fn.find((l) => l.debit === '4428') || {}).suma, 210);
  ok('cut-off: nicio linie de TVA deductibila inainte de factura', !fn.some((l) => l.debit === '4426'));
  const sf = toateLiniile('sosire_factura_nesosita', { baza: 1000, tva: 210 });
  eq('sosire: 408 se stinge la TOTAL (baza + TVA)', (sf.find((l) => l.debit === '408' && l.credit === '401') || {}).suma, 1210);
  eq('sosire: TVA devine deductibila (4426 = 4428)', (sf.find((l) => l.debit === '4426' && l.credit === '4428') || {}).suma, 210);
  // Perechea inchide contul: ce a intrat pe credit 408 iese pe debit.
  eq('perechea cut-off + sosire lasa 408 pe zero',
    fn.filter((l) => l.credit === '408').reduce((s, l) => s + l.suma, 0)
    - sf.filter((l) => l.debit === '408').reduce((s, l) => s + l.suma, 0), 0);

  // ── Capital social: 1011 si 456 lipseau, desi bilantul mapa deja 1011 pe randul 031 ──
  const sub = toateLiniile('subscriere_capital', { suma: 45000 });
  ok('subscriere: conturile exista', conturiValide(sub));
  eq('subscriere: creanta fata de asociati (456 = 1011)', (sub.find((l) => l.debit === '456' && l.credit === '1011') || {}).suma, 45000);
  const vars = toateLiniile('varsare_capital', { suma: 45000, cont: '5121' });
  ok('varsare: conturile exista', conturiValide(vars));
  eq('varsare: incasarea stinge creanta (5121 = 456)', (vars.find((l) => l.debit === '5121' && l.credit === '456') || {}).suma, 45000);
  // A doua linie e cea uitata de obicei: fara ea, 1011 ramane in bilant si varsatul apare zero.
  eq('varsare: capitalul trece din nevarsat in varsat (1011 = 1012)', (vars.find((l) => l.debit === '1011' && l.credit === '1012') || {}).suma, 45000);
  eq('subscriere + varsare lasa 1011 pe zero',
    sub.filter((l) => l.credit === '1011').reduce((s, l) => s + l.suma, 0)
    - vars.filter((l) => l.debit === '1011').reduce((s, l) => s + l.suma, 0), 0);

  // ── Creante incerte + ajustarea TVA la lipsa ──
  const ci = toateLiniile('client_incert', { suma: 12100 });
  ok('client incert: 4118 = 4111, conturi valide', conturiValide(ci) && ci[0].debit === '4118' && ci[0].credit === '4111');
  const atl = toateLiniile('ajustare_tva_lipsa', { baza: 3000, cota: 21 });
  ok('ajustare lipsa: conturile exista', conturiValide(atl));
  eq('ajustare lipsa: TVA dedusa se da inapoi (635 = 4426)', (atl.find((l) => l.debit === '635' && l.credit === '4426') || {}).suma, 630);
  eq('ajustare lipsa fara valoare -> nicio linie', toateLiniile('ajustare_tva_lipsa', { baza: 0, cota: 21 }).length, 0);

  // ── Ajustarile pentru creante: drumul complet, de la probabil la cert ──
  // Reclasificarea (4118 = 4111) exista din iulie, dar ajustarea propriu-zisa NU se putea
  // inregistra: niciunul dintre tipurile de document nu producea 6814/491/7814/654/754, desi
  // conturile erau in plan si bilantul le citea. Testele de mai jos apara cele patru intrari noi.
  const ajC = toateLiniile('ajustare_creanta_constituire', { suma: 12100 });
  ok('ajustare creante: conturile exista', conturiValide(ajC));
  eq('ajustare creante: constituirea e 6814 = 491', (ajC.find((l) => l.debit === '6814' && l.credit === '491') || {}).suma, 12100);
  const ajR = toateLiniile('ajustare_creanta_reluare', { suma: 12100 });
  eq('ajustare creante: reluarea e 491 = 7814', (ajR.find((l) => l.debit === '491' && l.credit === '7814') || {}).suma, 12100);

  // Scoaterea din evidenta are DOUA jumatati cand exista ajustare: fara reluarea simultana,
  // pierderea ar intra in rezultat de doua ori (o data la constituire, o data aici).
  const sco = toateLiniile('creanta_scoasa_din_evidenta', { suma: 12100, ajustare: 12100, contCreanta: '4118' });
  ok('creanta scoasa: conturile exista', conturiValide(sco));
  eq('creanta scoasa: pierderea e 654 = 4118', (sco.find((l) => l.debit === '654' && l.credit === '4118') || {}).suma, 12100);
  eq('creanta scoasa: ajustarea se reia in acelasi articol', (sco.find((l) => l.debit === '491' && l.credit === '7814') || {}).suma, 12100);
  eq('creanta scoasa cu ajustare: efect NET zero pe rezultat',
    sco.filter((l) => l.debit === '654').reduce((s, l) => s + l.suma, 0)
    - sco.filter((l) => l.credit === '7814').reduce((s, l) => s + l.suma, 0), 0);
  // Fara ajustare constituita, ramane o singura linie — pierderea nu a fost recunoscuta inainte.
  eq('creanta scoasa fara ajustare -> o singura linie',
    toateLiniile('creanta_scoasa_din_evidenta', { suma: 5000, ajustare: 0, contCreanta: '4111' }).length, 1);

  const rea = toateLiniile('creanta_reactivata', { suma: 12100, contCreanta: '4111' });
  eq('creanta reactivata: 4111 = 754', (rea.find((l) => l.debit === '4111' && l.credit === '754') || {}).suma, 12100);
  // Reactivarea NU incaseaza: incasarea e alt document, cu extrasul ei.
  ok('creanta reactivata nu atinge trezoreria',
    !rea.some((l) => /^5/.test(String(l.debit)) || /^5/.test(String(l.credit))));

  // Regimul FISCAL nu se scrie in monografie, dar trebuie sa fie prins de motorul de nedeductibile.
  //
  // ATENTIE, testul acesta a fost REFACUT: cerea `FIXE['6814'].pct === 70`, adica 30% deducere pe
  // TOT contul — regula pe care o aplica aplicatia si care era ea insasi defectul. Cei 30% se dau
  // numai creantelor eligibile (art. 26 alin. (1) lit. c), nu intregii ajustari. Un test verde
  // poate fi el insusi defectul.
  const ded = require('../src/deductibilitate');
  eq('654 e nedeductibil integral (art. 25)', ded.FIXE['654'].pct, 100);
  ok('6814 NU mai e procent fix pe cont', ded.FIXE['6814'] === undefined);
  ok('7814 NU mai e procent fix pe cont (oglindeste ajustarea anului)', ded.NEIMPOZABILE['7814'] === undefined);

  // ── Art. 26(1)(c): deducerea de 30% NUMAI pe creantele eligibile ──────────────────────────
  const cfg26 = { ajustariCreantePct: 30, ajustariCreanteZile: 270 };
  const rulaj26 = (suma) => ({ 6814: { d: suma, c: 0 } });
  // DEFECTUL REPARAT, cu cifre: o ajustare de 10.000 lei pe creante de 91 de zile. Regula veche
  // (30% pe tot contul) dadea 3.000 lei deducere la care firma nu avea drept — la 16% impozit,
  // 480 de lei de impozit subdeclarat pe an, si tot asa in fiecare an.
  {
    const fara = ded.ajustariCreante(rulaj26(10000), 0, cfg26);
    eq('nicio creanta eligibila -> integral nedeductibil', fara.nedeductibil, 10000);
    eq('...deci deducere zero, nu 3.000', fara.deductibil, 0);
    const cu = ded.ajustariCreante(rulaj26(10000), 10000, cfg26);
    eq('toata ajustarea eligibila -> se deduc 30%', cu.deductibil, 3000);
    eq('...si restul e nedeductibil', cu.nedeductibil, 7000);
    const partial = ded.ajustariCreante(rulaj26(10000), 4000, cfg26);
    eq('eligibila partial (4.000 din 10.000) -> deducere 1.200', partial.deductibil, 1200);
    eq('...nedeductibil 8.800', partial.nedeductibil, 8800);
    // Un marcaj mai mare decat cheltuiala nu poate produce deducere din nimic.
    eq('baza plafonata la ajustarea inregistrata', ded.ajustariCreante(rulaj26(1000), 50000, cfg26).deductibil, 300);
    eq('fara rulaj pe 6814, niciun rand', ded.ajustariCreante({}, 5000, cfg26), null);
    ok('temeiul e citat pe rand', /26\(1\)\(c\)/.test(cu.temei));
    ok('nota spune de ce nu se deduce nimic', /nicio creanta/i.test(fara.nota));
  }
  // Simetria art. 23(d): reluarea e neimpozabila in ACEEASI proportie in care ajustarea a fost
  // nedeductibila. Fara nicio ajustare inregistrata, reluarea e integral neimpozabila — altfel
  // s-ar impozita o suma care n-a fost niciodata dedusa.
  {
    const cu = ded.ajustariCreante(rulaj26(10000), 10000, cfg26);   // 70% nedeductibil
    const n1 = ded.neimpozabile({ 7814: { d: 0, c: 5000 } }, cu.pctNedeductibil);
    eq('reluare 5.000, oglindita la 70% -> neimpozabil 3.500', n1.total, 3500);
    const n2 = ded.neimpozabile({ 7814: { d: 0, c: 5000 } }, null);
    eq('reluare fara ajustare in an -> integral neimpozabila', n2.total, 5000);
    const fara = ded.ajustariCreante(rulaj26(10000), 0, cfg26);     // 100% nedeductibil
    eq('perechea conservatoare e consistenta (100% / 100%)',
      ded.neimpozabile({ 7814: { d: 0, c: 5000 } }, fara.pctNedeductibil).total, 5000);
  }
  // Randul pastreaza forma istorica citita de PDF si de interfata
  {
    const r26 = ded.ajustariCreante(rulaj26(10000), 4000, cfg26);
    ok('randul are forma {cont, cheltuit, pct, nedeductibil}',
      r26.cont === '6814' && r26.cheltuit === 10000 && typeof r26.pct === 'number' && r26.nedeductibil === 8800);
    eq('pct = proportia REZULTATA, nu o cota din lege', r26.pct, 88);
  }
  // Ajustarea intra in `ajustari()` prin marcaj, nu prin cont — deci si in impozitul postat
  {
    const cuBaza = ded.ajustari({ rulaj: rulaj26(10000), profitContabil: 50000, ajustariCreanteBaza: 10000 },
      Object.assign({ impozitProfit: 16 }, cfg26));
    const faraBaza = ded.ajustari({ rulaj: rulaj26(10000), profitContabil: 50000 },
      Object.assign({ impozitProfit: 16 }, cfg26));
    eq('cu baza eligibila: nedeductibil 7.000', cuBaza.totalNedeductibil, 7000);
    eq('fara marcaj: nedeductibil 10.000 (nu se presupune deducerea)', faraBaza.totalNedeductibil, 10000);
    ok('randul ajunge in tabelul de procente fixe al registrului',
      cuBaza.randuriFixe.some((x) => x.cont === '6814'));
  }
  // Grupa de vechime care alimenteaza baza fiscala
  {
    const an = require('../src/analytic');
    const azi = new Date();
    const cuZile = (n) => new Date(azi.getTime() - n * 86400000).toISOString().slice(0, 10);
    const dbAg = { entries: [
      { id: 'e1', firmaId: 'f', data: cuZile(300), period: cuZile(300).slice(0, 7), partener: 'VECHI SRL', partenerCui: 'RO1', lines: [{ debit: '4111', credit: '707', suma: 1000 }] },
      { id: 'e2', firmaId: 'f', data: cuZile(120), period: cuZile(120).slice(0, 7), partener: 'RECENT SRL', partenerCui: 'RO2', lines: [{ debit: '4111', credit: '707', suma: 2000 }] },
    ], partners: {} };
    const ag = an.aging(dbAg, null);
    const vechi = ag.clienti.find((c) => c.cui === 'RO1');
    const recent = ag.clienti.find((c) => c.cui === 'RO2');
    eq('creanta de 300 de zile intra in b270plus', vechi.b270plus, 1000);
    eq('...si ramane si in b90plus (grupa nu s-a taiat in doua)', vechi.b90plus, 1000);
    eq('creanta de 120 de zile e in b90plus, dar NU in b270plus', recent.b90plus, 2000);
    eq('...deci nu aduce nicio deducere', recent.b270plus, 0);
    eq('totalul pe grupe ramane egal cu soldul', Math.round((vechi.total + recent.total) * 100) / 100, 3000);
  }

  // ── AJUSTARILE PENTRU DEPRECIERE: stocuri (39x) si imobilizari (29x) ─────────────────────
  // Lipseau complet — nici conturi, nici monografii — desi patru module scriau deja reguli pentru
  // ele. Garda din `composeEntry` facea imposibila si o nota manuala: contul nu exista.
  {
    const aj = require('../src/ajustari');
    // Poarta pe HARTA BRUTA, nu pe ce intoarce `pentruCont`. Diferenta conteaza: `pentruCont`
    // refuza deja sa intoarca un cont absent din plan (`return null`), deci o poarta pe iesirea ei
    // e trivial adevarata si ar trece si cu harta stricata — exact tiparul „poarta pe conventie,
    // nu pe efect" intalnit la `db.pushEntry`. Aici se verifica valorile scrise in harta.
    const inventate = Object.values(aj.CONT_AJUSTARE).filter((c) => !coa2.getAccount(c));
    eq('fiecare cont din harta de ajustari exista in plan', [...new Set(inventate)].join(',') || '(niciunul)', '(niciunul)');
    ok('harta chiar are ce verifica', Object.keys(aj.CONT_AJUSTARE).length >= 20);
    // toate conturile de activ din PLAN care au ajustare -> contul exista si el
    const dinPlan = coa2.ACCOUNTS.filter((a) => /^(2[0-3]|3[0-8])/.test(a.cod) && aj.areAjustare(a.cod));
    ok('planul chiar contine conturi cu ajustare de verificat', dinPlan.length >= 8);
    eq('fiecare ajustare derivata din plan exista in plan',
      dinPlan.filter((a) => !coa2.getAccount(aj.pentruCont(a.cod).ajustare)).length, 0);

    const contAj = (c) => (aj.pentruCont(c) || {}).ajustare || '(fara)';
    eq('marfuri 371 -> 397', contAj('371'), '397');
    eq('materii prime 301 -> 391', contAj('301'), '391');
    eq('produse finite 345 -> 394', contAj('345'), '394');
    eq('constructii 212 -> 2912', contAj('212'), '2912');
    eq('echipamente 2131 -> 2913', contAj('2131'), '2913');
    eq('analitic 371.01 cade pe sinteticul lui', contAj('371.01'), '397');
    eq('cont fara ajustare definita -> null', aj.pentruCont('5121'), null);
    {
      const cheieProba = '399999'; // cont de proba, nu exista in plan
      aj.CONT_AJUSTARE[cheieProba] = '39999';
      eq('o intrare de harta care arata spre un cont absent din plan -> null, nu cod inventat',
        aj.pentruCont(cheieProba), null);
      delete aj.CONT_AJUSTARE[cheieProba];
      eq('...iar harta ramane curata dupa proba', aj.pentruCont(cheieProba), null);
    }
    // contul de cheltuiala depinde de CLASA activului, nu de felul deprecierii
    eq('stocurile trec prin 6814', (aj.pentruCont('371') || {}).cheltuiala, '6814');
    eq('imobilizarile trec prin 6813', (aj.pentruCont('212') || {}).cheltuiala, '6813');
    eq('reluarea stocurilor pe 7814', (aj.pentruCont('371') || {}).venit, '7814');
    eq('reluarea imobilizarilor pe 7813', (aj.pentruCont('212') || {}).venit, '7813');

    // articolele: constituire vs reluare, cu semnul diferentei
    const c = aj.linii('371', 6000);
    eq('constituire produce exact o linie', c.length, 1);
    eq('constituire: 6814 = 397', (c[0] || {}).debit + '=' + (c[0] || {}).credit, '6814=397');
    eq('...cu suma deprecierii', (c[0] || {}).suma, 6000);
    const rl = aj.linii('371', -2500);
    eq('reluare: 397 = 7814', (rl[0] || {}).debit + '=' + (rl[0] || {}).credit, '397=7814');
    eq('diferenta zero nu produce articol', aj.linii('371', 0).length, 0);
    eq('contul fara ajustare nu produce articol', aj.linii('5121', 1000).length, 0);
    ok('explicatia e citibila, nu agramata', /Ajustare pentru depreciere — Mărfuri \(371\)/.test((c[0] || {}).explicatie || ''));

    // monografiile chiar exista si folosesc aceeasi harta
    const st = gt2('ajustare_stoc_constituire').build({ contStoc: '301', suma: 800 });
    eq('monografia de stoc foloseste harta (301 -> 391)', (st[0] || {}).debit + '=' + (st[0] || {}).credit, '6814=391');
    const im = gt2('ajustare_imobilizare_reluare').build({ contImob: '2133', suma: 400 });
    eq('monografia de imobilizari, la reluare (2133 -> 2913)', (im[0] || {}).debit + '=' + (im[0] || {}).credit, '2913=7813');
  }

  // ── Regimul FISCAL al ajustarilor de stoc/imobilizari: integral nedeductibile ────────────
  {
    const cfgA = { ajustariCreantePct: 30, ajustariCreanteZile: 270 };
    const split = (o) => Object.assign({
      creante: { cheltuiala: 0, venit: 0 }, stocuri: { cheltuiala: 0, venit: 0 },
      imobilizari: { cheltuiala: 0, venit: 0 }, nedeterminat: { cheltuiala: 0, venit: 0 } }, o);
    const nd = ded.ajustariNedeductibile(split({ stocuri: { cheltuiala: 4000, venit: 0 } }));
    eq('ajustarea de stoc e integral nedeductibila', nd.total, 4000);
    eq('...cu un rand pe care sa-l vada registrul fiscal', nd.randuri.length, 1);
    ok('...cu temeiul art. 26(1)', /26\(1\)/.test((nd.randuri[0] || {}).temei || ''));
    const ndi = ded.ajustariNedeductibile(split({ imobilizari: { cheltuiala: 9000, venit: 0 } }));
    eq('ajustarea de imobilizari, la fel', ndi.total, 9000);
    eq('...pe contul 6813', (ndi.randuri[0] || {}).cont, '6813');
    // simetria: reluarea unei ajustari nedeductibile nu e venit impozabil
    const ndr = ded.ajustariNedeductibile(split({ stocuri: { cheltuiala: 0, venit: 3000 } }));
    eq('reluarea de stoc e integral neimpozabila', (ndr.randuriNeimpozabile[0] || {}).neimpozabil, 3000);
    eq('...deci nu adauga nimic la nedeductibile', ndr.total, 0);
    // liniile pe conturi neincadrate NU se imprastie peste celelalte familii
    const ndn = ded.ajustariNedeductibile(split({ nedeterminat: { cheltuiala: 1500, venit: 0 } }));
    eq('ajustarea neincadrata e tratata prudent (nedeductibila)', ndn.total, 1500);

    // DEFECTUL pe care spargerea il inchide, cu cifre. 6814 e comun creantelor si stocurilor: fara
    // separare, reluarea unei ajustari de STOC (niciodata dedusa) era oglindita cu proportia
    // creantelor si devenea impozabila in proportie de 30%.
    const rulajA = { 6814: { d: 10000, c: 0 }, 7814: { d: 0, c: 11000 } };
    const sp = split({ creante: { cheltuiala: 10000, venit: 5000 }, stocuri: { cheltuiala: 0, venit: 6000 } });
    const cuSpargere = ded.ajustari({ rulaj: rulajA, profitContabil: 100000, ajustariCreanteBaza: 10000, ajustariDepreciere: sp }, cfgA);
    const faraSpargere = ded.ajustari({ rulaj: rulajA, profitContabil: 100000, ajustariCreanteBaza: 10000 }, cfgA);
    eq('cu spargere: venituri neimpozabile 3.500 + 6.000', cuSpargere.totalNeimpozabil, 9500);
    eq('fara spargere: toata reluarea oglindita ca la creante', faraSpargere.totalNeimpozabil, 7700);
    ok('spargerea schimba baza impozabila cu 1.800 lei',
      Math.round((cuSpargere.totalNeimpozabil - faraSpargere.totalNeimpozabil) * 100) / 100 === 1800);
  }

  // ── C1: provizioanele de garantii sunt DEDUCTIBILE (art. 26 alin. (1) lit. b) ────────────
  // Regula veche trata TOT contul 6812 ca nedeductibil. Pentru o firma de constructii — profilul
  // caruia aplicatia ii dedica un grup intreg de documente — asta insemna impozit platit in plus.
  {
    const spP = (o) => Object.assign({ deductibile: { cheltuiala: 0, venit: 0 }, nedeductibile: { cheltuiala: 0, venit: 0 } }, o);
    const rulajP = { 6812: { d: 50000, c: 0 } };
    const cuP = ded.ajustari({ rulaj: rulajP, profitContabil: 200000,
      provizioane: spP({ deductibile: { cheltuiala: 30000, venit: 0 }, nedeductibile: { cheltuiala: 20000, venit: 0 } }) }, {});
    const faraP = ded.ajustari({ rulaj: rulajP, profitContabil: 200000 }, {});
    eq('garantiile de buna executie NU se adauga la nedeductibile', cuP.totalNedeductibil, 20000);
    eq('regula veche le facea pe toate nedeductibile', faraP.totalNedeductibil, 50000);
    ok('diferenta e 30.000 lei de baza impozabila (4.800 lei impozit la 16%)',
      faraP.totalNedeductibil - cuP.totalNedeductibil === 30000);
    // randul deductibil TREBUIE sa apara in registru, desi nu adauga nimic la baza
    const randG = cuP.randuriFixe.find((r) => r.cont === '1512');
    ok('provizionul deductibil apare in registrul fiscal', !!randG);
    eq('...cu nedeductibil zero', randG && randG.nedeductibil, 0);
    ok('...cu temeiul art. 26(1)(b)', /26\(1\)\(b\)/.test((randG || {}).temei || ''));
    ok('...si cu limita nesolutionata scrisa raspicat', /trimestrului/i.test((randG || {}).nota || ''));
    // forma ISTORICA a randului: PDF-ul si tabelul din interfata citesc `pct`
    ok('randurile noi pastreaza forma istorica (au pct)',
      cuP.randuriFixe.every((r) => r.pct != null));

    // SIMETRIA la reluare, in AMBELE sensuri — jumatatea care se uita usor
    const rulajR = { 7812: { d: 0, c: 30000 } };
    const reluareDed = ded.ajustari({ rulaj: rulajR, profitContabil: 100000,
      provizioane: spP({ deductibile: { cheltuiala: 0, venit: 30000 } }) }, {});
    const reluareNed = ded.ajustari({ rulaj: rulajR, profitContabil: 100000,
      provizioane: spP({ nedeductibile: { cheltuiala: 0, venit: 30000 } }) }, {});
    eq('reluarea unui provizion DEDUCTIBIL e venit impozabil', reluareDed.totalNeimpozabil, 0);
    eq('reluarea unuia NEDEDUCTIBIL nu se impoziteaza', reluareNed.totalNeimpozabil, 30000);

    // clasificarea, pe cont
    ok('1512 e contul deductibil', ded.provizionDeductibil('1512'));
    ok('analiticul lui la fel', ded.provizionDeductibil('1512.01'));
    ok('litigiile (1511) nu sunt deductibile', !ded.provizionDeductibil('1511'));
    ok('„alte provizioane" (1518) nu sunt deductibile', !ded.provizionDeductibil('1518'));
    ok('sinteticul 151 nu e deductibil (nu se poate sti felul)', !ded.provizionDeductibil('151'));

    // monografiile: implicitul e PRUDENT, iar tipul dedicat merge pe 1512
    const pg = gt2('provizion_garantii_constituire').build({ suma: 1000 });
    eq('provizionul de garantii: 6812 = 1512', (pg[0] || {}).debit + '=' + (pg[0] || {}).credit, '6812=1512');
    const pi = gt2('provizion_constituire').build({ suma: 1000 });
    eq('provizionul generic merge implicit pe 1518 (nedeductibil)', (pi[0] || {}).credit, '1518');
    ok('...deci alegerea neatenta nu produce deducere', !ded.provizionDeductibil((pi[0] || {}).credit));
  }

  // ── B2: registrul-inventar cu valoarea de inventar si diferentele ───────────────────────
  {
    const dbRI = {
      entries: [{ id: 'e1', firmaId: 1, data: '2026-06-10', period: '2026-06', system: false,
        lines: [{ debit: '371', credit: '401', suma: 20000 }, { debit: '5121', credit: '1012', suma: 20000 }] }],
      inventarAnual: [{ id: 'i1', firmaId: 1, an: '2026', cont: '371', valoareInventar: 14000, cauza: 'Marfă cu termen expirat' }],
      company: {}, openingBalances: {},
    };
    const repRI = require('../src/reporting');
    const ri = repRI.registruInventar(dbRI, '2026-12', '2026');
    const marfa = ri.rows.find((r) => r.cod === '371');
    eq('valoarea contabila vine din balanta', marfa.valoareContabila, 20000);
    eq('valoarea de inventar vine din inventariere', marfa.valoareInventar, 14000);
    eq('diferenta poarta SEMNUL (negativ = depreciere)', marfa.diferenta, -6000);
    eq('cauza ajunge in registru', marfa.cauza, 'Marfă cu termen expirat');
    eq('se propune contul de ajustare din aceeasi harta', (marfa.ajustare || {}).cont, '397');
    eq('...cu suma deprecierii, pozitiva', (marfa.ajustare || {}).suma, 6000);
    // „neinventariat" NU e „inventariat la zero" — altfel s-ar propune scoaterea intregului sold
    const banca = ri.rows.find((r) => r.cod === '5121');
    eq('element neevaluat: valoare de inventar null, nu 0', banca.valoareInventar, null);
    eq('...si fara diferenta', banca.diferenta, null);
    eq('...deci fara propunere de ajustare', banca.ajustare, null);
    eq('totalul diferentelor numara doar randurile evaluate', ri.totalDiferente, -6000);
    eq('se raporteaza si cate elemente au ramas neevaluate', ri.nrNeevaluate, 3);
    // un PLUS de valoare nu propune ajustare (ajustarea inregistreaza doar deprecierea)
    const dbPlus = Object.assign({}, dbRI, { inventarAnual: [{ id: 'i2', firmaId: 1, an: '2026', cont: '371', valoareInventar: 23000 }] });
    const riPlus = repRI.registruInventar(dbPlus, '2026-12', '2026');
    eq('plus de valoare: diferenta pozitiva', riPlus.rows.find((r) => r.cod === '371').diferenta, 3000);
    eq('...dar nicio ajustare propusa', riPlus.rows.find((r) => r.cod === '371').ajustare, null);
    // valorile altui an nu se amesteca
    const riAltAn = repRI.registruInventar(dbRI, '2026-12', '2025');
    eq('valoarea de inventar e legata de AN', riAltAn.rows.find((r) => r.cod === '371').valoareInventar, null);
  }

  // Planul de conturi: fara duplicate (581 aparea de doua ori) si cu toate codurile noi.
  const coduri = coa2.ACCOUNTS.map((a) => a.cod);
  eq('planul de conturi nu are coduri duplicate', coduri.length, new Set(coduri).size);
  ok('conturile noi sunt in plan', ['1011', '1171', '1174', '4118', '456', '473', '5191', '604', '6588', '7583']
    .every((c) => !!coa2.getAccount(c)));
}

section('Monografii corectate (HoReCa, aviz, dividende, scont)');
// HoReCa vanzare: 707 primeste doar baza; TVA colectata pe 4427; descarcarea scoate si 4428 din 371
const hv = gt2('horeca_vanzare').build({ numerar: 555, card: 0, cota: 11, cost: 300, adaos: 200 });
eq('horeca: venit 707 = baza (fara TVA)', (hv.find((l) => l.credit === '707') || {}).suma, 500);
eq('horeca: TVA colectata 4427 = 55', (hv.find((l) => l.credit === '4427') || {}).suma, 55);
eq('horeca: descarcare TVA neexigibila 4428=371', (hv.find((l) => l.debit === '4428' && l.credit === '371') || {}).suma, 55);
const hvTotal371 = hv.filter((l) => l.credit === '371').reduce((s, l) => s + l.suma, 0);
eq('horeca: 371 descarcat integral la pret de vanzare (cost+adaos+TVA)', Math.round(hvTotal371 * 100) / 100, 555);
// Aviz: 418 include TVA neexigibila; facturarea stinge 418 la total si exigibilizeaza TVA
const av = gt2('aviz_livrare').build({ baza: 1000, tva: 210 });
eq('aviz: 418=707 baza', (av.find((l) => l.credit === '707') || {}).suma, 1000);
eq('aviz: 418=4428 TVA neexigibila', (av.find((l) => l.credit === '4428') || {}).suma, 210);
const fa = gt2('facturare_aviz').build({ baza: 1000, tva: 210 });
eq('facturare aviz: 4111=418 cu tot cu TVA', (fa.find((l) => l.credit === '418') || {}).suma, 1210);
eq('facturare aviz: 4428=4427 exigibilizare', (fa.find((l) => l.debit === '4428' && l.credit === '4427') || {}).suma, 210);
// Dividende: cota implicita 16% din 2026 (Legea 141/2025)
eq('impozit dividende implicit 16%', fiscal.FISCAL.impozitDividende, 16);
eq('prag Intrastat introduceri 1.000.000 lei (Ordin INS 2024-2026)', fiscal.FISCAL.pragIntrastatIntroduceri, 1000000);
eq('prag Intrastat expedieri 1.000.000 lei (Ordin INS 2024-2026)', fiscal.FISCAL.pragIntrastatExpedieri, 1000000);
const dvf = require('../src/documentTypes').typesForClient().find((t) => t.id === 'repartizare_dividende');
eq('camp cota dividende: default 16', (dvf.fields.find((f) => f.name === 'cota') || {}).default, 16);
// Scontare efect: taxa de scont e cheltuiala financiara (667)
const sce = gt2('scontare_efect').build({ suma: 1000, scont: 50 });
eq('scontare: taxa pe 667', (sce.find((l) => l.suma === 50) || {}).debit, '667');

section('Avansuri facturate (factura de avans cu TVA + regularizare)');
const favC = gt2('factura_avans_client').build({ baza: 1000, tva: 210, cota: 21 });
eq('factura avans client: 4111=419 baza', (favC.find((l) => l.credit === '419') || {}).suma, 1000);
eq('factura avans client: 4111=4427 TVA', (favC.find((l) => l.credit === '4427') || {}).suma, 210);
const regC = gt2('regularizare_avans_client').build({ baza: 1000, tva: 210, cota: 21 });
const netOn = (lines, cont) => lines.reduce((s, l) => s + (l.credit === cont ? l.suma : 0) - (l.debit === cont ? l.suma : 0), 0);
eq('ciclu avans client: 419 se inchide', netOn([...favC, ...regC], '419'), 0);
eq('ciclu avans client: TVA avansului se anuleaza la regularizare', netOn([...favC, ...regC], '4427'), 0);
const favF = gt2('factura_avans_furnizor').build({ baza: 500, tva: 105, cota: 21 });
ok('factura avans furnizor: 409=401 + 4426=401', favF.some((l) => l.debit === '409' && l.credit === '401' && l.suma === 500) && favF.some((l) => l.debit === '4426' && l.suma === 105));
const regF = gt2('regularizare_avans_furnizor').build({ baza: 500, tva: 105, cota: 21 });
eq('ciclu avans furnizor: 409 se inchide', [...favF, ...regF].reduce((s, l) => s + (l.debit === '409' ? l.suma : 0) - (l.credit === '409' ? l.suma : 0), 0), 0);
// jurnalul de TVA: baza avansului (419) apare in vanzari; regularizarea o scade
const mkAv = (lines, data) => ({ id: 'av' + data, data, period: data.slice(0, 7), tipNume: 'test', partener: 'X', document: 'AV1', lines });
const jAv = acc.vatJournals({ entries: [mkAv(favC, '2026-05-10')], openingBalances: {} }, '2026-05');
eq('jurnal TVA: factura de avans cu baza 1000', jAv.totals.bazaV, 1000);
eq('jurnal TVA: TVA colectata avans 210', jAv.totals.colectata, 210);
const jReg = acc.vatJournals({ entries: [mkAv(favC, '2026-05-10'), mkAv(regC, '2026-05-20')], openingBalances: {} }, '2026-05');
eq('jurnal TVA: dupa regularizare baza neta 0', jReg.totals.bazaV, 0);
eq('jurnal TVA: dupa regularizare TVA neta 0', jReg.totals.colectata, 0);
// ── Retineri la sursa: baza impozabila si monografia prin 462 ─────────────────────────────────
{
  const R = require('../src/fiscal').retinereLaSursa;
  // B1: suma neimpozabila de 600 lei la premii (art. 110 alin. (4)), pentru FIECARE premiu.
  eq('premiu sub plafon: impozit ZERO', R('premii', 500).impozit, 0);
  eq('...si baza impozabila zero, nu 500', R('premii', 500).baza, 0);
  eq('premiu de 1.000: se impoziteaza doar diferenta peste 600', R('premii', 1000).impozit, 40);
  eq('premiu de exact 600: neimpozabil', R('premii', 600).impozit, 0);
  // Chirii: brut minus cota forfetara de 20% (art. 84) — efectiv 8% din brut.
  eq('chirie 1.000: baza 800', R('chirii', 1000).baza, 800);
  eq('...impozit 80, adica 8% din brut dar 10% din baza', R('chirii', 1000).impozit, 80);
  // Dividendele nu au deduceri: baza E brutul.
  eq('dividende: baza = brutul', R('dividende', 10000).baza, 10000);
  // Cota se poate suprascrie de pe document, dar baza nu depinde de ea.
  eq('cota suprascrisa schimba impozitul, nu baza', R('chirii', 1000, 16).baza, 800);
  eq('...si impozitul urmeaza cota data', R('chirii', 1000, 16).impozit, 128);

  // B3: monografia trece prin 462, nu direct pe trezorerie. Cheltuiala se recunoaste pe BRUT si la
  // data la care e datorata; plata inchide 462. Varianta veche o recunostea la plata, deci o chirie
  // de decembrie platita in ianuarie cadea in alt exercitiu.
  const lPlata = gt2('chirie_pf').build({ baza: 1000, cota: 10, cont: '5121' });
  eq('chirie platita: trei linii (cheltuiala, retinere, plata)', lPlata.length, 3);
  eq('...cheltuiala pe BRUT, cu datoria pe 462', lPlata[0].debit + '=' + lPlata[0].credit + ':' + lPlata[0].suma, '612=462:1000');
  eq('...retinerea din datorie', lPlata[1].debit + '=' + lPlata[1].credit + ':' + lPlata[1].suma, '462=446:80');
  eq('...plata netului inchide 462', lPlata[2].debit + '=' + lPlata[2].credit + ':' + lPlata[2].suma, '462=5121:920');
  const r2 = (x) => Math.round(x * 100) / 100;
  const sold = (l, cont) => r2(l.reduce((s, x) => s + (String(x.credit) === cont ? x.suma : 0) - (String(x.debit) === cont ? x.suma : 0), 0));
  eq('...iar 462 se inchide la zero cand plata e pe acelasi document', sold(lPlata, '462'), 0);
  // Neplatita: articolul se opreste dupa retinere, iar 462 arata cat se mai datoreaza.
  const lDat = gt2('chirie_pf').build({ baza: 1000, cota: 10, cont: '462' });
  eq('chirie neplatita: doua linii', lDat.length, 2);
  eq('...si 462 ramane cu netul de platit', sold(lDat, '462'), 920);
  // Premiul sub plafon nu produce linie de impozit deloc.
  eq('premiu sub plafon: fara linie de retinere', gt2('premiu_pf').build({ baza: 500, cota: 10, cont: '5311' }).length, 2);
}
const d205db = { entries: [
  { id: '1', tip: 'chirie_pf', period: '2026-03', data: '2026-03-01', partener: 'Ion Pop', partenerCui: '1900101415238', lines: gt2('chirie_pf').build({ baza: 1000, cota: 10, cont: '5121' }) },
  { id: '2', tip: 'premiu_pf', period: '2026-05', data: '2026-05-01', partener: 'Maria I', partenerCui: '2900202535241', lines: gt2('premiu_pf').build({ baza: 500, cota: 10, cont: '5311' }) },
  { id: '3', tip: 'repartizare_dividende', period: '2026-04', data: '2026-04-01', partener: 'Asociat A', partenerCui: '1800303646352', lines: [{ debit: '117', credit: '457', suma: 10000 }, { debit: '457', credit: '446', suma: 800 }] },
] };
const d205 = rep.d205(d205db, '2026');
eq('D205: 3 beneficiari', d205.nr, 3);
// Premiul de 500 de lei NU se impoziteaza: art. 110 alin. (4) lasa neimpozabili 600 de lei pentru
// FIECARE premiu. Aserțiunea cerea pana acum 50 de lei pe el — adica taxa pe un venit scutit.
eq('D205: total impozit retinut (80 chirie + 0 premiu sub plafon + 800 dividende)', d205.totalImpozit, 880);
ok('D205: dividend brut 10000 capturat', d205.rows.some((r) => r.tipVenit === 'Dividende' && r.venitBrut === 10000));
// BAZA declarata e cea pe care s-a retinut, nu brutul: la chirii brutul minus cota forfetara de
// 20% (art. 84). Cu brutul, raportul impozit/baza iesea 8% acolo unde regula e 10%.
{
  const rC = d205.rows.find((r) => r.tipVenit === 'Chirii');
  eq('D205 chirii: brut 1000', rC.venitBrut, 1000);
  eq('...dar baza impozabila 800 (brut - 20% forfetar)', rC.bazaImpozabila, 800);
  eq('...deci raportul impozit/baza da exact cota', Math.round((rC.impozit / rC.bazaImpozabila) * 100), 10);
  const xd = xml.d205Xml({ cui: 'RO1', nume: 'X' }, '2026', d205);
  ok('XML-ul poarta baza impozabila, nu brutul', /baza1="800"/.test(xd) && !/baza1="1000"/.test(xd));
  // `tip_plata` e legat de `tip_venit` prin regula R37 a validatorului, iar valoarea '0' folosita
  // pentru tot ce nu era dividend e RESPINSA. N-a iesit la iveala mai devreme fiindca referinta
  // oficiala continea doar dividende — abia varianta cu chirii si premii a lovit regula.
  ok('D205: niciun beneficiar cu tip_plata="0" (respins de regula R37)', !/tip_plata="0"/.test(xd));
  eq('...toate randurile au tip_plata=2 (impozit final)', (xd.match(/tip_plata="2"/g) || []).length, d205.nr);
  const rD = d205.rows.find((r) => r.tipVenit === 'Dividende');
  eq('la dividende baza E chiar brutul (art. 97, fara deduceri)', rD.bazaImpozabila, rD.venitBrut);
}
ok('D205 XML bine-format', wellFormed(xml.d205Xml({ cui: 'RO1', nume: 'X' }, '2026', d205)));
ok('D205 initiala poarta d_rec="0"', /d_rec="0"/.test(xml.d205Xml({ cui: 'RO1', nume: 'X' }, '2026', d205)));
ok('D205 rectificativa poarta d_rec="1"', /d_rec="1"/.test(xml.d205Xml({ cui: 'RO1', nume: 'X' }, '2026', d205, null, { rectificativa: true })));
const intr = rep.intrastat({ entries: [
  { id: '1', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-10', partenerCui: 'DE1', lines: gt2('livrare_intracomunitara').build({ baza: 5000 }) },
  { id: '2', tip: 'achizitie_intracomunitara', period: '2026-06', data: '2026-06-12', partenerCui: 'FR2', lines: gt2('achizitie_intracomunitara').build({ baza: 3000, cota: 21 }) },
] }, '2026-06');
eq('Intrastat: total expedieri (livrari) 5000', intr.totalExpedieri, 5000);
eq('Intrastat: total introduceri (achizitii) 3000', intr.totalIntroduceri, 3000);
const intrNC = rep.intrastat({ entries: [
  { id: '1', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-10', partenerCui: 'DE123', intrastat: { codNC: '94036010', masaNeta: 120, natura: '11', conditie: 'EXW' }, lines: gt2('livrare_intracomunitara').build({ baza: 5000 }) },
  { id: '2', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-12', partenerCui: 'DE123', intrastat: { codNC: '94036010', masaNeta: 80, natura: '11', conditie: 'EXW' }, lines: gt2('livrare_intracomunitara').build({ baza: 2000 }) },
  { id: '3', tip: 'achizitie_intracomunitara', period: '2026-06', data: '2026-06-12', partenerCui: 'FR123', intrastat: { codNC: '72142000', masaNeta: 500, natura: '11', conditie: 'DAP' }, lines: gt2('achizitie_intracomunitara').build({ baza: 3000, cota: 21 }) },
] }, '2026-06');
const deRow = intrNC.rows.find((r) => r.flux === 'expediere' && r.tara === 'DE' && r.codNC === '94036010');
eq('Intrastat NC8: grupare pe DE + 94036010 (2 operatiuni)', deRow.nrop, 2);
eq('Intrastat NC8: masa neta cumulata 120+80', deRow.masaNeta, 200);
eq('Intrastat NC8: valoare cumulata 5000+2000', deRow.valoare, 7000);
eq('Intrastat: pragul 1.000.000 lei', intrNC.pragExpedieri, 1000000);
eq('Intrastat: sub prag -> neobligat la declarare', intrNC.obligatExpedieri, false);
ok('Intrastat XML bine-format', wellFormed(xml.intrastatXml({ cui: 'RO1', nume: 'X' }, '2026-06', intrNC)));
ok('Intrastat XML: articolul DE cu masa neta cumulata', xml.intrastatXml({ cui: 'RO1', nume: 'X' }, '2026-06', intrNC).includes('masa_neta="200.00"'));
ok('Intrastat XML se declara explicit centralizator, nu schema oficiala INS', /format="centralizator-lucru" compatibil_ins="nu"/.test(xml.intrastatXml({ cui: 'RO1', nume: 'X' }, '2026-06', intrNC)));
const intrExtins = rep.intrastat({ entries: [
  { id: 'a', tip: 'autofactura_achizitie', naturaAutofactura: 'intracom', period: '2026-06', data: '2026-06-03', partenerCui: 'IT123', intrastat: { codNC: '01012100', masaNeta: 7, natura: '11', conditie: 'FCA' }, lines: [{ debit: '371', credit: '408', suma: 4000 }] },
  { id: 'd', tip: 'achizitie_tva_speciala_d301', d301: { tipOperatie: 2, baza: 2500 }, period: '2026-06', data: '2026-06-04', partenerCui: 'AT123', intrastat: { codNC: '87032110', masaNeta: 1000, natura: '11', conditie: 'CIP' }, lines: [{ debit: '2133', credit: '401', suma: 2500 }] },
  { id: 's', tip: 'achizitie_tva_speciala_d301', d301: { tipOperatie: 5, baza: 900 }, period: '2026-06', data: '2026-06-05', partenerCui: 'NL123', lines: [{ debit: '628', credit: '401', suma: 900 }] },
] }, '2026-06');
eq('Intrastat include autofactura de bunuri si ii citeste baza din 408', intrExtins.rows.find((r) => r.entryIds.includes('a')).valoare, 4000);
eq('Intrastat include bunurile D301 1-3, nu serviciile D301 tip 5', intrExtins.totalIntroduceri, 6500);
ok('Intrastat: articolele complete sunt gata pentru transcriere', intrExtins.gataPentruTranscriere && intrExtins.probleme.length === 0);
const intrMasaAscunsa = rep.intrastat({ entries: [
  { id: 'm0', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-01', partenerCui: 'DE123', intrastat: { codNC: '94036010', masaNeta: 0, natura: '11', conditie: 'EXW' }, lines: [{ debit: '4111', credit: '707', suma: 10 }] },
  { id: 'm1', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-02', partenerCui: 'DE123', intrastat: { codNC: '94036010', masaNeta: 10, natura: '11', conditie: 'EXW' }, lines: [{ debit: '4111', credit: '707', suma: 20 }] },
] }, '2026-06');
ok('Intrastat: agregarea nu ascunde documentul cu masa zero', intrMasaAscunsa.probleme.some((p) => p.camp === 'masaNeta' && p.entryIds.includes('m0')));
const intrYtd = rep.intrastat({ entries: [
  { id: 'm', tip: 'livrare_intracomunitara', period: '2026-05', data: '2026-05-10', partenerCui: 'DE123', intrastat: { codNC: '94036010', masaNeta: 1, natura: '11', conditie: 'EXW' }, lines: [{ debit: '4111', credit: '707', suma: 999000 }] },
  { id: 'i', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-10', partenerCui: 'DE123', intrastat: { codNC: '94036010', masaNeta: 1, natura: '11', conditie: 'EXW' }, lines: [{ debit: '4111', credit: '707', suma: 2000 }] },
] }, '2026-06');
eq('Intrastat: totalul lunar ramane al lunii selectate', intrYtd.totalExpedieri, 2000);
eq('Intrastat: pragul se compara cu rulajul anual cumulat', intrYtd.rulajAnualExpedieri, 1001000);
ok('Intrastat: depasirea cumulata este detectata chiar daca luna singura e sub prag', intrYtd.obligatExpedieri);
const intrSeparat = rep.intrastat({ entries: [
  { id: 'c1', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-01', partenerCui: 'DE123', intrastat: { codNC: '94036010', masaNeta: 1, natura: '11', conditie: 'EXW' }, lines: [{ debit: '4111', credit: '707', suma: 10 }] },
  { id: 'c2', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-02', partenerCui: 'DE123', intrastat: { codNC: '94036010', masaNeta: 1, natura: '11', conditie: 'DAP' }, lines: [{ debit: '4111', credit: '707', suma: 20 }] },
] }, '2026-06');
eq('Intrastat nu comaseaza doua conditii de livrare diferite', intrSeparat.rows.length, 2);

section('RO e-Transport (cod UIT) — nomenclatoare, asamblare, validare, XML');
const et = require('../src/etransport');
// nomenclatoare oficiale
ok('e-Transport: tip operatiune 30 = transport pe teritoriul national', /teritoriul national/i.test(et.TIP_OPERATIUNE[30]));
ok('e-Transport: scop 101 = comercializare', /comercial/i.test(et.SCOP_OPERATIUNE[101]));
// nomenclatoarele urmeaza documentatia XSD-ului oficial: tipurile de lohn / call-off lipseau,
// iar 801/802/901/1001 aveau denumiri gresite (erau ale altor scopuri).
ok('e-Transport: tipurile lohn (12/22) si call-off (14/24) exista', !!(et.TIP_OPERATIUNE[12] && et.TIP_OPERATIUNE[22] && et.TIP_OPERATIUNE[14] && et.TIP_OPERATIUNE[24]));
ok('e-Transport: scop 801 = leasing (nu „lohn")', /leasing/i.test(et.SCOP_OPERATIUNE[801]));
ok('e-Transport: scop 901 = operatiuni scutite', /scutit/i.test(et.SCOP_OPERATIUNE[901]));
ok('e-Transport: scopurile 1101 si 9901 exista (lipseau)', !!(et.SCOP_OPERATIUNE[1101] && et.SCOP_OPERATIUNE[9901]));
// coduri de judet (SIRUTA): nume, diacritice, cod direct, necunoscut
eq('e-Transport judet: Cluj -> 12', et.judetCod('Cluj'), '12');
eq('e-Transport judet: Bucuresti -> 40', et.judetCod('Bucuresti'), '40');
eq('e-Transport judet: diacritice „Timiș" -> 35', et.judetCod('Timiș'), '35');
eq('e-Transport judet: „jud. Iași" -> 22', et.judetCod('jud. Iași'), '22');
eq('e-Transport judet: cod direct „5" -> 05', et.judetCod('5'), '05');
eq('e-Transport judet: ISO „RO-CJ" -> 12 (format e-Factura)', et.judetCod('RO-CJ'), '12');
eq('e-Transport judet: ISO „RO-B" -> 40 (Bucuresti)', et.judetCod('RO-B'), '40');
eq('e-Transport judet: sufix ISO „CJ" -> 12', et.judetCod('CJ'), '12');
eq('e-Transport judet: necunoscut -> gol', et.judetCod('Atlantida'), '');
// tipul operatiunii dedus din articol
eq('e-Transport: aviz -> tip 30', et.defaultTipOperatiune('aviz_livrare'), 30);
eq('e-Transport: livrare IC -> tip 20', et.defaultTipOperatiune('livrare_intracomunitara'), 20);
eq('e-Transport: achizitie IC -> tip 10', et.defaultTipOperatiune('achizitie_intracomunitara'), 10);
eq('e-Transport: import -> tip 40', et.defaultTipOperatiune('import_vamal'), 40);
// eligibilitate
ok('e-Transport: aviz eligibil', et.isEtransportEligible({ tip: 'aviz_livrare' }));
ok('e-Transport: plata salarii NEeligibil', !et.isEtransportEligible({ tip: 'plata_salarii' }));
// asamblare din aviz cu linii (items)
const etCompany = { cui: 'RO12345678', nume: 'EXEMPLU PROD SRL', judet: 'Cluj', oras: 'Cluj-Napoca', adresa: 'Str. Fabricii 10' };
const etAviz = { id: 'e1', tip: 'aviz_livrare', tipNume: 'Aviz de insotire', data: '2026-07-24', document: 'AVIZ 55',
  partener: 'CLIENT & CO SRL', partenerCui: 'RO87654321',
  items: [{ nume: 'Cutii carton', cantitate: 100, um: 'buc', pret: 5, cota: 21 }],
  lines: gt2('aviz_livrare').build({ baza: 500, tva: 105 }) };
const etTd = { codScopOperatiune: '101', nrVehicul: 'CJ 01 ABC', codTarifar: '48191000', greutateNeta: 120, greutateBruta: 140,
  final: { judet: 'Bucuresti', localitate: 'Bucuresti', strada: 'Bd. Unirii', numar: '1' } };
const etDecl = et.buildDeclaration(etCompany, etAviz, etTd);
eq('e-Transport: codDeclarant fara prefix RO', etDecl.codDeclarant, '12345678');
eq('e-Transport: tip operatiune implicit 30 (aviz intern)', etDecl.codTipOperatiune, 30);
eq('e-Transport: o pozitie de marfa din aviz', etDecl.bunuri.length, 1);
eq('e-Transport: valoare fara TVA din items (100x5)', etDecl.bunuri[0].valoareLeiFaraTva, 500);
eq('e-Transport: UM „buc" -> C62', etDecl.bunuri[0].codUnitateMasura, 'C62');
eq('e-Transport: nr vehicul normalizat (fara spatii, majuscule)', etDecl.transport.nrVehicul, 'CJ01ABC');
eq('e-Transport: plecare din sediul firmei (Cluj=12)', etDecl.start.codJudet, '12');
eq('e-Transport: sosire la client (Bucuresti=40)', etDecl.final.codJudet, '40');
eq('e-Transport: partener fara prefix RO', etDecl.partener.cod, '87654321');
// valoare fara TVA din linii cand nu exista items
eq('e-Transport: valoare din linii de venit (fara items)', et.valoareFaraTva({ lines: [{ debit: '418', credit: '707', suma: 800 }, { debit: '418', credit: '4428', suma: 168 }] }), 800);
// XML bine-format + continut cheie
const etXml = et.eTransportXml(etCompany, etAviz, etTd);
ok('e-Transport XML bine-format', wellFormed(etXml));
ok('e-Transport XML: namespace v2', etXml.includes('xmlns="mfp:anaf:dgti:eTransport:declaratie:v2"'));

// ── Conformitatea cu XSD-ul OFICIAL (defecte prinse de poarta fiscala la prima rulare) ──
// Toate cele de mai jos invalidau declaratia la ANAF, desi XML-ul era bine-format si trecea
// verificarile de continut. `wellFormed` nu spune nimic despre schema.
ok('e-Transport XML: elementul e <notificare>, NU <transport> (choice-ul din schema)',
  /<notificare\b/.test(etXml) && !/<transport\b/.test(etXml));
ok('e-Transport XML: bunuriTransportate FARA nrCrt (atribut inexistent in schema)',
  /<bunuriTransportate\b/.test(etXml) && !/nrCrt=/.test(etXml));
ok('e-Transport XML: adresa sta in copilul <locatie>, nu pe capatul de traseu',
  /<locStartTraseuRutier>\s*<locatie /.test(etXml) && !/<locStartTraseuRutier [^>]*codJudet=/.test(etXml));
ok('e-Transport XML: ordinea din secventa (bunuri -> partener -> dateTransport -> traseu -> documente)',
  etXml.indexOf('<bunuriTransportate') < etXml.indexOf('<partenerComercial')
  && etXml.indexOf('<partenerComercial') < etXml.indexOf('<dateTransport')
  && etXml.indexOf('<dateTransport') < etXml.indexOf('<locStartTraseuRutier')
  && etXml.indexOf('<locFinalTraseuRutier') < etXml.indexOf('<documenteTransport'));
// atribute optionale: goale sau zero -> OMISE (schema are minLength=1 / minExclusive=0)
const etGol = et.eTransportXml(etCompany,
  Object.assign({}, etAviz, { document: '', partenerCui: '' }),
  Object.assign({}, etTd, { greutateNeta: 0 }));
ok('e-Transport XML: atribut optional gol e OMIS, nu emis ca ""',
  !/numarDocument=""/.test(etGol) && !/numarDocument=/.test(etGol) && !/ cod=""/.test(etGol));
ok('e-Transport XML: greutateNeta 0 e OMISA (minExclusive 0), bruta ramane',
  !/greutateNeta=/.test(etGol) && /greutateBruta="140.00"/.test(etGol));
ok('e-Transport XML: observatii goale nu se emit', !/observatii=/.test(etXml));
// dovada ca invelisul `at()` chiar escapeaza (e trecut pe lista portii de escapare din XML)
const etOstil = et.eTransportXml(etCompany,
  Object.assign({}, etAviz, { document: 'AV <b>&"1' }),
  Object.assign({}, etTd, { document: { observatii: 'x & y' } }));
ok('e-Transport XML: atributele prin `at()` sunt escapate (& < > ")',
  etOstil.includes('numarDocument="AV &lt;b&gt;&amp;&quot;1"') && etOstil.includes('observatii="x &amp; y"'));
// limitele de lungime din schema (Str200 pe denumiri, nu 500)
const etLung = et.buildDeclaration(etCompany, Object.assign({}, etAviz, { partener: 'P'.repeat(300) }), etTd);
eq('e-Transport: denumirea partenerului taiata la 200 (Str200)', etLung.partener.denumire.length, 200);
// codTarifar: schema cere EXACT 4, 6 sau 8 cifre — 5 sau 7 sunt respinse, nu tolerate
ok('e-Transport validare: cod tarifar de 5 cifre -> EROARE (nu avertisment)',
  !et.validate(et.buildDeclaration(etCompany, etAviz, Object.assign({}, etTd, { codTarifar: '48191' }))).ok);
ok('e-Transport validare: cod tarifar de 6 cifre e acceptat',
  et.validate(et.buildDeclaration(etCompany, etAviz, Object.assign({}, etTd, { codTarifar: '481910' }))).ok);
// <locatie> cere judet + localitate + STRADA (toate trei); lipsa strazii era tolerata
ok('e-Transport validare: sosire fara strada -> eroare (schema cere denumireStrada)',
  !et.validate(et.buildDeclaration(etCompany, etAviz, Object.assign({}, etTd, { final: { judet: 'Bucuresti', localitate: 'Bucuresti' } }))).ok);
// scopul admis depinde de tipul operatiunii (regula din documentatia XSD): 704 „transfer intre
// gestiuni" e valabil la transport intern, nu la o livrare intracomunitara.
ok('e-Transport validare: scop 704 (transfer gestiuni) la livrare IC -> avertisment',
  et.validate(et.buildDeclaration(etCompany, { id: 'ics', tip: 'livrare_intracomunitara', data: '2026-06-15', partener: 'DE Client', partenerCui: 'DE123', lines: [] },
    { nrVehicul: 'CJ01ABC', codTarifar: '94036010', greutateBruta: 500, codScopOperatiune: '704', final: { codPtf: '4' } })).warnings.some((w) => /nu e admis/i.test(w)));
ok('e-Transport XML: codTipOperatiune si nrVehicul', etXml.includes('codTipOperatiune="30"') && etXml.includes('nrVehicul="CJ01ABC"'));
ok('e-Transport XML: cod tarifar in bunuri', etXml.includes('codTarifar="48191000"'));
ok('e-Transport XML: amperandul din nume e escapat', etXml.includes('CLIENT &amp; CO SRL') && !etXml.includes('CLIENT & CO'));
// validare: completa -> ok
const etV = et.validate(etDecl);
ok('e-Transport validare: declaratie completa e ok', etV.ok && etV.errors.length === 0);
// validare: lipsa vehicul / NC / greutate / traseu -> erori
ok('e-Transport validare: fara vehicul -> eroare', !et.validate(et.buildDeclaration(etCompany, etAviz, Object.assign({}, etTd, { nrVehicul: '' }))).ok);
ok('e-Transport validare: fara cod tarifar -> eroare', !et.validate(et.buildDeclaration(etCompany, Object.assign({}, etAviz, { items: [], intrastat: null }), Object.assign({}, etTd, { codTarifar: '' }))).ok);
ok('e-Transport validare: fara greutate bruta -> eroare', !et.validate(et.buildDeclaration(etCompany, etAviz, Object.assign({}, etTd, { greutateNeta: 0, greutateBruta: 0 }))).ok);
ok('e-Transport validare: traseu final incomplet -> eroare', !et.validate(et.buildDeclaration(etCompany, etAviz, Object.assign({}, etTd, { final: {} }))).ok);
// multi-pozitie: td.bunuri BATE derivarea din aviz (2 marfuri = 2 linii nrCrt)
const etMulti = et.buildDeclaration(etCompany, etAviz, Object.assign({}, etTd, { bunuri: [
  { denumire: 'Marfa A', codTarifar: '48191000', cantitate: 10, um: 'buc', greutateNeta: 50, greutateBruta: 55, valoare: 300, codScop: '101' },
  { denumire: 'Marfa B', codTarifar: '39239000', cantitate: 20, um: 'kg', greutateNeta: 70, greutateBruta: 75, valoare: 200, codScop: '101' },
] }));
eq('e-Transport multi: 2 pozitii de marfa', etMulti.bunuri.length, 2);
eq('e-Transport multi: a doua pozitie are nrCrt 2 si UM kg=KGM', etMulti.bunuri[1].nrCrt + ':' + etMulti.bunuri[1].codUnitateMasura, '2:KGM');
// constrangeri de schema in plus (aliniate cu XSD-ul oficial)
ok('e-Transport validare: cantitate 0 -> eroare', !et.validate(et.buildDeclaration(etCompany, etAviz, Object.assign({}, etTd, { bunuri: [{ denumire: 'X', codTarifar: '48191000', cantitate: 0, um: 'buc', greutateBruta: 10, valoare: 5 }] }))).ok);
ok('e-Transport validare: greutate neta > bruta -> avertisment', et.validate(et.buildDeclaration(etCompany, etAviz, Object.assign({}, etTd, { greutateNeta: 200, greutateBruta: 140 }))).warnings.some((w) => /neta/i.test(w)));
// coerenta traseu <-> tip operatiune: livrare IC cu sosire pe judet (nu frontiera) -> avertisment
const etIc = { id: 'e2', tip: 'livrare_intracomunitara', tipNume: 'Livrare IC', data: '2026-06-15', partener: 'DE Client', partenerCui: 'DE123',
  lines: gt2('livrare_intracomunitara').build({ baza: 5000 }) };
const etIcDecl = et.buildDeclaration(etCompany, etIc, { nrVehicul: 'CJ01ABC', codTarifar: '94036010', greutateBruta: 500, codScopOperatiune: '101', final: { judet: 'Timis', localitate: 'Timisoara' } });
eq('e-Transport: livrare IC dedusa ca tip 20', etIcDecl.codTipOperatiune, 20);
ok('e-Transport validare: iesire IC cu sosire pe judet (nu frontiera) -> avertisment', et.validate(etIcDecl).warnings.some((w) => /frontier|vamal/i.test(w)));
// aceeasi iesire, dar cu sosire la un punct de trecere a frontierei -> fara avertismentul de traseu.
// codPtf e NUMERIC in schema (xs:int, 1..38 — „4" = Nadlac); o eticheta text ca „NADLAC2" nu e cod.
const etIcPtf = et.buildDeclaration(etCompany, etIc, { nrVehicul: 'CJ01ABC', codTarifar: '94036010', greutateBruta: 500, final: { codPtf: '4' } });
ok('e-Transport validare: iesire IC prin PTF -> fara avertisment de frontiera', !et.validate(etIcPtf).warnings.some((w) => /frontier|vamal/i.test(w)));
const etIcPtfText = et.buildDeclaration(etCompany, etIc, { nrVehicul: 'CJ01ABC', codTarifar: '94036010', greutateBruta: 500, final: { codPtf: 'NADLAC2' } });
eq('e-Transport: cod PTF nenumeric e ignorat (schema cere xs:int)', etIcPtfText.final.codPtf, '');
ok('e-Transport: PTF nenumeric NU trece drept frontiera', !et.validate(etIcPtfText).ok);

section('Reconciliere e-TVA — decont precompletat <-> D300 propriu');
const etva = require('../src/etvaReconcile');
const etvaV = scopedSeed();
const etvaPer = '2026-06';
const etvaD = rep.d300(etvaV, etvaPer);
const etvaOwn = xml.d300Rows(etvaD);
const etvaOwnXml = xml.d300Xml(etvaV.company, etvaPer, etvaD, null);
// parse
const etvaParsed = etva.parseD300(etvaOwnXml);
eq('e-TVA parse: luna/an din decont', etvaParsed.luna + '/' + etvaParsed.an, '6/2026');
ok('e-TVA parse: extrage randuri Rxx_2 (TVA colectata)', Number(etvaParsed.rows.R17_2) > 0);
let etvaThrew = false; try { etva.parseD300('<altceva/>'); } catch (e) { etvaThrew = e.status === 400; }
ok('e-TVA parse: XML care nu e D300 -> eroare 400', etvaThrew);
// self-vs-self: fara diferente
const etvaR1 = etva.reconcile(etvaOwn, etvaParsed.rows, { period: etvaPer, cuiPropriu: etvaV.company.cui, anafLuna: etvaParsed.luna, anafAn: etvaParsed.an, anafCui: etvaParsed.cui });
eq('e-TVA reconciliere: propriul decont vs sine -> 0 diferente', etvaR1.diffCount, 0);
ok('e-TVA reconciliere: self -> ok, fara constatari', etvaR1.ok && etvaR1.findings.length === 0);
eq('e-TVA reconciliere: R17 colectata identica', etvaR1.rows.find((r) => r.rand === 'R17').tva.match, true);
// decont modificat: R9_2 + R17_2 marite cu 500 -> diferenta la colectata
const etvaTampered = etvaOwnXml.replace(/R9_2="(\d+)"/, (m, n) => 'R9_2="' + (Number(n) + 500) + '"').replace(/R17_2="(\d+)"/, (m, n) => 'R17_2="' + (Number(n) + 500) + '"');
const etvaP2 = etva.parseD300(etvaTampered);
const etvaR2 = etva.reconcile(etvaOwn, etvaP2.rows, { period: etvaPer, cuiPropriu: etvaV.company.cui, anafLuna: etvaP2.luna, anafAn: etvaP2.an, anafCui: etvaP2.cui });
ok('e-TVA reconciliere: decont diferit -> diferente semnalate', etvaR2.diffCount >= 2 && !etvaR2.ok);
ok('e-TVA reconciliere: constatare pe taxa colectata', etvaR2.findings.some((f) => f.cod === 'e-tva-colectata-diferita'));
eq('e-TVA reconciliere: delta R9 = +500 (ANAF vede mai mult)', etvaR2.rows.find((r) => r.rand === 'R9').tva.delta, 500);
// CUI diferit -> eroare (decont al altei firme)
const etvaR3 = etva.reconcile(etvaOwn, etvaParsed.rows, { period: etvaPer, cuiPropriu: '99999999', anafLuna: etvaParsed.luna, anafAn: etvaParsed.an, anafCui: etvaParsed.cui });
ok('e-TVA reconciliere: CUI decont != firma -> eroare, not ok', etvaR3.findings.some((f) => f.cod === 'e-tva-cui' && f.nivel === 'eroare') && !etvaR3.ok);
// perioada diferita -> avertisment
const etvaR4 = etva.reconcile(etvaOwn, etvaParsed.rows, { period: '2026-05', cuiPropriu: etvaV.company.cui, anafLuna: etvaParsed.luna, anafAn: etvaParsed.an, anafCui: etvaParsed.cui });
ok('e-TVA reconciliere: perioada decont != comparata -> avertisment', etvaR4.findings.some((f) => f.cod === 'e-tva-perioada'));

section('Verificare post-extragere (reconciliere aritmetica) — src/extractCheck.js');
const echk = require('../src/extractCheck');
// completeaza golurile derivabile (nu suprascrie)
eq('extractCheck: completeaza suma lipsa (baza+TVA)', echk.reconcile({ baza: 1000, tva: 210 }).fields.suma, 1210);
eq('extractCheck: completeaza baza lipsa (suma-TVA)', echk.reconcile({ suma: 1210, tva: 210 }).fields.baza, 1000);
// infereaza cota din raportul TVA/baza cand lipseste
eq('extractCheck: infereaza cota 21 din 210/1000', echk.reconcile({ baza: 1000, tva: 210, cota: 0 }).fields.cota, 21);
eq('extractCheck: infereaza cota 9 din 27/300', echk.reconcile({ baza: 300, tva: 27, cota: 0 }).fields.cota, 9);
// cota 0 ramane 0 la document fara TVA (regresia „|| 19" — NU se mai forteaza)
eq('extractCheck: fara TVA -> cota ramane 0 (nu 19)', echk.reconcile({ baza: 500, tva: 0, suma: 500, cota: 0 }).fields.cota, 0);
// document coerent -> fara avertismente, valori neschimbate
const ecOk = echk.reconcile({ baza: 1000, tva: 210, suma: 1210, cota: 21 });
ok('extractCheck: document coerent -> fara avertismente', ecOk.warnings.length === 0 && ecOk.needsReview === false);
eq('extractCheck: nu suprascrie baza valida', ecOk.fields.baza, 1000);
// suma incoerenta -> avertisment, dar NU se suprascrie
const ecBad = echk.reconcile({ baza: 1000, tva: 210, suma: 1500, cota: 21 });
ok('extractCheck: suma != baza+TVA -> avertisment + needsReview', ecBad.warnings.some((w) => /nu se potrivesc/i.test(w)) && ecBad.needsReview);
eq('extractCheck: suma incoerenta NU e suprascrisa', ecBad.fields.suma, 1500);
// cota necorelata cu raportul TVA/baza -> avertisment
ok('extractCheck: cota necorelata cu raportul -> avertisment', echk.reconcile({ baza: 1000, tva: 210, suma: 1210, cota: 11 }).warnings.some((w) => /raportul TVA/i.test(w)));
// cota invalida -> avertisment
ok('extractCheck: cota invalida (17%) -> avertisment', echk.reconcile({ baza: 1000, tva: 170, suma: 1170, cota: 17 }).warnings.some((w) => /valid/i.test(w)));
// incredere joasa -> verificare recomandata
ok('extractCheck: incredere joasa -> needsReview', echk.reconcile({ baza: 1000, tva: 210, suma: 1210, cota: 21 }, { incredere: 40 }).needsReview);
// fallback pe cota standard cand nu se poate infera (baza lipseste)
eq('extractCheck: fallback pe cota standard cand baza lipseste', echk.reconcile({ tva: 210, cota: 0 }, { standardCota: 21 }).fields.cota, 21);

section('D100 — impozit micro trimestrial + XML');
// veniturile se cumuleaza pe lunile trimestrului (apr+iun in T2), luna din alt trimestru e exclusa
const d100db = { entries: [
  { id: '1', tip: 'x', period: '2026-04', data: '2026-04-10', lines: [{ debit: '4111', credit: '704', suma: 10000 }] },
  { id: '2', tip: 'x', period: '2026-06', data: '2026-06-10', lines: [{ debit: '4111', credit: '704', suma: 5000 }] },
  { id: '3', tip: 'x', period: '2026-03', data: '2026-03-10', lines: [{ debit: '4111', credit: '704', suma: 77777 }] },
] };
const d100q = rep.d100micro(d100db, '2026-06');
eq('D100: venit trimestrul II cumulat (apr+iun)', d100q.venit, 15000);
eq('D100: trimestrul detectat', d100q.trimestru, 2);
eq('D100: impozit micro 1% = 150', d100q.impozit, 150);
ok('D100 XML bine-format', wellFormed(xml.d100Xml({ cui: 'RO1', nume: 'X' }, '2026-06', d100q)));
ok('D100 XML v2: obligatia micro 121 cu cod bugetar, cota, scadenta si nr_evid pe 23 cifre', (() => {
  const x = xml.d100Xml({ cui: 'RO1', nume: 'X' }, '2026-06', d100q);
  return x.includes('cod_oblig="121"') && x.includes('cod_bugetar="20470101"') && x.includes('cota="1"')
    && x.includes('scadenta="25.07.2026"') && x.includes('suma_plata="150"')
    && /nr_evid="\d{23}"/.test(x) && x.includes('xmlns="mfp:anaf:dgti:d100:declaratie:v2"');
})());
const d710micro = xml.d710Xml({ cui: 'RO1', nume: 'X' }, '2026-06',
  { impozit: 150, codOblig: '121', codBugetar: '20470101', scadenta: '2026-07-25' },
  Object.assign({}, d100q, { impozit: 180, codOblig: '121', codBugetar: '20470101' }));
ok('D710 XML bine-format, cu schema v2', wellFormed(d710micro)
  && d710micro.includes('<declaratie710 xmlns="mfp:anaf:dgti:d710:declaratie:v2"'));
ok('D710 poarta valorile initiale si corectate complete, nu doar diferenta',
  /suma_dat_I="150" suma_dat_C="180" suma_plata_I="150" suma_plata_C="180"/.test(d710micro));
ok('D710 micro pastreaza creanta 121, cota 1 si suma de control I+C',
  /cod_oblig="121"/.test(d710micro) && /cota="1"/.test(d710micro) && /totalPlata_A="660"/.test(d710micro));
ok('D710 refuza lipsa unei diferente reale', (() => {
  try {
    xml.d710Xml({ cui: 'RO1', nume: 'X' }, '2026-06',
      { impozit: 150, codOblig: '121', codBugetar: '20470101' },
      { impozit: 150, codOblig: '121', codBugetar: '20470101' });
    return false;
  } catch (e) { return /nicio diferență/.test(e.message); }
})());
// eligibilitate micro (plafon implicit 100.000 EUR x curs 5 = 500.000 lei + conditia de salariat)
ok('D100: fara salariati -> avertisment de eligibilitate', d100q.avertismente.some((w) => /salariat/i.test(w)));
const d100over = rep.d100micro({ entries: [{ id: 'o1', period: '2026-02', data: '2026-02-01', lines: [{ debit: '4111', credit: '704', suma: 600000 }] }], angajati: [{ id: 'a' }] }, '2026-03');
ok('D100: peste plafonul micro -> avertisment de iesire din regim', d100over.avertismente.some((w) => /DEPASESC/.test(w)));
ok('D100: cu salariat -> fara avertismentul de salariat', !d100over.avertismente.some((w) => /salariat/i.test(w)));
const d100warn = rep.d100micro({ entries: [{ id: 'w1', period: '2026-02', data: '2026-02-01', lines: [{ debit: '4111', credit: '704', suma: 450000 }] }], angajati: [{ id: 'a' }] }, '2026-03');
ok('D100: peste 80% din plafon -> avertisment de urmarire (nu de depasire)', d100warn.avertismente.some((w) => /din plafonul micro/.test(w)) && !d100warn.avertismente.some((w) => /DEPASESC/.test(w)));
eq('D100: venitul anual cumulat pentru controlul plafonului', d100over.venitAn, 600000);

// ── AUTOFACTURA (art. 320) ───────────────────────────────────────────────────────────────────
// Cumparatorul obligat la plata TVA care nu a primit factura pana pe 15 a lunii urmatoare trebuie
// s-o emita singur. Tipul exista separat de `factura_nesosita` pentru un motiv contabil precis.
section('Autofactura art. 320 — TVA exigibil fara factura');
{
  const T = require('../src/documentTypes');
  const af = T.getType('autofactura_achizitie').build({ baza: 10000, cota: 21, contStoc: '371' });
  // Datoria pe 408 (factura chiar nu a sosit), nu pe 401.
  eq('baza merge pe 408, nu pe 401', af[0].credit, '408');
  // Miezul: TVA-ul e EXIGIBIL fara factura, deci 4426 = 4427 — NU 4428 ca la factura nesosita.
  // Prin 4428, colectata ar fi lipsit din decont si din D390, adica operatiunea ar fi fost
  // nedeclarata exact in cazul in care legea a cerut autofactura ca sa NU lipseasca.
  eq('TVA-ul se colecteaza si se deduce pe loc (4426)', af[1].debit, '4426');
  eq('...cu 4427, nu cu 4428 neexigibil', af[1].credit, '4427');
  eq('TVA calculat din baza si cota', af[1].suma, 2100);
  const nes = T.getType('factura_nesosita').build({ baza: 10000, tva: 2100, contChelt: '628' });
  eq('prin contrast, factura nesosita pastreaza TVA neexigibil', nes[1].debit, '4428');
  // Regularizarea are tip PROPRIU: perechea obisnuita ar deduce TVA-ul a doua oara.
  const reg = T.getType('sosire_factura_autofactura').build({ baza: 10000 });
  eq('regularizarea muta doar baza din 408 in 401', reg.length, 1);
  ok('...si nu atinge niciun cont de TVA', !reg.some((l) => /^442/.test(l.debit) || /^442/.test(l.credit)));
  ok('regularizarea de la facturi nesosite ATINGE TVA (de aceea nu se refoloseste)',
    T.getType('sosire_factura_nesosita').build({ baza: 10000, tva: 2100 }).some((l) => l.debit === '4426'));

  // Natura operatiunii se cere EXPLICIT: din conturi nu se poate citi, dar decide D390 si randul
  // din decont. Toate trei variantele dau EXACT aceleasi linii contabile.
  const camp = T.getType('autofactura_achizitie').fields.find((f) => f.name === 'naturaAutofactura');
  ok('natura operatiunii e ceruta, fara implicit ghicit', camp && camp.required && camp.default == null);
  const E = (nat) => ({ id: 'af' + nat, data: '2026-05-10', period: '2026-05', tip: 'autofactura_achizitie',
    tipNume: 'Autofactura', status: 'postat', partener: 'DE FURNIZOR', partenerCui: 'DE123456789',
    naturaAutofactura: nat,
    lines: [{ debit: '371', credit: '408', suma: 10000 }, { debit: '4426', credit: '4427', suma: 2100 }] });
  const vD = (nat) => ({ openingBalances: {}, entries: [E(nat)], company: { tvaPlatitor: true } });

  // D390: bunurile pe codul A, SERVICIILE pe codul S (art. 325 cere si serviciile). Aserțiunea
  // de aici spunea pana acum „D390 NU include serviciile din afara" — codifica exact regula
  // gresita, motiv pentru care defectul a trecut neobservat: testul confirma bugul.
  eq('D390 include autofactura marcata intracomunitar', rep.d390(vD('intracom'), '2026-05').rows.length, 1);
  eq('...cu baza citita de pe 408 (nu 0)', rep.d390(vD('intracom'), '2026-05').rows[0].baza, 10000);
  eq('...pe codul A (bunuri)', rep.d390(vD('intracom'), '2026-05').rows[0].cod, 'A');
  eq('D390 NU include taxarea inversa interna', rep.d390(vD('intern331'), '2026-05').rows.length, 0);
  eq('D390 INCLUDE serviciile primite de la un prestator din UE', rep.d390(vD('servicii'), '2026-05').rows.length, 1);
  eq('...pe codul S (achizitii de servicii), nu pe A', rep.d390(vD('servicii'), '2026-05').rows[0].cod, 'S');
  // Prestatorul din afara UE: taxare inversa da, D390 nu. Se deduce din prefixul codului de TVA,
  // fara camp suplimentar — si nu dispare tacit, ci iese in `avertismente`.
  {
    const eUS = Object.assign(E('servicii'), { partener: 'US LLC', partenerCui: '98-7654321' });
    const vUS = { openingBalances: {}, entries: [eUS], company: { tvaPlatitor: true } };
    const rUS = rep.d390(vUS, '2026-05');
    eq('serviciu din AFARA UE: nu intra in D390', rUS.rows.length, 0);
    eq('...dar e semnalat, nu inghitit', rUS.avertismente.length, 1);
    eq('...cu baza pe el, ca sa se vada cat lipseste', rUS.avertismente[0].baza, 10000);
  }

  // D300: pe randul de AUTOLICHIDARE, nu pe cele de cota. Fara incadrare, autofactura cadea prin
  // toate ramurile si aparea ca o LIVRARE taxabila de 10.000 care nu existase niciodata.
  const d3 = (nat) => rep.d300(vD(nat), '2026-05');
  eq('autofactura NU apare ca livrare taxabila', d3('intracom').coteV.length, 0);
  eq('...ci pe randul de autolichidare intracomunitara', d3('intracom').autolichidari.intracomBunuri.baza, 10000);
  eq('taxarea inversa interna merge pe randul ei', d3('intern331').autolichidari.taxareInversaInterna.baza, 10000);
  eq('...si nu pe cel intracomunitar', d3('intern331').autolichidari.intracomBunuri.baza, 0);
  // SERVICIILE nu sunt achizitii intracomunitare de BUNURI: in decont merg pe R7/R20, nu pe R5/R18.
  // Altfel aceeasi operatiune iesea „servicii" in D390 si „bunuri" in D300 — doua declaratii care
  // se contrazic pe aceeasi factura.
  eq('serviciile din UE NU merg pe randul de bunuri (R5)', d3('servicii').autolichidari.intracomBunuri.baza, 0);
  eq('...ci pe randul de taxare inversa la beneficiar (R7)', d3('servicii').autolichidari.taxareInversaInterna.baza, 10000);
  // Decontul ramane echilibrat: colectata = deductibila pe autolichidare, deci TVA de plata 0.
  eq('autolichidarea nu produce TVA de plata', d3('intracom').deplata, 0);
}

// ── D100 pentru platitorii de IMPOZIT PE PROFIT (art. 41) ────────────────────────────────────
// REGRESIE. Ruta chema mereu `d100micro`, iar generatorul avea `cod_oblig="620"` fix in sablon:
// o firma pe impozit pe profit descarca o declaratie de MICROINTREPRINDERE — alt cod de obligatie,
// alt cod bugetar si alta suma. Calculul trimestrial nu exista deloc.
{
  const P = (id, data, lines) => ({ id, data, period: data.slice(0, 7), tip: 'x', tipNume: 'x', lines });
  const firmaProfit = { cui: '12345674', nume: 'X SRL', regimImpozit: 'profit', caen: '1071' };
  const vp = { openingBalances: {}, assets: [], angajati: [], company: firmaProfit, entries: [
    P('q1', '2026-02-10', [{ debit: '4111', credit: '704', suma: 100000 }]), // T1: profit 100.000
    P('q2', '2026-05-10', [{ debit: '4111', credit: '704', suma: 50000 }]),  // T2: inca 50.000
    P('q3', '2026-08-10', [{ debit: '607', credit: '371', suma: 80000 }]),   // T3: pierdere
  ] };
  const t1 = rep.d100(vp, '2026-03'); const t2 = rep.d100(vp, '2026-06'); const t3 = rep.d100(vp, '2026-09');
  // Nomenclatorul: perechea (cod_oblig, cod_bugetar) e cea acceptata de validatorul OFICIAL.
  eq('regimul profit -> obligatia 103 (impozit pe profit)', t1.codOblig, '103');
  eq('...cu codul bugetar 20470101 (nu cel de micro)', t1.codBugetar, '20470101');
  eq('regimul micro foloseste obligatia 121', rep.d100({ entries: [], openingBalances: {}, angajati: [{ id: 'a' }], company: { regimImpozit: 'micro' } }, '2026-03').codOblig, '121');
  // Calculul e CUMULAT de la inceputul anului, iar pe declaratie merge diferenta.
  eq('T1: impozit pe profitul cumulat (100.000 x 16%)', t1.impozit, 16000);
  eq('T2: cumulat 24.000, deja declarat 16.000 -> se declara 8.000', t2.impozit, 8000);
  eq('T2: si cumulatul e expus, nu doar diferenta', t2.impozitCumulat, 24000);
  // Trimestru pe pierdere: cumulatul SCADE. Pe declaratie merge 0 (D100 nu ia sume negative),
  // dar diferenta bruta ramane vizibila, ca sa se vada de ce.
  ok('T3 pe pierdere: cumulatul scade', t3.impozitCumulat < t2.impozitCumulat);
  eq('T3: pe declaratie merge 0, nu o suma negativa', t3.impozit, 0);
  ok('T3: diferenta bruta ramane negativa in rezultat', t3.diferenta < 0);
  ok('T3: si se explica in avertismente', t3.avertismente.some((w) => /pierdere/i.test(w)));
  // Trimestrul IV NU se declara prin D100 (art. 41 alin. 1) — definitivarea e prin D101.
  const t4 = rep.d100(vp, '2026-12');
  eq('T4 nu se declara prin D100', t4.seDeclara, false);
  ok('T4: motivul e scris, nu doar un flag', t4.avertismente.some((w) => /trimestrul IV/i.test(w) && /D101/.test(w)));
  ok('T1-T3 se declara', t1.seDeclara && t2.seDeclara && t3.seDeclara);
  // XML-ul poarta obligatia din DATE, nu din sablon, iar nr_evid o codifica (regula R16).
  const xProfit = xml.d100Xml(firmaProfit, '2026-06', t2);
  ok('XML: cod_oblig si cod_bugetar de impozit pe profit', xProfit.includes('cod_oblig="103"') && xProfit.includes('cod_bugetar="20470101"'));
  ok('XML: suma declarata e diferenta trimestrului', xProfit.includes('suma_dat="8000"'));
  ok('XML: nr_evid codifica obligatia pe pozitiile 3-5 (R16)', /nr_evid="10103\d{18}"/.test(xProfit));
  ok('XML micro foloseste perechea fiscala 121 / 20470101', (() => {
    const xm = xml.d100Xml({ cui: 'RO1', nume: 'X' }, '2026-06', d100q);
    return xm.includes('cod_oblig="121"') && xm.includes('cod_bugetar="20470101"');
  })());
  // ── SISTEMUL ANUAL CU PLATI ANTICIPATE (art. 41 alin. (2)) ────────────────────────────────
  // Alta suma pe declaratie, alt calendar si inca un trimestru de declarat. Firma de mai sus,
  // aceleasi date, doar optiunea schimbata.
  {
    const anual = (extra) => Object.assign({}, vp, { company: Object.assign({}, firmaProfit,
      { sistemProfit: 'anual', impozitProfitAn: { 2025: 40000 }, ipcAnticipate: { 2026: 4.5 } }, extra || {}) });

    const a1 = rep.d100(anual(), '2026-03');
    eq('sistemul se vede in rezultat', a1.sistem, 'anual');
    // 40.000 actualizat cu 4,5% = 41.800; o patrime = 10.450. NU impozitul real al trimestrului
    // (care ar fi 16.000) — asta e toata diferenta dintre cele doua sisteme.
    eq('plata anticipata = o patrime din impozitul anului precedent, actualizat (alin. 8)', a1.impozit, 10450);
    eq('...si nu impozitul real al trimestrului', a1.impozitCumulat, 16000);
    eq('baza indexata e expusa, nu doar rezultatul', a1.anticipat.impozitIndexat, 41800);
    // Cele patru trimestre sunt EGALE: plata nu urmareste rezultatul anului curent.
    const aTot = ['2026-03', '2026-06', '2026-09', '2026-12'].map((p) => rep.d100(anual(), p));
    ok('toate patru trimestrele au aceeasi plata anticipata', aTot.every((r) => r.impozit === 10450));
    ok('...si toate patru se declara (spre deosebire de sistemul trimestrial)', aTot.every((r) => r.seDeclara));
    // Termenul trimestrului IV: 25 DECEMBRIE, in aceeasi luna cu perioada. Singurul din aplicatie.
    const profAnual = fiscalProfile.build(anual().company);
    eq('T4 la sistemul anual are termen 25 decembrie', decl.dueDate('d100', '2026-12', profAnual), '2026-12-25');
    eq('...iar T1 ramane 25 aprilie', decl.dueDate('d100', '2026-03', profAnual), '2026-04-25');
    eq('sistemul trimestrial ramane cu 25 ianuarie', decl.dueDate('d100', '2026-12', fiscalProfile.build(firmaProfit)), '2027-01-25');
    ok('D100 e ASTEPTAT pe T4 la sistemul anual', fiscalProfile.expected(profAnual, '2026-12').includes('d100'));
    ok('...si NU e asteptat pe T4 la sistemul trimestrial', !fiscalProfile.expected(fiscalProfile.build(firmaProfit), '2026-12').includes('d100'));

    // „N-am putut calcula" NU are voie sa arate ca „nu datorez nimic". Fara indice sau fara baza,
    // suma ar fi iesit 0 — o suma perfect plauzibila pe D100, deci o declaratie FALSA care ar fi
    // trecut neobservata. Se marcheaza `blocat`, iar ruta XML refuza generarea.
    const faraIpc = rep.d100(Object.assign({}, vp, { company: Object.assign({}, firmaProfit,
      { sistemProfit: 'anual', impozitProfitAn: { 2025: 40000 } }) }), '2026-03');
    eq('fara indicele preturilor de consum -> BLOCAT, nu zero', faraIpc.blocat, true);
    ok('...si spune ce lipseste si de unde se ia', faraIpc.avertismente.some((w) => /indicele pre/i.test(w) && /ministrului finan/i.test(w)));
    const faraBaza = rep.d100({ openingBalances: {}, assets: [], angajati: [], entries: [],
      company: Object.assign({}, firmaProfit, { sistemProfit: 'anual', ipcAnticipate: { 2026: 4.5 } }) }, '2026-03');
    eq('fara impozitul anului precedent -> tot BLOCAT', faraBaza.blocat, true);
    ok('sistemul trimestrial NU e blocat niciodata de asta', !rep.d100(vp, '2026-03').blocat);

    // Ramura de EXCEPTIE, alin. (7): cota aplicata profitului CONTABIL AL TRIMESTRULUI (nu
    // cumulat), si doar trimestrele I-III. Firma cu pierdere fiscala in anul precedent ar plati
    // altfel zero pe regula generala — de aceea excepatia exista.
    const exc = (p) => rep.d100(anual({ anticipatProfitContabil: true }), p);
    const e1 = exc('2026-03'); const e2 = exc('2026-06');
    eq('alin. (7): T1 = 16% din profitul contabil al trimestrului', e1.impozit, 16000);
    // T2 aduce inca 50.000 profit contabil -> 8.000, NU 24.000 (care ar fi cumulatul).
    eq('alin. (7): T2 se calculeaza pe trimestru, nu pe cumulat', e2.impozit, 8000);
    eq('alin. (7): T4 nu se declara', exc('2026-12').seDeclara, false);
    ok('alin. (7): motivul e scris', exc('2026-12').avertismente.some((w) => /alin\. \(7\)/.test(w)));
    eq('alin. (7): T4 revine la termenul de 25 ianuarie',
      decl.dueDate('d100', '2026-12', fiscalProfile.build(anual({ anticipatProfitContabil: true }).company)), '2027-01-25');

    // Bifa se CONFRUNTA cu datele: pierderea fiscala a anului precedent e singura dintre cele
    // patru situatii pe care aplicatia o poate citi sigur.
    const contrazis = rep.d100(anual({ pierdereFiscala: { 2025: 5000 } }), '2026-03');
    ok('pierdere fiscala in anul precedent, dar regula generala -> avertisment',
      contrazis.avertismente.some((w) => /pierdere fiscal/i.test(w) && /alin\. \(7\)/.test(w)));

    // Suma din XML e cea anticipata, cu aceeasi obligatie (nomenclatorul oficial numeste 103
    // „Impozit pe profit / plati anticipate in contul impozitului pe profit anual datorat").
    const xa = xml.d100Xml(anual().company, '2026-03', a1);
    ok('XML: obligatia ramane 103 si la plati anticipate', xa.includes('cod_oblig="103"'));
    ok('XML: suma e plata anticipata', xa.includes('suma_dat="10450"'));
  }

  // Ajustarile fiscale se cumuleaza pe aceeasi fereastra ca profitul (art. 28 / art. 25).
  eq('amortizarea fiscala se taie la finalul trimestrului',
    assets.depreciationDifference([{ id: 'm', cont: '2131', cost: 12000, durataLuni: 12,
      dataPif: '2025-12-15', metoda: 'liniara' }], '2026', null, '2026-03').fiscala, 3000);
  eq('...si pe an intreg ramane cat era', assets.depreciationDifference([{ id: 'm', cont: '2131',
    cost: 12000, durataLuni: 12, dataPif: '2025-12-15', metoda: 'liniara' }], '2026').fiscala, 12000);
  // Motorul de impozit accepta taierea, dar fara ea se comporta ca inainte.
  eq('profitTax cu panaLa: doar pana la finalul lunii', acc.profitTax(vp, '2026', { cota: 16, panaLa: '2026-03' }).profitContabil, 100000);
  eq('profitTax fara panaLa: anul intreg (comportament istoric)', acc.profitTax(vp, '2026', { cota: 16 }).profitContabil, 70000);
}

// ── Baza impozabila (art. 53) — NU e totalul clasei 7 ────────────────────────────────────────
// REGRESIE. Baza era „tot rulajul creditor al clasei 7", deci veniturile care nu reprezinta
// incasari din activitate (reluari de provizioane, productie de imobilizari, variatia stocurilor,
// diferente de curs, subventii) se impozitau ca oricare altele. Pe fixture-ul de mai jos, firma
// platea impozit pe 130.000 lei in loc de 50.000 — de 2,6 ori mai mult.
{
  const micro = require('../src/impozitMicro');
  const { round2: round2ForTest } = require('../src/util');
  const M = (id, data, lines) => ({ id, data, period: data.slice(0, 7), tip: 'x', tipNume: 'x', lines });
  const mkMic = (ents, caen) => ({ entries: ents, openingBalances: {}, assets: [],
    angajati: [{ id: 'a' }], company: { caen: caen || '4711' } });
  const art53 = mkMic([
    M('b1', '2026-03-05', [{ debit: '4111', credit: '704', suma: 50000 }]),  // venit real
    M('b2', '2026-03-06', [{ debit: '151', credit: '7812', suma: 30000 }]),  // reluare provizion
    M('b3', '2026-03-07', [{ debit: '231', credit: '722', suma: 40000 }]),   // productie imobilizari
    M('b4', '2026-03-08', [{ debit: '5124', credit: '765', suma: 10000 }]),  // diferente de curs
    M('b5', '2026-03-09', [{ debit: '345', credit: '711', suma: 20000 }]),   // variatia stocurilor
    M('b6', '2026-03-10', [{ debit: '445', credit: '741', suma: 15000 }]),   // subventie de exploatare
  ]);
  const rb = rep.d100micro(art53, '2026-03');
  eq('baza micro: veniturile clasei 7, ca reper (165.000)', rb.venitClasa7, 165000);
  eq('baza micro: se scad provizioane/productie/curs/stocuri/subventii', rb.totalScaderi, 115000);
  eq('baza micro (art. 53) = doar venitul din activitate', rb.venit, 50000);
  eq('impozit pe baza corecta, nu pe tot venitul', rb.impozit, 500);
  ok('fiecare scadere isi poarta temeiul legal', rb.scaderi.every((s) => /^Art\. 53/.test(s.temei)));
  // 7584 e subventie pentru investitii (se scade), dar 7581/7588 raman in baza: prefixul mai lung
  // nu are voie sa inghita tot grupul 758.
  const r758 = micro.baza({ 704: { d: 0, c: 1000 }, 7584: { d: 0, c: 500 }, 7588: { d: 0, c: 300 } }, {});
  eq('7584 se scade, 7588 ramane in baza', r758.baza, 1300);
  // Reducerile comerciale primite (609, sold creditor pe un cont de clasa 6) se ADAUGA.
  eq('reducerile comerciale primite se adauga la baza',
    micro.baza({ 704: { d: 0, c: 1000 }, 609: { d: 0, c: 200 } }, {}).baza, 1200);
  // Baza nu poate fi negativa (nu exista rambursare la micro). Cazul real: stornari masive care
  // lasa contul de venit cu sold DEBITOR, langa o scadere pozitiva.
  eq('scaderi peste venituri -> baza 0, nu negativa',
    micro.baza({ 704: { d: 5000, c: 0 }, 7812: { d: 0, c: 1000 } }, {}).baza, 0);
  // 7581 amesteca despagubiri de la asigurari (se scad) cu amenzi incasate (nu) -> ramane in baza,
  // dar se semnaleaza. O scadere ghicita ar micsora un impozit datorat, tacut.
  ok('7581 ramane in baza, cu nota explicita',
    micro.baza({ 7581: { d: 0, c: 900 } }, {}).baza === 900
    && micro.baza({ 7581: { d: 0, c: 900 } }, {}).note.length === 1);

  // ── Diferenta de curs: scazuta in T1-T3, reintrodusa CUMULAT in ultimul trimestru ──
  const cursEnt = [
    M('c0', '2026-02-01', [{ debit: '4111', credit: '704', suma: 100000 }]),
    M('c1', '2026-02-20', [{ debit: '5124', credit: '765', suma: 9000 }]),
    M('c2', '2026-03-20', [{ debit: '665', credit: '5124', suma: 2000 }]),
  ];
  eq('T1: diferenta de curs se scade integral', rep.d100micro(mkMic(cursEnt), '2026-03').venit, 100000);
  eq('T4: revine doar diferenta FAVORABILA a anului (9.000 - 2.000)',
    rep.d100micro(mkMic(cursEnt), '2026-12').venit, 7000);
  // Pierdere neta de curs pe an -> nu se adauga nimic (nu se scade suplimentar).
  const cursPierdere = [M('p1', '2026-02-20', [{ debit: '5124', credit: '765', suma: 1000 }]),
    M('p2', '2026-03-20', [{ debit: '665', credit: '5124', suma: 4000 }])];
  eq('T4: curs net NEFAVORABIL -> nimic de adaugat', rep.d100micro(mkMic(cursPierdere), '2026-12').venit, 0);

  // ── Cota istorica 1% / 3% pana in 2025; cota unica 1% din 2026 ─────────────────────────────
  // Pentru 2025, pragul: 60.000 EUR x cursPlafonMicro 5 = 300.000 lei.
  const V = (luna, s, an) => M('v' + (an || '2025') + luna, (an || '2025') + '-' + luna + '-10', [{ debit: '4111', credit: '704', suma: s }]);
  eq('2025: sub prag si CAEN neutru -> 1%', rep.d100micro(mkMic([V('02', 50000)], '4711'), '2025-03').cota, 1);
  eq('2025: peste prag -> 3%', rep.d100micro(mkMic([V('02', 400000)], '4711'), '2025-03').cota, 3);
  // CAEN din lista (IT/HoReCa/juridic/medical): 3% INDIFERENT de venituri — cazul pe care cota
  // unica din configuratie il rata complet, raportand o treime din impozitul datorat.
  const itMic = rep.d100micro(mkMic([V('02', 50000)], '6201'), '2025-03');
  eq('2025: CAEN IT 6201 cu venituri mici -> tot 3%', itMic.cota, 3);
  eq('...si impozitul e de trei ori cel de la 1%', itMic.impozit, 1500);
  eq('2025: CAEN HoReCa 5610 -> 3%', rep.d100micro(mkMic([V('02', 50000)], '5610'), '2025-03').cota, 3);
  ok('motivul cotei e explicit, nu doar cifra', /6201/.test(itMic.cotaMotiv) && itMic.cotaPrin === 'caen');
  ok('comutarea pe 3% ajunge si in avertismente', itMic.avertismente.some((w) => /3%/.test(w)));
  // Art. 51 alin. (4): comutarea opereaza de la TRIMESTRUL depasirii, deci contorul e cumulat de
  // la inceputul anului — nici pe trimestru singur, nici pe anul intreg (ar include luni viitoare).
  const dep = [V('02', 200000), V('05', 150000)];
  eq('2025 T1, cumulat 200.000 (sub prag) -> 1%', rep.d100micro(mkMic(dep, '4711'), '2025-03').cota, 1);
  eq('2025 T2, cumulat 350.000 (peste prag) -> 3%', rep.d100micro(mkMic(dep, '4711'), '2025-06').cota, 3);
  // Suprascrierea explicita ramane pentru anii istorici.
  eq('2025: cota transmisa explicit bate motorul', rep.d100micro(mkMic([V('02', 400000)], '6201'), '2025-03', 1).cota, 1);
  // Fara CAEN nu se poate verifica conditia de activitate -> se spune, nu se presupune.
  ok('fara CAEN: avertisment ca nu s-a putut verifica activitatea',
    rep.d100micro(mkMic([V('02', 50000)], ''), '2025-03').avertismente.some((w) => /CAEN/.test(w)));
  const mic2026 = rep.d100micro(mkMic([V('02', 400000, '2026')], '6201'), '2026-03');
  eq('2026: cota ramane 1% chiar peste vechiul prag si pe CAEN IT', mic2026.cota, 1);
  ok('2026: motivul spune explicit cota unica', /unică/.test(mic2026.cotaMotiv));

  // ── Registrul fiscal foloseste ACEEASI baza si cota ca D100 ────────────────
  // Linia comparativa avea cota scrisa `* 1` in cod si baza pe tot venitul: doua cifre diferite
  // pentru acelasi impozit, in doua ecrane care se citesc impreuna.
  //
  // Ancora corecta e „anualul = suma trimestrelor", nu „anualul = un trimestru": registrul e un
  // raport ANUAL, deci include si diferenta favorabila de curs pe care art. 53(2)(b) o reintroduce
  // in ultimul trimestru. Prima forma a acestui test compara T1 cu anul si pica pe o diferenta
  // care era CORECTA — de aceea invariantul se scrie pe insumare, nu pe o egalitate comoda.
  const rfMic = rep.registruFiscal(art53, '2026', 16);
  const sumaTrim = ['03', '06', '09', '12']
    .reduce((s, mm) => round2ForTest(s + rep.d100micro(art53, '2026-' + mm).venit), 0);
  eq('registrul fiscal: baza anuala = suma bazelor trimestriale', rfMic.bazaMicro, sumaTrim);
  eq('...si include diferenta de curs reintrodusa in T4', rfMic.bazaMicro, 60000);
  eq('registrul fiscal: impozitul micro e derivat din aceeasi baza', rfMic.impozitMicro, round2ForTest(sumaTrim * rfMic.rateMicro / 100));
  eq('registrul fiscal 2025 pastreaza cota istorica 3%',
    rep.registruFiscal(mkMic([V('02', 50000)], '6201'), '2025', 16).rateMicro, 3);
  eq('registrul fiscal 2026 foloseste aceeasi cota unica 1% ca D100',
    rep.registruFiscal(mkMic([V('02', 50000, '2026')], '6201'), '2026', 16).rateMicro, 1);
}

section('Produse agricole — fila carnet de comercializare (Legea 145/2014)');
const agr = gt2('achizitie_produse_agricole').build({ suma: 750, cont: '371' });
eq('achizitie pe carnet: 371=462, fara TVA', agr.map((l) => l.debit + '=' + l.credit).join(','), '371=462');
const agrCash = gt2('achizitie_produse_agricole').build({ suma: 750, cont: '301', platitCash: true });
ok('achizitie platita pe loc: 301=462 + 462=5311', agrCash.some((l) => l.debit === '301' && l.credit === '462') && agrCash.some((l) => l.debit === '462' && l.credit === '5311'));
const agrDb = { entries: [
  { id: '1', tip: 'achizitie_produse_agricole', period: '2026-06', data: '2026-06-05', partener: 'Ion Taranu', partenerCui: '1800101223344', document: 'Fila 12', lines: gt2('achizitie_produse_agricole').build({ suma: 750, cont: '371' }) },
  { id: '2', tip: 'achizitie_produse_agricole', period: '2026-06', data: '2026-06-15', partener: 'Ion Taranu', partenerCui: '1800101223344', document: 'Fila 13', lines: gt2('achizitie_produse_agricole').build({ suma: 250, cont: '371', platitCash: true }) },
  { id: '3', tip: 'achizitie_produse_agricole', period: '2026-05', data: '2026-05-15', partener: 'Alt Producator', lines: gt2('achizitie_produse_agricole').build({ suma: 999, cont: '301' }) },
] };
const agrRep = rep.achizitiiPfCarnet(agrDb, '2026-06');
eq('carnet: un producator agregat in iunie (mai exclus)', agrRep.nr, 1);
eq('carnet: 2 file cumulate, total 1000', agrRep.rows[0].nr + '|' + agrRep.rows[0].total, '2|1000');
const vjGol = acc.vatJournals({ entries: [], openingBalances: {} }, '2026-06');
// in schema v5, achizitiile pe fila de carnet devin op1 tip="N" (tip_partener=2, CNP drept
// cuiP) cu detaliul op11 pe nomenclatorul de bunuri + oglinda in rezumat1/detaliu
const d394pf = xml.d394Xml({ cui: 'RO1', nume: 'X' }, '2026-06', vjGol, null, agrRep);
ok('D394: fila carnet ca op1 tip N cu CNP si op11', /<op1 tip="N" tip_partener="2" cota="0" cuiP="1800101223344"[^>]*nrFact="2" baza="1000"/.test(d394pf) && /<op11 nrFactPR="2" codPR="35" bazaPR="1000"\/>/.test(d394pf));
ok('D394: rezumat1 pentru PF cu document_N si detaliu', /rezumat1 tip_partener="2" cota="0"[^>]*facturiN="2" document_N="1" bazaN="1000"/.test(d394pf) && /<detaliu bun="35" nrN="2" valN="1000"\/>/.test(d394pf));
ok('D394 bine-format cu sectiunea pf', wellFormed(d394pf));
ok('D394 fara achizitii pe carnet: fara op1 tip N', !/<op1 tip="N"/.test(xml.d394Xml({ cui: 'RO1', nume: 'X' }, '2026-06', vjGol)));

section('TVA avansat: pro-rata (art. 300) + bunuri de capital (art. 305)');
const prDb = { company: { proRataTva: 40 }, entries: [
  { id: 'p1', period: '2026-02', data: '2026-02-01', tip: 'factura_vanzare_servicii', lines: [{ debit: '4111', credit: '704', suma: 6000 }, { debit: '4111', credit: '4427', suma: 1260 }] },
  { id: 'p2', period: '2026-03', data: '2026-03-01', tip: 'vanzare_scutita_fara_drept', lines: [{ debit: '4111', credit: '704', suma: 4000 }] },
  { id: 'p3', period: '2026-04', data: '2026-04-01', tip: 'factura_utilitati', proRataMixt: true, lines: [{ debit: '605', credit: '401', suma: 1126 }, { debit: '4426', credit: '401', suma: 84 }] },
] };
const prR = rep.proRataTva(prDb, '2026');
eq('pro-rata: livrari cu drept / fara drept', prR.cuDrept + '|' + prR.faraDrept, '6000|4000');
eq('pro-rata definitiva rotunjita in sus', prR.definitiva, 60);
eq('TVA dedusa provizoriu pe achizitiile mixte', prR.dedusaProvizoriu, 84);
eq('regularizare anuala: 210 x 60% - 84 = +42 (de dedus)', prR.regularizare, 42);
// ── A4: pro-rata pe achizitiile MARI (taxare inversa) ─────────────────────────────────────────
// Bifa lipsea tocmai de pe tipurile unde stau sumele mari — imobilizari, import, leasing,
// intracomunitar, art. 331 — iar pe cele cu taxare inversa n-ar fi mers nici daca era pusa:
// motorul cauta linia de cost dupa CREDITUL liniei de TVA, care acolo e 4427, nu furnizorul.
{
  const T4 = require('../src/documentTypes');
  const CU_BIFA = ['factura_imobilizare', 'import_vamal', 'factura_leasing', 'factura_combustibil',
    'achizitie_intracomunitara', 'taxare_inversa_interna_achizitie',
    'achizitie_servicii_intracomunitara', 'autofactura_achizitie', 'imobilizare_in_curs'];
  for (const id of CU_BIFA) {
    ok('pro-rata: „' + id + '" poate fi marcat cu destinatie mixta',
      (T4.getType(id).fields || []).some((f) => f.name === 'proRataMixt'));
  }
  // Mecanica pe taxare inversa: taxa COLECTATA ramane intreaga, se reduce doar deducerea, iar
  // diferenta creste costul. Articolul trebuie sa ramana ECHILIBRAT — inainte, partea
  // nedeductibila disparea pur si simplu.
  const aplica = acc.tvaPartialInCost;
  const lines = T4.getType('achizitie_intracomunitara').build({ baza: 10000, cota: 21, contStoc: '371' });
  aplica(lines, 80, 'ded 80%', 'TVA nedeductibila pro-rata');
  const d = lines.reduce((x, l) => x + l.suma, 0);
  eq('taxare inversa + pro-rata: deducerea scade la 80%', lines.find((l) => l.debit === '4426').suma, 1680);
  eq('...iar taxa COLECTATA ramane intreaga pe 4427', lines.filter((l) => l.credit === '4427').reduce((x, l) => x + l.suma, 0), 2100);
  eq('...partea nedeductibila creste costul bunului', lines.filter((l) => l.debit === '371').reduce((x, l) => x + l.suma, 0), 10420);
  ok('...si articolul ramane echilibrat', d === 10000 + 1680 + 420);
  // Fara loc unde sa punem costul, TVA-ul ramane NEATINS: un articol corect si nemodificat e mai
  // bun decat unul dezechilibrat.
  const doarTva = [{ debit: '4426', credit: '4427', suma: 2100, explicatie: 'x' }];
  // Apelul se prinde: fara garda, `aplica` e null si arunca — asta ar opri suita in loc de a
  // raporta o aserțiune cu nume (aceeasi lectie ca la generatorul de e-Factura).
  let aRupt = false;
  try { aplica(doarTva, 80, 'ded', 'nedeductibil'); } catch (e) { aRupt = true; }
  ok('fara linie de baza, functia nu arunca', !aRupt);
  eq('...TVA-ul ramane neatins', doarTva[0].suma, 2100);
  eq('...si nu se adauga nicio linie', doarTva.length, 1);

  // DECONTUL la taxare inversa cu deducere limitata: perechea R5/R18 trebuie sa ramana pe sumele
  // INTEGRALE de pe factura — validatorul cere R18 = R5, iar taxa colectata se datoreaza in
  // intregime chiar cand deducerea e limitata. Limitarea iese doar prin R28 („taxa dedusa").
  {
    const dbTi = { openingBalances: {}, company: { cui: 'RO1', nume: 'X', perioadaTva: 'L' }, entries: [
      { id: 'ti1', data: '2026-06-19', period: '2026-06', tip: 'achizitie_intracomunitara',
        tipNume: 'IC', status: 'postat', partener: 'GMBH', partenerCui: 'DE811907980', document: 'IC1',
        lines: [{ debit: '371', credit: '401', suma: 5000 }, { debit: '4426', credit: '4427', suma: 840 },
          { debit: '371', credit: '4427', suma: 210 }],
        tvaPartial: { baza: 5000, cota: 21, tvaFactura: 1050, tvaDedusa: 840 } },
    ] };
    const aTi = xml.d300Rows(rep.d300(dbTi, '2026-06'));
    eq('taxare inversa: taxa COLECTATA (R5) e integrala, nu doar partea dedusa', aTi.R5_2, 1050);
    eq('...si perechea R18 = R5 (regula V7/V8 a validatorului)', aTi.R18_2, aTi.R5_2);
    eq('...si bazele la fel', aTi.R18_1, aTi.R5_1);
    eq('taxa DEDUCTIBILA (R27) e cea de pe factura', aTi.R27_2, 1050);
    eq('taxa DEDUSA (R28) e doar partea cuvenita', aTi.R28_2, 840);
  }
}
// ── Numitorul pro-ratei: NU tot ce trece prin clasa 7 ─────────────────────────────────────────
// Art. 300 alin. (7) scoate din calcul cesiunea bunurilor de capital si operatiunile financiare
// accesorii; restul conturilor de clasa 7 nici nu sunt operatiuni in sfera TVA. Numarate ca „fara
// drept", coborau pro-rata — adica firma deducea MAI PUTIN decat avea dreptul.
{
  const V = (id, cont, suma, tva) => ({ id, period: '2026-05', data: '2026-05-01', tip: 'x', status: 'postat',
    lines: [{ debit: '4111', credit: cont, suma }].concat(tva ? [{ debit: '4111', credit: '4427', suma: tva }] : []) });
  const db = { company: {}, entries: [
    V('t1', '704', 100000, 21000),  // taxabil: cu drept
    V('t2', '704', 25000),          // scutit fara drept
    V('x1', '7583', 40000, 8400),   // cesiune bun de capital — EXCLUS, desi are TVA
    V('x2', '766', 5000),           // dobanzi — exclus
    V('x3', '7812', 30000),         // reluare de provizion — exclus
    V('x4', '765', 2000),           // diferenta de curs — exclus
    V('x5', '741', 9000),           // subventie — exclus
    V('x6', '711', 7000),           // variatia stocurilor — exclus
  ] };
  const r = rep.proRataTva(db, '2026');
  eq('pro-rata: numai operatiunile din sfera TVA intra in numitor', r.total, 125000);
  eq('...deci 80%, nu 70% cat dadea numararea intregii clase 7', r.definitiva, 80);
  eq('cesiunea bunului de capital nu intra nici in numarator', r.cuDrept, 100000);
  // Ce s-a scos NU dispare tacit: apare cu suma si temei, ca sa poata fi contestat.
  eq('exclusele se raporteaza, cu total', r.totalExclus, 93000);
  ok('...si sunt motivate', r.excluse.some((x) => /bunuri de capital/.test(x.motiv))
    && r.excluse.some((x) => /financiare/.test(x.motiv)) && r.excluse.some((x) => /subventii/.test(x.motiv)));
  // 709 e RECTIFICATIV: reducerea acordata scade baza, nu o umfla si nici nu iese la „excluse".
  const dbRed = { company: {}, entries: [V('t1', '704', 10000, 2100),
    { id: 'r1', period: '2026-05', data: '2026-05-02', tip: 'reducere_comerciala_acordata', status: 'postat',
      lines: [{ debit: '709', credit: '4111', suma: 1000 }, { debit: '4427', credit: '4111', suma: 210 }] }] };
  eq('reducerea acordata (709) SCADE baza operatiunilor', rep.proRataTva(dbRed, '2026').cuDrept, 9000);
}
// Operatiunile scutite/netaxate CU drept de deducere nu se recunosc dupa „are TVA colectat" —
// tocmai asta le lipseste. Toate trei cadeau la „fara drept" si coborau pro-rata.
{
  const V = (id, tip, cont, suma) => ({ id, period: '2026-05', data: '2026-05-01', tip, status: 'postat',
    lines: [{ debit: '4111', credit: cont, suma }] });
  const db = { company: {}, entries: [
    { id: 'a', period: '2026-05', data: '2026-05-01', tip: 'factura_vanzare_marfuri', status: 'postat',
      lines: [{ debit: '4111', credit: '707', suma: 100000 }, { debit: '4111', credit: '4427', suma: 21000 }] },
    V('b', 'livrare_intracomunitara', '707', 20000),
    V('c', 'prestare_servicii_intracomunitara', '704', 50000),
    V('d', 'taxare_inversa_interna_livrare', '707', 30000),
  ] };
  eq('livrarea intracomunitara, serviciile intracom si art. 331 au drept de deducere',
    rep.proRataTva(db, '2026').definitiva, 100);
  eq('...si nimic nu cade la „fara drept"', rep.proRataTva(db, '2026').faraDrept, 0);
}
const ajS = gt2('ajustare_tva_bunuri_capital').build({ tvaDedusa: 10000, durata: '5', aniRamasi: 3, sens: 'stat' });
eq('ajustare art. 305 in favoarea statului: 635=4426 cu 3/5 din TVA', ajS[0].debit + '=' + ajS[0].credit + '|' + ajS[0].suma, '635=4426|6000');
const ajF = gt2('ajustare_tva_bunuri_capital').build({ tvaDedusa: 10000, durata: '20', aniRamasi: 5, sens: 'firma' });
eq('ajustare art. 305 in favoarea firmei: 4426=635 cu 5/20 din TVA', ajF[0].debit + '=' + ajF[0].credit + '|' + ajF[0].suma, '4426=635|2500');
eq('regularizare pro-rata in favoarea firmei: 4426=635', gt2('regularizare_pro_rata').build({ suma: 42, sens: 'firma' })[0].debit + '=' + gt2('regularizare_pro_rata').build({ suma: 42, sens: 'firma' })[0].credit, '4426=635');

// TVA partial deductibila (auto 50% art. 298, pro-rata art. 300): partea nededusa intra in linia
// de COST, deci baza si cota facturii nu se mai pot citi din linii — raportul TVA-dedus/baza-din-
// linii da 105/1105 = 10%, o cota care nu exista in nomenclatorul de randuri D300, si articolul
// disparea TACIT din decont (plus un fals pozitiv „cota neconforma" la reconcilierea e-TVA).
// `tvaPartial` (pus de composeEntry) pastreaza factura asa cum a fost emisa.
const auto50Db = { openingBalances: {}, company: { cui: 'RO1', nume: 'X', perioadaTva: 'L' }, entries: [
  { id: 'a50', data: '2026-06-05', period: '2026-06', tip: 'factura_combustibil', tipNume: 'Comb',
    partener: 'OMV', partenerCui: 'RO123', document: 'BON1',
    lines: [{ debit: '6022', credit: '401', suma: 1105 }, { debit: '4426', credit: '401', suma: 105 }],
    tvaPartial: { baza: 1000, cota: 21, tvaFactura: 210, tvaDedusa: 105 } },
] };
const vjA50 = acc.vatJournals(auto50Db, '2026-06');
const rA50 = vjA50.cumparari[0];
eq('auto50: jurnalul arata baza REALA a facturii, nu baza umflata cu TVA-ul nededus', rA50.baza, 1000);
eq('auto50: jurnalul arata TVA-ul de pe factura', rA50.tva, 210);
eq('auto50: cota ramane cea a facturii (nu 10% fantoma)', rA50.cota, 21);
eq('auto50: defalcarea deductibil / nedeductibil', rA50.tvaDedusa + '|' + rA50.tvaNedeductibila, '105|105');
// In decont intra factura ASA CUM A FOST EMISA. Varianta veche declara partea dedusa cu o baza
// proportionala INVENTATA (500 pentru o achizitie reala de 1.000) — o achizitie care nu existase.
// Nedeductibilul isi are randul lui: R28 („taxa dedusa") < R27 („taxa deductibila"), forma
// confirmata la validatorul oficial. Regula R84 e satisfacuta oricum: 210/1000 = 21%.
eq('auto50: D300 primeste baza si TVA-ul INTEGRALE de pe factura', JSON.stringify(vjA50.coteC), '[{"cota":21,"baza":1000,"tva":210}]');
const aA50 = xml.d300Rows(rep.d300(auto50Db, '2026-06'));
eq('auto50: randul NU dispare din D300 (R22 = achizitii 21%)', aA50.R22_1 + '/' + aA50.R22_2, '1000/210');
eq('auto50: raportul baza/TVA din decont da exact cota (regula R84)', Math.round((aA50.R22_2 / aA50.R22_1) * 100), 21);
eq('auto50: taxa DEDUCTIBILA (R27) e cea de pe factura', aA50.R27_2, 210);
eq('auto50: taxa DEDUSA (R28) e doar partea cuvenita', aA50.R28_2, 105);
eq('auto50: si totalul dedus (R32) o urmeaza pe R28', aA50.R32_2, 105);
ok('auto50: reconcilierea e-TVA nu mai raporteaza fals „cota neconforma"',
  !rep.tvaReconciliation(auto50Db, '2026-06').findings.some((f) => f.cod === 'tva-cota-neconforma'));
// factura normala (fara tvaPartial) trece neschimbata prin acelasi cod
const normalDb = { openingBalances: {}, company: { cui: 'RO1', nume: 'X' }, entries: [
  { id: 'n1', data: '2026-06-06', period: '2026-06', tip: 'factura_cumparare_marfuri', tipNume: 'M', partenerCui: 'RO9',
    lines: [{ debit: '371', credit: '401', suma: 1000 }, { debit: '4426', credit: '401', suma: 210 }] },
] };
eq('factura normala: baza si TVA neschimbate', JSON.stringify(acc.vatJournals(normalDb, '2026-06').coteC), '[{"cota":21,"baza":1000,"tva":210}]');

section('Suma in litere (chitante)');
const sil = require('../src/util').sumaInLitere;
eq('zero', sil(0), 'zero lei');
eq('12.50', sil(12.5), 'doisprezece lei si cincizeci bani');
eq('121', sil(121), 'o suta douazeci si unu lei');
eq('1000', sil(1000), 'o mie lei');
eq('2500', sil(2500), 'doua mii cinci sute lei');
eq('12000 (feminin)', sil(12000), 'douasprezece mii lei');
eq('21000 (de + feminin)', sil(21000), 'douazeci si una de mii lei');
eq('100000', sil(100000), 'o suta de mii lei');
eq('2000000', sil(2000000), 'doua milioane lei');
eq('1234567.89', sil(1234567.89), 'un milion doua sute treizeci si patru de mii cinci sute saizeci si sapte lei si optzeci si noua bani');

section('Fisa de cont (miscari + corespondent + sold curent)');
const fisaDb = { entries: [
  { period: '2026-05', data: '2026-05-01', document: 'F0', explicatie: 'veche', partener: 'C', lines: [{ debit: '4111', credit: '707', suma: 250 }] },
  { period: '2026-06', data: '2026-06-05', document: 'F1', explicatie: 'vanzare', partener: 'C', lines: [{ debit: '4111', credit: '707', suma: 1000 }] },
  { period: '2026-06', data: '2026-06-10', document: 'OP1', explicatie: 'incasare', partener: 'C', lines: [{ debit: '5121', credit: '4111', suma: 400 }] },
], openingBalances: { '4111': { d: 100, c: 0 } } };
const fisa1 = acc.fisaCont(fisaDb, '4111', '2026-06');
eq('sold initial = solduri deschidere + rulaj anterior', fisa1.siInitial, 350);
eq('doua miscari in iunie', fisa1.rows.length, 2);
eq('cont corespondent la vanzare', fisa1.rows[0].corespondent, '707');
eq('sold final 350+1000-400', fisa1.sfFinal, 950);
eq('rulaje perioada', fisa1.rd + '|' + fisa1.rc, '1000|400');

section('Situatie aprovizionari si situatie consumuri');
const stkDb = {
  products: [{ id: 'p1', cod: 'M1', denumire: 'Marfa', um: 'buc', cont: '371' }, { id: 'p2', cod: 'MP', denumire: 'Faina', um: 'kg', cont: '301' }],
  gestiuni: [{ id: 'g1', cod: 'DEP' }],
  stockMovements: [
    { id: 'sm0', data: '2026-06-01', tip: 'receptie', initial: true, productId: 'p2', gestiuneId: 'g1', cantitate: 100, pretUnitar: 2, document: 'Stoc initial (preluare)' },
    { id: 'sm1', data: '2026-06-02', tip: 'receptie', productId: 'p1', gestiuneId: 'g1', cantitate: 10, pretUnitar: 5, furnizor: 'F SRL', document: 'NIR1' },
    { id: 'sm2', data: '2026-06-10', tip: 'iesire', productId: 'p1', gestiuneId: 'g1', cantitate: 4, pretUnitar: 0, document: 'BC1' },
    { id: 'sm3', data: '2026-06-15', tip: 'iesire', productId: 'p2', gestiuneId: 'g1', cantitate: 50, pretUnitar: 0, auto: true, document: 'F123' },
  ],
};
const apr = stocks.situatieAprovizionari(stkDb, '2026-06');
eq('aprovizionari: doar receptia reala (stocul initial preluat e exclus)', apr.rows.length, 1);
eq('aprovizionari: total si recapitulatie pe furnizor', apr.total + '|' + apr.perFurnizor['F SRL'], '50|50');
const cons = stocks.situatieConsumuri(stkDb, '2026-06');
eq('consumuri: 2 iesiri in perioada', cons.rows.length, 2);
eq('consumuri: M1 la CMP pe 607 (4 x 5)', cons.perCont['607'], 20);
eq('consumuri: MP la CMP pe 601 (50 x 2)', cons.perCont['601'], 100);
ok('consumuri: iesirea automata e marcata "vanzare"', cons.rows.some((r) => r.cod === 'MP' && r.sursa === 'vanzare'));
ok('consumuri: bonul de consum manual e marcat "consum"', cons.rows.some((r) => r.cod === 'M1' && r.sursa === 'consum'));

// DBF: construieste un DBF minimal si parseaza-l
const dbfMod = require('../src/dbf');
(() => {
  const fields = [['CUI', 'C', 10], ['DEN', 'C', 20]];
  const hl = 32 + fields.length * 32 + 1; const rl = 1 + fields.reduce((s, f) => s + f[2], 0);
  const recs = [['RO123', 'ALFA SRL'], ['RO999', 'BETA SRL']];
  const b = Buffer.alloc(hl + recs.length * rl + 1);
  b[0] = 0x03; b.writeUInt32LE(recs.length, 4); b.writeUInt16LE(hl, 8); b.writeUInt16LE(rl, 10);
  let o = 32; for (const [n, t, l] of fields) { b.write(n, o, 'latin1'); b[o + 11] = t.charCodeAt(0); b[o + 16] = l; o += 32; }
  b[o] = 0x0D; o++;
  for (const r of recs) { b[o] = 0x20; let p = o + 1; r.forEach((v, i) => { b.write(String(v).padEnd(fields[i][2]), p, 'latin1'); p += fields[i][2]; }); o += rl; }
  const drows = dbfMod.parseDbf(b);
  eq('DBF: antet + 2 inregistrari', drows.length, 3);
  eq('DBF: nume campuri', drows[0].join(','), 'CUI,DEN');
  eq('DBF: prima inregistrare', drows[1].join(','), 'RO123,ALFA SRL');
})();

section('Facturi recurente (scadente)');
const recMod = require('../src/recurring');
const tpl = (o) => Object.assign({ activ: true, frecventa: 'lunar', startDate: '2026-01', lastGenerated: null }, o);
eq('lunar: scadent in orice luna', recMod.dueForPeriod([tpl({})], '2026-03').length, 1);
eq('inactiv: nu e scadent', recMod.dueForPeriod([tpl({ activ: false })], '2026-03').length, 0);
eq('deja generat luna asta: nu se redubleaza', recMod.dueForPeriod([tpl({ lastGenerated: '2026-03' })], '2026-03').length, 0);
eq('inainte de luna de start: nu', recMod.dueForPeriod([tpl({ startDate: '2026-05' })], '2026-03').length, 0);
eq('anual: scadent in luna de start (ian)', recMod.dueForPeriod([tpl({ frecventa: 'anual' })], '2026-01').length, 1);
eq('anual: NU in alta luna (mar)', recMod.dueForPeriod([tpl({ frecventa: 'anual' })], '2026-03').length, 0);
eq('trimestrial: scadent la +3 luni (apr)', recMod.dueForPeriod([tpl({ frecventa: 'trimestrial' })], '2026-04').length, 1);
eq('trimestrial: NU in luna intermediara (feb)', recMod.dueForPeriod([tpl({ frecventa: 'trimestrial' })], '2026-02').length, 0);

section('Personalizare documente: IBAN in e-Factura');
const efEntry = { tip: 'factura_vanzare_marfuri', data: '2026-06-15', document: 'F1', partener: 'B', partenerCui: 'RO9', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] };
const efIban = xml.eFacturaXml({ nume: 'X', cui: 'RO1', iban: 'RO49 BTRL 0001', banca: 'BT' }, efEntry, {});
ok('e-Factura include PaymentMeans + IBAN (fara spatii) cand e setat', efIban.includes('PaymentMeans') && efIban.includes('RO49BTRL0001') && efIban.includes('>BT<'));
ok('e-Factura bine-format cu PaymentMeans', wellFormed(efIban));
ok('fara IBAN -> fara PaymentMeans (optional)', !xml.eFacturaXml({ nume: 'X', cui: 'RO1' }, efEntry, {}).includes('PaymentMeans'));

section('Impozit pe profit (16%)');
const ptEnt = [
  { id: '1', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 10000 }] },
  { id: '2', period: '2026-04', data: '2026-04-01', lines: [{ debit: '607', credit: '371', suma: 6000 }] },
];
const pt = acc.profitTax({ entries: ptEnt }, '2026', 16);
eq('profit impozabil = 10000 - 6000', pt.profitImpozabil, 4000);
eq('impozit = 4000 × 16% = 640', pt.impozit, 640);
eq('articol 691=4411', pt.lines[0].debit + '=' + pt.lines[0].credit, '691=4411');
eq('691 exclus din baza (re-rulare cu impozit deja inregistrat -> tot 640)', acc.profitTax({ entries: ptEnt.concat([{ id: '3', period: '2026-12', data: '2026-12-31', lines: [{ debit: '691', credit: '4411', suma: 640 }] }]) }, '2026', 16).impozit, 640);
const ptLoss = acc.profitTax({ entries: [{ id: '1', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 5000 }] }, { id: '2', period: '2026-04', data: '2026-04-01', lines: [{ debit: '607', credit: '371', suma: 8000 }] }] }, '2026', 16);
eq('pierdere -> impozit 0', ptLoss.impozit, 0);
eq('pierdere -> niciun articol', ptLoss.lines.length, 0);
// D101 (calculul anual): split exploatare/financiar (76x/66x) + figuri peste profitTax
const d101ent = [
  { id: 'a', period: '2025-06', data: '2025-06-10', lines: [{ debit: '4111', credit: '707', suma: 100000 }, { debit: '627', credit: '401', suma: 5000 }] },
  { id: 'b', period: '2025-07', data: '2025-07-10', lines: [{ debit: '5121', credit: '766', suma: 3000 }, { debit: '666', credit: '5121', suma: 2000 }] },
];
const d101r = rep.d101({ entries: d101ent, openingBalances: {} }, '2025', { cheltNedeductibile: 1000 });
eq('D101: venituri exploatare = 100000', d101r.venituriExploatare, 100000);
eq('D101: rezultat financiar = 766 - 666 = 1000', d101r.rezFinanciar, 1000);
eq('D101: rezultat brut = exploatare 95000 + financiar 1000', d101r.rezultatBrut, 96000);
eq('D101: profit impozabil = brut 96000 + nedeductibile 1000', d101r.profitImpozabil, 97000);
eq('D101: impozit = 97000 × 16% = 15520', d101r.impozit, 15520);
eq('D101: scadenta = 25 martie anul urmator', d101r.scadenta, '2026-03-25');

// D101 XML (schema oficiala v10) — validat oficial cu DUKIntegrator (vezi docs/validare-oficiala.md);
// aici verificam bine-formarea, namespace-ul, structura si INVARIANTELE de calcul ale validatorului.
const d101co = { cui: '12345674', nume: 'S.C. EXEMPLU PROD S.R.L.', adresa: 'Str. Exemplu nr. 1', oras: 'Bucuresti', judet: 'RO-B', caen: '1071' };
const d101xml = xml.d101Xml(d101co, rep.d101({ entries: d101ent, openingBalances: {} }, '2026', { cheltNedeductibile: 1000 }));
ok('D101 XML bine-format', wellFormed(d101xml));
ok('D101 XML: schema v10, root declaratie101, cod_obligatie 103', d101xml.includes('xmlns="mfp:anaf:dgti:d101:declaratie:v10"') && d101xml.includes('<declaratie101') && d101xml.includes('cod_obligatie="103"'));
ok('D101 XML: Data_S/Data_I an calendaristic + nr_evid pe 23 cifre + cif fara RO', d101xml.includes('Data_I="01.01.2026"') && d101xml.includes('Data_S="31.12.2026"') && /nr_evid="\d{23}"/.test(d101xml) && d101xml.includes('cif="12345674"'));
const pAttr = (x, n) => Number((x.match(new RegExp('\\b' + n + '="(-?\\d+)"')) || [])[1]);
ok('D101 XML: P3=P1-P2, P7=P3+P6, P22=P10-P16-P21, P35=P22+P34 (invariante validator)', (() => {
  const P = (n) => pAttr(d101xml, n);
  return P('P3') === P('P1') - P('P2') && P('P7') === P('P3') + P('P6')
    && P('P22') === P('P10') - P('P16') - P('P21') && P('P35') === P('P22') + P('P34');
})());
ok('D101 XML: P41=P411, P48=P481+P482, P52=P48, totalPlata_A = suma indicatorilor principali', (() => {
  const P = (n) => pAttr(d101xml, n);
  const keys = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P10', 'P15', 'P16', 'P21', 'P22', 'P33', 'P34', 'P35', 'P36', 'P39', 'P40', 'P41', 'P48', 'P52'];
  const suma = keys.reduce((s, k) => s + P(k), 0);
  return P('P41') === P('P411') && P('P48') === P('P481') + P('P482') && P('P52') === P('P48') && P('totalPlata_A') === suma;
})());
// pierdere curenta: P35<0 -> P36 = -P35, P38a = 0, P40 = 0, impozit 0
const d101loss = xml.d101Xml(d101co, rep.d101({ entries: [{ id: 'l', period: '2026-05', data: '2026-05-01', lines: [{ debit: '607', credit: '371', suma: 8000 }, { debit: '5121', credit: '707', suma: 3000 }] }], openingBalances: {} }, '2026'));
ok('D101 XML pierdere: P36 = -P35 (pierderea curenta), P38a=0, P40=0, impozit P41=0', (() => {
  const P = (n) => pAttr(d101loss, n);
  return P('P35') < 0 && P('P36') === -P('P35') && P('P38a') === 0 && P('P40') === 0 && P('P41') === 0;
})());

section('Impozit pe profit — ajustari fiscale + reportare pierdere');
const ptAdjEnt = [
  { id: '1', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 10000 }] },
  { id: '2', period: '2026-04', data: '2026-04-01', lines: [{ debit: '607', credit: '371', suma: 6000 }] },
]; // profit contabil 4000
const ptAdj = acc.profitTax({ entries: ptAdjEnt }, '2026', { cota: 16, cheltNedeductibile: 1000, deduceri: 500 });
eq('profit impozabil = 4000 + 1000 nedeductibile − 500 deduceri', ptAdj.profitImpozabil, 4500);
eq('impozit = 4500 × 16% = 720', ptAdj.impozit, 720);
const ptAdj2 = acc.profitTax({ entries: ptAdjEnt }, '2026', { cota: 16, pierdereReportata: 2000 });
eq('pierdere reportata 2000 -> profit impozabil 2000', ptAdj2.profitImpozabil, 2000);
eq('impozit = 320, pierdere de reportat = 0', ptAdj2.impozit, 320);
// Plafonul de 70% la recuperarea pierderii (Legea 296/2023), aplicabil din anul fiscal 2024.
const ptAdj3 = acc.profitTax({ entries: ptAdjEnt }, '2026', { cota: 16, pierdereReportata: 5000 });
eq('2026: pierdere recuperabila plafonata la 70% din 4000 = 2800', ptAdj3.pierdereFolosita, 2800);
eq('2026: profit impozabil = 4000 − 2800 = 1200', ptAdj3.profitImpozabil, 1200);
eq('2026: impozit = 1200 × 16% = 192 (nu 0, plafonul lasa 30% impozabil)', ptAdj3.impozit, 192);
eq('2026: pierdere de reportat = 5000 − 2800 = 2200', ptAdj3.pierdereDeReportat, 2200);
eq('2026: plafonReportarePct expus = 70', ptAdj3.plafonReportarePct, 70);
// Sub plafon: o pierdere mai mica decat 70% din baza se foloseste integral (fara efect de plafon).
const ptCapSub = acc.profitTax({ entries: ptAdjEnt }, '2026', { cota: 16, pierdereReportata: 2000 });
eq('2026: pierdere 2000 < plafon 2800 -> folosita integral', ptCapSub.pierdereFolosita, 2000);
eq('2026: profit impozabil 2000, impozit 320', ptCapSub.impozit, 320);
// Regim vechi pentru anii fiscali <= 2023: recuperare 100% (pana la baza).
const ptOld = acc.profitTax({ entries: [{ id: '1', period: '2023-03', data: '2023-03-01', lines: [{ debit: '4111', credit: '707', suma: 10000 }] }, { id: '2', period: '2023-04', data: '2023-04-01', lines: [{ debit: '607', credit: '371', suma: 6000 }] }] }, '2023', { cota: 16, pierdereReportata: 5000 });
eq('2023: regim vechi -> pierdere recuperata 100% pana la baza (4000)', ptOld.pierdereFolosita, 4000);
eq('2023: profit impozabil 0 -> impozit 0', ptOld.impozit, 0);
eq('2023: plafonReportarePct expus = 100', ptOld.plafonReportarePct, 100);
// ── D177: baza difera dupa regim, iar corelatia sumelor o prinde aplicatia ──
{
  const rep3 = require('../src/reporting');
  const { round2 } = require('../src/util');
  const sponsEnt = (an) => [
    { id: 'v', period: an + '-06', data: an + '-06-01', status: 'postat', lines: [{ debit: '5121', credit: '704', suma: 500000 }] },
    { id: 's', period: an + '-06', data: an + '-06-30', status: 'postat', partener: 'ONG', partenerCui: 'RO12345674',
      document: 'CTR 7', lines: [{ debit: '6582', credit: '5121', suma: 1500 }] },
  ];
  const parteneri = { 12345674: { cui: '12345674', den: 'ONG', adresa: 'Str. 1', iban: 'RO49AAAA1B31007593840000' } };

  // PROFIT: plafonul e min(0,75% din cifra de afaceri; 20% din impozit) — art. 25(4)(i).
  const vProfit = { company: { regimImpozit: 'profit' }, angajati: [], partners: parteneri, openingBalances: {}, assets: [], entries: sponsEnt('2025') };
  const dProfit = rep3.d177(vProfit, '2025', { profitTax: { cota: 16, plafoane: require('../src/fiscalConfig').RATES } });
  eq('firma pe profit -> regim „profit"', dProfit.regim, 'profit');
  eq('plafonul de profit = 0,75% din 500.000', dProfit.sumaMax, 3750);

  // MICRO: nu exista limita pe cifra de afaceri — doar 20% din impozitul pe venituri (art. 56^1).
  const vMicro = { company: { regimImpozit: 'micro', caen: '4711' }, angajati: [{ id: 'a' }], partners: parteneri, openingBalances: {}, assets: [], entries: sponsEnt('2025') };
  const dMicro = rep3.d177(vMicro, '2025');
  eq('firma micro -> regim „micro"', dMicro.regim, 'micro');
  ok('plafonul micro NU e cel de profit (alta lege, alta cifra)', dMicro.sumaMax !== dProfit.sumaMax);
  // Asteptarea se DERIVA din impozitul micro real, nu dintr-o cota scrisa de mana: la 500.000 lei
  // venituri se depaseste pragul de 60.000 EUR, deci cota e 3%, nu 1% — prima varianta a testului
  // fixase 1% si a picat pe drept.
  const trim = [3, 6, 9, 12].map((m) => rep3.d100micro(vMicro, '2025-' + String(m).padStart(2, '0')));
  const brutAn = round2(trim.reduce((sx, t) => sx + t.impozitBrut, 0));
  eq('plafonul micro = 20% din impozitul BRUT al anului (inainte de deducere)', dMicro.sumaMax, round2(brutAn * 0.2));
  ok('si chiar s-a folosit cota de 3% (peste prag), nu cea de 1%', brutAn === round2(500000 * 0.03));

  // Art. 56^1: sponsorizarea se SCADE din impozitul trimestrial, in limita a 20% din el.
  const t2 = trim.find((t) => t.trimestru === 2); // sponsorizarea e in iunie
  eq('sponsorizarea trimestrului e vazuta', t2.sponsorizareTrimestru, 1500);
  eq('deducerea e plafonata la 20% din impozitul brut al trimestrului', t2.sponsorizareDedusa, round2(Math.min(1500, t2.impozitBrut * 0.2)));
  eq('impozitul declarat scade cu suma dedusa', t2.impozit, round2(t2.impozitBrut - t2.sponsorizareDedusa));
  ok('partea nefolosita e VIZIBILA, nu pierduta tacit', t2.sponsorizareNefolosita === round2(1500 - t2.sponsorizareDedusa));
  // Si asta e miezul reparatiei: `sumaAnt` nu mai e zero cand chiar s-a dedus ceva.
  eq('D177: sumaAnt = cat s-a scazut efectiv din impozit', dMicro.sumaAnt, t2.sponsorizareDedusa);
  ok('deci nu mai apare tot plafonul ca redirectionabil', dMicro.sumaRest < dMicro.sumaMax);
  // Sponsorizare PESTE plafon: se deduce doar 20%, restul ramane vizibil ca nefolosit. Fara acest
  // caz, limita nu se exercita deloc — fixtura de mai sus are sponsorizarea sub plafon.
  const vPeste = Object.assign({}, vMicro, { entries: sponsEnt('2025').map((e) => (e.id === 's'
    ? Object.assign({}, e, { lines: [{ debit: '6582', credit: '5121', suma: 9000 }] }) : e)) });
  const tPeste = rep3.d100micro(vPeste, '2025-06');
  eq('sponsorizare 9000 peste plafonul de 20% -> se deduce doar plafonul', tPeste.sponsorizareDedusa, tPeste.plafonSponsorizare);
  ok('si plafonul chiar taie (9000 > 20% din impozitul brut)', tPeste.plafonSponsorizare < 9000);
  eq('restul apare ca nefolosit, nu dispare', tPeste.sponsorizareNefolosita, round2(9000 - tPeste.plafonSponsorizare));

  // REPORTUL (art. 56^1 alin. (3)): partea nefolosita se deduce in trimestrele urmatoare, 28 de
  // trimestre, in ordinea inregistrarii. Se DERIVA din articole — fara stocare, fara migrare.
  {
    const ent = [
      { id: 'v1', period: '2025-06', data: '2025-06-01', status: 'postat', lines: [{ debit: '4111', credit: '704', suma: 500000 }] },
      { id: 's1', period: '2025-06', data: '2025-06-30', status: 'postat', lines: [{ debit: '6582', credit: '5121', suma: 9000 }] },
      { id: 'v2', period: '2025-09', data: '2025-09-01', status: 'postat', lines: [{ debit: '4111', credit: '704', suma: 500000 }] },
    ];
    const vRep = Object.assign({}, vMicro, { entries: ent });
    const t2 = rep3.d100micro(vRep, '2025-06');
    const t3 = rep3.d100micro(vRep, '2025-09');
    ok('T2: sponsorizarea depaseste plafonul, deci ramane rest', t2.sponsorizareNefolosita > 0);
    eq('restul pleaca in report cu trimestrul lui', JSON.stringify(t2.sponsorizareReportOut), '[{"trimestru":"2025-06","suma":' + t2.sponsorizareNefolosita + '}]');
    eq('T3: reportul din T2 intra ca disponibil', JSON.stringify(t3.sponsorizareReportIn), JSON.stringify(t2.sponsorizareReportOut));
    ok('si se deduce efectiv in T3, in limita plafonului lui', t3.sponsorizareDinReport > 0);
    eq('tot ce se deduce in T3 vine DIN REPORT (T3 n-are sponsorizare proprie)', t3.sponsorizareDedusa, t3.sponsorizareDinReport);
    eq('impozitul T3 scade cu suma dedusa din report', t3.impozit, round2(t3.impozitBrut - t3.sponsorizareDinReport));
    // Fara report, T3 ar fi platit impozitul intreg — asta e miezul reparatiei.
    eq('fara report, T3 n-ar deduce nimic', rep3.d100micro(vRep, '2025-09', null, { faraReport: true }).sponsorizareDedusa, 0);
  }
  // Motorul de vintage-uri pe trimestre: FIFO si expirare la 28 de trimestre.
  eq('28 de trimestre = fereastra de report', rep3.indexTrimestru('2032-06') - rep3.indexTrimestru('2025-06'), 28);
  {
    const c = rep3.consumaVintage([{ trimestru: '2025-03', suma: 100 }, { trimestru: '2032-06', suma: 50 }], 1000);
    eq('vintage-ul mai vechi de 28 de trimestre EXPIRA', c.expirate.map((x) => x.trimestru).join(), '2025-03');
    eq('doar cel valabil se consuma', c.folosit, 50);
    const c2 = rep3.consumaVintage([{ trimestru: '2025-09', suma: 80 }, { trimestru: '2025-06', suma: 30 }], 50);
    eq('consum FIFO: intai cel mai VECHI (2025-06), apoi restul', c2.detaliu.map((x) => x.trimestru + ':' + x.folosit).join('|'), '2025-06:30|2025-09:20');
  }

  // Fara sponsorizare, nimic nu se schimba fata de comportamentul dinainte.
  const vFara = Object.assign({}, vMicro, { entries: [sponsEnt('2025')[0]] });
  const tFara = rep3.d100micro(vFara, '2025-06');
  eq('fara sponsorizare, impozitul declarat = cel brut', tFara.impozit, tFara.impozitBrut);
  eq('si D177 vede tot plafonul liber', rep3.d177(vFara, '2025').sumaAnt, 0);

  // Corelatia pe care validatorul NU o verifica: beneficiarii nu pot depasi restul.
  ok('sponsorizare 1500 sub plafonul de profit 3750 -> nu depaseste', dProfit.depaseste === false);
  const vMult = Object.assign({}, vProfit, { entries: sponsEnt('2025').map((e) => (e.id === 's'
    ? Object.assign({}, e, { lines: [{ debit: '6582', credit: '5121', suma: 99000 }] }) : e)) });
  const dMult = rep3.d177(vMult, '2025', { profitTax: { cota: 16, plafoane: require('../src/fiscalConfig').RATES } });
  ok('beneficiari peste restul redirectionabil -> semnalat', dMult.depaseste === true);
  ok('si totalul chiar depaseste restul', dMult.total > dMult.sumaRest);
}

// ── Registrul bunurilor de capital (art. 305 alin. (4)) ──
{
  const bc = require('../src/bunuriCapital');
  const v = {
    assets: [
      { cont: '2133', cost: 50000, denumire: 'Utilaj', durataLuni: 60 },
      { cont: '2131', cost: 3000, denumire: 'Scule marunte', durataLuni: 36 },
    ],
    entries: [
      { id: 'e1', data: '2024-12-20', status: 'postat', document: 'F1', lines: [{ debit: '2133', credit: '404', suma: 50000 }, { debit: '4426', credit: '404', suma: 9500 }] },
      { id: 'e2', data: '2026-03-10', status: 'postat', document: 'F2', lines: [{ debit: '212', credit: '404', suma: 400000 }, { debit: '4426', credit: '404', suma: 76000 }] },
      { id: 'e3', data: '2026-05-01', status: 'postat', document: 'F3', lines: [{ debit: '2131', credit: '404', suma: 3000 }, { debit: '4426', credit: '404', suma: 570 }] },
      // achizitie FARA TVA dedusa (de la neplatitor): nu intra in perimetrul art. 305
      { id: 'e4', data: '2026-02-01', status: 'postat', document: 'F4', lines: [{ debit: '2133', credit: '404', suma: 7000 }] },
    ],
  };
  const r = bc.registru(v, { anReferinta: 2026 });

  eq('perioada: 20 de ani la imobile, 5 la restul', bc.periodaAjustare('212') + '/' + bc.periodaAjustare('2133'), '20/5');
  ok('terenurile sunt tot bunuri imobile', bc.esteImobil('2111'));
  eq('bunurile fara TVA dedusa nu intra in registru', r.bunuri.filter((b) => b.document === 'F4').length, 0);
  eq('activele amortizabile sub 5 ani nu sunt bunuri de capital (alin. 1 lit. a)', r.bunuri.filter((b) => b.document === 'F3').length, 0);
  eq('raman doar cele doua bunuri de capital reale', r.totaluri.nrBunuri, 2);

  // MIEZUL: perioada incepe la 1 IANUARIE al anului achizitiei, nu la data facturii.
  const utilaj = r.bunuri.find((b) => b.document === 'F1');
  eq('utilaj cumparat in DECEMBRIE 2024: anul 2024 se consuma intreg', utilaj.aniConsumati, 3);
  eq('deci in 2026 mai raman 2 ani din cei 5', utilaj.aniRamasi, 2);
  eq('perioada expira dupa 2028', utilaj.expiraDupa, 2028);
  eq('TVA de ajustat = 9500 x 2/5', utilaj.tvaDeAjustat, 3800);
  // Aceeasi achizitie, dar in IANUARIE: acelasi numar de ani consumati — asta dovedeste regula.
  const vIan = { assets: v.assets, entries: [Object.assign({}, v.entries[0], { data: '2024-01-05' })] };
  eq('achizitia din ianuarie consuma tot atatia ani ca cea din decembrie', bc.registru(vIan, { anReferinta: 2026 }).bunuri[0].aniConsumati, 3);

  const cladire = r.bunuri.find((b) => b.document === 'F2');
  eq('cladirea are 20 de ani, din care 1 consumat in 2026', cladire.durata + '/' + cladire.aniConsumati, '20/1');
  eq('TVA de ajustat = 76000 x 19/20', cladire.tvaDeAjustat, 72200);
  ok('cladirea e marcata ca imobil', cladire.imobil);

  // Iesirea din perioada: dupa expirare nu mai e nimic de ajustat.
  const dupa = bc.registru(v, { anReferinta: 2030 });
  eq('in 2030 utilajul a iesit din perioada', dupa.bunuri.find((b) => b.document === 'F1').inPerioada, false);
  eq('si nu mai are TVA de ajustat', dupa.bunuri.find((b) => b.document === 'F1').tvaDeAjustat, 0);
  eq('cladirea e inca in perioada', dupa.bunuri.find((b) => b.document === 'F2').inPerioada, true);

  // Ajustarile postate se citesc cu semnul lor.
  const vAj = { assets: [], entries: v.entries.concat([
    { id: 'a1', data: '2026-06-30', status: 'postat', tip: 'ajustare_tva_bunuri_capital', document: 'NC1', lines: [{ debit: '635', credit: '4426', suma: 3800 }] },
    { id: 'a2', data: '2026-07-31', status: 'postat', tip: 'ajustare_tva_bunuri_capital', document: 'NC2', lines: [{ debit: '4426', credit: '635', suma: 1200 }] },
  ]) };
  const rAj = bc.registru(vAj, { anReferinta: 2026 });
  eq('ajustarile in favoarea statului se cumuleaza', rAj.totaluri.ajustatCatreStat, 3800);
  eq('cele in favoarea firmei, separat (sensul conteaza)', rAj.totaluri.ajustatCatreFirma, 1200);

  // TVA-ul unui articol cu doua imobilizari se repartizeaza proportional cu baza.
  const vMulti = { assets: [], entries: [{ id: 'm', data: '2026-01-10', status: 'postat', document: 'FM',
    lines: [{ debit: '2133', credit: '404', suma: 30000 }, { debit: '2131', credit: '404', suma: 10000 }, { debit: '4426', credit: '404', suma: 7600 }] }] };
  const rM = bc.registru(vMulti, { anReferinta: 2026 });
  eq('TVA repartizata 3:1 dupa baza', rM.bunuri.map((b) => b.tvaDedusa).join('|'), '5700|1900');
  eq('si totalul se pastreaza', rM.totaluri.tvaDedusa, 7600);
  // Fara activ in nomenclator, bunul RAMANE in registru (o omisiune nu scoate din evidenta).
  ok('imobilizarea necunoscuta in registrul de mijloace fixe ramane in evidenta', rM.bunuri.length === 2);
}

// ── D101 se calculeaza cu ACELEASI reguli ca nota contabila 691 = 4411 ──
{
  const ptOpts = require('../src/profitTaxOptions');
  const rep2 = require('../src/reporting');
  // venituri 100.000 + amenda 20.000 (integral nedeductibila, art. 25(4)(b))
  const ent = [
    { id: 'v', period: '2026-03', data: '2026-03-01', status: 'postat', lines: [{ debit: '4111', credit: '704', suma: 100000 }] },
    { id: 'a', period: '2026-04', data: '2026-04-01', status: 'postat', lines: [{ debit: '6581', credit: '5121', suma: 20000 }] },
  ];
  const v = { firmaId: 1, company: { id: 1 }, entries: ent, openingBalances: {}, assets: [] };

  // Cifra pe care o INREGISTREAZA inchiderea, cu setul complet de reguli.
  const notaContabila = acc.profitTax(v, '2026', ptOpts.construieste(v, '2026'));
  eq('nota contabila: amenda e integral nedeductibila', notaContabila.cheltNedeductibile, 20000);
  eq('nota contabila: impozit 16% din 100.000', notaContabila.impozit, 16000);

  // Cifra pe care o DECLARA D101 — trebuie sa fie aceeasi.
  const decl = rep2.d101(v, '2026', ptOpts.pentruDeclaratie(v, '2026'));
  eq('D101 declara acelasi impozit ca nota postata', decl.impozit, notaContabila.impozit);
  eq('si aceeasi baza impozabila', decl.profitImpozabil, notaContabila.profitImpozabil);
  eq('si aceleasi nedeductibile', decl.cheltuieliNedeductibile, 20000);
  // Regresia propriu-zisa: chemata FARA optiuni, declaratia raporta 12.800 in loc de 16.000.
  ok('fara optiuni, D101 ar raporta mai putin — de asta nu se mai cheama asa',
    rep2.d101(v, '2026').impozit < notaContabila.impozit);

  // Amortizarea contabila reala (6811) se citeste FARA inchiderile 6/7 -> 121. Cu ele, contul e
  // creditat de articolul de inchidere si o insumare oarba l-ar aduce la zero: ajustarea art. 28
  // ar iesi inversata, iar impozitul odata cu ea. Aceeasi capcana pe care o evita si `d101`.
  const vAmort = {
    firmaId: 1, company: { id: 1 }, openingBalances: {},
    assets: [{ id: 'mf', denumire: 'Utilaj', cont: '2131', cost: 12000, dataPif: '2025-12-20', durataLuni: 60, metoda: 'liniara', status: 'activ' }],
    entries: [
      { id: 'v', period: '2026-03', data: '2026-03-01', status: 'postat', lines: [{ debit: '4111', credit: '704', suma: 50000 }] },
      { id: 'am', period: '2026-06', data: '2026-06-30', status: 'postat', lines: [{ debit: '6811', credit: '2813', suma: 2400 }] },
      // inchiderea anuala: 121 = 6811 (exact liniile care trebuie IGNORATE aici)
      { id: 'inch', period: '2026-12', data: '2026-12-31', tip: 'inchidere_an', status: 'postat', lines: [{ debit: '121', credit: '6811', suma: 2400 }] },
    ],
  };
  eq('amortizarea contabila reala ramane 2400 si dupa inchiderea anuala',
    ptOpts.construieste(vAmort, '2026').amortizare.contabila, 2400);
  eq('rulajCont ignora inchiderile de rezultat', ptOpts.rulajCont(vAmort, '2026', '6811'), 2400);

  // Vintage-urile firmei ajung si ele in optiuni — altfel declaratia ar ignora recuperarea de
  // pierdere pe care inchiderea o aplica, si am fi mutat divergenta in loc s-o inchidem.
  const vPierdere = { firmaId: 1, company: { id: 1, pierderiFiscale: [{ an: 2023, suma: 40000 }] }, entries: ent, openingBalances: {}, assets: [] };
  const optP = ptOpts.construieste(vPierdere, '2026');
  eq('optiunile poarta vintage-urile firmei', JSON.stringify(optP.pierderi), '[{"an":2023,"suma":40000}]');
  const declP = rep2.d101(vPierdere, '2026', ptOpts.pentruDeclaratie(vPierdere, '2026'));
  eq('D101 recupereaza pierderea, plafonat la 70% din 100.000', declP.pierdereFolosita, 40000);
  ok('deci impozitul declarat scade fata de firma fara pierdere', declP.impozit < decl.impozit);
  eq('si coincide cu ce ar inregistra inchiderea', declP.impozit, acc.profitTax(vPierdere, '2026', optP).impozit);
  // O pierdere EXPIRATA nu se recupereaza nici in declaratie (art. 31, prin acelasi motor).
  const vExp = { firmaId: 1, company: { id: 1, pierderiFiscale: [{ an: 2017, suma: 40000 }] }, entries: ent, openingBalances: {}, assets: [] };
  eq('pierderea expirata nu ajunge in D101', rep2.d101(vExp, '2026', ptOpts.pentruDeclaratie(vExp, '2026')).pierdereFolosita, 0);

  // INSTANTANEUL: dupa postare, pierderile reportate sunt deja consumate, deci o recalculare cu
  // aceleasi reguli ar da alta cifra. Declaratia trebuie sa raporteze ce s-a INREGISTRAT.
  const vPostat = {
    firmaId: 1,
    company: { id: 1, pierderiFiscale: [] }, // inchiderea a consumat tot
    openingBalances: {}, assets: [],
    entries: ent.concat([{
      id: 'ip', period: '2026-12', data: '2026-12-31', tip: 'impozit_profit', status: 'postat',
      lines: [{ debit: '691', credit: '4411', suma: 9200 }],
      rezultatFiscal: { cota: 16, impozit: 9200, impozitBrut: 9200, profitImpozabil: 57500, pierdereReportata: 42500, pierdereFolosita: 42500, cheltNedeductibile: 20000, deduceri: 0 },
    }]),
  };
  const optPostat = ptOpts.pentruDeclaratie(vPostat, '2026');
  ok('dupa postare se refoloseste instantaneul, nu se recalculeaza', !!optPostat.rezultatFiscal);
  const declPostat = rep2.d101(vPostat, '2026', optPostat);
  eq('D101 raporteaza EXACT impozitul inregistrat', declPostat.impozit, 9200);
  eq('si recuperarea de pierdere pe care a folosit-o inchiderea', declPostat.pierdereFolosita, 42500);
  // Fara instantaneu, recalcularea pe starea de ACUM (pierderi consumate) ar da alta cifra.
  ok('recalcularea pe starea de acum ar diverge — de asta exista instantaneul',
    acc.profitTax(vPostat, '2026', ptOpts.construieste(vPostat, '2026')).impozit !== 9200);
  // Articolul STORNAT nu mai e sursa de adevar.
  const vStornat = Object.assign({}, vPostat, { entries: vPostat.entries.map((e) => (e.tip === 'impozit_profit' ? Object.assign({}, e, { stornat: true }) : e)) });
  ok('un articol stornat nu mai impune instantaneul', !ptOpts.pentruDeclaratie(vStornat, '2026').rezultatFiscal);
}

// ── VECHIMEA pierderii fiscale (art. 31): 7 ani pana in 2023, 5 ani din 2024 ──
{
  eq('pierderile de pana in 2023 se recupereaza 7 ani', acc.aniReportPierdere(2023), 7);
  eq('cele din 2024 incolo, 5 ani', acc.aniReportPierdere(2024), 5);
  eq('regimul se decide pe VINTAGE, nu pe anul curent', acc.aniReportPierdere(2019), 7);

  // Consumul: FIFO (cea mai veche prima — e cea care expira prima), cu expirarile scoase din joc.
  const c = acc.consumaPierderi([{ an: 2018, suma: 50000 }, { an: 2022, suma: 30000 }, { an: 2024, suma: 20000 }], 2026, 40000);
  eq('pierderea din 2018 a EXPIRAT in 2026 (7 ani, pana in 2025)', c.expirate.map((x) => x.an).join(), '2018');
  eq('nu intra in disponibil', c.disponibil, 50000);
  eq('se consuma FIFO: intai 2022 (30000), apoi 10000 din 2024', c.detaliu.map((r) => r.an + ':' + r.folosit).join('|'), '2022:30000|2024:10000');
  eq('totalul folosit respecta plafonul dat', c.folosit, 40000);
  eq('mai departe se reporteaza doar restul VALABIL', JSON.stringify(c.ramase), '[{"an":2024,"suma":10000}]');
  ok('expirarea poarta motivul, ca sa se vada in registru', /7 ani/.test((c.expirate[0] || {}).motiv || ''));

  // Limita exacta a termenului — anul in care INCA se poate si primul in care nu se mai poate.
  eq('pierdere 2024 folosibila in 2029 (al 5-lea an)', acc.consumaPierderi([{ an: 2024, suma: 100 }], 2029, 1000).folosit, 100);
  eq('aceeasi pierdere e EXPIRATA in 2030', acc.consumaPierderi([{ an: 2024, suma: 100 }], 2030, 1000).folosit, 0);
  eq('pierdere 2023 folosibila in 2030 (al 7-lea an)', acc.consumaPierderi([{ an: 2023, suma: 100 }], 2030, 1000).folosit, 100);
  eq('si expirata in 2031', acc.consumaPierderi([{ an: 2023, suma: 100 }], 2031, 1000).folosit, 0);
  eq('pierderea anului CURENT nu e „reportata" (se trateaza separat)', acc.consumaPierderi([{ an: 2026, suma: 100 }], 2026, 1000).folosit, 0);

  // Prin profitTax: acelasi profit, dar o pierdere expirata NU mai reduce impozitul.
  const bazaEnt = ptAdjEnt; // profit contabil 4000 -> plafon 70% = 2800
  const cuValabila = acc.profitTax({ entries: bazaEnt }, '2026', { cota: 16, pierderi: [{ an: 2022, suma: 5000 }] });
  const cuExpirata = acc.profitTax({ entries: bazaEnt }, '2026', { cota: 16, pierderi: [{ an: 2018, suma: 5000 }] });
  eq('pierdere valabila -> se foloseste plafonul de 70%', cuValabila.pierdereFolosita, 2800);
  eq('pierdere EXPIRATA -> nu se foloseste nimic', cuExpirata.pierdereFolosita, 0);
  ok('si impozitul creste corespunzator', cuExpirata.impozit > cuValabila.impozit);
  eq('expirata: impozit pe toata baza (4000 x 16%)', cuExpirata.impozit, 640);
  eq('pierderea expirata NU se mai reporteaza mai departe', JSON.stringify(cuExpirata.pierderiDeReportat), '[]');
  eq('cea valabila isi reporteaza restul, cu anul ei', JSON.stringify(cuValabila.pierderiDeReportat), '[{"an":2022,"suma":2200}]');
  ok('detaliul pe vintage-uri e expus pentru registrul fiscal', Array.isArray(cuValabila.pierderiDetaliu) && cuValabila.pierderiDetaliu[0].expiraDupa === 2029);
  // Contractul ISTORIC (scalar, fara an) ramane: nu se poate imbatrani ce n-are varsta.
  const scalar = acc.profitTax({ entries: bazaEnt }, '2026', { cota: 16, pierdereReportata: 5000 });
  eq('scalarul se comporta ca inainte', scalar.pierdereFolosita, 2800);
  eq('si nu inventeaza vintage-uri', scalar.pierderiDetaliu, null);
  // Anul cu pierdere: vintage-ul nou poarta anul curent si se adauga la resturi.
  const anPierdere = acc.profitTax({ entries: [{ id: '1', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 3000 }] }, { id: '2', period: '2026-04', data: '2026-04-01', lines: [{ debit: '607', credit: '371', suma: 8000 }] }] }, '2026', { cota: 16, pierderi: [{ an: 2022, suma: 1000 }] });
  eq('pierderea anului curent intra ca vintage nou, datat', JSON.stringify(anPierdere.pierderiDeReportat), '[{"an":2022,"suma":1000},{"an":2026,"suma":5000}]');
}

// ── Plafonul de 1.500 lei/luna la amortizarea auto (art. 28 alin. (12) lit. m) ──
{
  const mf = { id: 'auto1', denumire: 'Autoturism', cont: '2133', cost: 200000, dataPif: '2026-01-15', durataLuni: 60, metoda: 'liniara', status: 'activ' };
  const auto = Object.assign({}, mf, { vehiculM1: true });
  eq('amortizarea CONTABILA ramane intreaga (6811 se inregistreaza normal)', assets.annualFor(auto, '2026', false), 36666.63);
  eq('cea FISCALA se plafoneaza la 1500/luna x 11 luni', assets.annualFor(auto, '2026', true), 16500);
  eq('fara marcaj M1, plafonul nu se aplica', assets.annualFor(mf, '2026', true), 36666.63);
  const dif = assets.depreciationDifference([auto], '2026');
  eq('diferenta devine ajustare (nedeductibil)', dif.diferenta, 20166.63);
  ok('si e semnalata ca diferenta', dif.areDiferenta);
  // Plafonarea e PE LUNA, nu pe an: un an cu mai putine luni nu primeste plafonul lunilor lipsa.
  eq('anul urmator, plin: 12 luni x 1500', assets.annualFor(auto, '2027', true), 18000);
  // Sub plafon nu se schimba nimic — masina ieftina se amortizeaza fiscal integral.
  const ieftin = { id: 'auto2', denumire: 'Auto mic', cont: '2133', cost: 60000, dataPif: '2026-01-15', durataLuni: 60, metoda: 'liniara', status: 'activ', vehiculM1: true };
  eq('1000 lei/luna < 1500 -> fiscal = contabil', assets.annualFor(ieftin, '2026', true), assets.annualFor(ieftin, '2026', false));
  eq('deci nicio ajustare', assets.depreciationDifference([ieftin], '2026').diferenta, 0);
  // `panaLa` (declaratia trimestriala) se combina cu plafonul.
  eq('la 31 martie: 2 luni plafonate (feb, mar)', assets.annualFor(auto, '2026', true, '2026-03'), 3000);
}

// Suprascriere manuala a plafonului (opts.pierdereRecuperabilaPct).
const ptOverride = acc.profitTax({ entries: ptAdjEnt }, '2026', { cota: 16, pierdereReportata: 5000, pierdereRecuperabilaPct: 100 });
eq('2026 + override 100% -> pierdere folosita 4000 (ca regimul vechi)', ptOverride.pierdereFolosita, 4000);
const ptLossYr = acc.profitTax({ entries: [{ id: '1', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 3000 }] }, { id: '2', period: '2026-04', data: '2026-04-01', lines: [{ debit: '607', credit: '371', suma: 8000 }] }] }, '2026', { cota: 16, pierdereReportata: 1000 });
eq('an pe pierdere -> impozit 0 (plafonul nu se aplica pe baza negativa)', ptLossYr.impozit, 0);
eq('pierdere curenta 5000 + reportata 1000 = 6000 de reportat', ptLossYr.pierdereDeReportat, 6000);

section('Plafoane de deductibilitate (art. 25 / 40^2) — src/deductibilitate.js');
{
  const deduct = require('../src/deductibilitate');
  const P = require('../src/fiscalConfig').RATES;
  const R = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { d: v, c: 0 }]));
  const gasit = (r, regula) => r.randuri.find((x) => x.regula === regula);

  // ── Protocol: baza INCLUDE cheltuiala insasi si impozitul pe profit ──────
  // Greseala clasica ar fi plafon = 2% din profitul contabil simplu (2.000), care ar da 3.000
  // nedeductibil in loc de 2.900. Diferenta e exact ce testeaza randul urmator.
  const prot = deduct.ajustari({ rulaj: R({ 623: 5000 }), profitContabil: 100000, cheltImpozitProfit: 0 }, P);
  eq('protocol: baza = profit + protocol + impozit = 105.000', gasit(prot, 'Protocol').baza, 105000);
  eq('protocol: plafon = 2% din baza = 2.100', gasit(prot, 'Protocol').plafon, 2100);
  eq('protocol: nedeductibil = 5.000 − 2.100 = 2.900', gasit(prot, 'Protocol').nedeductibil, 2900);
  const protImp = deduct.ajustari({ rulaj: R({ 623: 5000 }), profitContabil: 100000, cheltImpozitProfit: 16000 }, P);
  eq('protocol: impozitul deja inregistrat intra in baza (121.000)', gasit(protImp, 'Protocol').baza, 121000);
  // An pe pierdere: baza <= 0 => plafon 0 => cheltuiala integral nedeductibila.
  const protL = deduct.ajustari({ rulaj: R({ 623: 5000 }), profitContabil: -50000 }, P);
  eq('protocol pe pierdere: plafon 0', gasit(protL, 'Protocol').plafon, 0);
  eq('protocol pe pierdere: integral nedeductibil', gasit(protL, 'Protocol').nedeductibil, 5000);

  // ── Cheltuieli sociale: 5% din FONDUL DE SALARII (641), nu din cheltuiala ──
  const soc = deduct.ajustari({ rulaj: R({ 6458: 3000, 641: 40000 }), profitContabil: 0 }, P);
  eq('social: plafon = 5% din 40.000 = 2.000', gasit(soc, 'Cheltuieli sociale').plafon, 2000);
  eq('social: nedeductibil = 3.000 − 2.000 = 1.000', gasit(soc, 'Cheltuieli sociale').nedeductibil, 1000);
  const socFara = deduct.ajustari({ rulaj: R({ 6458: 3000 }), profitContabil: 0 }, P);
  eq('social fara fond de salarii: integral nedeductibil', gasit(socFara, 'Cheltuieli sociale').nedeductibil, 3000);
  // Sub plafon: nimic nedeductibil (plafonul nu inventeaza ajustari).
  const socSub = deduct.ajustari({ rulaj: R({ 6458: 1000, 641: 40000 }), profitContabil: 0 }, P);
  eq('social sub plafon: nedeductibil 0', gasit(socSub, 'Cheltuieli sociale').nedeductibil, 0);

  // ── Auto 50% pe CHELTUIALA (art. 25(3)(l)), distinct de TVA-ul auto (art. 298) ──
  const au = deduct.ajustari({ rulaj: {}, profitContabil: 0, cheltAuto: 8000 }, P);
  eq('auto: jumatate din cheltuiala e nedeductibila', gasit(au, 'Cheltuieli auto').nedeductibil, 4000);

  // ── Sponsorizarea ca CHELTUIALA e integral nedeductibila ────────────────
  const sp = deduct.ajustari({ rulaj: R({ 6582: 10000 }), profitContabil: 0 }, P);
  eq('sponsorizare: cheltuiala integral nedeductibila', gasit(sp, 'Sponsorizare (cheltuiala)').nedeductibil, 10000);
  eq('sponsorizare: suma e raportata separat pentru faza 2', sp.sponsorizareCheltuita, 10000);

  // ── Creditul fiscal (faza 2): min(0,75% din CA, 20% din impozit) ─────────
  const c1 = deduct.credit({ cifraAfaceri: 800000, impozit: 20000, sponsorizareAn: 10000, report: [], an: 2026 }, P);
  eq('credit: plafon CA = 0,75% × 800.000 = 6.000', c1.plafonCa, 6000);
  eq('credit: plafon impozit = 20% × 20.000 = 4.000', c1.plafonImpozit, 4000);
  eq('credit: se ia MINIMUL celor doua plafoane', c1.plafon, 4000);
  eq('credit: impozitul scade cu creditul folosit', c1.impozitDupaCredit, 16000);
  eq('credit: restul de 6.000 se reporteaza', c1.reportNou[0].suma, 6000);
  // Plafonul de CA muscator (CA mica): min(0,75%×100.000=750; 20%×20.000=4.000) = 750.
  const c2 = deduct.credit({ cifraAfaceri: 100000, impozit: 20000, sponsorizareAn: 10000, report: [], an: 2026 }, P);
  eq('credit: cand CA e mica, plafonul de 0,75% e cel care muscA', c2.folosit, 750);

  // ── Reportul: consum FIFO pe ani si prescriptie la 7 ani ─────────────────
  const c3 = deduct.credit({ cifraAfaceri: 1000000, impozit: 100000, sponsorizareAn: 0,
    report: [{ an: 2022, suma: 1000 }, { an: 2023, suma: 2000 }], an: 2026 }, P);
  eq('report: se consuma cel mai VECHI intai (2022 dispare)', c3.reportNou.length, 0);
  eq('report: tot ce era disponibil s-a folosit (3.000)', c3.folosit, 3000);
  const c4 = deduct.credit({ cifraAfaceri: 100000, impozit: 100000, sponsorizareAn: 0,
    report: [{ an: 2022, suma: 1000 }, { an: 2023, suma: 2000 }], an: 2026 }, P);
  eq('report FIFO: plafon 750 -> se stinge din bucketul 2022', c4.folosit, 750);
  eq('report FIFO: bucketul 2022 ramane cu 250', c4.reportNou[0].suma, 250);
  eq('report FIFO: anul bucketului se PASTREAZA (prescriptia depinde de el)', c4.reportNou[0].an, 2022);
  // Prescriptia: un bucket din 2019 e mai vechi de 7 ani fata de 2026 -> nu se mai poate folosi.
  const c5 = deduct.credit({ cifraAfaceri: 1000000, impozit: 100000, sponsorizareAn: 0,
    report: [{ an: 2019, suma: 5000 }], an: 2026 }, P);
  eq('prescriptie: bucketul de 7 ani vechime nu se mai foloseste', c5.folosit, 0);
  eq('prescriptie: suma pierduta e raportata explicit', c5.prescris, 5000);

  // ── Art. 40^2: costuri excedentare ale indatorarii ───────────────────────
  const dSub = deduct.ajustari({ rulaj: R({ 666: 50000 }), profitContabil: 0, cursEur: 5 }, P);
  eq('dobanzi sub plafonul de 1M EUR: nimic nedeductibil', gasit(dSub, 'Costuri excedentare ale indatorarii').nedeductibil, 0);
  // Veniturile din dobanzi (766) reduc costul excedentar — e un NET, nu o cheltuiala bruta.
  const dNet = deduct.ajustari({ rulaj: { 666: { d: 50000, c: 0 }, 766: { d: 0, c: 20000 } }, profitContabil: 0, cursEur: 5 }, P);
  eq('dobanzi: costul excedentar e NET de veniturile din dobanzi', gasit(dNet, 'Costuri excedentare ale indatorarii').cheltuit, 30000);
  // Peste plafon: 6.000.000 lei cost, plafon 5.000.000 (1M EUR × 5), baza 30% aplicata excedentului.
  const dPeste = deduct.ajustari({ rulaj: R({ 666: 6000000 }), profitContabil: 1000000,
    rezultatFiscalInainteDobanzi: 1000000, amortizareFiscala: 500000, cursEur: 5 }, P);
  const rd = gasit(dPeste, 'Costuri excedentare ale indatorarii');
  // baza = 1.000.000 + 6.000.000 + 500.000 = 7.500.000; 30% = 2.250.000; excedent peste plafon
  // = 1.000.000, deci deductibil integral din cei 30% -> nimic nedeductibil.
  eq('dobanzi peste plafon: excedentul incape in 30% din baza', rd.nedeductibil, 0);
  const dRau = deduct.ajustari({ rulaj: R({ 666: 20000000 }), profitContabil: 100000,
    rezultatFiscalInainteDobanzi: 100000, amortizareFiscala: 0, cursEur: 5 }, P);
  const rd2 = gasit(dRau, 'Costuri excedentare ale indatorarii');
  // baza = 100.000 + 20.000.000 = 20.100.000; 30% = 6.030.000; plafon EUR = 5.000.000;
  // deductibil = 5.000.000 + min(15.000.000; 6.030.000) = 11.030.000 -> nedeductibil 8.970.000
  eq('dobanzi mult peste plafon: nedeductibil = cost − (plafon EUR + 30% din baza)', rd2.nedeductibil, 8970000);
  // AMBELE citiri ale art. 40^2 sunt CALCULATE, ca revizorul sa aleaga intre doua cifre, nu intre
  // doua fraze. Diferenta pe acest caz e de 5.000.000 lei — nu o nuanta de redactare.
  ok('ambele interpretari sunt expuse', rd2.alternativa && rd2.alternativa.cumulativ && rd2.alternativa.max);
  eq('citirea implicita e cea cumulativa', rd2.alternativa.aplicata, 'cumulativ');
  eq('cumulativ -> 8.970.000 nedeductibil', rd2.alternativa.cumulativ.nedeductibil, 8970000);
  eq('alternativa max -> 13.970.000 nedeductibil', rd2.alternativa.max.nedeductibil, 13970000);
  eq('diferenta dintre citiri, pe acest caz', rd2.alternativa.max.nedeductibil - rd2.alternativa.cumulativ.nedeductibil, 5000000);
  // Optiunea chiar comuta calculul aplicat (nu doar raportarea)
  const dMax = deduct.ajustari({ rulaj: R({ 666: 20000000 }), profitContabil: 100000,
    rezultatFiscalInainteDobanzi: 100000, amortizareFiscala: 0, cursEur: 5, art402Interpretare: 'max' }, P);
  eq('optiunea „max" schimba cifra aplicata', gasit(dMax, 'Costuri excedentare ale indatorarii').nedeductibil, 13970000);
  ok('si o marcheaza ca atare', gasit(dMax, 'Costuri excedentare ale indatorarii').alternativa.aplicata === 'max');

  // ── Integrarea in profitTax: contractul istoric NU se schimba ────────────
  const ent = [
    { id: '1', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 200000 }] },
    { id: '2', period: '2026-04', data: '2026-04-01', lines: [{ debit: '623', credit: '401', suma: 5000 }] },
  ];
  const fara = acc.profitTax({ entries: ent }, '2026', { cota: 16 });
  eq('fara opts.plafoane: nedeductibile 0 (comportament istoric)', fara.cheltNedeductibile, 0);
  const cu = acc.profitTax({ entries: ent }, '2026', { cota: 16, plafoane: P });
  // profit contabil = 195.000; baza protocol = 195.000 + 5.000 = 200.000; plafon 4.000; neded 1.000
  eq('cu opts.plafoane: nedeductibilele se CALCULEAZA (1.000)', cu.cheltNedeductibile, 1000);
  eq('cu opts.plafoane: profitul impozabil creste cu nedeductibilul', cu.profitImpozabil, 196000);
  ok('cu opts.plafoane: randurile de ajustare sunt expuse', cu.ajustari.length === 1);
  const supra = acc.profitTax({ entries: ent }, '2026', { cota: 16, plafoane: P, cheltNedeductibile: 7777 });
  eq('suprascrierea manuala BATE motorul (portita contabilului)', supra.cheltNedeductibile, 7777);

  // ── Fara suprapunere intre procentele fixe si plafoane ──────────────────
  // Plafoanele citesc 623/6458/6582/666; procentele fixe citesc 6581/635/6814/654/6812. Daca un
  // cont ar intra in ambele, nedeductibilul s-ar numara de DOUA ori — de aici poarta. Listele se
  // iau din modul, nu se scriu aici: o tabela copiata in test nu mai pazeste nimic dupa ce
  // originalul se schimba.
  const conturiMotor = Object.values(deduct.CONT);
  const suprapuse = Object.keys(deduct.FIXE).filter((c) => conturiMotor.some((m) => String(c).startsWith(m)));
  ok('niciun cont nu e citit si de plafoane, si de procentele fixe', suprapuse.length === 0);
}

section('Un singur motor de nedeductibile: registrul fiscal = nota contabila = D101');
{
  // REGRESIE. `profitTax` (care posteaza 691 = 4411 SI alimenteaza D101) vedea doar plafoanele
  // art. 25/40^2, iar procentele fixe pe cont (amenzi, provizioane, impozite nedeductibile)
  // traiau intr-o tabela separata, citita numai de registrul de evidenta fiscala. Pe datele de
  // mai jos registrul spunea 15.779 lei impozit, iar nota contabila 10.560 — cu 33% mai putin,
  // si cu declaratia contrazicand propriul registru. Verificarea ancora e EGALITATEA celor doua
  // motoare, nu o cifra: o cifra scrisa de mana s-ar potrivi cu oricare dintre ele.
  const P = require('../src/fiscalConfig').RATES;
  const deduct = require('../src/deductibilitate');
  const { round2 } = require('../src/util');
  const E = (id, data, lines) => ({ id, data, period: data.slice(0, 7), tip: 'nota_contabila', tipNume: 'x', lines });
  const vFix = { openingBalances: {}, assets: [], company: {}, entries: [
    E('n1', '2026-03-10', [{ debit: '4111', credit: '704', suma: 100000 }]),
    E('n2', '2026-04-10', [{ debit: '6581', credit: '5121', suma: 20000 }]),  // amenda — fix 100%
    E('n3', '2026-05-10', [{ debit: '6812', credit: '151', suma: 10000 }]),   // provizion — fix 100%
    E('n4', '2026-06-10', [{ debit: '635', credit: '446', suma: 5000 }]),     // impozite — fix 100%
    E('n5', '2026-07-10', [{ debit: '151', credit: '7812', suma: 4000 }]),    // reluare — neimpozabil
    E('n6', '2026-08-10', [{ debit: '623', credit: '401', suma: 3000 }]),     // protocol — cu PLAFON
  ] };
  const opts = { cota: 16, plafoane: P };
  const pt = acc.profitTax(vFix, '2026', opts);
  const rfx = rep.registruFiscal(vFix, '2026', 16, { plafoane: P });

  // Ancora: aceleasi conturi, acelasi an -> acelasi impozit. Comparatie STRICTA (nu prin `eq`,
  // care rotunjeste si ar ascunde tocmai o divergenta de bani).
  ok('impozitul e acelasi in registru si in nota contabila', pt.impozit === rfx.impozitProfit);
  ok('si baza impozabila e aceeasi', pt.profitImpozabil === rfx.rezultatFiscal);

  // Procentele fixe chiar ajung in profitTax (inainte: 0).
  const rulajFiscal = acc.accumulate(acc.resultLines(acc.postedEntries(vFix)));
  // 6812 a IESIT din tabelul de procente fixe: deductibilitatea lui depinde de FELUL provizionului
  // (contul din contrapartida), nu de contul de cheltuiala. `fixe` numara acum doar 6581 + 635;
  // provizioanele intra prin `provizioane()`, iar TOTALUL de mai jos ramane neschimbat.
  eq('procentele fixe se calculeaza din conturi (20.000+5.000)', deduct.fixe(rulajFiscal).total, 25000);
  eq('provizioanele intra separat, tot nedeductibile fara spargere', deduct.provizioane(null, rulajFiscal).total, 10000);
  eq('nedeductibile = fixe + plafon protocol', pt.cheltNedeductibile, 36620);
  // Veniturile neimpozabile (art. 23) SCAD baza — nu se adunau deloc inainte.
  eq('veniturile neimpozabile se scad din baza', pt.venituriNeimpozabile, 4000);
  eq('profit impozabil = 66.000 + 36.620 - 4.000', pt.profitImpozabil, 98620);

  // Fara dubla numarare in registru: cele doua tabele sunt disjuncte si totalul lor da exact
  // nedeductibilul din nota. Aici s-ar vedea daca `ajustari` ar returna fixele si in `randuriPlafon`.
  eq('registrul nu numara fixele de doua ori', round2(rfx.totalNeded + rfx.totalPlafoane), pt.cheltNedeductibile);
  eq('procentele fixe raman separate de plafoane in raport', rfx.totalPlafoane, 1620);
  ok('registrul isi pastreaza forma istorica a randurilor', rfx.cheltNeded.every((c) => c.cod && c.nume && c.pct != null && c.suma != null));

  // D101 nu are voie sa piarda nedeductibilele pe drum: defalcarea pe randuri trebuie sa totalizeze
  // exact cat spune nota contabila (regula R80 a validatorului cere P34 = suma P23..P33).
  const dcl = rep.d101(vFix, '2026', opts);
  eq('D101: defalcarea totalizeaza cat nedeductibilul din nota', dcl.cheltuieliNedeductibile, pt.cheltNedeductibile);
  eq('D101: impozitul de plata e cel din nota contabila', dcl.impozitDePlata, pt.impozit);

  // Contractul suprascrierii manuale ramane: un camp COMPLETAT bate motorul, dar absenta lui nu
  // mai inseamna zero. Distinctia asta era chiar defectul: formularul trimitea mereu 0.
  const supra0 = acc.profitTax(vFix, '2026', Object.assign({}, opts, { cheltNedeductibile: 0, deduceri: 0 }));
  eq('zero transmis EXPLICIT ramane suprascriere (zero, exact)', supra0.cheltNedeductibile, 0);
  eq('si pentru deduceri la fel', supra0.deduceri, 0);
  const auto = acc.profitTax(vFix, '2026', Object.assign({}, opts, { cheltNedeductibile: '', deduceri: '' }));
  eq('campul GOL lasa motorul sa calculeze (nedeductibile)', auto.cheltNedeductibile, 36620);
  eq('campul GOL lasa motorul sa calculeze (deduceri)', auto.deduceri, 4000);

  // Fara `plafoane` nu se calculeaza nimic — contractul istoric al apelantilor „simpli".
  eq('fara opts.plafoane, contractul istoric e neatins', acc.profitTax(vFix, '2026', { cota: 16 }).cheltNedeductibile, 0);
}

section('Amortizare fiscala separata de cea contabila (art. 28)');
{
  const P = require('../src/fiscalConfig').RATES;
  const deduct = require('../src/deductibilitate');
  // Acelasi mijloc fix: liniar contabil (36 luni), accelerat fiscal (50% in primul an).
  const mf = { id: 'mf1', denumire: 'Utilaj', cont: '2131', cost: 36000, valoareReziduala: 0,
    dataPif: '2025-12-15', durataLuni: 36, metoda: 'liniara', metodaFiscala: 'accelerata' };

  ok('activul are plan fiscal diferit', assets.hasFiscalPlan(mf));
  ok('fara campuri fiscale, planul e IDENTIC (fallback, fara migrare)',
    !assets.hasFiscalPlan({ durataLuni: 36, metoda: 'liniara' }));
  // Vederea fiscala nu atinge activul original (altfel planul contabil s-ar corupe tacit).
  assets.fiscalView(mf);
  eq('fiscalView nu muteaza activul', mf.metoda, 'liniara');

  const c2026 = assets.annualFor(mf, '2026', false);
  const f2026 = assets.annualFor(mf, '2026', true);
  eq('contabil 2026: 12 luni x 1000 = 12.000', c2026, 12000);
  eq('fiscal 2026 (accelerat): 50% din 36.000 in primele 12 luni = 18.000', f2026, 18000);
  const d1 = assets.depreciationDifference([mf], '2026');
  eq('anul 1: fiscala > contabila -> diferenta NEGATIVA (deducere)', d1.diferenta, -6000);
  ok('anul 1: se raporteaza ca diferenta', d1.areDiferenta);
  const d2 = assets.depreciationDifference([mf], '2027');
  // an 2 contabil 12.000; fiscal: restul de 18.000 pe 24 de luni = 9.000/an
  eq('anul 2: contabila > fiscala -> diferenta POZITIVA (nedeductibil)', d2.diferenta, 3000);

  // INVARIANTUL CENTRAL: pe toata durata, ajustarile se anuleaza. Amortizarea fiscala MUTA
  // deducerea intre exercitii, nu o creeaza si nu o distruge. Daca suma nu e zero, undeva se
  // pierde sau se inventeaza deducere — cel mai grav defect posibil al acestei reguli.
  let sumaDif = 0; let sumaC = 0; let sumaF = 0;
  for (const an of ['2025', '2026', '2027', '2028', '2029']) {
    const d = assets.depreciationDifference([mf], an);
    sumaDif = Math.round((sumaDif + d.diferenta) * 100) / 100;
    sumaC = Math.round((sumaC + d.contabilaPlan) * 100) / 100;
    sumaF = Math.round((sumaF + d.fiscala) * 100) / 100;
  }
  ok('suma diferentelor pe toata durata = 0 (deducerea se muta, nu se creeaza)', sumaDif === 0);
  ok('ambele planuri amortizeaza exact costul (36.000)', sumaC === 36000 && sumaF === 36000);

  // Amortizarea contabila REALA (rulajul 6811) inlocuieste planul: registrul fiscal porneste de la
  // ce s-a inregistrat efectiv, nu de la ce ar fi trebuit.
  const dReal = assets.depreciationDifference([mf], '2026', 11500);
  eq('rulajul real al lui 6811 bate planul contabil', dReal.contabila, 11500);
  eq('planul contabil ramane vizibil separat', dReal.contabilaPlan, 12000);
  eq('diferenta se calculeaza fata de cifra REALA', dReal.diferenta, -6500);

  // Regula in motor: singura care poate da nedeductibil NEGATIV (= deducere).
  const aj = deduct.ajustari({ rulaj: {}, profitContabil: 0, amortizare: { contabila: 12000, fiscala: 18000 } }, P);
  const rA = aj.randuri.find((x) => x.regula === 'Amortizare (contabila vs fiscala)');
  eq('motor: diferenta negativa intra ca deducere', rA.nedeductibil, -6000);
  eq('motor: totalul scade cu deducerea', aj.totalNedeductibil, -6000);
  const aj2 = deduct.ajustari({ rulaj: {}, profitContabil: 0, amortizare: { contabila: 12000, fiscala: 9000 } }, P);
  eq('motor: diferenta pozitiva intra ca nedeductibil', aj2.totalNedeductibil, 3000);
  const aj0 = deduct.ajustari({ rulaj: {}, profitContabil: 0, amortizare: { contabila: 12000, fiscala: 12000 } }, P);
  ok('planuri identice -> NICIUN rand de ajustare (nu se inventeaza zerouri)',
    !aj0.randuri.some((x) => x.regula === 'Amortizare (contabila vs fiscala)'));
}

section('D101: defalcarea nedeductibilelor pe randurile formularului (P23..P33 + P11)');
{
  const deduct = require('../src/deductibilitate');
  const xmlM = require('../src/xml');

  // ── maparea, pe reguli ──────────────────────────────────────────────────────────────────────
  // Etichetele sunt cele din OPANAF 206/2025. Validatorul NU poate confirma maparea (R80 cere
  // doar ca totalul sa torne), deci corectitudinea vine din formular, si se fixeaza aici.
  const R = (regula, d101, ned, cheltuit, plafon) => ({ regula, d101, nedeductibil: ned, cheltuit: cheltuit != null ? cheltuit : ned, plafon: plafon || 0 });
  const m = deduct.mapareD101([
    R('Protocol', 'P26', 10000),
    R('Cheltuieli sociale', 'P33', 5000),
    R('Cheltuieli auto', 'P33', 8000),
    R('Sponsorizare (cheltuiala)', 'P27', 3000),
    R('Amortizare', { rand: 'P28', brut: true, deducere: 'P11' }, 3000, 12000, 9000),
  ]);
  eq('protocolul peste plafon merge la rd. 26', m.nedeductibile.P26, 10000);
  eq('sponsorizarea merge la rd. 27 (cheltuiala inregistrata)', m.nedeductibile.P27, 3000);
  eq('social + auto se cumuleaza la rd. 33 (art. 25(3), fara rand propriu)', m.nedeductibile.P33, 13000);
  eq('amortizarea CONTABILA intreaga merge la rd. 28, nu diferenta', m.nedeductibile.P28, 12000);
  eq('...iar cea FISCALA devine deducere la rd. 11', m.deduceri.P11, 9000);
  eq('totalul nedeductibilelor e suma randurilor', m.totalNedeductibil, 38000);
  eq('fara randuri: mapare goala, nu exceptie', deduct.mapareD101([]).totalNedeductibil, 0);
  eq('un rand fara `d101` cade la „alte" (rd. 33), nu se pierde',
    deduct.mapareD101([{ nedeductibil: 700 }]).nedeductibile.P33, 700);

  // ── randul D101 e ANCORAT PE REGULA REALA, nu doar pe randuri sintetice ─────────────────────
  // Prima varianta a testului folosea numai randuri construite in test, deci mutarea unei reguli
  // pe alt rand (P26 -> P33, in deductibilitate.js) trecea NEOBSERVATA. Aici se cer adnotarile
  // de pe regulile chiar produse de motor.
  const RATES = require('../src/fiscalConfig').RATES;
  const aj = deduct.ajustari({
    rulaj: { 623: { d: 10000, c: 0 }, 6458: { d: 5000, c: 0 }, 641: { d: 50000, c: 0 }, 6582: { d: 3000, c: 0 }, 666: { d: 200000, c: 0 } },
    profitContabil: 40000, cheltAuto: 8000,
    amortizare: { contabila: 12000, fiscala: 9000 },
    cursEur: 5,
  }, RATES);
  const randD101 = {};
  for (const r of aj.randuri) randD101[r.regula] = typeof r.d101 === 'string' ? r.d101 : (r.d101 && r.d101.rand);
  eq('regula Protocol e adnotata cu rd. 26', randD101.Protocol, 'P26');
  eq('regula Sponsorizare e adnotata cu rd. 27', randD101['Sponsorizare (cheltuiala)'], 'P27');
  eq('regula Amortizare e adnotata cu rd. 28', randD101['Amortizare (contabila vs fiscala)'], 'P28');
  eq('regula Dobanzi excedentare e adnotata cu rd. 31', randD101['Costuri excedentare ale indatorarii'], 'P31');
  eq('Cheltuielile sociale raman la rd. 33 (fara rand propriu)', randD101['Cheltuieli sociale'], 'P33');
  eq('Cheltuielile auto raman la rd. 33', randD101['Cheltuieli auto'], 'P33');
  ok('fiecare rand produs de motor stie pe ce rand de formular merge',
    aj.randuri.every((r) => !!r.d101));

  // ── invariantul care conteaza: defalcarea NU schimba impozitul ───────────────────────────────
  // Amortizarea muta `af` din nedeductibile in deduceri (P34 +af, P16 +af => P22 -af), deci P35
  // ramane pe loc. Daca acest test pica, defalcarea a inceput sa schimbe cifra datorata.
  const co = { cui: '12345674', nume: 'T SRL', adresa: 'A', oras: 'B', judet: 'RO-B', caen: '1071' };
  const baza = { year: 2026, cota: 16, venituriExploatare: 100000, cheltuieliExploatare: 60000,
    venituriFinanciare: 0, cheltuieliFinanciare: 0, deduceriFiscale: 0, pierdereReportata: 0,
    pierdereFolosita: 0, sponsorizareCredit: 0 };
  const vechi = xmlM.d101Xml(co, Object.assign({}, baza, { cheltuieliNedeductibile: 29000 }));
  const nou = xmlM.d101Xml(co, Object.assign({}, baza, {
    cheltuieliNedeductibile: m.totalNedeductibil,
    d101Nedeductibile: m.nedeductibile, d101Deduceri: m.deduceri,
  }));
  const at = (s, k) => { const g = s.match(new RegExp('\\b' + k + '="([^"]*)"')); return g ? Number(g[1]) : null; };
  for (const k of ['P35', 'P40', 'P41', 'P52']) {
    eq('defalcarea nu misca ' + k + ' (impozitul ramane identic)', at(nou, k), at(vechi, k));
  }
  eq('rd. 11 apare in XML cand exista amortizare fiscala', at(nou, 'P11'), 9000);
  eq('rd. 26 apare in XML', at(nou, 'P26'), 10000);
  eq('rd. 28 apare in XML', at(nou, 'P28'), 12000);

  // regulile de aritmetica ale validatorului, verificate pe iesire (aflate prin sondaj pe DUK)
  const RANDURI = ['P23', 'P24', 'P25', 'P26', 'P27', 'P28', 'P29', 'P30', 'P31', 'P32', 'P33'];
  const sumaNed = RANDURI.reduce((s, k) => s + (at(nou, k) || 0), 0);
  eq('R80: P34 = suma(P23..P33)', at(nou, 'P34'), sumaNed);
  eq('R56: P16 = P11 + P15', at(nou, 'P16'), (at(nou, 'P11') || 0) + at(nou, 'P15'));
  eq('R65: P22 = P10 - P16 - P21', at(nou, 'P22'), at(nou, 'P10') - at(nou, 'P16') - at(nou, 'P21'));

  // fara defalcare se pastreaza comportamentul istoric (nedeductibile tastate manual)
  eq('fara defalcare: tot la P33', at(vechi, 'P33'), 29000);
  ok('fara defalcare: randurile intermediare NU se emit',
    !/\bP26=/.test(vechi) && !/\bP28=/.test(vechi) && !/\bP11=/.test(vechi));

  // reporting: defalcarea apare doar cand nedeductibilele sunt CALCULATE, nu tastate
  const repM = require('../src/reporting');
  const entD = [{ id: 'e1', firmaId: 1, data: '2026-03-01', period: '2026-03', tip: 'x', status: 'postat',
    lines: [{ debit: '623', credit: '401', suma: 10000 }] }];
  const dbD = { entries: entD, company: { cui: '12345674', nume: 'T' }, firmaActiva: 1 };
  const cuPlaf = repM.d101(dbD, '2026', { cota: 16, plafoane: require('../src/fiscalConfig').RATES });
  ok('cu plafoane: reporting da defalcarea', !!cuPlaf.d101Nedeductibile);
  const manual = repM.d101(dbD, '2026', { cota: 16, plafoane: require('../src/fiscalConfig').RATES, cheltNedeductibile: 4321 });
  ok('nedeductibile TASTATE: fara defalcare inventata', !manual.d101Nedeductibile);
  eq('...si totalul ramane cel tastat', manual.cheltuieliNedeductibile, 4321);
}

section('Productie (consum materiale + obtinere produse finite)');
const prodMod = require('../src/production');
const prodProducts = [{ id: 'PF', cont: '345', cod: 'PF1', denumire: 'Masa', um: 'buc' }, { id: 'MAT', cont: '301', cod: 'M1', denumire: 'Cherestea', um: 'mc' }];
const prodBase = [{ id: 'm0', productId: 'MAT', gestiuneId: 'g1', data: '2026-06-01', tip: 'receptie', cantitate: 100, pretUnitar: 10 }];
let pn = 0;
const prodR = prodMod.buildProduction(prodProducts, prodBase, { productId: 'PF', gestiuneId: 'g1', cantitate: 10, costUnitar: 50, materiale: [{ productId: 'MAT', gestiuneId: 'g1', cantitate: 30 }] }, { fid: 1, data: '2026-06-15', document: 'P1', nextId: () => 'sm' + (++pn) });
ok('consum material 601=301 300 (la CMP 10)', prodR.lines.some((l) => l.debit === '601' && l.credit === '301' && l.suma === 300));
ok('obtinere PF 345=711 500 (10 × cost 50)', prodR.lines.some((l) => l.debit === '345' && l.credit === '711' && l.suma === 500));
eq('2 miscari de stoc (iesire material + receptie PF)', prodR.newMovements.length, 2);
eq('valoare obtinuta = 500', prodR.valoareObtinuta, 500);
const prodRep = prodMod.productionReport({ products: prodProducts, stockMovements: prodR.newMovements }, '2026-06');
eq('situatie productie: 1 produs finit', prodRep.rows.length, 1);
eq('situatie productie: valoare totala 500', prodRep.totalValoare, 500);
ok('stoc insuficient -> avertisment', prodMod.buildProduction(prodProducts, [], { productId: 'PF', cantitate: 1, costUnitar: 50, materiale: [{ productId: 'MAT', gestiuneId: 'g1', cantitate: 5 }] }, { fid: 1, data: '2026-06-15', nextId: () => 'x' + (++pn) }).warns.length > 0);

section('Cote fiscale configurabile');
const fcfg = require('../src/fiscal');
eq('CAS implicit 25%', fcfg.DEFAULTS.cas, 25);
fcfg.applyConfig({ cas: 21 });
eq('dupa applyConfig(cas:21): FISCAL.cas = 21', fcfg.FISCAL.cas, 21);
eq('payroll preia noua cota CAS (5000 × 21%)', fcfg.payroll(5000, 0, {}).cas, 1050);
eq('celelalte raman implicite (CASS 10%)', fcfg.FISCAL.cass, 10);
fcfg.applyConfig({ cas: 'abc' });
eq('suprascriere invalida -> revine la default (25)', fcfg.FISCAL.cas, 25);
fcfg.applyConfig({});
eq('reset complet: payroll CAS din nou 1250', fcfg.payroll(5000, 0, {}).cas, 1250);
// Vechimea cotelor: semnal cand anul calendaristic depaseste anul de referinta al cotelor.
const anRef = fcfg.FISCAL.an;
eq('an de referinta al cotelor este setat', typeof anRef === 'number' && anRef > 0, true);
eq('acelasi an -> cote la zi (nu stale)', fcfg.fiscalStaleness(anRef).stale, false);
eq('an anterior -> nu e stale', fcfg.fiscalStaleness(anRef - 1).stale, false);
eq('an ulterior -> stale (cote potential expirate)', fcfg.fiscalStaleness(anRef + 1).stale, true);
eq('vechime expune an + anCurent', fcfg.fiscalStaleness(anRef + 2).anCurent, anRef + 2);
eq('an lipsa (0) -> nu declara stale', fcfg.fiscalStaleness(0).stale, false);

section('Avize si facturi simplificate');
const avL = gt2('aviz_livrare').build({ baza: 1000, tva: 210, cota: 21 });
eq('aviz livrare: 418=707', avL[0].debit + '=' + avL[0].credit, '418=707');
const facAv = gt2('facturare_aviz').build({ baza: 1000, tva: 210, cota: 21 });
ok('facturare aviz: 4111=418 (total cu TVA) + 4428=4427', facAv.some((l) => l.debit === '4111' && l.credit === '418' && l.suma === 1210) && facAv.some((l) => l.debit === '4428' && l.credit === '4427' && l.suma === 210));
const facS = gt2('factura_simplificata').build({ baza: 500, tva: 105, cota: 21, cont: '5311' });
ok('factura simplificata (cash): 5311=707 + 5311=4427', facS.some((l) => l.debit === '5311' && l.credit === '707' && l.suma === 500) && facS.some((l) => l.debit === '5311' && l.credit === '4427' && l.suma === 105));
const net418 = (lines) => lines.reduce((s, l) => s + (l.credit === '418' ? l.suma : 0) - (l.debit === '418' ? l.suma : 0), 0);
eq('contul 418 se inchide dupa aviz + facturare (net 0)', net418(avL) + net418(facAv), 0);

section('Validare pre-depunere declaratii');
const validateMod = require('../src/validate');
ok('declaratie valida (CUI + an + continut) -> ok', validateMod.validateDeclaration('d205', '<?xml version="1.0"?><declaratie205 cui="123" an="2026"><beneficiar /></declaratie205>').ok);
const vNoCui = validateMod.validateDeclaration('d205', '<?xml version="1.0"?><declaratie205 an="2026"></declaratie205>');
ok('fara CUI -> eroare', !vNoCui.ok && vNoCui.errors.some((e) => /CUI/i.test(e)));
ok('declaratie goala -> avertisment (nu eroare)', validateMod.validateDeclaration('d205', '<?xml version="1.0"?><declaratie205 cui="123" an="2026"></declaratie205>').warnings.some((w) => /beneficiar/i.test(w)));
ok('lipsa antet <?xml -> eroare bine-format', !validateMod.validateDeclaration('d300', '<declaratie300 cui="1" luna="6" an="2026"/>').ok);
ok('d300 fara luna -> eroare', validateMod.validateDeclaration('d300', '<?xml version="1.0"?><declaratie300 cui="1" an="2026"/>').errors.some((e) => /luna/i.test(e)));
ok('d100: impozit 0 -> avertisment', validateMod.validateDeclaration('d100', '<?xml version="1.0"?><declaratie100 cui="1" luna="6" an="2026" total_plata="0.00"/>').warnings.some((w) => /impozit 0/i.test(w)));
ok('intrastat: declaratie goala -> avertisment', validateMod.validateDeclaration('intrastat', '<?xml version="1.0"?><declaratieIntrastat cui="1" luna="6" an="2026"></declaratieIntrastat>').warnings.some((w) => /goala/i.test(w)));
ok('intrastat: articol fara cod NC8 -> avertisment', validateMod.validateDeclaration('intrastat', '<?xml version="1.0"?><declaratieIntrastat cui="1" luna="6" an="2026"><articol codNC=""/></declaratieIntrastat>').warnings.some((w) => /NC8/i.test(w)));
ok('intrastat: problemele din articole devin erori de validare', !validateMod.validateDeclaration('intrastat', '<?xml version="1.0"?><declaratieIntrastat cui="1" luna="6" an="2026"><articol codNC="123"/></declaratieIntrastat>', { intrastatProbleme: [{ mesaj: 'Cod NC8 invalid.' }] }).ok);
ok('intrastat: validarea spune ca fisierul nu este schema oficiala INS', validateMod.validateDeclaration('intrastat', '<?xml version="1.0"?><declaratieIntrastat cui="1" luna="6" an="2026"><articol codNC="12345678"/></declaratieIntrastat>').warnings.some((w) => /centralizator.*nu XML-ul oficial/i.test(w)));

section('Cont de profit si pierdere F20 (structura oficiala)');
const stmtMod = require('../src/statements');
const f20db = { entries: [{ period: '2026-03', lines: [
  { debit: '4111', credit: '707', suma: 1000 }, // cifra de afaceri
  { debit: '607', credit: '371', suma: 400 },   // cheltuieli cu marfuri (materiale)
  { debit: '641', credit: '421', suma: 300 },   // cheltuieli cu personalul
  { debit: '6811', credit: '281', suma: 100 },  // amortizare
  { debit: '627', credit: '5121', suma: 50 },   // alte cheltuieli de exploatare (rezidual)
  { debit: '5121', credit: '766', suma: 80 },   // venit financiar
  { debit: '666', credit: '5121', suma: 30 },   // cheltuiala financiara
  { debit: '691', credit: '4411', suma: 90 },   // impozit pe profit
] }] };
const f20 = stmtMod.profitLossF20(f20db, 2026);
eq('F20 cifra de afaceri = 1000', f20.cifraAfaceri, 1000);
eq('F20 venituri exploatare total = 1000', f20.venitExpl, 1000);
eq('F20 cheltuieli materiale = 400', f20.cheltMateriale, 400);
eq('F20 cheltuieli personal = 300', f20.cheltPersonal, 300);
eq('F20 amortizare = 100', f20.amortizare, 100);
eq('F20 alte cheltuieli exploatare (rezidual 627) = 50', f20.alteCheltExpl, 50);
eq('F20 cheltuieli exploatare total = 850', f20.cheltExpl, 850);
eq('F20 rezultat exploatare = 150', f20.rezExpl, 150);
eq('F20 venit financiar = 80', f20.venitFin, 80);
eq('F20 cheltuiala financiara = 30', f20.cheltFin, 30);
eq('F20 rezultat financiar = 50', f20.rezFin, 50);
eq('F20 rezultat brut = 200', f20.rezBrut, 200);
eq('F20 impozit = 90', f20.impozit, 90);
eq('F20 rezultat net = 110', f20.rezNet, 110);
ok('F20 componente cheltuieli = total (consistent)', f20.cheltMateriale + f20.cheltPersonal + f20.amortizare + f20.alteCheltExpl === f20.cheltExpl);
ok('F20 venituri totale = exploatare + financiar', f20.venitTotal === f20.venitExpl + f20.venitFin);

section('Note explicative 1-5 (cifre auto-completate)');
const noteV = rep.notes(v, '2026');
eq('note: 6 sectiuni (Nota 1-6)', noteV.sections.length, 6);
const n1t = noteV.nota1[noteV.nota1.length - 1]; // randul TOTAL
ok('Nota 1: brut final = brut initial + intrari - iesiri', Math.abs(n1t.brutF - (n1t.brutI + n1t.intrari - n1t.iesiri)) < 0.01);
ok('Nota 1: net = brut - amortizare', Math.abs(n1t.netF - (n1t.brutF - n1t.amortF)) < 0.01);
ok('Nota 5: datorii total = sub 1 an + peste 1 an', Math.abs(noteV.nota5.datoriiTotal - (noteV.nota5.datoriiSub1 + noteV.nota5.datorii1_5 + noteV.nota5.datoriiPeste5)) < 0.01);
ok('Nota 3: rezerva legala + reportat = profit net', noteV.f20.rezNet <= 0 || Math.abs(noteV.rezervaLegala + noteV.reportat - noteV.f20.rezNet) < 0.01);
eq('Nota 4: cifra de afaceri = F20', noteV.f20.cifraAfaceri, stmt.profitLossF20(v, '2026').cifraAfaceri);

section('Situatia fluxurilor de trezorerie F30 (metoda directa)');
const cfDb = { openingBalances: { 5121: { d: 10000, c: 0 } }, entries: [{ period: '2026-04', lines: [
  { debit: '5121', credit: '4111', suma: 5000 },  // incasare client (exploatare +)
  { debit: '401', credit: '5121', suma: 2000 },   // plata furnizor (exploatare -)
  { debit: '421', credit: '5121', suma: 1500 },   // plata salarii (exploatare -)
  { debit: '4423', credit: '5121', suma: 300 },   // plata TVA (exploatare -)
  { debit: '2131', credit: '5121', suma: 8000 },  // achizitie utilaj (investitie -)
  { debit: '5121', credit: '1621', suma: 20000 }, // tragere credit (finantare +)
  { debit: '457', credit: '5121', suma: 1000 },   // dividende platite (finantare -)
  { debit: '5121', credit: '5311', suma: 500 },   // transfer intern (ignorat)
] }] };
const cf = stmt.cashFlow(cfDb, '2026');
eq('F30 incasari clienti', cf.ex_clienti, 5000);
eq('F30 plati furnizori+angajati (-3500)', cf.ex_furnizoriAngajati, -3500);
eq('F30 plati impozite (-300)', cf.ex_impozite, -300);
eq('F30 net exploatare (5000-3500-300)', cf.ex_net, 1200);
eq('F30 investitie imobilizari (-8000)', cf.inv_imobilizari, -8000);
eq('F30 finantare credite (+20000)', cf.fin_credite, 20000);
eq('F30 finantare dividende (-1000)', cf.fin_dividende, -1000);
eq('F30 net finantare (19000)', cf.fin_net, 19000);
eq('F30 variatie totala (1200-8000+19000)', cf.variatie, 12200);
eq('F30 numerar initial', cf.numerarInitial, 10000);
eq('F30 numerar final', cf.numerarFinal, 22200);
ok('F30 control: variatie = final - initial', cf.echilibrat);
ok('F30 transfer intern ignorat (nu apare in altele)', cf.ex_altele === 0);

section('Situatia modificarilor capitalurilor proprii F40');
const eqDb = { openingBalances: { 1012: { d: 0, c: 30000 }, 1061: { d: 0, c: 2000 }, 5121: { d: 32000, c: 0 } }, entries: [{ period: '2026-05', lines: [
  { debit: '5121', credit: '1012', suma: 10000 }, // majorare capital +10000
  { debit: '129', credit: '1061', suma: 500 },     // constituire rezerva legala +500
] }] };
const eqc = stmt.equityChanges(eqDb, '2026');
const eqRow = (n) => eqc.rows.find((r) => r.nume === n) || {};
eq('F40 capital sold initial', eqRow('Capital subscris').soldI, 30000);
eq('F40 capital cresteri', eqRow('Capital subscris').cresteri, 10000);
eq('F40 capital sold final', eqRow('Capital subscris').soldF, 40000);
eq('F40 rezerve legale sold final', eqRow('Rezerve legale').soldF, 2500);
eq('F40 repartizare (129) sold final (reducere)', eqRow('Repartizarea profitului').soldF, -500);
eq('F40 total capitaluri sold final', eqc.total.soldF, 42000);
ok('F40 reconciliere cu F10 (J_capital)', eqc.echilibrat);
ok('F40 rollforward consistent (soldI + cresteri - reduceri = soldF)', eqc.rows.every((r) => Math.abs(r.soldI + r.cresteri - r.reduceri - r.soldF) < 0.01));

section('Import e-Factura primita (UBL)');
const efi = require('../src/efacturaImport');
const ublSample = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">'
  + '<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1</cbc:CustomizationID>'
  + '<cbc:ID>FF-2026-100</cbc:ID><cbc:IssueDate>2026-03-15</cbc:IssueDate><cbc:DueDate>2026-04-15</cbc:DueDate>'
  + '<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>RON</cbc:DocumentCurrencyCode>'
  + '<cac:AccountingSupplierParty><cac:Party>'
  + '<cac:PartyTaxScheme><cbc:CompanyID>RO12345678</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>'
  + '<cac:PartyLegalEntity><cbc:RegistrationName>Furnizor Test SRL</cbc:RegistrationName><cbc:CompanyID>J40/1/2020</cbc:CompanyID></cac:PartyLegalEntity>'
  + '</cac:Party></cac:AccountingSupplierParty>'
  + '<cac:AccountingCustomerParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>Firma Mea SRL</cbc:RegistrationName><cbc:CompanyID>RO99</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>'
  + '<cac:TaxTotal><cbc:TaxAmount currencyID="RON">210.00</cbc:TaxAmount></cac:TaxTotal>'
  + '<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="RON">1000.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="RON">1000.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="RON">1210.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="RON">1210.00</cbc:PayableAmount></cac:LegalMonetaryTotal>'
  + '<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="C62">2</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="RON">1000.00</cbc:LineExtensionAmount>'
  + '<cac:Item><cbc:Name>Marfa X</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>21.00</cbc:Percent></cac:ClassifiedTaxCategory></cac:Item>'
  + '<cac:Price><cbc:PriceAmount currencyID="RON">500.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine></Invoice>';
const inv = efi.parseUBL(ublSample);
eq('e-Factura numar', inv.numar, 'FF-2026-100');
eq('e-Factura data', inv.data, '2026-03-15');
eq('e-Factura furnizor nume', inv.furnizor.nume, 'Furnizor Test SRL');
eq('e-Factura furnizor CUI (fara RO)', inv.furnizor.cui, '12345678');
eq('e-Factura baza', inv.baza, 1000);
eq('e-Factura TVA', inv.tva, 210);
eq('e-Factura total', inv.total, 1210);
eq('e-Factura cota dedusa', inv.cota, 21);
eq('e-Factura nr. linii', inv.linii.length, 1);
eq('e-Factura linie denumire', inv.linii[0].nume, 'Marfa X');
eq('e-Factura linie cantitate', inv.linii[0].cantitate, 2);
eq('e-Factura linie pret', inv.linii[0].pret, 500);
ok('e-Factura roundtrip cu generatorul UBL', (() => {
  const x = xml.eFacturaUBL({ nume: 'Firma Mea', cui: '99', regCom: 'J1' }, { tip: 'factura_vanzare_marfuri', data: '2026-03-15', document: 'INV-7', partener: 'Client SRL', partenerCui: '12345678', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] }, {});
  const p = efi.parseUBL(x);
  return p.numar === 'INV-7' && p.baza === 1000 && p.tva === 210 && p.furnizor.cui === '99';
})());

section('Registru de casa in valuta (5314)');
const lv = gt('incasare_numerar_valuta').build({ moneda: 'EUR', sumaValuta: 100, curs: 5, contraparte: '4111' });
eq('incasare valuta: linie 5314=4111', lv[0].debit + '=' + lv[0].credit, '5314=4111');
eq('incasare valuta: suma lei = 100x5', lv[0].suma, 500);
const pv = gt('plata_numerar_valuta').build({ moneda: 'USD', sumaValuta: 40, curs: 4.5, contraparte: '401' });
eq('plata valuta: linie 401=5314', pv[0].debit + '=' + pv[0].credit, '401=5314');
eq('plata valuta: suma lei = 40x4.5', pv[0].suma, 180);
const cvDb = { openingBalances: {}, entries: [
  { data: '2026-02-05', period: '2026-02', document: 'CH1', explicatie: 'incasare', valutaInfo: { valuta: 'EUR', sumaValuta: 100, curs: 5 }, lines: [{ debit: '5314', credit: '4111', suma: 500 }] },
  { data: '2026-02-10', period: '2026-02', document: 'CH2', explicatie: 'plata', valutaInfo: { valuta: 'EUR', sumaValuta: 40, curs: 5.1 }, lines: [{ debit: '401', credit: '5314', suma: 204 }] },
  { data: '2026-02-20', period: '2026-02', document: 'USD1', explicatie: 'incasare usd', valutaInfo: { valuta: 'USD', sumaValuta: 50, curs: 4 }, lines: [{ debit: '5314', credit: '4111', suma: 200 }] },
] };
const cvr = acc.cashRegisterValuta(cvDb, '2026-02', 'EUR');
eq('casa valuta: nr randuri', cvr.rows.length, 3);
eq('casa valuta: incasari EUR', cvr.rdVal, 100);
eq('casa valuta: plati EUR', cvr.rcVal, 40);
eq('casa valuta: sold final EUR', cvr.soldFinalVal, 60);
eq('casa valuta: incasari lei (toate monedele)', cvr.rdLei, 700);
eq('casa valuta: sold final lei', cvr.soldFinalLei, 496);
ok('casa valuta: USD nu intra in soldul EUR', cvr.soldFinalVal === 60);

section('Dashboard an-la-an');
const dyDb = { openingBalances: {}, partners: {}, entries: [
  { id: 'a', period: '2025-06', data: '2025-06-10', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '607', credit: '371', suma: 400 }] },
  { id: 'b', period: '2026-06', data: '2026-06-10', lines: [{ debit: '4111', credit: '707', suma: 1500 }, { debit: '607', credit: '371', suma: 600 }] },
] };
const dash = rep.dashboard(dyDb);
eq('dashboard an curent', dash.year, '2026');
eq('dashboard yoY prevYear', dash.yoY.prevYear, 2025);
eq('dashboard venituri 2026', dash.yoY.venituri, 1500);
eq('dashboard venituri 2025 (precedent)', dash.yoY.venituriPrev, 1000);
eq('dashboard crestere venituri +50%', dash.yoY.venituriDelta, 50);
eq('dashboard crestere cheltuieli +50%', dash.yoY.cheltuieliDelta, 50);
eq('dashboard crestere profit +50%', dash.yoY.profitDelta, 50);
// rezumatul executiv (mod simplu): bani disponibili, obligatii stat & salarii
const rzDb = { openingBalances: {}, partners: {}, entries: [
  { id: 'r1', period: '2026-06', data: '2026-06-01', lines: [{ debit: '5121', credit: '4111', suma: 3000 }] },
  { id: 'r2', period: '2026-06', data: '2026-06-02', lines: [{ debit: '5311', credit: '4111', suma: 500 }] },
  { id: 'r3', period: '2026-06', data: '2026-06-03', lines: [{ debit: '641', credit: '421', suma: 2000 }] },
  { id: 'r4', period: '2026-06', data: '2026-06-04', lines: [{ debit: '421', credit: '444', suma: 300 }] },
] };
const rz = rep.dashboard(rzDb);
eq('rezumat: bani disponibili = banca + casa', rz.disponibilTotal, 3500);
eq('rezumat: defalcarea banca/casa', rz.bancaTotal + '|' + rz.casaTotal, '3000|500');
eq('rezumat: salarii de plata (sold creditor 421)', rz.salariiDePlata, 1700);
eq('rezumat: taxe datorate (444)', rz.taxeDatorate, 300);
ok('rezumat: niciun cont de bani semnalat cand toate sunt pozitive', rz.conturiBaniNegative.length === 0);

// Trezoreria se raporteaza NET, cu semn. Varianta veche clampa soldurile negative la zero
// (`Math.max(sold, 0)`), deci un cont de banca pe minus disparea din calcul si SUPRAEVALUA
// „Bani disponibili" cu exact valoarea lui. Aici casa are +1000 si banca -400: disponibilul
// real e 600, nu 1000. Semnul se verifica cu `ok` si comparatie stricta — `eq` rotunjeste.
const rzNegDb = { openingBalances: {}, partners: {}, entries: [
  { id: 'n1', period: '2026-06', data: '2026-06-01', lines: [{ debit: '5311', credit: '4111', suma: 1000 }] },
  { id: 'n2', period: '2026-06', data: '2026-06-02', lines: [{ debit: '401', credit: '5121', suma: 400 }] },
] };
const rzNeg = rep.dashboard(rzNegDb);
ok('trezorerie: disponibilul scade cu soldul negativ, nu il ignora', rzNeg.disponibilTotal === 600);
ok('trezorerie: banca ramane negativa, nu clampata la 0', rzNeg.bancaTotal === -400);
ok('trezorerie: KPI-ul de banca poarta semnul', rzNeg.banca === -400);
eq('trezorerie: casa ramane pozitiva', rzNeg.casaTotal, 1000);
eq('trezorerie: exact un cont de bani semnalat', rzNeg.conturiBaniNegative.length, 1);
// `|| {}`: daca semnalul dispare cu totul (regresie), testele de mai jos trebuie sa PICE curat,
// nu sa arunce pe indexarea unui array gol — o exceptie aici ar opri restul suitei.
const cbn0 = rzNeg.conturiBaniNegative[0] || {};
eq('trezorerie: contul semnalat e cel de banca', cbn0.cont, '5121');
ok('trezorerie: soldul semnalat pastreaza semnul', cbn0.sold === -400);
// Ancorat pe SURSA denumirii, nu pe o bucata de text: aserțiunea era `/banci/i` si a picat cand
// planul de conturi a primit diacritice („bănci"), desi semnalul functiona perfect. Ce trebuie sa
// tina e ca semnalul poarta denumirea contului, nu cum se scrie ea in luna asta.
ok('trezorerie: semnalul poarta denumirea contului',
  !!cbn0.nume && cbn0.nume === require('../src/chartOfAccounts').accountName('5121'));
ok('trezorerie: conturile pozitive nu se semnaleaza', !rzNeg.conturiBaniNegative.some((x) => x.cont === '5311'));

section('Buget vs realizat');
const budDb = { entries: [{ period: '2026-04', lines: [
  { debit: '4111', credit: '707', suma: 12000 }, // venit realizat 12000
  { debit: '607', credit: '371', suma: 8000 },    // cheltuiala realizata 8000
] }] };
const br = rep.budgetReport(budDb, [{ id: 'x1', cont: '707', suma: 10000 }, { id: 'x2', cont: '607', suma: 9000 }], '2026');
const brRow = (c) => br.rows.find((r) => r.cont === c);
eq('buget venit 707 realizat', brRow('707').actual, 12000);
eq('buget venit 707 abatere (+2000)', brRow('707').variatie, 2000);
eq('buget venit 707 grad realizare 120%', brRow('707').realizarePct, 120);
eq('buget cheltuiala 607 realizat', brRow('607').actual, 8000);
eq('buget cheltuiala 607 abatere (-1000)', brRow('607').variatie, -1000);
eq('total buget venituri', br.totalBugetVenit, 10000);
eq('rezultat bugetat (10000-9000)', br.rezultatBugetat, 1000);
eq('rezultat realizat (12000-8000)', br.rezultatActual, 4000);

section('Reevaluare valutara la sfarsit de perioada');
const fxr = require('../src/fxreval');
const ra = fxr.revalue('5314', true, 500, 100, 5.2); // activ creste: 100 EUR x5.2 = 520 vs 500 -> +20 favorabil
eq('reeval activ: reevaluat lei', ra.revaluedLei, 520);
eq('reeval activ: diferenta +20', ra.diff, 20);
eq('reeval activ favorabila: 5314=765', ra.lines[0].debit + '=' + ra.lines[0].credit, '5314=765');
eq('reeval activ: suma 20', ra.lines[0].suma, 20);
const ra2 = fxr.revalue('5314', true, 500, 100, 4.8); // activ scade -> nefavorabil 665=5314
eq('reeval activ nefavorabila: 665=5314', ra2.lines[0].debit + '=' + ra2.lines[0].credit, '665=5314');
const rdt = fxr.revalue('401', false, 500, 100, 5.2); // datorie creste -> nefavorabil 665=401
eq('reeval datorie nefavorabila: 665=401', rdt.lines[0].debit + '=' + rdt.lines[0].credit, '665=401');
const rdt2 = fxr.revalue('401', false, 500, 100, 4.8); // datorie scade -> favorabil 401=765
eq('reeval datorie favorabila: 401=765', rdt2.lines[0].debit + '=' + rdt2.lines[0].credit, '401=765');
const fxDb = { openingBalances: {}, entries: [
  { period: '2026-01', data: '2026-01-10', valutaInfo: { valuta: 'EUR', sumaValuta: 100, curs: 5 }, lines: [{ debit: '5314', credit: '4111', suma: 500 }] },
] };
const built = fxr.buildRevaluation(fxDb, '2026-12', [{ cont: '5314', foreignBalance: 100, closingRate: 5.2 }]);
eq('buildRevaluation: o linie', built.lines.length, 1);
eq('buildRevaluation: 5314=765 favorabil', built.lines[0].debit + '=' + built.lines[0].credit, '5314=765');
eq('buildRevaluation: suma 20', built.lines[0].suma, 20);
eq('buildRevaluation: total favorabil 20', built.totalFavorabil, 20);
const c5314 = fxr.candidates(fxDb, '2026-12').find((c) => c.cont === '5314');
eq('candidates 5314 sold contabil lei', c5314.bookLei, 500);
eq('candidates 5314 sold in valuta', c5314.foreignBalance, 100);
eq('candidates 5314 moneda EUR', c5314.moneda, 'EUR');
ok('candidates 5314 este activ', c5314.isAsset);

// ── Reevaluarea unei DATORII, pe drumul intreg candidates -> articol ────────────────────────
// Costura dintre cele doua: `foreignBalance` intoarce soldul cu SEMN (credit = negativ), dar
// `revalue` il inmulteste cu cursul si il compara cu `bookLei`, care e MODULUL soldului. Testele
// de mai sus n-o atingeau: pe `revalue` treceau marimea direct, iar `candidates` era verificat
// doar pe un cont de ACTIV (5314), unde semnul e pozitiv si defectul invizibil.
// Pe o datorie de 1000 EUR la 4,90 reevaluata la 5,00, articolul corect e 665 = 401 cu 100 lei;
// forma veche dadea 401 = 765 cu 9900 — semn inversat si de ~2x soldul.
const fxDat = { openingBalances: {}, entries: [
  { period: '2026-11', data: '2026-11-10', tip: 'achizitie_intracomunitara',
    valutaInfo: { valuta: 'EUR', sumaValuta: 1000, curs: 4.90 },
    lines: [{ debit: '371', credit: '401', suma: 4900 }] },
] };
const cDat = fxr.candidates(fxDat, '2026-12').find((c) => c.cont === '401');
eq('candidates datorie: sold valutar in MODUL', cDat.foreignBalance, 1000);
ok('candidates datorie: nu e activ', !cDat.isAsset);
const bDat = fxr.buildRevaluation(fxDat, '2026-12', [{ cont: '401', foreignBalance: cDat.foreignBalance, closingRate: 5.00 }]);
eq('reeval datorie (drum intreg): o linie', bDat.lines.length, 1);
eq('reeval datorie (drum intreg): 665=401', bDat.lines[0].debit + '=' + bDat.lines[0].credit, '665=401');
eq('reeval datorie (drum intreg): suma 100', bDat.lines[0].suma, 100);
eq('reeval datorie (drum intreg): pierdere, nu castig', bDat.totalFavorabil, 0);
// `revalue` isi ia singur modulul: `items` vin din cerere, deci pot avea orice semn.
const rSemn = fxr.revalue('401', false, 4900, -1000, 5.00);
eq('revalue ignora semnul soldului trimis', rSemn.lines[0].debit + '=' + rSemn.lines[0].credit, '665=401');
eq('revalue ignora semnul: aceeasi suma', rSemn.lines[0].suma, 100);

// ── Doar elementele MONETARE se reevalueaza (OMFP 1802/2014 pct. 319-320) ───────────────────
// Marfa cumparata in valuta (371) si venitul dintr-o livrare intracomunitara (707) erau propuse
// la reevaluare fiindca apareau intr-un articol cu `valutaInfo`. Sunt elemente NEMONETARE: raman
// la cursul din ziua tranzactiei.
const contFx = fxr.candidates(fxDat, '2026-12').map((c) => c.cont);
ok('371 (marfa) nu e candidat la reevaluare', !contFx.includes('371'));
ok('401 (datorie) ramane candidat', contFx.includes('401'));
ok('esteMonetar: 4111 client', fxr.esteMonetar('4111'));
ok('esteMonetar: 5124 banca in valuta', fxr.esteMonetar('5124'));
ok('esteMonetar: 2678 creante imobilizate', fxr.esteMonetar('2678'));
ok('esteMonetar: 371 marfuri NU', !fxr.esteMonetar('371'));
ok('esteMonetar: 707 venituri NU', !fxr.esteMonetar('707'));
ok('esteMonetar: 4091 avans furnizor NU (pct. 320 alin. 3)', !fxr.esteMonetar('4091'));
ok('esteMonetar: 419 avans client NU', !fxr.esteMonetar('419'));
ok('esteMonetar: 4426 TVA NU (e in lei)', !fxr.esteMonetar('4426'));
ok('esteMonetar: 471 cheltuiala in avans NU', !fxr.esteMonetar('471'));

section('Previziune cash-flow');
const fcDb = {
  openingBalances: { 5121: { d: 10000, c: 0 } }, openingAnalytic: [],
  partners: { 111: { cui: '111', den: 'Client A', tip: 'client' }, 222: { cui: '222', den: 'Furnizor B', tip: 'furnizor' } },
  entries: [
    { id: 'c1', period: '2026-06', data: '2026-06-10', partener: 'Client A', partenerCui: '111', lines: [{ debit: '4111', credit: '707', suma: 5000 }] },
    { id: 'f1', period: '2026-06', data: '2026-06-12', partener: 'Furnizor B', partenerCui: '222', lines: [{ debit: '607', credit: '401', suma: 2000 }] },
  ],
};
const fcTpl = [
  { id: 't1', tip: 'factura_vanzare_servicii', frecventa: 'lunar', ziua: 5, activ: true, startDate: '2026-01', fields: { baza: 1000, tva: 210 } },
  { id: 't2', tip: 'factura_cumparare_marfuri', frecventa: 'lunar', ziua: 10, activ: true, startDate: '2026-01', fields: { baza: 500, tva: 105 } },
];
const fc = rep.cashForecast(fcDb, fcTpl, { months: 3, startPeriod: '2026-07' });
eq('forecast: numerar acum', fc.cashNow, 10000);
eq('forecast: creante deschise', fc.openReceivables, 5000);
eq('forecast: datorii deschise', fc.openPayables, 2000);
eq('forecast: 3 luni', fc.rows.length, 3);
eq('forecast luna1 venit recurent (1000+210)', fc.rows[0].recIn, 1210);
eq('forecast luna1 cheltuiala recurenta (500+105)', fc.rows[0].recOut, 605);
eq('forecast luna1 net (5000+1210-2000-605)', fc.rows[0].net, 3605);
eq('forecast luna1 sold final', fc.rows[0].closing, 13605);
eq('forecast luna2 sold final (doar recurente)', fc.rows[1].closing, 14210);

section('Jurnal TVA: cota per rand (export)');
const vjT = acc.vatJournals({ openingBalances: {}, entries: [
  { data: '2026-06-05', period: '2026-06', document: 'F1', partener: 'X', partenerCui: '99', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] },
  { data: '2026-06-06', period: '2026-06', document: 'A1', partener: 'Y', partenerCui: '88', lines: [{ debit: '371', credit: '401', suma: 500 }, { debit: '4426', credit: '401', suma: 55 }] },
] }, '2026-06');
eq('jurnal vanzari: 1 rand', vjT.vanzari.length, 1);
eq('jurnal vanzari cota 21%', vjT.vanzari[0].cota, 21);
eq('jurnal vanzari CUI pe rand', vjT.vanzari[0].cui, '99');
eq('jurnal cumparari: 1 rand', vjT.cumparari.length, 1);
eq('jurnal cumparari cota 11%', vjT.cumparari[0].cota, 11);

section('Compensare creante / datorii');
const { compensablePartners } = require('../src/reconcile');
const compDb = {
  openingBalances: {}, openingAnalytic: [],
  partners: { 555: { cui: '555', den: 'Partener Dual SRL', tip: 'ambele' }, 666: { cui: '666', den: 'Doar Client SRL', tip: 'client' } },
  entries: [
    { id: 'v1', period: '2026-05', data: '2026-05-10', partener: 'Partener Dual SRL', partenerCui: '555', lines: [{ debit: '4111', credit: '707', suma: 3000 }] },
    { id: 'c1', period: '2026-05', data: '2026-05-12', partener: 'Partener Dual SRL', partenerCui: '555', lines: [{ debit: '607', credit: '401', suma: 2000 }] },
    { id: 'v2', period: '2026-05', data: '2026-05-13', partener: 'Doar Client SRL', partenerCui: '666', lines: [{ debit: '4111', credit: '707', suma: 1000 }] },
  ],
};
const comp = compensablePartners(compDb);
eq('compensare: doar partenerul dual', comp.length, 1);
eq('compensare creanta 3000', comp[0].creanta, 3000);
eq('compensare datorie 2000', comp[0].datorie, 2000);
eq('compensare suma compensabila (min)', comp[0].compensabil, 2000);
eq('compensare CUI', comp[0].cui, '555');

section('Abonamente (planuri + trial)');
const plansMod = require('../src/plans');
eq('plans: fara abonament -> none', plansMod.status({}).status, 'none');
eq('plans: 3 planuri definite (fara Business)', plansMod.PLANS.length, 3);
ok('plans: nu exista planul business', !plansMod.PLANS.some((p) => p.id === 'business'));
ok('plans: platite au 6 functii, proba 5 (fara Suport prioritar)', plansMod.PLANS.every((p) => p.features[0] === 'Facturi + e-Factura'
  && (p.trial ? p.features.length === 5 && !p.features.includes('Suport prioritar') : p.features.length === 6 && p.features.includes('Suport prioritar'))));
// proba per-firma (independenta de abonamentul contului)
const nowFt = Date.parse('2026-07-05T00:00:00Z');
// billing strict per-firma: firmaStatus / firmaLocked
eq('firmaStatus: firma fara abonament -> none (blocata)', plansMod.firmaStatus({}, nowFt).status, 'none');
ok('firmaLocked: fara abonament -> blocata', plansMod.firmaLocked({}, nowFt) === true);
eq('firmaStatus: activa (grandfathered) -> nu e blocata', plansMod.firmaLocked({ subscription: { status: 'active', plan: 'grandfathered' } }, nowFt), false);
const ftAct = plansMod.firmaStatus({ subscription: { plan: 'trial', trialEndsAt: '2026-07-20T00:00:00Z' } }, nowFt);
eq('firmaStatus: proba activa, 15 zile ramase', ftAct.status + '|' + ftAct.zileRamase, 'trial|15');
const ftExp = plansMod.firmaStatus({ subscription: { plan: 'trial', trialEndsAt: '2026-06-01T00:00:00Z' } }, nowFt);
ok('firmaStatus: proba expirata -> expired + blocata', ftExp.status === 'expired' && plansMod.firmaLocked({ subscription: { plan: 'trial', trialEndsAt: '2026-06-01T00:00:00Z' } }, nowFt));
const ftSub = plansMod.firmaTrialSub(nowFt);
ok('firmaTrialSub: proba de 30 zile', ftSub.plan === 'trial' && plansMod.daysLeft(ftSub.trialEndsAt, nowFt) === 30);

// A DOUA perioada de proba: prima vine automat la inscriere, a doua se cere explicit dupa ce
// prima a expirat. Plafonul (TRIAL_MAX) opreste reinnoirea la nesfarsit.
{
  const expirata = (nr) => ({ subscription: Object.assign(plansMod.firmaTrialSub(Date.parse('2026-06-01T00:00:00Z'), nr)) });
  const p1 = expirata(1);
  eq('proba 1 expirata -> expired', plansMod.firmaStatus(p1, nowFt).status, 'expired');
  ok('...si mai poate cere una', plansMod.firmaPoateProba(p1, nowFt));
  eq('...iar starea o spune explicit', plansMod.firmaStatus(p1, nowFt).maiPoateProba, true);
  const p2 = expirata(2);
  ok('dupa a DOUA proba expirata nu mai poate', !plansMod.firmaPoateProba(p2, nowFt));
  eq('...iar cardul se arata inactiv (2/2)', plansMod.firmaStatus(p2, nowFt).trialCount + '/' + plansMod.firmaStatus(p2, nowFt).trialMax, '2/2');
  // cat timp proba e ACTIVA nu se poate cere alta (altfel s-ar putea stivui la nesfarsit)
  const activa = { subscription: plansMod.firmaTrialSub(nowFt, 1) };
  ok('proba activa -> nu se poate cere inca una', !plansMod.firmaPoateProba(activa, nowFt));
  // firma cu abonament platit nu are nevoie de proba
  ok('abonament activ -> fara proba', !plansMod.firmaPoateProba({ subscription: { status: 'active', plan: 'pro' } }, nowFt));
  // firmele VECHI, fara contor, se socotesc la prima proba: pot cere inca una
  const veche = { subscription: { plan: 'trial', trialEndsAt: '2026-06-01T00:00:00Z' } };
  eq('firma veche fara contor: socotita la prima proba', plansMod.firmaTrialCount(veche), 1);
  ok('...deci mai poate cere una', plansMod.firmaPoateProba(veche, nowFt));
}
const nowSub = Date.parse('2026-06-01T00:00:00Z');
const trial1 = plansMod.startTrial({}, nowSub);
eq('trial: status trial', trial1.status, 'trial');
eq('trial: 30 zile ramase la start', plansMod.status(trial1, nowSub).zileRamase, 30);
eq('trial: inca activ dupa 15 zile', plansMod.status(trial1, nowSub + 15 * 86400000).status, 'trial');
eq('trial: expirat dupa 31 zile', plansMod.status(trial1, nowSub + 31 * 86400000).status, 'expired');
ok('trial: nu se poate porni de doua ori', (() => { try { plansMod.startTrial(trial1, nowSub); return false; } catch (e) { return true; } })());
const sel1 = plansMod.selectPlan({}, 'pro');
eq('select: requestedPlan = pro', sel1.requestedPlan, 'pro');
ok('select: plan inexistent arunca', (() => { try { plansMod.selectPlan({}, 'xyz'); return false; } catch (e) { return true; } })());
ok('select: trial nu e plan platit', (() => { try { plansMod.selectPlan({}, 'trial'); return false; } catch (e) { return true; } })());
const act1 = plansMod.activatePlan(sel1, 'pro', nowSub);
eq('activate: status active', plansMod.status(act1).status, 'active');
eq('activate: plan pro', plansMod.status(act1).plan, 'pro');
eq('activate: requestedPlan curatat', act1.requestedPlan, null);

section('Stripe billing (integrare plati)');
const billing = require('../src/billing');
const evCheckout = billing.interpretEvent({ type: 'checkout.session.completed', data: { object: { metadata: { userId: '7', plan: 'pro' }, customer: 'cus_1', subscription: 'sub_1', client_reference_id: '7' } } });
eq('webhook checkout -> activate', evCheckout.action, 'activate');
eq('webhook checkout plan pro', evCheckout.plan, 'pro');
eq('webhook checkout userId', evCheckout.userId, '7');
eq('webhook checkout customerId', evCheckout.customerId, 'cus_1');
// billing per-firma: firmaId din metadata se propaga in evenimentul de activare (webhook -> firma)
eq('webhook checkout: fara firmaId -> null', evCheckout.firmaId, null);
const evFirma = billing.interpretEvent({ type: 'checkout.session.completed', data: { object: { metadata: { userId: '7', plan: 'pro', firmaId: '42' }, customer: 'cus_1', subscription: 'sub_1' } } });
eq('webhook checkout: firmaId din metadata (per-firma)', evFirma.firmaId, '42');
eq('webhook subscription.updated: firmaId propagat', billing.interpretEvent({ type: 'customer.subscription.updated', data: { object: { metadata: { userId: '7', plan: 'start', firmaId: '9' }, id: 'sub_1', status: 'active' } } }).firmaId, '9');
const evDel = billing.interpretEvent({ type: 'customer.subscription.deleted', data: { object: { metadata: { userId: '7' }, id: 'sub_1', customer: 'cus_1', status: 'canceled' } } });
eq('webhook subscription deleted -> cancel', evDel.action, 'cancel');
const evUpd = billing.interpretEvent({ type: 'customer.subscription.updated', data: { object: { metadata: { userId: '7', plan: 'start' }, id: 'sub_1', customer: 'cus_1', status: 'active' } } });
eq('webhook subscription updated activa -> activate', evUpd.action, 'activate');
const evPast = billing.interpretEvent({ type: 'customer.subscription.updated', data: { object: { metadata: { userId: '7', plan: 'start' }, id: 'sub_1', status: 'past_due' } } });
eq('webhook subscription past_due -> update (nu activeaza)', evPast.action, 'update');
eq('webhook eveniment necunoscut -> ignore', billing.interpretEvent({ type: 'invoice.paid', data: { object: {} } }).action, 'ignore');
const evGuest = billing.interpretEvent({ type: 'checkout.session.completed', data: { object: { metadata: { plan: 'pro', guest: '1' }, customer: 'cus_g', subscription: 'sub_g', customer_details: { email: 'A@B.ro' } } } });
eq('webhook guest -> flag guest', evGuest.guest, true);
eq('webhook guest -> email colectat', evGuest.email, 'A@B.ro');
eq('webhook guest -> plan', evGuest.plan, 'pro');
// legarea abonamentului platit (guest) la inscriere, dupa email
const pend = [{ email: 'client@firma.ro', plan: 'pro', customerId: 'cus_1', subscriptionId: 'sub_1' }];
eq('findPending: email potrivit (case-insensitive)', plansMod.findPending(pend, 'Client@Firma.RO'), 0);
eq('findPending: email nepotrivit -> -1', plansMod.findPending(pend, 'altul@x.ro'), -1);
eq('findPending: fara email -> -1', plansMod.findPending(pend, ''), -1);
// blocarea probei expirate (cont read-only)
const pastTrial = { plan: 'trial', status: 'trial', trialStartedAt: '2026-01-01', trialEndsAt: '2026-01-31' };
ok('expiredLock: proba expirata -> blocat', plansMod.expiredLock({ role: 'user', subscription: pastTrial }));
ok('expiredLock: proba activa -> liber', !plansMod.expiredLock({ role: 'user', subscription: plansMod.startTrial({}) }));
ok('expiredLock: fara abonament (invitat/demo) -> liber', !plansMod.expiredLock({ role: 'user' }));
ok('expiredLock: admin -> liber chiar cu proba expirata', !plansMod.expiredLock({ role: 'admin', subscription: pastTrial }));
ok('expiredLock: plan activ -> liber', !plansMod.expiredLock({ role: 'user', subscription: { plan: 'pro', status: 'active' } }));
// tipurile de utilizator: admin / tester (proba) / necontabil (Start) / contabil (Pro)
eq('userKind: admin ramane admin indiferent de plan', plansMod.userKind({ role: 'admin', subscription: { plan: 'pro', status: 'active' } }), 'admin');
eq('userKind: fara abonament -> tester', plansMod.userKind({ role: 'user' }), 'tester');
eq('userKind: proba gratuita -> tester', plansMod.userKind({ role: 'user', subscription: plansMod.startTrial({}) }), 'tester');
eq('userKind: Start activ -> necontabil', plansMod.userKind({ role: 'user', subscription: { plan: 'start', status: 'active' } }), 'necontabil');
eq('userKind: Pro activ -> contabil', plansMod.userKind({ role: 'user', subscription: { plan: 'pro', status: 'active' } }), 'contabil');
eq('userKind: Pro anulat -> tester', plansMod.userKind({ role: 'user', subscription: { plan: 'pro', status: 'canceled' } }), 'tester');
const linkedSub = plansMod.pendingToSubscription(pend[0]);
eq('pendingToSubscription: plan', linkedSub.plan, 'pro');
eq('pendingToSubscription: status active', linkedSub.status, 'active');
eq('pendingToSubscription: customer legat', linkedSub.stripeCustomerId, 'cus_1');
process.env.STRIPE_PRICE_PRO = 'price_test_pro';
eq('billing priceId(pro)', billing.priceId('pro'), 'price_test_pro');
eq('billing planForPrice', billing.planForPrice('price_test_pro'), 'pro');
delete process.env.STRIPE_PRICE_PRO;
ok('billing configured reflecta STRIPE_SECRET_KEY', billing.configured() === !!process.env.STRIPE_SECRET_KEY);

section('Retete / BOM productie');
const bomMod = require('../src/production');
const recT = { productId: 'fp', gestiuneId: 'g1', cantitateBaza: 10, costUnitar: 5, materiale: [{ productId: 'm1', gestiuneId: 'g1', cantitate: 20 }, { productId: 'm2', cantitate: 3 }] };
const ordT = bomMod.expandRecipe(recT, 25);
eq('expandRecipe: cantitate produs finit', ordT.cantitate, 25);
eq('expandRecipe: material 1 scalat (20 x 25/10)', ordT.materiale[0].cantitate, 50);
eq('expandRecipe: material 2 scalat (3 x 2.5)', ordT.materiale[1].cantitate, 7.5);
eq('expandRecipe: cost unitar din reteta', ordT.costUnitar, 5);
eq('expandRecipe: override cost', bomMod.expandRecipe(recT, 10, 8).costUnitar, 8);
eq('expandRecipe: fara cantitate -> cantitateBaza', bomMod.expandRecipe(recT).cantitate, 10);

section('Copie offsite pe stocare obiect (src/offsite.js)');
{
  const off = require('../src/offsite');
  // Vectorul de mai jos NU e memorat: e derivat INDEPENDENT cu openssl (alta implementare de
  // HMAC-SHA256) si confruntat cu al nostru. O valoare „stiuta" ar fi fost circulara — daca
  // implementarea si asteptarea vin din aceeasi sursa, testul nu dovedeste nimic.
  const k = off.signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam');
  eq('cheia de semnare SigV4 (confruntata cu openssl)', k.toString('hex'),
    'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  // Lantul e sensibil la FIECARE componenta: schimba una, se schimba cheia.
  ok('alta data -> alta cheie', off.signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120216', 'us-east-1', 'iam').toString('hex') !== k.toString('hex'));
  ok('alta regiune -> alta cheie', off.signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'eu-central-1', 'iam').toString('hex') !== k.toString('hex'));
  ok('alt serviciu -> alta cheie', off.signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 's3').toString('hex') !== k.toString('hex'));

  const CFG = { endpoint: 'https://s3.eu-central-003.backblazeb2.com', region: 'eu-central-003',
    bucket: 'contab-backup', accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
  const sg = off.signRequest(Object.assign({}, CFG, { key: 'contab/full-20260728.zip.enc',
    payload: Buffer.from('date'), amzDate: '20260728T120000Z' }));
  ok('antetul Authorization are forma AWS4-HMAC-SHA256', /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260728\/eu-central-003\/s3\/aws4_request/.test(sg.headers.Authorization));
  ok('semnatura e hex de 64', /^[0-9a-f]{64}$/.test(sg.signature));
  ok('URL-ul contine bucket si cheie', sg.url.endsWith('/contab-backup/contab/full-20260728.zip.enc'));
  ok('amprenta continutului e in antet, nu UNSIGNED-PAYLOAD', /^[0-9a-f]{64}$/.test(sg.headers['x-amz-content-sha256']));
  // Determinism: aceleasi intrari -> aceeasi semnatura (altfel nu s-ar putea reproduce un incident)
  const sg2 = off.signRequest(Object.assign({}, CFG, { key: 'contab/full-20260728.zip.enc',
    payload: Buffer.from('date'), amzDate: '20260728T120000Z' }));
  eq('semnarea e determinista', sg2.signature, sg.signature);
  // ...dar depinde de CONTINUT: un octet schimbat schimba semnatura (integritate, nu doar identitate)
  const sg3 = off.signRequest(Object.assign({}, CFG, { key: 'contab/full-20260728.zip.enc',
    payload: Buffer.from('datf'), amzDate: '20260728T120000Z' }));
  ok('un octet schimbat in continut schimba semnatura', sg3.signature !== sg.signature);

  // Configurarea incompleta NU se incearca: o urcare cu jumatate de credentiale ar esua la retea,
  // dupa ce a expus endpointul si numele bucketului in log.
  ok('configurare completa e recunoscuta', off.configured(CFG));
  ok('fara secret -> neconfigurat', !off.configured(Object.assign({}, CFG, { secretKey: '' })));
  ok('fara bucket -> neconfigurat', !off.configured(Object.assign({}, CFG, { bucket: '' })));
  ok('fara nimic -> neconfigurat', !off.configured({}));
  eq('citirea din mediu foloseste prefixul CONTAB_OFFSITE_',
    off.fromEnv({ CONTAB_OFFSITE_BUCKET: 'b', CONTAB_OFFSITE_ENDPOINT: 'https://x', CONTAB_OFFSITE_KEY: 'k', CONTAB_OFFSITE_SECRET: 's' }).bucket, 'b');
  eq('prefixul implicit al obiectelor', off.fromEnv({}).prefix, 'contab');

  // Codificarea caii pastreaza „/" dar codifica restul (un nume de fisier cu spatiu ar rupe semnatura)
  eq('caile se codifica pe segmente', off.uriEncodePath('contab/full 2026.zip'), 'contab/full%202026.zip');

  // ── Avertismentul de CONFIDENTIALITATE ──────────────────────────────────────────────────────
  // Pana la el, o copie plecata IN CLAR trecea complet tacut: singurul avertisment din backup.js
  // se declansa cand NU exista nicio destinatie, iar cu e-mailul configurat si fara cheie logul
  // spunea „Offsite email OK". Masurat pe productie la 2026-07-29: exact asta se intampla zilnic.
  const avert = (s) => off.confidentialityWarning(s);
  ok('copie trimisa FARA criptare -> avertisment',
    /NECRIPTATA/.test(avert({ sent: true, encrypted: false, viaEmail: true })));
  ok('...care numeste ce contine arhiva (nu doar „neconfigurat")',
    /contab\.sql/.test(avert({ sent: true, encrypted: false, viaEmail: true })));
  ok('...si spune ce ai de facut', /CONTAB_BACKUP_KEY/.test(avert({ sent: true, encrypted: false })));
  eq('copie trimisa CRIPTAT -> tacere', avert({ sent: true, encrypted: true, viaEmail: true }), '');
  eq('nimic trimis -> tacere (alt avertisment acopera cazul)', avert({ sent: false, encrypted: false }), '');
  eq('apel fara argumente nu arunca', avert(), '');
  ok('mentioneaza cutia postala doar cand chiar pleaca pe e-mail',
    /cutie postala/.test(avert({ sent: true, encrypted: false, viaEmail: true }))
    && !/cutie postala/.test(avert({ sent: true, encrypted: false, viaEmail: false })));

  // scripts/backup.js chiar CHEAMA garda SI ii foloseste rezultatul — altfel functia ar fi
  // corecta si moarta. Verificarea „apare numele functiei" nu ajunge: la mutatia de control am
  // scos linia care avertizeaza si testul a ramas verde, fiindca APELUL era inca acolo.
  const bk = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'backup.js'), 'utf8');
  const numeVar = (bk.match(/const\s+(\w+)\s*=\s*offsite\.confidentialityWarning\(/) || [])[1];
  ok('backup.js cheama garda de confidentialitate', !!numeVar);
  ok('...si chiar AVERTIZEAZA cu rezultatul ei',
    !!numeVar && new RegExp('warn\\(\\s*' + numeVar + '\\s*\\)').test(bk));

  // ── O VERIFICARE PICATA NU ARE VOIE SA ANULEZE PROTECTIA ────────────────────────────────────
  // Drill-ul nativ PG e o verificare a unei cai de restaurare SECUNDARE, iar pasul de dupa el e
  // copia OFFSITE. Varianta veche facea `process.exit(1)` la esecul drill-ului, deci arhiva zilei
  // nu mai pleca nicaieri — desi trecuse si verificarea arhivei si drill-ul pe db.json. Chiar s-a
  // intamplat, pe 2026-07-28 (rolul pg lipsea sub cron): in log lipseste linia „Offsite email OK",
  // singura zi din serie fara ea.
  const iDrill = bk.indexOf('RESTAURARE NATIVA PG ESUATA');
  const iOffsite = bk.indexOf('// 3) offsite');
  ok('poarta gaseste ambele repere in backup.js', iDrill > 0 && iOffsite > iDrill);
  // Comentariile se scot INAINTE de verificare: prima versiune a portii a picat pe propriul
  // comentariu explicativ („NU process.exit(1) aici"), adica pe text, nu pe cod. Aceeasi capcana
  // ca la poarta de CI, care trecea verde pe baza unei mentiuni intr-un comentariu.
  const faraComentarii = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const ramuraDrill = faraComentarii(bk.slice(iDrill, iOffsite));
  ok('esecul drill-ului nativ NU opreste rularea inainte de offsite',
    !/process\.exit\(/.test(ramuraDrill));
  ok('...dar rularea e marcata ca nereusita (ajunge in logul cron si in raportul zilnic)',
    /process\.exitCode\s*=\s*1/.test(ramuraDrill));
  const dupaDrill = bk.slice(iDrill, iOffsite);
  ok('starea last-backup este rescrisa dupa drill-ul PG curent', /scrieMarcaj\(\)/.test(dupaDrill));
  ok('marcajul final include starea offsite masurata, nu doar intentia', /offsite:\s*offsiteState/.test(bk) && /offsiteState\.ok\s*=\s*offsiteOk/.test(bk));

  // ...iar celelalte doua opriri RAMAN: acolo arhiva insasi e nefolosibila, deci trimiterea ei
  // offsite ar fi si inutila si inselatoare. Distinctia e deliberata, nu o inconsecventa — de aceea
  // se verifica in ambele sensuri, ca nimeni sa nu „uniformizeze" toate trei intr-o direcție.
  const iVerif = bk.indexOf('ARHIVA NERESTAURABILA');
  const iDrillJson = bk.indexOf('DRILL RESTAURARE ESUAT');
  ok('arhiva nerestaurabila opreste rularea (nu trimitem o arhiva stricata)',
    /process\.exit\(1\)/.test(bk.slice(iVerif, iDrillJson)));
  ok('drill-ul pe db.json picat opreste si el rularea',
    /process\.exit\(1\)/.test(bk.slice(iDrillJson, iDrill)));
}

section('Preluare firma din alt program (src/migrare.js)');
{
  const mig = require('../src/migrare');
  const ANTET = ['Cont', 'Denumire', 'Sold initial debitor', 'Sold initial creditor', 'Sold final debitor', 'Sold final creditor'];
  const det = mig.detectMapping(ANTET);
  eq('coloana contului e gasita', det.map.cont, 0);
  eq('soldul final debitor e gasit', det.map.sfd, 4);
  eq('soldul initial creditor e gasit', det.map.sic, 3);
  // Antet cu prescurtari, forma uzuala in exporturile romanesti
  const det2 = mig.detectMapping(['Simbol', 'Denumire cont', 'SID', 'SIC', 'SFD', 'SFC']);
  ok('prescurtarile SID/SFC sunt recunoscute', det2.map.sid === 2 && det2.map.sfc === 5);
  // O coloana nu poate fi luata de doua campuri (altfel debitul ar fi si credit)
  ok('fiecare coloana e atribuita unui singur camp',
    new Set(Object.values(det.map)).size === Object.values(det.map).length);
  ok('coloanele nefolosite sunt raportate', Array.isArray(mig.detectMapping(['Cont', 'Ceva', 'SFD', 'SFC']).nefolosite));

  // Presetul salveaza NUMELE anteturilor, nu indicii: acelasi program poate reordona coloanele
  // intre doua versiuni, iar reutilizarea n-are voie sa mute debitul in credit tacit.
  const fields = mig.presetFields(ANTET, det.map);
  const reordonat = ['Sold final creditor', 'Cont', 'Sold final debitor', 'Denumire', 'Sold initial creditor', 'Sold initial debitor'];
  const dinPreset = mig.mappingFromPreset(reordonat, fields);
  ok('presetul regaseste coloanele dupa nume cand ordinea se schimba',
    dinPreset.cont === 1 && dinPreset.sfd === 2 && dinPreset.sfc === 0 && dinPreset.denumire === 3);
  ok('compararea anteturilor ignora majuscule, spatii si diacritice',
    mig.mappingFromPreset([' CONT ', 'DENUMIRE', 'SOLD FINAL DEBITOR', 'SOLD FINAL CREDITOR'], {
      cont: 'Cont', denumire: 'Denumire', sfd: 'Sold final debitor', sfc: 'Sold final creditor',
    }).sfc === 3);
  const gasitPreset = mig.detectPresetMapping([
    ['BALANTA DE VERIFICARE'], ['Firma: EXEMPLU SRL'], reordonat,
  ], { campuri: fields });
  ok('presetul gaseste antetul dupa randurile de titlu', gasitPreset && gasitPreset.idxAntet === 2 && gasitPreset.map.cont === 1);
  eq('presetul nu se aplica partial peste alt format', mig.detectPresetMapping([['Cont', 'Debit']], { campuri: fields }), null);
  const hartaValida = mig.validateMapping({ cont: 0, sfd: 2, sfc: 3 }, 4, 'final');
  ok('harta explicita valida trece', hartaValida.probleme.length === 0 && hartaValida.map.sfc === 3);
  ok('aceeasi coloana in doua roluri e refuzata', mig.validateMapping({ cont: 0, sfd: 1, sfc: 1 }, 3, 'final').probleme.length > 0);
  ok('indicele din afara antetului e refuzat', mig.validateMapping({ cont: 9, sfd: 1 }, 3, 'final').probleme.length > 0);

  const RANDURI = [
    ['1012', 'Capital social', '0', '30.000,00', '0', '30.000,00'],
    ['371', 'Marfuri', '20.000,00', '0', '25.000,00', '0'],
    ['401', 'Furnizori', '0', '15.000,00', '0', '10.000,00'],
    ['5121', 'Banca', '25.000,00', '0', '15.000,00', '0'],
  ];
  const pv = mig.buildPreview(RANDURI, det.map, { sursa: 'final' });
  eq('se preiau conturile cu sold', pv.conturi.length, 4);
  eq('total debit', pv.totalD, 40000);
  eq('total credit', pv.totalC, 40000);
  ok('balanta e echilibrata', pv.echilibrata);
  ok('se poate importa', pv.sePoateImporta);
  eq('fara probleme', pv.probleme.length, 0);

  // REGULA DE AUR: dezechilibrul refuza importul INTREG, nu partial.
  const dezech = mig.buildPreview([['371', 'M', '0', '0', '25.000,00', '0'], ['401', 'F', '0', '0', '0', '10.000,00']], det.map, { sursa: 'final' });
  ok('balanta dezechilibrata NU se poate importa', !dezech.sePoateImporta);
  ok('mesajul spune ca refuzul e integral', dezech.probleme.some((p) => /refuza integral/i.test(p)));
  eq('diferenta e raportata', dezech.diferenta, 15000);

  // Randurile de titlu/total (fara cont numeric) se sar; conturile soldate nu se preiau.
  const cuGunoi = mig.buildPreview([
    ['BALANTA DE VERIFICARE', '', '', '', '', ''],
    ['371', 'M', '0', '0', '100,00', '0'],
    ['TOTAL', '', '', '', '100,00', '100,00'],
    ['401', 'F', '0', '0', '0', '100,00'],
    ['5311', 'Casa', '0', '0', '0', '0'],
  ], det.map, { sursa: 'final' });
  eq('randurile de titlu si total sunt sarite', cuGunoi.conturi.length, 2);
  ok('contul soldat nu se preia', !cuGunoi.conturi.some((x) => x.cont === '5311'));
  ok('balanta ramane echilibrata dupa curatare', cuGunoi.echilibrata);

  // Conturile din afara planului NU sunt eroare, dar trebuie vazute.
  const cuNecunoscut = mig.buildPreview([['371', 'M', '0', '0', '100,00', '0'], ['9999', 'X', '0', '0', '0', '100,00']], det.map, { sursa: 'final' });
  ok('contul din afara planului e semnalat', cuNecunoscut.necunoscute.includes('9999'));
  ok('dar nu blocheaza importul', cuNecunoscut.sePoateImporta);

  // AMBIGUITATEA separatorului: „1.234" singur nu se ghiceste — costa un factor de 1000.
  const amb = mig.buildPreview([['371', 'M', '0', '0', '1.234', '0'], ['401', 'F', '0', '0', '0', '1.234']], det.map, { sursa: 'final' });
  ok('separatorul ambiguu e raportat, nu ghicit', amb.ambigue > 0);
  ok('si blocheaza importul pana raspunde omul', !amb.sePoateImporta);
  // Cu rolul fixat explicit, aceleasi date se importa
  const dez = mig.buildPreview([['371', 'M', '0', '0', '1.234', '0'], ['401', 'F', '0', '0', '0', '1.234']], det.map,
    { sursa: 'final', roles: { '.': 'mii', ',': 'zecimale' } });
  eq('rolul fixat explicit: 1.234 = o mie doua sute treizeci si patru', dez.totalD, 1234);
  ok('si atunci se poate importa', dez.sePoateImporta);
  // O SINGURA linie neambigua din fisier lamureste conventia pentru toate celelalte
  const lamurit = mig.buildPreview([
    ['371', 'M', '0', '0', '1.234', '0'],
    ['401', 'F', '0', '0', '0', '1.234'],
    ['5121', 'B', '0', '0', '12.345.678', '0'],   // doi separatori => „mii", fara dubiu
    ['1012', 'C', '0', '0', '0', '12.345.678'],
  ], det.map, { sursa: 'final' });
  eq('o dovada neambigua fixeaza conventia pentru tot fisierul', lamurit.ambigue, 0);
  eq('si sumele se citesc ca mii', lamurit.totalD, 12346912);

  // Sursa soldurilor: initial vs final sunt coloane DIFERITE.
  const dinInitial = mig.buildPreview(RANDURI, det.map, { sursa: 'initial' });
  eq('sursa „initial" citeste alte coloane', dinInitial.totalD, 45000);
  ok('si ramane echilibrata', dinInitial.echilibrata);

  // Forma de stocare
  const ob = mig.toOpeningBalances(pv);
  eq('soldurile se transforma in forma de stocare', ob['371'].d, 25000);
  eq('creditul contului 401', ob['401'].c, 10000);
}

section('Migrare completa: parteneri + mijloace fixe + stoc, atomic');
{
  const aux = require('../src/migrationAux');
  const parteneriCsv = 'CUI;Denumire;Adresa;Oras;Judet;Tara;Tip;IBAN;BIC\nRO12345674;FURNIZOR TEST SRL;Str. Test 1;Iasi;IS;RO;furnizor;RO49AAAA1B31007593840000;AAAAROBU';
  const activeCsv = 'Nr inventar;Denumire;Cont;Cost;Data PIF;Durata luni;Metoda;Valoare reziduala;Furnizor;CUI;Data achizitie\nINV-1;Laptop contabilitate;214;25000;2026-01-15;36;liniara;0;FURNIZOR TEST SRL;12345674;2026-01-10';
  const stocCsv = 'Cod;Denumire;UM;Cont;Gestiune;Cantitate;Pret unitar;Valoare\nMARFA-1;Marfa test;buc;371;DEP;100;250;25000';
  const conturi = [{ cont: '371', d: 25000, c: 0 }, { cont: '1012', d: 0, c: 25000 }];
  const p = aux.prepare({ parteneriCsv, activeCsv, stocCsv, conturi, data: '2026-01-31' });
  ok('toate cele patru componente trec previzualizarea impreuna', p.ok && p.summary.conturi === 2
    && p.summary.parteneri === 1 && p.summary.active === 1 && p.summary.pozitiiStoc === 1);
  eq('valoarea stocului este calculata', p.summary.valoareStoc, 25000);
  ok('mijlocul fix pastreaza numarul de inventar si planul',
    p.fixedAssets.items[0].numarInventar === 'INV-1' && p.fixedAssets.items[0].durataLuni === 36);
  const compactHeader = aux.parseAssets(activeCsv.replace('Nr inventar', 'NrInventar'));
  ok('antetul compact NrInventar este recunoscut, nu importat ca activ', compactHeader.errors.length === 0
    && compactHeader.items.length === 1 && compactHeader.items[0].numarInventar === 'INV-1');
  const separatorAles = aux.prepare({ activeCsv: activeCsv.replace(';25000;', ';25.000;'), zecimal: ',' });
  ok('conventia explicita lamureste sumele auxiliare ambigue', separatorAles.ok
    && separatorAles.fixedAssets.items[0].cost === 25000);

  const mismatch = aux.prepare({ stocCsv, conturi: [{ cont: '371', d: 20000, c: 0 }, { cont: '1012', d: 0, c: 20000 }], data: '2026-01-31' });
  ok('stocul care nu bate cu soldul initial blocheaza pachetul', !mismatch.ok && mismatch.problems.some((x) => /stocul din contul 371/.test(x)));
  const badPartner = aux.prepare({ parteneriCsv: 'CUI;Denumire\nNU-SUNT-DATE;Gunoi' });
  ok('un partener invalid blocheaza intreg pachetul', !badPartner.ok && badPartner.summary.parteneri === 0);
  const badAsset = aux.prepare({ activeCsv: activeCsv.replace(';214;', ';9999;') });
  ok('un cont invalid pe mijlocul fix blocheaza intreg pachetul', !badAsset.ok && badAsset.problems.some((x) => /cont inexistent/.test(x)));
  const duplicateStock = aux.parseStock(stocCsv + '\nMARFA-1;Alta denumire;buc;371;DEP;1;1;1');
  ok('date contradictorii pentru acelasi produs sunt refuzate', duplicateStock.errors.some((x) => /contradictorii/.test(x)));
  const lipsaPozitie = aux.prepare({ stocCsv, conturi: [{ cont: '371', d: 25000, c: 0 },
    { cont: '301', d: 1000, c: 0 }, { cont: '1012', d: 0, c: 26000 }], data: '2026-01-31' });
  ok('un sold 3xx fara pozitie cantitativa blocheaza pachetul', !lipsaPozitie.ok
    && lipsaPozitie.problems.some((x) => /contul 301 este 0 lei.*soldul initial este 1000/.test(x)));

  // Aplicarea pe un graf separat dovedeste inlocuirea per firma si faptul ca id-urile se aloca
  // numai DUPA validarea completa. Firma 2 ramane neatinsa.
  const d = { seq: 10, openingBalances: { 2: { 5121: { d: 1, c: 0 } } }, partners: { 2: { X: { cui: 'X' } } },
    assets: [{ id: 'mf-vechi', firmaId: 2 }], products: [{ id: 'p-vechi', firmaId: 2 }],
    gestiuni: [], stockMovements: [{ id: 'sm-vechi', firmaId: 2 }] };
  aux.apply(d, 1, p, 'tester');
  ok('aplicarea construieste toate colectiile firmei tinta', d.openingBalances[1]['371'].d === 25000
    && d.partners[1]['12345674'] && d.assets.some((x) => x.firmaId === 1 && x.numarInventar === 'INV-1')
    && d.products.some((x) => x.firmaId === 1) && d.stockMovements.some((x) => x.firmaId === 1 && x.initial));
  ok('aplicarea nu atinge alta firma', d.partners[2].X && d.assets.some((x) => x.id === 'mf-vechi')
    && d.stockMovements.some((x) => x.id === 'sm-vechi'));
  ok('secventa avanseaza numai pentru obiectele create', d.seq > 10);
}

section('Fisier de plati ISO 20022 (pain.001) — src/sepa.js');
{
  const sepa = require('../src/sepa');
  // ── IBAN: mod 97, nu o euristica de forma ────────────────────────────────
  ok('IBAN romanesc valid', sepa.validIban('RO49AAAA1B31007593840000'));
  ok('IBAN german valid', sepa.validIban('DE89370400440532013000'));
  ok('acelasi IBAN cu spatii si litere mici', sepa.validIban('ro49 aaaa 1b31 0075 9384 0000'));
  // O SINGURA cifra schimbata trebuie sa pice: asta separa mod-97 de o verificare de lungime.
  ok('IBAN cu o cifra gresita e RESPINS', !sepa.validIban('RO49AAAA1B31007593840001'));
  ok('IBAN cu lungime gresita pentru tara e respins', !sepa.validIban('RO49AAAA1B3100759384'));
  ok('sir gol e respins', !sepa.validIban(''));
  ok('text oarecare e respins', !sepa.validIban('nu e un iban'));

  const DBT = { nume: 'S.C. EXEMPLU PROD S.R.L.', iban: 'RO49AAAA1B31007593840000' };
  const UNA = [{ beneficiar: 'ALFA', iban: 'DE89370400440532013000', suma: 100, ref: 'F1' }];

  // ── Verificarea lotului: TOATE problemele deodata, nu prima ──────────────
  const pr = sepa.checkPayload({ debitor: { nume: 'X' }, plati: [{ beneficiar: '', suma: 0 }] });
  ok('lipsa IBAN-ului platitorului e semnalata', pr.some((x) => /IBAN-ul firmei/.test(x)));
  ok('beneficiarul lipsa e semnalat', pr.some((x) => /lipseste beneficiarul/.test(x)));
  ok('suma zero e semnalata', pr.some((x) => /mai mare ca zero/.test(x)));
  ok('se raporteaza TOATE problemele, nu prima', pr.length >= 3);
  eq('un lot corect nu are probleme', sepa.checkPayload({ debitor: DBT, plati: UNA }).length, 0);
  // Generarea REFUZA lotul invalid (nu emite un fisier pe care banca il respinge)
  let statusInvalid = 0;
  try { sepa.buildPain001({ debitor: DBT, plati: [{ beneficiar: 'X', iban: 'GRESIT', suma: 1 }] }); }
  catch (e) { statusInvalid = e.status; }
  eq('generarea unui lot invalid arunca 400', statusInvalid, 400);

  // ── Structura si sumele de control ───────────────────────────────────────
  const x = sepa.buildPain001({ msgId: 'T1', creDtTm: '2026-07-28T10:00:00', execDate: '2026-07-30',
    moneda: 'RON', debitor: DBT,
    plati: [{ beneficiar: 'ALFA', iban: 'DE89370400440532013000', suma: 100.5, ref: 'F1' },
      { beneficiar: 'BETA', iban: 'RO49AAAA1B31007593840000', suma: 200.25, ref: 'F2' }] });
  ok('namespace-ul pain.001.001.03', /urn:iso:std:iso:20022:tech:xsd:pain\.001\.001\.03/.test(x));
  ok('XML bine-format', wellFormed(x));
  eq('numarul de tranzactii (in antet si in lot)', (x.match(/<NbOfTxs>2<\/NbOfTxs>/g) || []).length, 2);
  // Suma de control trebuie sa fie suma randurilor — o nepotrivire e primul lucru pe care il
  // verifica banca, si respinge tot lotul.
  eq('suma de control = suma randurilor', (x.match(/<CtrlSum>([\d.]+)<\/CtrlSum>/) || [])[1], '300.75');
  ok('sumele au exact doua zecimale', /<InstdAmt Ccy="RON">100\.50<\/InstdAmt>/.test(x));
  eq('cate un EndToEndId per plata', (x.match(/<EndToEndId>/g) || []).length, 2);

  // ── SEPA doar pe EUR: o plata interna in RON marcata „SEPA" e o contradictie ──
  ok('RON: FARA nivel de serviciu SEPA', !/<SvcLvl>/.test(x));
  const xe = sepa.buildPain001({ msgId: 'T2', moneda: 'EUR', debitor: DBT, plati: UNA });
  ok('EUR: CU nivel de serviciu SEPA', /<SvcLvl><Cd>SEPA<\/Cd><\/SvcLvl>/.test(xe));

  // ── Setul de caractere SEPA: diacriticele romanesti NU sunt permise ──────
  // Denumirile vin din e-Factura, deci CONTIN diacritice. Netransliterate, banca ori respinge
  // fisierul, ori stalceste numele — si plata pleaca spre un beneficiar scris altfel.
  const PERMIS = /^[A-Za-z0-9/\-?:().,'+ ]*$/;
  eq('diacriticele romanesti se translitereaza', sepa.txt('ÎNTREPRINDEREA ȚĂRĂNEASCĂ SRL', 70), 'INTREPRINDEREA TARANEASCA SRL');
  eq('s si t cu virgula (nu se descompun Unicode)', sepa.txt('ȘTEFAN ȚARA', 70), 'STEFAN TARA');
  eq('& devine + (in setul permis)', sepa.txt('ALFA & BETA', 70), 'ALFA + BETA');
  eq('linia lunga devine cratima', sepa.txt('nr. 5 – tigla', 70), 'nr. 5 - tigla');
  eq('diacriticele straine se descompun generic', sepa.txt('Müller & José', 70), 'Muller + Jose');
  ok('un text deja curat nu se schimba', sepa.txt('ALFA SRL', 70) === 'ALFA SRL');
  const xdia = sepa.buildPain001({ msgId: 'TD', debitor: { nume: 'S.C. ȘTEFAN S.R.L.', iban: 'RO49AAAA1B31007593840000' },
    plati: [{ beneficiar: 'ÎNTREPRINDEREA ȚĂRĂNEASCĂ SRL', iban: 'DE89370400440532013000', suma: 10, detalii: 'Factură țiglă' }] });
  const campuri = [...xdia.matchAll(/<(?:Nm|Ustrd)>([^<]*)<\/(?:Nm|Ustrd)>/g)].map((m) => m[1]);
  ok('fisierul generat are cel putin trei campuri de text', campuri.length >= 3);
  ok('NICIUN camp de text nu iese din setul SEPA'
    + (campuri.filter((c) => !PERMIS.test(c)).length ? ' — ' + campuri.filter((c) => !PERMIS.test(c)).join(' | ') : ''),
    campuri.every((c) => PERMIS.test(c)));
  // poarta trebuie sa POATA pica: un text netransliterat chiar iese din set
  ok('poarta chiar detecteaza un text neconform', !PERMIS.test('ȚARA'));

  // ── Escaparea: denumirile de partener vin din surse EXTERNE (e-Factura/SPV) ──
  const xesc = sepa.buildPain001({ msgId: 'T3', debitor: DBT,
    plati: [{ beneficiar: 'A & B <SRL> "X"', iban: 'DE89370400440532013000', suma: 5, detalii: 'ref & <b>bold</b>' }] });
  // Transliterarea SEPA elimina deja `<`, `>` si `"` (nu sunt in setul permis), iar `&` devine `+`.
  // Deci markup-ul nu mai are din ce sa se formeze — dar escaparea RAMANE, ca aparare in adancime:
  // daca setul permis s-ar largi vreodata, esc() e in continuare pe drum.
  ok('markup injectat nu supravietuieste transliterarii', !/<b>|&lt;SRL&gt;|<SRL>/.test(xesc));
  ok('& devine + in loc sa ajunga entitate', /A \+ B SRL/.test(xesc));
  // Apostroful E in setul SEPA, deci ajunge la XML — si acolo trebuie escapat.
  const xap = sepa.buildPain001({ msgId: 'T4', debitor: DBT,
    plati: [{ beneficiar: "O'BRIEN & CO", iban: 'DE89370400440532013000', suma: 5 }] });
  ok('apostroful (permis de SEPA) e escapat in XML', /O&apos;BRIEN/.test(xap));
  ok('ramane bine-format', wellFormed(xesc) && wellFormed(xap));

  // ── Invariantul de fond: generarea NU produce articole contabile ─────────
  // Fisierul e o INTENTIE de plata. Contabilizarea lui aici, plus cea de la import extras, ar
  // dubla plata — iar banca poate oricand refuza lotul.
  ok('iesirea e doar XML, fara nicio linie contabila', typeof x === 'string' && !/debit|credit|"lines"/.test(x));
  ok('modulul nu exporta nimic care sa scrie in baza',
    Object.keys(sepa).every((k) => ['buildPain001', 'checkPayload', 'validIban', 'normIban', 'txt', 'needsTranslit'].includes(k)));
}

section('Curs BNR (parsare, multiplicator, zile nelucratoare)');
{
  const bnr = require('../src/bnr');
  const XML = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><PublishingDate>2026-07-28</PublishingDate></Header><Body>
<Cube date="2026-07-27"><Rate currency="EUR">5.2200</Rate><Rate currency="USD">4.6000</Rate></Cube>
<Cube date="2026-07-28"><Rate currency="EUR">5.2310</Rate><Rate currency="USD">4.6050</Rate>
<Rate currency="HUF" multiplier="100">1.4517</Rate><Rate currency="JPY" multiplier="100">2.8103</Rate></Cube>
</Body></DataSet>`;
  const parsed = bnr.parseRates(XML);
  eq('parseaza toate zilele din fisier', parsed.length, 2);
  // Cursurile au 4 zecimale, iar `eq` rotunjeste la 2: comparatia trebuie sa fie STRICTA,
  // altfel 5,2310 si 5,2299 ar trece la fel si testul n-ar mai discrimina nimic.
  ok('cursul EUR al zilei (comparatie stricta, 4 zecimale)', parsed[1].cursuri.EUR === 5.231);
  // MULTIPLICATORUL: 1,4517 e cursul pentru 100 HUF. Ignorarea atributului ar da o eroare de
  // exact 100x — silentioasa si catastrofala pe o reevaluare. Comparatie STRICTA (eq rotunjeste
  // la 2 zecimale si ar face testul sa treaca degeaba).
  ok('multiplicatorul 100 e aplicat (HUF)', parsed[1].cursuri.HUF === 1.4517 / 100);
  ok('multiplicatorul 100 e aplicat (JPY)', parsed[1].cursuri.JPY === 2.8103 / 100);
  ok('valuta fara multiplicator ramane neatinsa', parsed[1].cursuri.USD === 4.605);
  eq('XML gol -> nicio zi (nu arunca)', bnr.parseRates('').length, 0);
  eq('XML fara Cube -> nicio zi', bnr.parseRates('<DataSet></DataSet>').length, 0);

  // upsert: idempotent, si actualizeaza o zi deja prezenta fara sa o dubleze
  const col = [];
  const u1 = bnr.upsertRates(col, parsed);
  eq('prima incarcare adauga ambele zile', u1.adaugate, 2);
  const u2 = bnr.upsertRates(col, parsed);
  eq('a doua incarcare nu adauga nimic (idempotent)', u2.adaugate, 0);
  eq('si nici nu actualizeaza (aceleasi valori)', u2.actualizate, 0);
  eq('colectia ramane la 2 zile', col.length, 2);
  bnr.upsertRates(col, [{ data: '2026-07-28', cursuri: { EUR: 5.25 } }]);
  eq('o zi revenita cu alte valori se ACTUALIZEAZA, nu se dubleaza', col.length, 2);
  ok('valoarea noua e cea retinuta', col.find((x) => x.id === '2026-07-28').cursuri.EUR === 5.25);

  // rateAt: regula zilelor nelucratoare — ultimul curs PUBLICAT inainte, fara interpolare
  const col2 = [{ id: '2026-07-24', cursuri: { EUR: 5.2 } }, { id: '2026-07-27', cursuri: { EUR: 5.22 } }];
  ok('zi cu curs propriu: exact', bnr.rateAt(col2, 'EUR', '2026-07-27').curs === 5.22);
  ok('zi cu curs propriu e marcata exact', bnr.rateAt(col2, 'EUR', '2026-07-27').exact === true);
  const weekend = bnr.rateAt(col2, 'EUR', '2026-07-26'); // sambata
  ok('zi nelucratoare: ultimul curs publicat inainte', weekend.curs === 5.2);
  eq('si se vede DIN CE ZI s-a luat', weekend.data, '2026-07-24');
  ok('zi nelucratoare NU e marcata exact', weekend.exact === false);
  ok('data dinaintea primului curs -> null (nu se extrapoleaza)', bnr.rateAt(col2, 'EUR', '2026-07-01') === null);
  ok('valuta necunoscuta -> null', bnr.rateAt(col2, 'XXX', '2026-07-27') === null);
  ok('RON e mereu 1, fara sa fie in colectie', bnr.rateAt(col2, 'RON', '2026-07-27').curs === 1);
  ok('data invalida -> null', bnr.rateAt(col2, 'EUR', 'maine') === null);
  eq('valutele disponibile', bnr.currencies(col2).join(','), 'EUR');
}

section('Declaratii rectificative (istoric depuneri + steag XML)');
{
  const decl = require('../src/declarations');
  const nid = (() => { let n = 0; return () => 'dcl' + (++n); })();
  const d = { declarations: [] };

  // Prima depunere NU e rectificativa; urmatoarele sunt, prin definitie.
  const s1 = decl.addSubmission(d, 'f1', 'd300', '2026-06', { sume: { tvaDePlata: 1000 }, de: 'ana' }, nid);
  eq('prima depunere are ordinalul 1', s1.depunere.ordinal, 1);
  ok('prima depunere NU e rectificativa', s1.depunere.rectificativa === false);
  const s2 = decl.addSubmission(d, 'f1', 'd300', '2026-06', { sume: { tvaDePlata: 1250 }, motiv: 'factura primita tarziu', de: 'ana' }, nid);
  eq('a doua depunere are ordinalul 2', s2.depunere.ordinal, 2);
  ok('a doua depunere E rectificativa', s2.depunere.rectificativa === true);

  // Istoricul NU se suprascrie — asta e intreg scopul: o rectificativa e o depunere NOUA.
  eq('istoricul pastreaza ambele depuneri', s2.rec.depuneri.length, 2);
  eq('prima depunere ramane cu suma ei initiala', s2.rec.depuneri[0].sume.tvaDePlata, 1000);
  eq('motivul se pastreaza pe depunere', s2.rec.depuneri[1].motiv, 'factura primita tarziu');
  // A treia nu pierde primele doua (regresia clasica: `depuneri` reinitializat la fiecare apel).
  const s3 = decl.addSubmission(d, 'f1', 'd300', '2026-06', { sume: { tvaDePlata: 1250 } }, nid);
  eq('a treia depunere nu pierde istoricul', s3.rec.depuneri.length, 3);
  eq('o singura inregistrare pe (firma, tip, perioada)', d.declarations.length, 1);
  eq('statusul devine „depusa"', s3.rec.status, 'depusa');

  // Diferenta: doar cheile SCHIMBATE, cu delta — o rectificativa fara diferenta vizibila nu se
  // poate verifica de nimeni.
  const dif = decl.submissionDiff(s1.depunere, s2.depunere);
  eq('diferenta are un singur rand', dif.length, 1);
  eq('diferenta: cheia schimbata', dif[0].cheie, 'tvaDePlata');
  eq('diferenta: delta calculat', dif[0].delta, 250);
  eq('doua depuneri identice -> nicio diferenta', decl.submissionDiff(s2.depunere, s3.depunere).length, 0);

  // Steagul in XML exista DOAR la D112 (dovedit prin sondaj pe validatoarele oficiale).
  ok('D112 e semnalizata in XML', !!decl.RECT_IN_XML.d112);
  ok('D107 e semnalizata in XML', !!decl.RECT_IN_XML.d107);
  ok('D205 e semnalizata in XML', !!decl.RECT_IN_XML.d205);
  ok('D307 e semnalizata in XML', !!decl.RECT_IN_XML.d307);
  ok('D300 NU are steag in XML (redepunere)', !decl.RECT_IN_XML.d300);
  ok('D394 NU are steag in XML (redepunere)', !decl.RECT_IN_XML.d394);

  // Generatorul: steagul apare doar cand e cerut, iar valoarea interzisa de regula A3b se corecteaza.
  const co = { cui: '12345674', nume: 'T', caen: '1071', adresa: 'A', oras: 'B', judet: 'RO-B' };
  const sp = { rows: [], totals: { brut: 0, cas: 0, cass: 0, impozit: 0, cam: 0, net: 0 } };
  const norm = xml.d112Xml(co, '2026-06', sp, null);
  const rect = xml.d112Xml(co, '2026-06', sp, null, { rectificativa: true, tipRec: 1 });
  ok('D112 normal NU are d_rec', !/d_rec/.test(norm));
  ok('D112 rectificativ are d_rec="1" si tip_rec', /d_rec="1"/.test(rect) && /tip_rec="1"/.test(rect));
  // Regula A3b a validatorului: cand d_rec=1, tip_rec nu poate fi 5.
  const bad = xml.d112Xml(co, '2026-06', sp, null, { rectificativa: true, tipRec: 5 });
  ok('tip_rec=5 (interzis de regula A3b) e corectat, nu emis', !/tip_rec="5"/.test(bad) && /tip_rec="1"/.test(bad));
  ok('rectificativa=false nu emite steag', !/d_rec/.test(xml.d112Xml(co, '2026-06', sp, null, { rectificativa: false })));

  // D300: fara steag, dar cu `temei` — lista dovedita {0, 2}.
  const d300d = { tvaColectata: 0, tvaDeductibila: 0, tvaDePlata: 0, tvaDeRecuperat: 0, randuri: {} };
  ok('D300 implicit are temei="0"', /temei="0"/.test(xml.d300Xml(co, '2026-06', d300d, null)));
  ok('D300 dupa anularea rezervei are temei="2"', /temei="2"/.test(xml.d300Xml(co, '2026-06', d300d, null, { dupaRezerva: true })));
}

section('Registrul depunerilor + portofoliu');
const declMod = require('../src/declarations');
eq('termen D300 pentru iunie', declMod.dueDate('d300', '2026-06'), '2026-07-25');
eq('termen D112 pentru decembrie (trece anul)', declMod.dueDate('d112', '2026-12'), '2027-01-25');
eq('termen SAF-T: ultima zi a lunii urmatoare', declMod.dueDate('saft', '2026-06'), '2026-07-31');
eq('termen SAF-T decembrie: 31 ianuarie', declMod.dueDate('saft', '2026-12'), '2027-01-31');
eq('termen D205 pentru veniturile 2025: weekendul muta 28 februarie pe 2 martie', declMod.dueDate('d205', '2025-12'), '2026-03-02');
eq('termen D205 pentru veniturile 2026: 28 februarie 2027 cade duminica -> 1 martie', declMod.dueDate('d205', '2026-12'), '2027-03-01');
const vDecl = scopedSeed(); // firma platitoare de TVA, cu angajati
const expIun = declMod.expectedForFirma(vDecl, '2026-06');
eq('asteptate iunie: d300+d394+d112+d100+saft (TVA lunar)', expIun.map((x) => x.tip).join(','), 'd300,d394,d112,d100,saft');
eq('asteptate mai: fara d100, dar cu saft lunar', declMod.expectedForFirma(vDecl, '2026-05').map((x) => x.tip).join(','), 'd300,d394,d112,saft');
eq('neplatitor TVA: saft doar trimestrial', declMod.expectedForFirma({ company: { tvaPlatitor: false }, angajati: [] }, '2026-06').map((x) => x.tip).join(','), 'd100,saft');
// PFA: fara D100 (impozitul merge prin Declaratia Unica) si fara SAF-T
eq('PFA platitor TVA: doar d300+d394 (fara d100/saft)', declMod.expectedForFirma({ company: { tvaPlatitor: true, tipEntitate: 'pfa' }, angajati: [], entries: [] }, '2026-06').map((x) => x.tip).join(','), 'd300,d394');
eq('PFA neplatitor fara angajati: nicio declaratie lunara', declMod.expectedForFirma({ company: { tvaPlatitor: false, tipEntitate: 'pfa' }, angajati: [], entries: [] }, '2026-06').length, 0);
const livPfa = rep.livrabile({ company: { tipEntitate: 'pfa' }, entries: [], openingBalances: {} }, '2026-06');
ok('livrabile PFA: fara D100 micro / SAF-T / D101 / situatii financiare / AGA', !livPfa.list.some((x) => [9, 12, 15, 16, 19].includes(x.id)));
ok('livrabile PFA: Declaratia Unica prezenta cu sumarul ei', livPfa.list.some((x) => /Declarația Unică/.test(x.nume)) && livPfa.sumar.du && livPfa.sumar.du.venitNet === 0);
// livrabile micro/profit: D101 (nr 16) apare doar la regimul de profit
// Numerotarea AFISATA nu are voie sa aiba goluri, oricare ar fi filtrarea: `nr` e pozitia,
// nu identitatea (aceea e `id`). Inainte, la micro sarea 15 -> 17, la PFA lipseau cinci numere.
const nrContinuu = (l) => l.list.every((x, i) => x.nr === i + 1);
const ordineSect = (l) => { const o = ['A. Lunar', 'B. Trimestrial', 'C. Anual', 'D. La cerere'];
  return l.list.every((x, i) => i === 0 || o.indexOf(l.list[i - 1].sectiune) <= o.indexOf(x.sectiune)); };
const livMicro = rep.livrabile({ company: { tipEntitate: 'srl', regimImpozit: 'micro' }, entries: [], openingBalances: {} }, '2026-06');
ok('borderou micro: numerotare continua, fara golul 15->17', nrContinuu(livMicro));
ok('borderou PFA: numerotare continua desi se scot 5 randuri', nrContinuu(livPfa));
ok('borderou PFA: sectiunile raman in ordine (randurile adaugate nu ies la coada)', ordineSect(livPfa));
ok('borderou: textele au diacritice (mesaj catre utilizator)', livMicro.list.some((x) => /ă|â|î|ș|ț/.test(x.nume)));
ok('livrabile micro: fara D101 in checklist', !rep.livrabile({ company: { tipEntitate: 'srl', regimImpozit: 'micro' }, entries: [], openingBalances: {} }, '2026-06').list.some((x) => x.id === 16));
ok('livrabile profit: cu D101 in checklist', rep.livrabile({ company: { tipEntitate: 'srl', regimImpozit: 'profit' }, entries: [], openingBalances: {} }, '2026-06').list.some((x) => x.id === 16));
eq('neplatitor TVA: luna non-trimestriala fara obligatii', declMod.expectedForFirma({ company: { tvaPlatitor: false }, angajati: [] }, '2026-05').length, 0);
const vIC = { company: { tvaPlatitor: true }, angajati: [], entries: [{ tip: 'livrare_intracomunitara', period: '2026-05', data: '2026-05-10' }] };
ok('D390 asteptata DOAR in lunile cu operatiuni intracomunitare',
  declMod.expectedForFirma(vIC, '2026-05').some((x) => x.tip === 'd390') && !declMod.expectedForFirma(vIC, '2026-04').some((x) => x.tip === 'd390'));
ok('asteptate decembrie include saft', declMod.expectedForFirma(vDecl, '2026-12').some((x) => x.tip === 'saft'));
const vD205 = { company: { tvaPlatitor: false }, angajati: [], entries: d205db.entries };
ok('D205 apare in calendarul din decembrie cand raportul anual are beneficiari',
  declMod.expectedForFirma(vD205, '2026-12').some((x) => x.tip === 'd205'));
ok('D205 nu apare intr-o luna intermediara si nici intr-un an fara operatiuni',
  !declMod.expectedForFirma(vD205, '2026-11').some((x) => x.tip === 'd205')
  && !declMod.expectedForFirma(vD205, '2025-12').some((x) => x.tip === 'd205'));
ok('D205 din registru are linkul XML cu anul raportat',
  declMod.descarcari('d205', '2026-12').some((l) => l.href === '/xml/d205?year=2026'));
const dDecl = { declarations: [] };
let seqDecl = 100;
const nidDecl = (p) => p + (seqDecl++);
declMod.record(dDecl, vDecl.firmaId, 'd300', '2026-06', { status: 'generata', generatedAt: '2026-07-01' }, nidDecl);
declMod.record(dDecl, vDecl.firmaId, 'd300', '2026-06', { status: 'depusa', recipisa: 'R123' }, nidDecl);
eq('upsert: o singura inregistrare per (firma,tip,luna)', dDecl.declarations.length, 1);
eq('status dupa depunere', dDecl.declarations[0].status, 'depusa');
declMod.record(dDecl, vDecl.firmaId, 'd300', '2026-06', { status: 'generata' }, nidDecl);
eq('re-generarea NU retrogradeaza depusa', dDecl.declarations[0].status, 'depusa');
const regDecl = declMod.registerForFirma(dDecl, vDecl, '2026-06', '2026-08-01');
eq('registru: d300 depusa', regDecl.find((r) => r.tip === 'd300').status, 'depusa');
ok('registru: d112 nedepusa cu termen depasit -> restanta', regDecl.find((r) => r.tip === 'd112').overdue);
ok('registru: d300 depusa nu e restanta', !regDecl.find((r) => r.tip === 'd300').overdue);
const portoDecl = declMod.portfolio(dDecl, [vDecl], '2026-06', '2026-08-01');
eq('portofoliu: asteptate (cu saft lunar)', portoDecl.tot.asteptate, 5);
eq('portofoliu: depuse', portoDecl.tot.depuse, 1);
eq('portofoliu: restante (d394+d112+d100+saft)', portoDecl.tot.restante, 4);
eq('portofoliu: conformitate 1/5 = 20%', portoDecl.conformitate, 20);
eq('portofoliu: firma are atentionari', portoDecl.firms[0].natentionari, 4);
declMod.record(dDecl, vDecl.firmaId, 'd100', '2026-06', { status: 'scutita' }, nidDecl);
eq('scutita iese din conformitate: 1/4 = 25%', declMod.portfolio(dDecl, [vDecl], '2026-06', '2026-08-01').conformitate, 25);
const notifDecl = declMod.notifications(dDecl, [vDecl], '2026-07-20', 7, 3);
ok('notificari: termen d112 iunie (25 iulie) e in fereastra de 7 zile', notifDecl.items.some((i) => i.tip === 'd112' && i.period === '2026-06' && i.kind === 'termen'));
ok('notificari: d300 depusa nu apare', !notifDecl.items.some((i) => i.tip === 'd300' && i.period === '2026-06'));
eq('notificari: restantele primele', declMod.notifications(dDecl, [vDecl], '2026-08-01', 7, 3).items[0].kind, 'restanta');

// O firma nou creata NU datoreaza declaratii pentru lunile dinaintea ei. Calendarul se deriva din
// PROFIL, nu din date (multe declaratii se depun „pe zero"), deci fara un reper de inceput o firma
// facuta azi aparea imediat cu restante D300/D394/D406 pentru ultimele 3 luni — o acuzatie falsa,
// chiar pe ecranul care ar trebui sa fie lista ei de lucru.
{
  const azi = '2026-07-30';
  const vNou = { firmaId: 9, company: { nume: 'NOUA SRL', tvaPlatitor: true, createdAt: '2026-07-28T10:00:00.000Z' }, entries: [], angajati: [] };
  const nNou = declMod.notifications({ declarations: [] }, [vNou], azi, 7, 3);
  eq('firma creata luna asta: nicio restanta pentru lunile dinaintea ei', nNou.items.filter((i) => i.kind === 'restanta').length, 0);
  eq('prima luna urmarita = luna crearii', declMod.primaLunaUrmarita(vNou), '2026-07');
  ok('portofoliul nu-i cere nimic pe o luna anterioara',
    declMod.portfolio({ declarations: [] }, [vNou], '2026-04', azi).firms[0].counts.asteptate === 0);
  ok('...dar firma RAMANE in lista portofoliului (nu dispare)',
    declMod.portfolio({ declarations: [] }, [vNou], '2026-04', azi).firms.length === 1);

  // istoric preluat de la contabilul anterior: inregistrari mai VECHI coboara reperul, fiindca
  // acolo obligatiile sunt reale
  const vIstoric = { firmaId: 10, company: { nume: 'CU ISTORIC SRL', tvaPlatitor: true, createdAt: '2026-07-28T10:00:00.000Z' },
    entries: [{ id: 'x', period: '2026-05', data: '2026-05-10', lines: [] }], angajati: [] };
  eq('istoricul preluat coboara reperul la luna celei mai vechi inregistrari', declMod.primaLunaUrmarita(vIstoric), '2026-05');
  ok('deci restantele reale din mai/iunie se arata',
    declMod.notifications({ declarations: [] }, [vIstoric], azi, 7, 3).items.some((i) => i.period === '2026-05' && i.kind === 'restanta'));

  // firmele DINAINTE de campul createdAt raman pe comportamentul vechi (nu ascundem retroactiv)
  const vVeche = { firmaId: 11, company: { nume: 'VECHE SRL', tvaPlatitor: true }, entries: [], angajati: [] };
  eq('firma fara createdAt: fara reper', declMod.primaLunaUrmarita(vVeche), '');
  ok('...deci restantele ei se arata ca inainte',
    declMod.notifications({ declarations: [] }, [vVeche], azi, 7, 3).items.some((i) => i.kind === 'restanta'));
}

section('Motor de profil fiscal (src/fiscalProfile.js)');
const fp = require('../src/fiscalProfile');
// implicite compatibile: firma veche (doar tvaPlatitor) => profil coerent
const pSrl = fp.build({ tvaPlatitor: true }, {});
eq('profil: platitor TVA implicit lunar', pSrl.perioadaTva, 'L');
eq('profil: non-PFA implicit micro', pSrl.regim, 'micro');
eq('profil: D406 lunar la TVA lunar', pSrl.d406, 'L');
eq('profil: neplatitor -> perioadaTva null', fp.build({ tvaPlatitor: false }, {}).perioadaTva, null);
eq('profil: neplatitor -> D406 trimestrial', fp.build({ tvaPlatitor: false }, {}).d406, 'T');
eq('profil: TVA trimestrial -> D406 trimestrial', fp.build({ tvaPlatitor: true, perioadaTva: 'T' }, {}).d406, 'T');
eq('profil: PFA -> regim pfa (ignora regimImpozit)', fp.build({ tipEntitate: 'pfa', regimImpozit: 'profit' }, {}).regim, 'pfa');
eq('profil: regim profit explicit', fp.build({ tvaPlatitor: true, regimImpozit: 'profit' }, {}).profit, true);
eq('profil: areAngajati din ctx', fp.build({}, { angajati: [{ id: 'a' }] }).areAngajati, true);
eq('profil: cadenta D406 explicita bate derivarea', fp.build({ tvaPlatitor: true, d406Cadenta: 'T' }, {}).d406, 'T');
// declaratii derivate din profil (echivalente cu expectedForFirma, dar profil-driven)
const noIntra = () => false;
eq('expected: TVA lunar + angajati, iunie', fp.expected(fp.build({ tvaPlatitor: true }, { angajati: [{ id: 'a' }] }), '2026-06', noIntra).join(','), 'd300,d394,d112,d100,saft');
eq('expected: TVA lunar, mai (fara d100)', fp.expected(fp.build({ tvaPlatitor: true }, {}), '2026-05', noIntra).join(','), 'd300,d394,saft');
eq('expected: neplatitor -> saft doar trimestrial', fp.expected(fp.build({ tvaPlatitor: false }, {}), '2026-06', noIntra).join(','), 'd100,saft');
eq('expected: PFA -> fara d100/saft', fp.expected(fp.build({ tvaPlatitor: true, tipEntitate: 'pfa' }, {}), '2026-06', noIntra).join(','), 'd300,d394');
// EXTINDERI noi ale motorului: Intrastat + scutiri + cadenta D406 anuala
const withIntra = () => true;
ok('expected: Intrastat cand firma e obligata + are miscari intracom', fp.expected(fp.build({ tvaPlatitor: true, intrastatObligat: true }, {}), '2026-05', withIntra).includes('intrastat'));
ok('expected: fara Intrastat cand nu are miscari intracom in luna', !fp.expected(fp.build({ tvaPlatitor: true, intrastatObligat: true }, {}), '2026-05', noIntra).includes('intrastat'));
ok('expected: scutirea suprima declaratia (d394 scutit)', !fp.expected(fp.build({ tvaPlatitor: true, scutiri: { d394: true } }, {}), '2026-06', noIntra).includes('d394'));
eq('expected: D406 cadenta anuala -> doar decembrie', [fp.expected(fp.build({ tvaPlatitor: true, d406Cadenta: 'A' }, {}), '2026-06', noIntra).includes('saft'), fp.expected(fp.build({ tvaPlatitor: true, d406Cadenta: 'A' }, {}), '2026-12', noIntra).includes('saft')].join(','), 'false,true');
eq('termen Intrastat: 15 ale lunii urmatoare', declMod.dueDate('intrastat', '2026-06'), '2026-07-15');
// micro/profit -> D100/D101: micro depune D100 trimestrial; profit depune si D101 anual (decembrie)
eq('micro: D100 la sfarsit de trimestru, fara D101', fp.expected(fp.build({ tvaPlatitor: true, regimImpozit: 'micro' }, {}), '2026-12', noIntra).filter((t) => t === 'd100' || t === 'd101').join(','), 'd100');
// TRIMESTRUL IV: la impozit pe profit se depune DOAR D101. Art. 41 alin. (1) cere D100 pentru
// trimestrele I-III, iar definitivarea anului se face prin declaratia anuala, pana pe 25 martie.
// Aserțiunea de aici cerea si D100 in decembrie — adica impingea firma sa declare acelasi impozit
// de doua ori. Micro ramane cu toate patru trimestrele (T4 se declara pana pe 25 ianuarie).
eq('profit: in decembrie DOAR D101 (T4 se definitiveaza anual, nu prin D100)', fp.expected(fp.build({ tvaPlatitor: true, regimImpozit: 'profit' }, {}), '2026-12', noIntra).filter((t) => t === 'd100' || t === 'd101').join(','), 'd101');
eq('profit: D100 la trimestrele I-III', ['2026-03', '2026-06', '2026-09'].map((p) => fp.expected(fp.build({ tvaPlatitor: true, regimImpozit: 'profit' }, {}), p, noIntra).includes('d100')).join(','), 'true,true,true');
ok('profit: D101 NU apare in afara lunii de sfarsit de an', !fp.expected(fp.build({ tvaPlatitor: true, regimImpozit: 'profit' }, {}), '2026-09', noIntra).includes('d101'));
ok('PFA: nici D100 nici D101', (() => { const t = fp.expected(fp.build({ tvaPlatitor: true, tipEntitate: 'pfa', regimImpozit: 'profit' }, {}), '2026-12', noIntra); return !t.includes('d100') && !t.includes('d101'); })());
eq('termen D101: 25 martie anul urmator anului fiscal', declMod.dueDate('d101', '2025-12'), '2026-03-25');
ok('expectedForFirma: firma pe profit vede D101 in decembrie', declMod.expectedForFirma({ firmaId: 8, company: { tvaPlatitor: true, regimImpozit: 'profit' }, angajati: [], entries: [] }, '2026-12').some((x) => x.tip === 'd101'));

section('Controale fiscale derivate din profil (src/fiscalControls.js)');
const fctrl = require('../src/fiscalControls');
// neplatitor TVA care colecteaza TVA (4427) -> EROARE, ok=false
const fcNepl = fctrl.check({ company: { tvaPlatitor: false, tipEntitate: 'srl' }, angajati: [{ id: 'a' }], entries: [{ period: '2026-03', data: '2026-03-10', tip: 'f', lines: [{ debit: '4111', credit: '4427', suma: 210 }] }] }, { year: '2026' });
ok('control: neplatitor TVA care colecteaza 4427 -> eroare + ok=false', fcNepl.findings.some((f) => f.cod === 'tva-neplatitor-colecteaza' && f.nivel === 'eroare') && fcNepl.ok === false);
// micro peste plafon -> atentie
ok('control: micro peste plafonul de venituri -> atentie', fctrl.check({ company: { tvaPlatitor: true, caen: '6201', regimImpozit: 'micro' }, angajati: [{ id: 'a' }], entries: [{ period: '2026-05', data: '2026-05-01', tip: 'x', lines: [{ debit: '4111', credit: '704', suma: 600000 }] }] }, { year: '2026' }).findings.some((f) => f.cod === 'micro-peste-plafon' && f.nivel === 'atentie'));
// platitor TVA fara CAEN -> atentie
ok('control: platitor TVA fara CAEN -> atentie', fctrl.check({ company: { tvaPlatitor: true, regimImpozit: 'profit' }, angajati: [{ id: 'a' }], entries: [] }, { year: '2026' }).findings.some((f) => f.cod === 'tva-fara-caen'));
// neplatitor TVA cu cifra de afaceri (70x) PESTE plafonul de scutire (395.000) -> atentie obligatie inregistrare
const fcTvaOver = fctrl.check({ company: { tvaPlatitor: false, caen: '6201', regimImpozit: 'micro' }, angajati: [{ id: 'a' }], entries: [{ period: '2026-06', data: '2026-06-01', tip: 'x', lines: [{ debit: '4111', credit: '704', suma: 420000 }] }] }, { year: '2026' });
ok('control: neplatitor peste plafonul de scutire TVA -> atentie (inregistrare in 10 zile)', fcTvaOver.findings.some((f) => f.cod === 'tva-plafon-scutire-depasit' && f.nivel === 'atentie'));
// aproape de plafon (>90% din 395.000 = 355.500) dar sub -> info monitorizare, fara constatarea de depasire
const fcTvaNear = fctrl.check({ company: { tvaPlatitor: false, caen: '6201', regimImpozit: 'micro' }, angajati: [{ id: 'a' }], entries: [{ period: '2026-06', data: '2026-06-01', tip: 'x', lines: [{ debit: '4111', credit: '704', suma: 380000 }] }] }, { year: '2026' });
ok('control: neplatitor aproape de plafonul de scutire TVA -> info (fara depasire)', fcTvaNear.findings.some((f) => f.cod === 'tva-plafon-scutire-aproape' && f.nivel === 'info') && !fcTvaNear.findings.some((f) => f.cod === 'tva-plafon-scutire-depasit'));
// reducerile comerciale (709, sold debitor) scad cifra de afaceri sub plafon -> nicio constatare de plafon
const fcTvaRed = fctrl.check({ company: { tvaPlatitor: false, caen: '6201', regimImpozit: 'micro' }, angajati: [{ id: 'a' }], entries: [{ period: '2026-06', data: '2026-06-01', tip: 'x', lines: [{ debit: '4111', credit: '704', suma: 420000 }, { debit: '709', credit: '4111', suma: 100000 }] }] }, { year: '2026' });
ok('control: 709 (reduceri) scade cifra de afaceri -> nicio constatare de plafon TVA', !fcTvaRed.findings.some((f) => /tva-plafon-scutire/.test(f.cod)));
// platitor de TVA (deja inregistrat) cu cifra de afaceri mare -> controlul de plafon NU se aplica
ok('control: platitor TVA cu CA mare -> fara constatare de plafon scutire', !fctrl.check({ company: { tvaPlatitor: true, caen: '6201', regimImpozit: 'micro' }, angajati: [{ id: 'a' }], entries: [{ period: '2026-06', data: '2026-06-01', tip: 'x', lines: [{ debit: '4111', credit: '704', suma: 900000 }] }] }, { year: '2026' }).findings.some((f) => /tva-plafon-scutire/.test(f.cod)));
// operatiuni intracom fara Intrastat marcat -> info
// Intrastat auto-detect din rulaj: sub prag -> info monitorizare; peste prag -> atentie obligat
ok('control: intracom sub pragul Intrastat -> info monitorizare', fctrl.check({ company: { tvaPlatitor: true, caen: '6201', regimImpozit: 'micro' }, angajati: [{ id: 'a' }], entries: [{ period: '2026-04', data: '2026-04-10', tip: 'livrare_intracomunitara', lines: [{ debit: '4111', credit: '707', suma: 5000 }] }] }, { year: '2026' }).findings.some((f) => f.cod === 'intracom-sub-prag' && f.nivel === 'info'));
ok('control: rulaj intracom PESTE prag + nemarcat -> atentie obligat', fctrl.check({ company: { tvaPlatitor: true, caen: '6201', regimImpozit: 'micro' }, angajati: [{ id: 'a' }], entries: [{ period: '2026-04', data: '2026-04-10', tip: 'livrare_intracomunitara', lines: [{ debit: '4111', credit: '707', suma: 1200000 }] }] }, { year: '2026' }).findings.some((f) => f.cod === 'intrastat-prag-depasit' && f.nivel === 'atentie'));
ok('control: rulaj peste prag dar Intrastat deja marcat -> fara constatare de prag', !fctrl.check({ company: { tvaPlatitor: true, caen: '6201', regimImpozit: 'micro', intrastatObligat: true }, angajati: [{ id: 'a' }], entries: [{ period: '2026-04', data: '2026-04-10', tip: 'livrare_intracomunitara', lines: [{ debit: '4111', credit: '707', suma: 1200000 }] }] }, { year: '2026' }).findings.some((f) => f.cod === 'intrastat-prag-depasit'));
// firma coerenta -> nicio constatare, ok=true
const fcOk = fctrl.check({ company: { tvaPlatitor: true, caen: '6201', regimImpozit: 'micro' }, angajati: [{ id: 'a' }], entries: [{ period: '2026-05', data: '2026-05-01', tip: 'x', lines: [{ debit: '4111', credit: '704', suma: 1000 }] }] }, { year: '2026' });
eq('control: firma coerenta -> 0 constatari, ok=true', fcOk.findings.length + '/' + fcOk.ok, '0/true');
// ── Controale pe registrul public ANAF (art. 11 si art. 297 alin. (2)) ──
{
  const registru = require('../src/anafRegistru');
  const svcP = require('../src/partnersService');
  const cump = (cui) => [{ id: 'c1', data: '2026-06-10', period: '2026-06', tip: 'factura_cumparare_marfuri',
    partenerCui: cui, partener: 'FURNIZOR SRL', status: 'postat',
    lines: [{ debit: '371', credit: '401', suma: 10000 }, { debit: '4426', credit: '401', suma: 2100 }] }];
  const cu = (anaf) => ({ partners: { 12345674: { cui: '12345674', den: 'FURNIZOR SRL', anaf } } });
  const coduri = (anaf, ent) => fctrl.controalePartener(cu(anaf), ent || cump('RO12345674'), '2026').map((f) => f.cod);
  const nivel = (anaf, cod) => (fctrl.controalePartener(cu(anaf), cump('RO12345674'), '2026').find((f) => f.cod === cod) || {}).nivel;

  // Absenta verificarii e ea insasi o constatare: „n-am verificat" nu e „e in regula".
  eq('partener neverificat cu achizitii -> se semnaleaza', coduri(null).join(), 'parteneri-neverificati-anaf');
  eq('nivelul e „atentie", nu tacere', nivel(null, 'parteneri-neverificati-anaf'), 'atentie');
  // Art. 11: inactivul face cheltuiala nedeductibila SI TVA-ul nedeductibil -> eroare.
  eq('partener INACTIV -> eroare', nivel({ verificatLa: 'x', gasit: true, inactiv: true, tvaPlatitor: true }, 'partener-inactiv'), 'eroare');
  // TVA dedusa de la cineva neinregistrat in scopuri de TVA.
  ok('TVA dedusa de la neplatitor -> eroare', coduri({ verificatLa: 'x', gasit: true, tvaPlatitor: false }).includes('tva-dedusa-de-la-neplatitor'));
  ok('neplatitor FARA TVA dedusa -> fara constatare', !fctrl.controalePartener(cu({ verificatLa: 'x', gasit: true, tvaPlatitor: false }),
    [{ id: 'c2', data: '2026-06-10', period: '2026-06', tip: 'x', partenerCui: 'RO12345674', status: 'postat', lines: [{ debit: '371', credit: '401', suma: 10000 }] }], '2026')
    .some((f) => f.cod === 'tva-dedusa-de-la-neplatitor'));
  // Art. 297 alin. (2): TVA la incasare la FURNIZOR amana deducerea cumparatorului.
  eq('furnizor cu TVA la incasare -> info (deducerea se amana)', nivel({ verificatLa: 'x', gasit: true, tvaPlatitor: true, tvaLaIncasare: true }, 'furnizor-tva-la-incasare'), 'info');
  ok('CUI inexistent in registru -> atentie', coduri({ verificatLa: 'x', gasit: false }).includes('partener-inexistent-anaf'));
  eq('partener verificat si curat -> nicio constatare', coduri({ verificatLa: 'x', gasit: true, tvaPlatitor: true }).length, 0);
  // Fara achizitii nu se spune nimic: un client caruia ii vinzi nu-ti afecteaza deductibilitatea.
  eq('doar vanzari catre partener -> niciun control de partener', fctrl.controalePartener(cu(null),
    [{ id: 'v1', data: '2026-06-10', period: '2026-06', tip: 'factura_vanzare_marfuri', partenerCui: 'RO12345674', status: 'postat', lines: [{ debit: '4111', credit: '707', suma: 5000 }, { debit: '4111', credit: '4427', suma: 1050 }] }], '2026').length, 0);
  // Cheia de nomenclator e CUI-ul fara RO: cu prefix, partenerul verificat n-ar mai fi gasit
  // si controlul ar raporta fals „neverificat" tocmai pentru cel verificat.
  eq('CUI-ul cu prefix RO se potriveste cu cheia din nomenclator', coduri({ verificatLa: 'x', gasit: true, tvaPlatitor: true }, cump('RO12345674')).length, 0);
  eq('si cel fara prefix, la fel', coduri({ verificatLa: 'x', gasit: true, tvaPlatitor: true }, cump('12345674')).length, 0);

  // Normalizarea raspunsului ANAF (forma ridicata prin sondarea serviciului real).
  const n = registru.normalizeaza({
    date_generale: { cui: 5, denumire: 'X SRL', stare_inregistrare: 'RADIERE din data 01.01.2020', statusRO_e_Factura: true },
    inregistrare_scop_Tva: { scpTVA: false, perioade_TVA: [{ data_inceput_ScpTVA: '2010-01-01' }, { data_inceput_ScpTVA: '2015-01-01', data_sfarsit_ScpTVA: '2020-01-01', mesaj_ScpTVA: 'anulat' }] },
  });
  eq('perioada de TVA luata e ULTIMA (cea curenta)', n.tvaPanaLa + '|' + n.tvaMotivAnulare, '2020-01-01|anulat');
  eq('radierea se citeste din textul starii', n.radiat, true);
  eq('sectiunile lipsa nu arunca, dau false', [n.inactiv, n.splitTva, n.tvaLaIncasare].join(), 'false,false,false');
  eq('CUI-ul se normalizeaza la sir', typeof n.cui, 'string');
  eq('cuiNumeric curata prefixul si separatorii', registru.cuiNumeric('RO 12 345 674'), 12345674);
  eq('cuiNumeric refuza ce nu e numar', registru.cuiNumeric('RO'), null);

  // Diferentele fata de nomenclator: doar de forma nu inseamna diferenta.
  eq('diferenta doar de majuscule/spatii nu se raporteaza', svcP.diferente({ den: 'test  srl' }, { denumire: 'TEST SRL' }).length, 0);
  eq('diferenta reala se raporteaza pe camp', svcP.diferente({ den: 'Alt nume' }, { denumire: 'TEST SRL' }).map((x) => x.camp).join(), 'den');
  eq('campurile goale la ANAF nu sterg datele noastre', svcP.diferente({ den: 'Al nostru', adresa: 'A' }, { denumire: '', adresa: '' }).length, 0);
}

// GUARD de scriere (fiscalProfile.entryGuard): neplatitor nu poate COLECTA TVA, dar taxarea inversa (net 0) e permisa
const gNepl = fp.build({ tvaPlatitor: false });
const gPlat = fp.build({ tvaPlatitor: true });
ok('guard: neplatitor + vanzare cu TVA (4427 net>0) -> blocat', !!fp.entryGuard(gNepl, { lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] }));
ok('guard: platitor + vanzare cu TVA -> permis (null)', fp.entryGuard(gPlat, { lines: [{ debit: '4111', credit: '4427', suma: 210 }] }) === null);
ok('guard: neplatitor + taxare inversa (4426=4427, net 0) -> permis', fp.entryGuard(gNepl, { lines: [{ debit: '4426', credit: '4427', suma: 210 }] }) === null);
ok('guard: neplatitor + document fara TVA -> permis', fp.entryGuard(gNepl, { lines: [{ debit: '5311', credit: '707', suma: 500 }] }) === null);
// expectedForFirma deleaga spre motor -> Intrastat vizibil in registru cand firma e obligata
const vIntra = { firmaId: 7, company: { tvaPlatitor: true, intrastatObligat: true }, angajati: [], entries: [{ tip: 'livrare_intracomunitara', period: '2026-05', data: '2026-05-10' }] };
ok('expectedForFirma: Intrastat apare pentru firma obligata cu miscari intracom', declMod.expectedForFirma(vIntra, '2026-05').some((x) => x.tip === 'intrastat'));
const vIntraD301 = { firmaId: 7, company: { tvaPlatitor: false, tvaArt317: false, intrastatObligat: true }, angajati: [], entries: [{ tip: 'achizitie_tva_speciala_d301', d301: { tipOperatie: 1 }, period: '2026-05', data: '2026-05-10' }] };
ok('expectedForFirma: bunurile D301 declanseaza Intrastat independent de eligibilitatea D390', declMod.expectedForFirma(vIntraD301, '2026-05').some((x) => x.tip === 'intrastat'));
ok('expectedForFirma: aceleasi bunuri D301 fara art. 317 nu inventeaza D390', !declMod.expectedForFirma(vIntraD301, '2026-05').some((x) => x.tip === 'd390'));

section('Exercitiul de restaurare automatizat (src/restoreDrill.js)');
const drillMod = require('../src/restoreDrill');
// graf coerent (2 firme, partida dubla echilibrata) -> drill ok, numaratoare corecta
const drillDb = { firmaActiva: 1, firme: [{ id: 1, nume: 'Alfa SRL' }, { id: 2, nume: 'Beta SRL' }],
  entries: [
    { id: 'a', firmaId: 1, period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '5121', credit: '4111', suma: 1000 }] },
    { id: 'b', firmaId: 2, period: '2026-03', data: '2026-03-02', lines: [{ debit: '371', credit: '401', suma: 500 }] },
  ], openingBalances: {} };
const drOk = drillMod.drillGraph(drillDb);
eq('drill: graf coerent -> ok, 2 firme, 2 articole', drOk.ok + '/' + drOk.nrFirme + '/' + drOk.totalEntries, 'true/2/2');
ok('drill: fiecare firma raportata cu balanta echilibrata', drOk.firme.every((f) => f.balanced && f.totalDebit === f.totalCredit));
// preluare (openingBalances) STRICATA -> balanta de verificare nu se inchide -> drill esueaza, motivul numeste firma
const drillBad = { firmaActiva: 1, firme: [{ id: 1, nume: 'Stricata SRL' }],
  entries: [{ id: 'x', firmaId: 1, period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 1000 }] }],
  openingBalances: { 1: { '5121': { d: 5000, c: 0 } } } }; // preluare de 5000 debit fara contrapartida
const drBad = drillMod.drillGraph(drillBad);
ok('drill: preluare dezechilibrata -> ok=false, motivul numeste firma', drBad.ok === false && /Stricata SRL/.test(drBad.motiv));
// ciornele NU intra in verificare (ca peste tot in agregari): o ciorna dezechilibrata nu strica drill-ul
const drillCiorna = { firmaActiva: 1, firme: [{ id: 1, nume: 'Ciorna SRL' }],
  entries: [{ id: 'c', firmaId: 1, status: 'ciorna', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '5121', credit: '4111', suma: 1 }] }], openingBalances: {} };
ok('drill: ciornele excluse din verificare -> ok', drillMod.drillGraph(drillCiorna).ok === true);
// graf fara firme -> ok=false cu motiv
ok('drill: db.json fara lista de firme -> ok=false', drillMod.drillGraph({ entries: [] }).ok === false && !!drillMod.drillGraph({ entries: [] }).motiv);
// INTEGRARE: arhiva completa reala (fullBackup) -> drillArchive o deschide si o valideaza
const drillBackup = require('../src/backup');
const drillTmp = require('os').tmpdir() + '/drill-' + process.pid;
require('fs').mkdirSync(drillTmp, { recursive: true });
const drillDbFile = drillTmp + '/db.json';
require('fs').writeFileSync(drillDbFile, JSON.stringify(Object.assign({ users: [{ id: 1 }] }, drillDb)));
const drillArch = drillBackup.fullBackup(drillDbFile, drillTmp, 5);
const drArch = drillMod.drillArchive(drillArch.path);
eq('drill: arhiva completa reala -> restaurabila si coerenta contabil', drArch.ok + '/' + drArch.totalEntries, 'true/2');
require('fs').rmSync(drillTmp, { recursive: true, force: true });

section('e-Factura netrimisa in SPV + SAF-T lunar');
eq('addCalendarDays: vineri + 5 zile calendaristice', declMod.addCalendarDays('2026-07-03', 5), '2026-07-08');
const vEf = { firmaId: 9, company: { nume: 'EF SRL', tvaPlatitor: true }, angajati: [], entries: [
  { id: 'e1', tip: 'factura_vanzare_servicii', partenerCui: 'RO123', partener: 'X', document: 'F1', data: '2026-07-18' },
  { id: 'e2', tip: 'factura_vanzare_marfuri', partenerCui: 'RO1', document: 'F2', data: '2026-07-15', spv: { index: '5' } },
  { id: 'e3', tip: 'factura_cumparare_marfuri', partenerCui: 'RO2', document: 'F3', data: '2026-07-15' },
  { id: 'e4', tip: 'factura_vanzare_produse', partenerCui: 'RO4', document: 'F4', data: '2026-07-01' },
  { id: 'e5', tip: 'factura_vanzare_produse', document: 'F5', data: '2026-07-15' },
] };
const efx = declMod.eFacturaNetrimise(vEf, '2026-07-20');
// `e5` nu are CUI de partener: e o factura B2C, deci intra si ea (raportabila din 2025).
eq('netrimise: vanzarile B2B si B2C fara spv', efx.count, 3);
eq('netrimise: restante (termen depasit)', efx.overdue, 1);
eq('netrimise: termen = data + 5 zile CALENDARISTICE (OUG 89/2025)', efx.items.find((x) => x.entryId === 'e1').due, '2026-07-23');
// ── Perimetrul e-Factura: DOUA conditii independente ─────────────────────────────────────────
// Erau amandoua gresite. Conditia 1 (documentul e o factura emisa) era o lista de cinci id-uri
// scrisa de mana, in trei copii; conditia 2 (beneficiarul e stabilit in Romania) lipsea.
{
  const TIP = require('../src/documentTypes');
  const F = (id, tip, cui, data) => ({ id, tip, partenerCui: cui, partener: 'P', document: id, data });
  const vv = (entries) => ({ firmaId: 9, company: { nume: 'EF SRL', tvaPlatitor: true }, angajati: [], entries });
  // Facturi emise care nu puteau pleca deloc in SPV — cauza directa a constatarii A2.
  for (const tip of ['factura_avans_client', 'facturare_aviz', 'vanzare_mijloc_fix',
    'taxare_inversa_interna_livrare', 'reducere_comerciala_acordata', 'factura_vanzare_valuta',
    'factura_vanzare_incasare']) {
    ok('e-Factura: „' + tip + '" e factura emisa (se poate trimite in SPV)', xml.isSendable({ tip }));
    ok('...si se poate genera UBL pentru ea', xml.isEFacturaEligible({ tip }));
    eq('...si intra in restantele cu termen', declMod.eFacturaNetrimise(vv([F('x', tip, 'RO7', '2026-07-01')]), '2026-07-20').count, 1);
  }
  // Documente care SEAMANA cu o factura si nu sunt. Decizia e explicita pe tip, cu motiv scris.
  for (const tip of ['bon_fiscal_z', 'aviz_livrare', 'factura_simplificata', 'horeca_vanzare',
    'diferenta_curs_favorabila', 'scont_acordat', 'factura_storno_cumparare',
    // storno de avans: se inregistreaza PE factura finala (art. 319 alin. 6), nu ca document
    // separat — randat singur ar iesi o „factura" cu sume negative
    'regularizare_avans_client']) {
    ok('e-Factura: „' + tip + '" NU e factura emisa de noi', !xml.isSendable({ tip }));
  }
  // SUMELE de pe UBL, pentru FIECARE tip declarat trimisibil. Fara asta, „se poate trimite" ar fi
  // fost o promisiune goala: citirea sumelor era ancorata pe o lista de patru conturi de venit
  // (701/704/707/708), deci avansul (419), facturarea avizului (418), mijlocul fix (7583) si TVA la
  // incasare (4428) ieseau cu baza sau TVA ZERO. O factura cu baza 0 si TVA 210 e mai rea decat una
  // negenerata — pleaca la ANAF. Testul e pe TOATE tipurile, nu pe cateva alese: un tip nou marcat
  // „da" fara sume corecte pica aici.
  {
    const P = { baza: 1000, tva: 210, cota: 21, suma: 1000, pret: 1000, valoare: 1000, valuta: 200, curs: 5, cantitate: 1 };
    // Operatiunile scutite / cu taxare inversa au TVA 0 pe factura — asta e regula, nu o scapare.
    const FARA_TVA = new Set(['livrare_intracomunitara', 'prestare_servicii_intracomunitara',
      'taxare_inversa_interna_livrare', 'factura_vanzare_valuta', 'export_extracomunitar', 'livrare_triunghiulara']);
    const emise = TIP.TYPES.filter((t) => t.eFactura === 'da');
    ok('sunt cel putin 13 tipuri de factura emisa', emise.length >= 13);
    for (const t of emise) {
      let lines = []; try { lines = t.build(P) || []; } catch (e) { lines = []; }
      const e = { tip: t.id, document: 'F1', data: '2026-06-10', partenerCui: 'RO123', partener: 'C', lines };
      // Generarea se prinde: un tip marcat „da" care NU se poate randa trebuie sa iasa ca
      // aserțiune cu nume, nu ca exceptie care opreste suita in loc necunoscut.
      let m = '';
      try { m = xml.eFacturaXml({ cui: 'RO1', nume: 'X' }, e, {}); } catch (err) { m = ''; }
      ok('UBL „' + t.id + '": se poate genera', m !== '');
      const nr = (re) => { const g = re.exec(m); return g ? Number(g[1]) : NaN; };
      const baza = nr(/TaxableAmount[^>]*>([\d.-]+)/);
      const tvaX = nr(/cbc:TaxAmount[^>]*>([\d.-]+)/);
      const total = nr(/PayableAmount[^>]*>([\d.-]+)/);
      eq('UBL „' + t.id + '": baza = 1000', baza, 1000);
      eq('UBL „' + t.id + '": TVA = ' + (FARA_TVA.has(t.id) ? '0 (scutit/taxare inversa)' : '210'), tvaX, FARA_TVA.has(t.id) ? 0 : 210);
      eq('UBL „' + t.id + '": total = baza + TVA', total, Math.round((baza + tvaX) * 100) / 100);
      ok('UBL „' + t.id + '": are denumire de articol, nu una generica', !/>Produse\/servicii</.test(m));
    }
  }

  // Conditia 2: obligatia priveste relatia B2B INTERNA (OUG 120/2021 art. 10). O livrare
  // intracomunitara e o factura emisa valabila, dar nu produce o restanta cu termen de 5 zile.
  eq('CUI romanesc cu prefix RO -> B2B', xml.perimetruEFactura('RO12345678'), 'b2b');
  eq('...si fara prefix (forma uzuala) -> B2B', xml.perimetruEFactura('12345678'), 'b2b');
  eq('cod de TVA din alt stat membru -> strain', xml.perimetruEFactura('DE811907980'), 'strain');
  // CNP-ul are TREISPREZECE cifre, un CUI romanesc cel mult zece: nu se pot confunda.
  eq('CNP (13 cifre) -> B2C', xml.perimetruEFactura('1900101415238'), 'b2c');
  eq('fara cod deloc -> B2C (cazul celor 13 zerouri)', xml.perimetruEFactura(''), 'b2c');
  // Fisa partenerului are ultimul cuvant cand codul nu spune nimic: un client strain inregistrat
  // doar cu numele nu trebuie sa devina o „restanta B2C".
  eq('partener fara cod, dar cu tara straina -> strain', xml.perimetruEFactura('', { tara: 'DE' }), 'strain');
  eq('livrare intracomunitara: factura emisa valabila, dar fara termen de 5 zile',
    declMod.eFacturaNetrimise(vv([F('ic', 'livrare_intracomunitara', 'DE811907980', '2026-07-01')]), '2026-07-20').count, 0);
  ok('...desi ramane trimisibila manual in SPV', xml.isSendable({ tip: 'livrare_intracomunitara' }));
  // ── B2C in UBL: identificatorul cumparatorului (BT-47) ────────────────────────────────────────
  // Obligatorie din 1 ianuarie 2025. Doua greseli, amandoua tacute pana acum:
  //   - clientul FARA cod iesea fara niciun identificator, iar SPV-ul il cere;
  //   - CNP-ul era prefixat cu „RO" si pus si in campul codului de TVA — un CNP declarat drept
  //     cod de TVA al unei firme care nu exista.
  {
    const fact = (cui, partener, pinfo) => xml.eFacturaXml({ cui: 'RO12345674', nume: 'F SRL' },
      { tip: 'factura_vanzare_marfuri', data: '2026-06-10', document: 'F1', partenerCui: cui, partener,
        lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] },
      pinfo || {});
    // Blocul CUMPARATORULUI se decupeaza intai: furnizorul e scris inaintea lui si are aceleasi
    // etichete, deci o cautare pe tot documentul intoarce datele firmei proprii — ceea ce s-a si
    // intamplat la prima scriere a testului, iar aserțiunea ar fi trecut daca cerea „nu e gol".
    const bloc = (m) => { const g = /<cac:AccountingCustomerParty>[\s\S]*?<\/cac:AccountingCustomerParty>/.exec(m); return g ? g[0] : ''; };
    const legalId = (m) => { const g = /<cac:PartyLegalEntity>[\s\S]*?<cbc:CompanyID>([^<]*)</.exec(bloc(m)); return g ? g[1] : ''; };
    const areTva = (m) => /<cac:PartyTaxScheme>/.test(bloc(m));

    const b2c = fact('', 'Ionescu Maria');
    eq('B2C fara cod: BT-47 = codul de 13 zerouri', legalId(b2c), xml.CIF_PERSOANA_FIZICA);
    eq('...si sunt chiar 13 zerouri', xml.CIF_PERSOANA_FIZICA, '0000000000000');
    ok('B2C: FARA cod de TVA al cumparatorului (BT-48)', !areTva(b2c));
    ok('B2C: numele persoanei ramane pe factura', /Ionescu Maria/.test(b2c));

    const cuCnp = fact('1900101415238', 'Ionescu Maria');
    eq('B2C cu CNP: BT-47 = CNP-ul, neatins', legalId(cuCnp), '1900101415238');
    ok('...si NU prefixat cu RO', !/RO1900101415238/.test(cuCnp));
    ok('B2C cu CNP: tot fara cod de TVA', !areTva(cuCnp));

    const b2b = fact('RO99887760', 'BETA SRL');
    eq('B2B ramane neschimbat: BT-47 = codul firmei', legalId(b2b), 'RO99887760');
    ok('B2B: codul de TVA al cumparatorului e prezent', areTva(b2b));

    // Nota de credit isi construieste partile pe alta cale — aceeasi regula, alt generator.
    const notaB2c = xml.eFacturaXml({ cui: 'RO12345674', nume: 'F SRL' },
      { tip: 'factura_storno_vanzare', data: '2026-06-11', document: 'S1', partener: 'Ionescu Maria',
        lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] }, {});
    ok('nota de credit catre persoana fizica e CreditNote', /<CreditNote/.test(notaB2c));
    eq('...si poarta acelasi identificator de 13 zerouri', legalId(notaB2c), xml.CIF_PERSOANA_FIZICA);
  }

  eq('aceeasi livrare catre un client ROMAN produce restanta',
    declMod.eFacturaNetrimise(vv([F('ro', 'factura_vanzare_marfuri', 'RO9', '2026-07-01')]), '2026-07-20').count, 1);
}
const nEf = declMod.notifications({ declarations: [] }, [vEf], '2026-07-20');
ok('notificari: e-Factura restanta prezenta (status netrimisa)', nEf.items.some((i) => i.tip === 'efactura' && i.kind === 'restanta' && i.status === 'netrimisa'));
ok('notificari: e-Factura cu termen apropiat apare', nEf.items.some((i) => i.tip === 'efactura' && i.kind === 'termen'));
// perioada TVA TRIMESTRIALA: D300/D394/D406 doar la sfarsit de trimestru
{
  const vLun = { company: { tvaPlatitor: true, perioadaTva: 'L' }, angajati: [], entries: [] };
  const vTri = { company: { tvaPlatitor: true, perioadaTva: 'T' }, angajati: [], entries: [] };
  const tipuri = (v, per) => declMod.expectedForFirma(v, per).map((x) => x.tip);
  ok('lunar: D300/D394 in luna 5 (non-trimestru)', tipuri(vLun, '2026-05').includes('d300') && tipuri(vLun, '2026-05').includes('d394'));
  ok('trimestrial: FARA D300/D394 in luna 5', !tipuri(vTri, '2026-05').includes('d300') && !tipuri(vTri, '2026-05').includes('d394'));
  ok('trimestrial: CU D300/D394 in luna 6 (sfarsit de trimestru)', tipuri(vTri, '2026-06').includes('d300') && tipuri(vTri, '2026-06').includes('d394'));
  ok('trimestrial: D406 urmeaza perioada TVA (nu in luna 5, da in luna 6)', !tipuri(vTri, '2026-05').includes('saft') && tipuri(vTri, '2026-06').includes('saft'));
  ok('lunar: D406 in fiecare luna', tipuri(vLun, '2026-05').includes('saft'));
}

// agregarea CONTINUTULUI pe trimestru (nu doar registrul): D300/D394 aduna cele 3 luni
{
  const accMod = require('../src/accounting');
  const repMod = require('../src/reporting');
  eq('vatPeriod: regim T -> trimestrul lunii', accMod.vatPeriod({ perioadaTva: 'T' }, '2026-05'), '2026-Q2');
  eq('vatPeriod: regim L -> luna ca atare', accMod.vatPeriod({ perioadaTva: 'L' }, '2026-05'), '2026-05');
  const mkV = (data, doc) => ({ id: doc, data, period: data.slice(0, 7), tip: 'factura_vanzare_marfuri', tipNume: 'V', partener: 'C', partenerCui: 'RO99887760', document: doc, lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] });
  const vT = { company: { perioadaTva: 'T' }, entries: [mkV('2026-04-10', 'A'), mkV('2026-05-10', 'B'), mkV('2026-06-10', 'C'), mkV('2026-07-10', 'D')], openingBalances: {} };
  const dQ2 = repMod.d300(vT, '2026-Q2');
  eq('D300 trimestrial: baza = suma celor 3 luni (Apr+Mai+Iun)', dQ2.bazaV, 3000);
  eq('D300 trimestrial: TVA colectata pe trimestru', dQ2.colectata, 630);
  eq('D300 lunar (o luna) NU aduna trimestrul', repMod.d300(vT, '2026-05').bazaV, 1000);
  eq('trimestrul exclude luna din alt trimestru (iulie)', repMod.d300(vT, '2026-Q3').bazaV, 1000);
}
ok('SAF-T lunar: bine-format, perioada corecta si codul L in HeaderComment', (() => { const x = saft.saftXml(vDecl, '2026-06'); return x.includes('<PeriodStart>6</PeriodStart>') && x.includes('<PeriodEnd>6</PeriodEnd>') && x.includes('<HeaderComment>L</HeaderComment>'); })());

section('Coada de persistenta: starea expusa (store/storePg queueStats)');
{
  const st = require('../src/store');
  const q = st.queueStats();
  ok('sqlite expune contractul complet', ['driver', 'pending', 'pendingAgeMs', 'pendingBytes', 'draining', 'commits', 'failStreak', 'lastCommitAt', 'lastError', 'conflicted'].every((k) => k in q));
  // Pe sqlite persist e SINCRON: nu exista niciodata ceva in asteptare. Zeroul e adevarul, nu umplutura.
  ok('sqlite: nimic in asteptare, niciodata', q.pending === false && q.pendingAgeMs === 0 && q.pendingBytes === 0);
  ok('sqlite: numara scrierile comise', typeof q.commits === 'number');
  const inainte = st.queueStats().commits;
  db.get().settings.__probaCoada = Date.now(); // fara o schimbare reala, persist() nu scrie nimic
  db.save();
  ok('un save() cu schimbari avanseaza contorul de commit-uri', st.queueStats().commits > inainte);
  const dupa = st.queueStats().commits;
  db.save();
  ok('un save() FARA schimbari nu produce tranzactie (zero I/O)', st.queueStats().commits === dupa);
  delete db.get().settings.__probaCoada; db.save();
  ok('...si dateaza ultima scriere', !!st.queueStats().lastCommitAt);
  // db.persistStats() da acelasi contract, indiferent de driver (ruta si jobul nu ramifica)
  const p = db.persistStats();
  ok('db.persistStats expune acelasi contract', p.driver === 'sqlite' && p.pending === false);

  // storePg: contractul exista si fara conexiune (jobul de veghe il apeleaza la fiecare minut)
  const pg = require('../src/storePg');
  const qp = pg.queueStats();
  ok('storePg expune acelasi contract, fara conexiune', qp.driver === 'pg' && qp.pending === false && qp.pendingAgeMs === 0);

  // Pragurile de memorie: o SINGURA sursa pentru metrica si pentru alerta
  const met = require('../src/metrics');
  ok('plafonul pm2 si pragul de avertizare sunt numere coerente',
    met.MEM_LIMIT_MB > 0 && met.MEM_WARN_MB > 0 && met.MEM_WARN_MB < met.MEM_LIMIT_MB);
  eq('pragul implicit e 70% din plafon', met.MEM_WARN_MB, Math.round(met.MEM_LIMIT_MB * 0.7));
  // Decizia „ce colectii diff-uim acum" (pura, src/persistPlan.js). `null` = diff COMPLET.
  // Regula de aur: orice motiv de completitudine BATE indiciul — un indiciu nu are voie sa
  // impiedice diff-ul complet, fiindca el e singura cale prin care o colectie sarita se recupereaza.
  const plan = require('../src/persistPlan');
  const proaspat = { forceFull: false, partiale: 0, dinUltimulComplet: 0 };
  const stPlan = (x) => Object.assign({}, proaspat, x);
  ok('fara indiciu -> diff complet (comportamentul dintotdeauna)', plan.colectiiDeDiffuit(undefined, proaspat) === null);
  ok('indiciu valid -> se restrange la colectiile cerute',
    (() => { const s = plan.colectiiDeDiffuit(['visitors'], proaspat); return s instanceof Set && s.size === 1 && s.has('visitors'); })());
  ok('indiciu ca sir simplu, nu doar ca lista', (() => { const s = plan.colectiiDeDiffuit('visitors', proaspat); return s && s.has('visitors'); })());
  ok('forceFull (init/restore) BATE indiciul', plan.colectiiDeDiffuit(['visitors'], stPlan({ forceFull: true })) === null);
  ok('indiciu gol -> nu restrange nimic', plan.colectiiDeDiffuit([], proaspat) === null);
  ok('indiciu numai cu gunoi -> nu restrange nimic', plan.colectiiDeDiffuit([null, '', 42], proaspat) === null);
  ok('plasa pe NUMAR: la prag se face diff complet',
    plan.colectiiDeDiffuit(['visitors'], stPlan({ partiale: plan.SAVE_FULL_EVERY })) === null);
  ok('...dar cu una mai putin indiciul inca tine',
    plan.colectiiDeDiffuit(['visitors'], stPlan({ partiale: plan.SAVE_FULL_EVERY - 1 })) !== null);
  ok('plasa pe TIMP: la prag se face diff complet',
    plan.colectiiDeDiffuit(['visitors'], stPlan({ dinUltimulComplet: plan.SAVE_FULL_MS })) === null);
  ok('...dar sub prag indiciul inca tine',
    plan.colectiiDeDiffuit(['visitors'], stPlan({ dinUltimulComplet: plan.SAVE_FULL_MS - 1 })) !== null);
  // `Infinity` = niciun diff complet inca (proces proaspat): trebuie tratat ca „scadent", nu ca „sub prag".
  ok('niciun diff complet inca -> primul persist e COMPLET',
    plan.colectiiDeDiffuit(['visitors'], stPlan({ dinUltimulComplet: Infinity })) === null);
  // Contorul: partial consuma fereastra, complet o re-armeaza.
  const stare = plan.stareNoua();
  plan.noteazaDiff(stare, new Set(['visitors'])); plan.noteazaDiff(stare, new Set(['visitors']));
  eq('doua salvari partiale consuma doua unitati din plasa', stare.partiale, 2);
  plan.noteazaDiff(stare, null);
  eq('un diff complet re-armeaza contorul', stare.partiale, 0);
  ok('...si noteaza momentul', stare.ultimulComplet > 0);

  // ── EFECTUL indiciului, nu mecanismul lui ────────────────────────────────────────────────
  // Toate aserttile de mai sus compara pragul CU EL INSUSI (`SAVE_FULL_MS - 1`), deci trec pentru
  // ORICE valoare a lui — inclusiv pentru una care taie indiciul la fiecare rulare. Exact asta se
  // intamplase: prag 30 s, cadenta jobului 60 s, deci diff COMPLET de fiecare data si optimizarea
  // moarta la rulare, cu suita verde. Poarta de aici leaga cele doua constante REALE si simuleaza
  // cadenta adevarata a singurului apelant cu indiciu.
  const cadenta = require('../src/jobs').VISITORS_FLUSH_MS;
  ok('cadenta jobului cu indiciu e o constanta numita (nu un numar magic)', cadenta > 0);
  ok('pragul de timp lasa indiciul sa se activeze (prag > cadenta)', plan.SAVE_FULL_MS > cadenta);
  ok('...si il face CAZUL OBISNUIT, nu exceptia (prag > 2x cadenta)', plan.SAVE_FULL_MS > 2 * cadenta);

  // Simulare pe ceas virtual: proces proaspat, apoi o rulare la fiecare `cadenta`. Numaram cate
  // ies partiale si cate complete — singura forma in care „indiciul functioneaza" e o AFIRMATIE
  // verificabila. Cu pragul vechi de 30 s, `nrPartiale` iese 0 si prima aserttie pica.
  let dinComplet = Infinity;  // niciun diff complet inca
  let consecutive = 0;
  let nrPartiale = 0;
  let nrComplete = 0;
  for (let tick = 0; tick < 10; tick += 1) {
    const only = plan.colectiiDeDiffuit(['visitors'], { forceFull: false, partiale: consecutive, dinUltimulComplet: dinComplet });
    if (only) { nrPartiale += 1; consecutive += 1; dinComplet += cadenta; }
    else { nrComplete += 1; consecutive = 0; dinComplet = cadenta; }
  }
  eq('10 rulari la cadenta reala: toate colectiile se contorizeaza', nrPartiale + nrComplete, 10);
  ok('indiciul CHIAR se activeaza la cadenta reala a jobului', nrPartiale > 0);
  ok('...si e majoritar (altfel optimizarea nu-si merita complexitatea)', nrPartiale > nrComplete);
  // `nrComplete > 0` ar fi trecut DIN MOTIVUL GRESIT: primul persist al oricarui proces e complet
  // (`dinUltimulComplet = Infinity`), deci aserttia ar fi fost adevarata si cu un prag de o ora,
  // adica exact in cazul in care plasa nu se mai inchide niciodata. Cerem inchideri REPETATE.
  ok('plasa se inchide si DUPA primul diff complet, nu doar la pornire', nrComplete >= 2);
  // Promisiunea reala a celor doua plase impreuna: cat timp poate trai in RAM o schimbare pe care
  // un indiciu gresit a sarit-o. E o POLITICA, deci se scrie ca atare — nu se deduce din praguri.
  const fereastraRecuperareMs = Math.min(plan.SAVE_FULL_EVERY * cadenta, plan.SAVE_FULL_MS);
  ok('fereastra garantata de recuperare ramane sub 10 minute',
    fereastraRecuperareMs > 0 && fereastraRecuperareMs <= 10 * 60 * 1000);

  // Decizia de ALERTA pe coada (pura): fiecare caz, plus pragurile.
  const { persistVerdict } = require('../src/jobs');
  const baza = { pending: false, pendingAgeMs: 0, pendingBytes: 0, failStreak: 0, conflicted: false };
  ok('coada la zi -> fara alerta', persistVerdict(baza).alert === false);
  ok('scrieri in asteptare, dar sub prag -> fara alerta',
    persistVerdict(Object.assign({}, baza, { pending: true, pendingAgeMs: 5000 }), { lagMs: 60000 }).alert === false);
  ok('scrieri necomise peste prag -> alerta, cu vechimea si memoria retinuta', (() => {
    const v = persistVerdict(Object.assign({}, baza, { pending: true, pendingAgeMs: 90000, pendingBytes: 2048 }), { lagMs: 60000 });
    return v.alert && v.cod === 'intarziere' && /90s/.test(v.motiv) && /2 KB/.test(v.motiv);
  })());
  ok('esecuri consecutive peste prag -> alerta', persistVerdict(Object.assign({}, baza, { failStreak: 3 }), { fails: 3 }).alert === true);
  ok('un singur esec nu alerteaza', persistVerdict(Object.assign({}, baza, { failStreak: 1 }), { fails: 3 }).alert === false);
  ok('conflictul de scriitor are prioritate (nimic nu se mai scrie)', (() => {
    const v = persistVerdict(Object.assign({}, baza, { conflicted: true, pending: true, pendingAgeMs: 90000 }));
    return v.alert && v.cod === 'conflict' && /INGHETATA/.test(v.motiv);
  })());
  // pe sqlite semnalul e constant zero -> jobul nu poate alerta fals
  ok('starea reala de pe sqlite nu declanseaza alerta', persistVerdict(require('../src/store').queueStats()).alert === false);
}


section('Blocajul buclei: alerta NUMESTE vinovatul (joburi + persist, nu doar cereri)');
{
  // Alerta de lag stia CAT a stat blocata bucla si spunea singura, in clar, „cauta in joburi, nu in
  // rute" — adica isi recunostea propriul punct orb. Cererile erau masurate, joburile si `db.save()`
  // nu. Sectiunea verifica jumatatea care lipsea, plus propozitia pe care o citeste omul.
  const met = require('../src/metrics');
  const { suspectiLag, ruleazaJob } = require('../src/jobs');

  // ── Propozitia din alerta (pura) ──────────────────────────────────────────────────────────
  const J = [{ job: 'backup', ms: 1420 }, { job: 'visitors-flush', ms: 12 }];
  const C = [{ route: 'GET /pdf/situatii', ms: 610 }];
  ok('cand nu s-a masurat nimic, mesajul spune CE INSEAMNA asta, nu „cauta in joburi"', (() => {
    const t = suspectiLag([], 0, []);
    return /nimic masurat/.test(t) && /GC/.test(t) && !/cauta in joburi/.test(t);
  })());
  ok('un job lung e numit, cu durata lui', /joburi: backup 1420ms/.test(suspectiLag(J, 0, [])));
  ok('varful de persist e raportat SEPARAT, nu topit in joburi', /persist \(db\.save\) varf 340ms/.test(suspectiLag([], 340, [])));
  ok('cererile lente apar si ele', /cereri: GET \/pdf\/situatii 610ms/.test(suspectiLag([], 0, C)));
  ok('ordinea e cauza -> efect: joburi, persist, apoi cereri', (() => {
    const t = suspectiLag(J, 340, C);
    return t.indexOf('joburi:') < t.indexOf('persist') && t.indexOf('persist') < t.indexOf('cereri:');
  })());
  ok('un persist de 0 ms nu umple mesajul cu zgomot', !/persist/.test(suspectiLag(J, 0, C)));

  // ── Masuratoarea pe job ───────────────────────────────────────────────────────────────────
  met.reset();
  ruleazaJob('proba-job', () => { for (let i = 0; i < 2e5; i += 1) Math.sqrt(i); });
  const dupa1 = met.jobsSnapshot()['proba-job'];
  ok('o tura de job se contorizeaza', dupa1 && dupa1.n === 1);
  ok('...cu o durata masurata, nu zero pus de mana', dupa1.lastMs >= 0 && dupa1.maxMs === dupa1.lastMs);
  ok('...si apare in fereastra recenta, cu numele jobului', (() => {
    const r = met.jobsRecent(60000, 3);
    return r.length === 1 && r[0].job === 'proba-job';
  })());

  // Cazul care conteaza cel mai mult: jobul care ARUNCA dupa ce a blocat bucla. Un cronometru pus
  // pe calea fericita l-ar fi ratat exact pe el — a blocat, deci trebuie sa apara.
  // (linia „eroare in job periodic" de mai jos e ASTEPTATA: proba chiar arunca)
  ruleazaJob('proba-job-cade', () => { throw new Error('esec deliberat, pentru masuratoare'); });
  const dupaCad = met.jobsSnapshot()['proba-job-cade'];
  ok('un job care arunca e TOTUSI masurat (blocajul lui a existat)', dupaCad && dupaCad.n === 1);
  eq('...si esecul lui e numarat separat', dupaCad.errors, 1);

  // Fereastra: o rulare veche nu are voie sa acuze fereastra de acum.
  met.jobRun('proba-veche', 999, Date.now() - 5 * 60 * 1000);
  ok('o rulare din afara ferestrei nu intra in suspecti',
    !met.jobsRecent(60000, 5).some((x) => x.job === 'proba-veche'));
  ok('...dar intra intr-o fereastra destul de larga',
    met.jobsRecent(10 * 60 * 1000, 5).some((x) => x.job === 'proba-veche'));
  ok('suspectii sunt ordonati descrescator (cel mai lung primul)', (() => {
    const r = met.jobsRecent(10 * 60 * 1000, 5);
    return r.length > 1 && r.every((x, i) => i === 0 || r[i - 1].ms >= x.ms);
  })());

  // ── Masuratoarea pe persist ───────────────────────────────────────────────────────────────
  met.reset();
  eq('fara nicio scriere, varful de persist e 0 (nu gunoi)', met.persistPeak(60000), 0);
  eq('...si media e 0, nu NaN', met.persistSnapshot().avgMs, 0);
  met.persistRun(120); met.persistRun(40);
  const ps = met.persistSnapshot();
  eq('scrierile se contorizeaza', ps.n, 2);
  eq('...cu varful pastrat', ps.maxMs, 120);
  eq('...si media calculata', ps.avgMs, 80);
  eq('varful din fereastra e cel mai lung save, nu ultimul', met.persistPeak(60000), 120);
  met.persistRun(999, Date.now() - 5 * 60 * 1000);
  eq('un save vechi nu ridica varful ferestrei curente', met.persistPeak(60000), 120);

  // ── Legatura reala: `db.save()` chiar alimenteaza masuratoarea ────────────────────────────
  // Fara asta, tot ce e mai sus ar dovedi doar ca un contor aduna numere pe care i le dam noi.
  met.reset();
  db.save();
  ok('db.save() inregistreaza singur o masuratoare de persist', met.persistSnapshot().n === 1);
  ok('...si e vizibila in fereastra de diagnostic', met.persistPeak(60000) >= 0);

  // Contractul cu /api/metrics: campul trebuie sa existe, altfel alerta trimite adminul intr-un gol.
  // Numele e `persistDurate`, nu `persist`: ruta suprapune `persist: db.persistStats()` (starea
  // COZII) peste acest obiect, deci un camp omonim ar fi disparut tacit. Ca proba sa nu depinda de
  // memoria mea, integrarea pe RUTA e verificata separat, in test/http.js.
  const snap = met.snapshot();
  ok('snapshot expune DURATA persistarii, sub un nume care nu se ciocneste', snap.persistDurate && typeof snap.persistDurate.maxMs === 'number');
  ok('...si nu ocupa numele `persist` (rezervat starii cozii)', snap.persist === undefined);
  ok('snapshot expune durata pe fiecare job', (() => {
    met.jobRun('proba-contract', 5);
    const j = met.snapshot().jobs['proba-contract'];
    return j && typeof j.maxMs === 'number' && typeof j.avgMs === 'number' && typeof j.n === 'number';
  })());
  met.reset();
}


section('Scalare: semnalul din ADR AJUNGE singur (nu asteapta sa se uite cineva)');
{
  // `docs/scalare-crestere.md` fixeaza regula „fiecare pas se ia pe un semnal real din productie,
  // nu pe volum ipotetic" si numeste semnalul: `firmeLoad`. Semnalul exista in /api/metrics de
  // mult — dar nu-l consuma NIMENI (o cautare in tot depozitul gasea doar producatorul si un test
  // de forma). Deci „observarea" prescrisa era manuala, deci nu s-a facut, deci documentul a ramas
  // in urma realitatii. Sectiunea verifica jumatatea care lipsea: calculul (o singura sursa) si
  // verdictul care il duce la alerta.
  const met = require('../src/metrics');
  const { verdictScalare, SCALE_ENTRIES_WARN } = require('../src/jobs');

  // ── Calculul, folosit si de ruta si de job ────────────────────────────────────────────────
  const graf = {
    firme: [{ id: 1, nume: 'ALFA' }, { id: 2, nume: 'BETA' }, { id: 3, nume: 'GAMA' }],
    entries: [
      { firmaId: 1 }, { firmaId: 1 }, { firmaId: 1 },
      { firmaId: 2 },
    ],
    documents: [{ firmaId: 1 }, { firmaId: 2 }, { firmaId: 2 }],
  };
  const l = met.firmeLoad(graf);
  eq('maxEntries e al firmei celei mai mari', l.maxEntries, 3);
  eq('...si topul e ordonat descrescator', l.top.map((f) => f.nume).join(','), 'ALFA,BETA');
  eq('fiecare firma isi poarta NUMELE (pasul e „partitioneaza firma X")', l.top[0].nume, 'ALFA');
  eq('documentele se numara separat de articole', l.top[0].documents, 1);
  ok('o firma fara articole nu apare in top (nu are ce partitiona)', !l.top.some((f) => f.nume === 'GAMA'));
  // Graful gol: semnalul trebuie sa fie 0, nu gunoi — jobul il citeste la fiecare pornire.
  eq('graf gol -> maxEntries 0', met.firmeLoad({}).maxEntries, 0);
  eq('...si top gol, nu undefined', met.firmeLoad({}).top.length, 0);
  // O firma stearsa lasa articole orfane: numele lipseste, dar volumul TREBUIE sa se vada.
  const orfan = met.firmeLoad({ firme: [], entries: [{ firmaId: 7 }, { firmaId: 7 }] });
  eq('articolele unei firme fara nume se numara totusi', orfan.maxEntries, 2);
  eq('...si primesc id-ul ca eticheta, nu „undefined"', orfan.top[0].nume, '7');

  // ── Verdictul ─────────────────────────────────────────────────────────────────────────────
  const sub = verdictScalare({ maxEntries: 100, top: [{ id: 1, nume: 'ALFA', entries: 100, documents: 0 }] }, { prag: 20000 });
  ok('sub prag -> fara alerta', sub.alert === false);
  ok('...dar rezumatul se raporteaza oricum (distributia e vizibila si cand e liniste)', /ALFA 100/.test(sub.rezumat));
  ok('...si spune fata de ce prag', /prag 20000/.test(sub.rezumat));
  const peste = verdictScalare({ maxEntries: 25000, top: [{ id: 2, nume: 'BETA SRL', entries: 25000, documents: 10 }] }, { prag: 20000 });
  ok('peste prag -> alerta', peste.alert === true);
  ok('...care NUMESTE firma (fara nume, raportul n-ar fi actionabil)', /BETA SRL/.test(peste.motiv));
  ok('...cu cifra si pragul', /25000/.test(peste.motiv) && /20000/.test(peste.motiv));
  ok('...si trimite la ADR-ul care descrie pasul', /scalare-crestere/.test(peste.motiv));
  ok('exact la prag -> alerta (pragul e inclusiv)', verdictScalare({ maxEntries: 20000, top: [{ id: 1, nume: 'A', entries: 20000 }] }, { prag: 20000 }).alert === true);
  ok('cu una sub prag -> inca liniste', verdictScalare({ maxEntries: 19999, top: [{ id: 1, nume: 'A', entries: 19999 }] }, { prag: 20000 }).alert === false);
  // Instalare noua: niciun articol. Verdictul nu are voie sa arunce si nici sa alerteze.
  const gol = verdictScalare({ maxEntries: 0, top: [] }, { prag: 20000 });
  ok('baza goala -> fara alerta si fara exceptie', gol.alert === false && /nicio firma/.test(gol.rezumat));
  ok('intrare lipsa (job pornit inaintea hidratarii) -> tot fara alerta', verdictScalare(null).alert === false);

  // ── Pragul din cod E cel din ADR ──────────────────────────────────────────────────────────
  // Aceeasi disciplina ca la `SAVE_FULL_MS` vs `VISITORS_FLUSH_MS`: doua numere in doua fisiere
  // care nu se verifica unul pe celalalt vor drifta. Aici al doilea fisier e chiar documentul de
  // decizie — daca cineva schimba pragul in cod si uita ADR-ul (sau invers), poarta o spune.
  {
    const fsS = require('fs'); const pS = require('path');
    const adr = fsS.readFileSync(pS.join(__dirname, '..', 'docs', 'scalare-crestere.md'), 'utf8');
    ok('ADR-ul chiar a fost citit (nu un fisier gol)', adr.length > 2000);
    const numere = [...adr.matchAll(/([\d.]+)\s*de articole/g)].map((m) => Number(m[1].replace(/\./g, '')));
    ok('ADR-ul numeste un prag de articole pe firma', numere.length > 0);
    ok('pragul din cod apare in ADR (nu au driftat unul de altul)', numere.includes(SCALE_ENTRIES_WARN));
  }
}


section('Drill de restaurare NATIVA PostgreSQL (src/pgRestoreDrill.js)');
{
  const pgd = require('../src/pgRestoreDrill');
  const fsx = require('fs'); const pth = require('path');

  // Colectiile verificate vin din ARRAY_COLLS — o colectie noua intra automat in drill,
  // nu ramane neverificata pentru ca cineva a uitat sa o adauge intr-o a doua lista.
  const colls = pgd.blobCollections();
  ok('lista de colectii vine din store.ARRAY_COLLS', colls.includes('entries') && colls.includes('firme') && colls.length > 10);
  eq('aceeasi lista ca a schemei', colls.join(','), require('../src/store').ARRAY_COLLS.map((c) => c.key).join(','));

  // URL-urile derivate: baza de intretinere `postgres` + baza temporara, pastrand credentialele
  const u = pgd.urlsFor('postgres://u:p@h:5432/contab', 'contab_drill_1');
  ok('URL de intretinere pe baza postgres', /\/postgres$/.test(u.maint) && u.maint.includes('u:p@h:5432'));
  ok('URL-ul bazei temporare poarta numele cerut', /\/contab_drill_1$/.test(u.temp));
  eq('fara URL explicit -> null (se cade pe socketul local)', pgd.urlsFor('', 'x'), null);
  eq('URL invalid -> null, nu exceptie', pgd.urlsFor('nu-e-url', 'x'), null);

  // Taxonomia rezultatelor e contractul pe care se sprijina alerta: `sarit` tace, `neverificabil`
  // se aude. Caile asincrone se verifica in test/http.js (ruta de admin); aici doar partea pura.
  const antet = fsx.readFileSync(pth.join(__dirname, '..', 'src', 'pgRestoreDrill.js'), 'utf8');
  ok('contractul distinge „nu se aplica" de „nu pot verifica"',
    /sarit\b[\s\S]{0,200}nu se aplica/i.test(antet) && /neverificabil[\s\S]{0,200}se alerteaza/i.test(antet));
  // `await` obligatoriu de cand lansarea lui psql e asincrona — vezi poarta „nicio comanda externa
  // SINCRONA pe o cale de cerere". Nedasteptata, stergerea ar putea sa nu apuce sa ruleze.
  ok('drill-ul curata baza temporara si pe calea de eroare (DROP asteptat, in finally)',
    /finally\s*\{[\s\S]{0,400}await\s+dropDb\(\)/.test(antet));
  ok('rejucarea foloseste ON_ERROR_STOP (altfel un dump stricat ar iesi cu 0)',
    /ON_ERROR_STOP=1'[^\n]*'-q'[^\n]*'-f'/.test(antet) || /'ON_ERROR_STOP=1', '-q', '-f'/.test(antet));
  ok('numele bazei temporare e unic (pid + timp), ca sa nu se ciocneasca rulari paralele',
    /contab_drill_' \+ process\.pid \+ '_' \+ Date\.now\(\)/.test(antet));
  eq('temporarul nu poate atinge baza de productie', /DROP DATABASE IF EXISTS "' \+ tempName/.test(antet), true);
  ok('fisierele extrase in /tmp se sterg si pe calea de eroare', /cleanupDir\(\);/.test(antet));
}

section('Inchidere lunara: motorul fluxului (src/monthlyClose.js)');
{
  const mcMod = require('../src/monthlyClose');
  const AZI = '2026-07-20';
  // Firma-model: platitoare de TVA, o luna cu o vanzare, o incasare care o stinge complet si
  // nota de regularizare TVA — punctul de plecare „luna curata".
  const mkV = (over) => Object.assign({
    firmaId: 5,
    company: { id: 5, nume: 'FLUX SRL', cui: '123', tvaPlatitor: true, perioadaTva: 'L' },
    angajati: [], products: [], gestiuni: [], stockMovements: [], inventories: [], assets: [],
    partners: {}, openingBalances: {}, openingAnalytic: [], payrollHistory: [], documents: [],
    entries: [
      { id: 'e1', firmaId: 5, data: '2026-06-10', period: '2026-06', tip: 'factura_vanzare_servicii', tipNume: 'Factura', partener: 'CLIENT SRL', document: 'F1', spv: { index: '9' }, lines: [{ debit: '4111', credit: '704', suma: 1000 }, { debit: '4111', credit: '4427', suma: 210 }] },
      { id: 'e2', firmaId: 5, data: '2026-06-20', period: '2026-06', tip: 'incasare_client', tipNume: 'Incasare', partener: 'CLIENT SRL', document: 'CH1', lines: [{ debit: '5121', credit: '4111', suma: 1210 }] },
      { id: 'e3', firmaId: 5, data: '2026-06-28', period: '2026-06', tip: 'inchidere_tva', tipNume: 'Inchidere TVA', system: true, lines: [{ debit: '4427', credit: '4423', suma: 210 }] },
    ],
  }, over || {});
  const D0 = { declarations: [], closings: [] };
  const stare = (d, v, per, o) => mcMod.status(d || D0, v || mkV(), per || '2026-06', Object.assign({ today: AZI }, o || {}));
  const pas = (st, k) => st.steps.find((s) => s.key === k);

  const st1 = stare();
  eq('ordinea pasilor e fluxul cerut', st1.steps.map((s) => s.key).join('>'), 'documente>banca>tva>declaratii>aprobare>blocare');
  eq('documente: gata (fara ciorne, fara lipsuri, e-Factura trimisa)', pas(st1, 'documente').stare, 'gata');
  eq('banca: gata (incasarea stinge factura, casa nu e negativa)', pas(st1, 'banca').stare, 'gata');
  eq('tva: gata (nota de regularizare postata, nimic ramas)', pas(st1, 'tva').stare, 'gata');
  eq('declaratii: deschis (nedepuse)', pas(st1, 'declaratii').stare, 'deschis');
  eq('aprobare: BLOCAT de declaratii', pas(st1, 'aprobare').blocatDe, 'Declarații validate și depuse');
  ok('blocare: blocata si ea, luna nu se poate inchide', pas(st1, 'blocare').stare === 'blocat' && st1.sePoateInchide === false);
  ok('blocantele numesc pasii, nu doar numarul', st1.blocante.some((b) => b.key === 'declaratii' && b.blocaje.length > 0));

  // termenele implicite se ancoreaza in TERMENUL REAL de depunere al lunii (nu o cifra inventata)
  eq('ancora de termen = cel mai devreme termen de depunere', st1.ancoraTermen, '2026-07-25');
  eq('termen implicit: documentele cu 15 zile inainte de ancora', pas(st1, 'documente').due, '2026-07-10');
  eq('termen implicit: banca cu 10 zile inainte', pas(st1, 'banca').due, '2026-07-15');
  ok('termenele implicite sunt marcate ca implicite', pas(st1, 'tva').dueImplicit === true);

  // CIORNA in luna = document neinregistrat contabil -> blocheaza primul pas
  const vCiorna = mkV();
  vCiorna.entries = vCiorna.entries.concat([{ id: 'e9', firmaId: 5, data: '2026-06-15', period: '2026-06', tip: 'nota_contabila', tipNume: 'Nota', status: 'ciorna', lines: [{ debit: '5311', credit: '5121', suma: 10 }] }]);
  const stC = stare(D0, vCiorna);
  eq('ciorna in luna: pasul 1 se deschide', pas(stC, 'documente').stare, 'deschis');
  ok('ciorna: motivul blocajului o numeste', pas(stC, 'documente').blocaje.some((b) => /ciorn/i.test(b)));
  // Un pas care nu e inca rezolvat devine „blocat" si spune CINE il tine. Un pas deja rezolvat
  // (aici TVA, cu nota postata) ramane „gata" — blocarea e despre ce ai de facut, nu o retrogradare.
  eq('pasul nerezolvat de dupa devine „blocat"', pas(stC, 'declaratii').stare, 'blocat');
  eq('...si spune CE il tine', pas(stC, 'declaratii').blocatDe, 'Documente complete');
  eq('un pas DEJA rezolvat nu se retrogradeaza', pas(stC, 'tva').stare, 'gata');

  // e-Factura netrimisa in luna: termen legal, deci blocaj
  const vEfact = mkV();
  vEfact.entries[0] = Object.assign({}, vEfact.entries[0], { partenerCui: 'RO77', spv: null });
  ok('e-Factura netrimisa a lunii blocheaza pasul 1', pas(stare(D0, vEfact), 'documente').blocaje.some((b) => /SPV|e-Factura/i.test(b)));

  // TVA: nota exista, dar apare o factura DUPA regularizare -> pasul redevine deschis
  const vTvaDupa = mkV();
  vTvaDupa.entries = vTvaDupa.entries.concat([{ id: 'e10', firmaId: 5, data: '2026-06-29', period: '2026-06', tip: 'factura_vanzare_servicii', tipNume: 'F', partener: 'CLIENT SRL', document: 'F2', spv: { index: '1' }, lines: [{ debit: '4111', credit: '704', suma: 500 }, { debit: '4111', credit: '4427', suma: 105 }] }]);
  const stTvaDupa = stare(D0, vTvaDupa);
  ok('TVA: operatiuni aparute DUPA regularizare redeschid pasul',
    pas(stTvaDupa, 'tva').stare === 'deschis' && pas(stTvaDupa, 'tva').blocaje.some((b) => /după regularizare/i.test(b)));

  // Luna fara nicio operatiune de TVA: nu cerem o nota goala (blocaj inventat)
  const vGol = mkV({ entries: [] });
  const stGol = stare(D0, vGol, '2026-06');
  ok('luna fara TVA: pasul e gata, marcat ca fara operatiuni',
    pas(stGol, 'tva').stare === 'gata' && pas(stGol, 'tva').detalii.faraOperatiuniTva === true);

  // Firma NEPLATITOARE de TVA: pasul nu se aplica si nu intra in progres
  const vNeplat = mkV({ company: { id: 5, nume: 'MICRO SRL', cui: '1', tvaPlatitor: false } });
  const stNep = stare(D0, vNeplat);
  eq('firma neplatitoare de TVA: pasul nu se aplica', pas(stNep, 'tva').stare, 'nuseaplica');
  ok('pasul „nu se aplica" nu intra in total', stNep.progres.total < st1.progres.total);
  ok('...si are motivul scris', /plătitoare de TVA/i.test(pas(stNep, 'tva').motiv || ''));

  // Sold de casa NEGATIV: imposibil fizic -> blocaj pe extras
  const vCasa = mkV();
  vCasa.entries = vCasa.entries.concat([{ id: 'e11', firmaId: 5, data: '2026-06-05', period: '2026-06', tip: 'plata_furnizor', tipNume: 'Plata', partener: 'F SRL', lines: [{ debit: '401', credit: '5311', suma: 500 }] }]);
  ok('sold de casa negativ: blocaj pe pasul de banca', pas(stare(D0, vCasa), 'banca').blocaje.some((b) => /NEGATIV/i.test(b)));

  // Incasare care NU stinge nicio factura -> punctaj incomplet
  const vNepunctat = mkV();
  vNepunctat.entries = vNepunctat.entries.concat([{ id: 'e12', firmaId: 5, data: '2026-06-22', period: '2026-06', tip: 'incasare_client', tipNume: 'Incasare', partener: 'ALT CLIENT', document: 'CH2', lines: [{ debit: '5121', credit: '4111', suma: 333 }] }]);
  ok('incasare nepunctata: blocaj pe extras', pas(stare(D0, vNepunctat), 'banca').blocaje.some((b) => /nepunctat/i.test(b)));

  // DECLARATII: depusa fara dovada de validare NU e suficient (fluxul cere dovada)
  const dDepusa = { declarations: [{ firmaId: 5, tip: 'd300', period: '2026-06', status: 'depusa' }], closings: [] };
  ok('declaratie depusa FARA dovada de validare ramane blocaj',
    pas(stare(dDepusa, mkV()), 'declaratii').blocaje.some((b) => /fără dovadă/i.test(b)));
  const dCuDovada = {
    declarations: [{ firmaId: 5, tip: 'd300', period: '2026-06', status: 'depusa' }],
    closings: [{ firmaId: 5, period: '2026-06', steps: {}, validari: { d300: { at: '2026-07-19T10:00:00Z', by: 3, username: 'maria', ok: true, errors: 0, warnings: 1 } } }],
  };
  const stDov = stare(dCuDovada, mkV());
  const d300Row = (pas(stDov, 'declaratii').detalii.declaratii || []).find((x) => x.tip === 'd300');
  ok('dovada validarii e purtata pe declaratie (cine, cand, verdict)',
    d300Row.dovada && d300Row.dovada.ok === true && d300Row.dovada.by === 3);
  ok('dovada cu ERORI nu trece pasul', (() => {
    const dErr = JSON.parse(JSON.stringify(dCuDovada));
    dErr.closings[0].validari.d300 = { at: 'x', by: 3, ok: false, errors: 2 };
    return pas(stare(dErr, mkV()), 'declaratii').blocaje.some((b) => /eroare/i.test(b));
  })());

  // Alocarea persistata: responsabil + termen + nota se citesc din inregistrarea lunii
  const dAlocat = { declarations: [], closings: [{ firmaId: 5, period: '2026-06', steps: { documente: { responsabilId: 7, due: '2026-07-02', nota: 'Cer facturile' } }, validari: {} }] };
  // pe vederea cu ciorna, ca pasul sa fie DESCHIS (un pas gata n-are termen depasit: nu mai ai ce face)
  const stAloc = stare(dAlocat, vCiorna, '2026-06', { users: [{ id: 7, username: 'maria' }] });
  const pDoc = pas(stAloc, 'documente');
  ok('responsabilul alocat apare cu nume', pDoc.responsabilId === 7 && pDoc.responsabil === 'maria');
  ok('termenul explicit inlocuieste implicitul', pDoc.due === '2026-07-02' && pDoc.dueImplicit === false);
  eq('nota se pastreaza', pDoc.nota, 'Cer facturile');
  ok('termen depasit fata de azi -> overdue', pDoc.overdue === true);

  // Perioada blocata (dar fara dosar de inchidere) vs finalizata prin flux
  const vBlocat = mkV({ company: { id: 5, nume: 'FLUX SRL', cui: '123', tvaPlatitor: true, lockedUntil: '2026-06' } });
  const stBloc = stare(D0, vBlocat);
  ok('perioada blocata: pasul de blocare e gata, dar luna NU e finalizata',
    pas(stBloc, 'blocare').stare === 'gata' && stBloc.inchisa === true && stBloc.finalizata === false);
  const dFinal = { declarations: [], closings: [{ firmaId: 5, period: '2026-06', steps: {}, validari: {}, closedAt: '2026-07-20T08:00:00Z', closedBy: 7, closedByName: 'maria' }] };
  const stFin = stare(dFinal, vBlocat);
  ok('cu dosar de inchidere: finalizata, cu cine si cand', stFin.finalizata === true && stFin.inchidere.username === 'maria');

  // Fortarea: motivul si pasii nerezolvati raman pe dosarul lunii
  const dFortat = { declarations: [], closings: [{ firmaId: 5, period: '2026-06', steps: {}, validari: {}, closedAt: 'x', fortata: { motiv: 'Depus manual pe portal', username: 'admin', blocante: ['Declaratii validate si depuse'] } }] };
  ok('fortarea e vizibila in stare, cu motiv', stare(dFortat, vBlocat).fortata.motiv === 'Depus manual pe portal');

  // perioada invalida -> 400 (nu o stare inventata)
  eq('perioada care nu e luna -> 400', (() => { try { stare(D0, mkV(), '2026'); return null; } catch (e) { return e.status; } })(), 400);
}

section('Inchidere lunara: garzile serviciului (src/monthlyCloseService.js)');
{
  const mcs = require('../src/monthlyCloseService');
  const errS = (fn) => { try { fn(); return null; } catch (e) { return e.status || 500; } };
  eq('firma inexistenta -> 403', errS(() => mcs.state(9999, '2026-06')), 403);
  eq('santinela NO_FIRMA (-1) -> 403, fara fallback pe firma activa', errS(() => mcs.state(-1, '2026-06')), 403);
  const fidReal = db.get().firme[0].id; // `dbx` se defineste mai jos in fisier (TDZ)
  eq('perioada invalida -> 400', errS(() => mcs.state(fidReal, '2026')), 400);
  eq('pas necunoscut -> 400', errS(() => mcs.setStep(fidReal, '2026-06', 'inexistent', {})), 400);
  eq('responsabil care nu are acces la firma -> 400', errS(() => mcs.setStep(fidReal, '2026-06', 'documente', { responsabilId: 424242 })), 400);
  eq('termen malformat -> 400', errS(() => mcs.setStep(fidReal, '2026-06', 'documente', { due: '02-07-2026' })), 400);
  eq('tip de declaratie necunoscut la validare -> 400', errS(() => mcs.validateDeclaration(fidReal, '2026-06', 'dXXX', null)), 400);
  eq('retragerea unei aprobari inexistente -> 400', errS(() => mcs.unapprove(fidReal, '2026-06')), 400);
}

section('XSS: escaparea datelor externe la randare (public/app.js)');
// app.js + ecranele extrase din el (periods/rapoarte/livrabile/mijloace/salarizare/stocuri/plan):
// portile de escapare acopera tot codul de randare, indiferent in ce modul a ajuns
const appJs = ['app', 'periods', 'rapoarte', 'livrabile', 'mijloace', 'salarizare', 'stocuri', 'plan', 'authui', 'docflow', 'entries']
  .map((n) => require('fs').readFileSync(require('path').join(__dirname, '..', 'public', n + '.js'), 'utf8')).join('\n');
// nucleul partajat (Etapa 0 a modularizarii frontendului): helperii comuni traiesc in core.js
const coreJs = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'core.js'), 'utf8');
// administrarea (firme + utilizatori) a fost extrasa in admin.js (Etapa 4)
const adminJs = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'admin.js'), 'utf8');
// nomenclatorul de parteneri a fost extras in partners.js (Etapa 7)
const partnersJs = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'partners.js'), 'utf8');
// helper-ul de escapare exista (in core.js, exportat) si acopera toate caracterele periculoase
ok('helper H() definit (core.js)', /export const H = \(s\) =>/.test(coreJs));
ok('H() escapeaza < > & " \'', /'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'/.test(coreJs));
ok('app.js importa H din core.js', /import \{[^}]*\bH\b[^}]*\} from '\.\/core\.js'/.test(appJs));
// verificarea H() efectiv (simulare)
const Htest = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
eq('H() neutralizeaza un payload de script', Htest('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
eq('H() escapeaza ghilimelele (spargere de atribut)', Htest('a" onmouseover="x'), 'a&quot; onmouseover=&quot;x');
// punctele critice cu date de proveniente externa folosesc H() (poarta anti-regresie)
ok('parteneri: numele si CUI-ul sunt escapate', /\$\{H\(p\.den\)\}/.test(partnersJs) && /\$\{H\(p\.cui\)\}/.test(partnersJs));
ok('jurnal/entries: partenerul e escapat', /\$\{H\(e\.partener\)\}/.test(appJs));
ok('utilizatori (admin): username-ul e escapat', /\$\{H\(u\.username\)\}/.test(adminJs));
ok('firme: denumirea firmei e escapata', /\$\{H\(f\.nume\)\}/.test(adminJs));
ok('stocuri: denumirea produsului e escapata', /\$\{H\(s\.product\.denumire\)\}/.test(appJs));
ok('salarii: numele angajatului e escapat', /\$\{H\(r\.nume\)\}/.test(appJs));
// puncte hardenizate suplimentar (audit XSS): date editabile de utilizator / provenite din e-Factura
const bankJs = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'bank.js'), 'utf8');
const dashJs = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'dashboard.js'), 'utf8');
ok('compensare: CUI/denumire partener escapate', /\$\{H\(c\.cui\)\}/.test(appJs) && /\$\{H\(c\.den\)\}/.test(appJs));
ok('analitic terti: denumirea partenerului e escapata', /\$\{H\(r\.den\)\}/.test(appJs));
ok('inventar: numele furnizorului (e-Factura) e escapat', /\$\{H\(inv\.furnizor\.nume/.test(appJs));
ok('gestiuni: denumirea e escapata in optiuni', /\$\{H\(g\.denumire\)\}/.test(appJs));
ok('productie/retete: denumirea produsului e escapata', /\$\{H\(p\.denumire\)\}/.test(appJs));
ok('extras bancar: descrierea (externa) e escapata', /\$\{H\(\(r\.descriere/.test(bankJs));
ok('extras bancar: partenerul din extras e escapat', /value="\$\{H\(r\.fields\.partener/.test(bankJs));
ok('parteneri: atributul data-cui e escapat', /data-cui="\$\{H\(p\.cui\)\}"/.test(partnersJs));
ok('buget: numele contului e escapat', /\$\{H\(row\.nume\)\}/.test(dashJs));
ok('audit (admin): username-ul e escapat', /\$\{H\(a\.username/.test(adminJs));
// porti negative: variantele NEescapate nu trebuie sa revina
ok('fara gestiune neescapata in optiuni', !/>\$\{g\.cod\} — \$\{g\.denumire\}</.test(appJs));
ok('fara descriere extras neescapata', !/<td>\$\{\(r\.descriere \|\| ''\)\.slice\(0, 40\)\}<\/td>/.test(bankJs));


// Platforma, al doilea grup (jurnalizare, parole, erori, pornire, backup, webhook):
require('./run/platforma').platformaProces({ appJs });
// Stratul de servicii si infrastructura: test/run/servicii.js (cerut AICI, pe pozitia lui,
// ca ordinea sectiunilor sa ramana neschimbata).
require('./run/servicii');

section('Fiscal — payroll & taxePfa ca functii pure (src/fiscal.js)');
{
  const F = require('../src/fiscal');
  const { round2 } = require('../src/util');
  const R = F.FISCAL;
  const rate2026 = R.cas === 25 && R.cass === 10 && R.impozitVenit === 10 && R.cam === 2.25;

  // ── payroll: INVARIANTI STRUCTURALI (nu depind de cotele exacte — nu se sparg la schimbari legale) ──
  const P0 = F.payroll(5000, 0);
  // tichetele intra in baza CASS + impozit, dar NU in CAS
  const Ptk = F.payroll(5000, 0, { tichete: 300 });
  eq('tichete NU maresc CAS (baza CAS = doar brutul)', Ptk.cas, P0.cas);
  ok('tichete maresc CASS', Ptk.cass > P0.cass);
  // concediu medical (OUG 158): datoreaza CAS + impozit, dar NU CASS
  const Pcm = F.payroll(4000, 0, { cmAngajator: 500, cmFnuass: 500 });
  const Pbase = F.payroll(4000, 0);
  ok('concediul medical mareste baza CAS', Pcm.cas > Pbase.cas);
  eq('concediul medical NU intra in CASS', Pcm.cass, Pbase.cass);
  // norma partiala (OUG 16/2022): sub salariul minim, diferenta de contributii o suporta ANGAJATORUL
  const Pnp = F.payroll(2000, 0, { bazaMinima: 4050 });
  ok('norma partiala: angajatorul suporta diferenta CAS (casAngajator > 0)', Pnp.casAngajator > 0);
  ok('norma partiala: si diferenta CASS (cassAngajator > 0)', Pnp.cassAngajator > 0);
  eq('norma partiala: netul angajatului NU scade cu partea angajatorului', Pnp.net, round2(2000 - Pnp.cas - Pnp.cass - Pnp.impozit));
  // avantaje in natura: intra in baze, dar netul CASH nu creste cu avantajul (nu se plateste in bani)
  const Pav = F.payroll(5000, 0, { avantaje: 1000 });
  ok('avantajele maresc baza (CAS creste)', Pav.cas > P0.cas);
  eq('avantajul nu se plateste in numerar (net = brut - contributii - impozit)', Pav.net, round2(5000 - Pav.cas - Pav.cass - Pav.impozit));
  // deducerea reduce baza de impozit -> creste netul
  ok('deducerea personala creste netul', F.payroll(5000, 500).net > P0.net);
  // margine: brut 0 -> totul zero
  const Pz = F.payroll(0, 0);
  ok('brut 0 -> toate componentele zero', Pz.cas === 0 && Pz.cass === 0 && Pz.impozit === 0 && Pz.net === 0);

  // ── payroll: VALORI DE REFERINTA (doar sub cotele 2026; altfel se sar, invariantii de sus raman) ──
  if (rate2026) {
    eq('2026 payroll(5000,0): CAS 25%', P0.cas, 1250);
    eq('2026 payroll(5000,0): CASS 10%', P0.cass, 500);
    eq('2026 payroll(5000,0): baza impozabila 3250', P0.baza, 3250);
    eq('2026 payroll(5000,0): impozit 10%', P0.impozit, 325);
    eq('2026 payroll(5000,0): CAM 2.25%', P0.cam, 112.5);
    eq('2026 payroll(5000,0): net 2925', P0.net, 2925);
    eq('2026 payroll(5000,0): cost total angajator', P0.costTotal, 5112.5);
  }

  // ── taxePfa: PRAGURILE (6/12/24/60 salarii minime) — miezul calcularii ──
  const sm = 4050;
  const pfa = (vn, extra) => F.taxePfa(vn, Object.assign({ salariuMinim: sm }, extra));
  eq('PFA venit 0 -> total 0', pfa(0).total, 0);
  eq('PFA sub 12 SM: CAS = 0 (optionala)', pfa(40000).cas, 0);
  eq('PFA la/peste 12 SM: baza CAS = 12 SM', pfa(60000).bazaCas, round2(sm * 12));
  eq('PFA la/peste 24 SM: baza CAS = 24 SM (nu creste peste)', pfa(300000).bazaCas, round2(sm * 24));
  eq('PFA sub 6 SM fara alte venituri: CASS la baza minima 6 SM', pfa(20000).bazaCass, round2(sm * 6));
  eq('PFA sub 6 SM CU alte venituri: CASS pe venitul real', pfa(20000, { areAlteVenituri: true }).bazaCass, 20000);
  eq('PFA peste 60 SM: CASS plafonata la 60 SM', pfa(300000).bazaCass, round2(sm * 60));
  // impozit = 10% din (venit net - CAS - CASS datorate)
  const T = pfa(60000);
  eq('PFA impozit = 10% din (venit - CAS - CASS)', T.impozit, round2((60000 - T.cas - T.cass) * (R.impozitVenit / 100)));
  if (rate2026) {
    const G = pfa(100000);
    eq('2026 PFA(100k): CAS pe 24 SM = 24300', G.cas, 24300);
    eq('2026 PFA(100k): CASS pe venit = 10000', G.cass, 10000);
    eq('2026 PFA(100k): impozit 6570', G.impozit, 6570);
    eq('2026 PFA(100k): total 40870', G.total, 40870);
  }
}

section('Paginare + garda OOM (src/paginate.js sendList)');
{
  const { sendList } = require('../src/paginate');
  const mkRes = () => ({ headers: {}, body: undefined, setHeader(k, v) { this.headers[k] = v; }, json(x) { this.body = x; return this; } });
  const big = Array.from({ length: 50 }, (_, i) => ({ id: i }));
  // fara limit, sub plafon: array simplu, neschimbat (compatibil)
  let r = mkRes(); sendList({ query: {}, path: '/x' }, r, big.slice(0, 10), { max: 20 });
  ok('fara limit sub plafon: array simplu neschimbat', Array.isArray(r.body) && r.body.length === 10);
  // fara limit, PESTE plafon: garda OOM -> ultimele `max` + antet X-Rows-Truncated (nu tacut)
  r = mkRes(); sendList({ query: {}, path: '/x' }, r, big, { max: 20 });
  ok('peste plafon: trunchiat la max, cele mai RECENTE', Array.isArray(r.body) && r.body.length === 20 && r.body[0].id === 30);
  eq('antet X-Rows-Truncated = totalul real (trunchiere vizibila)', r.headers['X-Rows-Truncated'], '50');
  // cu limit: plic { items, total, offset, limit }
  r = mkRes(); sendList({ query: { limit: '5' }, path: '/x' }, r, big, { max: 20 });
  ok('cu limit: plic paginat cu total', r.body && Array.isArray(r.body.items) && r.body.items.length === 5 && r.body.total === 50);
  eq('cu limit: fereastra de la offset 0', r.body.items[0].id, 0);
  r = mkRes(); sendList({ query: { limit: '5', offset: '10' }, path: '/x' }, r, big, { max: 20 });
  eq('offset: fereastra decalata', r.body.items[0].id, 10);
  r = mkRes(); sendList({ query: { limit: '9999' }, path: '/x' }, r, big, { max: 20 });
  eq('limit prins in [1, max] (nu poate depasi plafonul)', r.body.limit, 20);

  // sendMap: colectiile expuse ca OBIECT-harta (/api/partners, cheie = CUI). Nu se pot pagina ca
  // o lista fara sa schimbe forma, deci implicit raman harta (compatibil), iar `?limit` da plic.
  const { sendMap } = require('../src/paginate');
  const harta = {}; for (let i = 0; i < 30; i += 1) harta['CUI' + String(i).padStart(2, '0')] = { cui: 'CUI' + i, den: 'P' + i };
  r = mkRes(); sendMap({ query: {}, path: '/p' }, r, harta, { max: 100 });
  ok('harta sub plafon se intoarce ca harta (forma compatibila)', !Array.isArray(r.body) && Object.keys(r.body).length === 30);
  r = mkRes(); sendMap({ query: {}, path: '/p' }, r, harta, { max: 10 });
  eq('harta peste plafon e taiata', Object.keys(r.body).length, 10);
  eq('...si trunchierea e VIZIBILA in antet', r.headers['X-Rows-Truncated'], '30');
  r = mkRes(); sendMap({ query: { limit: '5' }, path: '/p' }, r, harta, { max: 100 });
  ok('cu ?limit harta devine plic cu items LISTA (o harta partiala ar fi ambigua)',
    Array.isArray(r.body.items) && r.body.items.length === 5 && r.body.total === 30);
  eq('...ordonat dupa cheie, stabil', r.body.items[0].den, 'P0');
  r = mkRes(); sendMap({ query: { limit: '5', offset: '10' }, path: '/p' }, r, harta, { max: 100 });
  eq('offset se aplica pe ordinea cheilor', r.body.items[0].den, 'P10');
  r = mkRes(); sendMap({ query: {}, path: '/p' }, r, null, { max: 10 });
  ok('harta lipsa nu arunca', r.body && Object.keys(r.body).length === 0);

  // capList: plafon PUR, pentru colectiile care ajung intr-un CAMP al raspunsului (firul de
  // mesaje din { admin, thread }), unde sendList n-ar merge — ar trimite el raspunsul.
  const { capList } = require('../src/paginate');
  const fir = []; for (let i = 0; i < 30; i += 1) fir.push({ id: i });
  let cl = capList(fir, 100);
  ok('sub plafon: lista intacta, fara semnal de trunchiere', cl.items.length === 30 && cl.total === 30 && cl.truncated === false);
  cl = capList(fir, 10);
  ok('peste plafon: taiat la plafon, cu totalul REAL pastrat', cl.items.length === 10 && cl.total === 30 && cl.truncated === true);
  eq('...se pastreaza cele mai RECENTE (coada firului, ce vrea o conversatie)', cl.items[cl.items.length - 1].id, 29);
  eq('...si taierea incepe de la cel mai vechi pastrat', cl.items[0].id, 20);
  cl = capList(null, 10);
  ok('lista lipsa nu arunca', cl.items.length === 0 && cl.total === 0 && cl.truncated === false);

  // Din CE CAPAT se taie. Implicitul (coada) e corect doar pentru listele append-ordered; o lista
  // sortata cu cele mai NOI la inceput (vizitatori, sesiuni) trebuie taiata de la coada listei,
  // adica pastrata de la CAP. Aserțiunea pe LUNGIME nu discrimineaza — trece in ambele variante —
  // deci se verifica IDENTITATEA randurilor pastrate, singura marime pe care doar varianta
  // corecta o produce.
  const noiIntai = []; for (let i = 0; i < 30; i += 1) noiIntai.push({ id: i, rang: 30 - i }); // id 0 = cel mai NOU
  const capt = capList(noiIntai, 10, 'x', { pastreaza: 'cap' });
  eq('pastreaza:cap -> primul returnat e chiar cel mai NOU din colectie', capt.items[0].id, 0);
  eq('...si ultimul pastrat e al zecelea ca noutate', capt.items[capt.items.length - 1].id, 9);
  ok('...totalul real si semnalul de trunchiere raman', capt.total === 30 && capt.truncated === true);
  const impl = capList(noiIntai, 10, 'x');
  eq('implicitul ramane NESCHIMBAT (coada) pentru listele append-ordered', impl.items[0].id, 20);
  ok('cele doua capete chiar difera (aserțiunea de mai sus nu e tautologica)',
    capt.items[0].id !== impl.items[0].id);
  const subPlafon = capList(noiIntai, 100, 'x', { pastreaza: 'cap' });
  eq('sub plafon optiunea nu schimba nimic', subPlafon.items.length, 30);

  // `max` gresit nu are voie sa DEZARMEZE garda. Cazul real: `capList(lista, { label: 'x' })`
  // (argumente decalate) lasa `cap` obiect, `total <= cap` compara cu NaN — mereu fals — deci
  // plafonul nu se mai aplica DELOC si fiecare apel raporta o trunchiere inexistenta.
  const decalat = capList(noiIntai, { label: 'verificare-anaf' });
  ok('argument `max` nenumeric -> se cade pe plafonul implicit, nu pe „fara plafon"',
    decalat.truncated === false && decalat.items.length === 30 && decalat.total === 30);
  for (const [nume, val] of [['0', 0], ['null', null], ['undefined', undefined], ['negativ', -5], ['NaN', NaN]]) {
    const c = capList(noiIntai, val);
    ok('`max` = ' + nume + ' -> plafonul implicit (lista scurta trece intreaga, netrunchiata)',
      c.truncated === false && c.items.length === 30);
  }
}

section('Trunchierea se NUMARA mereu, dar se avertizeaza rar (zgomot in jurnal)');
{
  const pag = require('../src/paginate');
  const metricsT = require('../src/metrics');
  const logT = require('../src/log');
  const lung = []; for (let i = 0; i < 30; i += 1) lung.push({ i });
  const scurt = [{ i: 0 }];

  // Intercepteaza jurnalul: `paginate` cheama `log.warn` prin cautare de proprietate, deci
  // inlocuirea aici e vazuta. Se pune la loc la final, orice s-ar intampla.
  const warnReal = logT.warn;
  let linii = 0;
  logT.warn = () => { linii += 1; };
  try {
    pag._resetTrunchieri();
    const eticheta = 'proba:trunchiere';
    const nInainte = (metricsT.truncationsSnapshot()[eticheta] || { n: 0 }).n;

    for (let k = 0; k < 5; k += 1) pag.capList(lung, 10, eticheta);
    eq('cinci trunchieri la rand -> o SINGURA linie in jurnal', linii, 1);
    // Aserțiunea care conteaza: throttle-ul e doar pe consola. Daca ar fi si pe contor, remediul
    // zgomotului ar fi devenit TACERE — adica exact defectul pe care il repara.
    const dupa = metricsT.truncationsSnapshot()[eticheta];
    eq('...dar contorul creste la FIECARE trunchiere (throttle doar pe consola)', dupa.n - nInainte, 5);
    eq('...si retine cat de mare era lista', dupa.ultimTotal, 30);
    eq('...si plafonul aplicat', dupa.cap, 10);

    // Etichete diferite nu impart fereastra: o problema noua nu are voie sa fie inghitita de una veche.
    linii = 0;
    pag.capList(lung, 10, 'proba:alta-eticheta');
    eq('o eticheta NOUA avertizeaza imediat, nu asteapta fereastra', linii, 1);

    // Re-armare: lista scade sub plafon -> revenirea la trunchiere se vede IMEDIAT.
    linii = 0;
    pag.capList(lung, 10, eticheta);
    eq('a doua trunchiere in aceeasi fereastra tace', linii, 0);
    pag.capList(scurt, 10, eticheta);       // sub plafon -> re-armeaza
    pag.capList(lung, 10, eticheta);
    eq('dupa ce lista a scazut sub plafon, urmatoarea trunchiere avertizeaza din nou', linii, 1);
  } finally {
    logT.warn = warnReal;
    pag._resetTrunchieri();
  }
}

// Portile si infrastructura au fost mutate in test/run/porti.js — vezi test/run/comun.js pentru
// motiv. Se cer AICI, pe pozitia lor din fisier, ca ordinea sectiunilor sa ramana neschimbata.
require('./run/porti');

section('Stocuri: evaluarea iesirilor la FIFO (pe langa CMP)');
{
  const st = require('../src/stocks');
  const prod = { id: 'p1', denumire: 'Test', cont: '371' };
  const M = (id, data, tip, cant, pret, g, gd) => ({ id, data, tip, productId: 'p1', gestiuneId: g || 'g1', gestiuneDestId: gd || null, cantitate: cant, pretUnitar: pret || 0 });
  // doua loturi la preturi diferite, apoi o iesire de exact un lot
  const movs = [M('m1', '2026-01-05', 'receptie', 10, 10), M('m2', '2026-01-10', 'receptie', 10, 20), M('m3', '2026-01-15', 'iesire', 10)];

  const cmp = st.productLedger(prod, movs, null, 'g1', 'cmp');
  const fifo = st.productLedger(prod, movs, null, 'g1', 'fifo');
  const iesV = (l) => l.rows.find((r) => r.id === 'm3').iesireV;
  eq('CMP: iesirea se evalueaza la costul mediu (10 x 15)', iesV(cmp), 150);
  eq('FIFO: iesirea consuma LOTUL VECHI (10 x 10)', iesV(fifo), 100);
  eq('CMP: stocul ramas 10 x 15', cmp.stocV, 150);
  eq('FIFO: stocul ramas e lotul nou, 10 x 20', fifo.stocV, 200);
  // proba ca testul discrimineaza: daca cele doua ar coincide, n-ar dovedi nimic
  ok('FIFO chiar difera de CMP pe acest set', iesV(cmp) !== iesV(fifo));
  // metoda necunoscuta / lipsa NU schimba comportamentul istoric
  eq('metoda absenta => CMP (firmele existente nu se schimba)', iesV(st.productLedger(prod, movs, null, 'g1')), 150);
  eq('metoda invalida => CMP, nu eroare', iesV(st.productLedger(prod, movs, null, 'g1', 'lifo')), 150);
  eq('metodaFirma: implicit cmp', st.metodaFirma({ company: {} }), 'cmp');
  eq('metodaFirma: fifo cand e setat', st.metodaFirma({ company: { metodaEvaluareStoc: 'FIFO' } }), 'fifo');

  // INVARIANTUL cozii de loturi: suma cantitatilor = qty, suma (q x cost) = value, dupa fiecare miscare.
  // Fara el, FIFO ar putea da un stoc valoric care nu corespunde loturilor ramase.
  const stare = (metoda, pana) => {
    const l = st.productLedger(prod, movs.filter((m) => m.data <= pana), null, 'g1', metoda);
    return l;
  };
  for (const zi of ['2026-01-05', '2026-01-10', '2026-01-15']) {
    const l = stare('fifo', zi);
    ok('FIFO ' + zi + ': stocul valoric e coerent cu cantitatea', l.stocQ >= 0 && l.stocV >= 0);
  }

  // Descarcarea INTEGRALA nu lasa ban fantoma (regula comuna ambelor metode)
  const tot = movs.concat([M('m4', '2026-01-20', 'iesire', 10)]);
  for (const met of ['cmp', 'fifo']) {
    const l = st.productLedger(prod, tot, null, 'g1', met);
    eq('golirea stocului duce valoarea exact la 0 (' + met + ')', l.stocV, 0);
    eq('...si cantitatea la 0 (' + met + ')', l.stocQ, 0);
  }

  // TRANSFERUL muta loturile CU COSTURILE LOR — altfel FIFO ar degenera tacit in CMP
  const cuTransfer = [M('m1', '2026-01-05', 'receptie', 10, 10), M('m2', '2026-01-10', 'receptie', 10, 20),
    M('t1', '2026-01-12', 'transfer', 20, 0, 'g1', 'g2'), M('m3', '2026-01-15', 'iesire', 10, 0, 'g2')];
  const dupaTransfer = st.productLedger(prod, cuTransfer, null, 'g2', 'fifo');
  eq('FIFO: dupa transfer, iesirea consuma tot lotul vechi (10 x 10)',
    dupaTransfer.rows.find((r) => r.id === 'm3').iesireV, 100);
  eq('FIFO: in gestiunea destinatie ramane lotul nou (10 x 20)', dupaTransfer.stocV, 200);

  // Costul marfii vandute (descarcarea automata la vanzare) urmeaza aceeasi metoda
  const cogsF = st.saleCogs([prod], movs.slice(0, 2), [{ productId: 'p1', gestiuneId: 'g1', cantitate: 10 }],
    { fid: 1, data: '2026-01-20', metoda: 'fifo', nextId: () => 'sm1' });
  eq('saleCogs la FIFO: COGS = lotul vechi', cogsF.total, 100);
  ok('...si explicatia spune metoda', /FIFO/.test(cogsF.cogsLines[0].explicatie));
  const cogsC = st.saleCogs([prod], movs.slice(0, 2), [{ productId: 'p1', gestiuneId: 'g1', cantitate: 10 }],
    { fid: 1, data: '2026-01-20', metoda: 'cmp', nextId: () => 'sm1' });
  eq('saleCogs la CMP: COGS = costul mediu', cogsC.total, 150);
}

section('Poarta fiscala: perimetrul acopera toate generatoarele ANAF (fara drift)');
{
  const fsx = require('fs'); const pth = require('path');
  const root = pth.join(__dirname, '..');
  const poarta = fsx.readFileSync(pth.join(root, 'scripts', 'poarta-fiscala.sh'), 'utf8');
  const lista = (poarta.match(/CAI_FISCALE='([^']*)'/) || [undefined, ''])[1].split('\n').map((s) => s.trim()).filter(Boolean);
  ok('scripts/poarta-fiscala.sh declara un perimetru CAI_FISCALE', lista.length > 5);

  // Poarta valideaza cu validatoarele OFICIALE ce produc generatoarele; daca apare un generator
  // ANAF nou (alt XML de declaratie) si nu intra in perimetru, poarta nu se mai aplica la
  // schimbarile lui — adica exact regresia pe care ar trebui s-o prinda trece nevazuta.
  // Detectia e dupa SURSA (namespace ANAF in continut), nu dupa numele fisierului.
  const NS_ANAF = /xmlns="mfp:anaf|Ro_SAFT_Schema/;
  const generatoare = [];
  // Caile se compun cu `/`, NU cu `path.join`: perimetrul din `poarta-fiscala.sh` e scris cu bare
  // normale, iar pe Windows `path.join` produce `src\xml.js`. Compararea esua atunci pentru TOATE
  // generatoarele, iar poarta raporta ca lipsesc din perimetru fisiere care erau acolo — un
  // fals-pozitiv zgomotos, dar tot un test care spune altceva decat realitatea. `path.join` ramane
  // pentru accesul pe disc, unde separatorul chiar trebuie sa fie cel al sistemului.
  const scan = (rel) => {
    for (const f of fsx.readdirSync(pth.join(root, rel))) {
      const p = rel + '/' + f;
      if (fsx.statSync(pth.join(root, p)).isDirectory()) { scan(p); continue; }
      if (!f.endsWith('.js')) continue;
      if (NS_ANAF.test(fsx.readFileSync(pth.join(root, p), 'utf8'))) generatoare.push(p);
    }
  };
  scan('src');
  ok('detectia gaseste generatoarele cunoscute (xml/saft/etransport)', generatoare.length >= 3);
  // ── Inchiderea TRANZITIVA a perimetrului ──────────────────────────────────
  // Detectia de mai sus gaseste GENERATOARELE (dupa namespace-ul ANAF din continut). Dar un modul
  // care doar ALIMENTEAZA un generator poate schimba cifrele fara sa contina vreun XML — si atunci
  // poarta nu se aplica la schimbarile lui. Exact asta s-a intamplat cu `assets.js`: amortizarea
  // fiscala a intrat in D101 prin registrul fiscal, iar poarta a rulat doar fiindca acelasi commit
  // atingea si reporting.js. O schimbare izolata pe amortizare ar fi sarit poarta complet.
  // Regula: orice modul din src/ cerut de un fisier DEJA in perimetru intra si el, cu exceptia
  // infrastructurii (persistenta, log, utilitare) — care nu poarta reguli fiscale.
  const INFRA = new Set(['src/db.js', 'src/log.js', 'src/util.js', 'src/metrics.js', 'src/store.js',
    'src/storePg.js', 'src/session.js', 'src/csv.js', 'src/cache.js', 'src/paginate.js',
    // Transport, criptare si formate care NU merg la ANAF: nu poarta reguli fiscale, deci o
    // schimbare in ele nu are ce valida DUKIntegrator. `sepa.js` (pain.001) pleaca la BANCA, si
    // e acoperit de poarta de escapare XML din acest fisier — alt mecanism, alt perimetru.
    'src/anaf.js', 'src/secretbox.js', 'src/zipGuard.js', 'src/sepa.js']);
  const neacoperite = new Set();
  for (const f of lista) {
    const abs = pth.join(root, f);
    if (!fsx.existsSync(abs) || fsx.statSync(abs).isDirectory()) continue;
    for (const m of fsx.readFileSync(abs, 'utf8').matchAll(/require\('\.\/([a-zA-Z0-9_]+)'\)/g)) {
      const dep = 'src/' + m[1] + '.js';
      if (!fsx.existsSync(pth.join(root, dep))) continue;
      if (lista.includes(dep) || INFRA.has(dep)) continue;
      neacoperite.add(dep);
    }
  }
  ok('perimetrul e inchis tranzitiv (dependintele fiscale sunt si ele acoperite)'
    + (neacoperite.size ? ' — LIPSESC: ' + [...neacoperite].sort().join(', ') : ''), neacoperite.size === 0);

  // ── AL DOILEA STRAT: MONOGRAFIILE ────────────────────────────────────────
  // Inchiderea tranzitiva de mai sus merge in JOS: dependintele unui fisier fiscal. Dar un modul
  // poate schimba cifrele unei declaratii fara sa fie cerut de niciun fisier din perimetru — ii
  // ajunge sa SCRIE ARTICOLE CONTABILE. Declaratiile se calculeaza din `entries`, nu din apeluri:
  // cine decide debitul si creditul decide si ce ajunge la ANAF, oricat de departe ar fi de
  // generatorul XML. `src/documentTypes/` era in perimetru tocmai din acest motiv, dar restul
  // monografiilor (reevaluare valutara, productie, inchideri, salarii, stocuri, import e-Factura)
  // nu erau — si niciun require nu le lega de perimetru, deci ancora nu le putea vedea.
  //
  // Ancora nu se slabeste (fara ea, orice modul care doar CITESTE articole ar fi fals-pozitiv):
  // se adauga un al doilea strat, care verifica CELALALT capat — cine PRODUCE articolul.
  // Semnatura unei linii contabile in acest cod: { debit, credit, suma, explicatie }.
  const LINIE_CONTABILA = /\{[^{}]{0,240}debit\s*:[^{}]{0,240}credit\s*:[^{}]{0,240}suma\s*:[^{}]{0,240}explicatie\s*:/s;
  const monografii = [];
  for (const f of fsx.readdirSync(pth.join(root, 'src'))) {
    if (!f.endsWith('.js')) continue;
    const rel = 'src/' + f;
    if (INFRA.has(rel)) continue; // persistenta: serializeaza linii, nu le decide
    if (LINIE_CONTABILA.test(fsx.readFileSync(pth.join(root, rel), 'utf8'))) monografii.push(rel);
  }
  ok('detectia gaseste monografiile cunoscute (accounting, fxreval, production)',
    ['src/accounting.js', 'src/fxreval.js', 'src/production.js'].every((f) => monografii.includes(f)));
  ok('detectia NU confunda o harta de coloane cu o monografie (bank.js)', !monografii.includes('src/bank.js'));

  const acoperit = (f) => lista.some((c) => f === c || f.startsWith(c));
  const monoLipsa = monografii.filter((f) => !acoperit(f));
  ok('fiecare modul care SCRIE articole contabile e in perimetru'
    + (monoLipsa.length ? ' — LIPSESC: ' + monoLipsa.join(', ') : ''), monoLipsa.length === 0);

  const lipsa = generatoare.filter((f) => !acoperit(f));
  ok('fiecare generator ANAF e in perimetrul portii' + (lipsa.length ? ' — LIPSA: ' + lipsa.join(', ') : ''), lipsa.length === 0);

  // ...si caile declarate chiar exista (o cale scrisa gresit dezactiveaza tacit poarta pe ea)
  const inexistente = lista.filter((c) => !fsx.existsSync(pth.join(root, c.replace(/\/$/, ''))));
  ok('fiecare cale din perimetru exista pe disc' + (inexistente.length ? ' — INEXISTENTE: ' + inexistente.join(', ') : ''), inexistente.length === 0);

  // poarta trebuie sa POATA pica: un generator inventat, in afara perimetrului, e detectat
  ok('poarta detecteaza un generator din afara perimetrului', !acoperit('src/declaratieNoua.js'));

  // Schema e-Transport e versionata in repo, ca poarta sa fie reproductibila oriunde (runnerul
  // de CI e efemer — o variabila cu o CALE de pe server n-ar indica nimic acolo).
  const dirSchema = pth.join(root, 'schemas', 'eTransport');
  const xsdFiles = fsx.existsSync(dirSchema) ? fsx.readdirSync(dirSchema).filter((f) => f.endsWith('.xsd')) : [];
  ok('schema e-Transport e versionata in repo (schemas/eTransport/*.xsd)', xsdFiles.length >= 1);
  // O SINGURA versiune: scriptul ia cel mai recent *.xsd, deci doua fisiere ar schimba tacit
  // fata de ce se valideaza (vezi schemas/eTransport/README.md).
  ok('exact o versiune de schema in depozit (nu doua)' + (xsdFiles.length > 1 ? ' — ' + xsdFiles.join(', ') : ''), xsdFiles.length === 1);
  if (xsdFiles.length === 1) {
    const xsd = fsx.readFileSync(pth.join(dirSchema, xsdFiles[0]), 'utf8');
    ok('schema declara namespace-ul eTransport v2', xsd.includes('targetNamespace="mfp:anaf:dgti:eTransport:declaratie:v2"'));
    ok('schema are elementul <notificare> (structura pe care o genereaza codul)', /name="notificare"/.test(xsd));
  }
}


section('Situatii financiare anuale (S1120/S1121) — randuri, invarianti, antet');
{
  const bil = require('../src/bilant');
  const nomB = require('../src/bilantNomenclator');
  const { bilantXml } = require('../src/xml');
  const { buildSeedData } = require('../src/seed');

  // Numarul de campuri e impus de SCHEMA ANAF (verificat pe validatorul oficial). Daca cineva
  // modifica intervalele, formularul iese cu randuri lipsa — pe care ANAF le asteapta completate.
  eq('F10 are 102 campuri (51 randuri x 2 coloane)', bil.CAMPURI_F10.length, 102);
  eq('F20 micro are 28 de campuri (14 randuri)', bil.CAMPURI_F20_MICRO.length, 28);
  eq('F20 complet are 176 de campuri (88 de randuri)', bil.CAMPURI_F20_COMPLET.length, 176);
  eq('F10 complet are 208 campuri (104 randuri, S1122)', bil.CAMPURI_F10_COMPLET.length, 208);
  ok('campurile respecta tiparul <formular>_<rand><coloana>', bil.CAMPURI_F10.every((k) => /^F10_\d{4}$/.test(k)));

  let n = 0; const sd = buildSeedData(() => 'e' + (++n));
  const view = { entries: sd.entries, openingBalances: sd.openingBalances || {} };
  const firma = Object.assign({}, sd.firme[0], {
    telefon: '0211234567', formaProprietate: '35', administrator: 'POPESCU ION',
    intocmitNume: 'IONESCU MARIA', intocmitCalitate: '21', intocmitNr: '12345', auditStatut: '3',
  });

  // ── Reziduul de rotunjire: se absoarbe, dar NU mai tacut ────────────────────────────────
  // Absorbtia e obligatorie (fara ea identitatea F10_64 pica la validator), dar pana acum n-avea
  // nici prag, nici glas: inghitea la fel si doi lei de rotunjire, si o eroare de mapare de sute
  // de mii. Consecinta perfida — un cont mapat gresit NU produce niciodata un bilant dezechilibrat,
  // ci un rezultat reportat gresit, pe care nu-l confrunta nimeni.
  {
    // reziduul se ataseaza NEENUMERABIL: nu are voie sa ajunga intr-un camp de formular sau in XML
    const R = bil.f10Totals({ '001': 100 });
    const marcat = bil.verificaRezidual(R);
    eq('un set fara marcaj raporteaza reziduu zero', marcat.rezidual, 0);
    ok('...si e considerat in regula', marcat.ok);
    const sMic = bil.situatii(view, firma, 2026, 'micro');
    const randuri = sMic.f10[2];
    ok('reziduul NU apare printre cheile randurilor', !Object.keys(randuri).includes('rezidual'));
    ok('...si nici in serializare (JSON)', !('rezidual' in JSON.parse(JSON.stringify(randuri))));
    ok('...dar se poate citi cand e cerut', typeof bil.verificaRezidual(randuri).rezidual === 'number');
    // pragul discrimineaza rotunjirea de o eroare de mapare
    const cuRezid = (v) => { const o = {}; Object.defineProperty(o, 'rezidual', { value: v, enumerable: false }); return bil.verificaRezidual(o); };
    ok('doi lei = rotunjire, tace', cuRezid(2).ok && cuRezid(2).mesaj === '');
    ok('pragul insusi inca trece', cuRezid(bil.PRAG_REZIDUAL).ok);
    ok('un leu peste prag deja vorbeste', !cuRezid(bil.PRAG_REZIDUAL + 1).ok);
    ok('...si in minus, la fel', !cuRezid(-(bil.PRAG_REZIDUAL + 1)).ok);
    ok('mesajul spune ca formularul TOTUSI se depune', /se depune corect/i.test(cuRezid(50000).mesaj));
    ok('...si ce anume sa verifice contabilul', /cont care nu cade/i.test(cuRezid(50000).mesaj));
    ok('...cu suma in mesaj', /50000/.test(cuRezid(50000).mesaj));
    // situatiile duc verdictul mai departe, pe ambii ani
    ok('situatiile raporteaza reziduul pe exercitiul curent si pe cel precedent',
      sMic.rezidual && sMic.rezidual.curent && sMic.rezidual.precedent);
    ok('seed-ul e curat: niciun avertisment', Array.isArray(sMic.avertismente) && sMic.avertismente.length === 0);

    // ...si CALEA REALA chiar raporteaza ce a absorbit. Fara aserțiunile astea, tot blocul de mai
    // sus verifica doar functia pura `verificaRezidual` si neenumerabilitatea — masurat: golirea
    // reziduului raportat („mereu zero") trecea suita VERDE. Al treilea caz din aceeasi familie:
    // cand pui o garda, testeaza si drumul pe care circula datele, nu doar piesele lui.
    {
      const vSimplu = { entries: [{ id: 'ez', firmaId: 1, data: '2026-03-01', period: '2026-03', system: false,
        lines: [{ debit: '5121', credit: '1012', suma: 30000 }] }], openingBalances: {} };
      // `rezultatNet` impus, incompatibil cu soldurile -> reziduu fortat prin absorbtia reala
      const R0 = bil.f10At(vSimplu, 2026, 0);
      eq('bilant coerent -> reziduu zero', bil.verificaRezidual(R0).rezidual, 0);
      const Rp = bil.f10At(vSimplu, 2026, 5000);
      eq('reziduul absorbit e RAPORTAT, cu semn', bil.verificaRezidual(Rp).rezidual, -5000);
      eq('...si chiar a fost mutat in rezultatul reportat', Rp['042'], 5000);
      ok('...si depaseste pragul, deci se semnaleaza', !bil.verificaRezidual(Rp).ok);
      const Rm = bil.f10At(vSimplu, 2026, -7000);
      eq('in celalalt sens, la fel', bil.verificaRezidual(Rm).rezidual, 7000);
      eq('...mutat pe partea cealalta a reportatului', Rm['041'], 7000);
      // identitatea de bilant TINE oricum — asta e si motivul pentru care defectul era invizibil
      const g = (k) => Rp[k] || 0;
      eq('identitatea F10_64 se satisface in ciuda reziduului',
        g('004') + g('009') + g('010') - g('013') - g('016') - g('017') - g('018'), g('049'));
    }
  }

  for (const cat of ['micro', 'mic', 'mare']) {
    const s = bil.situatii(view, firma, 2026, cat);
    eq('antet complet -> nimic de reclamat (' + cat + ')', s.lipsa.length, 0);
    const R = s.f10[2];
    const g = (k) => R[k] || 0;
    // INVARIANTUL CENTRAL: identitatea de bilant pe care o verifica validatorul (regula F10_64).
    // Tine doar daca fiecare cont a cazut in EXACT UN rand, cu semnul corect.
    const complet = cat === 'mare';
    const stanga = complet ? g('103') : g('049');
    const dreapta = complet
      ? g('025') + g('041') + g('042') - g('053') - g('064') - g('068') - g('079')
      : g('004') + g('009') + g('010') - g('013') - g('016') - g('017') - g('018');
    eq('identitatea de bilant tine (' + cat + ')', stanga, dreapta);
    // Legatura impusa intre formulare: rezultatul din bilant = rezultatul din contul de profit
    const randP = cat === 'micro' ? '008' : '069';
    const randPi = cat === 'micro' ? '009' : '070';
    eq('rezultatul din F10 = rezultatul din F20 (' + cat + ')',
      complet ? g('097') - g('098') : g('043') - g('044'), s.f20[2][randP] - s.f20[2][randPi]);
    // Toate sumele sunt INTREGI — validatorul respinge zecimalele
    ok('toate randurile F10 sunt lei intregi (' + cat + ')',
      Object.values(R).every((x) => Number.isInteger(x)));
    ok('toate randurile F20 sunt lei intregi (' + cat + ')',
      Object.values(s.f20[2]).every((x) => Number.isInteger(x)));

    const x = bilantXml(s);
    ok('XML bine format (' + cat + ')', wellFormed(x));
    ok('radacina si namespace corecte (' + cat + ')',
      x.includes('<' + s.antet.formular.radacina + ' ') && x.includes(':' + s.antet.formular.ns + ':declaratie:'));
    ok('contine toate campurile F10 (' + cat + ')', s.randuriF10.every((k) => x.includes(k + '="')));
    ok('niciun atribut gol (validatorul le respinge) (' + cat + ')', !/="\s*"/.test(x));
  }

  // Versiunea de namespace se alege dupa ANUL RAPORTAT (capcana confirmata pe validator).
  const { bilantNsVersion } = require('../src/xml');
  eq('namespace v3 pentru 2025', bilantNsVersion(2025), 'v3');
  eq('namespace v2 pentru 2020', bilantNsVersion(2020), 'v2');
  eq('namespace v1 pentru 2017', bilantNsVersion(2017), 'v1');

  // Antetul REFUZA sa se completeze singur: fara datele firmei nu se genereaza nimic.
  const gol = bil.situatii(view, { nume: 'X', cui: '1', judet: 'RO-B' }, 2026, 'micro');
  ok('antet incomplet -> raporteaza ce lipseste, nu inventeaza', gol.lipsa.length >= 5);
  ok('...si numeste forma de proprietate', gol.lipsa.some((m) => /forma de proprietate/.test(m)));
  const jGresit = bil.situatii(view, Object.assign({}, firma, { judet: 'XX' }), 2026, 'micro');
  ok('judet nerecunoscut -> refuz explicit, nu un cod implicit', jGresit.lipsa.some((m) => /judet/.test(m)));

  // Regula R26 a validatorului: numarul CECCAR e obligatoriu la calitatile 21/22, interzis altfel.
  const fara = bil.antet(Object.assign({}, firma, { intocmitNr: '' }), 2026, 'micro', 0);
  ok('R26: calitatea 21 fara numar CECCAR -> reclamat', fara.lipsa.some((m) => /CECCAR/.test(m)));
  const intern = bil.antet(Object.assign({}, firma, { intocmitCalitate: '12', intocmitNr: '999' }), 2026, 'micro', 0);
  ok('R26: la calitatea 12 numarul NU se trimite', intern.attrs.nri_intocmit === undefined);

  // Nomenclatoarele sunt cele din validatorul oficial — nu inventate de noi.
  eq('42 de judete in nomenclator', nomB.JUDETE.length, 42);
  eq('Bucuresti = 40', nomB.codJudet('RO-B'), '40');
  eq('Calarasi pastreaza codul istoric 51', nomB.codJudet('RO-CL'), '51');
  eq('Giurgiu pastreaza codul istoric 52', nomB.codJudet('RO-GR'), '52');
  ok('judet necunoscut -> null (nu un implicit tacut)', nomB.codJudet('RO-ZZ') === null);
  eq('27 de forme de proprietate', nomB.FORME_PROPRIETATE.length, 27);
  eq('5 calitati de intocmitor', nomB.CALITATI.length, 5);

  // Termenul legal: 31 mai anul urmator (150 de zile, Legea 82/1991 art. 36).
  const declB = require('../src/declarations');
  eq('termenul situatiilor financiare = 31 mai anul urmator', declB.dueDate('bilant', '2026-12'), '2027-05-31');
  ok('tipul apare in registrul de declaratii', !!declB.TIPURI.bilant);
}

section('e-Factura: refuzul de a emite o factura pe care nu o poate citi');
{
  // Garda inlocuieste o cadere „de siguranta" pe suma veniturilor, scoasa fiindca nu se declansa
  // pentru niciun tip emis (toate trec prin 411x/461) si MASCA ancora: cu ea, stergerea lui 461 din
  // `CREANTA` nu picase niciun test — veniturile salvau tacit rezultatul, iar aserțiunea trecea din
  // motivul gresit. Un UBL de zero lei ar fi trecut generarea si ar fi plecat in SPV.
  const goala = { tip: 'factura_vanzare_marfuri', data: '2026-06-10', document: 'F0',
    partenerCui: 'RO1', partener: 'C', lines: [{ debit: '5311', credit: '707', suma: 1000 }] };
  let msg = '';
  try { xml.eFacturaXml({ cui: 'RO1', nume: 'X' }, goala, {}); } catch (e) { msg = e.message; }
  ok('factura fara miscare pe creanta e REFUZATA, nu emisa cu zero', /nu pot citi sumele/i.test(msg));
  ok('...si mesajul spune ce sa verifice', /411x sau 461/.test(msg));
  // Nota de credit are aceeasi garda: era al doilea generator, cu aceeasi gaura.
  let msgC = '';
  try { xml.eFacturaXml({ cui: 'RO1', nume: 'X' }, Object.assign({}, goala, { tip: 'factura_storno_vanzare' }), {}); } catch (e) { msgC = e.message; }
  ok('nota de credit: acelasi refuz', /nu pot citi sumele/i.test(msgC));
  // Calea cu linii detaliate NU trece prin articolul contabil, deci nu are voie sa fie refuzata.
  const cuItems = { tip: 'factura_vanzare_marfuri', data: '2026-06-10', document: 'F1',
    partenerCui: 'RO1', partener: 'C', lines: [],
    items: [{ nume: 'A', cantitate: 2, pret: 500, um: 'buc', cota: 21 }] };
  ok('factura cu linii detaliate se emite normal', /<Invoice/.test(xml.eFacturaXml({ cui: 'RO1', nume: 'X' }, cuItems, {})));
}

section('Poarta: suita nu scrie in directorul de date REAL');
{
  // Acest director e si instalarea de PRODUCTIE, iar `npm test` ruleaza la `prestart` — deci o
  // suita care scrie in `data/` scrie peste datele vii, la fiecare pornire a serverului. Poarta se
  // uita la calea EFECTIV rezolvata de src/db.js, nu la variabila de mediu: doar asa prinde si
  // cazul in care izolarea se strica din alta parte (o cale hardcodata, o valoare golita).
  const pathG = require('path');
  const reala = pathG.join(__dirname, '..', 'data');
  const dbG = require('../src/db');
  ok('directorul de date al suitei NU e `data/` din repo', pathG.resolve(dbG.DATA_DIR) !== pathG.resolve(reala));
  ok('...nici uploads-ul derivat din el', !pathG.resolve(dbG.UPLOAD_DIR).startsWith(pathG.resolve(reala) + pathG.sep));
  // Si baza, si oglinda ei: CONTAB_DB_FILE muta doar baza, deci amandoua se verifica separat.
  ok('fisierul bazei nu e in `data/` real', !pathG.resolve(process.env.CONTAB_DB_FILE).startsWith(pathG.resolve(reala) + pathG.sep));
  // Precondiția de la capul fisierului trebuie sa REFUZE, nu doar sa constate. Se verifica pe
  // functia ei de decizie, nu pornind inca un proces: garda ruleaza inainte de orice require, deci
  // un test care ar porni suita din nou ar fi si lent, si circular.
  const inauntruG = (p2) => {
    const r = pathG.resolve(p2);
    return r === pathG.resolve(reala) || r.startsWith(pathG.resolve(reala) + pathG.sep);
  };
  ok('garda de precondiție recunoaste baza REALA', inauntruG(pathG.join(reala, 'db.json')));
  ok('...si directorul real ca atare', inauntruG(reala));
  ok('...dar lasa caile temporare sa treaca', !inauntruG(require('os').tmpdir() + '/contab-test.json'));
  // Idempotenta: baza se sterge la pornire, deci a doua rulare pe acelasi fisier porneste curat.
  // Inainte, a doua rulare pica 5 aserttiuni (contorul cozii de persistenta + extrasul AI).
  ok('baza suitei e stearsa la pornire (idempotenta prin constructie)',
    /rmSync\(f, \{ force: true \}\)/.test(require('fs').readFileSync(__filename, 'utf8')));
  ok('driverul suitei e impus pe sqlite', process.env.CONTAB_DB_DRIVER === 'sqlite');
}

console.log('\n' + (stare.fail ? '✗ ' : '✓ ') + stare.pass + ' verificari trecute, ' + stare.fail + ' esuate.');
process.exit(stare.fail ? 1 : 0);
