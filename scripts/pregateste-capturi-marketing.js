'use strict';

// Fixture exclusiv pentru capturile de marketing. Pleacă de la seed-ul oficial,
// adaugă șase firme cu același profil fiscal și pregătește un portofoliu realist:
// șase firme la zi, una încă în lucru. Rulează numai cu baza temporară creată de
// `capturi-marketing.sh`; garda de mediu oprește orice pornire accidentală.
if (process.env.CONTAB_CAPTURI_IZOLAT !== '1' || !process.env.CONTAB_DB_FILE || !/\/tmp\//.test(process.env.CONTAB_DB_FILE)) {
  console.error('Fixture-ul de capturi cere CONTAB_CAPTURI_IZOLAT=1 și o bază temporară în /tmp.');
  process.exit(2);
}

const db = require('../src/db');
const declaratii = require('../src/declarations');
const crypto = require('crypto');
const passwordAuth = require('../src/auth');

const PERIOD = process.env.CAPTURI_PERIOD || new Date().toISOString().slice(0, 7);
const INITIAL_PASSWORD = process.env.CAPTURI_INITIAL_PW || 'ParolaCapturi2026x!';
const TODAY = PERIOD + '-16'; // în interiorul lunii: nicio obligație a lunii nu este restantă
const NUME = [
  'Atelier Nord SRL', 'Cabinet Meridian SRL', 'Distribuție Verde SRL',
  'Logistic Pro SRL', 'Studio Urban SRL', 'Tehnic Consult SRL',
];

function cuiDin(index) {
  const corp = String(41000000 + index * 137).padStart(9, '0');
  const ponderi = [7, 5, 3, 2, 1, 7, 5, 3, 2];
  let suma = 0;
  for (let i = 0; i < 9; i += 1) suma += Number(corp[i]) * ponderi[i];
  let control = (suma * 10) % 11;
  if (control === 10) control = 0;
  return String(Number(corp + control));
}

const auth = (action) => ({ authorized: true, action, actorId: 'fixture-capturi',
  username: 'fixture-capturi', role: 'admin', source: 'marketing-isolated-fixture' });

function continutExact(label, filename, mime) {
  const bytes = Buffer.from(label, 'utf8');
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    filename, mime, contentBase64: bytes.toString('base64'),
  };
}

/** Construieste traseul real generata → aprobata → transmisa → depusa. Fixture-ul vechi sarea
 * direct la `depusa`, ceea ce a devenit corect interzis de registrul append-only. */
function marcheazaDepusa(d, firmaId, tip, period, recipisa) {
  const profileHash = crypto.createHash('sha256').update('profil|' + firmaId + '|' + period).digest('hex');
  const artifact = Object.assign(continutExact('<declaratie fixture="marketing"/>', tip + '-' + period + '.xml', 'application/xml'), {
    profileSnapshot: { hash: profileHash, provenanceHash: profileHash, values: { fixture: true } },
  });
  declaratii.record(d, firmaId, tip, period, {
    status: 'generata', artifact, profileSnapshot: artifact.profileSnapshot,
    authorization: auth('declaration.prepare'), updatedBy: 'fixture-capturi',
  }, db.nextId);
  const aprobare = declaratii.approveDocument(d, firmaId, tip, period, {
    artifactHash: artifact.sha256, authorization: auth('declaration.approve'),
    fiscalReviewEvidence: { ready: true, hash: crypto.createHash('sha256').update('revizie-fixture').digest('hex') },
    note: 'Dovada sintetica pentru captura izolata',
  }).approval;
  // Dovada este sintetica si permisa numai de garda CONTAB_CAPTURI_IZOLAT de la inceputul
  // fisierului. Nu pretinde ca a rulat DUK: tine fixture-ul pe acelasi traseu criptografic ca
  // produsul, astfel incat transmiterea sa nu ocoleasca validarea artefactului exact.
  declaratii.recordOfficialValidation(d, firmaId, tip, period, {
    artifactHash: artifact.sha256,
    validator: { name: 'DUKIntegrator-fixture-capturi', version: '2026.08-fixture', distributionHash: '6'.repeat(64) },
    schema: { name: String(tip).toUpperCase() + '-fixture', version: '2026.08-fixture', hash: '7'.repeat(64) },
    result: { status: 'valid', errors: [], warnings: [], fullOutput: 'FIXTURE IZOLAT: document valid ' + artifact.sha256 },
    validatedAt: period + '-20T10:01:00.000Z',
    authorization: auth('declaration.validate'),
  });
  declaratii.record(d, firmaId, tip, period, {
    status: 'transmisa', documentApproval: aprobare,
    authorization: auth('declaration.submit'), updatedBy: 'fixture-capturi',
  }, db.nextId);
  const receipt = continutExact('recipisa fixture ' + recipisa, recipisa + '.txt', 'text/plain');
  return declaratii.record(d, firmaId, tip, period, {
    status: 'depusa', recipisa, receiptEvidence: receipt, documentApproval: aprobare,
    authorization: auth('declaration.submit'), updatedBy: 'fixture-capturi',
  }, db.nextId);
}

function marcheazaGenerata(d, firmaId, tip, period) {
  const profileHash = crypto.createHash('sha256').update('profil|' + firmaId + '|' + period).digest('hex');
  const artifact = Object.assign(continutExact('<declaratie fixture="marketing-in-lucru"/>',
    tip + '-' + period + '.xml', 'application/xml'), {
    profileSnapshot: { hash: profileHash, provenanceHash: profileHash, values: { fixture: true } },
  });
  return declaratii.record(d, firmaId, tip, period, {
    status: 'generata', artifact, profileSnapshot: artifact.profileSnapshot,
    authorization: auth('declaration.prepare'), updatedBy: 'fixture-capturi',
  }, db.nextId);
}

Promise.resolve(db.load()).then(async () => {
  const d = db.get();
  // Producția pornește acum fail-closed, cu admin inutilizabil până la bootstrap și apoi cu 2FA
  // obligatoriu. Fixture-ul efemer folosește aceeași identitate numai ca utilizator contabil de
  // vizualizare, limitat explicit la firmele sintetice; astfel nu ocolește poarta privilegiată.
  const adminUser = d.users.find((user) => user.username === 'admin');
  if (!adminUser) throw new Error('Seed-ul nu conține contul admin pentru captura izolată.');
  const credentials = passwordAuth.hashPassword(INITIAL_PASSWORD);
  Object.assign(adminUser, credentials, {
    role: 'user', tipCont: 'contabil', bootstrapPending: false, mustChange: false,
    subscription: { status: 'active', plan: 'pro', since: PERIOD + '-01T00:00:00.000Z' },
    profil: { numeComplet: 'Contabil Fixture', telefon: '0700000000' },
  });

  const baza = d.firme[0];
  if (!baza) throw new Error('Seed-ul nu conține firma exemplu.');
  baza.createdAt = PERIOD.slice(0, 4) + '-01-01T00:00:00.000Z';

  // Captura de pe login trebuie sa fie chiar experienta „Demo patron”, nu dashboardul acestui
  // utilizator-contabil. Identitatea dedicata detine numai firma exemplu si nu primeste acces la
  // portofoliul sintetic folosit de celelalte materiale.
  const patronId = db.nextUserId();
  const patronCredentials = passwordAuth.hashPassword(INITIAL_PASSWORD);
  const patronUser = Object.assign({
    id: patronId, username: 'demo', email: 'demo-patron@example.invalid',
    role: 'user', tipCont: 'patron', bootstrapPending: false, mustChange: false,
    firme: [baza.id], firmaActiva: baza.id, firmaRoluri: { [baza.id]: 'vizualizare' },
    profil: { numeComplet: 'Patron Demo', telefon: '0700000001' },
    createdAt: PERIOD + '-01T00:00:00.000Z',
  }, patronCredentials);
  baza.ownerId = patronId;
  d.users.push(patronUser);

  // Seed-ul oficial are factura clientului incasata integral si factura furnizorului fara
  // scadenta. Doua documente comerciale fictive lasa vizibile exact intrebarile patronului:
  // ce am de incasat si ce trebuie platit in urmatoarele 30 de zile. Taxele rezulta in continuare
  // din articolele reale ale seed-ului si apar in „De facut acum”.
  db.pushEntry({
    id: db.nextId('e'), firmaId: baza.id, data: '2026-06-24', period: '2026-06',
    tip: 'factura_vanzare_servicii', tipNume: 'Factura prestari servicii (emisa)',
    partener: 'CLIENT DEMO SRL', partenerCui: 'RO87654321', document: 'DEM 204',
    openItem: { dueDate: '2026-07-15', dueSource: 'document' }, fileId: null, system: false,
    lines: [
      { debit: '4111', credit: '704', suma: 6000, explicatie: 'Servicii fictive pentru captura Demo patron' },
      { debit: '4111', credit: '4427', suma: 1260, explicatie: 'TVA colectata' },
    ],
  }, { context: 'fixture captura Demo patron' });
  db.pushEntry({
    id: db.nextId('e'), firmaId: baza.id, data: '2026-06-25', period: '2026-06',
    tip: 'factura_cumparare_servicii', tipNume: 'Factura cumparare servicii',
    partener: 'FURNIZOR DEMO SRL', partenerCui: 'RO22334455', document: 'FDM 88',
    openItem: { dueDate: '2026-07-20', dueSource: 'document' }, fileId: null, system: false,
    lines: [
      { debit: '628', credit: '401', suma: 2500, explicatie: 'Servicii fictive pentru captura Demo patron' },
      { debit: '4426', credit: '401', suma: 525, explicatie: 'TVA deductibila' },
    ],
  }, { context: 'fixture captura Demo patron' });

  for (let i = 0; i < NUME.length; i += 1) {
    const id = db.nextFirmaId();
    const firma = Object.assign(db.defaultFirma(id), db.pickFirmaFields(baza), {
      id,
      nume: NUME[i],
      cui: cuiDin(i + 1),
      regCom: 'J40/' + (2100 + i) + '/2024',
      createdAt: baza.createdAt,
      subscription: { status: 'active', plan: 'grandfathered', since: baza.createdAt },
    });
    d.firme.push(firma);
    d.partners[id] = {};
    d.openingBalances[id] = {};
  }

  // Istoricul recent este închis pentru toate firmele. Altfel dashboard-ul ar
  // amesteca starea controlată a lunii capturate cu restanțe implicite din cele
  // trei luni anterioare — o captură tehnic validă, dar nereprezentativă pentru
  // un portofoliu administrat la zi.
  const perioadeInchise = [1, 2, 3].map((luni) => declaratii.addMonths(PERIOD, -luni));
  d.firme.forEach((firma) => {
    perioadeInchise.forEach((period) => {
      declaratii.registerForFirma(d, db.scoped(firma.id), period, TODAY).forEach((rand, randIndex) => {
        marcheazaDepusa(d, firma.id, rand.tip, period,
          'CAP-IST-' + firma.id + '-' + period.replace('-', '') + '-' + String(randIndex + 1).padStart(2, '0'));
      });
    });
  });

  // Toate firmele au același profil, deci șase din șapte la zi înseamnă o
  // conformitate stabilă și ușor de înțeles, fără un 100% artificial.
  d.firme.forEach((firma, firmaIndex) => {
    const randuri = declaratii.registerForFirma(d, db.scoped(firma.id), PERIOD, TODAY);
    randuri.forEach((rand, randIndex) => {
      const gata = firmaIndex < d.firme.length - 1;
      if (gata) {
        marcheazaDepusa(d, firma.id, rand.tip, PERIOD,
          'CAP-' + firma.id + '-' + String(randIndex + 1).padStart(2, '0'));
      } else if (randIndex % 2 === 0) marcheazaGenerata(d, firma.id, rand.tip, PERIOD);
    });
  });

  adminUser.firme = d.firme.map((firma) => firma.id);
  adminUser.firmaRoluri = Object.fromEntries(d.firme.map((firma) => [String(firma.id), 'vizualizare']));
  adminUser.firmaActiva = baza.id;
  d.firmaActiva = baza.id;
  const portofoliu = declaratii.portfolio(d, d.firme.map((f) => db.scoped(f.id)), PERIOD, TODAY);
  if (portofoliu.firms.length !== 7 || portofoliu.conformitate < 70 || portofoliu.conformitate > 90 || portofoliu.tot.restante !== 0) {
    throw new Error('Fixture portofoliu neverosimil: ' + JSON.stringify(portofoliu.tot)
      + ', conformitate=' + portofoliu.conformitate + ', firme=' + portofoliu.firms.length);
  }
  db.save();
  await db.flushStore();
  console.log('Fixture capturi:', PERIOD, '| firme:', portofoliu.firms.length,
    '| conformitate:', portofoliu.conformitate + '%', '| restante:', portofoliu.tot.restante);
}).catch((error) => {
  console.error('Pregătirea capturilor a eșuat:', error.message);
  process.exit(1);
});
