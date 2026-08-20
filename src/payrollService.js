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
const { statePlata, statPlataPerioada } = require('./payroll');
const fiscal = require('./fiscal'); // nomenclatorul categoriilor din plafonul de 33%
const identitate = require('./identitate');
const { reqFirma } = require('./stocksService');

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

function dataIso(value) {
  const s = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : '';
}

function campText(value, max) { return String(value || '').trim().slice(0, max); }
const COD_CM_RE = /^(?:0[1-9]|10|1[2-7]|51|91|92)$/;

function dateCM(b, key) { return dataIso(b[key]); }

/** Un certificat incomplet nu trebuie sa ajunga intr-un stat postat si abia apoi sa blocheze
 * D112. Previzualizarea ramane posibila prin statePlata(), dar salvarea unui angajat cu zile CM
 * cere exact datele de identificare folosite in sectiunea D. */
function valideazaCM(b, codCM, procentCM) {
  const zile = Math.max(0, Math.round(Number(b.zileCM) || 0));
  if (!zile) return;
  const zileLuna = Math.max(1, Math.round(Number(b.zileLucratoare) || 21));
  if (zile > zileLuna) fail(400, 'Zilele de concediu medical nu pot depasi zilele lucratoare ale lunii.');
  if (!COD_CM_RE.test(String(b.codIndemnizatieCM || ''))) {
    fail(400, 'Codul indemnizatiei CM nu este valid. Foloseste codul cu doua cifre de pe certificat.');
  }
  if (![55, 65, 75, 80, 85, 100].includes(procentCM)) {
    fail(400, 'Procentul indemnizatiei CM nu este valid.');
  }
  if (codCM === '01' && ![55, 65, 75].includes(procentCM)) {
    fail(400, 'Pentru codul 01 sunt admise procentele 55%, 65% sau 75%, potrivit duratei episodului.');
  }
  const obligatorii = [
    ['data inceperii episodului', dateCM(b, 'dataInceputCM')],
    ['seria certificatului', campText(b.serieCM, 5)],
    ['numarul certificatului', campText(b.numarCM, 10)],
    ['data acordarii', dateCM(b, 'dataAcordareCM')],
    ['data de inceput a certificatului', dateCM(b, 'dataInceputCertificatCM')],
    ['data de sfarsit a certificatului', dateCM(b, 'dataSfarsitCM')],
    ['codul bolii/diagnosticului', campText(b.codBoalaCM, 3)],
  ];
  const lipsa = obligatorii.filter((x) => !x[1]).map((x) => x[0]);
  if (lipsa.length) fail(400, 'Certificat CM incomplet: lipsesc ' + lipsa.join(', ') + '.');
  if (dateCM(b, 'dataSfarsitCM') < dateCM(b, 'dataInceputCertificatCM')) {
    fail(400, 'Data de sfarsit a certificatului CM nu poate fi anterioara datei de inceput.');
  }
  if (dateCM(b, 'dataInceputCertificatCM') < dateCM(b, 'dataInceputCM')) {
    fail(400, 'Certificatul curent nu poate incepe inaintea episodului de concediu medical.');
  }
  if (codCM === '15' && campText(b.codBoalaCM, 3).toUpperCase() !== 'RM') {
    fail(400, 'Pentru codul CM 15, codul bolii/diagnosticului trebuie sa fie RM.');
  }
  if (['09', '91', '92'].includes(codCM) && !identitate.validCNP(b.cnpCopilCM)) {
    fail(400, 'Pentru codul CM ' + codCM + ' este obligatoriu CNP-ul valid al copilului.');
  }
  if (codCM === '17' && !identitate.validCNP(b.cnpPacientOncologicCM)) {
    fail(400, 'Pentru codul CM 17 este obligatoriu CNP-ul valid al pacientului oncologic.');
  }
  const urgenta = campText(b.codUrgentaCM, 3);
  if (codCM === '06' && (!/^\d{1,3}$/.test(urgenta) || Number(urgenta) > 177)) {
    fail(400, 'Pentru codul CM 06 este obligatoriu codul valid al urgentei medico-chirurgicale.');
  }
  const infect = campText(b.codInfectocontagiosCM, 2);
  const limitaInfect = codCM === '51' ? 25 : 36;
  if (['05', '51'].includes(codCM)
      && (!/^\d{1,2}$/.test(infect) || Number(infect) < 1 || Number(infect) > limitaInfect)) {
    fail(400, 'Pentru codul CM ' + codCM + ' este obligatoriu codul bolii infectocontagioase'
      + ' din nomenclator (01-' + String(limitaInfect).padStart(2, '0') + ').');
  }
  if (codCM === '10' && !campText(b.avizMedicExpertCM, 10)) {
    fail(400, 'Pentru codul CM 10 este obligatoriu numarul avizului medicului expert.');
  }
  const serieInitiala = campText(b.serieInitialCM, 5);
  const numarInitial = campText(b.numarInitialCM, 10);
  if (!!serieInitiala !== !!numarInitial) {
    fail(400, 'Seria si numarul certificatului initial/anterior se completeaza impreuna.');
  }
  const diferentaA = Number(b.cmDiferentaAngajator) || 0;
  const diferentaF = Number(b.cmDiferentaFnuass) || 0;
  if (diferentaA < 0 || diferentaF < 0) {
    fail(400, 'Diferentele recalculate ale indemnizatiei CM nu pot fi negative.');
  }
  if ((diferentaA || diferentaF) && (codCM !== '01' || !serieInitiala)) {
    fail(400, 'Diferentele recalculate se completeaza numai pentru un certificat cod 01 in continuare.');
  }
}

function curataCertificatCM(b, zileLuna) {
  const codCM = COD_CM_RE.test(String(b.codIndemnizatieCM || ''))
    ? String(b.codIndemnizatieCM) : '01';
  const procentCM = [55, 65, 75, 80, 85, 100].includes(Number(b.procentCM))
    ? Number(b.procentCM) : 75;
  const sursa = Object.assign({}, b, { zileLucratoare: zileLuna });
  valideazaCM(sursa, codCM, procentCM);
  const continuare01 = codCM === '01' && campText(b.serieInitialCM, 5)
    && campText(b.numarInitialCM, 10);
  const locCM = [1, 2, 3, 4, 5].includes(Number(b.locPrescriereCM))
    ? Number(b.locPrescriereCM) : 1;
  const programNational = !!b.cmProgramNational;
  return {
    zileCM: Math.max(0, Math.round(Number(b.zileCM) || 0)),
    dataInceputCM: dataIso(b.dataInceputCM),
    dataInceputCertificatCM: dataIso(b.dataInceputCertificatCM),
    dataSfarsitCM: dataIso(b.dataSfarsitCM), dataAcordareCM: dataIso(b.dataAcordareCM),
    serieCM: campText(b.serieCM, 5), numarCM: campText(b.numarCM, 10),
    serieInitialCM: campText(b.serieInitialCM, 5),
    numarInitialCM: campText(b.numarInitialCM, 10),
    cmDiferentaAngajator: continuare01
      ? round2(Math.max(0, Number(b.cmDiferentaAngajator) || 0)) : 0,
    cmDiferentaFnuass: continuare01
      ? round2(Math.max(0, Number(b.cmDiferentaFnuass) || 0)) : 0,
    locPrescriereCM: locCM,
    codBoalaCM: codCM === '15' ? 'RM' : campText(b.codBoalaCM, 3),
    cnpCopilCM: ['09', '91', '92'].includes(codCM) ? identitate.cnpKey(b.cnpCopilCM) : '',
    cnpPacientOncologicCM: codCM === '17' ? identitate.cnpKey(b.cnpPacientOncologicCM) : '',
    codUrgentaCM: codCM === '06' ? campText(b.codUrgentaCM, 3) : '',
    codInfectocontagiosCM: ['05', '51'].includes(codCM)
      ? campText(b.codInfectocontagiosCM, 2) : '',
    avizMedicExpertCM: codCM === '10' ? campText(b.avizMedicExpertCM, 10) : '',
    procentCM, codIndemnizatieCM: codCM, cmProgramNational: programNational,
    // Exceptiile introduse prin Legea 64/2026 se aplica in motor in functie de data
    // certificatului (de la 01.06.2026), nu se graveaza aici ca si cum ar fi existat retroactiv.
    cmExceptatZiNeplatita: !!b.cmExceptatZiNeplatita,
    cmIntegralFnuass: !!b.cmIntegralFnuass
      || ['07', '08', '09', '10', '15', '17', '51', '91', '92'].includes(codCM),
  };
}

function curataCertificateCM(b, zileLuna) {
  const surse = Array.isArray(b.certificateCM) ? b.certificateCM : [b];
  const active = surse.filter((c) => Math.round(Number(c && c.zileCM) || 0) > 0);
  if (active.length > 10) fail(400, 'D112 permite maximum 10 certificate CM per angajat si luna.');
  const out = active.map((c) => curataCertificatCM(c, zileLuna));
  if (out.reduce((s, c) => s + c.zileCM, 0) > zileLuna) {
    fail(400, 'Totalul zilelor din certificatele CM depaseste zilele lucratoare ale lunii.');
  }
  const chei = new Set();
  for (const c of out) {
    const k = c.serieCM + '|' + c.numarCM;
    if (chei.has(k)) fail(400, 'Acelasi certificat CM apare de doua ori: ' + c.serieCM + ' ' + c.numarCM + '.');
    chei.add(k);
  }
  const intervale = out.slice().sort((x, y) => x.dataInceputCertificatCM.localeCompare(y.dataInceputCertificatCM));
  for (let i = 1; i < intervale.length; i += 1) {
    if (intervale[i].dataInceputCertificatCM <= intervale[i - 1].dataSfarsitCM) {
      fail(400, 'Intervalele certificatelor CM nu se pot suprapune.');
    }
  }
  return out;
}

function curataIstoricBazaCM(intrat) {
  if (!Array.isArray(intrat)) return [];
  if (intrat.length > 12) fail(400, 'Istoricul manual al bazei CM poate avea maximum 12 luni.');
  const vazute = new Set();
  return intrat.map((x) => {
    const period = String((x || {}).period || '').trim();
    const venit = round2(Number((x || {}).venit));
    const zile = Math.round(Number((x || {}).zile));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || !(venit >= 0) || !(zile >= 1 && zile <= 31)) {
      fail(400, 'Istoric baza CM invalid. Foloseste perioada YYYY-MM, venit pozitiv/zero si 1-31 zile.');
    }
    if (vazute.has(period)) fail(400, 'Istoricul bazei CM contine luna duplicata ' + period + '.');
    vazute.add(period);
    return { period, venit, zile };
  }).sort((x, y) => x.period.localeCompare(y.period));
}

/** Sumele acordate pe categoriile art. 76 alin. (4^1), curatate: doar id-uri din nomenclator,
 *  doar valori pozitive. Fara filtrul pe id, un camp inventat de client ar intra in obiect si ar
 *  fi purtat mai departe fara sa aiba vreodata o limita — adica exact scapare de sub plafon. */
function curataBeneficii(intrat) {
  const src = intrat && typeof intrat === 'object' ? intrat : {};
  const out = {};
  for (const cat of fiscal.CATEGORII_BENEFICII) {
    const v = round2(Number(src[cat.id]) || 0);
    if (v > 0) out[cat.id] = v;
  }
  return out;
}

/** Ordinea de includere in plafonul de 33% aleasa de angajator (art. 76 alin. (4^2)).
 *  Gol => ordinea din lege. Id-urile necunoscute se ignora; `ordoneaza()` completeaza restul. */
function curataOrdine(intrat) {
  if (!Array.isArray(intrat)) return undefined;
  const stiute = new Set(fiscal.CATEGORII_BENEFICII.map((c) => c.id));
  const out = intrat.filter((id) => stiute.has(id));
  return out.length ? out : undefined;
}

function upsertAngajat(fid, b) {
  fid = reqFirma(fid); b = b || {};
  if (!b.nume || !b.salariuBrut) fail(400, 'Completeaza numele si salariul brut.');
  const zileLuna = Math.max(1, Math.round(Number(b.zileLucratoare) || 21));
  const certificateCM = curataCertificateCM(b, zileLuna);
  const cm0 = certificateCM[0] || {
    zileCM: 0, procentCM: 75, codIndemnizatieCM: '01',
    locPrescriereCM: [1, 2, 3, 4, 5].includes(Number(b.locPrescriereCM))
      ? Number(b.locPrescriereCM) : 1,
  };
  const d = db.get();
  const a = b.id && (d.angajati || []).find((x) => x.id === b.id && x.firmaId === fid);
  const rec = a || { id: db.nextId('ang'), firmaId: fid };
  // IBAN-ul angajatului: pentru lotul de plata a salariilor nete (pain.001). Optional.
  Object.assign(rec, { iban: b.iban != null ? sepa.normIban(b.iban) : (rec.iban || ''),
    nume: String(b.nume), cnp: b.cnp || '', functie: b.functie || '', salariuBrut: round2(Number(b.salariuBrut) || 0), neimpozabil: round2(Number(b.neimpozabil) || 0), spor: round2(Number(b.spor) || 0), avans: round2(Number(b.avans) || 0), retineri: round2(Number(b.retineri) || 0), persoane: b.persoane === '' || b.persoane == null ? null : Math.max(0, Math.round(Number(b.persoane) || 0)),
    // Functia de baza: deducerea personala se acorda AICI (art. 77). Implicit DA — cazul obisnuit;
    // al doilea loc de munca se declara explicit, debifand. `undefined` (inregistrari vechi,
    // importuri) inseamna tot DA, ca sa nu ramana nimeni fara deducere din omisiune.
    functieBaza: b.functieBaza === undefined ? true : !!b.functieBaza,
    sub26: !!b.sub26, copii: Math.max(0, Math.round(Number(b.copii) || 0)), tichete: round2(Number(b.tichete) || 0), avantaje: round2(Number(b.avantaje) || 0),
    certificateCM, zileCM: certificateCM.reduce((s, c) => s + c.zileCM, 0),
    // Datele certificatului sunt necesare sectiunii D din D112; se pastreaza separat inceputul
    // EPISODULUI (pentru ziua neplatita o singura data) de intervalul certificatului curent.
    dataInceputCM: cm0.dataInceputCM || '',
    dataInceputCertificatCM: cm0.dataInceputCertificatCM || '',
    dataSfarsitCM: cm0.dataSfarsitCM || '', dataAcordareCM: cm0.dataAcordareCM || '',
    serieCM: cm0.serieCM || '', numarCM: cm0.numarCM || '',
    serieInitialCM: cm0.serieInitialCM || '', numarInitialCM: cm0.numarInitialCM || '',
    // Din 07/2026, diferentele rezultate din majorarea procentului unui episod cod 01 care trece
    // in luna urmatoare se includ in luna recalcularii (OUG 89/2025) si in D112 D_20a/D_21a.
    cmDiferentaAngajator: cm0.cmDiferentaAngajator || 0,
    cmDiferentaFnuass: cm0.cmDiferentaFnuass || 0,
    locPrescriereCM: cm0.locPrescriereCM || 1,
    codBoalaCM: cm0.codBoalaCM || '', cnpCopilCM: cm0.cnpCopilCM || '',
    cnpPacientOncologicCM: cm0.cnpPacientOncologicCM || '',
    codUrgentaCM: cm0.codUrgentaCM || '',
    codInfectocontagiosCM: cm0.codInfectocontagiosCM || '',
    avizMedicExpertCM: cm0.avizMedicExpertCM || '',
    // Certificatul medical poarta procentul. Din august 2025, codul 01 poate avea 55/65/75%
    // in functie de durata episodului; 80/85/100% raman necesare celorlalte coduri.
    procentCM: cm0.procentCM, codIndemnizatieCM: cm0.codIndemnizatieCM,
    cmProgramNational: !!cm0.cmProgramNational,
    // OUG 91/2025 scade o zi in 2026-2027, cu exceptii legale. Bifele explicite pastreaza
    // certificatul drept sursa de adevar si evita deducerea tipului medical dintr-un procent.
    cmExceptatZiNeplatita: !!cm0.cmExceptatZiNeplatita,
    cmIntegralFnuass: !!cm0.cmIntegralFnuass,
    cmEligibilitate: ['stagiu', 'exceptie'].includes(b.cmEligibilitate) ? b.cmEligibilitate : '',
    cmStagiuDocument: campText(b.cmStagiuDocument, 160),
    istoricBazaCM: curataIstoricBazaCM(b.istoricBazaCM),
    cmBazaPerioadaCompleta: !!b.cmBazaPerioadaCompleta,
    zileCO: Math.max(0, Math.round(Number(b.zileCO) || 0)), zileLucratoare: zileLuna,
    normaPartiala: !!b.normaPartiala, scutitNormaPartiala: !!b.scutitNormaPartiala,
    sector: ['it', 'constructii', 'agro'].includes(b.sector) ? b.sector : 'normal',
    // Avantajele din plafonul de 33% (art. 76 alin. (4^1)) + numaratorile de care depind limitele
    // lor individuale: zilele de telemunca (lit. h), zilele de mobilitate (lit. a) si copiii in
    // educatie timpurie (lit. i). `zileMobilitate` gol = zilele efectiv lucrate din luna.
    beneficii: curataBeneficii(b.beneficii),
    zileTelemunca: Math.max(0, Math.round(Number(b.zileTelemunca) || 0)),
    zileMobilitate: b.zileMobilitate === '' || b.zileMobilitate == null ? null : Math.max(0, Math.round(Number(b.zileMobilitate) || 0)),
    copiiCresa: Math.max(0, Math.round(Number(b.copiiCresa) || 0)),
    ordineBeneficii: curataOrdine(b.ordineBeneficii),
    beneficiiOrdineConfirmata: !!b.beneficiiOrdineConfirmata });
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
  const sp = statePlata(v.angajati, period, v.payrollHistory, { cursuriBnr: v.cursuriBnr });
  const faraEligibilitate = sp.rows.find((r) => r.zileCM > 0
    && (!['stagiu', 'exceptie'].includes(r.cmEligibilitate) || !r.cmStagiuDocument));
  if (faraEligibilitate) {
    fail(400, 'Statul nu poate fi postat: pentru ' + faraEligibilitate.nume
      + ' confirmă eligibilitatea CM (stagiu sau excepție) și documentul justificativ.');
  }
  const bazaNeconfirmata = sp.rows.find((r) => r.zileCM > 0 && r.cmBazaAproximata);
  if (bazaNeconfirmata) {
    fail(400, 'Statul nu poate fi postat: baza CM pentru ' + bazaNeconfirmata.nume
      + ' este incompletă. Introdu istoricul din adeverință și confirmă perioada legală disponibilă.');
  }
  const repartizareNeconfirmata = sp.rows.find((r) => r.zileCM > 0 && r.cmAproximat);
  if (repartizareNeconfirmata) {
    fail(400, 'Statul nu poate fi postat: repartizarea CM pentru ' + repartizareNeconfirmata.nume
      + ' este aproximată. Completează datele episodului și intervalele certificatelor.');
  }
  const cursBeneficiiNeconfirmat = sp.rows.find((r) => r.beneficiiCursAproximat);
  if (cursBeneficiiNeconfirmat) {
    fail(400, 'Statul nu poate fi postat: plafonul anual în EUR pentru '
      + cursBeneficiiNeconfirmat.nume
      + ' nu are încă un curs BNR definitiv pentru ultima zi a lunii. Actualizează istoricul BNR.');
  }
  const ordineBeneficiiNeconfirmata = sp.rows.find((r) => r.beneficiiOrdineNecesara
    && !r.beneficiiOrdineConfirmata);
  if (ordineBeneficiiNeconfirmata) {
    fail(400, 'Statul nu poate fi postat: beneficiile lui ' + ordineBeneficiiNeconfirmata.nume
      + ' depășesc plafonul comun de 33%. Confirmă ordinea de includere aleasă de angajator.');
  }
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
  if (sp.totals.cmAngajator > 0) entry.lines.push({ debit: '6458', credit: '421', suma: sp.totals.cmAngajator, explicatie: 'Indemnizații CM suportate de angajator (intervalul legal al episodului)' });
  if (sp.totals.cmFnuass > 0) entry.lines.push({ debit: '4373', credit: '421', suma: sp.totals.cmFnuass, explicatie: 'Indemnizații CM suportate de FNUASS (de recuperat)' });
  // Norma partiala sub salariul minim (OUG 16/2022): diferentele de CAS/CASS pana la nivelul
  // salariului minim sunt CHELTUIALA a angajatorului (nu retinere din salariat).
  if (sp.totals.casAngajator > 0) entry.lines.push({ debit: '6458', credit: '4315', suma: sp.totals.casAngajator, explicatie: 'CAS suportat de angajator — normă parțială sub salariul minim' });
  if (sp.totals.cassAngajator > 0) entry.lines.push({ debit: '6458', credit: '4316', suma: sp.totals.cassAngajator, explicatie: 'CASS suportat de angajator — normă parțială sub salariul minim' });
  const d = db.get();
  db.pushEntry(entry, { context: 'stat de plata' });
  // instantaneu in istoricul de salarizare (inlocuieste daca luna era deja inregistrata)
  d.payrollHistory = (d.payrollHistory || []).filter((h) => !(h.firmaId === fid && h.period === period));
  d.payrollHistory.push({
    id: db.nextId('ph'), firmaId: fid, period, ts: new Date().toISOString(), formatVersion: 2,
    // `beneficii` NU e decor in instantaneu: plafoanele anuale de la art. 76 alin. (4^1) lit. d)-g)
    // (turism, pensii, sanatate, sport) se consuma pe an, iar `beneficii.consumAnual()` citeste
    // exact de aici cat s-a acordat deja neimpozabil. Fara el, fiecare luna ar reporni de la
    // plafonul intreg si 400 EUR/an ar deveni 400 EUR/luna.
    // Fotografia COMPLETA este documentul sursa pentru fluturas, plata si D112. Maparea veche
    // pastra doar opt sume si pierdea certificatul CM, deducerile, bazele si repartizarea FNUASS.
    rows: sp.rows.map((r) => Object.assign({ angajatId: r.id }, r,
      { beneficii: (r.beneficii || []).map((b) => Object.assign({}, b)) })),
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
  const sp = statPlataPerioada(v, period);
  if (sp.totals.restPlata <= 0) fail(400, 'Nimic de platit (rest de plata 0).');
  const c = ['5121', '5311'].includes(cont) ? cont : '5121';
  const entry = deps.buildEntry('plata_salarii', { data: ultimaZiDinLuna(period), suma: sp.totals.restPlata, cont: c }, null, fid);
  entry.system = true; entry.document = 'Plata salarii ' + period;
  db.pushEntry(entry, { context: 'plata salarii' });
  db.save();
  return { suma: sp.totals.restPlata, cont: c, entry };
}

module.exports = { upsertAngajat, deleteAngajat, postStatPlata, paySalaries };
