'use strict';

// Service layer pentru scrierile de salarizare: nomenclatorul de angajati, postarea statului
// de plata (articolul agregat + instantaneul lunar in payrollHistory) si plata neta a
// salariilor. Rutele (src/routes/payroll.js) raman puncte de intrare subtiri; citirile
// (stat de plata, registru, dosar CM) si PDF-urile raman in ruta — sunt pure pe view.
//
// buildEntry ramane infrastructura partajata in server.js si vine ca dependenta in `deps`
// (tiparul din entriesService). Autorizarea pe firma e dublata prin reqFirma.

const db = require('./db');
const sepa = require('./sepa');
const { round2, ultimaZiDinLuna } = require('./util');
const { statePlata } = require('./payroll');
const { reqFirma } = require('./stocksService');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

function upsertAngajat(fid, b) {
  fid = reqFirma(fid); b = b || {};
  if (!b.nume || !b.salariuBrut) fail(400, 'Completeaza numele si salariul brut.');
  const d = db.get();
  const a = b.id && (d.angajati || []).find((x) => x.id === b.id && x.firmaId === fid);
  const rec = a || { id: db.nextId('ang'), firmaId: fid };
  // IBAN-ul angajatului: pentru lotul de plata a salariilor nete (pain.001). Optional.
  Object.assign(rec, { iban: b.iban != null ? sepa.normIban(b.iban) : (rec.iban || ''),
    nume: String(b.nume), cnp: b.cnp || '', functie: b.functie || '', salariuBrut: round2(Number(b.salariuBrut) || 0), neimpozabil: round2(Number(b.neimpozabil) || 0), spor: round2(Number(b.spor) || 0), avans: round2(Number(b.avans) || 0), retineri: round2(Number(b.retineri) || 0), persoane: b.persoane === '' || b.persoane == null ? null : Math.max(0, Math.round(Number(b.persoane) || 0)), sub26: !!b.sub26, copii: Math.max(0, Math.round(Number(b.copii) || 0)), tichete: round2(Number(b.tichete) || 0), avantaje: round2(Number(b.avantaje) || 0), zileCM: Math.max(0, Math.round(Number(b.zileCM) || 0)), procentCM: [75, 85, 100].includes(Number(b.procentCM)) ? Number(b.procentCM) : 75, zileCO: Math.max(0, Math.round(Number(b.zileCO) || 0)), zileLucratoare: Math.max(1, Math.round(Number(b.zileLucratoare) || 21)), normaPartiala: !!b.normaPartiala, scutitNormaPartiala: !!b.scutitNormaPartiala, sector: ['it', 'constructii', 'agro'].includes(b.sector) ? b.sector : 'normal' });
  if (!a) d.angajati.push(rec);
  db.save();
  return { angajat: rec };
}

function deleteAngajat(fid, id) {
  fid = reqFirma(fid);
  const d = db.get();
  const a = (d.angajati || []).find((x) => x.id === id && x.firmaId === fid);
  if (!a) fail(404, 'Angajat inexistent.'); // izolare multi-firma
  d.angajati = (d.angajati || []).filter((x) => x !== a);
  db.save();
}

/** Posteaza statul de plata pe o luna: articolul agregat (retineri, CM, norma partiala) +
 *  instantaneul lunar in payrollHistory (inlocuieste luna daca era deja inregistrata —
 *  baza registrului anual si a adeverintelor). buildEntry e apelat intentionat fara catch
 *  (ca in ruta istorica): o eroare de acolo urca la handlerul global. */
function postStatPlata(fid, period, deps) {
  fid = reqFirma(fid);
  const v = db.scoped(fid);
  if (!v.angajati.length) fail(400, 'Niciun angajat definit.');
  if (!period) fail(400, 'Lipseste perioada (YYYY-MM).');
  db.assertPeriodOpen(fid, period, 'Postarea statului de plata');
  // Jurnal append-only: statul lunii se posteaza O SINGURA DATA. `payrollHistory` era inlocuit la
  // fiecare rulare (deci idempotent), dar articolul se ADAUGA — a doua apasare dubla tacut 641=421
  // si toate retinerile, iar istoricul continua sa arate o singura luna. Aceeasi garda ca la
  // impozitul pe profit; corectia se face prin storno, nu prin repostare.
  const dejaPostat = db.get().entries.find((e) => e.firmaId === fid && e.tip === 'stat_plata'
    && (e.period || '') === period && !e.stornat);
  if (dejaPostat) {
    fail(400, 'Statul de plata pe ' + period + ' este deja postat (articolul ' + dejaPostat.id
      + '). Corecteaza prin storno, apoi posteaza din nou.');
  }
  const sp = statePlata(v.angajati, period, v.payrollHistory);
  const data = ultimaZiDinLuna(period);
  // posteaza articolul de salarii cu sumele agregate din statul de plata (potrivite exact)
  const entry = deps.buildEntry('stat_plata', {
    data, brut: sp.totals.brut, neimpozabil: sp.totals.neimpozabil,
    cas: sp.totals.cas, cass: sp.totals.cass, impozit: sp.totals.impozit, cam: sp.totals.cam,
    analitic: sp.rows.length + ' angajati',
  }, null, fid);
  entry.system = true; entry.document = 'Stat plata ' + period;
  if (sp.totals.avans > 0) entry.lines.push({ debit: '421', credit: '425', suma: sp.totals.avans, explicatie: 'Reținere avans acordat' });
  if (sp.totals.retineri > 0) entry.lines.push({ debit: '421', credit: '427', suma: sp.totals.retineri, explicatie: 'Rețineri din salarii (terți/popriri)' });
  // Concedii medicale: drepturile trec tot prin 421 (retinerile si plata raman pe un singur cont);
  // partea FNUASS e creanta de recuperat (4373 debit). Alternativa cu 423 exista ca tipuri manuale.
  if (sp.totals.cmAngajator > 0) entry.lines.push({ debit: '6458', credit: '421', suma: sp.totals.cmAngajator, explicatie: 'Indemnizații CM suportate de angajator (primele 5 zile lucrătoare)' });
  if (sp.totals.cmFnuass > 0) entry.lines.push({ debit: '4373', credit: '421', suma: sp.totals.cmFnuass, explicatie: 'Indemnizații CM suportate de FNUASS (de recuperat)' });
  // Norma partiala sub salariul minim (OUG 16/2022): diferentele de CAS/CASS pana la nivelul
  // salariului minim sunt CHELTUIALA a angajatorului (nu retinere din salariat).
  if (sp.totals.casAngajator > 0) entry.lines.push({ debit: '6458', credit: '4315', suma: sp.totals.casAngajator, explicatie: 'CAS suportat de angajator — normă parțială sub salariul minim' });
  if (sp.totals.cassAngajator > 0) entry.lines.push({ debit: '6458', credit: '4316', suma: sp.totals.cassAngajator, explicatie: 'CASS suportat de angajator — normă parțială sub salariul minim' });
  const d = db.get();
  d.entries.push(entry);
  // instantaneu in istoricul de salarizare (inlocuieste daca luna era deja inregistrata)
  d.payrollHistory = (d.payrollHistory || []).filter((h) => !(h.firmaId === fid && h.period === period));
  d.payrollHistory.push({
    id: db.nextId('ph'), firmaId: fid, period, ts: new Date().toISOString(),
    rows: sp.rows.map((r) => ({ angajatId: r.id, nume: r.nume, cnp: r.cnp, brut: r.brut, cas: r.cas, cass: r.cass, impozit: r.impozit, cam: r.cam, net: r.net, restPlata: r.restPlata })),
    totals: sp.totals,
  });
  db.save();
  return { totals: sp.totals, entry, angajati: sp.rows.length };
}

/** Plata efectiva a salariilor: rest de plata -> 421 = 5121/5311 (implicit banca). */
function paySalaries(fid, period, cont, deps) {
  fid = reqFirma(fid);
  if (!period) fail(400, 'Lipseste perioada (YYYY-MM).');
  const v = db.scoped(fid);
  const sp = statePlata(v.angajati, period, v.payrollHistory);
  if (sp.totals.restPlata <= 0) fail(400, 'Nimic de platit (rest de plata 0).');
  const c = ['5121', '5311'].includes(cont) ? cont : '5121';
  const entry = deps.buildEntry('plata_salarii', { data: ultimaZiDinLuna(period), suma: sp.totals.restPlata, cont: c }, null, fid);
  entry.system = true; entry.document = 'Plata salarii ' + period;
  db.get().entries.push(entry);
  db.save();
  return { suma: sp.totals.restPlata, cont: c, entry };
}

module.exports = { upsertAngajat, deleteAngajat, postStatPlata, paySalaries };
