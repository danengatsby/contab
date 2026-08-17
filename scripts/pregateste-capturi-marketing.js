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

const PERIOD = process.env.CAPTURI_PERIOD || new Date().toISOString().slice(0, 7);
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

Promise.resolve(db.load()).then(async () => {
  const d = db.get();
  const baza = d.firme[0];
  if (!baza) throw new Error('Seed-ul nu conține firma exemplu.');
  baza.createdAt = PERIOD.slice(0, 4) + '-01-01T00:00:00.000Z';

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
        declaratii.record(d, firma.id, rand.tip, period, {
          status: 'depusa',
          recipisa: 'CAP-IST-' + firma.id + '-' + period.replace('-', '') + '-' + String(randIndex + 1).padStart(2, '0'),
          updatedBy: 'fixture-capturi',
        }, db.nextId);
      });
    });
  });

  // Toate firmele au același profil, deci șase din șapte la zi înseamnă o
  // conformitate stabilă și ușor de înțeles, fără un 100% artificial.
  d.firme.forEach((firma, firmaIndex) => {
    const randuri = declaratii.registerForFirma(d, db.scoped(firma.id), PERIOD, TODAY);
    randuri.forEach((rand, randIndex) => {
      const gata = firmaIndex < d.firme.length - 1;
      declaratii.record(d, firma.id, rand.tip, PERIOD, {
        status: gata ? 'depusa' : (randIndex % 2 ? 'nedepusa' : 'generata'),
        recipisa: gata ? 'CAP-' + firma.id + '-' + String(randIndex + 1).padStart(2, '0') : '',
        note: gata ? '' : 'În verificare',
        updatedBy: 'fixture-capturi',
      }, db.nextId);
    });
  });

  const admin = (d.users || []).find((u) => u.username === 'admin');
  if (admin) admin.firmaActiva = baza.id;
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
