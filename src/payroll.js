'use strict';

// Statul de plata: calcul salarial per angajat (CAS 25%, CASS 10%, impozit 10%, CAM 2,25%)
// folosind parametrii fiscali curenti. Reutilizeaza fiscal.payroll().

const { round2, ultimaZiDinLuna } = require('./util');
const fiscal = require('./fiscal');
const ben = require('./beneficii'); // plafonul de 33% (art. 76 alin. (4^1)) — doar consumul anual
const bnr = require('./bnr');
const calendar = require('./romanianCalendar');
const payrollHistory = require('./payrollHistory');
const BENEFICII_EUR = new Set(fiscal.CATEGORII_BENEFICII
  .filter((c) => c.limita && c.limita.tip === 'anEur').map((c) => c.id));

function randuriIstoric(a, history, period, luni) {
  const past = [];
  for (const h of (history || [])) {
    if (period && String(h.period) >= String(period)) continue;
    const r = (h.rows || []).find((x) => (x.angajatId || x.id) === a.id || (a.cnp && x.cnp === a.cnp));
    if (r && Number(r.brut) > 0) past.push({ period: h.period, row: r });
  }
  past.sort((x, y) => (x.period < y.period ? 1 : -1));
  return past.slice(0, luni);
}

/** Certificatele lunii. Inregistrarile vechi aveau campurile CM direct pe angajat; noul model
 * pastreaza pana la 10 certificate, dar citeste in continuare forma veche fara migrare distructiva. */
function certificateIntrare(a) {
  if (Array.isArray(a.certificateCM)) {
    return a.certificateCM.filter((c) => Math.round(Number(c && c.zileCM) || 0) > 0);
  }
  return Math.round(Number(a.zileCM) || 0) > 0 ? [a] : [];
}

/** Istoricul bazei CM combina statele postate cu adeverintele introduse pentru perioade lucrate
 * la alti angajatori. Pentru aceeasi luna, statul postat are prioritate; nu dublam venitul. */
function randuriBazaCM(a, history, period) {
  const byPeriod = new Map();
  for (const x of randuriIstoric(a, history, period, 12)) byPeriod.set(String(x.period), x);
  for (const m of (a.istoricBazaCM || [])) {
    const p = String((m || {}).period || '');
    if (!/^\d{4}-\d{2}$/.test(p) || (period && p >= String(period)) || byPeriod.has(p)) continue;
    byPeriod.set(p, { period: p, row: {
      venitBazaCM: Number(m.venit) || 0,
      zileBazaCM: Math.round(Number(m.zile) || 0),
      sursaBazaCM: 'adeverinta',
    } });
  }
  return [...byPeriod.values()].sort((x, y) => (x.period < y.period ? 1 : -1)).slice(0, 6);
}

/** Media bruturilor unui angajat din ultimele `luni` state postate (payrollHistory), inainte de `period`. */
function mediaIstoric(a, history, period, luni) {
  const lastN = randuriIstoric(a, history, period, luni);
  return lastN.length
    ? round2(lastN.reduce((s, x) => s + Number(x.row.brut), 0) / lastN.length)
    : 0;
}

/**
 * Media ZILNICA pentru CM: suma veniturilor asigurate / totalul zilelor din baza ultimelor
 * 6 luni. Formula anterioara impartea media lunara la zilele lunii CURENTE, desi Ordinul
 * MS/CNAS 521/2026 cere explicit ΣV / NTZ. Instantaneele noi pastreaza ambii termeni; pentru
 * cele vechi, zilele se reconstruiesc din calendarul legal standard al lunii respective.
 */
function bazaZilnicaCM(a, history, period, zlm, brut) {
  const lastN = randuriBazaCM(a, history, period);
  if (!lastN.length) {
    const venit = Math.min(round2(brut), round2(12 * fiscal.salariuMinimLa(period)));
    return { zilnica: round2(venit / zlm), mediaLunara: venit, venit, zile: zlm,
      luni: 0, aproximata: true };
  }
  let venit = 0; let zile = 0; let zileReconstituite = false;
  for (const x of lastN) {
    const r = x.row;
    const v = Number(r.venitBazaCM != null ? r.venitBazaCM : r.brut) || 0;
    const cap = round2(12 * fiscal.salariuMinimLa(x.period));
    venit = round2(venit + Math.min(v, cap));
    let z = Math.round(Number(r.zileBazaCM) || 0);
    if (!(z > 0)) {
      z = calendar.workingDaysInMonth(String(x.period));
      zileReconstituite = true;
    }
    zile += z;
  }
  if (!(zile > 0)) return { zilnica: 0, mediaLunara: 0, venit, zile: 0,
    luni: lastN.length, aproximata: true };
  return { zilnica: round2(venit / zile), mediaLunara: round2(venit / lastN.length),
    venit, zile, luni: lastN.length,
    aproximata: zileReconstituite || (lastN.length < 6 && !a.cmBazaPerioadaCompleta) };
}

/** Statul de plata pentru o lista de angajati: randuri per angajat + totaluri.
 *  `spor` se adauga la brut (impozabil); `avans` (425) si `retineri` (terti -> 427) se scad din net.
 *  `period` (YYYY-MM, optional) alege salariul minim S1/S2 pentru deducerea personala.
 *  `history` (payrollHistory, optional) da media ultimelor 6 luni pentru baza concediului medical. */
/**
 * Zilele LUCRATOARE cuprinse in primele `n` zile CALENDARISTICE ale concediului medical.
 *
 * OUG 158/2005 art. 12 lit. A pune in sarcina angajatorului „prima zi pana in a 5-a zi de
 * incapacitate" — zile CALENDARISTICE de incapacitate, nu zile lucratoare de concediu. Indemnizatia
 * se cuvine insa doar pentru zilele lucratoare din interval. Cele doua numaratori difera ori de
 * cate ori intervalul prinde un weekend: un concediu care incepe JOI are in primele 5 zile
 * calendaristice doar 3 zile lucratoare (joi, vineri, luni), deci angajatorul suporta 3, nu 5.
 *
 * Formula veche, `min(5, zileCM)`, numara 5 zile lucratoare — adica MAXIMUL posibil. Rezultatul:
 * cost mutat sistematic de la FNUASS la firma si o suma recuperabila subdeclarata in D112.
 *
 * Sarbatorile legale sunt eliminate prin calendarul national comun folosit si la termenele fiscale.
 * Programul special stabilit prin contract colectiv ramane o intrare care trebuie confirmata de
 * operator prin numarul de zile CM din luna.
 */
function zileLucratoareInPrimele(dataStart, n, offset, period, intervalStart, intervalEnd) {
  const zi = String(dataStart || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(zi)) return null;
  const d = new Date(zi + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== zi) return null;
  d.setUTCDate(d.getUTCDate() + (Math.max(0, Math.round(Number(offset) || 0))));
  let lucratoare = 0;
  for (let i = 0; i < n; i += 1) {
    const iso = d.toISOString().slice(0, 10);
    const inCertificat = (!intervalStart || iso >= String(intervalStart).slice(0, 10))
      && (!intervalEnd || iso <= String(intervalEnd).slice(0, 10));
    if ((!period || iso.slice(0, 7) === period) && inCertificat && calendar.isWorkingDay(d)) {
      lucratoare += 1;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return lucratoare;
}

function primaZiLucratoare(dataStart) {
  const zi = String(dataStart || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(zi)) return null;
  const d = new Date(zi + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== zi) return null;
  for (let i = 0; i < 14; i += 1) {
    if (calendar.isWorkingDay(d)) return d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return null;
}

function statePlata(angajati, period, history, options) {
  const opts = options || {};
  const ruleSet = fiscal.rulesAt(period); const rates = ruleSet.rates;
  // O fotografie legata de un articol stornat nu mai poate alimenta medii CM/CO sau plafoane
  // anuale. Deducerea se face o singura data aici, inainte ca istoricul sa ajunga in calcule.
  history = payrollHistory.activeSnapshots(history, opts.entries);
  const dataCursBeneficii = ultimaZiDinLuna(period);
  const cursBeneficii = bnr.cursPlafon(opts.cursuriBnr || [], dataCursBeneficii,
    rates.cursEurBeneficii);
  // Un curs dinaintea sfarsitului unei luni care nu s-a incheiat este doar provizoriu. Pentru o
  // luna inchisa, `exact:false` poate insemna legitim weekend/sarbatoare si nu este aproximare.
  const cursBeneficiiProvizoriu = !!(dataCursBeneficii
    && dataCursBeneficii > new Date().toISOString().slice(0, 10));
  const rows = [];
  const t = { brut: 0, neimpozabil: 0, neimpozabilMinim: 0, deducere: 0, tichete: 0, avantaje: 0,
    beneficiiAcordate: 0, beneficiiNeimpozabile: 0, beneficiiImpozabile: 0, spor: 0, cas: 0, cass: 0, impozit: 0, cam: 0, net: 0, avans: 0, retineri: 0, restPlata: 0, costTotal: 0, cmAngajator: 0, cmFnuass: 0, indemnizatieCM: 0, indemnizatieCO: 0, casAngajator: 0, cassAngajator: 0 };
  for (const a of angajati || []) {
    const spor = round2(Number(a.spor) || 0);
    const brut = round2((Number(a.salariuBrut) || 0) + spor);
    // `a.neimpozabil` = alte venituri neimpozabile, introduse de contabil (asa e si eticheta din
    // formular: „Venit neimpozabil suplimentar"). Facilitatea din salariul minim NU se ia de aici:
    // se DERIVA mai jos, fiindca depinde de salariu si de luna, iar un cuantum stocat ar ramane
    // adevarat dupa ce salariul creste.
    const neimpozabil = round2(Number(a.neimpozabil) || 0);
    // DEDUCEREA PERSONALA (art. 77 Cod fiscal) se acorda la FUNCTIA DE BAZA, indiferent daca
    // angajatul are sau nu persoane in intretinere: cu zero persoane se cuvine tot deducerea de
    // baza, diminuata progresiv pana la plafonul salariu minim + 2.000.
    //
    // Poarta era `a.persoane != null`, adica "s-a completat campul". Era o compatibilitate cu
    // inregistrarile vechi, nu regula legala — si a devenit generator de eroare: campul „Persoane
    // in intretinere" din formular avea `placeholder="0"` fara `value="0"`, deci ARATA completat cu
    // zero, dar se trimitea GOL. Rezultat: angajatul nu primea nicio deducere si era supraimpozitat.
    // Masurat la 5.000 lei brut: deducere 430 -> impozit 282 in loc de 325, adica 43 lei/luna,
    // 516 lei/an per angajat, in plus la stat si in minus din netul omului.
    //
    // Azi poarta e cea legala: deducerea se acorda daca angajatul E la functia de baza. Singurul
    // caz in care NU se acorda (al doilea loc de munca) se declara EXPLICIT, prin `functieBaza:false`,
    // nu prin uitarea unui camp.
    const hasDP = a.functieBaza !== false;
    const dp = hasDP ? fiscal.deducerePersonala(brut, Number(a.persoane) || 0,
      { period, rules: ruleSet, sub26: a.sub26, copii: a.copii }).total : 0;
    const deducere = round2(dp + neimpozabil); // total scazut din baza de impozit
    const tichete = round2(Number(a.tichete) || 0);
    const avantaje = round2(Number(a.avantaje) || 0); // avantaje in natura impozabile (auto, chirie...)
    const sector = a.sector || 'normal';
    const avans = round2(Number(a.avans) || 0);
    const retineri = round2(Number(a.retineri) || 0);
    // Concediu medical: baza zilnica = Σ venituri asigurate / Σ zile din ultimele 6 luni.
    // Pentru certificatele 01.02.2026-31.12.2027, OUG 91/2025 + Ordinul 521/2026 scad prima zi
    // lucratoare si muta sarcina angajatorului pe zilele calendaristice 2-6 ale episodului.
    const zlm = Math.max(1, Math.round(Number(a.zileLucratoare) || 21));
    const intrariCM = certificateIntrare(a);
    let zileRamaseCM = zlm;
    const certificateSursa = intrariCM.map((c) => {
      const zile = Math.max(0, Math.min(Math.round(Number(c.zileCM) || 0), zileRamaseCM));
      zileRamaseCM -= zile;
      return Object.assign({}, c, { zileCM: zile });
    }).filter((c) => c.zileCM > 0);
    const zcm = certificateSursa.reduce((s, c) => s + c.zileCM, 0);
    let cmA = 0; let cmF = 0; let cmACurent = 0; let cmFCurent = 0;
    let cmDiferentaA = 0; let cmDiferentaF = 0;
    let mediaCM = 0; let mediaZilnicaCM = 0;
    let cmAprox = false; let cmBazaAprox = false; let zileAngajator = 0; let zileAngajatorTotal = 0;
    let zileNeplatiteCM = 0; let zilePlatiteCM = 0; let zileBazaCM = 0; let venitBazaCMIstoric = 0;
    let luniBazaCM = 0; let cmCuCass = 0;
    const certificateCM = [];
    if (zcm > 0) {
      const bazaCM = bazaZilnicaCM(a, history, period, zlm, brut);
      mediaCM = bazaCM.mediaLunara; mediaZilnicaCM = bazaCM.zilnica;
      zileBazaCM = bazaCM.zile; venitBazaCMIstoric = bazaCM.venit; luniBazaCM = bazaCM.luni;
      cmBazaAprox = bazaCM.aproximata;
      const per = /^\d{4}-\d{2}$/.test(String(period || ''))
        ? String(period) : new Date().toISOString().slice(0, 7);
      for (const c of certificateSursa) {
        const procent = Number(c.procentCM) || 75;
        const cod = String(c.codIndemnizatieCM || '01').padStart(2, '0');
        const zilnica = round2(mediaZilnicaCM * (procent / 100));
        const dataCertificat = c.dataAcordareCM || c.dataInceputCertificatCM || (per + '-01');
        const inMasuraTemporara = dataCertificat >= '2026-02-01'
          && dataCertificat <= '2027-12-31';
        // Legea 64/2026: de la 01.06.2026 nu se diminueaza maternitatea, riscul maternal,
        // ingrijirea pacientului oncologic, PNS si certificatele acordate in spital. Campul
        // explicit acopera celelalte exceptii documentate de operator. Pana la 31.05 aceste
        // exceptii noi nu se aplica retroactiv.
        const exceptieDinIunie = (c.dataInceputCertificatCM || dataCertificat) >= '2026-06-01'
          && (c.cmProgramNational || Number(c.locPrescriereCM) === 2
            || ['08', '15', '17'].includes(cod));
        const exceptat = !!c.cmExceptatZiNeplatita || exceptieDinIunie;
        const regula2026 = inMasuraTemporara && !exceptat;
        // Incepand cu Legea 64/2026, un episod neintrerupt pierde o singura zi, indiferent de
        // cate certificate il acopera. Pentru certificatele anterioare modificarii se aplica
        // regula initiala pe certificatul curent.
        const oZiPeEpisod = dataCertificat >= '2026-05-18';
        const reperPrimaZi = oZiPeEpisod
          ? (c.dataInceputCM || c.dataInceputCertificatCM)
          : (c.dataInceputCertificatCM || c.dataInceputCM);
        const primaLucratoare = primaZiLucratoare(reperPrimaZi);
        const inceputCert = c.dataInceputCertificatCM || '';
        const sfarsitCert = c.dataSfarsitCM || '';
        const primaInCertificat = primaLucratoare && (!inceputCert || primaLucratoare >= inceputCert)
          && (!sfarsitCert || primaLucratoare <= sfarsitCert);
        let neplatite = 0;
        if (regula2026 && (!primaLucratoare
          || (primaLucratoare.slice(0, 7) === per && primaInCertificat))) neplatite = 1;
        neplatite = Math.min(neplatite, c.zileCM);
        const platite = Math.max(0, c.zileCM - neplatite);

        // Regula temporara 2026-2027: angajatorul suporta zilele 2-6 ale fiecarui episod. Un
        // certificat in continuare poarta data episodului initial, deci prima zi nu se scade din
        // nou in luna curenta.
        let capAng = zileLucratoareInPrimele(c.dataInceputCM, 5, regula2026 ? 1 : 0,
          per, inceputCert, sfarsitCert);
        if (regula2026 && capAng != null && primaLucratoare && primaInCertificat) {
          const inceput = new Date(String(c.dataInceputCM).slice(0, 10) + 'T00:00:00Z');
          const prima = new Date(primaLucratoare + 'T00:00:00Z');
          const pozitie = Math.round((prima - inceput) / 86400000);
          if (pozitie >= 1 && pozitie <= 5 && primaLucratoare.slice(0, 7) === per) capAng -= 1;
        }
        const aproximat = capAng == null;
        if (c.cmIntegralFnuass) capAng = 0;
        const zileAng = Math.min(Math.max(0, capAng == null ? (regula2026 ? 4 : 5) : capAng), platite);
        const curentA = round2(zilnica * zileAng);
        const curentF = round2(zilnica * (platite - zileAng));
        const continuare01 = cod === '01' && c.serieInitialCM && c.numarInitialCM;
        const diferentaA = continuare01
          ? round2(Math.max(0, Number(c.cmDiferentaAngajator) || 0)) : 0;
        const diferentaF = continuare01
          ? round2(Math.max(0, Number(c.cmDiferentaFnuass) || 0)) : 0;
        const sumaA = round2(curentA + diferentaA);
        const sumaF = round2(curentF + diferentaF);
        const detaliu = Object.assign({}, c, {
          procentCM: procent, codIndemnizatieCM: cod,
          cmExceptatZiNeplatita: exceptat,
          zilePlatiteCM: platite, zileNeplatiteCM: neplatite,
          zileCMAngajator: zileAng,
          zileCMAngajatorTotal: c.cmIntegralFnuass ? 0 : Math.min(c.zileCM, zileAng + neplatite),
          mediaCM, mediaZilnicaCM, zileBazaCM, venitBazaCMIstoric, luniBazaCM,
          cmBazaAproximata: cmBazaAprox, cmAproximat: aproximat,
          cmAngajatorCurent: curentA, cmFnuassCurent: curentF,
          cmDiferentaAngajator: diferentaA, cmDiferentaFnuass: diferentaF,
          cmAngajator: sumaA, cmFnuass: sumaF, indemnizatieCM: round2(sumaA + sumaF),
        });
        certificateCM.push(detaliu);
        zilePlatiteCM += platite; zileNeplatiteCM += neplatite;
        zileAngajator += zileAng; zileAngajatorTotal += detaliu.zileCMAngajatorTotal;
        cmACurent = round2(cmACurent + curentA); cmFCurent = round2(cmFCurent + curentF);
        cmDiferentaA = round2(cmDiferentaA + diferentaA);
        cmDiferentaF = round2(cmDiferentaF + diferentaF);
        cmA = round2(cmA + sumaA); cmF = round2(cmF + sumaF);
        cmAprox = cmAprox || aproximat;
        if (['01', '07', '10'].includes(cod)) cmCuCass = round2(cmCuCass + sumaA + sumaF);
      }
    }
    const primulCM = certificateCM[0] || {};
    const procentCM = Number(primulCM.procentCM) || 0;
    const codIndemnizatieCM = String(primulCM.codIndemnizatieCM || '01').padStart(2, '0');
    // Concediu de odihna: indemnizatia = media zilnica a bruturilor din ultimele 3 luni postate
    // (fallback: brutul curent) x zilele de CO; salariul se reduce proportional. Indemnizatia CO
    // se impoziteaza integral, ca salariul (CAS + CASS + impozit + CAM).
    const zco = Math.max(0, Math.min(Math.round(Number(a.zileCO) || 0), zlm - zcm));
    let indemnizatieCO = 0; let mediaCO = 0;
    if (zco > 0) {
      mediaCO = mediaIstoric(a, history, period, 3) || brut;
      indemnizatieCO = round2((mediaCO / zlm) * zco);
    }
    const salariuZileLucrate = (zcm || zco) ? round2((brut * (zlm - zcm - zco)) / zlm) : brut;
    const brutTaxabil = round2(salariuZileLucrate + indemnizatieCO);
    // Norma partiala (OUG 16/2022): contributii cel putin la nivelul salariului minim, diferenta
    // in sarcina angajatorului; exceptii legale (elevi/studenti, pensionari, ucenici, dizabilitate,
    // cumul de norma intreaga la alt angajator) — bifate pe angajat.
    const bazaMinima = (a.normaPartiala && !a.scutitNormaPartiala) ? rates.salariuMinim : 0;
    // Suma neimpozabila din salariul minim (art. 76): derivata din salariul de BAZA contractual
    // (`a.salariuBrut`, fara spor) si din brutul efectiv al lunii. Nu e o deducere — iese din toate
    // bazele, deci se trimite separat de `deducere`.
    const nm = fiscal.neimpozabilMinim(brutTaxabil, round2(Number(a.salariuBrut) || 0), period, ruleSet);
    // Avantajele din plafonul de 33% (art. 76 alin. (4^1)). Plafonul se calculeaza pe salariul de
    // BAZA contractual (`a.salariuBrut`, fara spor si fara reducerea pentru zilele de concediu) —
    // vezi nota din src/beneficii.js. Plafoanele ANUALE (turism, pensii, sanatate, sport) au nevoie
    // de cat s-a acordat deja anul asta, deci se citesc din acelasi `history` din care vine si
    // baza concediului medical. `ordineBeneficii` sta pe angajat, nu ca parametru al functiei:
    // asa calculeaza IDENTIC toate cele noua puncte care cheama statePlata (stat, PDF, D112,
    // plati), fara sa depinda de cine si-a amintit sa transmita optiunea.
    const bnf = fiscal.beneficii({
      period, rules: ruleSet,
      salariuBaza: round2(Number(a.salariuBrut) || 0),
      acordate: a.beneficii || {},
      zile: {
        lucratoare: zlm,
        lucrate: Math.max(0, zlm - zcm - zco),
        mobilitate: a.zileMobilitate != null ? Math.max(0, Math.round(Number(a.zileMobilitate) || 0)) : Math.max(0, zlm - zcm - zco),
        telemunca: Math.max(0, Math.round(Number(a.zileTelemunca) || 0)),
      },
      copii: Number(a.copiiCresa) || 0,
      tichete,
      salariuMinim: rates.salariuMinim,
      consumAnual: ben.consumAnual(history, a.id, period),
      ordine: a.ordineBeneficii,
      cursEur: cursBeneficii.curs,
    });
    const beneficiiCursNecesar = bnf.randuri.some((r) => BENEFICII_EUR.has(r.id));
    const beneficiiOrdineNecesara = bnf.randuri.some((r) => Number(r.pestePlafon) > 0);
    const p = fiscal.payroll(brutTaxabil, deducere, { period, rules: ruleSet, tichete, avantaje, sector,
      cmAngajator: cmA, cmFnuass: cmF, cmCuCass, bazaMinima,
      neimpozabilMinim: nm.suma, beneficiiImpozabile: bnf.totalImpozabil });
    const restPlata = round2(p.net - avans - retineri);
    rows.push({
      id: a.id, nume: a.nume || '', cnp: a.cnp || '', functie: a.functie || '', iban: a.iban || '',
      persoane: a.persoane != null ? Number(a.persoane) : null, sub26: !!a.sub26, copii: Number(a.copii) || 0,
      brut: brutTaxabil, salariuBaza: brut, salariuZileLucrate, spor, neimpozabil, deducere: dp,
      neimpozabilMinim: nm.suma, neimpozabilMinimMotiv: nm.motiv, tichete, avantaje, sector, scutire: p.scutImpozit || p.scutCass, overPlafon: p.overPlafon,
      // Art. 76 alin. (4^1): detaliul pe categorii ramane pe rand — statul de plata trebuie sa
      // poata arata din ce plafon a iesit fiecare leu impozitat, nu doar totalul.
      beneficii: bnf.randuri, beneficiiPlafon: bnf.plafon, beneficiiAcordate: bnf.totalAcordat,
      beneficiiNeimpozabile: bnf.totalNeimpozabil, beneficiiImpozabile: bnf.totalImpozabil,
      beneficiiRamas: bnf.ramas, beneficiiDepasit: bnf.depasit,
      cursEurBeneficii: cursBeneficii.curs, cursEurBeneficiiData: cursBeneficii.data,
      cursEurBeneficiiSursa: cursBeneficii.sursa,
      beneficiiCursNecesar,
      beneficiiCursAproximat: beneficiiCursNecesar
        && (cursBeneficii.sursa !== 'bnr' || cursBeneficiiProvizoriu),
      ordineBeneficii: Array.isArray(a.ordineBeneficii) ? a.ordineBeneficii.slice() : undefined,
      beneficiiOrdineNecesara,
      beneficiiOrdineConfirmata: !!a.beneficiiOrdineConfirmata,
      // numaratorile de care depind limitele — formularul le reciteste de aici la „editeaza"
      zileTelemunca: Math.max(0, Math.round(Number(a.zileTelemunca) || 0)),
      zileMobilitate: a.zileMobilitate != null ? Math.max(0, Math.round(Number(a.zileMobilitate) || 0)) : null,
      copiiCresa: Math.max(0, Math.round(Number(a.copiiCresa) || 0)),
      zileLucratoare: zlm, zileCM: zcm, zilePlatiteCM, zileNeplatiteCM,
      procentCM: zcm ? procentCM : 0, mediaCM, mediaZilnicaCM, zileBazaCM, luniBazaCM,
      venitBazaCMIstoric, cmBazaAproximata: cmBazaAprox, certificateCM,
      cmAngajator: cmA, cmFnuass: cmF, cmAngajatorCurent: cmACurent, cmFnuassCurent: cmFCurent,
      cmDiferentaAngajator: cmDiferentaA, cmDiferentaFnuass: cmDiferentaF,
      indemnizatieCM: round2(cmA + cmF),
      dataInceputCM: primulCM.dataInceputCM || '', zileCMAngajator: zileAngajator,
      zileCMAngajatorTotal: zileAngajatorTotal, cmAproximat: cmAprox,
      codIndemnizatieCM, cmCuCass, cmExceptatZiNeplatita: !!primulCM.cmExceptatZiNeplatita,
      cmIntegralFnuass: !!primulCM.cmIntegralFnuass, cmProgramNational: !!primulCM.cmProgramNational,
      serieCM: primulCM.serieCM || '', numarCM: primulCM.numarCM || '',
      serieInitialCM: primulCM.serieInitialCM || '', numarInitialCM: primulCM.numarInitialCM || '',
      dataAcordareCM: primulCM.dataAcordareCM || '',
      dataInceputCertificatCM: primulCM.dataInceputCertificatCM || primulCM.dataInceputCM || '',
      dataSfarsitCM: primulCM.dataSfarsitCM || '',
      locPrescriereCM: Number(primulCM.locPrescriereCM) || 1,
      codBoalaCM: primulCM.codBoalaCM || '', cnpCopilCM: primulCM.cnpCopilCM || '',
      cnpPacientOncologicCM: primulCM.cnpPacientOncologicCM || '',
      codUrgentaCM: primulCM.codUrgentaCM || '',
      codInfectocontagiosCM: primulCM.codInfectocontagiosCM || '',
      avizMedicExpertCM: primulCM.avizMedicExpertCM || '',
      cmEligibilitate: a.cmEligibilitate || '', cmStagiuDocument: a.cmStagiuDocument || '',
      cmBazaPerioadaCompleta: !!a.cmBazaPerioadaCompleta,
      istoricBazaCM: (a.istoricBazaCM || []).map((x) => Object.assign({}, x)),
      zileCO: zco, mediaCO, indemnizatieCO,
      normaPartiala: !!(a.normaPartiala && !a.scutitNormaPartiala), casAngajator: p.casAngajator, cassAngajator: p.cassAngajator,
      venitBazaCM: round2(brutTaxabil + cmA + cmF), bazaCas: p.bazaCas, bazaCass: p.bazaCass,
      cas: p.cas, cass: p.cass,
      bazaImpozit: p.baza, impozit: p.impozit, cam: p.cam, net: p.net,
      avans, retineri, restPlata, costTotal: p.costTotal,
    });
    t.deducere = round2(t.deducere + dp); t.tichete = round2((t.tichete || 0) + tichete); t.avantaje = round2(t.avantaje + avantaje);
    t.beneficiiAcordate = round2(t.beneficiiAcordate + bnf.totalAcordat);
    t.beneficiiNeimpozabile = round2(t.beneficiiNeimpozabile + bnf.totalNeimpozabil);
    t.beneficiiImpozabile = round2(t.beneficiiImpozabile + bnf.totalImpozabil);
    t.cmAngajator = round2(t.cmAngajator + cmA); t.cmFnuass = round2(t.cmFnuass + cmF); t.indemnizatieCM = round2(t.indemnizatieCM + cmA + cmF);
    t.indemnizatieCO = round2(t.indemnizatieCO + indemnizatieCO);
    t.casAngajator = round2(t.casAngajator + p.casAngajator); t.cassAngajator = round2(t.cassAngajator + p.cassAngajator);
    t.brut = round2(t.brut + brutTaxabil); t.neimpozabil = round2(t.neimpozabil + neimpozabil); t.spor = round2(t.spor + spor);
    t.neimpozabilMinim = round2((t.neimpozabilMinim || 0) + nm.suma);
    t.cas = round2(t.cas + p.cas); t.cass = round2(t.cass + p.cass); t.impozit = round2(t.impozit + p.impozit);
    t.cam = round2(t.cam + p.cam); t.net = round2(t.net + p.net); t.costTotal = round2(t.costTotal + p.costTotal);
    t.avans = round2(t.avans + avans); t.retineri = round2(t.retineri + retineri); t.restPlata = round2(t.restPlata + restPlata);
  }
  t.totalBuget = round2(t.cas + t.cass + t.impozit + t.cam + t.casAngajator + t.cassAngajator);
  return { rows, totals: t, ruleSetId: ruleSet.id, fiscalRulesHash: ruleSet.hash };
}

/** Sursa unica pentru o perioada de salarizare. Dupa postare, fotografia completa este imuabila:
 * schimbarea ulterioara a fisei angajatului nu are voie sa rescrie fluturasul, plata sau D112.
 * Fotografiile vechi, partiale (formatVersion lipsa), raman compatibile prin recalculare. */
function statPlataPerioada(view, period, preferaPostat = true) {
  const h = preferaPostat && payrollHistory.activeSnapshot(view.payrollHistory, period, view.entries);
  const platit = (view.entries || []).find((e) => e.tip === 'plata_salarii'
    && String(e.period || '') === String(period || '') && !e.stornat);
  if (h && h.formatVersion >= 2 && Array.isArray(h.rows) && h.totals) {
    return { rows: h.rows, totals: h.totals, postat: true, postedAt: h.ts,
      entryId: h.entryId || null, snapshotId: h.id || null,
      ruleSetId: h.ruleSetId || null, fiscalRulesHash: h.fiscalRulesHash || null,
      platit: !!platit, paymentEntryId: platit ? platit.id : null };
  }
  return Object.assign(statePlata(view.angajati, period, view.payrollHistory,
    { cursuriBnr: view.cursuriBnr, entries: view.entries }),
  { postat: false, snapshotIncomplet: !!h, entryId: h ? (h.entryId || null) : null,
    snapshotId: h ? (h.id || null) : null,
    platit: !!platit, paymentEntryId: platit ? platit.id : null });
}

/**
 * Documentele care pot fi semnate, platite sau depuse nu au voie sa cada tacut pe calculul
 * „live”. Dupa storno, acel calcul reprezinta deja o alta versiune a lunii, chiar daca utilizatorul
 * nu a postat corectia. Previzualizarile il pot cere explicit prin `statPlataPerioada(..., false)`,
 * dar iesirile oficiale trec toate prin aceasta poarta.
 */
function statPlataPostata(view, period) {
  const sp = statPlataPerioada(view, period, true);
  if (sp.postat) return sp;
  const p = period ? ' pe ' + period : ' pentru perioada selectata';
  const e = new Error(sp.snapshotIncomplet
    ? 'Statul de plata' + p + ' are o fotografie istorica incompleta. Storneaza articolul vechi si '
      + 'reposteaza luna pentru a genera in siguranta D112 si documentele finale.'
    : 'Statul de plata' + p
      + ' nu este postat. Inregistreaza statul lunii inainte de D112, plata sau documentele finale.');
  e.status = 409;
  throw e;
}

/** Registrul anual de salarii: cumuleaza instantaneele lunare per angajat pentru un an. */
function registruSalarii(history, year, entries) {
  const snaps = payrollHistory.activeSnapshots(history, entries)
    .filter((h) => String(h.period).startsWith(String(year)));
  const byEmp = new Map();
  for (const h of snaps) {
    for (const r of (h.rows || [])) {
      const key = r.angajatId || r.cnp || r.nume;
      if (!byEmp.has(key)) byEmp.set(key, { angajatId: key, nume: r.nume, cnp: r.cnp || '', brut: 0, cas: 0, cass: 0, impozit: 0, net: 0, luni: 0 });
      const e = byEmp.get(key);
      e.brut = round2(e.brut + (r.brut || 0)); e.cas = round2(e.cas + (r.cas || 0)); e.cass = round2(e.cass + (r.cass || 0));
      e.impozit = round2(e.impozit + (r.impozit || 0)); e.net = round2(e.net + (r.net || 0)); e.luni += 1;
    }
  }
  const angajati = [...byEmp.values()].sort((a, b) => a.nume.localeCompare(b.nume));
  const t = { brut: 0, cas: 0, cass: 0, impozit: 0, net: 0 };
  for (const e of angajati) for (const k of Object.keys(t)) t[k] = round2(t[k] + e[k]);
  return { year: String(year), angajati, totals: t, nrLuni: new Set(snaps.map((h) => h.period)).size };
}

module.exports = { statePlata, statPlataPerioada, statPlataPostata, registruSalarii, zileLucratoareInPrimele };
