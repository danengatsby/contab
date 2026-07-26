'use strict';

// Test suite — blocheaza regresiile pe numerele cheie ale exemplului din ghid.
// Ruleaza pe datele "scoped" pure; testele care ating baza de date folosesc un fisier temporar
// (CONTAB_DB_FILE) ca sa NU atinga data/db.json. `npm test`.

const path = require('path');
const os = require('os');
process.env.CONTAB_DB_FILE = process.env.CONTAB_DB_FILE || path.join(os.tmpdir(), 'contab-test-' + process.pid + '.json');

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
const { reconcile } = require('../src/reconcile');
const { settle, candidatesFor } = require('../src/matching');
const { reconcileInbox, journalPurchases } = require('../src/einvoiceReconcile');
const { statePlata, registruSalarii } = require('../src/payroll');

let pass = 0; let fail = 0;

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

function eq(name, got, exp) {
  const g = typeof got === 'number' ? Math.round(got * 100) / 100 : got;
  if (g === exp) { pass += 1; }
  else { fail += 1; console.error('  ✗ ' + name + ': got ' + JSON.stringify(g) + ', expected ' + JSON.stringify(exp)); }
}
function ok(name, cond) { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + name + ': condition false'); } }
function section(t) { console.log('\n' + t); }
function wellFormed(x) {
  const s = String(x).replace(/<\?xml[^>]*\?>/, '');
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g;
  const stack = []; let m;
  while ((m = re.exec(s))) { const [, c, n, , sc] = m; if (sc) continue; if (c) { if (stack.pop() !== n) return false; } else stack.push(n); }
  return stack.length === 0;
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

const v = scopedSeed();

section('Balanta de verificare (2026-06)');
const tb = acc.trialBalance(v, '2026-06');
eq('balanced', tb.balanced, true);
eq('total SI debit = credit', tb.tot.siD, tb.tot.siC);
eq('total SI', tb.tot.siD, 65000);
eq('total rulaj D = C', tb.tot.rd, tb.tot.rc);
eq('total SF debit', tb.tot.sfD, 84327.5);
eq('total SF debit = credit', tb.tot.sfD, tb.tot.sfC);

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
eq('rezultat brut', pl.rezBrut, 687.5);

section('Registrul de evidenta fiscala (2026)');
const rf = rep.registruFiscal(v, '2026');
eq('rezultat contabil', rf.rezultatContabil, 687.5);
eq('total nedeductibile (fara ajustari in seed)', rf.totalNeded, 0);
eq('rezultat fiscal', rf.rezultatFiscal, 687.5);
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
eq('coeficient degresiv ≤5 ani', assets.degressiveCoef(5), 1.5);
eq('coeficient degresiv 6-10 ani', assets.degressiveCoef(8), 2.0);
eq('coeficient degresiv >10 ani', assets.degressiveCoef(12), 2.5);
// degresiva e front-loaded: primul an > liniarul mediu
const degSch = assets.schedule({ cost: 10000, durataLuni: 60, metoda: 'degresiva', dataPif: '2026-01-01' });
const degAn1 = degSch.filter((r) => r.period.startsWith('2026')).reduce((s, r) => s + r.amount, 0) + degSch.filter((r) => r.period === '2027-01').reduce((s, r) => s + r.amount, 0);
ok('degresiva front-loaded (an 1 = 3000 > liniar 2000)', Math.round(degAn1) === 3000);

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

section('uploadsHygiene — staging orfan + raport de fisiere nereferentiate');
{
  const uh = require('../src/uploadsHygiene');
  const fsH = require('fs'); const osH = require('os'); const pathH = require('path');
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'uph-'));
  fsH.mkdirSync(pathH.join(dir, '.import-vechi'));
  fsH.writeFileSync(pathH.join(dir, '.import-vechi', 'f.bin'), 'x');
  fsH.mkdirSync(pathH.join(dir, '.import-proaspat'));
  fsH.writeFileSync(pathH.join(dir, 'doc1.pdf'), 'a');
  fsH.writeFileSync(pathH.join(dir, 'orfan.pdf'), 'b');
  // "vechi" = mtime impins in trecut
  const vechi = new Date(Date.now() - 48 * 3600 * 1000);
  fsH.utimesSync(pathH.join(dir, '.import-vechi'), vechi, vechi);
  eq('staging-ul vechi e sters, cel proaspat ramane', uh.sweepStaging(dir), 1);
  ok('directorul proaspat a supravietuit', fsH.existsSync(pathH.join(dir, '.import-proaspat')));
  const rap = uh.orphanReport({ documents: [{ storedName: 'doc1.pdf' }], firme: [], messages: [] }, dir);
  eq('raport: 1 orfan din 2 fisiere (staging-ul nu se numara)', rap.orfane + '/' + rap.total, '1/2');
  fsH.rmSync(dir, { recursive: true, force: true });
}

section('sesiune: token FARA sessId respins (fix escaladare prin secret compromis)');
{
  const session = require('../src/session');
  const authlibS = require('../src/auth');
  const dS = db.get();
  const secret = process.env.CONTAB_AUTH_SECRET || dS.settings.authSecret;
  const uid = dS.users[0].id;
  // token forjat sessionless {uid} — semnat CORECT, dar fara sessId
  const fara = authlibS.sign({ uid, exp: Date.now() + 3600000 }, secret);
  const reqFara = { headers: { cookie: 'sid=' + fara } };
  eq('token valid dar FARA sessId -> neautentificat', session.currentUser(reqFara), null);
  // token cu sessId inexistent -> tot respins (sesiune revocata)
  const inv = authlibS.sign({ uid, sessId: 'nu-exista', exp: Date.now() + 3600000 }, secret);
  eq('token cu sessId inexistent -> neautentificat', session.currentUser({ headers: { cookie: 'sid=' + inv } }), null);
}

section('auditLog — jurnal DURABIL append-only pe disc');
{
  const auditLog = require('../src/auditLog');
  const fsA = require('fs'); const pathA = require('path'); const osA = require('os');
  const prevAuditDir = process.env.CONTAB_AUDIT_DIR;
  process.env.CONTAB_AUDIT_DIR = fsA.mkdtempSync(pathA.join(osA.tmpdir(), 'audit-test-')); // izolat de data/ real
  const rec1 = { id: 1, ts: '2026-07-15T10:00:00.000Z', username: 'u', action: 'test.a', detail: 'x' };
  const rec2 = { id: 2, ts: '2026-07-15T10:01:00.000Z', username: 'u', action: 'test.b', detail: 'y' };
  const rec3 = { id: 3, ts: '2026-08-01T09:00:00.000Z', username: 'v', action: 'test.c', detail: 'z' };
  auditLog.append(rec1); auditLog.append(rec2); auditLog.append(rec3);
  const dir = auditLog.auditDir();
  const iul = pathA.join(dir, 'audit-2026-07.ndjson');
  const aug = pathA.join(dir, 'audit-2026-08.ndjson');
  ok('fisier lunar creat (rotatie pe luna)', fsA.existsSync(iul) && fsA.existsSync(aug));
  const linii = fsA.readFileSync(iul, 'utf8').trim().split('\n');
  eq('append-only: ambele evenimente ale lunii, in ordine', linii.length, 2);
  eq('linia e NDJSON valid, reconstructibila', JSON.parse(linii[0]).action, 'test.a');
  ok('listFiles le vede pe amandoua, noile primele', (() => { const f = auditLog.listFiles(); return f[0] === 'audit-2026-08.ndjson' && f.includes('audit-2026-07.ndjson'); })());
  fsA.rmSync(process.env.CONTAB_AUDIT_DIR, { recursive: true, force: true }); // curatenie (dir izolat)
  if (prevAuditDir === undefined) delete process.env.CONTAB_AUDIT_DIR; else process.env.CONTAB_AUDIT_DIR = prevAuditDir;
}

section('secretbox — criptarea secretelor cu cheie externa');
const sbox = require('../src/secretbox');
{
  const K = 'CONTAB_SECRETS_KEY';
  const veche = process.env[K];
  delete process.env[K];
  eq('fara cheie: seal e passthrough', sbox.seal('parola'), 'parola');
  process.env[K] = 'a'.repeat(64);
  const sigilat = sbox.seal('parola-smtp');
  ok('cu cheie: sigilat (enc:v1:...)', sbox.isSealed(sigilat) && sigilat !== 'parola-smtp');
  eq('open intoarce textul original', sbox.open(sigilat), 'parola-smtp');
  eq('valorile in clar trec neatinse prin open', sbox.open('text-vechi'), 'text-vechi');
  eq('sigilarea e idempotenta (nu dubleaza)', sbox.seal(sigilat), sigilat);
  // rotatie: cheia veche ramane acceptata prin CONTAB_SECRETS_KEY_OLD
  process.env.CONTAB_SECRETS_KEY_OLD = process.env[K];
  process.env[K] = 'b'.repeat(64);
  eq('rotatie: secretul sigilat cu cheia veche se deschide', sbox.open(sigilat), 'parola-smtp');
  ok('re-sigilarea foloseste cheia noua', sbox.open(sbox.seal('nou')) === 'nou');
  delete process.env.CONTAB_SECRETS_KEY_OLD;
  ok('fara nicio cheie potrivita: eroare clara, nu text gresit', (() => {
    process.env[K] = 'c'.repeat(64);
    try { sbox.open(sigilat); return false; } catch (e) { return /CONTAB_SECRETS_KEY/.test(e.message); }
  })());
  if (veche === undefined) delete process.env[K]; else process.env[K] = veche;
}

section('zipGuard — garda anti zip-bomb la importuri');
const zipGuard = require('../src/zipGuard');
const AdmZipT = require('adm-zip');
const zOk = new AdmZipT();
zOk.addFile('firma.json', Buffer.from('{}'));
ok('arhiva legitima trece garda', !!zipGuard.openGuarded(zOk.toBuffer()).zip);
const zBomb = new AdmZipT();
zBomb.addFile('bomb.bin', Buffer.alloc(2 * 1024 * 1024, 0)); // 2MB de zerouri -> raport urias
ok('zip-bomb (raport de compresie) respins cu 400', (() => {
  try { zipGuard.openGuarded(zBomb.toBuffer(), { maxRatio: 50 }); return false; }
  catch (e) { return e.status === 400 && /suspect/.test(e.message); }
})());
const zMany = new AdmZipT();
for (let i = 0; i < 20; i++) zMany.addFile('f' + i + '.txt', Buffer.from('x'));
ok('prea multe intrari respins cu 400', (() => {
  try { zipGuard.openGuarded(zMany.toBuffer(), { maxEntries: 10 }); return false; }
  catch (e) { return e.status === 400 && /prea multe/.test(e.message); }
})());
ok('fisier peste limita per-intrare respins', (() => {
  try { zipGuard.openGuarded(zBomb.toBuffer(), { maxEntrySize: 1024, maxRatio: 1e9 }); return false; }
  catch (e) { return e.status === 400 && /prea mare/.test(e.message); }
})());
ok('buffer corupt respins cu 400 (nu crapa)', (() => {
  try { zipGuard.openGuarded(Buffer.from('nu-e-zip')); return false; }
  catch (e) { return e.status === 400; }
})());

section('backup: verificarea restaurabilitatii arhivei');
const bkp = require('../src/backup');
const fsBk = require('fs');
const zGood = new AdmZipT();
zGood.addFile('db.json', Buffer.from(JSON.stringify({ firme: [{ id: 1 }], entries: [] })));
zGood.addFile('contab.sqlite', Buffer.from('sqlite-fals'));
const tmpZ = path.join(os.tmpdir(), 'bkp-test-' + process.pid + '.zip');
fsBk.writeFileSync(tmpZ, zGood.toBuffer());
const vOkB = bkp.verifyArchive(tmpZ);
ok('arhiva valida: ok cu firmele numarate', vOkB.ok === true && vOkB.firme === 1 && vOkB.sqlite === true);
const zNoDb = new AdmZipT(); zNoDb.addFile('altceva.txt', Buffer.from('x'));
fsBk.writeFileSync(tmpZ, zNoDb.toBuffer());
ok('arhiva fara db.json: respinsa cu motiv', bkp.verifyArchive(tmpZ).ok === false && /db\.json/.test(bkp.verifyArchive(tmpZ).motiv));
fsBk.writeFileSync(tmpZ, Buffer.from('nu-e-zip'));
ok('fisier corupt: respins fara crash', bkp.verifyArchive(tmpZ).ok === false);
fsBk.unlinkSync(tmpZ);

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
// vanzare fara CUI de partener (B2C) nu intra la e-Factura netrimisa
const recB2c = rep.tvaReconciliation(mkVat([
  { id: 'v4', tip: 'factura_vanzare_marfuri', document: 'BON1', period: '2026-06', data: '2026-06-13', lines: [{ debit: '4111', credit: '707', suma: 500 }, { debit: '4111', credit: '4427', suma: 105 }] },
]), '2026-06');
ok('reconciliere: vanzare B2C (fara CUI) nu e semnalata ca netrimisa', !recB2c.findings.some((f) => f.cod === 'efactura-netrimisa'));
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
const ESC_XML = /\b(esc|num2|numOf|roCui|umCode|Number|String|Math|parseInt|parseFloat|encodeURIComponent)\(/;
function frunze(line) {
  const out = []; let s = line;
  for (let i = 0; i < 10; i += 1) {
    let gasit = false;
    s = s.replace(/\$\{([^{}]*)\}/g, (_, x) => { out.push(x.trim()); gasit = true; return ''; });
    if (!gasit) break;
  }
  return out;
}
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
const neescapateXml = [];
for (const f of ['xml.js', 'saft.js', 'etransport.js']) {
  fsx2.readFileSync(pth2.join(__dirname, '..', 'src', f), 'utf8').split('\n').forEach((ln, i) => {
    if (!/<[a-zA-Z/?]/.test(ln)) return;
    for (const e of frunze(ln)) {
      if (e && CAMP_RISCANT.test(e) && CAMP_RISCANT.test(faraEsc(e))) neescapateXml.push(f + ':' + (i + 1) + ' ${' + e.slice(0, 50) + '}');
    }
  });
}
ok('niciun camp de text interpolat in XML fara esc()'
  + (neescapateXml.length ? ' — ' + neescapateXml.slice(0, 3).join(' | ') : ''), neescapateXml.length === 0);
ok('poarta XML chiar detecteaza o interpolare neescapata',
  frunze('`<Name>${p.denumire}</Name>`').some((e) => CAMP_RISCANT.test(faraEsc(e))));
ok('poarta XML nu raporteaza o interpolare escapata',
  !frunze('`<Name>${esc(p.denumire)}</Name>`').some((e) => CAMP_RISCANT.test(faraEsc(e))));
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

section('Inchiderea anuala (2026)');
const an = acc.annualClosing(v, '2026');
eq('total venituri inchise', an.totalVen, 14000);
eq('total cheltuieli inchise', an.totalChelt, 13312.5);
eq('rezultat (121) = rezultat brut P&L', an.rezultat, 687.5);
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
eq('ALFA facturat (perioada)', alfaR.facturat, 12100);
eq('ALFA decontat', alfaR.decontat, 12100);
eq('ALFA sold reconciliat', alfaR.sold, 0);
eq('ALFA potriviri factura-plata', alfaR.potriviri, 1);
ok('ALFA fara facturi deschise (reconciliat complet)', Array.isArray(alfaR.deschise) && alfaR.deschise.length === 0);
const betaR = rc.partners.find((p) => /BETA/.test(p.den) && p.cont === '4111');
eq('BETA facturat', betaR.facturat, 16940);
eq('BETA decontat', betaR.decontat, 16940);

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
eq('total activ', bs.totalActiv, 70815);
eq('rezultat curent (clasa 7-6)', bs.rezultatCurent, 687.5);

section('Bilant structura F10 (prescurtat)');
const f10 = stmt.balanceSheetF10(v, '2026-06');
eq('F10 echilibrat', f10.echilibrat, true);
eq('F10 total activ = bilant simplificat', f10.totalActiv, bs.totalActiv);
eq('F10 total activ = total pasiv', f10.totalActiv, f10.totalPasiv);
ok('F10 are datorii curente (D)', f10.randuri.D_datorii > 0);
eq('F10 rezultat curent in capitaluri', f10.randuri.rezultatCurent, 687.5);
eq('F10 total activ', f10.totalActiv, 70815);
// datoriile pe termen lung (grupa 16) merg in randul G, nu in datorii curente
const f10lt = stmt.balanceSheetF10({ openingBalances: { 1621: { d: 0, c: 50000 }, 5121: { d: 50000, c: 0 } }, entries: [] }, '2026-12');
eq('F10: credit pe TL (1621) -> G (datorii >1 an)', f10lt.randuri.G_datoriiLT, 50000);
eq('F10: nu apare in datorii curente', f10lt.randuri.D_datorii, 0);
ok('F10 echilibrat cu datorie pe termen lung', f10lt.echilibrat);

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
eq('stat: total de virat include partea angajatorului', spNp.totals.totalBuget, 500 + 200 + 130 + 45 + 512.5 + 205);
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
const sp = statePlata(v.angajati);
eq('numar angajati', sp.rows.length, 1);
eq('total brut', sp.totals.brut, 5000);
eq('total net', sp.totals.net, 2925);
eq('total de virat la buget', sp.totals.totalBuget, 2187.5);
eq('cost total angajator', sp.totals.costTotal, 5112.5);
eq('angajat net = payroll net', sp.rows[0].net, fiscal.payroll(5000).net);
const d112 = xml.d112Xml(v.company, '2026-06', sp);
ok('D112 bine-format', wellFormed(d112));
ok('D112 pe schema curenta (declaratieUnica v7)', d112.includes('xmlns="mfp:anaf:dgti:declaratie_unica:declaratie:v7"'));
ok('D112 contine asiguratul (nume/prenume separate + CNP)', d112.includes('numeAsig="Popescu"') && d112.includes('prenAsig="Ion"') && d112.includes('cnpAsig="1900101415238"'));
ok('D112: obligatiile pe coduri (602/412/432/480) cu totalul de plata', /A_codOblig="602" A_datorat="325"/.test(d112) && /A_codOblig="480" A_datorat="113"/.test(d112) && d112.includes('totalPlata_A="2188"'));
ok('D112: impozitul per asigurat in E3 (E3_15) si Timp_E3', d112.includes('E3_15="325"') && d112.includes('Timp_E3="325"'));
ok('D112: NZL cu sarbatorile legale (iunie 2026 = 21 zile, 1 iunie Rusalii)', d112.includes('A_8="21"') && d112.includes('A_6="168"'));
// spor (impozabil) + retineri (din net)
const sp2 = statePlata([{ id: 'x', nume: 'Test', salariuBrut: 4700, spor: 300, retineri: 500 }]);
eq('brut cu spor (4700+300)', sp2.totals.brut, 5000);
eq('net (ca la 5000 brut)', sp2.totals.net, 2925);
eq('rest de plata = net - retineri', sp2.rows[0].restPlata, 2425);
eq('total retineri', sp2.totals.retineri, 500);
const sp3 = statePlata([{ id: 'y', nume: 'Test', salariuBrut: 5000, avans: 1000, retineri: 200 }]);
eq('rest de plata = net - avans - retineri', sp3.rows[0].restPlata, 1725);
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
const payMin = fiscal.payroll(sm, dpMin);
eq('impozit scade cu deducerea personala', spDP.rows[0].impozit, payMin.impozit);
eq('deducerea apare in rand', spDP.rows[0].deducere, dpMin);
ok('impozit cu deducere < impozit fara deducere', payMin.impozit < fiscal.payroll(sm, 0).impozit);
// fara campuri noi -> comportament neschimbat (compat)
eq('angajat fara persoane: deducere 0 (compat)', statePlata([{ id: 'q', nume: 'X', salariuBrut: 5000 }]).rows[0].deducere, 0);

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
  firma: { id: 9, nume: 'Test SRL', cui: '999' },
  partners: {}, openingBalances: { 371: { d: 1000, c: 0 } }, openingAnalytic: [],
  products: [{ id: 'p1', firmaId: 9, cod: 'X', denumire: 'X', um: 'buc', cont: '371' }],
  gestiuni: [{ id: 'g1', firmaId: 9, cod: 'D', denumire: 'Depozit' }, { id: 'g2', firmaId: 9, cod: 'M', denumire: 'Magazin' }],
  stockMovements: [{ id: 'm1', firmaId: 9, data: '2026-01-01', tip: 'transfer', productId: 'p1', gestiuneId: 'g1', gestiuneDestId: 'g2', cantitate: 5 }],
  entries: [{ id: 'e1', firmaId: 9, data: '2026-01-01', period: '2026-01', tip: 't', tipNume: 't', lines: [{ debit: '371', credit: '401', suma: 100 }] }],
  inventories: [], assets: [], angajati: [], payrollHistory: [], documents: [],
};
const newFid = db.importFirma(bundle);
const v2 = db.scoped(newFid);
ok('firma importata are id nou', newFid !== 9);
eq('produse importate', v2.products.length, 1);
eq('miscari importate', v2.stockMovements.length, 1);
const mv = v2.stockMovements[0];
ok('miscarea trimite la un produs valid din firma noua', v2.products.some((p) => p.id === mv.productId));
ok('miscarea trimite la gestiuni valide (sursa+dest)', v2.gestiuni.some((g) => g.id === mv.gestiuneId) && v2.gestiuni.some((g) => g.id === mv.gestiuneDestId));
eq('export reflecta firma importata', db.exportFirma(newFid).entries.length, 1);
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

section('Provizioane pentru riscuri si cheltuieli (151)');
const vProv = { entries: [
  mkTva('provizion_constituire', { suma: 5000, explicatie: 'Litigiu' }, '2026-12-15'),
  mkTva('provizion_reluare', { suma: 2000, explicatie: 'Litigiu castigat partial' }, '2026-12-31'),
], openingBalances: {} };
const tbP = acc.trialBalance(vProv, '2026-12');
const fP = (c) => tbP.rows.find((r) => r.cod === c) || {};
eq('provizion 151 ramas (5000-2000)', fP('151').sfC, 3000);
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
const d205db = { entries: [
  { id: '1', tip: 'chirie_pf', period: '2026-03', data: '2026-03-01', partener: 'Ion Pop', partenerCui: '1900101415238', lines: gt2('chirie_pf').build({ baza: 1000, cota: 10, cont: '5121' }) },
  { id: '2', tip: 'premiu_pf', period: '2026-05', data: '2026-05-01', partener: 'Maria I', partenerCui: '2900202535241', lines: gt2('premiu_pf').build({ baza: 500, cota: 10, cont: '5311' }) },
  { id: '3', tip: 'repartizare_dividende', period: '2026-04', data: '2026-04-01', partener: 'Asociat A', partenerCui: '1800303646352', lines: [{ debit: '117', credit: '457', suma: 10000 }, { debit: '457', credit: '446', suma: 800 }] },
] };
const d205 = rep.d205(d205db, '2026');
eq('D205: 3 beneficiari', d205.nr, 3);
eq('D205: total impozit retinut (80+50+800; chirie 10% din net)', d205.totalImpozit, 930);
ok('D205: dividend brut 10000 capturat', d205.rows.some((r) => r.tipVenit === 'Dividende' && r.venitBrut === 10000));
ok('D205 XML bine-format', wellFormed(xml.d205Xml({ cui: 'RO1', nume: 'X' }, '2026', d205)));
const intr = rep.intrastat({ entries: [
  { id: '1', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-10', partenerCui: 'DE1', lines: gt2('livrare_intracomunitara').build({ baza: 5000 }) },
  { id: '2', tip: 'achizitie_intracomunitara', period: '2026-06', data: '2026-06-12', partenerCui: 'FR2', lines: gt2('achizitie_intracomunitara').build({ baza: 3000, cota: 21 }) },
] }, '2026-06');
eq('Intrastat: total expedieri (livrari) 5000', intr.totalExpedieri, 5000);
eq('Intrastat: total introduceri (achizitii) 3000', intr.totalIntroduceri, 3000);
const intrNC = rep.intrastat({ entries: [
  { id: '1', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-10', partenerCui: 'DE1', intrastat: { codNC: '94036010', masaNeta: 120, natura: '11' }, lines: gt2('livrare_intracomunitara').build({ baza: 5000 }) },
  { id: '2', tip: 'livrare_intracomunitara', period: '2026-06', data: '2026-06-12', partenerCui: 'DE2', intrastat: { codNC: '94036010', masaNeta: 80 }, lines: gt2('livrare_intracomunitara').build({ baza: 2000 }) },
  { id: '3', tip: 'achizitie_intracomunitara', period: '2026-06', data: '2026-06-12', partenerCui: 'FR1', intrastat: { codNC: '72142000', masaNeta: 500 }, lines: gt2('achizitie_intracomunitara').build({ baza: 3000, cota: 21 }) },
] }, '2026-06');
const deRow = intrNC.rows.find((r) => r.flux === 'expediere' && r.tara === 'DE' && r.codNC === '94036010');
eq('Intrastat NC8: grupare pe DE + 94036010 (2 operatiuni)', deRow.nrop, 2);
eq('Intrastat NC8: masa neta cumulata 120+80', deRow.masaNeta, 200);
eq('Intrastat NC8: valoare cumulata 5000+2000', deRow.valoare, 7000);
eq('Intrastat: pragul 1.000.000 lei', intrNC.pragExpedieri, 1000000);
eq('Intrastat: sub prag -> neobligat la declarare', intrNC.obligatExpedieri, false);
ok('Intrastat XML bine-format', wellFormed(xml.intrastatXml({ cui: 'RO1', nume: 'X' }, '2026-06', intrNC)));
ok('Intrastat XML: articolul DE cu masa neta cumulata', xml.intrastatXml({ cui: 'RO1', nume: 'X' }, '2026-06', intrNC).includes('masa_neta="200.00"'));

section('RO e-Transport (cod UIT) — nomenclatoare, asamblare, validare, XML');
const et = require('../src/etransport');
// nomenclatoare oficiale
ok('e-Transport: tip operatiune 30 = transport intern', /intern/i.test(et.TIP_OPERATIUNE[30]));
ok('e-Transport: scop 101 = comercializare', /comercial/i.test(et.SCOP_OPERATIUNE[101]));
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
// aceeasi iesire, dar cu sosire la un punct de trecere a frontierei -> fara avertismentul de traseu
const etIcPtf = et.buildDeclaration(etCompany, etIc, { nrVehicul: 'CJ01ABC', codTarifar: '94036010', greutateBruta: 500, final: { codPtf: 'NADLAC2' } });
ok('e-Transport validare: iesire IC prin PTF -> fara avertisment de frontiera', !et.validate(etIcPtf).warnings.some((w) => /frontier|vamal/i.test(w)));

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
ok('D100 XML v2: obligatia 620 cu cod bugetar, scadenta si nr_evid pe 23 cifre', (() => {
  const x = xml.d100Xml({ cui: 'RO1', nume: 'X' }, '2026-06', d100q);
  return x.includes('cod_oblig="620"') && x.includes('cod_bugetar="20A031800"')
    && x.includes('scadenta="25.07.2026"') && x.includes('suma_plata="150"')
    && /nr_evid="\d{23}"/.test(x) && x.includes('xmlns="mfp:anaf:dgti:d100:declaratie:v2"');
})());
// eligibilitate micro (plafon implicit 100.000 EUR x curs 5 = 500.000 lei + conditia de salariat)
ok('D100: fara salariati -> avertisment de eligibilitate', d100q.avertismente.some((w) => /salariat/i.test(w)));
const d100over = rep.d100micro({ entries: [{ id: 'o1', period: '2026-02', data: '2026-02-01', lines: [{ debit: '4111', credit: '704', suma: 600000 }] }], angajati: [{ id: 'a' }] }, '2026-03');
ok('D100: peste plafonul micro -> avertisment de iesire din regim', d100over.avertismente.some((w) => /DEPASESC/.test(w)));
ok('D100: cu salariat -> fara avertismentul de salariat', !d100over.avertismente.some((w) => /salariat/i.test(w)));
const d100warn = rep.d100micro({ entries: [{ id: 'w1', period: '2026-02', data: '2026-02-01', lines: [{ debit: '4111', credit: '704', suma: 450000 }] }], angajati: [{ id: 'a' }] }, '2026-03');
ok('D100: peste 80% din plafon -> avertisment de urmarire (nu de depasire)', d100warn.avertismente.some((w) => /din plafonul micro/.test(w)) && !d100warn.avertismente.some((w) => /DEPASESC/.test(w)));
eq('D100: venitul anual cumulat pentru controlul plafonului', d100over.venitAn, 600000);

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
// In decont intra DOAR partea dedusa, cu baza ei proportionala: validatorul oficial cere
// raportul baza/TVA egal cu cota (regula R84), iar `pro_rata` declarat nu il relaxeaza.
eq('auto50: D300 primeste baza proportionala cu TVA-ul dedus', JSON.stringify(vjA50.coteC), '[{"cota":21,"baza":500,"tva":105}]');
const aA50 = xml.d300Rows(rep.d300(auto50Db, '2026-06'));
eq('auto50: randul NU mai dispare din D300 (R22 = achizitii 21%)', aA50.R22_1 + '/' + aA50.R22_2, '500/105');
eq('auto50: raportul baza/TVA din decont da exact cota (regula R84)', Math.round((aA50.R22_2 / aA50.R22_1) * 100), 21);
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
// Suprascriere manuala a plafonului (opts.pierdereRecuperabilaPct).
const ptOverride = acc.profitTax({ entries: ptAdjEnt }, '2026', { cota: 16, pierdereReportata: 5000, pierdereRecuperabilaPct: 100 });
eq('2026 + override 100% -> pierdere folosita 4000 (ca regimul vechi)', ptOverride.pierdereFolosita, 4000);
const ptLossYr = acc.profitTax({ entries: [{ id: '1', period: '2026-03', data: '2026-03-01', lines: [{ debit: '4111', credit: '707', suma: 3000 }] }, { id: '2', period: '2026-04', data: '2026-04-01', lines: [{ debit: '607', credit: '371', suma: 8000 }] }] }, '2026', { cota: 16, pierdereReportata: 1000 });
eq('an pe pierdere -> impozit 0 (plafonul nu se aplica pe baza negativa)', ptLossYr.impozit, 0);
eq('pierdere curenta 5000 + reportata 1000 = 6000 de reportat', ptLossYr.pierdereDeReportat, 6000);

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

section('Registrul depunerilor + portofoliu');
const declMod = require('../src/declarations');
eq('termen D300 pentru iunie', declMod.dueDate('d300', '2026-06'), '2026-07-25');
eq('termen D112 pentru decembrie (trece anul)', declMod.dueDate('d112', '2026-12'), '2027-01-25');
eq('termen SAF-T: ultima zi a lunii urmatoare', declMod.dueDate('saft', '2026-06'), '2026-07-31');
eq('termen SAF-T decembrie: 31 ianuarie', declMod.dueDate('saft', '2026-12'), '2027-01-31');
const vDecl = scopedSeed(); // firma platitoare de TVA, cu angajati
const expIun = declMod.expectedForFirma(vDecl, '2026-06');
eq('asteptate iunie: d300+d394+d112+d100+saft (TVA lunar)', expIun.map((x) => x.tip).join(','), 'd300,d394,d112,d100,saft');
eq('asteptate mai: fara d100, dar cu saft lunar', declMod.expectedForFirma(vDecl, '2026-05').map((x) => x.tip).join(','), 'd300,d394,d112,saft');
eq('neplatitor TVA: saft doar trimestrial', declMod.expectedForFirma({ company: { tvaPlatitor: false }, angajati: [] }, '2026-06').map((x) => x.tip).join(','), 'd100,saft');
// PFA: fara D100 (impozitul merge prin Declaratia Unica) si fara SAF-T
eq('PFA platitor TVA: doar d300+d394 (fara d100/saft)', declMod.expectedForFirma({ company: { tvaPlatitor: true, tipEntitate: 'pfa' }, angajati: [], entries: [] }, '2026-06').map((x) => x.tip).join(','), 'd300,d394');
eq('PFA neplatitor fara angajati: nicio declaratie lunara', declMod.expectedForFirma({ company: { tvaPlatitor: false, tipEntitate: 'pfa' }, angajati: [], entries: [] }, '2026-06').length, 0);
const livPfa = rep.livrabile({ company: { tipEntitate: 'pfa' }, entries: [], openingBalances: {} }, '2026-06');
ok('livrabile PFA: fara D100 micro / SAF-T / D101 / situatii financiare / AGA', !livPfa.list.some((x) => [9, 12, 15, 16, 19].includes(x.nr)));
ok('livrabile PFA: Declaratia Unica prezenta cu sumarul ei', livPfa.list.some((x) => /Declaratia Unica/.test(x.nume)) && livPfa.sumar.du && livPfa.sumar.du.venitNet === 0);
// livrabile micro/profit: D101 (nr 16) apare doar la regimul de profit
ok('livrabile micro: fara D101 in checklist', !rep.livrabile({ company: { tipEntitate: 'srl', regimImpozit: 'micro' }, entries: [], openingBalances: {} }, '2026-06').list.some((x) => x.nr === 16));
ok('livrabile profit: cu D101 in checklist', rep.livrabile({ company: { tipEntitate: 'srl', regimImpozit: 'profit' }, entries: [], openingBalances: {} }, '2026-06').list.some((x) => x.nr === 16));
eq('neplatitor TVA: luna non-trimestriala fara obligatii', declMod.expectedForFirma({ company: { tvaPlatitor: false }, angajati: [] }, '2026-05').length, 0);
const vIC = { company: { tvaPlatitor: true }, angajati: [], entries: [{ tip: 'livrare_intracomunitara', period: '2026-05', data: '2026-05-10' }] };
ok('D390 asteptata DOAR in lunile cu operatiuni intracomunitare',
  declMod.expectedForFirma(vIC, '2026-05').some((x) => x.tip === 'd390') && !declMod.expectedForFirma(vIC, '2026-04').some((x) => x.tip === 'd390'));
ok('asteptate decembrie include saft', declMod.expectedForFirma(vDecl, '2026-12').some((x) => x.tip === 'saft'));
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
eq('profit: D100 (avans) + D101 in decembrie', fp.expected(fp.build({ tvaPlatitor: true, regimImpozit: 'profit' }, {}), '2026-12', noIntra).filter((t) => t === 'd100' || t === 'd101').join(','), 'd100,d101');
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
eq('netrimise: doar vanzarile B2B fara spv', efx.count, 2);
eq('netrimise: restante (termen depasit)', efx.overdue, 1);
eq('netrimise: termen = data + 5 zile CALENDARISTICE (OUG 89/2025)', efx.items.find((x) => x.entryId === 'e1').due, '2026-07-23');
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

section('Logging structurat (src/log.js)');
const logger = require('../src/log');
ok('log expune info/warn/error/debug + ctx', ['info', 'warn', 'error', 'debug', 'ctx'].every((k) => typeof logger[k] === 'function'));
const lctx = logger.ctx({ reqId: 'ab12cd34', method: 'POST', originalUrl: '/api/entries', user: { id: 9, username: 'gigel' } }, { status: 500 });
eq('ctx: reqId din cerere', lctx.reqId, 'ab12cd34');
eq('ctx: userId din req.user', lctx.userId, 9);
eq('ctx: username din req.user', lctx.user, 'gigel');
eq('ctx: ruta', lctx.url, '/api/entries');
eq('ctx: extra (status) pastrat', lctx.status, 500);
ok('ctx fara cerere: nu arunca', typeof logger.ctx(null, { job: 'x' }) === 'object');

section('Config fiscal centralizat & datat (src/fiscalConfig.js)');
const fconf = require('../src/fiscalConfig');
// documentTypes e un director de module: poarta negativa scaneaza toate fisierele lui
const dtDir = require('path').join(__dirname, '..', 'src', 'documentTypes');
const dtSrc = require('fs').readdirSync(dtDir).filter((f) => f.endsWith('.js'))
  .map((f) => require('fs').readFileSync(require('path').join(dtDir, f), 'utf8')).join('\n');
ok('fiscalConfig are AN si DATA_ACTUALIZARE', typeof fconf.AN === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(fconf.DATA_ACTUALIZARE));
eq('FISCAL provine din fiscalConfig.RATES (sursa unica) — cas', fiscal.FISCAL.cas, fconf.RATES.cas);
eq('FISCAL provine din fiscalConfig.RATES — tvaStandard', fiscal.FISCAL.tvaStandard, fconf.RATES.tvaStandard);
eq('anul FISCAL == fiscalConfig.AN', fiscal.FISCAL.an, fconf.AN);
// bug reparat: taxePfa fara salariuMinim explicit nu mai da NaN (folosea FISCAL.salariuMinim inexistent)
const pfaCfg = fiscal.taxePfa(120000, { period: '2026-03' });
ok('taxePfa fara salariuMinim explicit: valori finite (nu NaN)', Number.isFinite(pfaCfg.cas) && Number.isFinite(pfaCfg.cass) && Number.isFinite(pfaCfg.impozit));
eq('taxePfa: salariul minim implicit = S1 (martie)', pfaCfg.salariuMinim, fconf.RATES.salariuMinimS1);
// tipul „import vamal" isi ia cota TVA din config, nu dintr-un 21 hardcodat
const vam = getType('import_vamal');
eq('import vamal: cota TVA implicita = tvaStandard', (vam.fields.find((f) => f.name === 'cota') || {}).default, fiscal.FISCAL.tvaStandard);
// poarta negativa: TVA-ul standard nu mai e hardcodat ca 21 in documentTypes
ok('documentTypes: fara cota TVA hardcodata (default: 21 / || 21)', !/default: 21\b/.test(dtSrc) && !/\|\| 21\)/.test(dtSrc));

section('Modularizare frontend: vizualizator documente (Etapa 8, public/viewer.js)');
const viewerJs = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'viewer.js'), 'utf8');
ok('viewer.js importa $ si toast din core.js', /import \{[^}]*\btoast\b[^}]*\} from '\.\/core\.js'/.test(viewerJs));
ok('viewer.js contine functiile vizualizatorului', /function openViewer\b/.test(viewerJs) && /function renderEfactura\b/.test(viewerJs) && /function openXmlViewer\b/.test(viewerJs));
ok('viewer.js intercepteaza click-urile pe link-uri (/pdf, /csv, /xml)', /addEventListener\('click'/.test(viewerJs) && /efactura/.test(viewerJs) && /openXmlViewer\(/.test(viewerJs));
ok('app.js importa viewer.js (efect secundar)', /import '\.\/viewer\.js'/.test(appJs));
ok('app.js NU mai defineste vizualizatorul (mutat in viewer.js)', !/function openViewer\b/.test(appJs) && !/function renderEfactura\b/.test(appJs));

section('Politica de parole (validatePassword)');
const authlib = require('../src/auth');
ok('parola de 8+ caractere e acceptata', authlib.validatePassword('parolabuna1') === null);
ok('parola prea scurta e respinsa', /prea scurta/i.test(authlib.validatePassword('scurt1') || ''));
ok('parola comuna „password" e respinsa', /prea comuna/i.test(authlib.validatePassword('password') || ''));
ok('parola implicita „admin" e respinsa (prea scurta sau comuna)', authlib.validatePassword('admin') !== null);
ok('parola = utilizator e respinsa', /identica cu numele/i.test(authlib.validatePassword('gigelgigel', { username: 'gigelgigel' }) || ''));
ok('parola diferita de utilizator trece', authlib.validatePassword('altaparola9', { username: 'gigel' }) === null);

section('Nume de utilizator: normalizare si regula unica de duplicat');
// Numele apare in listele de utilizatori, in jurnalul de audit si in portofoliu. Nu era validat
// pe caractere nicaieri, iar cele DOUA cai de creare aveau reguli diferite: inscrierea publica
// verifica duplicatele insensibil la litere mari/mici, iar calea de admin SENSIBIL si fara trim —
// deci putea lasa sa coexiste „ana", „Ana" si „ana ", conturi care arata identic pe ecran.
eq('spatiile de la capete se scot', authlib.normalizeUsername('  ana  '), 'ana');
eq('sirurile de spatii interioare se strang', authlib.normalizeUsername('a  n   a'), 'a n a');
eq('null nu arunca', authlib.normalizeUsername(null), '');
ok('numele obisnuit e acceptat', authlib.validateUsername('gigel') === null);
ok('numele cu spatiu simplu e acceptat', authlib.validateUsername('Ana Maria') === null);
ok('diacriticele romanesti sunt acceptate', authlib.validateUsername('Ștefan Ioniță') === null);
ok('numele prea scurt e respins', /prea scurt/i.test(authlib.validateUsername('ab') || ''));
ok('numele prea lung e respins', /prea lung/i.test(authlib.validateUsername('x'.repeat(70)) || ''));
// caractere care fac doua nume sa arate IDENTIC pe ecran fara sa fie egale
ok('zero-width space e respins', authlib.validateUsername('an​a') !== null);
ok('marcajul bidirectional (RLO) e respins', authlib.validateUsername('an‮a') !== null);
ok('caracterul NUL e respins', authlib.validateUsername('an a') !== null);
// BOM si TAB sunt in clasa \s a JS, deci normalizarea ii transforma intr-un spatiu VIZIBIL
// inainte de verificare — mascarea dispare oricum, doar pe alta cale decat respingerea.
eq('BOM-ul devine spatiu vizibil, nu ramane invizibil', authlib.normalizeUsername('an\ufeffa'), 'an a');
eq('TAB-ul devine spatiu vizibil', authlib.normalizeUsername('an\ta'), 'an a');
// duplicatele: aceeasi regula, indiferent de calea de creare
const uLista = [{ username: 'admin' }, { username: 'Ana Maria' }];
ok('duplicat exact', authlib.usernameTaken(uLista, 'admin'));
ok('duplicat cu litere mari', authlib.usernameTaken(uLista, 'ADMIN'));
ok('duplicat cu spatii la capete', authlib.usernameTaken(uLista, '  admin '));
ok('duplicat cu spatii interioare in plus', authlib.usernameTaken(uLista, 'Ana  Maria'));
ok('un nume nou nu e duplicat', !authlib.usernameTaken(uLista, 'altcineva'));
ok('lista goala nu arunca', !authlib.usernameTaken(null, 'oricine'));
// regula se aplica DOAR la creare: un nume deja existent care n-ar mai trece azi ramane valid
ok('un nume vechi invalid azi e totusi gasit ca duplicat', authlib.usernameTaken([{ username: 'ab' }], 'ab'));

section('Handlerul global de erori (src/serverErrors.js)');
// Ultimul modul din src/ ramas fara nicio verificare. E plasa de siguranta: decide ce vede
// CLIENTUL cand ceva crapa. O regresie aici scurge mesaje interne (interogari, cai de fisier,
// stack) catre oricine trimite o cerere care esueaza — si se observa greu, fiindca aplicatia
// „merge" mai departe.
const serverErrors = require('../src/serverErrors');
let errHandler = null;
serverErrors.installErrorHandler({ use: (fn) => { errHandler = fn; } });
ok('handlerul se inregistreaza ca middleware de erori (4 argumente)', typeof errHandler === 'function' && errHandler.length === 4);
const fakeRes = () => {
  const r = { code: 0, body: null, headersSent: false };
  r.status = (c) => { r.code = c; return r; };
  r.json = (bd) => { r.body = bd; return r; };
  return r;
};
const fakeReq = (x) => Object.assign({ method: 'GET', originalUrl: '/api/ceva', reqId: 'abc12345' }, x || {});
// logarea 5xx scrie pe stderr; o tacem doar pe durata acestor verificari, ca sa nu polueze suita
const errPrev = console.error; const writePrev = process.stderr.write.bind(process.stderr);
console.error = () => {}; process.stderr.write = () => true;
const r500 = fakeRes();
const eIntern = new Error('SELECT parola FROM users WHERE id=1 a esuat la /var/www/contab/data/db.json');
errHandler(eIntern, fakeReq(), r500, () => {});
const r400 = fakeRes();
errHandler(Object.assign(new Error('Completeaza cel putin o suma.'), { status: 400 }), fakeReq(), r400, () => {});
const rCode = fakeRes();
errHandler(Object.assign(new Error('Interzis.'), { statusCode: 403 }), fakeReq(), rCode, () => {});
let nextPrimit = null;
const rSent = fakeRes(); rSent.headersSent = true;
errHandler(eIntern, fakeReq(), rSent, (e) => { nextPrimit = e; });
console.error = errPrev; process.stderr.write = writePrev;

const body500 = JSON.stringify(r500.body || {});
eq('eroarea fara status devine 500', r500.code, 500);
ok('5xx NU scurge mesajul intern catre client', !body500.includes('SELECT') && !body500.includes('parola'));
ok('5xx NU scurge cai de fisier de pe server', !body500.includes('/var/www'));
ok('5xx NU trimite stack-ul', !body500.includes(' at ') && !body500.includes('.js:'));
ok('5xx da un mesaj generic, util utilizatorului', /eroare interna/i.test((r500.body || {}).error || ''));
eq('5xx include reqId, ca eroarea sa poata fi corelata cu logul', (r500.body || {}).reqId, 'abc12345');
// 4xx sunt erori de BUSINESS: mesajul e scris pentru utilizator si trebuie sa ajunga la el
eq('4xx pastreaza statusul', r400.code, 400);
eq('4xx pastreaza mesajul de business', (r400.body || {}).error, 'Completeaza cel putin o suma.');
ok('4xx NU include reqId (nu e un incident de server)', (r400.body || {}).reqId === undefined);
eq('statusCode e onorat, nu doar status', rCode.code, 403);
eq('4xx prin statusCode isi pastreaza mesajul', (rCode.body || {}).error, 'Interzis.');
// daca raspunsul a plecat deja (ex. un export in flux), handlerul nu mai scrie peste el
ok('cu antetele deja trimise, eroarea urca la Express', nextPrimit === eIntern);
eq('cu antetele deja trimise nu se scrie un al doilea raspuns', rSent.code, 0);

section('Banner de pornire: adresele afisate (src/lifecycle.js)');
// Banner-ul enumera interfetele publice; daca o face si cand serverul e legat la loopback,
// spune ceva NEADEVARAT — un „Retea: http://<ip-public>:8080" care nu raspunde (endpointul
// public e nginx). Cine citeste logul trage concluzii gresite despre ce e expus.
const { bannerUrls } = require('../src/lifecycle');
const ifTest = { eth0: [{ family: 'IPv4', address: '203.0.113.7', internal: false }], lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] };
const bLoop = bannerUrls('127.0.0.1', 8080, ifTest);
eq('legat la loopback: doar adresa locala', bLoop.length, 1);
ok('legat la loopback NU se anunta interfata publica', !bLoop.join(' ').includes('203.0.113.7'));
ok('adresa locala e mereu afisata', bLoop[0].includes('http://localhost:8080'));
eq('„localhost" e tratat tot ca loopback', bannerUrls('localhost', 8080, ifTest).length, 1);
eq('IPv6 loopback e tratat la fel', bannerUrls('::1', 8080, ifTest).length, 1);
// legat pe toate interfetele: atunci anuntul e corect si util
const bAll = bannerUrls('0.0.0.0', 8080, ifTest);
eq('legat pe toate interfetele: local + retea', bAll.length, 2);
ok('se anunta interfata publica reala', bAll.join(' ').includes('http://203.0.113.7:8080'));
ok('interfetele interne nu se anunta ca „retea"', !bAll.slice(1).join(' ').includes('127.0.0.1'));
eq('fara interfete nu arunca', bannerUrls('0.0.0.0', 8080, null).length, 1);

section('Igiena data/: rotatia backup-urilor ad-hoc (src/backup.js)');
const backupMod = require('../src/backup');
const fsB = require('fs'); const osB = require('os'); const pathB = require('path');
const tmpB = fsB.mkdtempSync(pathB.join(osB.tmpdir(), 'contab-bak-'));
// 12 backup-uri ad-hoc + 2 fisiere de migrare (de pastrat)
for (let k = 0; k < 12; k++) { const f = pathB.join(tmpB, 'db.json.bak-op' + k); fsB.writeFileSync(f, 'x'); const t = Date.now() - (12 - k) * 1000; fsB.utimesSync(f, t / 1000, t / 1000); }
fsB.writeFileSync(pathB.join(tmpB, 'db.pre-pg.json'), 'x');
fsB.writeFileSync(pathB.join(tmpB, 'db.pre-sqlite.json'), 'x');
const rB = backupMod.pruneStrayBackups(tmpB, 10);
eq('rotatie: sterge peste ultimele 10', rB.removed, 2);
eq('rotatie: pastreaza 10', fsB.readdirSync(tmpB).filter((f) => /^db\.json\.bak-/.test(f)).length, 10);
ok('rotatie: NU atinge db.pre-*.json (migrare)', fsB.existsSync(pathB.join(tmpB, 'db.pre-pg.json')) && fsB.existsSync(pathB.join(tmpB, 'db.pre-sqlite.json')));
ok('rotatie: pastreaza cele mai NOI', fsB.existsSync(pathB.join(tmpB, 'db.json.bak-op11')) && !fsB.existsSync(pathB.join(tmpB, 'db.json.bak-op0')));
try { fsB.rmSync(tmpB, { recursive: true, force: true }); } catch (_) { /* ignora */ }

section('Stripe webhook: deduplicare pe event.id (src/billing.js)');
const billingMod = require('../src/billing');
const stgs = {};
ok('eveniment nou: nevazut', !billingMod.seenEvent(stgs, 'evt_1'));
billingMod.rememberEvent(stgs, 'evt_1');
ok('dupa procesare: vazut (livrarea dubla se sare)', billingMod.seenEvent(stgs, 'evt_1'));
ok('alt eveniment: nevazut', !billingMod.seenEvent(stgs, 'evt_2'));
billingMod.rememberEvent(stgs, null);
ok('id lipsa: nu crapa si nu se inregistreaza', !stgs.stripeEventIds.null && Object.keys(stgs.stripeEventIds).length === 1);
ok('seenEvent tolereaza settings gol/necunoscut', !billingMod.seenEvent({}, 'evt_1') && !billingMod.seenEvent(null, 'evt_1'));
// rotatia istoricului: peste MAX_SEEN_EVENTS se taie cele mai VECHI (ordinea inserarii)
const stgs2 = {};
for (let k = 0; k < billingMod.MAX_SEEN_EVENTS + 10; k++) billingMod.rememberEvent(stgs2, 'evt_' + k);
eq('rotatie: istoricul e plafonat', Object.keys(stgs2.stripeEventIds).length, billingMod.MAX_SEEN_EVENTS);
ok('rotatie: cele mai vechi au iesit', !billingMod.seenEvent(stgs2, 'evt_0') && !billingMod.seenEvent(stgs2, 'evt_9'));
ok('rotatie: cele mai noi raman', billingMod.seenEvent(stgs2, 'evt_10') && billingMod.seenEvent(stgs2, 'evt_' + (billingMod.MAX_SEEN_EVENTS + 9)));

section('Service layer stocuri: autorizarea dublata pe firma (src/stocksService.js)');
const ssvc = require('../src/stocksService');
const dbx = db.get();
const fidOk = dbx.firme[0].id;
/** ruleaza fn si intoarce statusul erorii de business (sau null daca nu arunca) */
const errStatus = (fn) => { try { fn(); return null; } catch (e) { return e.status || 500; } };
eq('firma inexistenta -> 403', errStatus(() => ssvc.upsertProduct(9999, { cod: 'X', denumire: 'X' })), 403);
eq('firma lipsa (null) -> 403', errStatus(() => ssvc.addMovement(null, 'op', { productId: 'p1', tip: 'receptie', cantitate: 1, data: '2026-01-01' })), 403);
eq('santinela NO_FIRMA (-1) -> 403, fara fallback pe firma activa', errStatus(() => ssvc.upsertGestiune(-1, { cod: 'G', denumire: 'G' })), 403);
const rp = ssvc.upsertProduct(fidOk, { cod: 'SVC-1', denumire: 'Produs service', um: 'buc', cont: '371' });
ok('creare produs prin serviciu (firma valida)', rp.created && rp.product.firmaId === fidOk);
// izolare: aceeasi resursa, ceruta din ALTA firma — serviciul refuza indiferent de apelant
dbx.firme.push({ id: 7777, nume: 'ALT SRL', cui: '77' });
eq('stergerea produsului din alta firma -> 404', errStatus(() => ssvc.deleteProduct(7777, rp.product.id)), 404);
eq('miscare pe produsul altei firme -> 400 (produs inexistent)', errStatus(() => ssvc.addMovement(7777, 'op', { productId: rp.product.id, tip: 'receptie', cantitate: 1, data: '2026-01-01' })), 400);
eq('storno pe inventarul altei firme -> 404', errStatus(() => ssvc.stornoInventory(7777, 'op', 'inv-inexistent', null)), 404);
ssvc.deleteProduct(fidOk, rp.product.id); // produs FARA miscari -> stergere permisa (creat din greseala)
ok('produs fara miscari: stergerea merge', !db.get().products.some((p) => p.id === rp.product.id));
dbx.firme = dbx.firme.filter((f) => f.id !== 7777); // curatenie (doar in memorie)

// ── STERGERE PRODUS vs DEZACTIVARE (fisa de magazie / cartea mare nu diverg) ──
{
  const pu = ssvc.upsertProduct(fidOk, { cod: 'USE-1', denumire: 'Produs folosit', um: 'buc', cont: '371' }).product;
  const gU = ssvc.upsertGestiune(fidOk, { cod: 'GU', denumire: 'Gest U' }).gestiune;
  ssvc.addMovement(fidOk, 'op', { productId: pu.id, tip: 'receptie', cantitate: 3, data: '2026-06-05', pretUnitar: 10, gestiuneId: gU.id });
  eq('produs CU miscari: stergerea e refuzata (400)', errStatus(() => ssvc.deleteProduct(fidOk, pu.id)), 400);
  ok('mesajul indruma spre dezactivare', (() => { try { ssvc.deleteProduct(fidOk, pu.id); return false; } catch (e) { return /[Dd]ezactiveaza/.test(e.message); } })());
  ssvc.setProductActive(fidOk, pu.id, false);
  ok('produsul dezactivat ramane in nomenclator (istoric intact)', db.get().products.some((p) => p.id === pu.id && p.activ === false));
  eq('produs dezactivat: miscare noua refuzata (400)', errStatus(() => ssvc.addMovement(fidOk, 'op', { productId: pu.id, tip: 'receptie', cantitate: 1, data: '2026-06-06', gestiuneId: gU.id })), 400);
  ssvc.setProductActive(fidOk, pu.id, true);
  ok('reactivat: miscarile noi merg din nou', !!ssvc.addMovement(fidOk, 'op', { productId: pu.id, tip: 'receptie', cantitate: 1, data: '2026-06-07', pretUnitar: 10, gestiuneId: gU.id }).movement);
  // curatenie
  db.get().stockMovements = db.get().stockMovements.filter((m) => m.productId !== pu.id);
  db.get().products = db.get().products.filter((p) => p.id !== pu.id);
  db.get().gestiuni = db.get().gestiuni.filter((g) => g.id !== gU.id);
}

// ── COLABORATORI PE FIRMA (contabil <-> necontabil): firmeService ──
section('Colaboratori pe firmă (src/firmeService.js)');
{
  const fsvc = require('../src/firmeService');
  const dC = db.get();
  const fidC = db.nextFirmaId();
  dC.firme.push({ id: fidC, nume: 'Colab SRL', subscription: { status: 'active', plan: 'grandfathered' } });
  // id-uri manuale unice (db.nextUserId() citeste starea curenta; 3 apeluri inainte de push ar da acelasi id)
  const owner = { id: 90001, username: 'proprietar', role: 'user', firme: [fidC], firmaActiva: fidC };
  const acc = { id: 90002, username: 'contabilx', email: 'c@x.ro', role: 'user', firme: [999], subscription: { status: 'active', plan: 'pro' } };
  const adminU = { id: 90003, username: 'adminx', role: 'admin' };
  dC.users.push(owner, acc, adminU);
  db.save();
  eq('list: initial doar proprietarul', fsvc.listCollaborators(fidC).map((c) => c.username).join(','), 'proprietar');
  // adaugare cont existent (dupa email) -> capata acces
  const added = fsvc.addExistingCollaborator(fidC, { email: 'c@x.ro' });
  eq('addExisting: contabilx capata firma', added.username + ':' + db.get().users.find((u) => u.id === acc.id).firme.includes(fidC), 'contabilx:true');
  eq('addExisting: contabil recunoscut ca tip', added.tip, 'contabil');
  eq('addExisting: dubla -> 400', errStatus(() => fsvc.addExistingCollaborator(fidC, { username: 'contabilx' })), 400);
  eq('addExisting: cont inexistent -> 404', errStatus(() => fsvc.addExistingCollaborator(fidC, { username: 'nimeni' })), 404);
  eq('addExisting: adminul deja are acces -> 400', errStatus(() => fsvc.addExistingCollaborator(fidC, { username: 'adminx' })), 400);
  // invitatie noua -> pending user cu firme:[fidC]
  const inv = fsvc.inviteCollaborator(fidC, { username: 'invitatnou', email: 'i@x.ro' });
  ok('inviteNew: token + pending user cu acces la firma', inv.token.length === 48 && db.get().users.find((u) => u.id === inv.user.id).firme.includes(fidC) && db.get().users.find((u) => u.id === inv.user.id).pending === true);
  eq('inviteNew: username existent -> 400', errStatus(() => fsvc.inviteCollaborator(fidC, { username: 'contabilx' })), 400);
  eq('list: acum 3 (proprietar + contabilx + invitatnou pending)', fsvc.listCollaborators(fidC).length, 3);
  ok('list: invitatia apare cu pending=true', fsvc.listCollaborators(fidC).some((c) => c.username === 'invitatnou' && c.pending));
  // scoatere
  fsvc.removeCollaborator(fidC, acc.id);
  ok('remove: contabilx pierde accesul', !db.get().users.find((u) => u.id === acc.id).firme.includes(fidC));
  eq('remove: non-colaborator -> 404', errStatus(() => fsvc.removeCollaborator(fidC, acc.id)), 404);
  eq('remove: admin -> 404 (nu e colaborator per-firma)', errStatus(() => fsvc.removeCollaborator(fidC, adminU.id)), 404);
  // pana ramane doar proprietarul: scot invitatia, apoi refuz scoaterea ultimului
  fsvc.removeCollaborator(fidC, inv.user.id);
  eq('remove: ultimul utilizator -> 400 (firma nu ramane orfana)', errStatus(() => fsvc.removeCollaborator(fidC, owner.id)), 400);
  // curatenie
  db.get().firme = db.get().firme.filter((f) => f.id !== fidC);
  db.get().users = db.get().users.filter((u) => ![owner.id, acc.id, adminU.id, inv.user.id].includes(u.id));
  db.save();
}

// ── PERIOADA INCHISA: garda unica (db.assertPeriodOpen) uniforma pe serviciile datate ──
{
  const firmaLk = db.getFirma(fidOk);
  const lkPrev = firmaLk.lockedUntil;
  firmaLk.lockedUntil = '2026-03'; // luni <= 2026-03 sunt inchise
  const pLk = ssvc.upsertProduct(fidOk, { cod: 'LK-1', denumire: 'Prod lock', um: 'buc', cont: '371' }).product;
  eq('stoc: miscare in luna INCHISA -> 400', errStatus(() => ssvc.addMovement(fidOk, 'op', { productId: pLk.id, tip: 'receptie', cantitate: 5, data: '2026-02-10', pretUnitar: 10 })), 400);
  ok('mesajul indruma spre storno', (() => { try { ssvc.addMovement(fidOk, 'op', { productId: pLk.id, tip: 'receptie', cantitate: 5, data: '2026-02-10' }); return false; } catch (e) { return /STORNO/i.test(e.message); } })());
  const mvDeschis = ssvc.addMovement(fidOk, 'op', { productId: pLk.id, tip: 'receptie', cantitate: 5, data: '2026-06-10', pretUnitar: 10 }).movement;
  ok('stoc: miscare in luna DESCHISA -> merge', !!mvDeschis.id);
  // stergerea unei miscari dintr-o luna inchisa -> blocata (nu rupe nici nota legata)
  const mvInchis = { id: db.nextId('sm'), firmaId: fidOk, data: '2026-02-15', tip: 'receptie', productId: pLk.id, cantitate: 1, pretUnitar: 1 };
  db.get().stockMovements.push(mvInchis);
  eq('stoc: stergere miscare din luna inchisa -> 400', errStatus(() => ssvc.deleteMovement(fidOk, mvInchis.id)), 400);
  eq('inventar in luna inchisa -> 400', errStatus(() => ssvc.createInventory(fidOk, 'op', { gestiuneId: 'nope', data: '2026-02-01', lines: [] })), 400);
  eq('preluare stoc initial in luna inchisa -> 400', errStatus(() => ssvc.importInitialStock(fidOk, 'op', { data: '2026-02-01', csv: 'cod;den\nX;Y' })), 400);
  // salarii postate intr-o luna inchisa -> blocate
  const psvc = require('../src/payrollService');
  eq('salarii: postare in luna inchisa -> 400', errStatus(() => psvc.postStatPlata(fidOk, '2026-02', { buildEntry: () => ({ lines: [] }) })), 400);
  // curatenie
  db.get().stockMovements = db.get().stockMovements.filter((m) => m.id !== mvDeschis.id && m.id !== mvInchis.id);
  db.get().products = db.get().products.filter((p) => p.id !== pLk.id);
  firmaLk.lockedUntil = lkPrev;
}

section('Serii de documente prin service layer (docSeries / assignDocNumber)');
eq('seriile firmei inexistente -> 403', errStatus(() => ssvc.docSeries(9999)), 403);
eq('actualizarea seriilor pe firma invalida -> 403', errStatus(() => ssvc.updateDocSeries(null, { NIR: { serie: 'X' } })), 403);
eq('numerotare pe firma invalida -> 403', errStatus(() => ssvc.assignDocNumber(-1, 'NIR', [])), 403);
const serii = ssvc.docSeries(fidOk);
ok('seriile implicite exista (NIR/BC/AVIZ/CH)', serii.NIR && serii.BC && serii.AVIZ && serii.CH);
const mv1 = { id: 'dn1' }; const mv2 = { id: 'dn2' };
const nrStart = serii.NIR.next;
const nr1 = ssvc.assignDocNumber(fidOk, 'NIR', [mv1, mv2]);
ok('numarul e atribuit intregului grup', mv1.docNr.NIR === nr1 && mv2.docNr.NIR === nr1 && nr1.startsWith(serii.NIR.serie + '-'));
eq('seria avanseaza', ssvc.docSeries(fidOk).NIR.next, nrStart + 1);
eq('retiparirea REFOLOSESTE numarul (nu consuma serie)', ssvc.assignDocNumber(fidOk, 'NIR', [mv1, mv2]), nr1);
eq('seria nu a avansat la refolosire', ssvc.docSeries(fidOk).NIR.next, nrStart + 1);

section('Service layer cont (src/accountService.js)');
const asvc = require('../src/accountService');
const authT = require('../src/auth');
const totpT = require('../src/totp');
// garda pe contul demo: refuzata la nivel de serviciu, nu doar in ruta
const demoAcc = { username: 'demo' };
eq('demo: setup 2FA -> 403', errStatus(() => asvc.setup2fa(demoAcc)), 403);
eq('demo: schimbare parola -> 403', errStatus(() => asvc.changePassword(demoAcc, 'a', 'parola-noua-2026')), 403);
eq('demo: actualizare profil -> 403', errStatus(() => asvc.updateProfile(demoAcc, { email: 'spam@x.ro' })), 403);
eq('demo: revocare dispozitive -> 403', errStatus(() => asvc.revokeTrustedDevices(demoAcc)), 403);
// schimbarea parolei: gardele si efectul
const hpT = authT.hashPassword('parola-veche-123');
const u1 = { username: 'tester-cont', salt: hpT.salt, hash: hpT.hash, mustChange: true, sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] };
eq('parola veche gresita -> 400', errStatus(() => asvc.changePassword(u1, 'gresita', 'parola-noua-2026')), 400);
eq('parola noua slaba -> 400', errStatus(() => asvc.changePassword(u1, 'parola-veche-123', 'ab1')), 400);
eq('parola noua = cea veche -> 400', errStatus(() => asvc.changePassword(u1, 'parola-veche-123', 'parola-veche-123')), 400);
asvc.changePassword(u1, 'parola-veche-123', 'parola-noua-2026');
ok('schimbare valida: hash nou + mustChange resetat', authT.verifyPassword('parola-noua-2026', u1.salt, u1.hash) && u1.mustChange === false);
// fluxul 2FA: setup -> enable (cod real) -> disable, cu gardele de stare
eq('enable fara setup -> 400', errStatus(() => asvc.enable2fa(u1, '123456')), 400);
const s2fa = asvc.setup2fa(u1);
ok('setup: secret + otpauth + QR', !!s2fa.secret && /^otpauth:\/\/totp\//.test(s2fa.otpauth) && /<svg/.test(s2fa.qrSvg));
eq('enable cu cod gresit -> 400', errStatus(() => asvc.enable2fa(u1, '000000')), 400);
const codeNowT = () => totpT.codeForCounter(s2fa.secret, Math.floor(Date.now() / 1000 / 30));
const epoch0 = u1.tfdEpoch || 0;
asvc.enable2fa(u1, codeNowT());
ok('enable: activat, pending consumat, dispozitivele vechi invalidate', u1.twofa === true && !u1.pending2fa && u1.totpSecret === s2fa.secret && u1.tfdEpoch === epoch0 + 1);
eq('setup cu 2FA deja activ -> 400', errStatus(() => asvc.setup2fa(u1)), 400);
eq('disable cu cod gresit -> 400', errStatus(() => asvc.disable2fa(u1, '000000')), 400);
asvc.disable2fa(u1, codeNowT());
ok('disable: dezactivat + secret sters', u1.twofa === false && !u1.totpSecret);
eq('disable cand nu e activ -> 400', errStatus(() => asvc.disable2fa(u1, '000000')), 400);
// sesiuni: listare (curenta marcata, ordinea inversata) + logout-others + revocare
const sess = asvc.listSessions(u1, 's2');
ok('listare: cea mai noua prima + sesiunea curenta marcata', sess[0].id === 's3' && sess[0].current === false && sess.find((s) => s.id === 's2').current === true);
asvc.logoutOtherSessions(u1, 's2');
ok('logout-others pastreaza doar sesiunea curenta', u1.sessions.length === 1 && u1.sessions[0].id === 's2');
asvc.revokeSession(u1, 's2');
eq('revocare individuala: sesiunea dispare', u1.sessions.length, 0);
// profil: campuri albe curatate, cheile necunoscute ignorate, email + notificari
const prof = asvc.updateProfile(u1, { email: 'x@exemplu.ro', notifyDeadlines: false, profil: { numeComplet: '  Ion Pop  ', telefon: '0712', necunoscut: 'ignorat' } });
ok('profil: email + notificari + campuri curatate', prof.email === 'x@exemplu.ro' && prof.notifyDeadlines === false && prof.profil.numeComplet === 'Ion Pop' && prof.profil.necunoscut === undefined);
ok('getProfile reflecta starea', asvc.getProfile(u1).email === 'x@exemplu.ro' && asvc.getProfile(u1).notifyDeadlines === false);

section('Service layer articole contabile (src/entriesService.js)');
const esvc = require('../src/entriesService');
// buildEntry/upsertPartner sunt infrastructura din server.js (nu se poate require aici — porneste
// serverul); stub-uri minimale, serviciul e testat pe gardele si scrierile proprii
let partnerCalls = 0;
const stubDeps = {
  buildEntry: (tip, f, fileId, fid) => ({
    id: db.nextId('e'), firmaId: fid, data: f.data || '2026-06-15', period: String(f.data || '2026-06-15').slice(0, 7),
    tip, tipNume: 'Stub ' + tip, document: f.document || '', partener: f.partener || '', partenerCui: f.cuiPartener || '',
    explicatie: '', fileId: fileId || null, system: false, lines: [],
  }),
  upsertPartner: () => { partnerCalls += 1; },
};
const throwDeps = { buildEntry: () => { throw new Error('tip invalid'); }, upsertPartner: () => {} };
// gardele de firma (reqFirma refolosit din stocksService)
eq('creare pe firma inexistenta -> 403', errStatus(() => esvc.createEntry(9999, { tip: 'x' }, stubDeps)), 403);
eq('sablon recurent pe firma lipsa -> 403', errStatus(() => esvc.saveRecurring(null, { tip: 'x' })), 403);
eq('generare pe santinela NO_FIRMA -> 403', errStatus(() => esvc.generateRecurring(-1, '2026-06', stubDeps)), 403);
eq('exigibilitate TVA pe firma inexistenta -> 403', errStatus(() => esvc.tvaExigibilitate(9999, { brut: 100, cota: 21 }, stubDeps)), 403);
// creare: eroarea din buildEntry devine 400; succesul scrie si actualizeaza partenerul
eq('buildEntry esueaza -> 400', errStatus(() => esvc.createEntry(fidOk, { tip: 'necunoscut' }, throwDeps)), 400);
const ce = esvc.createEntry(fidOk, { tip: 'test_svc', fields: { data: '2026-06-10', document: 'SVC-E1' } }, stubDeps);
ok('creare: articolul e scris + upsertPartner apelat', db.get().entries.some((e) => e.id === ce.entry.id) && partnerCalls === 1 && ce.stoc === null);
// stergere: 404 fara acces, 400 in perioada inchisa; POSTAT nu se sterge (storno), doar ciornele
eq('stergere fara acces la firma -> 404', errStatus(() => esvc.deleteEntry(ce.entry.id, fidOk, () => false)), 404);
const firmaLockT = db.getFirma(fidOk); const lockPrev = firmaLockT.lockedUntil || null;
firmaLockT.lockedUntil = '2026-06';
eq('stergere in perioada inchisa -> 400', errStatus(() => esvc.deleteEntry(ce.entry.id, fidOk, () => true)), 400);
firmaLockT.lockedUntil = lockPrev;
eq('stergerea unui articol POSTAT -> 400 (corectie prin storno)', errStatus(() => esvc.deleteEntry(ce.entry.id, fidOk, () => true)), 400);
// storno generic: reversare legata + originalul marcat; re-storno refuzat
const stRes = esvc.stornoEntry(ce.entry.id, fidOk, () => true, '2026-06-30');
ok('storno: nota de reversare legata (stornoOf) + original marcat stornat', stRes.storno.stornoOf === ce.entry.id && stRes.original.stornat === true && stRes.storno.system === true);
eq('re-storno al aceluiasi articol -> 400', errStatus(() => esvc.stornoEntry(ce.entry.id, fidOk, () => true)), 400);
// ciorna: se creeaza cu status, NU intra in contabilitate si SE STERGE liber
const dr = esvc.createEntry(fidOk, { tip: 'test_svc', ciorna: true, fields: { data: '2026-06-11', document: 'SVC-DRAFT' } }, stubDeps);
eq('creare cu ciorna:true -> status ciorna', dr.entry.status, 'ciorna');
eq('storno pe o ciorna -> 400 (se sterge direct)', errStatus(() => esvc.stornoEntry(dr.entry.id, fidOk, () => true)), 400);
eq('stergerea unei ciorne: removed=1', esvc.deleteEntry(dr.entry.id, fidOk, () => true).removed, 1);
// flux de stare: ciorna -> validat -> postat; postat = ireversibil
const dr2 = esvc.createEntry(fidOk, { tip: 'test_svc', ciorna: true, fields: { data: '2026-06-11', document: 'SVC-DRAFT2' } }, stubDeps);
eq('avans ciorna->validat', esvc.setEntryStatus(dr2.entry.id, fidOk, () => true, 'validat').status, 'validat');
eq('avans validat->postat', esvc.setEntryStatus(dr2.entry.id, fidOk, () => true, 'postat').status, 'postat');
eq('postat: schimbarea starii -> 400', errStatus(() => esvc.setEntryStatus(dr2.entry.id, fidOk, () => true, 'ciorna')), 400);
eq('stare invalida -> 400', errStatus(() => esvc.setEntryStatus(dr2.entry.id, fidOk, () => true, 'xyz')), 400);
eq('id inexistent NU e eroare: removed=0 (contract istoric)', esvc.deleteEntry('e-inexistent', fidOk, () => true).removed, 0);
// recurente: validare + valori implicite + generare idempotenta pe perioada
eq('sablon fara tip -> 400', errStatus(() => esvc.saveRecurring(fidOk, {})), 400);
const rt = esvc.saveRecurring(fidOk, { tip: 'test_svc', partener: 'Chirias SRL', frecventa: 'gresita', ziua: 99, startDate: '2026-01' }).template;
ok('sablon: frecventa implicita + ziua plafonata la 28', rt.frecventa === 'lunar' && rt.ziua === 28 && rt.activ === true);
const gen1 = esvc.generateRecurring(fidOk, '2026-06', stubDeps);
ok('generare: 1 articol + lastGenerated setat', gen1.created.length === 1 && rt.lastGenerated === '2026-06' && db.get().entries.some((e) => e.recurringId === rt.id));
eq('regenerarea aceleiasi perioade nu dubleaza', esvc.generateRecurring(fidOk, '2026-06', stubDeps).created.length, 0);
const genErr = esvc.generateRecurring(fidOk, '2026-07', throwDeps);
ok('eroarea per sablon se aduna in errors, nu opreste generarea', genErr.created.length === 0 && genErr.errors.length === 1 && /tip invalid/.test(genErr.errors[0]));
esvc.deleteRecurring(fidOk, rt.id);
ok('stergerea sablonului', !(db.get().recurringInvoices || []).some((t) => t.id === rt.id));
db.get().entries = db.get().entries.filter((e) => e.recurringId !== rt.id); // curatenie
// blocarea perioadei: 404 pe firma inexistenta (contract istoric, nu 403), validare format
eq('period-lock pe firma inexistenta -> 404', errStatus(() => esvc.setPeriodLock(9999, '2026-05')), 404);
eq('period-lock cu format invalid -> 400', errStatus(() => esvc.setPeriodLock(fidOk, '05-2026')), 400);
eq('period-lock cu luna invalida -> 400', errStatus(() => esvc.setPeriodLock(fidOk, '2026-13')), 400);
eq('blocare valida', esvc.setPeriodLock(fidOk, '2026-05').lockedUntil, '2026-05');
eq('deblocare cu null', esvc.setPeriodLock(fidOk, null).lockedUntil, null);
// TVA la incasare: validare + calculul sutei marite + baza exigibila
eq('exigibilitate fara suma -> 400', errStatus(() => esvc.tvaExigibilitate(fidOk, { brut: 0, cota: 21 }, stubDeps)), 400);
const tvaR = esvc.tvaExigibilitate(fidOk, { brut: 1210, cota: 21 }, stubDeps);
ok('TVA din suta marita: 1210 la 21% -> 210, baza 1000, nota system', tvaR.tva === 210 && tvaR.entry.tvaExig.baza === 1000 && tvaR.entry.system === true && tvaR.entry.tip === 'exigibilitate_tva_colectata');
db.get().entries = db.get().entries.filter((e) => e.id !== tvaR.entry.id); // curatenie

section('Service layer mesagerie (src/messagesService.js)');
const msvc = require('../src/messagesService');
const msgsPure = require('../src/messages');
const dMsg = db.get(); dMsg.messages = dMsg.messages || []; dMsg.users = dMsg.users || [];
dMsg.users.push({ id: 9101, username: 'u-msg' }, { id: 9102, username: 'alt-user' });
const aUserM = { user: { id: 9101, username: 'u-msg' }, isAdmin: false };
const aAltM = { user: { id: 9102, username: 'alt-user' }, isAdmin: false };
const aAdminM = { user: { id: 1, username: 'admin' }, isAdmin: true };
// trimitere: validari + destinatar
eq('mesaj gol fara atasament -> 400', errStatus(() => msvc.sendMessage(aUserM, { text: '  ' }, null)), 400);
eq('mesaj peste MAX_LEN -> 400', errStatus(() => msvc.sendMessage(aUserM, { text: 'x'.repeat(msgsPure.MAX_LEN + 1) }, null)), 400);
eq('adminul fara destinatar valid -> 400', errStatus(() => msvc.sendMessage(aAdminM, { text: 'salut', userId: 424242 }, null)), 400);
// utilizatorul trimite; conversatia arhivata se redeschide automat
dMsg.users.find((x) => x.id === 9101).supportArchived = true;
const sm1 = msvc.sendMessage(aUserM, { text: 'am o intrebare' }, null);
ok('trimitere utilizator: mesaj scris, necitit de admin, conversatia redeschisa', !sm1.fromAdmin && !sm1.message.readByAdmin && dMsg.users.find((x) => x.id === 9101).supportArchived === false);
// adminul deschide firul -> cererile devin citite; utilizator inexistent -> 404
eq('fir pentru utilizator inexistent -> 404', errStatus(() => msvc.threadForAdmin(424242)), 404);
msvc.threadForAdmin(9101);
eq('deschiderea firului marcheaza cererile citite', msgsPure.unreadForAdmin(dMsg.messages), 0);
// raspunsul adminului + inbox-ul utilizatorului il marcheaza citit
const sm2 = msvc.sendMessage(aAdminM, { userId: 9101, text: 'raspuns' }, null);
ok('raspuns admin: fromAdmin + necitit de utilizator', sm2.fromAdmin && !sm2.message.readByUser);
msvc.inbox(aUserM);
eq('inbox-ul utilizatorului marcheaza raspunsurile citite', msgsPure.unreadForUser(dMsg.messages, 9101), 0);
// editare: doar propriile mesaje; golirea e refuzata
eq('utilizatorul editeaza mesajul adminului -> 403', errStatus(() => msvc.editMessage(aUserM, sm2.message.id, 'hack')), 403);
eq('editare mesaj inexistent -> 404', errStatus(() => msvc.editMessage(aAdminM, 'msg-inexistent', 'x')), 404);
eq('golirea unui mesaj fara atasament -> 400', errStatus(() => msvc.editMessage(aAdminM, sm2.message.id, '  ')), 400);
ok('adminul isi editeaza raspunsul', !!msvc.editMessage(aAdminM, sm2.message.id, 'raspuns corectat').message.editedAt);
// atasamente: accesul altui utilizator -> 403, fisier lipsa pe disc -> 404
const smAtt = msvc.sendMessage(aUserM, { text: 'cu fisier' }, { name: 'f.pdf', storedName: 'test-inexistent-9101.pdf', size: 1, mime: 'application/pdf' });
eq('mesaj fara atasament -> 404', errStatus(() => msvc.attachmentFile(aUserM, sm1.message.id)), 404);
eq('atasamentul altui utilizator -> 403', errStatus(() => msvc.attachmentFile(aAltM, smAtt.message.id)), 403);
eq('fisier lipsa pe disc -> 404 (dupa ce accesul a trecut)', errStatus(() => msvc.attachmentFile(aUserM, smAtt.message.id)), 404);
// stergere (admin) + arhivare
eq('stergere mesaj inexistent -> 404', errStatus(() => msvc.deleteMessage('msg-inexistent')), 404);
eq('stergerea cu atasament lipsa pe disc nu crapa (best-effort)', errStatus(() => msvc.deleteMessage(smAtt.message.id)), null);
ok('mesajul a disparut', !dMsg.messages.some((m) => m.id === smAtt.message.id));
eq('arhivare pentru utilizator inexistent -> 404', errStatus(() => msvc.archiveThread(424242, true)), 404);
ok('arhivare + redeschidere', msvc.archiveThread(9101, true).archived === true && msvc.archiveThread(9101, false).archived === false);
// curatenie
dMsg.messages = dMsg.messages.filter((m) => m.userId !== 9101);
dMsg.users = dMsg.users.filter((x) => x.id !== 9101 && x.id !== 9102);

section('Service layer parteneri si solduri initiale (src/partnersService.js)');
const psvc = require('../src/partnersService');
const coaT = require('../src/chartOfAccounts');
const fsT = require('fs');
// gardele de firma
eq('partener pe firma inexistenta -> 403', errStatus(() => psvc.upsertPartner(9999, { cui: '123' })), 403);
eq('import parteneri pe firma lipsa -> 403', errStatus(() => psvc.importPartners(null, 'a;b')), 403);
eq('solduri pe santinela NO_FIRMA -> 403', errStatus(() => psvc.setOpening(-1, {})), 403);
// parteneri: normalizarea CUI + pastrarea tipului la actualizare
eq('partener fara CUI -> 400', errStatus(() => psvc.upsertPartner(fidOk, { den: 'X' })), 400);
const ppS = psvc.upsertPartner(fidOk, { cui: 'RO 4242', den: 'Partener SVC', tip: 'client' }).partner;
ok('CUI normalizat (fara RO/spatii)', ppS.cui === '4242' && ppS.tip === 'client');
ok('actualizarea fara tip pastreaza tipul anterior', psvc.upsertPartner(fidOk, { cui: '4242', den: 'Alt nume' }).partner.tip === 'client');
// import CSV: antetul e sarit, randurile fara CUI ajung in erori
eq('CSV parteneri gol -> 400', errStatus(() => psvc.importPartners(fidOk, '')), 400);
const piS = psvc.importPartners(fidOk, 'CUI;Denumire\n111;Firma Unu\n;Fara Cui\nRO222;Firma Doi');
ok('import: 2 importati + 1 eroare de rand + CUI normalizat', piS.importati === 2 && piS.erori.length === 1 && db.get().partners[fidOk]['222'].den === 'Firma Doi');
delete db.get().partners[fidOk]['4242']; delete db.get().partners[fidOk]['111']; delete db.get().partners[fidOk]['222']; // curatenie
// plan de conturi personalizat (global, partajat intre firme)
eq('CSV conturi gol -> 400', errStatus(() => psvc.importAccounts('')), 400);
const aiS = psvc.importAccounts('Cont;Denumire\n8991;Cont test service;8;B');
ok('cont adaugat in plan + customAccounts', aiS.importati === 1 && !!coaT.getAccount('8991') && db.get().customAccounts.some((a) => a.cod === '8991'));
db.get().customAccounts = db.get().customAccounts.filter((a) => a.cod !== '8991'); // curatenie in baza (in planul din memorie ramane pe durata suitei)
// conversia de fisiere: fisierul temporar se sterge si la eroare
const tmpConv = path.join(os.tmpdir(), 'contab-conv-' + process.pid + '.bin');
fsT.writeFileSync(tmpConv, 'nu e un fisier excel');
eq('fisier nerecunoscut -> 400', errStatus(() => psvc.convertUploadToCsv(tmpConv, 'date.xlsx')), 400);
ok('fisierul temporar e sters si la eroare', !fsT.existsSync(tmpConv));
// solduri initiale analitice: upsert pe cheia cont+CUI, stergere dupa index
eq('analitic fara cont -> 400', errStatus(() => psvc.saveOpeningAnalytic(fidOk, { partener: 'X' })), 400);
psvc.saveOpeningAnalytic(fidOk, { cont: '4111', partener: 'Client A', cui: 'RO500', d: 100 });
const oa2 = psvc.saveOpeningAnalytic(fidOk, { cont: '4111', cui: '500', d: 250 });
const oaMine = oa2.openingAnalytic.filter((o) => o.cont === '4111' && String(o.cui).replace(/^RO/i, '') === '500');
ok('acelasi cont+CUI se inlocuieste (nu se dubleaza)', oaMine.length === 1 && oaMine[0].d === 250);
const listOA = db.get().openingAnalytic.filter((o) => (o.firmaId == null ? db.get().firmaActiva : o.firmaId) === fidOk);
psvc.deleteOpeningAnalytic(fidOk, listOA.findIndex((o) => o.cont === '4111' && o.cui === '500'));
ok('stergerea analiticului dupa index', !db.get().openingAnalytic.some((o) => o.firmaId === fidOk && o.cui === '500'));
eq('index invalid NU e eroare (contract istoric)', errStatus(() => psvc.deleteOpeningAnalytic(fidOk, 9999)), null);
// solduri initiale sintetice: dezechilibrul respins cu detaliile in extra
const prevOB = db.get().openingBalances[fidOk];
let obErr = null;
try { psvc.setOpening(fidOk, { 5121: { d: 1000, c: 0 }, 1012: { d: 0, c: 800 } }); } catch (e) { obErr = e; }
ok('dezechilibru -> 400 cu totalurile si diferenta in extra', !!obErr && obErr.status === 400 && obErr.extra && obErr.extra.diferenta === 200 && obErr.extra.totalDebit === 1000 && obErr.extra.totalCredit === 800);
const obOk = psvc.setOpening(fidOk, { 5121: { d: 1000, c: 0 }, 1012: { d: 0, c: 1000 } });
ok('echilibrat: salvat cu totalurile', obOk.totalDebit === 1000 && obOk.totalCredit === 1000);
if (prevOB === undefined) delete db.get().openingBalances[fidOk]; else db.get().openingBalances[fidOk] = prevOB; // restaurare

section('Service layer configurare (src/configService.js)');
const errStatusCfg = (fn) => { try { fn(); return null; } catch (e) { return e.status || 500; } };
const cfsvc = require('../src/configService');
const fiscalT = require('../src/fiscal');
// gardele de firma
eq('date firma pe firma inexistenta -> 403', errStatus(() => cfsvc.updateCompany(9999, { nume: 'X' })), 403);
eq('chitanta pe firma lipsa -> 403', errStatus(() => cfsvc.assignChitanta(null, 'e1')), 403);
// datele firmei: ALLOWLIST de profil — campurile de identificare se salveaza, cele
// sensibile (lockedUntil/subscription/anaf) si tehnice (id/logoFile/camp necunoscut) NU
const firmaCfg = db.getFirma(fidOk);
firmaCfg.lockedUntil = '2026-05'; const subInit = firmaCfg.subscription;
cfsvc.updateCompany(fidOk, {
  nume: 'Firma Editata SRL', caen: '6201',                 // profil — permise
  logoFile: 'furat.png', id: 424242, campNecunoscut: 'x',  // tehnice — ignorate
  lockedUntil: null, subscription: { plan: 'gratis-forjat' }, anaf: { clientSecret: 'furat' }, // sensibile — ignorate
});
ok('profil salvat (nume/caen)', firmaCfg.nume === 'Firma Editata SRL' && firmaCfg.caen === '6201');
ok('campurile tehnice ignorate (id/logoFile/necunoscut)', firmaCfg.id === fidOk && firmaCfg.logoFile !== 'furat.png' && firmaCfg.campNecunoscut === undefined);
ok('perioada inchisa NU se poate deschide prin /api/company', firmaCfg.lockedUntil === '2026-05');
ok('abonamentul si credentialele ANAF NU se pot injecta', firmaCfg.subscription === subInit && firmaCfg.anaf === undefined);
delete firmaCfg.lockedUntil; // curatenie
// logo: validare pe magic bytes, nu pe extensie
const tmpLogoBad = path.join(os.tmpdir(), 'contab-logo-bad-' + process.pid + '.png');
fsT.writeFileSync(tmpLogoBad, 'nu e imagine');
eq('fisier care nu e PNG/JPEG -> 400', errStatus(() => cfsvc.setLogo(fidOk, tmpLogoBad)), 400);
ok('fisierul invalid e sters', !fsT.existsSync(tmpLogoBad));
eq('fisier ilizibil -> 400', errStatus(() => cfsvc.setLogo(fidOk, path.join(os.tmpdir(), 'nu-exista-' + process.pid))), 400);
const prevLogo = firmaCfg.logoFile;
const tmpLogoOk = path.join(os.tmpdir(), 'contab-logo-ok-' + process.pid + '.png');
fsT.writeFileSync(tmpLogoOk, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
const logoR = cfsvc.setLogo(fidOk, tmpLogoOk);
ok('PNG valid: logoFile setat pe basename + format detectat', firmaCfg.logoFile === path.basename(tmpLogoOk) && logoR.format === 'PNG');
cfsvc.deleteLogo(fidOk);
ok('stergerea logo-ului goleste campul (fisier lipsa = best-effort)', firmaCfg.logoFile === undefined);
eq('stergerea fara logo NU e eroare (contract istoric)', errStatus(() => cfsvc.deleteLogo(fidOk)), null);
if (prevLogo !== undefined) firmaCfg.logoFile = prevLogo; // restaurare
try { fsT.unlinkSync(tmpLogoOk); } catch (_) { /* posibil mutat/sters */ }
// chitanta: doar incasari in numerar (531x); numarul se atribuie o data si se refoloseste
const dCfg = db.get();
dCfg.entries.push({ id: 'chit-svc-1', firmaId: fidOk, data: '2026-06-01', period: '2026-06', tip: 'incasare_client', tipNume: 'Incasare', partener: 'Casa SRL', document: 'CH-T', lines: [{ debit: '5311', credit: '4111', suma: 150 }] });
dCfg.entries.push({ id: 'chit-svc-2', firmaId: fidOk, data: '2026-06-01', period: '2026-06', tip: 'incasare_client', tipNume: 'Incasare', partener: 'Banca SRL', document: 'CH-B', lines: [{ debit: '5121', credit: '4111', suma: 150 }] });
eq('chitanta pe inregistrare inexistenta -> 404', errStatus(() => cfsvc.assignChitanta(fidOk, 'chit-inexistent')), 404);
eq('chitanta pe incasare prin banca -> 400', errStatus(() => cfsvc.assignChitanta(fidOk, 'chit-svc-2')), 400);
const chNext = ssvc.docSeries(fidOk).CH.next;
const ch1 = cfsvc.assignChitanta(fidOk, 'chit-svc-1');
ok('prima tiparire: numar atribuit din seria CH + suma 531x', ch1.justAssigned && ch1.nr.startsWith(ssvc.docSeries(fidOk).CH.serie + '-') && ch1.suma === 150);
const ch2 = cfsvc.assignChitanta(fidOk, 'chit-svc-1');
ok('retiparirea refoloseste numarul (seria nu avanseaza)', !ch2.justAssigned && ch2.nr === ch1.nr && ssvc.docSeries(fidOk).CH.next === chNext + 1);
dCfg.entries = dCfg.entries.filter((e) => e.id !== 'chit-svc-1' && e.id !== 'chit-svc-2'); // curatenie
// setari globale: ALLOWLIST STRICT (fix escaladare — authSecret/chei arbitrare interzise)
eq('cheia interzisa (authSecret) -> 403, nu se scrie', errStatusCfg(() => cfsvc.updateSettings({ authSecret: 'x' })), 403);
ok('authSecret NU a fost atins', dCfg.settings.authSecret !== 'x');
eq('setare GLOBALA (useAI) fara rol de admin -> 403', errStatusCfg(() => cfsvc.updateSettings({ useAI: false }, false)), 403);
eq('setare GLOBALA (useAI) CU rol de admin -> permisa', (cfsvc.updateSettings({ useAI: false }, true), dCfg.settings.useAI), false);
eq('selfRegister CU rol de admin -> permisa', (cfsvc.updateSettings({ selfRegister: true }, true), dCfg.settings.selfRegister), true);
ok('raspunsul nu contine authSecret (fara leak)', !('authSecret' in cfsvc.updateSettings({ useAI: true }, true).settings));
const prevFiscalCfg = dCfg.settings.fiscal;
const fc1 = cfsvc.setFiscalConfig({ tvaStandard: 19, invalid: 'abc', necunoscut: 5 });
ok('cota valida aplicata imediat, cheile necunoscute ignorate', fc1.current.tvaStandard === 19 && dCfg.settings.fiscal.necunoscut === undefined);
const fc2 = cfsvc.setFiscalConfig({ reset: true });
ok('reset: custom sters + valorile standard revin', fc2.reset && dCfg.settings.fiscal === undefined && fc2.current.tvaStandard === fiscalT.DEFAULTS.tvaStandard);
if (prevFiscalCfg !== undefined) { dCfg.settings.fiscal = prevFiscalCfg; fiscalT.applyConfig(prevFiscalCfg); } // restaurare

section('Service layer inchideri fiscale (src/closingsService.js)');
const clsvc = require('../src/closingsService');
const firmaCl = db.getFirma(fidOk);
const prevLockCl = firmaCl.lockedUntil || null;
const prevLossCl = firmaCl.pierdereFiscala;
firmaCl.lockedUntil = null;
// gardele de firma si de format
eq('inchidere TVA pe firma inexistenta -> 403', errStatus(() => clsvc.closeVat(9999, '2026-06')), 403);
eq('inchidere TVA pe un AN intreg -> 400 (doar luna)', errStatus(() => clsvc.closeVat(fidOk, '2026')), 400);
eq('inchidere TVA pe luna 13 -> 400', errStatus(() => clsvc.closeVat(fidOk, '2026-13')), 400);
eq('inchidere anuala fara an -> 400', errStatus(() => clsvc.closeYear(fidOk, null)), 400);
eq('impozit pe profit fara an -> 400', errStatus(() => clsvc.closeProfitTax(fidOk, {}, null)), 400);
// blocarea perioadei la inchiderea TVA: se blocheaza si fara TVA de regularizat, doar inainte
const cv1 = clsvc.closeVat(fidOk, '2035-01');
ok('perioada blocata chiar si fara TVA de regularizat', cv1.lockedUntil === '2035-01' && cv1.posted === false);
eq('inchiderea lunii urmatoare avanseaza blocajul', clsvc.closeVat(fidOk, '2035-02').lockedUntil, '2035-02');
eq('inchiderea unei luni mai VECHI nu da blocajul inapoi', clsvc.closeVat(fidOk, '2034-12').lockedUntil, '2035-02');
// inchiderea anuala pe un an fara rulaje: nimic postat
ok('an fara rulaje: posted=false, fara nota', clsvc.closeYear(fidOk, '2035').posted === false && !db.get().entries.some((e) => e.firmaId === fidOk && e.tip === 'inchidere_an' && e.period === '2035-12'));
// optiunile impozitului: pierderea explicita bate pierderea memorata pe firma
firmaCl.pierdereFiscala = { 2034: 500 };
eq('pierderea memorata pe anul precedent se preia implicit', clsvc.profitTaxOptions(fidOk, {}, 2035).pierdereReportata, 500);
eq('pierderea explicita are prioritate', clsvc.profitTaxOptions(fidOk, { pierdereReportata: 100 }, 2035).pierdereReportata, 100);
// impozitul pe profit: dubla inregistrare refuzata; pierderea se memoreaza si la impozit 0
db.get().entries.push({ id: 'cl-svc-dbl', firmaId: fidOk, data: '2036-12-31', period: '2036-12', tip: 'impozit_profit', tipNume: 'Impozit pe profit', lines: [], system: true });
eq('impozitul deja inregistrat pe an -> 400', errStatus(() => clsvc.closeProfitTax(fidOk, {}, '2036')), 400);
db.get().entries = db.get().entries.filter((e) => e.id !== 'cl-svc-dbl');
const cpt = clsvc.closeProfitTax(fidOk, {}, '2035');
ok('an fara profit: posted=false + pierderea de reportat memorata pe firma', cpt.posted === false && firmaCl.pierdereFiscala['2035'] !== undefined);
// repartizarea rezultatului: sold 121 zero -> nimic de repartizat
ok('121 zero: posted=false, fara nota', clsvc.distributeResult(fidOk, '2035').posted === false && !db.get().entries.some((e) => e.firmaId === fidOk && e.tip === 'repartizare_rezultat' && e.period === '2035-12'));
// restaurare
firmaCl.lockedUntil = prevLockCl;
if (prevLossCl === undefined) delete firmaCl.pierdereFiscala; else firmaCl.pierdereFiscala = prevLossCl;

section('Service layer salarizare (src/payrollService.js)');
const paysvc = require('../src/payrollService');
// firma dedicata, ca testele sa nu depinda de angajatii din seed
db.get().firme.push({ id: 7788, nume: 'PAY SRL', cui: '7788' });
// gardele
eq('angajat pe firma inexistenta -> 403', errStatus(() => paysvc.upsertAngajat(9999, { nume: 'X', salariuBrut: 5000 })), 403);
eq('angajat fara nume/brut -> 400', errStatus(() => paysvc.upsertAngajat(7788, { nume: 'X' })), 400);
eq('stergere angajat inexistent -> 404', errStatus(() => paysvc.deleteAngajat(7788, 'ang-inexistent')), 404);
eq('stat de plata fara angajati -> 400 (inaintea perioadei)', errStatus(() => paysvc.postStatPlata(7788, null, stubDeps)), 400);
// nomenclator: valori implicite igienizate + actualizare pe id
const angR = paysvc.upsertAngajat(7788, { nume: 'Ion Salariat', salariuBrut: 5000, avans: 500, procentCM: 99, sector: 'gresit' }).angajat;
ok('valori implicite: procentCM 75, sector normal, 21 zile lucratoare', angR.procentCM === 75 && angR.sector === 'normal' && angR.zileLucratoare === 21);
const angR2 = paysvc.upsertAngajat(7788, { id: angR.id, nume: 'Ion Salariat', salariuBrut: 6000, avans: 500 }).angajat;
ok('actualizarea pe id pastreaza identitatea', angR2.id === angR.id && angR2.salariuBrut === 6000 && db.get().angajati.filter((a) => a.firmaId === 7788).length === 1);
// postarea statului: perioada obligatorie; liniile de retineri + instantaneul lunar
eq('stat de plata fara perioada -> 400', errStatus(() => paysvc.postStatPlata(7788, null, stubDeps)), 400);
const spR = paysvc.postStatPlata(7788, '2026-06', stubDeps);
ok('avansul intra ca retinere 421=425 in articolul agregat', spR.entry.lines.some((l) => l.debit === '421' && l.credit === '425' && l.suma === 500));
eq('instantaneul lunar e salvat in payrollHistory', db.get().payrollHistory.filter((h) => h.firmaId === 7788 && h.period === '2026-06').length, 1);
paysvc.postStatPlata(7788, '2026-06', stubDeps);
eq('repostarea aceleiasi luni INLOCUIESTE instantaneul (nu dubleaza)', db.get().payrollHistory.filter((h) => h.firmaId === 7788 && h.period === '2026-06').length, 1);
// plata neta: perioada obligatorie, contul necunoscut cade pe banca (5121)
eq('plata fara perioada -> 400', errStatus(() => paysvc.paySalaries(7788, null, '5121', stubDeps)), 400);
const payR = paysvc.paySalaries(7788, '2026-06', 'cont-gresit', stubDeps);
ok('plata: suma = restul de plata, cont implicit 5121', payR.suma > 0 && payR.suma === spR.totals.restPlata && payR.cont === '5121');
eq('plata din casa (5311) e respectata', paysvc.paySalaries(7788, '2026-06', '5311', stubDeps).cont, '5311');
// curatenie: firma de test + tot ce a produs
const dPay = db.get();
dPay.angajati = dPay.angajati.filter((a) => a.firmaId !== 7788);
dPay.entries = dPay.entries.filter((e) => e.firmaId !== 7788);
dPay.payrollHistory = dPay.payrollHistory.filter((h) => h.firmaId !== 7788);
dPay.firme = dPay.firme.filter((f) => f.id !== 7788);

section('Protectie upload: continut pe magic bytes + plafon per utilizator (src/uploadGuard.js)');
const ug = require('../src/uploadGuard');
ok('pdf real acceptat', ug.contentMatches('.pdf', Buffer.from('%PDF-1.4 continut')));
ok('pdf cu junk inaintea antetului acceptat (spec permite)', ug.contentMatches('.pdf', Buffer.concat([Buffer.alloc(16, 0x41), Buffer.from('%PDF-1.7')])));
ok('pdf deghizat (text/html) respins', !ug.contentMatches('.pdf', Buffer.from('<html>nu e pdf</html>')));
ok('png real acceptat', ug.contentMatches('.png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])));
ok('png deghizat respins', !ug.contentMatches('.png', Buffer.from('GIF89a')));
ok('jpeg real acceptat', ug.contentMatches('.jpg', Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])));
ok('gif real acceptat', ug.contentMatches('.gif', Buffer.from('GIF89a...')));
ok('webp real acceptat', ug.contentMatches('.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])));
ok('fisier gol pe extensie de imagine respins', !ug.contentMatches('.png', Buffer.alloc(0)));
ok('csv text acceptat', ug.contentMatches('.csv', Buffer.from('CUI;Denumire\n1;X')));
ok('csv cu octeti NUL respins (binar deghizat)', !ug.contentMatches('.csv', Buffer.from([0x41, 0x00, 0x42])));
ok('containerele raman pe validarea parserului (.xlsx trece)', ug.contentMatches('.xlsx', Buffer.from('orice-continut')));
// plafonul per utilizator: bucket-uri separate, 429 peste plafon, resetare la igiena
const mkRes = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const limT = ug.userLimit('test-svc', 2, 'Prea multe.');
const reqLim = { user: { id: 424242 } };
let trecute = 0;
for (let i = 0; i < 2; i++) limT(reqLim, mkRes(), () => { trecute += 1; });
eq('sub plafon: cererile trec', trecute, 2);
const rOver = mkRes(); let nextOver = false;
limT(reqLim, rOver, () => { nextOver = true; });
ok('peste plafon: 429 cu mesaj si minutele ramase', !nextOver && rOver.code === 429 && /Reincearca peste ~\d+ min/.test(rOver.body.error));
const rAlt = mkRes(); let nextAlt = false;
limT({ user: { id: 424243 } }, rAlt, () => { nextAlt = true; });
ok('alt utilizator: bucket separat, trece', nextAlt);
ug.pruneRateBuckets(Date.now() + 2 * 3600 * 1000);
const rDupa = mkRes(); let nextDupa = false;
limT(reqLim, rDupa, () => { nextDupa = true; });
ok('dupa igiena (fereastra expirata): plafonul se reseteaza', nextDupa);

section('Contoarele extragerilor AI (src/metrics.js aiCall/aiSnapshot)');
const metAi = require('../src/metrics');
metAi.reset();
eq('snapshot gol: zero apeluri', metAi.aiSnapshot().n, 0);
metAi.aiCall(100, true);
metAi.aiCall(300, false, 'timeout la model');
const aiSnap = metAi.aiSnapshot();
ok('agregare: n/fail/avgMs corecte', aiSnap.n === 2 && aiSnap.fail === 1 && aiSnap.avgMs === 200);
ok('ultima eroare e retinuta (mesaj, nu continut)', aiSnap.lastError === 'timeout la model' && !!aiSnap.lastErrorAt);
ok('snapshot() expune sectiunea ai', metAi.snapshot().ai && metAi.snapshot().ai.n === 2);
metAi.reset();
eq('reset goleste si contoarele AI', metAi.aiSnapshot().n, 0);

section('Metrici de performanta pe ruta (src/metrics.js)');
const metricsMod = require('../src/metrics');
metricsMod.reset();
eq('tipar: id numeric -> :id', metricsMod.routePattern({ url: '/api/firme/123' }), '/api/firme/:id');
eq('tipar: id hex lung -> :id', metricsMod.routePattern({ url: '/api/document/a1b2c3d4e5f6a7b8/file' }), '/api/document/:id/file');
eq('tipar: query-ul se taie', metricsMod.routePattern({ url: '/xml/saft?period=2026-06' }), '/xml/saft');
eq('tipar: ruta Express are prioritate', metricsMod.routePattern({ route: { path: '/api/firme/:id' }, baseUrl: '', url: '/api/firme/9' }), '/api/firme/:id');
metricsMod.record('/xml/saft', 120, 200);
metricsMod.record('/xml/saft', 700, 200);
metricsMod.record('/api/health', 3, 200);
metricsMod.record('/xml/saft', 80, 500);
const snap = metricsMod.snapshot();
eq('agregare: ruta cu cel mai mare timp total e prima', snap.routes[0].route, '/xml/saft');
ok('agregare: n/avg/max corecte', snap.routes[0].n === 3 && snap.routes[0].totalMs === 900 && snap.routes[0].avgMs === 300 && snap.routes[0].maxMs === 700);
ok('agregare: numara lente si 5xx', snap.routes[0].slow === 1 && snap.routes[0].err5xx === 1);
// inelul de erori recente: plafonat, cele mai noi primele
for (let k = 0; k < 25; k++) metricsMod.recordError('eroare ' + k);
const snapE = metricsMod.snapshot();
eq('erori recente: plafonate la 20', snapE.recentErrors.length, 20);
eq('erori recente: cea mai noua prima', snapE.recentErrors[0].msg, 'eroare 24');
eq('erori recente: cele mai vechi au iesit', snapE.recentErrors[19].msg, 'eroare 5');
// starea job-urilor: tick / rezultat / eroare
metricsMod.jobTick('backup');
metricsMod.jobResult('backup', 'db-x.json');
metricsMod.jobError('spv-poll', 'ANAF 503');
const snapJ = metricsMod.snapshot().jobs;
ok('job: tick + rezultat notate', snapJ.backup.lastTickAt && snapJ.backup.lastResult === 'db-x.json' && snapJ.backup.errors === 0);
ok('job: eroarea notata si numarata', snapJ['spv-poll'].lastError === 'ANAF 503' && snapJ['spv-poll'].errors === 1);
metricsMod.reset();
ok('reset: erori si joburi golite', metricsMod.snapshot().recentErrors.length === 0 && Object.keys(metricsMod.snapshot().jobs).length === 0);

section('Service layer firme: autorizarea dublata (src/firmeService.js)');
const fsvc = require('../src/firmeService');
const fidPrima = dbx.firme[0].id;
// gărzile refuza indiferent de apelant — nu depind de middleware-ul rutei
const demoU = { id: 900, username: 'demo', role: 'user', firme: [fidPrima] };
eq('demo nu creeaza firme -> 403', errStatus(() => fsvc.createFirma(demoU, { nume: 'X' })), 403);
eq('demo nu sterge firme -> 403', errStatus(() => fsvc.deleteFirma(demoU, fidPrima, null)), 403);
const strainU = { id: 901, username: 'strain', role: 'user', firme: [] };
eq('firma straina: editare -> 403', errStatus(() => fsvc.updateFirma(strainU, fidPrima, { nume: 'Hack' })), 403);
eq('firma straina: export JSON -> 403', errStatus(() => fsvc.exportBundle(strainU, fidPrima)), 403);
eq('firma straina: export ZIP -> 403', errStatus(() => fsvc.exportZip(strainU, fidPrima)), 403);
eq('firma straina: activare -> 403', errStatus(() => fsvc.activateFirma(strainU, fidPrima)), 403);
eq('firma straina: clona de test -> 403', errStatus(() => fsvc.testClone(strainU, fidPrima)), 403);
eq('import peste firma la care nu ai acces -> 403', errStatus(() => fsvc.importBundle(strainU, { firma: { nume: 'X' } }, { replace: true, activeFid: fidPrima })), 403);
eq('export toate firmele fara admin -> 403', errStatus(() => fsvc.exportAllZip(strainU)), 403);
// adminul aflat sub impersonare NU are drepturile lui de admin la stergere
const admU = { id: 902, username: 'boss', role: 'admin', firme: [] };
eq('admin sub impersonare: stergere firma straina -> 403', errStatus(() => fsvc.deleteFirma(admU, fidPrima, 55)), 403);
// garda „cel putin o firma ramane" pentru utilizatorul cu o singura firma
const unicU = { id: 903, username: 'unic', role: 'user', firme: [fidPrima], firmaActiva: fidPrima };
eq('stergerea ultimei firme a utilizatorului -> 400', errStatus(() => fsvc.deleteFirma(unicU, fidPrima, null)), 400);

section('Sesiuni & anti-brute-force (src/session.js)');
{
  const sess = require('../src/session');
  const dbx = require('../src/db');
  const mkRes = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, append(k, v) { this.headers[k] = this.headers[k] ? [].concat(this.headers[k], v) : v; } });
  const mkReq = (cookie, ip) => ({ headers: { cookie: cookie || '', 'user-agent': 'test-agent' }, ip: ip || '203.0.113.9' });
  const sidOf = (res) => String([].concat(res.headers['Set-Cookie']).find((c) => c.startsWith('sid=')) || '').split(';')[0];

  // utilizator dedicat, curatat la final (baza e temporara oricum)
  const d = dbx.get();
  const su = { id: 7777, username: 'sesiuni-test', role: 'user', firme: [1], firmaActiva: 1, salt: 'x', hash: 'x' };
  d.users.push(su);

  // login -> cookie sid -> currentUser regaseste utilizatorul; sesiunea e inregistrata server-side
  const res1 = mkRes(); const req1 = mkReq();
  sess.startSession(req1, res1, su);
  const sid = sidOf(res1);
  ok('startSession seteaza cookie sid semnat', /^sid=[^;]{20,}$/.test(sid));
  eq('cookie-ul e HttpOnly + SameSite=Lax', /HttpOnly/.test(String(res1.headers['Set-Cookie'])) && /SameSite=Lax/.test(String(res1.headers['Set-Cookie'])), true);
  const found = sess.currentUser(mkReq(sid));
  eq('currentUser din cookie-ul emis', found && found.id, 7777);
  ok('token falsificat -> null', sess.currentUser(mkReq(sid + 'x')) === null);
  // revocarea sesiunii (logout pe alt dispozitiv) invalideaza tokenul inca valid criptografic
  su.sessions = [];
  ok('sesiune revocata server-side -> null (tokenul singur nu ajunge)', sess.currentUser(mkReq(sid)) === null);

  // plafonul de dispozitive: peste MAX_SESSIONS (10), cele mai vechi cad
  for (let i = 0; i < 13; i++) sess.startSession(mkReq(), mkRes(), su);
  eq('sesiunile sunt plafonate la 10 dispozitive', su.sessions.length, 10);

  // dispozitiv de incredere (2FA): valid pentru utilizator, invalidat de schimbarea epocii
  const res2 = mkRes();
  sess.setTrustedDevice(mkReq(), res2, su);
  const tfd = String([].concat(res2.headers['Set-Cookie']).find((c) => String(c).startsWith('tfd='))).split(';')[0];
  ok('setTrustedDevice emite cookie tfd', /^tfd=.{20,}/.test(tfd));
  ok('deviceTrusted recunoaste dispozitivul', sess.deviceTrusted(mkReq(tfd), su) === true);
  su.tfdEpoch = (su.tfdEpoch || 0) + 1; // „deconecteaza celelalte dispozitive"
  ok('schimbarea epocii invalideaza dispozitivele vechi', sess.deviceTrusted(mkReq(tfd), su) === false);
  const alt = { id: 7778 };
  ok('tfd nu e transferabil intre utilizatori', sess.deviceTrusted(mkReq(tfd), alt) === false);

  // anti-brute-force per IP: 8 esecuri -> blocat ~15 min; alt IP nu e afectat; prune curata
  const atkIp = '198.51.100.77';
  eq('atacatorul porneste deblocat', sess.isLocked(mkReq('', atkIp)), 0);
  for (let i = 0; i < 8; i++) sess.bumpFail(mkReq('', atkIp));
  ok('dupa 8 esecuri: blocat (minute ramase > 0)', sess.isLocked(mkReq('', atkIp)) > 0);
  eq('alt IP nu e blocat', sess.isLocked(mkReq('', '198.51.100.78')), 0);
  sess.clearFails(mkReq('', atkIp));
  eq('clearFails deblocheaza (login reusit)', sess.isLocked(mkReq('', atkIp)), 0);
  for (let i = 0; i < 8; i++) sess.bumpFail(mkReq('', atkIp));
  sess.pruneLoginAttempts(Date.now() + 16 * 60 * 1000); // dupa expirarea ferestrei
  eq('pruneLoginAttempts curata blocajele expirate', sess.isLocked(mkReq('', atkIp)), 0);
  eq('attemptKey cade pe x-forwarded-for cand req.ip lipseste', sess.attemptKey({ headers: { 'x-forwarded-for': '192.0.2.5, 10.0.0.1' } }), '192.0.2.5');

  d.users = d.users.filter((x) => x.id !== 7777);
}

section('Extras bancar — parsere CSV / MT940 + sugestii (src/bank.js)');
{
  const bank = require('../src/bank');
  const csv = 'Data;Descriere;Debit;Credit\n'
    + '03.06.2026;Incasare factura CLIENT ALFA SRL;;1190,00\n'
    + '04.06.2026;Plata furnizor BETA COM;500,50;\n'
    + '05.06.2026;Comision administrare cont;12,00;\n'
    + 'rand fara data valida;x;y;z\n';
  const t = bank.parseCsv(csv);
  eq('CSV: 3 tranzactii valide (randul invalid e sarit)', t.length, 3);
  eq('CSV: data RO dd.mm.yyyy -> ISO', t[0].data, '2026-06-03');
  eq('CSV: creditul e incasare (sens in)', t[0].sens, 'in');
  eq('CSV: suma cu virgula zecimala', t[0].suma, 1190);
  eq('CSV: debitul e plata (sens out)', t[1].sens, 'out');
  // fara antet si cu o singura coloana de suma: semnul da sensul
  const t2 = bank.parseCsv('2026-06-07,POS Kaufland,-89.90\n2026-06-08,Incasare ramburs,25.00\n');
  eq('CSV fara antet: suma negativa -> out', t2[0].sens, 'out');
  eq('CSV fara antet: suma pozitiva -> in', t2[1].sens, 'in');

  const mt = ':61:2606030603C1190,00NTRF\n:86:Incasare CLIENT ALFA SRL factura 101\n:61:2606040604D500,50NTRF\n:86:Plata BETA COM\n';
  const m = bank.parseMt940(mt);
  eq('MT940: 2 tranzactii din :61:', m.length, 2);
  eq('MT940: data din YYMMDD', m[0].data, '2026-06-03');
  eq('MT940: C -> incasare', m[0].sens, 'in');
  eq('MT940: descrierea din :86:', /CLIENT ALFA/.test(m[0].descriere), true);
  eq('parseStatement detecteaza MT940 dupa :61:', bank.parseStatement(mt).length, 2);

  // CAMT.053 (ISO 20022, XML) — extrasul SEPA modern; namespace cu prefix, CRDT/DBIT, stornare, Dt/DtTm
  const camt = '<?xml version="1.0"?><ns:Document xmlns:ns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><ns:BkToCstmrStmt><ns:Stmt>'
    + '<ns:Ntry><ns:Amt Ccy="RON">1190.00</ns:Amt><ns:CdtDbtInd>CRDT</ns:CdtDbtInd><ns:BookgDt><ns:Dt>2026-06-03</ns:Dt></ns:BookgDt>'
    + '<ns:NtryDtls><ns:TxDtls><ns:Amt Ccy="RON">1190.00</ns:Amt><ns:RltdPties><ns:Dbtr><ns:Nm>CLIENT ALFA SRL</ns:Nm></ns:Dbtr></ns:RltdPties><ns:RmtInf><ns:Ustrd>Incasare ALX 1024</ns:Ustrd></ns:RmtInf></ns:TxDtls></ns:NtryDtls></ns:Ntry>'
    + '<ns:Ntry><ns:Amt Ccy="RON">500.50</ns:Amt><ns:CdtDbtInd>DBIT</ns:CdtDbtInd><ns:ValDt><ns:Dt>2026-06-04</ns:Dt></ns:ValDt><ns:NtryDtls><ns:TxDtls><ns:RmtInf><ns:Ustrd>Plata BETA</ns:Ustrd></ns:RmtInf></ns:TxDtls></ns:NtryDtls></ns:Ntry>'
    + '<ns:Ntry><ns:Amt Ccy="RON">30.00</ns:Amt><ns:CdtDbtInd>CRDT</ns:CdtDbtInd><ns:RvslInd>true</ns:RvslInd><ns:BookgDt><ns:DtTm>2026-06-05T09:15:00</ns:DtTm></ns:BookgDt><ns:AddtlNtryInf>Stornare comision</ns:AddtlNtryInf></ns:Ntry>'
    + '</ns:Stmt></ns:BkToCstmrStmt></ns:Document>';
  const camtTx = bank.parseCamt(camt);
  eq('CAMT: 3 tranzactii din <Ntry>', camtTx.length, 3);
  eq('CAMT: CRDT -> incasare (sens in)', camtTx[0].sens, 'in');
  eq('CAMT: suma cu punct zecimal (Amt nivel Ntry, nu TxDtls)', camtTx[0].suma, 1190);
  eq('CAMT: data din BookgDt/Dt', camtTx[0].data, '2026-06-03');
  eq('CAMT: descrierea = remitenta + numele partii', /ALX 1024/.test(camtTx[0].descriere) && /CLIENT ALFA/.test(camtTx[0].descriere), true);
  eq('CAMT: DBIT -> plata (sens out)', camtTx[1].sens, 'out');
  eq('CAMT: cade pe ValDt cand lipseste BookgDt', camtTx[1].data, '2026-06-04');
  eq('CAMT: RvslInd inverseaza semnul (CRDT stornat -> out)', camtTx[2].sens, 'out');
  eq('CAMT: DtTm redus la data (YYYY-MM-DD)', camtTx[2].data, '2026-06-05');
  eq('parseStatement detecteaza CAMT dupa BkToCstmrStmt', bank.parseStatement(camt).length, 3);
  const sugC = bank.parseAndSuggest({ partners: { 12345678: { cui: '12345678', den: 'CLIENT ALFA SRL' } }, entries: [] }, camt);
  eq('CAMT + sugestie: incasarea de la partener cunoscut -> incasare_client potrivit', sugC[0].tip + '|' + sugC[0].matched, 'incasare_client|true');

  // sugestii: comisionul are tip dedicat; partenerul cunoscut e potrivit dupa denumire
  const fakeDb = { partners: { 12345678: { cui: '12345678', den: 'CLIENT ALFA SRL' } }, entries: [] };
  const sug = bank.parseAndSuggest(fakeDb, csv);
  eq('sugestie: incasarea de la partener cunoscut -> incasare_client potrivit', sug[0].tip + '|' + sug[0].matched, 'incasare_client|true');
  eq('sugestie: CUI-ul partenerului potrivit e completat', sug[0].fields.cuiPartener, 'RO12345678');
  eq('sugestie: comisionul bancar are tipul lui', sug[2].tip, 'comision_bancar');
  eq('sugestie: fara facturi deschise -> potrivire "fara"', sug[0].potrivire.tip, 'fara');

  // potrivire cu factura DESCHISA: incasarea de 1190 stinge exact factura clientului (si pre-completeaza doc)
  const dbOpen = {
    partners: { 12345678: { cui: '12345678', den: 'CLIENT ALFA SRL' } },
    entries: [{ id: 'inv1', data: '2026-06-01', document: 'ALX 1024', partener: 'CLIENT ALFA SRL', partenerCui: 'RO12345678',
      lines: [{ debit: '4111', credit: '707', suma: 1000 }, { debit: '4111', credit: '4427', suma: 190 }] }],
  };
  const sugM = bank.parseAndSuggest(dbOpen, csv);
  eq('potrivire bancara: incasarea de 1190 stinge exact factura deschisa', sugM[0].potrivire.tip, 'exacta');
  eq('potrivire bancara: factura stinsa legata', sugM[0].potrivire.facturi[0].doc, 'ALX 1024');
  eq('potrivire bancara: documentul facturii pre-completat pe potrivirea exacta', sugM[0].fields.document, 'ALX 1024');
  eq('potrivire bancara: legatura de decontare (stinge) propusa spre confirmare', JSON.stringify(sugM[0].stinge), JSON.stringify(['inv1']));
}

section('Extractor — euristici pe text de factura (src/extractor.js)');
{
  const ex = require('../src/extractor');
  eq('parseRoNumber: 1.234,56 (RO)', ex.parseRoNumber('1.234,56'), 1234.56);
  eq('parseRoNumber: 1,234.56 (EN)', ex.parseRoNumber('1,234.56'), 1234.56);
  eq('parseRoNumber: sufixul lei e ignorat', ex.parseRoNumber('250 lei'), 250);
  eq('parseRoNumber: text gol -> null', ex.parseRoNumber('  '), null);

  const fct = 'FACTURA FISCALA seria ABC nr. 1234 din 05.06.2026\n'
    + 'Furnizor: BETA COM SRL, CUI RO23456789\nCumparator: FIRMA MEA SRL, CUI RO12345678\n'
    + 'Marfuri conform anexa\nTotal fara TVA: 1.000,00\nTotal TVA: 210,00\nTotal de plata: 1.210,00 lei';
  const r = ex.extractFromText(fct, '12345678');
  eq('factura primita: tipul sugerat e cumparare', r.suggestedType, 'factura_cumparare_marfuri');
  eq('extractie: baza dupa eticheta „fara TVA"', r.fields.baza, 1000);
  eq('extractie: TVA reconciliat din total - baza', r.fields.tva, 210);
  eq('extractie: totalul de plata', r.fields.suma, 1210);
  eq('extractie: data documentului', r.fields.data, '2026-06-05');
  ok('extractie: ambele CUI-uri gasite', r.cuis.includes('23456789') && r.cuis.includes('12345678'));
  // sens invers: daca PRIMUL CUI din text e al firmei proprii, e o vanzare
  const out = ex.extractFromText('FACTURA nr 7 din 05.06.2026\nFurnizor: FIRMA MEA SRL CUI RO12345678\nClient: X SRL CUI RO23456789\nPrestari servicii\nTotal de plata: 119,00', '12345678');
  eq('factura emisa (CUI-ul propriu primul): vanzare de servicii', out.suggestedType, 'factura_vanzare_servicii');
  // doar total -> baza si TVA derivate din cota implicita
  const only = ex.extractFromText('FACTURA nr 9 din 05.06.2026\nTotal de plata: 121,00', '');
  eq('doar total: baza derivata din cota standard', only.fields.baza, 100);
  eq('doar total: TVA derivat', only.fields.tva, 21);
}

section('Serializare sigura a bazei (stringifyDb: BigInt / valori nefinite)');
{
  const { stringifyDb } = require('../src/util');
  // BigInt: nu mai arunca TypeError; sub MAX_SAFE_INTEGER devine numar, peste devine string
  eq('BigInt mic -> numar JSON', stringifyDb({ suma: 42n }), '{"suma":42}');
  eq('BigInt peste MAX_SAFE_INTEGER -> string (fara pierdere de precizie)', stringifyDb({ id: 9007199254740993n }), '{"id":"9007199254740993"}');
  // valorile nefinite pastreaza comportamentul JSON standard (null), dar sunt semnalate in log
  eq('NaN -> null (ca JSON standard)', stringifyDb({ x: NaN }), '{"x":null}');
  eq('Infinity -> null (ca JSON standard)', stringifyDb({ x: Infinity }), '{"x":null}');
  ok('pretty-print cu spatiere functioneaza', /\n  "a": 1/.test(stringifyDb({ a: 1 }, 2)));
  // referintele circulare raman erori vizibile (nu au reprezentare corecta)
  const circ = {}; circ.self = circ;
  ok('referinta circulara arunca in continuare', (() => { try { stringifyDb(circ); return false; } catch (e) { return true; } })());

  // scenariul grav de dinainte: un BigInt in graf facea ca TOATE save()-urile sa esueze.
  // Acum save() pe driverul real (sqlite in teste) supravietuieste si persista valoarea convertita.
  const dbx = require('../src/db');
  const d = dbx.get();
  d.audit = d.audit || [];
  d.audit.push({ id: (d.audit[d.audit.length - 1] || {}).id + 1 || 1, ts: new Date().toISOString(), action: 'test.bigint', detail: '', userId: 1, username: 'x', firmaId: null, durataNs: 12345n });
  let saved = true;
  try { dbx.save(); } catch (e) { saved = false; }
  ok('save() cu BigInt in graf nu mai arunca (persistenta supravietuieste)', saved);
  d.audit = d.audit.filter((a) => a.action !== 'test.bigint');
  dbx.save();
}

section('Garda node:sqlite (driverul implicit cere Node >= 22.13)');
{
  // node:sqlite nu exista pe Node < 22.5 (si e sub flag pana la 22.13): fara garda, driverul
  // IMPLICIT ar cadea cu o eroare criptica la require. checkSqlite transforma caderea intr-un
  // mesaj actionabil, iar package.json declara cerinta (npm avertizeaza la install).
  const storeMod = require('../src/store');
  ok('pe Node curent, checkSqlite trece (DatabaseSync disponibil)', !!storeMod.checkSqlite(require('node:sqlite')));
  const msg = (() => { try { storeMod.checkSqlite({}, 'v18.19.0'); return ''; } catch (e) { return e.message; } })();
  ok('fara DatabaseSync: mesajul numeste versiunea gasita', /v18\.19\.0/.test(msg));
  ok('mesajul numeste cerinta si flagul istoric', /22\.13/.test(msg) && /--experimental-sqlite/.test(msg));
  ok('mesajul ofera driverele alternative', /CONTAB_DB_DRIVER=pg/.test(msg) && /CONTAB_DB_DRIVER=json/.test(msg));
  const pkg = require('../package.json');
  ok('package.json declara engines.node >= 22.13', !!(pkg.engines && pkg.engines.node === '>=22.13'));
}

section('Joburi periodice opribile (src/jobs.js: unref + stop)');
{
  // Intervalele joburilor nu au voie sa tina un proces in viata sau sa "scape" dintr-un test:
  // sunt unref() la creare, iar start() intoarce un stop() care le curata pe toate.
  const jobs = require('../src/jobs');
  const stubs = { doBackup: () => ({ name: 'x' }), resetDemo: () => ({ ok: true }), registerAttempts: new Map(), forgotAttempts: new Map() };
  const h = jobs.start(stubs);
  ok('start() intoarce un handle cu stop()', h && typeof h.stop === 'function');
  eq('stop() curata toate cele 7 joburi', h.stop(), 7);
  eq('stop() e idempotent (a doua oara: nimic de curatat)', jobs.stop(), 0);
  // dupa stop, un nou start functioneaza si se curata la fel (nu ramane stare blocata)
  jobs.start(stubs);
  eq('restart dupa stop: tot 7 joburi, curatate din nou', jobs.stop(), 7);
}

section('Migrari DB versionate (src/migrations.js)');
// backfill idempotent al statutului `activ` pe produse (dezactivarea inlocuieste stergerea)
{
  const dMig = { firme: [{ id: 1 }], products: [{ id: 'x1', cod: 'A' }, { id: 'x2', cod: 'B', activ: false }, { id: 'x3', cod: 'C', activ: true }], partners: {}, openingBalances: {}, settings: {} };
  db.migrate(dMig);
  eq('produs fara camp -> activ:true', dMig.products[0].activ, true);
  eq('produs dezactivat -> ramane false', dMig.products[1].activ, false);
  eq('produs activ -> ramane true (idempotent)', dMig.products[2].activ, true);
}

{
  const mig = require('../src/migrations');
  const quiet = { info: () => {} }; // fara zgomot in log din testele de migrare
  // baza VECHE (fara schemaVersion): aplica pasii in ordine, stampileaza LATEST
  const dOld = { entries: [{ id: 'e1', data: '2026-03-15' }, { id: 'e2', data: '2026-04-01', period: '2026-04' }] };
  const applied = mig.runMigrations(dOld, { log: quiet });
  eq('baza veche -> schemaVersion stampilat la LATEST', dOld.schemaVersion, mig.LATEST);
  eq('v1 backfill: period derivat din data unde lipsea', dOld.entries[0].period, '2026-03');
  eq('v1 backfill: period existent NU se atinge', dOld.entries[1].period, '2026-04');
  ok('v1 a raportat inregistrarea atinsa', applied.some((a) => a.v === 1 && a.changed === 1));
  // re-rulare pe baza deja migrata: idempotent prin VERSIUNE (niciun pas)
  const applied2 = mig.runMigrations(dOld, { log: quiet });
  eq('re-rulare: niciun pas aplicat', applied2.length, 0);
  // baza deja la LATEST: pasii <= schemaVersion nu ruleaza
  const dNew = { entries: [{ id: 'x', data: '2026-01-01' }], schemaVersion: mig.LATEST };
  mig.runMigrations(dNew, { log: quiet });
  ok('baza la zi: backfill nu ruleaza (period ramane absent)', dNew.entries[0].period === undefined);
  // forward-only: o baza mai noua decat codul NU se coboara
  const dFuture = { entries: [], schemaVersion: mig.LATEST + 5 };
  mig.runMigrations(dFuture, { log: quiet });
  eq('forward-only: versiunea mai noua nu se coboara', dFuture.schemaVersion, mig.LATEST + 5);
  // versiuni strict crescatoare, fara duplicate (contract pentru autorii de pasi)
  const vs = mig.MIGRATIONS.map((m) => m.v);
  ok('versiunile migrarilor sunt strict crescatoare', vs.every((v, i) => i === 0 || v > vs[i - 1]));
  // integrare: baza reala incarcata de db.js a primit schemaVersion prin hook-ul din migrate()
  eq('db incarcata: schemaVersion = LATEST (hook in migrate)', require('../src/db').get().schemaVersion, mig.LATEST);
}

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
}

section('PWA: manifest + service worker (instalabilitate + siguranta cache)');
{
  const fsx = require('fs'); const pth = require('path');
  const pub = pth.join(__dirname, '..', 'public');
  const man = JSON.parse(fsx.readFileSync(pth.join(pub, 'manifest.webmanifest'), 'utf8'));
  ok('manifest: name + short_name', !!man.name && !!man.short_name);
  eq('manifest: start_url = /', man.start_url, '/');
  eq('manifest: display standalone (instalabil)', man.display, 'standalone');
  ok('manifest: are icoana 192 si 512', man.icons.some((i) => i.sizes === '192x192') && man.icons.some((i) => i.sizes === '512x512'));
  ok('manifest: are o icoana maskable', man.icons.some((i) => i.purpose === 'maskable'));
  ok('manifest: theme/background din brand', man.theme_color === '#2f2e2a' && man.background_color === '#f0ede4');
  // iconitele referite exista si sunt PNG-uri reale
  for (const ic of man.icons) {
    const f = pth.join(pub, ic.src.replace(/^\//, ''));
    ok('iconita exista: ' + ic.src, fsx.existsSync(f));
    const head = fsx.readFileSync(f).subarray(0, 4);
    ok('iconita e PNG valid: ' + ic.src, head[0] === 0x89 && head.subarray(1, 4).toString() === 'PNG');
  }
  const sw = fsx.readFileSync(pth.join(pub, 'sw.js'), 'utf8');
  ok('SW: are handler de fetch (cerinta de instalabilitate)', /addEventListener\('fetch'/.test(sw));
  ok('SW: doar GET', /req\.method !== 'GET'/.test(sw));
  ok('SW: ocoleste datele de utilizator (/api|/pdf|/xml|/csv|/efactura)', /api\|pdf\|xml\|csv\|efactura/.test(sw));
  ok('SW: doar same-origin', /url\.origin !== self\.location\.origin/.test(sw));
  ok('SW: cache versionat (activate sterge ce e vechi)', /contab-shell-v\d/.test(sw));
  // index.html leaga manifestul + theme-color
  const idx = fsx.readFileSync(pth.join(pub, 'index.html'), 'utf8');
  ok('index.html: <link rel="manifest">', /rel="manifest"[^>]*manifest\.webmanifest/.test(idx));
  ok('index.html: meta theme-color', /name="theme-color"/.test(idx));
  // inregistrarea SW e in core.js, in context sigur
  const core = fsx.readFileSync(pth.join(pub, 'core.js'), 'utf8');
  ok('core.js: inregistreaza sw.js', /serviceWorker'?\s* in navigator/.test(core) && /register\('\/sw\.js'/.test(core));
  ok('core.js: doar in context sigur (https/localhost)', /https:|localhost|127\.0\.0\.1/.test(core.split('serviceWorker')[1] || ''));
}

section('Plafon general de API (uploadGuard.generalLimit)');
{
  const ug = require('../src/uploadGuard');
  const mk = (uid, ip) => ({ user: uid != null ? { id: uid } : null, ip: ip || '203.0.113.1' });
  const run = (mw, req) => { let out = null; const res = { status(c) { out = c; return this; }, json() { return this; } }; let passed = false; mw(req, res, () => { passed = true; }); return passed ? 'next' : out; };
  const lim = ug.generalLimit(3, 60 * 1000);
  eq('sub plafon: cererile trec (3/3)', [run(lim, mk(501)), run(lim, mk(501)), run(lim, mk(501))].join(','), 'next,next,next');
  eq('peste plafon: 429', run(lim, mk(501)), 429);
  eq('alt utilizator nu e afectat', run(lim, mk(502)), 'next');
  eq('anonimii sunt plafonati per IP', [run(lim, mk(null, '198.51.100.1')), run(lim, mk(null, '198.51.100.1')), run(lim, mk(null, '198.51.100.1')), run(lim, mk(null, '198.51.100.1'))].pop(), 429);
  eq('alt IP anonim nu e afectat', run(lim, mk(null, '198.51.100.2')), 'next');
  eq('plafon 0 = dezactivat', run(ug.generalLimit(0, 60000), mk(501)), 'next');
  ug.pruneRateBuckets(Date.now() + 61 * 1000); // igiena: bucket-urile de test dispar
  eq('dupa expirarea ferestrei, contorul porneste de la zero', run(lim, mk(501)), 'next');
}

section('CSP: style-src FARA unsafe-inline (poarta zero)');
{
  // styleSrc e doar 'self' (src/bootstrap.js): orice element <style> sau atribut style= din
  // markup ar fi BLOCAT de browser. Poarta tine suprafata la zero: stilurile statice merg in
  // u.css/styles.css (data-u sau clase), cele dinamice prin data-style + CSSOM (core.js).
  // setAttribute('style') e si el blocat de CSP — foloseste el.style.prop / el.style.cssText.
  const fsx = require('fs'); const pth = require('path');
  const pub = pth.join(__dirname, '..', 'public');
  const files = fsx.readdirSync(pub);
  const count = (ext, re) => files.filter((f) => f.endsWith(ext))
    .map((f) => (fsx.readFileSync(pth.join(pub, f), 'utf8').match(re) || []).length)
    .reduce((a, b) => a + b, 0);
  eq('zero elemente <style> in paginile HTML', count('.html', /<style[\s>]/g), 0);
  eq('zero atribute style= in HTML (data-u/data-style permise)', count('.html', /(?<!data-)style="/g), 0);
  eq('zero atribute style= in template-urile JS', count('.js', /(?<!data-)style=\\?"/g), 0);
  eq('zero setAttribute(style) in JS (blocat de CSP; foloseste el.style)', count('.js', /setAttribute\((['"])style\1/g), 0);
  ok('CSP: styleSrc nu mai contine unsafe-inline', !/styleSrc[^\]]*unsafe-inline/.test(fsx.readFileSync(pth.join(__dirname, '..', 'src', 'bootstrap.js'), 'utf8')));
}

section('Docs API: rutele documentate exista in cod (fara drift)');
{
  const fsx = require('fs'); const pth = require('path');
  const root = pth.join(__dirname, '..');
  const norm = (m, p) => m.toUpperCase() + ' ' + p.replace(/\?.*$/, '').replace(/:[a-zA-Z0-9_]+|\{[a-zA-Z0-9_]+\}/g, ':_').replace(/\/$/, '');
  // rutele DOCUMENTATE in docs/api.md: `METHOD /path`
  const apiMd = fsx.readFileSync(pth.join(root, 'docs', 'api.md'), 'utf8');
  const documented = new Set();
  for (const m of apiMd.matchAll(/`(GET|POST|PUT|DELETE)\s+(\/[a-zA-Z0-9/_:{}?=.&-]+)`/g)) {
    const r = norm(m[1], m[2]);
    // docs foloseste forma prescurtata `DELETE /:id` relativa la ruta precedenta (ex. dupa
    // `GET/POST /api/products`) — nu e o ruta de sine statatoare, deci o sarim.
    if (/ \/:_$/.test(r)) continue;
    documented.add(r);
  }
  // rutele INREGISTRATE in cod: app.method('/path'
  const codeFiles = ['server.js', 'src/authRoutes.js', ...fsx.readdirSync(pth.join(root, 'src', 'routes')).map((f) => 'src/routes/' + f)];
  const registered = new Set();
  for (const f of codeFiles) {
    const s = fsx.readFileSync(pth.join(root, f), 'utf8');
    for (const m of s.matchAll(/app\.(get|post|put|delete)\('(\/[a-zA-Z0-9/_:.-]+)'/g)) registered.add(norm(m[1], m[2]));
  }
  ok('docs/api.md are rute documentate (grep-abile)', documented.size > 50);
  const drifted = [...documented].filter((r) => !registered.has(r));
  ok('fiecare ruta documentata exista in cod (drift = ' + drifted.length + ')' + (drifted.length ? ': ' + drifted.slice(0, 5).join(', ') : ''), drifted.length === 0);

  // ── Poartă: orice rută de SCRIERE arată o formă de autorizare ──
  // Lectia din `/api/accounts/import` (merge d117de9): ruta scria planul de conturi GLOBAL fara
  // requireAdmin si fara scoping, iar un utilizator legat de o singura firma redenumea conturi
  // pentru toate. Autentificarea e garantata central (o singura garda in bootstrap), dar
  // AUTORIZAREA e per-ruta — deci se poate uita, si atunci nimic nu semnaleaza.
  // Dovada acceptata: scoping pe firma (activeId/S(req)/reqFirma/canAccess/firmaId), garda de
  // admin, sau predarea lui req.user unui serviciu care autorizeaza el (tiparul reqEntry).
  const AUTZ = /\bactiveId\(|\bS\(req\)|\breqFirma\b|\bcanAccess\(|\bfirmaId\b|\breq\.user\b|\brequireAdmin\b|\bdemoContLock\b/;
  // Exceptii REVIZUITE, fiecare cu motivul ei. O ruta noua care ajunge aici trebuie justificata
  // explicit — asta e rostul portii, nu sa fie ocolita.
  const FARA_AUTZ_OK = new Map([
    ['POST /api/efactura/parse', 'fara persistenta: converteste XML-ul primit in campuri, nu scrie nimic'],
    ['POST /api/xlsx-to-csv', 'fara persistenta: conversie de format pentru fluxurile de import'],
    ['POST /api/checkout-guest', 'PUBLICA prin proiectare (vizitator neautentificat, inainte de cont)'],
    ['POST /api/production', 'autorizata in helperul doProduction (activeId + S(req)), nu in corpul rutei'],
  ]);
  const neautorizate = [];
  for (const f of codeFiles) {
    const s = fsx.readFileSync(pth.join(root, f), 'utf8');
    for (const m of s.matchAll(/app\.(post|put|patch|delete)\(\s*'([^']+)'([\s\S]{0,900}?)(?=\n {2}app\.|\n\};|$)/g)) {
      const cheie = m[1].toUpperCase() + ' ' + m[2];
      if (AUTZ.test(m[3]) || FARA_AUTZ_OK.has(cheie)) continue;
      neautorizate.push(cheie + '  (' + f + ')');
    }
  }
  ok('fiecare ruta de scriere arata o autorizare (sau e pe lista revizuita)'
    + (neautorizate.length ? ' — ' + neautorizate.slice(0, 5).join(' | ') : ''), neautorizate.length === 0);
  // poarta trebuie sa POATA pica
  ok('poarta de autorizare chiar detecteaza o ruta fara garda',
    !AUTZ.test("(req, res) => run(res, () => { const r = svc.importAccounts((req.body || {}).csv); return r; })"));
  ok('poarta accepta scoping pe firma', AUTZ.test("(req, res) => res.json(svc.list(activeId(req)))"));
  ok('poarta accepta garda de admin', AUTZ.test("requireAdmin, (req, res) => res.json(svc.all())"));
}


console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari trecute, ' + fail + ' esuate.');
process.exit(fail ? 1 : 0);
