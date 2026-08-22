'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  GENERATOARELE PDF: se verifica CE SCRIE PE HARTIE, nu ca raspunsul incepe cu %PDF.
//
//  Pana acum, singura proba pe src/pdf/ era fumul din test/http.js: „ruta raspunde 200 si
//  continutul incepe cu %PDF". Masurat, asta lasa `src/pdf/stocuri.js` la 3,2% si
//  `src/pdf/salarii.js` la 3,7% acoperire — cele mai slab acoperite doua module din tot `src/`,
//  desi produc exact documentele pe care omul le SEMNEAZA si le da mai departe: fluturasul,
//  statul de plata, adeverinta de venit, NIR-ul, bonul de consum, avizul, procesul-verbal de
//  inventariere.
//
//  Un PDF fara logo, fara linia de rest de plata sau fara marcajul „STORNAT" e tot un PDF valid,
//  cu acelasi `%PDF` la inceput. Fumul nu putea vedea diferenta — si chiar n-a vazut-o: bugul
//  logo-ului (require rupt la split-ul monolitului) a trait 26 de zile sub fum verde.
//
//  Metoda: se genereaza documentul intr-un `res` fals care aduna octetii, apoi se EXTRAGE TEXTUL
//  cu acelasi `src/extractor.js` folosit pe documentele primite, si se afirma pe text. Deci proba
//  trece prin randare reala (pdfkit) si prin citire reala — nu prin intentia autorului.
//
//  Suita e ASINCRONA (pdfkit scrie pe stream, extragerea intoarce promisiune), deci sta in fisier
//  propriu: `test/run.js` e sincron prin constructie, iar acolo aserttile async nu s-ar numara
//  si nu ar putea pica (vezi CLAUDE.md).
// ─────────────────────────────────────────────────────────────────────────────

const { Writable } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Directorul de date TREBUIE redirectionat inainte de a cere `src/db` (UPLOAD_DIR se fixeaza la
// incarcare): altfel proba de logo ar scrie in data/uploads REAL. Vezi poarta din test/run.js.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'contab-pdf-'));
process.env.CONTAB_DATA_DIR = TMP;
process.env.CONTAB_DB_FILE = path.join(TMP, 'db.json');
fs.mkdirSync(path.join(TMP, 'uploads'), { recursive: true });

const salarii = require('../src/pdf/salarii');
const declaratii = require('../src/pdf/declaratii');
const xmlMod = require('../src/xml');
const stocuri = require('../src/pdf/stocuri');
const helpers = require('../src/pdf/helpers');
const ex = require('../src/extractor');

let pass = 0; let fail = 0;
function ok(name, cond) { if (cond) { pass += 1; } else { fail += 1; console.log('  ✗ ' + name); } }
function eq(name, got, want) { ok(name + ' (=' + JSON.stringify(want) + ', got ' + JSON.stringify(got) + ')', got === want); }
function section(t) { console.log('\n' + t + '\n'); }
/** Textul contine sirul? Se normalizeaza spatiile: pdfkit rupe randurile unde vrea el. */
function are(text, s) { return text.replace(/\s+/g, ' ').includes(String(s).replace(/\s+/g, ' ')); }

/** `res` fals: aduna octetii scrisi de pdfkit si expune promisiunea documentului terminat. */
function fakeRes() {
  const chunks = [];
  const w = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
  w.setHeader = (k, v) => { (w.headers = w.headers || {})[k] = v; };
  w.gata = new Promise((res, rej) => { w.on('finish', () => res(Buffer.concat(chunks))); w.on('error', rej); });
  return w;
}

// pdf2json scrie „Setting up fake worker" pe stdout la fiecare parsare (diagnostic intern pdf.js).
// Acelasi tipar ca in test/extractor.js: se reduce la tacere DOAR in jurul apelului, ca iesirea
// suitei sa ramana citibila. Erorile reale trec mai departe — nu se inghite nimic in afara zgomotului.
async function silent(fn) {
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true; process.stderr.write = () => true;
  try { return await fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
}

/** Randeaza un generator si intoarce { buf, text, headers }. Trece prin pdfkit SI prin extractor. */
async function randeaza(fn, ...args) {
  const res = fakeRes();
  fn(res, ...args);
  const buf = await res.gata;
  const text = await silent(() => ex.extractText(buf));
  return { buf, text, headers: res.headers || {} };
}

const FIRMA = { nume: 'S.C. PROBA CONTABO S.R.L.', cui: '12345678', adresa: 'Bucuresti' };

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  section('Contractul de randare: PDF real, citibil, cu antetul firmei');
  {
    const { buf, text, headers } = await randeaza(salarii.adeverintaPdf, FIRMA,
      { nume: 'Popescu Ion', cnp: '1900101410011', functie: 'Contabil', luni: 12, brut: 60000, cas: 15000, cass: 6000, impozit: 3900, net: 35100 }, 2026);
    eq('iesirea e un PDF', buf.slice(0, 5).toString(), '%PDF-');
    ok('...si chiar se poate CITI (nu doar are antetul magic)', text.length > 200);
    ok('antetul poarta numele firmei', are(text, 'S.C. PROBA CONTABO S.R.L.'));
    ok('...si CUI-ul ei', are(text, 'CUI 12345678'));
    eq('tipul de continut e anuntat corect', headers['Content-Type'], 'application/pdf');
    ok('numele fisierului ajunge in Content-Disposition', /adeverinta-venit.*\.pdf/.test(headers['Content-Disposition'] || ''));
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('LOGO-UL FIRMEI ajunge pe hartie (require rupt la split-ul monolitului)');
  {
    // `logoPath` a raspuns `null` 26 de zile pentru ORICE firma: mutata din `src/pdf.js` in
    // `src/pdf/helpers.js`, linia `require('./db')` a inceput sa arate spre `src/pdf/db`,
    // inexistent; `catch`-ul inghitea MODULE_NOT_FOUND. Proba e pe EFECT — fisier real pe disc.
    const db = require('../src/db');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(path.join(db.UPLOAD_DIR, 'logo-proba.png'), png);

    ok('logoPath gaseste un logo care EXISTA pe disc', helpers.logoPath({ logoFile: 'logo-proba.png' }) !== null);
    ok('...si e chiar calea din UPLOAD_DIR', helpers.logoPath({ logoFile: 'logo-proba.png' }) === path.join(db.UPLOAD_DIR, 'logo-proba.png'));
    ok('fara logo configurat -> null (nu eroare)', helpers.logoPath({}) === null);
    ok('logo inexistent pe disc -> null', helpers.logoPath({ logoFile: 'nu-exista.png' }) === null);
    // Gardurile care erau deja acolo, dar pe care nu le verifica nimeni fiindca functia
    // raspundea `null` din alt motiv: cat timp era rupta, treceau „din motivul gresit".
    ok('extensie neacceptata de pdfkit (.svg) -> null', helpers.logoPath({ logoFile: 'x.svg' }) === null);
    ok('traversare de cale -> null (numele e curatat, nu concatenat)', helpers.logoPath({ logoFile: '../../etc/passwd.png' }) === null);

    // Efectul final: documentul cu logo e MAI MARE decat acelasi document fara logo — singura
    // dovada ca imaginea chiar a fost incorporata, fiindca un logo nu produce text de extras.
    const arg = [{ nume: 'X', cnp: '', functie: '', luni: 1, brut: 100, cas: 25, cass: 10, impozit: 7, net: 58 }, 2026];
    const fara = await randeaza(salarii.adeverintaPdf, FIRMA, ...arg);
    const cu = await randeaza(salarii.adeverintaPdf, Object.assign({}, FIRMA, { logoFile: 'logo-proba.png' }), ...arg);
    ok('logo-ul chiar se incorporeaza in PDF (documentul creste)', cu.buf.length > fara.buf.length);
    ok('...si restul continutului ramane acelasi', are(cu.text, 'Venit net anual') && are(fara.text, 'Venit net anual'));
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('Salarizare: cifrele pe care le semneaza angajatul');
  {
    const sp = {
      rows: [
        { nume: 'Popescu Ion', cnp: '1900101410011', functie: 'Contabil', brut: 5000, cas: 1250, cass: 500, impozit: 325, net: 2925, cam: 112.5 },
        { nume: 'Ionescu Ana', cnp: '2900101410022', functie: 'Analist', brut: 7000, cas: 1750, cass: 700, impozit: 455, net: 4095, cam: 157.5 },
      ],
      totals: { brut: 12000, cas: 3000, cass: 1200, impozit: 780, net: 7020, cam: 270, totalBuget: 5250, costTotal: 12270 },
    };
    const { text } = await randeaza(salarii.statePlataPdf, FIRMA, sp, '2026-06');
    ok('statul de plata poarta titlul lui', are(text, 'Stat de plata'));
    ok('...si perioada', are(text, '2026'));
    ok('fiecare angajat apare cu numele', are(text, 'Popescu Ion') && are(text, 'Ionescu Ana'));
    ok('...si cu CNP-ul (documentul e nominal)', are(text, '1900101410011'));
    ok('brutul fiecaruia ajunge pe hartie', are(text, '5.000,00') && are(text, '7.000,00'));
    ok('netul fiecaruia ajunge pe hartie', are(text, '2.925,00') && are(text, '4.095,00'));
    ok('randul de TOTAL exista', are(text, 'TOTAL'));
    ok('...cu totalul de brut', are(text, '12.000,00'));
    // Linia care spune patronului cat scoate din buzunar: doua cifre distincte, usor de confundat.
    ok('totalul de virat la buget e scris explicit', are(text, 'Total de virat la buget') && are(text, '5.250,00'));
    ok('costul total angajator e scris explicit', are(text, 'Cost total angajator') && are(text, '12.270,00'));
    const draft = await randeaza(salarii.statePlataPdf, FIRMA, sp, '2026-06', { ciorna: true });
    ok('previzualizarea statului este marcata vizibil drept CIORNA si NEPOSTATA',
      are(draft.text, 'CIORNA') && are(draft.text, 'PREVIZUALIZARE NEPOSTATA'));
    ok('ciorna spune explicit ca nu se semneaza', are(draft.text, 'nu se semneaza'));
    const recap112 = await randeaza(declaratii.d112Pdf, FIRMA, {
      period: '2026-06', brut: 12000, cas: 3000, casAngajator: 100,
      cass: 1200, cassAngajator: 40, impozit: 780, cam: 270, net: 7020,
      totalBuget: 5390,
    });
    ok('recap D112 separa contributiile retinute de suplimentul suportat de angajator',
      are(recap112.text, 'CAS suplimentar suportat de angajator')
      && are(recap112.text, 'CASS suplimentar suportat de angajator'));
    ok('recap D112 foloseste totalul bugetar al fotografiei salariale', are(recap112.text, '5.390,00'));
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('Fluturasul: fiecare ramura conditionala chiar tipareste');
  {
    // Fluturasul e cel mai ramificat document din aplicatie: spor, concediu de odihna, concediu
    // medical (cu partea angajatorului si cea FNUASS), norma partiala, avantaje in natura,
    // beneficii art. 76 alin. (4^1), avans, retineri. Fiecare `if` e un rand care poate DISPAREA
    // fara ca nimic sa se rupa — si exact acolo se uita angajatul cand contesta.
    const bazic = { nume: 'Popescu Ion', cnp: '1900101410011', functie: 'Contabil', brut: 5000, cas: 1250, cass: 500, impozit: 325, net: 2925, restPlata: 2925, cam: 112.5, costTotal: 5112.5 };
    const b = await randeaza(salarii.fluturasPdf, FIRMA, bazic, '2026-06');
    ok('fluturasul simplu: titlu + angajat', are(b.text, 'Fluturas de salariu') && are(b.text, 'Popescu Ion'));
    // Identificarea angajatului: a LIPSIT de pe fluturas. `fluturasPdf` isi facea un document
    // propriu, scria acolo „Angajat:"/„CNP:", apoi delega la `recapPdf` — care isi face si isi
    // inchide documentul LUI. Cel dintai ramanea orfan, iar randurile dispareau tacut. Numele
    // parea prezent doar fiindca vine separat, prin `subtitle` — deci o proba pe nume trecea,
    // din motivul gresit. Se cer explicit randurile de identificare.
    ok('fluturasul poarta randul de identificare a angajatului', are(b.text, 'Angajat: Popescu Ion'));
    ok('...cu functia lui', are(b.text, '(Contabil)'));
    ok('...si cu CNP-ul', are(b.text, 'CNP: 1900101410011'));
    ok('...salariul brut', are(b.text, 'Salariu brut') && are(b.text, '5.000,00'));
    ok('...contributiile, cu procentele lor', are(b.text, 'CAS 25%') && are(b.text, 'CASS 10%') && are(b.text, 'Impozit pe venit 10%'));
    ok('...salariul net', are(b.text, 'Salariu net') && are(b.text, '2.925,00'));
    ok('...si REST DE PLATA (cifra pe care o asteapta in cont)', are(b.text, 'REST DE PLATA'));
    ok('...plus costul angajatorului', are(b.text, 'Cost total angajator') && are(b.text, '5.112,50'));
    const bDraft = await randeaza(salarii.fluturasPdf, FIRMA, bazic, '2026-06', { ciorna: true });
    ok('previzualizarea fluturasului nu poate fi confundata cu documentul pentru angajat',
      are(bDraft.text, 'CIORNA') && are(bDraft.text, 'nu se inmaneaza angajatului'));
    ok('fara spor, randul de spor NU apare', !are(b.text, '+ Spor'));
    ok('fara avans, randul de avans NU apare', !are(b.text, 'Avans acordat'));
    // Angajat fara CNP in fisa: randul dispare de tot, nu tipareste „CNP: undefined".
    const fnc = await randeaza(salarii.fluturasPdf, FIRMA, Object.assign({}, bazic, { cnp: '', functie: '' }), '2026-06');
    ok('fara CNP, randul de CNP lipseste (nu apare gol sau „undefined")', !are(fnc.text, 'CNP') && !are(fnc.text, 'undefined'));
    ok('...dar randul de angajat ramane', are(fnc.text, 'Angajat: Popescu Ion'));

    // Concediu medical: partea angajatorului si partea FNUASS. Daca a doua
    // dispare, angajatul nu are cum sa afle de ce a primit mai putin.
    const cm = await randeaza(salarii.fluturasPdf, FIRMA, Object.assign({}, bazic, {
      zileCM: 8, zilePlatiteCM: 7, zileNeplatiteCM: 1, zileCMAngajator: 4,
      mediaCM: 4200, mediaZilnicaCM: 200, procentCM: 75,
      cmAngajator: 600, cmFnuass: 450, salariuZileLucrate: 3000,
    }), '2026-06');
    ok('CM: indemnizatia ANGAJATORULUI apare, cu identificare, zile si procent',
      are(cm.text, 'Indemnizatie CM angajator (cod 01; 4 zile, 75%'));
    ok('CM: indemnizatia FNUASS apare separat, cu zilele si identificarea ei',
      are(cm.text, 'Indemnizatie CM FNUASS (3 zile; cod 01)'));
    ok('CM: sumele amandurora ajung pe hartie', are(cm.text, '600,00') && are(cm.text, '450,00'));
    ok('CM: ziua neplatita temporar este explicata', are(cm.text, 'Zi lucratoare neplatita'));
    ok('CM: salariul zilelor lucrate e distinct de brut', are(cm.text, 'Salariu aferent zilelor lucrate') && are(cm.text, '3.000,00'));

    // Concediu de odihna: media pe 3 luni e obligatorie pe document (se contesta pe ea).
    const co = await randeaza(salarii.fluturasPdf, FIRMA, Object.assign({}, bazic, {
      zileCO: 10, mediaCO: 240, indemnizatieCO: 2400, salariuZileLucrate: 2600,
    }), '2026-06');
    ok('CO: indemnizatia apare cu zilele SI cu media de 3 luni', are(co.text, 'Indemnizatie concediu de odihna (10 zile, media 3 luni 240,00)'));
    ok('CO: totalul brut impozabil e marcat separat', are(co.text, 'Total brut impozabil'));

    // Beneficii art. 76 alin. (4^1): fiecare pe randul lui, cu temeiul si limita — deliberat, ca
    // angajatul sa vada DE CE i s-a impozitat un abonament. Un total ar fi ilizibil.
    const ben = await randeaza(salarii.fluturasPdf, FIRMA, Object.assign({}, bazic, {
      beneficii: [
        { nume: 'Abonament sala', temei: 'art. 76 alin. (4^1) lit. h)', limitaIndividuala: 100, acordat: 150, impozabil: 50, pesteIndividual: 50, pestePlafon: 0 },
        { nume: 'Tichete culturale', temei: 'art. 76 alin. (4^1) lit. g)', limitaIndividuala: null, acordat: 200, impozabil: 0, pesteIndividual: 0, pestePlafon: 0 },
      ],
      beneficiiAcordate: 350, beneficiiPlafon: 1650, beneficiiNeimpozabile: 300, beneficiiRamas: 1300, beneficiiImpozabile: 50,
    }), '2026-06');
    ok('beneficii: fiecare apare pe randul lui, cu temeiul legal', are(ben.text, 'Abonament sala (art. 76 alin. (4^1) lit. h)'));
    ok('...cu limita proprie cand are una', are(ben.text, 'limita 100,00'));
    ok('...si cu „fara limita proprie" cand nu are', are(ben.text, 'fara limita proprie'));
    ok('beneficii: partea impozabila isi spune CAUZA', are(ben.text, 'din care IMPOZABIL') && are(ben.text, 'peste limita proprie'));
    ok('beneficii: plafonul de 33% e scris cu toate cifrele lui', are(ben.text, 'Plafon 33% din salariul de baza') && are(ben.text, '1.650,00'));

    // Retinerile: avans si popriri. Sunt scaderi din rest de plata — daca nu se tiparesc,
    // angajatul vede un rest de plata mai mic fara nicio explicatie.
    const ret = await randeaza(salarii.fluturasPdf, FIRMA, Object.assign({}, bazic, {
      spor: 500, avans: 1000, retineri: 300, restPlata: 1625, neimpozabil: 200,
    }), '2026-06');
    ok('sporul isi separa baza de el insusi', are(ret.text, 'Salariu de baza') && are(ret.text, '+ Spor') && are(ret.text, '500,00'));
    ok('avansul apare ca scadere', are(ret.text, 'Avans acordat') && are(ret.text, '1.000,00'));
    ok('popririle apar ca scadere', are(ret.text, 'Retineri (popriri / terti)') && are(ret.text, '300,00'));
    ok('partea neimpozabila apare', are(ret.text, 'din care neimpozabil') && are(ret.text, '200,00'));
    ok('restul de plata e cel dupa retineri', are(ret.text, '1.625,00'));

    // Norma partiala: CAS+CASS pana la salariul minim sunt suportate de ANGAJATOR — o regula pe
    // care angajatul o vede doar daca randul se tipareste.
    const np = await randeaza(salarii.fluturasPdf, FIRMA, Object.assign({}, bazic, {
      normaPartiala: true, casAngajator: 400, cassAngajator: 160,
    }), '2026-06');
    ok('norma partiala: randul explica cine suporta contributiile', are(np.text, 'Norma partiala') && are(np.text, 'suportate de ANGAJATOR'));
    ok('...cu suma insumata corect (CAS + CASS angajator)', are(np.text, '560,00'));

    // Diacriticele: fonturile standard pdfkit nu le au, deci `clean` le transliterza. Ce NU e
    // tradus cade in filtrul final de Latin-1 imprimabil si DISPARE — un nume ciuntit pe un act
    // nominal, tacut. Numele de proba le poarta pe TOATE, in ambele cazuri: un „Gheorghita
    // Stefanescu" oarecare nu contine niciun `ș` mic, deci scoaterea acelei reguli ar fi trecut
    // neobservata (masurat: exact asa a scapat prima versiune a acestei probe).
    const dia = await randeaza(salarii.fluturasPdf, FIRMA, Object.assign({}, bazic, {
      nume: 'ăâîșț ĂÂÎȘȚ Mureșan', functie: 'Șef încasări',
    }), '2026-06');
    ok('toate diacriticele romanesti se transliterza, mici si mari', are(dia.text, 'aaist AAIST Muresan'));
    ok('...si in celelalte campuri, nu doar in nume', are(dia.text, '(Sef incasari)'));
    ok('nimic nu se pierde pe drum (numele ramane intreg, nu ciuntit)',
      !/[ăâîșțĂÂÎȘȚ]/.test(dia.text) && are(dia.text, 'Muresan'));
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('Registrul de salarii si adeverinta de venit');
  {
    const rs = {
      year: 2026, nrLuni: 12,
      angajati: [{ nume: 'Popescu Ion', cnp: '1900101410011', luni: 12, brut: 60000, cas: 15000, cass: 6000, impozit: 3900, net: 35100 }],
      totals: { brut: 60000, cas: 15000, cass: 6000, impozit: 3900, net: 35100 },
    };
    const r = await randeaza(salarii.registruSalariiPdf, FIRMA, rs);
    ok('registrul poarta anul si numarul de luni', are(r.text, 'Exercitiul 2026') && are(r.text, '12 luni inregistrate'));
    ok('angajatul apare cu brutul anual', are(r.text, 'Popescu Ion') && are(r.text, '60.000,00'));
    ok('...si cu netul anual', are(r.text, '35.100,00'));

    // Starea GOALA: fara nicio luna inregistrata, documentul trebuie sa SPUNA asta si sa indice
    // ce are de facut omul. Un tabel gol, fara explicatie, arata ca o defectiune.
    const gol = await randeaza(salarii.registruSalariiPdf, FIRMA, { year: 2026, nrLuni: 0, angajati: [], totals: { brut: 0, cas: 0, cass: 0, impozit: 0, net: 0 } });
    ok('registrul gol explica de ce e gol', are(gol.text, 'Nicio luna inregistrata pentru acest an'));
    ok('...si spune unde se rezolva', are(gol.text, 'tab-ul Salarizare'));

    const ad = await randeaza(salarii.adeverintaPdf, FIRMA,
      { nume: 'Popescu Ion', cnp: '1900101410011', functie: 'Contabil', luni: 12, brut: 60000, cas: 15000, cass: 6000, impozit: 3900, net: 35100 }, 2026);
    ok('adeverinta e formulata ca act (se depune la banca)', are(ad.text, 'Se adevereste prin prezenta'));
    ok('...il numeste pe angajat, cu CNP si functie', are(ad.text, 'Popescu Ion, CNP 1900101410011, avand functia de Contabil'));
    ok('...il leaga de firma emitenta, cu CUI', are(ad.text, 'salariat al S.C. PROBA CONTABO S.R.L. (CUI 12345678)'));
    ok('...si poarta anul', are(ad.text, 'in anul 2026'));
    ok('venitul brut si cel net anual sunt amandoua pe act', are(ad.text, '60.000,00') && are(ad.text, '35.100,00'));
    ok('...cu locuri de semnatura pentru administrator si contabil', are(ad.text, 'Administrator') && are(ad.text, 'Intocmit (contabil)'));
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('Documente de gestiune: NIR, bon de consum, aviz');
  {
    const linii = [
      { cod: 'P001', denumire: 'Ciment 42.5R', um: 'sac', cantitate: 100, pret: 25, cmp: 25, valoare: 2500 },
      { cod: 'P002', denumire: 'Nisip spalat', um: 'to', cantitate: 10, pret: 80, cmp: 80, valoare: 800 },
    ];
    const nir = await randeaza(stocuri.nirPdf, FIRMA, {
      serieNr: 'NIR-000123', document: 'FF 4455', furnizor: 'S.C. MATERIALE S.R.L.', gestiune: 'DEPOZIT CENTRAL',
      data: '2026-06-15', operator: 'Popescu Ion', lines: linii, total: 3300,
    });
    ok('NIR: titlul legal complet', are(nir.text, 'Nota de intrare-receptie') && are(nir.text, 'si constatare de diferente'));
    ok('NIR: seria si numarul (documentul e in registru de serii)', are(nir.text, 'NIR-000123'));
    ok('NIR: documentul-sursa si furnizorul', are(nir.text, 'FF 4455') && are(nir.text, 'S.C. MATERIALE S.R.L.'));
    ok('NIR: gestiunea si data receptiei', are(nir.text, 'DEPOZIT CENTRAL') && are(nir.text, '15.06.2026'));
    ok('NIR: fiecare produs, cu cantitate si pret', are(nir.text, 'Ciment 42.5R') && are(nir.text, '100,00') && are(nir.text, '25,00'));
    ok('NIR: valorile pe linie', are(nir.text, '2.500,00') && are(nir.text, '800,00'));
    ok('NIR: TOTALUL, care trebuie sa fie suma liniilor', are(nir.text, 'TOTAL') && are(nir.text, '3.300,00'));
    ok('NIR: locurile de semnatura (comisie + gestionar)', are(nir.text, 'Comisia de receptie') && are(nir.text, 'Gestionar'));

    const bon = await randeaza(stocuri.bonConsumPdf, FIRMA, {
      serieNr: 'BC-000045', document: 'Consum santier A', gestiune: 'DEPOZIT CENTRAL',
      data: '2026-06-20', operator: 'Ionescu Ana', lines: linii, total: 3300,
    });
    ok('bon de consum: titlu si serie', are(bon.text, 'Bon de consum') && are(bon.text, 'BC-000045'));
    ok('bon: pretul e CMP-ul, nu pretul de achizitie (coloana isi spune numele)', are(bon.text, 'Pret (CMP)'));
    ok('bon: totalul iesirii', are(bon.text, '3.300,00'));
    ok('bon: cele trei semnaturi (predat/primit/aprobat)', are(bon.text, 'Predat (gestionar)') && are(bon.text, 'Primit') && are(bon.text, 'Aprobat'));

    const aviz = await randeaza(stocuri.avizPdf, FIRMA, {
      serieNr: 'AVIZ-000007', document: 'Transfer', expeditor: '', destinatar: 'S.C. CLIENT S.R.L.',
      data: '2026-06-22', operator: 'Ionescu Ana', lines: linii, total: 3300,
    });
    ok('aviz: titlul legal', are(aviz.text, 'Aviz de insotire a marfii'));
    ok('aviz: fara expeditor dat, cade pe numele firmei (nu ramane gol)', are(aviz.text, 'Expeditor: S.C. PROBA CONTABO S.R.L.'));
    ok('aviz: destinatarul', are(aviz.text, 'Destinatar: S.C. CLIENT S.R.L.'));
    ok('aviz: delegatul si mijlocul de transport au loc pe document', are(aviz.text, 'Delegat (mijloc transport)'));
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('Stocuri: situatie, fisa de magazie, inventariere');
  {
    const st = await randeaza(stocuri.stocksPdf, FIRMA, [
      { product: { cod: 'P001', denumire: 'Ciment 42.5R', um: 'sac', cont: '371' }, gestiune: { cod: 'DEP' }, stocQ: 40, cmp: 25, stocV: 1000 },
      { product: { cod: 'P002', denumire: 'Nisip spalat', um: 'to' }, gestiune: { cod: 'DEP' }, stocQ: 5, cmp: 80, stocV: 400 },
    ], '2026-06-30');
    ok('situatia stocurilor: titlu si data', are(st.text, 'Situatia stocurilor') && are(st.text, '2026-06-30'));
    ok('...produsele cu cantitatile si CMP-ul', are(st.text, 'Ciment 42.5R') && are(st.text, '40,00') && are(st.text, '25,00'));
    ok('...contul implicit 371 cand produsul nu are unul propriu', are(st.text, '371'));
    ok('...si TOTALUL de valoare (suma coloanei, nu prima linie)', are(st.text, 'TOTAL VALOARE STOC') && are(st.text, '1.400,00'));

    const fm = await randeaza(stocuri.stockLedgerPdf, FIRMA, {
      product: { cod: 'P001', denumire: 'Ciment 42.5R', um: 'sac' },
      rows: [
        { data: '2026-06-15', tip: 'intrare', document: 'NIR-123', intrareQ: 100, intrareV: 2500, stocQ: 100, cmp: 25, stocV: 2500 },
        { data: '2026-06-20', tip: 'iesire', document: 'BC-45', iesireQ: 60, iesireV: 1500, stocQ: 40, cmp: 25, stocV: 1000 },
      ],
      stocQ: 40, cmp: 25, stocV: 1000,
    });
    ok('fisa de magazie: produsul in subtitlu, cu UM', are(fm.text, 'P001 - Ciment 42.5R (sac)'));
    ok('...intrarea, cu documentul ei', are(fm.text, 'NIR-123') && are(fm.text, '2.500,00'));
    ok('...iesirea, cu documentul ei', are(fm.text, 'BC-45') && are(fm.text, '1.500,00'));
    ok('...si STOCUL FINAL, randul pentru care exista fisa', are(fm.text, 'STOC FINAL') && are(fm.text, '1.000,00'));

    const li = await randeaza(stocuri.inventoryListPdf, FIRMA, {
      gestiune: 'DEPOZIT CENTRAL', asOf: '2026-06-30',
      lines: [{ product: { cod: 'P001', denumire: 'Ciment 42.5R', um: 'sac' }, scripticQty: 40, cmp: 25, scripticVal: 1000 }],
    });
    ok('lista de inventariere: titlu, gestiune, data', are(li.text, 'Lista de inventariere') && are(li.text, 'DEPOZIT CENTRAL'));
    ok('...scripticul e completat, iar FAPTICUL ramane gol (se scrie de mana)', are(li.text, 'Stoc faptic') && are(li.text, 'Diferenta'));
    ok('...cu totalul scriptic', are(li.text, 'TOTAL VALOARE SCRIPTICA') && are(li.text, '1.000,00'));
    ok('...si locurile comisiei si gestionarului', are(li.text, 'Comisia de inventariere') && are(li.text, 'Gestionar'));

    // Procesul-verbal: plusuri, lipsuri, imputare — fiecare cu monografia lui SCRISA pe document,
    // fiindca acolo se uita controlul.
    const pv = await randeaza(stocuri.inventoryPvPdf, FIRMA, {
      id: 'inv1', gestiuneCod: 'DEP', gestiuneDen: 'DEPOZIT CENTRAL', data: '2026-06-30',
      operator: 'Popescu Ion', gestionar: 'Ionescu Ana',
      lines: [
        { cod: 'P001', denumire: 'Ciment', um: 'sac', scriptic: 40, faptic: 42, diff: 2, cmp: 25, valoare: 50, tip: 'plus' },
        { cod: 'P002', denumire: 'Nisip', um: 'to', scriptic: 5, faptic: 4, diff: -1, cmp: 80, valoare: 80, tip: 'minus', imputat: true },
        { cod: 'P003', denumire: 'Var', um: 'sac', scriptic: 10, faptic: 10, diff: 0, cmp: 12, valoare: 0, tip: 'ok' },
      ],
      totalPlus: 50, totalMinus: 80, totalImputat: 95.2,
    });
    ok('PV: titlu, gestiune, data', are(pv.text, 'Proces-verbal de inventariere') && are(pv.text, 'DEP DEPOZIT CENTRAL'));
    ok('PV: plusul poarta semnul + si monografia lui', are(pv.text, '+2,00') && are(pv.text, 'plus (371=758)'));
    ok('PV: lipsa IMPUTATA se distinge de lipsa simpla', are(pv.text, 'lipsa imputata'));
    ok('PV: linia fara diferenta e marcata OK, fara valoare', are(pv.text, 'OK'));
    ok('PV: totalurile pe cele trei categorii', are(pv.text, 'Total plusuri de inventar (371 = 758)') && are(pv.text, '50,00'));
    ok('PV: imputarea poarta monografia cu TVA (4282 = 7588 + 4427)', are(pv.text, '4282 = 7588 + 4427') && are(pv.text, '95,20'));
    ok('PV: operatorul si gestionarul sunt numiti', are(pv.text, 'Popescu Ion') && are(pv.text, 'Ionescu Ana'));

    // STORNAT: un PV anulat care nu-si spune starea e o capcana de control — arata ca unul valid.
    const pvS = await randeaza(stocuri.inventoryPvPdf, FIRMA, {
      id: 'inv2', gestiuneCod: 'DEP', gestiuneDen: 'DEPOZIT', data: '2026-06-30', status: 'stornat',
      stornoData: '2026-07-02', stornoOperator: 'Popescu Ion',
      lines: [], totalPlus: 0, totalMinus: 0, totalImputat: 0,
    });
    ok('PV stornat: marcajul STORNAT e pe document', are(pvS.text, 'STORNAT la 2026-07-02'));
    ok('...cu cine l-a stornat', are(pvS.text, 'de Popescu Ion'));
    ok('PV nestornat NU poarta marcajul', !are(pv.text, 'STORNAT'));
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('helpers.table: cursorul se intoarce la marginea stanga');
  {
    // `table` scrie ultima celula cu `doc.text(txt, x + 4, ...)`, iar pdfkit RETINE acel x. Fara
    // resetare, orice titlu sau nota de dupa un tabel pornea din dreapta paginii si se rupea —
    // se vedea pe fiecare document cu doua tabele (jurnalele de TVA, recapitulatia D394).
    // Proba e pe contractul helperului, cu document pdfkit REAL: textul extras nu poarta pozitii,
    // deci o aserttiune pe continut ar fi trecut si cu defectul in loc.
    const doc = helpers.newDoc(false);
    const stanga = doc.page.margins.left;
    doc.text('ceva in dreapta', 400, 100);
    ok('pdfkit chiar retine x-ul ultimei scrieri (proba discrimineaza)', doc.x > stanga + 100);
    helpers.table(doc, [{ label: 'A', key: 'a', width: 100 }, { label: 'B', key: 'b', width: 100, align: 'right' }],
      [{ a: 'x', b: 'y' }]);
    eq('dupa tabel, cursorul e din nou la marginea stanga', doc.x, stanga);
    doc.end();
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('D394 si SAF-T: recapitulatiile pe care omul le citeste inainte de depunere');
  {
    // Agregarea e ACEEASI din care se compune XML-ul (`xml.d394Operatiuni`) — deci proba
    // dovedeste si ca PDF-ul nu are un al doilea motor: se randeaza exact ce pleaca la ANAF.
    const vj = {
      vanzari: [
        { data: '2026-06-10', document: 'F 1', partener: 'ALFA SRL', cui: 'RO111', cota: 21, baza: 1000, tva: 210 },
        { data: '2026-06-12', document: 'F 2', partener: 'ALFA SRL', cui: 'RO111', cota: 21, baza: 500, tva: 105 },
        { data: '2026-06-14', document: 'F 3', partener: 'BETA SRL', cui: 'RO222', cota: 11, baza: 200, tva: 22 },
      ],
      cumparari: [
        { data: '2026-06-05', document: 'FF 9', partener: 'GAMA SRL', cui: 'RO333', cota: 21, baza: 800, tva: 168 },
        { data: '2026-06-06', document: 'FF 10', partener: 'STRAIN GMBH', cui: 'DE9', cota: 21, baza: 400, tva: 84, inD394: false },
      ],
      scutite: [],
    };
    const ops = xmlMod.d394Operatiuni(vj, null);
    // Doua facturi catre acelasi partener, aceeasi cota -> UN rand cu 2 facturi (asa cere D394).
    const alfa = ops.find((o) => o.cui === '111');
    eq('agregarea uneste facturile aceluiasi partener si cote', alfa.nr, 2);
    eq('...si insumeaza baza', alfa.baza, 1500);
    ok('achizitia intracomunitara NU intra in D394', !ops.some((o) => o.cui === '9' || o.cui === 'DE9'));

    const d394 = await randeaza(declaratii.d394Pdf, FIRMA, { period: '2026-06', ops });
    ok('antetul spune ce declaratie e', are(d394.text, 'D394'));
    ok('perioada apare in clar', are(d394.text, 'iunie 2026'));
    ok('sectiunea de livrari e numita, nu doar codificata', are(d394.text, 'Livrari taxabile'));
    ok('sectiunea de achizitii la fel', are(d394.text, 'Achizitii taxabile'));
    ok('partenerul apare pe hartie', are(d394.text, 'ALFA SRL'));
    ok('...cu CUI-ul fara prefixul RO, ca in declaratie', are(d394.text, '111'));
    ok('cele doua facturi agregate se vad ca numar', are(d394.text, '1.500,00'));
    ok('TVA-ul partenerului apare', are(d394.text, '315,00'));
    ok('achizitia apare separat de livrare', are(d394.text, 'GAMA SRL'));
    ok('partenerul intracomunitar NU apare (merge in D390)', !are(d394.text, 'STRAIN GMBH'));
    ok('exista bloc de control cu parteneri distincti', are(d394.text, 'Parteneri distincti'));
    ok('...si cu baza totala', are(d394.text, 'Baza totala'));
    ok('nota avertizeaza despre rotunjirea la lei intregi', are(d394.text, 'LEI INTREGI'));
    ok('...si trimite la validatorul oficial', are(d394.text, 'DUKIntegrator'));
    eq('numele fisierului e explicit', d394.headers['Content-Disposition'].includes('recap-d394.pdf'), true);

    // Starea GOALA e un caz real: o luna fara operatiuni B2B trebuie sa spuna asta, nu sa iasa
    // o pagina alba din care nu intelegi daca s-a generat sau nu.
    const gol = await randeaza(declaratii.d394Pdf, FIRMA, { period: '2026-07', ops: [] });
    ok('luna fara operatiuni B2B o spune explicit', are(gol.text, 'Nicio operatiune B2B'));

    const saft = await randeaza(declaratii.saftPdf, FIRMA, {
      year: '2026', accounts: 42, entries: 318, totalDebit: 987654.32, customers: 7, suppliers: 9,
      salesInvoices: 120, purchaseInvoices: 98, payments: 60, assets: 4, products: 31, stockMovements: 55,
    });
    ok('recapitulatia SAF-T numeste declaratia', are(saft.text, 'D406'));
    ok('exercitiul apare', are(saft.text, '2026'));
    ok('numarul de articole contabile e pe hartie', are(saft.text, '318'));
    ok('numarul de conturi la fel', are(saft.text, '42'));
    ok('totalul de control apare formatat romaneste', are(saft.text, '987.654,32'));
    ok('nota explica la ce foloseste si la ce NU', are(saft.text, 'nu a formei'));
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' verificari PDF trecute, ' + fail + ' esuate.');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temporar */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('EROARE in suita PDF:', e); process.exit(1); });
