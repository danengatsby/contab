'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  TEMEIUL LEGAL AL FIECARUI PAS DIN CICLUL CONTABIL
//
//  SURSA UNICA. Aceleasi trimiteri apar in cockpitul de inchidere lunara, in tabul de inchidere a
//  anului, in ghid si in documentatie — scrise separat, ar drifta si ar ajunge sa spuna lucruri
//  diferite despre acelasi pas. Aici sunt o data, structurate, si se citesc de acolo.
//
//  Structura raspunde la trei intrebari, in ordinea in care si le pune contabilul:
//    CE fac (pasul), DE CE sunt obligat (actul + articolul), CE anume spune (rezumatul).
//
//  DOUA REGULI de redactare, ca sa ramana de incredere:
//  1. `articol` se scrie cat de precis se poate SUSTINE, nu cat de precis ar suna bine. Unde
//     alineatul e sigur, apare; unde nu, ramane doar articolul. O trimitere falsa la un alineat e
//     mai rea decat lipsa lui: cine o verifica pierde increderea in tot tabelul.
//  2. Aici NU stau termene si NU stau cote. Termenele se deriva din `declarations.dueDate` (o
//     singura sursa, fiindca `nr_evid` le codifica), iar cotele din `fiscalConfig`. Un „25 ale
//     lunii" copiat aici ar deveni a doua sursa de adevar si s-ar invechi tacut.
//
//  Trimiterile sunt reper de ORIENTARE, nu consultanta: legea se modifica, iar raspunderea pentru
//  aplicarea ei ramane a contabilului (Legea 82/1991 art. 10-11).
// ─────────────────────────────────────────────────────────────────────────────

/** Actele la care se face trimitere. `cod` e cheia folosita in `CICLU`. */
const ACTE = {
  L82: { cod: 'L82', titlu: 'Legea contabilității nr. 82/1991', scurt: 'Legea 82/1991' },
  CF: { cod: 'CF', titlu: 'Codul fiscal (Legea nr. 227/2015)', scurt: 'Cod fiscal' },
  CPF: { cod: 'CPF', titlu: 'Codul de procedură fiscală (Legea nr. 207/2015)', scurt: 'Cod proc. fiscală' },
  O1802: { cod: 'O1802', titlu: 'OMFP nr. 1802/2014 — reglementările contabile privind situațiile financiare anuale', scurt: 'OMFP 1802/2014' },
  O2634: { cod: 'O2634', titlu: 'OMFP nr. 2634/2015 — documentele financiar-contabile', scurt: 'OMFP 2634/2015' },
  O2861: { cod: 'O2861', titlu: 'OMFP nr. 2861/2009 — normele privind organizarea și efectuarea inventarierii', scurt: 'OMFP 2861/2009' },
  L31: { cod: 'L31', titlu: 'Legea societăților nr. 31/1990', scurt: 'Legea 31/1990' },
  L70: { cod: 'L70', titlu: 'Legea nr. 70/2015 — disciplina plăților în numerar', scurt: 'Legea 70/2015' },
  OUG120: { cod: 'OUG120', titlu: 'OUG nr. 120/2021 — sistemul național RO e-Factura', scurt: 'OUG 120/2021' },
};

const t = (act, articol, ce) => ({ act, articol, ce });

/**
 * Ciclul contabil, in ordinea in care se executa. `faza` grupeaza pasii:
 *   permanent  — la fiecare operatiune, tot anul;
 *   lunar      — inchiderea lunii (cheile coincid cu `monthlyClose.STEPS`);
 *   trimestrial;
 *   anual      — inchiderea exercitiului.
 */
const CICLU = [
  // ── PERMANENT ──────────────────────────────────────────────────────────────
  {
    key: 'document', faza: 'permanent', nume: 'Documentul justificativ',
    descriere: 'Orice operațiune se consemnează, în momentul efectuării ei, într-un document care stă la baza înregistrării în contabilitate.',
    temei: [
      t('L82', 'art. 6 alin. (1)', 'Orice operațiune economico-financiară efectuată se consemnează în momentul efectuării ei într-un document care stă la baza înregistrărilor în contabilitate, dobândind astfel calitatea de document justificativ.'),
      t('L82', 'art. 6 alin. (2)', 'Documentele justificative angajează răspunderea persoanelor care le-au întocmit, vizat, aprobat și înregistrat.'),
      t('O2634', 'normele generale', 'Conținutul minimal obligatoriu al documentelor financiar-contabile; în documente nu sunt admise ștersături sau alte asemenea procedee — de aceea corecția se face prin stornare, nu prin modificare.'),
    ],
  },
  {
    key: 'inregistrare', faza: 'permanent', nume: 'Înregistrarea în partidă dublă',
    descriere: 'Fiecare document devine articol contabil (debit = credit), cronologic și sistematic.',
    temei: [
      t('L82', 'art. 5 alin. (1)', 'Obligația de a conduce contabilitatea în partidă dublă și de a întocmi situații financiare anuale.'),
      t('O1802', 'reglementările contabile', 'Planul de conturi general și regulile de înregistrare a operațiunilor.'),
    ],
  },
  {
    key: 'facturare', faza: 'permanent', nume: 'Facturarea și e-Factura',
    descriere: 'Emiterea facturii și transmiterea ei prin sistemul național RO e-Factura.',
    temei: [
      t('CF', 'art. 319', 'Obligația de facturare și elementele obligatorii ale facturii.'),
      t('OUG120', '—', 'Transmiterea facturilor în sistemul RO e-Factura și termenul de transmitere.'),
    ],
  },
  {
    key: 'numerar', faza: 'permanent', nume: 'Disciplina plăților în numerar',
    descriere: 'Plafoanele zilnice de încasări și plăți în numerar, pe partener și pe zi.',
    temei: [t('L70', 'art. 3–5', 'Plafoanele de încasări/plăți în numerar între persoane juridice și față de persoane fizice.')],
  },

  // ── LUNAR (cheile coincid cu pasii cockpitului de inchidere) ────────────────
  {
    key: 'documente', faza: 'lunar', nume: 'Documente complete',
    descriere: 'Toate documentele lunii sunt înregistrate și postate.',
    temei: [t('L82', 'art. 6 alin. (1)', 'Consemnarea operațiunii în momentul efectuării ei — o lună închisă cu documente lipsă contrazice chiar înregistrarea în contabilitate.')],
  },
  {
    key: 'banca', faza: 'lunar', nume: 'Extras bancar și punctaj',
    descriere: 'Încasările și plățile lunii sunt înregistrate și punctate cu facturile.',
    temei: [
      t('O2634', 'extrasul de cont', 'Extrasul de cont e document justificativ pentru operațiunile de trezorerie.'),
      t('L82', 'art. 22', 'Verificarea înregistrării corecte în contabilitate a operațiunilor efectuate.'),
    ],
  },
  {
    key: 'tva', faza: 'lunar', nume: 'Regularizarea TVA',
    descriere: 'TVA colectată și deductibilă se regularizează; rezultă taxa de plată sau de recuperat.',
    temei: [
      t('CF', 'art. 322', 'Perioada fiscală pentru TVA (luna sau trimestrul).'),
      t('CF', 'art. 323', 'Decontul de taxă pe valoarea adăugată și obligația depunerii lui.'),
    ],
  },
  {
    key: 'declaratii', faza: 'lunar', nume: 'Declarații validate și depuse',
    descriere: 'Fiecare declarație așteptată e validată fără erori și marcată depusă.',
    temei: [
      t('CF', 'art. 323', 'Decontul de TVA (D300).'),
      t('CF', 'art. 324', 'Declarația recapitulativă privind operațiunile intracomunitare (D390).'),
      t('CF', 'art. 147', 'Declarația privind obligațiile de plată a contribuțiilor sociale, impozitului pe venit și evidența nominală (D112).'),
      t('CPF', 'art. 101', 'Obligația de a depune declarații fiscale la termenele prevăzute de lege.'),
    ],
  },
  {
    key: 'aprobare', faza: 'lunar', nume: 'Aprobarea lunii',
    descriere: 'Cineva își asumă explicit că luna e corectă și poate fi raportată.',
    temei: [
      t('L82', 'art. 10', 'Răspunderea pentru organizarea și conducerea contabilității revine administratorului.'),
      t('L82', 'art. 11', 'Contabilitatea se conduce de persoane cu studii de specialitate sau de persoane autorizate.'),
    ],
  },
  {
    key: 'blocare', faza: 'lunar', nume: 'Blocarea perioadei',
    descriere: 'Luna devine read-only; corecțiile ulterioare se fac prin stornare într-o lună deschisă.',
    temei: [
      t('O2634', 'normele generale', 'În documentele financiar-contabile nu sunt admise ștersături sau modificări — corecția se face printr-o înregistrare nouă, nu prin rescrierea celei vechi.'),
      t('CPF', 'art. 105', 'Corectarea declarațiilor fiscale deja depuse se face prin declarație rectificativă.'),
    ],
  },

  // ── TRIMESTRIAL ────────────────────────────────────────────────────────────
  {
    key: 'trimestrial', faza: 'trimestrial', nume: 'Impozitul trimestrial',
    descriere: 'Declararea și plata impozitului pe profit sau pe veniturile microîntreprinderilor (D100).',
    temei: [
      t('CF', 'art. 41', 'Declararea și plata impozitului pe profit, trimestrial; sistemul anual cu plăți anticipate.'),
      t('CF', 'art. 56', 'Calculul, declararea și plata impozitului pe veniturile microîntreprinderilor, trimestrial.'),
    ],
  },

  // ── ANUAL (inchiderea exercitiului, in ordinea de executie) ─────────────────
  {
    key: 'inventariere', faza: 'anual', nume: 'Inventarierea generală',
    descriere: 'Inventarierea elementelor de natura activelor, datoriilor și capitalurilor proprii.',
    temei: [
      t('L82', 'art. 7 alin. (1)', 'Inventarierea generală se efectuează cel puțin o dată în cursul exercițiului financiar.'),
      t('O2861', 'normele de inventariere', 'Organizarea și efectuarea inventarierii; documentele care o consemnează.'),
    ],
  },
  {
    key: 'evaluare', faza: 'anual', nume: 'Evaluarea la inventar și ajustările',
    descriere: 'Elementele se evaluează la valoarea de inventar; minusul de valoare devine ajustare pentru depreciere.',
    temei: [
      t('L82', 'art. 8', 'Evaluarea elementelor la inventariere și înregistrarea rezultatelor inventarierii în contabilitate.'),
      t('O1802', 'reglementările contabile', 'Ajustările pentru depreciere: reversibile, lasă valoarea de intrare neatinsă.'),
      t('CF', 'art. 26', 'Provizioanele și ajustările deductibile — enumerare limitativă; restul sunt nedeductibile.'),
    ],
  },
  {
    key: 'amortizare', faza: 'anual', nume: 'Amortizarea',
    descriere: 'Recuperarea valorii imobilizărilor, contabil și fiscal.',
    temei: [
      t('O1802', 'reglementările contabile', 'Amortizarea contabilă, pe durata de utilizare economică.'),
      t('CF', 'art. 28', 'Amortizarea fiscală: activele amortizabile, regimurile permise pe clasă de activ, investițiile ulterioare.'),
    ],
  },
  {
    key: 'balanta', faza: 'anual', nume: 'Balanța de verificare',
    descriere: 'Verificarea înregistrării corecte a operațiunilor, cu cele patru egalități.',
    temei: [t('L82', 'art. 22', 'Balanța de verificare se întocmește pentru verificarea înregistrării corecte în contabilitate a operațiunilor efectuate.')],
  },
  {
    key: 'impozit', faza: 'anual', nume: 'Impozitul pe profit anual',
    descriere: 'Rezultatul fiscal, ajustările și impozitul anual (D101).',
    temei: [
      t('CF', 'art. 19', 'Reguli generale de stabilire a rezultatului fiscal.'),
      t('CF', 'art. 25', 'Cheltuieli deductibile, cu deductibilitate limitată și nedeductibile.'),
      t('CF', 'art. 31', 'Recuperarea pierderii fiscale din anii precedenți.'),
      t('CF', 'art. 42', 'Declarația anuală de impozit pe profit.'),
    ],
  },
  {
    key: 'inchidere', faza: 'anual', nume: 'Închiderea conturilor de venituri și cheltuieli',
    descriere: 'Clasele 6 și 7 se închid în contul 121, rezultând rezultatul exercițiului.',
    temei: [t('O1802', 'reglementările contabile', 'Determinarea rezultatului exercițiului financiar prin închiderea conturilor de venituri și cheltuieli.')],
  },
  {
    key: 'situatii', faza: 'anual', nume: 'Situațiile financiare anuale',
    descriere: 'Bilanțul și contul de profit și pierdere, pe categoria de entitate.',
    temei: [
      t('L82', 'art. 28', 'Obligația întocmirii situațiilor financiare anuale.'),
      t('O1802', 'reglementările contabile', 'Formatul situațiilor financiare pe categorii de entități (micro, mici, mijlocii și mari).'),
    ],
  },
  {
    key: 'repartizare', faza: 'anual', nume: 'Repartizarea rezultatului',
    descriere: 'Rezerva legală, acoperirea pierderii și repartizarea profitului, după aprobarea situațiilor.',
    temei: [
      // Fara procent si fara plafon in text: cotele stau in `fiscalConfig` (datate), iar o cifra
      // copiata aici ar deveni a doua sursa de adevar. Poarta din suita chiar a prins-o.
      t('L31', 'art. 183', 'Constituirea fondului de rezervă din profitul societății, până la limita raportată la capitalul social prevăzută de lege.'),
      t('CF', 'art. 26', 'Regimul fiscal al rezervei legale.'),
      t('O1802', 'reglementările contabile', 'Transferul rezultatului exercițiului la rezultatul reportat.'),
    ],
  },
  {
    key: 'depunere', faza: 'anual', nume: 'Depunerea situațiilor financiare',
    descriere: 'Depunerea la unitățile teritoriale ale Ministerului Finanțelor.',
    temei: [t('L82', 'art. 36', 'Termenele și modul de depunere a situațiilor financiare anuale.')],
  },
  {
    key: 'saft', faza: 'anual', nume: 'Fișierul standard de control fiscal (SAF-T / D406)',
    descriere: 'Declarația informativă cu datele contabile în format standardizat.',
    temei: [t('CPF', 'art. 59^1', 'Obligația de a transmite fișierul standard de control fiscal (SAF-T).')],
  },
  {
    key: 'registre', faza: 'anual', nume: 'Registrele obligatorii',
    descriere: 'Registrul-jurnal, Registrul-inventar și Cartea mare.',
    temei: [
      t('L82', 'art. 20', 'Registrele de contabilitate obligatorii: Registrul-jurnal, Registrul-inventar și Cartea mare.'),
      t('O2634', 'formularele', 'Modelul și normele de întocmire a registrelor (Registrul-inventar, cod 14-1-2).'),
    ],
  },
  {
    key: 'pastrare', faza: 'anual', nume: 'Păstrarea documentelor',
    descriere: 'Arhivarea registrelor și a documentelor justificative.',
    temei: [t('L82', 'art. 25', 'Termenele de păstrare a registrelor de contabilitate și a documentelor justificative.')],
  },
];

const FAZE = ['permanent', 'lunar', 'trimestrial', 'anual'];
const BY_KEY = new Map(CICLU.map((p) => [p.key, p]));

/** Pasul din ciclu dupa cheie (aceleasi chei ca `monthlyClose.STEPS` la faza lunara). */
function pas(key) { return BY_KEY.get(String(key || '')) || null; }

/** Temeiul unui pas, gata de afisat: „Legea 82/1991, art. 6 alin. (1)". */
function temeiul(key) {
  const p = pas(key);
  if (!p) return [];
  return p.temei.map((x) => ({
    act: (ACTE[x.act] || {}).scurt || x.act,
    actTitlu: (ACTE[x.act] || {}).titlu || x.act,
    articol: x.articol,
    ce: x.ce,
    eticheta: ((ACTE[x.act] || {}).scurt || x.act) + (x.articol && x.articol !== '—' ? ', ' + x.articol : ''),
  }));
}

/** Ciclul intreg, cu temeiurile deja formatate (pentru interfata si pentru ghid). */
function ciclu(faza) {
  return CICLU
    .filter((p) => !faza || p.faza === faza)
    .map((p) => ({ key: p.key, faza: p.faza, nume: p.nume, descriere: p.descriere, temei: temeiul(p.key) }));
}

module.exports = { ACTE, CICLU, FAZE, pas, temeiul, ciclu };
