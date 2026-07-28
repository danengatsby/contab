'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  CORPUSUL DE CAZURI-TEST SUPUSE REVIZIEI DE SPECIALITATE (CECCAR / fiscalist)
//
//  De ce exista separat de test/run.js: restul suitei dovedeste ca aplicatia
//  calculeaza CONSECVENT (fara regresii). Fisierul acesta dovedeste altceva —
//  ca un OM calificat a confirmat ca numerele sunt si CORECTE fata de lege.
//  Un test verde in run.js inseamna „codul face ce facea ieri"; un caz aprobat
//  aici inseamna „un expert contabil a semnat cifra asta, la data asta".
//
//  Mecanismul aprobarii:
//    - fiecare caz are `intrare`, `asteptat` (cifrele) si `temei` (baza legala);
//    - cand un specialist confirma cazul, se completeaza `aprobare` cu cine/cand
//      si cu `semnatura` = amprenta SHA-256 a tripletei (temei, intrare, asteptat);
//    - daca cineva modifica ulterior un caz APROBAT (alta intrare, alta cifra,
//      alt temei), amprenta nu mai corespunde si suita PICA cu „re-supune la
//      revizie". Aprobarea nu poate fi mostenita tacit de alte cifre.
//
//  Consecinte pe stari:
//    calculat != asteptat            -> EROARE (regresie sau cifra gresita)
//    aprobat, dar amprenta schimbata -> EROARE (modificat dupa aprobare)
//    neaprobat inca                  -> AVERTISMENT (nu blocheaza `npm test`)
//
//  Utilizare:
//    node test/cazuri-aprobate.js                 ruleaza corpusul
//    node test/cazuri-aprobate.js --semnatura ID  tipareste amprenta de lipit in `aprobare`
//    node test/cazuri-aprobate.js --md            tabelul pentru dosarul de revizie
//    node test/cazuri-aprobate.js --dosar         documentul de LUCRU al revizorului (de trimis)
//
//  Dosarul trimis revizorului: docs/dosar-revizie-fiscala.md
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fiscal = require('../src/fiscal');
const cfg = require('../src/fiscalConfig');
const { statePlata } = require('../src/payroll');
const deduct = require('../src/deductibilitate');

/** Istoric de state postate (pentru mediile de concediu): `luni` luni cu acelasi brut. */
function istoric(id, luni, brut) {
  return luni.map((period) => ({ period, rows: [{ angajatId: id, brut }] }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  CAZURILE
//
//  `arie`      — capitolul de revizie (grupeaza in dosar)
//  `temei`     — actul normativ pe care revizorul il verifica
//  `intrare`   — datele de intrare (afisate revizorului ca atare)
//  `asteptat`  — cifrele supuse aprobarii
//  `calc`      — apelul real din cod care trebuie sa produca `asteptat`
//  `observatii`— abaterile CUNOSCUTE / intrebarile deschise pentru revizor
//  `aprobare`  — null pana la semnatura; apoi { de, la, nota, semnatura }
// ─────────────────────────────────────────────────────────────────────────────

const CAZURI = [
  // ─── Cote si praguri (verificarea anuala „de ianuarie") ───────────────────
  {
    id: 'COT-01', arie: 'Cote si praguri',
    titlu: 'Cotele de contributii si impozit pe salarii, anul ' + cfg.AN,
    temei: 'Art. 138 (CAS 25%), art. 156 (CASS 10%), art. 78 (impozit 10%), art. 220^3 (CAM 2,25%) Cod fiscal',
    intrare: { an: cfg.AN },
    asteptat: { cas: 25, cass: 10, impozitVenit: 10, cam: 2.25 },
    calc: () => ({ cas: fiscal.FISCAL.cas, cass: fiscal.FISCAL.cass, impozitVenit: fiscal.FISCAL.impozitVenit, cam: fiscal.FISCAL.cam }),
    aprobare: null,
  },
  {
    id: 'COT-02', arie: 'Cote si praguri',
    titlu: 'Salariul minim brut si sumele neimpozabile, pe semestre',
    temei: 'HG salariu minim ' + cfg.AN + '; art. 76 Cod fiscal (suma neimpozabila din salariul minim)',
    intrare: { luna_S1: '2026-03', luna_S2: '2026-08' },
    asteptat: { salariuMinimS1: 4050, salariuMinimS2: 4325, neimpozabilS1: 300, neimpozabilS2: 200 },
    calc: () => ({
      salariuMinimS1: fiscal.salariuMinimLa('2026-03'), salariuMinimS2: fiscal.salariuMinimLa('2026-08'),
      neimpozabilS1: fiscal.neimpozabilLa('2026-03'), neimpozabilS2: fiscal.neimpozabilLa('2026-08'),
    }),
    observatii: 'Trecerea S1 -> S2 e fixata la 1 iulie. De confirmat data intrarii in vigoare a HG pentru anul revizuit.',
    aprobare: null,
  },
  {
    id: 'COT-03', arie: 'Cote si praguri',
    titlu: 'Cotele de TVA si plafonul regimului special de scutire',
    temei: 'Legea 141/2025 (TVA 21% / 11% de la 1 aug. 2025); art. 310 Cod fiscal, OG 22/2025 (plafon 395.000 lei de la 1 sept. 2025)',
    intrare: { an: cfg.AN },
    asteptat: { tvaStandard: 21, tvaRedus: 11, plafonScutireTvaLei: 395000, deductibilitateTvaAutoLimitat: 50 },
    calc: () => ({
      tvaStandard: fiscal.FISCAL.tvaStandard, tvaRedus: fiscal.FISCAL.tvaRedus,
      plafonScutireTvaLei: fiscal.FISCAL.plafonScutireTvaLei, deductibilitateTvaAutoLimitat: fiscal.FISCAL.deductibilitateTvaAutoLimitat,
    }),
    aprobare: null,
  },
  {
    id: 'COT-04', arie: 'Cote si praguri',
    titlu: 'Impozitul pe profit / micro / dividende si plafonul micro',
    temei: 'Art. 17 (profit 16%), art. 51 (micro 1%), art. 47 Cod fiscal + OUG 156/2024 (plafon 100.000 EUR); Legea 141/2025 (dividende 16% de la 1 ian. 2026)',
    intrare: { an: cfg.AN },
    asteptat: { impozitProfit: 16, impozitMicro: 1, impozitDividende: 16, plafonMicroEur: 100000 },
    calc: () => ({
      impozitProfit: fiscal.FISCAL.impozitProfit, impozitMicro: fiscal.FISCAL.impozitMicro,
      impozitDividende: fiscal.FISCAL.impozitDividende, plafonMicroEur: fiscal.FISCAL.plafonMicroEur,
    }),
    observatii: 'Cursul folosit la plafonul micro (`cursPlafonMicro`) e o valoare orientativa in cod; legal e cursul de la '
      + 'inchiderea exercitiului precedent. De decis daca ramane parametru sau se preia automat.',
    aprobare: null,
  },

  // ─── Salarii: cazul de baza ───────────────────────────────────────────────
  {
    id: 'SAL-01', arie: 'Salarii',
    titlu: 'Salariu brut 5.000 lei, fara deduceri si fara beneficii',
    temei: 'Art. 138, 156, 78, 220^3 Cod fiscal',
    intrare: { brut: 5000, deducere: 0 },
    asteptat: { cas: 1250, cass: 500, baza: 3250, impozit: 325, cam: 112.5, net: 2925, costTotal: 5112.5 },
    calc: (i) => {
      const p = fiscal.payroll(i.brut, i.deducere);
      return { cas: p.cas, cass: p.cass, baza: p.baza, impozit: p.impozit, cam: p.cam, net: p.net, costTotal: p.costTotal };
    },
    aprobare: null,
  },
  {
    id: 'SAL-02', arie: 'Salarii',
    titlu: 'Tichete de masa 400 lei peste un brut de 5.000 lei',
    temei: 'Art. 76 alin. (3) si art. 157 Cod fiscal — tichetele suporta CASS si impozit, NU CAS',
    intrare: { brut: 5000, tichete: 400 },
    asteptat: { cas: 1250, cass: 540, baza: 3610, impozit: 361, cam: 112.5, net: 2849 },
    calc: (i) => {
      const p = fiscal.payroll(i.brut, 0, { tichete: i.tichete });
      return { cas: p.cas, cass: p.cass, baza: p.baza, impozit: p.impozit, cam: p.cam, net: p.net };
    },
    observatii: 'CAM se calculeaza NUMAI pe salariul brut (112,50 = 2,25% x 5.000), tichetele fiind excluse din baza CAM. '
      + 'De confirmat tratamentul. Netul in numerar nu include tichetele (se acorda ca valoare).',
    aprobare: null,
  },
  {
    id: 'SAL-03', arie: 'Salarii',
    titlu: 'Avantaje in natura impozabile 1.000 lei peste un brut de 5.000 lei',
    temei: 'Art. 76 alin. (3) Cod fiscal — avantajele intra in baza CAS + CASS + impozit + CAM',
    intrare: { brut: 5000, avantaje: 1000 },
    asteptat: { cas: 1500, cass: 600, baza: 3900, impozit: 390, cam: 135, net: 2510 },
    calc: (i) => {
      const p = fiscal.payroll(i.brut, 0, { avantaje: i.avantaje });
      return { cas: p.cas, cass: p.cass, baza: p.baza, impozit: p.impozit, cam: p.cam, net: p.net };
    },
    observatii: 'Netul in numerar (2.510) scade cu contributiile aferente avantajului, avantajul nefiind platit in bani.',
    aprobare: null,
  },
  {
    id: 'SAL-04', arie: 'Salarii',
    titlu: 'Norma partiala: brut 2.000 lei sub salariul minim (S1)',
    temei: 'Art. 146 alin. (5^6) Cod fiscal, OUG 16/2022 — CAS/CASS la nivelul salariului minim, diferenta in sarcina angajatorului',
    intrare: { brut: 2000, perioada: '2026-03', salariuMinim: 4050, normaPartiala: true },
    asteptat: { cas: 500, cass: 200, impozit: 130, net: 1170, casAngajator: 512.5, cassAngajator: 205, costTotal: 2762.5 },
    calc: (i) => {
      const r = statePlata([{ id: 'np', nume: 'Test', salariuBrut: i.brut, zileLucratoare: 21, normaPartiala: true }], i.perioada).rows[0];
      return { cas: r.cas, cass: r.cass, impozit: r.impozit, net: r.net, casAngajator: r.casAngajator, cassAngajator: r.cassAngajator, costTotal: r.costTotal };
    },
    observatii: 'Diferenta pana la minim NU se retine din netul angajatului. Exceptiile legale (elevi/studenti, pensionari, '
      + 'ucenici, dizabilitate, cumul de norma intreaga) se bifeaza manual pe angajat — de confirmat ca lista e completa.',
    aprobare: null,
  },

  // ─── Deducerea personala ──────────────────────────────────────────────────
  {
    id: 'DED-01', arie: 'Deducerea personala',
    titlu: 'Deducerea de baza la nivelul salariului minim (S1), 0 si 2 persoane in intretinere',
    temei: 'Art. 77 Cod fiscal, Legea 34/2023 — 20% / 25% / 30% / 35% / 45% din salariul minim',
    intrare: { brut: 4050, salariuMinim: 4050, perioada: '2026-03' },
    asteptat: { pers0: 810, pers2: 1220 },
    calc: (i) => ({
      pers0: fiscal.deducerePersonala(i.brut, 0, { period: i.perioada }).total,
      pers2: fiscal.deducerePersonala(i.brut, 2, { period: i.perioada }).total,
    }),
    observatii: 'Rezultatul se rotunjeste la 10 lei IN FAVOAREA angajatului (1.215 -> 1.220). De confirmat regula de rotunjire.',
    aprobare: null,
  },
  {
    id: 'DED-02', arie: 'Deducerea personala',
    titlu: 'Diminuarea deducerii peste salariul minim (la +1.000 lei si la +2.000 lei)',
    temei: 'Art. 77 Cod fiscal — deducerea scade pana la 0 la salariul minim + 2.000 lei',
    intrare: { brut_5050: 5050, brut_6050: 6050, salariuMinim: 4050, persoane: 0 },
    asteptat: { la_5050: 410, la_6050: 0 },
    calc: (i) => ({
      la_5050: fiscal.deducerePersonala(i.brut_5050, 0, { period: '2026-03' }).total,
      la_6050: fiscal.deducerePersonala(i.brut_6050, 0, { period: '2026-03' }).total,
    }),
    observatii: 'ABATERE CUNOSCUTA: codul interpoleaza LINIAR intre minim si minim+2.000, in loc sa citeasca grila '
      + 'oficiala ANAF pe transe de 50 lei. Diferentele sunt de ordinul catorva lei pe transa. '
      + 'De decis: se accepta aproximarea sau se introduce grila exacta?',
    aprobare: null,
  },
  {
    id: 'DED-03', arie: 'Deducerea personala',
    titlu: 'Deducerea suplimentara pentru tineri sub 26 de ani, la salariul minim',
    temei: 'Art. 77 alin. (7) Cod fiscal — 15% din salariul minim, pentru venit brut pana la nivelul salariului minim',
    intrare: { brut: 4050, sub26: true, persoane: 0, perioada: '2026-03' },
    asteptat: { baza: 810, suplimentara: 607.5, total: 1420 },
    calc: (i) => {
      const d = fiscal.deducerePersonala(i.brut, 0, { period: i.perioada, sub26: true });
      return { baza: d.baza, suplimentara: d.suplimentara, total: d.total };
    },
    aprobare: null,
  },

  // ─── Concedii (zona marcata „simplificat" in cod) ─────────────────────────
  {
    id: 'CM-01', arie: 'Concedii medicale',
    titlu: 'Concediu medical 10 zile din 21, brut 5.000 lei, fara istoric de state postate',
    temei: 'OUG 158/2005 — indemnizatie 75%, primele 5 zile in sarcina angajatorului, restul FNUASS; '
      + 'art. 157 Cod fiscal — indemnizatiile nu suporta CASS',
    intrare: { brut: 5000, zileLucratoare: 21, zileCM: 10, procentCM: 75, perioada: '2026-03', istoric: 'niciun stat postat' },
    asteptat: {
      mediaCM: 5000, cmAngajator: 892.85, cmFnuass: 892.85, salariuZileLucrate: 2619.05,
      cas: 1101.19, cass: 261.9, impozit: 304.17, cam: 79.02, net: 2737.49,
    },
    calc: (i) => {
      const r = statePlata([{ id: 'cm', nume: 'Test', salariuBrut: i.brut, zileLucratoare: i.zileLucratoare, zileCM: i.zileCM }], i.perioada).rows[0];
      return {
        mediaCM: r.mediaCM, cmAngajator: r.cmAngajator, cmFnuass: r.cmFnuass, salariuZileLucrate: r.salariuZileLucrate,
        cas: r.cas, cass: r.cass, impozit: r.impozit, cam: r.cam, net: r.net,
      };
    },
    observatii: 'ZONA CU CELE MAI MULTE SIMPLIFICARI — vezi capitolul dedicat din dosar. Puncte de decis: '
      + '(1) `zileCM` e tratat ca zile LUCRATOARE, iar cele 5 zile ale angajatorului se scad din ele — OUG 158/2005 '
      + 'vorbeste de zile CALENDARISTICE; (2) media zilnica se obtine impartind baza la zilele lucratoare ale lunii '
      + 'curente, nu la zilele de stagiu din cele 6 luni; (3) fara istoric, baza cade pe brutul curent; '
      + '(4) CASS nu se retine pe indemnizatie, CAS si impozitul da, CAM doar pe partea angajatorului.',
    aprobare: null,
  },
  {
    id: 'CM-02', arie: 'Concedii medicale',
    titlu: 'Acelasi concediu, cu 6 state postate anterior la 6.000 lei brut (baza = media)',
    temei: 'OUG 158/2005 art. 10 — baza de calcul = media veniturilor brute lunare din ultimele 6 luni, plafonata la 12 salarii minime',
    intrare: { brut: 5000, istoric: '6 luni x 6.000 lei', zileLucratoare: 21, zileCM: 10, perioada: '2026-03' },
    asteptat: { mediaCM: 6000, cmAngajator: 1071.45, cmFnuass: 1071.45, cas: 1190.49, cass: 261.9, net: 2978.6 },
    calc: (i) => {
      const h = istoric('cm2', ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02'], 6000);
      const r = statePlata([{ id: 'cm2', nume: 'Test', salariuBrut: i.brut, zileLucratoare: i.zileLucratoare, zileCM: i.zileCM }], i.perioada, h).rows[0];
      return { mediaCM: r.mediaCM, cmAngajator: r.cmAngajator, cmFnuass: r.cmFnuass, cas: r.cas, cass: r.cass, net: r.net };
    },
    observatii: 'Media se ia din statele POSTATE in aplicatie; o firma migrata la mijloc de an are istoric incomplet. '
      + 'Plafonul de 12 salarii minime se aplica mediei LUNARE (48.600 lei la S1). Stagiul minim de cotizare '
      + '(6 luni in ultimele 12) NU e verificat de aplicatie.',
    aprobare: null,
  },
  {
    id: 'CO-01', arie: 'Concedii de odihna',
    titlu: 'Concediu de odihna 10 zile din 21, brut 5.000 lei, fara istoric',
    temei: 'Art. 150 Codul muncii — indemnizatia de concediu = media zilnica a veniturilor din ultimele 3 luni; '
      + 'se impoziteaza ca salariul',
    intrare: { brut: 5000, zileLucratoare: 21, zileCO: 10, perioada: '2026-03' },
    asteptat: { mediaCO: 5000, indemnizatieCO: 2380.95, salariuZileLucrate: 2619.05, brutTaxabil: 5000, cas: 1250, cass: 500, impozit: 325, net: 2925 },
    calc: (i) => {
      const r = statePlata([{ id: 'co', nume: 'Test', salariuBrut: i.brut, zileLucratoare: i.zileLucratoare, zileCO: i.zileCO }], i.perioada).rows[0];
      return {
        mediaCO: r.mediaCO, indemnizatieCO: r.indemnizatieCO, salariuZileLucrate: r.salariuZileLucrate,
        brutTaxabil: r.brut, cas: r.cas, cass: r.cass, impozit: r.impozit, net: r.net,
      };
    },
    observatii: 'Indemnizatia de CO suporta integral CAS + CASS + impozit + CAM (spre deosebire de cea de CM). '
      + 'Baza legala e media pe ultimele 3 luni; codul o ia din statele postate, cu fallback pe brutul curent.',
    aprobare: null,
  },

  // ─── PFA / Declaratia Unica ───────────────────────────────────────────────
  {
    id: 'PFA-01', arie: 'PFA — Declaratia Unica',
    titlu: 'Venit net 30.000 lei (intre 6 si 12 salarii minime): CASS da, CAS nu',
    temei: 'Art. 170 Cod fiscal (CASS, plafon inferior 6 SM) si art. 148 (CAS, datorata de la 12 SM)',
    intrare: { venitNet: 30000, salariuMinim: 4050 },
    asteptat: { plafon6: 24300, plafon12: 48600, bazaCas: 0, cas: 0, bazaCass: 30000, cass: 3000, impozit: 2700, total: 5700 },
    calc: (i) => {
      const t = fiscal.taxePfa(i.venitNet, { salariuMinim: i.salariuMinim });
      return { plafon6: t.plafon6, plafon12: t.plafon12, bazaCas: t.bazaCas, cas: t.cas, bazaCass: t.bazaCass, cass: t.cass, impozit: t.impozit, total: t.total };
    },
    observatii: 'CAS sub 12 SM e OPTIONALA; aplicatia o considera 0 (neoptata). Impozitul se aplica dupa scaderea CAS si CASS.',
    aprobare: null,
  },
  {
    id: 'PFA-02', arie: 'PFA — Declaratia Unica',
    titlu: 'Venit net 60.000 lei (peste 12 SM): baza CAS = 12 salarii minime',
    temei: 'Art. 148 Cod fiscal — baza CAS aleasa: 12 SM intre 12 si 24 SM',
    intrare: { venitNet: 60000, salariuMinim: 4050 },
    asteptat: { bazaCas: 48600, cas: 12150, bazaCass: 60000, cass: 6000, impozit: 4185, total: 22335 },
    calc: (i) => {
      const t = fiscal.taxePfa(i.venitNet, { salariuMinim: i.salariuMinim });
      return { bazaCas: t.bazaCas, cas: t.cas, bazaCass: t.bazaCass, cass: t.cass, impozit: t.impozit, total: t.total };
    },
    aprobare: null,
  },
  {
    id: 'PFA-03', arie: 'PFA — Declaratia Unica',
    titlu: 'Venit net 300.000 lei: baza CAS = 24 SM, CASS plafonata la 60 SM',
    temei: 'Art. 148 si 170 Cod fiscal — plafoanele 24 SM (CAS) si 60 SM (CASS)',
    intrare: { venitNet: 300000, salariuMinim: 4050 },
    asteptat: { bazaCas: 97200, cas: 24300, bazaCass: 243000, cass: 24300, impozit: 25140, total: 73740 },
    calc: (i) => {
      const t = fiscal.taxePfa(i.venitNet, { salariuMinim: i.salariuMinim });
      return { bazaCas: t.bazaCas, cas: t.cas, bazaCass: t.bazaCass, cass: t.cass, impozit: t.impozit, total: t.total };
    },
    observatii: 'Rezultatul e marcat „estimare" in interfata si in PDF. De confirmat ca plafonarea CASS la 60 SM '
      + 'ramane valabila pentru anul revizuit.',
    aprobare: null,
  },

  // ─── Plafoane de deductibilitate la impozitul pe profit ───────────────────
  {
    id: 'PLF-01', arie: 'Plafoane de deductibilitate (impozit pe profit)',
    titlu: 'Cheltuieli de protocol — plafonul de 2% si BAZA lui de calcul',
    temei: 'Art. 25(3)(a) Cod fiscal — deductibile in limita a 2% din baza = profit contabil '
      + '+ cheltuielile de protocol + cheltuiala cu impozitul pe profit',
    intrare: { profitContabil: 100000, cheltProtocol: 5000, cheltImpozitProfit: 16000 },
    asteptat: { baza: 121000, plafon: 2420, nedeductibil: 2580 },
    calc: (i) => {
      const r = deduct.ajustari({ rulaj: { 623: { d: i.cheltProtocol, c: 0 } },
        profitContabil: i.profitContabil, cheltImpozitProfit: i.cheltImpozitProfit }, cfg.RATES);
      const x = r.randuri.find((y) => y.regula === 'Protocol');
      return { baza: x.baza, plafon: x.plafon, nedeductibil: x.nedeductibil };
    },
    observatii: 'PUNCTUL DE CONFIRMAT: baza include cheltuiala de protocol INSASI si impozitul pe profit. '
      + 'Daca revizorul considera ca baza e alta (ex. doar profitul contabil), plafonul devine 2.000 '
      + 'si nedeductibilul 3.000 — deci cifra se schimba.',
    aprobare: null,
  },
  {
    id: 'PLF-02', arie: 'Plafoane de deductibilitate (impozit pe profit)',
    titlu: 'Cheltuieli sociale — plafonul de 5% din fondul de salarii',
    temei: 'Art. 25(3)(b) Cod fiscal — deductibile in limita a 5% din cheltuielile cu salariile personalului',
    intrare: { cheltSociale: 3000, fondSalarii: 40000 },
    asteptat: { plafon: 2000, nedeductibil: 1000 },
    calc: (i) => {
      const r = deduct.ajustari({ rulaj: { 6458: { d: i.cheltSociale, c: 0 }, 641: { d: i.fondSalarii, c: 0 } },
        profitContabil: 0 }, cfg.RATES);
      const x = r.randuri.find((y) => y.regula === 'Cheltuieli sociale');
      return { plafon: x.plafon, nedeductibil: x.nedeductibil };
    },
    observatii: 'Baza e rulajul contului 641. De confirmat daca in fondul de salarii intra si alte conturi '
      + '(ex. 642/643/644) pentru firmele care le folosesc.',
    aprobare: null,
  },
  {
    id: 'PLF-03', arie: 'Plafoane de deductibilitate (impozit pe profit)',
    titlu: 'Sponsorizare — cheltuiala nedeductibila + creditul fiscal cu dublu plafon',
    temei: 'Art. 25(4)(i) Cod fiscal — cheltuiala integral nedeductibila; se scade DIN IMPOZIT '
      + 'in limita minimului dintre 0,75% din cifra de afaceri si 20% din impozitul pe profit',
    intrare: { sponsorizare: 10000, cifraAfaceri: 800000, impozit: 20000 },
    asteptat: { nedeductibil: 10000, plafonCa: 6000, plafonImpozit: 4000, credit: 4000, report: 6000 },
    calc: (i) => {
      const a = deduct.ajustari({ rulaj: { 6582: { d: i.sponsorizare, c: 0 } }, profitContabil: 0 }, cfg.RATES);
      const x = a.randuri.find((y) => y.regula === 'Sponsorizare (cheltuiala)');
      const c = deduct.credit({ cifraAfaceri: i.cifraAfaceri, impozit: i.impozit,
        sponsorizareAn: a.sponsorizareCheltuita, report: [], an: cfg.AN }, cfg.RATES);
      return { nedeductibil: x.nedeductibil, plafonCa: c.plafonCa, plafonImpozit: c.plafonImpozit,
        credit: c.folosit, report: c.reportNou.reduce((s, b) => s + b.suma, 0) };
    },
    observatii: 'DOUA puncte de confirmat. (1) Validatorul oficial D101 impune plafonul ca '
      + '`round((P41-P42)*20%) >= P43` — deci pe impozitul MINUS creditul fiscal extern, nu pe impozitul brut; '
      + 'aplicatia nu modeleaza P42, deci azi coincid. (2) Reportul creditului neutilizat pe '
      + cfg.RATES.sponsorizareReportAni + ' ani: de confirmat ca regimul de report e cel in vigoare pentru anul '
      + 'revizuit (regulile de report/redirectionare s-au schimbat in ultimii ani).',
    aprobare: null,
  },
  {
    id: 'PLF-04', arie: 'Plafoane de deductibilitate (impozit pe profit)',
    titlu: 'Cheltuieli auto — 50% nedeductibil pe CHELTUIALA (distinct de TVA)',
    temei: 'Art. 25(3)(l) Cod fiscal — 50% din cheltuielile aferente vehiculelor fara utilizare '
      + 'exclusiv in scopul activitatii economice',
    intrare: { cheltAuto: 8000 },
    asteptat: { nedeductibil: 4000 },
    calc: (i) => {
      const r = deduct.ajustari({ rulaj: {}, profitContabil: 0, cheltAuto: i.cheltAuto }, cfg.RATES);
      return { nedeductibil: r.randuri.find((y) => y.regula === 'Cheltuieli auto').nedeductibil };
    },
    observatii: 'Baza vine din articolele bifate „auto 50%" la inregistrare. Limitarea e DISTINCTA de cea '
      + 'de TVA (art. 298), care se aplica deja la inregistrare — de confirmat ca nu se considera dubla limitare.',
    aprobare: null,
  },
  {
    id: 'PLF-05', arie: 'Plafoane de deductibilitate (impozit pe profit)',
    titlu: 'Costuri excedentare ale indatorarii — plafon in EUR + 30% din baza',
    temei: 'Art. 40^2 Cod fiscal — deductibile pana la echivalentul a 1.000.000 EUR; '
      + 'ce depaseste, doar pana la 30% din baza de calcul',
    intrare: { cheltDobanzi: 20000000, venitDobanzi: 0, profitContabil: 100000, amortizareFiscala: 0, cursEur: 5 },
    asteptat: { costExcedentar: 20000000, plafonAplicat: 11030000, nedeductibil: 8970000 },
    calc: (i) => {
      const r = deduct.ajustari({ rulaj: { 666: { d: i.cheltDobanzi, c: 0 }, 766: { d: 0, c: i.venitDobanzi } },
        profitContabil: i.profitContabil, rezultatFiscalInainteDobanzi: i.profitContabil,
        amortizareFiscala: i.amortizareFiscala, cursEur: i.cursEur }, cfg.RATES);
      const x = r.randuri.find((y) => y.regula === 'Costuri excedentare ale indatorarii');
      return { costExcedentar: x.cheltuit, plafonAplicat: x.plafon, nedeductibil: x.nedeductibil };
    },
    observatii: 'INTERPRETARE DE CONFIRMAT, cea mai incerta din acest grup: aplicatia trateaza plafonul in EUR '
      + 'ca deductibil neconditionat si aplica cei 30% DOAR partii care il depaseste (deductibil = 5.000.000 '
      + '+ min(15.000.000; 30% x 20.100.000)). O citire alternativa ar fi deductibil = max(plafon EUR; 30% din baza), '
      + 'care aici ar da 6.030.000 si un nedeductibil de 13.970.000. De asemenea: baza de calcul foloseste '
      + 'amortizarea fiscala, care azi coincide cu cea contabila (vezi itemul separat din backlog), iar '
      + 'diferentele de curs aferente imprumuturilor NU sunt incluse in costul excedentar.',
    aprobare: null,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  MECANICA
// ─────────────────────────────────────────────────────────────────────────────

/** Serializare canonica (chei sortate recursiv) — amprenta nu depinde de ordinea din fisier. */
function canonic(v) {
  if (Array.isArray(v)) return '[' + v.map(canonic).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonic(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

/** Amprenta unui caz: ce anume a fost aprobat (temei + intrare + cifre asteptate). */
function semnatura(c) {
  return crypto.createHash('sha256').update(canonic({ temei: c.temei, intrare: c.intrare, asteptat: c.asteptat })).digest('hex').slice(0, 16);
}

let pass = 0; let fail = 0; const probleme = [];

function eroare(msg) { fail++; probleme.push(msg); console.log('  ✗ ' + msg); }

/** Comparatie STRICTA — fara toleranta: un caz aprobat inseamna cifra exacta, la ban. */
function verifica(c) {
  let obtinut;
  try { obtinut = c.calc(c.intrare); } catch (e) {
    eroare(c.id + ': calculul a aruncat eroare — ' + e.message);
    return false;
  }
  let bun = true;
  for (const k of Object.keys(c.asteptat)) {
    const a = c.asteptat[k]; const o = obtinut[k];
    if (o === a) { pass++; continue; }
    bun = false;
    eroare(c.id + ' [' + k + ']: asteptat ' + a + ', calculat ' + o);
  }
  return bun;
}

function ruleaza() {
  const azi = new Date().toISOString().slice(0, 10);
  console.log('\nCazuri-test supuse reviziei de specialitate — set fiscal ' + cfg.AN
    + ' (actualizat ' + cfg.DATA_ACTUALIZARE + ')\n');

  const ids = new Set();
  let aprobate = 0; const neaprobate = []; let ultimaRevizie = '';

  let arieCurenta = '';
  for (const c of CAZURI) {
    if (ids.has(c.id)) eroare('id duplicat in corpus: ' + c.id);
    ids.add(c.id);
    if (c.arie !== arieCurenta) { arieCurenta = c.arie; console.log('── ' + arieCurenta); }

    const okCalc = verifica(c);
    const ap = c.aprobare;
    let stare;
    if (!ap) {
      neaprobate.push(c.id);
      stare = 'NEREVIZUIT';
    } else if (ap.semnatura !== semnatura(c)) {
      // Cazul a fost modificat DUPA aprobare: aprobarea nu mai acopera cifrele curente.
      eroare(c.id + ': caz APROBAT dar modificat ulterior (amprenta ' + ap.semnatura + ' != ' + semnatura(c) + '). '
        + 'Re-supune-l la revizie si actualizeaza `aprobare`.');
      stare = 'APROBARE INVALIDA';
    } else {
      aprobate++;
      if (String(ap.la) > ultimaRevizie) ultimaRevizie = String(ap.la);
      stare = 'aprobat ' + ap.la + ' — ' + ap.de;
    }
    console.log('   ' + (okCalc ? '✓' : '✗') + ' ' + c.id + '  ' + c.titlu + '\n       [' + stare + ']');
  }

  // ─── Raportul de acoperire a reviziei ───────────────────────────────────
  console.log('\n── Acoperirea reviziei');
  console.log('   ' + aprobate + ' / ' + CAZURI.length + ' cazuri aprobate de un specialist');
  if (neaprobate.length) {
    console.log('   ⚠ NEREVIZUITE: ' + neaprobate.join(', '));
    console.log('   ⚠ Cifrele de mai sus sunt doar CONSECVENTE cu implementarea, nu confirmate fata de lege.');
    console.log('     Vezi docs/dosar-revizie-fiscala.md pentru procedura de aprobare.');
  }
  if (ultimaRevizie) {
    console.log('   Ultima aprobare: ' + ultimaRevizie);
    const anRevizie = Number(ultimaRevizie.slice(0, 4));
    if (anRevizie < cfg.AN) {
      console.log('   ⚠ Setul fiscal e pentru anul ' + cfg.AN + ', dar ultima revizie e din ' + anRevizie
        + ' — revizia anuala e restanta.');
    }
  }
  const anAzi = Number(azi.slice(0, 4));
  if (anAzi > cfg.AN) console.log('   ⚠ Anul calendaristic (' + anAzi + ') a depasit anul setului fiscal (' + cfg.AN + ').');

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari trecute, ' + fail + ' esuate.');
  return fail ? 1 : 0;
}

/** `--dosar`: documentul de LUCRU al revizorului — fiecare caz cu intrarea, cifrele si intrebarile
 *  deschise, ca sa poata bifa/contesta fara sa citeasca JavaScript. Asta se trimite, nu codul. */
function dosar() {
  // `an` e un an calendaristic, nu o suma: fara separator de mii (altfel „2.026").
  const val = (k, v) => {
    if (v == null) return '—';
    if (typeof v !== 'number') return String(v);
    if (/^an$/i.test(k)) return String(v);
    return v.toLocaleString('ro-RO', { maximumFractionDigits: 2 });
  };
  const tabel = (o) => Object.keys(o).map((k) => '| `' + k + '` | ' + val(k, o[k]) + ' |').join('\n');
  console.log('# Cazuri fiscale supuse aprobării — document de lucru\n');
  console.log('Set fiscal **' + cfg.AN + '** (actualizat ' + cfg.DATA_ACTUALIZARE + '). '
    + CAZURI.length + ' cazuri, ' + CAZURI.filter((c) => c.aprobare).length + ' aprobate.\n');
  console.log('Pentru fiecare caz: **temeiul** pe care se verifică, **intrarea** și **cifrele** '
    + 'propuse. Marcați fiecare caz cu ✔ (corect) sau ✘ + valoarea corectă și temeiul. '
    + 'Punctele „De decis" sunt cele unde implementarea e simplificată deliberat.\n');
  let arie = '';
  for (const c of CAZURI) {
    if (c.arie !== arie) { arie = c.arie; console.log('\n## ' + arie); }
    console.log('\n### ' + c.id + ' — ' + c.titlu + '\n');
    console.log('**Temei:** ' + c.temei.replace(/\n\s*/g, ' ') + '\n');
    console.log('| Intrare | Valoare |\n|---|---|');
    console.log(tabel(c.intrare));
    console.log('\n| Cifra propusă spre aprobare | Valoare |\n|---|---|');
    console.log(tabel(c.asteptat));
    if (c.observatii) console.log('\n> **De decis:** ' + c.observatii.replace(/\n\s*/g, ' '));
    console.log('\n**Verdict:** ☐ corect ☐ incorect → valoarea corectă: ............ (temei: ............)');
  }
  console.log('\n---\n');
  console.log('Revizor: ........................................  '
    + 'Calitate/nr. CECCAR: ....................  Data: ..............\n');
}

/** `--md`: tabelul de cazuri pentru dosarul trimis revizorului. */
function tabelMd() {
  let arie = '';
  for (const c of CAZURI) {
    if (c.arie !== arie) {
      arie = c.arie;
      console.log('\n### ' + arie + '\n');
      console.log('| Caz | Ce se verifică | Temei | Aprobare |');
      console.log('|---|---|---|---|');
    }
    const ap = c.aprobare ? (c.aprobare.de + ', ' + c.aprobare.la) : '— (nerevizuit)';
    console.log('| `' + c.id + '` | ' + c.titlu + ' | ' + c.temei.replace(/\n\s*/g, ' ') + ' | ' + ap + ' |');
  }
  console.log('');
}

const arg = process.argv[2];
if (arg === '--semnatura') {
  const c = CAZURI.find((x) => x.id === process.argv[3]);
  if (!c) { console.error('Caz inexistent: ' + process.argv[3] + '. Cazuri: ' + CAZURI.map((x) => x.id).join(', ')); process.exit(1); }
  console.log(semnatura(c));
} else if (arg === '--md') {
  tabelMd();
} else if (arg === '--dosar') {
  dosar();
} else {
  process.exit(ruleaza());
}

module.exports = { CAZURI, semnatura };
